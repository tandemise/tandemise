import type { MissionId, Timestamp } from '@tandemise/shared';
import type { Lane, StepClass, TaskProfile } from './types.js';

/**
 * One planning pass's record (#53 §5.5): the source for "Why these steps", the
 * brain's history entry and the merge decision's `process.*` facts.
 */
export interface PlanDecisionStep {
  readonly key: string;
  readonly stepClass: StepClass;
  /** Null: the role's model applies (no routing ladder for the class). */
  readonly model: string | null;
  readonly reason: string;
  readonly escalate: readonly string[];
}

export interface PlanDecisionApproval {
  readonly step: string;
  readonly when: 'before' | 'after';
  readonly reason: string;
}

export interface PlanDecisionTiebreak {
  readonly reason: string;
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly answer: { readonly type: string; readonly size: string; readonly areas: readonly string[]; readonly why: string } | null;
  readonly error: string | null;
  /** The first 500 characters of a reply nothing usable could be read from; absent or null otherwise. */
  readonly rawReply?: string | null;
}

export interface PlanDecision {
  readonly id: string;
  readonly missionId: MissionId;
  /** The factory files' refs it read: `shipped` or `sha256:<12 hex>` per file, joined. */
  readonly policyRef: string;
  readonly basis: 'predicted' | 'measured';
  readonly profile: TaskProfile;
  readonly lane: Lane;
  readonly laneBecause: string;
  readonly workflowId: string;
  /** Modules applied, by name. */
  readonly modules: readonly string[];
  readonly dropped: readonly { readonly name: string; readonly why: string }[];
  readonly steps: readonly PlanDecisionStep[];
  readonly approvals: readonly PlanDecisionApproval[];
  /** Ceremony the lane skipped, in words ("No plan approval."). */
  readonly skipped: readonly string[];
  readonly tiebreak: PlanDecisionTiebreak | null;
  /** A person made it quick (§5.4); the merge decision reads it. */
  readonly lightenedByPerson: boolean;
  readonly createdAt: Timestamp;
}
