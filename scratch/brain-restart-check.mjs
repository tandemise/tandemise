/**
 * #153: the tracker a project reads from its brain survives a daemon restart.
 *
 * The brain's intake config (and its ledger of outcomes) are cached in memory
 * and filled when the brain's sync listeners run. They used to run only on a
 * link, an unlink or a sync that moved the head, so after a restart with no
 * new brain commit (or with the brain's remote out of reach) the project had
 * no tracker until someone pushed to the brain.
 *
 * Starts the daemon from `dist` in this process with a fresh TANDEMISE_HOME,
 * links two projects to brains that hold a tracker (one on this machine only,
 * one with a remote), restarts the daemon on the same home, and reads the
 * intake config again: once with the remote reachable and unchanged, once
 * with it gone.
 *
 *   npm run build && node scratch/brain-restart-check.mjs
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const ROOT = mkdtempSync(join(tmpdir(), 'tdm-brain-restart-'));
const FAKE = { bin: join(ROOT, 'bin'), log: join(ROOT, 'gh-log.jsonl'), state: join(ROOT, 'gh-state'), remotes: join(ROOT, 'remotes'), gitconfig: join(ROOT, 'gitconfig') };
mkdirSync(FAKE.bin, { recursive: true });
mkdirSync(FAKE.remotes, { recursive: true });
writeFileSync(join(FAKE.bin, 'gh'), `#!/bin/sh\nFAKE_GH_LOG='${FAKE.log}' FAKE_GH_STATE='${FAKE.state}' FAKE_GH_REMOTES='${FAKE.remotes}' exec '${process.execPath}' '${join(here, 'brain-fixtures', 'fake-gh.mjs')}' "$@"\n`);
chmodSync(join(FAKE.bin, 'gh'), 0o755);
writeFileSync(FAKE.gitconfig, `[url "file://${FAKE.remotes}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n[user]\n\tname = Ana Smith\n\temail = ana@localhost\n[init]\n\tdefaultBranch = main\n`);
process.env.PATH = `${FAKE.bin}:${process.env.PATH}`;
process.env.GIT_CONFIG_GLOBAL = FAKE.gitconfig;
process.env.TANDEMISE_OFFLINE = '1';
const remoteDir = join(FAKE.remotes, 'acme', 'brain.git');

globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');

const home = join(ROOT, 'home');
async function start() {
  const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 300 });
  const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { daemon, api };
}

/** The start-up sync runs in the background; give it a moment to land. */
async function trackerOf(api, ws) {
  let config;
  for (let i = 0; i < 40; i++) {
    config = (await api('GET', `/v1/workspaces/${ws}/intake/config`)).body;
    if (config?.tracker) return config;
    await sleep(150);
  }
  return config;
}

const tracker = {
  kind: 'github-issues', repo: 'acme/app', board: 'is:open',
  states: { ready: ['open'], in_progress: 'in progress', done: ['closed'], wont_do: [] }, onComplete: 'done',
};

let d;
try {
  section('two projects whose tracker comes from their brain');
  d = await start();
  const repoDir = join(home, 'code');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'README.md'), '# app\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'init');

  const localWs = (await d.api('POST', '/v1/workspaces', { name: 'Local brain', repositoryPath: repoDir })).body?.workspace?.id;
  await d.api('PUT', `/v1/workspaces/${localWs}/intake/config`, { tracker, intake: { sources: [] } });
  const local = await d.api('POST', `/v1/workspaces/${localWs}/brain`, { mode: 'local' });
  check('a brain on this machine only is linked', local.body?.status === 'local_only', local.body);

  const remoteWs = (await d.api('POST', '/v1/workspaces', { name: 'Shared brain', repositoryPath: repoDir })).body?.workspace?.id;
  await d.api('PUT', `/v1/workspaces/${remoteWs}/intake/config`, { tracker, intake: { sources: [] } });
  const shared = await d.api('POST', `/v1/workspaces/${remoteWs}/brain`, { mode: 'create', owner: 'acme', name: 'brain' });
  check('a brain with a remote is linked', shared.body?.status === 'up_to_date', shared.body);

  for (const [name, ws] of [['local', localWs], ['shared', remoteWs]]) {
    const before = await trackerOf(d.api, ws);
    check(`before the restart, the ${name} brain's project has its tracker`, before?.origin === 'brain' && before.tracker?.repo === 'acme/app', before);
  }
  await d.daemon.stop();
  d = undefined;

  section('restart with nothing new in either brain');
  d = await start();
  for (const [name, ws] of [['local', localWs], ['shared', remoteWs]]) {
    const after = await trackerOf(d.api, ws);
    check(`after a restart, the ${name} brain's project still has its tracker`, after?.origin === 'brain' && after.tracker?.repo === 'acme/app', after);
  }
  await d.daemon.stop();
  d = undefined;

  section("restart with the brain's remote out of reach");
  renameSync(remoteDir, `${remoteDir}.gone`);
  d = await start();
  const offline = await trackerOf(d.api, remoteWs);
  check('offline, the project still has the tracker from its copy of the brain', offline?.origin === 'brain' && offline.tracker?.repo === 'acme/app', offline);
  const view = (await d.api('GET', `/v1/workspaces/${remoteWs}/brain`)).body;
  check('…and the Brain section says it is working from that copy', view?.status === 'offline', view?.status);
  renameSync(`${remoteDir}.gone`, remoteDir);
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await d?.daemon.stop().catch(() => {});
  await sleep(100);
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
