import { z } from 'zod';
import { lintGate, lintRule } from '../gate-lint.js';
import { ARTIFACT_TYPES } from '../entities/artifact.js';
import { CHECK_NAMES, MAX_CHECK_BUDGET_MINUTES } from '../entities/workspace.js';
import { stepSkillProblem } from '../entities/skill.js';
import { CI_CHECK_KINDS } from '../merge/ci-checks.js';
import { LANES, RISK_LEVELS, SENSITIVITIES, STEP_CLASSES, TASK_SIZES, TASK_TYPES } from './types.js';

/**
 * `planner.yaml` (#53 §3): areas, profile rules, lanes, modules. Parsed here so
 * the same answer comes back whether the file came from a repository, this
 * computer or the shipped default. A rule whose `when` can't be read is dropped
 * and reported; one bad rule never stops planning.
 */
const onOff = z.preprocess((v) => (v === true ? 'on' : v === false ? 'off' : v), z.enum(['on', 'off']));
const name = z.string().trim().min(1);
const when = z.string().trim().min(1);

/**
 * What a check runs when every changed file is in this area (#106): a command,
 * or `none` (or null) for "this change needs no such check". A check an area
 * does not name runs the repository's own command.
 */
const areaCommand = z.preprocess(
  (v) => (typeof v === 'string' && ['none', 'off', ''].includes(v.trim().toLowerCase()) ? null : v),
  z.string().trim().min(1).nullable(),
);

const area = z.object({
  name,
  paths: z.array(name).min(1),
  sensitivity: z.enum(SENSITIVITIES).default('none'),
  skills: z.array(name).default([]),
  checks: z.record(z.enum(CHECK_NAMES), areaCommand).optional(),
});

/** Each check's time budget in minutes (#111); a repository's own setting overrides it. */
const checkSettings = z.object({
  budgets: z.record(z.enum(CHECK_NAMES), z.number().int().min(1).max(MAX_CHECK_BUDGET_MINUTES)).default({}),
});

const profileRule = z.object({
  when,
  set: z.object({
    type: z.enum(TASK_TYPES).optional(),
    size: z.enum(TASK_SIZES).optional(),
    risk: z.enum(RISK_LEVELS).optional(),
  }),
});

const laneRule = z.object({ when: when.optional(), lane: z.enum(LANES) });

const moduleStep = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_]*$/),
  class: z.enum(STEP_CLASSES).optional(),
  role: name,
  after: name,
  title: name.optional(),
  objective: name.optional(),
  outputs: z.array(z.enum(ARTIFACT_TYPES)).optional(),
  skills: z.array(name).default([]),
  gate: when.optional(),
});

const plannerModule = z.object({
  name,
  when,
  add: z.object({
    step: moduleStep.optional(),
    gateClause: z.object({ step: name, clause: when }).optional(),
    approval: z.object({ step: name, when: z.enum(['before', 'after']), reason: name }).optional(),
    skills: z.object({ step: name, skills: z.array(name).min(1) }).optional(),
    maxAttempts: z.object({ step: name, atLeast: z.number().int().min(1).max(10) }).optional(),
  }),
});

/**
 * `stepSkills` (#131): the team's own skill a step of a class runs instead of
 * its role's prompt, first match per class. `when` reads the plan facts.
 */
const stepSkillRule = z.object({
  class: z.enum(STEP_CLASSES),
  when: when.optional(),
  skill: name.refine((n) => stepSkillProblem(n) === null, { message: 'a skill is written as name or plugin:name' }),
  args: z.string().max(2000).default(''),
});

const laneMap = z.object({ quick: name, standard: name, careful: name });

export const plannerConfigSchema = z.object({
  version: z.literal(1).default(1),
  areas: z.array(area).default([]),
  trackerTypes: z.record(z.string(), z.enum(TASK_TYPES)).default({}),
  labels: z.record(z.string(), z.enum(TASK_TYPES)).default({}),
  profile: z.object({ rules: z.array(profileRule).default([]) }).default({ rules: [] }),
  lanes: z.array(laneRule).default([]),
  laneWorkflows: laneMap.default({ quick: 'quick', standard: 'standard', careful: 'careful' }),
  byType: z.record(z.string(), z.record(z.string(), name)).default({}),
  modules: z.array(plannerModule).default([]),
  stepSkills: z.array(stepSkillRule).default([]),
  holdApproval: z.object({
    minTasks: z.number().int().min(1).max(100).default(5),
    rate: z.number().min(0).max(1).default(0.4),
  }).default({ minTasks: 5, rate: 0.4 }),
  tiebreak: onOff.default('on'),
  checks: checkSettings.default({ budgets: {} }),
  /**
   * CI on the pull request. `checks` (#194): what a failing check is about, a
   * check's name or a glob over it mapped to `metadata`, `code` or `unknown`,
   * winning over the defaults, which read the check's name and what it
   * printed. `maxRounds` (#196): how many rounds a mission takes on its own
   * before a person decides.
   */
  ci: z.object({
    checks: z.record(name, z.enum(CI_CHECK_KINDS)).default({}),
    maxRounds: z.number().int().min(1).max(50).default(3),
  }).default({ checks: {}, maxRounds: 3 }),
});

export type PlannerConfig = z.infer<typeof plannerConfigSchema>;
export type PlannerArea = PlannerConfig['areas'][number];
export type ProfileRule = PlannerConfig['profile']['rules'][number];
export type LaneRule = PlannerConfig['lanes'][number];
export type PlannerModule = PlannerConfig['modules'][number];
export type ModuleStep = NonNullable<PlannerModule['add']['step']>;
export type StepSkillRule = PlannerConfig['stepSkills'][number];

export interface ConfigProblem {
  readonly path: string;
  readonly message: string;
}

/** A config with nothing in it: every task is standard, no modules, no areas. */
export const EMPTY_PLANNER_CONFIG: PlannerConfig = plannerConfigSchema.parse({});

/**
 * Reads a parsed `planner.yaml`. A structurally broken file yields `fallback`
 * (the shipped default) plus one problem; a rule, lane or module whose
 * condition can't be read is dropped and reported, and the rest still load.
 */
export function parsePlannerConfig(raw: unknown, fallback: PlannerConfig = EMPTY_PLANNER_CONFIG): {
  readonly config: PlannerConfig;
  readonly problems: readonly ConfigProblem[];
} {
  const parsed = plannerConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      config: fallback,
      problems: [{ path: issue?.path.join('.') || '(root)', message: `The planner file can't be read (${issue?.message ?? 'invalid'}), so the built-in rules apply.` }],
    };
  }
  const problems: ConfigProblem[] = [];
  const keep = (path: string, expression: string): boolean => {
    const found = lintRule(expression, 'plan');
    for (const p of found) problems.push({ path, message: p.message });
    return found.length === 0;
  };
  const c = parsed.data;
  const rules = c.profile.rules.filter((r, i) => keep(`profile.rules.${i}.when`, r.when));
  const lanes = c.lanes.filter((r, i) => r.when === undefined || keep(`lanes.${i}.when`, r.when));
  const modules = c.modules.filter((m, i) => {
    if (!keep(`modules.${i}.when`, m.when)) return false;
    const step = m.add.step;
    if (step?.gate !== undefined) {
      const found = lintGate(step.gate, { stepKey: step.key, outputs: step.outputs ?? defaultOutputs(step.class ?? 'review'), independentOf: false });
      if (found.length > 0) { problems.push({ path: `modules.${i}.add.step.gate`, message: found[0]!.message }); return false; }
    }
    return true;
  });
  const stepSkills = c.stepSkills.filter((r, i) => r.when === undefined || keep(`stepSkills.${i}.when`, r.when));
  return { config: { ...c, profile: { rules }, lanes, modules, stepSkills }, problems };
}

/** What a step of a class writes when a module doesn't say. */
export function defaultOutputs(cls: (typeof STEP_CLASSES)[number]): readonly (typeof ARTIFACT_TYPES)[number][] {
  switch (cls) {
    case 'implement': case 'resolve_conflicts': return ['ChangeSet'];
    case 'review': return ['ReviewReport'];
    case 'verify': return ['QAReport'];
    case 'spec': return ['ProductSpec'];
    case 'design': return ['DesignBrief'];
    case 'architecture': return ['ArchitecturePlan'];
    case 'investigate': return ['ProductSpec'];
    case 'ship': return [];
  }
}
