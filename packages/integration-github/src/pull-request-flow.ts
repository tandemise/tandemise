import { z } from 'zod';
import type { PullRequestChecks, PullRequestPort, PullRequestRef } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import { TandemiseError } from '@tandemise/shared';
import { gh, ghJson, type GhContext } from './gh.js';

/**
 * The ship step's pull requests (#53 §8), through `gh` as every GitHub call
 * is: Tandemise stores no GitHub credential and uses the starting member's own
 * `gh` session. Merging is always bound to the decided head commit with
 * `--match-head-commit`, so GitHub itself refuses a merge of anything pushed
 * after the decision.
 */
const PR_FIELDS = 'number,url,title,headRefOid,headRefName,baseRefName,state,isDraft,mergedBy,mergeCommit';

const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string().optional(),
  headRefOid: z.string().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  mergedBy: z.object({ login: z.string() }).nullable().optional(),
  mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
});

/** At most this many pages of 100 check runs are read. */
const CHECK_PAGES = 10;

/** Lines of a failing check's output kept for the round's note. */
const LOG_TAIL_LINES = 40;

function toRef(repo: string, pr: z.infer<typeof prSchema>): PullRequestRef {
  const state = pr.state.toUpperCase();
  return {
    repo,
    number: pr.number,
    url: pr.url,
    title: pr.title ?? '',
    headSha: pr.headRefOid ?? '',
    headBranch: pr.headRefName ?? '',
    baseBranch: pr.baseRefName ?? '',
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    isDraft: pr.isDraft ?? false,
    mergedBy: pr.mergedBy?.login ?? null,
    mergeSha: pr.mergeCommit?.oid ?? null,
  };
}

export class GhPullRequestFlow implements PullRequestPort {
  constructor(private readonly exec: CommandExecutor) {}

  #ctx(cwd: string): GhContext {
    return { exec: this.exec, workingDirectory: cwd };
  }

  async open(input: { cwd: string; repo: string; head: string; base: string; title: string; body: string }): Promise<PullRequestRef & { created: boolean }> {
    const existing = await this.#byHead(input.cwd, input.repo, input.head);
    if (existing !== null) return { ...existing, created: false };
    await gh(this.#ctx(input.cwd), [
      'pr', 'create', '--repo', input.repo, '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', '-',
    ], { stdin: input.body });
    const made = await this.#byHead(input.cwd, input.repo, input.head);
    if (made === null) throw new TandemiseError('INTEGRATION_FAILED', `gh opened a pull request for ${input.head}, but it can't be found.`);
    return { ...made, created: true };
  }

  async #byHead(cwd: string, repo: string, head: string): Promise<PullRequestRef | null> {
    const rows = await ghJson(this.#ctx(cwd), ['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--json', PR_FIELDS], z.array(prSchema));
    const live = rows.map((r) => toRef(repo, r)).filter((r) => r.state !== 'CLOSED').sort((a, b) => b.number - a.number);
    return live[0] ?? null;
  }

  async listByHead(cwd: string, repo: string, head: string): Promise<readonly (PullRequestRef & { body: string })[]> {
    const rows = await ghJson(this.#ctx(cwd), ['pr', 'list', '--repo', repo, '--head', head, '--state', 'all', '--json', `${PR_FIELDS},body`], z.array(prSchema.extend({ body: z.string().optional() })));
    return rows.map((r) => ({ ...toRef(repo, r), body: r.body ?? '' }));
  }

  async view(cwd: string, repo: string, number: number): Promise<PullRequestRef> {
    return toRef(repo, await ghJson(this.#ctx(cwd), ['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS], prSchema));
  }

  /**
   * Everything GitHub says about a commit's CI: check runs (every page), check
   * suites that haven't produced their runs yet (a workflow queued), and
   * commit statuses from older integrations. PASS only when all are done and
   * green and there is at least one; NONE only when there is nothing at all.
   */
  async checks(cwd: string, repo: string, sha: string): Promise<PullRequestChecks> {
    const runSchema = z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      details_url: z.string().nullable().optional(),
      output: z.object({ summary: z.string().nullable().optional(), text: z.string().nullable().optional() }).nullable().optional(),
    }).passthrough();
    const all: z.infer<typeof runSchema>[] = [];
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const res = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`], z.object({
        total_count: z.number().optional(),
        check_runs: z.array(runSchema).optional(),
      }));
      const runs = res.check_runs ?? [];
      all.push(...runs);
      if (runs.length < 100 || (res.total_count !== undefined && all.length >= res.total_count)) break;
    }
    const suites = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}/commits/${sha}/check-suites?per_page=100`], z.object({
      check_suites: z.array(z.object({ status: z.string().nullable().optional(), latest_check_runs_count: z.number().optional(), app: z.object({ slug: z.string().optional() }).nullable().optional() }).passthrough()).optional(),
    })).catch(() => ({ check_suites: [] }));
    // A suite still waiting to create its runs (a workflow just queued) keeps CI pending. Suites of apps with no
    // runs at all stay queued forever, so only GitHub Actions' or ones that already have runs count.
    const waitingSuites = (suites.check_suites ?? []).filter((s) => (s.status ?? '').toLowerCase() !== 'completed'
      && ((s.latest_check_runs_count ?? 0) > 0 || s.app?.slug === 'github-actions')).length;
    const status = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}/commits/${sha}/status`], z.object({
      statuses: z.array(z.object({ context: z.string(), state: z.string(), target_url: z.string().nullable().optional(), description: z.string().nullable().optional() }).passthrough()).optional(),
    })).catch(() => ({ statuses: [] }));
    const statuses = status.statuses ?? [];
    const done = all.filter((r) => r.status.toLowerCase() === 'completed');
    const failingRuns = done.filter((r) => !['success', 'neutral', 'skipped'].includes((r.conclusion ?? '').toLowerCase()));
    const failingStatuses = statuses.filter((s) => s.state === 'failure' || s.state === 'error');
    const pendingStatuses = statuses.filter((s) => s.state === 'pending');
    const total = all.length + statuses.length;
    const finished = done.length + statuses.length - pendingStatuses.length;
    const failing = [
      ...failingRuns.map((r) => {
        const text = [r.output?.summary, r.output?.text].filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
        return { name: r.name, link: r.details_url ?? null, logTail: text.length === 0 ? null : text.split('\n').slice(-LOG_TAIL_LINES).join('\n') };
      }),
      ...failingStatuses.map((s) => ({ name: s.context, link: s.target_url ?? null, logTail: s.description ?? null })),
    ];
    const state: PullRequestChecks['state'] = total === 0 && waitingSuites === 0 ? 'NONE'
      : failing.length > 0 ? 'FAIL'
        : finished < total || waitingSuites > 0 ? 'PENDING' : 'PASS';
    return { state, done: finished, total: total + waitingSuites, failing };
  }

  /**
   * What the base branch requires, from classic branch protection and from
   * rulesets. Classic protection answering 404 means "none of that kind"; only
   * when the rulesets API also answers is the branch known to be unprotected.
   * Anything that can't be read is null, which never passes a rule (it asks).
   */
  async protection(cwd: string, repo: string, branch: string): Promise<{ requiredChecks: boolean | null; reviewRequired: boolean | null; upToDate: boolean | null }> {
    const unknown = { requiredChecks: null, reviewRequired: null, upToDate: null };
    const classic = await gh(this.#ctx(cwd), ['api', `repos/${repo}/branches/${branch}/protection`], { tolerateExitCodes: [1] });
    let fromClassic: { requiredChecks: boolean; reviewRequired: boolean; upToDate: boolean } | null = null;
    if (classic.exitCode === 0) {
      try {
        const p = JSON.parse(classic.stdout) as {
          required_status_checks?: { strict?: boolean; contexts?: string[]; checks?: unknown[] } | null;
          required_pull_request_reviews?: { required_approving_review_count?: number } | null;
        };
        const checks = p.required_status_checks ?? null;
        fromClassic = {
          requiredChecks: checks !== null && ((checks.contexts?.length ?? 0) + (checks.checks?.length ?? 0)) > 0,
          reviewRequired: (p.required_pull_request_reviews?.required_approving_review_count ?? (p.required_pull_request_reviews ? 1 : 0)) > 0,
          upToDate: checks?.strict === true,
        };
      } catch {
        return unknown;
      }
    } else if (!/404|Not Found|not protected/i.test(`${classic.stderr}${classic.stdout}`)) {
      return unknown;
    }
    const rules = await gh(this.#ctx(cwd), ['api', `repos/${repo}/rules/branches/${branch}`], { tolerateExitCodes: [1] });
    // Rulesets unreadable: a requirement classic protection already sets holds; one it doesn't could still be set by a ruleset.
    const tightenable = (c: { requiredChecks: boolean; reviewRequired: boolean; upToDate: boolean }) => ({
      requiredChecks: c.requiredChecks ? true : null, reviewRequired: c.reviewRequired ? true : null, upToDate: c.upToDate ? true : null,
    });
    if (rules.exitCode !== 0) return fromClassic === null ? unknown : tightenable(fromClassic);
    let list: { type?: string; parameters?: Record<string, unknown> }[];
    try {
      list = JSON.parse(rules.stdout) as typeof list;
    } catch {
      return fromClassic === null ? unknown : tightenable(fromClassic);
    }
    const review = list.some((r) => r.type === 'pull_request' && Number(r.parameters?.['required_approving_review_count'] ?? 0) > 0);
    const statusRule = list.find((r) => r.type === 'required_status_checks');
    return {
      requiredChecks: (fromClassic?.requiredChecks ?? false) || statusRule !== undefined,
      reviewRequired: (fromClassic?.reviewRequired ?? false) || review,
      upToDate: (fromClassic?.upToDate ?? false) || statusRule?.parameters?.['strict_required_status_checks_policy'] === true,
    };
  }

  async comment(cwd: string, repo: string, number: number, body: string, existingId: number | null): Promise<{ id: number }> {
    const args = existingId === null
      ? ['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]
      : ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existingId}`, '-f', `body=${body}`];
    return ghJson(this.#ctx(cwd), args, z.object({ id: z.number() }).passthrough());
  }

  async requestReviewers(cwd: string, repo: string, number: number, reviewers: readonly string[]): Promise<void> {
    if (reviewers.length === 0) return;
    await gh(this.#ctx(cwd), ['pr', 'edit', String(number), '--repo', repo, ...reviewers.flatMap((r) => ['--add-reviewer', r])]);
  }

  async reviews(cwd: string, repo: string, number: number): Promise<readonly { state: string; author: string }[]> {
    const view = await ghJson(this.#ctx(cwd), ['pr', 'view', String(number), '--repo', repo, '--json', 'reviews'], z.object({
      reviews: z.array(z.object({ state: z.string(), author: z.object({ login: z.string() }).nullable().optional() })).optional(),
    }));
    return (view.reviews ?? []).map((r) => ({ state: r.state, author: r.author?.login ?? '' }));
  }

  async merge(cwd: string, repo: string, number: number, opts: { method: 'squash' | 'merge' | 'rebase'; matchHeadCommit: string; auto: boolean; subject: string; body: string }): Promise<{ merged: boolean; queued: boolean; refused: string | null }> {
    const result = await gh(this.#ctx(cwd), [
      'pr', 'merge', String(number), '--repo', repo, `--${opts.method}`, '--match-head-commit', opts.matchHeadCommit,
      ...(opts.auto ? ['--auto'] : []), '--subject', opts.subject, '--body', opts.body,
    ], { tolerateExitCodes: [1] });
    if (result.exitCode !== 0) return { merged: false, queued: false, refused: (result.stderr || result.stdout).split('\n')[0] ?? 'refused' };
    return { merged: !opts.auto, queued: opts.auto, refused: null };
  }

  async disableAutoMerge(cwd: string, repo: string, number: number): Promise<void> {
    await gh(this.#ctx(cwd), ['pr', 'merge', String(number), '--repo', repo, '--disable-auto']);
  }

  async updateBranch(cwd: string, repo: string, number: number): Promise<void> {
    await gh(this.#ctx(cwd), ['pr', 'update-branch', String(number), '--repo', repo]);
  }

  async repoSettings(cwd: string, repo: string): Promise<{ allowAutoMerge: boolean }> {
    // The REST field, not `gh repo view --json autoMergeAllowed`: that JSON field is not in
    // every gh release (2.103 refuses it), and a refused read must never stop an approved merge.
    const view = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}`], z.object({ allow_auto_merge: z.boolean().optional() }).passthrough());
    return { allowAutoMerge: view.allow_auto_merge === true };
  }

  async commits(cwd: string, repo: string, branch: string, sinceIso: string): Promise<readonly { sha: string; subject: string }[]> {
    const rows = await ghJson(this.#ctx(cwd), ['api', `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(sinceIso)}&per_page=100`], z.array(z.object({
      sha: z.string(), commit: z.object({ message: z.string() }),
    }).passthrough()));
    return rows.map((r) => ({ sha: r.sha, subject: r.commit.message.split('\n')[0] ?? '' }));
  }
}
