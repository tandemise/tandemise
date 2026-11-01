import type {
  MergeDecisionRecord, Mission, MissionRepositoryPort, MissionTask, OutcomeEvent, OutcomeKind, OutcomeRepositoryPort,
  PlanDecisionRepositoryPort, RunScoreRepositoryPort, EventBusPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { isTrialMission, maxSensitivity, stepClassFor } from '@tandemise/domain';
import { ids, type Clock, type Logger, type MissionId, type WorkspaceId } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';

/**
 * Writes outcomes (#53 §9.1): what happened to a step or a change after the
 * fact. Local rows until the brain's ledger takes them (#51, Task 20). Only
 * factory-planned missions have a lane and profile to bucket by; eval trials
 * never write one. Recording never fails the caller.
 */
export interface OutcomeRecorderDeps {
  readonly outcomes: OutcomeRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly runScores?: Pick<RunScoreRepositoryPort, 'listByTask'>;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** Who writes them: this machine's local person, as a ledger writer would be. */
  readonly writer?: () => string;
  /** Also sends each outcome to the brain's ledger when the project has one (#53 Task 20). */
  readonly sink?: (workspaceId: WorkspaceId, event: OutcomeEvent) => void;
  /** Where `task.hold_ended` arrives from, and the task it names. */
  readonly bus?: Pick<EventBusPort, 'subscribe'>;
  readonly tasks?: Pick<TaskRepositoryPort, 'get'>;
}

export class OutcomeRecorder {
  readonly name = 'hold-outcomes';
  #unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: OutcomeRecorderDeps) {}

  /** Listens for holds ending (#50 records \`task.hold_ended\`): each one counts against that step's rung. */
  async start(): Promise<void> {
    if (this.#unsubscribe !== null || this.deps.bus === undefined || this.deps.tasks === undefined) return;
    const tasks = this.deps.tasks;
    this.#unsubscribe = this.deps.bus.subscribe((record) => {
      if ((record.body as { type: string }).type !== 'task.hold_ended' || record.taskId == null) return;
      const task = tasks.get(record.taskId);
      if (task !== undefined) this.held(task);
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** A step's attempt settled: its score as a `step_result`. */
  stepSettled(mission: Mission, task: MissionTask): void {
    if (task.executor !== 'agent' || isTrialMission(mission)) return;
    const scores = this.deps.runScores?.listByTask(task.id) ?? [];
    const score = [...scores].sort((a, b) => (a.scoredAt < b.scoredAt ? -1 : 1)).at(-1);
    this.#write(mission.id, 'step_result', {
      step: {
        class: stepClassFor(task), model: score?.model ?? task.modelPolicy?.model ?? null, attempt: Math.max(1, task.attempts),
        gatePassed: score?.gatePassed ?? task.status === 'SUCCEEDED', costUsd: score?.costUsd ?? null, wallTimeMs: score?.wallTimeMs ?? null, taskKey: task.key,
      },
    });
  }

  /** A hold (#50) ended; counts against the step's rung. */
  held(task: MissionTask): void {
    this.#write(task.missionId, 'held', { step: this.#stepOf(task) });
  }

  changesRequested(task: MissionTask): void {
    this.#write(task.missionId, 'changes_requested', { step: this.#stepOf(task) });
  }

  /**
   * A merge (#174): Tandemise ran it, on its own or on a person's Merge (kept
   * with who approved it and the card), or a person merged it in GitHub.
   */
  merged(decision: MergeDecisionRecord, how: { by: 'tandemise' } | { by: 'approval'; approver: string; approvalId: string | null } | { by: 'person' }): void {
    if (how.by === 'person') { this.#write(decision.missionId, 'merged_by_person', { merge: this.#merge(decision) }); return; }
    const approval = how.by === 'approval' ? { approval: { by: how.approver, ...(how.approvalId === null ? {} : { card: how.approvalId }) } } : {};
    this.#write(decision.missionId, 'merged', { merge: { ...this.#merge(decision), ...approval } });
  }

  reverted(decision: MergeDecisionRecord): void { this.#write(decision.missionId, 'reverted', { merge: this.#merge(decision) }); }
  brokeMain(decision: MergeDecisionRecord): void { this.#write(decision.missionId, 'broke_main', { merge: this.#merge(decision) }); }
  closedUnmerged(decision: MergeDecisionRecord): void { this.#write(decision.missionId, 'closed_unmerged', { merge: this.#merge(decision) }); }
  mergedClean(decision: MergeDecisionRecord): void { this.#write(decision.missionId, 'merged_clean', { merge: this.#merge(decision) }); }

  #stepOf(task: MissionTask): NonNullable<OutcomeEvent['step']> {
    return { class: stepClassFor(task), model: task.modelPolicy?.model ?? null, attempt: Math.max(1, task.attempts), gatePassed: false, costUsd: null, wallTimeMs: null, taskKey: task.key };
  }

  #merge(d: MergeDecisionRecord): NonNullable<OutcomeEvent['merge']> {
    return { verdict: d.verdict, score: d.score, pr: `${d.repo}#${d.prNumber}` };
  }

  #write(missionId: MissionId, kind: OutcomeKind, extra: Pick<OutcomeEvent, 'step' | 'merge'>): void {
    try {
      const mission = this.deps.missions.get(missionId);
      if (mission === undefined || isTrialMission(mission)) return;
      const decision = this.deps.planDecisions.latest(missionId);
      if (decision === undefined) return;
      const p = decision.profile;
      const event: OutcomeEvent = {
        op: 'outcome', id: ids.outcome(), at: this.deps.clock.now(), by: this.deps.writer?.() ?? 'local',
        mission: missionId, lane: decision.lane,
        profile: { type: p.type, size: p.size, risk: p.risk, areas: p.areas.map((a) => a.name), sensitivity: maxSensitivity(p.areas) },
        kind, ...extra,
      };
      this.deps.outcomes.append({ ...event, workspaceId: mission.workspaceId });
      this.deps.sink?.(mission.workspaceId, event);
      this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId }, {
        type: 'task.outcome', outcomeId: event.id, kind, stepClass: event.step?.class ?? null, model: event.step?.model ?? null,
      });
    } catch (e) {
      this.deps.log.warn('outcomes.write_failed', { missionId, kind, error: String(e) });
    }
  }
}
