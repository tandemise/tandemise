import { TandemiseError, asId, type Clock, type MissionId, type TaskId } from '@tandemise/shared';
import type {
  ApprovalPolicy, ArtifactRequirement, ArtifactType, Capability, ExecutionPolicy, MissionTask,
  ModelPolicy, RetryPolicy, SkillPin, StepSkill, TaskRepositoryPort, TaskStatus,
} from '@tandemise/domain';
import { DEFAULT_RETRY_POLICY, NO_APPROVAL } from '@tandemise/domain';
import type { ResolvedStaffingSnapshot, StaffingPatch, TaskExecutor, WaitPolicy } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';
import { fromSqlBool, parseJson, parseJsonOrNull, toJson, toJsonOrNull, toSqlBool } from '../json.js';
import { applyPatch } from '../patch.js';

interface TaskRow {
  id: string;
  mission_id: string;
  key: string;
  title: string;
  objective: string;
  role_id: string;
  required_capabilities: string;
  input_artifacts: string;
  expected_outputs: string;
  execution_policy: string;
  approval_policy: string;
  retry_policy: string;
  completion_gate: string | null;
  status: string;
  status_reason: string | null;
  attempts: number;
  remediates_task_id: string | null;
  repository_id: string | null;
  executor: string | null;
  wait_policy: string | null;
  retry_feedback: string | null;
  model_policy: string | null;
  skills: string | null;
  run_skill: string | null;
  step_class: string | null;
  staffing: string | null;
  staffing_override: string | null;
  assignee_id: string | null;
  responsible_id: string | null;
  needs_attention: number;
  round: number;
  order_hint: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Used only when an execution policy column fails to parse. Every field errs
 * toward refusing work rather than granting it: no isolation implies no
 * worktree to escape into, an empty capability list grants nothing, and a zero
 * wall-time budget stops the run immediately instead of letting a task with an
 * unreadable policy execute unbounded.
 */
const FAIL_CLOSED_EXECUTION: ExecutionPolicy = { isolation: 'none', maxWallTimeMs: 0, capabilities: [] };

function toRow(t: MissionTask): TaskRow {
  return {
    id: t.id,
    mission_id: t.missionId,
    key: t.key,
    title: t.title,
    objective: t.objective,
    role_id: t.roleId,
    required_capabilities: toJson(t.requiredCapabilities),
    input_artifacts: toJson(t.inputArtifacts),
    expected_outputs: toJson(t.expectedOutputs),
    execution_policy: toJson(t.executionPolicy),
    approval_policy: toJson(t.approvalPolicy),
    retry_policy: toJson(t.retryPolicy),
    completion_gate: t.completionGate,
    status: t.status,
    status_reason: t.statusReason,
    attempts: t.attempts,
    remediates_task_id: t.remediatesTaskId,
    repository_id: t.repositoryId,
    // Defaulted on write as well as on read: a task built before this column
    // existed - a fixture, an older caller - is an agent task, and binding null
    // into a NOT NULL column would fail far from the cause.
    executor: t.executor ?? 'agent',
    wait_policy: t.waitPolicy === null || t.waitPolicy === undefined ? null : toJson(t.waitPolicy),
    retry_feedback: t.retryFeedback ?? null,
    model_policy: toJsonOrNull(t.modelPolicy ?? null),
    skills: toJsonOrNull(t.skills ?? null),
    run_skill: toJsonOrNull(t.runSkill ?? null),
    step_class: t.stepClass ?? null,
    staffing: toJsonOrNull(t.staffing),
    staffing_override: toJsonOrNull(t.staffingOverride),
    assignee_id: t.assigneeId ?? null,
    responsible_id: t.responsibleId ?? null,
    needs_attention: toSqlBool(t.needsAttention ?? false),
    // Defaulted on write like `executor`: a task built before round columns
    // existed is round 1, its first and only pass so far.
    round: t.round ?? 1,
    order_hint: t.orderHint,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    started_at: t.startedAt,
    finished_at: t.finishedAt,
  };
}

function fromRow(r: TaskRow, dependsOn: readonly string[]): MissionTask {
  return {
    id: asId<'TaskId'>(r.id),
    missionId: asId<'MissionId'>(r.mission_id),
    key: r.key,
    title: r.title,
    objective: r.objective,
    roleId: r.role_id,
    dependsOn,
    requiredCapabilities: parseJson<readonly Capability[]>(r.required_capabilities, []),
    inputArtifacts: parseJson<readonly ArtifactRequirement[]>(r.input_artifacts, []),
    expectedOutputs: parseJson<readonly ArtifactType[]>(r.expected_outputs, []),
    executionPolicy: parseJson<ExecutionPolicy>(r.execution_policy, FAIL_CLOSED_EXECUTION),
    approvalPolicy: parseJson<ApprovalPolicy>(r.approval_policy, NO_APPROVAL),
    retryPolicy: parseJson<RetryPolicy>(r.retry_policy, DEFAULT_RETRY_POLICY),
    completionGate: r.completion_gate,
    status: r.status as TaskStatus,
    statusReason: r.status_reason,
    attempts: r.attempts,
    remediatesTaskId: r.remediates_task_id === null ? null : asId<'TaskId'>(r.remediates_task_id),
    repositoryId: r.repository_id === null ? null : asId<'RepositoryId'>(r.repository_id),
    executor: (r.executor ?? 'agent') as TaskExecutor,
    waitPolicy: r.wait_policy === null ? null : parseJson<WaitPolicy | null>(r.wait_policy, null),
    retryFeedback: r.retry_feedback,
    modelPolicy: parseJsonOrNull<ModelPolicy>(r.model_policy),
    skills: parseJsonOrNull<SkillPin[]>(r.skills),
    runSkill: parseJsonOrNull<StepSkill>(r.run_skill),
    stepClass: (r.step_class ?? null) as MissionTask['stepClass'],
    staffing: parseJsonOrNull<ResolvedStaffingSnapshot>(r.staffing),
    staffingOverride: parseJsonOrNull<StaffingPatch>(r.staffing_override),
    assigneeId: r.assignee_id,
    responsibleId: r.responsible_id,
    needsAttention: fromSqlBool(r.needs_attention),
    round: r.round,
    orderHint: r.order_hint,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const COLUMNS = `id, mission_id, "key", title, objective, role_id, required_capabilities,
  input_artifacts, expected_outputs, execution_policy, approval_policy, retry_policy,
  completion_gate, status, status_reason, attempts, remediates_task_id, repository_id, executor, wait_policy, retry_feedback, model_policy, skills, run_skill, step_class,
  staffing, staffing_override, assignee_id, responsible_id, needs_attention, round, order_hint,
  created_at, updated_at, started_at, finished_at`;

export class SqliteTaskRepository implements TaskRepositoryPort {
  readonly #db: TandemiseDatabase;
  readonly #clock: Clock;
  readonly #insert;
  readonly #update;
  readonly #selectOne;
  readonly #selectByKey;
  readonly #selectByMission;
  readonly #selectByStatus;
  readonly #deleteObsolete;
  readonly #deleteDeps;
  readonly #insertDep;
  readonly #selectDeps;

  constructor(db: TandemiseDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
    this.#insert = db.handle.prepare<TaskRow>(
      `INSERT INTO mission_tasks (${COLUMNS}) VALUES (
        :id, :mission_id, :key, :title, :objective, :role_id, :required_capabilities,
        :input_artifacts, :expected_outputs, :execution_policy, :approval_policy, :retry_policy,
        :completion_gate, :status, :status_reason, :attempts, :remediates_task_id, :repository_id, :executor, :wait_policy, :retry_feedback, :model_policy, :skills, :run_skill, :step_class,
        :staffing, :staffing_override, :assignee_id, :responsible_id, :needs_attention, :round, :order_hint,
        :created_at, :updated_at, :started_at, :finished_at)`,
    );
    this.#update = db.handle.prepare<TaskRow>(
      `UPDATE mission_tasks SET
         "key" = :key, title = :title, objective = :objective, role_id = :role_id,
         required_capabilities = :required_capabilities, input_artifacts = :input_artifacts,
         expected_outputs = :expected_outputs, execution_policy = :execution_policy,
         approval_policy = :approval_policy, retry_policy = :retry_policy,
         completion_gate = :completion_gate, status = :status, status_reason = :status_reason,
         attempts = :attempts, remediates_task_id = :remediates_task_id,
         repository_id = :repository_id, executor = :executor, wait_policy = :wait_policy, retry_feedback = :retry_feedback, model_policy = :model_policy, skills = :skills, run_skill = :run_skill, step_class = :step_class,
         staffing = :staffing, staffing_override = :staffing_override, assignee_id = :assignee_id,
         responsible_id = :responsible_id, needs_attention = :needs_attention,
         round = :round, order_hint = :order_hint,
         updated_at = :updated_at, started_at = :started_at, finished_at = :finished_at
       WHERE id = :id`,
    );
    this.#selectOne = db.handle.prepare<{ id: string }, TaskRow>(
      `SELECT ${COLUMNS} FROM mission_tasks WHERE id = :id`,
    );
    this.#selectByKey = db.handle.prepare<{ missionId: string; key: string }, TaskRow>(
      `SELECT ${COLUMNS} FROM mission_tasks WHERE mission_id = :missionId AND "key" = :key`,
    );
    this.#selectByMission = db.handle.prepare<{ missionId: string }, TaskRow>(
      `SELECT ${COLUMNS} FROM mission_tasks WHERE mission_id = :missionId ORDER BY order_hint, created_at, id`,
    );
    this.#selectByStatus = db.handle.prepare<{ statuses: string }, TaskRow>(
      `SELECT ${COLUMNS} FROM mission_tasks
       WHERE status IN (SELECT value FROM json_each(:statuses))
       ORDER BY order_hint, created_at, id`,
    );
    this.#deleteObsolete = db.handle.prepare<{ missionId: string; keepIds: string }>(
      `DELETE FROM mission_tasks
       WHERE mission_id = :missionId AND id NOT IN (SELECT value FROM json_each(:keepIds))`,
    );
    this.#deleteDeps = db.handle.prepare<{ taskId: string }>(
      'DELETE FROM task_dependencies WHERE task_id = :taskId',
    );
    this.#insertDep = db.handle.prepare<{ taskId: string; key: string; ordinal: number }>(
      'INSERT INTO task_dependencies (task_id, depends_on_key, ordinal) VALUES (:taskId, :key, :ordinal)',
    );
    this.#selectDeps = db.handle.prepare<{ ids: string }, { task_id: string; depends_on_key: string }>(
      `SELECT task_id, depends_on_key FROM task_dependencies
       WHERE task_id IN (SELECT value FROM json_each(:ids))
       ORDER BY task_id, ordinal`,
    );
  }

  /**
   * Re-plans a mission's task list.
   *
   * Tasks the new plan keeps (same id) are updated in place rather than deleted
   * and re-inserted: a task row owns its runs, assignments and check results by
   * foreign key, and delete-then-insert would cascade that history away even
   * though the task survived the replan.
   */
  replaceAll(missionId: MissionId, tasks: readonly MissionTask[]): readonly MissionTask[] {
    return this.#db.transaction(() => {
      this.#deleteObsolete.run({ missionId, keepIds: toJson(tasks.map((t) => t.id)) });
      return tasks.map((task) => this.#write(task, this.#selectOne.get({ id: task.id }) !== undefined));
    });
  }

  add(task: MissionTask): MissionTask {
    return this.#db.transaction(() => this.#write(task, false));
  }

  get(id: TaskId): MissionTask | undefined {
    const row = this.#selectOne.get({ id });
    return row ? fromRow(row, this.#depsFor([row.id]).get(row.id) ?? []) : undefined;
  }

  getByKey(missionId: MissionId, key: string): MissionTask | undefined {
    const row = this.#selectByKey.get({ missionId, key });
    return row ? fromRow(row, this.#depsFor([row.id]).get(row.id) ?? []) : undefined;
  }

  listByMission(missionId: MissionId): readonly MissionTask[] {
    return this.#hydrate(this.#selectByMission.all({ missionId }));
  }

  listByStatus(statuses: readonly TaskStatus[]): readonly MissionTask[] {
    if (statuses.length === 0) return [];
    return this.#hydrate(this.#selectByStatus.all({ statuses: toJson(statuses) }));
  }

  update(
    id: TaskId,
    patch: Partial<Omit<MissionTask, 'id' | 'missionId' | 'createdAt'>>,
  ): MissionTask {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw TandemiseError.notFound('Task', id);
      const next: MissionTask = { ...applyPatch(current, patch), updatedAt: this.#clock.now() };
      return this.#write(next, true);
    });
  }

  /** Writes the row and its dependency edges. Caller owns the transaction. */
  #write(task: MissionTask, exists: boolean): MissionTask {
    const row = toRow(task);
    if (exists) this.#update.run(row);
    else this.#insert.run(row);

    this.#deleteDeps.run({ taskId: task.id });
    // A plan may repeat a dependency; the edge table is a set, so collapse
    // duplicates here rather than letting the primary key reject the whole write.
    const unique = [...new Set(task.dependsOn)];
    unique.forEach((key, ordinal) => this.#insertDep.run({ taskId: task.id, key, ordinal }));
    return { ...task, dependsOn: unique };
  }

  #hydrate(rows: readonly TaskRow[]): readonly MissionTask[] {
    if (rows.length === 0) return [];
    const deps = this.#depsFor(rows.map((r) => r.id));
    return rows.map((r) => fromRow(r, deps.get(r.id) ?? []));
  }

  /** One query for the whole page of tasks, never one per task. */
  #depsFor(ids: readonly string[]): Map<string, string[]> {
    const byTask = new Map<string, string[]>();
    for (const edge of this.#selectDeps.all({ ids: toJson(ids) })) {
      const list = byTask.get(edge.task_id);
      if (list) list.push(edge.depends_on_key);
      else byTask.set(edge.task_id, [edge.depends_on_key]);
    }
    return byTask;
  }
}
