import type {
  ArtifactType, CriterionOutcome, CriterionResult, Evaluation, Finding, FindingSeverity,
} from '@tandemise/domain';
import type { Clock, MissionId, RunId, TaskId } from '@tandemise/shared';
import { ids } from '@tandemise/shared';

/**
 * Lifts an evaluator role's artifact into the structured `Evaluation` that
 * gates read (MVP.md §17.1 level 3).
 *
 * This is the step that makes `review.blocking_findings == 0` a *measurement*
 * rather than a claim. The reviewer states its findings in front matter, which
 * the schema already validated; Tandemise counts them. Nothing here trusts the
 * prose, and nothing asks the reviewer whether it thinks the work is done.
 *
 * Front matter arrives as `Record<string, unknown>` because the parser port is
 * deliberately schema-agnostic, so every field is narrowed here rather than
 * cast. A field that is absent or the wrong shape degrades to the conservative
 * reading - an unreadable verdict is `needs_changes`, never `pass`.
 */
export interface EvaluationSource {
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  readonly roleId: string;
  readonly type: ArtifactType;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

export function evaluationFrom(source: EvaluationSource, clock: Clock): Evaluation | null {
  if (source.type === 'ReviewReport') return reviewEvaluation(source, clock);
  if (source.type === 'QAReport') return qaEvaluation(source, clock);
  return null;
}

function reviewEvaluation(source: EvaluationSource, clock: Clock): Evaluation {
  const findings = readArray(source.frontMatter['findings']).map((raw): Finding => {
    const entry = readRecord(raw);
    return {
      severity: readSeverity(entry['severity']),
      title: readString(entry['title']) ?? 'Untitled finding',
      detail: readString(entry['detail']) ?? '',
      location: readString(entry['location']),
      suggestedFix: readString(entry['suggestedFix']),
    };
  });

  return {
    id: ids.evaluation(),
    missionId: source.missionId,
    taskId: source.taskId,
    runId: source.runId,
    evaluatorRoleId: source.roleId,
    verdict: readVerdict(source.frontMatter['verdict']),
    summary: source.summary,
    findings,
    criteriaCoverage: [],
    createdAt: clock.now(),
  };
}

function qaEvaluation(source: EvaluationSource, clock: Clock): Evaluation {
  const criteriaCoverage = readArray(source.frontMatter['results']).map((raw): CriterionResult => {
    const entry = readRecord(raw);
    const criterionId = readString(entry['criterionId']);
    return {
      criterionId: criterionId === null ? null : criterionId.trim(),
      criterion: readString(entry['criterion']) ?? criterionId ?? 'unnamed criterion',
      outcome: readOutcome(entry['outcome']),
      evidence: readString(entry['evidence']) ?? '',
    };
  });

  const declaredDefects = readNonNegativeInteger(source.frontMatter['blockingDefects']);
  const findings = qaFindings(criteriaCoverage, declaredDefects);
  const verdict = declaredDefects > 0
    ? 'fail'
    : criteriaCoverage.some((c) => c.outcome === 'FAIL') ? 'needs_changes' : 'pass';

  return {
    id: ids.evaluation(),
    missionId: source.missionId,
    taskId: source.taskId,
    runId: source.runId,
    evaluatorRoleId: source.roleId,
    verdict,
    summary: source.summary,
    findings,
    criteriaCoverage,
    createdAt: clock.now(),
  };
}

/**
 * `qa.blocking_defects` is counted from findings, so the findings list has to
 * carry exactly as many blocking entries as the report declared. Failed
 * criteria are the natural source; when the report declares more defects than
 * it has failed criteria, the remainder are recorded as unattributed so the
 * count stays honest rather than quietly shrinking.
 */
function qaFindings(criteria: readonly CriterionResult[], declaredDefects: number): readonly Finding[] {
  const failed = criteria.filter((c) => c.outcome === 'FAIL');
  const findings: Finding[] = failed.map((c, index) => ({
    severity: index < declaredDefects ? 'blocking' : 'major',
    title: `Acceptance criterion not met: ${c.criterion}`,
    detail: c.evidence,
    location: null,
    suggestedFix: null,
  }));
  for (let i = failed.length; i < declaredDefects; i++) {
    findings.push({
      severity: 'blocking',
      title: 'Blocking defect reported without a failing acceptance criterion',
      detail: 'The QA report declared more blocking defects than it mapped to criteria. See the report body.',
      location: null,
      suggestedFix: null,
    });
  }
  return findings;
}

// ------------------------------------------------------------------ narrowing

const SEVERITIES: readonly FindingSeverity[] = ['blocking', 'major', 'minor', 'nit'];
const OUTCOMES: readonly CriterionOutcome[] = ['PASS', 'FAIL', 'SKIP'];

function readArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

function readRecord(v: unknown): Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function readSeverity(v: unknown): FindingSeverity {
  return SEVERITIES.find((s) => s === v) ?? 'major';
}

function readOutcome(v: unknown): CriterionOutcome {
  return OUTCOMES.find((o) => o === v) ?? 'SKIP';
}

function readVerdict(v: unknown): Evaluation['verdict'] {
  return v === 'pass' || v === 'fail' || v === 'needs_changes' ? v : 'needs_changes';
}

function readNonNegativeInteger(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}
