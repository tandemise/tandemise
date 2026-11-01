#!/usr/bin/env node
// Hold and interact, in the real window, on a brand-new installation
// (docs/superpowers/specs/2026-10-30-hold-and-interact-design.md, "Acceptance").
//
//   npm run build && node scratch/acceptance/hold/run-all.mjs [--keep-going] [--skip-claude] [--only=h01,h03] [--hold]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs), the daemon from this
// checkout's build, the real desktop window with its own user-data-dir and CDP
// on 9341, the hold workflows and fake runtime profiles, then H1-H11. The fake
// runtime stands in for Claude Code (it resumes, and its interactive session
// echoes and writes files on a real PTY); with `claude` on PATH, H3 is also
// run on the real Claude Code. Writes the evidence and REPORT.md to
// docs/superpowers/evidence/2026-10-30-hold/.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { keepPainting } from '../p0/lib/frame-pump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-hold';
const PORT = Number(process.env.CDP_PORT ?? 9341);
const EVIDENCE = join(repoRoot, 'docs/superpowers/evidence/2026-10-30-hold');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);
const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const skipClaude = process.argv.includes('--skip-claude') || (() => { try { execFileSync('which', ['claude'], { stdio: 'ignore' }); return false; } catch { return true; } })();

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-hold-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
// A run of some scenarios (--only) replaces their evidence and keeps the rest.
if (!only) rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, SCRIPTED_DELAY_MS: '1500', SCRIPTED_STATE_DIR: `${LINK}/scripted-state` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
{
  const env = JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8'));
  const api = async (method, path, body) => {
    const res = await fetch(`${env.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json', 'x-tandemise-api-version': 'v1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };
  // Setup shortcut: the hold workflows, committed to the project as a person would add them.
  for (const file of readdirSync(join(here, 'workflows'))) copyFileSync(join(here, 'workflows', file), join(env.project, '.tandemise', 'workflows', file));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], { cwd: env.project, stdio: ['ignore', 'pipe', 'ignore'] });
  git('add', '.');
  git('commit', '-q', '-m', 'hold workflows');
  // Setup shortcut: the repository's tests take a while, so a gated step spends time checking its work (H9).
  const repos = await api('GET', `/v1/workspaces/${env.workspaceId}/repositories`);
  const repo = (repos.repositories ?? repos)[0];
  await api('PATCH', `/v1/repositories/${repo.id ?? repo.repository?.id}`, { checks: { test: 'sleep 25' } });
}

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

// Order: what builds on one held step first (H8 → H1 → H12 → H2 → H4 → H5 → H3), then the scenarios with steps of their own.
const scenarios = [
  'h08-now.mjs', 'h01-hold-running.mjs', 'h12-accessible-terminal.mjs', 'h02-iterate.mjs', 'h04-close-reopen.mjs', 'h05-daemon-restart.mjs', 'h03-continue.mjs',
  'h09-refusals.mjs', 'h06-ask-human.mjs', 'h07-hold-ready.mjs', 'h10-under-review.mjs', 'h11-profile-pinning.mjs',
  ...(skipClaude ? [] : ['h03-real-claude.mjs']),
].filter((file) => !only || only.some((o) => file.startsWith(o)));

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
// --hold leaves the window and daemon up for inspection; the next run cleans them up.
if (!process.argv.includes('--hold')) {
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  // The daemon leads its own process group: its terminals go with it.
  try { const pid = JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid; process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
const order = ['H1', 'H2', 'H3', 'H3-claude', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', 'H12'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# Hold and interact: acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real}`,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : results.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES'}** (${results.filter((r) => r.ok).length}/${results.length} scenarios)${skipClaude ? ' · real Claude Code scenario skipped' : ''}`,
  '',
  '| Scenario | Result | Checks |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.id} — ${r.title} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
  '',
  ...results.flatMap((r) => [
    `## ${r.id} — ${r.title}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 220)}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
console.log(`\n${lines.slice(0, 6 + results.length + 2).join('\n')}`);
process.exit(failed || !results.every((r) => r.ok) ? 1 : 0);
