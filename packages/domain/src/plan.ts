import { Err, Ok, type ArtifactId, type Result } from '@tandemise/shared';
import type { Capability } from './capability.js';
import type { TaskExecutor, WaitPolicy } from './entities/task.js';
import type { ArtifactType } from './entities/artifact.js';
import { isArtifactType } from './entities/artifact.js';
import type { ArtifactRequirement, ExecutionPolicy, ApprovalPolicy, RetryPolicy } from './entities/task.js';
import { validateGate } from './gate.js';
import { lintGate } from './gate-lint.js';
import type { ModelPolicy } from './entities/models.js';
import type { SkillRef, StepSkill } from './entities/skill.js';
import type { StepClass } from './planner/types.js';

/**
 * A proposed mission plan.
 *
 * The planner is a role, not an oracle (MVP.md §9.3). Whatever it returns is
 * untrusted until `validateMissionPlan` has confirmed it is acyclic, that every
 * required input artifact has a producer, that every referenced role exists, and
 * that every gate parses. A plan that fails validation is shown to the user as a
 * planning failure - it is never partially executed.
 */
export interface MissionPlan {
  readonly summary: string;
  readonly tasks: readonly PlannedTask[];
  /** Stages the planner omitted because an upload already covers them (spec A2). */
  readonly skipped?: readonly SkippedStage[];
}

/**
 * A stage the planner left out of `tasks` because a preexisting upload
 * already produced its output type. Materialization turns each of these into
 * a `SKIPPED` placeholder task instead of a real one, so dependents still
 * find a producer for `outputType`.
 */
export interface SkippedStage {
  readonly stage: string;
  readonly outputType: ArtifactType;
  readonly artifactId: ArtifactId;
  readonly reason: string;
}

export interface PlannedTask {
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly roleId: string;
  /**
   * Repository this task works in, by name, or null for the mission's own.
   *
   * A name rather than an id because a plan is written by a language model and
   * read by a human: `beveloce-mobile` is checkable at a glance and an id is
   * not. It is resolved against the project's repositories when the plan is
   * materialized, and a name that matches none of them is a plan error rather
   * than a task that quietly runs in the wrong place.
   */
  readonly repository?: string | null;
  /**
   * Who carries the task out. Absent means an agent, which is nearly always.
   *
   * A `human` task never reaches a runtime: the scheduler parks it and waits
   * for a person. Keeping it in the graph is the point - a design that has to
   * be made in Figma, or a console someone must click through, is work the rest
   * of the mission genuinely depends on, and pretending otherwise means either
   * a failed task or a plan that quietly omits a real step.
   */
  readonly executor?: TaskExecutor;
  /** Set only for a `wait` step. */
  readonly waitPolicy?: WaitPolicy | null;
  readonly dependsOn: readonly string[];
  readonly requiredCapabilities: readonly Capability[];
  readonly inputArtifacts: readonly ArtifactRequirement[];
  readonly expectedOutputs: readonly ArtifactType[];
  readonly executionPolicy: ExecutionPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly retryPolicy: RetryPolicy;
  readonly completionGate: string | null;
  /** What the step is for (#53 §5); absent: derived from its role. */
  readonly stepClass?: StepClass | null;
  /** Model settings from a workflow step (P12). A planner never sets them. */
  readonly modelPolicy?: ModelPolicy | null;
  /** A workflow step's `skills:` (P13), resolved to pins when the task is created. A planner never sets them. */
  readonly skillRefs?: readonly SkillRef[];
  /** The team's skill this step runs instead of its role's prompt (#131): a workflow step's `runSkill`, or `planner.yaml`'s `stepSkills`. */
  readonly runSkill?: StepSkill | null;
}

export interface PlanValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly taskKey: string | null;
  readonly message: string;
}

export interface PlanValidationContext {
  /** Role ids the workspace actually has templates for. */
  readonly knownRoleIds: ReadonlySet<string>;
  /**
   * Capabilities at least one enabled runtime + grant combination can satisfy.
   * A plan that needs something the machine cannot do should fail at planning
   * time, not three tasks into execution.
   */
  readonly satisfiableCapabilities: ReadonlySet<Capability>;
  /**
   * Artifacts that already exist on the mission (e.g. an upload pinned before
   * planning, or an intake artifact from a prior run), by id and type. A
   * `skipped` stage must name one of these, so a plan cannot claim a stage is
   * covered by an artifact that does not exist or is of the wrong type.
   */
  readonly preexistingArtifacts?: readonly { readonly id: ArtifactId; readonly type: ArtifactType }[];
  /**
   * Repository names available to this mission, lowercased.
   *
   * Omitted means "do not check", which is what a caller with no project
   * context passes. Given the set, a task naming a repository outside it is an
   * error: silently running it in the mission's own repository would put a
   * change in the wrong codebase, which is worse than refusing the plan.
   */
  readonly knownRepositoryNames?: ReadonlySet<string>;
  /**
   * How gates are judged. `lint` (the default) refuses any gate that could
   * never pass (`lintGate`). `syntax` only parses them: a running mission's
   * graph, re-validated when the engine splices a task in, was accepted under
   * the rules of its day and must not start failing mid-mission.
   */
  readonly gates?: 'lint' | 'syntax';
}

export function validateMissionPlan(
  plan: MissionPlan,
  ctx: PlanValidationContext,
): Result<MissionPlan, readonly PlanValidationIssue[]> {
  const issues: PlanValidationIssue[] = [];
  const error = (taskKey: string | null, message: string) => issues.push({ severity: 'error', taskKey, message });
  const warn = (taskKey: string | null, message: string) => issues.push({ severity: 'warning', taskKey, message });

  if (plan.tasks.length === 0) error(null, 'Plan contains no tasks.');

  const byKey = new Map<string, PlannedTask>();
  for (const task of plan.tasks) {
    if (!/^[a-z0-9][a-z0-9_]*$/.test(task.key)) {
      error(task.key, `Task key '${task.key}' must be lowercase alphanumeric with underscores.`);
    }
    if (byKey.has(task.key)) error(task.key, `Duplicate task key '${task.key}'.`);
    byKey.set(task.key, task);
  }

  for (const task of plan.tasks) {
    // Only a task that runs on a runtime needs a role template. A step a person
    // carries out, or one that only watches something outside this machine, has
    // no role to look up - demanding one would make every workflow containing a
    // design checkpoint or a CI wait invalid.
    const needsRole = (task.executor ?? 'agent') === 'agent';
    if (needsRole && !ctx.knownRoleIds.has(task.roleId)) {
      error(task.key, `Unknown role '${task.roleId}'. Known roles: ${[...ctx.knownRoleIds].sort().join(', ')}.`);
    }
    const repository = task.repository?.trim();
    if (repository !== undefined && repository !== '' && ctx.knownRepositoryNames !== undefined
        && !ctx.knownRepositoryNames.has(repository.toLowerCase())) {
      error(task.key, `Unknown repository '${repository}'. This project has: `
        + `${[...ctx.knownRepositoryNames].sort().join(', ') || 'none'}.`);
    }
    for (const dep of task.dependsOn) {
      if (!byKey.has(dep)) error(task.key, `Depends on unknown task '${dep}'.`);
      if (dep === task.key) error(task.key, 'Task depends on itself.');
    }
    for (const type of task.expectedOutputs) {
      if (!isArtifactType(type)) error(task.key, `Unknown artifact type '${type}' in expectedOutputs.`);
    }
    for (const req of task.inputArtifacts) {
      if (!isArtifactType(req.type)) error(task.key, `Unknown artifact type '${req.type}' in inputArtifacts.`);
    }
    for (const cap of task.requiredCapabilities) {
      if (!ctx.satisfiableCapabilities.has(cap)) {
        error(task.key, `Requires capability '${cap}', which no configured runtime and policy can satisfy.`);
      }
    }
    if (task.completionGate) {
      if (ctx.gates === 'syntax') {
        const gate = validateGate(task.completionGate);
        if (!gate.ok) error(task.key, `Invalid completion gate: ${gate.error}`);
      } else {
        for (const problem of lintGate(task.completionGate, {
          stepKey: task.key,
          outputs: task.expectedOutputs,
          independentOf: task.modelPolicy?.independentOf !== undefined,
          isolation: task.executionPolicy.isolation,
        })) error(task.key, problem.message);
      }
    }
    if (task.retryPolicy.maxAttempts < 1) error(task.key, 'retryPolicy.maxAttempts must be at least 1.');
    if (task.executionPolicy.maxWallTimeMs <= 0) error(task.key, 'executionPolicy.maxWallTimeMs must be positive.');
  }

  const cycle = findCycle(plan.tasks);
  if (cycle) error(null, `Plan is not acyclic: ${cycle.join(' → ')}.`);

  // Every required input must be produced by a transitive dependency. Producing
  // it *somewhere* in the plan is not enough - if it is not upstream, the task
  // can start before it exists.
  if (!cycle) {
    const ancestors = transitiveDependencies(plan.tasks);
    const preexisting = new Set((ctx.preexistingArtifacts ?? []).map((a) => a.type));
    for (const task of plan.tasks) {
      for (const req of task.inputArtifacts) {
        if (!req.required || preexisting.has(req.type)) continue;
        const upstream = ancestors.get(task.key) ?? new Set<string>();
        const producedUpstream = [...upstream].some((key) =>
          byKey.get(key)?.expectedOutputs.includes(req.type),
        );
        if (producedUpstream) continue;
        const producedAnywhere = plan.tasks.some((t) => t.expectedOutputs.includes(req.type));
        error(
          task.key,
          producedAnywhere
            ? `Requires '${req.type}', which is produced by a task that is not an upstream dependency.`
            : `Requires '${req.type}', which no task in the plan produces.`,
        );
      }
    }
  }

  // A skip is only honest when the artifact it names is real: a stage the
  // planner claims is covered by an upload that does not exist (or is of the
  // wrong type) would leave the mission with no producer for that output.
  for (const skip of plan.skipped ?? []) {
    const upload = (ctx.preexistingArtifacts ?? []).find((a) => a.id === skip.artifactId);
    if (upload === undefined || upload.type !== skip.outputType) {
      error(null, `skipped stage '${skip.stage}' names ${skip.artifactId}, which is not an upload of type ${skip.outputType}.`);
    }
  }

  for (const task of plan.tasks) {
    const orphan = task.expectedOutputs.filter(
      (type) => !plan.tasks.some((t) => t.inputArtifacts.some((r) => r.type === type)),
    );
    if (orphan.length > 0 && task !== plan.tasks[plan.tasks.length - 1]) {
      warn(task.key, `Produces ${orphan.join(', ')} which no later task consumes.`);
    }
  }

  const blocking = issues.filter((i) => i.severity === 'error');
  return blocking.length > 0 ? Err(issues) : Ok(plan);
}

/** Returns the first cycle found as a readable key path, or null. */
export function findCycle(tasks: readonly PlannedTask[]): readonly string[] | null {
  const adjacency = new Map(tasks.map((t) => [t.key, t.dependsOn.filter((d) => tasks.some((x) => x.key === d))]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): readonly string[] | null => {
    const s = state.get(key);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of adjacency.get(key) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };

  for (const t of tasks) {
    const found = visit(t.key);
    if (found) return found;
  }
  return null;
}

/** key → set of all transitive dependency keys. Assumes an acyclic plan. */
export function transitiveDependencies(tasks: readonly PlannedTask[]): Map<string, Set<string>> {
  const direct = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const memo = new Map<string, Set<string>>();

  const resolve = (key: string, seen: Set<string>): Set<string> => {
    const cached = memo.get(key);
    if (cached) return cached;
    if (seen.has(key)) return new Set();
    seen.add(key);
    const out = new Set<string>();
    for (const dep of direct.get(key) ?? []) {
      out.add(dep);
      for (const t of resolve(dep, seen)) out.add(t);
    }
    memo.set(key, out);
    return out;
  };

  for (const t of tasks) resolve(t.key, new Set());
  return memo;
}

/**
 * Dependency-respecting execution order. Used for display and for merging task
 * branches into the integration branch in a deterministic order (MVP.md §11.3).
 */
export function topologicalOrder(tasks: readonly PlannedTask[]): Result<readonly string[], string> {
  const indegree = new Map(tasks.map((t) => [t.key, 0]));
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!indegree.has(dep)) continue;
      indegree.set(t.key, (indegree.get(t.key) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.key]);
    }
  }
  // Ties break on the plan's own ordering, which keeps the DAG view stable
  // between renders instead of shuffling on every refresh.
  const order = new Map(tasks.map((t, i) => [t.key, i]));
  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  ready.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const out: string[] = [];
  while (ready.length > 0) {
    const key = ready.shift()!;
    out.push(key);
    for (const next of dependents.get(key) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) {
        ready.push(next);
        ready.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      }
    }
  }
  return out.length === tasks.length ? Ok(out) : Err('Plan contains a cycle.');
}

/**
 * Assigns each task a DAG "level" (longest path from a root) so the UI can lay
 * the plan out in columns without a graph layout library.
 */
export function planLevels(tasks: readonly PlannedTask[]): Map<string, number> {
  const levels = new Map<string, number>();
  const ordered = topologicalOrder(tasks);
  const keys = ordered.ok ? ordered.value : tasks.map((t) => t.key);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  for (const key of keys) {
    const deps = byKey.get(key)?.dependsOn ?? [];
    const level = deps.length === 0 ? 0 : Math.max(...deps.map((d) => (levels.get(d) ?? 0) + 1));
    levels.set(key, level);
  }
  return levels;
}
