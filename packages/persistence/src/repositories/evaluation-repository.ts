import { asId, type MissionId, type TaskId } from '@tandemise/shared';
import type {
  CheckOutcome, CheckResult, CriterionResult, Evaluation, EvaluationRepositoryPort, Finding,
} from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { parseJson, toJson } from '../json.js';

interface EvaluationRow {
  id: string;
  mission_id: string;
  task_id: string;
  run_id: string | null;
  evaluator_role_id: string;
  verdict: string;
  summary: string;
  findings: string;
  criteria_coverage: string;
  created_at: string;
}

interface CheckRow {
  id: string;
  mission_id: string;
  task_id: string;
  run_id: string | null;
  name: string;
  outcome: string;
  detail: string;
  command: string | null;
  exit_code: number | null;
  duration_ms: number;
  output_ref: string | null;
  created_at: string;
  tree_sha: string | null;
}

function evaluationToRow(e: Evaluation): EvaluationRow {
  return {
    id: e.id,
    mission_id: e.missionId,
    task_id: e.taskId,
    run_id: e.runId,
    evaluator_role_id: e.evaluatorRoleId,
    verdict: e.verdict,
    summary: e.summary,
    findings: toJson(e.findings),
    criteria_coverage: toJson(e.criteriaCoverage),
    created_at: e.createdAt,
  };
}

function evaluationFromRow(r: EvaluationRow): Evaluation {
  return {
    id: asId<'EvaluationId'>(r.id),
    missionId: asId<'MissionId'>(r.mission_id),
    taskId: asId<'TaskId'>(r.task_id),
    runId: r.run_id === null ? null : asId<'RunId'>(r.run_id),
    evaluatorRoleId: r.evaluator_role_id,
    verdict: r.verdict as Evaluation['verdict'],
    summary: r.summary,
    findings: parseJson<readonly Finding[]>(r.findings, []),
    criteriaCoverage: parseJson<readonly CriterionResult[]>(r.criteria_coverage, []),
    createdAt: r.created_at,
  };
}

function checkToRow(c: CheckResult): CheckRow {
  return {
    id: c.id,
    mission_id: c.missionId,
    task_id: c.taskId,
    run_id: c.runId,
    name: c.name,
    outcome: c.outcome,
    detail: c.detail,
    command: c.command,
    exit_code: c.exitCode,
    duration_ms: c.durationMs,
    output_ref: c.outputRef,
    created_at: c.createdAt,
    tree_sha: c.treeSha ?? null,
  };
}

function checkFromRow(r: CheckRow): CheckResult {
  return {
    id: r.id,
    missionId: asId<'MissionId'>(r.mission_id),
    taskId: asId<'TaskId'>(r.task_id),
    runId: r.run_id === null ? null : asId<'RunId'>(r.run_id),
    name: r.name,
    outcome: r.outcome as CheckOutcome,
    detail: r.detail,
    command: r.command,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    outputRef: r.output_ref,
    createdAt: r.created_at,
    treeSha: r.tree_sha,
  };
}

const EVALUATION_COLUMNS = `id, mission_id, task_id, run_id, evaluator_role_id, verdict,
  summary, findings, criteria_coverage, created_at`;
const CHECK_COLUMNS = `id, mission_id, task_id, run_id, name, outcome, detail, command,
  exit_code, duration_ms, output_ref, created_at, tree_sha`;

/**
 * Both tables are append-only. A check result is a measurement taken at a point
 * in time; re-running the check produces a new row, and the history of a flaky
 * test is exactly what makes it identifiable as flaky.
 */
export class SqliteEvaluationRepository implements EvaluationRepositoryPort {
  readonly #insertEvaluation;
  readonly #selectEvaluations;
  readonly #insertCheck;
  readonly #selectChecks;
  readonly #selectLatestChecksForTask;
  readonly #selectLatestChecks;
  readonly #selectReusable;

  constructor(db: TandemiseDatabase) {
    this.#insertEvaluation = db.handle.prepare<EvaluationRow>(
      `INSERT INTO evaluations (${EVALUATION_COLUMNS}) VALUES (
        :id, :mission_id, :task_id, :run_id, :evaluator_role_id, :verdict,
        :summary, :findings, :criteria_coverage, :created_at)`,
    );
    this.#selectEvaluations = db.handle.prepare<{ taskId: string }, EvaluationRow>(
      `SELECT ${EVALUATION_COLUMNS} FROM evaluations WHERE task_id = :taskId ORDER BY created_at, id`,
    );
    this.#insertCheck = db.handle.prepare<CheckRow>(
      `INSERT INTO check_results (${CHECK_COLUMNS}) VALUES (
        :id, :mission_id, :task_id, :run_id, :name, :outcome, :detail, :command,
        :exit_code, :duration_ms, :output_ref, :created_at, :tree_sha)`,
    );
    this.#selectReusable = db.handle.prepare<{ treeSha: string; name: string; command: string }, CheckRow>(
      `SELECT ${CHECK_COLUMNS} FROM check_results
        WHERE tree_sha = :treeSha AND name = :name AND command = :command AND outcome IN ('PASS','FAIL')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    this.#selectChecks = db.handle.prepare<{ taskId: string }, CheckRow>(
      `SELECT ${CHECK_COLUMNS} FROM check_results WHERE task_id = :taskId ORDER BY created_at, id`,
    );
    // The newest row per check name for ONE task, which is what a task card and
    // its drawer show. A task that retried 14 times has 4 checks, not 56
    // results, and the one a person needs to see is the last one.
    this.#selectLatestChecksForTask = db.handle.prepare<{ taskId: string }, CheckRow>(
      `SELECT ${CHECK_COLUMNS} FROM (
         SELECT ${CHECK_COLUMNS},
                ROW_NUMBER() OVER (PARTITION BY name ORDER BY created_at DESC, id DESC) AS rn
         FROM check_results
         WHERE task_id = :taskId
       )
       WHERE rn = 1
       ORDER BY name`,
    );
    // The newest row per (task, check name). Gates read facts like
    // `checks.typecheck`, and the fact is the *last* measurement, not the first
    // or the best - a window function keeps that to a single pass.
    this.#selectLatestChecks = db.handle.prepare<{ missionId: string }, CheckRow>(
      `SELECT ${CHECK_COLUMNS} FROM (
         SELECT ${CHECK_COLUMNS},
                ROW_NUMBER() OVER (PARTITION BY task_id, name ORDER BY created_at DESC, id DESC) AS rn
         FROM check_results
         WHERE mission_id = :missionId
       )
       WHERE rn = 1
       ORDER BY task_id, name`,
    );
  }

  createEvaluation(evaluation: Evaluation): Evaluation {
    this.#insertEvaluation.run(evaluationToRow(evaluation));
    return evaluation;
  }

  listEvaluations(taskId: TaskId): readonly Evaluation[] {
    return this.#selectEvaluations.all({ taskId }).map(evaluationFromRow);
  }

  recordCheck(check: CheckResult): CheckResult {
    this.#insertCheck.run(checkToRow(check));
    return check;
  }

  listChecks(taskId: TaskId): readonly CheckResult[] {
    return this.#selectChecks.all({ taskId }).map(checkFromRow);
  }

  latestChecksForTask(taskId: TaskId): readonly CheckResult[] {
    return this.#selectLatestChecksForTask.all({ taskId }).map(checkFromRow);
  }

  latestChecks(missionId: MissionId): readonly CheckResult[] {
    return this.#selectLatestChecks.all({ missionId }).map(checkFromRow);
  }

  reusableCheck(treeSha: string, name: string, command: string): CheckResult | undefined {
    const row = this.#selectReusable.get({ treeSha, name, command });
    return row === undefined ? undefined : checkFromRow(row);
  }
}
