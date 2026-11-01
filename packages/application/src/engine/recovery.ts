import type {
  Approval, ApprovalRepositoryPort, MissionTask,
  ExecutionTargetRepositoryPort, LeaseRepositoryPort, MissionRepositoryPort, Run,
  RunRepositoryPort, RunStatus, RuntimeProfileRepositoryPort, TaskHoldRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { isTrialMission } from '@tandemise/domain';
import type { RuntimeRegistry } from '@tandemise/runtimes-core';
import { asId, type Clock, type Logger, type MissionId, type RunId } from '@tandemise/shared';
import type { ProcessLivenessPort } from '../ports.js';
import type { EventRecorder } from '../support/event-recorder.js';
import { withdrawApproval } from '../support/withdraw.js';
import { heldWaitingReason } from '../support/held.js';

export interface RecoveryReport {
  readonly adopted: readonly string[];
  readonly resumable: readonly string[];
  readonly interrupted: readonly string[];
  readonly tasksRequeued: number;
  readonly leasesReleased: number;
  readonly targetsFailed: number;
  readonly missionsTouched: readonly MissionId[];
}

/**
 * Startup recovery (MVP.md §21.2, APPLICATION_DESIGN.md §Recovery).
 *
 * The daemon is a supervisor of other people's processes, so "what was running
 * when I died?" is a question it must answer before it does anything else.
 * `SchedulerService.start()` must not be reached until this has run: dispatching
 * into a world where a previous worker is still alive is how two agents end up
 * writing the same worktree.
 *
 * Migrations and the single-instance lock (steps 1 and 2 of the design) are the
 * composition root's, not this class's - they have to happen before the
 * database is even opened, which is before anything here can be constructed.
 *
 * The rule throughout is *verify before acting*. A lease is released only after
 * its holder is confirmed dead; a run is marked INTERRUPTED only after its pid
 * is confirmed gone. Guessing in the other direction restarts work that is
 * still running.
 */
export class RecoveryService {
  constructor(
    private readonly missions: MissionRepositoryPort,
    private readonly tasks: TaskRepositoryPort,
    private readonly runs: RunRepositoryPort,
    private readonly targets: ExecutionTargetRepositoryPort,
    private readonly leases: LeaseRepositoryPort,
    private readonly runtimeProfiles: RuntimeProfileRepositoryPort,
    private readonly registry: RuntimeRegistry,
    private readonly liveness: ProcessLivenessPort,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
    private readonly log: Logger,
    /** Questions a dead run was waiting on, so they can be withdrawn. */
    private readonly approvals: ApprovalRepositoryPort,
    /** Open holds, whose terminals died with the last daemon. */
    private readonly holds: TaskHoldRepositoryPort,
  ) {}

  /** An eval trial's mission, whose tasks the eval runner recovers, not this (P3b). */
  #isTrial(missionId: MissionId): boolean {
    const mission = this.missions.get(missionId);
    return mission !== undefined && isTrialMission(mission);
  }

  /**
   * Asynchronous although every step is a synchronous repository call: the
   * daemon awaits this before the scheduler starts, and a future step that has
   * to touch the filesystem (verifying a worktree still exists, say) must not
   * force that call site to change.
   */
  async run(): Promise<RecoveryReport> {
    const adopted: string[] = [];
    const resumable: string[] = [];
    const interrupted: string[] = [];
    const touched = new Set<MissionId>();
    let tasksRequeued = 0;

    for (const run of this.runs.listByStatus(['STARTING', 'RUNNING'])) {
      if (run.pid !== null && this.liveness.isAlive(run.pid)) {
        // Still running under a pid we recorded. Leave it: the previous
        // daemon's child is doing real work, and killing it would discard it.
        adopted.push(run.id);
        continue;
      }

      const status = this.#classify(run);
      this.runs.update(run.id, {
        status,
        finishedAt: this.clock.now(),
        errorCode: status,
        errorMessage: status === 'RESUMABLE'
          ? 'The daemon exited mid-run; the runtime session can be resumed.'
          : 'The daemon exited mid-run and the worker process is gone.',
      });
      (status === 'RESUMABLE' ? resumable : interrupted).push(run.id);

      // The attempt count is preserved on purpose: an interrupted attempt was
      // an attempt, and pretending otherwise would let a task that fails by
      // crashing loop past its retry budget.
      // An eval trial's task is never requeued: the run is classified as any
      // other, and the eval runner's own boot recovery cancels the trial (P3b).
      // Nor is its mission noted as touched, because the note says its tasks
      // "were returned to the queue", which for a trial is untrue.
      const trial = this.#isTrial(run.missionId);
      if (!trial) touched.add(run.missionId);
      const task = trial ? undefined : this.tasks.get(run.taskId);
      // A task parked on a question is still an in-flight run: the worker was
      // blocked inside `ask_human`, and that process is gone now. Left alone it
      // would sit in AWAITING_INPUT forever, and its question would stay in the
      // inbox with nothing waiting for the answer.
      if (task !== undefined && task.status === 'AWAITING_INPUT') this.#withdrawQuestions(task.id);
      if (task !== undefined && (task.status === 'RUNNING' || task.status === 'AWAITING_INPUT')) {
        this.tasks.update(task.id, {
          status: 'READY',
          statusReason: status === 'RESUMABLE'
            ? 'The previous run was interrupted and can be resumed.'
            : 'The previous run was interrupted before it finished.',
        });
        tasksRequeued += 1;
      }
    }

    // A held task waits for its person whatever happened to its run, so it is
    // neither requeued nor cancelled: only RUNNING and AWAITING_INPUT are. Its
    // terminal died with the last daemon, though, and the open hold forgets
    // that pid; reopening the terminal resumes the captured session.
    for (const task of this.tasks.listByStatus(['HELD'])) {
      const hold = this.holds.openFor(task.id);
      if (hold === undefined) {
        // The hold ended but the daemon died before the task went back to the
        // queue (a hold ends before its terminal does, and the task follows).
        this.tasks.update(task.id, { status: 'READY', statusReason: null, needsAttention: false, finishedAt: null });
        const mission = this.missions.get(task.missionId);
        if (mission !== undefined) {
          this.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id }, {
            type: 'task.status', from: 'HELD', to: 'READY', reason: 'Its hold had ended; returned to the queue.',
          });
        }
        for (const waiting of this.tasks.listByMission(task.missionId)) {
          if (waiting.status === 'PENDING' && waiting.statusReason === heldWaitingReason(task)) this.tasks.update(waiting.id, { statusReason: null });
        }
        touched.add(task.missionId);
        tasksRequeued += 1;
        continue;
      }
      if (hold !== undefined && hold.ptyPid !== null && !this.liveness.isAlive(hold.ptyPid)) {
        this.holds.update(hold.id, { ptyPid: null });
      }
    }

    // A task can read RUNNING with no run behind it at all: the attempt failed
    // between marking the task and recording its run (a constraint error did
    // exactly this), and the loop above only looks at runs. Such a task was
    // stuck forever - no run to recover, and the scheduler never dispatches a
    // RUNNING task. With no live, adopted run it goes back to the queue.
    const liveTasks = new Set(this.runs.listByStatus(['STARTING', 'RUNNING']).map((r) => r.taskId as string));
    for (const task of this.tasks.listByStatus(['RUNNING'])) {
      if (liveTasks.has(task.id) || this.#isTrial(task.missionId)) continue;
      this.tasks.update(task.id, {
        status: 'READY',
        statusReason: 'Found marked running with no run behind it; returned to the queue.',
      });
      touched.add(task.missionId);
      tasksRequeued += 1;
    }

    // A mission marked COMPLETE with work still queued - closed over a
    // cancelled task, then that task retried. Nothing ticks a completed
    // mission, so its task would sit READY forever: reopen it.
    for (const mission of this.missions.list({ statuses: ['COMPLETE'] })) {
      const open = this.tasks.listByMission(mission.id)
        .filter((t) => !['SUCCEEDED', 'SKIPPED', 'FAILED', 'CANCELLED'].includes(t.status));
      if (open.length === 0) continue;
      const reason = `Reopened: ${open.map((t) => t.key).join(', ')} still to run.`;
      this.missions.update(mission.id, { status: 'EXECUTING', statusReason: reason });
      this.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id }, {
        type: 'mission.status', from: 'COMPLETE', to: 'EXECUTING', reason,
      });
      touched.add(mission.id);
    }

    const adoptedTasks = new Set(adopted.map((id) => this.runs.get(id as RunId)?.taskId).filter((t) => t !== undefined));
    const leasesReleased = this.#releaseDeadLeases(adoptedTasks);
    const targetsFailed = this.#failOrphanedTargets(touched);

    for (const missionId of touched) {
      const mission = this.missions.get(missionId);
      if (mission === undefined) continue;
      this.recorder.note(
        { workspaceId: mission.workspaceId, missionId },
        `Tandemise restarted while this mission was running. `
        + `${resumable.length} run(s) can be resumed, ${interrupted.length} were interrupted; `
        + `affected tasks were returned to the queue.`,
        'warn',
      );
    }

    const report: RecoveryReport = {
      adopted, resumable, interrupted, tasksRequeued, leasesReleased, targetsFailed,
      missionsTouched: [...touched],
    };
    this.log.info('recovery.complete', { ...report, missionsTouched: report.missionsTouched.length });
    this.recorder.invalidate('missions');
    this.recorder.invalidate('tasks');
    return report;
  }

  /**
   * Resumable needs two things at once: a runtime that can resume, and a
   * session handle it can resume *from*. Either alone is not enough, and
   * claiming resumability without both produces a retry that silently starts
   * from scratch while telling the user it continued.
   */
  #classify(run: Run): RunStatus {
    const profile = this.runtimeProfiles.get(asId<'RuntimeProfileId'>(run.runtimeProfileId));
    const adapter = profile === undefined ? undefined : this.registry.tryAdapter(profile.adapterId);
    const canResume = adapter?.resume !== undefined && run.externalSessionId !== null;
    return canResume ? 'RESUMABLE' : 'INTERRUPTED';
  }

  #withdrawQuestions(taskId: MissionTask['id']): void {
    for (const approval of this.approvals.list({ statuses: ['PENDING'] })) {
      // A question, or a tool waiting on its approval (#141): both park the
      // task, and both were asked by a run that is gone now.
      if (approval.taskId !== taskId || !PARKED_CARD_KINDS.includes(approval.kind)) continue;
      withdrawApproval(
        { approvals: this.approvals, recorder: this.recorder, clock: this.clock },
        approval,
        'Tandemise restarted while the worker was waiting on this. It will ask again if it still needs to.',
      );
    }
  }

  #releaseDeadLeases(adoptedTasks: ReadonlySet<string>): number {
    let released = 0;
    const now = this.clock.now();
    const expired = new Set(this.leases.listExpired(now).map((l) => l.id));

    for (const lease of this.leases.listAll()) {
      const holder = lease.holderRunId === null ? undefined : this.runs.get(lease.holderRunId as RunId);
      const holderAlive = holder !== undefined
        && (holder.status === 'STARTING' || holder.status === 'RUNNING')
        && holder.pid !== null
        && this.liveness.isAlive(holder.pid);

      if (holderAlive) continue;
      // A held checkout is the person's for as long as the hold is open, across
      // restarts: the hold service takes the lease up again once recovery is done.
      if (lease.holderRunId === null && lease.holderTaskId !== null && this.#heldOpen(lease.holderTaskId)) continue;
      if (lease.holderRunId === null && !expired.has(lease.id)
        && lease.holderTaskId !== null && adoptedTasks.has(lease.holderTaskId)) {
        // Held by a task whose worker outlived the last daemon and was adopted
        // above: that worker is still using the resource.
        continue;
      }
      // Any other task-held lease belonged to the previous daemon's executor,
      // and the instance lock means that daemon is gone. Waiting out the TTL
      // stranded the task that held it - and every task sharing its checkout -
      // for up to half an hour after a restart, READY but never dispatched.
      this.leases.release(lease.id);
      released += 1;
    }
    return released;
  }

  #heldOpen(taskId: string): boolean {
    const task = this.tasks.get(asId<'TaskId'>(taskId));
    return task?.status === 'HELD' && this.holds.openFor(task.id) !== undefined;
  }

  #failOrphanedTargets(touched: Set<MissionId>): number {
    let failed = 0;
    for (const target of this.targets.listByStatus(['PROVISIONING'])) {
      this.targets.update(target.id, {
        status: 'FAILED',
        detail: 'Provisioning was interrupted by a daemon restart.',
      });
      // A trial's target is the eval runner's to clean up, and its mission gets no restart note.
      if (target.missionId !== null && !this.#isTrial(target.missionId)) touched.add(target.missionId);
      failed += 1;
    }
    if (failed > 0) this.recorder.invalidate('targets');
    return failed;
  }
}

/** The cards a run parked on: a worker's question and a tool call waiting on its approval. */
const PARKED_CARD_KINDS: readonly Approval['kind'][] = ['choice', 'action', 'release'];
