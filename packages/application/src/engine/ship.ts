import type {
  Approval, ApprovalRepositoryPort, EvaluationRepositoryPort, MergeDecision, MergeDecisionRecord, MergeDecisionRepositoryPort,
  MergeFacts, MergePolicyOrError, Mission, MissionCriteriaRepositoryPort, MissionRepositoryPort, MissionTask, OutcomeRepositoryPort,
  PlanDecisionRepositoryPort, PlannerConfig, PullRequestPort, PullRequestRef, RepoRepositoryPort, Repository, RunScoreRepositoryPort,
  TaskRepositoryPort, TaskStatus, TaskType, UnitOfWork,
} from '@tandemise/domain';
import {
  APPROVE_OPTION, DEFAULT_ESCALATE_AFTER_MS, REJECT_OPTION, RUNTIME_ACTOR, decideMerge, decisionComment, foldOutcomes,
  closingLine, githubRepoFromRemote, isTrialMission, prBody, prTitle, profileLine, squashTrailers, stepClassFor,
} from '@tandemise/domain';
import type { ApprovalFactory } from '@tandemise/policy';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { errorMessage, ids, type Clock, type Logger, type Timestamp } from '@tandemise/shared';
import { measureMergeFacts } from './ship-measure.js';
import { SHIPPED_PLANNER } from '../planning/defaults/planner.js';
import type { FeedbackRounds } from './feedback-rounds.js';
import type { OutcomeRecorder } from './outcomes.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { BranchIntegrationService } from './branch-integration.js';
import { ROUND_CAP_LABEL, missionRounds, roundStopCard } from './ci-rounds.js';

/**
 * The ship step (#53 §8.1): the daemon-owned last step of every code plan. No
 * agent runs in it and nobody holds it. In order, each transition persisted
 * before its side effect: integrate the task branches (a conflict becomes a
 * `resolve_conflicts_N` step before any pull request exists), push, and open a
 * non-draft pull request from the daemon, titled from the profile.
 */
export type ShipOutcome =
  | { readonly kind: 'opened'; readonly prs: readonly PullRequestRef[] }
  /** Merged, by Tandemise or a person; the step is done. */
  | { readonly kind: 'merged'; readonly reason: string }
  /** Waiting on a person or on GitHub; the status says which. Nothing for the scheduler to change. */
  | { readonly kind: 'waiting' }
  /** CI failed: the code step went back for another round, and the ship step waits behind it. */
  | { readonly kind: 'reopened'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly taskKey: string }
  /** The measured change called for more steps (#53 §5.4); the ship step waits behind them. */
  | { readonly kind: 'escalated'; readonly added: readonly string[] }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'cancelled' };

const PUSH_TIMEOUT_MS = 120_000;
/** How often the ship step reads CI and the pull request: the waiter's own default interval. */
export const SHIP_CI_POLL_MS = 30_000;
/** CI that hasn't finished in an hour is something a person should look at. */
export const SHIP_CI_TIMEOUT_MS = 3_600_000;
/** A workflow can take a few minutes to register its first check after a push. */
export const SHIP_CI_GRACE_MS = 180_000;
/** Rounds a mission takes on its own before a person decides (#196), unless planner.yaml says otherwise. */
export const DEFAULT_MAX_ROUNDS = 3;
/** Lines of a failing check's output given to the next round. */
export const SHIP_LOG_TAIL_LINES = 40;

export const PR_CHANGED = 'The pull request changed after it was checked; checking again.';
export const PR_CLOSED = 'The pull request was closed without merging.';
export const WAITING_FOR_GITHUB_MERGE = 'Waiting for you to merge it in GitHub.';
const DECISION_LABEL = 'Decision';

export interface ShipDeps {
  readonly tasks: TaskRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly integration: BranchIntegrationService;
  readonly pullRequests: PullRequestPort;
  readonly exec: CommandExecutor | null;
  readonly credentialEnv?: () => Readonly<Record<string, string>>;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly criteria: Pick<MissionCriteriaRepositoryPort, 'listActive'>;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** Re-profiles from the changed paths and adds steps (#53 §5.4); the keys it added. */
  readonly escalate?: (mission: Mission, paths: readonly string[]) => Promise<readonly string[]>;
  /** The head Tandemise last pushed for a pull request, from its `ship.pr_opened` events. */
  readonly pushedSha?: (mission: Mission, pr: PullRequestRef) => string | null;
  /** The mission's `ship.pr_opened` events, oldest first: the pull requests it opened, or its CI wait found (#143). */
  readonly opened?: (mission: Mission) => readonly OpenedPullRequest[];
  /** Reverts a merge (#53 §8.7). */
  readonly revert?: (decisionId: string, by: string) => Promise<unknown>;
  /** The decision (#53 §8). Optional so the open-only harnesses still compose. */
  readonly decide?: ShipDecideDeps;
  /**
   * What the pull request's body says beyond the plan (#113): the change set's
   * headline and points, the tracker item, the holds, and whether QA reported.
   * Optional so the open-only harnesses still compose; absent, the body says
   * only what the plan knows.
   */
  readonly prFacts?: (mission: Mission) => PrFacts;
}

/** One `ship.pr_opened` event. */
export interface OpenedPullRequest {
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly foundBy: 'wait' | null;
}

export const MERGED_BEFORE_DECISION = 'Merged in GitHub by a person before Tandemise decided.';

/** What `ShipDeps.prFacts` reads for one mission. */
export interface PrFacts {
  readonly summary: { readonly headline: string; readonly points: readonly string[] } | null;
  readonly issue: { readonly label: string; readonly key: string; readonly url: string } | null;
  readonly holds: readonly string[];
  /** A QA report exists on the mission: its Done-when results are QA's, not the agent's. */
  readonly qaReported: boolean;
  /** The tracker item's own type (a YouTrack Bug), when it has one; it can type the pull request (#157). */
  readonly trackerType?: string | null;
}

export interface ShipDecideDeps {
  readonly missions: MissionRepositoryPort;
  readonly mergeDecisions: MergeDecisionRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly approvalFactory: ApprovalFactory;
  readonly evaluations: EvaluationRepositoryPort;
  readonly runScores: RunScoreRepositoryPort;
  readonly outcomeRows: OutcomeRepositoryPort;
  readonly unitOfWork: UnitOfWork;
  readonly rounds: () => FeedbackRounds;
  readonly outcomes: () => OutcomeRecorder | undefined;
  /** The project's planner and merge policy, read fresh, with the files' refs. */
  /** `autoMergeAuthorized`: the merge policy came from the brain and a person turned auto-merge on in the app (a Decision). */
  readonly factory: (workspaceId: string) => Promise<{ planner: PlannerConfig; merge: MergePolicyOrError; policyRef: string; autoMergeAuthorized: boolean }>;
  readonly pollMs: number;
  readonly timeoutMs: number;
  /** No CI right after a push is CI not started yet: waited for this long before it counts as none. */
  readonly ciGraceMs: number;
  /** The code step's feedback, to tell a repeated CI failure from a new one (#197); absent, every failure starts a round. */
  readonly feedback?: Pick<import('@tandemise/domain').FeedbackRepositoryPort, 'listByTask'>;
  /** Hold records (#50), counted into process.holds; absent, holds are unmeasured. */
  readonly holds?: Pick<import('@tandemise/domain').TaskHoldRepositoryPort, 'listByMission'>;
}

export class ShipService {
  /** Ship steps whose decision must ask whatever the policy says, with why. */
  readonly #mustAsk = new Map<string, string>();

  constructor(protected readonly deps: ShipDeps) {}

  async run(mission: Mission, task: MissionTask, signal: AbortSignal): Promise<ShipOutcome> {
    if (isTrialMission(mission)) return { kind: 'skipped', reason: 'An eval trial never opens a pull request.' };
    const repository = mission.repositoryId === null ? undefined : this.deps.repositories.get(mission.repositoryId);
    if (repository === undefined) return { kind: 'skipped', reason: 'This mission has no repository, so there is no pull request to open.' };
    const d = this.deps.decide;
    // Adopted after a restart, or watched while a person decides: never push or decide twice for one head.
    if (d !== undefined && (task.status === 'AWAITING_APPROVAL' || task.status === 'AWAITING_EXTERNAL')) {
      const latest = d.mergeDecisions.listByMission(mission.id).at(-1);
      if (latest !== undefined) return this.#watch(mission, task, repository, latest, signal);
    }
    // A pull request a step opened, found by the mission's CI wait (#143): decided on as it is, not pushed and opened again.
    const found = this.#found(mission);
    if (d !== undefined && found !== null) {
      const pr = await this.deps.pullRequests.view(repository.path, found.repo, found.number);
      if (pr.state === 'MERGED') return this.mergedOnGitHub(mission, task, pr);
      if (pr.state === 'OPEN') return this.#afterOpen(mission, task, repository, pr, signal);
    }
    const opened = await this.open(mission, task, repository, signal);
    if (opened.kind !== 'opened' || d === undefined) return opened;
    return this.#afterOpen(mission, task, repository, opened.prs[0]!, signal);
  }

  /** Integrate, push and open (#53 §8.1 steps 1-2). */
  async open(mission: Mission, task: MissionTask, repository: Repository, signal: AbortSignal): Promise<ShipOutcome> {
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id };

    // A revert ships the branch the daemon made for it (#53 §8.7); nothing to measure or integrate.
    const fixed = mission.workflowInputs['shipBranch'];
    // Measured before anything leaves this machine: a change that touched more
    // than its plan expected gets its steps first, then ships (#53 §5.4).
    const early = fixed === undefined ? this.#codeBranch(mission) : null;
    if (early !== null && this.deps.escalate !== undefined) {
      const base = mission.baseBranch ?? repository.defaultBranch;
      const diff = await this.#git(repository, ['diff', '--name-only', `${base}...${early}`], false);
      const paths = diff.exitCode === 0 ? diff.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0) : [];
      try {
        const added = await this.deps.escalate(mission, paths);
        if (added.length > 0) {
          const current = this.deps.tasks.get(task.id) ?? task;
          this.deps.tasks.update(task.id, { dependsOn: [...new Set([...current.dependsOn, ...added])] });
          return { kind: 'escalated', added };
        }
      } catch (e) {
        // What the change touched couldn't be re-checked: it ships, but the decision asks.
        this.deps.log.warn('ship.escalate_failed', { missionId: mission.id, error: errorMessage(e) });
        this.#mustAsk.set(task.id, `Tandemise couldn't re-check what this change touches (${errorMessage(e)}), so it asks.`);
      }
    }

    const integrated = fixed !== undefined
      ? { conflictTaskKey: null, results: [], integrationBranch: null }
      : await this.deps.integration.integrate(mission);
    if (integrated.conflictTaskKey !== null) {
      // The ship step waits behind the conflict's resolution, then integrates again.
      const current = this.deps.tasks.get(task.id) ?? task;
      this.deps.tasks.update(task.id, { dependsOn: [...new Set([...current.dependsOn, integrated.conflictTaskKey])] });
      return { kind: 'conflict', taskKey: integrated.conflictTaskKey };
    }
    if (signal.aborted) return { kind: 'cancelled' };
    const branch = fixed ?? (integrated.results.length >= 2 && integrated.integrationBranch !== null
      ? integrated.integrationBranch
      : this.#codeBranch(mission));
    if (branch === null) return { kind: 'skipped', reason: 'No step changed any code, so there is nothing to ship.' };
    // #196: a branch with no commit beyond the remote base would open a pull request on a commit already there,
    // whose CI is the base's own; a red check on it sent the step back for ever.
    if (fixed === undefined) {
      const base = mission.baseBranch ?? repository.defaultBranch;
      if (await this.#ahead(repository, base, branch) === 0) {
        const reason = `Nothing to ship: the change is already on ${base}.`;
        this.deps.recorder.note(scope, `${reason} The branch ${branch} has no commit beyond it, so no pull request was opened.`);
        return { kind: 'skipped', reason };
      }
    }
    // #138: what ships must hold every step's final work. A round that redid
    // a step leaves its new commit on that step's branch only; shipping a
    // branch cut before it would ship code without the fix that was reviewed.
    if (fixed === undefined) {
      const missing = await this.missingUpstreamWork(mission, repository, branch);
      if (missing.length > 0) {
        const reason = `The branch ${branch} is missing the final work of ${missing.map((m) => `'${m.taskKey}' (${m.commit.slice(0, 7)})`).join(', ')}, so it was not pushed.`;
        this.#missingWorkCard(mission, task, reason);
        return { kind: 'blocked', reason };
      }
    }

    const repo = githubRepoFromRemote(repository.remoteUrl);
    if (repo === null) {
      return { kind: 'skipped', reason: `There is no GitHub remote, so there is no pull request to open; the work is on branch ${branch}.` };
    }

    const pushed = await this.#git(repository, ['push', 'origin', `${branch}:refs/heads/${branch}`], true);
    if (pushed.exitCode !== 0) return { kind: 'blocked', reason: `Couldn't push ${branch}: ${firstLine(pushed.stderr || pushed.stdout)}` };
    if (signal.aborted) return { kind: 'cancelled' };

    let pr: PullRequestRef & { created: boolean };
    try {
      pr = await this.deps.pullRequests.open({
        cwd: repository.path,
        repo,
        head: branch,
        base: mission.baseBranch ?? repository.defaultBranch,
        title: await this.titleFor(mission, repository, branch),
        body: this.body(mission, repo),
      });
    } catch (e) {
      return { kind: 'blocked', reason: `Couldn't open the pull request: ${errorMessage(e)}` };
    }
    const local = await this.#git(repository, ['rev-parse', `refs/heads/${branch}`], false);
    const pushedSha = local.exitCode === 0 ? local.stdout.trim() : pr.headSha;
    this.deps.recorder.record(scope, { type: 'ship.pr_opened', repo, number: pr.number, url: pr.url, headSha: pushedSha });
    if (pr.created) this.deps.recorder.note(scope, `Opened the pull request ${pr.url}.`);
    // A revert's pull request now exists: only now does the merge it undoes count as reverted (#53 §8.7).
    const revertOf = mission.workflowInputs['revertOf'];
    if (pr.created && revertOf !== undefined) {
      const original = this.deps.decide?.mergeDecisions.get(revertOf);
      if (original !== undefined) {
        this.deps.recorder.record({ workspaceId: original.workspaceId, missionId: original.missionId }, { type: 'merge.reverted', decisionId: original.id, revertPr: pr.url, by: mission.workflowInputs['revertBy'] ?? 'a person' });
        this.deps.decide?.outcomes()?.reverted(original);
      }
    }
    this.deps.recorder.invalidate('ship', mission.id);
    return { kind: 'opened', prs: [pr] };
  }

  // ------------------------------------------------- CI, decide, ask (§8.1 3-6)

  async #afterOpen(mission: Mission, task: MissionTask, repository: Repository, opened: PullRequestRef, signal: AbortSignal): Promise<ShipOutcome> {
    const d = this.deps.decide!;
    let pr = opened;
    const started = this.deps.clock.epochMs();
    for (;;) {
      if (signal.aborted) return { kind: 'cancelled' };
      // A decision already made for this exact head (a restart between decide and merge) is not made again.
      const existing = d.mergeDecisions.latestFor(mission.id, pr.repo);
      if (existing !== undefined && existing.voidedAt === null && existing.headSha === pr.headSha) {
        return this.#settle(mission, task, repository, pr, existing);
      }
      const read = await this.deps.pullRequests.checks(repository.path, pr.repo, pr.headSha);
      const starting = read.state === 'NONE' && this.deps.clock.epochMs() - started < d.ciGraceMs;
      const checks = starting ? { ...read, state: 'PENDING' as const } : read;
      if (checks.state === 'PENDING') {
        this.#status(mission, task, 'AWAITING_EXTERNAL', starting ? 'Waiting for CI (0 of 0 checks done)' : `Waiting for CI (${checks.done} of ${checks.total} checks done)`);
        if (this.deps.clock.epochMs() - started > d.timeoutMs) return { kind: 'blocked', reason: 'CI didn\'t finish within an hour.' };
        await sleep(d.pollMs, signal);
        const now = await this.deps.pullRequests.view(repository.path, pr.repo, pr.number);
        if (now.state !== 'OPEN') return this.#closedOrMerged(mission, task, now, existing ?? null);
        pr = now;
        continue;
      }
      if (checks.state === 'FAIL') return await this.#ciFailed(mission, task, checks.failing[0] ?? { name: 'a check', link: null, logTail: null }, pr.headSha);
      const decision = await this.#decide(mission, task, repository, pr, checks, existing?.commentId ?? null);
      return this.#settle(mission, task, repository, pr, decision);
    }
  }

  async #decide(mission: Mission, task: MissionTask, repository: Repository, pr: PullRequestRef, checks: Awaited<ReturnType<PullRequestPort['checks']>>, commentId: number | null): Promise<MergeDecisionRecord> {
    const d = this.deps.decide!;
    const factory = await d.factory(mission.workspaceId);
    const protection = await this.deps.pullRequests.protection(repository.path, pr.repo, pr.baseBranch);
    const fetched = await this.#git(repository, ['fetch', '--quiet', 'origin', pr.baseBranch], true);
    const baseRef = fetched.exitCode === 0 ? `origin/${pr.baseBranch}` : pr.baseBranch;
    // The head being decided must be here: its branch, else GitHub's pull/<n>/head ref.
    if ((await this.#git(repository, ['cat-file', '-e', `${pr.headSha}^{commit}`], false)).exitCode !== 0) {
      await this.#git(repository, ['fetch', '--quiet', 'origin', pr.headBranch], true);
      if ((await this.#git(repository, ['cat-file', '-e', `${pr.headSha}^{commit}`], false)).exitCode !== 0) {
        await this.#git(repository, ['fetch', '--quiet', 'origin', `pull/${pr.number}/head:refs/tandemise/pr/${pr.number}`], true);
      }
    }
    const recent = d.outcomeRows.listByWorkspace(mission.workspaceId, new Date(this.deps.clock.epochMs() - 90 * 86_400_000).toISOString());
    let measured: MergeFacts;
    try {
      measured = await measureMergeFacts({
      git: (args) => this.#git(repository, args, false),
      tasks: this.deps.tasks, evaluations: d.evaluations, runScores: d.runScores, criteria: this.deps.criteria, planDecisions: this.deps.planDecisions,
    }, {
      mission, repository, pr, baseRef, checks, protection, policy: factory.merge, planner: factory.planner,
      pushedSha: this.#pushedSha(mission, pr), repos: 1,
      stats: foldOutcomes(recent),
      holds: d.holds === undefined ? null : d.holds.listByMission(mission.id).length,
      now: this.deps.clock.epochMs(),
    });
    } catch (e) {
      return this.#recordDecision(mission, task, repository, pr, factory.policyRef, commentId, null, `Tandemise couldn't measure this change (${errorMessage(e)}), so it asks.`);
    }
    const facts = measured;
    // Auto-merge counts only when the policy came from the brain and a person turned it on in the app (#53 §8.4);
    // a merge.yaml in a repository or on this computer saying "on" is not that.
    const policy = 'error' in factory.merge || factory.autoMergeAuthorized ? factory.merge : { ...factory.merge, autoMerge: 'off' as const, revertAutoMerge: 'off' as const };
    const forced = this.#mustAsk.get(task.id);
    if (forced !== undefined) return this.#recordDecision(mission, task, repository, pr, factory.policyRef, commentId, null, forced);
    return this.#recordDecision(mission, task, repository, pr, factory.policyRef, commentId, { facts, decided: decideMerge(facts, policy) }, null);
  }

  /** Writes a decision (or a "couldn't measure" ask) before anything acts on it, then the one PR comment. */
  async #recordDecision(
    mission: Mission, task: MissionTask, repository: Repository, pr: PullRequestRef, policyRef: string, commentId: number | null,
    made: { facts: MergeFacts; decided: MergeDecision } | null, failure: string | null,
  ): Promise<MergeDecisionRecord> {
    const d = this.deps.decide!;
    const decided: MergeDecision = made?.decided ?? { verdict: 'ask', score: 0, allowed: null, wouldMerge: false, factors: [], reasons: [failure ?? 'Tandemise couldn\'t measure this change, so it asks.'] };
    const facts = made?.facts ?? null;
    const record: MergeDecisionRecord = {
      id: ids.mergeDecision(), workspaceId: mission.workspaceId, missionId: mission.id, repo: pr.repo, prNumber: pr.number, headSha: pr.headSha,
      policyRef, verdict: decided.verdict, score: decided.score, allowed: decided.allowed, wouldMerge: decided.wouldMerge,
      factors: decided.factors, reasons: decided.reasons, facts: (facts ?? {}) as unknown as Record<string, unknown>,
      decidedAt: this.deps.clock.now() as Timestamp, voidedAt: null, commentId, mergedAt: null, mergedBy: null, mergeSha: null,
    };
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id };
    // The row exists before anything acts on it: a crash after this decides nothing twice.
    this.deps.recorder.deferred(() => d.unitOfWork.transaction(() => {
      d.mergeDecisions.create(record);
      this.deps.recorder.record(scope, { type: 'merge.decided', decisionId: record.id, verdict: record.verdict, score: record.score, repo: pr.repo, number: pr.number, headSha: pr.headSha });
    }));
    try {
      const text = facts === null ? `Tandemise asks for a review: ${decided.reasons.join(' ')} Policy: ${policyRef}.` : decisionComment(decided, facts, { headSha: pr.headSha, policyRef });
      const comment = await this.deps.pullRequests.comment(repository.path, pr.repo, pr.number, text, commentId);
      d.mergeDecisions.update(record.id, { commentId: comment.id });
    } catch (e) {
      this.deps.log.warn('ship.comment_failed', { missionId: mission.id, error: errorMessage(e) });
    }
    this.deps.recorder.invalidate('ship', mission.id);
    return d.mergeDecisions.get(record.id) ?? record;
  }

  /** After a decision: merge, or ask a person and wait (§8.1 step 6). */
  async #settle(mission: Mission, task: MissionTask, repository: Repository, pr: PullRequestRef, decision: MergeDecisionRecord): Promise<ShipOutcome> {
    // Already queued on GitHub (auto-merge, waiting for its checks): watch it, never queue it again.
    if (decision.mergedBy !== null && decision.mergedAt === null) {
      this.#status(mission, task, 'AWAITING_EXTERNAL', 'Queued to merge on GitHub once its required checks pass.');
      return { kind: 'waiting' };
    }
    if (decision.verdict === 'merge') return this.mergeDecided(mission, task, repository, decision, 'auto');
    const d = this.deps.decide!;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id };
    const forDecision = d.approvals.list({ missionId: mission.id }).filter((a) => a.taskId === task.id && a.evidence.some((e) => e.label === DECISION_LABEL && e.value === decision.id));
    // You already said Merge for this exact decision and it didn't go through: try again.
    const approved = forDecision.find((a) => a.status === 'APPROVED' && a.selectedOptionId === APPROVE_OPTION);
    if (approved !== undefined && decision.mergedAt === null) return this.mergeDecided(mission, task, repository, decision, 'person', approved.decidedBy ?? 'a person');
    // You chose to merge it in GitHub yourself: watch for that, ask nothing more.
    if (forDecision.some((a) => a.status === 'REJECTED')) return { kind: 'waiting' };
    const cards = forDecision.filter((a) => a.status === 'PENDING');
    const current = this.deps.tasks.get(task.id) ?? task;
    if (cards.length === 0) {
      const factory = await d.factory(mission.workspaceId);
      const reviewers = 'error' in factory.merge ? [] : factory.merge.reviewers;
      try { await this.deps.pullRequests.requestReviewers(repository.path, pr.repo, pr.number, reviewers); } catch (e) {
        this.deps.log.warn('ship.reviewers_failed', { missionId: mission.id, error: errorMessage(e) });
      }
      const card = d.approvalFactory.createOrThrow({
        workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, kind: 'release', risk: 'release',
        // The pull request as GitHub has it (#152): its own title is what a squash merge commits.
        title: `Review and merge #${pr.number}: ${pr.title}`,
        rationale: decision.reasons.join(' '),
        effect: 'Merge merges this exact commit with your approval. "I\'ll merge it in GitHub" leaves it to you; Tandemise finishes when GitHub says it merged.',
        evidence: [
          ...decision.reasons.map((r) => ({ kind: 'text' as const, label: 'Why it asks', value: r })),
          { kind: 'link' as const, label: 'Pull request', value: pr.url },
          { kind: 'text' as const, label: DECISION_LABEL, value: decision.id },
        ],
        options: [
          { id: APPROVE_OPTION, label: 'Merge', recommended: true },
          { id: REJECT_OPTION, label: 'I\'ll merge it in GitHub' },
        ],
        addressees: mission.createdBy === null || mission.createdBy === undefined ? [] : [mission.createdBy],
        escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS,
      });
      d.approvals.create(card);
      this.deps.recorder.record(scope, { type: 'approval.requested', approvalId: card.id });
      this.deps.recorder.record(scope, { type: 'merge.asked', decisionId: decision.id, reasons: [...decision.reasons] });
      this.deps.recorder.invalidate('approvals', mission.id);
      this.#status(mission, current, 'AWAITING_APPROVAL', `Waiting for your review: ${decision.reasons[0] ?? 'the merge policy asks'}`);
    }
    return { kind: 'waiting' };
  }

  /** Each pass while a person decides: did GitHub merge it, close it, or move its head? */
  async #watch(mission: Mission, task: MissionTask, repository: Repository, decision: MergeDecisionRecord, signal: AbortSignal): Promise<ShipOutcome> {
    const pr = await this.deps.pullRequests.view(repository.path, decision.repo, decision.prNumber);
    if (pr.state !== 'OPEN') return this.#closedOrMerged(mission, task, pr, decision);
    if (decision.voidedAt === null && pr.headSha !== decision.headSha) {
      this.#void(mission, task, decision);
      return this.#afterOpen(mission, task, repository, pr, signal);
    }
    if (decision.voidedAt !== null) return this.#afterOpen(mission, task, repository, pr, signal);
    // Decided with no CI, and CI has shown up since for the same head: decide again on it.
    if ((decision.facts as { ci?: { state?: string } }).ci?.state === 'NONE' && decision.mergedAt === null && decision.mergedBy === null) {
      const now = await this.deps.pullRequests.checks(repository.path, pr.repo, pr.headSha);
      if (now.state !== 'NONE') {
        this.#void(mission, task, decision);
        return this.#afterOpen(mission, task, repository, pr, signal);
      }
    }
    return this.#settle(mission, task, repository, pr, decision);
  }

  #void(mission: Mission, task: MissionTask, decision: MergeDecisionRecord): void {
    const d = this.deps.decide!;
    d.mergeDecisions.update(decision.id, { voidedAt: this.deps.clock.now() as Timestamp });
    void this.cancelQueued(decision);
    for (const card of d.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).filter((a) => a.evidence.some((e) => e.label === DECISION_LABEL && e.value === decision.id))) {
      d.approvals.update(card.id, { status: 'CANCELLED', decidedAt: this.deps.clock.now() });
    }
    this.deps.recorder.note({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id }, PR_CHANGED);
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  /** A merge queued on GitHub (`--auto`) for a decision that no longer stands is cancelled there too. */
  async cancelQueued(decision: MergeDecisionRecord): Promise<void> {
    if (decision.mergedBy !== 'tandemise' || decision.mergedAt !== null) return;
    const mission = this.deps.decide?.missions.get(decision.missionId);
    const repository = mission?.repositoryId == null ? undefined : this.deps.repositories.get(mission.repositoryId);
    if (repository === undefined) return;
    try {
      await this.deps.pullRequests.disableAutoMerge(repository.path, decision.repo, decision.prNumber);
      this.deps.decide?.mergeDecisions.update(decision.id, { mergedBy: null });
    } catch (e) {
      this.deps.log.warn('ship.disable_auto_failed', { decisionId: decision.id, error: errorMessage(e) });
    }
  }

  #closedOrMerged(mission: Mission, task: MissionTask, pr: PullRequestRef, decision: MergeDecisionRecord | null): ShipOutcome {
    const d = this.deps.decide!;
    if (pr.state === 'MERGED') {
      // A merge Tandemise queued (`--auto`) that GitHub has now done.
      // Only when GitHub merged the head that was decided; anything else is a person's merge.
      if (decision !== null && decision.mergedAt === null && decision.mergedBy === 'tandemise' && pr.headSha === decision.headSha) {
        return this.#recordMerged(mission, task, decision, pr.mergeSha, 'tandemise');
      }
      if (decision !== null && decision.mergedAt === null) {
        d.mergeDecisions.update(decision.id, { mergedAt: this.deps.clock.now() as Timestamp, mergedBy: pr.mergedBy ?? 'a person', mergeSha: pr.mergeSha });
        this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id }, { type: 'merge.merged', decisionId: decision.id, mergeSha: pr.mergeSha ?? '', by: pr.mergedBy ?? 'a person' });
        d.outcomes()?.merged(decision, 'person');
      }
      this.#cancelCards(mission, task);
      return { kind: 'merged', reason: `Merged in GitHub by ${pr.mergedBy ?? 'a person'}: ${pr.url}` };
    }
    if (decision !== null) d.outcomes()?.closedUnmerged(decision);
    this.#cancelCards(mission, task);
    return { kind: 'blocked', reason: PR_CLOSED };
  }

  #cancelCards(mission: Mission, task: MissionTask): void {
    const d = this.deps.decide!;
    for (const card of d.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).filter((a) => a.taskId === task.id)) {
      d.approvals.update(card.id, { status: 'CANCELLED', decidedAt: this.deps.clock.now() });
    }
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  /**
   * A mission's CI wait found the pull request a step opened (#143): recorded
   * once per head, so the mission shows it while the wait runs and the ship
   * step decides on it.
   */
  found(mission: Mission, task: MissionTask, pr: PullRequestRef): void {
    const seen = (this.deps.opened?.(mission) ?? []).some((o) => o.repo === pr.repo && o.number === pr.number && o.headSha === pr.headSha);
    if (seen) return;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id };
    this.deps.recorder.record(scope, { type: 'ship.pr_opened', repo: pr.repo, number: pr.number, url: pr.url, headSha: pr.headSha, foundBy: 'wait' });
    this.deps.recorder.invalidate('ship', mission.id);
  }

  /**
   * A person merged the mission's pull request on GitHub before Tandemise
   * decided on it (#143): a decision is recorded as merged by them, so the
   * outcome is `merged_by_person` and main is watched after it, as for any
   * merge. Recorded once per pull request.
   */
  async mergedOnGitHub(mission: Mission, task: MissionTask | null, pr: PullRequestRef): Promise<ShipOutcome> {
    const d = this.deps.decide;
    const by = pr.mergedBy ?? 'a person';
    const reason = `Merged in GitHub by ${by}: ${pr.url}`;
    if (d === undefined) return { kind: 'merged', reason };
    const existing = d.mergeDecisions.listByMission(mission.id).filter((x) => x.repo === pr.repo && x.prNumber === pr.number).at(-1);
    if (existing !== undefined && task !== null) {
      // Decided already: the usual path records it, once.
      return this.#closedOrMerged(mission, task, pr, existing.mergedAt === null ? existing : null);
    }
    const factory = await d.factory(mission.workspaceId);
    const record: MergeDecisionRecord = {
      id: ids.mergeDecision(), workspaceId: mission.workspaceId, missionId: mission.id, repo: pr.repo, prNumber: pr.number, headSha: pr.headSha,
      policyRef: factory.policyRef, verdict: 'ask', score: 0, allowed: null, wouldMerge: false, factors: [], reasons: [MERGED_BEFORE_DECISION], facts: {},
      decidedAt: this.deps.clock.now() as Timestamp, voidedAt: null, commentId: null,
      mergedAt: this.deps.clock.now() as Timestamp, mergedBy: by, mergeSha: pr.mergeSha,
    };
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, ...(task === null ? {} : { taskId: task.id }) };
    this.deps.recorder.deferred(() => d.unitOfWork.transaction(() => {
      d.mergeDecisions.create(record);
      this.deps.recorder.record(scope, { type: 'merge.merged', decisionId: record.id, mergeSha: pr.mergeSha ?? '', by });
    }));
    d.outcomes()?.merged(record, 'person');
    if (task !== null) this.#cancelCards(mission, task);
    this.deps.recorder.invalidate('ship', mission.id);
    return { kind: 'merged', reason };
  }

  /** CI failed on a pull request a wait step watched (#143): the same path as the ship step's own CI. */
  async ciFailed(mission: Mission, task: MissionTask, failing: { name: string; link: string | null; logTail: string | null }, head?: string): Promise<ShipOutcome> {
    if (this.deps.decide === undefined) return { kind: 'blocked', reason: `CI failed on ${failing.name}.` };
    return this.#ciFailed(mission, task, failing, head);
  }

  /** The pull request the mission's CI wait found, when that is how the mission got its pull request. */
  #found(mission: Mission): OpenedPullRequest | null {
    const opened = this.deps.opened?.(mission) ?? [];
    if (opened.some((o) => o.foundBy === null)) return null;
    return opened.at(-1) ?? null;
  }

  /** CI failed: the code step gets another round with the log tail, up to its attempts (§8.1 step 3). */
  async #ciFailed(mission: Mission, task: MissionTask, failing: { name: string; link: string | null; logTail: string | null }, head?: string): Promise<ShipOutcome> {
    const d = this.deps.decide!;
    // An agent's step: a wait or a person's step reads as `implement` by its role, but has no code to redo.
    const code = [...this.deps.tasks.listByMission(mission.id)].reverse()
      .find((t) => t.executor === 'agent' && (stepClassFor(t) === 'implement' || stepClassFor(t) === 'resolve_conflicts'));
    if (code === undefined || (code.round ?? 1) >= code.retryPolicy.maxAttempts) {
      return { kind: 'blocked', reason: `CI kept failing on ${failing.name}.` };
    }
    const tail = (failing.logTail ?? '').split('\n').slice(-SHIP_LOG_TAIL_LINES).join('\n');
    // The first line names the check and the commit, so the next failure can be told apart from this one.
    const headline = `CI failed: ${failing.name}${head === undefined ? '' : ` on commit ${head.slice(0, 7)}`}`;
    // The same check failing on the same commit as the last round: no new commit came of that round, so
    // another one would read the same red CI again. A person decides instead (#197).
    const last = [...(d.feedback?.listByTask(code.id) ?? [])].reverse().find((f) => f.text.startsWith('CI failed: '));
    if (head !== undefined && last !== undefined && last.text.split('\n')[0] === headline) {
      const reason = `CI failed again on ${failing.name}, on the same commit ${head.slice(0, 7)}: the last round pushed nothing new, so another round would read the same result.`;
      this.#ciRepeatCard(mission, task, failing, reason);
      return { kind: 'blocked', reason };
    }
    // #196: rounds per mission are capped (planner.yaml ci.maxRounds); past the cap a person decides.
    const cap = await this.#roundCap(mission);
    const done = missionRounds(this.deps.tasks.listByMission(mission.id));
    const allowed = cap + d.approvals.list({ missionId: mission.id })
      .filter((a) => a.kind === 'intervention' && a.status === 'APPROVED' && a.evidence.some((e) => e.label === ROUND_CAP_LABEL)).length;
    if (done >= allowed) {
      const reason = `CI failed on ${failing.name} again after ${done} rounds on this mission, the most it may take on its own (ci.maxRounds: ${cap} in planner.yaml).`;
      roundStopCard({ approvals: d.approvals, approvalFactory: d.approvalFactory, recorder: this.deps.recorder }, mission, task, {
        title: `${this.title(mission)}: CI still fails after ${done} rounds`, reason, failure: headline, cap, logTail: tail, link: failing.link,
      });
      return { kind: 'blocked', reason };
    }
    const note = `${headline}${tail.length > 0 ? `\n\n${tail}` : ''}`;
    const rounds = d.rounds();
    d.unitOfWork.transaction(() => {
      const item = rounds.record({ task: code, text: note, artifactId: null, authorId: RUNTIME_ACTOR, recordedBy: RUNTIME_ACTOR, status: 'open', round: code.round ?? 1 });
      rounds.beginRound({ task: code, feedbackIds: [item.id], downstream: 'redo', actorId: RUNTIME_ACTOR });
    });
    return { kind: 'reopened', reason: `CI failed on ${failing.name}; ${code.title.toLowerCase()} goes again with the log.` };
  }

  /** `ci.maxRounds` from the project's planner.yaml (#196); the default when it can't be read. */
  async #roundCap(mission: Mission): Promise<number> {
    try {
      return (await this.deps.decide?.factory(mission.workspaceId))?.planner.ci?.maxRounds ?? DEFAULT_MAX_ROUNDS;
    } catch {
      return DEFAULT_MAX_ROUNDS;
    }
  }

  /** Commits on `branch` beyond the remote's `base` (fetched first); null when that can't be read. */
  async #ahead(repository: Repository, base: string, branch: string): Promise<number | null> {
    await this.#git(repository, ['fetch', '--quiet', 'origin', base], true);
    const remote = await this.#git(repository, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], false);
    const from = remote.exitCode === 0 ? `refs/remotes/origin/${base}` : base;
    const count = await this.#git(repository, ['rev-list', '--count', `${from}..refs/heads/${branch}`], false);
    const n = Number.parseInt(count.stdout.trim(), 10);
    return count.exitCode === 0 && Number.isFinite(n) ? n : null;
  }

  /** A person chose on the "Review and merge" card (§8.1 step 6). */
  async personDecided(approval: Approval): Promise<void> {
    const d = this.deps.decide;
    if (d === undefined || approval.taskId === null || approval.missionId === null) return;
    const task = this.deps.tasks.get(approval.taskId);
    const mission = d.missions.get(approval.missionId);
    if (task === undefined || mission === undefined || task.executor !== 'ship') return;
    // Main broke after a merge: Revert is the person's call, never the daemon's (§8.7).
    const broke = approval.evidence.find((e) => e.label === 'Broke main')?.value;
    if (broke !== undefined) {
      if (approval.selectedOptionId === APPROVE_OPTION) await this.deps.revert?.(broke, approval.decidedBy ?? 'a person');
      return;
    }
    const decisionId = approval.evidence.find((e) => e.label === DECISION_LABEL)?.value;
    const decision = decisionId === undefined ? undefined : d.mergeDecisions.get(decisionId);
    const repository = mission.repositoryId === null ? undefined : this.deps.repositories.get(mission.repositoryId);
    if (decision === undefined || repository === undefined) return;
    if (approval.selectedOptionId === APPROVE_OPTION) {
      const outcome = await this.mergeDecided(mission, task, repository, decision, 'person', approval.decidedBy ?? 'a person');
      if (outcome.kind === 'merged') this.#status(mission, this.deps.tasks.get(task.id) ?? task, 'SUCCEEDED', outcome.reason, true);
      else if (outcome.kind === 'blocked') this.#status(mission, this.deps.tasks.get(task.id) ?? task, 'BLOCKED', outcome.reason);
      return;
    }
    this.#status(mission, task, 'AWAITING_EXTERNAL', WAITING_FOR_GITHUB_MERGE);
  }

  /**
   * Merges exactly the decided head (§8.5): `--match-head-commit`, so GitHub
   * refuses anything pushed after the decision. A refusal voids the decision
   * and the step checks again; a base that must be up to date is updated
   * first, which moves the head and so means a new decision.
   */
  protected async mergeDecided(mission: Mission, task: MissionTask, repository: Repository, decision: MergeDecisionRecord, by: 'auto' | 'person', member?: string): Promise<ShipOutcome> {
    const d = this.deps.decide!;
    const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id };
    const factory = await d.factory(mission.workspaceId);
    const pr = await this.deps.pullRequests.view(repository.path, decision.repo, decision.prNumber);
    if (pr.state !== 'OPEN') return this.#closedOrMerged(mission, task, pr, decision);
    if (pr.headSha !== decision.headSha) {
      // Changed since it was decided: void it and let the scheduler's next look check again.
      this.#void(mission, task, decision);
      this.#status(mission, task, 'AWAITING_EXTERNAL', 'Waiting for CI on the new commit.');
      return { kind: 'waiting' };
    }
    const protection = await this.deps.pullRequests.protection(repository.path, pr.repo, pr.baseBranch);
    if (protection.upToDate === true) {
      await this.#git(repository, ['fetch', '--quiet', 'origin', pr.baseBranch], true);
      const behind = await this.#git(repository, ['merge-base', '--is-ancestor', `origin/${pr.baseBranch}`, pr.headSha], false);
      if (behind.exitCode !== 0) {
        await this.deps.pullRequests.updateBranch(repository.path, pr.repo, pr.number);
        this.deps.recorder.note(scope, 'The base branch moved on, so the pull request was brought up to date; checking it again.');
        this.#status(mission, task, 'AWAITING_EXTERNAL', 'Waiting for CI after bringing the pull request up to date.');
        return { kind: 'waiting' };
      }
    }
    const settings = await this.deps.pullRequests.repoSettings(repository.path, pr.repo);
    const method = 'error' in factory.merge ? 'squash' : factory.merge.method;
    // GitHub's auto-merge waits only for required checks; with none it would merge at once, so it isn't used.
    const auto = settings.allowAutoMerge && protection.requiredChecks === true;
    const result = await this.deps.pullRequests.merge(repository.path, pr.repo, pr.number, {
      method, matchHeadCommit: decision.headSha, auto,
      subject: `${pr.title} (#${pr.number})`,
      body: squashTrailers(decision, { policyRef: decision.policyRef, mission: mission.issueLinkId ?? mission.id, by }),
    });
    if (result.refused !== null) {
      if (/head branch was modified|head commit/i.test(result.refused)) {
        this.#void(mission, task, decision);
        this.#status(mission, task, 'AWAITING_EXTERNAL', 'Waiting for CI on the new commit.');
        return { kind: 'waiting' };
      }
      // Watched, not blocked: GitHub may take it on a later look, or a person merges it there.
      this.#status(mission, task, 'AWAITING_EXTERNAL', `GitHub refused the merge (${result.refused}); Tandemise tries again, or you can merge it in GitHub.`);
      return { kind: 'waiting' };
    }
    const mergedBy = by === 'auto' ? 'tandemise' : (member ?? 'a person');
    if (result.queued) {
      d.mergeDecisions.update(decision.id, { mergedBy });
      this.#status(mission, task, 'AWAITING_EXTERNAL', 'GitHub merges it once its required checks pass.');
      const after = await this.deps.pullRequests.view(repository.path, pr.repo, pr.number);
      if (after.state === 'MERGED') return this.#closedOrMerged(mission, task, after, d.mergeDecisions.get(decision.id) ?? decision);
      return { kind: 'waiting' };
    }
    const after = await this.deps.pullRequests.view(repository.path, pr.repo, pr.number);
    return this.#recordMerged(mission, task, decision, after.mergeSha, mergedBy);
  }

  #recordMerged(mission: Mission, task: MissionTask, decision: MergeDecisionRecord, mergeSha: string | null, mergedBy: string): ShipOutcome {
    const d = this.deps.decide!;
    d.mergeDecisions.update(decision.id, { mergedAt: this.deps.clock.now() as Timestamp, mergedBy, mergeSha });
    this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id }, { type: 'merge.merged', decisionId: decision.id, mergeSha: mergeSha ?? '', by: mergedBy });
    d.outcomes()?.merged(decision, mergedBy === 'tandemise' ? 'tandemise' : 'person');
    this.#cancelCards(mission, task);
    this.deps.recorder.invalidate('ship', mission.id);
    return { kind: 'merged', reason: mergedBy === 'tandemise' ? `Merged on its own: risk score ${decision.score} of ${decision.allowed ?? 0} allowed.` : `Merged by you: risk score ${decision.score} of ${decision.allowed ?? 0}.` };
  }

  #pushedSha(mission: Mission, pr: PullRequestRef): string | null {
    return this.deps.pushedSha?.(mission, pr) ?? null;
  }

  #status(mission: Mission, task: MissionTask, status: TaskStatus, reason: string, finished = false): void {
    const current = this.deps.tasks.get(task.id) ?? task;
    if (current.status === status && current.statusReason === reason) return;
    this.deps.tasks.update(task.id, { status, statusReason: reason, ...(finished ? { finishedAt: this.deps.clock.now() } : {}) });
    this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id }, { type: 'task.status', from: current.status, to: status, reason });
    this.deps.recorder.invalidate('tasks', mission.id);
    this.deps.recorder.invalidate('ship', mission.id);
  }

  /** `<type>: <title>` from what is known before any commit is read: the item's prefix, its tracker type, the profile. */
  title(mission: Mission): string {
    const decision = this.deps.planDecisions.latest(mission.id);
    return prTitle({ type: decision?.profile.type ?? 'unknown' }, mission.title, { labelType: this.#trackerType(mission) });
  }

  /**
   * The pull request's title (#157): a Conventional Commit whose type is what
   * is known about the change: the item's own prefix, its tracker type or
   * labels, the planner's profile, then the agent's commits on `branch`; and
   * whose subject is the agent's commit subject when it wrote one. A
   * squash-merged repository makes this the commit on its default branch.
   */
  async titleFor(mission: Mission, repository: Repository, branch: string): Promise<string> {
    const decision = this.deps.planDecisions.latest(mission.id);
    return prTitle({ type: decision?.profile.type ?? 'unknown' }, mission.title, {
      labelType: this.#trackerType(mission),
      commits: await this.#agentCommits(repository, mission.baseBranch ?? repository.defaultBranch, branch),
    });
  }

  /** The tracker item's type (a YouTrack Bug), mapped as the shipped planner maps it. */
  #trackerType(mission: Mission): TaskType | null {
    const type = this.deps.prFacts?.(mission).trackerType ?? null;
    if (type === null) return null;
    const maps: Readonly<Record<string, TaskType>> = { ...SHIPPED_PLANNER.labels, ...SHIPPED_PLANNER.trackerTypes } as Readonly<Record<string, TaskType>>;
    const key = Object.keys(maps).find((k) => k.toLowerCase() === type.toLowerCase());
    return key === undefined ? null : maps[key]!;
  }

  /**
   * Subjects of the commits the agents made on `branch`, oldest first.
   * Tandemise's own commits (a step's leftovers, a salvage) carry a
   * `Tandemise-Run:` trailer and are left out, as are merges. The base is
   * the remote's copy when there is one, so a stale local default branch does
   * not add other people's commits.
   */
  async #agentCommits(repository: Repository, base: string, branch: string): Promise<string[]> {
    const remote = await this.#git(repository, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], false);
    const from = remote.exitCode === 0 ? `refs/remotes/origin/${base}` : base;
    const log = await this.#git(repository, [
      'log', '--no-merges', '--reverse', '--format=%s', '--invert-grep', '--grep=^Tandemise-Run:', `${from}..refs/heads/${branch}`,
    ], false);
    return log.exitCode === 0 ? log.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0) : [];
  }

  /**
   * What changed (the change set's headline and points), the issue it closes,
   * the Done-when table with a status that claims no more than happened, any
   * holds, and the plan's why (#113). `repo` is the pull request's `owner/repo`.
   */
  body(mission: Mission, repo: string | null = null): string {
    const decision = this.deps.planDecisions.latest(mission.id);
    const why = decision === undefined ? [] : [
      `${profileLine(decision.profile)}; ${decision.lane} lane.`,
      ...decision.modules.map((m) => `Added by the ${m} rule.`),
      ...decision.skipped,
    ];
    const facts = this.deps.prFacts?.(mission) ?? { summary: null, issue: null, holds: [], qaReported: false };
    const status = facts.qaReported
      ? 'Checked by QA: see its report on the mission'
      : facts.summary !== null ? 'Claimed by the agent, not independently verified' : 'Not verified';
    const criteria = this.deps.criteria.listActive(mission.id)
      .filter((c) => c.source !== 'spec' && c.status === 'accepted')
      .map((c) => ({ key: c.key, statement: c.statement, verified: c.source === 'implicit' ? 'Not independently verified' : status }));
    const issue = facts.issue === null ? null : { ...facts.issue, closes: repo === null ? null : closingLine(facts.issue.url, repo) };
    return prBody({ summary: facts.summary, issue, criteria, holds: facts.holds, why, missionId: mission.id });
  }

  /** The code step's branch: an implement or conflict step's, else the first that succeeded. */
  /**
   * The steps whose final commit `branch` does not contain (#138). A step's
   * final commit is the tip of its own branch now, not what its ChangeSet
   * recorded: a round can commit again without the report changing.
   */
  async missingUpstreamWork(mission: Mission, repository: Repository, branch: string): Promise<ReadonlyArray<{ taskKey: string; commit: string }>> {
    const missing: { taskKey: string; commit: string }[] = [];
    for (const step of this.deps.integration.branchesFor(mission)) {
      if (step.branch === branch) continue;
      const tip = await this.#git(repository, ['rev-parse', '--verify', `refs/heads/${step.branch}^{commit}`], false);
      if (tip.exitCode !== 0) continue;
      const commit = tip.stdout.trim();
      const held = await this.#git(repository, ['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`], false);
      if (held.exitCode !== 0) missing.push({ taskKey: step.taskKey, commit });
    }
    return missing;
  }

  /** A card on the step that read CI: look again (after a push or a re-run on GitHub), or leave it blocked. */
  #ciRepeatCard(mission: Mission, task: MissionTask, failing: { name: string; link: string | null }, reason: string): void {
    const d = this.deps.decide;
    if (d === undefined || d.approvals.pendingForTask(task.id).length > 0) return;
    const card = d.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, kind: 'intervention', risk: 'read',
      title: `${this.title(mission)}: CI fails the same way again`,
      rationale: reason,
      effect: 'Retry reads CI again, for example after you push a fix or re-run the check on GitHub. Leaving it blocked stops here.',
      evidence: [
        { kind: 'text', label: 'Why it stopped', value: reason },
        ...(failing.link === null ? [] : [{ kind: 'link' as const, label: failing.name, value: failing.link }]),
      ],
      options: [{ id: APPROVE_OPTION, label: 'Retry' }, { id: REJECT_OPTION, label: 'Leave blocked' }],
      recommendedOptionId: null,
      addressees: mission.createdBy === null || mission.createdBy === undefined ? [] : [mission.createdBy],
    });
    d.approvals.create(card);
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  /** A card on the ship step: retry once the branch holds the work, or leave it. */
  #missingWorkCard(mission: Mission, task: MissionTask, reason: string): void {
    const d = this.deps.decide;
    if (d === undefined || d.approvals.pendingForTask(task.id).length > 0) return;
    const card = d.approvalFactory.createOrThrow({
      workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, kind: 'intervention', risk: 'read',
      title: `${this.title(mission)}: the branch to ship is missing work`,
      rationale: reason,
      effect: 'Retry opens the pull request again once the branch holds every step\'s final commit. Leaving it blocked stops here.',
      evidence: [{ kind: 'text', label: 'Why it stopped', value: reason }],
      options: [{ id: APPROVE_OPTION, label: 'Retry' }, { id: REJECT_OPTION, label: 'Leave blocked' }],
      recommendedOptionId: null,
      addressees: mission.createdBy === null || mission.createdBy === undefined ? [] : [mission.createdBy],
    });
    d.approvals.create(card);
    this.deps.recorder.invalidate('approvals', mission.id);
  }

  #codeBranch(mission: Mission): string | null {
    const branches = this.deps.integration.branchesFor(mission);
    const tasks = this.deps.tasks.listByMission(mission.id);
    const code = branches.find((b) => {
      const t = tasks.find((x) => x.key === b.taskKey);
      return t !== undefined && (t.stepClass === 'implement' || t.stepClass === 'resolve_conflicts' || t.roleId === 'development');
    });
    return (code ?? branches[0])?.branch ?? null;
  }

  protected async git(repository: Repository, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.#git(repository, args, false);
  }

  async #git(repository: Repository, args: readonly string[], credentials: boolean): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (this.deps.exec === null) return { exitCode: 1, stdout: '', stderr: 'no git runner here' };
    return this.deps.exec.run({
      command: 'git',
      args,
      cwd: repository.path,
      timeoutMs: PUSH_TIMEOUT_MS,
      // A remote that asks for a password has no one to ask here; it fails instead of hanging.
      env: { GIT_TERMINAL_PROMPT: '0', ...(credentials ? this.deps.credentialEnv?.() ?? {} : {}) },
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // The abort listener goes when the sleep ends either way: a long CI wait adds one per poll otherwise.
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'git failed';
}
