import { z } from 'zod';
import { ARTIFACT_TYPES } from './entities/artifact.js';
import { DEFAULT_WAIT_EVERY_MS, DEFAULT_WAIT_TIMEOUT_MS, ISOLATION_MODES } from './entities/task.js';
import type { IsolationMode } from './entities/task.js';
import { Err, Ok, type Result } from '@tandemise/shared';
import type { MissionPlan, PlannedTask } from './plan.js';
import { MAX_LADDER, MAX_MODEL_NAME, normalizeModelPolicy } from './entities/models.js';
import { parseSkillRef, stepSkillProblem } from './entities/skill.js';
import { lintGate } from './gate-lint.js';
import { STEP_CLASSES } from './planner/types.js';

/**
 * A workflow someone wrote, as opposed to one a model proposed.
 *
 * Tandemise shipped three workflow presets compiled into the binary, which is
 * fine until someone's process is not one of the three - and nobody's process
 * is. A real team's pipeline is specific: which gates, in what order, who
 * approves what, which repository each step lands in, and where a person has to
 * go and do something by hand. That belongs in a file next to the code it
 * describes, versioned with it and reviewable in a diff, not in this repository.
 *
 * The shape is deliberately the shape of a plan. A workflow compiles to exactly
 * the `MissionPlan` a planner would have produced, so it inherits the DAG, the
 * validator, the gates, the approvals and the scheduler unchanged - authoring a
 * workflow is writing a plan by hand, not teaching the engine a second language.
 *
 * What it is *not* is a place to restate the engine's rules. A gate that must
 * not be weakened, a retry limit, an isolated worktree per task: those are
 * enforced in code and stay there. A workflow says what the steps are.
 */

const templateString = z.string().min(1);
/** A model name as the runtime will receive it: one word (P12). */
const modelName = z.string().trim().min(1).max(MAX_MODEL_NAME).regex(/^\S+$/, 'a model name has no spaces');

const workflowStep = z.object({
  /** Stable key, referenced by `dependsOn`. Lowercase with underscores. */
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_]*$/, 'must be lowercase alphanumeric with underscores'),
  title: z.string().trim().min(1).optional(),
  /**
   * What the step is for. Templated with `{{ input }}` placeholders.
   *
   * For a person, this is the instruction they read; for an agent it is the
   * objective it is given. Same field because it is the same sentence.
   */
  objective: templateString,
  /**
   * Who carries it out. `agent` is a runtime; `human` is you.
   *
   * A human step is the reason this exists at all: a design that has to be made
   * in Figma, a console someone has to click through, an account that has to be
   * created. Modelling it as a step keeps it inside the dependency graph, so the
   * work that needs it waits rather than failing, and the mission is honest
   * about what it is waiting for.
   */
  executor: z.enum(['agent', 'human', 'wait', 'ship']).default('agent'),
  /**
   * What the step is for (#53 §5), independent of its key: the routing table is
   * keyed on it. Defaulted from the role when absent.
   */
  class: z.enum(STEP_CLASSES).optional(),
  /**
   * For `executor: wait` - the command that decides when the wait is over.
   *
   * A shell command rather than a list of supported services, because what is
   * being waited for differs every time: `gh pr checks --watch`, a curl at a
   * health endpoint, a vendor CLI. Exit 0 ends the wait.
   */
  waitFor: z.string().trim().min(1).optional(),
  everyMs: z.number().int().min(1000).max(600_000).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  /** Role template id. Ignored for a human step. */
  role: z.string().trim().min(1).optional(),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
  /** Repository name, for a project that has more than one. */
  repository: z.string().trim().min(1).nullish(),
  isolation: z.enum(ISOLATION_MODES).optional(),
  capabilities: z.array(z.string().trim().min(1)).default([]),
  /** Artifact types this step must produce before it counts as done. */
  outputs: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  inputs: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  /** Gate expression, measured after the step runs. */
  gate: z.string().trim().min(1).nullish(),
  approval: z.enum(['none', 'before', 'after']).default('none'),
  maxWallTimeMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  /** This step's model, over its role's and the runtime profile's (P12). */
  model: modelName.optional(),
  /** Models for retries: attempt 2 uses the first, attempt 3 and later the next (the last repeats). */
  escalate: z.array(modelName).max(MAX_LADDER).optional(),
  /**
   * An upstream step this one must be independent of: its run must use a
   * different runtime or model. Adds `review.independent` to the gate.
   */
  independentOf: z.string().trim().min(1).optional(),
  /**
   * Skills this step's runs get (P13): `name`, `name@2` or `name@latest`.
   * Resolved to a concrete version when the task is created.
   */
  skills: z.array(z.string().trim().min(1).refine((ref) => parseSkillRef(ref) !== null, {
    message: 'a skill is written as name, name@<version> or name@latest',
  })).max(20).optional(),
  /**
   * One of the team's own Claude Code skills this step runs instead of its
   * role's prompt (#131): `{ name: team:build-feature, args: '{{item.key}}' }`.
   * The step keeps its outputs and gate.
   */
  runSkill: stepSkillSchema().optional(),
});

/** `runSkill:` in a workflow step and an entry of `planner.yaml`'s `stepSkills` (#131). */
export function stepSkillSchema() {
  return z.object({
    name: z.string().trim().min(1).refine((n) => stepSkillProblem(n) === null, { message: 'a skill is written as name or plugin:name' }),
    args: z.string().max(2000).default(''),
  });
}

const workflowInput = z.object({
  name: z.string().trim().regex(/^[a-z][a-z0-9_]*$/i, 'must be a simple identifier'),
  description: z.string().trim().min(1).optional(),
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export const workflowDefinition = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).optional(),
  inputs: z.array(workflowInput).default([]),
  steps: z.array(workflowStep).min(1),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinition>;
export type WorkflowStep = z.infer<typeof workflowStep>;
export type WorkflowInput = z.infer<typeof workflowInput>;

export interface WorkflowIssue {
  readonly path: string;
  readonly message: string;
}

/** The role a human step is recorded under, so the UI can say who is waiting. */
export const HUMAN_ROLE_ID = 'human';
/** Likewise for a step that is only watching something outside this machine. */
export const WAIT_ROLE_ID = 'wait';
/** And for the daemon-owned ship step (#53 §8.1): no agent runs in it. */
export const SHIP_ROLE_ID = 'ship';

const DEFAULT_WALL_TIME_MS = 1_800_000;

/**
 * Reads a workflow file's already-parsed contents.
 *
 * Parsing YAML is the caller's job - this layer never touches a filesystem -
 * but everything that can be wrong *about* a workflow is decided here, so the
 * same answer comes back whether the file arrived from disk, an import, or a
 * test.
 */
export function parseWorkflowDefinition(raw: unknown): Result<WorkflowDefinition, readonly WorkflowIssue[]> {
  const parsed = workflowDefinition.safeParse(raw);
  if (!parsed.success) {
    return Err(parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })));
  }
  // A gate that could never pass is as broken as a misspelt key: the file is
  // listed with the reason, and nothing plans from it (P15).
  const gateIssues = parsed.data.steps.flatMap((step, index) => stepGateIssues(step, index));
  return gateIssues.length > 0 ? Err(gateIssues) : Ok(parsed.data);
}

/**
 * The validator's problems with one step's gate. Isolation is only judged when
 * the step says it (or cannot have one); a step inheriting its role's is judged
 * again at compile, once the role is known.
 */
function stepGateIssues(step: WorkflowStep, index: number, isolation?: IsolationMode): WorkflowIssue[] {
  if (step.gate === undefined || step.gate === null) return [];
  const known = isolation ?? (step.executor === 'agent' ? step.isolation : 'none');
  return lintGate(step.gate, {
    stepKey: step.key,
    outputs: step.outputs,
    independentOf: step.independentOf !== undefined,
    ...(known === undefined ? {} : { isolation: known }),
  }).map((problem) => ({ path: `steps.${index}.gate`, message: problem.message }));
}

/**
 * Turns a workflow and its inputs into the plan the scheduler runs.
 *
 * Everything structural is checked here rather than left to the plan validator,
 * because a workflow author wants to hear "step 'build' depends on 'desgin',
 * which does not exist" and not a failure three tasks into a mission.
 */
export interface WorkflowCompileContext {
  /**
   * A role's default isolation, so a step inherits it rather than falling to
   * `none`.
   *
   * This matters more than it reads. Tandemise's promise is that it never edits
   * your checkout - code work happens in a git worktree cut for that task. A
   * workflow author writing a `development` step should not have to remember
   * `isolation: worktree` to get that; forgetting it would silently point an
   * agent at the real working tree, which is the one outcome the product exists
   * to prevent. The role already knows; the step asks it.
   */
  readonly isolationForRole?: (roleId: string) => IsolationMode | undefined;
}

export function compileWorkflow(
  definition: WorkflowDefinition,
  inputs: Readonly<Record<string, string>>,
  ctx: WorkflowCompileContext = {},
): Result<MissionPlan, readonly WorkflowIssue[]> {
  const issues: WorkflowIssue[] = [];
  const resolved = resolveInputs(definition, inputs, issues);

  const keys = new Set<string>();
  for (const [index, step] of definition.steps.entries()) {
    if (keys.has(step.key)) issues.push({ path: `steps.${index}.key`, message: `Duplicate step key '${step.key}'.` });
    keys.add(step.key);
  }
  for (const [index, step] of definition.steps.entries()) {
    for (const dep of step.dependsOn) {
      if (dep === step.key) issues.push({ path: `steps.${index}.dependsOn`, message: `Step '${step.key}' depends on itself.` });
      else if (!keys.has(dep)) {
        issues.push({ path: `steps.${index}.dependsOn`, message: `Step '${step.key}' depends on '${dep}', which is not a step in this workflow.` });
      }
    }
    if (step.executor === 'agent' && step.role === undefined) {
      issues.push({ path: `steps.${index}.role`, message: `Step '${step.key}' runs on an agent, so it needs a role.` });
    }
    if (step.executor === 'wait' && step.waitFor === undefined) {
      issues.push({ path: `steps.${index}.waitFor`, message: `Step '${step.key}' waits, so it needs a \`waitFor\` command.` });
    }
    if (step.executor !== 'wait' && step.waitFor !== undefined) {
      issues.push({ path: `steps.${index}.waitFor`, message: `Step '${step.key}' sets \`waitFor\` but is not a wait step.` });
    }
  }
  const ships = definition.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.executor === 'ship');
  for (const { step, index } of ships.slice(1)) {
    issues.push({ path: `steps.${index}.executor`, message: `A workflow has at most one ship step; '${step.key}' is the second.` });
  }
  const byKey = new Map(definition.steps.map((step) => [step.key, step]));
  for (const [index, step] of definition.steps.entries()) {
    if (step.independentOf === undefined) continue;
    if (!upstreamOf(step.key, byKey).has(step.independentOf)) {
      issues.push({
        path: `steps.${index}.independentOf`,
        message: `Step '${step.key}' must be independent of '${step.independentOf}', so it has to depend on that step (directly or through others).`,
      });
    }
  }

  if (issues.length > 0) return Err(issues);

  const tasks = definition.steps.map((step) => toPlannedTask(step, resolved, issues, ctx));
  // Again with each step's resolved isolation: `git.clean` on a step that
  // inherits `none` from its role is only knowable now.
  for (const [index, step] of definition.steps.entries()) {
    issues.push(...stepGateIssues(step, index, tasks[index]?.executionPolicy.isolation));
  }
  if (issues.length > 0) return Err(issues);

  return Ok({
    summary: definition.description ?? `Runs the "${definition.name}" workflow.`,
    tasks,
  });
}

/** Every step `key` depends on, directly or through others. */
function upstreamOf(key: string, byKey: ReadonlyMap<string, WorkflowStep>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byKey.get(key)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next) || next === key) continue;
    seen.add(next);
    stack.push(...(byKey.get(next)?.dependsOn ?? []));
  }
  return seen;
}

/** `independentOf` is enforced by the gate: the fact is added to it (P12). */
function withIndependence(gate: string | null, independentOf: string | undefined): string | null {
  if (independentOf === undefined) return gate;
  if (gate === null) return 'review.independent';
  if (/\breview\.independent\b/.test(gate)) return gate;
  return `(${gate}) && review.independent`;
}

function resolveInputs(
  definition: WorkflowDefinition,
  provided: Readonly<Record<string, string>>,
  issues: WorkflowIssue[],
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const input of definition.inputs) {
    const value = provided[input.name] ?? input.default;
    if (value === undefined || value === '') {
      if (input.required) issues.push({ path: `inputs.${input.name}`, message: `Input '${input.name}' is required.` });
      continue;
    }
    resolved[input.name] = value;
  }
  return resolved;
}

/**
 * Substitutes `{{ name }}`.
 *
 * Deliberately the whole templating language. A workflow that needs conditions
 * and loops is a program, and the moment this grows an expression evaluator it
 * becomes one nobody can debug - the DAG is where branching belongs.
 */
export function applyTemplate(
  text: string,
  values: Readonly<Record<string, string>>,
  onUnknown: (name: string) => void,
): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      onUnknown(name);
      return `{{ ${name} }}`;
    }
    return value;
  });
}

function toPlannedTask(
  step: WorkflowStep,
  values: Readonly<Record<string, string>>,
  issues: WorkflowIssue[],
  ctx: WorkflowCompileContext,
): PlannedTask {
  const objective = applyTemplate(step.objective, values, (name) => {
    issues.push({ path: `steps.${step.key}.objective`, message: `Uses {{ ${name} }}, which this workflow does not declare as an input.` });
  });
  const human = step.executor === 'human';
  const waiting = step.executor === 'wait';
  const shipping = step.executor === 'ship';

  return {
    key: step.key,
    title: step.title ?? step.key.replace(/_/g, ' '),
    objective,
    // A person's step keeps the role it names, so staffing for that role applies
    // to it; the placeholder is only for a step that names none.
    roleId: waiting ? WAIT_ROLE_ID : shipping ? SHIP_ROLE_ID : step.role ?? HUMAN_ROLE_ID,
    executor: step.executor,
    ...(step.class === undefined ? (shipping ? { stepClass: 'ship' as const } : {}) : { stepClass: step.class }),
    waitPolicy: waiting
      ? {
          command: applyTemplate(step.waitFor as string, values, (name) => {
            issues.push({ path: `steps.${step.key}.waitFor`, message: `Uses {{ ${name} }}, which this workflow does not declare as an input.` });
          }),
          everyMs: step.everyMs ?? DEFAULT_WAIT_EVERY_MS,
          timeoutMs: step.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        }
      : null,
    repository: step.repository ?? null,
    dependsOn: step.dependsOn,
    requiredCapabilities: step.capabilities,
    inputArtifacts: step.inputs.map((type) => ({ type, required: true })),
    expectedOutputs: step.outputs,
    executionPolicy: {
      // Neither a person nor a poll is sandboxed. Cutting a worktree on their
      // behalf would leave one nobody ever opens. Everything else takes the
      // step's own answer, then its role's, and only then `none`.
      isolation: human || waiting || shipping
        ? 'none'
        : step.isolation
          ?? (step.role === undefined ? undefined : ctx.isolationForRole?.(step.role))
          ?? 'none',
      maxWallTimeMs: step.maxWallTimeMs ?? DEFAULT_WALL_TIME_MS,
      capabilities: step.capabilities,
    },
    approvalPolicy: {
      beforeStart: step.approval === 'before',
      // A human step is its own approval: waiting for someone to do the work
      // and then asking them to approve it is one interruption too many.
      onCompletion: !human && step.approval === 'after',
    },
    retryPolicy: {
      // Retrying a wait means starting the clock again, which is what the
      // timeout already decided against.
      maxAttempts: human || waiting || shipping ? 1 : step.maxAttempts ?? 2,
      backoffMs: 5_000,
      onExhausted: 'block',
    },
    completionGate: withIndependence(step.gate ?? null, step.independentOf),
    modelPolicy: normalizeModelPolicy({
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.escalate === undefined ? {} : { escalate: step.escalate }),
      ...(step.independentOf === undefined ? {} : { independentOf: step.independentOf }),
    }),
    ...(step.skills === undefined || step.skills.length === 0
      ? {}
      : { skillRefs: step.skills.map((ref) => parseSkillRef(ref)!) }),
    ...(step.runSkill === undefined || step.executor !== 'agent' ? {} : { runSkill: { name: step.runSkill.name, args: step.runSkill.args } }),
  };
}
