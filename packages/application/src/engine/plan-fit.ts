import type {
  Approval, ApprovalRepositoryPort, ArtifactManifest, ArtifactRepositoryPort, Mission, MissionTask,
} from '@tandemise/domain';
import { CONTINUE_PLAN_OPTION, RECHECK_SHIP_OPTION, REPLAN_REST_OPTION, REQUEST_CHANGES_OPTION, SKIP_REST_OPTION, isPlanFitCard, isTrialMission } from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import type { WorkspaceId } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import type { RequestAddress } from './reviews.js';
import { RECHECKED_NOTE, recommendedFor, type CiNow } from './ci-rounds.js';

export interface PlanFitDeps {
  readonly artifacts: ArtifactRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly recorder: EventRecorder;
  /** Who a card on the stopping step goes to: the same people as any other card on it. */
  readonly addressFor: (task: MissionTask, workspaceId: WorkspaceId) => RequestAddress;
  /** Whether the step is in a round a red CI check started (#200): its card can re-check CI and go on to ship. */
  readonly inCiRound?: (task: MissionTask) => boolean;
  /** CI on the mission's pull request as last read, for the card's recommendation (#200). */
  readonly ciNow?: (missionId: string) => CiNow | undefined;
}

const HELD_PREFIX = "Waiting for you: '";
const HELD_SUFFIX = "' says the plan no longer fits.";

/** The reason a step waits behind a step that said the plan no longer fits. */
export function planFitReason(stopping: MissionTask): string {
  return `${HELD_PREFIX}${stopping.key}${HELD_SUFFIX}`;
}

/**
 * A step held behind a plan-fit card: PENDING, but waiting on a person who has
 * a card to answer, as a person step or an approval is. A mission holding only
 * these is not stuck, and must not be marked BLOCKED: a blocked mission is
 * never dispatched again, so the answer would have nothing left to release.
 */
export function isHeldForPlanFit(task: Pick<MissionTask, 'status' | 'statusReason'>): boolean {
  const reason = task.statusReason ?? '';
  return task.status === 'PENDING' && reason.startsWith(HELD_PREFIX) && reason.endsWith(HELD_SUFFIX);
}

/** The reason a step is skipped when the person agrees. */
export function skippedForPlanFit(stopping: MissionTask): string {
  return `Skipped: '${stopping.key}' said the plan no longer fits.`;
}

/**
 * A step's handoff can say `stop`: what it found means the steps after it
 * should not run as planned (plan-fit spec). The step itself succeeds; the
 * steps that depend on it wait at promotion until a person answers one card.
 *
 * Read at promotion rather than when the step settles, so every way a step
 * succeeds (at once, after its reviews, after a round) is covered by one rule.
 */
export class PlanFit {
  constructor(private readonly deps: PlanFitDeps) {}

  /**
   * Null when work after `dependency` may start; otherwise why it waits. The
   * first time a stop holds anything, the card is filed. One card per stopped
   * output: a later round that says stop again asks again, and one that does
   * not releases the hold.
   */
  holdBehind(mission: Mission, dependency: MissionTask): string | null {
    // A trial has nobody to ask, as ask_human there is answered "nobody": it runs on.
    if (isTrialMission(mission) || dependency.status !== 'SUCCEEDED') return null;
    const stopped = stoppedOutput(this.deps.artifacts.listByTask(dependency.id));
    if (stopped === undefined) return null;
    const card = this.deps.approvals.list({ missionId: mission.id })
      .find((a) => a.taskId === dependency.id && isPlanFitCard(a) && cardFor(a) === stopped.id);
    if (card === undefined) {
      this.#file(mission, dependency, stopped);
      return planFitReason(dependency);
    }
    // "Re-check and continue to ship" holds the steps until the re-check has dropped the round (#200).
    const rechecking = card.selectedOptionId === RECHECK_SHIP_OPTION && !(card.decisionNote ?? '').startsWith(RECHECKED_NOTE);
    return card.status === 'PENDING' || rechecking ? planFitReason(dependency) : null;
  }

  #file(mission: Mission, task: MissionTask, stopped: ArtifactManifest): void {
    const stop = stopped.handoff?.stop ?? '';
    const recheck = this.deps.inCiRound?.(task) === true;
    const options = [
      ...(recheck ? [{ id: RECHECK_SHIP_OPTION, label: 'Re-check and continue to ship' }] : []),
      { id: SKIP_REST_OPTION, label: 'Skip the steps after it' },
      { id: REQUEST_CHANGES_OPTION, label: 'Send it back with a note' },
      { id: REPLAN_REST_OPTION, label: 'Plan the rest again' },
      { id: CONTINUE_PLAN_OPTION, label: 'Continue as planned' },
    ];
    // Never "skip the steps after it" while the pull request is open and green (#200).
    const recommended = recommendedFor({ options }, this.deps.ciNow?.(mission.id) ?? null);
    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      kind: 'intervention',
      risk: 'read',
      title: `‘${task.title}’ says the plan no longer fits`,
      rationale: stop,
      effect: (recheck ? 'Re-check reads CI again: if the check that started this round passes now on the same commit, the round is dropped and the mission goes on to ship. ' : '')
        + 'Skip the steps after it and the mission finishes on what was done. Send it back and it goes again as its next round, '
        + 'briefed by your note. Plan the rest again and the planner writes new steps from what is done, for you to approve. '
        + 'Continue as planned and the next steps start on what it wrote.',
      evidence: [
        { kind: 'artifact', label: stopped.title, value: stopped.id },
        ...(stopped.handoff?.needs ? [{ kind: 'text' as const, label: 'It needs', value: stopped.handoff.needs }] : []),
      ],
      options: options.map((o) => ({ ...o, recommended: o.id === recommended })),
      recommendedOptionId: recommended,
      ...this.deps.addressFor(task, mission.workspaceId),
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.note(
      { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId },
      `'${task.key}' says the plan no longer fits: ${stop} The steps after it wait for you.`,
    );
    this.deps.recorder.invalidate('approvals', mission.id);
  }
}

/** Whether the step's newest output says the plan no longer fits. */
export function stopsPlan(outputs: readonly ArtifactManifest[]): boolean {
  return stoppedOutput(outputs) !== undefined;
}

/** The newest live output of a step whose handoff says stop, if any. */
function stoppedOutput(outputs: readonly ArtifactManifest[]): ArtifactManifest | undefined {
  const superseded = new Set(outputs.map((a) => a.supersedes).filter((id) => id !== null));
  return outputs
    .filter((a) => !superseded.has(a.id) && (a.withdrawnAt ?? null) === null && (a.handoff?.stop ?? null) !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The stopped output a plan-fit card answers. */
function cardFor(approval: Approval): string | null {
  return approval.evidence.find((e) => e.kind === 'artifact')?.value ?? null;
}
