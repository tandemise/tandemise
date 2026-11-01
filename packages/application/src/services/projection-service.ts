import type {
  Approval, ApprovalRepositoryPort, ArtifactRepositoryPort, DecisionRepositoryPort,
  EvaluationRepositoryPort, EventRepositoryPort, ExecutionTargetRecord, FeedbackItem, FeedbackRepositoryPort,
  ExecutionTargetRepositoryPort, Mission, MissionRepositoryPort, MissionStatus, MissionTask,
  MemberRepositoryPort, PlanValidationIssue, RepoRepositoryPort, RoleRepositoryPort, RunEventRecord, RunRepositoryPort,
  RuntimeProfileRepositoryPort, Run, TaskRepositoryPort, TaskStatus, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { LIVE_RUN_STATUSES, PENDING_FEEDBACK_STATUSES, RUNTIME_ACTOR, isTrialMission, nowLine, planLevels } from '@tandemise/domain';
import type { AgentEvent } from '@tandemise/domain';
import type {
  ActorRef, FeedCard, HomeView, InboxView, MissionDetail, MissionFeedView, MissionLimitsView, MissionSummary, RuntimeView, TaskView,
} from '@tandemise/api-contract';
import { humanActionForMember, isApprovalForMember, planStanding } from '@tandemise/api-contract';
import type { InboxIntakeDecisionView, InboxStalledView } from '@tandemise/api-contract';
import type { MissionId, TaskId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import type { HoldService, HoldStanding, ProjectionService, RuntimeService } from '../services.js';
import type { GateService } from '../engine/gates.js';
import type { ReadinessService } from './readiness.js';
import type { LimitService } from './limit-service.js';
import type { LivenessService } from './liveness-service.js';
import type { DeskService } from './desk-service.js';
import { criteriaSummary } from '../support/criteria-summary.js';
import type { MetricsService } from '../engine/metrics.js';
import { asPlannedTasks, validateTaskGraph } from '../support/dag.js';
import { toApprovalView, toApprovalViews } from '../support/approval-view.js';
import { actorRef, actorRefs, toArtifactView } from '../support/actors.js';
import type { StaffingContext, StaffingResolver } from '../engine/staffing-resolver.js';
import type { Caller } from '../support/identity.js';
import { versionLines } from '../support/artifact-versions.js';
import { currentHandoff, isPlanAsking, isTaskAsking, primaryArtifact } from '../support/handoff-rules.js';
import { resolveChanges, toFeedbackView } from '../support/feedback-view.js';
import { missionTakesRounds } from '../support/feedback-rules.js';
import { intakeArtifactFor, missionUploads, uploadFilename } from '../planning/upload-intake.js';
import { isCoveredPlaceholder, parkedExternalOf, waitingForWorkIn } from '../support/outside-work.js';
import { handedTo } from '../support/lineage.js';

/** Where a task that carries an in-round note has not started that round's pass yet. */
const ROUND_NOT_RUN: readonly MissionTask['status'][] = ['READY', 'PENDING'];

/** Enough of the timeline for the home screen to show what is happening now. */
const HOME_EVENT_LIMIT = 30;
const HOME_MISSION_LIMIT = 20;

const ACTIVE_MISSION_STATUSES: readonly MissionStatus[] = [
  'PLANNING', 'EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP', 'RELEASED', 'OBSERVING',
];
const ATTENTION_MISSION_STATUSES: readonly MissionStatus[] = ['BLOCKED', 'AWAITING_PLAN_APPROVAL'];

/** The feed shows the latest few finished cards; the rest sit behind "Show N more". */
const DEFAULT_FEED_DONE_LIMIT = 5;
/** Finished for good: these cards are history, not work in flight. */
const FEED_DONE_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'];

const NO_LIMITS: MissionLimitsView = { source: 'none', limits: [], usage: { agentMinutes: 0, tokens: null, costUsd: null, runs: 0 }, pendingApprovalId: null };

export interface ProjectionDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly events: EventRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly evaluations: EvaluationRepositoryPort;
  readonly targets: ExecutionTargetRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly runtimes: RuntimeService;
  readonly gates: GateService;
  readonly metrics: MetricsService;
  readonly members: MemberRepositoryPort;
  readonly staffing: StaffingResolver;
  readonly feedback: FeedbackRepositoryPort;
  /** DRAFT missions waiting on a refinement decision (P6); optional for harnesses built before it. */
  readonly readiness?: ReadinessService;
  /** Limits and usage (P8); optional for harnesses built before it. */
  readonly limits?: Pick<LimitService, 'missionView' | 'alerts'>;
  /** Stalled missions and quiet runs (P9); optional for harnesses built before it. */
  readonly liveness?: Pick<LivenessService, 'stalled' | 'silentRuns' | 'watchOf'>;
  /** Start moves the tracker refused (#187), as Stalled rows; resolved per call, optional for harnesses. */
  readonly trackerStalled?: (workspaceId: WorkspaceId) => readonly InboxStalledView[];
  /** The desk's numbers and banners (P10); optional for harnesses built before it. */
  readonly desk?: Pick<DeskService, 'metrics' | 'banners'>;
  /** Intake signals waiting on a person (intake plan Task 7); optional for harnesses built before it. */
  readonly intakeDecisions?: (workspaceId: WorkspaceId) => readonly InboxIntakeDecisionView[];
  /** A step's open hold and whether it can be held; optional for harnesses built before holds. */
  readonly holds?: Pick<HoldService, 'standing'>;
  /** The claim banner and the Unclaimed Inbox rows (relay spec); optional for harnesses built before it. */
  readonly coordination?: {
    missionClaim(missionId: string): MissionDetail['claim'];
    inboxUnclaimed(workspaceId: string): NonNullable<InboxView['unclaimed']>;
  };
}

/** The run events a "Now" line is read from: what the agent is doing, not its bookkeeping. */
const NOW_EVENT_TYPES: readonly AgentEvent['type'][] = ['tool.started', 'message', 'thinking_summary', 'file.changed'];
const NO_HOLDS: HoldStanding = {
  hold: null, holdable: { ok: false, reason: 'This daemon has no terminal to hold a step in.' },
};

/**
 * Read models (MVP.md §7.2).
 *
 * The renderer never joins. A mission screen is one request because this
 * assembles the join here, against indexes, rather than leaving the UI to make
 * six calls and correlate them - which is how a timeline ends up showing a task
 * next to a run from a previous attempt.
 *
 * Nothing here is cached. Every value is derived from the durable record on
 * demand, and the projection bus tells subscribers *when* to re-ask rather than
 * shipping them a diff. A cache would have to be invalidated correctly from
 * fifteen call sites, and a stale mission screen is worse than a re-read.
 */
export class ProjectionServiceImpl implements ProjectionService {
  constructor(private readonly deps: ProjectionDeps) {}

  async home(workspaceId?: string): Promise<HomeView> {
    const workspace = workspaceId === undefined
      ? this.deps.workspaces.list()[0] ?? null
      : this.deps.workspaces.get(asId<'WorkspaceId'>(workspaceId)) ?? null;

    const scope = workspace === null ? {} : { workspaceId: workspace.id };
    const missions = this.deps.missions.list({ ...scope, limit: HOME_MISSION_LIMIT });
    const summaries = missions.map((m) => this.#summary(m));

    const metrics = workspace === null ? undefined : this.deps.desk?.metrics(workspace.id);
    const banners = workspace === null || metrics === undefined ? [] : this.deps.desk?.banners(workspace.id, metrics) ?? [];
    return {
      workspace,
      activeMissions: summaries.filter((s) => ACTIVE_MISSION_STATUSES.includes(s.mission.status)),
      blockedMissions: summaries.filter((s) => ATTENTION_MISSION_STATUSES.includes(s.mission.status)),
      recentMissions: summaries,
      pendingApprovals: toApprovalViews(this.deps, this.deps.approvals.list({ ...scope, statuses: ['PENDING'] })),
      runtimes: await this.#runtimeViews(workspace?.id),
      recentEvents: this.#recentEvents(missions),
      limitAlerts: workspace === null || this.deps.limits === undefined ? [] : this.deps.limits.alerts(workspace.id),
      ...(metrics === undefined ? {} : { metrics, banners }),
    };
  }

  inbox(workspaceId: WorkspaceId): InboxView {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
    // The team is read once and every name comes from it: this is behind the
    // always-mounted nav badge, and a lookup per addressee per card adds up.
    const team = new Map(this.deps.members.listByWorkspace(workspaceId, { includeRemoved: true }).map((m) => [m.id as string, m]));
    const named = { ...this.deps, members: { get: (id: string) => team.get(id) ?? this.deps.members.get(asId<'MemberId'>(id)) } };

    const missions = new Map<string, Mission | undefined>();
    const missionOf = (id: MissionId): Mission | undefined => {
      if (!missions.has(id)) missions.set(id, this.deps.missions.get(id));
      return missions.get(id);
    };
    // An eval trial is never shown to a person (P3b): its steps, parks and cards are left out.
    const isTrialOf = (id: MissionId): boolean => {
      const mission = missionOf(id);
      return mission !== undefined && isTrialMission(mission);
    };
    const tasks = this.deps.tasks.listByStatus(['AWAITING_HUMAN']).flatMap((task) => {
      const mission = missionOf(task.missionId);
      if (mission === undefined || mission.workspaceId !== workspaceId || isTrialMission(mission)) return [];
      return [{
        id: task.id,
        key: task.key,
        title: task.title,
        missionId: mission.id,
        missionTitle: mission.title,
        assignee: actorRef(named, task.assigneeId),
        responsible: actorRef(named, task.responsibleId),
        claimable: actorRefs(named, task.staffing?.claimable),
        escalatedTo: actorRefs(named, task.staffing?.escalatedTo),
        statusReason: task.statusReason,
        updatedAt: task.updatedAt,
      }];
    });
    // A request waiting on the person's decisions before it can be planned:
    // one row per mission, gone as soon as nothing is left to decide.
    const refinements = this.deps.readiness === undefined ? [] : this.deps.missions.list({ workspaceId, statuses: ['DRAFT'] }).flatMap((mission) => {
      const counts = this.deps.readiness!.counts(mission.id);
      const toDecide = counts.openQuestions + counts.proposedPending;
      if (toDecide === 0) return [];
      return [{
        missionId: mission.id,
        missionTitle: mission.title,
        toDecide,
        openQuestions: counts.openQuestions,
        proposedPending: counts.proposedPending,
        forIds: mission.createdBy == null ? [] : [mission.createdBy],
        updatedAt: mission.updatedAt,
      }];
    });
    // Parked agent steps (spec A4); the log is read only for missions that have one.
    const parked = this.deps.tasks.listByStatus(['AWAITING_EXTERNAL']).flatMap((task) => {
      const mission = missionOf(task.missionId);
      if (mission === undefined || mission.workspaceId !== workspaceId || isTrialMission(mission) || task.executor !== 'agent') return [];
      const park = parkedExternalOf(task, this.deps.events.listByMission(mission.id, { semanticOnly: true }));
      if (park === null) return [];
      return [{
        taskId: task.id,
        taskKey: task.key,
        taskTitle: task.title,
        missionId: mission.id,
        missionTitle: mission.title,
        tool: park.tool,
        title: waitingForWorkIn(park.tool),
        since: park.since,
        href: `/missions/${mission.id}?task=${task.id}`,
        forIds: park.actorId === null ? [] : [park.actorId],
      }];
    });
    return {
      // Trials raise no cards; this is the safety net should one ever slip through.
      approvals: toApprovalViews(named, this.deps.approvals.list({ workspaceId, statuses: ['PENDING'] })
        .filter((a) => a.missionId === null || !isTrialOf(a.missionId))),
      tasks,
      refinements,
      parked,
      // Derived here, on the read the nav badge makes: a mission that can move
      // again drops out with no state to clear (P9).
      stalled: [...(this.deps.liveness?.stalled(workspaceId) ?? []), ...(this.deps.trackerStalled?.(workspaceId) ?? [])],
      silentRuns: this.deps.liveness?.silentRuns(workspaceId) ?? [],
      ...(this.deps.intakeDecisions === undefined ? {} : { intakeDecisions: this.deps.intakeDecisions(workspaceId) }),
      unclaimed: this.deps.coordination?.inboxUnclaimed(workspaceId) ?? [],
    };
  }

  /**
   * A mission's cards for one caller, in a single pass.
   *
   * The team, the tasks, the artifacts, the pending approvals and the runs are
   * each read once and joined here; nothing below asks the database per card.
   * This is the screen a mission opens on and it refreshes on every task
   * event, so a query per card would be paid over and over.
   *
   * Who a card is for comes from `@tandemise/api-contract/for-me`, the rule
   * the Inbox uses, so a card in "Needs you" is always also in "For me".
   */
  missionFeed(id: MissionId, caller: Caller, options: { doneLimit?: number } = {}): MissionFeedView {
    const mission = this.#requireMission(id);
    const doneLimit = options.doneLimit ?? DEFAULT_FEED_DONE_LIMIT;

    const team = new Map(this.deps.members.listByWorkspace(mission.workspaceId, { includeRemoved: true }).map((m) => [m.id as string, m]));
    // Removed seats stay in `team` so old work is still named, but a removed seat is nobody's "me".
    const meId = [...team.values()].find((m) => m.kind === 'person' && m.personId === caller.personId && m.status === 'active')?.id ?? null;
    const tasks = this.deps.tasks.listByMission(id);
    const taskById = new Map(tasks.map((t) => [t.id as string, t]));
    const roles = new Map(this.deps.roles.list(mission.workspaceId).map((r) => [r.id, r]));
    const runsByTask = groupBy(this.deps.runs.listByMission(id), (r: Run) => r.taskId);
    const artifacts = this.deps.artifacts.listByMission(id);
    const lines = versionLines(artifacts);
    // Newest first, as the repository returns them.
    const live = artifacts.filter((a) => lines.get(a.id)?.supersededBy === null);
    const liveByTask = groupBy(live.filter((a) => a.taskId !== null), (a) => a.taskId as string);
    const allByTask = groupBy(artifacts.filter((a) => a.taskId !== null), (a) => a.taskId as string);
    const artifactById = new Map(artifacts.map((a) => [a.id as string, a]));
    // Every status, read once: the plan card is labelled from its decided approval, and the task cards need only the pending ones.
    const missionApprovals = this.deps.approvals.list({ missionId: id });
    const pending = missionApprovals.filter((a) => a.status === 'PENDING');
    const pendingByTask = groupBy(pending.filter((a) => a.taskId !== null), (a) => a.taskId as string);
    // One read for every card's notes, like everything else here.
    const notes = this.deps.feedback.listByMission(id);
    const notesByTask = groupBy(notes, (i: FeedbackItem) => i.taskId);

    const named = {
      members: { get: (memberId: string) => team.get(memberId) },
      missions: { get: (missionId: MissionId) => (missionId === mission.id ? mission : undefined) },
      tasks: { get: (taskId: TaskId) => taskById.get(taskId) },
      roles: { get: (roleId: string) => roles.get(roleId) },
      runs: { listByTask: (taskId: TaskId) => runsByTask.get(taskId) ?? [] },
      // Already loaded for the cards, so a pending approval's headline costs no query.
      artifacts: { get: (artifactId: string) => artifactById.get(artifactId), listByMission: () => artifacts },
    };
    // Addressed to me, checks included: spec §4.1 puts a check for me under "Needs you", the Inbox's own "for me".
    const forMe = (a: Approval): boolean => isApprovalForMember(a.addressees ?? [], meId);

    const needsYou: FeedCard[] = [];
    const inProgress: FeedCard[] = [];
    // `oldest` pins a card to the end of done regardless of its timestamp.
    const done: { card: FeedCard; finishedAt: string; oldest: boolean }[] = [];

    for (const task of tasks) {
      // Planned but not started: the feed is what has happened, and the Plan tab shows what will.
      if (task.status === 'PENDING') continue;
      // READY is not always fresh. A retry after gate feedback or a recovery
      // requeue has started before, and a task deferred for a runtime carries
      // the scheduler's reason; both are work in flight a person should see.
      if (task.status === 'READY' && task.startedAt === null && task.statusReason === null) continue;
      // Skipped or cancelled before it ever ran: nothing happened worth a card.
      if ((task.status === 'SKIPPED' || task.status === 'CANCELLED') && task.startedAt === null) continue;

      const own = liveByTask.get(task.id) ?? [];
      // A later fix or revision task can supersede this task's output. The card
      // still shows what this task produced, marked as updated, rather than
      // going blank as if it had done nothing.
      const primary = primaryArtifact(own, task.expectedOutputs, allByTask.get(task.id) ?? []);
      const superseded = primary !== undefined && (lines.get(primary.id)?.supersededBy ?? null) !== null;
      const successorId = superseded ? lines.get(primary.id)?.supersededBy ?? null : null;
      const successorTaskId = successorId === null ? null : artifactById.get(successorId)?.taskId ?? null;
      const supersededByTaskKey = successorTaskId === null ? null : taskById.get(successorTaskId)?.key ?? null;
      const approvals = pendingByTask.get(task.id) ?? [];
      // A request that holds work up leads; a check for me shows only when nothing else is asked of me.
      const mine = approvals.find((a) => a.kind !== 'check' && forMe(a)) ?? approvals.find(forMe);
      const humanAction = task.status === 'AWAITING_HUMAN'
        ? humanActionForMember({
          assigneeId: task.assigneeId ?? null,
          claimableIds: task.staffing?.claimable ?? [],
          escalatedToIds: task.staffing?.escalatedTo ?? [],
        }, meId)
        : null;
      // `needs` describes a request; once nothing is being asked, it is stale and hidden.
      const asking = isTaskAsking(task, approvals);
      const section: FeedCard['section'] = mine !== undefined || humanAction !== null
        ? 'needs_you'
        : FEED_DONE_STATUSES.includes(task.status) ? 'done' : 'in_progress';
      const doneBy = this.#runtimeNamed(actorRef(named, primary?.authorId ?? task.assigneeId), primary?.createdByRunId ?? null, runsByTask.get(task.id) ?? []);

      const card: FeedCard = {
        taskId: task.id,
        key: task.key,
        title: task.title,
        // A role that no longer resolves has no name worth showing; a raw id is not one.
        roleName: roles.get(task.roleId)?.name ?? null,
        status: task.status,
        statusReason: task.statusReason,
        section,
        doneBy,
        responsible: actorRef(named, task.responsibleId ?? primary?.responsibleId),
        recordedBy: differentActor(actorRef(named, primary?.recordedBy), doneBy),
        artifactId: primary?.id ?? null,
        artifactTitle: primary?.title ?? null,
        handoff: currentHandoff(primary, asking),
        // A superseded primary is not among the live ones, so every live artifact is "more".
        moreArtifacts: own.filter((a) => a.id !== primary?.id).length,
        overBudget: primary?.overBudget ?? false,
        superseded,
        supersededByTaskKey,
        pendingApproval: section === 'needs_you' && mine !== undefined ? toApprovalView(named, mine) : null,
        humanAction,
        planDecision: null,
        updatedAt: task.updatedAt,
        round: task.round ?? 1,
        // A round that has started but not run yet still carries its notes: "2 notes for round 2",
        // rather than a count that missed the one the round started with.
        openFeedback: (notesByTask.get(task.id) ?? [])
          .filter((i) => PENDING_FEEDBACK_STATUSES.includes(i.status) || (i.status === 'in_round' && ROUND_NOT_RUN.includes(task.status)))
          .map((i) => toFeedbackView(named, i)),
        // Only this task's notes, as the reader resolves them: a change answers the notes on its own task.
        changed: resolveChanges(named, primary?.handoff, new Map((notesByTask.get(task.id) ?? []).map((i) => [i.id as string, i]))),
        // A wait step reads nothing, a task with nothing done has nothing to change yet, and a cancelled mission takes no more rounds.
        canRequestChanges: task.executor !== 'wait' && task.executor !== 'ship' && (task.startedAt !== null || primary !== undefined) && missionTakesRounds(mission),
      };
      if (section === 'needs_you') needsYou.push(card);
      else if (section === 'in_progress') inProgress.push(card);
      else done.push({ card, finishedAt: task.finishedAt ?? task.updatedAt, oldest: false });
    }

    // The plan gates everything after it, so an open plan approval for me leads
    // "Needs you"; once decided it is the oldest thing that happened and closes "Done".
    const planArtifact = live.find((a) => a.type === 'MissionPlan');
    const planAsking = isPlanAsking(mission, pending);
    // The rule the Feed tab's count uses too, so the tab and this section never disagree.
    const standing = planStanding({
      missionStatus: mission.status,
      planCreatedAt: planArtifact?.createdAt ?? null,
      approvals: missionApprovals.map((a) => ({ id: a.id, kind: a.kind, status: a.status, createdAt: a.createdAt, addresseeIds: a.addressees ?? [] })),
      tasks,
    }, meId);
    const planDecision = standing.decision;
    const planApproval = standing.approvalId === undefined ? undefined : missionApprovals.find((a) => a.id === standing.approvalId);
    if (planArtifact !== undefined || planApproval !== undefined) {
      // Only a request the mission is still asking gets Approve on the card: a
      // PENDING row a re-plan or a crash left behind would approve a plan that no longer stands.
      const askingMe = planDecision === 'pending' && standing.forMe;
      // A rejection that still stops the mission waits for a re-plan, on the person who was asked.
      const rejectedOpen = planDecision === 'rejected' && standing.open;
      // The planner has no run to name a runtime from (KNOWN_LIMITATIONS).
      const planAuthor = actorRef(named, planArtifact?.authorId);
      const doneBy = planAuthor?.id === RUNTIME_ACTOR ? { ...planAuthor, name: 'Planner' } : planAuthor;
      const plan: FeedCard = {
        taskId: null,
        key: 'plan',
        title: planArtifact?.title ?? `Plan for ${mission.title}`,
        roleName: null,
        status: 'PLAN',
        // The open request itself while it is asked; after a rejection, the mission's line, which says why and what to do next.
        statusReason: planDecision === 'pending' ? planApproval?.title ?? null
          : rejectedOpen ? mission.statusReason : null,
        // Open for someone else: the plan is waiting on them, which is work in flight, not history.
        section: standing.forMe ? 'needs_you' : standing.open ? 'in_progress' : 'done',
        doneBy,
        responsible: actorRef(named, planArtifact?.responsibleId),
        recordedBy: differentActor(actorRef(named, planArtifact?.recordedBy), doneBy),
        artifactId: planArtifact?.id ?? null,
        artifactTitle: planArtifact?.title ?? null,
        handoff: currentHandoff(planArtifact, planAsking),
        moreArtifacts: 0,
        overBudget: planArtifact?.overBudget ?? false,
        superseded: false,
        supersededByTaskKey: null,
        pendingApproval: askingMe && planApproval !== undefined ? toApprovalView(named, planApproval) : null,
        humanAction: null,
        planDecision,
        updatedAt: planArtifact?.createdAt ?? planApproval?.createdAt ?? mission.updatedAt,
        // The plan is answered through its approval and re-planning, not through rounds.
        round: 1,
        openFeedback: [],
        changed: [],
        canRequestChanges: false,
      };
      if (plan.section === 'needs_you') needsYou.unshift(plan);
      else if (plan.section === 'in_progress') inProgress.unshift(plan);
      // The plan came before every task, so it is the oldest done card and belongs last.
      else done.push({ card: plan, finishedAt: planArtifact?.createdAt ?? '', oldest: true });
    }

    // Longest waiting first: it has held things up the longest.
    needsYou.sort((a, b) => (a.key === 'plan' ? -1 : b.key === 'plan' ? 1 : a.updatedAt.localeCompare(b.updatedAt)));
    done.sort((a, b) => Number(a.oldest) - Number(b.oldest) || b.finishedAt.localeCompare(a.finishedAt));

    return {
      missionId: mission.id,
      needsYou,
      inProgress,
      done: done.slice(0, doneLimit).map((d) => d.card),
      doneTotal: done.length,
    };
  }

  async missionDetail(id: MissionId): Promise<MissionDetail> {
    const mission = this.#requireMission(id);
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    const tasks = this.deps.tasks.listByMission(id);

    return {
      mission,
      progress: this.deps.missions.progress(id),
      repository: mission.repositoryId === null
        ? null
        : this.deps.repositories.get(mission.repositoryId) ?? null,
      tasks: this.#taskViews(mission, tasks),
      artifacts: this.deps.artifacts.listByMission(id).map((a) => toArtifactView(this.deps, a)),
      approvals: this.deps.approvals.list({ missionId: id }),
      decisions: this.deps.decisions.listByMission(id),
      targets: this.deps.targets.listByMission(id),
      checks: tasks.flatMap((t) => this.deps.evaluations.listChecks(t.id)),
      evaluations: tasks.flatMap((t) => this.deps.evaluations.listEvaluations(t.id)),
      metrics: this.deps.metrics.compute(mission, workspace),
      limits: this.deps.limits?.missionView(mission) ?? NO_LIMITS,
      plan: tasks.length === 0
        ? null
        : { summary: this.#planSummary(mission, tasks), tasks: asPlannedTasks(tasks) },
      planIssues: this.#planIssues(mission, tasks),
      uploads: this.#uploads(id),
      claim: this.deps.coordination?.missionClaim(id) ?? null,
    };
  }

  /**
   * Work no agent member staffs is authored by the runtime actor, which read
   * "by Runtime" on every card of a fresh install. The run says which runtime
   * it was, so the card can say "by Claude Code".
   */
  #runtimeNamed(ref: ActorRef | null, runId: string | null, runs: readonly Run[]): ActorRef | null {
    if (ref?.id !== RUNTIME_ACTOR) return ref;
    const run = (runId === null ? undefined : runs.find((r) => r.id === runId))
      ?? [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const profile = run === undefined ? undefined : this.deps.runtimeProfiles.get(asId<'RuntimeProfileId'>(run.runtimeProfileId));
    return profile === undefined ? ref : { ...ref, name: profile.name };
  }

  /** The pinned uploads and what intake made of each, if anything yet (spec A7). */
  #uploads(id: MissionId): NonNullable<MissionDetail['uploads']> {
    const artifacts = this.deps.artifacts.listByMission(id);
    return missionUploads(artifacts).map((evidence) => ({
      evidenceId: evidence.id,
      filename: uploadFilename(evidence),
      mediaType: evidence.mediaType,
      refs: evidence.sourceRefs,
      intakeArtifactId: intakeArtifactFor(evidence, artifacts)?.id ?? null,
    }));
  }

  /**
   * The upload that stands in for a SKIPPED placeholder, computed on read
   * (ruling 3): its reason marks it as one, and the intake artifact of its
   * output type says which upload. Anything else is covered by nothing.
   */
  #coveredBy(task: MissionTask, intake: ReadonlyMap<string, { artifactId: string; filename: string }>): TaskView['coveredBy'] {
    if (!isCoveredPlaceholder(task)) return null;
    for (const type of task.expectedOutputs) {
      const found = intake.get(type);
      if (found !== undefined) return found;
    }
    return null;
  }

  async missionTasks(id: MissionId): Promise<readonly TaskView[]> {
    const mission = this.#requireMission(id);
    return this.#taskViews(mission, this.deps.tasks.listByMission(id));
  }

  taskView(id: TaskId): TaskView {
    const task = this.deps.tasks.get(id);
    if (task === undefined) throw TandemiseError.notFound('Task', id);
    const mission = this.#requireMission(task.missionId);
    // Levels depend on the whole graph, so the task is projected among its siblings.
    const view = this.#taskViews(mission, this.deps.tasks.listByMission(mission.id)).find((t) => t.id === id);
    if (view === undefined) throw TandemiseError.notFound('Task', id);
    return view;
  }

  missionEvents(
    id: MissionId,
    opts: { afterSequence?: number; limit?: number; semanticOnly?: boolean },
  ): readonly RunEventRecord[] {
    this.#requireMission(id);
    return this.deps.events.listByMission(id, opts);
  }

  targets(missionId?: string): readonly ExecutionTargetRecord[] {
    if (missionId !== undefined) {
      return this.deps.targets.listByMission(asId<'MissionId'>(missionId));
    }
    // Everything still holding disk or a process, across every mission - the
    // "machines" screen exists to answer "what is running right now?".
    return this.deps.targets.listByStatus(['PROVISIONING', 'READY', 'IN_USE']);
  }

  // ------------------------------------------------------------------ internals

  #taskViews(mission: Mission, tasks: readonly MissionTask[]): readonly TaskView[] {
    const levels = planLevels(asPlannedTasks(tasks));
    const targets = this.deps.targets.listByMission(mission.id);
    // Loaded once for every PENDING task's would-be staffing, not once per task.
    const pending = tasks.find((t) => t.status === 'PENDING');
    const context = pending === undefined ? undefined : this.#staffingContext(pending);
    const notesByTask = groupBy(this.deps.feedback.listByMission(mission.id), (i: FeedbackItem) => i.taskId);
    // What intake made, by type, read only when a placeholder can use it.
    const intakeByType = new Map<string, { artifactId: string; filename: string }>();
    if (tasks.some((t) => t.status === 'SKIPPED')) {
      const artifacts = this.deps.artifacts.listByMission(mission.id);
      for (const evidence of missionUploads(artifacts)) {
        const intake = intakeArtifactFor(evidence, artifacts);
        if (intake !== undefined && !intakeByType.has(intake.type)) {
          intakeByType.set(intake.type, { artifactId: intake.id, filename: uploadFilename(evidence) });
        }
      }
    }
    // Why each flagged task stands out, read from its latest flag; the log is scanned only when something is flagged.
    const flags = new Map<string, TaskView['attention']>();
    if (tasks.some((t) => t.needsAttention === true)) {
      for (const event of this.deps.events.listByMission(mission.id, { semanticOnly: true })) {
        if (event.body.type !== 'task.attention') continue;
        flags.set(event.body.taskId, event.body.kind === 'stale_input'
          ? { kind: 'stale_input', upstream: event.body.upstream ?? null, note: event.body.note }
          : { kind: 'changes_requested', upstream: null, note: event.body.note });
      }
    }

    // What each person's step was handed, read once and only when the mission has one.
    const missionArtifacts = tasks.some((t) => t.executor === 'human') ? this.deps.artifacts.listByMission(mission.id) : [];

    // A parked step is told from a wait step by its park event, so the log is
    // read only when some agent step is AWAITING_EXTERNAL.
    const parkLog = tasks.some((t) => t.status === 'AWAITING_EXTERNAL' && t.executor === 'agent')
      ? this.deps.events.listByMission(mission.id, { semanticOnly: true })
      : [];

    return tasks.map((task): TaskView => {
      const runs = [...this.deps.runs.listByTask(task.id)]
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const latestRun = runs[0] ?? null;
      const profile = latestRun === null
        ? undefined
        : this.deps.runtimeProfiles.get(asId<'RuntimeProfileId'>(latestRun.runtimeProfileId));
      const target = targets.find((t) => t.taskId === task.id);

      return {
        ...task,
        roleName: this.deps.roles.get(task.roleId, mission.workspaceId)?.name ?? task.roleId,
        level: levels.get(task.key) ?? 0,
        latestRun,
        runCount: runs.length,
        outputArtifacts: this.deps.artifacts.listByTask(task.id).map((a) => toArtifactView(this.deps, a)),
        inputs: task.executor === 'human' ? handedTo(task, tasks, missionArtifacts).map((a) => toArtifactView(this.deps, a)) : [],
        // The newest measurement per check, not one row per attempt: a task
        // that retried 14 times produced 56 results describing 4 checks, and
        // the card rendered all of them - including a FAIL from two days and
        // thirteen passing runs ago. The full history stays on the Checks tab.
        checks: this.deps.evaluations.latestChecksForTask(task.id),
        // Evaluated live rather than stored: a gate is a view of the evidence as
        // it stands now, and a re-run check has to move the badge.
        // Only once the task has been judged: on a task that has not run, every
        // gate reads "Not met", and a plan full of red "Not met" badges looks
        // like a stuck mission when nothing has even started.
        gate: task.attempts > 0 && task.status !== 'RUNNING' ? this.deps.gates.evaluate(task) : null,
        pendingApprovalId: pendingCardFor(this.deps.approvals.pendingForTask(task.id)),
        runtimeName: profile?.name ?? latestRun?.runtimeProfileId ?? null,
        targetName: target?.name ?? null,
        repositoryName: task.repositoryId === null || task.repositoryId === mission.repositoryId
          ? null
          : this.deps.repositories.get(task.repositoryId)?.name ?? null,
        assignee: actorRef(this.deps, task.assigneeId),
        responsible: actorRef(this.deps, task.responsibleId),
        claimable: actorRefs(this.deps, task.staffing?.claimable),
        escalatedTo: actorRefs(this.deps, task.staffing?.escalatedTo),
        wouldBe: this.#wouldBe(task, context),
        round: task.round ?? 1,
        feedback: (notesByTask.get(task.id) ?? []).map((i) => toFeedbackView(this.deps, i)),
        attention: task.needsAttention === true ? flags.get(task.id) ?? { kind: 'changes_requested', upstream: null, note: '' } : null,
        watch: this.deps.liveness?.watchOf(task, latestRun) ?? null,
        coveredBy: this.#coveredBy(task, intakeByType),
        parkedExternal: parkedView(parkedExternalOf(task, parkLog)),
        now: this.#now(task, latestRun, target?.workingDirectory ?? null),
        ...(this.deps.holds?.standing(task, mission) ?? NO_HOLDS),
      };
    });
  }

  /** One indexed read per live agent step; every other step has no "Now". */
  #now(task: MissionTask, run: Run | null, workingDirectory: string | null): string | null {
    if (task.executor !== 'agent' || task.status !== 'RUNNING' || run === null || !LIVE_RUN_STATUSES.includes(run.status)) return null;
    const latest = this.deps.events.latestByRun(run.id, NOW_EVENT_TYPES);
    return nowLine(latest === undefined ? null : latest.body as AgentEvent, workingDirectory);
  }

  /**
   * The resolution a PENDING task would get now, so the plan can say who is
   * lined up before anything is decided. Any failure to resolve (a workspace
   * that lost its owner) is shown as nothing rather than breaking the mission view.
   */
  #wouldBe(task: MissionTask, context: StaffingContext | null | undefined): TaskView['wouldBe'] {
    if (task.status !== 'PENDING' || context === null) return null;
    try {
      const resolved = this.deps.staffing.resolve(task, context);
      const responsible = actorRef(this.deps, resolved.responsibleId);
      if (responsible === null) return null;
      return {
        assignee: actorRef(this.deps, resolved.assigneeId ?? resolved.agentCandidates[0]?.id ?? null),
        responsible,
        claimable: actorRefs(this.deps, resolved.claimable),
        executor: resolved.executor,
      };
    } catch {
      return null;
    }
  }

  #staffingContext(task: MissionTask): StaffingContext | null {
    try {
      return this.deps.staffing.context(task);
    } catch {
      return null;
    }
  }

  #summary(mission: Mission): MissionSummary {
    const tasks = this.deps.tasks.listByMission(mission.id);
    const running = tasks.find((t) => t.status === 'RUNNING');
    const waiting = tasks.find((t) => t.status === 'AWAITING_APPROVAL');
    const blocked = tasks.find((t) => t.status === 'BLOCKED');
    const latest = this.deps.events.listByMission(mission.id, { limit: 1, semanticOnly: true });

    return {
      mission,
      progress: this.deps.missions.progress(mission.id),
      repositoryName: mission.repositoryId === null
        ? null
        : this.deps.repositories.get(mission.repositoryId)?.name ?? null,
      currentActivity: running?.title
        ?? (waiting === undefined ? null : `Waiting for approval: ${waiting.title}`)
        ?? (blocked === undefined ? null : `Blocked: ${blocked.title}`)
        ?? mission.statusReason,
      lastEventAt: latest[latest.length - 1]?.createdAt ?? null,
      criteria: mission.status === 'DRAFT' ? null : criteriaSummary(this.deps.gates.trace(mission.id).trace),
    };
  }

  async #runtimeViews(workspaceId: WorkspaceId | undefined): Promise<readonly RuntimeView[]> {
    try {
      return await this.deps.runtimes.list(workspaceId);
    } catch {
      // Health probes spawn processes. The home screen must render even when
      // one of them is broken - the runtimes panel is not worth a failed page.
      return [];
    }
  }

  #recentEvents(missions: readonly Mission[]): readonly RunEventRecord[] {
    const events = missions.flatMap((m) =>
      this.deps.events.listByMission(m.id, { limit: HOME_EVENT_LIMIT, semanticOnly: true }));
    return events
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-HOME_EVENT_LIMIT);
  }

  /** The planner's own words when they were stored, otherwise the shape. */
  #planSummary(mission: Mission, tasks: readonly MissionTask[]): string {
    const artifact = this.deps.artifacts.latest(mission.id, 'MissionPlan');
    return artifact?.summary ?? `${tasks.length} tasks.`;
  }

  /**
   * Re-validated on read, not remembered from planning time.
   *
   * A running mission's graph is mutated - remediation splices tasks in, the
   * integration service adds a conflict task - so the only honest answer to "is
   * this plan still coherent?" is to ask the validator about the graph that
   * exists now.
   */
  #planIssues(mission: Mission, tasks: readonly MissionTask[]): readonly PlanValidationIssue[] {
    if (tasks.length === 0) return [];
    // An intake artifact is on the mission before any task runs, and a dependent
    // reads it through the latest-of-type fallback: for "is this input
    // available", it is a producer (spec A2).
    const artifacts = this.deps.artifacts.listByMission(mission.id);
    const preexisting = missionUploads(artifacts).flatMap((evidence) => {
      const intake = intakeArtifactFor(evidence, artifacts);
      return intake === undefined ? [] : [{ id: intake.id, type: intake.type }];
    });
    const validated = validateTaskGraph(tasks, this.deps.roles.list(mission.workspaceId), preexisting);
    return validated.ok ? [] : validated.error;
  }

  #requireMission(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }
}

/** The view's shape of a parked step: who parked it stays in the log. */
function parkedView(park: { readonly tool: string; readonly since: string } | null): TaskView['parkedExternal'] {
  return park === null ? null : { tool: park.tool, since: park.since };
}

/** The card a task is waiting on: a check waits on nobody, so any other pending card comes first. */
function pendingCardFor(cards: readonly { readonly id: string; readonly kind: string }[]): string | null {
  return (cards.find((c) => c.kind !== 'check') ?? cards[0])?.id ?? null;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) groups.set(k, [item]);
    else group.push(item);
  }
  return groups;
}

/** A second name on a card only when it is a different actor. */
function differentActor(actor: ActorRef | null, than: ActorRef | null): ActorRef | null {
  return actor === null || actor.id === than?.id ? null : actor;
}
