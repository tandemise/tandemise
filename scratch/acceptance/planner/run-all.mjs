#!/usr/bin/env node
// #53 acceptance (PR 1): the factory plans by lane, says why, and opens the pull request itself.
//
//   node scratch/acceptance/planner/run-all.mjs [--keep-going] [--only=pm01,pm07] [--hold] [--real-claude]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs). The project's checkout is
// registered with a GitHub remote (git@github.com:acme/web.git), so the ship
// step knows which repository its pull request is for; its `origin` is then
// pointed at a local bare repository, so the push works offline. The daemon is
// this checkout's build with a fake `gh` first on its PATH (scratch/fake-gh.mjs
// records every call); the real desktop window has its own user-data-dir and
// CDP on 9374. Scenario JSON lands in planner/evidence/; screenshots in
// docs/superpowers/evidence/2026-10-30-planner/.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { installFakeGh } from '../../fake-gh.mjs';
import { keepPainting } from '../p0/lib/frame-pump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-planner';
const PORT = Number(process.env.CDP_PORT ?? 9374);
const EVIDENCE = join(here, 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-planner-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const ghBin = installFakeGh(`${LINK}/gh`, { login: 'acme-bot' });
// No run may reach real GitHub: the daemon's PATH must resolve gh to the fake before anything starts.
const resolvedGh = execFileSync('sh', ['-c', 'command -v gh'], { env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}` }, encoding: 'utf8' }).trim();
if (resolvedGh !== `${ghBin}/gh`) {
  console.error(`refusing to run: gh resolves to ${resolvedGh}, not the fake at ${ghBin}/gh`);
  process.exit(2);
}

// The project exists before setup so it is registered with a GitHub remote.
const project = `${LINK}/project`;
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'README.md'), '# Acceptance project\n');
writeFileSync(join(project, 'package.json'), JSON.stringify({
  name: 'acceptance-project', private: true,
  scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' },
}, null, 2));
writeFileSync(join(project, '.gitignore'), '.tandemise/out/\nnode_modules/\n');
git(project, 'init', '-q', '-b', 'main');
git(project, 'remote', 'add', 'origin', 'git@github.com:acme/web.git');

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, SCRIPTED_DELAY_MS: '1200', TANDEMISE_SHIP_POLL_MS: '1500', TANDEMISE_SHIP_CI_GRACE_MS: '3000', SCRIPTED_STATE_DIR: `${LINK}/scripted-state` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// GitHub, offline: the registered remote URL stays acme/web, while pushes go to a bare repository.
const bare = `${LINK}/origin.git`;
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
git(project, 'remote', 'set-url', 'origin', bare);
git(project, 'push', '-q', 'origin', 'main');

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

const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
// --real-claude adds PM1 on the real Claude Code runtime (claude at ~/.local/bin/claude, logged in).
const scenarios = ['pm01.mjs', 'pm02.mjs', 'pm05.mjs', 'pm06.mjs', 'pm07.mjs', 'pm10.mjs', 'pm03.mjs', 'pm04.mjs', 'pm08.mjs', 'pm09.mjs', 'pm11.mjs', 'pm12.mjs', 'pm13.mjs', 'pm14.mjs', ...(process.argv.includes('--real-claude') ? ['pm01-real-claude.mjs'] : [])]
  .filter((file) => !only || only.some((o) => file.replace('.mjs', '') === o || (o === 'pm01' && file === 'pm01.mjs') || (o !== 'pm01' && file.includes(o))));

let failed = null;
for (const file of scenarios) {
  log(file);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'suite', file)], {
      stdio: 'inherit',
      env: { ...process.env, ACCEPTANCE_SCRATCH: LINK, CDP_PORT: String(PORT), ACCEPTANCE_EVIDENCE_DIR: `${EVIDENCE}/` },
    });
    child.on('close', done);
  });
  const evidence = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
  if (code !== 0 || evidence.some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- stop what this run started
if (!process.argv.includes('--hold')) {
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ }
}

// ---------------------------------------------------------------- summary
const results = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
const order = ['PM1', 'PM1R', 'PM2', 'PM3', 'PM4', 'PM5', 'PM6', 'PM7', 'PM8', 'PM9', 'PM10', 'PM11', 'PM12', 'PM13', 'PM14'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# Planner acceptance (#53)',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real}`,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : results.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES'}** (${results.filter((r) => r.ok).length}/${results.length} scenarios)`,
  '',
  ...results.flatMap((r) => [
    `## ${r.id} — ${r.title}: ${r.ok ? 'PASS' : 'FAIL'}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? 'ok' : 'FAIL'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 220)}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'summary.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 4).join('\n')}`);
process.exit(failed || !results.every((r) => r.ok) ? 1 : 0);
