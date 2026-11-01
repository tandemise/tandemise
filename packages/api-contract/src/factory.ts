import { z } from 'zod';

/**
 * The factory (#53): why a mission got the steps it got, the lane a person can
 * change, and the pull request the ship step opened. Every sentence here is
 * built by the daemon; the renderer only shows it.
 */

export const LANE_REQUESTS = ['quick', 'careful'] as const;

/** `POST /v1/missions/:id/lane`: Make it quick or Make it careful. */
export const setLaneRequest = z.object({ lane: z.enum(LANE_REQUESTS) });
export type SetLaneRequest = z.infer<typeof setLaneRequest>;

/** `POST /v1/missions/:id/plan`: Plan, or Plan quick / Plan careful for a factory mission. */
export const planMissionRequest = z.object({ lane: z.enum(LANE_REQUESTS).optional() });
export type PlanMissionRequest = z.infer<typeof planMissionRequest>;

export interface PlanChipView {
  /** "Fix", "tiny", "low risk". */
  readonly label: string;
  /** What made it so, as sentences: "Prefix fix → type fix". */
  readonly signals: readonly string[];
}

export interface PlanStepLineView {
  readonly key: string;
  /** "Implement · role model". */
  readonly line: string;
}

/** `GET /v1/missions/:id/plan-decision`: "Why these steps". */
export interface PlanDecisionView {
  readonly missionId: string;
  readonly lane: 'quick' | 'standard' | 'careful';
  /** "Fix · tiny · low risk". */
  readonly profileLine: string;
  readonly chips: readonly PlanChipView[];
  /**
   * The signal that decided each of type, size and risk, in plain words (#103):
   * "Size tiny: the item says "copy"."
   */
  readonly decidedBy: readonly string[];
  /** "Quick lane: one step, then a pull request." */
  readonly laneLine: string;
  /** Why this lane: "The rules matched quick work", "You chose it". */
  readonly laneBecause: string;
  /** Ceremony the lane skipped, in words. */
  readonly skipped: readonly string[];
  /** "Added a security review because it touches auth." */
  readonly modules: readonly string[];
  /** Rules that could not apply, and why. */
  readonly dropped: readonly string[];
  readonly steps: readonly PlanStepLineView[];
  /** Looks from you the plan added, each as its reason: "People stepped in on 3 of the last 3 …, so you'll look at this one before it moves on." */
  readonly approvals: readonly string[];
  /** "Couldn't tell from the tracker …; asked haiku: fix.", or null when it didn't run. */
  readonly tiebreak: string | null;
  readonly lightenedByPerson: boolean;
  /** Which switches still make sense: none once the pull request is on its way. */
  readonly canMakeQuick: boolean;
  readonly canMakeCareful: boolean;
  /** Measured from the change, not predicted from the request. */
  readonly measured: boolean;
}

export type ShipStage = 'none' | 'waiting' | 'opening' | 'opened' | 'ci' | 'review' | 'merged' | 'skipped' | 'blocked' | 'cancelled';

/** The latest merge decision on a pull request, in words (#53 §8.6, §10). */
export interface ShipDecisionView {
  readonly id: string;
  readonly verdict: 'merge' | 'ask';
  readonly headSha: string;
  /** "Risk score 1 of 2 allowed". */
  readonly scoreLine: string;
  /** Why it asks, in the daemon's words; empty for a merge. */
  readonly reasons: readonly string[];
  /** The score lines that counted: "over 100 lines changed (+1)". */
  readonly factors: readonly string[];
  /** "would have merged: score 0 of 2" when auto-merge is off; null otherwise. */
  readonly wouldHave: string | null;
  readonly policyRef: string;
  /** The pending Review and merge card, when there is one. */
  readonly cardId: string | null;
  readonly mergedBy: string | null;
  readonly mergeSha: string | null;
  readonly canRevert: boolean;
}

export interface ShipPullRequestView {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly state: 'opening' | 'opened';
  readonly decision: ShipDecisionView | null;
}

/** `GET /v1/missions/:id/ship` (part 1: pull requests only). */
export interface ShipView {
  readonly missionId: string;
  readonly taskId: string | null;
  readonly stage: ShipStage;
  /** "Opening the pull request", "Pull request opened". */
  readonly headline: string;
  /** One sentence on where the ship step stands. */
  readonly status: string;
  readonly prs: readonly ShipPullRequestView[];
}

// ------------------------------------------------------------- routing (#53 §6, §10)

/** One model's measured record in one bucket. */
export interface RoutingModelView {
  /** The model name as written on the ladder; "role model" for runs with none. */
  readonly model: string;
  readonly onLadder: boolean;
  /** Similar steps measured. */
  readonly tasks: number;
  /** "92%", or "not measured" with no steps. */
  readonly firstPass: string;
  readonly success: string;
  /** "$0.12", or "not reported" when no run reported it (never $0). */
  readonly medianCost: string;
  readonly medianTime: string;
  /** Where a new step in this bucket starts today. */
  readonly starting: boolean;
}

export interface RoutingBucketView {
  readonly key: string;
  /** "Quick lane · not sensitive". */
  readonly title: string;
  readonly models: readonly RoutingModelView[];
  /** "Starts at sonnet: passed 23 of 25 similar implement steps first time." */
  readonly startingLine: string;
}

export interface RoutingClassView {
  readonly stepClass: string;
  /** "Implement". */
  readonly title: string;
  /** "haiku, then sonnet, then opus; starts at sonnet until enough is measured." */
  readonly ladderLine: string;
  readonly buckets: readonly RoutingBucketView[];
  /** Set when nothing in this class has been measured yet. */
  readonly empty: string | null;
}

/** `GET /v1/workspaces/:id/routing`: per step class, per bucket, each model's measured stats and the starting model. */
export interface RoutingView {
  readonly workspaceId: string;
  /** "A model is chosen once its success rate is confidently at least 80%, over at least 8 similar steps." */
  readonly ruleLine: string;
  readonly classes: readonly RoutingClassView[];
  /** Set when no ladder is written: every step uses its role's model. */
  readonly empty: string | null;
}

// -------------------------------------------------------------- factory files

export type FactoryFileOrigin = 'brain' | 'project' | 'home' | 'shipped';

export interface FactoryFileView {
  readonly name: 'planner' | 'routing' | 'merge';
  /** "Planner rules", "Model routing", "Merge policy". */
  readonly title: string;
  readonly origin: FactoryFileOrigin;
  /** "From this project's repository", "From this computer", "Built in". */
  readonly originLine: string;
  readonly path: string | null;
  /** `shipped`, or `sha256:<12 hex>` of the file read. */
  readonly ref: string;
  /** Rules that don't parse, in the daemon's words. */
  readonly problems: readonly string[];
}

/** `GET /v1/workspaces/:id/factory`, and the answer to `POST …/factory/defaults`. */
export interface FactoryView {
  readonly workspaceId: string;
  readonly files: readonly FactoryFileView[];
  /** Where "Write the defaults" writes, or null when the project has no repository. */
  readonly repositoryName: string | null;
  /** Whether any file is still built in or from this computer, so writing the defaults would add one. */
  readonly canWriteDefaults: boolean;
}

// ------------------------------------------------------------- merge (#53 §8.4)

/** `PUT /v1/workspaces/:id/merge-policy` and `POST …/merge-policy/backtest`: a whole merge.yaml as an object. */
export const mergePolicyRequest = z.object({ policy: z.record(z.string(), z.unknown()) });

export interface MergePolicyResponse {
  readonly policy: Readonly<Record<string, unknown>> & { readonly autoMerge: 'on' | 'off'; readonly autoMergeAtMost: number };
  readonly origin: 'brain' | 'project' | 'home' | 'shipped';
  readonly path: string | null;
  readonly error: string | null;
}

export interface BacktestResponse {
  readonly total: number;
  readonly mergedCurrent: number;
  readonly mergedCandidate: number;
  readonly changedThenReverted: number;
  readonly changed: readonly { readonly decisionId: string; readonly pr: string; readonly from: 'merge' | 'ask'; readonly to: 'merge' | 'ask'; readonly revertedOrBroke: boolean }[];
  /** "Over the last 90 days this would have merged 14 of 31 pull requests on its own; none of those 14 were reverted." */
  readonly sentence: string;
}
