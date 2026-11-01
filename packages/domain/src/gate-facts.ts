import { APPROVAL_KINDS } from './entities/approval.js';
import { ARTIFACT_TYPES, isArtifactType } from './entities/artifact.js';

/**
 * The complete gate fact vocabulary (MVP.md §17.2), with where each fact is
 * measured.
 *
 * This is a published contract in four directions at once: the validator reads
 * it to refuse a gate that can never pass, the planner prompt lists the facts a
 * step's gate may read, `docs/WORKFLOWS.md` is generated from it, and
 * `GateFactBuilder` (in `@tandemise/evaluation`) produces the step facts.
 * Keeping the scope next to the name - rather than in a doc that drifts - is
 * what makes "this gate can never pass" something the daemon can say when the
 * gate is written, instead of an hour later on an intervention card.
 *
 * It lives in domain because plan and workflow validation live here and must
 * read it; `@tandemise/evaluation` re-exports it unchanged.
 *
 * A fact that is not measured is `undefined`, and `undefined` compares false
 * against everything. A gate never passes because a measurement was missing.
 */
export type FactScope = 'step' | 'mission' | 'workspace' | 'plan' | 'ship';

/**
 * A step fact measured only under a condition the step itself declares. The
 * validator refuses a gate that reads one on a step without it.
 */
export type FactRequirement = 'independentOf' | 'worktree' | 'changeset';

export interface FactDefinition {
  readonly name: string;
  readonly type: 'outcome' | 'boolean' | 'number' | 'verdict' | 'approval' | 'string' | 'predicate';
  readonly description: string;
  /** Written with `<...>` where the name is parameterised. */
  readonly example: string;
  /**
   * `step`: measured when a step's gate is read (`GateService.factsFor`).
   * `mission` / `workspace`: measured for the whole mission or project by a
   * daemon rule or service, never inside a step - a step gate reading one
   * fails as "not measured" on every attempt.
   * `plan` / `ship`: read only by factory rules (#53): `planner.yaml` rules
   * when a task is profiled, `merge.yaml` rules when a pull request's merge is
   * decided. A predicate's name ends in `()` and is called with literals.
   */
  readonly scope: FactScope;
  /** Where the daemon supplies it, in words, for the docs table. */
  readonly measuredIn: string;
  readonly requires?: FactRequirement;
}

const STEP_GATE = 'step gate';
const PLANNER = 'planner';
const SHIP = 'ship step';

const planFact = (name: string, type: FactDefinition['type'], description: string, example: string): FactDefinition =>
  ({ name, type, description, example, scope: 'plan', measuredIn: PLANNER });
const shipFact = (name: string, type: FactDefinition['type'], description: string, example: string): FactDefinition =>
  ({ name, type, description, example, scope: 'ship', measuredIn: SHIP });

/**
 * Facts a planner rule reads (`planner.yaml`), measured from the tracker item
 * and the task profile before any code changes (#53 §3).
 */
const PLAN_FACTS: readonly FactDefinition[] = [
  planFact('item.type', 'string', 'The tracker item\'s type as the tracker names it (Bug, Feature), or not measured when it has none.', 'item.type == "Bug"'),
  planFact('item.prefix', 'string', 'The Conventional-Commit prefix of the title (fix, docs, feat), or not measured when the title has none.', 'item.prefix == "docs"'),
  planFact('item.criteria', 'number', 'Done-when lines the task was given.', 'item.criteria >= 2'),
  planFact('item.keywords_any()', 'predicate', 'True when the title or description contains any of the words given, ignoring case.', 'item.keywords_any("typo", "rename")'),
  planFact('item.labels_any()', 'predicate', 'True when the tracker item has any of the labels given.', 'item.labels_any("dependencies")'),
  planFact('item.source_any()', 'predicate', 'True when the task came from any of the source kinds given (sentry, posthog, dependabot, advisory).', 'item.source_any("sentry")'),
  planFact('profile.type', 'string', 'The task profile\'s type: fix, feature, refactor, chore, docs, deps, test, security or unknown.', 'profile.type == "feature"'),
  planFact('profile.size', 'string', 'The task profile\'s size: xs, s, m or l.', 'profile.size == "xs"'),
  planFact('profile.risk', 'string', 'The task profile\'s risk: low, medium or high. Never below the sensitivity floor.', 'profile.risk == "high"'),
  planFact('profile.max_sensitivity', 'string', 'The highest sensitivity of the areas the task touches: none, sensitive or critical.', 'profile.max_sensitivity == "critical"'),
  planFact('profile.repos', 'number', 'Repositories the task names or implies.', 'profile.repos > 1'),
  planFact('profile.areas_any()', 'predicate', 'True when the task touches any of the areas named.', 'profile.areas_any("auth", "payments")'),
];

/**
 * Facts a merge rule reads (`merge.yaml`), measured by the daemon from the
 * repository, GitHub and its own records at the pull request's head commit
 * (#53 §8.2). None is ever taken from text an agent wrote.
 */
const SHIP_FACTS: readonly FactDefinition[] = [
  shipFact('change.files', 'number', 'Files the pull request changes.', 'change.files > 15'),
  shipFact('change.lines_added', 'number', 'Lines added, from the diff\'s numstat.', 'change.lines_added + change.lines_removed > 400'),
  shipFact('change.lines_removed', 'number', 'Lines removed, from the diff\'s numstat.', 'change.lines_removed > 100'),
  shipFact('change.repos', 'number', 'Repositories this mission opened pull requests in.', 'change.repos > 1'),
  shipFact('change.binary_files', 'number', 'Binary files changed.', 'change.binary_files > 0'),
  shipFact('change.deleted_files', 'number', 'Files deleted.', 'change.deleted_files > 0'),
  shipFact('change.tests_touched', 'number', 'Changed files that match the merge policy\'s test globs.', 'change.tests_touched == 0'),
  shipFact('change.dependencies_changed', 'boolean', 'A dependency manifest or lockfile changed.', 'change.dependencies_changed'),
  shipFact('change.lockfile_only', 'boolean', 'Only lockfiles changed among the dependency files.', '!change.lockfile_only'),
  shipFact('change.max_sensitivity', 'string', 'The highest sensitivity of the areas the change touches: none, sensitive or critical.', 'change.max_sensitivity == "sensitive"'),
  shipFact('change.areas_any()', 'predicate', 'True when the change touches any of the areas named.', 'change.areas_any("auth")'),
  shipFact('change.paths_matching()', 'predicate', 'How many changed paths match the glob given.', 'change.paths_matching("**/*.sql") > 0'),
  shipFact('coverage.changed_lines', 'number', 'Percent of changed lines covered, only when the checks produce a coverage report. Otherwise not measured.', 'coverage.changed_lines < 60'),
  shipFact('ci.state', 'outcome', 'PASS only when every check on the head commit succeeded and there is at least one.', 'ci.state == PASS'),
  shipFact('ci.required_present', 'boolean', 'The base branch has required status checks.', 'ci.required_present'),
  shipFact('github.review_required', 'boolean', 'Branch protection requires an approving review.', 'github.review_required'),
  shipFact('criteria.unverified', 'number', 'Done-when lines the person gave that no QA report verified.', 'criteria.unverified > 0'),
  shipFact('criteria.implicit', 'boolean', 'The only Done-when line is the implicit one: the task as written.', 'criteria.implicit'),
  shipFact('process.lane', 'string', 'The lane the mission ran in: quick, standard or careful.', 'process.lane == "careful"'),
  shipFact('process.lightened_by_person', 'boolean', 'A person made the mission quick.', 'process.lightened_by_person'),
  shipFact('process.steps_skipped', 'number', 'Ceremony the lane skipped.', 'process.steps_skipped > 2'),
  shipFact('process.holds', 'number', 'Times a person held a step of this mission.', 'process.holds > 0'),
  shipFact('process.changes_requested', 'number', 'Request-changes rounds in this mission.', 'process.changes_requested > 0'),
  shipFact('process.escalations', 'number', 'Times a step moved to a stronger model.', 'process.escalations > 1'),
  shipFact('process.gate_retries', 'number', 'Attempts after a failed gate across the mission.', 'process.gate_retries > 2'),
  shipFact('process.person_commits', 'number', 'Commits on the pull request not made by Tandemise or its agents.', 'process.person_commits > 0'),
  shipFact('process.retry_out_of_scope', 'boolean', 'A retry changed files its step had not touched before (the scope.retry check).', 'process.retry_out_of_scope'),
  shipFact('process.revert_of_auto', 'boolean', 'The pull request reverts a change Tandemise merged on its own.', 'process.revert_of_auto'),
  shipFact('history.area_reverts_90d', 'number', 'Reverts in the areas touched over the last 90 days.', 'history.area_reverts_90d > 1'),
  shipFact('history.area_recent_revert', 'boolean', 'An area touched had a revert or broke main in the last 14 days.', 'history.area_recent_revert'),
];

/** Step facts a merge rule may also read, measured on the mission's last code step. */
export const SHIP_READS_STEP_FACTS = ['checks.tests', 'review.blocking_findings', 'review.major_findings', 'review.independent'] as const;

export const GATE_FACT_VOCABULARY: readonly FactDefinition[] = [
  {
    name: 'checks.install',
    type: 'outcome',
    description: 'Dependency install command exit status. SKIP when the repository configures none. Run before any other check a gate reads.',
    example: 'checks.install == PASS',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'checks.typecheck',
    type: 'outcome',
    description: 'Type checker exit status. SKIP when the repository configures none.',
    example: 'checks.typecheck == PASS',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'checks.lint',
    type: 'outcome',
    description: 'Linter exit status. SKIP when the repository configures none.',
    example: 'checks.lint == PASS',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'checks.tests',
    type: 'outcome',
    description: 'Test command exit status. Plural, unlike the repository field it comes from. SKIP when the repository configures none.',
    example: 'checks.tests == PASS',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'checks.build',
    type: 'outcome',
    description: 'Build command exit status. SKIP when the repository configures none.',
    example: 'checks.build == PASS',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'artifact.<Type>.exists',
    type: 'boolean',
    description: 'True when at least one non-superseded artifact of that type exists for the mission. A gate on a step with outputs must read this for one of them.',
    example: 'artifact.ChangeSet.exists',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'artifact.<Type>.count',
    type: 'number',
    description: 'How many artifacts of that type the mission has.',
    example: 'artifact.QAReport.count >= 1',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'review.verdict',
    type: 'verdict',
    description: "Independent reviewer's verdict: pass, needs_changes, or fail.",
    example: 'review.verdict == "pass"',
    scope: 'step',
    measuredIn: `${STEP_GATE}, after a review`,
  },
  {
    name: 'review.blocking_findings',
    type: 'number',
    description: 'Count of reviewer findings with severity `blocking`.',
    example: 'review.blocking_findings == 0',
    scope: 'step',
    measuredIn: `${STEP_GATE}, after a review`,
  },
  {
    name: 'review.major_findings',
    type: 'number',
    description: 'Count of reviewer findings with severity `major`.',
    example: 'review.major_findings <= 2',
    scope: 'step',
    measuredIn: `${STEP_GATE}, after a review`,
  },
  {
    name: 'review.independent',
    type: 'boolean',
    description: "Set on a step with `independentOf: <step>`: true when this step's run used a different runtime, or a different known model, than that step's run. A model left to the runtime's default cannot be shown to differ on the same runtime, so it reads false. Absent until both runs exist.",
    example: 'artifact.ReviewReport.exists && review.independent',
    scope: 'step',
    measuredIn: `${STEP_GATE}, only with \`independentOf\``,
    requires: 'independentOf',
  },
  {
    name: 'skills.loaded',
    type: 'number',
    description: "How many pinned skills this step's newest run received, as a folder or in its prompt (P13). 0 before the step has run or when it pins none.",
    example: 'skills.loaded >= 1',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'skills.missing',
    type: 'number',
    description: "How many of this step's pinned skills its newest run did not receive at the pinned version and hash (P13). A run never starts with a pinned skill's content missing, so this reads 0 after a normal run.",
    example: 'artifact.ChangeSet.exists && skills.missing == 0',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'qa.acceptance_criteria_coverage',
    type: 'number',
    description: 'Percentage (0-100) of the mission\'s criteria QA verified as PASS. A criterion QA skipped or never reported counts as not verified. Without a Done-when ledger, the share of QA\'s own results that passed.',
    example: 'qa.acceptance_criteria_coverage == 100',
    scope: 'step',
    measuredIn: `${STEP_GATE}, with criteria or after QA`,
  },
  {
    name: 'qa.criteria_verified',
    type: 'number',
    description: 'Criteria on the Done-when ledger that the newest QA report marked PASS (a user criterion counts only when nothing in the spec covers it).',
    example: 'qa.criteria_verified >= 1',
    scope: 'step',
    measuredIn: `${STEP_GATE}, with criteria`,
  },
  {
    name: 'qa.criteria_failed',
    type: 'number',
    description: 'Criteria on the Done-when ledger that the newest QA report marked FAIL.',
    example: 'qa.criteria_failed == 0',
    scope: 'step',
    measuredIn: `${STEP_GATE}, with criteria`,
  },
  {
    name: 'qa.criteria_unverified',
    type: 'number',
    description: 'Criteria on the Done-when ledger with no PASS or FAIL from QA: skipped, never reported, not covered, or written after QA ran.',
    example: 'qa.criteria_unverified == 0',
    scope: 'step',
    measuredIn: `${STEP_GATE}, with criteria`,
  },
  {
    name: 'criteria.total',
    type: 'number',
    description: 'Live criteria on the Done-when ledger: the person\'s lines plus the current spec\'s acceptance criteria.',
    example: 'criteria.total >= 1',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'criteria.user_total',
    type: 'number',
    description: 'Done-when lines the person wrote (U1, U2, …).',
    example: 'criteria.user_total >= 1',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'criteria.uncovered_user',
    type: 'number',
    description: 'Done-when lines that no acceptance criterion of the current spec lists in `covers`.',
    example: 'criteria.uncovered_user == 0',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'criteria.unknown_covers',
    type: 'number',
    description: 'Entries in the spec\'s `covers` lists that name no Done-when line.',
    example: 'criteria.unknown_covers == 0',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'qa.blocking_defects',
    type: 'number',
    description: 'Count of QA defects that block release.',
    example: 'qa.blocking_defects == 0',
    scope: 'step',
    measuredIn: `${STEP_GATE}, after QA`,
  },
  {
    name: 'qa.verdict',
    type: 'verdict',
    description: "QA role's overall verdict.",
    example: 'qa.verdict == "pass"',
    scope: 'step',
    measuredIn: `${STEP_GATE}, after QA`,
  },
  {
    name: 'approval.plan',
    type: 'approval',
    description: 'Status of the mission plan approval. A pending one wins over an approved one.',
    example: 'approval.plan == APPROVED',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'approval.release_candidate',
    type: 'approval',
    description: 'Status of the release approval. PENDING until a human decides.',
    example: 'approval.release_candidate == APPROVED',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'approval.<kind>',
    type: 'approval',
    description: 'Status of any other approval kind on the mission: choice, exception, action, intervention, check.',
    example: 'approval.exception == APPROVED',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'task.attempt',
    type: 'number',
    description: 'Which attempt at the task this is; 0 before it first runs.',
    example: 'task.attempt >= 2',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'task.role',
    type: 'verdict',
    description: 'The role the task is staffed under.',
    example: 'task.role == "development"',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'task.risk',
    type: 'verdict',
    description: "The highest risk class among the task's capabilities: read, write_reversible, external_side_effect, destructive, financial or release.",
    example: 'task.risk == "release"',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'task.risk_level',
    type: 'number',
    description: 'task.risk as its position in that list, 0 (read) to 5 (release), so a condition can use >=.',
    example: 'task.risk_level >= 2',
    scope: 'step',
    measuredIn: STEP_GATE,
  },
  {
    name: 'diff.files_changed',
    type: 'number',
    description: "How many files the step's own ChangeSet says it changed. Not measured when it wrote no ChangeSet.",
    example: 'diff.files_changed > 20',
    scope: 'step',
    measuredIn: `${STEP_GATE}, when the step writes a ChangeSet`,
    requires: 'changeset',
  },
  {
    name: 'git.clean',
    type: 'outcome',
    description: 'PASS when the step\'s worktree has nothing uncommitted after Tandemise committed the worker\'s changes and ran the checks (a build that rewrites a tracked file makes it FAIL, listing the files). Recorded with the checks.',
    example: 'git.clean == PASS',
    scope: 'step',
    measuredIn: `${STEP_GATE}, only on a step with its own worktree`,
    requires: 'worktree',
  },
  {
    name: 'ready.criteria',
    type: 'number',
    description: 'Accepted Done-when criteria of a DRAFT mission: the person\'s lines, ones added by hand and accepted proposals. Read by the readiness gate before planning.',
    example: 'ready.criteria >= 1',
    scope: 'mission',
    measuredIn: 'the readiness check before planning',
  },
  {
    name: 'ready.open_questions',
    type: 'number',
    description: 'Questions refinement asked that the person has not answered yet.',
    example: 'ready.open_questions == 0',
    scope: 'mission',
    measuredIn: 'the readiness check before planning',
  },
  {
    name: 'ready.proposed_pending',
    type: 'number',
    description: 'Criteria refinement proposed that the person has not accepted or rejected yet.',
    example: 'ready.proposed_pending == 0',
    scope: 'mission',
    measuredIn: 'the readiness check before planning',
  },
  {
    name: 'mission.priority',
    type: 'number',
    description: 'The mission\'s priority as a number: 0 urgent, 1 high, 2 normal, 3 low. Orders the backlog and the worker slots.',
    example: 'mission.priority <= 1',
    scope: 'mission',
    measuredIn: 'published; the backlog orders by priority directly',
  },
  {
    name: 'workspace.active_missions',
    type: 'number',
    description: 'Missions in progress in the project: not DRAFT, not PAUSED and not finished. Read by the backlog pull.',
    example: 'workspace.active_missions < workspace.max_active_missions',
    scope: 'workspace',
    measuredIn: 'the backlog pull',
  },
  {
    name: 'workspace.max_active_missions',
    type: 'number',
    description: 'The project\'s work-in-progress limit. Not measured when the limit is off, so a gate reading it never passes and nothing is pulled.',
    example: 'workspace.max_active_missions >= 2',
    scope: 'workspace',
    measuredIn: 'the backlog pull',
  },
  {
    name: 'mission.agent_minutes',
    type: 'number',
    description: 'Agent time the mission\'s runs used, in minutes: what each runtime reported, or the run\'s own duration when it reported none.',
    example: 'mission.agent_minutes < 60',
    scope: 'mission',
    measuredIn: 'the limit service',
  },
  {
    name: 'mission.tokens',
    type: 'number',
    description: 'Input plus output tokens the mission\'s runs reported. Not measured when no runtime reported tokens.',
    example: 'mission.tokens < 200000',
    scope: 'mission',
    measuredIn: 'the limit service',
  },
  {
    name: 'mission.spend_usd',
    type: 'number',
    description: 'Cost in US dollars the mission\'s runs reported. Not measured when no runtime reported a cost: never read as 0.',
    example: 'mission.spend_usd < 5',
    scope: 'mission',
    measuredIn: 'the limit service',
  },
  {
    name: 'mission.limit_percent',
    type: 'number',
    description: 'How much of its most-used limit the mission has used, in percent. Not measured when it has no limit. Work stops at 100.',
    example: 'mission.limit_percent < 80',
    scope: 'mission',
    measuredIn: 'the limit service',
  },
  {
    name: 'workspace.month_limit_percent',
    type: 'number',
    description: 'How much of its most-used monthly limit the project has used this calendar month, in percent. Not measured without a monthly limit.',
    example: 'workspace.month_limit_percent < 80',
    scope: 'workspace',
    measuredIn: 'the limit service',
  },
  {
    name: 'mission.stalled',
    type: 'number',
    description: 'Whether the mission is stalled: 1 when nothing moves it and nothing asks the person (it has a Stalled row in the Inbox), else 0.',
    example: 'mission.stalled == 0',
    scope: 'mission',
    measuredIn: 'the liveness service',
  },
  {
    name: 'run.silent_minutes',
    type: 'number',
    description: 'Minutes since the step\'s live run last wrote an event. Not measured when the step has no live run - which is always the case when a step\'s gate is read, after its run ended.',
    example: 'run.silent_minutes < 10',
    scope: 'mission',
    measuredIn: 'the liveness service',
  },
  ...PLAN_FACTS,
  ...SHIP_FACTS,
];

/** Approval kinds a gate names directly; `release` is published as `approval.release_candidate`. */
const GENERIC_APPROVAL_KINDS: readonly string[] = APPROVAL_KINDS.filter((k) => k !== 'plan' && k !== 'release');

const BY_NAME = new Map(GATE_FACT_VOCABULARY.map((f) => [f.name, f]));

/**
 * The definition a concrete fact name falls under, or undefined when the daemon
 * does not know it. `artifact.<Type>.*` needs a real artifact type and
 * `approval.<kind>` a real approval kind: `artifact.Changeset.exists` is a typo,
 * not a fact.
 */
export function factDefinition(name: string): FactDefinition | undefined {
  const exact = BY_NAME.get(name);
  if (exact !== undefined && !exact.name.includes('<')) return exact;
  const artifact = /^artifact\.([A-Za-z]+)\.(exists|count)$/.exec(name);
  if (artifact !== null) {
    return isArtifactType(artifact[1] ?? '') ? BY_NAME.get(`artifact.<Type>.${artifact[2]}`) : undefined;
  }
  const approval = /^approval\.([a-z_]+)$/.exec(name);
  if (approval !== null && GENERIC_APPROVAL_KINDS.includes(approval[1] ?? '')) return BY_NAME.get('approval.<kind>');
  return undefined;
}

/** Every concrete fact name a gate could read, for "did you mean". */
export function concreteFactNames(): readonly string[] {
  const out: string[] = [];
  for (const fact of GATE_FACT_VOCABULARY) {
    if (fact.name === 'artifact.<Type>.exists' || fact.name === 'artifact.<Type>.count') {
      const suffix = fact.name.slice('artifact.<Type>.'.length);
      for (const type of ARTIFACT_TYPES) out.push(`artifact.${type}.${suffix}`);
    } else if (fact.name === 'approval.<kind>') {
      for (const kind of GENERIC_APPROVAL_KINDS) out.push(`approval.${kind}`);
    } else {
      out.push(fact.name);
    }
  }
  return out;
}

/** The facts a step's gate may read: the vocabulary's step scope. */
export function stepFacts(): readonly FactDefinition[] {
  return GATE_FACT_VOCABULARY.filter((f) => f.scope === 'step');
}
