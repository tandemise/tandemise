import { evaluateGate, gateDependencies, type GateFacts, type GatePredicates, type GateValue } from '../gate.js';
import { matchGlob } from '../planner/glob.js';
import { maxSensitivity, type Lane, type Sensitivity } from '../planner/types.js';
import type { MergeDecision, MergeFactor } from './types.js';
import { isPolicyError, type MergePolicy, type MergePolicyOrError } from './policy.js';

/**
 * The merge decision (#53 §8.2-§8.3): a pure function of facts the daemon
 * measured from git, GitHub and its own records, and the project's policy.
 * There is no field here an agent's text could fill: no ChangeSet claim, no
 * release notes, no model's rating, no confidence.
 */
export interface MergeFacts {
  readonly changedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
  readonly files: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly binaryFiles: number;
  readonly repos: number;
  /** Areas the change touches, each with the changed paths in it. */
  readonly areas: readonly { readonly name: string; readonly sensitivity: Sensitivity; readonly paths: readonly string[] }[];
  readonly testsTouched: number;
  readonly dependenciesChanged: boolean;
  readonly lockfileOnly: boolean;
  /** Null when the checks produce no coverage report: never satisfies a rule. */
  readonly coverageChangedLines: number | null;
  readonly ci: { readonly state: 'PASS' | 'FAIL' | 'PENDING' | 'NONE'; readonly requiredPresent: boolean | null };
  readonly reviewRequired: boolean | null;
  readonly checksTests: 'PASS' | 'FAIL' | 'SKIP' | 'TIMEOUT' | null;
  readonly review: { readonly blocking: number | null; readonly major: number | null; readonly independent: boolean | null };
  readonly criteria: { readonly unverified: number; readonly implicit: boolean };
  readonly process: {
    readonly lane: Lane; readonly lightenedByPerson: boolean; readonly stepsSkipped: number;
    /** 0 when the mission had no holds; null only when the daemon has no hold store to read (never satisfies a rule). */
    readonly holds: number | null;
    readonly changesRequested: number; readonly escalations: number; readonly gateRetries: number; readonly personCommits: number;
    readonly revertOfAuto: boolean;
    /** A retry changed files the step's earlier attempts had not touched (#117). Absent reads as false. */
    readonly retryOutOfScope?: boolean;
  };
  readonly history: { readonly areaReverts90d: number | null; readonly areaRecentRevert: boolean | null };
}

/** Where every top-level fact comes from. None is an artifact body or PR text. */
export const MERGE_FACT_ORIGINS: Readonly<Record<keyof MergeFacts, 'git' | 'github' | 'daemon' | 'ledger'>> = {
  changedPaths: 'git', deletedPaths: 'git', files: 'git', linesAdded: 'git', linesRemoved: 'git', binaryFiles: 'git',
  repos: 'daemon', areas: 'git', testsTouched: 'git', dependenciesChanged: 'git', lockfileOnly: 'git',
  coverageChangedLines: 'daemon', ci: 'github', reviewRequired: 'github', checksTests: 'daemon', review: 'daemon',
  criteria: 'daemon', process: 'daemon', history: 'ledger',
};

export const AUTO_MERGE_OFF = 'Auto-merge is off for this project.';
export const NO_CI = 'This repository has no CI checks, so Tandemise never merges it on its own.';
export const CI_NOT_GREEN = 'CI is not green on this commit.';
export const REVIEW_REQUIRED = 'This repository requires an approving review, so Tandemise can\'t merge it on its own.';
export const REVIEW_UNKNOWN = 'Tandemise couldn\'t tell whether this repository requires an approving review, so it asks.';
/** Changes to Tandemise's own rules: never merged on its own, whatever the policy says (a PR must not loosen it). */
export const OWN_RULES_GLOBS = ['.tandemise/**', '**/.tandemise/**', 'factory/**'];
export const ownRulesReason = (path: string): string => `Touches ${path} — a change to Tandemise's own rules always asks for a person.`;
export const malformedPolicy = (error: string): string => `The merge policy can't be read (${error}), so every pull request asks.`;

const undef = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
const verdictValue = (v: boolean | null): GateValue => (v === null ? undefined : v ? 'PASS' : 'FAIL');

/** The facts as the gate language reads them, with the two path predicates. */
export function mergeFactsToGate(f: MergeFacts): { facts: GateFacts; predicates: GatePredicates } {
  const facts: Record<string, GateValue> = {
    'change.files': f.files,
    'change.lines_added': f.linesAdded,
    'change.lines_removed': f.linesRemoved,
    'change.repos': f.repos,
    'change.binary_files': f.binaryFiles,
    'change.deleted_files': f.deletedPaths.length,
    'change.tests_touched': f.testsTouched,
    'change.dependencies_changed': f.dependenciesChanged,
    'change.lockfile_only': f.lockfileOnly,
    'change.max_sensitivity': maxSensitivity(f.areas),
    'coverage.changed_lines': undef(f.coverageChangedLines),
    'ci.state': f.ci.state,
    'ci.required_present': undef(f.ci.requiredPresent),
    'github.review_required': undef(f.reviewRequired),
    'checks.tests': undef(f.checksTests),
    'review.blocking_findings': undef(f.review.blocking),
    'review.major_findings': undef(f.review.major),
    'review.independent': verdictValue(f.review.independent),
    'criteria.unverified': f.criteria.unverified,
    'criteria.implicit': f.criteria.implicit,
    'process.lane': f.process.lane,
    'process.lightened_by_person': f.process.lightenedByPerson,
    'process.steps_skipped': f.process.stepsSkipped,
    'process.holds': undef(f.process.holds),
    'process.changes_requested': f.process.changesRequested,
    'process.escalations': f.process.escalations,
    'process.gate_retries': f.process.gateRetries,
    'process.person_commits': f.process.personCommits,
    'process.revert_of_auto': f.process.revertOfAuto,
    'process.retry_out_of_scope': f.process.retryOutOfScope ?? false,
    'history.area_reverts_90d': undef(f.history.areaReverts90d),
    'history.area_recent_revert': undef(f.history.areaRecentRevert),
  };
  const strs = (args: readonly GateValue[]) => args.filter((a): a is string => typeof a === 'string');
  const predicates: GatePredicates = {
    'change.areas_any': (args) => strs(args).some((n) => f.areas.some((a) => a.name.toLowerCase() === n.toLowerCase())),
    'change.paths_matching': (args) => {
      const globs = strs(args);
      return [...f.changedPaths, ...f.deletedPaths].filter((p) => globs.some((g) => matchGlob(g, p))).length;
    },
  };
  return { facts, predicates };
}

/** Facts a rule read that were not measured. */
function unmeasured(rule: string, facts: GateFacts, predicates: GatePredicates): string[] {
  return gateDependencies(rule).filter((d) => (d.endsWith('()') ? predicates[d.slice(0, -2)] === undefined : facts[d] === undefined));
}

/** Words for a `never` or `requires` rule the shipped policy writes; otherwise the rule itself. */
const RULE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^process\.lane == "careful"$/, 'This was careful work, which always asks for a review.'],
  [/^process\.person_commits > 0$/, 'A person committed to this pull request, so they should look at the result.'],
  [/^change\.deleted_files > 0 && change\.max_sensitivity != "none"$/, 'It deletes files in a sensitive area.'],
  [/^checks\.tests != FAIL$/, 'The tests failed on this commit.'],
  [/^checks\.tests == PASS$/, 'The tests did not pass on this commit.'],
  [/^review\.blocking_findings == 0( \|\| review\.blocking_findings == null)?$/, 'The review found blocking problems.'],
  [/^ci\.state == PASS$/, CI_NOT_GREEN],
];

export function ruleWords(rule: string, kind: 'never' | 'requires'): string {
  const found = RULE_WORDS.find(([re]) => re.test(rule.trim()));
  if (found !== undefined) return found[1];
  return kind === 'never' ? `It matches a rule that always asks: ${rule}.` : `A rule it must meet isn't met: ${rule}.`;
}

export function decideMerge(f: MergeFacts, policy: MergePolicyOrError): MergeDecision {
  if (isPolicyError(policy)) {
    return { verdict: 'ask', score: 0, allowed: null, wouldMerge: false, factors: [], reasons: [malformedPolicy(policy.error)] };
  }
  const { facts, predicates } = mergeFactsToGate(f);
  const factors: MergeFactor[] = [];
  const blocking: string[] = [];

  // Hard rules, enforced by code whatever the file says.
  const own = [...f.changedPaths, ...f.deletedPaths].find((p) => OWN_RULES_GLOBS.some((g) => matchGlob(g, p)));
  factors.push({ rule: 'never: Tandemise\'s own rules', kind: 'hard', matched: own !== undefined, points: 0, unmeasured: [], paths: own === undefined ? [] : [own] });
  if (own !== undefined) blocking.push(ownRulesReason(own));
  const ciRule = f.ci.state === 'NONE' ? NO_CI : f.ci.state !== 'PASS' ? CI_NOT_GREEN : null;
  factors.push({ rule: 'ci.state == PASS', kind: 'hard', matched: ciRule !== null, points: 0, unmeasured: [], paths: [] });
  if (ciRule !== null) blocking.push(ciRule);
  const reviewRule = f.reviewRequired === true ? REVIEW_REQUIRED : f.reviewRequired === null ? REVIEW_UNKNOWN : null;
  factors.push({ rule: 'github.review_required == false', kind: 'hard', matched: reviewRule !== null, points: 0, unmeasured: f.reviewRequired === null ? ['github.review_required'] : [], paths: [] });
  if (reviewRule !== null) blocking.push(reviewRule);

  // Never: any match asks, whatever the score. Unmeasured counts as a match.
  const all = [...f.changedPaths, ...f.deletedPaths];
  for (const rule of policy.never) {
    if ('paths' in rule) {
      const hit = all.filter((p) => rule.paths.some((g) => matchGlob(g, p)));
      factors.push({ rule: `never: ${rule.paths.join(', ')}`, kind: 'never', matched: hit.length > 0, points: 0, unmeasured: [], paths: hit });
      if (hit.length > 0) blocking.push(`Touches ${hit[0]} — never merged on its own in this project.`);
    } else if ('areas' in rule) {
      const hit = f.areas.filter((a) => rule.areas.some((n) => n.toLowerCase() === a.name.toLowerCase()));
      const paths = hit.flatMap((a) => a.paths);
      factors.push({ rule: `never: areas ${rule.areas.join(', ')}`, kind: 'never', matched: hit.length > 0, points: 0, unmeasured: [], paths });
      if (hit.length > 0) blocking.push(`Touches ${paths[0] ?? hit[0]!.name} — never merged on its own in this project.`);
    } else {
      const missing = unmeasured(rule.when, facts, predicates);
      const matched = missing.length > 0 || evaluateGate(rule.when, facts, predicates).passed;
      factors.push({ rule: rule.when, kind: 'never', matched, points: 0, unmeasured: missing, paths: [] });
      if (matched) blocking.push(ruleWords(rule.when, 'never'));
    }
  }

  // Requires: every one must hold. A rule may tolerate an unmeasured fact
  // explicitly (`== null`); otherwise unmeasured never passes.
  for (const rule of policy.requires) {
    const passed = evaluateGate(rule, facts, predicates).passed;
    factors.push({ rule, kind: 'requires', matched: !passed, points: 0, unmeasured: unmeasured(rule, facts, predicates), paths: [] });
    if (!passed && rule.trim() !== 'ci.state == PASS') blocking.push(ruleWords(rule, 'requires'));
  }

  // The score: points for every rule that holds; a rule on an unmeasured fact adds nothing and says so.
  let score = 0;
  const whys: string[] = [];
  for (const rule of policy.score) {
    const missing = unmeasured(rule.when, facts, predicates);
    const matched = evaluateGate(rule.when, facts, predicates).passed;
    factors.push({ rule: rule.when, kind: 'score', matched, points: matched ? rule.points : 0, unmeasured: missing, paths: [], why: rule.why });
    if (matched) { score += rule.points; whys.push(rule.why); }
  }
  const allowed = policy.autoMergeAtMost;
  const overScore = score > allowed ? `Risk score ${score} of ${allowed} allowed: ${whys.join(', ')}.` : null;
  const wouldMerge = blocking.length === 0 && overScore === null;
  const on = policy.autoMerge === 'on' || (f.process.revertOfAuto && policy.revertAutoMerge === 'on');
  const reasons = [...(on ? [] : [AUTO_MERGE_OFF]), ...blocking, ...(overScore === null ? [] : [overScore])];
  return { verdict: on && wouldMerge ? 'merge' : 'ask', score, allowed, wouldMerge, factors, reasons: on && wouldMerge ? [] : reasons };
}

/** The policy with auto-merge forced on: what a backtest and "what would have happened" replay. */
export function withAutoMerge(policy: MergePolicy): MergePolicy {
  return { ...policy, autoMerge: 'on' };
}
