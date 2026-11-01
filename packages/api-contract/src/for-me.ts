/**
 * Who a waiting item is for: the one "for me" rule behind the Inbox, Home's
 * "Needs you now" and the mission feed.
 *
 * This file has no imports on purpose. The desktop renderer is a sandboxed
 * browser context and every `@tandemise/*` package entry reaches Node
 * built-ins, so it reads this through the `@tandemise/api-contract/for-me`
 * subpath, which `scripts/check-boundaries.mjs` allowlists only while it stays
 * import-free. The daemon's feed projection imports the same functions, so the
 * nav badge and the feed can never disagree about what waits on a person.
 *
 * Everything is judged by member id. `memberId` is null when the caller has no
 * seat in the workspace; such a caller still sees what is for anyone.
 */

/**
 * An open approval is for me when I am one of its addressees. A card with no
 * addressees predates them and is for anyone, so it stays for me rather than
 * silently disappearing from a solo inbox.
 */
export function isApprovalForMember(addresseeIds: readonly string[], memberId: string | null): boolean {
  return addresseeIds.length === 0 || (memberId !== null && addresseeIds.includes(memberId));
}

/**
 * An approval that actually waits on me. A check is a non-blocking look at
 * finished work: it is for me, but nothing is held up until I answer it.
 */
export function isApprovalWaitingOnMember(approval: { readonly kind: string; readonly addresseeIds: readonly string[] }, memberId: string | null): boolean {
  return approval.kind !== 'check' && isApprovalForMember(approval.addresseeIds, memberId);
}

/** One thing in the Inbox, as far as "does it wait on me" needs to know (#151). */
export interface InboxItemFacts {
  /** approval, task, refinement, stalled, quiet or parked. */
  readonly kind: string;
  /** The approval's kind (`check`, `release`, …) for an approval; null for anything else. */
  readonly approvalKind: string | null;
  readonly forMe: boolean;
}

/**
 * Whether an Inbox item waits on me (#151): the one rule behind Home's
 * "Needs you" tile, its "Needs you now" list, the Inbox's "For me" count and
 * the nav badge, so none of them can disagree. It is for me, and it is not a
 * check: a check is a look at finished work that nothing waits on. A stalled
 * or blocked step that offers me an action (Retry, Re-plan, Open the pull
 * request) waits on me like a card does, and counts.
 */
export function waitsOnMember(item: InboxItemFacts): boolean {
  return item.forMe && item.approvalKind !== 'check';
}

/** How many items wait on me: what the tile shows, and how many the list holds. */
export function needsYouCount(items: readonly InboxItemFacts[]): number {
  return items.filter(waitsOnMember).length;
}

/** The people a task parked for a human names, as member ids. */
export interface HumanTaskPeople {
  readonly assigneeId: string | null;
  readonly claimableIds: readonly string[];
  readonly escalatedToIds: readonly string[];
}

/**
 * The part of the rule that is mine by name: assigned to me; claimable by me
 * while nobody has it; or opened to me by an escalation, which lets me take it
 * from its assignee.
 */
export function isHumanTaskMine(task: HumanTaskPeople, memberId: string | null): boolean {
  if (memberId === null) return false;
  return task.assigneeId === memberId
    || (task.assigneeId === null && task.claimableIds.includes(memberId))
    || task.escalatedToIds.includes(memberId);
}

/**
 * A task parked for a human is for me when it is mine by name, or when it has
 * nobody at all - no assignee and no pool - and so is for whoever picks it up.
 */
export function isHumanTaskForMember(task: HumanTaskPeople, memberId: string | null): boolean {
  return isHumanTaskMine(task, memberId) || (task.assigneeId === null && task.claimableIds.length === 0);
}

/**
 * What I can do with a person task that is for me: finish it when it is
 * already mine, otherwise take it. Null when it is not for me at all.
 */
export function humanActionForMember(task: HumanTaskPeople, memberId: string | null): 'complete' | 'claim' | null {
  if (!isHumanTaskForMember(task, memberId)) return null;
  return memberId !== null && task.assigneeId === memberId ? 'complete' : 'claim';
}

/** Where a mission's current plan stands; see `planStanding`. */
export type PlanDecision = 'pending' | 'approved' | 'auto_approved' | 'rejected' | 'cancelled';

/** The facts about a plan approval the plan card is judged from. */
export interface PlanApprovalFacts {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly addresseeIds: readonly string[];
}

/** Enough of a task to tell whether any of the plan has started. */
export interface PlanTaskFacts {
  readonly status: string;
  readonly startedAt: string | null;
}

export interface PlanStanding {
  readonly decision: PlanDecision;
  /** The approval the decision comes from; undefined when nobody was asked. */
  readonly approvalId: string | undefined;
  /**
   * The plan still waits on a person: its approval is being asked, or its
   * rejection is what stops the mission and it waits to be re-planned.
   */
  readonly open: boolean;
  /** Open and on me: I am asked to approve it, or I was the one asked about the plan whose rejection now waits for a re-plan. */
  readonly forMe: boolean;
}

/**
 * Whether none of the mission's tasks has started: nothing has run since the
 * plan was made. A mission blocked in that state was stopped by its plan (a
 * rejection, or planning that failed), not by work that went wrong, so
 * re-planning it throws nothing away. A plan's first tasks are materialized
 * READY, so READY counts as unstarted as long as it never began.
 */
export function isPlanUnstarted(tasks: readonly PlanTaskFacts[]): boolean {
  return tasks.every((t) => (t.status === 'PENDING' || t.status === 'READY') && t.startedAt === null);
}

/**
 * Where the current plan stands, for the plan card and the Feed tab's count.
 *
 * Only approvals raised for this plan count: the plan document is stored
 * before its approval is requested, so a request older than the live plan was
 * about a plan a re-plan replaced. The newest of them decides. No request at
 * all means the workspace accepts plans without asking. A PENDING row the
 * mission is no longer asking about (a cancel or re-plan withdrew it, or a
 * crash left it behind) reads as withdrawn, never as approved.
 *
 * A rejection is open only while it is what stops the mission: the mission is
 * BLOCKED and none of the plan has run. Once someone resumed the mission and
 * its tasks ran, a later block is about that work, and re-planning would throw
 * it away. A mission still in AWAITING_PLAN_APPROVAL after a rejection is the
 * state an older build left behind, when that transition was refused, and is
 * stuck the same way.
 */
export function planStanding(input: {
  readonly missionStatus: string;
  /** When the live plan document was stored; null when there is none. */
  readonly planCreatedAt: string | null;
  readonly approvals: readonly PlanApprovalFacts[];
  readonly tasks: readonly PlanTaskFacts[];
}, memberId: string | null): PlanStanding {
  const plans = input.approvals.filter((a) => a.kind === 'plan');
  const forPlan = plans
    .filter((a) => input.planCreatedAt === null || a.createdAt >= input.planCreatedAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const pending = plans.filter((a) => a.status === 'PENDING');
  if (input.missionStatus === 'AWAITING_PLAN_APPROVAL' && pending.length > 0) {
    const asked = forPlan.find((a) => a.status === 'PENDING') ?? pending[0]!;
    return { decision: 'pending', approvalId: asked.id, open: true, forMe: isApprovalForMember(asked.addresseeIds, memberId) };
  }
  const latest = forPlan[0];
  if (latest === undefined) return { decision: 'auto_approved', approvalId: undefined, open: false, forMe: false };
  if (latest.status === 'APPROVED') return { decision: 'approved', approvalId: latest.id, open: false, forMe: false };
  if (latest.status === 'REJECTED') {
    const open = input.missionStatus === 'AWAITING_PLAN_APPROVAL'
      || (input.missionStatus === 'BLOCKED' && isPlanUnstarted(input.tasks));
    return { decision: 'rejected', approvalId: latest.id, open, forMe: open && isApprovalForMember(latest.addresseeIds, memberId) };
  }
  // Expired, cancelled, or still PENDING on a mission that has stopped asking: nobody decided it.
  return { decision: 'cancelled', approvalId: latest.id, open: false, forMe: false };
}
