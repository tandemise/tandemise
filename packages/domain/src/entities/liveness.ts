import type { ApprovalKind } from './approval.js';
import type { MissionStatus } from './mission.js';
import type { TaskExecutor, TaskStatus } from './task.js';
import { canTransition } from './mission.js';

/**
 * Liveness (P9 spec §1): whether a mission can move, waits on the person with
 * an Inbox item, is parked by the person's own choice, is finished, or is
 * stalled - nothing moves it and nothing asks anyone.
 *
 * One pure function over rows, so the spec's table, the service that feeds it
 * and the check that seeds a mission per row are the same rule. Nothing an
 * agent says reaches it: only statuses, dependencies and open cards.
 */
export type LivenessKind = 'moving' | 'waiting' | 'parked' | 'finished' | 'stalled';

/** How one step stands, inside its mission. */
export type TaskStanding = 'moving' | 'waiting' | 'cause' | 'upstream' | 'done' | 'idle';

export interface LivenessRule {
  readonly id: string;
  readonly subject: 'mission' | 'task';
  readonly statuses: readonly string[];
  readonly condition: string;
  /** For a mission row, what it counts as; for a task row, how the step stands. */
  readonly kind: LivenessKind | TaskStanding;
}

/** Where the scheduler dispatches work. */
const WORKING: readonly MissionStatus[] = ['EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP'];

/** The spec's table, row for row. The check asserts every status has a row and every row is reached. */
export const LIVENESS_RULES: readonly LivenessRule[] = [
  { id: 'L1', subject: 'mission', statuses: ['COMPLETE', 'FAILED', 'CANCELLED'], condition: 'terminal', kind: 'finished' },
  { id: 'L2', subject: 'mission', statuses: ['RELEASED', 'OBSERVING'], condition: 'after shipping', kind: 'finished' },
  { id: 'L3', subject: 'mission', statuses: ['PAUSED'], condition: 'paused at a limit: its limit card is the item', kind: 'waiting' },
  { id: 'L4', subject: 'mission', statuses: ['PAUSED'], condition: 'paused by the person, or kept paused at a limit', kind: 'parked' },
  { id: 'L5', subject: 'mission', statuses: ['DRAFT'], condition: 'a refinement pass is running', kind: 'moving' },
  { id: 'L6', subject: 'mission', statuses: ['DRAFT'], condition: 'refinement left something to decide: the Refinement row', kind: 'waiting' },
  { id: 'L7', subject: 'mission', statuses: ['DRAFT'], condition: 'not queued', kind: 'parked' },
  { id: 'L8', subject: 'mission', statuses: ['DRAFT'], condition: 'queued and ready to plan: pulled when there is room', kind: 'moving' },
  { id: 'L9', subject: 'mission', statuses: ['DRAFT'], condition: 'queued, not ready, nothing to decide, not refining', kind: 'stalled' },
  { id: 'L10', subject: 'mission', statuses: ['PLANNING'], condition: 'the planner is running', kind: 'moving' },
  { id: 'L11', subject: 'mission', statuses: ['PLANNING'], condition: 'no planner is running', kind: 'stalled' },
  { id: 'L12', subject: 'mission', statuses: ['AWAITING_PLAN_APPROVAL'], condition: 'a pending plan card', kind: 'waiting' },
  { id: 'L13', subject: 'mission', statuses: ['AWAITING_PLAN_APPROVAL'], condition: 'no pending plan card', kind: 'stalled' },
  { id: 'L14', subject: 'mission', statuses: [...WORKING, 'BLOCKED'], condition: 'no steps', kind: 'stalled' },
  { id: 'L15', subject: 'mission', statuses: [...WORKING], condition: 'a step can move, or every step is finished', kind: 'moving' },
  { id: 'L16', subject: 'mission', statuses: ['BLOCKED'], condition: 'a live run settles', kind: 'moving' },
  { id: 'L17', subject: 'mission', statuses: [...WORKING, 'BLOCKED'], condition: 'nothing moves; a card or a step asks the person', kind: 'waiting' },
  { id: 'L18', subject: 'mission', statuses: [...WORKING, 'BLOCKED'], condition: 'nothing moves and nothing asks', kind: 'stalled' },
  { id: 'T1', subject: 'task', statuses: ['PENDING'], condition: 'every dependency succeeded or was skipped', kind: 'moving' },
  { id: 'T2', subject: 'task', statuses: ['PENDING'], condition: 'a dependency is not finished', kind: 'upstream' },
  { id: 'T3', subject: 'task', statuses: ['PENDING'], condition: 'a dependency failed or was cancelled', kind: 'upstream' },
  { id: 'T4', subject: 'task', statuses: ['READY'], condition: 'dispatched on the next pass', kind: 'moving' },
  { id: 'T5', subject: 'task', statuses: ['RUNNING'], condition: 'a live run', kind: 'moving' },
  { id: 'T6', subject: 'task', statuses: ['AWAITING_INPUT'], condition: 'a live run parked on its question card', kind: 'waiting' },
  { id: 'T7', subject: 'task', statuses: ['AWAITING_HUMAN'], condition: 'the Inbox step row', kind: 'waiting' },
  { id: 'T8', subject: 'task', statuses: ['AWAITING_EXTERNAL'], condition: 'a wait step polls until its timeout', kind: 'moving' },
  { id: 'T8b', subject: 'task', statuses: ['AWAITING_EXTERNAL'], condition: 'a parked agent task: the person who took it elsewhere is who it waits on', kind: 'waiting' },
  { id: 'T8c', subject: 'task', statuses: ['HELD'], condition: 'a person has the keyboard on it', kind: 'waiting' },
  { id: 'T8d', subject: 'task', statuses: ['AWAITING_EXTERNAL'], condition: 'a wait step past its stall threshold, or whose command can\'t run', kind: 'cause' },
  { id: 'T9', subject: 'task', statuses: ['AWAITING_APPROVAL'], condition: 'a pending card for it', kind: 'waiting' },
  { id: 'T10', subject: 'task', statuses: ['AWAITING_APPROVAL'], condition: 'no pending card', kind: 'cause' },
  { id: 'T11', subject: 'task', statuses: ['BLOCKED'], condition: 'a pending card for it', kind: 'waiting' },
  { id: 'T12', subject: 'task', statuses: ['BLOCKED'], condition: 'blocked by a dead upstream', kind: 'upstream' },
  { id: 'T13', subject: 'task', statuses: ['BLOCKED'], condition: 'any other reason', kind: 'cause' },
  { id: 'T14', subject: 'task', statuses: ['FAILED', 'CANCELLED'], condition: 'in a mission that is not finished', kind: 'cause' },
  { id: 'T15', subject: 'task', statuses: ['SUCCEEDED', 'SKIPPED'], condition: 'done', kind: 'done' },
];

export interface LivenessTaskInput {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly statusReason: string | null;
  readonly dependsOn: readonly string[];
  readonly attempts: number;
  readonly orderHint: number;
  /** Who carries it out (plan.ts); absent is read as `agent`, which every caller from before P3 means. */
  readonly executor?: TaskExecutor;
  /**
   * A wait step that has waited past `waitStalledAfterMs`, or whose command
   * can't run (#145): polling on is no longer a sign it moves. The service
   * derives it from the clock; absent is read as false.
   */
  readonly overdue?: boolean;
}

/**
 * How long a wait step may look before it counts as stalled (#145): half its
 * timeout, and never more than 30 minutes. A wait polls on its own until its
 * timeout, but a person should hear about one that is clearly not ending
 * well before then.
 */
export function waitStalledAfterMs(timeoutMs: number): number {
  return Math.min(Math.floor(timeoutMs / 2), 30 * 60_000);
}

/** The status line a wait writes once its command can't run at all (the waiter, #145). */
export const WAIT_BROKEN_PREFIX = "The wait can't run its command: ";

/** Whether a wait step that is AWAITING_EXTERNAL is overdue, from what it stores and the time. */
export function isWaitOverdue(task: {
  readonly executor?: TaskExecutor; readonly status: TaskStatus; readonly statusReason: string | null;
  readonly startedAt: string | null; readonly waitPolicy: { readonly timeoutMs: number } | null;
}, nowMs: number): boolean {
  if (task.executor !== 'wait' || task.status !== 'AWAITING_EXTERNAL') return false;
  if (task.statusReason?.startsWith(WAIT_BROKEN_PREFIX) === true) return true;
  if (task.startedAt === null || task.waitPolicy === null) return false;
  return nowMs - Date.parse(task.startedAt) >= waitStalledAfterMs(task.waitPolicy.timeoutMs);
}

export interface LivenessInput {
  readonly status: MissionStatus;
  readonly statusReason: string | null;
  readonly tasks: readonly LivenessTaskInput[];
  /** The mission's PENDING cards. */
  readonly cards: readonly { readonly taskId: string | null; readonly kind: ApprovalKind }[];
  /** A planner is running for it in this daemon. */
  readonly planning?: boolean;
  /** A refinement pass is running for it (P6). */
  readonly refining?: boolean;
  /** Queued in the backlog (P7). */
  readonly queued?: boolean;
  /** The readiness gate passes (P6). */
  readonly ready?: boolean;
  /** What is left to do before it can be planned: "Add at least one Done-when criterion to plan". */
  readonly readinessLabel?: string;
  /** Open questions plus pending proposals (P6). */
  readonly toDecide?: number;
}

/** The one thing a Stalled row offers, through a route that already exists. */
export type StalledAction =
  | { readonly kind: 'retry'; readonly label: string; readonly taskId: string; readonly taskKey: string }
  | { readonly kind: 'replan'; readonly label: 'Re-plan'; readonly taskId: null; readonly taskKey: null }
  | { readonly kind: 'refine'; readonly label: 'Refine'; readonly taskId: null; readonly taskKey: null }
  | { readonly kind: 'cancel'; readonly label: 'Cancel mission'; readonly taskId: null; readonly taskKey: null }
  /** The tracker refused Start's move to in progress (#187): try it again now. */
  | { readonly kind: 'tracker-move'; readonly label: 'Try the move again'; readonly taskId: null; readonly taskKey: null; readonly itemKey: string };

export interface LivenessVerdict {
  readonly kind: LivenessKind;
  /** The mission row that decided it (L1-L18). */
  readonly rule: string;
  /** What a person reads on the Stalled row; null unless stalled. */
  readonly reason: string | null;
  /** Null unless stalled. */
  readonly action: StalledAction | null;
  /** Each step's row and standing, for the check and the facts. */
  readonly tasks: readonly { readonly id: string; readonly key: string; readonly rule: string; readonly standing: TaskStanding }[];
}

const REPLAN: StalledAction = { kind: 'replan', label: 'Re-plan', taskId: null, taskKey: null };

/**
 * Where the Stalled row offers Re-plan (P9). Not `canTransition(…, 'PLANNING')`:
 * EXECUTING may enter PLANNING for a replan of the rest, which the replan
 * service guards; a working mission's row keeps offering what P9 specified.
 */
const REPLANNABLE: readonly MissionStatus[] = ['AWAITING_PLAN_APPROVAL', 'BLOCKED', 'PAUSED', 'FAILED'];
const replannable = (status: MissionStatus): boolean => REPLANNABLE.includes(status);
const REFINE: StalledAction = { kind: 'refine', label: 'Refine', taskId: null, taskKey: null };
const CANCEL: StalledAction = { kind: 'cancel', label: 'Cancel mission', taskId: null, taskKey: null };

/** A dependency block the scheduler wrote; the cause is the dead upstream, not this step. */
const DEPENDENCY_BLOCK_PREFIX = 'Blocked by ';

/**
 * A pause at a limit, whose card (P8) is the Inbox item. "Kept paused" is the
 * person's answer to that card, so it is their choice, like any other pause.
 */
function pausedAtLimit(reason: string | null): boolean {
  return reason !== null && (reason.startsWith('Limit reached: ') || reason.startsWith('Monthly limit reached: '));
}

/** The row and standing of one step. Pure; `moves` is false where the scheduler dispatches nothing. */
export function taskLiveness(
  task: LivenessTaskInput,
  context: { readonly byKey: ReadonlyMap<string, LivenessTaskInput>; readonly carded: ReadonlySet<string>; readonly moves: boolean },
): { readonly rule: string; readonly standing: TaskStanding } {
  const movable = (standing: TaskStanding): TaskStanding => (context.moves ? standing : 'idle');
  switch (task.status) {
    case 'PENDING': {
      const deps = task.dependsOn.map((k) => context.byKey.get(k));
      if (deps.some((d) => d !== undefined && (d.status === 'FAILED' || d.status === 'CANCELLED'))) return { rule: 'T3', standing: 'upstream' };
      if (deps.every((d) => d !== undefined && (d.status === 'SUCCEEDED' || d.status === 'SKIPPED'))) return { rule: 'T1', standing: movable('moving') };
      return { rule: 'T2', standing: 'upstream' };
    }
    case 'READY': return { rule: 'T4', standing: movable('moving') };
    // A live run settles whatever the mission's status: it is never the thing stuck.
    case 'RUNNING': return { rule: 'T5', standing: 'moving' };
    // Parked on its question; with the card gone, the run is still live and settles on its own.
    case 'AWAITING_INPUT': return { rule: 'T6', standing: context.carded.has(task.id) ? 'waiting' : 'moving' };
    case 'AWAITING_HUMAN': return { rule: 'T7', standing: 'waiting' };
    // A wait step polls until its own timeout and keeps moving; a parked agent
    // task went to a person, so it waits on them like AWAITING_HUMAN (T8b, spec A4).
    // One past its stall threshold, or whose command can't run, is the cause (T8d, #145).
    case 'AWAITING_EXTERNAL':
      if ((task.executor ?? 'agent') !== 'wait') return { rule: 'T8b', standing: 'waiting' };
      return task.overdue === true ? { rule: 'T8d', standing: 'cause' } : { rule: 'T8', standing: movable('moving') };
    case 'AWAITING_APPROVAL':
      return context.carded.has(task.id) ? { rule: 'T9', standing: 'waiting' } : { rule: 'T10', standing: 'cause' };
    // A person has the keyboard; the step is theirs until they continue or release it.
    case 'HELD': return { rule: 'T8c', standing: 'waiting' };
    case 'BLOCKED':
      if (context.carded.has(task.id)) return { rule: 'T11', standing: 'waiting' };
      if (task.statusReason?.startsWith(DEPENDENCY_BLOCK_PREFIX) === true) return { rule: 'T12', standing: 'upstream' };
      return { rule: 'T13', standing: 'cause' };
    case 'FAILED':
    case 'CANCELLED':
      return { rule: 'T14', standing: 'cause' };
    case 'SUCCEEDED':
    case 'SKIPPED':
      return { rule: 'T15', standing: 'done' };
  }
}

/** The spec's mission table (§1), first matching row wins. */
export function classifyLiveness(input: LivenessInput): LivenessVerdict {
  const verdict = (kind: LivenessKind, rule: string, reason: string | null = null, action: StalledAction | null = null, tasks: LivenessVerdict['tasks'] = []): LivenessVerdict =>
    ({ kind, rule, reason, action, tasks });
  // A check waits on nobody: work never stops for it, so it is never the item a mission waits on.
  const cards = input.cards.filter((c) => c.kind !== 'check');

  switch (input.status) {
    case 'COMPLETE':
    case 'FAILED':
    case 'CANCELLED':
      return verdict('finished', 'L1');
    case 'RELEASED':
    case 'OBSERVING':
      return verdict('finished', 'L2');
    case 'PAUSED':
      return pausedAtLimit(input.statusReason) ? verdict('waiting', 'L3') : verdict('parked', 'L4');
    case 'DRAFT':
      if (input.refining === true) return verdict('moving', 'L5');
      if ((input.toDecide ?? 0) > 0) return verdict('waiting', 'L6');
      if (input.queued !== true) return verdict('parked', 'L7');
      if (input.ready === true) return verdict('moving', 'L8');
      return verdict('stalled', 'L9', `Queued, but it cannot be planned yet: ${lowerFirst(input.readinessLabel ?? 'it is not ready to plan')}.`, REFINE);
    case 'PLANNING':
      return input.planning === true
        ? verdict('moving', 'L10')
        : verdict('stalled', 'L11', 'Planning stopped without a plan: nothing is planning this mission now.', REPLAN);
    case 'AWAITING_PLAN_APPROVAL':
      return cards.some((c) => c.kind === 'plan')
        ? verdict('waiting', 'L12')
        : verdict('stalled', 'L13', 'It waits for a plan approval that no longer exists.', REPLAN);
    case 'EXECUTING':
    case 'REVIEWING':
    case 'QA':
    case 'READY_TO_SHIP':
    case 'BLOCKED':
      return classifyWork(input, cards, verdict);
  }
}

function classifyWork(
  input: LivenessInput,
  cards: LivenessInput['cards'],
  verdict: (kind: LivenessKind, rule: string, reason?: string | null, action?: StalledAction | null, tasks?: LivenessVerdict['tasks']) => LivenessVerdict,
): LivenessVerdict {
  const working = WORKING.includes(input.status);
  if (input.tasks.length === 0) {
    return verdict('stalled', 'L14', input.statusReason ?? 'It has no steps to run.', replannable(input.status) ? REPLAN : CANCEL);
  }
  const byKey = new Map(input.tasks.map((t) => [t.key, t]));
  const carded = new Set(cards.flatMap((c) => (c.taskId === null ? [] : [c.taskId])));
  const tasks = input.tasks.map((t) => ({ id: t.id, key: t.key, ...taskLiveness(t, { byKey, carded, moves: working }) }));

  // The scheduler completes (or fails) a working mission whose every step finished on its next pass.
  const allFinished = input.tasks.every((t) => ['SUCCEEDED', 'SKIPPED', 'FAILED', 'CANCELLED'].includes(t.status));
  if (working && (allFinished || tasks.some((t) => t.standing === 'moving'))) return verdict('moving', 'L15', null, null, tasks);
  if (!working && tasks.some((t) => t.standing === 'moving')) return verdict('moving', 'L16', null, null, tasks);
  // Any card on the mission other than a check asks the person something about it (a plan, a step, a limit).
  if (cards.length > 0 || tasks.some((t) => t.standing === 'waiting')) return verdict('waiting', 'L17', null, null, tasks);

  // Stalled. The first stall cause in plan order, by its key; a dependent is blocked by its upstream, which is what to retry.
  const ordered = [...input.tasks].sort((a, b) => a.orderHint - b.orderHint || a.key.localeCompare(b.key));
  const cause = ordered.find((t) => tasks.find((x) => x.id === t.id)?.standing === 'cause');
  if (cause !== undefined) {
    const why = cause.statusReason === null ? '' : `: ${cause.statusReason}`;
    return verdict('stalled', 'L18', `'${cause.key}' is ${describeStatus(cause.status)}${why}`,
      { kind: 'retry', label: `Retry ${cause.key}`, taskId: cause.id, taskKey: cause.key }, tasks);
  }
  // Nothing has started (a rejected plan leaves every step waiting): planning again is the way on.
  const unstarted = input.tasks.every((t) => (t.status === 'PENDING' || t.status === 'READY') && t.attempts === 0);
  if (unstarted && replannable(input.status)) {
    return verdict('stalled', 'L18', input.statusReason ?? 'Nothing has started and nothing will: re-plan it.', REPLAN, tasks);
  }
  return verdict('stalled', 'L18', input.statusReason ?? 'Nothing can move this mission.', CANCEL, tasks);
}

function describeStatus(status: TaskStatus): string {
  switch (status) {
    case 'AWAITING_APPROVAL': return 'waiting for an approval that no longer exists';
    case 'AWAITING_EXTERNAL': return 'still waiting';
    case 'BLOCKED': return 'blocked';
    case 'FAILED': return 'failed';
    case 'CANCELLED': return 'cancelled';
    default: return status.toLowerCase();
  }
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// ------------------------------------------------------------ the watchdog (§2)

/** Quiet after this long without an agent event, unless the daemon is told otherwise (TANDEMISE_QUIET_MS). */
export const DEFAULT_QUIET_AFTER_MS = 10 * 60_000;

export interface WatchThresholds {
  readonly quietMs: number;
  readonly silentMs: number;
}

/**
 * Silent is the sooner of three quiet intervals and half the step's wall-time
 * budget, never before quiet: a run is reported while half its budget is left
 * to act on, and 30 minutes would come after a 25- or 30-minute budget ended it.
 */
export function watchThresholds(quietMs: number, budgetMs: number): WatchThresholds {
  const quiet = Math.max(1, quietMs);
  return { quietMs: quiet, silentMs: Math.max(quiet, Math.min(3 * quiet, Math.floor(budgetMs / 2))) };
}

export type WatchLevel = 'active' | 'quiet' | 'silent';

export function watchLevel(input: {
  readonly lastEventAtMs: number;
  readonly nowMs: number;
  readonly thresholds: WatchThresholds;
  readonly snoozedUntilMs: number | null;
}): { readonly level: WatchLevel; readonly quietForMs: number; readonly snoozed: boolean } {
  const quietForMs = Math.max(0, input.nowMs - input.lastEventAtMs);
  const level: WatchLevel = quietForMs >= input.thresholds.silentMs ? 'silent' : quietForMs >= input.thresholds.quietMs ? 'quiet' : 'active';
  return { level, quietForMs, snoozed: input.snoozedUntilMs !== null && input.nowMs < input.snoozedUntilMs };
}

/** "34 min", or "12 s" under a minute. */
export function quietForLabel(ms: number): string {
  return ms < 60_000 ? `${Math.floor(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;
}

/** The timeline note when a run first turns quiet or silent. */
export function quietNote(taskKey: string, level: 'quiet' | 'silent', quietForMs: number): string {
  const quiet = `'${taskKey}' has been quiet for ${quietForLabel(quietForMs)}`;
  return level === 'quiet'
    ? `${quiet}: its agent wrote nothing. It keeps running; Tandemise never stops it on its own.`
    : `${quiet}: it is in your inbox to stop and retry, or keep waiting.`;
}

/** `mission.stalled` and `run.silent_minutes` (absent with no live run). */
export function livenessFacts(input: { readonly stalled: boolean; readonly silentMs: number | null }): Record<string, number> {
  return {
    'mission.stalled': input.stalled ? 1 : 0,
    ...(input.silentMs === null ? {} : { 'run.silent_minutes': Math.round((input.silentMs / 60_000) * 100) / 100 }),
  };
}
