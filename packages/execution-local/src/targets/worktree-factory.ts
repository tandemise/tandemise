import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  TandemiseError,
  ids,
  slugify,
  systemClock,
  type Clock,
  type Logger,
  type MissionId,
} from '@tandemise/shared';
import type { ExecutionTargetRecord, TargetKind } from '@tandemise/domain';
import type {
  ExecutionTarget,
  ExecutionTargetFactory,
  ProcessSupervisor,
  ProvisionRequest,
  ReleaseOptions,
  ReleaseOutcome,
  TargetCapability,
} from '@tandemise/execution-core';
import type { GitService } from '../git/git-service.js';
import type { WorkspaceProvisioner } from '../workspace-provisioner.js';
import { DirectoryExecutionTarget } from './directory-target.js';

const CAPABILITIES: readonly TargetCapability[] = ['exec', 'filesystem', 'git', 'isolated-workspace'];

export interface WorktreeTargetDeps {
  readonly git: GitService;
  readonly supervisor: ProcessSupervisor;
  readonly provisioner: WorkspaceProvisioner;
  readonly log: Logger;
  readonly clock?: Clock;
}

/**
 * One git worktree and branch per code-writing task (MVP.md §11.2).
 *
 * Provisioning is idempotent on purpose. The daemon can die between creating a
 * worktree and recording it, so re-provisioning must converge on the existing
 * tree rather than failing or creating a second one - that is the difference
 * between a recoverable crash and a manual cleanup.
 */
/**
 * Directories worth carrying into a fresh worktree. Deliberately a short,
 * well-known list rather than "everything untracked": copying a build output or
 * a local database would be surprising, and the cost of a wrong guess is paid
 * on every task.
 */
const SEEDED_DEPENDENCY_DIRS = ['node_modules', '.venv', 'vendor/bundle'] as const;

/** How long fetching the base branch may take before the step starts from the clone's copy. */
const FETCH_TIMEOUT_MS = 60_000;

export class WorktreeTargetFactory implements ExecutionTargetFactory {
  readonly id = 'worktree';
  readonly displayName = 'Git worktree';
  readonly kind: TargetKind = 'worktree';
  readonly provides = [...CAPABILITIES];

  readonly #clock: Clock;

  constructor(private readonly deps: WorktreeTargetDeps) {
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Copies installed dependencies from the source checkout into a fresh
   * worktree.
   *
   * A git worktree contains only tracked files, so `node_modules` is absent and
   * every code task would otherwise begin with a full install - minutes each,
   * network-dependent, repeated per task. On APFS `cp -c` is a copy-on-write
   * clone: 26MB of `node_modules` takes ~40ms and costs no disk until something
   * diverges.
   *
   * A clone, not a symlink. Sharing the directory would let a worker's install
   * mutate the user's own checkout, which is exactly the thing worktree
   * isolation exists to prevent.
   *
   * Best effort throughout: a filesystem without clone support, or a source
   * that was never installed, simply means the task runs its own install.
   */
  async #seedDependencies(repositoryPath: string, directory: string): Promise<void> {
    const { log } = this.deps;
    for (const name of SEEDED_DEPENDENCY_DIRS) {
      const source = join(repositoryPath, name);
      const destination = join(directory, name);
      if (!existsSync(source) || existsSync(destination)) continue;
      const started = Date.now();
      try {
        // `-c` asks for a clone and falls back to a real copy where the
        // filesystem cannot clone; `-R` recurses; `-p` keeps modes.
        await this.deps.supervisor.spawn({
          command: 'cp',
          args: ['-c', '-Rp', source, destination],
          cwd: directory,
          label: `seed:${name}`,
        }).wait();
        log.debug('worktree.dependencies_seeded', { name, directory, ms: Date.now() - started });
      } catch (e) {
        log.debug('worktree.dependency_seed_failed', { name, directory, error: String(e) });
      }
    }
  }

  /**
   * Moves a task's branch onto its base's current head (#138). A worktree and
   * its branch outlive a run, so a step redone by a round would otherwise run
   * again on the commit it saw first: a review that reviews, and a QA that
   * verifies, code without the fix the round was for.
   */
  async #syncToBase(directory: string, branch: string, base: string): Promise<void> {
    const { git, log } = this.deps;
    const ancestor = async (a: string, b: string): Promise<boolean> =>
      (await git.run(directory, ['merge-base', '--is-ancestor', a, b])).exitCode === 0;
    if (await ancestor(base, 'HEAD')) return;
    if (await ancestor('HEAD', base)) {
      const ff = await git.run(directory, ['merge', '--ff-only', '--quiet', base]);
      if (ff.exitCode !== 0) {
        throw new TandemiseError('CONFLICT', `Could not move '${branch}' to the new work on '${base}': ${ff.stderr.trim() || ff.stdout.trim()}`, {
          details: { directory, branch, base },
        });
      }
      log.info('worktree.synced', { directory, branch, base, how: 'fast-forward' });
      return;
    }
    const merged = await git.run(directory, [
      '-c', 'user.name=Tandemise', '-c', 'user.email=factory@tandemise.local', '-c', 'commit.gpgsign=false',
      'merge', '--no-edit', '--quiet', base,
    ]);
    if (merged.exitCode !== 0) {
      await git.run(directory, ['merge', '--abort']);
      throw new TandemiseError('CONFLICT', `'${branch}' has its own commits that conflict with the new work on '${base}'; it cannot run on the old work.`, {
        details: { directory, branch, base },
      });
    }
    log.info('worktree.synced', { directory, branch, base, how: 'merge' });
  }

  /**
   * Where a new task branch is cut from (#167). The clone's local default
   * branch only moves when someone pulls it, so on a factory clone it can be
   * many commits behind what the pull request will merge into. With an
   * `origin`, fetch its copy of the branch and start from that, unless the
   * local branch already holds it (unpublished work on top of the remote is
   * kept). Offline, start from the local branch and say so on the target.
   */
  async #resolveStart(repositoryPath: string, base: string, fetch: boolean): Promise<{ ref: string; note: string | null }> {
    const { git, log } = this.deps;
    // A commit, not a branch (an eval case pins its base): nothing to fetch.
    if (/^[0-9a-f]{7,40}$/i.test(base)) return { ref: base, note: null };
    if ((await git.run(repositoryPath, ['remote', 'get-url', 'origin'])).exitCode !== 0) return { ref: base, note: null };
    let note: string | null = null;
    if (fetch) {
      const fetched = await git.run(repositoryPath, [
        'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`,
      ], { timeoutMs: FETCH_TIMEOUT_MS });
      if (fetched.exitCode !== 0) {
        const why = (fetched.stderr.trim() || fetched.stdout.trim()).split('\n')[0] ?? '';
        // The branch was never published: the local one is all there is.
        if (/couldn't find remote ref/i.test(why)) return { ref: base, note: null };
        note = `could not fetch origin/${base}, so this started from what the clone had: ${why.slice(0, 200)}`;
        log.warn('worktree.fetch_failed', { repositoryPath, base, error: why });
      }
    }
    const remoteRef = `origin/${base}`;
    const known = async (ref: string): Promise<boolean> =>
      (await git.run(repositoryPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).exitCode === 0;
    if (!(await known(`refs/remotes/${remoteRef}`))) return { ref: base, note };
    if (await known(`refs/heads/${base}`)) {
      const holdsRemote = await git.run(repositoryPath, ['merge-base', '--is-ancestor', `refs/remotes/${remoteRef}`, `refs/heads/${base}`]);
      if (holdsRemote.exitCode === 0) return { ref: base, note };
    }
    return { ref: remoteRef, note };
  }

  /**
   * Short, stable suffix from a task id. The full branded id is long and its
   * prefix is constant, so the tail carries the entropy.
   */
  static shortId(taskId: string): string {
    return taskId.slice(-8);
  }

  async provision(request: ProvisionRequest): Promise<ExecutionTarget> {
    const missionId = this.#requireMission(request);
    const { git, log } = this.deps;
    const repositoryPath = resolve(request.repositoryPath);

    // The slug carries the task id, not just the name. Two tasks called
    // "implement login" and "Implement Login!" slugify identically, and without
    // the id the second would silently adopt the first's worktree and branch -
    // exactly the concurrent-write collision MVP.md §11.2 exists to prevent.
    // The id is also what lets the reuse path below tell a crashed run of *this*
    // task apart from a live run of a different one.
    const slug = request.taskId ? `${slugify(request.name)}-${WorktreeTargetFactory.shortId(request.taskId)}` : slugify(request.name);
    const missionSlug = request.missionSlug ?? slugify(missionId);
    const branch = request.branch ?? `tandemise/${missionSlug}/${slug}`;
    const base = request.baseBranch ?? (await git.defaultBranch(repositoryPath));

    await this.deps.provisioner.ensureMission(request.workspaceId, missionId);
    const directory = this.deps.provisioner.paths.worktree(request.workspaceId, missionId, slug);

    // A crash can leave a registration pointing at a directory that is gone;
    // git refuses to reuse the path until the stale entry is pruned.
    await git.pruneWorktrees(repositoryPath);
    const existing = await this.#findWorktree(repositoryPath, directory);

    // #167: a step with nothing upstream starts from the remote's current
    // default branch. Only a new worktree fetches; a reused one keeps the
    // commit it was cut from. An upstream step's branch is the mission's own
    // local work, so it is used as it is.
    const start = request.syncToBase === true
      ? { ref: base, note: null }
      : await this.#resolveStart(repositoryPath, base, existing === undefined);

    if (existing) {
      if (existing.branch === null) {
        // A detached HEAD has no branch to commit onto, so release()'s salvage
        // commit would land unreachable and then be dropped by `worktree
        // remove` - silently losing the worker's uncommitted work. Refuse, and
        // let a human decide, rather than reuse a tree we cannot safely release.
        throw new TandemiseError('CONFLICT',
          `Worktree '${directory}' has a detached HEAD; refusing to reuse it because work committed there would be unreachable.`,
          { details: { directory, expected: branch } });
      }
      if (existing.branch !== branch) {
        throw new TandemiseError('CONFLICT', `Worktree '${directory}' already holds branch '${existing.branch}', not '${branch}'`, {
          details: { directory, expected: branch, actual: existing.branch },
        });
      }
      log.info('worktree.reused', { directory, branch });
    } else {
      await this.#clearEmptyDirectory(directory);
      const createBranch = !(await git.branchExists(repositoryPath, branch));
      await git.addWorktree(repositoryPath, directory, branch, start.ref, { createBranch });
      log.info('worktree.created', { directory, branch, base: start.ref, createBranch });
      await this.#seedDependencies(repositoryPath, directory);
    }

    if (request.syncToBase === true) await this.#syncToBase(directory, branch, base);

    const baseCommit = await git.revParse(repositoryPath, start.ref);
    const detail = baseCommit
      ? `base ${baseCommit}${start.ref !== base ? ` (${start.ref})` : ''}${start.note ? `; ${start.note}` : ''}`
      : start.note;
    const record: ExecutionTargetRecord = {
      id: request.id ?? ids.executionTarget(),
      workspaceId: request.workspaceId,
      missionId,
      taskId: request.taskId,
      kind: 'worktree',
      name: request.name,
      workingDirectory: directory,
      branch,
      // The ref the branch was cut from, so a diff against it (`base...HEAD`)
      // shows the step's own work and not the commits a stale local branch
      // lacks.
      baseBranch: start.ref,
      status: 'READY',
      detail,
      createdAt: this.#clock.now(),
      releasedAt: null,
    };
    return new DirectoryExecutionTarget({
      record,
      supervisor: this.deps.supervisor,
      log: this.deps.log,
      capabilities: CAPABILITIES,
    });
  }

  /**
   * Removes the worktree - but never at the cost of work. A dirty tree is
   * either committed to its own branch (when the caller supplies an identity to
   * attribute it to) or left exactly where it is with the reason reported.
   */
  async release(target: ExecutionTargetRecord, options: ReleaseOptions = {}): Promise<ReleaseOutcome> {
    const { git, log } = this.deps;
    const directory = target.workingDirectory;
    const outcome = (patch: Partial<ReleaseOutcome>): ReleaseOutcome => ({
      targetId: target.id,
      released: true,
      workingDirectory: directory,
      retainedReason: null,
      commit: null,
      ...patch,
    });

    if (!(await exists(directory))) return outcome({});

    const repositoryPath = await git.mainWorktreePath(directory);
    let commit: string | null = null;

    if (await git.hasUncommittedChanges(directory)) {
      const changed = await git.listChangedFiles(directory);
      if (options.commitLeftovers) {
        const message = options.commitMessage ?? `chore(tandemise): salvage work from ${target.name}`;
        commit = (await git.commitAll(directory, message, options.commitLeftovers)).hash;
        log.info('worktree.salvaged', { directory, commit: commit ?? undefined, files: changed.length });
      } else if (!options.force) {
        const retainedReason = `${changed.length} uncommitted path(s) on branch ${target.branch ?? 'unknown'}`;
        log.warn('worktree.retained', { directory, retainedReason, files: changed.slice(0, 20) });
        return outcome({ released: false, retainedReason });
      }
    }

    await git.removeWorktree(repositoryPath, directory, options.force ?? false);
    await git.pruneWorktrees(repositoryPath);
    log.info('worktree.removed', { directory, branch: target.branch ?? undefined });
    return outcome({ commit });
  }

  #requireMission(request: ProvisionRequest): MissionId {
    if (!request.missionId) {
      throw TandemiseError.validation('A worktree target requires a missionId: worktrees live under the mission', {
        name: request.name,
      });
    }
    return request.missionId;
  }

  async #findWorktree(repositoryPath: string, directory: string): Promise<{ branch: string | null } | undefined> {
    const wanted = await canonical(directory);
    for (const entry of await this.deps.git.listWorktrees(repositoryPath)) {
      if ((await canonical(entry.path)) === wanted) return entry;
    }
    return undefined;
  }

  /**
   * `git worktree add` refuses a non-empty directory. An empty one is the
   * residue of `ensureMission` or a half-finished provision and is safe to drop;
   * a non-empty unregistered directory is someone else's data and is not.
   */
  async #clearEmptyDirectory(directory: string): Promise<void> {
    if (!(await exists(directory))) return;
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new TandemiseError('CONFLICT', `'${directory}' already exists and is not a registered worktree`, {
        details: { directory, entries: entries.slice(0, 10) },
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** git reports resolved paths; on macOS `/tmp/x` and `/private/tmp/x` are one. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
