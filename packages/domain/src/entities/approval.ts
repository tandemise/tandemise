import type { ApprovalId, MissionId, RunId, TaskId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { RiskClass } from '../capability.js';

/** MVP.md §18.3. */
export const APPROVAL_KINDS = [
  'plan',          // approve or edit the proposed mission plan
  'choice',        // pick among product/design/architecture alternatives
  'exception',     // temporarily grant permission outside default policy
  'action',        // authorize one classified side effect
  'release',       // authorize merge / deploy / publish
  'intervention',  // a worker is stuck and needs a human
  'check',         // a non-blocking look at finished work, after the fact
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

/**
 * Everything a human needs to decide without opening five agent transcripts
 * (MVP.md §23.4). If a field here is empty, the approval card is not ready to be
 * shown - that is a deliberate design constraint, not an optional nicety.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly taskId: TaskId | null;
  readonly runId: RunId | null;
  readonly kind: ApprovalKind;
  readonly status: ApprovalStatus;
  readonly risk: RiskClass;
  /** What is being requested, in one line. */
  readonly title: string;
  /** Why it is being requested. */
  readonly rationale: string;
  /** Exactly what will happen if approved. */
  readonly effect: string;
  /** Evidence supporting the request: artifact ids, diffs, check results. */
  readonly evidence: readonly ApprovalEvidence[];
  readonly options: readonly ApprovalOption[];
  readonly recommendedOptionId: string | null;
  readonly selectedOptionId: string | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: Timestamp;
  readonly decidedAt: Timestamp | null;
  readonly expiresAt: Timestamp | null;
  /**
   * Member ids the card is addressed to. Optional so approvals built before
   * responsibility existed still typecheck; read back as an empty list.
   */
  readonly addressees?: readonly string[];
  /** How many steps up the team tree the card has been escalated. */
  readonly escalationLevel?: number;
  /** When an unanswered card moves to the next person up, or null for never. */
  readonly escalateAt?: Timestamp | null;
  /** Who put the card on record: a member id or a system actor. */
  readonly recordedBy?: string | null;
}

export interface ApprovalEvidence {
  readonly kind: 'artifact' | 'check' | 'diff' | 'link' | 'text';
  readonly label: string;
  readonly value: string;
}

export const APPROVE_OPTION = 'approve';
export const REJECT_OPTION = 'reject';
/**
 * Yes, and do not ask again for this capability while this task's run lasts.
 * Offered on tool approvals: a design run through a connected app makes a
 * dozen calls, and a card per call trains people to click without reading.
 */
export const APPROVE_FOR_TASK_OPTION = 'approve_for_task';
/**
 * On a task that exhausted its retries: accept what it produced and let the
 * mission continue. The answer when the work is sound and the gate is what
 * cannot be met - a QA gate requiring 100% coverage of a criterion that is only
 * checkable after a later task opens the pull request.
 */
export const ACCEPT_RESULT_OPTION = 'accept_result';

/**
 * The two answers to a `check`: a look at finished work that nothing waits on.
 * "Needs changes" is not a rejection of anything - the work already moved on -
 * so it is recorded as a note and a flag on the task, never a status change.
 */
export const LOOKS_GOOD_OPTION = 'looks_good';

/**
 * The two answers to a limit incident (P8): raise the limit to a number the
 * person gives and resume, or keep the work stopped. Carried on an
 * `intervention` card, so no new approval kind is needed.
 */
export const RAISE_LIMIT_OPTION = 'raise_limit';
export const KEEP_PAUSED_OPTION = 'keep_paused';
export const NEEDS_CHANGES_OPTION = 'needs_changes';

/**
 * An owner's answer to a round prompt: the work is not accepted, and the
 * task's next round should address the feedback given alongside it. Not
 * affirmative - it is a request, not a gate failure, but it is still not a
 * yes (P2 spec).
 */
export const REQUEST_CHANGES_OPTION = 'request_changes';

/**
 * The answers to a plan-fit card: a step's handoff said `stop`, the plan no
 * longer fits, and the steps after it wait. Skip them, or run them as planned;
 * the third answer is `request_changes`, a new round of the step. Carried on
 * an `intervention` card with a task, so no new approval kind is needed.
 */
export const SKIP_REST_OPTION = 'skip_rest';
export const CONTINUE_PLAN_OPTION = 'continue_plan';
/** Plan fit's fourth answer: a new plan for what is left, keeping what is done (replan spec). */
export const REPLAN_REST_OPTION = 'replan_rest';
/**
 * A plan-fit card on a step in a round that a red CI check started (#200):
 * CI is read again, and if that check passes now on the same commit the
 * round is dropped and the mission goes on to ship.
 */
export const RECHECK_SHIP_OPTION = 'recheck_ship';
/** A card that stops a mission's rounds (#196) can end the mission. */
export const CANCEL_MISSION_OPTION = 'cancel_mission';

/** A plan-fit card, told from other interventions by its options, as a limit card is. */
export function isPlanFitCard(approval: Pick<Approval, 'kind' | 'taskId' | 'options'>): boolean {
  return approval.kind === 'intervention' && approval.taskId !== null && approval.options.some((o) => o.id === SKIP_REST_OPTION);
}

/**
 * Whether deciding `optionId` means the request was granted.
 *
 * An `action` or `release` card is a yes/no question, so only `approve` is a
 * yes. A `choice` is not: the options *are* the answer, and a worker that asked
 * "Figma, Canva, or Claude?" must not have "Figma" read back to it as a
 * refusal. Anything other than an explicit decline answers a choice.
 *
 * Keeping the rule here rather than at the decision site is what stops the two
 * meanings drifting apart - the approval service, the tool that is blocked on
 * the answer, and the timeline all have to agree on what the human just did.
 */
export function isAffirmative(kind: ApprovalKind, optionId: string): boolean {
  if (kind === 'check') return optionId === LOOKS_GOOD_OPTION;
  return kind === 'choice'
    ? optionId !== REJECT_OPTION
    : optionId === APPROVE_OPTION || optionId === APPROVE_FOR_TASK_OPTION || optionId === ACCEPT_RESULT_OPTION
      || optionId === RAISE_LIMIT_OPTION || optionId === CONTINUE_PLAN_OPTION || optionId === RECHECK_SHIP_OPTION;
}

export const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: APPROVE_OPTION, label: 'Approve', recommended: true },
  { id: REJECT_OPTION, label: 'Reject' },
];
