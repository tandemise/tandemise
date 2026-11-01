import type {
  Approval, ApprovalRepositoryPort, EventRepositoryPort, FeedbackRepositoryPort, Mission, MissionRepositoryPort, MissionTask,
  PullRequestPort, RepoRepositoryPort, TaskRepositoryPort, TaskStatus, UnitOfWork,
} from '@tandemise/domain';
import {
  APPROVE_OPTION, CANCEL_MISSION_OPTION, CONTINUE_PLAN_OPTION, RECHECK_SHIP_OPTION, REJECT_OPTION, SKIP_REST_OPTION, SYSTEM_ACTOR,
  canTransition, isPlanFitCard, stepClassFor,
} from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { TandemiseError, errorMessage, type Clock, type Logger, type TaskId } from '@tandemise/shared';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { withdrawApproval } from '../support/withdraw.js';

/** The first line of the note a CI failure starts a round with (#197): "CI failed: <check> on commit <sha>". */
export const CI_ROUND_PREFIX = 'CI failed: ';
/** What a plan-fit card's "Re-check and continue to ship" writes once the re-check passed (#200). */
export const RECHECKED_NOTE = 'Re-checked:';
/** Evidence label on a card past the round cap (#196): each one approved allows one more round. */
export const ROUND_CAP_LABEL = 'Round cap';

/** A code step's round started by a red check on the pull request. */
export interface CiRound {
  readonly task: MissionTask;
  readonly round: number;
  /** The check that failed. */
  readonly check: string;
  /** The commit it failed on, as the note names it (7 characters); null when the note names none. */
  readonly sha: string | null;
}

/** The CI round `task` is in now: its current round holds a note that a red check started it. */
export function ciRoundOf(task: MissionTask, feedback: Pick<FeedbackRepositoryPort, 'listByTask'>): CiRound | null {
  const round = task.round ?? 1;
  if (round < 2) return null;
  const item = feedback.listByTask(task.id).filter((i) => i.round === round && i.text.startsWith(CI_ROUND_PREFIX)).at(-1);
  if (item === undefined) return null;
  const headline = item.text.split('\n')[0]!.slice(CI_ROUND_PREFIX.length);
  const parsed = /^(.*?)(?: on commit ([0-9a-f]{7,40}))?$/.exec(headline);
  return { task, round, check: parsed?.[1] ?? headline, sha: parsed?.[2] ?? null };
}

/** The rounds a mission has been through, feedback and CI alike: every round past each step's first. */
export function missionRounds(tasks: readonly MissionTask[]): number {
  return tasks.reduce((n, t) => n + Math.max(0, (t.round ?? 1) - 1), 0);
}

/** A code step: an agent's implement or conflict step, the one a CI round sends back. */
export function isCodeStep(task: MissionTask): boolean {
  return task.executor === 'agent' && (stepClassFor(task) === 'implement' || stepClassFor(task) === 'resolve_conflicts');
}

const CI_CHECK_PREFIX = 'Checking round ';

/** A step held while the CI round before it is checked: waiting on the next pass, not stuck. */
export function isHeldForCiCheck(task: Pick<MissionTask, 'status' | 'statusReason'>): boolean {
  return task.status === 'PENDING' && (task.statusReason ?? '').startsWith(CI_CHECK_PREFIX) && (task.statusReason ?? '').endsWith(' against CI.');
}

export function droppedReason(round: CiRound, sha: string): string {
  return `Round ${round.round} dropped: ${round.check} passes now on commit ${sha.slice(0, 7)}, and nothing changed since it failed.`;
}

export function isDropped(task: MissionTask): boolean {
  return task.status === 'SUCCEEDED' && /^Round \d+ dropped: /.test(task.statusReason ?? '');
}

/** What CI says now about the check a round was started for. */
export interface CiNow {
  readonly head: string;
  /** The pull request's head is still the commit the check failed on. */
  readonly sameHead: boolean;
  /** Every check passes, the failed one included. */
  readonly green: boolean;
  /** The failed check passes now, on the same head: the round's cause is gone. */
  readonly cleared: boolean;
  /** The failed check isn't failing any more but CI is still running. */
  readonly running: boolean;
  readonly at: number;
}

export interface CiRoundGuardDeps {
  readonly missions: Pick<MissionRepositoryPort, 'get' | 'update'>;
  readonly tasks: TaskRepositoryPort;
  readonly feedback: FeedbackRepositoryPort;
  readonly events: Pick<EventRepositoryPort, 'listByMission'>;
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly repositories: Pick<RepoRepositoryPort, 'get'>;
  readonly pullRequests: Pick<PullRequestPort, 'view' | 'checks'>;
  readonly exec: CommandExecutor | null;
  /** Each step's branch, as the ship step integrates them. */
  readonly branchesFor: (mission: Mission) => readonly { readonly taskKey: string; readonly branch: string }[];
  /** The pull requests the mission opened or found, oldest first. */
  readonly opened: (mission: Mission) => readonly { readonly repo: string; readonly number: number }[];
  /** Whether a step's output says the plan no longer fits (a plan-fit card handles that one). */
  readonly stops: (task: MissionTask) => boolean;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** How often CI is read again while a round waits on it. */
  readonly lookEveryMs: number;
}

/** How long "the round's cause still holds" stands before a step that hasn't started is checked again. */
const START_CHECK_TTL_MS = 60_000;

/**
 * Checks a CI-started round against CI as it is now (#196, #200), before the
 * round's next step starts:
 *
 * - The code step hasn't started its round yet (the mission was paused, the
 *   daemon restarted): if the check that failed passes now on the same head,
 *   the round is dropped, and the mission goes on to ship.
 * - The code step finished its round without changing anything (its branch
 *   is still the commit CI failed on, or the same tree): if CI passes now the
 *   round is dropped as above; otherwise another pass would read the same red
 *   result, so the step stops at once on a card.
 *
 * Read on each scheduler pass; what it found is held in memory, so a restart
 * checks again, which is what a resume should do.
 */
export class CiRoundGuard {
  /** Round checks that passed: the key and when. */
  readonly #checked = new Map<string, number>();
  /** When CI was last read for a round still waiting on it. */
  readonly #looked = new Map<string, number>();
  /** CI as last read, per mission, for the plan-fit card's choices. */
  readonly #ci = new Map<string, CiNow>();
  /** Each mission's `updatedAt` at its last review: a mission paused and resumed since is checked again. */
  readonly #stamp = new Map<string, string>();

  constructor(private readonly deps: CiRoundGuardDeps) {}

  /** A code step whose CI round hasn't been checked against CI yet waits to start. */
  waitsBeforeStart(task: MissionTask): boolean {
    if (!isCodeStep(task) || task.status !== 'READY') return false;
    const round = ciRoundOf(task, this.deps.feedback);
    return round !== null && !this.#fresh(startKey(round), START_CHECK_TTL_MS);
  }

  /** Work after a code step that just finished a CI round waits until that round is checked. */
  holdBehind(dependency: MissionTask): string | null {
    if (!isCodeStep(dependency) || dependency.status !== 'SUCCEEDED' || isDropped(dependency)) return null;
    const round = ciRoundOf(dependency, this.deps.feedback);
    if (round === null || this.#checked.has(doneKey(round))) return null;
    return `${CI_CHECK_PREFIX}${round.round} of '${dependency.key}' against CI.`;
  }

  /** CI as last read for the mission's pull request, when a round or a plan-fit card needed it. */
  ciNow(missionId: string): CiNow | undefined {
    return this.#ci.get(missionId);
  }

  /** One pass over a mission's CI rounds and plan-fit cards. Never throws: a round it can't check runs as planned. */
  async review(mission: Mission): Promise<void> {
    // Resumed, unblocked, retried: whatever stood about a round that hadn't started is read again.
    if (this.#stamp.get(mission.id) !== mission.updatedAt) {
      this.#stamp.set(mission.id, mission.updatedAt);
      for (const task of this.deps.tasks.listByMission(mission.id)) {
        for (const key of [...this.#checked.keys()]) if (key.startsWith(`${task.id}:`) && key.endsWith(':start')) this.#checked.delete(key);
      }
    }
    for (const task of this.deps.tasks.listByMission(mission.id)) {
      if (!isCodeStep(task)) continue;
      const round = ciRoundOf(task, this.deps.feedback);
      if (round === null) continue;
      try {
        if (task.status === 'READY' || task.status === 'PENDING') await this.#beforeStart(mission, round);
        else if (task.status === 'SUCCEEDED' && !isDropped(task)) await this.#afterRound(mission, round);
      } catch (e) {
        this.deps.log.warn('ci_rounds.check_failed', { missionId: mission.id, taskId: task.id, error: errorMessage(e) });
        this.#checked.set(startKey(round), this.deps.clock.epochMs());
        this.#checked.set(doneKey(round), this.deps.clock.epochMs());
      }
    }
    try {
      await this.#recommend(mission);
    } catch (e) {
      this.deps.log.warn('ci_rounds.recommend_failed', { missionId: mission.id, error: errorMessage(e) });
    }
  }

  /**
   * "Re-check and continue to ship" on a plan-fit card (#200): CI is read
   * now; if the check that started the round passes on the same head, the
   * round is dropped and the mission goes on to ship. Throws when it doesn't.
   */
  async recheck(card: Approval): Promise<void> {
    const task = card.taskId === null ? undefined : this.deps.tasks.get(card.taskId);
    const mission = card.missionId === null ? undefined : this.deps.missions.get(card.missionId);
    if (task === undefined || mission === undefined) throw TandemiseError.notFound('Task', card.taskId ?? '');
    const round = ciRoundOf(task, this.deps.feedback);
    if (round === null) throw TandemiseError.validation(`'${task.key}' is not in a round that CI started, so there is nothing to re-check.`);
    const now = await this.#prCi(mission, round.check, round.sha);
    if (now === null) throw TandemiseError.validation('There is no open pull request to re-check.');
    if (!now.sameHead) throw TandemiseError.validation(`The pull request's head moved to ${now.head.slice(0, 7)} since ${round.check} failed, so the round still has to run. Continue as planned, or plan the rest again.`);
    if (!now.cleared) throw TandemiseError.validation(`${round.check} still ${now.running ? 'runs' : 'fails'} on commit ${now.head.slice(0, 7)}. The card is open again.`);
    this.#drop(mission, round, now, card);
  }

  // ----------------------------------------------------------------- checks

  async #beforeStart(mission: Mission, round: CiRound): Promise<void> {
    const key = startKey(round);
    if (this.#fresh(key, START_CHECK_TTL_MS) || !this.#due(key)) return;
    this.#looked.set(key, this.deps.clock.epochMs());
    const now = await this.#prCi(mission, round.check, round.sha);
    if (now?.cleared === true) { this.#drop(mission, round, now, null); return; }
    // Still running: looked at again shortly, and the round waits for it.
    if (now?.running === true) return;
    this.#checked.set(key, this.deps.clock.epochMs());
  }

  async #afterRound(mission: Mission, round: CiRound): Promise<void> {
    const key = doneKey(round);
    if (this.#checked.has(key) || !this.#due(key)) return;
    const unchanged = await this.#unchanged(mission, round);
    if (unchanged !== true) { this.#checked.set(key, this.deps.clock.epochMs()); return; }
    this.#looked.set(key, this.deps.clock.epochMs());
    const now = await this.#prCi(mission, round.check, round.sha);
    if (now?.cleared === true) { this.#drop(mission, round, now, null); this.#checked.set(key, this.deps.clock.epochMs()); return; }
    if (now?.running === true) return;
    this.#checked.set(key, this.deps.clock.epochMs());
    // A step that said the plan no longer fits has its own card, which says why better than this one.
    if (this.deps.stops(round.task)) return;
    this.#sameTree(mission, round);
  }

  /** The step's branch is still the commit CI failed on, or the same tree. Null when that can't be read. */
  async #unchanged(mission: Mission, round: CiRound): Promise<boolean | null> {
    if (round.sha === null || this.deps.exec === null || mission.repositoryId === null) return null;
    const repository = this.deps.repositories.get(mission.repositoryId);
    const branch = this.deps.branchesFor(mission).find((b) => b.taskKey === round.task.key)?.branch;
    if (repository === undefined || branch === undefined) return null;
    const git = (args: readonly string[]) => this.deps.exec!.run({ command: 'git', args, cwd: repository.path, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    const failed = await git(['rev-parse', '--verify', '--quiet', `${round.sha}^{commit}`]);
    if (tip.exitCode !== 0 || failed.exitCode !== 0) return null;
    const [a, b] = [tip.stdout.trim(), failed.stdout.trim()];
    if ((await git(['merge-base', '--is-ancestor', a, b])).exitCode === 0) return true;
    const trees = await git(['rev-parse', `${a}^{tree}`, `${b}^{tree}`]);
    if (trees.exitCode !== 0) return null;
    const [ta, tb] = trees.stdout.trim().split('\n');
    return ta !== undefined && ta === tb;
  }

  /** CI on the mission's open pull request now, against the check a round started for. Null with no open pull request. */
  async #prCi(mission: Mission, check: string | null, sha: string | null): Promise<CiNow | null> {
    const known = this.deps.opened(mission).at(-1);
    const repository = mission.repositoryId === null ? undefined : this.deps.repositories.get(mission.repositoryId);
    if (known === undefined || repository === undefined) return null;
    const pr = await this.deps.pullRequests.view(repository.path, known.repo, known.number);
    if (pr.state !== 'OPEN') { this.#ci.delete(mission.id); return null; }
    const checks = await this.deps.pullRequests.checks(repository.path, pr.repo, pr.headSha);
    const sameHead = sha !== null && pr.headSha.startsWith(sha);
    const failing = check !== null && checks.failing.some((f) => f.name === check);
    const now: CiNow = {
      head: pr.headSha, sameHead, green: checks.state === 'PASS',
      cleared: sameHead && !failing && checks.state === 'PASS',
      running: sameHead && !failing && checks.state === 'PENDING',
      at: this.deps.clock.epochMs(),
    };
    this.#ci.set(mission.id, now);
    return now;
  }

  // ---------------------------------------------------------------- effects

  /**
   * The round's cause is gone: its notes are closed, the code step stands as
   * it was, the steps it reset are back as they were, a plan-fit card it
   * raised is answered, and ship goes on.
   */
  #drop(mission: Mission, round: CiRound, now: CiNow, card: Approval | null): void {
    const { deps } = this;
    const task = deps.tasks.get(round.task.id) ?? round.task;
    const reason = droppedReason(round, now.head);
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, actorId: SYSTEM_ACTOR };
    const at = deps.clock.now();
    deps.recorder.deferred(() => deps.unitOfWork.transaction(() => {
      for (const item of deps.feedback.listByTask(task.id)) {
        if (item.round !== round.round || (item.status !== 'open' && item.status !== 'in_round')) continue;
        deps.feedback.update(item.id, { status: 'addressed', round: round.round });
        deps.recorder.record(scope, { type: 'feedback.addressed', feedbackId: item.id, round: round.round, declined: false });
      }
      deps.tasks.update(task.id, { status: 'SUCCEEDED', statusReason: reason, finishedAt: task.finishedAt ?? at, needsAttention: false });
      deps.recorder.record(scope, { type: 'task.status', from: task.status, to: 'SUCCEEDED', reason });
      for (const [taskId, before] of this.#redoneBy(mission, task, round.round)) {
        const dependent = deps.tasks.get(taskId);
        if (dependent === undefined || (dependent.status !== 'PENDING' && dependent.status !== 'READY')) continue;
        const back = `Kept: round ${round.round} of '${task.key}' was dropped, so its earlier result stands.`;
        deps.tasks.update(dependent.id, { status: before, statusReason: back, finishedAt: dependent.finishedAt ?? at });
        deps.recorder.record({ ...scope, taskId: dependent.id }, { type: 'task.status', from: dependent.status, to: before, reason: back });
      }
      for (const open of deps.approvals.pendingForTask(task.id)) {
        if (open.id !== card?.id && isPlanFitCard(open)) withdrawApproval(deps, open, reason);
      }
      if (card !== null) {
        deps.approvals.update(card.id, { decisionNote: `${RECHECKED_NOTE} ${round.check} passes on commit ${now.head.slice(0, 7)}.${card.decisionNote ? ` ${card.decisionNote}` : ''}` });
      }
      const current = deps.missions.get(mission.id);
      if (current !== undefined && (current.status === 'BLOCKED') && canTransition(current.status, 'EXECUTING')) {
        deps.missions.update(mission.id, { status: 'EXECUTING', statusReason: reason });
        deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id }, { type: 'mission.status', from: current.status, to: 'EXECUTING', reason });
      }
      deps.recorder.note(scope, `${round.check} passes now on commit ${now.head.slice(0, 7)}, and nothing changed since it failed, so round ${round.round} of '${task.key}' is dropped and the mission goes on to ship.`);
    }));
    deps.recorder.invalidate('tasks', mission.id);
    deps.recorder.invalidate('approvals', mission.id);
  }

  /** The steps a round reset, each with the status it had before. */
  #redoneBy(mission: Mission, task: MissionTask, round: number): ReadonlyMap<TaskId, TaskStatus> {
    const events = this.deps.events.listByMission(mission.id, { semanticOnly: true });
    const started = events.filter((e) => e.taskId === task.id && e.body.type === 'task.round_started' && e.body.round === round).at(-1);
    if (started === undefined || started.body.type !== 'task.round_started') return new Map();
    const redone = new Set(started.body.redone);
    const tasks = this.deps.tasks.listByMission(mission.id).filter((t) => redone.has(t.key));
    const before = new Map<TaskId, TaskStatus>();
    const resetReason = `Redone after ${task.key} round ${round}`;
    for (const t of tasks) {
      const reset = events.filter((e) => e.taskId === t.id && e.body.type === 'task.status' && e.body.reason === resetReason).at(-1);
      const from = reset?.body.type === 'task.status' ? reset.body.from : undefined;
      if (from === 'SUCCEEDED' || from === 'SKIPPED') before.set(t.id, from);
    }
    return before;
  }

  /** The round made no change and CI still fails the same way: the step stops on a card. */
  #sameTree(mission: Mission, round: CiRound): void {
    const { deps } = this;
    const task = deps.tasks.get(round.task.id) ?? round.task;
    const reason = `Round ${round.round} made no change: '${task.key}' left the code as it was on commit ${round.sha}, where ${round.check} failed, so another round would read the same result.`;
    deps.tasks.update(task.id, { status: 'BLOCKED', statusReason: reason });
    deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, actorId: SYSTEM_ACTOR }, { type: 'task.status', from: task.status, to: 'BLOCKED', reason });
    roundStopCard(deps, mission, task, {
      title: `'${task.title}' made no change in round ${round.round}`,
      reason,
      failure: round.check,
    });
    deps.recorder.invalidate('tasks', mission.id);
  }

  /**
   * A pending plan-fit card on a step (#200) recommends what CI says now:
   * "Re-check and continue to ship" once a CI round's cause is gone, and never
   * skipping ship while the pull request is open and green.
   */
  async #recommend(mission: Mission): Promise<void> {
    const cards = this.deps.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).filter(isPlanFitCard);
    for (const card of cards) {
      const task = card.taskId === null ? undefined : this.deps.tasks.get(card.taskId);
      if (task === undefined) continue;
      const round = ciRoundOf(task, this.deps.feedback);
      const key = `card:${card.id}`;
      if (!this.#due(key)) continue;
      this.#looked.set(key, this.deps.clock.epochMs());
      const now = await this.#prCi(mission, round?.check ?? null, round?.sha ?? null);
      const wanted = recommendedFor(card, now);
      if (wanted === card.recommendedOptionId) continue;
      this.deps.approvals.update(card.id, {
        recommendedOptionId: wanted,
        options: card.options.map((o) => ({ ...o, recommended: o.id === wanted })),
      });
      this.deps.recorder.invalidate('approvals', mission.id);
    }
  }

  #fresh(key: string, ttl: number): boolean {
    const at = this.#checked.get(key);
    return at !== undefined && this.deps.clock.epochMs() - at < ttl;
  }

  /** CI is not read again for the same thing sooner than `lookEveryMs`. */
  #due(key: string): boolean {
    const last = this.#looked.get(key);
    return last === undefined || this.deps.clock.epochMs() - last >= this.deps.lookEveryMs;
  }
}

/** The plan-fit card's recommendation for CI as it is now (#200). */
export function recommendedFor(card: Pick<Approval, 'options'>, now: CiNow | null): string {
  const has = (id: string) => card.options.some((o) => o.id === id);
  if (now?.cleared === true && has(RECHECK_SHIP_OPTION)) return RECHECK_SHIP_OPTION;
  // An open pull request that passes its checks is never left without ship.
  if (now?.green === true) return has(RECHECK_SHIP_OPTION) ? RECHECK_SHIP_OPTION : CONTINUE_PLAN_OPTION;
  return SKIP_REST_OPTION;
}

const startKey = (r: CiRound) => `${r.task.id}:${r.round}:start`;
const doneKey = (r: CiRound) => `${r.task.id}:${r.round}:done:${r.task.attempts}`;

/**
 * A card that stops a mission's rounds (#196): past the round cap, or a round
 * that changed nothing. Try again allows one more; Hold leaves it stopped for
 * a person to look at; Cancel ends the mission.
 */
export function roundStopCard(
  deps: { readonly approvals: ApprovalRepositoryPort; readonly approvalFactory: ApprovalFactory; readonly recorder: EventRecorder },
  mission: Mission, task: MissionTask,
  input: { readonly title: string; readonly reason: string; readonly failure: string; readonly cap?: number; readonly logTail?: string | null; readonly link?: string | null },
): void {
  if (deps.approvals.pendingForTask(task.id).length > 0) return;
  const tail = (input.logTail ?? '').trim();
  const card = deps.approvalFactory.createOrThrow({
    workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, kind: 'intervention', risk: 'read',
    title: input.title,
    rationale: input.reason,
    effect: 'Try again allows one more round. Hold leaves the mission stopped here for you to look at. Cancel ends the mission.',
    evidence: [
      { kind: 'text', label: 'Why it stopped', value: input.reason },
      { kind: 'text', label: 'Last failure', value: input.failure },
      ...(input.link == null ? [] : [{ kind: 'link' as const, label: input.failure, value: input.link }]),
      ...(tail.length === 0 ? [] : [{ kind: 'text' as const, label: 'Log', value: tail }]),
      ...(input.cap === undefined ? [] : [{ kind: 'text' as const, label: ROUND_CAP_LABEL, value: String(input.cap) }]),
    ],
    options: [
      { id: APPROVE_OPTION, label: 'Try again' },
      { id: REJECT_OPTION, label: 'Hold' },
      { id: CANCEL_MISSION_OPTION, label: 'Cancel the mission' },
    ],
    recommendedOptionId: null,
    addressees: mission.createdBy === null || mission.createdBy === undefined ? [] : [mission.createdBy],
  });
  deps.approvals.create(card);
  deps.recorder.invalidate('approvals', mission.id);
}

