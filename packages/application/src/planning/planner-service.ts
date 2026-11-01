import {
  FACTORY_WORKFLOW_ID, IMPLICIT_CRITERION, IMPLICIT_CRITERION_KEY,
  addSkillRefs, applyModules, chooseLane, compileWorkflow, evaluateGate, isTrialMission, laneWorkflowId, parseSkillRef,
  profileRuleContext, profileLine, profileTask, stepClassFor, tiebreakReason, validateMissionPlan, matchGlob,
  type Lane, type MissionPlan, type Mission, type MissionCriteriaRepositoryPort, type MissionRepositoryPort,
  type PlanDecision, type PlanDecisionRepositoryPort, type PlannedTask, type PlannerConfig, type ProfileInput,
  type RepoRepositoryPort, type Repository, type RoleRepositoryPort, type RoleTemplate, type SkillRef, type TaskProfile,
  type WorkflowDefinition, type Workspace, type WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { TandemiseError, ids, type Clock, type Logger, type MissionId, type Timestamp, type WorkspaceId } from '@tandemise/shared';
import type { ApprovalFactory } from '@tandemise/policy';
import { DEFAULT_ESCALATE_AFTER_MS, indexTeam, laneStricter, type Approval, type ApprovalRepositoryPort, type MemberRepositoryPort, type MissionTask, type PlanProposalRepositoryPort, type TaskRepositoryPort } from '@tandemise/domain';
import type { Caller } from '../support/identity.js';
import { materializePlan } from './materialize.js';
import { routePlan } from './routing.js';
import { foldOutcomes, type OutcomeRepositoryPort, type OutcomeStats } from '@tandemise/domain';
import type { FactoryConfigSourcePort, WorkflowSourcePort } from '../ports.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { WorkflowPreset } from './presets.js';
import { loadFactoryConfig, type FactoryConfig } from './factory-config.js';
import { laneWorkflows, SHIP_STEP_KEY, VERIFY_STEP_KEY } from './defaults/lanes.js';
import { gatherSignals, userCriteriaCount } from './signals.js';
import { runTiebreak, type TiebreakRunnerPort } from './tiebreak.js';
import type { SkillPinning } from '../services/planning-service.js';

/**
 * The factory planner (#53 §5): the first rung of planning for missions whose
 * workflow is `auto`. Profile, lane, the lane's workflow, modules, skills and
 * validation, with no model call for quick and standard work (the tiebreak
 * aside). The careful lane hands its compiled plan to today's planner run as
 * the starting shape, and the tailored plan comes back through modules,
 * skills and validation, so tailoring can't drop a module's step or gate.
 *
 * Planning never fails because of a rule: an invalid result drops modules,
 * then falls back to the bare lane workflow, then returns null, and today's
 * ladder runs.
 */

/** Quick-lane planning, Start to the first READY step, without a model call. Measured in planner-check. */
export const QUICK_PLAN_BUDGET_MS = 200;

/** The planner role whose economy model breaks ties (P12). */
const PLANNER_ROLE_ID = 'architecture';

export interface PlannerDeps {
  readonly factory: FactoryConfigSourcePort;
  readonly workflows: WorkflowSourcePort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly criteria: Pick<MissionCriteriaRepositoryPort, 'listActive' | 'seed'>;
  readonly repositories: RepoRepositoryPort;
  readonly roles: RoleRepositoryPort;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  readonly tiebreak?: TiebreakRunnerPort;
  /** The type of the tracker item Start made the mission from (#52), mapped by planner.yaml's trackerTypes. */
  readonly trackerItems?: { get(id: string): { readonly type?: string } | undefined };
  readonly skills?: SkillPinning;
  /** For escalating a running mission and switching its lane (#53 §5.4). Optional for older harnesses. */
  readonly tasks?: TaskRepositoryPort;
  readonly approvals?: ApprovalRepositoryPort;
  readonly approvalFactory?: ApprovalFactory;
  readonly proposals?: PlanProposalRepositoryPort;
  readonly members?: MemberRepositoryPort;
  /** The outcome fold routes models and adds approvals (#53 §6.2, §5.3). Optional for older harnesses. */
  readonly outcomes?: OutcomeRepositoryPort;
}

/**
 * `planner.yaml`'s `stepSkills` (#131): each agent step that names no skill of
 * its own runs the first rule's skill whose class matches and whose `when`
 * holds. A workflow step's own `runSkill` wins.
 */
export function withStepSkills(
  plan: MissionPlan, planner: PlannerConfig, facts: Parameters<typeof evaluateGate>[1], predicates: Parameters<typeof evaluateGate>[2],
): MissionPlan {
  if (planner.stepSkills.length === 0) return plan;
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      if ((task.runSkill ?? null) !== null || (task.executor ?? 'agent') !== 'agent') return task;
      const cls = stepClassFor(task);
      const rule = planner.stepSkills.find((r) => r.class === cls && (r.when === undefined || evaluateGate(r.when, facts, predicates).passed));
      return rule === undefined ? task : { ...task, runSkill: { name: rule.skill, args: rule.args } };
    }),
  };
}

/** How far back routing stats look. */
const ROUTING_WINDOW_MS = 180 * 86_400_000;

/** The evidence label that marks a plan card as "make it quick"; read when the card is approved. */
export const LANE_CARD_LABEL = 'Lane';
const STARTABLE: readonly string[] = ['PENDING', 'READY'];

export interface FactoryPlan {
  readonly plan: MissionPlan;
  readonly lane: Lane;
  readonly decision: PlanDecision;
  /** Quick or standard with no Done-when line: an implicit criterion is written. */
  readonly implicitCriterion: boolean;
  /** Careful lane only: the compiled plan as the planner run's starting shape. */
  readonly preset: WorkflowPreset | null;
}

interface PlanContext {
  readonly roles: readonly RoleTemplate[];
  readonly repositories: readonly Repository[];
  readonly workspace: Workspace;
  readonly repository: Repository | null;
}

export class PlannerService {
  readonly #configs = new Map<WorkspaceId, FactoryConfig>();
  readonly #predicted = new Map<MissionId, Lane>();

  constructor(private readonly deps: PlannerDeps) {}

  /** Whether planning a mission goes through the factory. */
  handles(mission: Mission): boolean {
    return mission.workflowPreset === FACTORY_WORKFLOW_ID && !isTrialMission(mission);
  }

  /** The tracker item's type, when Start made this mission from one (null otherwise, or once the item is gone). */
  #trackerType(mission: Mission): string | null {
    const id = mission.trackerItemId;
    if (id === undefined || id === null) return null;
    return this.deps.trackerItems?.get(id)?.type ?? null;
  }

  /**
   * Loads the factory files and predicts the lane, so the synchronous
   * readiness check can ask `skipsReadiness`. Called before entering PLANNING.
   */
  async warm(missionId: MissionId): Promise<void> {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined || !this.handles(mission)) return;
    try {
      const predicted = await this.predict(mission);
      this.#predicted.set(missionId, predicted.lane);
    } catch (e) {
      this.deps.log.warn('planner.warm_failed', { missionId, error: String(e) });
    }
  }

  /**
   * Refinement and readiness survive only in the careful lane (#53 §4). From
   * the rules-only prediction: a tiebreak that later moves the lane to careful
   * doesn't re-impose readiness, but the planner run and plan approval apply.
   */
  skipsReadiness(mission: Mission): boolean {
    if (!this.handles(mission)) return false;
    if (mission.laneRequest === 'careful') return false;
    const lane = this.#predicted.get(mission.id);
    return lane !== undefined && lane !== 'careful';
  }

  async predict(mission: Mission): Promise<{ profile: TaskProfile; lane: Lane; because: string; config: FactoryConfig }> {
    const repositories = this.#orderedRepositories(mission.workspaceId);
    const config = await this.#config(mission.workspaceId, repositories, true);
    const input = gatherSignals({ mission, criteria: this.deps.criteria.listActive(mission.id), repositories, trackerType: this.#trackerType(mission) });
    const profile = profileTask(input, config.planner);
    return { profile, config, ...chooseLane(profile, config.planner, input.person) };
  }

  /** The factory files for a project, read fresh. */
  async config(workspaceId: WorkspaceId): Promise<FactoryConfig> {
    return this.#config(workspaceId, this.#orderedRepositories(workspaceId), true);
  }

  /** The outcome fold routing reads (the same window the planner routes with), for the Routing view. */
  routingStats(workspaceId: WorkspaceId): OutcomeStats {
    return this.#stats(workspaceId);
  }

  /** The project's repositories, the default one first: where its factory files are read from and written to. */
  repositories(workspaceId: WorkspaceId): readonly Repository[] {
    return this.#orderedRepositories(workspaceId);
  }

  async plan(mission: Mission, ctx: PlanContext): Promise<FactoryPlan | null> {
    if (!this.handles(mission)) return null;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };
    const config = await this.#config(mission.workspaceId, ctx.repositories, true);
    const criteria = this.deps.criteria.listActive(mission.id);
    let input: ProfileInput = gatherSignals({ mission, criteria, repositories: ctx.repositories, trackerType: this.#trackerType(mission) });
    let profile = profileTask(input, config.planner);

    let tiebreak: PlanDecision['tiebreak'] = null;
    const reason = config.planner.tiebreak === 'on' ? tiebreakReason(input, profile) : null;
    if (reason !== null && this.deps.tiebreak !== undefined) {
      const role = ctx.roles.find((r) => r.id === PLANNER_ROLE_ID);
      const model = role?.models?.economyModel ?? role?.models?.model ?? null;
      const ran = await runTiebreak(input, this.deps.tiebreak, {
        model, areaNames: config.planner.areas.map((a) => a.name), repoNames: ctx.repositories.map((r) => r.name), workspaceId: mission.workspaceId,
      });
      input = { ...input, tiebreak: ran.answer, tiebreakFailed: ran.answer === null ? ran.error : null };
      profile = profileTask(input, config.planner);
      tiebreak = { reason, model: ran.model, costUsd: ran.costUsd, answer: ran.answer, error: ran.error, ...(ran.rawReply === null ? {} : { rawReply: ran.rawReply }) };
      if (ran.error !== null) this.deps.recorder.note(scope, `Couldn't tell what kind of task this is, and the quick check ${ran.error}; planning with careful defaults.`, 'warn');
    }

    const { lane, because } = chooseLane(profile, config.planner, input.person);
    const workflowId = laneWorkflowId(lane, profile.type, config.planner);
    const definition = await this.#laneDefinition(workflowId, lane, ctx);
    if (definition === null) return null;

    const isolationForRole = (roleId: string) => ctx.roles.find((r) => r.id === roleId)?.defaultIsolation;
    const compiled = compileWorkflow(definition.def, mission.workflowInputs, { isolationForRole });
    if (!compiled.ok) {
      this.deps.recorder.note(scope, `The ${lane} lane's workflow "${definition.id}" can't run (${compiled.error.map((i) => i.message).join('; ')}); planning the usual way.`, 'warn');
      return null;
    }

    const skipped: string[] = [];
    let plan: MissionPlan = compiled.value;
    const userCriteria = userCriteriaCount(criteria);
    if (userCriteria === 0 && plan.tasks.some((t) => t.key === VERIFY_STEP_KEY)) {
      plan = dropStep(plan, VERIFY_STEP_KEY);
      skipped.push('No QA step: there are no Done-when lines to verify, so the tests carry it and the merge decision takes that into account.');
    }
    if (lane !== 'careful') skipped.push('No plan approval.');
    if (lane === 'quick') skipped.push('No separate review or QA: the tests carry it, and the merge decision will take that into account.');
    if (lane !== 'careful' && userCriteria === 0) skipped.push('No Done-when lines: "The task as written is done" stands in, and reads "Not independently verified".');

    const shaped = this.#shape(plan, profile, config, ctx, lane, this.#stats(mission.workspaceId));
    if (shaped === null) return null;

    const decision: PlanDecision = {
      id: ids.planDecision(),
      missionId: mission.id,
      policyRef: policyRef(config),
      basis: 'predicted',
      profile,
      lane,
      laneBecause: because,
      workflowId: definition.id,
      modules: shaped.applied,
      dropped: shaped.dropped,
      steps: decisionSteps(shaped.plan),
      approvals: decisionApprovals(shaped.plan),
      skipped,
      tiebreak,
      lightenedByPerson: false,
      createdAt: this.deps.clock.now() as Timestamp,
    };
    const implicitCriterion = lane !== 'careful' && criteria.length === 0;
    const preset: WorkflowPreset | null = lane !== 'careful' ? null : {
      id: definition.id,
      name: definition.def.name,
      description: definition.def.description ?? definition.def.name,
      stages: shaped.plan.tasks.filter((t) => t.executor !== 'ship').map((t) => t.title),
      // The planner sees the plan without the ship step: it can't write one, and it comes back on in `finish`.
      build: () => ({ ...shaped.plan, tasks: shaped.plan.tasks.filter((t) => t.executor !== 'ship').map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== SHIP_STEP_KEY) })) }),
    };
    return { plan: shaped.plan, lane, decision, implicitCriterion, preset };
  }

  /**
   * The careful lane's tailored plan, put back through the ship step, modules,
   * skills and validation (#53 §5 step 8). A model can't drop a module's step
   * or gate: they are re-added here. A tailored plan that no longer validates
   * gives way to the compiled one.
   */
  finish(factory: FactoryPlan, tailored: MissionPlan, ctx: PlanContext, config: FactoryConfig): FactoryPlan {
    const withShip = tailored.tasks.some((t) => t.executor === 'ship') ? tailored : appendShip(tailored, factory.plan);
    const shaped = this.#shape(withShip, factory.decision.profile, config, ctx, factory.lane, this.#stats(ctx.workspace.id));
    if (shaped === null) return factory;
    return {
      ...factory,
      plan: shaped.plan,
      decision: {
        ...factory.decision,
        modules: [...new Set([...factory.decision.modules, ...shaped.applied])],
        dropped: shaped.dropped,
        steps: decisionSteps(shaped.plan),
        approvals: decisionApprovals(shaped.plan),
      },
    };
  }

  /** Writes the decision, the implicit criterion and `plan.decided`. */
  record(factory: FactoryPlan, scope: EventScope): void {
    this.deps.planDecisions.create(factory.decision);
    if (factory.implicitCriterion && this.deps.criteria.listActive(factory.decision.missionId).length === 0) {
      this.deps.criteria.seed(factory.decision.missionId, [{ key: IMPLICIT_CRITERION_KEY, statement: IMPLICIT_CRITERION, source: 'implicit', covers: [] }]);
      this.deps.recorder.invalidate('criteria', factory.decision.missionId);
    }
    this.deps.recorder.record(scope, {
      type: 'plan.decided',
      lane: factory.lane,
      workflowId: factory.decision.workflowId,
      modules: [...factory.decision.modules],
      policyRef: factory.decision.policyRef,
    });
  }

  /** "fix · tiny · low risk", for the plan document's front matter. */
  front(factory: FactoryPlan): { readonly lane: Lane; readonly profile: string } {
    return { lane: factory.lane, profile: profileLine(factory.decision.profile).toLowerCase() };
  }

  // ------------------------------------------------- mid-mission (#53 §5.4)

  /**
   * Re-profiles from what the code steps actually changed, and *adds* the
   * steps and gate clauses a stricter lane or a newly matching module calls
   * for, before the ship step, without asking: it only adds. A lighter
   * measured profile changes nothing. Returns the keys it added.
   */
  async escalate(mission: Mission, paths: readonly string[], options: { readonly fromShip?: boolean; readonly person?: 'quick' | 'careful' } = {}): Promise<readonly string[]> {
    const tasksRepo = this.deps.tasks;
    if (!this.handles(mission) || tasksRepo === undefined) return [];
    const tasks = tasksRepo.listByMission(mission.id);
    const ship = tasks.find((t) => t.executor === 'ship');
    if (ship === undefined || (!options.fromShip && !STARTABLE.includes(ship.status))) return [];
    const repositories = this.#orderedRepositories(mission.workspaceId);
    const config = await this.#config(mission.workspaceId, repositories, true);
    const before = this.deps.planDecisions.latest(mission.id);
    const criteria = this.deps.criteria.listActive(mission.id);
    const input = gatherSignals({ mission, criteria, repositories, extraPaths: paths, basis: 'measured', trackerType: this.#trackerType(mission) });
    const person = options.person ?? mission.laneRequest ?? 'auto';
    const profile = profileTask({ ...input, person }, config.planner);
    const measured = chooseLane(profile, config.planner, person);
    const laneNow = before?.lane ?? 'standard';
    const stricter = laneStricter(measured.lane, laneNow);

    const { facts, predicates } = profileRuleContext(profile);
    const current: MissionPlan = { summary: '', tasks };
    const withModules = applyModules(current, config.planner.modules, facts, predicates);
    let planned = withModules.plan.tasks.filter((t) => !tasks.some((x) => x.key === t.key));
    const code = tasks.find((t) => stepClassFor(t) === 'implement' || t.roleId === 'development');
    if (stricter && code !== undefined) {
      const lane = laneWorkflows({})[laneWorkflowId(measured.lane, profile.type, config.planner)] ?? laneWorkflows({})[measured.lane];
      const compiled = lane === undefined ? null : compileWorkflow(lane, {}, { isolationForRole: (id) => this.deps.roles.list(mission.workspaceId).find((r) => r.id === id)?.defaultIsolation });
      const wanted = ['review', ...(userCriteriaCount(criteria) > 0 ? [VERIFY_STEP_KEY] : [])];
      let after = code.key;
      for (const key of wanted) {
        const step = compiled?.ok === true ? compiled.value.tasks.find((t) => t.key === key) : undefined;
        if (step === undefined || [...tasks, ...planned].some((t) => stepClassFor(t) === stepClassFor(step))) continue;
        planned = [...planned, { ...step, dependsOn: [after] }];
        after = key;
      }
    }
    // Gate clauses only reach steps that haven't started: a finished step's gate was read already.
    const gateEdits = withModules.plan.tasks.filter((t) => {
      const was = tasks.find((x) => x.key === t.key);
      return was !== undefined && STARTABLE.includes(was.status) && was.completionGate !== t.completionGate;
    });
    if (planned.length === 0 && gateEdits.length === 0 && !stricter && withModules.applied.every((m) => before?.modules.includes(m))) return [];

    for (const edit of gateEdits) {
      const was = tasks.find((x) => x.key === edit.key)!;
      tasksRepo.update(was.id, { completionGate: edit.completionGate });
    }
    const made = planned.length === 0 ? [] : materializePlan({ summary: '', tasks: planned }, mission.id, this.deps.clock, repositories)
      .map((t, i) => ({ ...t, status: 'PENDING' as const, orderHint: ship.orderHint + i }));
    for (const task of made) tasksRepo.add(task);
    if (made.length > 0) {
      // The ship step waits for every added step; a step that waited on the code step now waits on the last added one.
      const last = made.at(-1)!.key;
      tasksRepo.update(ship.id, { dependsOn: [...new Set([...ship.dependsOn.filter((d) => d !== code?.key || made.length === 0), last])], orderHint: ship.orderHint + made.length });
    }
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };
    const decision: PlanDecision = {
      id: ids.planDecision(),
      missionId: mission.id,
      policyRef: policyRef(config),
      basis: 'measured',
      profile,
      lane: stricter ? measured.lane : laneNow,
      laneBecause: stricter ? measured.because : before?.laneBecause ?? measured.because,
      workflowId: before?.workflowId ?? measured.lane,
      modules: [...new Set([...(before?.modules ?? []), ...withModules.applied])],
      dropped: before?.dropped ?? [],
      steps: decisionSteps({ summary: '', tasks: tasksRepo.listByMission(mission.id) }),
      approvals: decisionApprovals({ summary: '', tasks: tasksRepo.listByMission(mission.id) }),
      // Steps added for review or QA are no longer skipped.
      skipped: (before?.skipped ?? []).filter((line) => !(made.some((t) => ['review', 'verify'].includes(stepClassFor(t))) && line.startsWith('No separate review'))),
      tiebreak: null,
      lightenedByPerson: before?.lightenedByPerson ?? false,
      createdAt: this.deps.clock.now() as Timestamp,
    };
    this.deps.planDecisions.create(decision);
    if (made.length > 0) {
      const sensitive = profile.areas.filter((a) => a.sensitivity !== 'none').map((a) => a.name);
      const touched = paths.find((p) => config.planner.areas.some((a) => sensitive.includes(a.name) && a.paths.some((g) => matchGlob(g, p)))) ?? paths[0];
      const what = made.map((t) => withArticle(t.title.toLowerCase())).join(' and ');
      this.deps.recorder.note(scope, touched === undefined ? `You made it careful, so I added ${what}.` : `It touched ${touched}, so I added ${what}.`);
    }
    this.deps.recorder.invalidate('tasks', mission.id);
    return made.map((t) => t.key);
  }

  /**
   * A person's lane switch (#53 §5.4). Careful adds steps at once; quick asks
   * first through a plan card, because it removes steps, and only marks the
   * mission lightened when that card is approved.
   */
  async switchLane(missionId: MissionId, lane: 'quick' | 'careful', caller: Caller): Promise<void> {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    if (!this.handles(mission)) throw new TandemiseError('PRECONDITION_FAILED', 'Only missions the factory planned have a lane.', { details: { missionId } });
    const tasks = this.deps.tasks?.listByMission(missionId) ?? [];
    const ship = tasks.find((t) => t.executor === 'ship');
    if (ship === undefined || !STARTABLE.includes(ship.status)) {
      throw new TandemiseError('CONFLICT', "The pull request is already on its way; the lane can't change now.", { details: { missionId } });
    }
    void caller;
    if (lane === 'careful') {
      const updated = this.deps.missions.update(missionId, { laneRequest: 'careful' });
      await this.escalate(updated, [], { person: 'careful' });
      return;
    }
    this.#fileQuickCard(mission, tasks, ship);
  }

  #fileQuickCard(mission: Mission, tasks: readonly MissionTask[], ship: MissionTask): void {
    const { approvals, approvalFactory, proposals } = this.deps;
    if (approvals === undefined || approvalFactory === undefined || proposals === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', 'This daemon cannot change a lane.');
    }
    const removable = tasks.filter((t) => STARTABLE.includes(t.status) && t.executor === 'agent' && t.startedAt === null
      && ['review', 'verify', 'spec', 'architecture', 'design'].includes(stepClassFor(t)));
    if (removable.length === 0) throw new TandemiseError('PRECONDITION_FAILED', 'There is nothing left to take out: this mission is already as quick as it gets.');
    const gone = new Set(removable.map((t) => t.key));
    const keep = tasks.filter((t) => !gone.has(t.key) && t.key !== ship.key);
    const depended = new Set(keep.flatMap((t) => t.dependsOn));
    const sinks = keep.filter((t) => !depended.has(t.key)).map((t) => t.key);
    const newShip: MissionTask = { ...ship, id: ids.task(), dependsOn: sinks, status: 'PENDING', statusReason: null };
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id };
    const names = removable.map((t) => t.title).join(', ');
    const approval = approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: null,
      kind: 'plan',
      risk: 'read',
      title: `Make ${mission.title} quick?`,
      rationale: `Making it quick takes out ${names}. The merge decision then counts that you made it quick.`,
      effect: 'Approving removes those steps and carries on to the pull request. Rejecting leaves the mission exactly as it was.',
      evidence: [
        { kind: 'text', label: LANE_CARD_LABEL, value: 'quick' },
        { kind: 'text', label: 'Takes out', value: names },
      ],
      addressees: this.#addressees(mission),
      escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS,
    });
    approvals.create(approval);
    proposals.put({
      approvalId: approval.id,
      missionId: mission.id,
      tasks: [newShip],
      replaces: [...removable.map((t) => t.id), ship.id],
      resumeStatus: mission.status,
      planFitApprovalId: null,
      createdAt: this.deps.clock.now() as Timestamp,
    });
    this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: approval.id });
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  /** A plan card was approved: a "make it quick" card marks the mission lightened by a person. */
  laneApproved(approval: Pick<Approval, 'missionId' | 'evidence'>): void {
    const lane = approval.evidence.find((e) => e.label === LANE_CARD_LABEL)?.value;
    if (lane !== 'quick' || approval.missionId === null) return;
    const mission = this.deps.missions.update(approval.missionId, { laneRequest: 'quick' });
    const before = this.deps.planDecisions.latest(mission.id);
    if (before === undefined) return;
    this.deps.planDecisions.create({
      ...before,
      id: ids.planDecision(),
      basis: 'measured',
      lane: 'quick',
      laneBecause: 'you made it quick',
      lightenedByPerson: true,
      steps: this.deps.tasks === undefined ? before.steps : decisionSteps({ summary: '', tasks: this.deps.tasks.listByMission(mission.id) }),
      createdAt: this.deps.clock.now() as Timestamp,
    });
  }

  #addressees(mission: Mission): readonly string[] {
    if (mission.createdBy !== null && mission.createdBy !== undefined) return [mission.createdBy];
    if (this.deps.members === undefined) return [];
    return indexTeam(this.deps.members.listByWorkspace(mission.workspaceId, { includeRemoved: true })).owners.map((m) => m.id);
  }

  // ------------------------------------------------------------------ helpers

  /** Modules, area skills, validation; dropping modules (last first) until it validates. */
  #stats(workspaceId: WorkspaceId): OutcomeStats {
    const since = new Date(this.deps.clock.epochMs() - ROUTING_WINDOW_MS).toISOString();
    return foldOutcomes(this.deps.outcomes?.listByWorkspace(workspaceId, since) ?? []);
  }

  #shape(plan: MissionPlan, profile: TaskProfile, config: FactoryConfig, ctx: PlanContext, lane: Lane, stats: OutcomeStats): {
    plan: MissionPlan; applied: string[]; dropped: { name: string; why: string }[];
  } | null {
    const planner = config.planner;
    const { facts, predicates } = profileRuleContext(profile);
    const dropped: { name: string; why: string }[] = [];
    let modules = [...planner.modules];
    for (;;) {
      const applied = applyModules(plan, modules, facts, predicates);
      dropped.push(...applied.dropped.filter((d) => !dropped.some((x) => x.name === d.name)));
      const withSkills = withStepSkills(this.#areaSkills(applied.plan, profile, planner, ctx, dropped), planner, facts, predicates);
      const routed = routePlan(withSkills, { profile, lane, routing: config.routing, stats, holdApproval: planner.holdApproval });
      const issues = this.#validate(routed, ctx);
      if (issues === null) return { plan: routed, applied: [...applied.applied], dropped };
      const last = applied.applied.at(-1);
      if (last === undefined) {
        this.deps.log.warn('planner.lane_invalid', { issues });
        return null;
      }
      dropped.push({ name: last, why: issues });
      modules = modules.filter((m) => m.name !== last);
    }
  }

  /** Every matching area's skills on each code and review step (#53 §6.4). Missing skills are dropped and said. */
  #areaSkills(plan: MissionPlan, profile: TaskProfile, planner: PlannerConfig, ctx: PlanContext, dropped: { name: string; why: string }[]): MissionPlan {
    const names = new Set(profile.areas.map((a) => a.name));
    const refs = planner.areas.filter((a) => names.has(a.name)).flatMap((a) => a.skills)
      .map((s) => parseSkillRef(s)).filter((s): s is SkillRef => s !== null);
    const tasks = plan.tasks.map((task) => {
      const cls = stepClassFor(task);
      let next = task;
      if (refs.length > 0 && (cls === 'implement' || cls === 'review' || cls === 'resolve_conflicts')) {
        next = { ...task, skillRefs: addSkillRefs(task.skillRefs ?? [], refs) };
      }
      return this.#pinnable(next, ctx, dropped);
    });
    return { ...plan, tasks };
  }

  /**
   * A skill the library doesn't have is taken off the step and named in the
   * decision, rather than refusing the plan: a shipped area or module naming
   * `security-review` must not stop every auth task in a project without it.
   */
  #pinnable(task: PlannedTask, ctx: PlanContext, dropped: { name: string; why: string }[]): PlannedTask {
    const skills = this.deps.skills;
    if (skills === undefined || task.skillRefs === undefined || task.skillRefs.length === 0) return task;
    const role = ctx.roles.find((r) => r.id === task.roleId);
    const keep: SkillRef[] = [];
    for (const ref of task.skillRefs) {
      const problems = skills.pinsFor(ctx.workspace.id, role, { key: task.key, skillRefs: [ref] }).problems;
      if (problems.length === 0) keep.push(ref);
      else if (!dropped.some((d) => d.name === `skill ${ref.name}`)) dropped.push({ name: `skill ${ref.name}`, why: `It isn't in your skills library, so ${task.key} runs without it.` });
    }
    return { ...task, skillRefs: keep };
  }

  /** Null when valid; otherwise the validator's issues in one sentence. */
  #validate(plan: MissionPlan, ctx: PlanContext): string | null {
    // Capabilities are enforced as grants when a step runs; here only the graph,
    // roles, repositories and gates are judged, as an authored workflow is.
    const result = validateMissionPlan(plan, {
      knownRoleIds: new Set(ctx.roles.map((r) => r.id)),
      satisfiableCapabilities: new Set(plan.tasks.flatMap((t) => t.requiredCapabilities)),
      knownRepositoryNames: new Set(ctx.repositories.map((r) => r.name.toLowerCase())),
    });
    if (result.ok) return null;
    return result.error.filter((i) => i.severity === 'error').map((i) => (i.taskKey === null ? i.message : `${i.taskKey}: ${i.message}`)).join(' ') || null;
  }

  async #laneDefinition(workflowId: string, lane: Lane, ctx: PlanContext): Promise<{ id: string; def: WorkflowDefinition } | null> {
    const hasTestCommand = (ctx.repository?.checks?.test ?? null) !== null;
    const shipped = laneWorkflows({ hasTestCommand });
    try {
      // A project's own file of the same id overrides the shipped lane.
      const own = (await this.deps.workflows.list(ctx.repositories.map((r) => r.path))).find((w) => w.id === workflowId && w.definition !== null);
      if (own?.definition != null) return { id: workflowId, def: own.definition };
    } catch (e) {
      this.deps.log.warn('planner.workflows_unreadable', { error: String(e) });
    }
    if (shipped[workflowId] !== undefined) return { id: workflowId, def: shipped[workflowId]! };
    const fallback = shipped[lane];
    return fallback === undefined ? null : { id: lane, def: fallback };
  }

  async #config(workspaceId: WorkspaceId, repositories: readonly Repository[], fresh: boolean): Promise<FactoryConfig> {
    const cached = this.#configs.get(workspaceId);
    if (cached !== undefined && !fresh) return cached;
    const loaded = await loadFactoryConfig(this.deps.factory, repositories.map((r) => r.path), workspaceId);
    this.#configs.set(workspaceId, loaded);
    return loaded;
  }

  #orderedRepositories(workspaceId: WorkspaceId): readonly Repository[] {
    const all = this.deps.repositories.listByWorkspace(workspaceId);
    const first = this.deps.workspaces.get(workspaceId)?.defaultRepositoryId ?? null;
    return [...all].sort((a, b) => (a.id === first ? -1 : b.id === first ? 1 : 0));
  }
}

/** The factory files' refs, as one string the decision and the PR cite. */
export function policyRef(config: Pick<FactoryConfig, 'refs'>): string {
  const { planner, routing, merge } = config.refs;
  return planner === routing && routing === merge ? planner : `planner ${planner}, routing ${routing}, merge ${merge}`;
}

/** Removes a step and hands its dependencies to whoever depended on it. */
export function dropStep(plan: MissionPlan, key: string): MissionPlan {
  const gone = plan.tasks.find((t) => t.key === key);
  if (gone === undefined) return plan;
  return {
    ...plan,
    tasks: plan.tasks.filter((t) => t.key !== key).map((t) => (t.dependsOn.includes(key)
      ? { ...t, dependsOn: [...new Set([...t.dependsOn.filter((d) => d !== key), ...gone.dependsOn])] }
      : t)),
  };
}

/** Adds the compiled plan's ship step after every step nothing depends on. */
function appendShip(tailored: MissionPlan, compiled: MissionPlan): MissionPlan {
  const ship = compiled.tasks.find((t) => t.executor === 'ship');
  if (ship === undefined) return tailored;
  const depended = new Set(tailored.tasks.flatMap((t) => t.dependsOn));
  const sinks = tailored.tasks.filter((t) => !depended.has(t.key)).map((t) => t.key);
  return { ...tailored, tasks: [...tailored.tasks, { ...ship, dependsOn: sinks }] };
}

function decisionSteps(plan: MissionPlan): PlanDecision['steps'] {
  return plan.tasks.map((t) => ({
    key: t.key,
    stepClass: stepClassFor(t),
    model: t.modelPolicy?.model ?? null,
    reason: t.modelPolicy?.reason ?? (t.modelPolicy?.model !== undefined ? 'step override' : 'role model'),
    escalate: [...(t.modelPolicy?.escalate ?? [])],
  }));
}

function decisionApprovals(plan: MissionPlan): PlanDecision['approvals'] {
  return plan.tasks.flatMap((t) => [
    ...(t.approvalPolicy.beforeStart ? [{ step: t.key, when: 'before' as const, reason: t.approvalPolicy.reason ?? 'The workflow asks for it.' }] : []),
    ...(t.approvalPolicy.onCompletion ? [{ step: t.key, when: 'after' as const, reason: t.approvalPolicy.reason ?? 'The workflow asks for it.' }] : []),
  ]);
}


function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`;
}
