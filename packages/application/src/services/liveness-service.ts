import type {
  ApprovalKind, ApprovalRepositoryPort, LivenessVerdict, Mission, MissionRepositoryPort, MissionStatus, MissionTask, Run,
  RunRepositoryPort, TaskRepositoryPort, WatchThresholds,
} from '@tandemise/domain';
import {
  LIVE_RUN_STATUSES, TERMINAL_MISSION_STATUSES, classifyLiveness, isTrialMission, isWaitOverdue, livenessFacts, quietNote, watchLevel, watchThresholds,
} from '@tandemise/domain';
import type { InboxSilentRunView, InboxStalledView, TaskWatchView } from '@tandemise/api-contract';
import type { Clock, Logger, MissionId, RunId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import type { ReadinessService } from './readiness.js';

/** Every status the rule is asked about: a finished mission is never stalled, so it is not read at all. */
const OPEN_MISSION_STATUSES: readonly MissionStatus[] = [
  'DRAFT', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP',
  'RELEASED', 'OBSERVING', 'BLOCKED', 'PAUSED',
];

export interface LivenessDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  /** What a draft still needs before it can be planned (P6); optional for harnesses built before it. */
  readonly readiness?: Pick<ReadinessService, 'counts' | 'evaluate'>;
  /** Whether a planner is running for the mission in this daemon. Resolved per call: planning is composed after this. */
  readonly planning: (missionId: MissionId) => boolean;
  /** Whether a refinement pass is running for the mission (P6). */
  readonly refining: (missionId: MissionId) => boolean;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** Quiet after this long without an agent event (TANDEMISE_QUIET_MS). */
  readonly quietAfterMs: number;
  /** The mission's pull request, opened by its ship step or found by its CI wait (#145); optional for older harnesses. */
  readonly pullRequestOf?: (missionId: MissionId) => string | null;
}

/**
 * Nothing waits silently (P9 spec §1, §2).
 *
 * Gathers rows and hands them to the domain's rule; decides nothing itself.
 * Stalled and silent are derived on every read, so there is no stored state to
 * clear when a mission moves again: the row simply stops being derived.
 *
 * The only memory is which notes were already written ("said once" keys),
 * which a restart may repeat once and nothing else reads.
 */
export class LivenessService {
  readonly #said = new Set<string>();

  constructor(private readonly deps: LivenessDeps) {}

  /** The rule's verdict for one mission, from its rows as they are now. */
  classify(mission: Mission | MissionId): LivenessVerdict {
    const m = typeof mission === 'string' ? this.#requireMission(mission) : mission;
    const cards = this.deps.approvals.list({ missionId: m.id, statuses: ['PENDING'] });
    return this.#classify(m, this.deps.tasks.listByMission(m.id), cards);
  }

  /** One row per stalled mission in the project (the Inbox's `stalled`). */
  stalled(workspaceId: WorkspaceId): readonly InboxStalledView[] {
    // The project's open cards, read once and grouped: this is behind the always-mounted nav badge.
    const cardsByMission = new Map<string, { taskId: string | null; kind: ApprovalKind }[]>();
    for (const card of this.deps.approvals.list({ workspaceId, statuses: ['PENDING'] })) {
      if (card.missionId === null) continue;
      const list = cardsByMission.get(card.missionId) ?? [];
      list.push({ taskId: card.taskId, kind: card.kind });
      cardsByMission.set(card.missionId, list);
    }
    return this.deps.missions.list({ workspaceId, statuses: OPEN_MISSION_STATUSES }).flatMap((mission): InboxStalledView[] => {
      const tasks = this.deps.tasks.listByMission(mission.id);
      const verdict = this.#classify(mission, tasks, cardsByMission.get(mission.id) ?? []);
      if (verdict.kind !== 'stalled' || verdict.action === null) return [];
      // A stuck wait or ship step is about the pull request: the row links it and can end the mission too (#145).
      const cause = verdict.action.taskId === null ? undefined : tasks.find((t) => t.id === verdict.action!.taskId);
      const aboutPr = cause !== undefined && (cause.executor === 'wait' || cause.executor === 'ship');
      const pullRequestUrl = aboutPr ? this.deps.pullRequestOf?.(mission.id) ?? null : null;
      return [{
        missionId: mission.id,
        missionTitle: mission.title,
        missionStatus: mission.status,
        rule: verdict.rule,
        reason: verdict.reason ?? 'Nothing can move this mission.',
        action: verdict.action,
        forIds: mission.createdBy == null ? [] : [mission.createdBy],
        since: mission.updatedAt,
        ...(aboutPr ? { pullRequestUrl, cancellable: true } : {}),
      }];
    });
  }

  /** Runs silent past their threshold and not snoozed (the Inbox's `silentRuns`). */
  silentRuns(workspaceId: WorkspaceId): readonly InboxSilentRunView[] {
    const nowMs = this.deps.clock.epochMs();
    return this.#watched().flatMap(({ run, task, mission }): InboxSilentRunView[] => {
      if (mission.workspaceId !== workspaceId) return [];
      const thresholds = this.#thresholds(task);
      const watch = this.#level(run, thresholds, nowMs);
      if (watch.level !== 'silent' || watch.snoozed) return [];
      return [{
        runId: run.id,
        taskId: task.id,
        taskKey: task.key,
        taskTitle: task.title,
        missionId: mission.id,
        missionTitle: mission.title,
        attempt: run.attempt,
        lastEventAt: run.lastEventAt ?? run.startedAt,
        quietForMs: watch.quietForMs,
        quietAfterMs: thresholds.quietMs,
        silentAfterMs: thresholds.silentMs,
        budgetMs: task.executionPolicy.maxWallTimeMs,
        forIds: mission.createdBy == null ? [] : [mission.createdBy],
      }];
    });
  }

  /** How long a running step's live run has been quiet; null unless it runs. */
  watchOf(task: MissionTask, run: Run | null): TaskWatchView | null {
    if (task.status !== 'RUNNING' || run === null || !LIVE_RUN_STATUSES.includes(run.status)) return null;
    const thresholds = this.#thresholds(task);
    const watch = this.#level(run, thresholds, this.deps.clock.epochMs());
    return {
      level: watch.level,
      lastEventAt: run.lastEventAt ?? run.startedAt,
      quietForMs: watch.quietForMs,
      quietAfterMs: thresholds.quietMs,
      silentAfterMs: thresholds.silentMs,
      snoozedUntil: watch.snoozed ? run.watchSnoozedUntil ?? null : null,
    };
  }

  /**
   * "Keep waiting": the quiet row is hidden until the run has been silent one
   * more silent interval. Any agent event ends it sooner (the repository clears it).
   */
  snooze(runId: RunId): { readonly runId: string; readonly snoozedUntil: string } {
    const run = this.deps.runs.get(runId);
    if (run === undefined) throw TandemiseError.notFound('Run', runId);
    const task = this.deps.tasks.get(run.taskId);
    if (!LIVE_RUN_STATUSES.includes(run.status) || task === undefined || task.status !== 'RUNNING') {
      throw new TandemiseError('PRECONDITION_FAILED', 'This run has already ended, so there is nothing to wait for.', {
        details: { runId, status: run.status },
      });
    }
    const thresholds = this.#thresholds(task);
    const until = new Date(this.deps.clock.epochMs() + thresholds.silentMs).toISOString();
    this.deps.runs.snooze(run.id, until);
    const mission = this.deps.missions.get(run.missionId);
    if (mission !== undefined) {
      this.deps.recorder.note(
        { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, runId: run.id },
        `Kept waiting for '${task.key}'. It is asked about again if it stays quiet until ${until}.`,
      );
    }
    this.deps.recorder.invalidate('tasks', run.missionId);
    return { runId: run.id, snoozedUntil: until };
  }

  /**
   * Once per scheduler pass: a run that turns quiet or silent gets one note on
   * its mission's timeline, and every change of level (a snooze running out
   * included) invalidates the tasks topic, so an open window refreshes without
   * polling - silence produces no events of its own.
   */
  watch(): void {
    try {
      const nowMs = this.deps.clock.epochMs();
      const live = new Set<string>();
      for (const { run, task, mission } of this.#watched()) {
        live.add(run.id);
        const watch = this.#level(run, this.#thresholds(task), nowMs);
        if (watch.level === 'active') continue;
        if (watch.level === 'silent' && watch.snoozed) continue;
        const key = `${run.id}|${watch.level}|${run.watchSnoozedUntil ?? ''}`;
        if (this.#said.has(key)) continue;
        this.#said.add(key);
        const first = `${run.id}|${watch.level}|note`;
        if (!this.#said.has(first)) {
          this.#said.add(first);
          this.deps.recorder.note(
            { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, runId: run.id },
            quietNote(task.key, watch.level, watch.quietForMs),
            watch.level === 'silent' ? 'warn' : 'info',
          );
        }
        this.deps.recorder.invalidate('tasks', mission.id);
      }
      // A wait turning overdue (#145) produces no event of its own either: said once, and the Inbox refreshed.
      for (const task of this.deps.tasks.listByStatus(['AWAITING_EXTERNAL'])) {
        if (!isWaitOverdue(task, nowMs)) continue;
        const mission = this.deps.missions.get(task.missionId);
        if (mission === undefined || TERMINAL_MISSION_STATUSES.includes(mission.status) || isTrialMission(mission)) continue;
        live.add(task.id);
        const key = `${task.id}|overdue|${task.startedAt ?? ''}`;
        if (this.#said.has(key)) continue;
        this.#said.add(key);
        this.deps.recorder.note(
          { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id },
          `'${task.key}' is still waiting: ${(task.statusReason ?? 'it has not ended').replace(/\.$/, '')}. It is in your inbox to open, retry or cancel.`,
          'warn',
        );
        this.deps.recorder.invalidate('tasks', mission.id);
      }
      for (const key of this.#said) if (!live.has(key.split('|')[0] ?? '')) this.#said.delete(key);
    } catch (e) {
      // A courtesy to the person watching; it must never stop the pass that dispatches work.
      this.deps.log.warn('liveness.watch_failed', { error: errorMessage(e) });
    }
  }

  /** `mission.stalled` and `run.silent_minutes` (the longest-quiet live run in the mission). */
  facts(missionId: MissionId): Record<string, number> {
    const mission = this.#requireMission(missionId);
    const nowMs = this.deps.clock.epochMs();
    const quiet = this.#watched()
      .filter((w) => w.mission.id === mission.id)
      .map((w) => this.#level(w.run, this.#thresholds(w.task), nowMs).quietForMs);
    return livenessFacts({ stalled: this.classify(mission).kind === 'stalled', silentMs: quiet.length === 0 ? null : Math.max(...quiet) });
  }

  // ------------------------------------------------------------------ internals

  #classify(mission: Mission, tasks: readonly MissionTask[], cards: readonly { readonly taskId: string | null; readonly kind: ApprovalKind }[]): LivenessVerdict {
    const nowMs = this.deps.clock.epochMs();
    const draft = mission.status === 'DRAFT' && this.deps.readiness !== undefined ? this.#draft(mission.id) : null;
    return classifyLiveness({
      status: mission.status,
      statusReason: mission.statusReason,
      tasks: tasks.map((t) => ({
        id: t.id, key: t.key, title: t.title, status: t.status, statusReason: t.statusReason,
        dependsOn: t.dependsOn, attempts: t.attempts, orderHint: t.orderHint, executor: t.executor,
        overdue: isWaitOverdue(t, nowMs),
      })),
      cards: cards.map((c) => ({ taskId: c.taskId, kind: c.kind })),
      planning: mission.status === 'PLANNING' && this.deps.planning(mission.id),
      refining: mission.status === 'DRAFT' && this.deps.refining(mission.id),
      queued: mission.queuedAt !== null,
      ...(draft === null ? {} : draft),
    });
  }

  #draft(missionId: MissionId): { ready: boolean; readinessLabel: string; toDecide: number } {
    const readiness = this.deps.readiness!.evaluate(missionId);
    return { ready: readiness.ready, readinessLabel: readiness.label, toDecide: readiness.openQuestions + readiness.proposedPending };
  }

  /** Live runs on RUNNING steps of open missions: what the watchdog watches. A step parked on a question waits on the person. */
  #watched(): readonly { run: Run; task: MissionTask; mission: Mission }[] {
    const missions = new Map<string, Mission | undefined>();
    return this.deps.runs.listByStatus(LIVE_RUN_STATUSES).flatMap((run) => {
      const task = this.deps.tasks.get(run.taskId);
      if (task === undefined || task.status !== 'RUNNING') return [];
      if (!missions.has(run.missionId)) missions.set(run.missionId, this.deps.missions.get(run.missionId));
      const mission = missions.get(run.missionId);
      if (mission === undefined || TERMINAL_MISSION_STATUSES.includes(mission.status)) return [];
      // An eval trial's run is watched by its eval run, never raised to a person (P3b).
      if (isTrialMission(mission)) return [];
      return [{ run, task, mission }];
    });
  }

  #thresholds(task: MissionTask): WatchThresholds {
    return watchThresholds(this.deps.quietAfterMs, task.executionPolicy.maxWallTimeMs);
  }

  #level(run: Run, thresholds: WatchThresholds, nowMs: number): ReturnType<typeof watchLevel> {
    return watchLevel({
      lastEventAtMs: Date.parse(run.lastEventAt ?? run.startedAt),
      nowMs,
      thresholds,
      snoozedUntilMs: run.watchSnoozedUntil == null ? null : Date.parse(run.watchSnoozedUntil),
    });
  }

  #requireMission(id: MissionId): Mission {
    const mission = this.deps.missions.get(id);
    if (mission === undefined) throw TandemiseError.notFound('Mission', id);
    return mission;
  }
}
