import type {
  ApprovalRepositoryPort, EventRepositoryPort, MergeDecisionRecord, MergeDecisionRepositoryPort, MissionRepositoryPort, OutcomeRepositoryPort,
  PullRequestPort, RepoRepositoryPort, Repository, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { APPROVE_OPTION, DEFAULT_ESCALATE_AFTER_MS, REJECT_OPTION } from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import { errorMessage, type Clock, type Logger } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import type { OutcomeRecorder } from './outcomes.js';
import { gateOf, itemKey, itemLine, judgeMain, mainItems, type Gate, type MainItem } from './main-judge.js';

/**
 * Watching main after a merge (#53 §8.7). For 24 hours after a merge the
 * merge commit's checks on the base branch are read, judged by the
 * repository's own CI only (main-judge.ts, #186). A failure the merge brought
 * records `broke_main` once and puts a card in the Inbox with Leave it
 * (recommended) and Revert; one that was already failing on the previous main
 * commit is a note, with nothing to revert. It never reverts on its own. For 90 days a revert someone else made
 * (`Revert "<title>"`) is noticed and recorded once. After 7 days with
 * neither, the merge is `merged_clean`.
 */
export const MAIN_WATCH_MS = 86_400_000;
export const CLEAN_AFTER_MS = 7 * 86_400_000;
export const REVERT_WATCH_MS = 90 * 86_400_000;
/** At most this often: each look is a `gh` call per recent merge. */
export const MERGE_WATCH_EVERY_MS = 300_000;
export const BROKE_MAIN_LABEL = 'Broke main';
/** The timeline note for a failure main already had before the merge; said once per merge. */
export const ALREADY_FAILING_PREFIX = 'Main was already failing before';

export interface MergeWatchDeps {
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'list'>;
  readonly missions: Pick<MissionRepositoryPort, 'get'>;
  readonly tasks: Pick<TaskRepositoryPort, 'listByMission'>;
  readonly repositories: Pick<RepoRepositoryPort, 'get'>;
  readonly mergeDecisions: Pick<MergeDecisionRepositoryPort, 'listByWorkspace'>;
  readonly outcomeRows: Pick<OutcomeRepositoryPort, 'listByWorkspace'>;
  readonly pullRequests: Pick<PullRequestPort, 'checks' | 'commits' | 'view' | 'workflowRuns' | 'parentOf'>;
  /** To say "already failing" once per merge across restarts; optional for older harnesses (then once per daemon). */
  readonly events?: Pick<EventRepositoryPort, 'listByMission'>;
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
  readonly #saidAlready = new Set<string>();

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
      const pr = await this.deps.pullRequests.view(repository.path, d.repo, d.prNumber);
      const verdict = await this.#judge(repository, d, pr.baseBranch);
      if (verdict === null) return;
      const { judged, merge } = verdict;
      const scope = { workspaceId: d.workspaceId, missionId: d.missionId };
      if (judged.kind === 'already') {
        // Not this merge's doing: said once, and nothing is offered to revert.
        if (this.#alreadySaid(d)) return;
        this.#saidAlready.add(d.id);
        const names = judged.already.map((i) => (i.workflow === null ? i.job : `${i.workflow} › ${i.job}`)).join(', ');
        this.deps.recorder.note(scope, `${ALREADY_FAILING_PREFIX} ${pr.title} merged: ${names} failed on the previous main commit too, so this merge didn't cause it and there is nothing to revert.`, 'warn');
        return;
      }
      if (judged.kind === 'broken') {
        this.deps.outcomes()?.brokeMain(d);
        const ship = this.deps.tasks.listByMission(d.missionId).find((t) => t.executor === 'ship');
        const already = new Set(judged.already.map(itemKey));
        const first = judged.broken[0]!;
        const card = this.deps.approvalFactory.createOrThrow({
          workspaceId: d.workspaceId, missionId: d.missionId, taskId: ship?.id ?? null, kind: 'release', risk: 'release',
          title: `Main is failing after ${pr.title} merged`,
          rationale: `${first.workflow === null ? first.job : `${first.workflow} › ${first.job}`} failed on the merge commit ${d.mergeSha!.slice(0, 7)} and passed (or didn't run) on the main commit before it. Tandemise never reverts on its own.`,
          effect: 'Leave it keeps main as it is, so you can fix it forward. Revert opens a pull request that undoes this merge; main changes only once that pull request merges.',
          evidence: [
            { kind: 'text', label: BROKE_MAIN_LABEL, value: d.id },
            ...judged.broken.flatMap((i) => (i.link === null ? [] : [{ kind: 'link' as const, label: `${i.workflow ?? i.job}: failing run`, value: i.link }])),
            ...merge.filter((i) => i.state === 'fail' || !i.counted).slice(0, 12).map((i) => ({ kind: 'text' as const, ...itemLine(i, already) })),
          ],
          // Revert is never the default: a wrong click must not undo a good merge.
          options: [{ id: REJECT_OPTION, label: 'Leave it', recommended: true }, { id: APPROVE_OPTION, label: 'Revert' }],
          addressees: mission.createdBy == null ? [] : [mission.createdBy],
          escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS,
        });
        this.deps.approvals.create(card);
        this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: card.id });
        this.deps.recorder.invalidate('approvals', d.missionId);
        return;
      }
      if (judged.kind === 'pending') return;
    }
    if (!broke && !reverted && age >= CLEAN_AFTER_MS && !has(d, 'merged_clean')) this.deps.outcomes()?.mergedClean(d);
  }

  /**
   * The merge commit judged by the repository's own CI, against the main
   * commit before it (#186). Null when nothing on it can be read yet.
   */
  async #judge(repository: Repository, d: MergeDecisionRecord, base: string): Promise<{ judged: ReturnType<typeof judgeMain>; merge: readonly MainItem[] } | null> {
    const cwd = repository.path;
    const read = async (sha: string, gate: Gate): Promise<readonly MainItem[]> => {
      const [runs, checks] = await Promise.all([this.deps.pullRequests.workflowRuns(cwd, d.repo, sha), this.deps.pullRequests.checks(cwd, d.repo, sha)]);
      return mainItems({ base, runs, checks: checks.runs ?? checks.failing.map((f) => ({ name: f.name, passed: false, link: f.link })), gate });
    };
    // What the pull request was gated on: its head commit's workflows and checks.
    const [headRuns, headChecks] = await Promise.all([this.deps.pullRequests.workflowRuns(cwd, d.repo, d.headSha), this.deps.pullRequests.checks(cwd, d.repo, d.headSha)]);
    const gate = gateOf(headRuns, headChecks.runs ?? []);
    const merge = await read(d.mergeSha!, gate);
    if (merge.length === 0) return null;
    const parentSha = await this.deps.pullRequests.parentOf(cwd, d.repo, d.mergeSha!).catch(() => null);
    const parent = parentSha === null ? null : await read(parentSha, gate).catch(() => null);
    return { judged: judgeMain(merge, parent), merge };
  }

  #alreadySaid(d: MergeDecisionRecord): boolean {
    if (this.#saidAlready.has(d.id)) return true;
    const said = (this.deps.events?.listByMission(d.missionId) ?? [])
      .some((e) => e.body.type === 'note' && e.body.text.startsWith(ALREADY_FAILING_PREFIX));
    if (said) this.#saidAlready.add(d.id);
    return said;
  }
}
