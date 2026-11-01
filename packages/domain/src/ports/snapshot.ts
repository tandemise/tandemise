/**
 * A GitHub pull request read for a hand-back link (spec A4). Only what a
 * hand-back needs: the diff and body become the pinned Evidence's content,
 * and the head ref becomes the `git.branch` / `git.commit` refs downstream
 * review and QA read.
 */
export interface PullRequestSnapshot {
  readonly url: string;
  readonly number: number;
  readonly repo: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly title: string;
  readonly body: string;
  readonly diff: string;
}

/**
 * Resolves a link handed back into the pull request it points to.
 *
 * One implementation shells out to `gh pr view` / `gh pr diff`
 * (integration-github); a stub used in tests returns canned snapshots.
 */
export interface PullRequestSnapshotPort {
  /** null when the URL is not a GitHub PR this machine can read. Never throws for "not mine". */
  read(url: string, cwd: string): Promise<PullRequestSnapshot | null>;
}

/**
 * A pull request the ship step opened (#53 §8). Everything here is measured by
 * GitHub through `gh`; nothing is text an agent wrote about its work.
 */
export interface PullRequestRef {
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly isDraft: boolean;
  /** Set once merged: who merged it and the commit it made on the base. */
  readonly mergedBy: string | null;
  readonly mergeSha: string | null;
}

export interface PullRequestChecks {
  /** PASS only when every check finished green and there is at least one; NONE when there are none. */
  readonly state: 'PASS' | 'FAIL' | 'PENDING' | 'NONE';
  readonly done: number;
  readonly total: number;
  readonly failing: readonly { readonly name: string; readonly link: string | null; readonly logTail: string | null }[];
  /** Every check run on the commit, by name; optional for readers built before the merge watch needed it. */
  readonly runs?: readonly CheckRunSummary[];
}

/** One check run or Actions job: done or not, and whether it passed. */
export interface CheckRunSummary {
  readonly name: string;
  /** null while it runs. */
  readonly passed: boolean | null;
  readonly link: string | null;
}

/** One GitHub Actions workflow run on a commit, with its jobs. */
export interface WorkflowRunSummary {
  readonly id: number;
  /** The workflow's name, as GitHub shows it. */
  readonly workflow: string;
  /** `.github/workflows/ci.yml`, or `dynamic/…` for Dependabot and code scanning. */
  readonly path: string;
  /** What triggered it: `push`, `pull_request`, `dynamic`, `schedule`, … */
  readonly event: string;
  readonly headBranch: string | null;
  /** null while it runs. */
  readonly passed: boolean | null;
  readonly link: string | null;
  readonly jobs: readonly CheckRunSummary[];
}

export interface PullRequestPort {
  /** Idempotent by head branch: an open or merged pull request for it is returned, not opened again. */
  open(input: { readonly cwd: string; readonly repo: string; readonly head: string; readonly base: string; readonly title: string; readonly body: string }): Promise<PullRequestRef & { readonly created: boolean }>;
  view(cwd: string, repo: string, number: number): Promise<PullRequestRef>;
  /** Every pull request for a head branch, closed ones too, with its body: how a proposal's history is read. */
  listByHead(cwd: string, repo: string, head: string): Promise<readonly (PullRequestRef & { readonly body: string })[]>;
  /** Check runs on one commit: a pull request's head, or a merge commit on the base. */
  checks(cwd: string, repo: string, sha: string): Promise<PullRequestChecks>;
  /** A branch with no protection is `false` everywhere; null is "could not tell". */
  protection(cwd: string, repo: string, branch: string): Promise<{ readonly requiredChecks: boolean | null; readonly reviewRequired: boolean | null; readonly upToDate: boolean | null }>;
  /** Posts, or edits in place when `existingId` is set. */
  comment(cwd: string, repo: string, number: number, body: string, existingId: number | null): Promise<{ readonly id: number }>;
  requestReviewers(cwd: string, repo: string, number: number, reviewers: readonly string[]): Promise<void>;
  reviews(cwd: string, repo: string, number: number): Promise<readonly { readonly state: string; readonly author: string }[]>;
  /** Always bound to the decided head: GitHub refuses it if the head moved. */
  merge(cwd: string, repo: string, number: number, opts: {
    readonly method: 'squash' | 'merge' | 'rebase'; readonly matchHeadCommit: string; readonly auto: boolean; readonly subject: string; readonly body: string;
  }): Promise<{ readonly merged: boolean; readonly queued: boolean; readonly refused: string | null }>;
  updateBranch(cwd: string, repo: string, number: number): Promise<void>;
  /** Cancels a merge queued with `--auto`, so a decision voided or a kill switch takes effect on GitHub too. */
  disableAutoMerge(cwd: string, repo: string, number: number): Promise<void>;
  repoSettings(cwd: string, repo: string): Promise<{ readonly allowAutoMerge: boolean }>;
  /** The Actions workflow runs on one commit, with their jobs (#186). */
  workflowRuns(cwd: string, repo: string, sha: string): Promise<readonly WorkflowRunSummary[]>;
  /** A commit's first parent: on a merge commit on main, the main it was merged into. */
  parentOf(cwd: string, repo: string, sha: string): Promise<string | null>;
  /** Commit subjects on a branch since a time, newest first: how a revert by someone else is seen. */
  commits(cwd: string, repo: string, branch: string, sinceIso: string): Promise<readonly { readonly sha: string; readonly subject: string }[]>;
}
