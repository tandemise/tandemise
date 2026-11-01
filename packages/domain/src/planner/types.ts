/**
 * The factory's words for a task (#53 §2): what the planner believes about it
 * and how much process it gets. Pure values; nothing here reads a file.
 */
export const TASK_TYPES = ['fix', 'feature', 'refactor', 'chore', 'docs', 'deps', 'test', 'security', 'unknown'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_SIZES = ['xs', 's', 'm', 'l'] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const SENSITIVITIES = ['none', 'sensitive', 'critical'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const LANES = ['quick', 'standard', 'careful'] as const;
export type Lane = (typeof LANES)[number];

/**
 * What a step is for, independent of its key. The routing table is keyed on it
 * (#53 §6). `ship` is the daemon-owned last step of every code plan (§8.1).
 */
export const STEP_CLASSES = ['implement', 'review', 'verify', 'spec', 'design', 'architecture', 'investigate', 'resolve_conflicts', 'ship'] as const;
export type StepClass = (typeof STEP_CLASSES)[number];

export interface ProfileSignal {
  readonly name: string;
  readonly value: string;
  /** What it contributed, e.g. "type fix". An overruled signal's effect starts with "disagrees:". */
  readonly effect: string;
  /**
   * The signal in a person's words, when its name and value would not say it
   * plainly (#103): `the item says "copy"` for a keyword rule. Absent on
   * decisions stored before it existed.
   */
  readonly said?: string;
}

export interface ProfileArea {
  readonly name: string;
  readonly sensitivity: Sensitivity;
}

export interface TaskProfile {
  readonly type: TaskType;
  readonly size: TaskSize;
  readonly risk: RiskLevel;
  readonly areas: readonly ProfileArea[];
  /** Repository names the task names or implies. */
  readonly repos: readonly string[];
  /** Every input, with what it contributed. */
  readonly signals: readonly ProfileSignal[];
  readonly source: 'rules' | 'rules+model' | 'person';
  readonly basis: 'predicted' | 'measured';
}

export interface ProfileHistory {
  readonly medianSize: TaskSize;
  readonly revertRate: number;
  readonly holdRate: number;
  readonly n: number;
}

export interface TiebreakAnswer {
  readonly type: TaskType;
  readonly size: TaskSize;
  readonly areas: readonly string[];
  readonly why: string;
}

export interface ProfileInput {
  readonly item: {
    readonly title: string;
    readonly description: string;
    readonly trackerType: string | null;
    readonly labels: readonly string[];
    readonly sources: readonly string[];
    readonly criteria: number;
  };
  readonly paths: readonly string[];
  readonly repos: readonly string[];
  readonly projectRepos: number;
  readonly history: ProfileHistory | null;
  readonly person: 'auto' | 'quick' | 'careful';
  readonly tiebreak: TiebreakAnswer | null;
  /** Set when the tiebreak ran and failed: the profile takes the conservative default and says so. */
  readonly tiebreakFailed?: string | null;
  readonly basis: 'predicted' | 'measured';
}

/** The fields a failed tiebreak leaves conservative (#53 §2). */
export const CONSERVATIVE_PROFILE = { type: 'unknown', size: 'm', risk: 'medium' } as const satisfies Pick<TaskProfile, 'type' | 'size' | 'risk'>;

export const rankOf = <T extends string>(order: readonly T[], value: T): number => order.indexOf(value);
export const atLeast = <T extends string>(order: readonly T[], value: T, floor: T): T =>
  rankOf(order, value) >= rankOf(order, floor) ? value : floor;

export function maxSensitivity(areas: readonly { readonly sensitivity: Sensitivity }[]): Sensitivity {
  return areas.reduce<Sensitivity>((top, a) => atLeast(SENSITIVITIES, top, a.sensitivity), 'none');
}
