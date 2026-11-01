import { DaemonStopping } from '../support/shutdown.js';

/** The reason a task carries when it is blocked only by a dead dependency. */
const DEPENDENCY_BLOCK_PREFIX = 'Blocked by ';
import type {
  ApprovalRepositoryPort, MemberRepositoryPort, Mission, MissionRepositoryPort, MissionStatus, MissionTask, PullRequestRef,
  TaskRepositoryPort, WorkspaceRepositoryPort,
  RepoRepositoryPort,
} from '@tandemise/domain';
import {
  ACTIVE_TASK_STATUSES, canTransition, compareBacklog, isTaskFinished, isTaskParked, isTerminalMissionStatus,
} from '@tandemise/domain';
import type { Clock, Logger, MissionId, TaskId } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { LifecycleComponent } from '@tandemise/kernel';
import type { WaitOutcome, Waiter } from './waiter.js';
import { ciWaitTarget, type PullRequestWait } from './pr-wait.js';
import type { ShipService } from './ship.js';
import type { OutcomeRecorder } from './outcomes.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { BranchIntegrationService } from './branch-integration.js';
import type { RemediationPlanner } from './remediation.js';
import type { TaskAttemptOutcome, TaskExecutor } from './task-executor.js';
import { waitingReason, withoutEscalation, type StaffingResolver } from './staffing-resolver.js';
import type { ReviewPipeline } from './reviews.js';
import type { FeedbackRounds, ReviewRouting } from './feedback-rounds.js';
import { isHeldForPlanFit, type PlanFit } from './plan-fit.js';

/** Mission statuses in which the scheduler is allowed to dispatch work. */
const DISPATCHABLE: readonly MissionStatus[] = ['EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP'];

export interface SchedulerDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly executor: TaskExecutor;
  /** Repositories, so a wait polls in the right checkout. */
  readonly repositories: RepoRepositoryPort;
  readonly waiter: Waiter;
  /**
   * Decides a `gh pr checks` wait by its pull request's state on GitHub
   * (#143). Optional so harnesses built before it still compose; without it,
   * every wait is decided by its command.
   */
  readonly prWait?: PullRequestWait;
  /** The daemon-owned ship step (#53 §8). Optional so harnesses built before it still compose. */
  readonly ship?: ShipService;
  /** How often a waiting ship step is looked at again. */
  readonly shipPollMs?: number;
  /** Watches main after merges (#53 §8.7), throttled and in the background. */
  readonly watchMerges?: () => void;
  /** Records each settled attempt for routing (#53 §9.1). Optional for older harnesses. */
  readonly outcomes?: Pick<OutcomeRecorder, 'stepSettled'>;
  readonly remediation: RemediationPlanner;
  readonly integration: BranchIntegrationService;
  readonly recorder: EventRecorder;
  /** Resolves who does a task, once, when it becomes READY. */
  readonly staffing: StaffingResolver;
  /** To name the person a human task is waiting for. */
  readonly members: MemberRepositoryPort;
  /** Moves unanswered requests up the team tree, once per tick. */
  readonly reviews: ReviewPipeline;
  /** Releases feedback notes a settled pass never read, once per tick. */
  readonly rounds: FeedbackRounds;
  /**
   * Holds the steps after one whose handoff said the plan no longer fits
   * (plan-fit spec). Optional so harnesses built before it still compose; the
   * module always passes it.
   */
  readonly planFit?: Pick<PlanFit, 'holdBehind'>;
  /**
   * Plans the next queued drafts while a project has room under its
   * work-in-progress limit (P7). Optional so harnesses built before the
   * backlog still compose; the module always passes it.
   */
  readonly pullBacklog?: () => Promise<unknown>;
  /**
   * Adds the missions of due routines to the backlog (P11), before the pull so
   * one it adds can be pulled in the same pass. Optional so harnesses built
   * before routines still compose; the module always passes it.
   */
  readonly fireRoutines?: () => Promise<unknown>;
  /**
   * Starts due GitHub issue checks and the write-back pass (P14) in the
   * background; returns at once so a slow `gh` never holds up dispatch.
   */
  readonly syncIssues?: () => void;
  /**
   * Intake's background pass (plan Task 7): finishes links a crash left
   * pending and retries signals the tracker could not take. Returns at once.
   */
  readonly syncIntake?: () => void;
  /**
   * The hard-limit admission rule (P8): null when work may start in the
   * mission, else why not (and the stop is applied). Optional so harnesses
   * built before limits still compose; the module always passes it.
   */
  readonly limits?: { admit(missionId: MissionId): string | null };
  /**
   * The silent-run watchdog (P9): says once when a run turns quiet or silent,
   * so an open window refreshes. Optional for harnesses built before it.
   */
  readonly watchLiveness?: () => void;
  readonly clock: Clock;
  readonly log: Logger;
  readonly tickIntervalMs?: number;
}

/**
 * The tick loop (APPLICATION_DESIGN.md §Services to build).
 *
 * Everything the scheduler knows it re-reads from the database on every tick.
 * There is no in-memory model of "what the missions are doing" to drift out of
 * step with the rows, which is what makes a restart mid-mission a non-event:
 * the next tick sees exactly what the previous daemon left behind, and recovery
 * has already reconciled whatever was in flight.
 *
 * The only in-memory state is what genuinely cannot be persisted - the
 * `AbortController` for a run happening *in this process*, and the earliest
 * time a backed-off task may be retried. Both are safe to lose.
 *
 * A tick never blocks on a run. `#dispatch` starts an attempt and returns; the
 * attempt settles itself into the database and the next tick observes the
 * result. That is what lets `stop()` be honest: it aborts every controller it
 * holds and waits for the attempts to unwind, so no worker is orphaned.
 */
export class SchedulerService implements LifecycleComponent {
  readonly name = 'scheduler';

  readonly #active = new Map<TaskId, AbortController>();
  /** In-flight waits, which are deliberately not workers. */
  /** When each waiting ship step was last looked at. */
  readonly #shipWatched = new Map<string, number>();
  readonly #waiting = new Map<TaskId, AbortController>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #retryAfter = new Map<TaskId, number>();
  /** Consecutive failed looks at a waiting ship step: each doubles the wait before the next, up to SHIP_BACKOFF_CAP_MS. */
  readonly #shipFailures = new Map<TaskId, number>();
  /** What a waiting ship step said before GitHub started failing, said again once it answers. */
  readonly #shipReasonBefore = new Map<TaskId, string | null>();
  /** A CI wait's head whose red CI already sent the work back: not sent back again for the same commit. */
  readonly #failedHead = new Map<TaskId, string>();
  /** A CI wait's head whose pull request was just fixed (#194): its red checks run again, until then. */
  readonly #rerunHead = new Map<TaskId, { readonly head: string; readonly until: number }>();
  /** Missions whose task branches have already been merged, so it happens once. */
  readonly #integrated = new Set<MissionId>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #ticking = false;
  #wakeRequested = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const interval = Math.max(100, this.deps.tickIntervalMs ?? 1_500);
    this.#timer = setInterval(() => void this.#safeTick(), interval);
    // `unref` so a scheduler with nothing to do never keeps the process alive;
    // the daemon's HTTP server is what holds the event loop open.
    this.#timer.unref();
    this.deps.log.info('scheduler.started', { tickIntervalMs: interval });
    await this.#safeTick();
  }

  /**
   * Stops dispatching and cancels whatever this process is running.
   *
   * Aborting is not optional politeness: the abort signal is what terminates
   * the worker's child process. Returning from `stop()` with a run still
   * streaming would leave an agent writing into a worktree that nothing is
   * supervising any more (MVP.md §7.3).
   */
  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    // Stopping, not cancelling: the runs are handed to the next daemon.
    for (const controller of this.#active.values()) controller.abort(new DaemonStopping());
    // A wait can outlive every worker, so stopping has to cancel it too or
    // shutdown blocks until a CI run someone else is doing finishes.
    for (const controller of this.#waiting.values()) controller.abort(new DaemonStopping());
    await this.drain();
    this.deps.log.info('scheduler.stopped');
  }

  /** Waits for every attempt started in this process to finish unwinding. */
  async drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  /** Asks for a tick as soon as the current one finishes. */
  wake(): void {
    // A stopped scheduler - disposed, or never started, as in a check that
    // drives ticks itself - has nothing to wake; ticking it would read a
    // database that may already be closed.
    if (!this.#running) return;
    this.#wakeRequested = true;
    if (!this.#ticking) void this.#safeTick();
  }

  activeTaskIds(): readonly TaskId[] {
    return [...this.#active.keys()];
  }

  cancelMission(missionId: MissionId): void {
    for (const task of this.deps.tasks.listByMission(missionId)) this.cancelTask(task.id);
  }

  /** `reason` tells the run why it stopped: a hold (`TaskHeld`) keeps its session; a plain cancel does not. */
  cancelTask(taskId: TaskId, reason?: Error): void {
    this.#active.get(taskId)?.abort(reason);
    // A wait has no worker, only its poll: stopping it is what lets a retry or a skip stand.
    if (this.deps.tasks.get(taskId)?.executor === 'wait') this.#waiting.get(taskId)?.abort(reason);
  }

  /**
   * One pass: promote what is ready, dispatch what fits, reconcile each mission.
   *
   * Re-entrant calls collapse into a single pass plus a follow-up, so a burst of
   * `wake()` calls from the API cannot start the same task twice.
   */
  async tick(): Promise<void> {
    if (this.#ticking) {
      this.#wakeRequested = true;
      return;
    }
    this.#ticking = true;
    try {
      do {
        this.#wakeRequested = false;
        await this.#pass();
      } while (this.#wakeRequested && this.#running);
    } finally {
      this.#ticking = false;
    }
  }

  async #pass(): Promise<void> {
    try { this.deps.watchMerges?.(); } catch (e) { this.deps.log.warn('scheduler.merge_watch_failed', { error: errorMessage(e) }); }
    this.#sweepStrandedFeedback();
    // First, so a step re-resolved to an agent is dispatched in this same pass.
    this.#sweepEscalations();
    // Due routines add their queued drafts first, so the pull below sees them.
    await this.#fireRoutines();
    // In the background: a draft it adds is pulled on a later pass.
    this.#syncIssues();
    this.#syncIntake();
    // Before dispatch: a slot freed by the last pass is filled from the backlog
    // now, and the mission it pulls is planning by the time this pass reconciles.
    await this.#pullBacklog();

    // In backlog order, not list order (newest first): when the workers are
    // full, the next free slot goes to the most urgent mission (P7).
    const missions = this.deps.missions
      .list({ statuses: DISPATCHABLE })
      .filter((m) => !isTerminalMissionStatus(m.status))
      .sort(compareBacklog);

    for (const mission of missions) {
      this.#promoteReady(mission);
      this.#dispatchFor(mission);
    }
    // Reconciliation reads the state dispatch just wrote, so it runs after -
    // and after the loop, so a mission whose last task finished during this
    // pass is completed in this pass rather than one tick later.
    for (const mission of missions) {
      await this.#reconcile(this.deps.missions.get(mission.id) ?? mission);
    }
    // Last: silence produces no event of its own, so this pass is what notices it.
    // It never stops a run; the wall-time budget stays the only automatic stop.
    this.#watchLiveness();
  }

  #watchLiveness(): void {
    try {
      this.deps.watchLiveness?.();
    } catch (e) {
      this.deps.log.warn('scheduler.liveness_watch_failed', { error: errorMessage(e) });
    }
  }

  // ------------------------------------------------------------------ readiness

  /**
   * PENDING → READY once every dependency has succeeded (or was deliberately
   * skipped), PENDING → BLOCKED when a dependency can never succeed.
   *
   * A failed dependency has to block rather than be ignored: running a QA task
   * whose implementation failed produces a report about code that was never
   * written.
   */
  #promoteReady(mission: Mission): void {
    const tasks = this.deps.tasks.listByMission(mission.id);
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    const scope = scopeOf(mission);

    for (const task of tasks) {
      // Blocked only because an upstream task had died - and that task has
      // since been retried. Without this, retrying a cancelled or failed task
      // left everything downstream BLOCKED forever: the retried task would
      // succeed and the mission would still never finish.
      if (task.status === 'BLOCKED' && task.statusReason?.startsWith(DEPENDENCY_BLOCK_PREFIX)) {
        const upstream = task.dependsOn.map((key) => byKey.get(key)).filter((d) => d !== undefined);
        if (upstream.every((d) => d.status !== 'FAILED' && d.status !== 'CANCELLED')) {
          this.#setStatus(task, scope, 'PENDING', null);
        } else {
          continue;
        }
      } else if (task.status !== 'PENDING') {
        continue;
      }

      const missing = task.dependsOn.filter((key) => !byKey.has(key));
      if (missing.length > 0) {
        this.#setStatus(task, scope, 'BLOCKED', `Depends on unknown task(s): ${missing.join(', ')}.`);
        continue;
      }
      const dependencies = task.dependsOn.map((key) => byKey.get(key)!);
      const dead = dependencies.filter((d) => d.status === 'FAILED' || d.status === 'CANCELLED');
      if (dead.length > 0) {
        this.#setStatus(
          task, scope, 'BLOCKED',
          `${DEPENDENCY_BLOCK_PREFIX}${dead.map((d) => `${d.key} (${d.status})`).join(', ')}.`,
        );
        continue;
      }
      const satisfied = dependencies.every((d) => d.status === 'SUCCEEDED' || d.status === 'SKIPPED');
      if (!satisfied) continue;
      // A dependency that said the plan no longer fits holds this step until a
      // person answers; the reason is written once, not on every pass.
      const held = this.#planFitHold(mission, dependencies);
      if (held !== null) {
        if (task.statusReason !== held) this.#setStatus(task, scope, 'PENDING', held);
        continue;
      }
      // Resolved in the same write that makes it READY: from here on, changes
      // to the workspace's or mission's staffing no longer move this task.
      this.#setStatus(task, scope, 'READY', null, this.#resolveStaffing(task));
    }
  }

  #planFitHold(mission: Mission, dependencies: readonly MissionTask[]): string | null {
    if (this.deps.planFit === undefined) return null;
    for (const dependency of dependencies) {
      try {
        const held = this.deps.planFit.holdBehind(mission, dependency);
        if (held !== null) return held;
      } catch (e) {
        // A card that cannot be filed must not stop the mission: say so, and let the step run as planned.
        this.deps.log.warn('scheduler.plan_fit_failed', { taskId: dependency.id, error: errorMessage(e) });
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ dispatch

  #dispatchFor(mission: Mission): void {
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) return;

    const ceiling = Math.max(1, workspace.concurrency.maxTotalWorkers);
    const now = this.deps.clock.epochMs();

    // A task can reach READY without passing through promotion - planned with
    // no dependencies, retried, sent back by a failed gate, handed back by
    // recovery. One that has never been resolved is resolved here, before
    // anything routes on it; one already resolved is resolved again only if
    // it names someone who has since left, so a mid-mission staffing edit
    // still never moves work that reached READY.
    for (const task of this.deps.tasks.listByMission(mission.id)) {
      if (task.status !== 'READY' || this.#active.has(task.id)) continue;
      // Back in READY by whatever path, a task starts its next wait fresh: the
      // people an escalation reached were for the wait it left.
      if ((task.staffing?.escalatedTo ?? []).length > 0) {
        this.deps.tasks.update(task.id, { staffing: withoutEscalation(task.staffing!) });
      }
      if (task.staffing != null && !this.#isStale(task)) continue;
      const patch = this.#resolveStaffing(task);
      if (Object.keys(patch).length > 0) this.deps.tasks.update(task.id, patch);
    }

    const tasks = this.deps.tasks.listByMission(mission.id);
    // A wait lives in memory. One left AWAITING_EXTERNAL by a previous daemon
    // has no poller, and nothing else would ever move it: adopt it again.
    for (const task of tasks) {
      // A ship step waiting on CI, GitHub or a person is watched again every so often (#53 §8.1),
      // and adopted again after a restart.
      if ((task.status === 'AWAITING_EXTERNAL' || task.status === 'AWAITING_APPROVAL') && task.executor === 'ship' && !this.#waiting.has(task.id)) {
        const last = this.#shipWatched.get(task.id) ?? 0;
        const failures = this.#shipFailures.get(task.id) ?? 0;
        const every = Math.min((this.deps.shipPollMs ?? 30_000) * 2 ** failures, SHIP_BACKOFF_CAP_MS);
        if (now - last >= every) {
          this.#shipWatched.set(task.id, now);
          this.#startShip(mission, task);
        }
      }
      if (task.status === 'AWAITING_EXTERNAL' && task.executor === 'wait' && !this.#waiting.has(task.id)) {
        this.#startWait(mission, task);
      }
    }

    const ready = tasks
      .filter((t) => t.status === 'READY')
      .filter((t) => !this.#active.has(t.id))
      .filter((t) => (this.#retryAfter.get(t.id) ?? 0) <= now)
      .sort((a, b) => a.orderHint - b.orderHint || a.key.localeCompare(b.key));

    // Asked once per mission per pass, and only when an agent run would start:
    // a mission or project at its limit starts nothing (P8).
    let admitted: boolean | undefined;
    for (const task of ready) {
      // A person's task never occupies a worker slot, and is parked before the
      // ceiling is consulted: waiting on a human is not a reason to stop
      // dispatching the agent work that can proceed alongside it.
      if (task.executor === 'human') {
        this.#setStatus(task, scopeOf(mission), 'AWAITING_HUMAN', this.#waitingFor(task));
        continue;
      }
      // A wait holds no model and no worker slot: it is one command on an
      // interval. Counting it against the ceiling would let a twenty-minute
      // deploy wait block agent work that could run alongside it.
      if (task.executor === 'wait') {
        this.#startWait(mission, task);
        continue;
      }
      // The ship step is the daemon's own work (#53 §8.1): like a wait, it holds no model and no worker slot.
      if (task.executor === 'ship') {
        this.#startShip(mission, task);
        continue;
      }
      if (this.#occupiedSlots() >= ceiling) return;
      admitted ??= (this.deps.limits?.admit(mission.id) ?? null) === null;
      if (!admitted) return;
      this.#dispatch(mission, task);
    }
  }

  /**
   * Workers actually competing for the machine.
   *
   * A run blocked inside `ask_human` is still in `#active` - it has to be, or
   * `stop()` and `cancelTask()` could not abort it - but it is parked on a
   * person and consuming nothing. Counting it would let one unanswered question
   * stall every other task in the mission, which is the opposite of what asking
   * is for. The status is read from the row rather than tracked here, in keeping
   * with the scheduler holding no model of its own.
   */
  #occupiedSlots(): number {
    let occupied = 0;
    for (const taskId of this.#active.keys()) {
      const status = this.deps.tasks.get(taskId)?.status;
      if (status === undefined || !isTaskParked(status)) occupied++;
    }
    return occupied;
  }

  /**
   * Starts a wait, outside the concurrency ceiling.
   *
   * Tracked in its own map so `stop()` can cancel it and so the scheduler knows
   * a wait is in flight without treating it as a worker.
   */
  #startWait(mission: Mission, task: MissionTask): void {
    const policy = task.waitPolicy;
    if (policy === null) {
      this.#setStatus(task, scopeOf(mission), 'BLOCKED',
        `Task '${task.key}' is a wait step but names nothing to wait for.`);
      return;
    }

    const controller = new AbortController();
    this.#waiting.set(task.id, controller);
    // Adopted after a restart, a wait keeps what it last said and when it started: that is how long it has waited.
    if (task.status !== 'AWAITING_EXTERNAL') {
      this.#setStatus(task, scopeOf(mission), 'AWAITING_EXTERNAL', `Waiting: ${policy.command}`, { startedAt: this.deps.clock.now() });
    } else if (task.startedAt === null) {
      this.deps.tasks.update(task.id, { startedAt: this.deps.clock.now() });
    }

    const repository = task.repositoryId === null
      ? (mission.repositoryId === null ? null : this.deps.repositories.get(mission.repositoryId) ?? null)
      : this.deps.repositories.get(task.repositoryId) ?? null;

    // A CI wait on a pull request is decided by the pull request (#143), on every look, so a wait planned before this recovers too.
    const target = ciWaitTarget(policy.command);
    const prWait = this.deps.prWait;
    const options = {
      ...(target === null || prWait === undefined ? {} : {
        look: (waitedMs: number) => {
          const rerun = this.#rerunHead.get(task.id);
          const rerunHead = rerun !== undefined && rerun.until > this.deps.clock.epochMs() ? rerun.head : null;
          return prWait.look({ mission, target, repository, waitedMs, failedHead: this.#failedHead.get(task.id) ?? null, rerunHead });
        },
      }),
      progress: (detail: string, pr: PullRequestRef | null) => {
        if (pr !== null) this.deps.ship?.found(mission, task, pr);
        const current = this.deps.tasks.get(task.id);
        if (current === undefined || current.status !== 'AWAITING_EXTERNAL' || current.statusReason === detail) return;
        this.deps.tasks.update(task.id, { statusReason: detail });
        this.deps.recorder.invalidate('tasks', mission.id);
      },
    };

    void this.deps.waiter
      .wait(task, policy, repository, controller.signal, options)
      .then(async (outcome) => {
        if (outcome.kind === 'cancelled') return;
        // Retried, skipped or cancelled while the last look was out: what a person did stands.
        if (controller.signal.aborted || this.deps.tasks.get(task.id)?.status !== 'AWAITING_EXTERNAL') return;
        await this.#waitSettled(mission, task, outcome);
        this.deps.recorder.invalidate('tasks', mission.id);
        this.wake();
      })
      .catch((e: unknown) => {
        this.#setStatus(this.deps.tasks.get(task.id) ?? task, scopeOf(mission), 'BLOCKED',
          `The wait failed outside the poll: ${errorMessage(e)}`);
      })
      .finally(() => {
        if (this.#waiting.get(task.id) === controller) this.#waiting.delete(task.id);
      });
  }

  /** Where a wait's outcome leaves its step, and for a pull request, the mission (#143). */
  async #waitSettled(mission: Mission, task: MissionTask, outcome: Exclude<WaitOutcome, { kind: 'cancelled' }>): Promise<void> {
    const scope = scopeOf(mission);
    const current = (): MissionTask => this.deps.tasks.get(task.id) ?? task;
    const finish = (status: 'SUCCEEDED' | 'FAILED', reason: string): void => {
      this.#setStatus(current(), scope, status, reason, { finishedAt: this.deps.clock.now() });
    };
    if (outcome.pr !== undefined) this.deps.ship?.found(mission, task, outcome.pr);
    switch (outcome.kind) {
      case 'passed':
        this.#failedHead.delete(task.id);
        finish('SUCCEEDED', outcome.detail);
        return;
      case 'timedOut':
        finish('FAILED', outcome.detail);
        return;
      case 'closed':
        this.#setStatus(current(), scope, 'BLOCKED', outcome.detail);
        return;
      case 'ciFailed': {
        const ship = this.deps.ship;
        const sent = ship === undefined ? { kind: 'blocked' as const, reason: outcome.detail } : await ship.ciFailed(mission, current(), [outcome.failing, ...(outcome.others ?? [])], outcome.pr);
        if (sent.kind === 'waiting') {
          // The pull request itself was fixed (#194): the wait goes on while its checks run again.
          this.#rerunHead.set(task.id, { head: outcome.pr.headSha, until: sent.until ?? this.deps.clock.epochMs() });
          return;
        }
        this.#rerunHead.delete(task.id);
        if (sent.kind === 'reopened') {
          this.#failedHead.set(task.id, outcome.pr.headSha);
          this.#setStatus(current(), scope, 'PENDING', sent.reason);
        } else {
          this.#setStatus(current(), scope, 'BLOCKED', sent.kind === 'blocked' ? sent.reason : outcome.detail);
        }
        return;
      }
      case 'merged': {
        this.#failedHead.delete(task.id);
        // Merged by a person on GitHub: the mission is done. The ship step records it as theirs,
        // and what was still to come only led up to that merge. The wait finishes last, so no pass
        // starts the ship step in between.
        const tasks = this.deps.tasks.listByMission(mission.id);
        const shipTask = tasks.find((t) => t.executor === 'ship' && !isTaskFinished(t.status));
        const shipped = this.deps.ship === undefined ? null : await this.deps.ship.mergedOnGitHub(mission, shipTask ?? null, outcome.pr);
        if (shipTask !== undefined) {
          const reason = shipped?.kind === 'merged' ? shipped.reason : outcome.detail;
          this.#setStatus(this.deps.tasks.get(shipTask.id) ?? shipTask, scope, 'SUCCEEDED', reason, { finishedAt: this.deps.clock.now() });
        }
        const after = downstreamOf(task, this.deps.tasks.listByMission(mission.id));
        for (const t of after) {
          if (!['PENDING', 'READY', 'AWAITING_HUMAN'].includes(t.status)) continue;
          this.#setStatus(t, scope, 'SKIPPED', `Not needed: the pull request was merged in GitHub (${outcome.pr.url}).`, { finishedAt: this.deps.clock.now() });
          for (const card of this.deps.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).filter((a) => a.taskId === t.id)) {
            this.deps.approvals.update(card.id, { status: 'CANCELLED', decidedAt: this.deps.clock.now() });
          }
        }
        this.deps.recorder.invalidate('approvals', mission.id);
        finish('SUCCEEDED', outcome.detail);
        return;
      }
    }
  }

  /** Runs the ship step outside the ceiling, tracked like a wait so `stop()` can cancel it. */
  #startShip(mission: Mission, task: MissionTask): void {
    const ship = this.deps.ship;
    if (ship === undefined) {
      this.#setStatus(task, scopeOf(mission), 'SKIPPED', 'This daemon has no ship step, so no pull request was opened.');
      return;
    }
    if (this.#waiting.has(task.id)) return;
    const controller = new AbortController();
    this.#waiting.set(task.id, controller);
    if (task.status === 'READY' || task.status === 'PENDING') this.#setStatus(task, scopeOf(mission), 'RUNNING', 'Opening the pull request.');
    if (task.startedAt === null) this.deps.tasks.update(task.id, { startedAt: this.deps.clock.now() });
    void ship.run(mission, task, controller.signal)
      .then((outcome) => {
        this.#shipFailures.delete(task.id);
        if (this.#shipReasonBefore.has(task.id)) {
          const before = this.#shipReasonBefore.get(task.id) ?? null;
          this.#shipReasonBefore.delete(task.id);
          const now = this.deps.tasks.get(task.id);
          // Only if the look itself didn't say something newer.
          if (now !== undefined && /^GitHub didn't answer/.test(now.statusReason ?? '')) this.deps.tasks.update(task.id, { statusReason: before });
        }
        const current = this.deps.tasks.get(task.id) ?? task;
        const finish = (status: 'SUCCEEDED' | 'SKIPPED' | 'BLOCKED', reason: string) => {
          this.#setStatus(current, scopeOf(mission), status, reason);
          if (status !== 'BLOCKED') this.deps.tasks.update(task.id, { finishedAt: this.deps.clock.now() });
        };
        if (outcome.kind === 'cancelled' || outcome.kind === 'waiting') return;
        if (outcome.kind === 'merged') finish('SUCCEEDED', outcome.reason);
        else if (outcome.kind === 'reopened') this.#setStatus(current, scopeOf(mission), 'PENDING', outcome.reason);
        else if (outcome.kind === 'opened') finish('SUCCEEDED', `Pull request opened: ${outcome.prs.map((p) => p.url).join(', ')}`);
        else if (outcome.kind === 'skipped') finish('SKIPPED', outcome.reason);
        else if (outcome.kind === 'blocked') finish('BLOCKED', outcome.reason);
        else if (outcome.kind === 'escalated') this.#setStatus(current, scopeOf(mission), 'PENDING', `Waiting for ${outcome.added.join(', ')} before opening the pull request.`);
        else this.#setStatus(current, scopeOf(mission), 'PENDING', `Waiting for ${outcome.taskKey} to resolve the merge conflict.`);
        this.deps.recorder.invalidate('tasks', mission.id);
        this.wake();
      })
      .catch((e: unknown) => {
        const current = this.deps.tasks.get(task.id) ?? task;
        // Once its pull request is open and waiting, a failed call to GitHub is retried on the next look, not a blocked step.
        if (current.status === 'AWAITING_EXTERNAL' || current.status === 'AWAITING_APPROVAL') {
          const failures = (this.#shipFailures.get(task.id) ?? 0) + 1;
          this.#shipFailures.set(task.id, failures);
          if (!this.#shipReasonBefore.has(task.id)) this.#shipReasonBefore.set(task.id, current.statusReason ?? null);
          const next = Math.min((this.deps.shipPollMs ?? 30_000) * 2 ** failures, SHIP_BACKOFF_CAP_MS);
          this.deps.log.warn('ship.look_failed', { missionId: mission.id, taskId: task.id, failures, error: errorMessage(e) });
          this.deps.tasks.update(task.id, { statusReason: `GitHub didn't answer (${errorMessage(e)}); Tandemise tries again in ${waitWords(next)}.` });
          this.deps.recorder.invalidate('tasks', mission.id);
          return;
        }
        this.#setStatus(current, scopeOf(mission), 'BLOCKED', `The ship step failed: ${errorMessage(e)}`);
      })
      .finally(() => {
        this.#waiting.delete(task.id);
      });
  }

  #dispatch(mission: Mission, task: MissionTask): void {
    const controller = new AbortController();
    this.#active.set(task.id, controller);
    this.#retryAfter.delete(task.id);

    const attempt = this.deps.executor
      .execute(task.id, controller.signal)
      .then((outcome) => this.#settled(mission, task, outcome))
      .catch((e: unknown) => {
        // The executor already settles its own failures; reaching here means the
        // attempt threw outside that path, so the task would otherwise sit in
        // RUNNING forever.
        this.deps.log.error('scheduler.attempt_threw', {
          missionId: mission.id, taskId: task.id, error: errorMessage(e),
        });
        this.#setStatus(
          this.deps.tasks.get(task.id) ?? task, scopeOf(mission), 'BLOCKED',
          `The attempt failed outside the run: ${errorMessage(e)}`,
        );
      })
      .finally(() => {
        this.#active.delete(task.id);
        this.#inFlight.delete(attempt);
      });

    this.#inFlight.add(attempt);
  }

  #settled(mission: Mission, task: MissionTask, outcome: TaskAttemptOutcome): void {
    if (outcome.kind === 'deferred') {
      // Contention, not failure. Hold the slot open for a moment so a pair of
      // tasks fighting over one resource do not spin against each other.
      this.#retryAfter.set(task.id, this.deps.clock.epochMs() + (outcome.retryAfterMs ?? 1_000));
      // Said once, on the row: a READY task that never starts, with no reason
      // anywhere, is indistinguishable from a hung scheduler.
      const waiting = this.deps.tasks.get(task.id);
      if (waiting !== undefined && waiting.status === 'READY' && waiting.statusReason !== outcome.reason) {
        this.deps.tasks.update(task.id, { statusReason: outcome.reason });
        this.deps.recorder.invalidate('tasks', mission.id);
      }
      return;
    }
    if (outcome.retryAfterMs !== undefined) {
      this.#retryAfter.set(task.id, this.deps.clock.epochMs() + outcome.retryAfterMs);
    }
    if (outcome.status === 'SUCCEEDED' || outcome.status === 'FAILED' || outcome.status === 'BLOCKED') {
      this.deps.outcomes?.stepSettled(mission, this.deps.tasks.get(task.id) ?? task);
    }
    if (outcome.status !== 'SUCCEEDED') return;

    // Loopback: a review or QA task that found blocking problems becomes work.
    const settledTask = this.deps.tasks.get(task.id);
    if (settledTask === undefined) return;
    if (!settledTask.expectedOutputs.some((t) => t === 'ReviewReport' || t === 'QAReport')) return;

    const current = this.deps.missions.get(mission.id) ?? mission;
    // A review's findings go back to the author as a round; only when there is
    // no single reviewed task to send them to does a fix task take them (spec §5).
    if (settledTask.expectedOutputs.includes('ReviewReport')) {
      let routed: ReviewRouting = { kind: 'none' };
      try {
        routed = this.deps.rounds.fromReviewFindings(settledTask, current);
      } catch (e) {
        // Nothing was written (it is one unit), and a finding must not be lost:
        // the fix-task flow below still turns it into work.
        this.deps.log.warn('scheduler.review_round_failed', { missionId: mission.id, taskId: task.id, error: errorMessage(e) });
      }
      if (routed.kind === 'round' || routed.kind === 'noted') {
        // Outside the try: the findings are committed as notes, so a failure
        // stopping a dependent must never also plan fix tasks for them.
        this.deps.rounds.stopOvertaken(routed.begun);
        this.deps.log.info('scheduler.review_round', {
          missionId: mission.id, reviewed: routed.reviewedTaskId, routed: routed.kind, findings: routed.items,
          ...(routed.kind === 'round' ? { round: routed.round } : {}),
        });
        this.wake();
        return;
      }
      if (routed.kind === 'exhausted') {
        this.deps.remediation.escalate(settledTask, current, routed.blocking);
        return;
      }
    }
    const planned = this.deps.remediation.plan(settledTask, current);
    if (planned.kind === 'planned') {
      this.deps.log.info('scheduler.remediation_planned', {
        missionId: mission.id, taskId: task.id, fix: planned.fixKey, findings: planned.findings,
      });
    }
  }

  // --------------------------------------------------------------- reconcile

  /**
   * Decides what the mission as a whole is now doing.
   *
   * "Stalled" is defined structurally rather than by counting failures: if no
   * task is in an active status, nothing will move again without a human,
   * whatever the individual statuses say. A task waiting on a person counts as
   * active - the mission is not stuck, it is waiting, and calling that BLOCKED
   * would report a problem where there is only a queue. That covers the
   * cases a status-counting rule misses - a PENDING task whose dependency is
   * blocked, a mission whose only remaining work is behind a rejected approval.
   */
  async #reconcile(mission: Mission): Promise<void> {
    if (isTerminalMissionStatus(mission.status)) return;
    const tasks = this.deps.tasks.listByMission(mission.id);
    if (tasks.length === 0) return;

    if (tasks.every((t) => isTaskFinished(t.status))) {
      // A task's row reads SUCCEEDED before its attempt has settled: the
      // executor still releases the run's tool surface and target, and only
      // then does `#settled` turn a review's findings into a round or an
      // escalation. Finishing in that gap marked the mission COMPLETE and left
      // the escalation unable to block it. The next pass finishes it instead.
      if (tasks.some((t) => this.#active.has(t.id))) return;
      await this.#finish(mission, tasks);
      return;
    }

    const movable = tasks.some((t) => ACTIVE_TASK_STATUSES.includes(t.status) || isHeldForPlanFit(t));
    if (!movable && this.#active.size === 0) {
      const stuck = tasks.filter((t) => t.status === 'BLOCKED');
      this.#setMissionStatus(
        mission, 'BLOCKED',
        stuck.length > 0
          ? `Waiting on ${stuck.map((t) => t.key).join(', ')}: ${stuck[0]?.statusReason ?? 'no reason recorded'}`
          : 'No task can make progress without human intervention.',
      );
    }
  }

  async #finish(mission: Mission, tasks: readonly MissionTask[]): Promise<void> {
    const failed = tasks.filter((t) => t.status === 'FAILED');
    if (failed.length > 0) {
      this.#setMissionStatus(
        mission, 'FAILED',
        `${failed.length} task(s) failed: ${failed.map((t) => t.key).join(', ')}.`,
      );
      return;
    }

    // A cancelled task is work that did not happen. Counting it as done marked a
    // mission COMPLETE ("every task succeeded") while its release check had
    // been stopped mid-run - and a COMPLETE mission can no longer be revived by
    // retrying that task.
    const cancelled = tasks.filter((t) => t.status === 'CANCELLED');
    if (cancelled.length > 0) {
      this.#setMissionStatus(
        mission, 'BLOCKED',
        `${cancelled.map((t) => t.key).join(', ')} ${cancelled.length === 1 ? 'was' : 'were'} cancelled before finishing. Retry or skip to finish the mission.`,
      );
      return;
    }

    // Integration before completion: merging can insert a conflict-resolution
    // task, and a mission marked COMPLETE with unmerged work is a lie. A plan
    // with a ship step integrated there, before its pull request (#53 §8.1).
    if (!this.#integrated.has(mission.id) && !tasks.some((t) => t.executor === 'ship')) {
      this.#integrated.add(mission.id);
      try {
        const outcome = await this.deps.integration.integrate(mission);
        if (outcome.conflictTaskKey !== null) {
          this.deps.log.warn('scheduler.integration_conflict', {
            missionId: mission.id, task: outcome.conflictTaskKey,
          });
          // The new task is PENDING; the next tick promotes and runs it.
          return;
        }
      } catch (e) {
        this.deps.recorder.note(
          scopeOf(mission), `Branch integration failed: ${errorMessage(e)}`, 'error',
        );
        this.#setMissionStatus(mission, 'BLOCKED', `Branch integration failed: ${errorMessage(e)}`);
        return;
      }
    }

    const skipped = tasks.filter((t) => t.status === 'SKIPPED').length;
    this.#setMissionStatus(
      mission, 'COMPLETE',
      skipped === 0 ? 'Every task succeeded.' : `Every task succeeded; ${skipped} were skipped.`,
    );
    this.deps.missions.update(mission.id, { completedAt: this.deps.clock.now() });
  }

  // ------------------------------------------------------------- transitions

  /**
   * The staffing snapshot for a task becoming READY, or nothing.
   *
   * A resolution that fails leaves the task unresolved rather than failing the
   * tick: dispatch then routes it the way it always did, which is a better
   * outcome for one misconfigured workspace than stopping every mission.
   */
  #resolveStaffing(task: MissionTask): Partial<MissionTask> {
    try {
      return this.deps.staffing.snapshot(task) ?? {};
    } catch (e) {
      this.deps.log.warn('scheduler.staffing_unresolved', { taskId: task.id, error: errorMessage(e) });
      return {};
    }
  }

  #sweepEscalations(): void {
    try {
      this.deps.reviews.sweepEscalations(this.deps.clock.epochMs());
    } catch (e) {
      // Escalation is a courtesy to the people waiting; a failure here must
      // not stop the work that is not waiting on anyone.
      this.deps.log.warn('scheduler.escalation_failed', { error: errorMessage(e) });
    }
  }

  #syncIssues(): void {
    try {
      this.deps.syncIssues?.();
    } catch (e) {
      // Issue sync talks to GitHub; nothing it does may stop the pass.
      this.deps.log.warn('scheduler.issue_sync_failed', { error: errorMessage(e) });
    }
  }

  #syncIntake(): void {
    try {
      this.deps.syncIntake?.();
    } catch (e) {
      // Intake talks to the tracker; nothing it does may stop the pass.
      this.deps.log.warn('scheduler.intake_sync_failed', { error: errorMessage(e) });
    }
  }

  async #fireRoutines(): Promise<void> {
    if (this.deps.fireRoutines === undefined) return;
    try {
      await this.deps.fireRoutines();
    } catch (e) {
      // A routine that cannot run must not stop the pass that moves everything else.
      this.deps.log.warn('scheduler.routines_failed', { error: errorMessage(e) });
    }
  }

  async #pullBacklog(): Promise<void> {
    if (this.deps.pullBacklog === undefined) return;
    try {
      await this.deps.pullBacklog();
    } catch (e) {
      // The backlog is a convenience on top of dispatch; failing it must not stop work already running.
      this.deps.log.warn('scheduler.backlog_pull_failed', { error: errorMessage(e) });
    }
  }

  /** A note that arrived as a pass was settling is not lost: it waits as an open note on the card. */
  #sweepStrandedFeedback(): void {
    try {
      this.deps.rounds.releaseStranded();
    } catch (e) {
      // Like escalation, this tidies notes for people; it must never stop dispatch.
      this.deps.log.warn('scheduler.feedback_sweep_failed', { error: errorMessage(e) });
    }
  }

  #isStale(task: MissionTask): boolean {
    try {
      return this.deps.staffing.isStale(task);
    } catch (e) {
      this.deps.log.warn('scheduler.staffing_unresolved', { taskId: task.id, error: errorMessage(e) });
      return false;
    }
  }

  #waitingFor(task: MissionTask): string {
    return waitingReason(this.deps.members, task);
  }

  #setStatus(
    task: MissionTask, scope: EventScope, status: MissionTask['status'], reason: string | null,
    extra: Partial<MissionTask> = {},
  ): void {
    if (task.status === status && task.statusReason === reason) return;
    this.deps.tasks.update(task.id, { status, statusReason: reason, ...extra });
    this.deps.recorder.record({ ...scope, taskId: task.id, roleId: task.roleId }, {
      type: 'task.status',
      from: task.status,
      to: status,
      ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  #setMissionStatus(mission: Mission, status: MissionStatus, reason: string): void {
    if (mission.status === status) return;
    if (!canTransition(mission.status, status)) {
      this.deps.log.warn('scheduler.illegal_transition', {
        missionId: mission.id, from: mission.status, to: status,
      });
      return;
    }
    this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(scopeOf(mission), {
      type: 'mission.status', from: mission.status, to: status, reason,
    });
    this.deps.recorder.invalidate('missions', mission.id);
  }

  async #safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      // A scheduler that dies on one bad mission stops every other mission too.
      this.deps.log.error('scheduler.tick_failed', { error: errorMessage(e) });
    }
  }
}

/** Every step that depends on `task`, directly or through others. */
function downstreamOf(task: MissionTask, tasks: readonly MissionTask[]): readonly MissionTask[] {
  const found = new Set<string>([task.key]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) {
      if (found.has(t.key) || !t.dependsOn.some((d) => found.has(d))) continue;
      found.add(t.key);
      grew = true;
    }
  }
  return tasks.filter((t) => t.key !== task.key && found.has(t.key));
}

function scopeOf(mission: Mission): EventScope {
  return { workspaceId: mission.workspaceId, missionId: mission.id };
}

/** The longest wait between looks at a waiting ship step while GitHub keeps failing. */
const SHIP_BACKOFF_CAP_MS = 10 * 60_000;

function waitWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}
