import type {
  ApprovalId, ArtifactId, CriterionId, EventId, QuestionId, FeedbackId, MemberId, MissionId, PersonId, RepositoryId, RunId, RuntimeProfileId,
  ExecutionTargetId, EvalCaseId, EvalRunId, EvalSuiteId, EvalTrialId, IntegrationId, IssueLinkId, RoutineId, SkillId, TaskHoldId, TaskId, Timestamp, WorkerAssignmentId, WorkspaceId,
} from '@tandemise/shared';
import type { Mission, MissionDraft, MissionProgress, MissionStatus } from '../entities/mission.js';
import type { PlanDecision } from '../planner/decision.js';
import type { MergeDecisionPatch, MergeDecisionRecord } from '../merge/types.js';
import type { OutcomeEvent } from '../brain/outcomes.js';
import type {
  IssueComment, IssueCommentKind, IssueLink, IssueLinkDraft, IssueLinkPatch, IssueSyncPatch, IssueSyncSettings,
} from '../entities/issue.js';
import type { MissionTask, TaskStatus } from '../entities/task.js';
import type { Run, RunStatus, RunUsage, Checkpoint } from '../entities/run.js';
import type { ArtifactManifest, ArtifactType } from '../entities/artifact.js';
import type { Approval, ApprovalStatus } from '../entities/approval.js';
import type { Repository, Workspace } from '../entities/workspace.js';
import type { Member, Person } from '../entities/member.js';
import type { RoleTemplate } from '../entities/role.js';
import type { RuntimeProfile } from '../entities/runtime.js';
import type { ExecutionTargetRecord, ResourceLease, TargetStatus } from '../entities/target.js';
import type { Integration } from '../entities/integration.js';
import type { WorkerAssignment } from '../entities/assignment.js';
import type { RunEventRecord, TandemiseEventBody } from '../event.js';
import type { BrainPass, BrainProposal, WorkspaceBrain } from '../entities/brain.js';
import type { Decision } from '../entities/decision.js';
import type { CheckResult, Evaluation } from '../entities/evaluation.js';
import type { FeedbackItem, FeedbackStatus } from '../entities/feedback.js';
import type { MissionCriterion, SpecCriterionInput } from '../entities/criteria.js';
import type { MissionQuestion, QuestionInput } from '../entities/refinement.js';
import type { LimitIncident, LimitIncidentStatus, LimitMetric, LimitThreshold, UsageTotals } from '../entities/limits.js';
import type { Routine, RoutineDraft, RoutineRun } from '../entities/routine.js';
import type { TaskHold } from '../entities/hold.js';
import type { Skill, SkillVersion } from '../entities/skill.js';
import type {
  EvalCase, EvalCaseCriterion, EvalRun, EvalSuite, EvalTrial, RunScore,
} from '../entities/eval.js';

/**
 * Persistence ports.
 *
 * These are the only database-shaped contracts the application layer knows
 * about. The SQLite implementation lives outward in `@tandemise/persistence`
 * and is bound by the composition root, which is what keeps the mission engine
 * testable against an in-memory double and free of SQL (MVP.md §6.1).
 */

export interface WorkspaceRepositoryPort {
  /** The work-in-progress limit starts off unless given. */
  create(workspace: Omit<Workspace, 'createdAt' | 'updatedAt' | 'maxActiveMissions' | 'defaultMissionLimits' | 'monthlyLimits'>
    & { maxActiveMissions?: number | null; defaultMissionLimits?: Workspace['defaultMissionLimits']; monthlyLimits?: Workspace['monthlyLimits'] }): Workspace;
  get(id: WorkspaceId): Workspace | undefined;
  list(): readonly Workspace[];
  update(id: WorkspaceId, patch: Partial<Omit<Workspace, 'id' | 'createdAt'>>): Workspace;
}

/** People are global to the installation; removal is a timestamp so history keeps its names. */
export interface PersonRepositoryPort {
  create(p: Omit<Person, 'createdAt' | 'removedAt'>): Person;
  get(id: PersonId): Person | undefined;
  list(options?: { includeRemoved?: boolean }): readonly Person[];
  update(id: PersonId, patch: Partial<Pick<Person, 'displayName' | 'handles' | 'accountId' | 'removedAt'>>): Person;
}

export interface MemberRepositoryPort {
  create(m: Omit<Member, 'createdAt' | 'updatedAt'>): Member;
  get(id: MemberId): Member | undefined;
  listByWorkspace(workspaceId: WorkspaceId, options?: { includeRemoved?: boolean }): readonly Member[];
  findPersonMember(workspaceId: WorkspaceId, personId: PersonId): Member | undefined;
  update(id: MemberId, patch: Partial<Omit<Member, 'id' | 'workspaceId' | 'kind' | 'createdAt'>>): Member;
}

export interface RepoRepositoryPort {
  create(repo: Omit<Repository, 'createdAt' | 'updatedAt'>): Repository;
  get(id: RepositoryId): Repository | undefined;
  listByWorkspace(workspaceId: WorkspaceId): readonly Repository[];
  update(id: RepositoryId, patch: Partial<Omit<Repository, 'id' | 'workspaceId' | 'createdAt'>>): Repository;
  remove(id: RepositoryId): void;
}

export interface MissionRepositoryPort {
  create(draft: MissionDraft & { id: MissionId }): Mission;
  get(id: MissionId): Mission | undefined;
  list(filter?: { workspaceId?: WorkspaceId; statuses?: readonly MissionStatus[]; limit?: number }): readonly Mission[];
  update(id: MissionId, patch: Partial<Omit<Mission, 'id' | 'workspaceId' | 'createdAt'>>): Mission;
  progress(id: MissionId): MissionProgress;
  remove(id: MissionId): void;
}

export interface TaskRepositoryPort {
  replaceAll(missionId: MissionId, tasks: readonly MissionTask[]): readonly MissionTask[];
  add(task: MissionTask): MissionTask;
  get(id: TaskId): MissionTask | undefined;
  getByKey(missionId: MissionId, key: string): MissionTask | undefined;
  listByMission(missionId: MissionId): readonly MissionTask[];
  update(id: TaskId, patch: Partial<Omit<MissionTask, 'id' | 'missionId' | 'createdAt'>>): MissionTask;
  /** Tasks in the given statuses across all missions - used by the scheduler. */
  listByStatus(statuses: readonly TaskStatus[]): readonly MissionTask[];
}

export interface RunRepositoryPort {
  create(run: Run): Run;
  get(id: RunId): Run | undefined;
  listByTask(taskId: TaskId): readonly Run[];
  listByMission(missionId: MissionId): readonly Run[];
  listByStatus(statuses: readonly RunStatus[]): readonly Run[];
  update(id: RunId, patch: Partial<Omit<Run, 'id' | 'taskId' | 'startedAt'>>): Run;
  recordUsage(id: RunId, usage: RunUsage): void;
  heartbeat(id: RunId, at: Timestamp): void;
  /** Stamps `last_event_at` for an agent event and ends any "keep waiting" (P9). */
  markActivity(id: RunId, at: Timestamp): void;
  /** Hides a quiet run's Inbox row until `until` (P9). */
  snooze(id: RunId, until: Timestamp): void;
}

export interface EventRepositoryPort {
  /** Returns the persisted record, including its assigned monotonic sequence. */
  append(input: {
    id: EventId;
    workspaceId: WorkspaceId;
    missionId: MissionId;
    taskId?: TaskId | null;
    runId?: RunId | null;
    roleId?: string | null;
    runtimeProfileId?: string | null;
    body: TandemiseEventBody;
    createdAt: Timestamp;
    actorId?: string | null;
  }): RunEventRecord;
  listByMission(missionId: MissionId, opts?: { afterSequence?: number; limit?: number; semanticOnly?: boolean }): readonly RunEventRecord[];
  listByRun(runId: RunId, opts?: { afterSequence?: number; limit?: number }): readonly RunEventRecord[];
  /** The run's newest event of one of these types; what a live step's "Now" line is read from. */
  latestByRun(runId: RunId, types: readonly string[]): RunEventRecord | undefined;
  latestSequence(missionId: MissionId): number;
}

export interface ArtifactRepositoryPort {
  create(manifest: ArtifactManifest): ArtifactManifest;
  get(id: ArtifactId): ArtifactManifest | undefined;
  listByMission(missionId: MissionId, type?: ArtifactType): readonly ArtifactManifest[];
  listByTask(taskId: TaskId): readonly ArtifactManifest[];
  /** Most recent non-superseded artifact of a type on a mission. */
  latest(missionId: MissionId, type: ArtifactType): ArtifactManifest | undefined;
  /** Current versions only unless `includeSuperseded`: a search that returns every revision buries the live one. */
  search(workspaceId: WorkspaceId, query: string, limit?: number, options?: { includeSuperseded?: boolean }): readonly ArtifactManifest[];
  /** The workspace's artifacts, newest first; superseded versions are left out unless `includeSuperseded`. */
  listRecent(workspaceId: WorkspaceId, limit: number, options?: { includeSuperseded?: boolean }): readonly ArtifactManifest[];
  markSuperseded(id: ArtifactId, by: ArtifactId): void;
  /**
   * Sets aside the output of a pass that was overtaken before it was judged:
   * every list above leaves it out from now on (`get` still returns it), and
   * the versions it had replaced are live again.
   */
  withdraw(ids: readonly ArtifactId[], at: Timestamp): void;
}

export interface ApprovalRepositoryPort {
  create(approval: Approval): Approval;
  get(id: ApprovalId): Approval | undefined;
  list(filter?: { workspaceId?: WorkspaceId; missionId?: MissionId; statuses?: readonly ApprovalStatus[] }): readonly Approval[];
  update(id: ApprovalId, patch: Partial<Omit<Approval, 'id' | 'createdAt'>>): Approval;
  pendingForTask(taskId: TaskId): readonly Approval[];
  /** PENDING approvals whose `escalateAt` is at or before `at`: the escalation sweep's whole read. */
  dueForEscalation(at: Timestamp): readonly Approval[];
}

export interface RoleRepositoryPort {
  upsert(role: RoleTemplate): RoleTemplate;
  get(id: string, workspaceId: WorkspaceId | null): RoleTemplate | undefined;
  list(workspaceId: WorkspaceId | null): readonly RoleTemplate[];
  remove(id: string, workspaceId: WorkspaceId): void;
}

export interface RuntimeProfileRepositoryPort {
  create(profile: RuntimeProfile): RuntimeProfile;
  get(id: RuntimeProfileId): RuntimeProfile | undefined;
  list(workspaceId?: WorkspaceId | null): readonly RuntimeProfile[];
  update(id: RuntimeProfileId, patch: Partial<Omit<RuntimeProfile, 'id' | 'createdAt'>>): RuntimeProfile;
  remove(id: RuntimeProfileId): void;
}

export interface ExecutionTargetRepositoryPort {
  create(target: ExecutionTargetRecord): ExecutionTargetRecord;
  get(id: ExecutionTargetId): ExecutionTargetRecord | undefined;
  listByMission(missionId: MissionId): readonly ExecutionTargetRecord[];
  listByStatus(statuses: readonly TargetStatus[]): readonly ExecutionTargetRecord[];
  update(id: ExecutionTargetId, patch: Partial<Omit<ExecutionTargetRecord, 'id' | 'createdAt'>>): ExecutionTargetRecord;
}

export interface IntegrationRepositoryPort {
  create(integration: Integration): Integration;
  get(id: IntegrationId): Integration | undefined;
  listByWorkspace(workspaceId: WorkspaceId): readonly Integration[];
  update(id: IntegrationId, patch: Partial<Omit<Integration, 'id' | 'createdAt'>>): Integration;
  remove(id: IntegrationId): void;
}

export interface AssignmentRepositoryPort {
  create(assignment: WorkerAssignment): WorkerAssignment;
  get(id: WorkerAssignmentId): WorkerAssignment | undefined;
  listByTask(taskId: TaskId): readonly WorkerAssignment[];
}

export interface DecisionRepositoryPort {
  create(decision: Decision): Decision;
  get(id: string): Decision | undefined;
  listByMission(missionId: MissionId): readonly Decision[];
  listByWorkspace(workspaceId: WorkspaceId): readonly Decision[];
  update(id: string, patch: Partial<Decision>): Decision;
}

export interface EvaluationRepositoryPort {
  createEvaluation(evaluation: Evaluation): Evaluation;
  listEvaluations(taskId: TaskId): readonly Evaluation[];
  recordCheck(check: CheckResult): CheckResult;
  listChecks(taskId: TaskId): readonly CheckResult[];
  /** One row per check name - the newest measurement. What a person is shown. */
  latestChecksForTask(taskId: TaskId): readonly CheckResult[];
  latestChecks(missionId: MissionId): readonly CheckResult[];
  /**
   * The newest finished measurement (PASS or FAIL) of this command on this git
   * tree, by any task (#106). A tree is content-addressed: the same tree is the
   * same code, so its test result holds for every step that measures it.
   */
  reusableCheck(treeSha: string, name: string, command: string): CheckResult | undefined;
}

export interface CheckpointRepositoryPort {
  append(checkpoint: Checkpoint): Checkpoint;
  latest(runId: RunId): Checkpoint | undefined;
  list(runId: RunId): readonly Checkpoint[];
}

/**
 * Exclusive resource claims. `acquire` returns undefined rather than throwing
 * when the resource is held - contention is an ordinary scheduling outcome, not
 * an error.
 */
export interface LeaseRepositoryPort {
  acquire(resourceKey: string, holder: { runId?: RunId | null; taskId?: TaskId | null }, ttlMs: number): ResourceLease | undefined;
  renew(id: string, ttlMs: number): boolean;
  release(id: string): void;
  releaseByRun(runId: RunId): void;
  listExpired(now: Timestamp): readonly ResourceLease[];
  listAll(): readonly ResourceLease[];
}

export interface FeedbackRepositoryPort {
  create(item: FeedbackItem): FeedbackItem;
  get(id: FeedbackId): FeedbackItem | undefined;
  /** Oldest first. */
  listByTask(taskId: TaskId): readonly FeedbackItem[];
  /** Oldest first, through mission_tasks: one read for a whole feed. */
  listByMission(missionId: MissionId): readonly FeedbackItem[];
  listByStatus(statuses: readonly FeedbackStatus[]): readonly FeedbackItem[];
  /** Stamps `updatedAt`. */
  update(id: FeedbackId, patch: Partial<Pick<FeedbackItem, 'status' | 'round'>>): FeedbackItem;
}

/**
 * What a run actually saw, from the context compiler's `includedArtifactIds`.
 * Downstream impact is read from this rather than guessed from the plan
 * (spec §3); runs from before migration 010 have no rows here.
 */
/**
 * A replan waiting on its plan card (replan spec). Nothing on the mission
 * changes until the card is approved: the new steps live here, and a reject
 * only has to drop the row.
 */
export interface PlanProposal {
  readonly approvalId: ApprovalId;
  readonly missionId: MissionId;
  /** The new steps, materialised, written beside the kept ones on approval. */
  readonly tasks: readonly MissionTask[];
  /** The unstarted steps the new ones replace. */
  readonly replaces: readonly TaskId[];
  /** Where the mission goes back to if the card is rejected. */
  readonly resumeStatus: MissionStatus;
  /** The plan-fit card that asked for this replan, reopened on a reject. */
  readonly planFitApprovalId: ApprovalId | null;
  readonly createdAt: Timestamp;
}

export interface PlanProposalRepositoryPort {
  put(proposal: PlanProposal): void;
  get(approvalId: ApprovalId): PlanProposal | undefined;
  delete(approvalId: ApprovalId): void;
}

/** A person's holds on agent steps (hold-and-interact spec); see migration 022. */
export interface TaskHoldRepositoryPort {
  create(hold: TaskHold): void;
  get(id: TaskHoldId): TaskHold | undefined;
  /** The task's hold that has not ended; at most one exists. */
  openFor(taskId: TaskId): TaskHold | undefined;
  /** An ended hold the agent's next run has not yet read: ending 'continued' and no `consumedAt`. */
  pendingContinuation(taskId: TaskId): TaskHold | undefined;
  update(id: TaskHoldId, patch: Partial<TaskHold>): void;
  listByMission(missionId: MissionId): TaskHold[];
}

export interface RunInputRepositoryPort {
  /** Idempotent: a run records what it was given once, and a restart may record it again. */
  record(runId: RunId, artifactIds: readonly ArtifactId[]): void;
  listByRun(runId: RunId): readonly ArtifactId[];
  listByMission(missionId: MissionId): readonly { readonly runId: RunId; readonly artifactId: ArtifactId }[];
}

/** A single transactional boundary across the repositories above. */
export interface UnitOfWork {
  transaction<T>(fn: () => T): T;
}

/**
 * The Done-when ledger (P5). Criteria only: results are derived from QA on
 * every read. Kept small and general because P6 layers proposal and verdict
 * status on the same rows.
 */
export interface MissionCriteriaRepositoryPort {
  /** Live criteria (not superseded): user first, then spec, each in written order. */
  listActive(missionId: MissionId): readonly MissionCriterion[];
  /** Every row, superseded included, oldest first. */
  listAll(missionId: MissionId): readonly MissionCriterion[];
  /** Appends accepted `U<n>` rows after any the mission already has; `addedBy` marks one a person added later. */
  addUserCriteria(missionId: MissionId, statements: readonly string[], addedBy?: string): readonly MissionCriterion[];
  /**
   * Supersedes every live spec criterion of the mission and records these in
   * one transaction, so no reader ever sees two specs' criteria at once.
   */
  replaceSpecCriteria(missionId: MissionId, specArtifactId: ArtifactId, criteria: readonly SpecCriterionInput[]): readonly MissionCriterion[];
  get(id: CriterionId): MissionCriterion | undefined;
  /** The person's criteria in every status - the refinement view's rows - oldest first. */
  listUserRows(missionId: MissionId): readonly MissionCriterion[];
  /** Proposals still waiting for a verdict. */
  listProposed(missionId: MissionId): readonly MissionCriterion[];
  /**
   * Records a refinement's proposals as `P<n>` rows, numbered after every key
   * the mission ever had, and marks proposals still undecided `stale` - in one
   * transaction, so a reader never sees two passes' proposals as pending.
   */
  propose(missionId: MissionId, refinementArtifactId: ArtifactId, statements: readonly string[]): readonly MissionCriterion[];
  /** Accepts a proposal (it takes the next `U<n>` key, optionally reworded) or rejects it. */
  decide(id: CriterionId, verdict: 'accept' | 'reject', options: { readonly statement?: string; readonly decidedBy: string }): MissionCriterion;
  /**
   * Supersedes the live accepted criteria recorded by `decidedBy` and adds
   * these as the next `U<n>`, in one transaction (P14: an issue edited before
   * planning replaces only the lines that came from the issue).
   */
  replaceUserCriteriaBy(missionId: MissionId, decidedBy: string, statements: readonly string[]): readonly MissionCriterion[];
  /** Writes accepted rows verbatim (keys kept), for an eval trial's ledger. Only for a mission with no criteria. */
  seed(missionId: MissionId, rows: readonly EvalCaseCriterion[]): readonly MissionCriterion[];
}

/** Questions a refinement pass asked, and their answers (P6). */
export interface MissionQuestionRepositoryPort {
  get(id: QuestionId): MissionQuestion | undefined;
  /** Every question, oldest first. */
  listByMission(missionId: MissionId): readonly MissionQuestion[];
  /** Marks every open question `stale` and records these as `Q<n>`, numbered on, in one transaction. */
  replaceOpen(missionId: MissionId, refinementArtifactId: ArtifactId, questions: readonly QuestionInput[]): readonly MissionQuestion[];
  answer(id: QuestionId, text: string, answeredBy: string): MissionQuestion;
}

/**
 * Limit incidents and the usage they are measured from (P8).
 *
 * Usage is summed from `usage_records`, one row per finished run: agent time is
 * `wall_time_ms`, tokens are input plus output, cost is `cost_usd` where a
 * runtime reported one. A sum over nothing reported stays null.
 */
export interface LimitRepositoryPort {
  usageForMission(missionId: MissionId): UsageTotals;
  /** The project's usage between two instants (start inclusive, end exclusive). */
  usageForWorkspace(workspaceId: WorkspaceId, start: string, end: string): UsageTotals;
  /** Per mission, the same window: for the usage view. */
  usageByMission(workspaceId: WorkspaceId, start: string, end: string): readonly { missionId: MissionId; totals: UsageTotals }[];
  /** The same window, restricted to eval trial missions (P3b): what evals themselves have spent. */
  evalUsageForWorkspace(workspaceId: WorkspaceId, start: Timestamp, end: Timestamp): UsageTotals;
  /** The incident for this scope, metric, window, threshold and limit amount, whatever its status. */
  find(key: LimitIncidentKey): LimitIncident | undefined;
  get(id: LimitIncident['id']): LimitIncident | undefined;
  byApproval(approvalId: string): LimitIncident | undefined;
  create(incident: Omit<LimitIncident, 'id' | 'createdAt' | 'resolvedAt'>): LimitIncident;
  /**
   * Moves an incident from `from` to `to`; returns the updated row, or null when
   * it was not in `from` - which is what makes deciding twice resolve once.
   */
  transition(id: LimitIncident['id'], from: LimitIncidentStatus, to: LimitIncidentStatus, patch?: Partial<Pick<LimitIncident, 'approvalId' | 'amountObserved' | 'pausedMissionIds'>>): LimitIncident | null;
  listOpen(workspaceId: WorkspaceId): readonly LimitIncident[];
  listByMission(missionId: MissionId): readonly LimitIncident[];
}

export interface LimitIncidentKey {
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly metric: LimitMetric;
  readonly windowStart: string;
  readonly threshold: LimitThreshold;
  readonly amountLimit: number;
}

/**
 * Routines and the note of every run (P11). `claim` is the one conditional
 * write that makes a slot fire once: it moves the next run forward only if it
 * still holds the value the caller read.
 */
export interface RoutineRepositoryPort {
  create(draft: RoutineDraft): Routine;
  get(id: RoutineId): Routine | undefined;
  list(workspaceId: WorkspaceId): readonly Routine[];
  /** Enabled routines whose next run is at or before `now`, oldest first. */
  listDue(now: Timestamp): readonly Routine[];
  update(id: RoutineId, patch: Partial<Omit<Routine, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>>): Routine;
  /** Moves `next_run_at` from `from` to `to`; false when another pass already did. */
  claim(id: RoutineId, from: Timestamp, to: Timestamp): boolean;
  remove(id: RoutineId): void;
  recordRun(run: Omit<RoutineRun, 'id'>): RoutineRun;
  /** Newest first. */
  recentRuns(id: RoutineId, limit: number): readonly RoutineRun[];
}

/**
 * The skills library (P13): a project's skills and their immutable versions.
 * Content lives in the content store, addressed by each version's hash.
 */
export interface SkillRepositoryPort {
  create(skill: Skill): Skill;
  get(id: SkillId): Skill | undefined;
  getByName(workspaceId: WorkspaceId, name: string): Skill | undefined;
  list(workspaceId: WorkspaceId): readonly Skill[];
  update(id: SkillId, patch: Partial<Pick<Skill, 'description' | 'source' | 'updatedAt'>>): Skill;
  /** Removes the skill and its versions. */
  remove(id: SkillId): void;
  addVersion(version: SkillVersion): SkillVersion;
  /** Oldest first. */
  versions(skillId: SkillId): readonly SkillVersion[];
  /** Whether any version, in any project, still names this content hash. */
  hashInUse(hash: string): boolean;
}

/**
 * GitHub issue sync (P14): per-repository settings, one link per issue read,
 * and the comments Tandemise wrote on each (by kind, with the body last written).
 */
export interface IssueRepositoryPort {
  settings(repositoryId: RepositoryId): IssueSyncSettings | undefined;
  saveSettings(repositoryId: RepositoryId, workspaceId: WorkspaceId, patch: IssueSyncPatch): IssueSyncSettings;
  listSettings(workspaceId: WorkspaceId): readonly IssueSyncSettings[];
  /** Every repository with issue sync on, in any project. */
  listEnabled(): readonly IssueSyncSettings[];
  getLink(id: IssueLinkId): IssueLink | undefined;
  findLink(repositoryId: RepositoryId, number: number): IssueLink | undefined;
  listLinks(filter: { readonly workspaceId?: WorkspaceId; readonly repositoryId?: RepositoryId }): readonly IssueLink[];
  /** Written before its mission (status `pending`); UNIQUE (repository, number) makes a second one fail. */
  createLink(draft: IssueLinkDraft): IssueLink;
  updateLink(id: IssueLinkId, patch: IssueLinkPatch): IssueLink;
  comments(linkId: IssueLinkId): readonly IssueComment[];
  saveComment(linkId: IssueLinkId, kind: IssueCommentKind, commentId: string, body: string): IssueComment;
  /** Forgets a stored comment (tests use it to simulate a crash between posting and storing). */
  dropComment(linkId: IssueLinkId, kind: IssueCommentKind): void;
}

/** One row of measured facts per assessed run (P3b spec Part B, §B1). A record: the engine never reads it. */
export interface RunScoreRepositoryPort {
  /** Idempotent on runId: a second insert for the same run is ignored. */
  insert(score: RunScore): void;
  list(workspaceId: WorkspaceId, since: Timestamp, opts?: { readonly includeTrials?: boolean }): readonly RunScore[];
  listByTask(taskId: TaskId): readonly RunScore[];
}

/** Eval suites, saved cases, and the runs and trials tried against them (P3b spec Part B, §B6). */
export interface EvalRepositoryPort {
  createSuite(suite: EvalSuite): EvalSuite;
  getSuite(id: EvalSuiteId): EvalSuite | undefined;
  listSuites(workspaceId: WorkspaceId): readonly (EvalSuite & { readonly cases: number })[];
  deleteSuite(id: EvalSuiteId): void;
  insertCase(c: EvalCase): EvalCase;
  getCase(id: EvalCaseId): EvalCase | undefined;
  listCases(suiteId: EvalSuiteId): readonly EvalCase[];
  deleteCase(id: EvalCaseId): void;
  insertRun(run: EvalRun): EvalRun;
  getRun(id: EvalRunId): EvalRun | undefined;
  updateRun(id: EvalRunId, patch: Partial<Pick<EvalRun, 'status' | 'reason' | 'scorecard' | 'startedAt' | 'finishedAt'>>): EvalRun;
  listRuns(suiteId: EvalSuiteId): readonly EvalRun[];
  /** Runs in `queued` or `running`, oldest first, across workspaces. */
  activeRuns(): readonly EvalRun[];
  insertTrials(trials: readonly EvalTrial[]): void;
  getTrial(id: EvalTrialId): EvalTrial | undefined;
  updateTrial(id: EvalTrialId, patch: Partial<Pick<EvalTrial, 'status' | 'reason' | 'score' | 'missionId' | 'startedAt' | 'finishedAt'>>): EvalTrial;
  listTrials(runId: EvalRunId): readonly EvalTrial[];
}

/** One row per planning pass (#53 §5.5). */
export interface PlanDecisionRepositoryPort {
  create(d: PlanDecision): void;
  latest(missionId: MissionId): PlanDecision | undefined;
  listByMission(missionId: MissionId): readonly PlanDecision[];
}

/** The merge decision's audit trail (#53 §8.6): append-only but for five fields. */
export interface MergeDecisionRepositoryPort {
  create(d: MergeDecisionRecord): void;
  get(id: string): MergeDecisionRecord | undefined;
  latestFor(missionId: MissionId, repo: string): MergeDecisionRecord | undefined;
  listByMission(missionId: MissionId): readonly MergeDecisionRecord[];
  listByWorkspace(workspaceId: WorkspaceId, sinceIso: string): readonly MergeDecisionRecord[];
  update(id: string, patch: MergeDecisionPatch): void;
}

/** Outcomes (#53 §9.1), local until the brain's ledger takes them (#51). */
export interface OutcomeRepositoryPort {
  append(o: OutcomeEvent & { readonly workspaceId: WorkspaceId }): void;
  listByWorkspace(workspaceId: WorkspaceId, sinceIso: string): readonly OutcomeEvent[];
}

/** A project's brain link on this machine (#51). */
export interface WorkspaceBrainRepositoryPort {
  get(workspaceId: WorkspaceId): WorkspaceBrain | undefined;
  list(): readonly WorkspaceBrain[];
  create(brain: WorkspaceBrain): void;
  update(workspaceId: WorkspaceId, patch: Partial<Omit<WorkspaceBrain, 'workspaceId'>>): WorkspaceBrain;
  remove(workspaceId: WorkspaceId): void;
}

/** The brain's model passes and promotions (#51). */
export interface BrainRecordRepositoryPort {
  insertPass(pass: BrainPass): void;
  passes(workspaceId: WorkspaceId, since: Timestamp): readonly BrainPass[];
  upsertProposal(proposal: BrainProposal): void;
  proposal(id: string): BrainProposal | undefined;
  proposals(workspaceId: WorkspaceId): readonly BrainProposal[];
}
