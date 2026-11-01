import type { Lane, RiskLevel, Sensitivity, TaskSize, TaskType } from '../planner/types.js';

/**
 * What happened to a mission's work after the fact (#53 §9.1): the `outcome`
 * op of the brain's ledger, verbatim. Until the brain lands (#51) these rows
 * live in the local `outcomes` table; Task 20 appends them to the ledger.
 */
export const OUTCOME_KINDS = [
  'merged_clean', 'merged_by_person', 'merged', 'reverted', 'broke_main', 'changes_requested',
  'held', 'closed_unmerged', 'step_result',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export interface OutcomeEvent {
  readonly op: 'outcome';
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly mission: string;
  readonly tracker?: string;
  readonly lane: Lane;
  readonly profile: { readonly type: TaskType; readonly size: TaskSize; readonly risk: RiskLevel; readonly areas: readonly string[]; readonly sensitivity?: Sensitivity };
  readonly kind: OutcomeKind;
  readonly step?: {
    readonly class: string;
    readonly model: string | null;
    readonly attempt: number;
    readonly gatePassed: boolean;
    readonly costUsd: number | null;
    readonly wallTimeMs: number | null;
    /** The task the outcome is about, so later outcomes (a hold, a revert) find its step result. */
    readonly taskKey?: string;
  };
  readonly merge?: {
    readonly verdict: 'merge' | 'ask'; readonly score: number; readonly pr: string;
    /** Set when Tandemise merged it on a person's Merge (#174): who approved it, and the card. */
    readonly approval?: { readonly by: string; readonly card?: string };
  };
}

// ---------------------------------------------------------------- the fold

export interface BucketModelStats {
  readonly n: number;
  readonly firstPass: number;
  readonly success: number;
  readonly holds: number;
  readonly changesRequested: number;
  readonly reverts: number;
  /** Null when no run reported it: never 0. */
  readonly medianCostUsd: number | null;
  readonly medianWallTimeMs: number | null;
}

export interface AreaStats {
  readonly reverts90d: number;
  readonly lastRevertAt: string | null;
  readonly holds: number;
  readonly changesRequested: number;
  readonly tasks: number;
}

export interface OutcomeStats {
  /** bucket (`class|lane|sensitivity`) → model ('' for the runtime's own) → stats. */
  readonly buckets: Readonly<Record<string, Readonly<Record<string, BucketModelStats>>>>;
  readonly areas: Readonly<Record<string, AreaStats>>;
  /** `class|area` → whether a person stepped in, per task, oldest first (#53 §5.3). */
  readonly steppedIn: Readonly<Record<string, readonly boolean[]>>;
}

/** Reverts older than this don't count toward an area's recent history. */
export const REVERT_WINDOW_MS = 90 * 86_400_000;

export function bucketOf(o: Pick<OutcomeEvent, 'lane' | 'profile'> & { readonly step?: { readonly class: string } }): string {
  return `${o.step?.class ?? 'unknown'}|${o.lane}|${o.profile.sensitivity ?? 'none'}`;
}

const taskId = (o: OutcomeEvent): string => `${o.mission}|${o.step?.taskKey ?? ''}`;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Whether a step succeeded: its gate passed on the first attempt, nobody held
 * it or asked for changes on it, and (for implement) its change was not
 * reverted and did not break main.
 */
export function stepSuccess(step: OutcomeEvent, later: readonly OutcomeEvent[]): boolean {
  if (step.step === undefined || !step.step.gatePassed || step.step.attempt !== 1) return false;
  const id = taskId(step);
  if (later.some((o) => (o.kind === 'held' || o.kind === 'changes_requested') && taskId(o) === id)) return false;
  if (step.step.class === 'implement' && later.some((o) => (o.kind === 'reverted' || o.kind === 'broke_main') && o.mission === step.mission)) return false;
  return true;
}

/** Deterministic: the same events, in any order or split across writers, give the same stats. */
export function foldOutcomes(events: readonly OutcomeEvent[]): OutcomeStats {
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const latest = sorted.at(-1)?.at ?? null;
  const steps = sorted.filter((o) => o.kind === 'step_result' && o.step !== undefined);
  const raw = new Map<string, Map<string, { n: number; firstPass: number; success: number; holds: number; changesRequested: number; reverts: number; costs: number[]; walls: number[] }>>();
  // One entry per task, at its first result: a round's rerun is the same task, measured once.
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(taskId(s))) continue;
    seen.add(taskId(s));
    const bucket = bucketOf(s);
    const model = s.step!.model ?? '';
    const byModel = raw.get(bucket) ?? new Map();
    raw.set(bucket, byModel);
    const st = byModel.get(model) ?? { n: 0, firstPass: 0, success: 0, holds: 0, changesRequested: 0, reverts: 0, costs: [], walls: [] };
    byModel.set(model, st);
    const id = taskId(s);
    st.n++;
    if (s.step!.gatePassed && s.step!.attempt === 1) st.firstPass++;
    if (stepSuccess(s, sorted)) st.success++;
    if (sorted.some((o) => o.kind === 'held' && taskId(o) === id)) st.holds++;
    if (sorted.some((o) => o.kind === 'changes_requested' && taskId(o) === id)) st.changesRequested++;
    if (s.step!.class === 'implement' && sorted.some((o) => o.kind === 'reverted' && o.mission === s.mission)) st.reverts++;
    if (s.step!.costUsd !== null) st.costs.push(s.step!.costUsd);
    if (s.step!.wallTimeMs !== null) st.walls.push(s.step!.wallTimeMs);
  }
  const buckets: Record<string, Record<string, BucketModelStats>> = {};
  for (const bucket of [...raw.keys()].sort()) {
    const byModel = raw.get(bucket)!;
    buckets[bucket] = {};
    for (const model of [...byModel.keys()].sort()) {
      const st = byModel.get(model)!;
      buckets[bucket]![model] = {
        n: st.n, firstPass: st.firstPass, success: st.success, holds: st.holds, changesRequested: st.changesRequested, reverts: st.reverts,
        medianCostUsd: median(st.costs), medianWallTimeMs: median(st.walls),
      };
    }
  }

  const areas: Record<string, { reverts90d: number; lastRevertAt: string | null; holds: number; changesRequested: number; tasks: number }> = {};
  const area = (name: string) => (areas[name] ??= { reverts90d: 0, lastRevertAt: null, holds: 0, changesRequested: 0, tasks: 0 });
  const steppedIn: Record<string, boolean[]> = {};
  for (const o of sorted) {
    for (const name of o.profile.areas) {
      const a = area(name);
      if (o.kind === 'step_result') a.tasks++;
      if (o.kind === 'held') a.holds++;
      if (o.kind === 'changes_requested') a.changesRequested++;
      if (o.kind === 'reverted' || o.kind === 'broke_main') {
        if (latest !== null && Date.parse(latest) - Date.parse(o.at) <= REVERT_WINDOW_MS) a.reverts90d++;
        a.lastRevertAt = o.at;
      }
    }
  }
  // One entry per task, at its first result: a round's rerun is the same task, not another one people stepped in on.
  const counted = new Set<string>();
  for (const s of steps) {
    const id = taskId(s);
    if (counted.has(id)) continue;
    counted.add(id);
    const stepped = sorted.some((o) => (o.kind === 'held' || o.kind === 'changes_requested') && taskId(o) === id);
    for (const name of s.profile.areas) (steppedIn[`${s.step!.class}|${name}`] ??= []).push(stepped);
  }
  const sortedAreas: Record<string, AreaStats> = {};
  for (const k of Object.keys(areas).sort()) sortedAreas[k] = areas[k]!;
  const sortedStepped: Record<string, boolean[]> = {};
  for (const k of Object.keys(steppedIn).sort()) sortedStepped[k] = steppedIn[k]!;
  return { buckets, areas: sortedAreas, steppedIn: sortedStepped };
}
