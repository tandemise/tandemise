import type { Mission, PullRequestPort, PullRequestRef, Repository } from '@tandemise/domain';
import { githubRepoFromRemote } from '@tandemise/domain';

/**
 * A CI wait decided by its pull request (#143, #145).
 *
 * A planner writes a CI wait as `gh pr checks <branch>`, and a wait step ends
 * when that command exits 0. The exit code is a poor witness: `--required` on a
 * repository with no required checks exits 1 for ever, so does a repository
 * with no checks at all, and neither notices a pull request a person merged or
 * closed on GitHub. So when the command is a `gh pr checks` call and its pull
 * request can be found, the pull request's own state decides, read through the
 * GitHub integration on every look. The command stays the witness for every
 * other wait, and for a pull request this can't find.
 *
 * Decided on each look from what the task already stores, so a mission planned
 * before this existed recovers on the daemon's next poll, without a replan.
 */
export interface CiWaitTarget {
  /** The pull request's number, URL or head branch as the command names it; null names none. */
  readonly selector: string | null;
  /** `--repo owner/name`, when the command says. */
  readonly repo: string | null;
}

/** What a look at the pull request found. `unknown`: no pull request to read, so the command decides. */
export type PrWaitLook =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'pending'; readonly pr: PullRequestRef; readonly detail: string }
  | { readonly kind: 'passed'; readonly pr: PullRequestRef; readonly detail: string }
  | { readonly kind: 'failed'; readonly pr: PullRequestRef; readonly detail: string; readonly failing: CiFailure; readonly others: readonly CiFailure[] }
  | { readonly kind: 'merged'; readonly pr: PullRequestRef; readonly detail: string }
  | { readonly kind: 'closed'; readonly pr: PullRequestRef; readonly detail: string };

export interface CiFailure {
  readonly name: string;
  readonly link: string | null;
  readonly logTail: string | null;
}

/** A pull request the mission already knows of, from its `ship.pr_opened` events, oldest first. */
export interface KnownPullRequest {
  readonly repo: string;
  readonly number: number;
}

/** Flags of `gh pr checks` that take a value, so the value is not read as the selector. */
const VALUE_FLAGS = new Set(['-R', '--repo', '-i', '--interval', '--json', '-q', '--jq', '-t', '--template']);
const REPO_FLAGS = new Set(['-R', '--repo']);

/** `gh pr checks [<number> | <url> | <branch>] [flags]`, and nothing else: a pipe or a second command is the command's to decide. */
export function ciWaitTarget(command: string): CiWaitTarget | null {
  if (/[|;&<>`$()\n]/.test(command)) return null;
  const words = command.trim().split(/\s+/).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
  if (words[0] !== 'gh' || words[1] !== 'pr' || words[2] !== 'checks') return null;
  let selector: string | null = null;
  let repo: string | null = null;
  for (let i = 3; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      const name = eq === -1 ? word : word.slice(0, eq);
      const value = eq === -1 ? (VALUE_FLAGS.has(name) ? words[++i] : undefined) : word.slice(eq + 1);
      if (REPO_FLAGS.has(name) && value !== undefined && value.length > 0) repo = value;
      continue;
    }
    selector ??= word;
  }
  return { selector, repo };
}

export interface PullRequestWaitDeps {
  readonly pullRequests: Pick<PullRequestPort, 'view' | 'listByHead' | 'checks'>;
  /** The pull requests the mission already knows of (`ship.pr_opened`), oldest first. */
  readonly known: (mission: Mission) => readonly KnownPullRequest[];
  /** No checks right after a push is CI not started yet: waited for this long before it counts as none. */
  readonly graceMs: number;
}

export class PullRequestWait {
  constructor(private readonly deps: PullRequestWaitDeps) {}

  /**
   * One look. `waitedMs` is how long this wait has looked, for the grace;
   * `failedHead` is a head whose failure already sent the work back, so the
   * same red CI isn't sent back twice while the next commit is on its way;
   * `rerunHead` is a head whose pull request was just fixed (#194), whose red
   * checks are running again.
   */
  async look(input: {
    readonly mission: Mission;
    readonly target: CiWaitTarget;
    readonly repository: Repository | null;
    readonly waitedMs: number;
    readonly failedHead: string | null;
    readonly rerunHead?: string | null;
  }): Promise<PrWaitLook> {
    const { repository, target } = input;
    if (repository === null) return { kind: 'unknown' };
    const fromUrl = target.selector === null ? null : /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(target.selector);
    const repo = fromUrl?.[1] ?? target.repo ?? githubRepoFromRemote(repository.remoteUrl);
    if (repo === null) return { kind: 'unknown' };
    const pr = await this.#find(input.mission, repository, repo, target.selector, fromUrl === null ? null : Number(fromUrl[2]));
    if (pr === null) return { kind: 'unknown' };

    const name = `#${pr.number}`;
    if (pr.state === 'MERGED') return { kind: 'merged', pr, detail: `Merged in GitHub by ${pr.mergedBy ?? 'a person'}: ${pr.url}` };
    if (pr.state === 'CLOSED') {
      return { kind: 'closed', pr, detail: `Pull request ${name} was closed without merging: ${pr.url}. Reopen it on GitHub and retry this step, or cancel the mission.` };
    }
    const checks = await this.deps.pullRequests.checks(repository.path, pr.repo, pr.headSha);
    switch (checks.state) {
      case 'PASS':
        return { kind: 'passed', pr, detail: `Every check passed on ${name} (${checks.total} of ${checks.total}).` };
      case 'NONE':
        return input.waitedMs < this.deps.graceMs
          ? { kind: 'pending', pr, detail: `Waiting for checks to start on ${name}.` }
          : { kind: 'passed', pr, detail: `No checks reported on ${name}, so there is nothing to wait for.` };
      case 'FAIL': {
        const failing = checks.failing[0] ?? { name: 'a check', link: null, logTail: null };
        if (pr.headSha === (input.rerunHead ?? null)) {
          return { kind: 'pending', pr, detail: `Waiting for the checks to run again on ${name}.` };
        }
        if (pr.headSha === input.failedHead) {
          return { kind: 'pending', pr, detail: `CI failed on ${failing.name}; waiting for a new commit on ${name}.` };
        }
        return { kind: 'failed', pr, failing, others: checks.failing.slice(1), detail: `CI failed on ${name}: ${failing.name}.` };
      }
      case 'PENDING':
        // Before GitHub registers a check, "0 of 0 checks done" reads as if there were nothing to run (#194).
        return checks.registered === 0
          ? { kind: 'pending', pr, detail: `Waiting for checks to start on ${name}.` }
          : { kind: 'pending', pr, detail: `Waiting for CI on ${name} (${checks.done} of ${checks.total} checks done).` };
    }
  }

  async #find(mission: Mission, repository: Repository, repo: string, selector: string | null, urlNumber: number | null): Promise<PullRequestRef | null> {
    const number = urlNumber ?? (selector !== null && /^#?\d+$/.test(selector) ? Number(selector.replace('#', '')) : null);
    if (number !== null) return this.deps.pullRequests.view(repository.path, repo, number);
    if (selector !== null) {
      const all = await this.deps.pullRequests.listByHead(repository.path, repo, selector);
      // The open one if there is one; else the latest, merged or closed.
      const open = all.find((p) => p.state === 'OPEN');
      const latest = open ?? [...all].sort((a, b) => b.number - a.number)[0];
      if (latest !== undefined) return latest;
    }
    // No branch named, or nothing under it: the pull request the mission already knows of.
    const known = [...this.deps.known(mission)].reverse().find((k) => k.repo === repo);
    return known === undefined ? null : this.deps.pullRequests.view(repository.path, repo, known.number);
  }
}
