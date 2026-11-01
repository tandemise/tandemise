import { defineModule, type Container, type Resolver, type TandemiseModule } from '@tandemise/kernel';
import { SHIPPED_FACTORY_SOURCE } from './planning/factory-config.js';
import { PlannerService } from './planning/planner-service.js';
import { SHIP_CI_GRACE_MS, SHIP_CI_POLL_MS, SHIP_CI_TIMEOUT_MS, ShipService } from './engine/ship.js';
import { policyRef } from './planning/planner-service.js';
import { OutcomeRecorder } from './engine/outcomes.js';
import { MergeWatch } from './engine/merge-watch.js';
import { ShipRevert } from './engine/ship-revert.js';
import { ProposalService } from './services/proposal-service.js';
import { MergePolicyService, autoMergeAuthorized } from './services/merge-policy-service.js';
import { actorFor } from './support/identity.js';
import type { PullRequestPort } from '@tandemise/domain';
import { describeHoldEnd } from '@tandemise/domain';

/** Until the daemon binds the `gh` flow: every pull request call says there is no GitHub here. */
const NO_PULL_REQUESTS: PullRequestPort = new Proxy({} as PullRequestPort, {
  get: () => async () => { throw new Error('This daemon has no GitHub connection for pull requests.'); },
});
import { runtimeTiebreakRunner } from './planning/tiebreak-runner.js';
import type { Clock, Logger, TandemisePaths } from '@tandemise/shared';
import { TandemiseError, asId, createPaths, nullLogger, systemClock } from '@tandemise/shared';
import { APPROVAL_FACTORY, GRANT_BUILDER, POLICY_ENGINE } from '@tandemise/policy';
import { CONTEXT_COMPILER } from '@tandemise/context';
import { RUNTIME_MANAGER, RUNTIME_REGISTRY } from '@tandemise/runtimes-core';
import {
  CLOCK as EXECUTION_CLOCK, EXECUTION_TARGET_MANAGER, LOGGER as EXECUTION_LOGGER,
  PATHS as EXECUTION_PATHS, PROCESS_SUPERVISOR,
} from '@tandemise/execution-core';
import {
  APPROVAL_GATE, BUILT_IN_TOOLS, INTEGRATION_CREDENTIALS, INTEGRATION_PROVIDER_REGISTRY, INTEGRATION_SOURCE, TOOL_BROKER,
  TOOL_POLICY_GATE,
  COMMAND_EXECUTOR as INTEGRATION_COMMAND_EXECUTOR,
} from '@tandemise/integrations-core';
import { PRIMARY_TRACKER_FACTORIES } from '@tandemise/integrations-core';

import type { TandemiseServices } from './services.js';
import * as t from './tokens.js';
import { ArtifactHarvester } from './engine/harvester.js';
import { BranchIntegrationService } from './engine/branch-integration.js';
import { CheckService } from './engine/checks.js';
import { GateService } from './engine/gates.js';
import { MetricsService } from './engine/metrics.js';
import { RecoveryService } from './engine/recovery.js';
import { RemediationPlanner } from './engine/remediation.js';
import { FeedbackRounds } from './engine/feedback-rounds.js';
import { SchedulerService } from './engine/scheduler.js';
import { PlanFit } from './engine/plan-fit.js';
import { McpGatewayProvisioner } from './engine/mcp-gateway.js';
import { TaskExecutor } from './engine/task-executor.js';
import { EvalRunner } from './engine/eval-runner.js';
import { EventRecorder } from './support/event-recorder.js';
import { RepositoryProber } from './support/repository-prober.js';
import { RuntimeOverrides } from './support/runtime-overrides.js';
import { ApprovalWaiter, createApprovalGate, createPolicyEngineToolGate } from './support/tool-policy.js';
import { createAskHumanTool } from './tools/ask-human.js';
import { bindBrain, brainEdits, brainWorkflows } from './brain/module.js';
import { BRAIN_CONTEXT_SUPPLY, BRAIN_HOST, BRAIN_INTAKE_CONFIG, BRAIN_REPO, BRAIN_SERVICE } from './brain/tokens.js';
import { BrainFirstFactoryConfigSource } from './brain/brain-factory-config-source.js';
import { OutcomeHistory } from './brain/outcome-history.js';
import { RunDeadlines } from './engine/run-deadline.js';
import { ConnectFlow } from './services/connect-flow.js';
import { IntegrationCredentials } from './support/integration-credentials.js';
import { ApprovalServiceImpl } from './services/approval-service.js';
import { ReviewPipeline } from './engine/reviews.js';
import { ArtifactServiceImpl } from './services/artifact-service.js';
import { WorkflowServiceImpl } from './services/workflow-service.js';
import { Waiter } from './engine/waiter.js';
import { PullRequestWait } from './engine/pr-wait.js';
import { IntegrationServiceImpl } from './services/integration-service.js';
import { MissionServiceImpl } from './services/mission-service.js';
import { HoldServiceImpl } from './services/hold-service.js';
import { FeedbackServiceImpl } from './services/feedback-service.js';
import { CriteriaServiceImpl } from './services/criteria-service.js';
import { ReadinessService } from './services/readiness.js';
import { BacklogService } from './services/backlog-service.js';
import { LimitService } from './services/limit-service.js';
import { LivenessService } from './services/liveness-service.js';
import { DeskService } from './services/desk-service.js';
import { NotificationService } from './services/notification-service.js';
import { RoutineService } from './services/routine-service.js';
import { IssueService } from './services/issue-service.js';
import { SkillService } from './services/skill-service.js';
import { ContributionServiceImpl } from './services/contribution-service.js';
import { SkillInstaller } from './engine/skill-installer.js';
import { DEFAULT_QUIET_AFTER_MS, reachedReason, type IssueTrackerPort, type PullRequestSnapshotPort } from '@tandemise/domain';
import { lexicalSimilarity } from '@tandemise/domain';
import { SetupService } from './services/setup-service.js';
import { FactoryService } from './services/factory-service.js';
import { RefinementServiceImpl } from './services/refinement-service.js';
import { EvalService } from './services/eval-service.js';
import { CoordinationService } from './services/coordination-service.js';
import { PlanningServiceImpl } from './services/planning-service.js';
import { ProjectionServiceImpl } from './services/projection-service.js';
import { RoleServiceImpl } from './services/role-service.js';
import { RuntimeServiceImpl } from './services/runtime-service.js';
import { SystemServiceImpl } from './services/system-service.js';
import { WorkspaceServiceImpl } from './services/workspace-service.js';
import { TeamServiceImpl } from './services/team-service.js';
import { StaffingServiceImpl } from './services/staffing-service.js';
import { StaffingResolver } from './engine/staffing-resolver.js';
import { DEFAULT_LOCAL_PERSON_NAME, LocalIdentity } from './support/identity.js';
import * as it from './intake-tokens.js';
import { IntakeService } from './services/intake-service.js';
import { TrackerService } from './services/tracker-service.js';
import { LocalIntakeConfigSource } from './intake/config-source.js';
import { LinkedIntakeConfigSource } from './intake/linked-config-source.js';
import { MemoryBlobs } from './intake/memory-blobs.js';
import { TrackerResolver } from './intake/tracker-resolver.js';
import { IntakeRunnerHost } from './intake/runner-host.js';
import { ClosureService } from './services/closure-service.js';
import { INTAKE_RUNNERS } from '@tandemise/integrations-core';

const SOURCE = 'application';

export interface ApplicationModuleOptions {
  /** Scheduler tick interval. The daemon passes its configured value. */
  readonly tickIntervalMs?: number;
  /**
   * The name given to the local person if none exists yet. The daemon passes
   * `git config user.name`; this layer may not run processes to find it.
   */
  readonly localPersonName?: string;
  /** A run is quiet after this long without an agent event (P9). The daemon passes TANDEMISE_QUIET_MS. */
  readonly quietAfterMs?: number;
  /** How often the ship step reads CI and a waiting pull request (#53). The daemon passes TANDEMISE_SHIP_POLL_MS. */
  readonly shipPollMs?: number;
  /** How long no CI right after a push counts as CI not started yet. The daemon passes TANDEMISE_SHIP_CI_GRACE_MS. */
  readonly shipCiGraceMs?: number;
  /** How long a hold waits for the run it stopped (10 s by default); a check shortens it. */
  readonly holdStopWaitMs?: number;
  /** How often a hold renews its checkout leases (every 10 minutes by default); a check shortens it. */
  readonly holdLeaseRenewMs?: number;
}

/**
 * The mission engine's bindings.
 *
 * Every dependency is resolved by token, and the tokens for the ports this
 * layer cannot import (`persistence`, `artifacts`, the platform adapters) are
 * declared in `tokens.ts` and aliased by the composition root. That indirection
 * is the whole reason the engine can be composed against an in-memory double as
 * easily as against SQLite.
 *
 * Three cross-cutting tokens - clock, logger, paths - are resolved through
 * `@tandemise/execution-core`, which owns them today, and fall back to sane
 * defaults when the composition root has not bound them. They fall back rather
 * than throwing because a half-composed engine that cannot tell the time is a
 * worse diagnostic than one that logs nowhere.
 */
export function createApplicationModule(options: ApplicationModuleOptions = {}): TandemiseModule {
  const shipPollMs = options.shipPollMs ?? SHIP_CI_POLL_MS;
  return defineModule(SOURCE, (container: Container) => {
    const bind = container.bind.bind(container);

    // --------------------------------------------------------------- support

    bind(t.RUNTIME_OVERRIDES, () => new RuntimeOverrides(), { source: SOURCE });
    bind(t.APPROVAL_WAITER, () => new ApprovalWaiter(), { source: SOURCE });
    bind(t.RUN_DEADLINES, () => new RunDeadlines(), { source: SOURCE });

    bind(t.EVENT_RECORDER, (r) => new EventRecorder(
      r.resolve(t.EVENT_REPOSITORY),
      r.resolve(t.EVENT_BUS),
      r.resolve(t.PROJECTION_BUS),
      clock(r),
    ), { source: SOURCE });

    bind(t.IDENTITY, (r) => new LocalIdentity(
      r.resolve(t.PERSON_REPOSITORY),
      options.localPersonName ?? DEFAULT_LOCAL_PERSON_NAME,
    ), { source: SOURCE });

    bind(t.STAFFING_RESOLVER, (r) => new StaffingResolver({
      members: r.resolve(t.MEMBER_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
    }), { source: SOURCE });

    bind(t.REPOSITORY_PROBER, (r) => new RepositoryProber(r.resolve(PROCESS_SUPERVISOR)), { source: SOURCE });

    // ------------------------------------------------- the tool path's policy

    // Bound over the `denyAllPolicyGate` default in `integrations-core`. This is
    // the binding that gives `POLICY_ENGINE` a caller on the execution path.
    bind(TOOL_POLICY_GATE, (r) => createPolicyEngineToolGate({
      policy: r.resolve(POLICY_ENGINE),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      log: log(r).child({ component: 'tool-policy' }),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
    }), { source: SOURCE });

    bind(APPROVAL_GATE, (r) => createApprovalGate({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      waiter: r.resolve(t.APPROVAL_WAITER),
      recorder: r.resolve(t.EVENT_RECORDER),
      runs: r.resolve(t.RUN_REPOSITORY),
      // Resolved per card: the pipeline reads the team as it is when the tool asks.
      clock: clock(r),
      address: (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).addressFor(task, workspaceId),
      deadlines: r.resolve(t.RUN_DEADLINES),
    }), { source: SOURCE });

    // Asking the supervising human a question is a capability every worker has,
    // so it is contributed rather than configured: there is no vendor behind it
    // and no workspace that should be able to switch it off.
    container.contribute(BUILT_IN_TOOLS, (r) => createAskHumanTool({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      address: (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).questionAddressFor(task, workspaceId),
      waiter: r.resolve(t.APPROVAL_WAITER),
      deadlines: r.resolve(t.RUN_DEADLINES),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
    }), { source: SOURCE });

    // The tool catalog is built from the workspace's enabled integrations, and
    // it is a thunk so that enabling one takes effect without a rebuild.
    bind(INTEGRATION_SOURCE, (r) => () => {
      const workspaces = r.resolve(t.WORKSPACE_REPOSITORY);
      const integrations = r.resolve(t.INTEGRATION_REPOSITORY);
      return workspaces.list().flatMap((w) => integrations.listByWorkspace(w.id)).filter((i) => i.enabled);
    }, { source: SOURCE });

    // ---------------------------------------------------------------- engine

    bind(t.GATE_SERVICE, (r) => new GateService(
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(t.MISSION_REPOSITORY),
      r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      r.resolve(t.RUN_REPOSITORY),
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
    ), { source: SOURCE });

    bind(t.REVIEW_PIPELINE, (r) => new ReviewPipeline({
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      gates: r.resolve(t.GATE_SERVICE),
      staffing: r.resolve(t.STAFFING_RESOLVER),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'reviews' }),
    }), { source: SOURCE });

    bind(t.CHECK_SERVICE, (r) => new CheckService(
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      r.resolve(t.FACTORY_CONFIG_SOURCE),
    ), { source: SOURCE });

    bind(t.ARTIFACT_HARVESTER, (r) => new ArtifactHarvester(
      r.resolve(t.ARTIFACT_STORE),
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.ARTIFACT_PARSER),
      r.resolve(t.ARTIFACT_MEASURE),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.MISSION_CRITERIA_REPOSITORY),
    ), { source: SOURCE });

    bind(t.METRICS_SERVICE, (r) => new MetricsService(
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.RUN_REPOSITORY),
      r.resolve(t.EVENT_REPOSITORY),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      clock(r),
    ), { source: SOURCE });

    bind(t.TASK_EXECUTOR, (r) => new TaskExecutor({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      leases: r.resolve(t.LEASE_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      decisions: r.resolve(t.DECISION_REPOSITORY),
      checkpoints: r.resolve(t.CHECKPOINT_REPOSITORY),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      contextCompiler: r.resolve(CONTEXT_COMPILER),
      grantBuilder: r.resolve(GRANT_BUILDER),
      policy: r.resolve(POLICY_ENGINE),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      mcpGateway: mcpGateway(r),
      toolBroker: r.tryResolve(TOOL_BROKER) ?? null,
      overrides: r.resolve(t.RUNTIME_OVERRIDES),
      templates: r.resolve(t.ARTIFACT_TEMPLATES),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      events: r.resolve(t.EVENT_REPOSITORY),
      harvester: r.resolve(t.ARTIFACT_HARVESTER),
      checks: r.resolve(t.CHECK_SERVICE),
      gates: r.resolve(t.GATE_SERVICE),
      questions: r.resolve(t.MISSION_QUESTION_REPOSITORY),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      runInputs: r.resolve(t.RUN_INPUT_REPOSITORY),
      holds: r.resolve(t.TASK_HOLD_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      deadlines: r.resolve(t.RUN_DEADLINES),
      limits: r.resolve(t.LIMIT_SERVICE),
      skills: r.resolve(t.SKILL_SERVICE),
      skillInstaller: new SkillInstaller(r.resolve(t.EVENT_RECORDER)),
      trackerItems: { get: (id) => r.tryResolve(it.TRACKER_ITEM_REPOSITORY)?.get(id as import('@tandemise/shared').TrackerItemId) },
      runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
      // Resolved per call: the eval runner is composed from this executor.
      trialContext: (mission) => r.resolve(t.EVAL_RUNNER).contextFor(mission),
      brain: r.resolve(BRAIN_CONTEXT_SUPPLY),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'executor' }),
    }), { source: SOURCE });

    bind(t.EVAL_RUNNER, (r) => new EvalRunner({
      evals: r.resolve(t.EVAL_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      blobs: r.resolve(t.EVAL_BLOBS),
      repositories: r.resolve(t.REPO_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      executor: r.resolve(t.TASK_EXECUTOR),
      // Deleting a trial's branch is raw git in the person's repository, like a case's base commit.
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      clock: clock(r),
      log: log(r).child({ component: 'eval-runner' }),
    }), { source: SOURCE, dispose: (runner) => runner.stop() });

    bind(t.REMEDIATION_PLANNER, (r) => new RemediationPlanner(
      r.resolve(t.MISSION_REPOSITORY),
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.EVALUATION_REPOSITORY),
      r.resolve(t.ROLE_REPOSITORY),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(APPROVAL_FACTORY),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).addressFor(task, workspaceId),
    ), { source: SOURCE });

    bind(t.BRANCH_INTEGRATION_SERVICE, (r) => new BranchIntegrationService(
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.REPO_REPOSITORY),
      r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      r.resolve(t.ROLE_REPOSITORY),
      r.resolve(EXECUTION_TARGET_MANAGER),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      r.resolve(t.ARTIFACT_REPOSITORY),
    ), { source: SOURCE });

    bind(t.FEEDBACK_ROUNDS, (r) => new FeedbackRounds({
      outcomes: () => r.tryResolve(t.OUTCOME_RECORDER),
      missions: r.resolve(t.MISSION_REPOSITORY), tasks: r.resolve(t.TASK_REPOSITORY), runs: r.resolve(t.RUN_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY), artifactStore: r.resolve(t.ARTIFACT_STORE), approvals: r.resolve(t.APPROVAL_REPOSITORY),
      evaluations: r.resolve(t.EVALUATION_REPOSITORY), feedback: r.resolve(t.FEEDBACK_REPOSITORY), runInputs: r.resolve(t.RUN_INPUT_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY), events: r.resolve(t.EVENT_REPOSITORY), unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER), clock: clock(r),
      cancelTask: (taskId) => r.resolve(t.SCHEDULER).cancelTask(taskId),
    }), { source: SOURCE });

    bind(t.PULL_REQUEST_FLOW, () => NO_PULL_REQUESTS, { source: SOURCE });
    bind(t.MERGE_WATCH, (r) => new MergeWatch({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY), missions: r.resolve(t.MISSION_REPOSITORY), tasks: r.resolve(t.TASK_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY), mergeDecisions: r.resolve(t.MERGE_DECISION_REPOSITORY), outcomeRows: r.resolve(t.OUTCOME_HISTORY),
      pullRequests: r.resolve(t.PULL_REQUEST_FLOW), approvals: r.resolve(t.APPROVAL_REPOSITORY), approvalFactory: r.resolve(APPROVAL_FACTORY),
      outcomes: () => r.tryResolve(t.OUTCOME_RECORDER), recorder: r.resolve(t.EVENT_RECORDER), clock: clock(r), log: log(r).child({ component: 'merge-watch' }),
      events: r.resolve(t.EVENT_REPOSITORY),
    }), { source: SOURCE });
    bind(t.SHIP_REVERT, (r) => new ShipRevert({
      missions: r.resolve(t.MISSION_REPOSITORY), tasks: r.resolve(t.TASK_REPOSITORY), repositories: r.resolve(t.REPO_REPOSITORY),
      mergeDecisions: r.resolve(t.MERGE_DECISION_REPOSITORY), planDecisions: r.resolve(t.PLAN_DECISION_REPOSITORY), pullRequests: r.resolve(t.PULL_REQUEST_FLOW),
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      ...(r.has(t.GIT_CREDENTIAL_ENV) ? { credentialEnv: r.resolve(t.GIT_CREDENTIAL_ENV) } : {}),
      outcomes: () => r.tryResolve(t.OUTCOME_RECORDER), recorder: r.resolve(t.EVENT_RECORDER), clock: clock(r),
      wake: () => r.resolve(t.SCHEDULER).wake(), tmpRoot: `${paths(r).root}/ship-reverts`,
    }), { source: SOURCE });
    bind(t.PROPOSAL_SERVICE, (r) => new ProposalService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY), planner: r.resolve(t.PLANNER_SERVICE), outcomes: r.resolve(t.OUTCOME_HISTORY),
      pullRequests: r.resolve(t.PULL_REQUEST_FLOW), mergePolicy: () => r.resolve(t.MERGE_POLICY_SERVICE),
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      ...(r.has(t.GIT_CREDENTIAL_ENV) ? { credentialEnv: r.resolve(t.GIT_CREDENTIAL_ENV) } : {}),
      clock: clock(r), log: log(r).child({ component: 'proposals' }), tmpRoot: `${paths(r).root}/proposals`,
      brain: () => r.tryResolve(BRAIN_SERVICE), brainHost: () => r.tryResolve(BRAIN_HOST),
    }), { source: SOURCE });
    bind(t.OUTCOME_RECORDER, (r) => new OutcomeRecorder({
      outcomes: r.resolve(t.OUTCOME_REPOSITORY),
      sink: (workspaceId, event) => { void r.resolve(t.OUTCOME_HISTORY).send(workspaceId, event); },
      bus: r.resolve(t.EVENT_BUS),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      planDecisions: r.resolve(t.PLAN_DECISION_REPOSITORY),
      runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'outcomes' }),
    }), { source: SOURCE });
    bind(t.SHIP_SERVICE, (r) => new ShipService({
      tasks: r.resolve(t.TASK_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      integration: r.resolve(t.BRANCH_INTEGRATION_SERVICE),
      pullRequests: r.resolve(t.PULL_REQUEST_FLOW),
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      ...(r.has(t.GIT_CREDENTIAL_ENV) ? { credentialEnv: r.resolve(t.GIT_CREDENTIAL_ENV) } : {}),
      planDecisions: r.resolve(t.PLAN_DECISION_REPOSITORY),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'ship' }),
      escalate: (mission, paths) => r.resolve(t.PLANNER_SERVICE).escalate(mission, paths, { fromShip: true }),
      revert: (decisionId, by) => r.resolve(t.SHIP_REVERT).revert(decisionId, by),
      prFacts: (mission) => shipPrFacts(r, mission),
      pushedSha: (mission, pr) => {
        const opened = r.resolve(t.EVENT_REPOSITORY).listByMission(mission.id)
          .filter((e) => e.body.type === 'ship.pr_opened' && e.body.repo === pr.repo && e.body.number === pr.number);
        const last = opened.at(-1)?.body;
        return last !== undefined && last.type === 'ship.pr_opened' ? last.headSha : null;
      },
      opened: (mission) => openedPullRequests(r, mission.id),
      kept: (mission) => r.resolve(t.EVENT_REPOSITORY).listByMission(mission.id)
        .flatMap((e) => (e.body.type === 'merge.approval_kept' ? [{ approvalId: e.body.approvalId, by: e.body.by, toHead: e.body.toHead }] : [])),
      decide: {
        missions: r.resolve(t.MISSION_REPOSITORY),
        mergeDecisions: r.resolve(t.MERGE_DECISION_REPOSITORY),
        approvals: r.resolve(t.APPROVAL_REPOSITORY),
        approvalFactory: r.resolve(APPROVAL_FACTORY),
        evaluations: r.resolve(t.EVALUATION_REPOSITORY),
        runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
        outcomeRows: r.resolve(t.OUTCOME_HISTORY),
        unitOfWork: r.resolve(t.UNIT_OF_WORK),
        rounds: () => r.resolve(t.FEEDBACK_ROUNDS),
        outcomes: () => r.tryResolve(t.OUTCOME_RECORDER),
        holds: r.tryResolve(t.TASK_HOLD_REPOSITORY),
        feedback: r.resolve(t.FEEDBACK_REPOSITORY),
        factory: async (workspaceId) => {
          const config = await r.resolve(t.PLANNER_SERVICE).config(asId(workspaceId));
          const authorized = r.resolve(t.MERGE_POLICY_SERVICE).reconcile(asId(workspaceId), config);
          return { planner: config.planner, merge: config.merge, policyRef: policyRef(config), autoMergeAuthorized: authorized };
        },
        pollMs: shipPollMs,
        timeoutMs: SHIP_CI_TIMEOUT_MS,
        ciGraceMs: options.shipCiGraceMs ?? SHIP_CI_GRACE_MS,
      },
    }), { source: SOURCE });

    bind(t.SCHEDULER, (r) => new SchedulerService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      executor: r.resolve(t.TASK_EXECUTOR),
      repositories: r.resolve(t.REPO_REPOSITORY),
      waiter: new Waiter({
        exec: () => r.resolve(INTEGRATION_COMMAND_EXECUTOR),
        clock: clock(r),
        log: log(r).child({ component: 'waiter' }),
      }),
      prWait: new PullRequestWait({
        pullRequests: r.resolve(t.PULL_REQUEST_FLOW),
        known: (mission) => openedPullRequests(r, mission.id),
        graceMs: options.shipCiGraceMs ?? SHIP_CI_GRACE_MS,
      }),
      remediation: r.resolve(t.REMEDIATION_PLANNER),
      integration: r.resolve(t.BRANCH_INTEGRATION_SERVICE),
      outcomes: r.resolve(t.OUTCOME_RECORDER),
      ship: r.resolve(t.SHIP_SERVICE),
      shipPollMs,
      watchMerges: () => { r.resolve(t.MERGE_WATCH).tick(); r.resolve(t.PROPOSAL_SERVICE).tick(); },
      recorder: r.resolve(t.EVENT_RECORDER),
      staffing: r.resolve(t.STAFFING_RESOLVER),
      members: r.resolve(t.MEMBER_REPOSITORY),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      planFit: new PlanFit({
        artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
        approvals: r.resolve(t.APPROVAL_REPOSITORY),
        approvalFactory: r.resolve(APPROVAL_FACTORY),
        recorder: r.resolve(t.EVENT_RECORDER),
        addressFor: (task, workspaceId) => r.resolve(t.REVIEW_PIPELINE).addressFor(task, workspaceId),
      }),
      // Resolved per pass, not at construction: the backlog plans through the
      // planning service, which is composed with the API services after this.
      // Resolved per pass: routines create missions through the mission service, composed after this.
      fireRoutines: () => r.resolve(t.ROUTINE_SERVICE).tick(),
      // Resolved per pass: issue sync creates missions through the mission service too.
      syncIssues: () => r.resolve(t.ISSUE_SERVICE).tick(),
      // Resolved per pass: intake retries and recovers in the background (plan Task 7).
      // The runner host starts due polls and drains the webhook mailbox there too (plan Task 10).
      syncIntake: () => { r.resolve(it.INTAKE_SERVICE).tick(); r.resolve(it.TRACKER_SERVICE).tick(); r.resolve(it.INTAKE_RUNNER_HOST).tick(); r.resolve(it.CLOSURE_SERVICE).tick(); },
      pullBacklog: () => r.resolve(t.BACKLOG_SERVICE).pull(),
      limits: r.resolve(t.LIMIT_SERVICE),
      // Resolved per pass, like the backlog: it reads the planner, composed after this.
      watchLiveness: () => r.resolve(t.LIVENESS_SERVICE).watch(),
      clock: clock(r),
      log: log(r).child({ component: 'scheduler' }),
      ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
    }), { source: SOURCE, dispose: (s) => s.stop() });

    bind(t.RECOVERY_SERVICE, (r) => new RecoveryService(
      r.resolve(t.MISSION_REPOSITORY),
      r.resolve(t.TASK_REPOSITORY),
      r.resolve(t.RUN_REPOSITORY),
      r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      r.resolve(t.LEASE_REPOSITORY),
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(RUNTIME_REGISTRY),
      r.resolve(t.PROCESS_LIVENESS),
      r.resolve(t.EVENT_RECORDER),
      clock(r),
      log(r).child({ component: 'recovery' }),
      r.resolve(t.APPROVAL_REPOSITORY),
      r.resolve(t.TASK_HOLD_REPOSITORY),
    ), { source: SOURCE });

    // ---------------------------------------------------------- API services

    bind(t.SYSTEM_SERVICE, (r) => new SystemServiceImpl(
      r.resolve(t.SYSTEM_ENVIRONMENT),
      r.resolve(t.SETTINGS_STORE),
      {
        bindings: () => container.describe(),
        runtimeAdapters: () => r.resolve(RUNTIME_REGISTRY).ids(),
        targetKinds: () => r.resolve(EXECUTION_TARGET_MANAGER).kinds(),
        integrationProviders: () => r.resolve(INTEGRATION_PROVIDER_REGISTRY).ids(),
        artifactRoot: () => paths(r).root,
      },
    ), { source: SOURCE });

    bind(t.WORKSPACE_SERVICE, (r) => new WorkspaceServiceImpl(
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(t.REPO_REPOSITORY),
      r.resolve(t.ROLE_REPOSITORY),
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(t.REPOSITORY_PROBER),
      clock(r),
      {
        people: r.resolve(t.PERSON_REPOSITORY),
        members: r.resolve(t.MEMBER_REPOSITORY),
        unitOfWork: r.resolve(t.UNIT_OF_WORK),
        factoryEdits: brainEdits(r),
      },
    ), { source: SOURCE });

    bind(t.TEAM_SERVICE, (r) => new TeamServiceImpl({
      people: r.resolve(t.PERSON_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      clock: clock(r),
    }), { source: SOURCE });

    bind(t.STAFFING_SERVICE, (r) => new StaffingServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      resolver: r.resolve(t.STAFFING_RESOLVER),
      projections: r.resolve(t.PROJECTION_SERVICE),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
    }), { source: SOURCE });

    bind(t.ROLE_SERVICE, (r) => new RoleServiceImpl(
      r.resolve(t.ROLE_REPOSITORY), clock(r),
      (workspaceId, skills) => r.resolve(t.SKILL_SERVICE).validateRoleSkills(workspaceId, skills),
      brainEdits(r),
    ), { source: SOURCE });

    // P13: the daemon rebinds the files port (it reads folders and runs git); this one finds nothing.
    bind(t.SKILL_FILES, () => ({
      discoverRoot: () => '',
      discover: async () => ({ exists: false, folders: [] }),
      scan: async (folder: string) => ({ folder, files: [], sizeBytes: 0, problem: 'Skills cannot be read in this build.' }),
      fetchGit: async () => { throw new Error('Skills cannot be read in this build.'); },
      store: async () => undefined,
      read: async () => null,
      drop: async () => undefined,
    }), { source: SOURCE });

    bind(t.SKILL_SERVICE, (r) => new SkillService({
      factoryEdits: brainEdits(r),
      skills: r.resolve(t.SKILL_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      files: r.resolve(t.SKILL_FILES),
      clock: clock(r),
      log: log(r).child({ component: 'skills' }),
    }), { source: SOURCE });

    bind(t.ARTIFACT_SERVICE, (r) => new ArtifactServiceImpl(
      r.resolve(t.ARTIFACT_REPOSITORY),
      r.resolve(t.ARTIFACT_STORE),
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(t.MEMBER_REPOSITORY),
      r.resolve(t.ARTIFACT_MEASURE),
      {
        missions: r.resolve(t.MISSION_REPOSITORY),
        tasks: r.resolve(t.TASK_REPOSITORY),
        approvals: r.resolve(t.APPROVAL_REPOSITORY),
        feedback: r.resolve(t.FEEDBACK_REPOSITORY),
      },
    ), { source: SOURCE });

    bind(t.RUNTIME_SERVICE, (r) => new RuntimeServiceImpl(
      r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      r.resolve(t.WORKSPACE_REPOSITORY),
      r.resolve(RUNTIME_MANAGER),
      clock(r),
    ), { source: SOURCE });

    bind(t.INTEGRATION_CREDENTIAL_STORE, (r) => new IntegrationCredentials({
      secrets: r.resolve(t.SECRET_STORE),
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      clock: clock(r),
      log: log(r).child({ component: 'integration-credentials' }),
    }), { source: SOURCE });
    // Providers resolve this core token; they never see the store behind it.
    bind(INTEGRATION_CREDENTIALS, (r) => r.resolve(t.INTEGRATION_CREDENTIAL_STORE), { source: SOURCE });

    bind(t.CONNECT_FLOW, (r) => new ConnectFlow({
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      credentials: r.resolve(t.INTEGRATION_CREDENTIAL_STORE),
      callbacks: r.resolve(t.OAUTH_CALLBACK),
      // Resolved at call time: the service depends on this flow, so resolving
      // it while constructing the flow would be a cycle.
      checkHealth: (id) => r.resolve(t.INTEGRATION_SERVICE).checkHealth(id),
      clock: clock(r),
      log: log(r).child({ component: 'connect' }),
    }), { source: SOURCE });

    bind(t.INTEGRATION_SERVICE, (r) => new IntegrationServiceImpl({
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      providers: r.resolve(INTEGRATION_PROVIDER_REGISTRY),
      secrets: r.resolve(t.SECRET_STORE),
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      connect: r.has(t.OAUTH_CALLBACK) ? r.resolve(t.CONNECT_FLOW) : null,
      credentials: r.resolve(t.INTEGRATION_CREDENTIAL_STORE),
      clock: clock(r),
      log: log(r).child({ component: 'integrations' }),
    }), { source: SOURCE });

    bind(t.PROJECTION_SERVICE, (r) => new ProjectionServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      decisions: r.resolve(t.DECISION_REPOSITORY),
      evaluations: r.resolve(t.EVALUATION_REPOSITORY),
      targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      runtimes: r.resolve(t.RUNTIME_SERVICE),
      gates: r.resolve(t.GATE_SERVICE),
      metrics: r.resolve(t.METRICS_SERVICE),
      members: r.resolve(t.MEMBER_REPOSITORY),
      staffing: r.resolve(t.STAFFING_RESOLVER),
      feedback: r.resolve(t.FEEDBACK_REPOSITORY),
      readiness: r.resolve(t.READINESS_SERVICE),
      limits: r.resolve(t.LIMIT_SERVICE),
      liveness: r.resolve(t.LIVENESS_SERVICE),
      // Start moves the tracker refused (#187), resolved per call: the tracker service reads missions through these.
      trackerStalled: (workspaceId) => r.resolve(it.TRACKER_SERVICE).moveRefusals(workspaceId),
      // Resolved per call: the desk reads the inbox and the backlog, which are built on projections.
      desk: {
        metrics: (workspaceId) => r.resolve(t.DESK_SERVICE).metrics(workspaceId),
        banners: (workspaceId, metrics) => r.resolve(t.DESK_SERVICE).banners(workspaceId, metrics),
      },
      // Resolved per call: intake is composed after the projections (plan Task 7).
      intakeDecisions: (workspaceId) => r.resolve(it.INTAKE_SERVICE).decisions(workspaceId),
      // Resolved per call for the same reason: a hold answers with a task view.
      holds: { standing: (task, mission) => r.resolve(t.HOLD_SERVICE).standing(task, mission) },
      // Resolved per call: the claim banner and the Unclaimed rows (relay spec).
      coordination: {
        missionClaim: (missionId) => r.resolve(t.COORDINATION_SERVICE).missionClaim(missionId),
        inboxUnclaimed: (workspaceId) => r.resolve(t.COORDINATION_SERVICE).inboxUnclaimed(workspaceId),
      },
    }), { source: SOURCE });

    // Default: this installation has no workflow files. A composition root that
    // can read the filesystem rebinds it; one that cannot - a test, an embedder
    // - still gets the built-in presets rather than an unresolved token.
    bind(t.WORKFLOW_SOURCE, () => ({ list: async () => [] }), { source: SOURCE });
    bind(t.LOCAL_FACTORY_CONFIG_SOURCE, () => SHIPPED_FACTORY_SOURCE, { source: SOURCE });
    // A linked brain's factory/ first, then the local files (#53 Task 20).
    bind(t.FACTORY_CONFIG_SOURCE, (r) => new BrainFirstFactoryConfigSource(
      () => r.tryResolve(BRAIN_SERVICE), () => r.tryResolve(BRAIN_REPO), r.resolve(t.LOCAL_FACTORY_CONFIG_SOURCE),
      () => {
        const exec = r.tryResolve(INTEGRATION_COMMAND_EXECUTOR);
        const host = r.tryResolve(BRAIN_HOST);
        if (exec === undefined || host === undefined) return undefined;
        return { exec, host, tmpRoot: `${paths(r).root}/brain-edits`, ...(r.has(t.GIT_CREDENTIAL_ENV) ? { credentialEnv: r.resolve(t.GIT_CREDENTIAL_ENV) } : {}) };
      },
    ), { source: SOURCE });
    bind(t.OUTCOME_HISTORY, (r) => new OutcomeHistory(
      r.resolve(t.OUTCOME_REPOSITORY), () => r.tryResolve(BRAIN_SERVICE), () => r.tryResolve(BRAIN_REPO), log(r).child({ component: 'outcomes' }),
    ), { source: SOURCE });
    bind(t.TIEBREAK_RUNNER, (r) => runtimeTiebreakRunner({
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      paths: paths(r),
      log: log(r),
    }), { source: SOURCE });
    bind(t.PLANNER_SERVICE, (r) => new PlannerService({
      factory: r.resolve(t.FACTORY_CONFIG_SOURCE),
      workflows: r.resolve(t.WORKFLOW_SOURCE),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      planDecisions: r.resolve(t.PLAN_DECISION_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'planner' }),
      tiebreak: r.resolve(t.TIEBREAK_RUNNER),
      trackerItems: { get: (id) => r.tryResolve(it.TRACKER_ITEM_REPOSITORY)?.get(id as import('@tandemise/shared').TrackerItemId) },
      skills: r.resolve(t.SKILL_SERVICE),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      proposals: r.resolve(t.PLAN_PROPOSAL_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      outcomes: r.resolve(t.OUTCOME_HISTORY),
    }), { source: SOURCE });

    bind(t.WORKFLOW_SERVICE, (r) => new WorkflowServiceImpl(
      r.resolve(t.WORKFLOW_SOURCE),
      r.resolve(t.REPO_REPOSITORY),
      brainWorkflows(r),
    ), { source: SOURCE });

    bind(t.READINESS_SERVICE, (r) => new ReadinessService({
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      questions: r.resolve(t.MISSION_QUESTION_REPOSITORY),
    }), { source: SOURCE });

    bind(t.PLANNING_SERVICE, (r) => new PlanningServiceImpl({
      readiness: r.resolve(t.READINESS_SERVICE),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      questions: r.resolve(t.MISSION_QUESTION_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      workflows: r.resolve(t.WORKFLOW_SOURCE),
      brain: brainWorkflows(r),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      proposals: r.resolve(t.PLAN_PROPOSAL_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      projections: r.resolve(t.PROJECTION_SERVICE),
      recorder: r.resolve(t.EVENT_RECORDER),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'planning' }),
      skills: r.resolve(t.SKILL_SERVICE),
      parser: r.resolve(t.ARTIFACT_PARSER),
      templates: r.resolve(t.ARTIFACT_TEMPLATES),
      planner: r.resolve(t.PLANNER_SERVICE),
      wake: () => r.resolve(t.SCHEDULER).wake(),
      // Resolved per plan, not at construction: the integration service is
      // composed after planning, and a plan should see what is connected now.
      connectedApps: async (workspaceId) => (await r.resolve(t.INTEGRATION_SERVICE).list(asId(workspaceId)))
        .filter((view) => view.integration.enabled !== false && view.health.state === 'healthy')
        .map((view) => ({
          name: view.integration.name,
          capabilities: [...new Set(view.availableCapabilities.map((c) => c.capability))],
          detail: view.health.detail,
        })),
    }), { source: SOURCE });

    bind(t.APPROVAL_SERVICE, (r) => new ApprovalServiceImpl({
      laneApproved: (approval) => r.resolve(t.PLANNER_SERVICE).laneApproved(approval),
      shipDecided: (approval) => r.resolve(t.SHIP_SERVICE).personDecided(approval),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      scheduler: r.resolve(t.SCHEDULER),
      waiter: r.resolve(t.APPROVAL_WAITER),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      recorder: r.resolve(t.EVENT_RECORDER),
      members: r.resolve(t.MEMBER_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      limits: r.resolve(t.LIMIT_SERVICE),
      skills: r.resolve(t.SKILL_SERVICE),
      proposals: r.resolve(t.PLAN_PROPOSAL_REPOSITORY),
      replanRest: (missionId, note, planFitApprovalId) => r.resolve(t.PLANNING_SERVICE).replan(missionId, { note, planFitApprovalId }),
      claims: {
        assertMayStart: (mission) => r.resolve(t.COORDINATION_SERVICE).assertMayStart(mission),
        abandonStart: (mission) => r.resolve(t.COORDINATION_SERVICE).abandonStart(mission),
      },
      clock: clock(r),
      log: log(r).child({ component: 'approvals' }),
    }), { source: SOURCE });

    // Depends on no service but projections, so the mission service can use it for a retry with a note without a cycle.
    bind(t.FEEDBACK_SERVICE, (r) => new FeedbackServiceImpl({
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      feedback: r.resolve(t.FEEDBACK_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      projections: r.resolve(t.PROJECTION_SERVICE),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      scheduler: r.resolve(t.SCHEDULER),
      // Resolved per call: a note's files are pinned through it (spec A3).
      contributions: { pin: (input) => r.resolve(t.CONTRIBUTION_SERVICE).pin(input) },
      clock: clock(r),
    }), { source: SOURCE });

    bind(t.MISSION_SERVICE, (r) => new MissionServiceImpl({
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      members: r.resolve(t.MEMBER_REPOSITORY),
      roles: r.resolve(t.ROLE_REPOSITORY),
      reviews: r.resolve(t.REVIEW_PIPELINE),
      planning: r.resolve(t.PLANNING_SERVICE),
      limitRefusal: (missionId) => r.resolve(t.LIMIT_SERVICE).refusal(missionId),
      criteriaTrace: (missionId) => r.resolve(t.GATE_SERVICE).trace(missionId).trace,
      projections: r.resolve(t.PROJECTION_SERVICE),
      scheduler: r.resolve(t.SCHEDULER),
      feedback: r.resolve(t.FEEDBACK_SERVICE),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      overrides: r.resolve(t.RUNTIME_OVERRIDES),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'missions' }),
      // Resolved per call: uploads at creation are pinned through it (spec A2).
      contributions: {
        pin: (input) => r.resolve(t.CONTRIBUTION_SERVICE).pin(input),
        adoptPullRequestHead: (input) => r.resolve(t.CONTRIBUTION_SERVICE).adoptPullRequestHead(input),
      },
      // Where a handed-back file's workspace link is made relative to (spec A5).
      artifactRoot: (workspaceId) => paths(r).artifacts(workspaceId),
      events: r.resolve(t.EVENT_REPOSITORY),
      targets: r.resolve(t.EXECUTION_TARGET_REPOSITORY),
      claims: {
        assertMayStart: (mission) => r.resolve(t.COORDINATION_SERVICE).assertMayStart(mission),
        abandonStart: (mission) => r.resolve(t.COORDINATION_SERVICE).abandonStart(mission),
      },
    }), { source: SOURCE });

    bind(t.HOLD_SERVICE, (r) => new HoldServiceImpl({
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      assignments: r.resolve(t.ASSIGNMENT_REPOSITORY),
      holds: r.resolve(t.TASK_HOLD_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      executor: r.resolve(t.TASK_EXECUTOR),
      mcpGateway: mcpGateway(r),
      // Bound by the daemon when its terminal host loads; without it every hold is refused.
      ...(r.tryResolve(t.INTERACTIVE_SESSIONS) === undefined ? {} : { sessions: r.resolve(t.INTERACTIVE_SESSIONS) }),
      rounds: r.resolve(t.FEEDBACK_ROUNDS),
      scheduler: r.resolve(t.SCHEDULER),
      projections: r.resolve(t.PROJECTION_SERVICE),
      limitRefusal: (missionId) => r.resolve(t.LIMIT_SERVICE).refusal(missionId),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'holds' }),
      ...(options.holdStopWaitMs === undefined ? {} : { stopWaitMs: options.holdStopWaitMs }),
      ...(options.holdLeaseRenewMs === undefined ? {} : { leaseRenewMs: options.holdLeaseRenewMs }),
    }), { source: SOURCE, dispose: (service) => (service instanceof HoldServiceImpl ? service.dispose() : undefined) });

    // Who works on what with the team (relay spec). The ports are optional: a
    // composition with no coordination gets a service that does nothing.
    bind(t.COORDINATION_SERVICE, (r) => {
      const service = new CoordinationService({
        coordination: r.tryResolve(t.COORDINATION) ?? null,
        control: r.tryResolve(t.COORDINATION_CONTROL) ?? null,
        missions: r.resolve(t.MISSION_REPOSITORY),
        issues: r.resolve(t.ISSUE_REPOSITORY),
        // A mission Start made from a board item claims that item (intake spec §3, Ruling 22).
        trackerItems: { get: (id) => r.tryResolve(it.TRACKER_ITEM_REPOSITORY)?.get(id) },
        repositories: r.resolve(t.REPO_REPOSITORY),
        settings: r.resolve(t.SETTINGS_STORE),
        recorder: r.resolve(t.EVENT_RECORDER),
        cancelMission: (id, reason) => r.resolve(t.MISSION_SERVICE).cancel(id, reason),
        clock: clock(r),
        log: log(r).child({ component: 'coordination' }),
      });
      r.resolve(t.EVENT_BUS).subscribe((record) => { void service.onEvent(record); });
      return service;
    }, { source: SOURCE });

    bind(t.REFINEMENT_SERVICE, (r) => new RefinementServiceImpl({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      runtimeManager: r.resolve(RUNTIME_MANAGER),
      targetManager: r.resolve(EXECUTION_TARGET_MANAGER),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      parser: r.resolve(t.ARTIFACT_PARSER),
      templates: r.resolve(t.ARTIFACT_TEMPLATES),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      questions: r.resolve(t.MISSION_QUESTION_REPOSITORY),
      readiness: r.resolve(t.READINESS_SERVICE),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      paths: paths(r),
      clock: clock(r),
      log: log(r).child({ component: 'refinement' }),
      // The first refinement converts the uploads when it comes before planning (spec A2).
      intake: (missionId) => r.resolve(t.PLANNING_SERVICE).ensureIntake(missionId),
      // "From GAR-71" on criteria read from the mission's tracker item (#185).
      trackerKey: (missionId) => {
        const itemId = r.resolve(t.MISSION_REPOSITORY).get(missionId)?.trackerItemId ?? null;
        return itemId === null ? null : r.resolve(it.TRACKER_ITEM_REPOSITORY).get(itemId)?.key ?? null;
      },
    }), { source: SOURCE });

    bind(t.LIMIT_SERVICE, (r) => new LimitService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      limits: r.resolve(t.LIMIT_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      approvalFactory: r.resolve(APPROVAL_FACTORY),
      address: (workspaceId) => r.resolve(t.REVIEW_PIPELINE).addressFor(undefined, workspaceId),
      // Resolved per call: the scheduler is built with the executor, which is built with this.
      cancelTask: (taskId) => r.resolve(t.SCHEDULER).cancelTask(taskId),
      wake: () => r.resolve(t.SCHEDULER).wake(),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'limits' }),
    }), { source: SOURCE });

    bind(t.BACKLOG_SERVICE, (r) => new BacklogService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      readiness: r.resolve(t.READINESS_SERVICE),
      planning: r.resolve(t.PLANNING_SERVICE),
      refining: (missionId) => r.resolve(t.REFINEMENT_SERVICE).isRunning(missionId),
      heldBySpend: (workspaceId, priority) => r.resolve(t.LIMIT_SERVICE).heldFor(workspaceId, priority),
      summaries: (workspaceId) => r.resolve(t.MISSION_SERVICE).list({ workspaceId }),
      wake: () => r.resolve(t.SCHEDULER).wake(),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'backlog' }),
    }), { source: SOURCE });

    bind(t.LIVENESS_SERVICE, (r) => new LivenessService({
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      runs: r.resolve(t.RUN_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      readiness: r.resolve(t.READINESS_SERVICE),
      // Resolved per call: planning and refinement are composed after projections, which read this.
      planning: (missionId) => r.resolve(t.PLANNING_SERVICE).isPlanning(missionId),
      refining: (missionId) => r.resolve(t.REFINEMENT_SERVICE).isRunning(missionId),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'liveness' }),
      quietAfterMs: options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS,
      pullRequestOf: (missionId) => {
        const last = openedPullRequests(r, missionId).at(-1);
        return last === undefined ? null : last.url;
      },
    }), { source: SOURCE });

    bind(t.DESK_SERVICE, (r) => new DeskService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      parser: r.resolve(t.ARTIFACT_PARSER),
      measure: r.resolve(t.ARTIFACT_MEASURE),
      gates: r.resolve(t.GATE_SERVICE),
      limits: r.resolve(t.LIMIT_SERVICE),
      liveness: r.resolve(t.LIVENESS_SERVICE),
      // Start moves the tracker refused (#187), resolved per call: the tracker service reads missions through these.
      trackerStalled: (workspaceId) => r.resolve(it.TRACKER_SERVICE).moveRefusals(workspaceId),
      readiness: r.resolve(t.READINESS_SERVICE),
      backlog: (workspaceId) => r.resolve(t.BACKLOG_SERVICE).view(workspaceId),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
    }), { source: SOURCE });

    bind(t.ROUTINE_SERVICE, (r) => new RoutineService({
      factoryEdits: brainEdits(r),
      routines: r.resolve(t.ROUTINE_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      createMission: (caller, request, origin) => r.resolve(t.MISSION_SERVICE).create(caller, request, origin),
      writeStatusReport: (workspaceId, caller) => r.resolve(t.DESK_SERVICE).writeStatusReport(workspaceId, caller),
      monthHardStop: (workspaceId) => {
        const { level, status } = r.resolve(t.LIMIT_SERVICE).monthLevel(workspaceId);
        return level === 'hard' && status !== null ? reachedReason(status, 'month') : null;
      },
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'routines' }),
    }), { source: SOURCE });

    // Desktop notifications (P16): the Inbox diffed against what was announced, kept in settings.json.
    bind(t.NOTIFICATION_SERVICE, (r) => new NotificationService({
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      settings: r.resolve(t.SETTINGS_STORE),
      inbox: (workspaceId) => r.resolve(t.PROJECTION_SERVICE).inbox(workspaceId),
      clock: clock(r),
    }), { source: SOURCE });

    // P14: the daemon rebinds this with `gh`; without it every check says so.
    bind(t.ISSUE_TRACKER, (): IssueTrackerPort => {
      const missing = async (): Promise<never> => { throw new TandemiseError('INTEGRATION_FAILED', 'GitHub issues cannot be read in this build.'); };
      return { listOpen: missing, view: missing, viewer: missing, comments: missing, postComment: missing, updateComment: missing, close: missing };
    }, { source: SOURCE });

    // P3: the daemon rebinds this with `gh`; without it no link resolves, and
    // a hand-back needs an export.
    bind(t.PULL_REQUEST_SNAPSHOTS, (): PullRequestSnapshotPort => ({ read: async () => null }), { source: SOURCE });

    bind(t.CONTRIBUTION_SERVICE, (r) => new ContributionServiceImpl({
      missions: r.resolve(t.MISSION_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      snapshots: r.resolve(t.PULL_REQUEST_SNAPSHOTS),
      artifactRoot: (workspaceId) => paths(r).artifacts(workspaceId),
      // The same runner as `gh`, so a pull request's head is fetched with the daemon's own git and environment.
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      // Bound by the daemon to what its own environment carries; empty elsewhere.
      ...(r.has(t.GIT_CREDENTIAL_ENV) ? { credentialEnv: r.resolve(t.GIT_CREDENTIAL_ENV) } : {}),
    }), { source: SOURCE });

    bind(t.ISSUE_SERVICE, (r) => new IssueService({
      issues: r.resolve(t.ISSUE_REPOSITORY),
      tracker: r.resolve(t.ISSUE_TRACKER),
      repositories: r.resolve(t.REPO_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      createMission: (caller, request, origin) => r.resolve(t.MISSION_SERVICE).create(caller, request, origin),
      setQueued: (missionId, queued) => { r.resolve(t.BACKLOG_SERVICE).update(missionId, { queued }); },
      trace: (missionId) => r.resolve(t.GATE_SERVICE).trace(missionId).trace,
      stalled: (missionId) => {
        const verdict = r.resolve(t.LIVENESS_SERVICE).classify(missionId);
        return verdict.kind === 'stalled' ? { reason: verdict.reason ?? 'It is stalled.', action: verdict.action?.label ?? null } : null;
      },
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'issues' }),
      // "Use these issues as your tracker" (intake plan Task 10).
      intakeConfig: r.resolve(it.INTAKE_CONFIG_SOURCE),
      intake: r.resolve(it.INTAKE_REPOSITORY),
    }), { source: SOURCE });

    // Intake (spec 2026-10-30-intake-design.md, plan Task 3). The config comes
    // from the local settings until the brain (#51) rebinds the source; inline
    // attachments stay in memory unless the daemon gives them a disk.
    bind(it.INTAKE_CONFIG_SOURCE, (r) => new LinkedIntakeConfigSource({
      local: new LocalIntakeConfigSource({
        settings: r.resolve(t.SETTINGS_STORE),
        log: log(r).child({ component: 'intake' }),
      }),
      // A project linked to a brain (#51) reads factory/tracker.yaml and
      // factory/intake.yaml from it (Ruling 21); the others stay local.
      // Resolved per call: the brain's service depends on intake through P14.
      brain: {
        originFor: (ws) => r.tryResolve(BRAIN_INTAKE_CONFIG)?.originFor(ws) ?? 'local',
        read: (ws) => r.resolve(BRAIN_INTAKE_CONFIG).read(ws),
      },
      log: log(r).child({ component: 'intake' }),
    }), { source: SOURCE });
    bind(it.INTAKE_BLOBS, () => new MemoryBlobs(), { source: SOURCE });
    // The tracker per project (plan Task 5): each provider module contributes
    // its kind's factory; the credential comes from the local secret store.
    bind(it.TRACKER_RESOLVER, (r) => new TrackerResolver({
      config: r.resolve(it.INTAKE_CONFIG_SOURCE),
      secrets: r.resolve(t.SECRET_STORE),
      // Ruling 23: the credential is bound to the address it was saved for.
      origins: r.resolve(it.INTAKE_REPOSITORY).credentialOrigins,
      factories: () => r.resolveAll(PRIMARY_TRACKER_FACTORIES),
      log: log(r).child({ component: 'intake' }),
    }), { source: SOURCE });
    // Dedupe's scorer (plan Task 7): lexical, deterministic.
    bind(it.INTAKE_SIMILARITY, () => ({ score: (signal, candidate) => lexicalSimilarity(signal, candidate) }), { source: SOURCE });
    // The relay's claims (spec §3, Ruling 22): Start claims ('tracker_item', ref)
    // and a runner runs only under its source's lease. Without the relay
    // every claim is granted: Start re-reads the item instead.
    bind(it.INTAKE_CLAIMS, (r) => ({
      source: (workspaceId, sourceId) => r.resolve(t.COORDINATION_SERVICE).sourceClaim(workspaceId, sourceId),
      item: (input) => r.resolve(t.COORDINATION_SERVICE).claimItem(input),
      releaseItem: (itemRef, reason, localRef) => r.resolve(t.COORDINATION_SERVICE).releaseItem(itemRef, reason, localRef),
    }), { source: SOURCE });
    bind(it.INTAKE_SERVICE, (r) => new IntakeService({
      intake: r.resolve(it.INTAKE_REPOSITORY),
      config: r.resolve(it.INTAKE_CONFIG_SOURCE),
      trackers: r.resolve(it.TRACKER_RESOLVER),
      // A source's default API base, where its secrets are bound (Ruling 23).
      runners: () => r.resolveAll(INTAKE_RUNNERS),
      // A source's secrets (plan Task 11).
      secrets: r.resolve(t.SECRET_STORE),
      items: r.resolve(it.TRACKER_ITEM_REPOSITORY),
      similarity: r.resolve(it.INTAKE_SIMILARITY),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      projections: r.resolve(t.PROJECTION_BUS),
      blobs: r.resolve(it.INTAKE_BLOBS),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      clock: clock(r),
      log: log(r).child({ component: 'intake' }),
      // Resolved per call: the tracker service is composed after this one (#134).
      trackerChanged: (workspaceId) => r.resolve(it.TRACKER_SERVICE).trackerChanged(workspaceId),
    }), { source: SOURCE });
    // The board and Start (plan Task 8): missions are made only through the
    // mission service, resolved per call since it is composed with the API services.
    bind(it.TRACKER_SERVICE, (r) => new TrackerService({
      config: r.resolve(it.INTAKE_CONFIG_SOURCE),
      trackers: r.resolve(it.TRACKER_RESOLVER),
      items: r.resolve(it.TRACKER_ITEM_REPOSITORY),
      intake: r.resolve(it.INTAKE_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      createMission: (caller, request, origin) => r.resolve(t.MISSION_SERVICE).create(caller, request, origin),
      planDraft: (missionId) => r.resolve(t.PLANNING_SERVICE).begin(missionId),
      // Refine on a draft item (#135), resolved per call like the mission service.
      refinement: {
        begin: (caller, missionId) => r.resolve(t.REFINEMENT_SERVICE).begin(caller, missionId),
        view: (missionId) => r.resolve(t.REFINEMENT_SERVICE).view(missionId),
      },
      claims: r.resolve(it.INTAKE_CLAIMS),
      settings: r.resolve(t.SETTINGS_STORE),
      members: r.resolve(t.MEMBER_REPOSITORY),
      people: r.resolve(t.PERSON_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      tasks: r.resolve(t.TASK_REPOSITORY),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      trace: (missionId) => r.resolve(t.GATE_SERVICE).trace(missionId).trace,
      projections: r.resolve(t.PROJECTION_BUS),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      clock: clock(r),
      log: log(r).child({ component: 'intake' }),
      // Resolved per call: the closure service reaches the runner host, which reads this board (plan Task 13).
      detectClosures: (workspaceId, items) => r.resolve(it.CLOSURE_SERVICE).detect(workspaceId, items),
    }), { source: SOURCE });
    // The shipped runners (plan Task 10): contributed by the provider modules,
    // read per pass, driven from the scheduler's `syncIntake`.
    bind(it.INTAKE_RUNNER_HOST, (r) => new IntakeRunnerHost({
      runners: () => r.resolveAll(INTAKE_RUNNERS),
      config: r.resolve(it.INTAKE_CONFIG_SOURCE),
      intake: r.resolve(it.INTAKE_REPOSITORY),
      pipeline: r.resolve(it.INTAKE_SERVICE),
      board: r.resolve(it.TRACKER_SERVICE),
      claims: r.resolve(it.INTAKE_CLAIMS),
      mailbox: r.resolve(it.WEBHOOK_MAILBOX),
      // The team's mailbox (Ruling 24), resolved per call like INTAKE_CLAIMS.
      relayMailbox: {
        available: () => r.resolve(t.COORDINATION_SERVICE).available,
        projectKey: (workspaceId) => r.resolve(t.COORDINATION_SERVICE).projectKey(workspaceId),
        pull: (projectKey, max, leaseSeconds) => r.resolve(t.COORDINATION_SERVICE).pull(projectKey, max, leaseSeconds),
        ack: (ids) => r.resolve(t.COORDINATION_SERVICE).ack(ids),
      },
      secrets: r.resolve(t.SECRET_STORE),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      clock: clock(r),
      log: log(r).child({ component: 'intake' }),
    }), { source: SOURCE });
    // Closing the loop (plan Task 13): the board refresh detects, the scheduler's
    // `syncIntake` ticks, and each closure goes to its runner through the host.
    bind(it.CLOSURE_SERVICE, (r) => new ClosureService({
      intake: r.resolve(it.INTAKE_REPOSITORY),
      config: r.resolve(it.INTAKE_CONFIG_SOURCE),
      items: r.resolve(it.TRACKER_ITEM_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      closer: r.resolve(it.INTAKE_RUNNER_HOST),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      projections: r.resolve(t.PROJECTION_BUS),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      clock: clock(r),
      log: log(r).child({ component: 'intake' }),
    }), { source: SOURCE });

    // Default: no disk. The daemon rebinds it; a harness without one can still
    // compose, and setup as code answers that there is no folder.
    bind(t.SETUP_FOLDER, () => ({
      read: async () => null,
      stage: async () => ({ commit: async () => {}, discard: async () => {} }),
      gitWarnings: async () => [],
    }), { source: SOURCE });

    bind(t.SETUP_SERVICE, (r) => new SetupService({
      workspaces: r.resolve(t.WORKSPACE_SERVICE),
      repositories: r.resolve(t.REPO_REPOSITORY),
      roles: r.resolve(t.ROLE_SERVICE),
      runtimeProfiles: r.resolve(t.RUNTIME_PROFILE_REPOSITORY),
      routines: r.resolve(t.ROUTINE_REPOSITORY),
      routineService: r.resolve(t.ROUTINE_SERVICE),
      skills: r.resolve(t.SKILL_SERVICE),
      issueSettings: r.resolve(t.ISSUE_REPOSITORY),
      issues: r.resolve(t.ISSUE_SERVICE),
      integrations: r.resolve(t.INTEGRATION_REPOSITORY),
      workflows: r.resolve(t.WORKFLOW_SOURCE),
      brain: brainWorkflows(r),
      folder: r.resolve(t.SETUP_FOLDER),
      settings: r.resolve(t.SETTINGS_STORE),
      unitOfWork: r.resolve(t.UNIT_OF_WORK),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      log: log(r).child({ component: 'setup' }),
    }), { source: SOURCE });

    bind(t.CRITERIA_SERVICE, (r) => new CriteriaServiceImpl({
      missions: r.resolve(t.MISSION_REPOSITORY),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      gates: r.resolve(t.GATE_SERVICE),
    }), { source: SOURCE });

    // Default: fails loudly, the way ISSUE_TRACKER's default does. Content-addressed
    // eval case inputs (P3b) are really disk under the daemon, which rebinds this;
    // a working in-memory default would let a composition that forgot to rebind
    // silently lose a case's inputs instead of telling anyone.
    bind(t.EVAL_BLOBS, () => ({
      put: async (): Promise<string> => {
        throw new TandemiseError('INTEGRATION_FAILED', 'Eval inputs cannot be stored in this build.');
      },
      get: async (): Promise<Uint8Array | null> => null,
      has: async (): Promise<boolean> => false,
    }), { source: SOURCE });

    bind(t.EVAL_SERVICE, (r) => new EvalService({
      evals: r.resolve(t.EVAL_REPOSITORY),
      runScores: r.resolve(t.RUN_SCORE_REPOSITORY),
      blobs: r.resolve(t.EVAL_BLOBS),
      artifacts: r.resolve(t.ARTIFACT_REPOSITORY),
      artifactStore: r.resolve(t.ARTIFACT_STORE),
      runs: r.resolve(t.RUN_REPOSITORY),
      runInputs: r.resolve(t.RUN_INPUT_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      missions: r.resolve(t.MISSION_REPOSITORY),
      repositories: r.resolve(t.REPO_REPOSITORY),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      decisions: r.resolve(t.DECISION_REPOSITORY),
      questions: r.resolve(t.MISSION_QUESTION_REPOSITORY),
      criteria: r.resolve(t.MISSION_CRITERIA_REPOSITORY),
      // The same runner as contributions, so a case's base commit is resolved with the daemon's own git.
      exec: r.tryResolve(INTEGRATION_COMMAND_EXECUTOR) ?? null,
      clock: clock(r),
      roles: r.resolve(t.ROLE_REPOSITORY),
      skills: r.resolve(t.SKILL_SERVICE),
      readSetupFolder: (path) => r.resolve(t.SETUP_SERVICE).readFolder(path),
      readBrainCandidate: (workspaceId, ref) => r.resolve(BRAIN_SERVICE).candidateAt(workspaceId, ref),
      // Lazily: the runner is composed from the executor, which nothing here needs until a run starts.
      runner: () => r.resolve(t.EVAL_RUNNER),
    }), { source: SOURCE });

    bind(t.FACTORY_SERVICE, (r) => new FactoryService({
      planner: r.resolve(t.PLANNER_SERVICE),
      planning: r.resolve(t.PLANNING_SERVICE),
      projections: r.resolve(t.PROJECTION_SERVICE),
      readiness: r.resolve(t.READINESS_SERVICE),
      missions: r.resolve(t.MISSION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      planDecisions: r.resolve(t.PLAN_DECISION_REPOSITORY),
      events: r.resolve(t.EVENT_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      approvals: r.resolve(t.APPROVAL_REPOSITORY),
      mergeDecisions: r.resolve(t.MERGE_DECISION_REPOSITORY),
      factorySource: r.resolve(t.FACTORY_CONFIG_SOURCE),
    }), { source: SOURCE });

    bind(t.MERGE_POLICY_SERVICE, (r) => new MergePolicyService({
      planner: r.resolve(t.PLANNER_SERVICE),
      factorySource: r.resolve(t.FACTORY_CONFIG_SOURCE),
      workspaces: r.resolve(t.WORKSPACE_REPOSITORY),
      mergeDecisions: r.resolve(t.MERGE_DECISION_REPOSITORY),
      outcomes: r.resolve(t.OUTCOME_REPOSITORY),
      decisions: r.resolve(t.DECISION_REPOSITORY),
      tasks: r.resolve(t.TASK_REPOSITORY),
      members: r.resolve(t.MEMBER_REPOSITORY),
      recorder: r.resolve(t.EVENT_RECORDER),
      clock: clock(r),
      wake: () => r.resolve(t.SCHEDULER).wake(),
      brainLinked: (workspaceId) => r.tryResolve(BRAIN_SERVICE)?.linkOf(workspaceId) !== undefined,
      cancelQueued: (decision) => r.resolve(t.SHIP_SERVICE).cancelQueued(decision),
    }), { source: SOURCE });

    bind(t.TANDEMISE_SERVICES, (r): TandemiseServices => ({
      system: r.resolve(t.SYSTEM_SERVICE),
      workspaces: r.resolve(t.WORKSPACE_SERVICE),
      workflows: r.resolve(t.WORKFLOW_SERVICE),
      missions: r.resolve(t.MISSION_SERVICE),
      planning: r.resolve(t.PLANNING_SERVICE),
      approvals: r.resolve(t.APPROVAL_SERVICE),
      artifacts: r.resolve(t.ARTIFACT_SERVICE),
      runtimes: r.resolve(t.RUNTIME_SERVICE),
      roles: r.resolve(t.ROLE_SERVICE),
      integrations: r.resolve(t.INTEGRATION_SERVICE),
      projections: r.resolve(t.PROJECTION_SERVICE),
      identity: r.resolve(t.IDENTITY),
      team: r.resolve(t.TEAM_SERVICE),
      staffing: r.resolve(t.STAFFING_SERVICE),
      feedback: r.resolve(t.FEEDBACK_SERVICE),
      criteria: r.resolve(t.CRITERIA_SERVICE),
      refinement: r.resolve(t.REFINEMENT_SERVICE),
      backlog: r.resolve(t.BACKLOG_SERVICE),
      limits: r.resolve(t.LIMIT_SERVICE),
      liveness: r.resolve(t.LIVENESS_SERVICE),
      desk: r.resolve(t.DESK_SERVICE),
      routines: r.resolve(t.ROUTINE_SERVICE),
      notifications: r.resolve(t.NOTIFICATION_SERVICE),
      skills: r.resolve(t.SKILL_SERVICE),
      issues: r.resolve(t.ISSUE_SERVICE),
      setup: r.resolve(t.SETUP_SERVICE),
      factory: r.resolve(t.FACTORY_SERVICE),
      mergePolicy: r.resolve(t.MERGE_POLICY_SERVICE),
      shipActions: {
        merge: async (decisionId, caller) => {
          const decision = r.resolve(t.MERGE_DECISION_REPOSITORY).get(decisionId);
          const card = decision === undefined ? undefined : r.resolve(t.APPROVAL_REPOSITORY).list({ missionId: decision.missionId, statuses: ['PENDING'] })
            .find((a) => a.evidence.some((e) => e.label === 'Decision' && e.value === decisionId));
          if (card === undefined) throw new TandemiseError('CONFLICT', 'This pull request isn\'t waiting for your review any more.');
          return r.resolve(t.APPROVAL_SERVICE).decide(caller, card.id, { optionId: 'approve' });
        },
        revert: async (decisionId, caller) => {
          const decision = r.resolve(t.MERGE_DECISION_REPOSITORY).get(decisionId);
          if (decision === undefined) throw TandemiseError.notFound('Merge decision', decisionId);
          const { actorId } = actorFor({ members: r.resolve(t.MEMBER_REPOSITORY) }, decision.workspaceId, caller);
          return r.resolve(t.SHIP_REVERT).revert(decisionId, actorId);
        },
      },
      contributions: r.resolve(t.CONTRIBUTION_SERVICE),
      evals: r.resolve(t.EVAL_SERVICE),
      intake: r.resolve(it.INTAKE_SERVICE),
      tracker: r.resolve(it.TRACKER_SERVICE),
      intakeRunners: r.resolve(it.INTAKE_RUNNER_HOST),
      closures: r.resolve(it.CLOSURE_SERVICE),
      holds: r.resolve(t.HOLD_SERVICE),
      brain: r.resolve(BRAIN_SERVICE),
      coordination: r.resolve(t.COORDINATION_SERVICE),
    }), { source: SOURCE });

    bindBrain(container);
  });
}

/** Convenience binding for composition roots with no scheduler override. */
export const applicationModule: TandemiseModule = createApplicationModule();

/** The mission's `ship.pr_opened` events, oldest first: the pull requests it opened, or its CI wait found (#143). */
function openedPullRequests(r: Resolver, missionId: string): readonly (import('./engine/ship.js').OpenedPullRequest & { readonly url: string })[] {
  return r.resolve(t.EVENT_REPOSITORY).listByMission(asId<'MissionId'>(missionId), { semanticOnly: true }).flatMap((e) => (e.body.type === 'ship.pr_opened'
    ? [{ repo: e.body.repo, number: e.body.number, url: e.body.url, headSha: e.body.headSha, foundBy: e.body.foundBy ?? null }]
    : []));
}

/**
 * What the ship step's pull request says beyond the plan (#113): the latest
 * change set's headline and points, the tracker item the mission came from,
 * one sentence per hold, and whether QA reported.
 */
function shipPrFacts(r: Resolver, mission: import('@tandemise/domain').Mission): import('./engine/ship.js').PrFacts {
  const artifacts = r.resolve(t.ARTIFACT_REPOSITORY);
  const change = artifacts.latest(mission.id, 'ChangeSet');
  const summary = change === undefined ? null
    : change.handoff != null ? { headline: change.handoff.headline, points: change.handoff.points }
      : change.summary !== null ? { headline: change.summary, points: [] } : null;
  const item = mission.trackerItemId == null ? undefined : r.tryResolve(it.TRACKER_ITEM_REPOSITORY)?.get(mission.trackerItemId);
  const label = item === undefined ? '' : /^https:\/\/github\.com\//.test(item.url) ? 'GitHub' : /youtrack/i.test(item.url) ? 'YouTrack' : 'Tracker item';
  const tasks = new Map(r.resolve(t.TASK_REPOSITORY).listByMission(mission.id).map((task) => [task.id, task.title]));
  const members = r.resolve(t.MEMBER_REPOSITORY);
  const holds = (r.tryResolve(t.TASK_HOLD_REPOSITORY)?.listByMission(mission.id) ?? [])
    .filter((h) => h.endedAt !== null)
    .map((h) => `${members.get(h.heldBy)?.name ?? 'A person'} held ${tasks.get(h.taskId) ?? 'a step'}: ${describeHoldEnd(h)}`);
  return {
    summary,
    issue: item === undefined ? null : { label, key: item.key, url: item.url },
    holds,
    qaReported: artifacts.latest(mission.id, 'QAReport') !== undefined,
    trackerType: item?.type ?? null,
  };
}

/**
 * The application's public surface, assembled.
 *
 * A function rather than a token lookup at the call site because this is the
 * one thing the daemon genuinely needs from the container, and `createServices`
 * reads as what it is: "give me the API".
 */
export function createServices(container: Container): TandemiseServices {
  return container.resolve(t.TANDEMISE_SERVICES);
}

/** The factory a run's tool surface comes from; a held task's terminal gets its surface from the same one. */
const mcpGateway = (r: Resolver): McpGatewayProvisioner => new McpGatewayProvisioner({
  broker: r.tryResolve(TOOL_BROKER) ?? null,
  exec: () => r.resolve(INTEGRATION_COMMAND_EXECUTOR),
  paths: paths(r),
  clock: clock(r),
  log: log(r).child({ component: 'mcp-gateway' }),
});

const log = (r: Resolver): Logger => r.tryResolve(EXECUTION_LOGGER) ?? nullLogger;
const clock = (r: Resolver): Clock => r.tryResolve(EXECUTION_CLOCK) ?? systemClock;
const paths = (r: Resolver): TandemisePaths => r.tryResolve(EXECUTION_PATHS) ?? createPaths();
