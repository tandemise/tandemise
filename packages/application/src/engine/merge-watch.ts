import type {
  ApprovalRepositoryPort, MergeDecisionRecord, MergeDecisionRepositoryPort, MissionRepositoryPort, OutcomeRepositoryPort,
  PullRequestPort, RepoRepositoryPort, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { APPROVE_OPTION, DEFAULT_ESCALATE_AFTER_MS, REJECT_OPTION } from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import { errorMessage, type Clock, type Logger } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import type { OutcomeRecorder } from './outcomes.js';

/**
 * Watching main after a merge (#53 §8.7). For 24 hours after a merge the
 * merge commit's checks on the base branch are read: a failure records
 * `broke_main` once and puts a card in the Inbox with Revert and Leave it. It
 * never reverts on its own. For 90 days a revert someone else made
 * (`Revert "<title>"`) is noticed and recorded once. After 7 days with
 * neither, the merge is `merged_clean`.
 */
export const MAIN_WATCH_MS = 86_400_000;
export const CLEAN_AFTER_MS = 7 * 86_400_000;
export const REVERT_WATCH_MS = 90 * 86_400_000;
/** At most this often: each look is a `gh` call per recent merge. */
export const MERGE_WATCH_EVERY_MS = 300_000;
export const BROKE_MAIN_LABEL = 'Broke main';

export interface MergeWatchDeps {
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'list'>;
  readonly missions: Pick<MissionRepositoryPort, 'get'>;
  readonly tasks: Pick<TaskRepositoryPort, 'listByMission'>;
  readonly repositories: Pick<RepoRepositoryPort, 'get'>;
  readonly mergeDecisions: Pick<MergeDecisionRepositoryPort, 'listByWorkspace'>;
  readonly outcomeRows: Pick<OutcomeRepositoryPort, 'listByWorkspace'>;
  readonly pullRequests: Pick<PullRequestPort, 'checks' | 'commits' | 'view'>;
  readonly approvals: Pick<ApprovalRepositoryPort, 'create'>;
  readonly approvalFactory: ApprovalFactory;
  readonly outcomes: () => Pick<OutcomeRecorder, 'brokeMain' | 'reverted' | 'mergedClean'> | undefined;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

export class MergeWatch {
  #last = 0;
  #running = false;

  constructor(private readonly deps: MergeWatchDeps) {}

  /** From the scheduler's pass: in the background, throttled. */
  tick(): void {
    const now = this.deps.clock.epochMs();
    if (this.#running || now - this.#last < MERGE_WATCH_EVERY_MS) return;
    this.#last = now;
    this.#running = true;
    void this.sweep().catch((e: unknown) => this.deps.log.warn('merge_watch.failed', { error: errorMessage(e) })).finally(() => { this.#running = false; });
  }

  async sweep(nowMs: number = this.deps.clock.epochMs()): Promise<void> {
    for (const workspace of this.deps.workspaces.list()) {
      const since = new Date(nowMs - REVERT_WATCH_MS).toISOString();
      const merged = this.deps.mergeDecisions.listByWorkspace(workspace.id, since).filter((d) => d.mergedAt !== null && d.mergeSha !== null);
      if (merged.length === 0) continue;
      const outcomes = this.deps.outcomeRows.listByWorkspace(workspace.id, since);
      const has = (d: MergeDecisionRecord, kind: string) => outcomes.some((o) => o.mission === d.missionId && o.kind === kind);
      for (const d of merged) {
        try {
          await this.#look(d, nowMs, has);
        } catch (e) {
          this.deps.log.warn('merge_watch.look_failed', { decisionId: d.id, error: errorMessage(e) });
        }
      }
    }
  }

  async #look(d: MergeDecisionRecord, nowMs: number, has: (d: MergeDecisionRecord, kind: string) => boolean): Promise<void> {
    const mission = this.deps.missions.get(d.missionId);
    const repository = mission?.repositoryId == null ? undefined : this.deps.repositories.get(mission.repositoryId);
    if (mission === undefined || repository === undefined) return;
    const age = nowMs - Date.parse(d.mergedAt!);
    const reverted = has(d, 'reverted');
    const broke = has(d, 'broke_main');
    if (!reverted) {
      const pr = await this.deps.pullRequests.view(repository.path, d.repo, d.prNumber);
      const commits = await this.deps.pullRequests.commits(repository.path, d.repo, pr.baseBranch, d.mergedAt!);
      if (commits.some((c) => c.subject === `Revert "${pr.title}"` || c.subject.startsWith(`Revert "${pr.title}`))) {
        this.deps.outcomes()?.reverted(d);
        this.deps.recorder.record({ workspaceId: d.workspaceId, missionId: d.missionId }, { type: 'merge.reverted', decisionId: d.id, revertPr: null, by: 'someone else' });
        return;
      }
    }
    if (!broke && !reverted && age <= MAIN_WATCH_MS) {
      const checks = await this.deps.pullRequests.checks(repository.path, d.repo, d.mergeSha!);
      if (checks.state === 'FAIL') {
        this.deps.outcomes()?.brokeMain(d);
        const ship = this.deps.tasks.listByMission(d.missionId).find((t) => t.executor === 'ship');
        const pr = await this.deps.pullRequests.view(repository.path, d.repo, d.prNumber);
        const card = this.deps.approvalFactory.createOrThrow({
          workspaceId: d.workspaceId, missionId: d.missionId, taskId: ship?.id ?? null, kind: 'release', risk: 'release',
          title: `Main is failing after ${pr.title} merged`,
          rationale: `${checks.failing[0]?.name ?? 'A check'} failed on the merge commit ${d.mergeSha!.slice(0, 7)}. Tandemise never reverts on its own.`,
          effect: 'Revert opens a pull request that undoes the merge. Leave it keeps main as it is.',
          evidence: [
            { kind: 'text', label: BROKE_MAIN_LABEL, value: d.id },
            ...checks.failing.slice(0, 3).map((f) => ({ kind: 'text' as const, label: f.name, value: (f.logTail ?? 'failed').slice(-600) })),
          ],
          options: [{ id: APPROVE_OPTION, label: 'Revert' }, { id: REJECT_OPTION, label: 'Leave it' }],
          addressees: mission.createdBy == null ? [] : [mission.createdBy],
          escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS,
        });
        this.deps.approvals.create(card);
        this.deps.recorder.record({ workspaceId: d.workspaceId, missionId: d.missionId }, { type: 'approval.requested', approvalId: card.id });
        this.deps.recorder.invalidate('approvals', d.missionId);
        return;
      }
    }
    if (!broke && !reverted && age >= CLEAN_AFTER_MS && !has(d, 'merged_clean')) this.deps.outcomes()?.mergedClean(d);
  }
}
