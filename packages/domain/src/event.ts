import type {
  ApprovalId, ArtifactId, EventId, MemberId, MissionId, RunId, TaskHoldId, TaskId, Timestamp, WorkspaceId,
} from '@tandemise/shared';
import type { FeedbackStatus } from './entities/feedback.js';
import type { ArtifactType } from './entities/artifact.js';
import type { TaskStatus } from './entities/task.js';
import type { HoldEnding, HoldDiffStat } from './entities/hold.js';

/**
 * The canonical event vocabulary (MVP.md §10.4).
 *
 * Every runtime adapter normalizes into this shape, which is what lets one
 * mission timeline show Claude Code and any other worker side by side. Adapters
 * translate; they never extend this union - a new event kind is a deliberate
 * change to the organization's vocabulary, not an adapter detail.
 */
export type AgentEvent =
  | { readonly type: 'message'; readonly text: string }
  | { readonly type: 'thinking_summary'; readonly text: string }
  | { readonly type: 'tool.started'; readonly tool: string; readonly inputSummary: string }
  | { readonly type: 'tool.completed'; readonly tool: string; readonly outcome: 'ok' | 'error'; readonly outputSummary?: string }
  | { readonly type: 'file.changed'; readonly path: string; readonly change: 'add' | 'edit' | 'delete' }
  | { readonly type: 'artifact.created'; readonly artifactId: ArtifactId }
  | { readonly type: 'approval.requested'; readonly approvalId: ApprovalId }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly costUsd?: number | null; readonly wallTimeMs?: number }
  | { readonly type: 'checkpoint'; readonly externalSessionId?: string; readonly label?: string }
  | { readonly type: 'completed'; readonly resultRef?: string; readonly summary?: string }
  | { readonly type: 'failed'; readonly code: string; readonly message: string; readonly retryable: boolean }
  /** Adapter could not classify the line; kept for the raw log view only. */
  | { readonly type: 'raw'; readonly channel: 'stdout' | 'stderr'; readonly text: string };

export type AgentEventType = AgentEvent['type'];

/**
 * Orchestration events the daemon itself emits. They share the timeline with
 * agent events so the user sees one causal story rather than two.
 */
export type OrchestrationEvent =
  | { readonly type: 'mission.status'; readonly from: string; readonly to: string; readonly reason?: string }
  | { readonly type: 'task.status'; readonly from: string; readonly to: string; readonly reason?: string }
  | { readonly type: 'run.started'; readonly attempt: number; readonly runtime: string; readonly target: string }
  | { readonly type: 'run.finished'; readonly status: string; readonly durationMs: number }
  | { readonly type: 'check.result'; readonly name: string; readonly outcome: 'PASS' | 'FAIL' | 'SKIP' | 'TIMEOUT'; readonly detail?: string }
  | { readonly type: 'gate.evaluated'; readonly gate: string; readonly passed: boolean; readonly detail?: string }
  | { readonly type: 'approval.resolved'; readonly approvalId: ApprovalId; readonly status: string; readonly option?: string }
  | { readonly type: 'policy.denied'; readonly capability: string; readonly reason: string }
  /** An unanswered approval was also sent to the next person up; `to` is who was added. */
  | { readonly type: 'approval.escalated'; readonly approvalId: ApprovalId; readonly to: readonly string[]; readonly level: number }
  /**
   * A review was not needed: its `when` did not hold (with the facts it read), or - with `reason` - the only
   * person who could give it did the work. `when` is `sign-off` for a lead's skipped sign-off.
   */
  | { readonly type: 'review.skipped'; readonly taskId: TaskId; readonly when: string; readonly facts: Readonly<Record<string, unknown>>; readonly reason?: string }
  /** A review's `when` read a fact nobody measured, so the review was kept rather than skipped. */
  | { readonly type: 'review.required'; readonly taskId: TaskId; readonly when: string; readonly missingFacts: readonly string[] }
  /**
   * Finished work stands out: someone looked at it and said it needs changes, or
   * (`kind: 'stale_input'`) it was kept on a version of `upstream` that a later
   * round replaced. Absent `kind` is the first case, as every older event is.
   */
  | {
    readonly type: 'task.attention'; readonly taskId: TaskId; readonly note: string;
    readonly kind?: 'stale_input';
    /** The title of the task whose newer version is out; set with `kind`. */
    readonly upstream?: string;
  }
  /**
   * A passed round's artifacts ran over their word budgets, so the author is asked once to tighten them.
   * `attempt` is the task's counted attempt the pass belongs to: it is what keeps a restart from asking twice.
   */
  | { readonly type: 'artifact.tighten_requested'; readonly types: readonly string[]; readonly attempt: number; readonly filesChanged?: number }
  /**
   * An artifact was accepted over its word budget, after its tighten pass. Length never blocks a mission.
   * The artifact's type is `artifactType` because `type` is the event's own discriminant.
   */
  | { readonly type: 'artifact.over_budget'; readonly artifactId: ArtifactId; readonly artifactType: string; readonly words: number; readonly budget: number }
  /** A person or an AI reviewer left a note on a task's output. */
  | { readonly type: 'feedback.given'; readonly feedbackId: string; readonly status: FeedbackStatus; readonly excerpt: string }
  /** A round's handoff cited the note, accepting or declining the change. */
  | { readonly type: 'feedback.addressed'; readonly feedbackId: string; readonly round: number; readonly declined: boolean }
  /** A note was withdrawn or superseded without a round addressing it. */
  | { readonly type: 'feedback.dismissed'; readonly feedbackId: string }
  /** The brain learned a lesson from a person's correction (#51 spec §11): one line on the mission feed. */
  | { readonly type: 'brain.learned'; readonly entryId: string; readonly text: string; readonly signal: 'hold' | 'rejection' | 'gate' | 'person' | 'agent' }
  /** The task's next round began, carrying the feedback it is meant to address. */
  | { readonly type: 'task.round_started'; readonly round: number; readonly feedbackIds: readonly string[]; readonly downstream: 'redo' | 'keep' | 'none'; readonly redone: readonly string[] }
  /**
   * A queued draft was taken from the backlog into planning (P7): `position` in
   * the queue when it was pulled, the project's `limit`, `active` missions in
   * progress counting it, and `skipped` queued ones ahead of it that were not ready.
   */
  | { readonly type: 'mission.pulled'; readonly position: number; readonly limit: number; readonly active: number; readonly skipped?: number }
  /** "Continue elsewhere": an agent task was parked to work in another tool (spec A4). */
  | { readonly type: 'task.parked_external'; readonly tool: string }
  /** "Take it back": a parked task's park was called off and the agent runs it again; the tool it had been continued in. */
  | { readonly type: 'task.unparked'; readonly tool: string }
  /** A parked task's hand-back landed as a human-authored round; which outputs, and whether the contribution was a file or a link. */
  | { readonly type: 'task.handed_back'; readonly artifactIds: readonly ArtifactId[]; readonly round: number; readonly contribution: 'file' | 'link' }
  /** A person took the keyboard on an agent step: the task is HELD from `fromStatus`, in the agent's own session. */
  | { readonly type: 'task.held'; readonly holdId: TaskHoldId; readonly fromStatus: TaskStatus; readonly heldBy: MemberId; readonly sessionBefore: string | null }
  /** A hold ended: continued (the agent picks the work up again) or released; `diffStat` is what changed while held. */
  | {
    readonly type: 'task.hold_ended'; readonly holdId: TaskHoldId; readonly ending: HoldEnding; readonly endedBy: MemberId | null;
    readonly sessionAfter: string | null; readonly durationMs: number; readonly diffStat: HoldDiffStat | null;
  }
  /** Mission intake (spec A2) ran once over the mission's pinned uploads: what it produced and what it could not convert. */
  | {
    readonly type: 'mission.intake_completed'; readonly uploads: number;
    readonly produced: readonly { readonly artifactId: ArtifactId; readonly type: ArtifactType }[];
    readonly failed: readonly { readonly evidenceId: ArtifactId; readonly reason: string }[];
  }
  /** The factory planned the mission (#53 §5.5): its lane, workflow, the modules it applied and the files' refs. */
  | { readonly type: 'plan.decided'; readonly lane: string; readonly workflowId: string; readonly modules: readonly string[]; readonly policyRef: string }
  /** The ship step opened (or found) the pull request (#53 §8.1). */
  | {
    readonly type: 'ship.pr_opened'; readonly repo: string; readonly number: number; readonly url: string; readonly headSha: string;
    /** Set when a step opened it and the mission's CI wait found it (#143): the ship step decides on it rather than opening its own. */
    readonly foundBy?: 'wait';
  }
  /** An outcome was recorded for routing and learning (#53 §9.1). */
  | { readonly type: 'task.outcome'; readonly outcomeId: string; readonly kind: string; readonly stepClass: string | null; readonly model: string | null }
  /** The merge decision for one head commit (#53 §8.6). */
  | { readonly type: 'merge.decided'; readonly decisionId: string; readonly verdict: 'merge' | 'ask'; readonly score: number; readonly repo: string; readonly number: number; readonly headSha: string }
  | { readonly type: 'merge.merged'; readonly decisionId: string; readonly mergeSha: string; readonly by: string }
  | { readonly type: 'merge.asked'; readonly decisionId: string; readonly reasons: readonly string[] }
  | { readonly type: 'merge.reverted'; readonly decisionId: string; readonly revertPr: string | null; readonly by: string }
  | { readonly type: 'note'; readonly text: string; readonly level?: 'info' | 'warn' | 'error' };

export type TandemiseEventBody = AgentEvent | OrchestrationEvent;

/**
 * A persisted event. The append-only log exists for run reconstruction,
 * streaming, debugging and recovery - not as a general event-sourcing substrate
 * (MVP.md §20.3).
 */
export interface RunEventRecord {
  readonly id: EventId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly taskId: TaskId | null;
  readonly runId: RunId | null;
  readonly sequence: number;
  readonly roleId: string | null;
  readonly runtimeProfileId: string | null;
  readonly body: TandemiseEventBody;
  readonly createdAt: Timestamp;
  /** Who caused the event: a member id or a system actor. Null for older events. */
  readonly actorId?: string | null;
}

/**
 * Event types shown in the semantic timeline by default. Everything else is
 * available behind the raw log view (MVP.md §23.3) - the default surface should
 * read like a status report, not a terminal.
 */
export const SEMANTIC_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message', 'file.changed', 'artifact.created', 'approval.requested', 'completed',
  'failed', 'mission.status', 'task.status', 'run.started', 'run.finished',
  'check.result', 'gate.evaluated', 'approval.resolved', 'policy.denied', 'note',
  'tool.started', 'approval.escalated', 'review.skipped', 'review.required', 'task.attention',
  'artifact.tighten_requested', 'artifact.over_budget',
  'feedback.given', 'feedback.addressed', 'feedback.dismissed', 'task.round_started', 'mission.pulled',
  'task.parked_external', 'task.unparked', 'task.handed_back', 'mission.intake_completed',
  'plan.decided', 'ship.pr_opened', 'task.outcome', 'merge.decided', 'merge.merged', 'merge.asked', 'merge.reverted',
  'task.held', 'task.hold_ended',
  'brain.learned',
]);

export function isSemanticEvent(body: TandemiseEventBody): boolean {
  return SEMANTIC_EVENT_TYPES.has(body.type);
}
