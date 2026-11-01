// #167: a task's worktree starts from the remote's current default branch, not
// from the clone's local `main`, which nothing moves on its own.
//
// A bare "remote" moves on after the clone is made, so the clone's `main` (and
// its `origin/main`) are a commit behind. Provisioning a task's worktree must
// fetch, cut the branch from the fetched tip, and record that commit. Offline,
// it falls back to the local branch and says so. A local branch that holds
// unpublished work on top of the remote is kept, not thrown away.
//
// Run: node scratch/worktree-base-check.mjs   (after `npm run build`)
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Container, compose } from '@tandemise/kernel';
import { createLogger, createPaths, ids } from '@tandemise/shared';
import { EXECUTION_TARGET_MANAGER, LOGGER, PATHS, executionCoreModule } from '@tandemise/execution-core';
import { GIT_SERVICE, executionLocalModule } from '@tandemise/execution-local';

let passed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) {
    console.error(`FAIL  ${label} ${detail}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${label}`);
  }
  passed += 1;
  console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
};

const root = await mkdtemp(join(tmpdir(), 'tdm-wtbase-'));
const remote = join(root, 'remote.git');
const seed = join(root, 'seed');
const clone = join(root, 'clone');
const home = join(root, 'home');

const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Check', '-c', 'user.email=check@tandemise.local', '-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const commit = async (cwd, file, text) => {
  await writeFile(join(cwd, file), text);
  sh(cwd, 'add', '-A');
  sh(cwd, 'commit', '-q', '-m', `add ${file}`);
  return sh(cwd, 'rev-parse', 'HEAD');
};

const container = new Container();
container.bindValue(LOGGER, createLogger({ level: 'error' }));
container.bindValue(PATHS, createPaths(home));
compose(container, executionCoreModule, executionLocalModule);
const git = container.resolve(GIT_SERVICE);
const manager = container.resolve(EXECUTION_TARGET_MANAGER);
const workspaceId = ids.workspace();
const missionId = ids.mission();
const provision = (name) => manager.provision({
  workspaceId, missionId, taskId: ids.task(), kind: 'worktree', name,
  // What the task executor passes for a step with nothing upstream: the mission's base.
  repositoryPath: clone, baseBranch: 'main', missionSlug: 'base-check',
});

// A published repository and a clone of it.
await mkdir(seed, { recursive: true });
sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
sh(seed, 'init', '-q', '-b', 'main');
const first = await commit(seed, 'README.md', '# demo\n');
sh(seed, 'remote', 'add', 'origin', remote);
sh(seed, 'push', '-q', 'origin', 'main');
sh(root, 'clone', '-q', remote, clone);

// The remote moves on; the clone is not pulled.
const second = await commit(seed, 'two.txt', 'merged on the remote\n');
sh(seed, 'push', '-q', 'origin', 'main');
check('the clone\'s main is behind the remote', sh(clone, 'rev-parse', 'main') === first && second !== first);

const fresh = await provision('task fresh');
const head = sh(fresh.workingDirectory, 'rev-parse', 'HEAD');
check('the worktree starts from the remote\'s tip, not the stale local main', head === second,
  `HEAD ${head.slice(0, 7)}, local main ${first.slice(0, 7)}, remote ${second.slice(0, 7)}`);
check('the target records the commit it started from', (fresh.describe().detail ?? '').includes(second),
  fresh.describe().detail ?? '(no detail)');
check('the target\'s base diffs against that commit, not the stale main',
  sh(fresh.workingDirectory, 'diff', '--name-only', `${fresh.describe().baseBranch}...HEAD`) === '',
  `base ${fresh.describe().baseBranch}`);
check('the person\'s own main is not moved', sh(clone, 'rev-parse', 'main') === first);
// `git config --get` exits 1 when the key is unset, which is what we want.
const upstream = (await git.run(fresh.workingDirectory, ['config', '--get', `branch.${fresh.describe().branch}.merge`])).stdout.trim();
check('the task branch does not track the remote main (a bare push cannot land on main)', upstream === '', upstream);

// Unpublished work on the local main sits on top of the remote: keep it.
sh(clone, 'merge', '-q', '--ff-only', 'origin/main');
const local = await commit(clone, 'local.txt', 'not pushed yet\n');
const ahead = await provision('task ahead');
check('a local main ahead of the remote is used as it is',
  sh(ahead.workingDirectory, 'rev-parse', 'HEAD') === local, sh(ahead.workingDirectory, 'rev-parse', 'HEAD').slice(0, 7));

// Offline: the remote is gone. The task still starts, from the local branch, and says why.
sh(clone, 'remote', 'set-url', 'origin', join(root, 'nowhere.git'));
const offline = await provision('task offline');
check('offline, the worktree still starts from the local main',
  sh(offline.workingDirectory, 'rev-parse', 'HEAD') === local);
check('offline, the target says the remote could not be fetched',
  /could not fetch/i.test(offline.describe().detail ?? ''), offline.describe().detail ?? '(no detail)');

// No remote at all: nothing to fetch and nothing to warn about.
sh(clone, 'remote', 'remove', 'origin');
const solo = await provision('task solo');
check('without a remote, the local main is the base and nothing is flagged',
  sh(solo.workingDirectory, 'rev-parse', 'HEAD') === local && !/could not fetch/i.test(solo.describe().detail ?? ''),
  solo.describe().detail ?? '');

console.log(`\nworktree-base-check: ${passed} passed`);
