import type {
  Approval, ApprovalRepositoryPort, ArtifactManifest, ArtifactRepositoryPort, ArtifactStorePort, ArtifactType,
  AssignmentRepositoryPort, CapabilityGrant, CheckResult, CheckpointRepositoryPort,
  Decision, DecisionRepositoryPort, EventRepositoryPort, ExecutionTargetRepositoryPort, ExecutionTargetRecord, ExternalRef,
  CriteriaTrace, GateFacts, GateOutcome, LimitPressure, LoadedArtifact, Member, MemberRepositoryPort, Mission, MissionCriterion, MissionQuestionRepositoryPort, MissionRepositoryPort, MissionTask, RepoRepositoryPort,
  Repository, ResourceLease, RoleRepositoryPort, RoleTemplate, Run, RunEventRecord, RunInputRepositoryPort, RunPurpose,
  ResolvedModel, RunRepositoryPort, RunScoreRepositoryPort, RunSkill, RunUsage, SkillFile, SkillPin, TracedCriterion,
  RuntimeProfile, RuntimeProfileRepositoryPort, TargetKind, TaskHold, TaskHoldRepositoryPort, TaskRepositoryPort, TaskStatus,
  Workspace, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  ACCEPT_RESULT_OPTION, ARTIFACT_OUT_DIR, CORE_CAPABILITIES, RUNTIME_ACTOR, SKILL_NOT_LOADED, anyCapabilityMatches, stepSkillArgs, stepSkillInstructions, gateDependencies, indexTeam, isActiveMember, isTrialMission, missingSkillReason, resolveModel, responsibleFor,
} from '@tandemise/domain';
import { isDaemonStopping } from '../support/shutdown.js';
import { isTaskHeld } from '../support/held.js';
import { NO_SKILLS, type InstalledSkills, type SkillInstaller } from './skill-installer.js';
import { LIVE_RUN_STATUSES } from '../support/downstream.js';
import { liveArtifacts, upstreamTaskIds } from '../support/lineage.js';
import { githubSlug } from '../support/repository-slug.js';
import { STEP_CAPABILITIES_LABEL } from '../support/tool-policy.js';
import { capDraft, renderRoundBrief, roundRequest, type RoundBrief } from '../support/feedback-rules.js';
import type { ContextCompiler, ExpectedArtifact } from '@tandemise/context';
import type { ExecutionTarget, ExecutionTargetManager } from '@tandemise/execution-core';
import type { ApprovalFactory, GrantBuilder, PolicyEngine } from '@tandemise/policy';
import type { ToolBroker } from '@tandemise/integrations-core';
import { McpGatewayProvisioner, NO_TOOL_SURFACE, type RunToolSurface } from './mcp-gateway.js';
import { RUNTIME_SIGNED_OUT, SESSION_NOT_FOUND, describeRejections, onlyBusy, onlyWaiting } from '@tandemise/runtimes-core';
import type { RunRequest, RunSkillRequest, RuntimeManager, RuntimeSelection, SlotReservation, SlotRetention } from '@tandemise/runtimes-core';
import type { ArtifactId, Clock, Logger, MissionId, RunId, TandemisePaths, TaskId } from '@tandemise/shared';
import { TandemiseError, errorMessage, ids, slugify, summarize } from '@tandemise/shared';
import type { ArtifactMeasurePort, ArtifactTemplatePort } from '../ports.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { runtimeCapabilitiesFor } from '../support/capabilities.js';
import type { RuntimeOverrides } from '../support/runtime-overrides.js';
import { ArtifactHarvester, outDirFor, type HarvestResult, type OverBudgetArtifact } from './harvester.js';
import type { CheckService, PlannedCheck } from './checks.js';
import { personSaidSection, readPersonSaid } from '../support/hold-steer.js';
import type { GateService } from './gates.js';
import type { ReviewPipeline } from './reviews.js';
import type { FeedbackRounds } from './feedback-rounds.js';
import { MAX_PARKED_MS, type RunDeadlines } from './run-deadline.js';

/** How long a resource lease is held before the scheduler must renew it. */
const LEASE_TTL_MS = 30 * 60_000;

/**
 * How often a task waiting on a person's action at the runtime - a sign-in - is
 * offered again. Each offer costs only a cached health read until the runtime's
 * own unavailability window lapses, so this bounds latency, not load.
 */
const AWAITING_PERSON_RETRY_MS = 15_000;

/**
 * The longest a task waits between tries after its runs keep reporting a
 * sign-in failure. The adapter normally throttles by marking itself
 * unavailable; this bounds the cost when one does not, without ever turning a
 * wait for a person into a failure.
 */
const MAX_SIGNED_OUT_BACKOFF_MS = 10 * 60_000;

/**
 * The most passes one attempt spends delivering notes that arrived while it
 * ran. A person who keeps adding notes could otherwise hold the task running
 * forever; later notes wait as open, with "Start round" (plan ruling 7).
 */
const MAX_FEEDBACK_PASSES = 5;

/**
 * What the agent is told when it continues the session a person held (spec
 * "Continue"). The session already holds everything the person and the agent
 * said; the prompt only hands the work back.
 */
/** The file tools a step writes its artifact with. */
const FILE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit'];

/** Documents that describe what to build; a role that consumes them is always handed them (#191). */
const PLANNING_ARTIFACTS: readonly ArtifactType[] = ['ProblemBrief', 'ProductSpec', 'DesignBrief', 'ArchitecturePlan', 'ImplementationPlan'];

export const CONTINUATION_PROMPT = 'A person held this task and worked with you directly in this session. '
  + 'Their changes are in the worktree. Continue the task from where things stand now and finish it.';

/**
 * What a person's terminal on a held task works in (spec "Hold, in order",
 * step 4): the target an attempt would use and the grants it would get.
 */
export interface HoldPreparation {
  readonly target: ExecutionTarget;
  /** The attempt's grants, minus `human.ask`: the person is already in the session. */
  readonly grants: readonly CapabilityGrant[];
  readonly allowedRoots: readonly string[];
  /** The task's normal prompt, for a session that starts fresh; `tools` are the hold gateway's. */
  prompt(tools: readonly string[]): Promise<string>;
  /** Gives the target back the way an attempt does, skills and all; a worktree stays on disk. */
  release(): Promise<void>;
}

/** The checkout leases a hold keeps for as long as it lasts, as an attempt keeps them for its run. */
export interface HoldLeases {
  /** Extends them; false when one was lost (it expired and someone else took it). */
  renew(): boolean;
  release(): void;
}

/** How often a hold renews its leases: well inside their TTL. */
export const HOLD_LEASE_RENEW_MS = 10 * 60_000;

export type TaskAttemptOutcome =
  /** Admission failed for a reason that will resolve on its own. Try again shortly. */
  | {
      readonly kind: 'deferred';
      readonly reason: string;
      /** How long to wait before offering the task again; the scheduler's default when absent. */
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'settled';
      readonly status: TaskStatus;
      readonly reason: string | null;
      /** Delay before the scheduler may dispatch this task again. */
      readonly retryAfterMs?: number;
    };

/** What the executor asks of the limit rule (P8). */
export interface LimitGuard {
  /** Null when work may start in the mission's scopes; otherwise why not (and the stop is applied). */
  admit(missionId: MissionId): string | null;
  /** Measures the mission and its project after a run's usage was recorded; warns or stops. */
  afterUsage(missionId: MissionId, finishedRunId: RunId): void;
  /** The limit furthest past its warning level, or null (P12: the economy model rule). Optional for older harnesses. */
  pressure?(missionId: MissionId): LimitPressure | null;
}

export interface TaskExecutorDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly assignments: AssignmentRepositoryPort;
  readonly targets: ExecutionTargetRepositoryPort;
  readonly leases: import('@tandemise/domain').LeaseRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly approvals: ApprovalRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  /** The agent members a task's staffing names, and their owners. */
  readonly members: MemberRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly checkpoints: CheckpointRepositoryPort;
  readonly runtimeManager: RuntimeManager;
  readonly targetManager: ExecutionTargetManager;
  readonly contextCompiler: ContextCompiler;
  readonly grantBuilder: GrantBuilder;
  /** The decision point every capability this attempt is given must survive. */
  readonly policy: PolicyEngine;
  readonly approvalFactory: ApprovalFactory;
  /** Null when no integration surface is composed; the run simply gets no tools. */
  readonly toolBroker: ToolBroker | null;
  /** Builds the run-scoped MCP surface so a worker can actually call a tool. */
  readonly mcpGateway: McpGatewayProvisioner;
  readonly overrides: RuntimeOverrides;
  readonly templates: ArtifactTemplatePort;
  /** Word budgets, stated in the output contract. */
  readonly measure: ArtifactMeasurePort;
  /** The durable log, read to learn whether this round already had its tighten pass. */
  readonly events: EventRepositoryPort;
  readonly harvester: ArtifactHarvester;
  readonly checks: CheckService;
  readonly gates: GateService;
  /** What the person answered while the request was refined; optional for harnesses built before P6. */
  readonly questions?: Pick<MissionQuestionRepositoryPort, 'listByMission'>;
  /** Who looks at a passed round, and who every card about a task is addressed to. */
  readonly reviews: ReviewPipeline;
  /** Reads a round's brief and contract, and settles the notes a pass answered. */
  readonly rounds: FeedbackRounds;
  /** What each run was given, so a round knows whose work used the old version. */
  readonly runInputs: RunInputRepositoryPort;
  /** A person's holds: the session the next pass continues and the profile it runs on. */
  readonly holds: TaskHoldRepositoryPort;
  readonly recorder: EventRecorder;
  /** Live run budgets, so a worker waiting on a person is not timed out. */
  readonly deadlines: RunDeadlines;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  /**
   * Hard limits (P8): refuses to start a run in a mission or project at its
   * limit, and is told after every run's usage is recorded. Optional so
   * harnesses built before limits still compose; the module always passes it.
   */
  readonly limits?: LimitGuard;
  /**
   * The skills library (P13): a task's pins and their verified content.
   * Optional so harnesses built before skills still compose; the module always
   * passes it, together with the installer.
   */
  readonly skills?: SkillSupply;
  readonly skillInstaller?: SkillInstaller;
  /** The tracker item a mission came from, for a step skill's `{{item.key}}` (#131). Optional for older harnesses. */
  readonly trackerItems?: { get(id: string): { readonly key: string; readonly url: string; readonly title: string } | undefined };
  /**
   * Where a run's measured facts are kept (P3b). Optional so harnesses built
   * before evals still compose; the module always passes it. Scoring never
   * fails the run, so its absence just means nothing is kept.
   */
  readonly runScores?: RunScoreRepositoryPort;
  /**
   * What an eval trial replays instead of the live project (P3b): its frozen
   * role, knowledge, decisions and answers. Asked only for a trial mission;
   * absent (or null for a trial) outside the eval runner.
   */
  readonly trialContext?: (mission: Mission) => TrialContext | null;
  /** The project's brain (#51): rules and lessons for the prompt, recorded on the run. Optional. */
  readonly brain?: Pick<import('../brain/context-supply.js').BrainContextSupply, 'forAttempt'>;
  readonly log: Logger;
}

/** What an eval trial replays instead of the live project (P3b). Null for every real mission. */
export interface TrialContext {
  readonly role: RoleTemplate;
  readonly knowledge: Workspace['knowledge'];
  readonly decisions: readonly Decision[];
  readonly answers: readonly { readonly key: string; readonly text: string; readonly answer: string }[];
  /** A `brain` candidate's rules (#51): the trial reads these, and no lessons. */
  readonly brainRules?: readonly { readonly path: string; readonly text: string }[];
}

/** What the executor asks of the skills library (P13). */
export interface SkillSupply {
  /** The pins a task gets from its role and step, `latest` made concrete; problems name what could not be pinned. */
  pinsFor(
    workspaceId: import('@tandemise/shared').WorkspaceId,
    role: RoleTemplate | undefined,
    step: { readonly key: string; readonly skillRefs?: readonly import('@tandemise/domain').SkillRef[] },
  ): { readonly pins: readonly SkillPin[]; readonly problems: readonly string[] };
  /** Pins whose content is not in the store, or no longer hashes to its pin. */
  missing(pins: readonly SkillPin[]): Promise<readonly SkillPin[]>;
  /** A pin's content, verified against its hash; null when missing. */
  content(hash: string): Promise<readonly SkillFile[] | null>;
}

/**
 * One attempt at one task, start to finish (APPLICATION_DESIGN.md §Task
 * lifecycle).
 *
 * The rule that shapes every method here: **persist the state transition before
 * the side effect it authorizes.** The task is RUNNING in the database before
 * the worker is launched; the target row exists as PROVISIONING before the
 * worktree is created; the run row exists before the adapter is asked for a
 * single event. A daemon that dies at any await therefore leaves a record that
 * recovery can interpret, rather than an orphan nothing knows about.
 *
 * The second rule: **every runtime event is persisted and published as it
 * arrives.** Batching them at the end would be faster and would lose the entire
 * timeline of any run that crashes - which is exactly the run whose timeline
 * matters most.
 */
export class TaskExecutor {
  constructor(private readonly deps: TaskExecutorDeps) {}

  async execute(taskId: TaskId, signal: AbortSignal): Promise<TaskAttemptOutcome> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(this.deps.missions.get(task.missionId), 'Mission', task.missionId);
    const workspace = this.#require(
      this.deps.workspaces.get(mission.workspaceId), 'Workspace', mission.workspaceId,
    );
    const repository = this.#repositoryFor(task, mission);

    const scope: EventScope = {
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: task.id,
      roleId: task.roleId,
    };

    // An eval trial replays the case's frozen setup, never today's project (P3b).
    // A trial with no setup to replay is a runner bug, and running it against
    // the live role would score the wrong thing, so it stops here.
    const trialMission = isTrialMission(mission);
    const trial = trialMission ? this.deps.trialContext?.(mission) ?? null : null;
    if (trialMission && trial === null) return this.#block(task, scope, 'This eval trial lost its setup.');
    const role = trial?.role ?? this.deps.roles.get(task.roleId, workspace.id);
    if (role === undefined) {
      return this.#block(task, scope, `No role template '${task.roleId}' exists in this workspace.`);
    }

    // A round that passed and was mid-tighten when the daemon died is settled
    // from the drafts on record: re-running it would redo accepted work and
    // spend an attempt on a restart.
    const concluded = this.#concludeInterruptedTighten(task, mission, workspace, role, scope);
    if (concluded !== null) return concluded;

    // 12(a). An approval demanded *before* the task starts is checked here
    // rather than in the scheduler, because this is the only place that knows
    // what the task is about to be permitted to do.
    const gateOnStart = this.#approvalBeforeStart(task, mission, workspace, role, scope);
    if (gateOnStart !== null) return gateOnStart;

    // 1. Admission. A mission or project at its limit starts nothing, however
    //    the attempt was reached (P8): the scheduler checks too, and this is
    //    the backstop for any other caller.
    //    An eval trial is bounded by its run's own spend cap instead.
    const overLimit = trialMission ? null : this.deps.limits?.admit(mission.id) ?? null;
    if (overLimit !== null) return { kind: 'deferred', reason: overLimit };
    // 1(b). Skills (P13): a pinned skill whose content is gone refuses the run
    //       before anything is spent on it, naming the skill.
    const skillRefusal = await this.#refuseMissingSkills(task, mission, workspace, role, scope);
    if (skillRefusal !== null) return skillRefusal;
    const leases = this.#acquireLeases(task, mission, repository);
    if (!leases.ok) return { kind: 'deferred', reason: leases.reason };

    try {
      return await this.#run({ task, mission, workspace, repository, role, trial, scope, signal });
    } catch (e) {
      this.deps.log.error('task.attempt_failed', {
        missionId: mission.id, taskId: task.id, error: errorMessage(e),
      });
      // Re-read: `task` is from before the attempt marked it RUNNING, and
      // settling from that stale copy compared READY with READY, skipped the
      // write, and left the row RUNNING with nothing running.
      const current = this.#requireTask(task.id);
      // Moved by someone else while this attempt was failing (a Redo resets it,
      // a park writes AWAITING_EXTERNAL, and the abort can surface as a throw):
      // that status stands, the rule #overtaken and #stopped apply. Only the
      // status the attempt started from is not a decision: a throw before the
      // step was marked RUNNING leaves it READY, and that is still a failure.
      if (!LIVE_RUN_STATUSES.includes(current.status) && current.status !== task.status) {
        return { kind: 'settled', status: current.status, reason: current.statusReason };
      }
      return this.#settleFailure(current, scope, errorMessage(e));
    } finally {
      for (const lease of leases.held) this.deps.leases.release(lease.id);
    }
  }

  // -------------------------------------------------------------------- holds

  /**
   * The profiles a hold on a task with no session yet may open on, in the
   * order an attempt would try them. A retry's runtime override is read, not
   * consumed: the attempt after the hold still gets it.
   */
  holdProfiles(taskId: TaskId): readonly RuntimeProfile[] {
    const task = this.#requireTask(taskId);
    const mission = this.#require(this.deps.missions.get(task.missionId), 'Mission', task.missionId);
    const workspace = this.#require(this.deps.workspaces.get(mission.workspaceId), 'Workspace', mission.workspaceId);
    const routing = this.#candidateProfiles(workspace, task, { peek: true });
    return routing.kind === 'profiles' ? routing.profiles : [];
  }

  /**
   * Why a hold may not start a step that has not run, in the words the
   * attempt would use: a pinned skill missing from the library. Unlike the
   * attempt, nothing is blocked and no card is raised; the hold is refused.
   */
  async holdStartRefusal(taskId: TaskId): Promise<string | null> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(this.deps.missions.get(task.missionId), 'Mission', task.missionId);
    const workspace = this.#require(this.deps.workspaces.get(mission.workspaceId), 'Workspace', mission.workspaceId);
    const role = this.deps.roles.get(task.roleId, workspace.id);
    if (role === undefined) return `No role template '${task.roleId}' exists in this workspace.`;
    return (await this.#missingSkills(task, workspace, role))?.reason ?? null;
  }

  /**
   * The leases an attempt on this task would take, taken for a hold: a person
   * working in a shared checkout takes turns with the agents that do. Refused
   * in the attempt's own words when another task holds one.
   */
  acquireHoldLeases(taskId: TaskId): { ok: true; value: HoldLeases } | { ok: false; reason: string } {
    const task = this.#requireTask(taskId);
    const mission = this.#require(this.deps.missions.get(task.missionId), 'Mission', task.missionId);
    const leases = this.#acquireLeases(task, mission, this.#repositoryFor(task, mission), true);
    if (!leases.ok) return { ok: false, reason: leases.reason };
    const { held } = leases;
    return {
      ok: true,
      value: {
        renew: () => held.every((lease) => this.deps.leases.renew(lease.id, LEASE_TTL_MS)),
        release: () => { for (const lease of held) this.deps.leases.release(lease.id); },
      },
    };
  }

  /**
   * The target and grants a held task's terminal works with, made the way an
   * attempt makes them, so the person's session sees what a run would: the
   * same checkout (a worktree converges on the one already there), the same
   * out folder (kept, as a continuation keeps it), the same pinned skills on
   * `profile`, and the same vetted grants.
   */
  async prepareHold(taskId: TaskId, profile: RuntimeProfile): Promise<{ ok: true; value: HoldPreparation } | { ok: false; reason: string }> {
    const task = this.#requireTask(taskId);
    const mission = this.#require(this.deps.missions.get(task.missionId), 'Mission', task.missionId);
    const workspace = this.#require(this.deps.workspaces.get(mission.workspaceId), 'Workspace', mission.workspaceId);
    const role = this.deps.roles.get(task.roleId, workspace.id);
    if (role === undefined) return { ok: false, reason: `No role template '${task.roleId}' exists in this workspace.` };
    const repository = this.#repositoryFor(task, mission);
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId };
    const kind = targetKindFor(task.executionPolicy.isolation);
    const provisioned = await this.#provisionTarget(
      kind, task, mission, workspace, repository, scope, this.#upstreamChangeBranch(task, mission),
    );
    if (!provisioned.ok) return provisioned;
    const { target } = provisioned;
    let installed: InstalledSkills = NO_SKILLS;
    const release = async (): Promise<void> => {
      // As after a run: a worktree keeps its skills, anywhere else is someone's own folder.
      if (kind !== 'worktree' && installed.written.length > 0) await this.deps.skillInstaller?.remove(target, scope, installed);
      await this.#releaseTarget(target, kind);
    };
    try {
      await this.deps.harvester.prepare(target, scope, task, { keepOwn: true });
      const adapter = this.deps.runtimeManager.registry.tryAdapter(profile.adapterId) ?? {};
      installed = await this.#installSkills(this.#requireTask(task.id), target, profile, adapter, scope);
      const vetted = this.#vet(this.#requestedGrants(role, task, workspace, repository, target), task, workspace, scope);
      if (vetted.blockedOn !== null) {
        await release();
        return { ok: false, reason: vetted.blockedOn };
      }
      const grants = vetted.grants.filter((g) => g.capability !== CORE_CAPABILITIES.humanAsk);
      const ctx: AttemptContext = {
        task, mission, workspace, repository, role, trial: null, scope, signal: new AbortController().signal, skills: installed,
      };
      return {
        ok: true,
        value: {
          target, grants, allowedRoots: allowedRoots(grants, target.workingDirectory), release,
          prompt: async (tools) => (await this.#compilePrompt({ ...ctx, grants, target, tools, feedback: null, round: null })).prompt,
        },
      };
    } catch (e) {
      await release();
      throw e;
    }
  }

  // --------------------------------------------------------------- the attempt

  async #run(ctx: AttemptContext): Promise<TaskAttemptOutcome> {
    const { task, workspace, scope } = ctx;
    const { deps } = this;

    // 2. Routing. A role with an explicit routing policy is never given a
    //    runtime that policy excluded - the fallback is "no candidates", which
    //    blocks with a reason, not a silent substitution.
    const routing = this.#candidateProfiles(workspace, task);
    if (routing.kind === 'nobody_active') {
      // Someone staffed left between promotion and this attempt. The next
      // dispatch sees the stale snapshot and hands the task to a person; widening
      // to any runtime here is exactly what staffing it was meant to prevent.
      return { kind: 'deferred', reason: 'Nobody staffed for this task is active any more.' };
    }
    if (routing.kind === 'no_runtime') {
      const names = routing.agents.map((a) => a.name);
      const who = names.length <= 1 ? names[0] ?? 'The staffed agent' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return this.#block(task, scope, `${who} ${names.length > 1 ? 'have' : 'has'} no enabled runtime.`);
    }
    const { profiles: routed, agents } = routing;
    if (routed.length === 0) {
      return this.#block(task, scope, `No runtime profile is routed to role '${task.roleId}'.`);
    }
    // A hold the agent has not continued from yet pins the pass to the profile
    // holding its session: another profile has another config dir, where the
    // session does not exist. Running it elsewhere would lose what the person
    // did in that session, so a pinned profile no longer routed here blocks
    // the task and the hold waits, unread.
    const continuation = this.#continuationFor(task);
    if (continuation !== null && !routed.some((p) => p.id === continuation.runtimeProfileId)) {
      return this.#block(task, scope, "The runtime holding this task's session is no longer available to its agent.");
    }
    // A session a restart left is continued on the profile that holds it when
    // that profile can take the run; otherwise the attempt starts fresh elsewhere.
    const sessionProfile = continuation?.runtimeProfileId ?? this.#latestResumable(task.id)?.runtimeProfileId ?? null;
    const candidates = continuation !== null
      ? routed.filter((p) => p.id === continuation.runtimeProfileId)
      : [...routed].sort((a, b) => Number(b.id === sessionProfile) - Number(a.id === sessionProfile));
    const required = runtimeCapabilitiesFor(task);
    const selected = await deps.runtimeManager.select(candidates, required);
    // Selection awaits a health probe; a round upstream can hold this task
    // back meanwhile, and starting it then would run on the old version.
    const reset = this.#changedSince(task);
    if (reset !== null) {
      if (selected.ok) selected.value.reservation.release();
      return reset;
    }
    if (!selected.ok) {
      const detail = describeRejections(selected.error.rejections);
      // Every capable runtime is busy: that is contention, not a failure. The
      // task stays READY and is offered again once a slot frees up.
      if (onlyBusy(selected.error)) return { kind: 'deferred', reason: `Waiting for a runtime slot. ${detail}` };
      // A runtime waiting on a person - signed out, most often - will run this
      // task unchanged once they act. Blocking would make them also find and
      // retry every task it stranded; waiting lets the work resume by itself.
      if (onlyWaiting(selected.error)) {
        const action = selected.error.rejections.find((r) => r.awaitingPerson === true)?.reason ?? detail;
        return { kind: 'deferred', reason: `Waiting for you: ${action}`, retryAfterMs: AWAITING_PERSON_RETRY_MS };
      }
      return this.#block(
        task,
        scope,
        `No healthy runtime satisfies [${required.join(', ')}] for role '${task.roleId}'. ${detail}`,
      );
    }
    // Routing reserved the slot; it passes to the run in #drive, and is given
    // back here on every path that never gets that far - a failed provision,
    // a vetting block - so an attempt that never ran cannot hold a worker.
    try {
      return await this.#runRouted(ctx, selected.value, agentFor(agents, selected.value.profile.id), continuation);
    } finally {
      selected.value.reservation.release();
    }
  }

  async #runRouted(
    ctx: AttemptContext, selection: RuntimeSelection, agent: Member | null, continuation: TaskHold | null,
  ): Promise<TaskAttemptOutcome> {
    const { task, mission, workspace, repository, role, signal } = ctx;
    const { deps } = this;
    const { profile, adapter, reservation } = selection;
    // Everything from here on is done by the agent the runtime was chosen for,
    // or by the runtime itself when no agent member stands behind it.
    const scope: EventScope = { ...ctx.scope, actorId: agent?.id ?? RUNTIME_ACTOR };
    // Resuming a session a restart interrupted continues that attempt rather
    // than starting a new one. Counting it spent the retry budget on restarts:
    // a task with two attempts had used five before it had failed once, so its
    // first real gate failure would have blocked it outright.
    const resumable = this.#resumableRun(task.id, profile, adapter.resume !== undefined);
    const resuming = continuation === null && resumable !== null && task.attempts > 0;
    // Continuing from a hold spends no attempt either: the person's iteration
    // is not a failure (spec "Continue"). A task held before it ever ran still
    // counts this as its first.
    const attempt = continuation !== null ? Math.max(task.attempts, 1) : resuming ? task.attempts : task.attempts + 1;
    const round = task.round ?? 1;
    // Only counted attempts make a round "started"; a tighten or delivery pass
    // does not. Runs from before rounds existed count as round 1's.
    const firstOfRound = !deps.runs.listByTask(task.id)
      .some((r) => (r.round ?? 1) === round && (r.purpose === 'round' || r.purpose === 'retry' || r.purpose == null));
    const purpose: RunPurpose = resuming ? resumable.purpose ?? 'retry' : firstOfRound ? 'round' : 'retry';

    // The previous attempt's measured failure, read from its own column rather
    // than `statusReason`: that is the line a person reads, and any wait between
    // the failure and this retry - a busy runtime, a sign-in - rewrote it. The
    // retry was then told it had "failed" because it was queued, and the single
    // highest-value feedback loop in the system silently became a no-op.
    const feedback = attempt > 1 && !resuming && continuation === null ? task.retryFeedback ?? null : null;

    // #131: a step that runs the team's own skill finds it for this runtime
    // first. Not found stops the step with the reason and a card; it never
    // falls back to the role's prompt, and no attempt is spent.
    const stepSkill = await this.#stepSkill(task, mission, repository, profile, adapter);
    if (!stepSkill.ok) return this.#refuseStepSkill(task, mission, workspace, scope, stepSkill.reason);

    const running = this.#setStatus(task, scope, 'RUNNING', null, {
      attempts: attempt,
      startedAt: task.startedAt ?? deps.clock.now(),
      ...this.#assignment(task, workspace, agent),
    });

    // 3. Target. The row exists before the worktree does, so a crash between
    //    the two leaves a PROVISIONING record for recovery to fail cleanly.
    const kind = targetKindFor(task.executionPolicy.isolation);
    // A reviewer or tester must be able to SEE the change. Basing its worktree
    // on the base branch would hand it a tree without the work in it, leaving
    // it to review the ChangeSet's *description* of the diff - and the whole
    // point of an independent evaluator is that it checks the claim against the
    // artifact rather than taking the claim (MVP.md §16.1, §17.3).
    const upstreamBranch = this.#upstreamChangeBranch(running, mission);
    const provisioned = await this.#provisionTarget(
      kind, running, mission, workspace, repository, scope, upstreamBranch,
    );
    if (!provisioned.ok) {
      return this.#overtaken(running, scope, signal) ?? this.#settleFailure(running, scope, provisioned.reason);
    }
    const target = provisioned.target;

    // Declared outside the try so the finally can tear it down however the
    // attempt ends. A leftover socket would be a second, unauthenticated door
    // into the tool broker.
    let toolSurface: RunToolSurface = NO_TOOL_SURFACE;
    // The pinned skills this attempt installed (P13); removed again from a target that is not a worktree.
    let installed: InstalledSkills = NO_SKILLS;
    // The first run keeps its runtime slot when it ends, in case the round
    // needs a tighten pass: freed, it would go to another task while this one
    // harvests and checks, and the pass would run the profile over its limit.
    const retained: SlotRetention = { reservation: undefined };

    try {
      // Provisioning awaited; inside the try, so the target is released however this ends.
      const overtakenProvisioning = this.#overtaken(running, scope, signal);
      if (overtakenProvisioning !== null) return overtakenProvisioning;

      // 4. Grants: least privilege, scoped to this target and this mission.
      const requested = this.#requestedGrants(role, running, workspace, repository, target);
      const vetted = this.#vet(requested, running, workspace, scope);
      if (vetted.blockedOn !== null) {
        return this.#block(running, scope, vetted.blockedOn);
      }
      const grants = vetted.grants;

      // 5. Assignment: the unit permissions attach to.
      const assignment = deps.assignments.create({
        id: ids.workerAssignment(),
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: running.id,
        roleId: role.id,
        runtimeProfileId: profile.id,
        executionTargetId: target.id,
        grants,
        budgets: {
          maxWallTimeMs: task.executionPolicy.maxWallTimeMs,
          maxAttempts: task.retryPolicy.maxAttempts,
        },
        createdAt: deps.clock.now(),
      });

      // The run id is minted here rather than inside #drive so the tool surface,
      // its socket and its config file can all be keyed to this attempt and
      // destroyed with it.
      const runId = ids.run();

      // 6. Context. The tool surface is narrowed to this assignment before the
      //    prompt is written, so a worker is never told about a tool its grants
      //    would not let it call - and the same narrowed gateway is what backs
      //    the MCP server it will call through, so the list it is shown and the
      //    list it can reach are the same list by construction.
      toolSurface = await deps.mcpGateway.provision({
        runId,
        workspaceId: mission.workspaceId,
        missionId: mission.id,
        assignment,
        workingDirectory: target.workingDirectory,
        signal,
      });
      // A continuation keeps the task's out folder: the person may have written the output during the hold.
      await deps.harvester.prepare(target, scope, running, { keepOwn: continuation !== null });
      installed = await this.#installSkills(running, target, profile, adapter, scope);
      // Every pass of this attempt - the first run, a tighten, a delivery - gets the same skills.
      const actx: AttemptContext = { ...ctx, skills: installed };
      // Notes left while the task was held join this pass, the way a delivery pass takes them.
      const delivered = continuation === null ? [] : deps.rounds.promoteQueued(running);
      const brief = await deps.rounds.openRound(running);
      const compiled = await this.#compilePrompt({
        ...actx, task: running, workspace, grants, target, tools: toolSurface.toolNames, feedback, round: brief,
        // #131: the skill's instructions replace the role's; the step's context stays.
        role: running.runSkill == null ? role : { ...role, instructions: stepSkillInstructions(running.runSkill) },
      });
      if (stepSkill.request !== undefined) {
        deps.recorder.note(scope, `Runs the skill /${stepSkill.request.name}${stepSkill.request.args === '' ? '' : ` ${stepSkill.request.args}`} (${stepSkill.from}).`);
      }
      const destinations = running.expectedOutputs.map((type) => `${outDirFor(running)}/${type}.md`);
      // Spec §5: a round continues the last settled session whenever the runtime can, whatever that run's status.
      const session = continuation !== null
        ? this.#heldSession(continuation, profile, adapter)
        : firstOfRound && round > 1 && !resuming && brief !== null
          ? this.#settledSession(running.id, profile, adapter)
          : null;
      // Continue sends the fixed continuation and the notes owed; Release sends
      // the normal prompt. A session that cannot be resumed gets the normal prompt too.
      const notes = brief !== null && brief.toAddress.length > 0
        ? roundRequest({ ...brief, delivery: delivered.length > 0 }, destinations)
        : null;
      const prompt = continuation !== null
        ? session !== null && continuation.ending === 'continued'
          ? notes === null ? CONTINUATION_PROMPT : `${CONTINUATION_PROMPT}\n\n${notes}`
          : compiled.prompt
        : session !== null && brief !== null ? roundRequest(brief, destinations) : compiled.prompt;

      // Nothing is started for a task that was reset while its prompt was compiled.
      const overtakenBeforeRun = this.#overtaken(running, scope, signal);
      if (overtakenBeforeRun !== null) return overtakenBeforeRun;

      // #117: where a retry starts, so what it adds to the step's change can be told apart afterwards.
      const retryFrom = feedback !== null && target.kind === 'worktree' ? await this.#head(target, signal) : null;

      // 7. Run.
      const outcome = await this.#drive({
        task: running, mission, role, profile, adapter, target, assignment, grants, scope, signal, agent,
        runId, mcpConfigPath: toolSurface.mcpConfigPath, reservation, retainSlot: retained, prompt,
        ...(session === null ? {} : { continueSession: session, freshPrompt: compiled.prompt }),
        ...(continuation === null ? {} : { continuation }),
        purpose, round, inputs: compiled.includedArtifactIds, skills: installed.received, brain: compiled.brain ?? null,
        ...(stepSkill.request === undefined ? {} : { stepSkill: stepSkill.request }),
      });

      const stopped = this.#stopped(outcome, running, scope);
      if (stopped !== null) return stopped;

      // A round of an upstream task can reset this one after its run ended
      // but before the pass settles; nothing of the pass is recorded then,
      // and not even a sign-out's READY may overwrite the reset.
      const overtaken = this.#overtaken(running, scope, signal);
      if (overtaken !== null) return overtaken;

      if (outcome.failure?.code === SKILL_NOT_LOADED) {
        // #131: the session started without the skill; nothing of the work ran.
        return this.#refuseStepSkill(running, mission, workspace, scope, outcome.failure.message, { attempts: task.attempts });
      }

      if (outcome.failure?.code === RUNTIME_SIGNED_OUT) {
        // Nothing about the work was tried, so nothing about it is judged: the
        // attempt is handed back and the task waits for the runtime. The adapter
        // has already marked the profile unavailable; dropping the cached health
        // makes routing see that now rather than after the cache lapses.
        deps.runtimeManager.invalidateHealth(profile.id);
        const reason = `Waiting for you: ${outcome.failure.message}`;
        // The attempt that runs after the sign-in carries the notes that waited for this one.
        deps.rounds.promoteQueued(running);
        // Only the row's line changes; `retryFeedback` keeps what the last real
        // attempt failed on, for the attempt that eventually runs.
        this.#setStatus(running, scope, 'READY', reason, { attempts: task.attempts });
        return { kind: 'deferred', reason, retryAfterMs: this.#signedOutBackoff(task.id) };
      }

      // 8/9. Commit first, then harvest, so every artifact carries the commit
      //      it describes as provenance. `.tandemise/out/` is git-ignored, so the
      //      commit's content is unaffected by the order.
      const refs = await this.#commit(target, running, role, profile, outcome.runId, scope);
      if (retryFrom !== null) await deps.checks.measureRetryScope({ task: running, target, runId: outcome.runId, scope, signal }, retryFrom);
      const harvest = await deps.harvester.harvest({
        mission,
        task: running,
        target,
        runId: outcome.runId,
        roleId: role.id,
        scope: { ...scope, runId: outcome.runId, runtimeProfileId: profile.id },
        sourceRefs: refs,
        authorId: agent?.id ?? RUNTIME_ACTOR,
        ...(brief === null ? {} : { roundContract: deps.rounds.roundContract(running, brief) }),
      });
      // Everything this attempt stored, so an overtaken attempt sets all of it aside.
      const produced: ArtifactManifest[] = [...harvest.manifests];
      const setAside = (): void => this.#withdrawOutput(running, scope, produced);
      // Nothing ran long and no note waits, so no pass can follow: the slot
      // goes back now rather than being held idle through the checks.
      if (harvest.overBudget.length === 0 && !deps.rounds.hasQueued(running.id)) releaseSlot(retained);

      // 10. Checks.
      let checks = outcome.status === 'CANCELLED'
        ? []
        : await deps.checks.run({
          task: running,
          repository,
          target,
          runId: outcome.runId,
          scope: { ...scope, runId: outcome.runId },
          signal,
        });

      // Checks take time, and the harvest awaited too: judging a pass whose
      // task was reset meanwhile would overwrite PENDING and raise a card
      // about output made from the old version. That output is set aside.
      const overtakenAfterChecks = this.#overtaken(running, scope, signal);
      if (overtakenAfterChecks !== null) {
        setAside();
        return overtakenAfterChecks;
      }

      // 11. Gate.
      let assessed = this.#assess(running, harvest, outcome.failure, scope, outcome.runId);
      this.#score(running, mission, outcome.runId, assessed, harvest);
      let final = harvest;
      let lastRunId = outcome.runId;

      // 11(b'). Notes that arrived while the pass ran are delivered before it
      //         settles (spec §4).
      if (assessed.verdict.passed) {
        const delivered = await this.#deliverQueued({
          ...actx, task: running, harvest, assessed, profile, adapter, target, assignment, grants, agent, scope,
          firstRunId: outcome.runId, tools: toolSurface.toolNames, mcpConfigPath: toolSurface.mcpConfigPath,
          retained, produced, checks,
        });
        if (delivered.kind === 'stopped') {
          if (!isDaemonStopping(signal)) setAside();
          return delivered.outcome;
        }
        ({ harvest: final, assessed, lastRunId, checks } = delivered);
        const overtakenAfterDelivery = this.#overtaken(running, scope, signal);
        if (overtakenAfterDelivery !== null) {
          setAside();
          return overtakenAfterDelivery;
        }
        // A delivery pass broke the round: notes that arrived during it ride with the retry too.
        if (!assessed.verdict.passed) deps.rounds.promoteQueued(running);
      } else {
        // A failed pass is retried anyway; the notes ride with the retry, which must cite them.
        deps.rounds.promoteQueued(running);
      }

      // 11(c). A passed round whose artifacts ran long gets one tighten pass
      //        before anyone reviews it, so reviewers read the final version.
      if (assessed.verdict.passed && final.overBudget.length > 0) {
        const tightened = await this.#tighten({
          ...actx, task: running, harvest: final, profile, adapter, target, assignment, grants, agent, scope,
          firstRunId: lastRunId, tools: toolSurface.toolNames, mcpConfigPath: toolSurface.mcpConfigPath,
          retained,
        });
        if (tightened.kind === 'stopped') {
          // A daemon stop keeps the drafts: the restart settles the round from them.
          if (!isDaemonStopping(signal)) setAside();
          return tightened.outcome;
        }
        final = tightened.harvest;
        produced.push(...final.manifests);
        const overtakenAfterTighten = this.#overtaken(running, scope, signal);
        if (overtakenAfterTighten !== null) {
          setAside();
          return overtakenAfterTighten;
        }
      }

      // The round landed: the notes it cited are answered, and work kept on the old version is told.
      if (assessed.verdict.passed) deps.rounds.onRoundLanded(running, final.manifests, scope);

      return this.#judge({
        task: running, mission, workspace, role, scope, harvest: final, checks,
        runFailure: outcome.failure, runId: lastRunId, assessed,
      });
    } finally {
      // 13. Release. A worktree is left intact: it is the reviewable artifact,
      //     but the run's private tool surface dies with the run.
      retained.reservation?.release();
      await toolSurface.dispose();
      // A worktree keeps its skills (it is the run's reviewable record, and they
      // are excluded from its commits); anywhere else is someone's own folder.
      if (kind !== 'worktree' && installed.written.length > 0) await deps.skillInstaller?.remove(target, scope, installed);
      await this.#releaseTarget(target, kind);
    }
  }

  // -------------------------------------------------------------- run plumbing

  async #drive(input: DriveInput): Promise<DriveOutcome> {
    const { deps } = this;
    const { task, mission, profile, target, assignment, prompt, grants, scope, signal } = input;

    // Taking the handle consumes it. A stale handle that stayed RESUMABLE was
    // the whole bug: every later attempt asked the runtime to continue the same
    // forgotten session and failed identically, so the task could never leave
    // BLOCKED however many times it was retried. The new run below carries the
    // same handle, so a daemon that dies again loses nothing.
    // A tighten pass names the session it continues: the run that holds it
    // finished successfully and is not a handle waiting to be taken over.
    // A continuation from a hold names its session too, and takes over any
    // handle the held run left, so nothing later resumes the session from
    // before the person's changes.
    const source = input.continueSession === undefined || input.continuation !== undefined
      ? this.#resumableRun(task.id, profile, input.adapter.resume !== undefined)
      : null;
    const resumeFrom = input.continueSession === undefined ? source?.externalSessionId ?? null : input.continueSession;
    const { runId } = input;
    const startedAt = deps.clock.now();

    // A run's number is its place among this task's runs, not the task's
    // attempt count: a resumed session continues an attempt in a new run, and
    // (task, attempt) is unique on the runs table.
    const runNumber = Math.max(task.attempts, ...deps.runs.listByTask(task.id).map((r) => r.attempt + 1));
    // P12: the model, decided by the one rule and recorded on the run before it starts.
    const chosen = this.#modelFor(task, mission, input.role, profile, input.adapter);
    deps.runs.create({
      id: runId,
      missionId: mission.id,
      taskId: task.id,
      assignmentId: assignment.id,
      attempt: runNumber,
      status: 'STARTING',
      roleId: task.roleId,
      runtimeProfileId: profile.id,
      executionTargetId: target.id,
      externalSessionId: resumeFrom,
      pid: null,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
      usage: null,
      startedAt,
      finishedAt: null,
      heartbeatAt: startedAt,
      agentMemberId: input.agent?.id ?? null,
      round: input.round,
      purpose: input.purpose,
      model: chosen.model,
      modelReason: chosen.reason,
      skills: input.skills ?? null,
      brain: input.brain ?? null,
    });
    // Recorded before the run starts, so a round started while it runs already sees it as a consumer.
    deps.runInputs.record(runId, input.inputs);
    // A handle on another profile cannot be resumed by this run or any run on
    // this profile; left RESUMABLE, a later attempt routed back there would
    // continue a session from before this one.
    if (input.continueSession === undefined || input.continuation !== undefined) {
      for (const stale of deps.runs.listByTask(task.id)) {
        if (stale.status !== 'RESUMABLE' || stale.id === source?.id || stale.runtimeProfileId === profile.id) continue;
        deps.runs.update(stale.id, { status: 'INTERRUPTED', errorMessage: 'Its session is on another runtime; a later attempt started fresh.' });
      }
    }
    // The hold is read once the run holding its session exists; an older one
    // left unread is superseded by it, and is not continued later either.
    if (input.continuation !== undefined) {
      for (const hold of this.#endedHolds(task)) deps.holds.update(hold.id, { consumedAt: startedAt });
    }
    // Only now, with the new run holding the handle, is the old one released:
    // a daemon that dies between the two writes still leaves a run to resume.
    // Consumed whether or not the resume then works - a handle that failed
    // once is not worth a second try, and one that worked lives on above.
    if (source !== null) {
      deps.runs.update(source.id, {
        status: 'INTERRUPTED',
        errorMessage: 'Its session handle was handed to a later attempt.',
      });
    }

    const runScope: EventScope = { ...scope, runId, runtimeProfileId: profile.id };
    deps.recorder.record(runScope, {
      type: 'run.started',
      attempt: task.attempts,
      runtime: profile.name,
      target: `${target.kind}:${target.workingDirectory}`,
    });

    // The budget is enforced here, where it can be paused while the worker waits
    // on a person, and not only inside the adapter - an adapter that ignores it
    // must not be able to hold a worker slot forever.
    // A resumed session may have to start over, and the restart must reuse the
    // slot the stale attempt held rather than claim a second one.
    const ownRetention: SlotRetention | undefined = input.retainSlot === undefined && resumeFrom !== null
      ? { reservation: undefined }
      : undefined;
    const retention = input.retainSlot ?? ownRetention;
    const deadline = deps.deadlines.open(assignment.id, task.executionPolicy.maxWallTimeMs);
    const combined = AbortSignal.any([signal, deadline.signal]);

    const request = {
      runId,
      profile,
      prompt,
      workingDirectory: target.workingDirectory,
      grants: grants.map((g) => g.capability),
      allowedRoots: allowedRoots(grants, target.workingDirectory),
      mcpConfigPath: input.mcpConfigPath,
      model: chosen.model,
      // The adapter runs its own timer, which cannot be paused. Given the real
      // budget it would kill a worker mid-question; given this it remains a
      // backstop against a runaway adapter and never fires before the deadline
      // above, which is the precise one.
      maxWallTimeMs: task.executionPolicy.maxWallTimeMs + MAX_PARKED_MS,
      signal: combined,
      log: deps.log.child({ runId, taskId: task.id, missionId: mission.id, runtime: profile.adapterId }),
      reservation: input.reservation,
      retainSlot: retention,
      ...(input.stepSkill === undefined ? {} : { skill: input.stepSkill }),
    };

    let usage: RunUsage = {};
    let failure: RunFailure | null;
    try {
      const resumed = await this.#stream(request, runScope, resumeFrom);
      usage = resumed.usage;
      failure = resumed.failure;

      // A handle the runtime cannot honour says nothing about the work, only
      // that the continuity is gone. Charging the attempt for that would spend a
      // retry on our own optimisation - and on a task whose budget was already
      // spent, it blocks the mission on a session id. So the same run starts
      // over from scratch, under the same run id, with the dead handle cleared.
      // Not after an abort: a run someone stopped is not restarted.
      if (failure?.code === SESSION_NOT_FOUND && resumeFrom !== null && !combined.aborted) {
        deps.runs.update(runId, { externalSessionId: null });
        deps.recorder.note(
          scope,
          `The previous session for '${task.key}' could no longer be resumed, so this attempt started fresh.`,
          'warn',
        );
        const slot = retention?.reservation;
        if (retention !== undefined) retention.reservation = undefined;
        const fresh = await this.#stream(
          { ...request, reservation: slot, ...(input.freshPrompt === undefined ? {} : { prompt: input.freshPrompt }) },
          runScope,
          null,
        );
        usage = mergeUsage(usage, fresh.usage);
        failure = fresh.failure;
      }
    } finally {
      deps.deadlines.close(assignment.id);
      ownRetention?.reservation?.release();
    }

    const cancelled = signal.aborted;
    if (deadline.expired && !cancelled) {
      // Overrides whatever the adapter reported. From inside the adapter an
      // exhausted budget is indistinguishable from a cancellation - its signal
      // simply fired - so it reports CANCELLED, which is not retryable. Only
      // this side knows the deadline is why, and a timeout is exactly the
      // failure a retry exists for.
      failure = {
        code: 'TIMEOUT',
        message: `Run exceeded its ${task.executionPolicy.maxWallTimeMs}ms wall-time budget`,
        retryable: true,
      };
    } else if (combined.aborted && failure === null) {
      failure = { code: 'CANCELLED', message: 'Run cancelled', retryable: false };
    }

    const finishedAt = deps.clock.now();
    // Agent time is always measured (P8): what the runtime reported when it
    // said, otherwise how long the run took by the daemon's clock.
    if (usage.wallTimeMs === undefined) usage = { ...usage, wallTimeMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) };
    const interrupted = isDaemonStopping(signal);
    const session = deps.runs.get(runId)?.externalSessionId ?? null;
    // A signed-out runtime never reached the session it was asked to continue,
    // so a resume that failed that way hands the handle on intact: after the
    // sign-in the work continues where the restart left it, not from scratch.
    const resumeUntouched = failure?.code === RUNTIME_SIGNED_OUT && resumeFrom !== null;
    // A hold pauses the run for a person, as a stop pauses it for a restart: its session is kept.
    const status = interrupted || resumeUntouched || isTaskHeld(signal)
      ? (session !== null && input.adapter.resume !== undefined ? 'RESUMABLE' : 'INTERRUPTED')
      : cancelled ? 'CANCELLED' : failure === null ? 'SUCCEEDED' : 'FAILED';
    deps.runs.update(runId, {
      status,
      finishedAt,
      errorCode: failure?.code ?? null,
      errorMessage: failure === null ? null : summarize(failure.message, 2000),
      usage: hasUsage(usage) ? usage : null,
    });
    if (hasUsage(usage)) deps.runs.recordUsage(runId, usage);
    // Right after the record, before the pass is judged: a mission that just
    // crossed its limit stops here, and nothing else in it starts (P8).
    if (hasUsage(usage)) {
      try {
        deps.limits?.afterUsage(mission.id, runId);
      } catch (e) {
        deps.log.error('limits.after_usage_failed', { missionId: mission.id, runId, error: errorMessage(e) });
      }
    }

    deps.recorder.record(runScope, {
      type: 'run.finished',
      status,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    });

    return { runId, status, failure, cancelled, interrupted };
  }

  /**
   * The task's skill pins (P13), resolved once. A planned task got them when it
   * was created; a task the engine added later (a fix, a merge conflict) takes
   * its role's pins now and keeps them for every retry.
   */
  #pinSkills(task: MissionTask, workspace: Workspace, role: RoleTemplate): { task: MissionTask; problems: readonly string[] } {
    const skills = this.deps.skills;
    if (skills === undefined || (task.skills !== null && task.skills !== undefined)) return { task, problems: [] };
    const { pins, problems } = skills.pinsFor(workspace.id, role, { key: task.key });
    if (problems.length > 0) return { task, problems };
    return { task: this.deps.tasks.update(task.id, { skills: pins }), problems: [] };
  }

  /**
   * Refuses a run whose pinned skills cannot all be given to it (P13 spec §4):
   * the task goes BLOCKED with the skill named, and an intervention card asks
   * the person to import it again and retry. No attempt is spent - nothing ran.
   */
  async #refuseMissingSkills(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    role: RoleTemplate,
    scope: EventScope,
  ): Promise<TaskAttemptOutcome | null> {
    const refused = await this.#missingSkills(task, workspace, role);
    if (refused === null) return null;
    const { reason, named } = refused;
    const current = this.#requireTask(task.id);
    // Nobody reads a card raised by an eval trial: the trial ends blocked, naming the skill.
    if (isTrialMission(mission)) return this.#block(current, scope, `Missing skill: ${named.join(', ')}`);
    // Nothing is waiting on this task but the person: don't raise a second card for the same refusal.
    const open = this.deps.approvals.pendingForTask(task.id).some((a) => a.kind === 'intervention');
    if (!open) {
      const approval = this.deps.approvalFactory.createOrThrow({
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: task.id,
        kind: 'intervention',
        risk: 'read',
        title: `‘${task.title}’ needs a skill that is missing`,
        rationale: reason,
        effect: 'Retry runs the step once the skill is back in the library. Leave blocked stops here.',
        evidence: [
          { kind: 'text', label: 'Missing', value: named.join(', ') },
          { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
        ],
        options: [
          { id: 'approve', label: 'Retry' },
          { id: 'reject', label: 'Leave blocked' },
        ],
        recommendedOptionId: null,
        ...this.deps.reviews.addressFor(task, workspace.id),
      });
      this.deps.approvals.create(approval);
      this.deps.recorder.invalidate('approvals', mission.id);
    }
    return this.#block(current, scope, reason);
  }

  /** A pinned skill that cannot be given to the step, and why; null when every pin is in the library. */
  async #missingSkills(
    task: MissionTask, workspace: Workspace, role: RoleTemplate,
  ): Promise<{ readonly reason: string; readonly named: readonly string[] } | null> {
    if (this.deps.skills === undefined) return null;
    const pinned = this.#pinSkills(task, workspace, role);
    if (pinned.problems.length > 0) {
      return {
        reason: `${pinned.problems.join(' ')} Import it on the Skills screen or change the pin, then choose Retry.`,
        named: pinned.problems.map((p) => /skill '([^']+)'/.exec(p)?.[1] ?? '?'),
      };
    }
    const missing = await this.deps.skills.missing(pinned.task.skills ?? []);
    if (missing.length === 0) return null;
    return { reason: missingSkillReason(missing), named: missing.map((m) => `${m.name} v${m.version}`) };
  }

  /**
   * The team's skill a step runs (#131), found for the routed runtime: its
   * arguments filled, and the plugin folder a Claude Code run loads. A step
   * without one is ok with no request.
   */
  async #stepSkill(
    task: MissionTask, mission: Mission, repository: Repository | null, profile: RuntimeProfile,
    adapter: { readonly displayName?: string; resolveSkill?: import('@tandemise/runtimes-core').AgentRuntimeAdapter['resolveSkill'] },
  ): Promise<{ readonly ok: true; readonly request?: RunSkillRequest; readonly from: string } | { readonly ok: false; readonly reason: string }> {
    const step = task.runSkill;
    if (step == null) return { ok: true, from: '' };
    if (adapter.resolveSkill === undefined) {
      return {
        ok: false,
        reason: `‘${task.title}’ runs the skill /${step.name}, and only Claude Code can run a skill as a step. `
          + `It was routed to ${profile.name}, a ${adapter.displayName ?? profile.adapterId} runtime. Route the step's role to Claude Code, then choose Retry.`,
      };
    }
    const item = mission.trackerItemId == null ? undefined : this.deps.trackerItems?.get(mission.trackerItemId);
    const args = stepSkillArgs(step.args, { item: item === undefined ? null : { key: item.key, url: item.url, title: item.title }, missionTitle: mission.title });
    // A library skill pinned to the step is written to `.claude/skills/<name>` before the run.
    if ((task.skills ?? []).some((pin) => pin.name === step.name)) {
      return { ok: true, request: { name: step.name, args, pluginDirs: [] }, from: 'pinned from the skills library' };
    }
    const found = await adapter.resolveSkill(profile, step.name, repository === null ? [] : [repository.path]);
    if (!found.ok) return { ok: false, reason: found.reason };
    return { ok: true, request: { name: step.name, args, pluginDirs: found.pluginDirs }, from: found.from };
  }

  /**
   * Stops a step whose skill can't be run (#131) with the reason, and asks the
   * person on a card, as a missing library skill does. Never a fallback.
   */
  #refuseStepSkill(
    task: MissionTask, mission: Mission, workspace: Workspace, scope: EventScope, reason: string, extra: Partial<MissionTask> = {},
  ): TaskAttemptOutcome {
    const name = task.runSkill?.name ?? '?';
    if (!isTrialMission(mission) && !this.deps.approvals.pendingForTask(task.id).some((a) => a.kind === 'intervention')) {
      const approval = this.deps.approvalFactory.createOrThrow({
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: task.id,
        kind: 'intervention',
        risk: 'read',
        title: `‘${task.title}’ needs a skill that isn’t installed`,
        rationale: reason,
        effect: 'Retry runs the step once the skill is there. Leave blocked stops here.',
        evidence: [
          { kind: 'text', label: 'Skill', value: `/${name}` },
          { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
        ],
        options: [
          { id: 'approve', label: 'Retry' },
          { id: 'reject', label: 'Leave blocked' },
        ],
        recommendedOptionId: null,
        ...this.deps.reviews.addressFor(task, workspace.id),
      });
      this.deps.approvals.create(approval);
      this.deps.recorder.invalidate('approvals', mission.id);
    }
    return this.#settle(task, scope, 'BLOCKED', reason, extra);
  }

  /**
   * Gives this attempt its pinned skills (P13): verified content, written into
   * the runtime's skills folder when it has one, else into the prompt.
   */
  async #installSkills(
    task: MissionTask,
    target: ExecutionTarget,
    profile: RuntimeProfile,
    adapter: { skillsFolder?(profile: RuntimeProfile): string | null },
    scope: EventScope,
  ): Promise<InstalledSkills> {
    const { skills, skillInstaller } = this.deps;
    const pins = task.skills ?? [];
    if (skills === undefined || skillInstaller === undefined || pins.length === 0) return NO_SKILLS;
    const contents: { pin: SkillPin; files: readonly SkillFile[] }[] = [];
    for (const pin of pins) {
      const files = await skills.content(pin.hash);
      // Checked before the attempt began; gone since, the attempt fails and says which.
      if (files === null) throw new Error(missingSkillReason([pin]));
      contents.push({ pin, files });
    }
    return skillInstaller.install({ target, scope, folder: adapter.skillsFolder?.(profile) ?? null, skills: contents });
  }

  /**
   * The model for a run of this task (P12). Gathers what `resolveModel` reads -
   * the step's settings, the role's, the profile's, the attempt, how close a
   * limit is, whether the runtime can take a model - and decides nothing itself.
   */
  #modelFor(
    task: MissionTask,
    mission: Mission,
    role: RoleTemplate,
    profile: RuntimeProfile,
    adapter: { acceptsModel?(profile: RuntimeProfile): boolean },
  ): ResolvedModel {
    const profileModel = profile.settings['model'];
    let pressure: LimitPressure | null = null;
    try {
      // A trial's pinned model wins anyway; no pressure keeps its recorded reason honest.
      pressure = isTrialMission(mission) ? null : this.deps.limits?.pressure?.(mission.id) ?? null;
    } catch (e) {
      this.deps.log.warn('limits.pressure_failed', { missionId: mission.id, error: errorMessage(e) });
    }
    return resolveModel({
      step: task.modelPolicy ?? null,
      role: role.models ?? null,
      profileModel: typeof profileModel === 'string' ? profileModel : null,
      attempt: Math.max(1, task.attempts),
      pressure,
      runtimeTakesModel: adapter.acceptsModel?.(profile) ?? false,
    });
  }

  /**
   * One pass of the runtime over one run, resumed or fresh.
   *
   * Separate from `#drive` because an attempt may need two of them: a resume
   * whose session has vanished is not a failed attempt, it is a failed
   * shortcut, and the retry belongs here rather than in the task's budget.
   */
  async #stream(
    request: RunRequest,
    runScope: EventScope,
    resumeFrom: string | null,
  ): Promise<{ usage: RunUsage; failure: RunFailure | null }> {
    const { deps } = this;
    const { runId } = request;
    let usage: RunUsage = {};
    let failure: RunFailure | null = null;
    let started = false;
    let lastBeat = deps.clock.epochMs();

    try {
      const events = resumeFrom !== null
        ? deps.runtimeManager.resume(resumeFrom, request)
        : deps.runtimeManager.start(request);

      for await (const event of events) {
        if (!started) {
          started = true;
          deps.runs.update(runId, {
            status: 'RUNNING',
            pid: deps.runtimeManager.pid(request.profile, runId),
          });
        }

        // A stale handle is not recorded as a failure: the caller restarts the
        // run and says so in a note, and a failure card followed by success
        // would contradict it. An abort in the meantime is recorded as usual.
        const staleSession = resumeFrom !== null && event.type === 'failed' && event.code === SESSION_NOT_FOUND;

        // Persisted and published one at a time: the UI timeline and recovery
        // both read the durable log, so a batched write is a lost run.
        if (!staleSession) deps.recorder.record(runScope, event);
        // Every event, unthrottled: silence is measured from it (P9), and the
        // watchdog must never call a run quiet that spoke a second ago.
        deps.runs.markActivity(runId, deps.clock.now());

        switch (event.type) {
          case 'checkpoint': {
            // Immediately, not at the end: this is the single fact that makes
            // resuming an interrupted run possible (MVP.md §21.2).
            if (event.externalSessionId !== undefined) {
              deps.runs.update(runId, { externalSessionId: event.externalSessionId });
            }
            deps.checkpoints.append({
              runId,
              sequence: deps.clock.epochMs(),
              label: event.label ?? 'checkpoint',
              externalSessionId: event.externalSessionId ?? null,
              payload: {},
              createdAt: deps.clock.now(),
            });
            break;
          }
          case 'usage':
            usage = mergeUsage(usage, event);
            break;
          case 'failed':
            failure = { code: event.code, message: event.message, retryable: event.retryable };
            break;
          default:
            break;
        }

        const now = deps.clock.epochMs();
        if (now - lastBeat >= 2_000) {
          lastBeat = now;
          deps.runs.heartbeat(runId, deps.clock.now());
        }
      }
    } catch (e) {
      failure = { code: 'RUNTIME_FAILED', message: errorMessage(e), retryable: true };
    }
    return { usage, failure };
  }

  // ------------------------------------------------------------------ decision

  /**
   * The gate's verdict on the round as it was first harvested.
   *
   * Separate from `#judge` because a tighten pass sits between the two: it
   * only runs on a round that passed, and it must not re-open that verdict.
   */
  #assess(
    task: MissionTask,
    harvest: HarvestResult,
    runFailure: RunFailure | null,
    scope: EventScope,
    runId: RunId,
  ): Assessment {
    const measured = harvest.filesChanged === undefined ? {} : { filesChanged: harvest.filesChanged };
    // A task with no completion gate has nothing to score, so its facts are
    // never assembled - GateService.assess() is only called when there is a
    // gate to read them against.
    const assessed = task.completionGate === null ? { outcome: null, facts: {} } : this.deps.gates.assess(task, measured);
    const gate = assessed.outcome;
    const verdict = decide(gate, harvest, runFailure);
    if (gate !== null) {
      this.deps.recorder.record({ ...scope, runId }, {
        type: 'gate.evaluated',
        gate: gate.expression,
        passed: gate.passed,
        detail: gate.detail,
      });
    }
    return { gate, verdict, measured, facts: assessed.facts };
  }

  /**
   * Keeps the run's measured facts (P3b). A score is a record for people and
   * evals; the engine never reads it back, and failing to write one never fails
   * the run.
   */
  #score(task: MissionTask, mission: Mission, runId: RunId, assessed: Assessment, harvest: HarvestResult): void {
    if (assessed.gate === null || this.deps.runScores === undefined) return;
    try {
      const run = this.deps.runs.get(runId);
      if (run === undefined) return;
      const traced = this.deps.gates.trace(mission.id);
      const usage = run.usage;
      this.deps.runScores.insert({
        runId, taskId: task.id, missionId: mission.id, workspaceId: mission.workspaceId,
        roleId: run.roleId, model: run.model ?? null, skills: run.skills ?? [],
        attempt: run.attempt, round: run.round ?? task.round ?? 1, purpose: run.purpose ?? null,
        gatePassed: assessed.gate.passed, gateDetail: assessed.gate.detail, facts: assessed.facts,
        criteria: traced.qa === undefined ? null
          : { verified: traced.trace.verified, failed: traced.trace.failed, unverified: traced.trace.unverified },
        overBudget: harvest.overBudget.length,
        inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        costUsd: usage?.costUsd ?? null, wallTimeMs: usage?.wallTimeMs ?? null,
        evalTrial: isTrialMission(mission), scoredAt: this.deps.clock.now(),
      });
    } catch (e) {
      this.deps.log.error('run.score_failed', { runId, error: errorMessage(e) });
    }
  }

  #judge(input: JudgeInput): TaskAttemptOutcome {
    const { task, mission, workspace, role, scope, harvest, checks, runFailure } = input;
    const { gate, verdict, measured } = input.assessed;

    if (verdict.passed) {
      // 12(b). The task's reviews - or the one `approvalPolicy.onCompletion`
      //        implies - decide whether it, and everything downstream of it,
      //        waits for a person.
      const outcome = this.deps.reviews.onRoundPassed({ task, mission, workspace, role, gate, checks, scope, measured });
      return this.#settle(task, scope, outcome.status, outcome.reason);
    }

    // 11(a'). An evaluator whose gate failed only because it found problems did
    //        its job. Retrying it re-runs the same review or QA on unchanged
    //        work and fails the same way until the budget is gone - and the fix
    //        loop, which starts from a *succeeded* evaluator, never runs. A QA
    //        run found a real defect and would have been re-run three times
    //        instead of handed to a developer. So it settles SUCCEEDED and the
    //        scheduler's remediation turns the findings into a fix and a
    //        re-check, which downstream tasks are repointed to wait on.
    if (runFailure === null && gate !== null && this.#foundOwnProblems(task, gate, harvest)) {
      this.deps.recorder.note(
        scope,
        `'${task.key}' found blocking problems (${verdict.detail}). They go to a fix task rather than a re-run of the same check on unchanged work.`,
      );
      return this.#settle(task, scope, 'SUCCEEDED', `Found blocking problems: ${verdict.detail}`);
    }

    // 11(a''). A check that ran out of time measured nothing about the work
    //         (#111). Re-running the agent cannot make a slow suite finish:
    //         on the dogfood run every retry re-ran the suite, timed out the
    //         same way and blocked anyway, an hour later. The check service
    //         already gave it a second run with twice the budget, so the step
    //         asks a person now: raise the budget, change the command, or go
    //         again. No attempt is spent on the agent's account.
    const timedOut = gate === null ? [] : checks.filter((c) => c.outcome === 'TIMEOUT' && verdict.detail.includes(c.name));
    if (runFailure === null && timedOut.length > 0 && !isTrialMission(mission)) {
      const reason = timeoutReason(timedOut);
      this.#createTimeoutApproval(task, mission, workspace, timedOut, reason);
      return this.#settle(task, scope, 'BLOCKED', reason, { retryFeedback: timeoutFeedback(timedOut) });
    }

    // 11(a'''). The step's own output was refused by its runtime (#191): the
    //          write to its out folder came back denied, so the artifact the
    //          gate needs could never land. Retrying the same grants refuses
    //          the same write; a person is asked now, with the refusal.
    const refused = harvest.missing.length > 0 ? this.#refusedOutputWrites(input.runId) : [];
    if (refused.length > 0 && !isTrialMission(mission)) {
      const reason = `Its ${harvest.missing.join(', ')} could not be saved: the write to ${refused[0]} was refused by the runtime. `
        + 'The step did not succeed, and its result is not used.';
      this.#createInterventionApproval(task, mission, workspace, reason, { title: `${task.title}: its output was refused`, rationale: reason });
      return this.#settle(task, scope, 'BLOCKED', reason, { retryFeedback: verdict.detail });
    }

    // 11(b). Gate feedback into the retry. Shown on the row, and kept in
    //        `retryFeedback` so the next attempt's prompt can quote it verbatim
    //        however long the task waits - even past a block and a manual retry.
    // The gate only says which fact failed ("checks.tests is FAIL"); the check's
    // own detail says why - a test's output, or that it ran out of time. An
    // agent told only the first went looking for a broken test that a timeout
    // never implied, so the retry quotes the failed checks the gate names too.
    const feedback = withFailedChecks(verdict.detail, checks);
    const retrying = task.attempts < task.retryPolicy.maxAttempts;
    // The agent gets the measurement verbatim; a person reading the row gets the
    // round's line when that measurement is only an unanswered note, since its
    // ids and paths say nothing to them.
    const reason = unansweredLine(harvest, gate, runFailure, retrying) ?? verdict.detail;
    if (retrying) {
      this.#setStatus(task, scope, 'READY', reason, { retryFeedback: feedback });
      return {
        kind: 'settled',
        status: 'READY',
        reason,
        retryAfterMs: task.retryPolicy.backoffMs,
      };
    }
    // Trial tasks are written to fail on exhaustion; the guard keeps an eval
    // trial from ever raising an intervention card nobody would read.
    if (task.retryPolicy.onExhausted === 'fail' || isTrialMission(mission)) {
      return this.#settle(task, scope, 'FAILED', reason, { retryFeedback: feedback });
    }
    // The card's evidence is a person-readable summary, never the gate's
    // verbatim detail: `feedback` can carry ids and file paths, and stays
    // verbatim only in `retryFeedback`, for the agent's own next attempt.
    this.#createInterventionApproval(task, mission, workspace, interventionSummary(task, harvest, gate, runFailure));
    return this.#settle(task, scope, 'BLOCKED', reason, { retryFeedback: feedback });
  }

  /**
   * True when this task is the evaluator whose report failed the gate: it
   * delivered its report, the report itself carries blocking problems, and no
   * fix has been started for it yet (a second pass over the same findings
   * falls back to an ordinary retry rather than looping).
   */
  #foundOwnProblems(task: MissionTask, gate: GateOutcome, harvest: HarvestResult): boolean {
    const own: Array<[ArtifactType, string]> = [['QAReport', 'qa.blocking_defects'], ['ReviewReport', 'review.blocking_findings']];
    const reported = own.some(([type, fact]) => task.expectedOutputs.includes(type)
      && !harvest.missing.includes(type)
      && typeof gate.facts[fact] === 'number' && (gate.facts[fact] as number) > 0);
    if (!reported) return false;
    return !this.deps.tasks.listByMission(task.missionId).some((t) => t.remediatesTaskId === task.id);
  }

  // ------------------------------------------------------------------ tighten

  /**
   * One tighten pass over a passed round whose artifacts ran over budget.
   *
   * It belongs to the same attempt: the work was accepted, so charging it an
   * attempt would let length exhaust a retry budget meant for failures. It
   * continues the author's session when the runtime can, because editing in
   * context is cheaper and better than starting over; otherwise it runs fresh
   * with the draft in the prompt, so the author still edits rather than
   * rewrites. Whatever happens, it never fails the round: a pass that breaks
   * leaves the first draft standing, over budget.
   */
  async #tighten(input: TightenInput): Promise<
    { readonly kind: 'harvest'; readonly harvest: HarvestResult } | { readonly kind: 'stopped'; readonly outcome: TaskAttemptOutcome }
  > {
    const { deps } = this;
    const { task, harvest, profile, scope } = input;
    const firstScope: EventScope = { ...scope, runId: input.firstRunId, runtimeProfileId: profile.id };

    // Asked once per round, and the record of asking is the event itself: a
    // daemon that restarts mid-pass resumes this attempt and must accept what
    // it gets rather than ask again.
    if (this.#tightenedThisRound(task)) {
      this.#recordOverBudget(firstScope, harvest.overBudget);
      return { kind: 'harvest', harvest };
    }
    deps.recorder.record(firstScope, {
      type: 'artifact.tighten_requested',
      types: [...new Set(harvest.overBudget.map((o) => o.type))],
      attempt: task.attempts,
      // Kept so a restart can settle the round on the facts its reviews read.
      ...(harvest.filesChanged === undefined ? {} : { filesChanged: harvest.filesChanged }),
    });

    const feedback = harvest.overBudget.map(tightenLine).join('\n');
    const drafts: LoadedArtifact[] = [];
    for (const over of harvest.overBudget) {
      try {
        drafts.push(await deps.artifactStore.read(over.artifactId));
      } catch (e) {
        deps.recorder.note(scope, `Could not read the ${over.type} draft for its tighten pass: ${errorMessage(e)}`, 'warn');
      }
    }
    // The round's brief rides along so a fresh pass keeps the citations; the drafts are already inlined above it.
    const brief = await deps.rounds.openRound(task);
    const round = brief === null ? null : { ...brief, previous: [] };
    const fresh = await this.#compilePrompt({ ...input, feedback: null, tighten: { feedback, drafts }, round });
    const session = deps.runs.get(input.firstRunId)?.externalSessionId ?? null;
    const resumable = session !== null
      && input.adapter.resume !== undefined
      && deps.runtimeManager.capabilities(profile).includes('session_resume');

    const outcome = await this.#drive({
      task, mission: input.mission, role: input.role, profile, adapter: input.adapter, target: input.target, assignment: input.assignment,
      prompt: resumable ? tightenRequest(feedback, harvest.overBudget.map((o) => `${outDirFor(task)}/${o.type}.md`)) : fresh.prompt,
      freshPrompt: fresh.prompt,
      continueSession: resumable ? session : null,
      grants: input.grants, scope, signal: input.signal, agent: input.agent, runId: ids.run(),
      mcpConfigPath: input.mcpConfigPath, skills: input.skills?.received ?? null,
      // The slot the first run kept, handed straight on.
      reservation: takeReservation(input.retained),
      purpose: 'tighten', round: task.round ?? 1, inputs: fresh.includedArtifactIds,
    });

    if (outcome.interrupted) {
      // The daemon is stopping. The round already passed, so it is settled now
      // from the first draft instead of going back to the queue, where a
      // restart would redo it and could spend an attempt. The run's session is
      // not worth resuming for a round that is closed.
      deps.runs.update(outcome.runId, {
        status: 'INTERRUPTED',
        errorMessage: 'Tandemise stopped during the tighten pass; the round was settled from its first draft.',
      });
      deps.recorder.note(scope, `Tandemise stopped during the tighten pass for '${task.key}'. The first draft stands, over its length budget.`, 'warn');
      this.#recordOverBudget(firstScope, harvest.overBudget);
      return { kind: 'harvest', harvest };
    }
    const stopped = this.#stopped(outcome, task, scope) ?? this.#overtaken(task, scope, input.signal);
    if (stopped !== null) return { kind: 'stopped', outcome: stopped };
    if (outcome.failure !== null) {
      deps.recorder.note(
        scope,
        `The tighten pass for '${task.key}' did not finish (${outcome.failure.code}: ${summarize(outcome.failure.message, 300)}). `
        + 'The first draft stands, over its length budget.',
        'warn',
      );
      this.#recordOverBudget(firstScope, harvest.overBudget);
      return { kind: 'harvest', harvest };
    }

    const refs = await this.#commit(input.target, task, input.role, profile, outcome.runId, scope);
    const second = await deps.harvester.harvest({
      mission: input.mission,
      task,
      target: input.target,
      runId: outcome.runId,
      roleId: input.role.id,
      scope: { ...scope, runId: outcome.runId, runtimeProfileId: profile.id },
      sourceRefs: refs,
      authorId: input.agent?.id ?? RUNTIME_ACTOR,
      revising: harvest.manifests,
      // A tightened draft still answers the round's notes; one that dropped a citation keeps its draft.
      ...(brief === null ? {} : { roundContract: deps.rounds.roundContract(task, brief) }),
    });

    // Per type: a valid rewrite replaces its draft (the harvester has already
    // superseded it), and a type the pass broke or deleted keeps its draft.
    const rewritten = new Map(second.manifests.map((m) => [m.type, m]));
    const manifests = harvest.manifests.map((m) => rewritten.get(m.type) ?? m);
    const kept = harvest.manifests.filter((m) => !rewritten.has(m.type)).map((m) => m.type);
    const issues = second.issues.length > 0 ? ` (${summarize(second.issues.join(' '), 500)})` : '';
    if (kept.length > 0) {
      deps.recorder.note(
        scope,
        `The tighten pass for '${task.key}' did not leave a valid ${kept.join(', ')}${issues}; the first draft stands for ${kept.length === 1 ? 'it' : 'them'}.`,
        'warn',
      );
    } else if (second.issues.length > 0) {
      deps.recorder.note(scope, `The tighten pass for '${task.key}' also left files Tandemise did not use${issues}.`, 'warn');
    }
    const live = new Set(manifests.map((m) => m.id));
    // A file the pass left untouched comes back as its draft, which the first run wrote.
    const drafted = new Set(harvest.manifests.map((m) => m.id));
    const rewrittenIds = new Set(second.manifests.map((m) => m.id).filter((id) => !drafted.has(id)));
    const overBudget = [...second.overBudget, ...harvest.overBudget]
      .filter((o, i, all) => live.has(o.artifactId) && all.findIndex((x) => x.artifactId === o.artifactId) === i);
    // Each event carries the run that produced the artifact it is about.
    const tightenScope: EventScope = { ...scope, runId: outcome.runId, runtimeProfileId: profile.id };
    this.#recordOverBudget(tightenScope, overBudget.filter((o) => rewrittenIds.has(o.artifactId)));
    this.#recordOverBudget(firstScope, overBudget.filter((o) => !rewrittenIds.has(o.artifactId)));
    return { kind: 'harvest', harvest: { ...harvest, manifests, overBudget } };
  }

  /**
   * Spec §4: notes that arrived while the pass ran are delivered before the task
   * settles, as further passes in the same round. They are not attempts: a person
   * asked for more, nothing failed. The session continues when the runtime can;
   * otherwise the pass runs fresh with the draft and the notes in its prompt.
   * It hands the slot on and treats a stop the way the tighten pass does.
   */
  async #deliverQueued(input: DeliveryInput): Promise<
    | {
      readonly kind: 'harvest'; readonly harvest: HarvestResult; readonly assessed: Assessment; readonly lastRunId: RunId;
      readonly checks: readonly CheckResult[];
    }
    | { readonly kind: 'stopped'; readonly outcome: TaskAttemptOutcome }
  > {
    const { deps } = this;
    const { task, profile, scope } = input;
    let harvest = input.harvest;
    let assessed = input.assessed;
    let lastRunId = input.firstRunId;
    let checks = input.checks;
    for (let pass = 0; pass < MAX_FEEDBACK_PASSES; pass++) {
      if (!deps.rounds.hasQueued(task.id)) break;
      // The first run may have given its slot back when no note waited yet. A
      // pass never runs without an admitted slot: that would put the profile
      // over its limit. With none free, the notes wait, open, for "Start round".
      if (input.retained.reservation === undefined) {
        const selected = await deps.runtimeManager.select([profile], runtimeCapabilitiesFor(task));
        if (selected.ok) input.retained.reservation = selected.value.reservation;
        const overtakenWhileSelecting = this.#overtaken(task, scope, input.signal);
        if (overtakenWhileSelecting !== null) return { kind: 'stopped', outcome: overtakenWhileSelecting };
        if (!selected.ok) {
          deps.recorder.note(
            scope,
            `A note arrived while '${task.key}' was running, but its runtime cannot take another pass now (${summarize(describeRejections(selected.error.rejections), 200)}). The note waits as an open note; start a round to deliver it.`,
            'warn',
          );
          break;
        }
      }
      const delivered = deps.rounds.promoteQueued(task);
      if (delivered.length === 0) break;
      deps.recorder.note(scope, `Delivering ${delivered.length === 1 ? 'a note' : `${delivered.length} notes`} to '${task.key}' now that its pass has ended.`);
      const opened = (await deps.rounds.openRound(task))!;
      // The pass edits what this attempt just wrote, in every round, not the last round's output.
      const drafts: LoadedArtifact[] = [];
      for (const manifest of harvest.manifests) {
        try {
          drafts.push(await deps.artifactStore.read(manifest.id));
        } catch (e) {
          deps.recorder.note(scope, `Could not read the ${manifest.type} draft for the note: ${errorMessage(e)}`, 'warn');
        }
      }
      const brief: RoundBrief = { ...opened, previous: drafts, delivery: true };
      const fresh = await this.#compilePrompt({ ...input, feedback: null, round: brief });
      const session = deps.runs.get(lastRunId)?.externalSessionId ?? null;
      const resumable = session !== null && input.adapter.resume !== undefined
        && deps.runtimeManager.capabilities(profile).includes('session_resume');
      const destinations = task.expectedOutputs.map((type) => `${outDirFor(task)}/${type}.md`);
      const overtakenBeforeRun = this.#overtaken(task, scope, input.signal);
      if (overtakenBeforeRun !== null) return { kind: 'stopped', outcome: overtakenBeforeRun };
      const outcome = await this.#drive({
        task, mission: input.mission, role: input.role, profile, adapter: input.adapter, target: input.target, assignment: input.assignment,
        prompt: resumable ? roundRequest(brief, destinations, { inPlace: true }) : fresh.prompt, freshPrompt: fresh.prompt,
        continueSession: resumable ? session : null, grants: input.grants, scope, signal: input.signal, agent: input.agent,
        runId: ids.run(), mcpConfigPath: input.mcpConfigPath, skills: input.skills?.received ?? null,
        // The slot is handed on and kept again, since another pass may follow this one.
        reservation: takeReservation(input.retained), retainSlot: input.retained,
        purpose: 'feedback', round: task.round ?? 1, inputs: fresh.includedArtifactIds,
      });
      if (outcome.interrupted) {
        // As for a tighten pass: the round already passed, so it settles from
        // what it had, and the notes go back to waiting; the sweep shows them
        // as open once the task has settled. Nothing should resume this run.
        deps.runs.update(outcome.runId, {
          status: 'INTERRUPTED',
          errorMessage: 'Tandemise stopped while delivering a note; the round was settled from the output before it.',
        });
        deps.rounds.requeue(delivered);
        deps.recorder.note(scope, `Tandemise stopped while '${task.key}' was taking a note. The output before it stands, and the note waits.`, 'warn');
        return { kind: 'harvest', harvest, assessed, lastRunId, checks };
      }
      const stopped = this.#stopped(outcome, task, scope) ?? this.#overtaken(task, scope, input.signal);
      if (stopped !== null) return { kind: 'stopped', outcome: stopped };
      if (outcome.failure !== null) {
        // Spec §4, the tighten pass's rule: a pass that broke at the runtime
        // never fails the attempt that passed before it. That output stands,
        // and the notes wait for a round a person starts.
        if (outcome.failure.code === RUNTIME_SIGNED_OUT) deps.runtimeManager.invalidateHealth(profile.id);
        // A sign-out hands a continued session on as resumable; this round is closing, so nothing may resume it.
        if (outcome.status === 'RESUMABLE') {
          deps.runs.update(outcome.runId, { status: 'INTERRUPTED', errorMessage: 'The pass delivering a note did not finish; the round was settled from the output before it.' });
        }
        deps.rounds.requeue(delivered);
        deps.recorder.note(
          scope,
          `The pass delivering ${delivered.length === 1 ? 'a note' : `${delivered.length} notes`} to '${task.key}' did not finish (${outcome.failure.code}: ${summarize(outcome.failure.message, 300)}). `
          + 'The output before it stands; start a round to deliver the notes.',
          'warn',
        );
        return { kind: 'harvest', harvest, assessed, lastRunId, checks };
      }
      const refs = await this.#commit(input.target, task, input.role, profile, outcome.runId, scope);
      const second = await deps.harvester.harvest({
        mission: input.mission, task, target: input.target, runId: outcome.runId, roleId: input.role.id,
        scope: { ...scope, runId: outcome.runId, runtimeProfileId: profile.id }, sourceRefs: refs,
        authorId: input.agent?.id ?? RUNTIME_ACTOR, revising: harvest.manifests, roundContract: deps.rounds.roundContract(task, brief),
      });
      input.produced.push(...second.manifests);
      const rewritten = new Map(second.manifests.map((m) => [m.type, m]));
      const manifests = harvest.manifests.map((m) => rewritten.get(m.type) ?? m);
      const live = new Set(manifests.map((m) => m.id));
      harvest = {
        ...harvest,
        manifests,
        // A type the pass broke (a citation missing) is missing now, so the gate fails and the retry names it.
        // Deliberately a counted failure, unlike a pass that broke at the runtime: spec §5 makes a handoff
        // that drops a note it owes a malformed artifact, whichever pass wrote it.
        missing: task.expectedOutputs.filter((type) => !rewritten.has(type)),
        issues: second.issues,
        unanswered: second.unanswered,
        // As in the tighten pass: a draft the pass left standing keeps its over-budget flag.
        overBudget: [...second.overBudget, ...harvest.overBudget]
          .filter((o, i, all) => live.has(o.artifactId) && all.findIndex((x) => x.artifactId === o.artifactId) === i),
        ...(second.filesChanged === undefined ? {} : { filesChanged: second.filesChanged }),
      };
      lastRunId = outcome.runId;
      if (harvest.overBudget.length === 0 && !deps.rounds.hasQueued(task.id)) releaseSlot(input.retained);
      // The pass edited the work the first checks measured. The gate reads the
      // newest results and the reviews are handed these, so a note that broke
      // the tests is judged on the tests as they are now, not as they were.
      checks = await deps.checks.run({
        task, repository: input.repository, target: input.target, runId: outcome.runId, scope: { ...scope, runId: outcome.runId }, signal: input.signal,
      });
      const overtakenAfterChecks = this.#overtaken(task, scope, input.signal);
      if (overtakenAfterChecks !== null) return { kind: 'stopped', outcome: overtakenAfterChecks };
      assessed = this.#assess(task, harvest, null, scope, outcome.runId);
      this.#score(task, input.mission, outcome.runId, assessed, harvest);
      if (!assessed.verdict.passed) break;
    }
    return { kind: 'harvest', harvest, assessed, lastRunId, checks };
  }

  /**
   * Settles a round whose tighten pass a daemon death cut short.
   *
   * Recognised by its `artifact.tighten_requested` for the current attempt
   * with no settling `task.status` after it: recovery requeues a task without
   * recording a transition, so nothing has concluded that round. Its drafts
   * are already stored and its gate already passed, so it goes straight to
   * the reviews, exactly as a pass that failed would have.
   */
  #concludeInterruptedTighten(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    role: RoleTemplate,
    scope: EventScope,
  ): TaskAttemptOutcome | null {
    const { deps } = this;
    if (task.attempts === 0) return null;
    // The scan below reads every semantic event of the mission, and this runs on
    // every start. A tighten pass is only ever requested for artifacts stored
    // over budget, and a pass cut short leaves its run RESUMABLE or INTERRUPTED,
    // so a task with neither cannot have one to settle and skips the scan.
    const cutShort = deps.runs.listByTask(task.id).some((r) => r.status === 'RESUMABLE' || r.status === 'INTERRUPTED');
    if (!cutShort && !deps.artifacts.listByTask(task.id).some((a) => a.overBudget === true)) return null;
    const events = deps.events.listByMission(task.missionId, { semanticOnly: true }).filter((e) => e.taskId === task.id);
    let at = -1;
    events.forEach((e, i) => {
      if (e.body.type === 'artifact.tighten_requested' && e.body.attempt === task.attempts) at = i;
    });
    if (at === -1) return null;
    const request = events[at]!.body as Extract<RunEventRecord['body'], { type: 'artifact.tighten_requested' }>;
    const settled = events.slice(at + 1).some((e) => e.body.type === 'task.status'
      && e.body.to !== 'RUNNING' && e.body.to !== 'AWAITING_INPUT');
    if (settled) return null;

    // The pass's session belongs to a closed round; nothing should resume it.
    for (const run of deps.runs.listByTask(task.id)) {
      if (run.status !== 'RESUMABLE') continue;
      deps.runs.update(run.id, {
        status: 'INTERRUPTED',
        errorMessage: 'Tandemise restarted during the tighten pass; the round was settled from its first draft.',
      });
    }
    deps.recorder.note(
      scope,
      `Tandemise restarted during the tighten pass for '${task.key}'. The round had already passed, so it is settled from the drafts on record.`,
      'warn',
    );
    const all = deps.artifacts.listByTask(task.id);
    const superseded = new Set(all.map((a) => a.supersedes).filter((id) => id !== null));
    this.#recordOverBudget(scope, all
      .filter((a) => !superseded.has(a.id) && a.overBudget === true)
      .map((a) => ({ artifactId: a.id, type: a.type, words: a.wordCount ?? 0, budget: deps.measure.measure(a.type, '').budget })));

    // The round passed before the daemon died, so it lands here as it would have
    // after the pass: its cited notes are answered and work kept on the old
    // version is told. Otherwise the notes stay in the round for good.
    deps.rounds.onRoundLanded(task, all.filter((a) => !superseded.has(a.id)), scope);
    const measured = request.filesChanged === undefined ? {} : { filesChanged: request.filesChanged };
    const gate = deps.gates.evaluate(task, measured);
    const outcome = deps.reviews.onRoundPassed({ task, mission, workspace, role, gate, checks: [], scope, measured });
    return this.#settle(task, scope, outcome.status, outcome.reason);
  }

  /** Called only for a passed round with artifacts over budget, so the scan is already that rare. */
  #tightenedThisRound(task: MissionTask): boolean {
    return this.deps.events.listByMission(task.missionId, { semanticOnly: true }).some((e) => e.taskId === task.id
      && e.body.type === 'artifact.tighten_requested'
      && e.body.attempt === task.attempts);
  }

  #recordOverBudget(scope: EventScope, overBudget: readonly OverBudgetArtifact[]): void {
    for (const over of overBudget) {
      this.deps.recorder.record(scope, {
        type: 'artifact.over_budget',
        artifactId: over.artifactId,
        artifactType: over.type,
        words: over.words,
        budget: over.budget,
      });
    }
  }

  /**
   * The outcome of a pass whose task was taken from it after its run ended:
   * the row moved on (a Redo reset it to PENDING, a cancel settled it), or a
   * person cancelled the pass. The row's status stands, as it does for a run
   * cancelled mid-way. Null when the pass should settle as usual; a daemon
   * stopping is left to finish settling, since the work itself is done.
   */
  #overtaken(running: MissionTask, scope: EventScope, signal: AbortSignal): TaskAttemptOutcome | null {
    const current = this.deps.tasks.get(running.id);
    if (current !== undefined && !LIVE_RUN_STATUSES.includes(current.status)) {
      return { kind: 'settled', status: current.status, reason: current.statusReason };
    }
    if (!signal.aborted || isDaemonStopping(signal)) return null;
    return this.#stopped({ cancelled: true, interrupted: false }, running, scope);
  }

  /**
   * The outcome for an attempt whose task row changed before it marked the
   * task RUNNING (a round upstream held it back to PENDING), or null.
   */
  #changedSince(task: MissionTask): TaskAttemptOutcome | null {
    const current = this.deps.tasks.get(task.id);
    if (current === undefined || current.status === task.status) return null;
    return { kind: 'settled', status: current.status, reason: current.statusReason };
  }

  /**
   * Sets aside what an overtaken pass harvested. It was never judged, and a
   * card or a reader showing it as the task's output would present work made
   * from the old version as current.
   */
  #withdrawOutput(task: MissionTask, scope: EventScope, manifests: readonly ArtifactManifest[]): void {
    const ids = [...new Set(manifests.map((m) => m.id))];
    if (ids.length === 0) return;
    this.deps.artifacts.withdraw(ids, this.deps.clock.now());
    this.deps.recorder.note(
      scope,
      `'${task.key}' was reset before its pass was judged, so the ${ids.length === 1 ? 'output it produced was' : `${ids.length} outputs it produced were`} set aside.`,
    );
    this.deps.recorder.invalidate('artifacts', task.missionId);
  }

  /** The outcome of a run the daemon or a person stopped, or null when it ran to an end. */
  #stopped(outcome: Pick<DriveOutcome, 'cancelled' | 'interrupted'>, running: MissionTask, scope: EventScope): TaskAttemptOutcome | null {
    if (!outcome.interrupted && !outcome.cancelled) return null;
    // A person holds the task: it stays HELD however its run stopped, and its
    // queued notes wait for the pass that continues from the hold.
    const current = this.deps.tasks.get(running.id);
    if (current?.status === 'HELD') return { kind: 'settled', status: 'HELD', reason: current.statusReason };
    if (outcome.interrupted) {
      // Back to the queue with its attempt count kept, exactly as recovery
      // treats a run the last daemon left behind; the next start resumes it.
      // A note that waited for this pass rides with that start instead.
      this.deps.rounds.promoteQueued(running);
      return this.#settle(running, scope, 'READY', 'Tandemise stopped mid-run; this task resumes when it starts again.');
    }
    if (outcome.cancelled) {
      // Cancelled so that something else could happen - a retry with more
      // access requeues the task and stops its run. The run ends after that
      // decision, and settling it CANCELLED here overwrote the retry.
      if (current !== undefined && !LIVE_RUN_STATUSES.includes(current.status)) {
        return { kind: 'settled', status: current.status, reason: current.statusReason };
      }
      return this.#settle(running, scope, 'CANCELLED', 'Cancelled before the run finished.');
    }
    return null;
  }

  // -------------------------------------------------------------------- policy

  /** What the role and the task ask for, scoped to this target; `#vet` decides what of it is granted. */
  #requestedGrants(
    role: RoleTemplate, task: MissionTask, workspace: Workspace, repository: Repository | null, target: ExecutionTarget,
  ): readonly CapabilityGrant[] {
    return this.deps.grantBuilder.build({
      role,
      task,
      autonomy: workspace.autonomy,
      workingDirectory: target.workingDirectory,
      artifactRoot: this.deps.paths.artifacts(workspace.id),
      readOnlyPaths: repository === null ? [] : [repository.path],
      // The repository this task works in, as the code host names it. Without
      // it every github.* grant carried an empty scope and was denied: a
      // task that had pushed its branch could not open its pull request.
      allowedRepositories: [githubSlug(repository?.remoteUrl ?? null)].filter((s): s is string => s !== null),
      // Wall time plus the longest the run may be parked on a person. This does
      // not extend what the worker can do: a grant is only exercisable through
      // the run-scoped tool socket, which is destroyed with the run, and the
      // run's *active* time is still bounded by its deadline. A TTL of wall
      // time alone would expire every grant while a question sat unanswered,
      // and the worker would come back from the answer unable to act on it.
      ttlMs: task.executionPolicy.maxWallTimeMs + MAX_PARKED_MS,
    });
  }

  /**
   * Runs every grant the builder produced through the policy engine before the
   * worker is launched (MVP.md §19.2).
   *
   * The grant builder answers "what did the role and the task ask for?". That
   * is a *description*. The policy engine answers "what does this workspace
   * permit, at this risk class, right now?" - and that is the decision. Without
   * this step the engine's shell classification and autonomy dials are computed
   * and discarded, and a worker is handed whatever its role template listed.
   *
   * A denied capability is dropped from the grant set and recorded as
   * `policy.denied`, so the worker is launched strictly narrower rather than
   * failing later for a reason nobody can see. A denied capability the task
   * declared as *required* is different: running without it would produce work
   * that silently does not do what the plan said, so the task blocks.
   */
  #vet(
    grants: readonly CapabilityGrant[],
    task: MissionTask,
    workspace: Workspace,
    scope: EventScope,
  ): { grants: readonly CapabilityGrant[]; blockedOn: string | null } {
    const required = new Set(task.requiredCapabilities);
    const allowed: CapabilityGrant[] = [];

    for (const grant of grants) {
      const decision = this.deps.policy.evaluate({
        capability: grant.capability,
        ...(grant.resourceScope[0] === undefined ? {} : { resource: grant.resourceScope[0] }),
        grants,
        autonomy: workspace.autonomy,
      });
      if (decision.outcome !== 'deny') {
        allowed.push(grant);
        continue;
      }
      this.deps.recorder.record(scope, {
        type: 'policy.denied',
        capability: grant.capability,
        reason: decision.reason,
      });
      if (required.has(grant.capability)) {
        return {
          grants: allowed,
          blockedOn: `'${task.key}' requires '${grant.capability}', which policy refuses: ${decision.reason}`,
        };
      }
    }
    return { grants: allowed, blockedOn: null };
  }

  // ------------------------------------------------------------------- context

  async #compilePrompt(input: PromptInput): Promise<{ readonly prompt: string; readonly includedArtifactIds: readonly ArtifactId[]; readonly brain?: import('@tandemise/domain').RunBrain }> {
    const { task, mission, workspace, role, trial, grants, target, scope } = input;
    const dependencies = await this.#loadDependencies(task, scope, input.role);
    // #51: what this attempt reads from the brain, at one commit.
    const brain = await this.deps.brain?.forAttempt({
      task, mission, role, trial, dependencies, round: task.round ?? 1,
      repositories: this.deps.repositories.listByWorkspace(workspace.id), previousRuns: this.deps.runs.listByTask(task.id),
    });

    const expected: readonly ExpectedArtifact[] = task.expectedOutputs.map((type) => ({
      type,
      template: this.deps.templates.render(type) ?? `(no template is defined for ${type}; write clear Markdown.)`,
      destination: `${outDirFor(task)}/${type}.md`,
      wordBudget: this.deps.measure.measure(type, '').budget,
    }));

    // The ledger as the gates will measure it, so the prompt names the same ids.
    const ledger = this.deps.gates.trace(mission.id).trace.rows.map((r) => r.criterion);
    // #106: what Tandemise runs after this pass, so the agent need not run it too.
    const planned = trial === undefined || trial === null ? await this.deps.checks.planned(task, input.repository) : [];
    // #117: what people said during this step's holds, binding on every later pass.
    const personSaid = personSaidSection(
      this.deps.holds.listByMission(task.missionId)
        .filter((h) => h.taskId === task.id && h.endedAt !== null)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((hold) => ({ hold, said: readPersonSaid(hold) })),
    );
    const compiled = this.deps.contextCompiler.compile({
      role,
      workspaceName: workspace.name,
      criteria: ledger.map((c) => ({ key: c.key, statement: c.statement, covers: c.covers })),
      // An eval trial reads the case's frozen answers, knowledge and decisions, not today's.
      answers: trial?.answers ?? (this.deps.questions?.listByMission(mission.id) ?? [])
        .flatMap((q) => (q.status === 'answered' && q.answer !== null ? [{ key: q.key, text: q.text, answer: q.answer }] : [])),
      knowledge: trial?.knowledge ?? workspace.knowledge,
      mission,
      task,
      dependencyArtifacts: dependencies,
      decisions: trial?.decisions ?? this.deps.decisions.listByMission(mission.id).filter((d) => d.status === 'accepted'),
      evidence: [],
      grants,
      ...(brain === undefined ? {} : { brain: brain.request }),
      outputContract: {
        artifacts: expected,
        workingDirectory: target.workingDirectory,
        completionGate: task.completionGate,
        notes: [
          // #51: a project with no brain is not told about the brain's tools.
          ...this.#contractNotes(task, target, brain === undefined ? input.tools.filter((name) => !name.startsWith('brain.')) : input.tools, input.feedback, input.tighten, input.round ?? null),
          ...ledgerNotes(task, ledger),
          ...(planned.length === 0 ? [] : [plannedChecksNote(planned)]),
          ...(personSaid === null ? [] : [personSaid]),
        ],
      },
    });

    if (compiled.truncated.length > 0) {
      this.deps.recorder.note(
        scope,
        `Context budget bound: ${compiled.truncated.map((t) => `${t.section} ${t.action}`).join(', ')}.`,
        'warn',
      );
    }
    // P13: the pinned skills - one line each when the runtime loads them from
    // its skills folder, the whole SKILL.md when it cannot.
    const skillSection = input.skills?.promptSection ?? null;
    const prompt = skillSection === null ? compiled.prompt : `${compiled.prompt.trimEnd()}\n\n${skillSection}\n`;
    // Files attached to the notes this pass answers are shown in the round's
    // brief, not by the compiler, so they are added to what the run records it
    // read (spec A3); a continued session gets the same brief and records the same.
    const attached = (input.round?.attachments ?? []).map((a) => a.manifest.id).filter((id) => !compiled.includedArtifactIds.includes(id));
    return { prompt, includedArtifactIds: [...compiled.includedArtifactIds, ...attached], ...(brain === undefined ? {} : { brain: brain.record }) };
  }

  #contractNotes(
    task: MissionTask,
    target: ExecutionTarget,
    tools: readonly string[],
    feedback: string | null,
    tighten: TightenPrompt | undefined,
    round: RoundBrief | null,
  ): readonly string[] {
    const notes = [
      `Write each artifact to its own file under \`${outDirFor(task)}/\` in ${target.workingDirectory}. `
      + `The file name is the artifact type followed by \`.md\` — for example \`${outDirFor(task)}/ProductSpec.md\`. `
      + 'Tandemise reads those files after your run ends; anything you only describe in conversation is discarded.',
      `\`${ARTIFACT_OUT_DIR}/\` is git-ignored, so writing there never pollutes the diff.`,
    ];
    if (target.kind === 'worktree') {
      const branch = target.describe().branch;
      notes.push(
        `You are on your own branch${branch ? ` (\`${branch}\`)` : ''} in an isolated worktree `
        + `at ${target.workingDirectory}. Commit your code changes here, on this branch. `
        + 'Anything left uncommitted is committed for you and attributed to this run.',
        // Repository instructions often say "create a worktree and a feature
        // branch first". Followed here, the work lands on a branch Tandemise
        // does not know, and the reviewer and tester - whose worktrees are cut
        // from this one - review a tree without the change in it.
        'Do not create another worktree, clone, or branch to do this work, even if the repository\'s own '
        + 'instructions (CLAUDE.md, AGENTS.md, contributing docs) say to: this worktree already is that '
        + 'isolation, and downstream review and QA read this branch. If a later task needs a differently named '
        + 'branch - for a pull request, say - push this branch under that name rather than moving the work.',
      );
    }
    if (tools.length > 0) {
      notes.push(
        `Integration tools available to you: ${tools.join(', ')}. `
        + 'Every call is checked against this task\'s grants; one that needs a human is paused, not refused.',
      );
    }
    // #51: the "propose additions after" half of the brain.
    if (tools.includes('brain.propose')) notes.push('If you learned something the next person doing this step should know, call brain.propose with one short sentence.');
    // The retry feedback loop: the previous attempt's failure, stated verbatim.
    // Quoted rather than paraphrased on purpose - the worker needs the exact
    // condition Tandemise measured, not this system's opinion about it.
    if (feedback !== null && feedback.trim().length > 0) {
      notes.push(
        `Your previous attempt did not satisfy this task's completion gate. `
        + `Tandemise measured: ${feedback} `
        + 'Fix exactly that before you finish; nothing else about the task has changed. '
        // #117: a retry told only "the tests failed" edited an unrelated check
        // to get green, and reverted what a person had asked for.
        + 'Your previous work is committed on this branch: build on it, do not start over. Keep the change scoped '
        + 'to this task: do not edit files outside it (other tests, checks, configuration) to make a measurement '
        + 'pass, and do not undo anything a person asked for. Tandemise flags files a retry adds to the change.',
      );
    }
    // An owner's request, not a gate failure (P0 lesson): the round passed, or the person chose to go again.
    if (round !== null) notes.push(renderRoundBrief(round, (type) => `${outDirFor(task)}/${type}.md`));
    // An editor's request, not a gate failure: the round already passed, and
    // an author told it failed rewrites from scratch instead of cutting.
    if (tighten !== undefined) {
      notes.push(
        `${tightenPreamble()}\n${tighten.feedback}\n`
        + 'Edit your draft rather than rewriting it: keep what it says, say it in fewer words.'
        + tighten.drafts.map((draft) => `\n\nYour ${draft.manifest.type} draft, to edit and write back to `
          + `\`${outDirFor(task)}/${draft.manifest.type}.md\`:\n\n\`\`\`\`markdown\n${capDraft(draft.body.trimEnd())}\n\`\`\`\``).join(''),
      );
    }
    return notes;
  }

  async #loadDependencies(task: MissionTask, scope: EventScope, role?: RoleTemplate): Promise<readonly LoadedArtifact[]> {
    const loaded: LoadedArtifact[] = [];
    const upstream = upstreamTaskIds(task, this.deps.tasks.listByMission(task.missionId));
    // #191: the planning documents the role checks work against (a reviewer
    // reads the ProductSpec and ArchitecturePlan), when the mission has them,
    // even if the step listed only the change. They sit outside the worktree,
    // so a step not handed them cannot read them at all.
    const listed = new Set(task.inputArtifacts.map((r) => r.type));
    const planning = (role?.consumesArtifacts ?? [])
      .filter((type) => PLANNING_ARTIFACTS.includes(type) && !listed.has(type) && !task.expectedOutputs.includes(type))
      .map((type) => ({ type, required: false }));
    for (const requirement of [...task.inputArtifacts, ...planning]) {
      // Every live artifact of the type from an upstream task, not just the
      // newest in the mission: a product document fed by web and mobile
      // research needs both briefs. Falls back to the newest when nothing
      // upstream produced one (an input produced outside the graph).
      const fromUpstream = liveArtifacts(this.deps.artifacts, task.missionId, requirement.type)
        .filter((a) => a.taskId !== null && upstream.has(a.taskId));
      const latest = this.deps.artifacts.latest(task.missionId, requirement.type);
      const manifests = fromUpstream.length > 0 ? fromUpstream : latest === undefined ? [] : [latest];
      if (manifests.length === 0) {
        if (requirement.required) {
          this.deps.recorder.note(
            scope,
            `Required input artifact ${requirement.type} does not exist; ${task.key} runs without it.`,
            'warn',
          );
        }
        continue;
      }
      for (const manifest of manifests) {
        try {
          loaded.push(await this.deps.artifactStore.read(manifest.id));
        } catch (e) {
          this.deps.recorder.note(scope, `Could not read ${requirement.type}: ${errorMessage(e)}`, 'warn');
        }
      }
    }
    return loaded;
  }

  // ------------------------------------------------------------------- targets

  /**
   * The branch a downstream task should start from.
   *
   * Walks this task's transitive dependencies for the most recent `ChangeSet`
   * and returns the branch it recorded. Null when nothing upstream produced
   * code - a product or design task has nothing to check out, and the base
   * branch is correct for it.
   *
   * Only *upstream* changesets count. A ChangeSet produced by a parallel task
   * this one does not depend on is not part of what it was asked to evaluate,
   * and silently folding it in would make a review report about code the
   * reviewer was never shown.
   */
  /**
   * The repository a task works in: its own, or the mission's when it names none.
   *
   * Most tasks name none. One that does is how a mission spanning several of a
   * project's repositories stays a single dependency graph.
   */
  #repositoryFor(task: MissionTask, mission: Mission): Repository | null {
    const id = task.repositoryId ?? mission.repositoryId;
    return id === null ? null : this.deps.repositories.get(id) ?? null;
  }

  #upstreamChangeBranch(task: MissionTask, mission: Mission): string | null {
    const all = this.deps.tasks.listByMission(mission.id);
    const byKey = new Map(all.map((t) => [t.key, t]));

    const upstream = new Set<string>();
    const walk = (key: string): void => {
      for (const dep of byKey.get(key)?.dependsOn ?? []) {
        if (upstream.has(dep)) continue;
        upstream.add(dep);
        walk(dep);
      }
    };
    walk(task.key);
    if (upstream.size === 0) return null;

    // Only upstream tasks in the *same* repository. A mission may span several
    // of a project's repositories, and a branch cut in one of them does not
    // exist in another - checking it out would fail, and matching it by name
    // against an unrelated branch would be worse.
    const ownRepository = task.repositoryId ?? mission.repositoryId;
    const upstreamIds = new Set(
      [...upstream]
        .map((key) => byKey.get(key))
        .filter((t): t is MissionTask => t !== undefined)
        .filter((t) => (t.repositoryId ?? mission.repositoryId) === ownRepository)
        .map((t) => t.id),
    );
    if (upstreamIds.size === 0) return null;

    // Newest first: after a remediation cycle the fix task's ChangeSet is the
    // one that should be reviewed, not the original. Only live ones: a change
    // handed back as a file (spec A4) replaces the agent's but names no
    // branch, and the agent's retired branch must not be what work after it
    // is cut from; with no live branch upstream, the mission base is.
    const changeSets = liveArtifacts(this.deps.artifacts, mission.id, 'ChangeSet')
      .filter((a) => a.taskId !== null && upstreamIds.has(a.taskId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    for (const artifact of changeSets) {
      const branch = artifact.sourceRefs.find((r) => r.kind === 'git.branch')?.value;
      if (branch) return branch;
    }
    return null;
  }

  async #provisionTarget(
    kind: TargetKind,
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    repository: Repository | null,
    scope: EventScope,
    upstreamBranch: string | null,
  ): Promise<{ ok: true; target: ExecutionTarget } | { ok: false; reason: string }> {
    if (repository === null && kind !== 'local') {
      return { ok: false, reason: `Task '${task.key}' needs a ${kind} target but the mission has no repository.` };
    }
    const repositoryPath = repository?.path ?? this.deps.paths.mission(workspace.id, mission.id);
    const id = ids.executionTarget();
    const name = `${slugify(mission.title)}-${task.key}`;

    this.deps.targets.create({
      id,
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind,
      name,
      workingDirectory: repositoryPath,
      branch: null,
      baseBranch: upstreamBranch ?? mission.baseBranch,
      status: 'PROVISIONING',
      detail: null,
      createdAt: this.deps.clock.now(),
      releasedAt: null,
    });

    try {
      const target = await this.deps.targetManager.provision({
        id,
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: task.id,
        kind,
        name,
        repositoryPath,
        baseBranch: upstreamBranch ?? mission.baseBranch ?? repository?.defaultBranch,
        missionSlug: slugify(mission.title),
        // #138: built on an upstream step's work, so it runs on that work as it is now.
        syncToBase: upstreamBranch !== null,
      });
      const record = target.describe();
      this.deps.targets.update(id, {
        workingDirectory: record.workingDirectory,
        branch: record.branch,
        baseBranch: record.baseBranch,
        status: 'IN_USE',
        detail: record.detail,
      });
      this.deps.recorder.invalidate('targets', mission.id);
      return { ok: true, target };
    } catch (e) {
      this.deps.targets.update(id, { status: 'FAILED', detail: summarize(errorMessage(e), 500) });
      this.deps.recorder.note(scope, `Could not provision a ${kind} target: ${errorMessage(e)}`, 'error');
      return { ok: false, reason: `Target provisioning failed: ${errorMessage(e)}` };
    }
  }

  async #releaseTarget(target: ExecutionTarget, kind: TargetKind): Promise<void> {
    const record = target.describe();
    if (kind === 'worktree') {
      // The branch and its tree are the reviewable output of the task. Leaving
      // them is not laziness; discarding them would destroy the work. A
      // hand-back that landed as the run wound down has already retired the
      // target, and that stands.
      if (this.deps.targets.get(record.id)?.status !== 'RELEASED') this.deps.targets.update(record.id, { status: 'READY' });
      await target.dispose();
      return;
    }
    try {
      await this.deps.targetManager.release(record);
      this.deps.targets.update(record.id, { status: 'RELEASED', releasedAt: this.deps.clock.now() });
    } catch (e) {
      this.deps.log.warn('target.release_failed', { targetId: record.id, error: errorMessage(e) });
    }
  }

  // ---------------------------------------------------------------------- git

  /**
   * Commits whatever the worker left behind, attributed to the role and the run
   * (MVP.md §P7). Failure here is recorded and stepped over: losing the commit
   * is bad, losing the artifacts the run already produced would be worse.
   */
  async #commit(
    target: ExecutionTarget,
    task: MissionTask,
    role: RoleTemplate,
    profile: RuntimeProfile,
    runId: RunId,
    scope: EventScope,
  ): Promise<readonly ExternalRef[]> {
    const record = target.describe();
    const refs: ExternalRef[] = [];
    if (record.branch !== null) {
      refs.push({ kind: 'git.branch', value: record.branch, label: `${task.key} branch` });
    }
    if (target.kind !== 'worktree') return refs;

    try {
      const status = await target.exec({ command: 'git', args: ['status', '--porcelain'] });
      if (status.exitCode === 0 && status.stdout.trim().length > 0) {
        const name = `Tandemise ${role.name}`;
        const email = `${role.id}@tandemise.local`;
        await target.exec({ command: 'git', args: ['add', '--all'] });
        const commit = await target.exec({
          command: 'git',
          args: [
            '-c', `user.name=${name}`,
            '-c', `user.email=${email}`,
            '-c', 'commit.gpgsign=false',
            'commit',
            '--message', commitMessage(task, role, profile, runId),
          ],
        });
        if (commit.exitCode !== 0) {
          this.deps.recorder.note(scope, `Could not commit the worker's changes: ${summarize(commit.stderr, 400)}`, 'warn');
        }
      }
      const head = await target.exec({ command: 'git', args: ['rev-parse', 'HEAD'] });
      if (head.exitCode === 0 && head.stdout.trim().length > 0) {
        refs.push({ kind: 'git.commit', value: head.stdout.trim(), label: `${task.key} HEAD` });
      }
    } catch (e) {
      this.deps.recorder.note(scope, `Git bookkeeping failed after the run: ${errorMessage(e)}`, 'warn');
    }
    return refs;
  }

  // ------------------------------------------------------------------- leases

  /**
   * Exclusive claims on anything two runs must not share. Contention is an
   * ordinary scheduling outcome, so a failed acquisition releases what it
   * already holds and asks to be tried again - it never errors.
   */
  #acquireLeases(
    task: MissionTask,
    mission: Mission,
    repository: Repository | null,
    /**
     * For a hold: a lease this task already holds with no run (an open hold's,
     * kept across a restart) is taken up and renewed, not acquired again,
     * which would refuse it as held by someone.
     */
    adoptOwn = false,
  ): { ok: true; held: readonly ResourceLease[] } | { ok: false; reason: string; held: readonly ResourceLease[] } {
    const held: ResourceLease[] = [];
    const own = adoptOwn ? this.deps.leases.listAll().filter((l) => l.holderTaskId === task.id && l.holderRunId === null) : [];
    for (const key of resourceKeysFor(task, mission, repository)) {
      const kept = own.find((l) => l.resourceKey === key);
      const lease = kept !== undefined && this.deps.leases.renew(kept.id, LEASE_TTL_MS)
        ? kept
        : this.deps.leases.acquire(key, { taskId: task.id }, LEASE_TTL_MS);
      if (lease === undefined) {
        for (const acquired of held) this.deps.leases.release(acquired.id);
        return {
          ok: false,
          reason: key.endsWith(':worktree')
            ? 'Queued: another task is working directly in this repository checkout, and tasks that run in place take turns.'
            : `Queued: resource '${key}' is held by another task.`,
          held: [],
        };
      }
      held.push(lease);
    }
    return { ok: true, held };
  }

  // ---------------------------------------------------------------- approvals

  #approvalBeforeStart(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    role: RoleTemplate,
    scope: EventScope,
  ): TaskAttemptOutcome | null {
    // Trial tasks are written with NO_APPROVAL; this guards it, since nobody would answer the card.
    if (!task.approvalPolicy.beforeStart || isTrialMission(mission)) return null;
    const existing = this.deps.approvals.pendingForTask(task.id).find((a) => a.kind === 'action');
    if (existing !== undefined) {
      return { kind: 'settled', status: 'AWAITING_APPROVAL', reason: existing.title };
    }
    const decided = this.deps.approvals
      .list({ missionId: mission.id, statuses: ['APPROVED'] })
      .some((a) => a.taskId === task.id && a.kind === 'action');
    if (decided) return null;

    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind: 'action',
      risk: 'write_reversible',
      title: `Start ${task.title}?`,
      rationale: task.approvalPolicy.reason ?? `The plan requires approval before '${task.key}' runs.`,
      effect: `${role.name} will run in a ${task.executionPolicy.isolation} target and may use: `
        + `${task.executionPolicy.capabilities.join(', ') || 'no capabilities'}.`,
      evidence: [
        { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
        { kind: 'text', label: 'Mission goal', value: summarize(mission.goal, 400) },
        // The exact list this yes covers: the step's tool calls for these are
        // not asked about again (#141). Never summarised - a cut list would
        // bind a capability the person never saw.
        ...(task.executionPolicy.capabilities.length === 0 ? [] : [{
          kind: 'text' as const, label: STEP_CAPABILITIES_LABEL, value: task.executionPolicy.capabilities.join(', '),
        }]),
      ],
      ...this.deps.reviews.addressFor(task, workspace.id),
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
    this.deps.recorder.invalidate('approvals', mission.id);
    return this.#settle(task, scope, 'AWAITING_APPROVAL', approval.title);
  }

  #createInterventionApproval(
    task: MissionTask,
    mission: Mission,
    workspace: Workspace,
    detail: string,
    words?: { readonly title: string; readonly rationale: string },
  ): Approval {
    const gateNow = this.deps.gates.evaluate(task);
    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind: 'intervention',
      risk: 'read',
      title: words?.title ?? `${task.title} exhausted its retries`,
      rationale: words?.rationale ?? `'${task.key}' failed its completion gate on every one of its ${task.retryPolicy.maxAttempts} attempts.`,
      effect: 'Retrying returns the task to the queue for one more attempt. Accepting marks its result good enough and lets dependent work continue. Leaving it blocked stops here.',
      evidence: [
        { kind: 'text', label: 'Last measurement', value: summarize(detail, 1000) },
        // What the gate reads NOW, not what it read when the attempt failed.
        // A task can exhaust its retries and still be sound - the work passes
        // and the gate is the thing that cannot be met - and without this the
        // card is a dead end: three options and no way to tell which is right.
        // When every condition is already met, the block is the last thing
        // standing and one more attempt clears it.
        ...(gateNow === null ? [] : [{
          kind: 'text' as const,
          label: 'What the gate reads now',
          value: gateNow.passed
            ? 'Every condition is met as the work stands. One more attempt should clear it.'
            : summarize(gateNow.detail, 600),
        }]),
        ...doneWhenEvidence(task, this.deps.gates.trace(mission.id).trace),
        { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
      ],
      options: [
        { id: 'approve', label: 'Retry once more' },
        // The work may be sound and the gate the thing that cannot be met;
        // retrying cannot fix that, and leaving it blocked stops the mission.
        { id: ACCEPT_RESULT_OPTION, label: 'Accept the result and continue' },
        { id: 'reject', label: 'Leave blocked' },
      ],
      recommendedOptionId: null,
      ...this.deps.reviews.addressFor(task, workspace.id),
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.invalidate('approvals', mission.id);
    return approval;
  }

  /**
   * The card a timed-out check raises (#111): it says plainly that the check,
   * not the work, ran out of time, and what a person can do about it.
   */
  #createTimeoutApproval(
    task: MissionTask, mission: Mission, workspace: Workspace, timedOut: readonly CheckResult[], reason: string,
  ): Approval {
    const approval = this.deps.approvalFactory.createOrThrow({
      workspaceId: workspace.id,
      missionId: mission.id,
      taskId: task.id,
      kind: 'intervention',
      risk: 'read',
      title: `${task.title}: a check ran out of time`,
      rationale: reason,
      effect: 'Raise the check\'s time budget (or change its command) in Project settings → Repositories, then retry: '
        + 'the agent\'s work is kept on its branch and the checks run again. Accepting marks the result good enough '
        + 'and lets dependent work continue; the pull request\'s CI still runs the full suite. Leaving it blocked stops here.',
      evidence: [
        ...timedOut.map((c) => ({ kind: 'text' as const, label: c.name.replace(/^checks\./, ''), value: summarize(c.detail, 600) })),
        { kind: 'text', label: 'Objective', value: summarize(task.objective, 600) },
      ],
      options: [
        { id: 'approve', label: 'Retry' },
        { id: ACCEPT_RESULT_OPTION, label: 'Accept the result and continue' },
        { id: 'reject', label: 'Leave blocked' },
      ],
      recommendedOptionId: null,
      ...this.deps.reviews.addressFor(task, workspace.id),
    });
    this.deps.approvals.create(approval);
    this.deps.recorder.invalidate('approvals', mission.id);
    return approval;
  }

  async #head(target: ExecutionTarget, signal: AbortSignal): Promise<string | null> {
    try {
      const r = await target.exec({ command: 'git', args: ['rev-parse', 'HEAD'], signal });
      return r.exitCode === 0 ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  /**
   * Writes into the step's out folder its runtime refused during this run
   * (#191): a file tool started on a path under `.tandemise/out/` and came
   * back an error. Paths as the tool reported them.
   */
  #refusedOutputWrites(runId: RunId): string[] {
    const refused: string[] = [];
    let pending: string | null = null;
    for (const event of this.deps.events.listByRun(runId)) {
      const body = event.body;
      if (body.type === 'tool.started') {
        pending = FILE_WRITE_TOOLS.includes(body.tool) && body.inputSummary.includes(`${ARTIFACT_OUT_DIR}/`)
          ? /([^\s"'{:]*\.tandemise\/out\/[^\s"',}]+)/.exec(body.inputSummary)?.[1] ?? `${ARTIFACT_OUT_DIR}/`
          : null;
      } else if (body.type === 'tool.completed') {
        if (pending !== null && body.outcome === 'error') refused.push(pending);
        pending = null;
      }
    }
    return refused;
  }

  // -------------------------------------------------------------- transitions

  #setStatus(
    task: MissionTask,
    scope: EventScope,
    status: TaskStatus,
    reason: string | null,
    extra: Partial<MissionTask> = {},
  ): MissionTask {
    if (task.status === status && task.statusReason === reason) return task;
    const finished = status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED' || status === 'SKIPPED';
    const updated = this.deps.tasks.update(task.id, {
      status,
      statusReason: reason,
      ...(finished ? { finishedAt: this.deps.clock.now() } : {}),
      // A success answers whatever the last failure said; nothing is owed to a
      // later attempt of this task any more.
      ...(status === 'SUCCEEDED' ? { retryFeedback: null } : {}),
      ...extra,
    });
    this.deps.recorder.record(scope, {
      type: 'task.status',
      from: task.status,
      to: status,
      ...(reason === null ? {} : { reason }),
    });
    this.deps.recorder.invalidate('tasks', task.missionId);
    return updated;
  }

  #settle(
    task: MissionTask,
    scope: EventScope,
    status: TaskStatus,
    reason: string | null,
    extra: Partial<MissionTask> = {},
  ): TaskAttemptOutcome {
    this.#setStatus(task, scope, status, reason, extra);
    return { kind: 'settled', status, reason };
  }

  #settleFailure(task: MissionTask, scope: EventScope, reason: string): TaskAttemptOutcome {
    // Notes queued on a pass that failed go with the next attempt, which must cite them;
    // left queued, the sweep would turn them open and that attempt would miss them.
    if (task.attempts < task.retryPolicy.maxAttempts) {
      this.deps.rounds.promoteQueued(task);
      this.#setStatus(task, scope, 'READY', reason, { retryFeedback: reason });
      return { kind: 'settled', status: 'READY', reason, retryAfterMs: task.retryPolicy.backoffMs };
    }
    return this.#settle(
      task, scope, task.retryPolicy.onExhausted === 'fail' ? 'FAILED' : 'BLOCKED', reason, { retryFeedback: reason },
    );
  }

  #block(task: MissionTask, scope: EventScope, reason: string): TaskAttemptOutcome {
    return this.#settle(task, scope, 'BLOCKED', reason);
  }

  // ----------------------------------------------------------------- lookups

  /**
   * The runtimes this attempt may use, most preferred first, and the agents
   * they belong to.
   *
   * In order: a manual retry's named runtime; the ranked runtimes of the agent
   * members the task's staffing resolved to; and, only for a task whose
   * staffing named nobody, the workspace's legacy routing for the role and
   * then every enabled runtime. A task staffed to agents never widens: when
   * none of them is active, or none has an enabled runtime, it says so
   * instead of running on a runtime nobody chose (F11). A workspace nobody
   * has staffed runs exactly as it always did.
   */
  #candidateProfiles(workspace: Workspace, task: MissionTask, options: { readonly peek?: boolean } = {}): CandidateRouting {
    const all = this.deps.runtimeProfiles.list(workspace.id).filter((p) => p.enabled);
    const agents = this.#activeAgentCandidates(workspace, task);

    // A manual retry may name a runtime. It is a preference, not a bypass: the
    // profile still has to pass health and capability selection, so overriding
    // onto a runtime that cannot do the work blocks with a reason rather than
    // failing halfway through the run.
    const override = options.peek === true ? this.deps.overrides.peek(task.id) : this.deps.overrides.take(task.id);
    if (override !== undefined) {
      const chosen = all.filter((p) => p.id === override);
      if (chosen.length > 0) return { kind: 'profiles', profiles: chosen, agents };
    }

    // An agent's runtime that was deleted or disabled is skipped, not an error:
    // the next agent, or the next runtime of the same agent, can still do it.
    const staffed = [...new Set(agents.flatMap((a) => a.runtimeProfileIds))]
      .flatMap((id) => all.filter((p) => p.id === id));
    if (staffed.length > 0) return { kind: 'profiles', profiles: staffed, agents };
    if ((task.staffing?.staffing.assignees.length ?? 0) > 0) {
      return agents.length > 0 ? { kind: 'no_runtime', agents } : { kind: 'nobody_active' };
    }

    const routed = workspace.routing[task.roleId];
    if (routed === undefined || routed.length === 0) return { kind: 'profiles', profiles: all, agents: [] };
    // Routing is an ordered preference list, so it is walked in order and a
    // profile it does not mention is not a candidate at all.
    return { kind: 'profiles', profiles: routed.flatMap((id) => all.filter((p) => p.id === id)), agents: [] };
  }

  /**
   * The snapshot's agent candidates that can still act.
   *
   * The snapshot fixes *who was staffed*; it cannot make an agent whose owner
   * has since left the team keep acting on their authority. So activity is
   * checked now, at dispatch, and an inactive agent is passed over.
   */
  #activeAgentCandidates(workspace: Workspace, task: MissionTask): readonly Member[] {
    const ids = task.staffing?.agentCandidateIds ?? [];
    if (ids.length === 0) return [];
    const team = indexTeam(this.deps.members.listByWorkspace(workspace.id, { includeRemoved: true }));
    return ids
      .filter((id) => isActiveMember(team, id))
      .map((id) => team.byId.get(id))
      .filter((m): m is Member => m !== undefined && m.kind === 'agent');
  }

  /**
   * Who the running task is assigned to and who answers for it, once the
   * runtime has picked the agent.
   *
   * Resolution could only name the *first* candidate as responsible; the agent
   * that actually runs may be a later one with a different owner.
   */
  #assignment(task: MissionTask, workspace: Workspace, agent: Member | null): Partial<MissionTask> {
    if (agent === null || task.staffing == null) return {};
    const team = indexTeam(this.deps.members.listByWorkspace(workspace.id, { includeRemoved: true }));
    if (team.owners.length === 0) return { assigneeId: agent.id };
    return { assigneeId: agent.id, responsibleId: responsibleFor(team, task.staffing.staffing, agent.id) };
  }

  /** Doubles with each consecutive signed-out run of this task, up to a ceiling. */
  #signedOutBackoff(taskId: TaskId): number {
    const runs = [...this.deps.runs.listByTask(taskId)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const streak = runs.findIndex((r) => r.errorCode !== RUNTIME_SIGNED_OUT);
    const consecutive = streak === -1 ? runs.length : streak;
    return Math.min(AWAITING_PERSON_RETRY_MS * 2 ** Math.max(0, consecutive - 1), MAX_SIGNED_OUT_BACKOFF_MS);
  }

  /**
   * The session a round continues: the task's latest one, whatever its run's
   * status, when this runtime can resume it (spec §5).
   */
  #settledSession(taskId: TaskId, profile: RuntimeProfile, adapter: { resume?: unknown }): string | null {
    if (adapter.resume === undefined || !this.deps.runtimeManager.capabilities(profile).includes('session_resume')) return null;
    const last = [...this.deps.runs.listByTask(taskId)]
      .filter((r) => r.externalSessionId !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    // A session belongs to the runtime profile that holds it; another profile cannot continue it.
    return last !== undefined && last.runtimeProfileId === profile.id ? last.externalSessionId : null;
  }

  #resumableRun(taskId: TaskId, profile: RuntimeProfile, adapterSupportsResume: boolean): Run | null {
    if (!adapterSupportsResume) return null;
    const resumable = this.#latestResumable(taskId);
    // As for a settled session: another profile's config dir does not have it, and resuming there silently starts fresh.
    return resumable !== null && resumable.runtimeProfileId === profile.id ? resumable : null;
  }

  /** The task's latest run whose session a later attempt can take over, on whatever profile. */
  #latestResumable(taskId: TaskId): Run | null {
    const runs = [...this.deps.runs.listByTask(taskId)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return runs.find((r) => r.status === 'RESUMABLE' && r.externalSessionId !== null) ?? null;
  }

  /**
   * The ended hold the next pass continues from, or null: the latest one no run
   * has read yet, whether the person continued it or released it.
   */
  #continuationFor(task: MissionTask): TaskHold | null {
    return this.#endedHolds(task)[0] ?? null;
  }

  /** The task's ended holds no run has read yet, latest first. */
  #endedHolds(task: MissionTask): TaskHold[] {
    return this.deps.holds.listByMission(task.missionId)
      .filter((h) => h.taskId === task.id && h.endedAt !== null && h.ending !== null && h.consumedAt === null)
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
  }

  /** The session a hold left, when this profile is the one holding it and can resume it. */
  #heldSession(hold: TaskHold, profile: RuntimeProfile, adapter: { resume?: unknown }): string | null {
    if (hold.runtimeProfileId !== profile.id || adapter.resume === undefined) return null;
    if (!this.deps.runtimeManager.capabilities(profile).includes('session_resume')) return null;
    return hold.sessionAfter ?? hold.sessionBefore;
  }

  #requireTask(id: TaskId): MissionTask {
    return this.#require(this.deps.tasks.get(id), 'Task', id);
  }

  #require<T>(value: T | undefined, what: string, id: string): T {
    if (value === undefined) throw TandemiseError.notFound(what, id);
    return value;
  }
}

// ------------------------------------------------------------------ internals

interface AttemptContext {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly workspace: Workspace;
  readonly repository: Repository | null;
  readonly role: RoleTemplate;
  /** The frozen setup an eval trial replays; null for every real mission. */
  readonly trial: TrialContext | null;
  readonly scope: EventScope;
  readonly signal: AbortSignal;
  /** The skills this attempt installed (P13); absent before they are. */
  readonly skills?: InstalledSkills;
}

interface PromptInput extends AttemptContext {
  readonly grants: readonly CapabilityGrant[];
  readonly target: ExecutionTarget;
  readonly tools: readonly string[];
  /** The previous attempt's gate detail, verbatim, or null on a first attempt. */
  readonly feedback: string | null;
  /** Set only for a tighten pass that runs fresh: the request and the drafts to edit. */
  readonly tighten?: TightenPrompt;
  /** The feedback this pass carries, or null when it carries none. */
  readonly round?: RoundBrief | null;
}

interface TightenPrompt {
  /** One `Tighten <Type>: …` line per artifact over budget. */
  readonly feedback: string;
  readonly drafts: readonly LoadedArtifact[];
}

interface TightenInput extends AttemptContext {
  /** Holds the slot the first run kept; the pass takes it. */
  readonly retained: SlotRetention;
  readonly harvest: HarvestResult;
  readonly profile: RuntimeProfile;
  readonly adapter: { resume?: unknown; acceptsModel?(profile: RuntimeProfile): boolean };
  readonly target: ExecutionTarget;
  readonly assignment: { id: import('@tandemise/shared').WorkerAssignmentId };
  readonly grants: readonly CapabilityGrant[];
  readonly agent: Member | null;
  readonly firstRunId: RunId;
  readonly tools: readonly string[];
  readonly mcpConfigPath: string | null;
}

interface DeliveryInput extends TightenInput {
  readonly assessed: Assessment;
  /** The first pass's check results, handed back unchanged when no delivery pass ran. */
  readonly checks: readonly CheckResult[];
  /** Collects what each delivery pass stores, so an overtaken attempt can set it aside. */
  readonly produced: ArtifactManifest[];
}

interface Assessment {
  readonly gate: GateOutcome | null;
  readonly verdict: { readonly passed: boolean; readonly detail: string };
  readonly measured: { readonly filesChanged?: number };
  /** Every fact the gate could read (P3b), kept for `#score` even when the gate itself only read a few. */
  readonly facts: GateFacts;
}

interface DriveInput {
  readonly task: MissionTask;
  readonly mission: Mission;
  /** The role the attempt resolved: a trial's frozen one, else the workspace's. */
  readonly role: RoleTemplate;
  readonly profile: RuntimeProfile;
  readonly adapter: { resume?: unknown; acceptsModel?(profile: RuntimeProfile): boolean; skillsFolder?(profile: RuntimeProfile): string | null };
  readonly target: ExecutionTarget;
  readonly assignment: { id: import('@tandemise/shared').WorkerAssignmentId };
  readonly prompt: string;
  readonly grants: readonly CapabilityGrant[];
  readonly scope: EventScope;
  readonly signal: AbortSignal;
  readonly runId: import('@tandemise/shared').RunId;
  /** Null when the assignment was granted no tools. */
  readonly mcpConfigPath: string | null;
  /** The slot routing reserved; undefined when the run claims its own. */
  readonly reservation: SlotReservation | undefined;
  /**
   * The session to continue, given explicitly by a tighten pass; null starts
   * fresh. Undefined leaves the choice to the task's resumable runs.
   */
  readonly continueSession?: string | null;
  /** The prompt for starting over when the session to continue is gone. */
  readonly freshPrompt?: string;
  /** The hold this pass continues from; read (consumed) once the run row exists. */
  readonly continuation?: TaskHold;
  /** Keeps the run's slot when it ends; see `RunRequest.retainSlot`. */
  readonly retainSlot?: SlotRetention;
  /** The agent member doing the run, or null when the runtime acts for no agent. */
  readonly agent: Member | null;
  readonly purpose: RunPurpose;
  readonly round: number;
  /** The artifacts the compiled prompt included, recorded as this run's inputs. */
  readonly inputs: readonly ArtifactId[];
  /** The skills the run was given (P13), recorded on its row; null when there is no library. */
  readonly skills?: readonly RunSkill[] | null;
  /** What the run knew from the brain (#51); null without one. */
  readonly brain?: import('@tandemise/domain').RunBrain | null;
  /** The team's skill the run invokes (#131); only a step's own pass, never a tighten or delivery. */
  readonly stepSkill?: RunSkillRequest;
}

interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface DriveOutcome {
  readonly runId: RunId;
  readonly status: Run['status'];
  readonly failure: RunFailure | null;
  readonly cancelled: boolean;
  /** The daemon stopped under the run; the task goes back to the queue, not to CANCELLED. */
  readonly interrupted: boolean;
}

interface JudgeInput {
  readonly task: MissionTask;
  readonly mission: Mission;
  readonly workspace: Workspace;
  readonly role: RoleTemplate;
  readonly scope: EventScope;
  readonly harvest: HarvestResult;
  readonly checks: readonly CheckResult[];
  readonly runFailure: RunFailure | null;
  readonly runId: RunId;
  readonly assessed: Assessment;
}

/**
 * The gate decides, and when there is no gate the evidence does.
 *
 * A task without a completion gate still has an objective contract: the outputs
 * its plan declared. Treating "no gate" as "always succeeded" would let a
 * worker that produced nothing satisfy its dependents.
 */
function decide(
  gate: GateOutcome | null,
  harvest: HarvestResult,
  runFailure: RunFailure | null,
): { passed: boolean; detail: string } {
  // A file refused for leaving a note unanswered was written: calling it
  // missing sends the reader looking for a file that is there. Its own issue
  // says what it lacks. It still counts as missing for the verdict below.
  const explained = new Set(harvest.unanswered.map((u) => u.type));
  const unexplained = harvest.missing.filter((type) => !explained.has(type));
  const context = [
    ...(runFailure === null ? [] : [`The run failed (${runFailure.code}): ${runFailure.message}`]),
    ...(unexplained.length > 0 ? [`Missing expected artifacts: ${unexplained.join(', ')}.`] : []),
    ...harvest.issues,
  ];

  if (gate !== null) {
    return {
      passed: gate.passed,
      detail: [gate.detail, ...context].join(' '),
    };
  }
  const passed = runFailure === null && harvest.missing.length === 0 && harvest.issues.length === 0;
  return {
    passed,
    detail: passed ? 'All expected outputs were produced.' : context.join(' '),
  };
}

/**
 * Whether the only fault in this attempt is the round's contract - a note
 * left uncited - and if so, the round and what it was left saying. Null when
 * anything else went wrong too: a gate that reads more than the outputs could
 * have failed on its own account, which the person-facing lines below must
 * not hide.
 */
function unansweredNote(harvest: HarvestResult, gate: GateOutcome | null, runFailure: RunFailure | null): { round: number; what: string } | null {
  const first = harvest.unanswered[0];
  if (runFailure !== null || first === undefined) return null;
  const tagged = new Set(harvest.unanswered.map((u) => u.issue));
  if (harvest.issues.some((issue) => !tagged.has(issue))) return null;
  const types = new Set(harvest.unanswered.map((u) => u.type));
  if (harvest.missing.some((type) => !types.has(type))) return null;
  if (gate !== null && gateDependencies(gate.expression).some((fact) => !fact.startsWith('artifact.'))) return null;
  const notes = harvest.unanswered.reduce((sum, u) => sum + u.notes, 0);
  const what = notes === 0 ? 'cited a note that is not on this task' : `left ${notes} ${notes === 1 ? 'note' : 'notes'} unanswered`;
  return { round: first.round, what };
}

/**
 * "Round 2 left 1 note unanswered; trying again.": the person's line for an
 * attempt whose only fault is the round's contract, or null when anything else
 * went wrong too.
 */
function unansweredLine(harvest: HarvestResult, gate: GateOutcome | null, runFailure: RunFailure | null, retrying: boolean): string | null {
  const note = unansweredNote(harvest, gate, runFailure);
  if (note === null) return null;
  return `Round ${note.round} ${note.what}${retrying ? '; trying again.' : '.'}`;
}

/**
 * "Round 2 still left 1 note unanswered after 3 attempts.": the exhausted-
 * retries intervention card's summary. The gate's own detail can carry ids
 * and file paths (§B2's ban is on refusal text, not on gate measurements), so
 * the card never shows it verbatim - only this line, or a generic one when
 * the failure was not only the round's contract.
 */
function interventionSummary(task: MissionTask, harvest: HarvestResult, gate: GateOutcome | null, runFailure: RunFailure | null): string {
  const attempts = task.retryPolicy.maxAttempts;
  const times = `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`;
  const note = unansweredNote(harvest, gate, runFailure);
  if (note !== null) return `Round ${note.round} still ${note.what} after ${times}.`;
  return `This task failed its completion gate on every one of its ${times}.`;
}

/**
 * Gives the kept slot back and empties its holder, so a later pass can tell it
 * holds no slot and must be admitted again rather than hand on a dead one.
 */
function releaseSlot(holder: SlotRetention): void {
  takeReservation(holder)?.release();
}

/** Takes the kept slot out of its holder, so it is handed on exactly once. */
function takeReservation(holder: SlotRetention): SlotReservation | undefined {
  const reservation = holder.reservation;
  holder.reservation = undefined;
  return reservation;
}

/** The request a tighten pass makes, in the spec's words; one line per artifact. */
function tightenLine(over: OverBudgetArtifact): string {
  return `Tighten ${over.type}: the main body is ${over.words} words; the budget is ${over.budget}. `
    + 'Keep the handoff, move detail under "## Appendix", and cut repetition.';
}

function tightenPreamble(): string {
  return 'An editor asks for one tightening pass over the work you just finished. This is not a failure: '
    + 'your round passed, and nothing else about the task has changed.';
}

/** What a resumed session is told: it already has the task and its draft in context. */
/**
 * The row's line for a step whose check ran out of time (#111), in a person's
 * words: which check, after how long, and that it is not the agent's fault.
 */
export function timeoutReason(timedOut: readonly CheckResult[]): string {
  const names = timedOut.map((c) => `the ${c.name.replace(/^checks\./, '')} check`);
  const which = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${which.charAt(0).toUpperCase()}${which.slice(1)} ran out of time before it finished. That is not a fault in the work. `
    + 'Raise its time budget in Project settings → Repositories, or accept the result.';
}

/** What the agent is told if a person retries after a timeout: the work was not judged, so nothing needs fixing. */
function timeoutFeedback(timedOut: readonly CheckResult[]): string {
  return [
    ...timedOut.map((c) => `${c.name}: ${c.detail}`),
    'Your work was not judged: the check never finished. Your previous attempt is committed on this branch. '
    + 'Do not change code to make the check faster or to skip it; if the task is done, finish without further changes.',
  ].join('\n');
}

/**
 * What the step is told about the checks Tandemise runs after it (#106). On the
 * dogfood run every agent followed the repository's own "run the full CI
 * before a pull request" and spent 15-20 minutes on it, and then the gate ran
 * the same suite again. The gate's run is the one that counts, and the pull
 * request's CI runs everything; the agent runs only what its change needs.
 */
function plannedChecksNote(planned: readonly PlannedCheck[]): string {
  return [
    'After you finish, Tandemise itself runs these checks in this worktree and judges the step by them:',
    ...planned.map((c) => `- ${c.name}: \`${c.command}\` (time budget ${c.budgetMinutes} min)`),
    'Do not run these full commands yourself, even if the repository\'s own instructions say to run its whole '
      + 'test suite or CI before a pull request: Tandemise runs them once, after you, and the pull request\'s CI runs '
      + 'everything again. Run only the narrow, fast checks for what you changed (one test file, one package). '
      + 'A change to documentation only needs no test run at all.',
  ].join('\n');
}

/**
 * The gate's own words, then the detail of each failed check the gate names:
 * `checks.tests: \`npm test\` exceeded its time budget after 600008ms.`, or
 * the tail of a failing test run. Nothing is added when no named check failed.
 */
function withFailedChecks(gateDetail: string, checks: readonly CheckResult[]): string {
  const failed = checks.filter((c) => c.outcome === 'FAIL' && gateDetail.includes(c.name));
  if (failed.length === 0) return gateDetail;
  return [gateDetail, ...failed.map((c) => `${c.name}: ${c.detail}`)].join('\n');
}

function tightenRequest(feedback: string, destinations: readonly string[]): string {
  return [
    tightenPreamble(),
    '',
    feedback,
    '',
    `Edit the files in place (${destinations.map((d) => `\`${d}\``).join(', ')}) and keep their front matter valid. `
    + 'Keep what they say; say it in fewer words.',
  ].join('\n');
}

/** Where an attempt may run, or why a staffed task has nowhere to. */
type CandidateRouting =
  | { readonly kind: 'profiles'; readonly profiles: readonly RuntimeProfile[]; readonly agents: readonly Member[] }
  | { readonly kind: 'no_runtime'; readonly agents: readonly Member[] }
  | { readonly kind: 'nobody_active' };

/** The first candidate agent that lists the chosen runtime, in staffing order. */
function agentFor(agents: readonly Member[], profileId: string): Member | null {
  return agents.find((a) => a.runtimeProfileIds.includes(profileId)) ?? null;
}

function targetKindFor(isolation: MissionTask['executionPolicy']['isolation']): TargetKind {
  return isolation === 'none' ? 'local' : isolation;
}

/**
 * Resource keys a task must hold exclusively.
 *
 * A worktree task owns its own branch, so it contends with nobody. A task
 * running unisolated in the user's checkout contends with every other such
 * task, because they share one working tree (MVP.md §9.4).
 */
/** Capabilities that let a task change the checkout it runs in, beyond its own artifacts. */
const CHANGES_CHECKOUT = [
  CORE_CAPABILITIES.filesystemWrite, CORE_CAPABILITIES.shell, CORE_CAPABILITIES.git, CORE_CAPABILITIES.gitCommit,
];

function resourceKeysFor(
  task: MissionTask,
  mission: Mission,
  repository: Repository | null,
): readonly string[] {
  if (repository === null) return [];
  if (task.executionPolicy.isolation === 'none') {
    // A task that only reads and writes its own artifact folder cannot disturb
    // another task in the same checkout, so it does not take turns with them.
    // Without this, research in one mission queued behind a spec in another.
    const capabilities = [...task.executionPolicy.capabilities, ...task.requiredCapabilities];
    const changes = capabilities.some((c) => CHANGES_CHECKOUT.some((w) => anyCapabilityMatches([c], w)));
    return changes ? [`repository:${repository.id}:worktree`] : [];
  }
  return [`mission:${mission.id}:branch:${task.key}`];
}

function allowedRoots(grants: readonly CapabilityGrant[], workingDirectory: string): readonly string[] {
  const roots = new Set<string>();
  for (const grant of grants) {
    if (grant.approvalMode === 'deny') continue;
    for (const scope of grant.resourceScope) {
      if (scope.startsWith('/') && scope !== workingDirectory) roots.add(scope);
    }
  }
  return [...roots];
}

function commitMessage(
  task: MissionTask,
  role: RoleTemplate,
  profile: RuntimeProfile,
  runId: RunId,
): string {
  return [
    `${task.key}: ${task.title}`,
    '',
    summarize(task.objective, 500),
    '',
    `Tandemise-Role: ${role.id}`,
    `Tandemise-Task: ${task.id}`,
    `Tandemise-Run: ${runId}`,
    `Tandemise-Runtime: ${profile.adapterId}`,
  ].join('\n');
}

function mergeUsage(
  usage: RunUsage,
  event: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number | null; wallTimeMs?: number },
): RunUsage {
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(usage.inputTokens, event.inputTokens),
    outputTokens: add(usage.outputTokens, event.outputTokens),
    cacheReadTokens: add(usage.cacheReadTokens, event.cacheReadTokens),
    cacheWriteTokens: add(usage.cacheWriteTokens, event.cacheWriteTokens),
    wallTimeMs: add(usage.wallTimeMs, event.wallTimeMs),
    // A subscription runtime exposes no trustworthy per-run cost, so a missing
    // cost stays null rather than being summed into a fabricated zero.
    costUsd: event.costUsd === undefined || event.costUsd === null
      ? usage.costUsd ?? null
      : (usage.costUsd ?? 0) + event.costUsd,
  };
}

function hasUsage(usage: RunUsage): boolean {
  return usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.wallTimeMs !== undefined
    || (usage.costUsd !== null && usage.costUsd !== undefined);
}

/**
 * What a spec author and a tester owe the Done-when ledger, with the ids
 * spelled out: an agent told "cover every criterion" without the list guesses,
 * and the harvester then refuses what it guessed.
 */
function ledgerNotes(task: MissionTask, ledger: readonly MissionCriterion[]): readonly string[] {
  const users = ledger.filter((c) => c.source === 'user').map((c) => c.key);
  const notes: string[] = [];
  if (task.expectedOutputs.includes('ProductSpec') && users.length > 0) {
    notes.push(
      `The person's Done-when lines are ${users.join(', ')}. Every one must appear in the \`covers\` list of at least `
      + 'one acceptance criterion in your ProductSpec; name your own criteria AC1, AC2, and so on. '
      + 'Tandemise checks this: a line left uncovered fails the task.',
    );
  }
  if (task.expectedOutputs.includes('QAReport') && ledger.length > 0) {
    const covered = new Set(ledger.filter((c) => c.source === 'spec').flatMap((c) => c.covers));
    const verify = ledger.filter((c) => c.source === 'spec' || !covered.has(c.key)).map((c) => c.key);
    notes.push(
      `Give one QAReport result per criterion, with \`criterionId\` set to its ledger id: ${verify.join(', ')}. `
      + 'A result naming any other id is refused. A criterion you could not verify is SKIP, and it counts as not verified.',
    );
  }
  return notes;
}

/**
 * For a card about a task whose gate reads the Done-when ledger: which
 * criteria hold it up, by id and in the person's words. The gate line says
 * "criteria.uncovered_user is 1"; this says which one.
 */
function doneWhenEvidence(task: MissionTask, trace: CriteriaTrace): readonly { kind: 'text'; label: string; value: string }[] {
  if (task.completionGate === null) return [];
  const reads = gateDependencies(task.completionGate);
  if (!reads.some((fact) => fact.startsWith('criteria.') || fact.startsWith('qa.criteria_'))) return [];
  const named = (rows: readonly TracedCriterion[]): string =>
    rows.map((r) => `${r.criterion.key} (${summarize(r.criterion.statement, 80)})`).join(', ');
  const uncovered = trace.rows.filter((r) => r.uncovered);
  const failed = trace.rows.filter((r) => r.counted && r.result === 'FAIL');
  const unverified = trace.rows.filter((r) => r.counted && !r.uncovered && r.result !== 'PASS' && r.result !== 'FAIL');
  const lines = [
    ...(uncovered.length > 0 ? [`Not covered by the spec: ${named(uncovered)}.`] : []),
    ...(failed.length > 0 ? [`Failed in QA: ${named(failed)}.`] : []),
    ...(unverified.length > 0 ? [`Not verified yet: ${named(unverified)}.`] : []),
  ];
  return lines.length === 0 ? [] : [{ kind: 'text', label: 'Done when', value: summarize(lines.join(' '), 600) }];
}
