#!/usr/bin/env node
// P13 acceptance: the skills library, in the real window, on a brand-new installation.
//
//   node scratch/acceptance/p13/run-all.mjs [--keep-going] [--only=n01,n03] [--hold] [--keep-painting]
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs), the daemon from this
// checkout's build with its skills discovery root pointed at a fixture folder
// (never the real ~/.claude/skills), the real desktop window with its own
// user-data-dir and CDP on 9348, then N1-N4 in order. The scripted agent's
// profile reads skills from .claude/skills (settings.skillsFolder) and records,
// for every run, which skills it found in that folder and in its prompt.
// N5 (#129) adds an installed plugin under the fixture root (the Claude config
// folder is the skills root's parent), a grouping folder and a repository skill.
// Writes p13/evidence/REPORT.md.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { keepPainting } from '../p0/lib/frame-pump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-p13';
const PORT = Number(process.env.CDP_PORT ?? 9348);
const EVIDENCE = join(here, 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

// ---------------------------------------------------------------- fresh install
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
if (existsSync(`${LINK}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-p13-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

// The fixture skills: two good ones, one that links outside its folder (refused), and one elsewhere to import by path.
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
put(`${LINK}/claude-skills/tdd/SKILL.md`, '---\nname: tdd\ndescription: Write the failing test first, then the code.\n---\n\n# Test first\n\n1. Write a test that fails.\n2. Make it pass with the least code.\n3. Tidy up while it stays green.\n');
put(`${LINK}/claude-skills/tdd/reference.md`, '# Naming tests\n\nName a test after the behaviour it proves.\n');
put(`${LINK}/claude-skills/house-style/SKILL.md`, '---\nname: house-style\ndescription: How our copy reads.\n---\n\n# House style\n\nShort sentences. Plain words. Say what the reader can do next.\n');
put(`${LINK}/claude-skills/shared-notes/SKILL.md`, '---\nname: shared-notes\ndescription: Notes that live somewhere else.\n---\n\nSee the linked file.\n');
symlinkSync('/etc/hosts', `${LINK}/claude-skills/shared-notes/hosts`);
put(`${LINK}/more-skills/lint-rules/SKILL.md`, '---\nname: lint-rules\ndescription: The lint rules we keep.\n---\n\n# Lint rules\n\nNo unused imports. No commented-out code.\n');

log('setup');
// Runs take a few seconds each, so a scenario can read the window between two of them.
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, SCRIPTED_DELAY_MS: '1500', SCRIPTED_ARGS_DIR: `${LINK}/args`, SCRIPTED_STATE_DIR: `${LINK}/scripted-state`, TANDEMISE_SKILLS_DISCOVER_DIR: `${LINK}/claude-skills`, SCRIPTED_ECHO_SKILLS: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Setup shortcut: the scripted agent reads skills from .claude/skills in its working folder (skillsFolder), like
// Claude Code does; N3 switches it off through the same route to show the prompt path.
{
  const env = JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8'));
  const res = await fetch(`${env.url}/v1/runtimes/${env.scriptedProfileId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json', 'x-tandemise-api-version': 'v1' },
    body: JSON.stringify({ settings: { command: process.execPath, args: [resolve(here, '../p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'ndjson', skillsFolder: true, capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] } }),
  });
  if (!res.ok) throw new Error(`could not give the scripted runtime its skills folder: ${res.status} ${await res.text()}`);
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

const keepGoing = process.argv.includes('--keep-going');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
// No real-model scenario: which skills a run gets is decided by the daemon; the scripted agent shows what it received.
const scenarios = ['n01-import.mjs', 'n02-role-run.mjs', 'n03-update.mjs', 'n04-missing.mjs', 'n05-plugins.mjs']
  .filter((file) => !only || only.some((o) => file.includes(o)));

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
if (!process.argv.includes('--hold')) try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
if (!process.argv.includes('--hold')) {
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  try { process.kill(JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8')).pid); } catch { /* gone */ }
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
const order = ['N1', 'N2', 'N3', 'N4', 'N5'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const lines = [
  '# P13 acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real}`,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : results.every((r) => r.ok) ? 'ALL PASS' : 'FAILURES'}** (${results.filter((r) => r.ok).length}/${results.length} scenarios)`,
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
