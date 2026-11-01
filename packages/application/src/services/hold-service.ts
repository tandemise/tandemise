import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApprovalRepositoryPort, AssignmentRepositoryPort, HoldDiffStat, HoldEnding, InteractiveSessionsPort, MemberRepositoryPort, Mission,
  MissionRepositoryPort, MissionTask, RunRepositoryPort, RuntimeProfile, RuntimeProfileRepositoryPort, TaskHold, TaskHoldRepositoryPort,
  TaskRepositoryPort, UnitOfWork,
} from '@tandemise/domain';
import { holdRefusal, isTrialMission } from '@tandemise/domain';
import type { TaskView } from '@tandemise/api-contract';
import type { ExecutionTarget } from '@tandemise/execution-core';
import type { RunRequest, RuntimeManager, SlotReservation } from '@tandemise/runtimes-core';
import type { Clock, Logger, MemberId, TandemisePaths, TaskHoldId, TaskId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage, ids } from '@tandemise/shared';
import type { HoldService, HoldStanding, ProjectionService } from '../services.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { FeedbackRounds, RoundBegun } from '../engine/feedback-rounds.js';
import { HOLD_LEASE_RENEW_MS, type HoldLeases, type TaskExecutor } from '../engine/task-executor.js';
import { NO_TOOL_SURFACE, type McpGatewayProvisioner, type RunToolSurface } from '../engine/mcp-gateway.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { isOutputApproval } from '../support/approval-view.js';
import { actorFor, type Caller } from '../support/identity.js';
import { assertMayTake } from '../support/take-rule.js';
import { TaskHeld, heldWaitingReason } from '../support/held.js';
import { withdrawApproval } from '../support/withdraw.js';
import { HOLD_PROMPTS_FILE } from '../support/hold-steer.js';

/** How long a hold waits for the run it stopped to end before giving up on opening the terminal. */
const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 100;
const LIVE_RUN = ['STARTING', 'RUNNING'];

export interface HoldDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly assignments: AssignmentRepositoryPort;
  readonly holds: TaskHoldRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly runtimeManager: Pick<RuntimeManager, 'capabilities' | 'interactive' | 'occupy'>;
  /** The attempt's own routing, target and grants, so a held session works where a run would. */
  readonly executor: Pick<TaskExecutor, 'holdProfiles' | 'prepareHold' | 'holdStartRefusal' | 'acquireHoldLeases'>;
  /** The factory a run's tool surface comes from; a hold gets its own. */
  readonly mcpGateway: McpGatewayProvisioner;
  /** Absent when the daemon has no terminal host; every hold is then refused. */
  readonly sessions?: InteractiveSessionsPort;
  readonly rounds: FeedbackRounds;
  readonly scheduler: Pick<SchedulerService, 'cancelTask' | 'activeTaskIds' | 'wake'>;
  readonly projections: Pick<ProjectionService, 'taskView'>;
  /** Why work may not start in the mission (P8); a hold on a step that has not started is a start. */
  readonly limitRefusal?: (missionId: Mission['id']) => string | null;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
  /** How long a hold waits for the run it stopped; 10 s unless a check shortens it. */
  readonly stopWaitMs?: number;
  /** How often a hold renews its checkout leases; HOLD_LEASE_RENEW_MS unless a check shortens it. */
  readonly leaseRenewMs?: number;
}

/** What the held step says when its checkout lease lapsed and was lost. */
const LEASE_LOST = 'Your hold lost its claim on this checkout, so other work may start in it. Continue or release when you can.';
/** How long shutdown gives each open terminal to exit before the host kills it. */
const SHUTDOWN_GRACE_MS = 1000;

/** The checkout leases a hold keeps from start to end, renewed while it lasts. */
interface KeptLeases {
  readonly leases: HoldLeases;
  readonly timer: ReturnType<typeof setInterval>;
}

/** What an open terminal holds on to, given back when it ends however it ends. */
interface LiveHold {
  readonly target: ExecutionTarget;
  readonly releaseTarget: () => Promise<void>;
  readonly gateway: RunToolSurface;
  readonly slot: SlotReservation;
  readonly controller: AbortController;
}

/** Where a hold resumes from: the profile holding the session, and the session (null for a fresh one). */
interface HoldSource {
  readonly profile: RuntimeProfile | null;
  readonly session: string | null;
  /** The run being stopped, whose session is read again once it has ended. */
  readonly runId: string | null;
}

/**
 * Hold, continue and release (spec "Hold, in order", "Continue").
 *
 * A person takes the keyboard on an agent step: its run is stopped into a
 * resumable state, and the same session opens in a terminal on the runtime
 * that holds it. As everywhere in the engine, the state transition is written
 * before the side effect it authorizes - the task is HELD before the run is
 * stopped, and the hold is ended before the terminal is - so a daemon that
 * dies at any await leaves a record recovery can read. Anything that fails
 * after the hold is written leaves the task HELD with the failure as its
 * status line; the person can open the terminal again or continue.
 *
 * Opening a hold's terminal, opening it again and ending the hold take turns,
 * one hold at a time: each reads the hold afresh once its turn comes.
 */
export class HoldServiceImpl implements HoldService {
  readonly #live = new Map<TaskHoldId, LiveHold>();
  readonly #leases = new Map<TaskHoldId, KeptLeases>();
  readonly #tearing = new Map<TaskHoldId, Promise<void>>();
  /** The tail of each hold's queue of operations. */
  readonly #turns = new Map<TaskHoldId, Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(private readonly deps: HoldDeps) {
    this.#unsubscribe = deps.sessions?.onExit((holdId) => { void this.#exited(holdId); }) ?? (() => {});
  }

  async hold(taskId: TaskId, caller: Caller): Promise<TaskView> {
    const { deps } = this;
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId, recordedBy } = actorFor(deps, mission.workspaceId, caller);
    const source = this.#source(task);
    const refusal = this.#refusal(task, mission, source);
    if (refusal !== null) refuse(refusal, task);
    if (source.profile === null) refuse(`No runtime is routed to '${task.title}', so there is nothing to hold it in.`, task);
    if (task.status === 'READY') await this.#assertMayStart(task, mission);
    assertMayTake(deps, task, mission, actorId, 'hold');
    this.#assertTerminal();
    // A step that has not started takes its checkout now, as its start would,
    // and is refused in the start's words when another task has it. A running
    // step's leases are its run's until that run has stopped.
    let leases: HoldLeases | null = null;
    if (task.status === 'READY') {
      const taken = deps.executor.acquireHoldLeases(task.id);
      if (!taken.ok) refuse(taken.reason, task);
      leases = taken.value;
    }

    const profile = source.profile;
    const name = this.#nameOf(actorId);
    const reason = `Held by ${name}.`;
    const holdId = ids.taskHold();
    const record: TaskHold = {
      id: holdId, taskId: task.id, missionId: mission.id, heldBy: actorId, fromStatus: task.status,
      runtimeProfileId: profile.id, sessionBefore: source.session, sessionAfter: null, ptyPid: null,
      startedAt: deps.clock.now(), endedAt: null, endedBy: null, ending: null, consumedAt: null, diffStat: null,
      // The hook's session file, the gateway config and the diff baseline live here.
      dir: join(deps.paths.mission(mission.workspaceId, mission.id), 'holds', holdId),
    };
    const scope = this.#scope(task, mission, actorId);
    let begun: RoundBegun | null;
    try {
      begun = deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
        // Read again inside the unit: a run may have started, or someone else held it, since the checks.
        const current = this.#task(task.id);
        if (current.status !== task.status || deps.holds.openFor(task.id) !== undefined) {
          refuse(`'${task.title}' changed while you asked; try holding it again.`, task);
        }
        let from: MissionTask = current;
        let round = null;
        if (current.status === 'AWAITING_APPROVAL') {
          // Request changes, interactively: the output is set aside as a request
          // for changes sets it aside, and the round reopens the task.
          const card = deps.approvals.pendingForTask(current.id).find((a) => isOutputApproval(a, current, deps.runs));
          const roundReason = `Held by ${name} to change it directly.`;
          if (card !== undefined) deps.rounds.decideReviewCard(card, { actorId, recordedBy, note: roundReason });
          const impact = deps.rounds.impactOf(current);
          round = deps.rounds.beginRound({
            task: current, feedbackIds: [], actorId, reason: roundReason,
            downstream: impact.consumers.length === 0 ? 'none' : impact.defaultChoice,
            ...(card === undefined ? {} : { keepCardId: card.id }),
          });
          from = round.task;
        } else {
          // The person answers in the terminal now; a question card nobody waits on is closed.
          for (const card of deps.approvals.pendingForTask(current.id)) {
            if (card.kind === 'choice' || isOutputApproval(card, current, deps.runs)) withdrawApproval(deps, card, reason);
          }
        }
        deps.holds.create(record);
        deps.tasks.update(current.id, { status: 'HELD', statusReason: reason, needsAttention: false });
        deps.recorder.record(scope, { type: 'task.status', from: from.status, to: 'HELD', reason });
        deps.recorder.record(scope, {
          type: 'task.held', holdId: record.id, fromStatus: task.status, heldBy: actorId, sessionBefore: record.sessionBefore,
        });
        // The output is the person's until the hold ends, so work about to read it waits.
        deps.rounds.holdDependents({ ...from, status: 'HELD' }, heldWaitingReason(task));
        return round;
      }));
    } catch (e) {
      leases?.release();
      throw e;
    }
    if (leases !== null) this.#keepLeases(record.id, leases);
    if (begun !== null) deps.rounds.stopOvertaken(begun);
    deps.recorder.invalidate('tasks', mission.id);
    deps.recorder.invalidate('approvals', mission.id);

    // Only after the commit: the terminal stops the run first, which then ends
    // with HELD on its row, so the executor keeps it.
    await this.#inTurn(record.id, () => this.#openTerminal(record.id, false, source.runId));
    return this.#view(task.id);
  }

  async continue(taskId: TaskId, caller: Caller): Promise<TaskView> {
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller);
    const hold = this.#openHold(task);
    if (hold.heldBy !== actorId) {
      throw new TandemiseError('CONFLICT', `Only ${this.#nameOf(hold.heldBy)} can continue this hold; you can release it.`, {
        details: { taskId, holdId: hold.id, heldBy: hold.heldBy },
      });
    }
    return this.#inTurn(hold.id, () => this.#end(task, mission, hold.id, actorId, 'continued'));
  }

  async release(taskId: TaskId, caller: Caller): Promise<TaskView> {
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller);
    const hold = this.#openHold(task);
    if (hold.heldBy !== actorId) assertMayTake(this.deps, task, mission, actorId, 'release');
    return this.#inTurn(hold.id, () => this.#end(task, mission, hold.id, actorId, 'released'));
  }

  async reopen(taskId: TaskId, caller: Caller): Promise<TaskView> {
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller);
    const hold = this.#openHold(task);
    if (hold.heldBy !== actorId) {
      throw new TandemiseError('CONFLICT', `Only ${this.#nameOf(hold.heldBy)} can open this hold's terminal; you can release it.`, {
        details: { taskId, holdId: hold.id, heldBy: hold.heldBy },
      });
    }
    this.#assertTerminal();
    await this.#inTurn(hold.id, async () => {
      // A turn ahead of this one may have ended the hold, or opened the terminal already.
      if (this.deps.holds.get(hold.id)?.endedAt !== null) refuse(`'${task.title}' is not held.`, task);
      if (this.deps.sessions?.isOpen(hold.id) === true) return;
      await this.#teardown(hold.id);
      await this.#openTerminal(hold.id, true, null);
    });
    return this.#view(task.id);
  }

  resume(): void {
    // Recovery kept the leases of every open hold; they are taken up again, and renewed from here on.
    for (const task of this.deps.tasks.listByStatus(['HELD'])) {
      const hold = this.deps.holds.openFor(task.id);
      if (hold === undefined) continue;
      if (this.#ensureLeases(hold) !== null) this.#failed(hold, LEASE_LOST);
    }
  }

  standing(task: MissionTask, mission: Mission): HoldStanding {
    const { deps } = this;
    const open = deps.holds.openFor(task.id);
    const hold = open === undefined ? null : {
      holdId: open.id, heldBy: open.heldBy, heldByName: this.#nameOf(open.heldBy), startedAt: open.startedAt,
      terminalOpen: deps.sessions?.isOpen(open.id) === true,
    };
    // A done, a person's or a trial step, and one already held, are refused
    // before the runtime is asked about, so their runtime is never looked up.
    if (open !== undefined || task.status === 'SUCCEEDED' || task.executor !== 'agent' || isTrialMission(mission)) {
      const reason = this.#refusal(task, mission, { profile: null, session: null, runId: null });
      return { hold, holdable: reason === null ? { ok: true } : { ok: false, reason } };
    }
    const source = this.#source(task);
    const reason = this.#refusal(task, mission, source)
      ?? (source.profile === null ? `No runtime is routed to '${task.title}', so there is nothing to hold it in.` : null)
      ?? this.#terminalRefusal();
    return { hold, holdable: reason === null ? { ok: true } : { ok: false, reason } };
  }

  terminalFor(taskId: TaskId): TaskHoldId | null {
    const hold = this.deps.holds.openFor(taskId);
    return hold !== undefined && this.deps.sessions?.isOpen(hold.id) === true ? hold.id : null;
  }

  /**
   * Shutdown: the terminals this daemon opened end with it (the application is
   * disposed before the terminal host), and what they held is given back. The
   * holds themselves stay open, for the next daemon to resume.
   */
  async dispose(): Promise<void> {
    for (const kept of this.#leases.values()) clearInterval(kept.timer);
    const open = [...this.#live.keys()];
    await Promise.all(open.map(async (holdId) => {
      if (this.deps.sessions?.isOpen(holdId) === true) {
        await this.deps.sessions.end(holdId, SHUTDOWN_GRACE_MS).catch(() => undefined);
      }
      await this.#teardown(holdId);
    }));
    this.#unsubscribe();
  }

  // ------------------------------------------------------------------ internals

  /**
   * Provisions the terminal for an open hold (spec step 4): the target, a
   * gateway with the run's grants minus `human.ask`, one slot on the pinned
   * profile, and the runtime's own interactive CLI resumed in the hold's
   * session. A failure is the task's status line, in the daemon's words; the
   * task stays HELD.
   */
  async #openTerminal(holdId: TaskHoldId, reopening: boolean, stoppedRunId: string | null): Promise<void> {
    const { deps } = this;
    // A terminal never opens beside a live run of the step: whatever is still
    // running is stopped as the hold stopped it (a no-op when nothing runs),
    // and waited for. Resuming alongside it would fork the session.
    const taskId = deps.holds.get(holdId)!.taskId;
    deps.scheduler.cancelTask(taskId, new TaskHeld());
    if (!(await this.#stopped(taskId))) {
      this.#failed(deps.holds.get(holdId)!, "The agent's run did not stop in time. Open the terminal again in a moment.");
      return;
    }
    this.#refreshSessionBefore(holdId, stoppedRunId);
    const hold = deps.holds.get(holdId)!;
    const task = this.#task(hold.taskId);
    // The checkout is the person's for the whole hold; taken again after a restart released it.
    const leased = this.#ensureLeases(hold);
    if (leased !== null) {
      this.#failed(hold, leased);
      return;
    }
    const mission = this.#mission(task);
    const sessions = deps.sessions!;
    const profile = deps.runtimeProfiles.get(asId<'RuntimeProfileId'>(hold.runtimeProfileId));
    if (profile === undefined) {
      this.#failed(hold, "The runtime this hold's session is on no longer exists. Release the hold to hand it back.");
      return;
    }
    const prepared = await deps.executor.prepareHold(task.id, profile).catch((e: unknown) => ({ ok: false as const, reason: errorMessage(e) }));
    if (!prepared.ok) {
      this.#failed(hold, prepared.reason);
      return;
    }
    const prep = prepared.value;
    const controller = new AbortController();
    let gateway: RunToolSurface = NO_TOOL_SURFACE;
    let slot: SlotReservation | undefined;
    try {
      await mkdir(hold.dir, { recursive: true, mode: 0o700 });
      // What the hold's diff is measured against: the checkout as the person found it.
      const headFile = join(hold.dir, 'head.txt');
      if (!existsSync(headFile)) {
        const head = await prep.target.exec({ command: 'git', args: ['rev-parse', 'HEAD'] });
        if (head.exitCode === 0 && head.stdout.trim() !== '') await writeFile(headFile, head.stdout.trim());
      }
      // One assignment per hold, made when its terminal first opens and kept by every reopen.
      const assignmentId = asId<'WorkerAssignmentId'>(`wa_${hold.id.slice(hold.id.indexOf('_') + 1)}`);
      const assignment = deps.assignments.get(assignmentId) ?? deps.assignments.create({
        id: assignmentId, workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId,
        runtimeProfileId: profile.id, executionTargetId: prep.target.id, grants: prep.grants,
        budgets: { maxWallTimeMs: task.executionPolicy.maxWallTimeMs, maxAttempts: task.retryPolicy.maxAttempts },
        createdAt: deps.clock.now(),
      });
      gateway = await deps.mcpGateway.provision({
        runId: null, owner: { key: hold.id, dir: hold.dir }, workspaceId: mission.workspaceId, missionId: mission.id,
        assignment, workingDirectory: prep.target.workingDirectory, signal: controller.signal,
      });
      const session = this.#sessionOf(hold);
      // A hold with no session starts the agent's work fresh, with the prompt a run would get.
      const initialPrompt = session === null ? await prep.prompt(gateway.toolNames) : null;
      const request: RunRequest = {
        runId: ids.run(), profile, prompt: initialPrompt ?? '', workingDirectory: prep.target.workingDirectory,
        grants: prep.grants.map((g) => g.capability), allowedRoots: prep.allowedRoots, mcpConfigPath: gateway.mcpConfigPath,
        maxWallTimeMs: task.executionPolicy.maxWallTimeMs, signal: controller.signal,
        log: deps.log.child({ holdId: hold.id, taskId: task.id, missionId: mission.id }),
      };
      const invocation = deps.runtimeManager.interactive(profile, session, request, {
        sessionFile: join(hold.dir, 'session-id'), initialPrompt, promptsFile: join(hold.dir, HOLD_PROMPTS_FILE),
      });
      // The last look before a process starts: a hold that has ended gets no terminal.
      if (deps.holds.get(hold.id)?.endedAt !== null) {
        controller.abort();
        await gateway.dispose().catch(() => undefined);
        await prep.release().catch(() => undefined);
        return;
      }
      slot = deps.runtimeManager.occupy(profile);
      const { pid } = sessions.open(hold.id, invocation);
      this.#live.set(hold.id, { target: prep.target, releaseTarget: prep.release, gateway, slot, controller });
      deps.holds.update(hold.id, { ptyPid: pid });
      // A failure an earlier try left on the status line is over.
      const reason = `Held by ${this.#nameOf(hold.heldBy)}.`;
      if (this.#task(task.id).statusReason !== reason) deps.tasks.update(task.id, { statusReason: reason });
      deps.recorder.invalidate('tasks', mission.id);
      if (reopening) deps.log.info('hold.reopened', { holdId: hold.id, taskId: task.id });
    } catch (e) {
      slot?.release();
      controller.abort();
      await gateway.dispose().catch(() => undefined);
      await prep.release().catch(() => undefined);
      this.#failed(hold, errorMessage(e));
    }
  }

  /**
   * Continue and Release, in two steps. The hold ends first, while the task
   * stays HELD, so the terminal closing reads as the exit of a hold that is
   * over; only once the terminal is gone does the task go back to the queue,
   * so the next pass never starts beside a live session. A terminal that will
   * not end does not keep the task: once the host has given up on it, the task
   * goes back all the same.
   */
  async #end(task: MissionTask, mission: Mission, holdId: TaskHoldId, actorId: MemberId, ending: HoldEnding): Promise<TaskView> {
    const { deps } = this;
    // Read in turn: a turn ahead of this one may have ended it.
    const hold = deps.holds.get(holdId);
    if (hold === undefined || hold.endedAt !== null) refuse(`'${task.title}' is no longer held.`, task);
    const sessionAfter = this.#sessionOf(hold);
    const diffStat = await this.#diffStat(hold);
    const endedAt = deps.clock.now();
    const scope = this.#scope(task, mission, actorId);
    const reason = ending === 'continued' ? `Continued by ${this.#nameOf(actorId)}.` : `Released by ${this.#nameOf(actorId)}.`;
    deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
      if (deps.holds.openFor(task.id)?.id !== hold.id) refuse(`'${task.title}' is no longer held.`, task);
      deps.holds.update(hold.id, { endedAt, endedBy: actorId, ending, sessionAfter, diffStat });
      deps.tasks.update(task.id, { statusReason: reason, needsAttention: false });
      deps.recorder.record(scope, {
        type: 'task.hold_ended', holdId: hold.id, ending, endedBy: actorId, sessionAfter,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(hold.startedAt)), diffStat,
      });
    }));
    deps.recorder.invalidate('tasks', mission.id);
    try {
      if (deps.sessions?.isOpen(hold.id) === true) {
        await deps.sessions.end(hold.id).catch((e: unknown) => deps.log.warn('hold.end_failed', { holdId: hold.id, error: errorMessage(e) }));
      }
      await this.#teardown(hold.id);
    } finally {
      this.#releaseLeases(hold.id);
      deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
        const current = this.#task(task.id);
        // Recovery puts a HELD task with no open hold back the same way, should the daemon die in between.
        if (current.status !== 'HELD' || deps.holds.openFor(task.id) !== undefined) return;
        deps.tasks.update(task.id, { status: 'READY', statusReason: null, needsAttention: false, finishedAt: null });
        deps.recorder.record(scope, { type: 'task.status', from: 'HELD', to: 'READY', reason });
        deps.rounds.releaseHeld(current, heldWaitingReason(task));
      }));
      deps.recorder.invalidate('tasks', mission.id);
      deps.scheduler.wake();
    }
    return this.#view(task.id);
  }

  /** The terminal went away on its own (`/exit`, a crash): the task stays HELD and can be reopened or continued. */
  async #exited(holdId: TaskHoldId): Promise<void> {
    const { deps } = this;
    try {
      const hold = deps.holds.get(holdId);
      if (hold !== undefined && hold.endedAt === null) {
        deps.holds.update(holdId, { ptyPid: null, sessionAfter: this.#sessionOf(hold) });
        deps.recorder.invalidate('tasks', hold.missionId);
      }
      await this.#teardown(holdId);
    } catch (e) {
      deps.log.warn('hold.exit_failed', { holdId, error: errorMessage(e) });
    }
  }

  /** Gives back what an open terminal held: its gateway, its slot and its target. Idempotent. */
  async #teardown(holdId: TaskHoldId): Promise<void> {
    const live = this.#live.get(holdId);
    // A teardown under way (the exit a `sessions.end` fires) is waited for, not skipped.
    if (live === undefined) return this.#tearing.get(holdId);
    this.#live.delete(holdId);
    live.slot.release();
    live.controller.abort();
    const done = (async () => {
      await live.gateway.dispose().catch(() => undefined);
      await live.releaseTarget().catch(() => undefined);
    })();
    this.#tearing.set(holdId, done);
    try { await done; } finally { this.#tearing.delete(holdId); }
  }

  /**
   * The session the terminal ended on: what its hook last wrote, else what
   * the hold already knew. A failed hook leaves no file, and the session the
   * hold started from is then the best there is.
   */
  #sessionOf(hold: TaskHold): string | null {
    try {
      const written = readFileSync(join(hold.dir, 'session-id'), 'utf8').trim();
      if (written !== '') return written;
    } catch { /* no file: the hook did not run */ }
    return hold.sessionAfter ?? hold.sessionBefore;
  }

  /**
   * Files and lines changed since the hold began, untracked files included:
   * they are staged into a throwaway index, never the checkout's own. Null
   * when it cannot be measured; a hold ends either way.
   */
  async #diffStat(hold: TaskHold): Promise<HoldDiffStat | null> {
    const { deps } = this;
    let head: string;
    try { head = readFileSync(join(hold.dir, 'head.txt'), 'utf8').trim(); } catch { return null; }
    let target = this.#live.get(hold.id)?.target;
    let release: (() => Promise<void>) | null = null;
    if (target === undefined) {
      const profile = deps.runtimeProfiles.get(asId<'RuntimeProfileId'>(hold.runtimeProfileId));
      if (profile === undefined) return null;
      const prepared = await deps.executor.prepareHold(hold.taskId, profile).catch(() => null);
      if (prepared === null || !prepared.ok) return null;
      target = prepared.value.target;
      release = prepared.value.release;
    }
    const index = join(hold.dir, 'diff.index');
    const env = { GIT_INDEX_FILE: index };
    try {
      await rm(index, { force: true });
      // Seeded from HEAD, so the throwaway index starts where the checkout's own does.
      const seeded = await target.exec({ command: 'git', args: ['read-tree', 'HEAD'], env });
      if (seeded.exitCode !== 0) return null;
      // The hold's own folder may sit inside the checkout (a mission with no repository); it is not the person's work.
      const added = await target.exec({ command: 'git', args: ['add', '-A', '--', '.', ':(exclude)holds'], env });
      if (added.exitCode !== 0) return null;
      const diff = await target.exec({ command: 'git', args: ['diff', '--cached', '--shortstat', head], env });
      return diff.exitCode === 0 ? parseShortstat(diff.stdout) : null;
    } catch (e) {
      deps.log.warn('hold.diffstat_failed', { holdId: hold.id, error: errorMessage(e) });
      return null;
    } finally {
      await rm(index, { force: true }).catch(() => undefined);
      await release?.().catch(() => undefined);
    }
  }

  /** Waits for the stopped run to end; false when it did not in time. */
  async #stopped(taskId: TaskId): Promise<boolean> {
    const end = Date.now() + (this.deps.stopWaitMs ?? STOP_WAIT_MS);
    const live = (): boolean => this.deps.scheduler.activeTaskIds().includes(taskId)
      || this.deps.runs.listByTask(taskId).some((r) => LIVE_RUN.includes(r.status));
    while (live()) {
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    }
    return true;
  }

  /**
   * The profile and session a hold opens on. A session the agent has not yet
   * continued from (an earlier hold, a restart's handle) comes first; a step
   * that has run resumes its latest session where it ran; a step that has not
   * gets the runtime an attempt would get, and starts fresh.
   */
  #source(task: MissionTask): HoldSource {
    const { deps } = this;
    const profile = (id: string): RuntimeProfile | null => deps.runtimeProfiles.get(asId<'RuntimeProfileId'>(id)) ?? null;
    const unread = deps.holds.listByMission(task.missionId)
      .filter((h) => h.taskId === task.id && h.endedAt !== null && h.consumedAt === null)
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
    if (unread !== undefined) return { profile: profile(unread.runtimeProfileId), session: unread.sessionAfter ?? unread.sessionBefore, runId: null };
    const runs = [...deps.runs.listByTask(task.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (task.status === 'READY') {
      const resumable = runs.find((r) => r.status === 'RESUMABLE' && r.externalSessionId !== null);
      if (resumable !== undefined) return { profile: profile(resumable.runtimeProfileId), session: resumable.externalSessionId, runId: null };
      const routed = deps.executor.holdProfiles(task.id);
      const chosen = routed.find((p) => deps.runtimeManager.capabilities(p).includes('interactive_resume')) ?? routed[0] ?? null;
      return { profile: chosen, session: null, runId: null };
    }
    const run = runs.find((r) => LIVE_RUN.includes(r.status)) ?? runs.find((r) => r.externalSessionId !== null) ?? runs[0];
    if (run === undefined) return { profile: null, session: null, runId: null };
    return { profile: profile(run.runtimeProfileId), session: run.externalSessionId, runId: run.id };
  }

  /** A hold on a step that has not started is its start, so the start's own checks apply (spec "Where a hold can start"). */
  async #assertMayStart(task: MissionTask, mission: Mission): Promise<void> {
    const { deps } = this;
    if (task.approvalPolicy.beforeStart) {
      const approved = deps.approvals.list({ missionId: mission.id, statuses: ['APPROVED'] })
        .some((a) => a.taskId === task.id && a.kind === 'action');
      if (!approved) refuse('Approve the start first, then you can hold it.', task);
    }
    const limit = deps.limitRefusal?.(mission.id) ?? null;
    if (limit !== null) refuse(limit, task);
    const skills = await deps.executor.holdStartRefusal(task.id);
    if (skills !== null) refuse(skills, task);
  }

  /**
   * A hold that stopped a run starts from that run's session, which the run
   * may only have learned as it ended. Only then: a hold from an earlier
   * hold's session must not be sent back to the older one a run left.
   */
  #refreshSessionBefore(holdId: TaskHoldId, stoppedRunId: string | null): void {
    const { deps } = this;
    const hold = deps.holds.get(holdId)!;
    if (hold.fromStatus !== 'RUNNING' && hold.fromStatus !== 'AWAITING_INPUT') return;
    const stopped = stoppedRunId !== null
      ? deps.runs.get(asId<'RunId'>(stoppedRunId))
      : [...deps.runs.listByTask(hold.taskId)]
        .filter((r) => r.runtimeProfileId === hold.runtimeProfileId && r.startedAt <= hold.startedAt && r.externalSessionId !== null)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (stopped?.externalSessionId != null && stopped.externalSessionId !== hold.sessionBefore) {
      deps.holds.update(holdId, { sessionBefore: stopped.externalSessionId });
    }
  }

  /** Null when the hold has its checkout's leases (taking them if a restart let them go); else why not. */
  #ensureLeases(hold: TaskHold): string | null {
    if (this.#leases.has(hold.id)) return null;
    const taken = this.deps.executor.acquireHoldLeases(hold.taskId);
    if (!taken.ok) return taken.reason;
    this.#keepLeases(hold.id, taken.value);
    return null;
  }

  #keepLeases(holdId: TaskHoldId, leases: HoldLeases): void {
    const timer = setInterval(() => {
      if (leases.renew()) return;
      // Lapsed and taken: what is left is let go, and the step says so. Opening
      // the terminal again tries to take the checkout back.
      this.deps.log.warn('hold.lease_lost', { holdId });
      this.#releaseLeases(holdId);
      const hold = this.deps.holds.get(holdId);
      if (hold !== undefined && hold.endedAt === null) this.#failed(hold, LEASE_LOST);
    }, this.deps.leaseRenewMs ?? HOLD_LEASE_RENEW_MS);
    timer.unref?.();
    this.#leases.set(holdId, { leases, timer });
  }

  #releaseLeases(holdId: TaskHoldId): void {
    const kept = this.#leases.get(holdId);
    if (kept === undefined) return;
    this.#leases.delete(holdId);
    clearInterval(kept.timer);
    kept.leases.release();
  }

  #assertTerminal(): void {
    const reason = this.#terminalRefusal();
    if (reason !== null) throw new TandemiseError('CONFLICT', reason);
  }

  /** Why no terminal can open on this daemon; null when one can. */
  #terminalRefusal(): string | null {
    const sessions = this.deps.sessions;
    if (sessions === undefined) return 'This daemon has no terminal to hold a step in.';
    const available = sessions.available();
    return available.ok ? null : available.reason;
  }

  /** The domain's refusal, given the facts it asks about this task. */
  #refusal(task: MissionTask, mission: Mission, source: HoldSource): string | null {
    const { deps } = this;
    const openHold = deps.holds.openFor(task.id) ?? null;
    return holdRefusal({
      task, mission, trial: isTrialMission(mission),
      liveRun: deps.runs.listByTask(task.id).some((r) => LIVE_RUN.includes(r.status)),
      outputUnderReview: task.status === 'AWAITING_APPROVAL'
        && deps.approvals.pendingForTask(task.id).some((a) => isOutputApproval(a, task, deps.runs)),
      runtimeHasInteractive: source.profile === null || deps.runtimeManager.capabilities(source.profile).includes('interactive_resume'),
      openHold, holderName: openHold === null ? null : this.#nameOf(openHold.heldBy),
    });
  }

  /** After the hold is written, a failure is the task's status line; the task stays HELD. Silent once the hold has ended. */
  #failed(hold: TaskHold, reason: string): void {
    this.deps.log.warn('hold.open_failed', { holdId: hold.id, taskId: hold.taskId, reason });
    if (this.deps.holds.get(hold.id)?.endedAt !== null) return;
    this.deps.tasks.update(hold.taskId, { statusReason: reason });
    this.deps.recorder.invalidate('tasks', hold.missionId);
  }

  /** Runs `op` once every earlier operation on the same hold has settled, whatever their outcome. */
  async #inTurn<T>(holdId: TaskHoldId, op: () => Promise<T>): Promise<T> {
    const before = this.#turns.get(holdId) ?? Promise.resolve();
    const result = before.then(op);
    const tail = result.then(() => undefined, () => undefined);
    this.#turns.set(holdId, tail);
    try {
      return await result;
    } finally {
      if (this.#turns.get(holdId) === tail) this.#turns.delete(holdId);
    }
  }

  #openHold(task: MissionTask): TaskHold {
    const hold = this.deps.holds.openFor(task.id);
    if (hold === undefined) refuse(`'${task.title}' is not held.`, task);
    return hold;
  }

  #scope(task: MissionTask, mission: Mission, actorId: MemberId): EventScope {
    return { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId };
  }

  #nameOf(memberId: string): string {
    return this.deps.members.get(asId<'MemberId'>(memberId))?.name ?? 'someone';
  }

  #view(taskId: TaskId): TaskView {
    return this.deps.projections.taskView(taskId);
  }

  #task(id: TaskId): MissionTask {
    const task = this.deps.tasks.get(id);
    if (task === undefined) throw TandemiseError.notFound('Task', id);
    return task;
  }

  #mission(task: MissionTask): Mission {
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);
    return mission;
  }
}

function refuse(reason: string, task: MissionTask): never {
  throw new TandemiseError('CONFLICT', reason, { details: { taskId: task.id, status: task.status } });
}

/** ` 2 files changed, 5 insertions(+), 1 deletion(-)`; empty output is no change. */
export function parseShortstat(text: string): HoldDiffStat {
  const n = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}
