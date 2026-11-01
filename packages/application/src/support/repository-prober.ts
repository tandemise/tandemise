import type { RepositoryChecks } from '@tandemise/domain';
import type { RepositoryProbe } from '@tandemise/api-contract';
import { ScopedFileSystem, type ProcessSupervisor } from '@tandemise/execution-core';
import { TandemiseError, errorMessage, expandPath } from '@tandemise/shared';

/**
 * Inspects a directory without adding it to a workspace (MVP.md §13.1).
 *
 * Everything here is *observed*, never assumed: a check command is reported
 * only if the repository really declares it. Guessing `npm test` for a project
 * that has no test script would produce a gate that fails for a reason the user
 * never chose.
 *
 * It talks to git through the process supervisor rather than through a git
 * service, because the probe must survive a path that is not a repository at
 * all - and the supervisor reports a non-zero exit where a git service throws.
 */
export class RepositoryProber {
  constructor(private readonly supervisor: ProcessSupervisor) {}

  async probe(inputPath: string): Promise<RepositoryProbe> {
    const path = expandPath(inputPath);
    const fs = new ScopedFileSystem(path);
    const warnings: string[] = [];

    if (!(await fs.exists('.'))) {
      throw new TandemiseError('NOT_FOUND', `No such directory: ${path}`, { details: { path } });
    }

    const topLevel = await this.#git(path, ['rev-parse', '--show-toplevel']);
    const isGitRepository = topLevel.ok && topLevel.text.length > 0;
    if (!isGitRepository) {
      warnings.push('Not a git repository. Tandemise cannot isolate work in a worktree without one.');
    }

    const currentBranch = await this.#optional(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const defaultBranch = isGitRepository ? await this.#defaultBranch(path, currentBranch) : null;
    const remoteUrl = await this.#optional(path, ['remote', 'get-url', 'origin']);
    const status = await this.#git(path, ['status', '--porcelain']);
    const isClean = !isGitRepository || (status.ok && status.text.length === 0);
    if (isGitRepository && !isClean) {
      warnings.push('The working tree has uncommitted changes. Worktrees branch from the last commit, so they will not include them.');
    }

    const manifest = await this.#readPackageJson(fs);
    const detectedChecks = detectChecks(manifest?.scripts ?? {});
    if (detectedChecks.test === null) {
      warnings.push('No test command detected. Gates that depend on `checks.tests` will record SKIP.');
    }

    return {
      path,
      isGitRepository,
      name: manifest?.name ?? basename(path),
      defaultBranch,
      currentBranch: currentBranch === 'HEAD' ? null : currentBranch,
      remoteUrl,
      isClean,
      detectedChecks,
      languages: detectLanguages(manifest !== null),
      warnings,
    };
  }

  async #defaultBranch(path: string, currentBranch: string | null): Promise<string | null> {
    const head = await this.#optional(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (head !== null) return head.replace(/^origin\//, '');
    for (const candidate of ['main', 'master']) {
      const found = await this.#git(path, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      if (found.ok) return candidate;
    }
    return currentBranch;
  }

  async #readPackageJson(fs: ScopedFileSystem): Promise<PackageManifest | null> {
    if (!(await fs.exists('package.json'))) return null;
    try {
      const parsed: unknown = JSON.parse(await fs.read('package.json'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const scripts = record['scripts'];
      return {
        name: typeof record['name'] === 'string' ? record['name'] : null,
        scripts: isStringRecord(scripts) ? scripts : {},
      };
    } catch (e) {
      // A malformed manifest is a fact about the repository, not a probe failure.
      return { name: null, scripts: {}, error: errorMessage(e) };
    }
  }

  async #git(cwd: string, args: readonly string[]): Promise<{ ok: boolean; text: string }> {
    try {
      const result = await this.supervisor.run({
        command: 'git',
        args: ['--no-pager', ...args],
        cwd,
        timeoutMs: 15_000,
        label: `git ${args[0] ?? ''}`,
      });
      return { ok: result.exitCode === 0, text: result.stdout.trim() };
    } catch {
      // git missing from PATH: report it as "not a repository" rather than
      // failing a probe the user asked for interactively.
      return { ok: false, text: '' };
    }
  }

  async #optional(cwd: string, args: readonly string[]): Promise<string | null> {
    const result = await this.#git(cwd, args);
    return result.ok && result.text.length > 0 ? result.text : null;
  }
}

interface PackageManifest {
  readonly name: string | null;
  readonly scripts: Readonly<Record<string, string>>;
  readonly error?: string;
}

/**
 * npm script names Tandemise recognises, most specific first. The mapping is
 * conventional rather than clever: a project that calls its type checker
 * something else configures it by hand, which is better than Tandemise
 * inventing a command that happens to exist and does something different.
 */
const SCRIPT_CANDIDATES: Readonly<Record<Exclude<keyof RepositoryChecks, 'budgets'>, readonly string[]>> = {
  install: [],
  typecheck: ['typecheck', 'type-check', 'tsc'],
  lint: ['lint'],
  test: ['test'],
  build: ['build'],
  devServer: ['dev', 'start', 'serve'],
  devServerUrl: [],
};

function detectChecks(scripts: Readonly<Record<string, string>>): RepositoryProbe['detectedChecks'] {
  const pick = (key: keyof typeof SCRIPT_CANDIDATES): string | null => {
    const name = SCRIPT_CANDIDATES[key].find((candidate) => candidate in scripts);
    return name === undefined ? null : `npm run ${name}`;
  };
  const hasManifest = Object.keys(scripts).length > 0;
  return {
    // `npm ci` needs a lockfile that may not exist; `npm install` always works.
    install: hasManifest ? 'npm install' : null,
    typecheck: pick('typecheck'),
    lint: pick('lint'),
    // `npm test` is the one script npm itself defines a top-level verb for.
    test: 'test' in scripts ? 'npm test' : null,
    build: pick('build'),
    devServer: pick('devServer'),
    devServerUrl: null,
  };
}

function detectLanguages(hasPackageJson: boolean): readonly string[] {
  return hasPackageJson ? ['javascript'] : [];
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && Object.values(v).every((x) => typeof x === 'string');
}

function basename(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}
