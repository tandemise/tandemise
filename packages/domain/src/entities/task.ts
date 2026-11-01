import type { MissionId, RepositoryId, TaskId, Timestamp } from '@tandemise/shared';
import type { Capability } from '../capability.js';
import type { ArtifactType } from './artifact.js';
import type { GateExpression } from '../gate.js';
import type { ResolvedStaffingSnapshot, StaffingPatch } from '../staffing.js';
import type { ModelPolicy } from './models.js';
import type { SkillPin, StepSkill } from './skill.js';
import type { StepClass } from '../planner/types.js';

/** Who carries a task out (MVP.md §11). */
export const TASK_EXECUTORS = ['agent', 'human', 'wait', 'ship'] as const;
export type TaskExecutor = (typeof TASK_EXECUTORS)[number];

/** Whether a runtime carries the task out: not a person, a wait or the daemon's ship step (#53). */
export function isAgentExecutor(e: TaskExecutor): boolean {
  return e === 'agent';
}

export const TASK_STATUSES = [
  'PENDING',       // dependencies not yet satisfied
  'READY',         // eligible to be scheduled
  'RUNNING',
  'AWAITING_INPUT',    // running, but blocked on a question it asked a human
  'AWAITING_HUMAN',    // a person has to do this one
  'AWAITING_EXTERNAL', // polling something outside this machine
  'AWAITING_APPROVAL',
  'HELD',          // a person took the keyboard; the agent is not running
  'BLOCKED',       // needs human intervention or an unmet gate
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] =
  ['READY', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_HUMAN', 'AWAITING_EXTERNAL', 'AWAITING_APPROVAL', 'HELD'];

/**
 * Statuses where the task is parked on something that is not this machine's to
 * hurry: a person, or the outside world.
 *
 * The scheduler excludes these from the concurrency ceiling. A worker blocked
 * on a question consumes no CPU, and counting it would let one unanswered
 * question stall every other task in the mission - which is the opposite of
 * what asking is for.
 */
export const PARKED_TASK_STATUSES: readonly TaskStatus[] =
  ['AWAITING_INPUT', 'AWAITING_HUMAN', 'AWAITING_EXTERNAL', 'AWAITING_APPROVAL', 'HELD'];

export function isTaskParked(s: TaskStatus): boolean {
  return PARKED_TASK_STATUSES.includes(s);
}
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'];

export function isTaskFinished(s: TaskStatus): boolean {
  return FINISHED_TASK_STATUSES.includes(s);
}

/** Where a task's work must happen (MVP.md §11). */
/**
 * What a `wait` step watches.
 *
 * A shell command rather than a typed integration on purpose: the thing being
 * waited for is different every time - `gh pr checks`, a curl against a health
 * endpoint, a vendor CLI - and any list this repository shipped would be the
 * wrong list for someone. Exit code 0 means the wait is over.
 */
export interface WaitPolicy {
  /** Run in the task's repository. Exit 0 ends the wait. */
  readonly command: string;
  readonly everyMs: number;
  /** Give up and fail the task after this long. */
  readonly timeoutMs: number;
}

export const DEFAULT_WAIT_EVERY_MS = 30_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 1_800_000;

export const ISOLATION_MODES = ['none', 'worktree', 'docker', 'browser'] as const;
export type IsolationMode = (typeof ISOLATION_MODES)[number];

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  /** After exhausting attempts: block for a human, or fail the task outright. */
  readonly onExhausted: 'block' | 'fail';
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, backoffMs: 5_000, onExhausted: 'block' };

export interface ExecutionPolicy {
  readonly isolation: IsolationMode;
  readonly maxWallTimeMs: number;
  /** Capabilities the worker may use. Enforced as grants, not suggestions. */
  readonly capabilities: readonly Capability[];
}

export interface ApprovalPolicy {
  /** Approval demanded before the task starts (e.g. a release action). */
  readonly beforeStart: boolean;
  /** Approval demanded for the task's outputs before dependents may run. */
  readonly onCompletion: boolean;
  readonly reason?: string;
}

export const NO_APPROVAL: ApprovalPolicy = { beforeStart: false, onCompletion: false };

export interface ArtifactRequirement {
  readonly type: ArtifactType;
  /** When false the task runs even if no artifact of this type exists. */
  readonly required: boolean;
}

export interface MissionTask {
  readonly id: TaskId;
  readonly missionId: MissionId;
  /**
   * The repository this task works in, or null for the mission's own.
   *
   * A project is frequently several repositories that ship together, and one
   * change lands in more than one of them. Letting a task name its repository
   * is what keeps that a single mission with a single dependency graph, rather
   * than separate missions that cannot wait on each other.
   */
  readonly repositoryId: RepositoryId | null;
  /** `human` and `wait` tasks are never dispatched to a runtime. */
  readonly executor: TaskExecutor;
  /** Set only for a `wait` task: what it polls, and for how long. */
  readonly waitPolicy: WaitPolicy | null;
  /** Stable, plan-author-supplied key (`implement_onboarding`). Unique per mission. */
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly roleId: string;
  readonly dependsOn: readonly string[];
  readonly requiredCapabilities: readonly Capability[];
  readonly inputArtifacts: readonly ArtifactRequirement[];
  readonly expectedOutputs: readonly ArtifactType[];
  readonly executionPolicy: ExecutionPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly retryPolicy: RetryPolicy;
  readonly completionGate: GateExpression | null;
  /** What the step is for (#53 §5); null or absent: derived from its role (`stepClassFor`). */
  readonly stepClass?: StepClass | null;
  /** The workflow step's model settings (P12); null or absent when it has none. */
  readonly modelPolicy?: ModelPolicy | null;
  /**
   * The skills this task's runs get (P13), resolved when the task was created
   * (`latest` made concrete). Null or absent: not resolved yet - a task the
   * engine added later resolves its role's pins on its first run.
   */
  readonly skills?: readonly SkillPin[] | null;
  /** The team's skill this step runs instead of its role's prompt (#131); null or absent: the role's prompt. */
  readonly runSkill?: StepSkill | null;
  readonly status: TaskStatus;
  /** What a person reads about the task's current state. Changes whenever it waits. */
  readonly statusReason: string | null;
  /**
   * What the next attempt is told about the last one - a failed gate's
   * measurement. Separate from `statusReason` because it must survive every
   * wait between the failure and the retry. Optional: a freshly planned task
   * has none, and every builder of a task need not say so.
   */
  readonly retryFeedback?: string | null;
  /**
   * Who was resolved to do and answer for this task when it was dispatched,
   * kept so the answer does not change if the team does. Null until then.
   */
  readonly staffing?: ResolvedStaffingSnapshot | null;
  /** A task-level staffing patch, layered over the mission's and workspace's. */
  readonly staffingOverride?: StaffingPatch | null;
  /** The member doing the work: an agent, or a person who claimed it. */
  readonly assigneeId?: string | null;
  /** The person who answers for the work. Always a person member once set. */
  readonly responsibleId?: string | null;
  /** Set when an after-the-fact check asked for changes on finished work. */
  readonly needsAttention?: boolean;
  /**
   * Which pass through the task this is. Round 1 is the first passed attempt;
   * feedback and tightening happen inside a round and never start a new one.
   * Optional so builders written before P2 still compile; read back as 1.
   */
  readonly round?: number;
  readonly attempts: number;
  /** Present when this task was generated to fix findings from another task. */
  readonly remediatesTaskId: TaskId | null;
  readonly orderHint: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly finishedAt: Timestamp | null;
}
