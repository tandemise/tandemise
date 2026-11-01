import type { MissionTask, TaskRepositoryPort } from '@tandemise/domain';

/**
 * A live run blocked on a person reads AWAITING_INPUT, not RUNNING: the worker
 * is alive but consuming nothing, and the card says it is your move. Shared by
 * `ask_human` and the tool approval gate, the two places a run waits on someone.
 *
 * Only a running task is parked (a second wait refreshes the line). A held one
 * has a person in its session already, and any other status is not this run's
 * to change.
 */
export function parkOnPerson(tasks: Pick<TaskRepositoryPort, 'get' | 'update'>, taskId: MissionTask['id'], reason: string): void {
  const status = tasks.get(taskId)?.status;
  if (status !== 'RUNNING' && status !== 'AWAITING_INPUT') return;
  tasks.update(taskId, { status: 'AWAITING_INPUT', statusReason: reason });
}

/**
 * Undoes only a park. If the task moved on - the run was cancelled, the
 * executor failed it - putting it back to RUNNING here would resurrect a task
 * nothing is driving.
 */
export function unparkFromPerson(tasks: Pick<TaskRepositoryPort, 'get' | 'update'>, taskId: MissionTask['id']): void {
  if (tasks.get(taskId)?.status !== 'AWAITING_INPUT') return;
  tasks.update(taskId, { status: 'RUNNING', statusReason: null });
}
