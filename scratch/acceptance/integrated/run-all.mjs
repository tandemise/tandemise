#!/usr/bin/env node
// The pivot, end to end on one installation (#56): the owner's normal day across relay, brain, hold, intake and the
// planner, in the real window, with fakes for everything outside this machine.
//
//   npm run build && node scratch/acceptance/integrated/run-all.mjs [--hold] [--keep-painting]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) whose checkout is registered with a GitHub remote (acme/web) and
// whose `origin` is then a local bare repository, so the ship step's push works offline. The daemon is this
// checkout's build with a fake `gh` first on its PATH (scratch/fake-gh.mjs). The tracker is a fake YouTrack
// (scratch/fake-youtrack.mjs); the project's intake is one custom source, `web-form`, with no type → workflow
// mapping, so Start uses the default. The Coding agent (role development) runs on the fake runtime, which resumes
// and opens an interactive session on a real PTY. The real desktop window has its own user-data-dir and CDP on
// 9390. Evidence (REPORT.md + screenshots) goes to docs/superpowers/evidence/2026-10-31-integrated/.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { installFakeGh } from '../../fake-gh.mjs';
import { keepPainting } from '../p0/lib/frame-pump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-integrated';
const PORT = Number(process.env.CDP_PORT ?? 9390);
const EVIDENCE = join(repoRoot, 'docs/superpowers/evidence/2026-10-31-integrated');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// ---------------------------------------------------------------- fresh install
const killFromFile = (file, key) => { if (existsSync(file)) { try { for (const pid of [JSON.parse(readFileSync(file, 'utf8'))[key]].flat()) process.kill(pid); } catch { /* gone */ } } };
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
killFromFile(`${LINK}/env.json`, 'pid');
killFromFile(`${LINK}/fakes.json`, 'pids');
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-integrated-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

// ---------------------------------------------------------------- the fakes
log('fakes');
const children = [];
{
  const dir = `${LINK}/youtrack`;
  mkdirSync(dir, { recursive: true });
  children.push(spawn(process.execPath, [join(repoRoot, 'scratch/fake-youtrack.mjs'), '--port', '0', '--state', dir, '--project', 'GAR', '--token', 'perm:acceptance', '--login', 'tandemise-bot'], { stdio: ['ignore', 'ignore', 'inherit'] }));
  const deadline = Date.now() + 15_000;
  while (!existsSync(`${dir}/url`)) { if (Date.now() > deadline) throw new Error('fake YouTrack did not start'); await sleep(100); }
}
const ytUrl = readFileSync(`${LINK}/youtrack/url`, 'utf8').trim();
writeFileSync(`${LINK}/fakes.json`, JSON.stringify({ pids: children.map((c) => c.pid) }));
// The board a team already has: one item someone else is on.
await fetch(`${ytUrl}/_fake/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idReadable: 'GAR-1', summary: 'Dark mode for the settings page', type: 'Task', state: 'In Progress', assignee: 'kim' }) });

const ghBin = installFakeGh(`${LINK}/gh`, { login: 'acme-bot' });
// No run may reach real GitHub: the daemon's PATH must resolve gh to the fake before anything starts.
const resolvedGh = execFileSync('sh', ['-c', 'command -v gh'], { env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}` }, encoding: 'utf8' }).trim();
if (resolvedGh !== `${ghBin}/gh`) { console.error(`refusing to run: gh resolves to ${resolvedGh}, not the fake`); process.exit(2); }

// The project exists before setup so it is registered with a GitHub remote.
const project = `${LINK}/project`;
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'README.md'), '# Acceptance project\n');
// The test script counts its runs in tests-ran.log: a docs-only item must not run it, a code change only once (#106).
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'acceptance-project', private: true, scripts: { test: `node -e "require('fs').appendFileSync('${LINK}/tests-ran.log', 'ran\\n')"`, build: 'node -e "process.exit(0)"' } }, null, 2));
writeFileSync(join(project, '.gitignore'), '.tandemise/out/\nnode_modules/\n');
git(project, 'init', '-q', '-b', 'main');
git(project, 'remote', 'add', 'origin', 'git@github.com:acme/web.git');

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, SCRIPTED_DELAY_MS: '800', TANDEMISE_SHIP_POLL_MS: '1500', TANDEMISE_SHIP_CI_GRACE_MS: '3000', SCRIPTED_STATE_DIR: `${LINK}/scripted-state` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const bare = `${LINK}/origin.git`;
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
git(project, 'remote', 'set-url', 'origin', bare);
git(project, 'push', '-q', 'origin', 'main');

// ---------------------------------------------------------------- the project's intake (setup shortcut: the daemon's own routes)
const env = JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8'));
const api = async (method, path, body) => {
  const res = await fetch(`${env.url}${path}`, { method, headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const ws = env.workspaceId;
await api('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: 'perm:acceptance' });
await api('PUT', `/v1/workspaces/${ws}/intake/config`, {
  tracker: {
    kind: 'youtrack', url: ytUrl, project: 'GAR', board: 'project: GAR #Unresolved',
    states: { ready: ['Open', 'Submitted'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'] },
    onComplete: 'in_review',
  },
  intake: { sources: [{ id: 'web-form', kind: 'custom', instance: 'web-form', create: { type: 'Bug' } }] },
});

// A window behind others stops painting, and a screenshot then never returns: keep it rendering while occluded.
const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${LINK}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: join(repoRoot, 'apps/desktop'),
  env: { ...process.env, TANDEMISE_HOME: `${LINK}/home` },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
desktop.unref();
// --keep-painting (or ACCEPTANCE_KEEP_PAINTING=1): for a display that is idle during the run.
keepPainting([PORT]);

log('day.mjs');
const code = await new Promise((done) => {
  const child = spawn(process.execPath, [join(here, 'suite', 'day.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, ACCEPTANCE_SCRATCH: LINK, CDP_PORT: String(PORT), ACCEPTANCE_EVIDENCE_DIR: `${EVIDENCE}/` },
  });
  child.on('close', done);
});

// ---------------------------------------------------------------- stop what this run started
if (!process.argv.includes('--hold')) {
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  // The daemon leads its own process group: its terminals go with it.
  try { process.kill(-env.pid, 'SIGTERM'); } catch { /* gone */ }
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
const ok = code === 0 && results.length > 0 && results.every((r) => r.ok);
const lines = [
  '# The pivot, end to end on main: acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real} · fake YouTrack and GitHub, fake runtime`,
  `Result: **${ok ? 'PASS' : 'FAIL'}** (${results.flatMap((r) => r.checks).filter((c) => c.ok).length}/${results.flatMap((r) => r.checks).length} checks)`,
  '',
  ...results.flatMap((r) => [
    `## ${r.id} — ${r.title}: ${r.ok ? 'PASS' : 'FAIL'}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 220).replace(/`/g, "'")}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
  // What this scenario found on main, and the fixes that closed each seam.
  readFileSync(join(here, 'HISTORY.md'), 'utf8'),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 4).join('\n')}`);
process.exit(ok ? 0 : 1);
