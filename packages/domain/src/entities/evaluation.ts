import type { EvaluationId, MissionId, RunId, TaskId, Timestamp } from '@tandemise/shared';

/**
 * `TIMEOUT` is its own outcome (#111): a check that ran out of its time budget
 * measured nothing about the work. Reading it as FAIL sent the agent back to
 * re-do work that may have been fine, and the next run timed out the same way;
 * the engine asks a person about a timeout instead of retrying the agent.
 */
export const CHECK_OUTCOMES = ['PASS', 'FAIL', 'SKIP', 'TIMEOUT'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];
/** What QA reports per Done-when line: a person's verdict, which cannot time out. */
export type CriterionOutcome = Exclude<CheckOutcome, 'TIMEOUT'>;

/**
 * A deterministic check result (MVP.md §17.1 level 1). These are measurements,
 * not opinions - `tests.pass` means a test command exited zero on this machine,
 * which is why gates are allowed to depend on them.
 */
export interface CheckResult {
  readonly id: string;
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  /** Dotted fact name the gate language reads, e.g. `checks.typecheck`. */
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly outputRef: string | null;
  readonly createdAt: Timestamp;
  /**
   * The git tree the check measured (#106), so a later step measuring the same
   * tree reuses this result instead of running the command again. Absent or
   * null when it ran outside a git tree; such a result is never reused.
   */
  readonly treeSha?: string | null;
}

/** Structured output of an evaluator role (MVP.md §17.1 level 3). */
export interface Evaluation {
  readonly id: EvaluationId;
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  readonly evaluatorRoleId: string;
  readonly verdict: 'pass' | 'fail' | 'needs_changes';
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly criteriaCoverage: readonly CriterionResult[];
  readonly createdAt: Timestamp;
}

export const FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface Finding {
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly location: string | null;
  readonly suggestedFix: string | null;
}

/** Maps one acceptance criterion to the evidence that it holds. */
export interface CriterionResult {
  /**
   * The ledger key QA verified (`AC1`, `U2`). Absent on results recorded
   * before the ledger existed; `resultKey` falls back to `criterion` for them.
   */
  readonly criterionId?: string | null;
  readonly criterion: string;
  readonly outcome: CriterionOutcome;
  readonly evidence: string;
}

export function blockingFindings(evaluation: Evaluation): readonly Finding[] {
  return evaluation.findings.filter((f) => f.severity === 'blocking');
}

/**
 * The percentage of acceptance criteria that were verified and passed.
 *
 * The denominator is EVERY criterion, not only the scored ones. Dividing by the
 * scored subset turns this into a pass-rate, and `ready_to_ship` reads it as
 * coverage: a QAReport with one PASS and nine SKIPs would report 100 and ship
 * with nine criteria never tested. A criterion QA could not verify has not been
 * met - it is unmeasured, and MVP.md §17.3 is explicit that unmeasured must
 * never read as passing.
 */
export function criteriaCoveragePercent(results: readonly CriterionResult[]): number {
  if (results.length === 0) return 0;
  const passed = results.filter((r) => r.outcome === 'PASS').length;
  return Math.round((passed / results.length) * 100);
}

/** Criteria QA was unable to verify. Surfaced so a gate failure can name them. */
export function unverifiedCriteria(results: readonly CriterionResult[]): readonly CriterionResult[] {
  return results.filter((r) => r.outcome === 'SKIP');
}
