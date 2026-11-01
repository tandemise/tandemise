import { relative } from 'node:path';
import { FACTORY_WORKFLOW_ID } from '@tandemise/domain';
import type {
  CriteriaTrace, ArtifactHandoff, ArtifactManifest, EventRepositoryPort, ExecutionTargetRepositoryPort, ExternalRef, HandoffLink,
  ApprovalRepositoryPort, ArtifactRepositoryPort, MemberRepositoryPort, Mission, MissionCriteriaRepositoryPort, MissionRepositoryPort, MissionStatus,
  MissionTask, RepoRepositoryPort, RoleRepositoryPort, RunRepositoryPort, TaskRepositoryPort, UnitOfWork, WorkspaceRepositoryPort,
  ArtifactStorePort,
} from '@tandemise/domain';
import {
  ISSUE_CRITERIA_AUTHOR, TRACKER_CRITERIA_AUTHOR, canTransition, evaluateReadiness, indexTeam, isTaskFinished, isTerminalMissionStatus, normalizeLimits,
  responsibleFor,
} from '@tandemise/domain';
import type {
  ClaimTaskRequest, CompleteTaskRequest, CreateMissionRequest, HandBackRequest, MissionSummary, ParkTaskRequest, TaskView,
} from '@tandemise/api-contract';
import type { Clock, IssueLinkId, Logger, MissionId, RepositoryId, RoutineId, TaskId, TrackerItemId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, ids, slugify, summarize } from '@tandemise/shared';
import type { ContributionService, FeedbackService, MissionService, PlanningService, PinnedContribution, ProjectionService } from '../services.js';
import { ContributionError } from './contribution-service.js';
import type { SchedulerService } from '../engine/scheduler.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { RuntimeOverrides } from '../support/runtime-overrides.js';
import { DEFAULT_PRESET_ID } from '../planning/presets.js';
import { actorFor, requireSeat, type Caller } from '../support/identity.js';
import { supersededBy } from '../support/lineage.js';
import { waitingForName, withoutEscalation } from '../engine/staffing-resolver.js';
import type { ReviewPipeline } from '../engine/reviews.js';
import type { FeedbackRounds } from '../engine/feedback-rounds.js';
import type { ArtifactMeasurePort } from '../ports.js';
import { feedbackEffectFor } from '../support/feedback-rules.js';
import { assertStaffing, mergeRoleStaffing } from '../support/staffing-edit.js';
import { assertReadiness } from './readiness.js';
import { assertMayTake, type TakeAction } from '../support/take-rule.js';
import { criteriaSummary } from '../support/criteria-summary.js';
import {
  COVERED_MESSAGE, LINKABLE_OUTPUT_TYPES, continuedIn, isCoveredPlaceholder, parkedExternalOf, type ParkedExternal,
} from '../support/outside-work.js';
import { CLOSED_MISSION_MESSAGE, isReadableText, missionTakesRounds } from '../support/feedback-rules.js';
import { uploadFilename } from '../planning/upload-intake.js';

/** Where a step may be continued elsewhere from: queued, running, or done with nobody downstream on it yet (spec A4). */
const PARKABLE_TASK_STATUSES: readonly MissionTask['status'][] = ['READY', 'RUNNING', 'SUCCEEDED'];

/** A handoff shows at most this many links; the hand-back's own link is kept over a derived one. */
const HANDOFF_MAX_LINKS = 5;

/** Statuses from which a task may be put back in the queue by hand. */
const RETRYABLE_TASK_STATUSES: readonly MissionTask['status'][] = [
  'FAILED', 'BLOCKED', 'CANCELLED', 'SUCCEEDED', 'SKIPPED', 'AWAITING_APPROVAL',
];

export interface MissionDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  /** Tells an output card from a start card, which decides whether a retry's note starts a round. */
  readonly runs: Pick<RunRepositoryPort, 'listByTask'>;
  readonly approvals: ApprovalRepositoryPort;
  /** Where a person's completed work is written, in the shape the plan declared. */
  readonly artifactStore: ArtifactStorePort;
  /** Where its manifest is recorded, so gates and downstream tasks can find it. */
  readonly artifacts: ArtifactRepositoryPort;
  /** Gives a person's text the handoff an agent writes for itself. */
  readonly measure: ArtifactMeasurePort;
  /** Who may act, and who a task is assigned to. */
  readonly members: MemberRepositoryPort;
  readonly roles: RoleRepositoryPort;
  /** A person's finished step is reviewed exactly as an agent's round is. */
  readonly reviews: ReviewPipeline;
  readonly planning: PlanningService;
  /** Why a mission may not resume: it is at a limit (P8). Null when it may. */
  readonly limitRefusal?: (missionId: MissionId) => string | null;
  /** The Done-when trace (P5), so a mission row can say "1 of 3 verified" (P10); optional for older harnesses. */
  readonly criteriaTrace?: (missionId: MissionId) => CriteriaTrace;
  readonly projections: ProjectionService;
  readonly scheduler: SchedulerService;
  /** A retry with a note is the next round, started the way any note starts one. */
  readonly feedback: FeedbackService;
  /** A person's completed step answers the notes left on it. */
  readonly rounds: FeedbackRounds;
  readonly overrides: RuntimeOverrides;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** The Done-when ledger; the person's lines become U1…Un at creation. Optional for older harnesses. */
  readonly criteria?: MissionCriteriaRepositoryPort;
  /** Pins uploads at creation (spec A2). Optional for older harnesses, which then refuse a mission with uploads. */
  readonly contributions?: Pick<ContributionService, 'pin'> & Partial<Pick<ContributionService, 'adoptPullRequestHead'>>;
  /** The workspace's artifact root, which a handed-back file's workspace link is relative to (spec A5). */
  readonly artifactRoot?: (workspaceId: WorkspaceId) => string;
  /** The log a parked step is read from (spec A4). Optional for older harnesses, which then park nothing. */
  readonly events?: Pick<EventRepositoryPort, 'listByMission'>;
  /** A change handed back retires the step's own worktree, so integration merges the person's branch instead. */
  readonly targets?: Pick<ExecutionTargetRepositoryPort, 'listByMission' | 'update'>;
  /** Claims the mission's tracker item before it starts (relay spec). Optional for older harnesses. */
  readonly claims?: { assertMayStart(mission: Mission): Promise<boolean | void>; abandonStart?(mission: Mission): Promise<void> };
}

/**
 * The mission lifecycle (MVP.md §9.1, §9.4).
 *
 * One rule governs everything here: **the goal and the success criteria are
 * never mutated** (MVP.md §9.4). They are the user's own words and the contract
 * every later role is measured against; a system that quietly rewrites them to
 * match what it managed to build has stopped being accountable. Re-planning
 * replaces tasks, never intent.
 *
 * The second rule is that every transition goes through `canTransition` and
 * emits an event. The scheduler, the approval service and this service all move
 * missions; without one shared table of legal transitions they would each
 * invent their own, and a mission would eventually reach a state none of them
 * could leave.
 */
export class MissionServiceImpl implements MissionService {
  constructor(private readonly deps: MissionDeps) {}

  list(filter: { workspaceId?: string; status?: string; limit?: number }): readonly MissionSummary[] {
    const missions = this.deps.missions.list({
      ...(filter.workspaceId === undefined ? {} : { workspaceId: asId<'WorkspaceId'>(filter.workspaceId) }),
      ...(filter.status === undefined ? {} : { statuses: [filter.status as MissionStatus] }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit }),
    });
    return missions.map((mission) => this.#summary(mission));
  }

  async create(
    caller: Caller, request: CreateMissionRequest, origin: { routineId?: RoutineId; issueLinkId?: IssueLinkId; trackerItemId?: TrackerItemId; missionId?: MissionId } = {},
  ): Promise<Mission> {
    const workspaceId = asId<'WorkspaceId'>(request.workspaceId);
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    // The creator is who plan approvals go to first, so it is resolved before
    // anything is written: a caller with no seat creates nothing.
    const { actorId } = actorFor(this.deps, workspaceId, caller, request.onBehalfOf);

    const repositoryId = request.repositoryId === undefined
      ? workspace.defaultRepositoryId
      : request.repositoryId === null ? null : asId<'RepositoryId'>(request.repositoryId);
    const repository = repositoryId === null ? undefined : this.deps.repositories.get(repositoryId);
    if (repositoryId !== null && repository === undefined) {
      throw TandemiseError.notFound('Repository', repositoryId);
    }

    // The factory's quick and standard lanes don't ask for Done-when lines (#53 §4);
    // whether this one is careful is known only once it is profiled, at planning.
    const factoryLane = request.workflowPreset === FACTORY_WORKFLOW_ID && request.lane !== 'careful';
    if (request.planNow === true && !factoryLane) {
      // The readiness gate a plan would meet, applied before anything is
      // written: a new mission has no proposals or questions, so it is ready
      // exactly when it has a Done-when line. Creating it and then refusing
      // its plan would leave a mission the caller did not ask for (P6 ruling 2).
      const lines = (request.successCriteria ?? []).filter((line) => line.trim().length > 0).length;
      assertReadiness(null, evaluateReadiness({ criteria: lines, openQuestions: 0, proposedPending: 0 }));
    }

    // Start names the id first: it claims the tracker item under it before the mission exists (intake, Ruling 22).
    const id = origin.missionId ?? ids.mission();
    const title = request.title?.trim() || titleFromGoal(request.goal);
    // Queued only while it is a draft: a mission planned now is not waiting for anything.
    const queued = request.queued === true && request.planNow !== true;
    // A draft with uploads joins the queue only once they are pinned. Pinning
    // can take minutes (`gh` reading a pull request), and a draft in the queue
    // can be pulled into planning by any tick meanwhile; a refused upload then
    // removes a mission that is already being planned.
    const uploading = (request.uploads ?? []).length > 0;
    const created = this.deps.unitOfWork.transaction(() => {
      // Validated and stored with the mission, in one transaction, rather than
      // patched on afterwards: with plans approved automatically, a task can
      // become READY - and snapshot its staffing - before a second request lands.
      const { next: staffing, touched } = mergeRoleStaffing({}, request.staffing ?? {});
      if (touched.length > 0) {
        assertStaffing(indexTeam(this.deps.members.listByWorkspace(workspaceId, { includeRemoved: true })), staffing, touched);
      }
      this.deps.missions.create({
        id,
        workspaceId,
        repositoryId: repositoryId as RepositoryId | null,
        title,
        goal: request.goal.trim(),
        constraints: request.constraints ?? [],
        successCriteria: request.successCriteria ?? [],
        autonomy: request.autonomy ?? workspace.defaultAutonomyLevel,
        workflowPreset: request.workflowPreset ?? DEFAULT_PRESET_ID,
        workflowInputs: request.workflowInputs ?? {},
        baseBranch: request.baseBranch ?? repository?.defaultBranch ?? null,
        createdBy: actorId,
        staffing,
        ...(request.priority === undefined ? {} : { priority: request.priority }),
        queued: queued && !uploading,
        // Its own limits (P8); absent, the project's default mission limits apply.
        ...(request.limits === undefined ? {} : { limits: normalizeLimits(request.limits) }),
        // Which routine made it (P11); a person's own mission has none.
        ...(origin.routineId === undefined ? {} : { routineId: origin.routineId }),
        // Which GitHub issue it came from (P14): a restart finds it by this rather than making another.
        ...(origin.issueLinkId === undefined ? {} : { issueLinkId: origin.issueLinkId }),
        ...(request.lane === undefined ? {} : { laneRequest: request.lane }),
        // Which tracker item Start made it from (intake spec §7): Start refuses a second mission by this.
        ...(origin.trackerItemId === undefined ? {} : { trackerItemId: origin.trackerItemId }),
      });
      // Numbered in the same transaction as the mission: the ledger is the
      // contract every later role is measured against, so a mission never
      // exists without it.
      // Lines parsed from an issue are marked as such, so an upstream edit replaces only those (P14).
      // Lines parsed from a tracker item are recorded as coming from the tracker (intake spec §7).
      this.deps.criteria?.addUserCriteria(id, request.successCriteria ?? [], origin.issueLinkId !== undefined ? ISSUE_CRITERIA_AUTHOR
        : origin.trackerItemId !== undefined ? TRACKER_CRITERIA_AUTHOR : undefined);
      // The integration branch is named at creation rather than at merge time so
      // that every task branch can be cut from a name that already exists in the
      // record, and so the user can see where the work will land before it does.
      return this.deps.missions.update(id, {
        integrationBranch: `tandemise/${slugify(title)}/integration`,
      });
    });

    // Pinned before the mission is announced or planned, and all or nothing: a
    // refused upload removes the mission it came with rather than leave one
    // the person did not get back from their request. Pinning writes blobs
    // and may call `gh`, so it cannot share the creation transaction.
    const pinned = await this.#pinUploads(caller, id, request);
    const announced = queued && uploading ? this.deps.missions.update(id, { queuedAt: this.deps.clock.now() }) : created;

    this.deps.recorder.note(
      { workspaceId, missionId: id, actorId },
      `Mission created: ${summarize(created.goal, 300)}`,
    );
    for (const upload of pinned) {
      // Recorded like a person's completed step: what they handed in is on the timeline.
      this.deps.recorder.record({ workspaceId, missionId: id, actorId }, { type: 'artifact.created', artifactId: upload.evidence.id });
    }
    if (pinned.length > 0) this.deps.recorder.invalidate('artifacts', id);
    this.deps.recorder.invalidate('missions', id);
    // A queued draft may be pulled at once if the project has room.
    if (announced.queuedAt !== null) this.deps.scheduler.wake();

    if (request.planNow === true) {
      // In the background: the caller gets the mission back in PLANNING, not a
      // request held open for as long as a model takes to think. Only now,
      // with every upload pinned, so planning never starts on a mission a
      // refused upload is about to remove.
      await this.deps.planning.begin(id);
      return this.#require(id);
    }
    return announced;
  }

  /** Every upload pinned as Evidence with no task, or the mission removed and the refusal said. */
  async #pinUploads(caller: Caller, missionId: MissionId, request: CreateMissionRequest): Promise<readonly PinnedContribution[]> {
    const uploads = request.uploads ?? [];
    if (uploads.length === 0) return [];
    const pinned: PinnedContribution[] = [];
    try {
      if (this.deps.contributions === undefined) throw TandemiseError.validation('This build cannot take uploads.');
      for (const contribution of uploads) {
        pinned.push(await this.deps.contributions.pin({
          missionId, taskId: null, caller, onBehalfOf: request.onBehalfOf ?? null, contribution,
        }));
      }
      return pinned;
    } catch (e) {
      // The artifact rows go with the mission; a blob already written stays,
      // content-addressed and harmless, for the next identical upload to reuse.
      this.deps.missions.remove(missionId);
      if (e instanceof ContributionError) throw TandemiseError.validation(e.message, { code: e.code });
      throw e;
    }
  }

  async start(id: MissionId): Promise<Mission> {
    const mission = this.#require(id);
    const tasks = this.deps.tasks.listByMission(id);
    if (tasks.length === 0) {
      throw new TandemiseError('PRECONDITION_FAILED', 'This mission has no plan yet. Plan it first.', {
        details: { missionId: id },
      });
    }
    const pendingPlanApproval = this.deps.approvals
      .list({ missionId: id, statuses: ['PENDING'] })
      .find((a) => a.kind === 'plan');
    if (pendingPlanApproval !== undefined) {
      throw new TandemiseError(
        'APPROVAL_REQUIRED',
        'The plan is waiting for your approval; approving it starts the mission.',
        { details: { approvalId: pendingPlanApproval.id } },
      );
    }

    // Someone else working on the same tracker item refuses the start, in plain words.
    const claimed = canTransition(mission.status, 'EXECUTING') ? await this.deps.claims?.assertMayStart(mission) : false;
    let started: Mission;
    try {
      started = this.#transition(mission, 'EXECUTING', 'Started.');
    } catch (e) {
      // The start failed after the claim was made: let the item go again.
      if (claimed === true) await this.deps.claims?.abandonStart?.(mission);
      throw e;
    }
    if (started.startedAt === null) {
      this.deps.missions.update(id, { startedAt: this.deps.clock.now() });
    }
    this.deps.scheduler.wake();
    return this.#require(id);
  }

  async pause(id: MissionId): Promise<Mission> {
    const mission = this.#require(id);
    // In-flight runs are allowed to finish. Killing a worker mid-edit to honour
    // a pause would leave a half-written tree, which is a worse outcome than a
    // pause that takes one task to take effect; `cancel` is the hard stop.
    return this.#transition(mission, 'PAUSED', 'Paused by the user. Running tasks will finish.');
  }

  async resume(id: MissionId): Promise<Mission> {
    const mission = this.#require(id);
    if (mission.status !== 'PAUSED' && mission.status !== 'BLOCKED') {
      throw new TandemiseError('PRECONDITION_FAILED', `A mission in ${mission.status} is not paused.`, {
        details: { missionId: id, status: mission.status },
      });
    }
    // Resuming at a limit would start work the limit exists to stop; the
    // limit card, or a higher limit, is the way on (P8).
    const refusal = this.deps.limitRefusal?.(id) ?? null;
    if (refusal !== null) {
      throw new TandemiseError('PRECONDITION_FAILED', `${refusal}. Raise the limit to resume this mission.`, {
        details: { missionId: id, reason: refusal },
      });
    }
    const resumed = this.#transition(mission, 'EXECUTING', 'Resumed by the user.');
    this.deps.scheduler.wake();
    return resumed;
  }

  async cancel(id: MissionId, reason?: string): Promise<Mission> {
    const mission = this.#require(id);
    const detail = reason?.trim() || 'Cancelled by the user.';
    const scope = scopeOf(mission);

    // Abort first: the transition authorizes the stop, and a worker that is
    // still streaming while the mission reads CANCELLED is exactly the orphan
    // this ordering exists to prevent.
    this.deps.scheduler.cancelMission(id);
    // The planner is not a task: stop it too, so a plan finishing after the
    // cancel is discarded instead of raising an approval on a cancelled mission.
    this.deps.planning.abandon(id);
    const cancelled = this.#transition(mission, 'CANCELLED', detail);

    for (const task of this.deps.tasks.listByMission(id)) {
      if (isTaskFinished(task.status)) continue;
      this.deps.tasks.update(task.id, {
        status: 'CANCELLED',
        statusReason: detail,
        finishedAt: this.deps.clock.now(),
      });
      this.deps.recorder.record({ ...scope, taskId: task.id, roleId: task.roleId }, {
        type: 'task.status', from: task.status, to: 'CANCELLED', reason: detail,
      });
    }
    for (const approval of this.deps.approvals.list({ missionId: id, statuses: ['PENDING'] })) {
      this.deps.approvals.update(approval.id, {
        status: 'CANCELLED',
        decidedAt: this.deps.clock.now(),
        decisionNote: detail,
      });
    }
    this.deps.missions.update(id, { completedAt: this.deps.clock.now() });
    this.deps.recorder.invalidate('tasks', id);
    this.deps.recorder.invalidate('approvals', id);
    return cancelled;
  }

  async remove(id: MissionId): Promise<void> {
    const mission = this.#require(id);
    if (!isTerminalMissionStatus(mission.status)) {
      this.deps.scheduler.cancelMission(id);
      await this.deps.scheduler.drain();
    }
    this.deps.missions.remove(id);
    this.deps.recorder.invalidate('missions');
  }

  async retryTask(
    caller: Caller,
    taskId: TaskId,
    options: { runtimeProfileId?: string; note?: string; addCapabilities?: readonly string[]; stopRun?: boolean },
  ): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    requireSeat(this.deps, mission.workspaceId, caller);
    // A stage an upload covers has no work of its own to retry: a replan
    // decides afresh whether the upload still covers it (spec A2).
    if (isCoveredPlaceholder(task)) {
      throw new TandemiseError('CONFLICT', COVERED_MESSAGE, { details: { taskId } });
    }
    const widening = (options.addCapabilities ?? []).length > 0;
    // A worker parked on a question can be restarted with more access: that is
    // often the question ("I can't do this with my grants").
    // "Stop and retry" on a quiet run (P9): its live run is stopped and the step
    // queued again in this one decision, the path a widening retry already takes.
    const stopping = options.stopRun === true && (task.status === 'RUNNING' || task.status === 'AWAITING_INPUT');
    // A wait that keeps looking can be told to start over (#145): its poll stops and it looks again from now.
    const rewaiting = task.executor === 'wait' && task.status === 'AWAITING_EXTERNAL';
    const retryable = RETRYABLE_TASK_STATUSES.includes(task.status) || (widening && task.status === 'AWAITING_INPUT') || stopping || rewaiting;
    if (!retryable) {
      throw new TandemiseError('PRECONDITION_FAILED', `A task in ${task.status} cannot be retried.`, {
        details: { taskId, status: task.status },
      });
    }

    if (options.runtimeProfileId !== undefined) {
      this.deps.overrides.set(taskId, asId<'RuntimeProfileId'>(options.runtimeProfileId));
    }
    // The budget is extended rather than the attempt counter reset: the history
    // of how many times this task has been tried is evidence, and erasing it
    // would let a task that always fails loop forever one manual retry at a time
    // while the timeline showed attempt 1 each round.
    const added = [...new Set(options.addCapabilities ?? [])]
      .filter((c) => !task.executionPolicy.capabilities.includes(c));
    const note = options.note?.trim() ?? '';
    // A note is the person's request, so the retry is the next round framed as
    // one (spec §7, C12), not a gate failure with a remark appended. Only where
    // a note would start a round: from AWAITING_INPUT the run is restarted with
    // more access mid-question, and behind a start card nothing has run yet, so
    // those keep today's framing.
    // A wait step reads no feedback, so its note stays a retry reason.
    const effect = feedbackEffectFor(task, this.deps.approvals.pendingForTask(taskId), this.deps.runs);
    if (note.length > 0 && !stopping && task.executor !== 'wait' && task.executor !== 'ship' && (effect.kind === 'review' || effect.kind === 'reopen' || effect.kind === 'round_now')) {
      let pending;
      try {
        // One unit with the round, so a round that cannot start leaves the task's access as it was.
        pending = this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
          if (added.length > 0) {
            this.deps.tasks.update(taskId, { executionPolicy: { ...task.executionPolicy, capabilities: [...task.executionPolicy.capabilities, ...added] } });
          }
          // A retry cannot show the impact dialog; work that used the old version is kept and flagged when the round lands.
          return this.deps.feedback.beginGive(caller, taskId, { text: note }, { forceDownstream: 'keep' });
        }));
      } catch (error) {
        // The override lives in memory, outside the unit: set before the round so its first dispatch sees it, taken back if it failed.
        if (options.runtimeProfileId !== undefined) this.deps.overrides.clear(taskId);
        throw error;
      }
      // Only now that the unit has committed: the scheduler must find the round when it wakes.
      this.deps.feedback.afterGive(pending);
      return this.#taskView(mission.id, taskId);
    }
    const reason = note
      || `${stopping ? 'Stopped and retried' : 'Retried'} by the user${options.runtimeProfileId === undefined ? '' : ' on a different runtime'}`
        + `${added.length > 0 ? ` with more access: ${added.join(', ')}` : ''}.`;
    if (rewaiting) this.deps.scheduler.cancelTask(taskId);
    // The run ends after this decision; the executor finds the step READY and leaves it so.
    if (task.status === 'AWAITING_INPUT' || stopping) {
      this.deps.scheduler.cancelTask(taskId);
      for (const approval of this.deps.approvals.pendingForTask(taskId)) {
        this.deps.approvals.update(approval.id, {
          status: 'CANCELLED', decidedAt: this.deps.clock.now(), decisionNote: reason,
        });
      }
    }
    this.deps.tasks.update(taskId, {
      ...(added.length > 0
        ? {
          executionPolicy: { ...task.executionPolicy, capabilities: [...task.executionPolicy.capabilities, ...added] },
        }
        : {}),
      status: 'READY',
      statusReason: reason,
      // A retry is a new round: the attention a check asked for was about the
      // last one, and the people an escalation reached were for that wait.
      needsAttention: false,
      ...(task.staffing?.escalatedTo === undefined ? {} : { staffing: withoutEscalation(task.staffing) }),
      // The retry's prompt quotes what the last attempt failed on. A note the
      // person wrote is added to it, never swapped in: "Retried by the user"
      // in its place told the worker nothing about what to do differently.
      retryFeedback: [task.retryFeedback, options.note?.trim() ? `When retrying, the person said: ${options.note.trim()}` : null]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n\n') || null,
      retryPolicy: {
        ...task.retryPolicy,
        maxAttempts: Math.max(task.retryPolicy.maxAttempts, task.attempts + 1),
      },
      finishedAt: null,
    });
    this.deps.recorder.record({ ...scopeOf(mission), taskId, roleId: task.roleId }, {
      type: 'task.status', from: task.status, to: 'READY', reason,
    });
    this.#holdDependents(task, mission);
    this.#reviveMission(mission, `'${task.key}' was retried by the user.`);
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  /**
   * Sends work downstream of a retried task back to waiting for it.
   *
   * Retrying a task that had succeeded left its dependents where they were, so
   * they kept running on the old result: a release task checked for a pull
   * request while the task that opens it was still re-running, found none, and
   * asked for approval of that. Dependents still in flight or parked go back to
   * PENDING (a running one is stopped); finished ones are left alone - their
   * work is done, and redoing it is the person's call.
   */
  #holdDependents(task: MissionTask, mission: Mission): void {
    const all = this.deps.tasks.listByMission(mission.id);
    const downstream = new Set<string>();
    const stack = [task.key];
    while (stack.length > 0) {
      const key = stack.pop()!;
      for (const t of all) {
        if (t.dependsOn.includes(key) && !downstream.has(t.key)) {
          downstream.add(t.key);
          stack.push(t.key);
        }
      }
    }
    const reason = `Waiting again: '${task.key}' is being retried.`;
    for (const dependent of all.filter((t) => downstream.has(t.key))) {
      if (isTaskFinished(dependent.status) || dependent.status === 'PENDING') continue;
      this.deps.scheduler.cancelTask(dependent.id);
      this.deps.tasks.update(dependent.id, { status: 'PENDING', statusReason: reason });
      for (const approval of this.deps.approvals.pendingForTask(dependent.id)) {
        this.deps.approvals.update(approval.id, {
          status: 'CANCELLED', decidedAt: this.deps.clock.now(), decisionNote: reason,
        });
      }
      this.deps.recorder.record({ ...scopeOf(mission), taskId: dependent.id, roleId: dependent.roleId }, {
        type: 'task.status', from: dependent.status, to: 'PENDING', reason,
      });
    }
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  /**
   * A person reports that they have finished a `human` task.
   *
   * What they bring back is written as the artifact the step declared, so the
   * work downstream consumes it the same way it consumes an agent's output.
   * That is the whole trick: a design made in Figma and a design written by a
   * model arrive at the next task in the same shape, and nothing after this
   * point needs to care which it was.
   */
  async completeTask(caller: Caller, taskId: TaskId, request: CompleteTaskRequest): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);

    if (task.executor !== 'human') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `Task '${task.key}' runs on a runtime; it is not yours to complete.`,
        { details: { taskId, executor: task.executor } });
    }
    if (task.status !== 'AWAITING_HUMAN') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `A task in ${task.status} is not waiting for you.`,
        { details: { taskId, status: task.status } });
    }
    const { actorId, recordedBy } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    this.#assertMayTake(task, mission, actorId, 'complete');
    // Completing an unclaimed pool task is claiming it: whoever did the work is
    // its assignee, and answers for it unless someone was named responsible.
    const taken: { assigneeId?: string; responsibleId?: string } = task.assigneeId !== actorId
      ? this.#claimFields(task, mission, actorId) : {};
    const responsibleId = taken.responsibleId ?? task.responsibleId ?? null;

    const scope: EventScope = { ...scopeOf(mission), taskId, roleId: task.roleId, actorId };
    // Taking it from its assignee (an escalation reached them) is said, as a claim would say it.
    if (task.assigneeId != null && task.assigneeId !== actorId) this.#noteTaken(scope, task, actorId);
    // People are not made to fill in YAML: their first sentence is the headline.
    const handoff = this.deps.measure.deriveHandoff(request.result);
    for (const type of task.expectedOutputs) {
      // A re-completed task replaces what it brought back last time, exactly as
      // an agent's retry does; otherwise both answers stay live and the next
      // task reads the stale one too. The repository sets the back-pointer.
      const previous = supersededBy(task, type, this.deps.artifacts, this.deps.tasks);
      const manifest = await this.deps.artifactStore.write({
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        taskId: task.id,
        type,
        title: task.title,
        body: request.result,
        // What a person types is text, whatever the output type: Evidence
        // defaults to a binary blob, which the reader cannot show.
        mediaType: 'text/markdown',
        summary: handoff.headline,
        supersedes: previous?.id ?? null,
      });
      // Recorded, not only stored: gates and the next task read the manifest
      // table, and a person's output has to arrive the way an agent's does.
      // Measured so the reader can show its length, but never held to a budget:
      // what a person brings back is theirs to size.
      const recorded = this.deps.artifacts.create({
        ...manifest, authorId: actorId, recordedBy, responsibleId,
        handoff, wordCount: this.deps.measure.measure(type, request.result).mainWords, overBudget: false,
        round: task.round ?? 1,
      });
      this.deps.recorder.record(scope, { type: 'artifact.created', artifactId: recorded.id });
    }
    // A person's text cites no ids, so bringing the step back answers every note on it (plan ruling 1).
    this.deps.rounds.onPersonCompleted(task, scope);

    // The step passed its round: the reviews its staffing names - a blocking
    // look, the lead's sign-off, an after-the-fact check - apply to a person's
    // work exactly as they do to an agent's. A person's step has no gate and
    // no checks of its own.
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', mission.workspaceId);
    const outcome = this.deps.reviews.onRoundPassed({
      task: { ...task, ...taken },
      mission,
      workspace,
      role: this.deps.roles.get(task.roleId, mission.workspaceId),
      gate: null,
      checks: [],
      scope,
    });
    const reason = outcome.status === 'SUCCEEDED' ? request.note?.trim() || 'Completed by you.' : outcome.reason;
    this.deps.tasks.update(taskId, {
      ...taken,
      status: outcome.status,
      statusReason: reason,
      ...(outcome.status === 'SUCCEEDED' ? { finishedAt: this.deps.clock.now() } : {}),
    });
    this.deps.recorder.record(scope, {
      type: 'task.status', from: task.status, to: outcome.status, ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.recorder.invalidate('artifacts', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  /**
   * Takes an unassigned human task, for the caller or the member named.
   *
   * Only someone the staffing made claimable may take it, and a task already
   * taken by someone else is not taken twice: two people doing the same work
   * without knowing it is the failure this exists to prevent.
   */
  async claimTask(caller: Caller, taskId: TaskId, request: ClaimTaskRequest): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    if (task.executor !== 'human' || task.status !== 'AWAITING_HUMAN') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `Task '${task.key}' is not waiting for a person to take it.`,
        { details: { taskId, executor: task.executor, status: task.status } });
    }
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    if (task.assigneeId === actorId) return this.#taskView(mission.id, taskId);
    this.#assertMayTake(task, mission, actorId, 'claim');

    const fields = this.#claimFields(task, mission, actorId);
    const name = this.#nameOf(actorId);
    this.deps.tasks.update(taskId, { ...fields, statusReason: waitingForName(name) });
    this.#noteTaken({ ...scopeOf(mission), taskId, roleId: task.roleId, actorId }, task, actorId);
    this.deps.recorder.invalidate('tasks', mission.id);
    return this.#taskView(mission.id, taskId);
  }

  /**
   * "Continue elsewhere" (spec A4): the person takes an agent's step to
   * another tool, and the step waits for their hand-back.
   *
   * AWAITING_EXTERNAL is written before the live run is stopped, so the
   * executor, finding its row no longer running as the run ends, keeps the
   * park rather than settling the step CANCELLED. The scheduler adopts only
   * wait steps in AWAITING_EXTERNAL, and a parked status is outside the
   * concurrency ceiling, so the step neither runs again nor holds a slot.
   */
  async parkTask(taskId: TaskId, caller: Caller, request: ParkTaskRequest): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller);
    const refuse = (reason: string): never => {
      throw new TandemiseError('CONFLICT', reason, { details: { taskId, status: task.status, executor: task.executor } });
    };
    if (task.executor !== 'agent') {
      refuse(task.executor === 'wait' || task.executor === 'ship'
        ? `'${task.title}' is a ${task.executor === 'ship' ? 'ship' : 'wait'} step; it finishes on its own check, not in another tool.`
        : `'${task.title}' is already a person's step; complete it instead.`);
    }
    if (!PARKABLE_TASK_STATUSES.includes(task.status)) refuse(`A step in ${task.status} cannot be continued elsewhere.`);
    if (!task.expectedOutputs.some((type) => LINKABLE_OUTPUT_TYPES.includes(type))) {
      refuse(`'${task.title}' makes nothing that can be brought back from another tool.`);
    }
    // A finished mission goes back to work, as a round would take it; a cancelled one cannot.
    if (!missionTakesRounds(mission)) refuse(CLOSED_MISSION_MESSAGE);
    if (this.deps.events === undefined) refuse('This build cannot park a step.');
    // Once other work has read this step's output, taking the step away would
    // leave that work standing on a version nobody is finishing.
    if (this.deps.rounds.impactOf(task).consumers.length > 0) {
      refuse(`Work already used the output of '${task.title}', so it cannot be continued elsewhere now.`);
    }
    this.#assertMayTake(task, mission, actorId, 'continue');

    const tool = request.tool.trim();
    const reason = continuedIn(tool);
    const scope: EventScope = { ...scopeOf(mission), taskId, roleId: task.roleId, actorId };
    // One unit: the park, the work it holds and the mission it reopens land together.
    this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      this.deps.tasks.update(taskId, { status: 'AWAITING_EXTERNAL', statusReason: reason, needsAttention: false, finishedAt: null });
      this.deps.recorder.record(scope, { type: 'task.status', from: task.status, to: 'AWAITING_EXTERNAL', reason });
      this.deps.recorder.record(scope, { type: 'task.parked_external', tool });
      // The output is away until the hand-back, so work about to read it waits,
      // as it does for a round; finishing the step again releases it.
      this.deps.rounds.holdDependents({ ...task, status: 'AWAITING_EXTERNAL' }, `Waiting for '${task.key}' from ${tool}.`);
      // A mission that had finished waits on the person again, rather than reading as done.
      this.#reviveMission(mission, `'${task.key}' was continued in ${tool}.`);
    }));
    // Only after the commit: the run ends after the park is on the row, so the
    // executor keeps it. A no-op when nothing runs.
    this.deps.scheduler.cancelTask(taskId);
    this.deps.recorder.invalidate('tasks', mission.id);
    return this.#taskView(mission.id, taskId);
  }

  /**
   * "Take it back": the person changed their mind about continuing a step
   * elsewhere, and the agent picks it up again. The step goes back to READY
   * as a retry would, the work the park held stops waiting on the other tool
   * and waits for the step instead, and the scheduler runs it again. Nothing
   * is pinned or written; a hand-back after this is refused, as the step is
   * no longer parked.
   */
  async unparkTask(taskId: TaskId, caller: Caller): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller);
    const park = this.#assertParked(task, mission, 'taken back');
    this.#assertMayTake(task, mission, actorId, 'take back');
    const scope: EventScope = { ...scopeOf(mission), taskId, roleId: task.roleId, actorId };
    const reason = `Taken back from ${park.tool}.`;
    this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
      // Checked again inside the unit: a hand-back racing this one may have landed first.
      const current = this.#requireTask(taskId);
      if (parkedExternalOf(current, this.#log(mission.id)) === null) {
        throw new TandemiseError('CONFLICT', `'${task.title}' is no longer waiting for work from another tool.`, { details: { taskId } });
      }
      this.deps.tasks.update(taskId, {
        status: 'READY', statusReason: null, needsAttention: false, finishedAt: null,
        // Room for one more attempt, as a retry gives: a step parked after its last attempt must still run.
        retryPolicy: { ...current.retryPolicy, maxAttempts: Math.max(current.retryPolicy.maxAttempts, current.attempts + 1) },
      });
      this.deps.recorder.record(scope, { type: 'task.status', from: current.status, to: 'READY', reason });
      this.deps.recorder.record(scope, { type: 'task.unparked', tool: park.tool });
      this.deps.rounds.releaseHeld(current, `Waiting for '${task.key}' from ${park.tool}.`);
      this.#reviveMission(mission, `'${task.key}' was taken back from ${park.tool}.`);
    }));
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  /**
   * "Hand back" (spec A4): what the person made elsewhere comes back as the
   * parked step's next round, a human-authored one.
   *
   * The contribution is pinned as Evidence first (a PR link is read through
   * the resolver), then each output the step declared is written from it, so
   * the work downstream reads it the same way it reads an agent's round. The
   * parked runtime session is not resumed: the work moved to another tool.
   */
  async handBack(taskId: TaskId, caller: Caller, request: HandBackRequest): Promise<{ task: TaskView; artifacts: ArtifactManifest[] }> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    const { actorId, recordedBy } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    const park = this.#assertParked(task, mission, 'handed back');
    // Whoever records it is the one taking the step; the author may be someone without a seat.
    this.#assertMayTake(task, mission, recordedBy, 'hand back');
    if (this.deps.contributions === undefined) throw TandemiseError.validation('This build cannot take a hand-back.');
    // Read before anything is pinned: a hand-back that cannot land leaves nothing behind.
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', mission.workspaceId);
    const role = this.deps.roles.get(task.roleId, mission.workspaceId);

    let pinned: PinnedContribution;
    try {
      pinned = await this.deps.contributions.pin({
        missionId: mission.id, taskId, caller, onBehalfOf: request.onBehalfOf ?? null, contribution: request.contribution,
        // A change is only worth handing back with a branch review, QA and integration can check out.
        requireBranch: task.expectedOutputs.includes('ChangeSet'),
      });
    } catch (e) {
      if (e instanceof ContributionError) throw TandemiseError.validation(e.message, { code: e.code });
      throw e;
    }
    const { evidence } = pinned;
    let landed = false;
    try {
      const round = (task.round ?? 1) + 1;
      const body = await this.#handBackBody(request.note, park.tool, pinned);
      const link = this.#handBackLink(mission.workspaceId, request.contribution, pinned);
      const derived = this.deps.measure.deriveHandoff(request.note);
      const handoff: ArtifactHandoff = link === null
        ? derived
        : { ...derived, links: [...derived.links.slice(0, HANDOFF_MAX_LINKS - 1), link] };
      // The Evidence's refs ride on every output: a file's blob, a link's url,
      // and for a pull request its head commit and branch, so review and QA
      // downstream read the commit that was handed back.
      const sourceRefs: readonly ExternalRef[] = evidence.sourceRefs;

      // Blobs are written first, outside the unit: they are content-addressed,
      // and one no row points to is harmless.
      const written: { manifest: ArtifactManifest; type: MissionTask['expectedOutputs'][number] }[] = [];
      for (const type of task.expectedOutputs) {
        const previous = supersededBy(task, type, this.deps.artifacts, this.deps.tasks);
        const manifest = await this.deps.artifactStore.write({
          workspaceId: mission.workspaceId, missionId: mission.id, taskId, type, title: task.title, body,
          mediaType: 'text/markdown', summary: handoff.headline, sourceRefs, supersedes: previous?.id ?? null,
        });
        written.push({ manifest, type });
      }

      // Everything after the awaits is one unit, whose events reach subscribers
      // only once it commits: a failure part-way leaves the step parked, with
      // no output, no event and no consumer reset.
      const { artifacts, stop } = this.deps.recorder.deferred(() => this.deps.unitOfWork.transaction(() => {
        // Checked again now that the awaits are behind us: a second hand-back
        // that raced this one has landed, and this one records nothing.
        const current = this.#requireTask(taskId);
        if (parkedExternalOf(current, this.#log(mission.id)) === null) {
          throw new TandemiseError('CONFLICT', `'${task.title}' was already handed back.`, { details: { taskId } });
        }
        // Handing it back is taking it: whoever did the work is its assignee now, as completing a step makes them.
        const taken: { assigneeId?: string; responsibleId?: string } = current.assigneeId !== actorId ? this.#claimFields(current, mission, actorId) : {};
        const responsibleId = taken.responsibleId ?? current.responsibleId ?? null;
        const scope: EventScope = { ...scopeOf(mission), taskId, roleId: task.roleId, actorId };
        this.deps.recorder.record(scope, { type: 'artifact.created', artifactId: evidence.id });
        const outputs = written.map(({ manifest, type }) => {
          const recorded = this.deps.artifacts.create({
            ...manifest, authorId: actorId, recordedBy, responsibleId, handoff,
            // Measured so the reader can show its length, never held to a budget: a person's work is theirs to size.
            wordCount: this.deps.measure.measure(type, body).mainWords, overBudget: false, round,
          });
          this.deps.recorder.record(scope, { type: 'artifact.created', artifactId: recorded.id });
          return recorded;
        });
        const next: MissionTask = { ...current, ...taken, round };
        this.deps.recorder.record(scope, {
          type: 'task.handed_back', artifactIds: outputs.map((a) => a.id), round, contribution: request.contribution.kind,
        });
        // P2's rule for work that read the version this replaces: redone, or kept
        // and flagged. Redone first, so the flagging below passes over it.
        const redone = this.deps.rounds.redoConsumers(next, round, request.downstream ?? 'keep');
        // A person's contribution cites no note ids, so it answers every note on the step.
        this.deps.rounds.onPersonCompleted(next, scope);
        const outcome = this.deps.reviews.onRoundPassed({ task: next, mission, workspace, role, gate: null, checks: [], scope });
        const reason = outcome.status === 'SUCCEEDED' ? `Handed back from ${park.tool}.` : outcome.reason;
        this.deps.tasks.update(taskId, {
          ...taken, round, status: outcome.status, statusReason: reason, needsAttention: false,
          ...(outcome.status === 'SUCCEEDED' ? { finishedAt: this.deps.clock.now() } : {}),
        });
        this.deps.recorder.record(scope, {
          type: 'task.status', from: current.status, to: outcome.status, ...(reason === null ? {} : { reason }),
        });
        if (task.expectedOutputs.includes('ChangeSet')) this.#retireTargets(task, `Superseded by the change handed back from ${park.tool}.`);
        return { artifacts: outputs, stop: redone };
      }));
      landed = true;
      // Only after the commit: a stopped pass re-reads its row and must find the reset.
      for (const id of stop) this.deps.scheduler.cancelTask(id);
      if (task.expectedOutputs.includes('ChangeSet')) await this.#adoptHandedBackHead(task, mission, pinned, park.tool);
      this.deps.recorder.invalidate('tasks', mission.id);
      this.deps.recorder.invalidate('artifacts', mission.id);
      this.deps.scheduler.wake();
      return { task: await this.#taskView(mission.id, taskId), artifacts };
    } finally {
      // A hand-back that did not land leaves no pin behind to be read as one.
      if (!landed) this.deps.artifacts.withdraw([evidence.id], this.deps.clock.now());
    }
  }

  /**
   * Marks the step's own execution targets released. A hand-back replaces the
   * agent's change with the person's, and the worktree the agent left behind
   * would otherwise still be merged into the integration branch next to it.
   * The tree and its branch stay on disk; only the record stops counting them.
   */
  #retireTargets(task: MissionTask, detail: string): void {
    const targets = this.deps.targets;
    if (targets === undefined) return;
    for (const record of targets.listByMission(task.missionId)) {
      if (record.taskId !== task.id || record.status === 'RELEASED') continue;
      targets.update(record.id, { status: 'RELEASED', releasedAt: this.deps.clock.now(), detail });
    }
    this.deps.recorder.invalidate('targets', task.missionId);
  }

  /**
   * A change handed back from a pull request becomes where the step's next
   * agent round starts. The step's worktree branch is fixed per task and a
   * later round reuses it, so without this a round asked for after the
   * hand-back would go back onto the agent's old branch, without the pull
   * request, and its ChangeSet would replace the person's. A change handed
   * back as a file has no branch to move to: the step's next round starts
   * from its old branch, which KNOWN_LIMITATIONS says.
   */
  async #adoptHandedBackHead(task: MissionTask, mission: Mission, pinned: PinnedContribution, tool: string): Promise<void> {
    const adopt = this.deps.contributions?.adoptPullRequestHead;
    const head = pinned.resolved?.headRefOid;
    const fetched = pinned.evidence.sourceRefs.some((r) => r.kind === 'git.branch');
    if (adopt === undefined || head === undefined || !fetched || pinned.repositoryPath === null || this.deps.targets === undefined) return;
    const worktrees = this.deps.targets.listByMission(mission.id)
      .filter((t) => t.taskId === task.id && t.kind === 'worktree' && t.branch !== null)
      .map((t) => ({ directory: t.workingDirectory, branch: t.branch! }));
    const unique = [...new Map(worktrees.map((w) => [w.branch, w])).values()];
    if (unique.length === 0) return;
    const problems = await adopt.call(this.deps.contributions, { repositoryPath: pinned.repositoryPath, commit: head, worktrees: unique });
    if (problems.length > 0) {
      this.deps.recorder.note(
        { ...scopeOf(mission), taskId: task.id, roleId: task.roleId },
        `The change handed back from ${tool} is in place, but a later round of '${task.key}' may not start from it: ${problems.join(' ')}`,
        'warn',
      );
    }
  }

  /** The step's park, or a CONFLICT saying why nothing can be handed back to it or taken back from it. Writes nothing. */
  #assertParked(task: MissionTask, mission: Mission, action: 'handed back' | 'taken back'): ParkedExternal {
    const park = task.executor === 'agent' ? parkedExternalOf(task, this.#log(mission.id)) : null;
    if (park === null) {
      throw new TandemiseError('CONFLICT', `'${task.title}' is not waiting for work from another tool.`, {
        details: { taskId: task.id, status: task.status },
      });
    }
    if (mission.status === 'CANCELLED' || mission.status === 'COMPLETE') {
      const next = action === 'handed back' ? 'start a new mission to continue this work' : 'there is nothing left to run it in';
      throw new TandemiseError('CONFLICT', `This mission is ${mission.status === 'CANCELLED' ? 'cancelled' : 'complete'}; ${next}.`, {
        details: { taskId: task.id, missionId: mission.id, status: mission.status },
      });
    }
    return park;
  }

  /** The mission's semantic log, where parks and hand-backs are recorded. */
  #log(missionId: MissionId) {
    return this.deps.events?.listByMission(missionId, { semanticOnly: true }) ?? [];
  }

  /**
   * The body of a handed-back output: the person's note, then what came back.
   * Text (a Markdown file, a PR's title, body and diff) is carried in full so
   * the work downstream reads the contribution itself; anything else is named,
   * and its Evidence is one link away.
   */
  async #handBackBody(note: string, tool: string, pinned: PinnedContribution): Promise<string> {
    const { evidence } = pinned;
    const name = pinned.resolved !== null ? `pull request ${pinned.resolved.repo}#${pinned.resolved.number}` : uploadFilename(evidence);
    const lines = [note.trim(), '', `## Handed back from ${tool}`, '', `From ${name} (Evidence ${evidence.id}).`];
    if (isReadableText(pinned.mediaType)) {
      try {
        lines.push('', (await this.deps.artifactStore.read(evidence.id)).body.trimEnd());
      } catch {
        // Unreadable here is still pinned and linked; the note stands on its own.
      }
    }
    return `${lines.join('\n')}\n`;
  }

  /** The handoff link a reader follows to the contribution: the PR, the page, or the stored file. */
  #handBackLink(workspaceId: WorkspaceId, contribution: HandBackRequest['contribution'], pinned: PinnedContribution): HandoffLink | null {
    if (contribution.kind === 'link') {
      // Every link kind but `workspace` is http(s) only.
      if (!/^https?:\/\//i.test(contribution.url)) return null;
      return pinned.resolved !== null
        ? { label: `Pull request #${pinned.resolved.number}`, kind: 'pr', url: contribution.url }
        : { label: contribution.label ?? 'Open the link', kind: 'doc', url: contribution.url };
    }
    if (this.deps.artifactRoot === undefined) return null;
    const path = relative(this.deps.artifactRoot(workspaceId), this.deps.artifactStore.resolvePath(pinned.evidence));
    return { label: 'Open the file', kind: 'workspace', path };
  }

  async skipTask(caller: Caller, taskId: TaskId): Promise<TaskView> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(task.missionId);
    requireSeat(this.deps, mission.workspaceId, caller);
    if (isTaskFinished(task.status) && task.status !== 'FAILED') {
      throw new TandemiseError('PRECONDITION_FAILED', `A task in ${task.status} cannot be skipped.`, {
        details: { taskId, status: task.status },
      });
    }
    this.deps.scheduler.cancelTask(taskId);

    const reason = 'Skipped by the user.';
    this.deps.tasks.update(taskId, {
      status: 'SKIPPED',
      statusReason: reason,
      finishedAt: this.deps.clock.now(),
    });
    this.deps.recorder.record({ ...scopeOf(mission), taskId, roleId: task.roleId }, {
      type: 'task.status', from: task.status, to: 'SKIPPED', reason,
    });
    // A skipped task has nothing left to decide, so its open cards are
    // withdrawn - otherwise an intervention for work nobody is doing anymore
    // stays in the inbox asking to retry it.
    for (const approval of this.deps.approvals.pendingForTask(taskId)) {
      this.deps.approvals.update(approval.id, {
        status: 'CANCELLED', decidedAt: this.deps.clock.now(), decisionNote: reason,
      });
    }
    this.deps.recorder.invalidate('approvals', mission.id);
    // A skipped task counts as satisfied for its dependents, so downstream work
    // that was waiting on it can proceed - that is the point of skipping.
    this.#reviveMission(mission, `'${task.key}' was skipped by the user.`);
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.scheduler.wake();
    return this.#taskView(mission.id, taskId);
  }

  // ------------------------------------------------------------------ internals

  #nameOf(memberId: string): string {
    return this.deps.members.get(asId<'MemberId'>(memberId))?.name ?? 'someone';
  }

  /** "Ana took 'Design review'." - the audit line for someone taking a task. */
  #noteTaken(scope: EventScope, task: MissionTask, actorId: string): void {
    this.deps.recorder.note(scope, `${this.#nameOf(actorId)} took '${task.title}'.`);
  }

  /** The take rule (`support/take-rule.ts`), shared with the hold service. */
  #assertMayTake(task: MissionTask, mission: Mission, actorId: string, action: TakeAction): void {
    assertMayTake(this.deps, task, mission, actorId, action);
  }

  /** The assignment a person taking a task gets, with responsibility re-derived for them. */
  #claimFields(task: MissionTask, mission: Mission, actorId: string): { assigneeId: string; responsibleId?: string } {
    if (task.staffing == null) return { assigneeId: actorId };
    const team = indexTeam(this.deps.members.listByWorkspace(mission.workspaceId, { includeRemoved: true }));
    if (team.owners.length === 0) return { assigneeId: actorId };
    return { assigneeId: actorId, responsibleId: responsibleFor(team, task.staffing.staffing, actorId) };
  }

  /** A blocked mission that just got a runnable task again goes back to work. */
  #reviveMission(mission: Mission, reason: string): void {
    if (mission.status !== 'BLOCKED' && mission.status !== 'FAILED' && mission.status !== 'COMPLETE') return;
    this.#transition(mission, 'EXECUTING', reason);
  }

  #transition(mission: Mission, status: MissionStatus, reason: string): Mission {
    if (mission.status === status) return mission;
    if (!canTransition(mission.status, status)) {
      throw new TandemiseError(
        'PRECONDITION_FAILED',
        `A mission in ${mission.status} cannot move to ${status}.`,
        { details: { missionId: mission.id, from: mission.status, to: status } },
      );
    }
    const updated = this.deps.missions.update(mission.id, { status, statusReason: reason });
    this.deps.recorder.record(scopeOf(mission), {
      type: 'mission.status', from: mission.status, to: status, reason,
    });
    this.deps.recorder.invalidate('missions', mission.id);
    return updated;
  }

  #summary(mission: Mission): MissionSummary {
    const tasks = this.deps.tasks.listByMission(mission.id);
    const running = tasks.find((t) => t.status === 'RUNNING');
    return {
      mission,
      progress: this.deps.missions.progress(mission.id),
      repositoryName: mission.repositoryId === null
        ? null
        : this.deps.repositories.get(mission.repositoryId)?.name ?? null,
      currentActivity: running?.title ?? mission.statusReason,
      lastEventAt: null,
      criteria: mission.status === 'DRAFT' || this.deps.criteriaTrace === undefined ? null : criteriaSummary(this.deps.criteriaTrace(mission.id)),
    };
  }

  async #taskView(missionId: MissionId, taskId: TaskId): Promise<TaskView> {
    const views = await this.deps.projections.missionTasks(missionId);
    const view = views.find((v) => v.id === taskId);
    if (view === undefined) throw TandemiseError.notFound('Task', taskId);
    return view;
  }

  #require(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }

  #requireTask(id: TaskId): MissionTask {
    const task = this.deps.tasks.get(id);
    if (task === undefined) throw TandemiseError.notFound('Task', id);
    return task;
  }
}

function scopeOf(mission: Mission): EventScope {
  return { workspaceId: mission.workspaceId, missionId: mission.id };
}

/**
 * A title from the goal, for the common case where the user typed one sentence
 * and nothing else. Deliberately dumb: a title is a label, and spending a model
 * call on one would make creating a mission slower than typing the title.
 */
export function titleFromGoal(goal: string): string {
  const firstSentence = goal.trim().split(/(?<=[.!?])\s/)[0] ?? goal.trim();
  const trimmed = firstSentence.replace(/[.!?]+$/, '').trim();
  if (trimmed.length <= TITLE_MAX) return trimmed;
  // A goal's first clause is usually the outcome and the rest its reason:
  // "Add a --top N option to the tally CLI so it prints…" titles as the option.
  // Cutting at a fixed length instead left "…the N most frequent w…".
  const clause = trimmed.split(/,\s|\s(?:so that|so|because|which|while|without|—|-)\s/)[0]!.trim();
  if (clause.length >= 12 && clause.length <= TITLE_MAX) return clause;
  const cut = trimmed.slice(0, TITLE_MAX - 1);
  const words = /\s/.test(trimmed[TITLE_MAX - 1] ?? '') ? cut : cut.replace(/\s+\S*$/, '');
  return `${(words.length >= 12 ? words : cut).trimEnd()}…`;
}

/** The handoff contract's title budget (collaboration roadmap). */
const TITLE_MAX = 60;
