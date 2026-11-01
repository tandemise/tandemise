import { token, type Token } from '@tandemise/kernel';
import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, ArtifactStorePort, AssignmentRepositoryPort,
  CheckpointRepositoryPort, DecisionRepositoryPort, EvalBlobPort, EvalRepositoryPort, EvaluationRepositoryPort, EventBusPort,
  EventRepositoryPort, ExecutionTargetRepositoryPort, FeedbackRepositoryPort, IntegrationRepositoryPort, InteractiveSessionsPort,
  LeaseRepositoryPort, MemberRepositoryPort, MissionCriteriaRepositoryPort, MissionQuestionRepositoryPort, MissionRepositoryPort, LimitRepositoryPort, RoutineRepositoryPort, RunScoreRepositoryPort, SkillRepositoryPort, IssueRepositoryPort, IssueTrackerPort, PullRequestSnapshotPort, PersonRepositoryPort, ProjectionBusPort, RepoRepositoryPort,
  PlanProposalRepositoryPort, TaskHoldRepositoryPort, RoleRepositoryPort, RunInputRepositoryPort, RunRepositoryPort, RuntimeProfileRepositoryPort, SecretStorePort,
  TaskRepositoryPort, UnitOfWork, WorkspaceRepositoryPort, PlanDecisionRepositoryPort, MergeDecisionRepositoryPort, OutcomeRepositoryPort,
} from '@tandemise/domain';
import type { ArtifactMeasurePort, ArtifactParserPort, ArtifactTemplatePort, ProcessLivenessPort, SettingsStorePort, SystemEnvironmentPort, WorkflowSourcePort, OAuthCallbackPort, SkillFilesPort } from './ports.js';
import type {
  ApprovalService, ArtifactService, IntegrationService, MissionService, PlanningService,
  ProjectionService, RoleService, RuntimeService, SystemService, TandemiseServices,
  StaffingService, TeamService, WorkspaceService,
  WorkflowService, FeedbackService, CriteriaService, RefinementService, ContributionService,
} from './services.js';
import type { IdentityPort } from './support/identity.js';
import type { ReadinessService } from './services/readiness.js';
import type { BacklogService } from './services/backlog-service.js';
import type { LimitService } from './services/limit-service.js';
import type { LivenessService } from './services/liveness-service.js';
import type { DeskService } from './services/desk-service.js';
import type { NotificationService } from './services/notification-service.js';
import type { RoutineService } from './services/routine-service.js';
import type { SkillService } from './services/skill-service.js';
import type { IssueService } from './services/issue-service.js';
import type { StaffingResolver } from './engine/staffing-resolver.js';
import type { ReviewPipeline } from './engine/reviews.js';
import type { ArtifactHarvester } from './engine/harvester.js';
import type { BranchIntegrationService } from './engine/branch-integration.js';
import type { CheckService } from './engine/checks.js';
import type { GateService } from './engine/gates.js';
import type { MetricsService } from './engine/metrics.js';
import type { RecoveryService } from './engine/recovery.js';
import type { RemediationPlanner } from './engine/remediation.js';
import type { FeedbackRounds } from './engine/feedback-rounds.js';
import type { SchedulerService } from './engine/scheduler.js';
import type { ApprovalWaiter } from './support/tool-policy.js';
import type { RunDeadlines } from './engine/run-deadline.js';
import type { ConnectFlow } from './services/connect-flow.js';
import type { IntegrationCredentials } from './support/integration-credentials.js';
import type { RuntimeOverrides } from './support/runtime-overrides.js';
import type { TaskExecutor } from './engine/task-executor.js';
import type { EventRecorder } from './support/event-recorder.js';
import type { RepositoryProber } from './support/repository-prober.js';

/**
 * Port tokens the mission engine resolves.
 *
 * `@tandemise/application` sits above `@tandemise/persistence` and
 * `@tandemise/artifacts` in the dependency graph and therefore cannot import
 * their token modules. Declaring the tokens here - against the *domain* port
 * types - is what keeps that boundary intact: the engine names a contract, the
 * composition root decides what satisfies it.
 *
 * The exported names mirror `@tandemise/persistence/tokens.ts` exactly, so the
 * daemon's aliasing is mechanical:
 *
 * ```ts
 * for (const name of [...]) container.bind(app[name], (r) => r.resolve(sqlite[name]));
 * ```
 *
 * The descriptions deliberately differ (`port.` rather than `persistence.`):
 * two tokens are two identities, and diagnostics that showed them under one
 * name would hide the alias rather than document it.
 */

export const UNIT_OF_WORK = token<UnitOfWork>('port.UnitOfWork');

export const INTERACTIVE_SESSIONS = token<InteractiveSessionsPort>('port.InteractiveSessions');
export const WORKSPACE_REPOSITORY = token<WorkspaceRepositoryPort>('port.WorkspaceRepository');
export const REPO_REPOSITORY = token<RepoRepositoryPort>('port.RepoRepository');
export const MISSION_REPOSITORY = token<MissionRepositoryPort>('port.MissionRepository');
export const TASK_REPOSITORY = token<TaskRepositoryPort>('port.TaskRepository');
export const RUN_REPOSITORY = token<RunRepositoryPort>('port.RunRepository');
export const EVENT_REPOSITORY = token<EventRepositoryPort>('port.EventRepository');
export const ARTIFACT_REPOSITORY = token<ArtifactRepositoryPort>('port.ArtifactRepository');
export const APPROVAL_REPOSITORY = token<ApprovalRepositoryPort>('port.ApprovalRepository');
export const ROLE_REPOSITORY = token<RoleRepositoryPort>('port.RoleRepository');
export const RUNTIME_PROFILE_REPOSITORY = token<RuntimeProfileRepositoryPort>('port.RuntimeProfileRepository');
export const EXECUTION_TARGET_REPOSITORY = token<ExecutionTargetRepositoryPort>('port.ExecutionTargetRepository');
export const INTEGRATION_REPOSITORY = token<IntegrationRepositoryPort>('port.IntegrationRepository');
export const ASSIGNMENT_REPOSITORY = token<AssignmentRepositoryPort>('port.AssignmentRepository');
export const DECISION_REPOSITORY = token<DecisionRepositoryPort>('port.DecisionRepository');
export const EVALUATION_REPOSITORY = token<EvaluationRepositoryPort>('port.EvaluationRepository');
export const CHECKPOINT_REPOSITORY = token<CheckpointRepositoryPort>('port.CheckpointRepository');
export const LEASE_REPOSITORY = token<LeaseRepositoryPort>('port.LeaseRepository');
export const PERSON_REPOSITORY = token<PersonRepositoryPort>('port.PersonRepository');
export const MEMBER_REPOSITORY = token<MemberRepositoryPort>('port.MemberRepository');
export const FEEDBACK_REPOSITORY = token<FeedbackRepositoryPort>('port.FeedbackRepository');
export const RUN_INPUT_REPOSITORY = token<RunInputRepositoryPort>('port.RunInputRepository');
export const PLAN_PROPOSAL_REPOSITORY = token<PlanProposalRepositoryPort>('port.PlanProposalRepository');
/** The planner and risk-based merge's records (#53). */
export const PLAN_DECISION_REPOSITORY = token<PlanDecisionRepositoryPort>('port.PlanDecisionRepository');
export const MERGE_DECISION_REPOSITORY = token<MergeDecisionRepositoryPort>('port.MergeDecisionRepository');
export const OUTCOME_REPOSITORY = token<OutcomeRepositoryPort>('port.OutcomeRepository');
export const TASK_HOLD_REPOSITORY = token<TaskHoldRepositoryPort>('port.TaskHoldRepository');
export const MISSION_CRITERIA_REPOSITORY = token<MissionCriteriaRepositoryPort>('port.MissionCriteriaRepository');
export const MISSION_QUESTION_REPOSITORY = token<MissionQuestionRepositoryPort>('port.MissionQuestionRepository');
export const LIMIT_REPOSITORY = token<LimitRepositoryPort>('port.LimitRepository');
export const ROUTINE_REPOSITORY = token<RoutineRepositoryPort>('port.RoutineRepository');
export const SKILL_REPOSITORY = token<SkillRepositoryPort>('port.SkillRepository');
export const ISSUE_REPOSITORY = token<IssueRepositoryPort>('port.IssueRepository');
export const RUN_SCORE_REPOSITORY = token<RunScoreRepositoryPort>('port.RunScoreRepository');
export const EVAL_REPOSITORY = token<EvalRepositoryPort>('port.EvalRepository');
/** Content-addressed eval case inputs (P3b); rebound by the daemon. */
export const EVAL_BLOBS = token<EvalBlobPort>('port.EvalBlobs');

export const ARTIFACT_STORE = token<ArtifactStorePort>('port.ArtifactStore');
/** Workflow files, read from the project's repositories. */
export const WORKFLOW_SOURCE = token<WorkflowSourcePort>('port.WorkflowSource');
/** The factory's planner, routing and merge files (#53). The daemon binds the real one. */
export const FACTORY_CONFIG_SOURCE = token<import('./ports.js').FactoryConfigSourcePort>('port.FactoryConfigSource');
/** The factory files outside a brain: project repository, this computer, built in. The daemon binds the file one. */
export const LOCAL_FACTORY_CONFIG_SOURCE = token<import('./ports.js').FactoryConfigSourcePort>('port.LocalFactoryConfigSource');
/** Outcomes, local and from the brain's ledger (#53 Task 20). */
export const OUTCOME_HISTORY = token<import('./brain/outcome-history.js').OutcomeHistory>('application.OutcomeHistory');
/** The factory's cheap classifier pass (#53 §2). Bound to a runtime-backed runner. */
export const TIEBREAK_RUNNER = token<import('./planning/tiebreak.js').TiebreakRunnerPort>('port.TiebreakRunner');
/** The factory planner (#53 §5). */
export const PLANNER_SERVICE = token<import('./planning/planner-service.js').PlannerService>('application.PlannerService');
/** Pull requests the ship step opens and merges (#53 §8). The daemon binds the `gh` one. */
export const PULL_REQUEST_FLOW = token<import('@tandemise/domain').PullRequestPort>('port.PullRequestFlow');
/** The daemon-owned ship step (#53 §8.1). */
export const SHIP_SERVICE = token<import('./engine/ship.js').ShipService>('application.ShipService');
export const CI_ROUND_GUARD = token<import('./engine/ci-rounds.js').CiRoundGuard>('application.CiRoundGuard');
/** Outcomes for routing and learning (#53 §9.1). */
export const MERGE_WATCH = token<import('./engine/merge-watch.js').MergeWatch>('application.MergeWatch');
export const SHIP_REVERT = token<import('./engine/ship-revert.js').ShipRevert>('application.ShipRevert');
export const PROPOSAL_SERVICE = token<import('./services/proposal-service.js').ProposalService>('application.ProposalService');
export const OUTCOME_RECORDER = token<import('./engine/outcomes.js').OutcomeRecorder>('application.OutcomeRecorder');
/** The `.tandemise` setup folder on disk (P15). The daemon binds the real one. */
export const SETUP_FOLDER = token<import('./ports.js').SetupFolderPort>('port.SetupFolder');
export const WORKFLOW_SERVICE = token<WorkflowService>('service.Workflow');
export const EVENT_BUS = token<EventBusPort>('port.EventBus');
export const PROJECTION_BUS = token<ProjectionBusPort>('port.ProjectionBus');
export const SECRET_STORE = token<SecretStorePort>('port.SecretStore');

/**
 * Bound to `renderArtifactTemplate` / `parseArtifact` from
 * `@tandemise/artifacts`. The artifact *hand-off protocol* is an application
 * concern - the prompt has to state it and the harvester has to enforce it -
 * but the schemas and templates that give it teeth live one layer down.
 */
export const ARTIFACT_TEMPLATES = token<ArtifactTemplatePort>('port.ArtifactTemplates');
export const ARTIFACT_PARSER = token<ArtifactParserPort>('port.ArtifactParser');
export const ARTIFACT_MEASURE = token<ArtifactMeasurePort>('port.ArtifactMeasure');

export const SETTINGS_STORE = token<SettingsStorePort>('port.SettingsStore');
export const SYSTEM_ENVIRONMENT = token<SystemEnvironmentPort>('port.SystemEnvironment');
export const PROCESS_LIVENESS = token<ProcessLivenessPort>('port.ProcessLiveness');
/** Who works on what with the team (relay spec): the local store or a relay client, bound by the daemon. */
export const COORDINATION = token<import('./ports.js').CoordinationPort>('port.Coordination');
export const COORDINATION_CONTROL = token<import('./ports.js').CoordinationControlPort>('port.CoordinationControl');

// ------------------------------------------------------------ engine services

export const EVENT_RECORDER = token<EventRecorder>('application.EventRecorder');
export const REPOSITORY_PROBER = token<RepositoryProber>('application.RepositoryProber');
export const GATE_SERVICE = token<GateService>('application.GateService');
export const CHECK_SERVICE = token<CheckService>('application.CheckService');
export const ARTIFACT_HARVESTER = token<ArtifactHarvester>('application.ArtifactHarvester');
export const TASK_EXECUTOR = token<TaskExecutor>('application.TaskExecutor');
export const REMEDIATION_PLANNER = token<RemediationPlanner>('application.RemediationPlanner');
export const BRANCH_INTEGRATION_SERVICE = token<BranchIntegrationService>('application.BranchIntegrationService');
/**
 * The tick loop, as a `LifecycleComponent`. The composition root registers it
 * with its `LifecycleHost` so that shutdown stops the scheduler before the
 * processes it supervises are reaped (MVP.md §7.3).
 */
export const SCHEDULER = token<SchedulerService>('application.Scheduler');
export const RECOVERY_SERVICE = token<RecoveryService>('application.RecoveryService');
export const METRICS_SERVICE = token<MetricsService>('application.MetricsService');
export const STAFFING_RESOLVER = token<StaffingResolver>('application.StaffingResolver');
export const REVIEW_PIPELINE = token<ReviewPipeline>('application.ReviewPipeline');
/** Feedback items, downstream impact and round starts: shared by the mission service, the executor and reviews. */
export const FEEDBACK_ROUNDS = token<FeedbackRounds>('application.FeedbackRounds');
/** Who requests act as until accounts exist. The local person's name comes from the module options. */
export const IDENTITY = token<IdentityPort>('application.Identity');
export const RUNTIME_OVERRIDES = token<RuntimeOverrides>('application.RuntimeOverrides');
export const APPROVAL_WAITER = token<ApprovalWaiter>('application.ApprovalWaiter');
/** Live run budgets, shared by the executor that owns them and `ask_human`, which pauses them. */
export const RUN_DEADLINES = token<RunDeadlines>('application.RunDeadlines');
/** Access tokens for connected integrations; also bound to integrations-core's credential source. */
export const INTEGRATION_CREDENTIAL_STORE = token<IntegrationCredentials>('application.IntegrationCredentials');
export const CONNECT_FLOW = token<ConnectFlow>('application.ConnectFlow');
/** The loopback redirect listener. Bound by the daemon; absent in headless compositions. */
export const OAUTH_CALLBACK = token<OAuthCallbackPort>('port.OAuthCallback');

// --------------------------------------------------------------- API services

export const SYSTEM_SERVICE = token<SystemService>('application.SystemService');
export const WORKSPACE_SERVICE = token<WorkspaceService>('application.WorkspaceService');
export const MISSION_SERVICE = token<MissionService>('application.MissionService');
export const HOLD_SERVICE = token<import('./services.js').HoldService>('application.HoldService');
export const PLANNING_SERVICE = token<PlanningService>('application.PlanningService');
export const APPROVAL_SERVICE = token<ApprovalService>('application.ApprovalService');
export const ARTIFACT_SERVICE = token<ArtifactService>('application.ArtifactService');
export const RUNTIME_SERVICE = token<RuntimeService>('application.RuntimeService');
export const ROLE_SERVICE = token<RoleService>('application.RoleService');
export const INTEGRATION_SERVICE = token<IntegrationService>('application.IntegrationService');
export const PROJECTION_SERVICE = token<ProjectionService>('application.ProjectionService');
export const TEAM_SERVICE = token<TeamService>('application.TeamService');
export const STAFFING_SERVICE = token<StaffingService>('application.StaffingService');
export const FEEDBACK_SERVICE = token<FeedbackService>('application.FeedbackService');
export const CRITERIA_SERVICE = token<CriteriaService>('application.CriteriaService');
export const REFINEMENT_SERVICE = token<RefinementService>('application.RefinementService');
export const READINESS_SERVICE = token<ReadinessService>('application.ReadinessService');
export const BACKLOG_SERVICE = token<BacklogService>('application.BacklogService');
export const LIMIT_SERVICE = token<LimitService>('application.LimitService');
export const LIVENESS_SERVICE = token<LivenessService>('application.LivenessService');
export const DESK_SERVICE = token<DeskService>('application.DeskService');
export const ROUTINE_SERVICE = token<RoutineService>('application.RoutineService');
export const NOTIFICATION_SERVICE = token<NotificationService>('application.NotificationService');
export const SKILL_SERVICE = token<SkillService>('application.SkillService');
/** Skill folders and the content store (P13); rebound by the daemon. */
export const SKILL_FILES = token<SkillFilesPort>('port.SkillFiles');
export const ISSUE_SERVICE = token<IssueService>('application.IssueService');
export const COORDINATION_SERVICE = token<import('./services/coordination-service.js').CoordinationService>('application.CoordinationService');
/** GitHub issues over `gh` (P14); rebound by the daemon. */
export const ISSUE_TRACKER = token<IssueTrackerPort>('port.IssueTracker');
/** Outside contributions pinned as Evidence (P3). */
export const CONTRIBUTION_SERVICE = token<ContributionService>('application.ContributionService');
/** Reads a handed-back pull request (P3); rebound by the daemon with `gh`. */
export const PULL_REQUEST_SNAPSHOTS = token<PullRequestSnapshotPort>('port.PullRequestSnapshots');
/** The git credential variables (ssh-agent, askpass) a pull request fetch may pass to git; see `pickGitCredentialEnv`. */
export const GIT_CREDENTIAL_ENV = token<() => Readonly<Record<string, string>>>('port.GitCredentialEnv');
export const SETUP_SERVICE = token<import('./services/setup-service.js').SetupService>('application.SetupService');
/** "Why these steps", the lane switch and the opened pull request (#53 §10). */
export const FACTORY_SERVICE = token<import('./services/factory-service.js').FactoryService>('application.FactoryService');
/** Project settings → Merge (#53 §8.4). */
export const MERGE_POLICY_SERVICE = token<import('./services/merge-policy-service.js').MergePolicyService>('application.MergePolicyService');
/** Eval suites, saved cases and the run-score summary (P3b). */
export const EVAL_SERVICE = token<import('./services/eval-service.js').EvalService>('application.EvalService');
/**
 * Runs eval trials one at a time (P3b), as a `LifecycleComponent` the daemon
 * registers after the scheduler; its boot recovery runs before either starts.
 */
export const EVAL_RUNNER = token<import('./engine/eval-runner.js').EvalRunner>('application.EvalRunner');

export const TANDEMISE_SERVICES = token<TandemiseServices>('application.TandemiseServices');

/**
 * Every persistence port the engine needs, by the name `@tandemise/persistence`
 * uses for it. Exported so the composition root can alias the whole set in one
 * loop instead of eighteen hand-written lines that can drift.
 */
export const PERSISTENCE_PORT_TOKENS = {
  UNIT_OF_WORK,
  WORKSPACE_REPOSITORY,
  REPO_REPOSITORY,
  MISSION_REPOSITORY,
  TASK_REPOSITORY,
  RUN_REPOSITORY,
  EVENT_REPOSITORY,
  ARTIFACT_REPOSITORY,
  APPROVAL_REPOSITORY,
  ROLE_REPOSITORY,
  RUNTIME_PROFILE_REPOSITORY,
  EXECUTION_TARGET_REPOSITORY,
  INTEGRATION_REPOSITORY,
  ASSIGNMENT_REPOSITORY,
  DECISION_REPOSITORY,
  EVALUATION_REPOSITORY,
  CHECKPOINT_REPOSITORY,
  LEASE_REPOSITORY,
  PERSON_REPOSITORY,
  MEMBER_REPOSITORY,
  FEEDBACK_REPOSITORY,
  RUN_INPUT_REPOSITORY,
  PLAN_PROPOSAL_REPOSITORY,
  TASK_HOLD_REPOSITORY,
  MISSION_CRITERIA_REPOSITORY,
} as const satisfies Readonly<Record<string, Token<unknown>>>;
