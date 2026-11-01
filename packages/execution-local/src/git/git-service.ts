import { dirname } from 'node:path';
import {
  TandemiseError,
  type Logger,
  type Timestamp,
} from '@tandemise/shared';
import type { ExecResult, ProcessSupervisor, WorkAttribution } from '@tandemise/execution-core';
import type {
  GitCommitResult,
  GitCommitSummary,
  GitDiffStat,
  GitFileChange,
  GitStatus,
  GitStatusEntry,
  GitWorktreeEntry,
  MergeResult,
} from './types.js';

/** ASCII unit separator: cannot occur in a git ref, name or subject line. */
const UNIT = '\u001f';

/**
 * Git through the `git` CLI, never through a library.
 *
 * Writes especially: a library reimplementation of index/merge/worktree
 * semantics is a source of subtle corruption, and the CLI is also what the user
 * will reach for to inspect and undo whatever Tandemise did. Every invocation
 * goes through the ProcessSupervisor, so git inherits the same environment
 * control, timeouts and cancellation as any other child process.
 */
export class GitService {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly logger: Logger,
  ) {}

  async status(cwd: string): Promise<GitStatus> {
    const [branch, out] = await Promise.all([
      this.currentBranch(cwd),
      this.#must(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const entries = parseStatus(out);
    return { branch, entries, clean: entries.length === 0 };
  }

  /** Null when HEAD is detached. */
  async currentBranch(cwd: string): Promise<string | null> {
    const name = (await this.#must(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return name === 'HEAD' ? null : name;
  }

  /**
   * The branch a worktree should be based on when nothing else says otherwise:
   * the remote's published HEAD if there is one, else a conventional local
   * branch, else whatever is checked out.
   */
  async defaultBranch(cwd: string): Promise<string> {
    const remote = await this.#git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (remote.exitCode === 0) {
      const short = remote.stdout.trim().replace(/^origin\//, '');
      if (short) return short;
    }
    for (const candidate of ['main', 'master']) {
      const found = await this.#git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      if (found.exitCode === 0) return candidate;
    }
    const current = await this.currentBranch(cwd);
    if (current) return current;
    throw new TandemiseError('PRECONDITION_FAILED', `Cannot determine a default branch in ${cwd}`);
  }

  async isClean(cwd: string): Promise<boolean> {
    return (await this.#must(cwd, ['status', '--porcelain', '-z'])).trim().length === 0;
  }

  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    return !(await this.isClean(cwd));
  }

  /** Resolved object id, or null when the revision does not exist. */
  async revParse(cwd: string, rev = 'HEAD'): Promise<string | null> {
    const result = await this.#git(cwd, ['rev-parse', '--verify', '--quiet', rev]);
    const hash = result.stdout.trim();
    return result.exitCode === 0 && hash ? hash : null;
  }

  async log(cwd: string, limit = 20, rev = 'HEAD'): Promise<readonly GitCommitSummary[]> {
    const format = ['%H', '%an', '%ae', '%aI', '%s'].join(UNIT);
    const result = await this.#git(cwd, ['log', `--max-count=${limit}`, `--pretty=format:${format}`, rev]);
    if (result.exitCode !== 0) return []; // an unborn branch has no log; not an error
    return result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [hash = '', author = '', email = '', date = '', ...rest] = line.split(UNIT);
        return { hash, author, email, date: date as Timestamp, subject: rest.join(UNIT) };
      });
  }

  /** Unified patch text. `threeDot` compares against the merge base instead. */
  async diff(
    cwd: string,
    base: string,
    head?: string,
    options: { threeDot?: boolean; paths?: readonly string[] } = {},
  ): Promise<string> {
    return this.#must(cwd, [
      'diff', '--no-color',
      ...revRange(base, head, options.threeDot),
      ...pathArgs(options.paths),
    ]);
  }

  async diffStat(cwd: string, base: string, head?: string): Promise<GitDiffStat> {
    const out = await this.#must(cwd, ['diff', '--numstat', ...revRange(base, head)]);
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [added = '', removed = ''] = line.split('\t');
      filesChanged += 1;
      // A binary file reports '-' for both counts.
      insertions += Number.parseInt(added, 10) || 0;
      deletions += Number.parseInt(removed, 10) || 0;
    }
    return { filesChanged, insertions, deletions };
  }

  async diffNameStatus(cwd: string, base: string, head?: string): Promise<readonly GitFileChange[]> {
    const out = await this.#must(cwd, ['diff', '--name-status', '-z', ...revRange(base, head)]);
    return parseNameStatus(out);
  }

  /** Paths differing from HEAD in the working tree, including untracked files. */
  async listChangedFiles(cwd: string): Promise<readonly string[]> {
    const { entries } = await this.status(cwd);
    return entries.map((e) => e.path);
  }

  async addWorktree(
    repoPath: string,
    worktreePath: string,
    branch: string,
    base: string,
    options: { createBranch?: boolean } = {},
  ): Promise<void> {
    const args = (options.createBranch ?? true)
      ? ['worktree', 'add', '-b', branch, worktreePath, base]
      : ['worktree', 'add', worktreePath, branch];
    await this.#must(repoPath, args);
  }

  async removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<void> {
    await this.#must(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
  }

  async listWorktrees(repoPath: string): Promise<readonly GitWorktreeEntry[]> {
    return parseWorktrees(await this.#must(repoPath, ['worktree', 'list', '--porcelain']));
  }

  /** Clears registrations whose directory disappeared - e.g. after a crash. */
  async pruneWorktrees(repoPath: string): Promise<void> {
    await this.#must(repoPath, ['worktree', 'prune']);
  }

  /**
   * The main working tree that owns `cwd`. Lets a worktree be released from its
   * persisted record alone, without also having to remember where it came from.
   */
  async mainWorktreePath(cwd: string): Promise<string> {
    const common = (await this.#must(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    return dirname(common);
  }

  async createBranch(cwd: string, name: string, base = 'HEAD'): Promise<void> {
    await this.#must(cwd, ['branch', '--', name, base]);
  }

  async checkout(cwd: string, ref: string): Promise<void> {
    // `--` ends option parsing: without it a ref whose name begins with a dash,
    // or which collides with a path in the tree, is reinterpreted by git as a
    // flag or a pathspec. Branch names here are derived from task titles, so
    // they are not fully under our control.
    await this.#must(cwd, ['checkout', ref, '--']);
  }

  async branchExists(cwd: string, name: string): Promise<boolean> {
    return (await this.revParse(cwd, `refs/heads/${name}`)) !== null;
  }

  /**
   * Stages everything and commits, attributing the work to the role and run
   * that produced it. Returns `committed: false` for an unchanged tree rather
   * than failing: "nothing to commit" is a normal outcome for a review task.
   */
  async commitAll(cwd: string, message: string, author: WorkAttribution): Promise<GitCommitResult> {
    await this.#must(cwd, ['add', '--all']);
    if (await this.isClean(cwd)) return { committed: false, hash: null };
    const result = await this.#git(cwd, [
      '-c', `user.name=${author.name}`,
      '-c', `user.email=${author.email}`,
      // Signing would block on a passphrase prompt no one is there to answer.
      '-c', 'commit.gpgsign=false',
      'commit',
      '--author', `${author.name} <${author.email}>`,
      '--message', withTrailers(message, author),
    ]);
    if (result.exitCode !== 0) throw gitFailed(cwd, ['commit'], result);
    const hash = await this.revParse(cwd, 'HEAD');
    this.logger.info('git.committed', { cwd, hash: hash ?? undefined, role: author.roleId, runId: author.runId });
    return { committed: true, hash };
  }

  /**
   * Merges `branch` into the current branch. Conflicts are reported, never
   * resolved and never aborted here: the caller decides whether to raise a
   * conflict-resolution task or roll back (MVP.md §11.3).
   */
  async merge(
    cwd: string,
    branch: string,
    options: { noFf?: boolean; message?: string } = {},
  ): Promise<MergeResult> {
    const before = await this.revParse(cwd, 'HEAD');
    const result = await this.#git(cwd, [
      '-c', 'commit.gpgsign=false',
      'merge',
      options.noFf === false ? '--ff' : '--no-ff',
      ...(options.message ? ['--message', options.message] : []),
      branch,
    ]);
    if (result.exitCode === 0) {
      const hash = (await this.revParse(cwd, 'HEAD')) ?? '';
      return { ok: true, hash, alreadyUpToDate: hash === before };
    }
    const conflicted = await this.#conflictedPaths(cwd);
    if (conflicted.length === 0) {
      // Not a conflict but a refusal (dirty tree, unknown ref, ...). Surface it.
      throw gitFailed(cwd, ['merge', branch], result);
    }
    this.logger.warn('git.merge_conflict', { cwd, branch, paths: conflicted.length });
    return { ok: false, conflictedPaths: conflicted, message: result.stdout.trim() || result.stderr.trim() };
  }

  async abortMerge(cwd: string): Promise<void> {
    await this.#must(cwd, ['merge', '--abort']);
  }

  async tag(cwd: string, name: string, message?: string): Promise<void> {
    const args = message
      ? ['-c', 'tag.gpgsign=false', 'tag', '--annotate', name, '--message', message]
      : ['tag', name];
    await this.#must(cwd, args);
  }

  /** Raw invocation, for the narrow cases a typed method would only obscure. */
  async run(cwd: string, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.#git(cwd, args, options);
  }

  async #conflictedPaths(cwd: string): Promise<readonly string[]> {
    const out = await this.#git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z']);
    return out.stdout.split('\0').filter((p) => p.length > 0);
  }

  async #git(cwd: string, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.supervisor.run({
      command: 'git',
      args: ['--no-pager', ...args],
      cwd,
      env: {
        // Never block a background process on an interactive credential prompt.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ADVICE: '0',
      },
      timeoutMs: options.timeoutMs ?? 120_000,
      label: `git ${args[0] ?? ''}`,
    });
  }

  async #must(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.#git(cwd, args);
    if (result.exitCode !== 0) throw gitFailed(cwd, args, result);
    return result.stdout;
  }
}

function gitFailed(cwd: string, args: readonly string[], result: ExecResult): TandemiseError {
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 5).join('; ');
  return new TandemiseError(
    result.timedOut ? 'TIMEOUT' : 'INTERNAL',
    `git ${args.join(' ')} failed (exit ${result.exitCode}): ${detail}`,
    { details: { cwd, args: [...args], exitCode: result.exitCode } },
  );
}

function revRange(base: string, head?: string, threeDot = false): string[] {
  if (!head) return [base];
  return threeDot ? [`${base}...${head}`] : [base, head];
}

function pathArgs(paths?: readonly string[]): string[] {
  return paths && paths.length > 0 ? ['--', ...paths] : [];
}

/** `git status --porcelain=v1 -z`: `XY path\0`, renames add `\0origPath`. */
function parseStatus(raw: string): readonly GitStatusEntry[] {
  const records = raw.split('\0').filter((r) => r.length > 0);
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const index = record[0] ?? ' ';
    const worktree = record[1] ?? ' ';
    let oldPath: string | null = null;
    if (index === 'R' || index === 'C') oldPath = records[++i] ?? null;
    entries.push({
      path: record.slice(3),
      oldPath,
      index,
      worktree,
      untracked: index === '?' && worktree === '?',
      conflicted:
        index === 'U' || worktree === 'U' ||
        (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D'),
    });
  }
  return entries;
}

/** `--name-status -z`: `status\0path\0`; renames and copies add a destination. */
function parseNameStatus(raw: string): readonly GitFileChange[] {
  const fields = raw.split('\0').filter((f) => f.length > 0);
  const changes: GitFileChange[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!;
    const first = fields[i + 1];
    if (first === undefined) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const destination = fields[i + 2];
      if (destination === undefined) break;
      changes.push({ status: status[0]!, path: destination, oldPath: first });
      i += 1;
    } else {
      changes.push({ status: status[0]!, path: first, oldPath: null });
    }
  }
  return changes;
}

function parseWorktrees(raw: string): readonly GitWorktreeEntry[] {
  const out: GitWorktreeEntry[] = [];
  let current: { -readonly [K in keyof GitWorktreeEntry]?: GitWorktreeEntry[K] } = {};
  const flush = (): void => {
    if (current.path === undefined) return;
    out.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
      locked: current.locked ?? false,
      prunable: current.prunable ?? false,
    });
    current = {};
  };
  for (const line of raw.split('\n')) {
    if (line === '') { flush(); continue; }
    const [key = '', ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') { flush(); current.path = value; }
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  flush();
  return out;
}

/**
 * Commit trailers that keep history attributable: which role produced the
 * change, under which task and run (MVP.md §P7).
 */
function withTrailers(message: string, author: WorkAttribution): string {
  const trailers = [
    author.roleId ? `Tandemise-Role: ${author.roleId}` : null,
    author.taskId ? `Tandemise-Task: ${author.taskId}` : null,
    author.runId ? `Tandemise-Run: ${author.runId}` : null,
    author.runtime ? `Tandemise-Runtime: ${author.runtime}` : null,
  ].filter((t): t is string => t !== null);
  return trailers.length === 0 ? message : `${message.trimEnd()}\n\n${trailers.join('\n')}\n`;
}
