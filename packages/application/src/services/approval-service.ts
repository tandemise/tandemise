import type {
  Approval, ApprovalRepositoryPort, ArtifactRepositoryPort, MemberRepositoryPort, Mission, MissionRepositoryPort, MissionTask,
  PlanProposal, PlanProposalRepositoryPort, RoleRepositoryPort, RunRepositoryPort, TaskRepositoryPort, UnitOfWork,
} from '@tandemise/domain';
import {
  ACCEPT_RESULT_OPTION, CANCEL_MISSION_OPTION, FINISHED_TASK_STATUSES, RECHECK_SHIP_OPTION, NEEDS_CHANGES_OPTION, REPLAN_REST_OPTION, REQUEST_CHANGES_OPTION, SKIP_REST_OPTION, canTransition, isAffirmative, isPlanFitCard, isStarted,
} from '@tandemise/domain';
import type { ApprovalView, DecideApprovalRequest } from '@tandemise/api-contract';
import type { ApprovalId, Clock, Logger } from '@tandemise/shared';
import { TandemiseError, asId, summarize } from '@tandemise/shared';
import type { ApprovalService } from '../services.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { ApprovalWaiter } from '../support/tool-policy.js';
import type { FeedbackRounds, RoundBegun } from '../engine/feedback-rounds.js';
import type { ReviewPipeline } from '../engine/reviews.js';
import { actorFor, type Caller } from '../support/identity.js';
import { isStartApproval, toApprovalView, toApprovalViews } from '../support/approval-view.js';
import { feedbackEffectFor } from '../support/feedback-rules.js';
import { materializePlan } from '../planning/materialize.js';
import { skillPinner, type SkillPinning } from './planning-service.js';
import type { LimitService } from './limit-service.js';
import { parsePlanResponse } from '../planning/parse.js';
import { upstreamTaskIds } from '../support/lineage.js';
import { skippedForPlanFit } from '../engine/plan-fit.js';
import { reopenCard, sentence } from '../support/replan.js';

export interface ApprovalDeps {
  readonly approvals: ApprovalRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly scheduler: SchedulerService;
  readonly waiter: ApprovalWaiter;
  /** Turns "Request changes" on output, or "Needs changes" on a check, into feedback and the task's next round. */
  readonly rounds: FeedbackRounds;
  /** A decision, the note it records and the round it starts are written together or not at all. */
  readonly unitOfWork: UnitOfWork;
  /** What an approved review leads to: the next review, the lead's sign-off, or success. */
  readonly reviews: ReviewPipeline;
  readonly recorder: EventRecorder;
  /** Names the people on a card: addressees, who decided, who recorded it. */
  readonly members: MemberRepositoryPort;
  /** Gives a card the headline of the artifact it cites. */
  readonly artifacts: ArtifactRepositoryPort;
  /**
   * Limit cards (P8): validates a raise before anything is written, and applies
   * the decision inside the same transaction. Optional so harnesses built
   * before limits still compose.
   */
  readonly limits?: Pick<LimitService, 'incidentFor' | 'validateDecision' | 'decide'>;
  /** The skills library (P13): an edited plan's tasks get their pins like a planned one's. */
  readonly skills?: SkillPinning;
  /** A replan's new steps, waiting on its plan card (replan spec). Optional so older harnesses compose. */
  readonly proposals?: PlanProposalRepositoryPort;
  /** A "make it quick" card was approved (#53 §5.4). */
  readonly laneApproved?: (approval: Approval) => void;
  /** A "Review and merge" card was answered (#53 §8.1); runs after the commit. */
  readonly shipDecided?: (approval: Approval) => Promise<void>;
  /** Plan fit's "Plan the rest again": starts the replan once the card is decided. Resolved late, as planning composes after this. */
  readonly replanRest?: (missionId: Mission['id'], note: string | null, planFitApprovalId: Approval['id']) => Promise<unknown>;
  /** "Re-check and continue to ship" on a plan-fit card (#200); throws when CI still fails. */
  readonly recheckCiRound?: (card: Approval) => Promise<void>;
  /** "Cancel the mission" on a card that stopped its rounds (#196). */
  readonly cancelMission?: (missionId: Mission['id'], reason: string) => Promise<unknown>;
  /** Claims the mission's tracker item before an approved plan starts it (relay spec). Optional for older harnesses. */
  readonly claims?: { assertMayStart(mission: Mission): Promise<boolean | void>; abandonStart?(mission: Mission): Promise<void> };
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The human decision point (MVP.md §18).
 *
 * Deciding an approval is never only a status change: something is *waiting* on
 * it, and this service is the only place that knows what. A plan approval
 * releases the mission; a completion approval releases every task downstream of
 * the one it gates; a tool approval unblocks a worker that is still running,
 * mid-call, right now.
 *
 * The awkward case is telling a "may this task start?" approval apart from a
 * "do you accept this task's output?" approval - both are `kind: 'action'` on
 * the same task. Rather than stamping a marker into the card (which would show
 * the user a meaningless row), it is derived from the record: a start approval
 * is created *before* the attempt's run row exists, a completion approval
 * after. The run log already knows; asking it keeps the approval card honest.
 */
export class ApprovalServiceImpl implements ApprovalService {
  constructor(private readonly deps: ApprovalDeps) {}

  list(filter: { workspaceId?: string; missionId?: string; status?: string }): readonly ApprovalView[] {
    const approvals = this.deps.approvals.list({
      ...(filter.workspaceId === undefined ? {} : { workspaceId: asId<'WorkspaceId'>(filter.workspaceId) }),
      ...(filter.missionId === undefined ? {} : { missionId: asId<'MissionId'>(filter.missionId) }),
      ...(filter.status === undefined ? {} : { statuses: [filter.status as Approval['status']] }),
    });
    return toApprovalViews(this.deps, approvals);
  }

  get(id: ApprovalId): ApprovalView {
    return toApprovalView(this.deps, this.#require(id));
  }

  async decide(caller: Caller, id: ApprovalId, request: DecideApprovalRequest): Promise<ApprovalView> {
    const approval = this.#require(id);
    if (approval.status !== 'PENDING') {
      throw new TandemiseError('CONFLICT', `Approval '${id}' was already ${approval.status.toLowerCase()}.`, {
        details: { approvalId: id, status: approval.status },
      });
    }
    const option = approval.options.find((o) => o.id === request.optionId);
    if (option === undefined) {
      throw TandemiseError.validation(
        `'${request.optionId}' is not an option on this approval.`,
        { options: approval.options.map((o) => o.id) },
      );
    }

    // The note is the whole brief for the round Request changes starts; a round
    // with nothing to address would only rerun the same work.
    if (option.id === REQUEST_CHANGES_OPTION && (request.note ?? '').trim().length === 0) {
      throw TandemiseError.validation('Say what should change: the note is the brief for the next round.', { optionId: option.id });
    }

    // A raise that would stop the work again at once is refused before the card is answered.
    this.deps.limits?.validateDecision(approval, option.id, request.raiseTo);

    // Resolved before anything is written: someone who is not on the team, or
    // who names a non-person to decide for, changes nothing.
    const { actorId, recordedBy } = actorFor(this.deps, approval.workspaceId, caller, request.onBehalfOf);

    // A `choice` is answered, not approved: its options *are* the answer, and
    // reading "Figma" back to the worker as a refusal would make the whole
    // asking mechanism useless.
    const approved = isAffirmative(approval.kind, option.id);
    // Approving a plan starts the mission, so a held tracker item refuses it before the card is answered.
    const starting = approval.kind === 'plan' && approved && approval.missionId !== null && this.deps.proposals?.get(approval.id) === undefined
      ? this.deps.missions.get(approval.missionId) : undefined;
    const claimed = starting !== undefined ? await this.deps.claims?.assertMayStart(starting) : false;
    const abandon = async (): Promise<void> => { if (claimed === true && starting !== undefined) await this.deps.claims?.abandonStart?.(starting); };
    // One unit: a round that fails to start leaves no card decided for it and no
    // note recorded, and nothing reaches subscribers until it has committed.
    let committed: { decided: Approval; begun: RoundBegun | null };
    try {
      committed = this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      const written = this.deps.approvals.update(id, {
        status: approved ? 'APPROVED' : 'REJECTED',
        selectedOptionId: option.id,
        decisionNote: request.note ?? null,
        decidedBy: actorId,
        recordedBy,
        decidedAt: this.deps.clock.now(),
      });

      const scope = this.#scope(written, actorId);
      if (scope !== null) {
        this.deps.recorder.record(scope, {
          type: 'approval.resolved',
          approvalId: written.id,
          status: written.status,
          option: option.id,
        });
      }

      let round: RoundBegun | null = null;
      if (written.kind === 'plan') this.#resumePlan(written, approved, request);
      else if (isPlanFitCard(written)) round = this.#resumePlanFit(written, actorId, recordedBy);
      // A ship card's answer is the ship step's to act on, after the commit (#53 §8.1).
      else if (written.taskId !== null && this.#isShipCard(written)) round = null;
      else if (written.taskId !== null) round = this.#resumeTask(written, approved, actorId, recordedBy);
      else if (this.deps.limits?.incidentFor(written) !== undefined) this.deps.limits.decide(written, option.id, request.raiseTo, actorId);
      return { decided: written, begun: round };
    }));
    } catch (e) {
      await abandon();
      throw e;
    }
    const { decided, begun } = committed;

    // Started after the commit, as a round is: planning runs in the background and must
    // not begin inside the transaction. A replan that cannot start now (a step is still
    // running, say) leaves the card open and says why.
    if (isPlanFitCard(decided) && decided.selectedOptionId === REPLAN_REST_OPTION && decided.missionId !== null && this.deps.replanRest !== undefined) {
      try {
        await this.deps.replanRest(decided.missionId, decided.decisionNote, decided.id);
      } catch (e) {
        reopenCard(this.deps.approvals, decided.id);
        this.deps.recorder.invalidate('approvals', decided.missionId);
        throw e;
      }
    }

    if (isPlanFitCard(decided) && decided.selectedOptionId === RECHECK_SHIP_OPTION && this.deps.recheckCiRound !== undefined) {
      try {
        await this.deps.recheckCiRound(decided);
      } catch (e) {
        reopenCard(this.deps.approvals, decided.id);
        this.deps.recorder.invalidate('approvals', decided.missionId ?? undefined);
        this.deps.scheduler.wake();
        throw e;
      }
    }
    if (decided.kind === 'intervention' && decided.selectedOptionId === CANCEL_MISSION_OPTION && decided.missionId !== null) {
      await this.deps.cancelMission?.(decided.missionId, `Cancelled on the card: ${decided.title}`);
    }

    // A worker blocked mid-call gets its answer as soon as the decision stands:
    // it is holding a concurrency slot and a target while it waits.
    this.deps.waiter.settle(decided, approved);
    // Only after the commit: a stopped pass re-reads its row as it settles and must find the round there.
    if (begun !== null) this.deps.rounds.stopOvertaken(begun);

    // The ship step acts on it in the background: a person's Merge never waits on GitHub or CI.
    if (this.#isShipCard(decided)) void this.deps.shipDecided?.(decided).catch(() => undefined);
    this.deps.recorder.invalidate('approvals', decided.missionId ?? undefined);
    this.deps.scheduler.wake();
    return toApprovalView(this.deps, decided);
  }

  // ------------------------------------------------------------------- resume

  #resumePlan(approval: Approval, approved: boolean, request: DecideApprovalRequest): void {
    const mission = approval.missionId === null ? undefined : this.deps.missions.get(approval.missionId);
    if (mission === undefined) return;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };

    const proposal = this.deps.proposals?.get(approval.id);
    if (proposal !== undefined) {
      this.#resumeReplan(mission, { ...scope, ...(approval.decidedBy === null ? {} : { actorId: approval.decidedBy }) }, proposal, approved, request.note ?? null);
      if (approved) this.deps.laneApproved?.(approval);
      return;
    }

    if (!approved) {
      this.#setMissionStatus(
        mission, scope, 'BLOCKED',
        `${sentence(`The plan was rejected${request.note === undefined ? '' : `: ${summarize(request.note, 300)}`}`)} `
        + 'Re-plan or change the mission goal.',
      );
      return;
    }

    if (request.editedPlan !== undefined && request.editedPlan !== null) {
      this.#applyEditedPlan(mission, scope, request.editedPlan);
    }
    this.#setMissionStatus(mission, scope, 'EXECUTING', 'Plan approved; executing.');
    if (mission.startedAt === null) {
      this.deps.missions.update(mission.id, { startedAt: this.deps.clock.now() });
    }
  }

  /**
   * A replan's card (replan spec). Approve writes the new steps beside the
   * kept ones; the steps it replaces never started, so removing them takes no
   * history. Reject only drops the proposal: the mission is exactly as it was,
   * and a plan-fit card that asked for it is open again, holding what it held.
   */
  #resumeReplan(mission: Mission, scope: EventScope, proposal: PlanProposal, approved: boolean, note: string | null): void {
    this.deps.proposals?.delete(proposal.approvalId);
    if (!approved) {
      if (proposal.planFitApprovalId !== null) reopenCard(this.deps.approvals, proposal.planFitApprovalId);
      this.deps.recorder.invalidate('approvals', mission.id);
      this.#setMissionStatus(
        mission, scope, proposal.resumeStatus,
        `${sentence(`The new plan for the rest was rejected${note === null ? '' : `: ${summarize(note, 300)}`}`)} The mission is as it was.`,
      );
      return;
    }
    const current = this.deps.tasks.listByMission(mission.id);
    const replaced = new Set<string>(proposal.replaces);
    const withRuns = new Set(this.deps.runs.listByMission(mission.id).map((r) => r.taskId as string));
    // A replaced step that somehow started since stays: planning never removes history.
    const kept = current.filter((t) => !replaced.has(t.id) || isStarted(t, withRuns.has(t.id)));
    const keys = new Set(kept.map((t) => t.key));
    const added = proposal.tasks.filter((t) => !keys.has(t.key));
    this.deps.tasks.replaceAll(mission.id, [...kept, ...added]);
    // The new plan is the answer to "the plan no longer fits": a stop card still open
    // (the replan came from the header, or the route) would hold the new steps behind it.
    for (const card of this.deps.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).filter(isPlanFitCard)) {
      const answered = this.deps.approvals.update(card.id, {
        status: isAffirmative(card.kind, REPLAN_REST_OPTION) ? 'APPROVED' : 'REJECTED',
        selectedOptionId: REPLAN_REST_OPTION,
        decisionNote: 'Answered by the new plan for the rest.',
        decidedBy: scope.actorId ?? null,
        decidedAt: this.deps.clock.now(),
      });
      this.deps.recorder.record(scope, { type: 'approval.resolved', approvalId: answered.id, status: answered.status, option: REPLAN_REST_OPTION });
    }
    this.deps.recorder.note(scope, `New plan for the rest approved: ${kept.length} kept, ${current.length - kept.length} replaced, ${added.length} added.`);
    this.deps.recorder.invalidate('tasks', mission.id);
    this.#setMissionStatus(mission, scope, 'EXECUTING', 'New plan for the rest approved; executing.');
  }

  /**
   * A user-edited plan is validated exactly as a planner's is.
   *
   * "The human wrote it" is not a reason to skip validation: a hand-edited plan
   * with a dependency typo produces a mission that never starts that task, and
   * the failure would surface as silence rather than as an error on the edit.
   */
  #applyEditedPlan(mission: Mission, scope: EventScope, edited: unknown): void {
    const parsed = parsePlanResponse(JSON.stringify(edited));
    if (!parsed.ok) {
      throw TandemiseError.validation(
        `The edited plan is not usable: ${parsed.error.join('; ')}`,
        { issues: parsed.error },
      );
    }
    // Edited from a proposed plan, so its tasks read what they depend on as a planned one's do.
    const tasks = materializePlan(parsed.value, mission.id, this.deps.clock, [], {
      inferInputs: true, ...skillPinner(this.deps.skills, mission.workspaceId, this.deps.roles.list(mission.workspaceId)),
    });
    this.deps.tasks.replaceAll(mission.id, tasks);
    this.deps.recorder.note(scope, `The plan was edited before approval: ${tasks.length} tasks.`);
    this.deps.recorder.invalidate('tasks', mission.id);
  }

  /** Returns the round the decision started, for the caller to act on once it has committed. */
  #isShipCard(approval: Approval): boolean {
    return approval.kind === 'release' && approval.taskId !== null && this.deps.tasks.get(approval.taskId)?.executor === 'ship';
  }

  #resumeTask(approval: Approval, approved: boolean, actorId: string, recordedBy: string): RoundBegun | null {
    if (approval.taskId === null) return null;
    const task = this.deps.tasks.get(approval.taskId);
    if (task === undefined) return null;
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) return null;

    // A check is answered after the task has already succeeded and work has
    // moved on from it, so "Looks good" never touches the task's status.
    if (approval.kind === 'check') return this.#resumeCheck(approval, task, mission, actorId, recordedBy);

    // A tool approval is answered while its worker is still RUNNING. The waiter
    // has already released it; touching the task status here would yank the
    // task out from under a live run.
    //
    // An intervention is the exception: it is raised on a task that already
    // exhausted its retries and sits BLOCKED, so requiring AWAITING_APPROVAL
    // made "Retry once more" record an approval and then do nothing at all.
    const interventionOnBlocked = approval.kind === 'intervention' && task.status === 'BLOCKED';
    if (task.status !== 'AWAITING_APPROVAL' && !interventionOnBlocked) return null;

    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      roleId: task.roleId,
      actorId,
    };

    if (approval.kind === 'intervention') {
      // Cancel ends the mission once the answer stands; nothing to change on the step first.
      if (approval.selectedOptionId === CANCEL_MISSION_OPTION) return null;
      if (approval.selectedOptionId === ACCEPT_RESULT_OPTION) {
        this.#setTaskStatus(task, scope, 'SUCCEEDED', 'A human accepted the result as it stands.');
        if (mission.status === 'BLOCKED') {
          this.#setMissionStatus(mission, scope, 'EXECUTING', `'${task.key}' was accepted by a human.`);
        }
        return null;
      }
      if (!approved) {
        this.#setTaskStatus(task, scope, 'BLOCKED', 'A human declined to retry this task.');
        this.#setMissionStatus(mission, scope, 'BLOCKED', `'${task.key}' was left blocked by a human.`);
        return null;
      }
      // "Retry once more" has to mean it: the task already exhausted its budget,
      // so returning it to READY without extending the budget would have it
      // re-fail on the first dispatch without running anything.
      // Never fewer than it had: a card raised before any attempt ran (a pinned
      // skill that was missing, P13) would otherwise leave a budget of one.
      this.deps.tasks.update(task.id, {
        retryPolicy: { ...task.retryPolicy, maxAttempts: Math.max(task.retryPolicy.maxAttempts, task.attempts + 1) },
      });
      this.#setTaskStatus(task, scope, 'READY', 'A human authorized one more attempt.');
      if (mission.status === 'BLOCKED') {
        this.#setMissionStatus(mission, scope, 'EXECUTING', `'${task.key}' was given one more attempt.`);
      }
      return null;
    }

    if (isStartApproval(approval, task, this.deps.runs)) {
      if (!approved) {
        this.#setTaskStatus(task, scope, 'BLOCKED', 'A human declined to let this task start.');
        return null;
      }
      // Work it builds on may have gone again since the card was raised (a
      // round upstream). READY would start it on the old version; waiting, it
      // is promoted once that work is done, and the approval on record lets it start.
      const all = this.deps.tasks.listByMission(task.missionId);
      const unfinished = task.dependsOn
        .map((key) => all.find((t) => t.key === key))
        .filter((d): d is MissionTask => d !== undefined && d.status !== 'SUCCEEDED' && d.status !== 'SKIPPED');
      if (unfinished.length > 0) {
        this.#setTaskStatus(task, scope, 'PENDING', `Approved to start; waits for ${unfinished.map((d) => `'${d.key}'`).join(', ')} to finish.`);
      } else {
        this.#setTaskStatus(task, scope, 'READY', 'Approved to start.');
      }
      return null;
    }

    if (approved) {
      this.deps.reviews.onReviewApproved(approval, actorId);
      return null;
    }

    const note = approval.decisionNote?.trim() ?? '';
    // Request changes, or a reject with a note on a card from before Request
    // changes existed: the note is feedback, and the same task goes again as its
    // next round instead of a copy of it (spec §2, AWAITING_APPROVAL). On a card
    // that offers Request changes, "Reject without changes" means exactly that,
    // note or not (spec §6).
    const legacyCard = !approval.options.some((o) => o.id === REQUEST_CHANGES_OPTION);
    if (approval.selectedOptionId === REQUEST_CHANGES_OPTION || (legacyCard && note.length > 0)) {
      const item = this.deps.rounds.record({ task, text: note, artifactId: null, authorId: actorId, recordedBy, status: 'open', round: null });
      return this.deps.rounds.beginRound({
        task, feedbackIds: [item.id], actorId, keepCardId: approval.id,
        // Work that used an earlier round's output while this one awaited review
        // was kept when that round started; that choice stands, and the round
        // flags it again when it lands. With nothing downstream "none" is the only choice.
        downstream: this.deps.rounds.impactOf(task).consumers.length === 0 ? 'none' : 'keep',
      });
    }

    // A bare "no" gives the worker nothing to change, so nothing is re-run on
    // a guess. The reason says how to get another round instead.
    this.#setTaskStatus(task, scope, 'BLOCKED',
      'Rejected without changes, so nothing was re-run. Request changes with a note, or retry the task, to run it again.');
    this.#setMissionStatus(mission, scope, 'BLOCKED', `The output of '${task.key}' was rejected.`);
    return null;
  }

  /**
   * A step said the plan no longer fits (plan-fit spec), and the steps after
   * it wait at promotion. The step itself already succeeded, so its status is
   * not touched here unless it goes again as a round.
   *
   * Continue releases them: the scheduler finds the card answered and
   * promotes them. Skip marks every unfinished step downstream SKIPPED, and
   * the mission finishes on what was done. Send back starts the step's next
   * round with the note; nothing downstream used its output, so nothing else
   * is redone, and the new output is read afresh for a stop.
   */
  #resumePlanFit(approval: Approval, actorId: string, recordedBy: string): RoundBegun | null {
    const task = approval.taskId === null ? undefined : this.deps.tasks.get(approval.taskId);
    if (task === undefined) return null;
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) return null;
    if (approval.selectedOptionId === REQUEST_CHANGES_OPTION) {
      const note = approval.decisionNote?.trim() ?? '';
      const item = this.deps.rounds.record({ task, text: note, artifactId: null, authorId: actorId, recordedBy, status: 'open', round: null });
      return this.deps.rounds.beginRound({ task, feedbackIds: [item.id], actorId, keepCardId: approval.id, downstream: 'none' });
    }
    // Re-check reads CI once the answer stands (`recheckCiRound`): the steps stay held until it has.
    if (approval.selectedOptionId === RECHECK_SHIP_OPTION) return null;
    if (approval.selectedOptionId === SKIP_REST_OPTION) {
      const all = this.deps.tasks.listByMission(task.missionId);
      const reason = skippedForPlanFit(task);
      for (const later of all) {
        if (FINISHED_TASK_STATUSES.includes(later.status) || !upstreamTaskIds(later, all).has(task.id)) continue;
        this.#setTaskStatus(later, { workspaceId: mission.workspaceId, missionId: mission.id, taskId: later.id, roleId: later.roleId, actorId }, 'SKIPPED', reason);
      }
    }
    this.deps.recorder.invalidate('tasks', mission.id);
    return null;
  }

  /**
   * "Needs changes" on a check is feedback (spec §10). Work may already have
   * started from this output, so the round starts here only when nothing used
   * it; otherwise the note waits open and the person makes that call in the
   * impact dialog. Without a note there is nothing to brief a round with, so
   * P0's flag stays and the task still stands out.
   */
  #resumeCheck(approval: Approval, task: MissionTask, mission: Mission, actorId: string, recordedBy: string): RoundBegun | null {
    if (approval.selectedOptionId !== NEEDS_CHANGES_OPTION) return null;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId };
    const note = approval.decisionNote?.trim() ?? '';
    if (note.length === 0) {
      this.deps.tasks.update(task.id, { needsAttention: true });
      this.deps.recorder.record(scope, { type: 'task.attention', taskId: task.id, note: '' });
      this.deps.recorder.invalidate('tasks', mission.id);
      return null;
    }
    const base = { task, text: note, artifactId: null, authorId: actorId, recordedBy };
    // The check was filed when the round passed, but the task may have moved on
    // since: a pass that is running reads the note when it ends, and one that has
    // not run yet reads it in its first round, exactly as a note given directly would.
    const effect = feedbackEffectFor(task, this.deps.approvals.pendingForTask(task.id), this.deps.runs);
    if (effect.kind === 'queue' || effect.kind === 'attach') {
      this.deps.rounds.record({ ...base, status: effect.kind === 'queue' ? 'queued' : 'open', round: task.round ?? 1 });
      return null;
    }
    const item = this.deps.rounds.record({ ...base, status: 'open', round: null });
    if (this.deps.rounds.impactOf(task).consumers.length > 0) return null;
    // A later round's output card waiting on the task is answered by this note,
    // as a note given on the task would answer it: decided, not withdrawn.
    const card = effect.kind === 'review' ? effect.card : undefined;
    if (card !== undefined) this.deps.rounds.decideReviewCard(card, { actorId, recordedBy, note: item.text });
    return this.deps.rounds.beginRound({ task, feedbackIds: [item.id], downstream: 'none', actorId, keepCardId: card?.id ?? approval.id });
  }

  // -------------------------------------------------------------- transitions

  #setTaskStatus(
    task: MissionTask,
    scope: EventScope,
    status: MissionTask['status'],
    reason: string | null,
  ): void {
    this.deps.tasks.update(task.id, {
      status,
      statusReason: reason,
      ...(status === 'SUCCEEDED' ? { finishedAt: this.deps.clock.now() } : {}),
    });
    this.deps.recorder.record(scope, {
      type: 'task.status',
      from: task.status,
      to: status,
      ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', task.missionId);
  }

  #setMissionStatus(
    mission: Mission,
    scope: EventScope,
    status: Mission['status'],
    reason: string,
  ): void {
    if (mission.status === status) return;
    if (!canTransition(mission.status, status)) {
      this.deps.log.warn('approval.illegal_mission_transition', {
        missionId: mission.id, from: mission.status, to: status,
      });
      return;
    }
    this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(
      { workspaceId: scope.workspaceId, missionId: scope.missionId },
      { type: 'mission.status', from: mission.status, to: status, reason },
    );
    this.deps.recorder.invalidate('missions', mission.id);
  }

  #scope(approval: Approval, actorId: string): EventScope | null {
    if (approval.missionId === null) return null;
    return {
      workspaceId: approval.workspaceId,
      missionId: approval.missionId,
      taskId: approval.taskId,
      actorId,
    };
  }

  #require(id: ApprovalId): Approval {
    const approval = this.deps.approvals.get(id);
    if (approval === undefined) throw TandemiseError.notFound('Approval', id);
    return approval;
  }
}


