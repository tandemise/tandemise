#!/usr/bin/env node
// Intake acceptance (spec 2026-10-30-intake-design.md "Acceptance", plan Task 14):
// work from any source lands once in the project's tracker, a person starts it
// from the Board, the tracker follows the mission, and the loop closes at
// every source — in the real window, on a brand-new installation.
//
//   node scratch/acceptance/intake/run-all.mjs [--keep-going] [--only=i01,i03] [--hold]
//   node scratch/acceptance/intake/run-all.mjs --real-youtrack     (opt-in; see below)
//
// Fresh TANDEMISE_HOME + project (p0/setup.mjs) whose checkout has a GitHub
// remote (acme/web, the repository the fake Sentry links), the daemon from
// this checkout's build with a fake `gh` first on its PATH, three fakes as
// child processes (scratch/fake-youtrack.mjs, fake-sentry.mjs, fake-slack.mjs,
// each writing its URL to <LINK>/<name>/url), the project's intake config and
// secrets set through the daemon's own routes (the brain, #51, is not on main:
// the local IntakeConfigSource is what a person's Settings → Intake writes),
// the real desktop window with its own user-data-dir and CDP on 9352, then
// I1–I10 in order. I10 links the project to a brain on this machine (#70) and
// moves the tracker to a second fake YouTrack (youtrack-b), so it runs last. Writes intake/evidence/REPORT.md and copies it, with the
// screenshots, to docs/superpowers/evidence/2026-10-30-intake/acceptance/.
//
// --real-youtrack: with TANDEMISE_YOUTRACK_URL, TANDEMISE_YOUTRACK_TOKEN and
// TANDEMISE_YOUTRACK_PROJECT set, the tracker is that YouTrack (nothing is
// seeded or edited in it) and only I1, I2 and I6 run, as A15 does for the real
// Claude. Never run without the owner's say-so: it files a real item.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { installFakeGh } from '../../fake-gh.mjs';
import { keepPainting } from '../p0/lib/frame-pump.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const LINK = process.env.ACCEPTANCE_LINK ?? '/tmp/tdm-intake';
const PORT = Number(process.env.CDP_PORT ?? 9352);
const EVIDENCE = join(here, 'evidence');
const DOCS = join(repoRoot, 'docs/superpowers/evidence/2026-10-30-intake/acceptance');
const REAL = process.argv.includes('--real-youtrack');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);

if (REAL && !['TANDEMISE_YOUTRACK_URL', 'TANDEMISE_YOUTRACK_TOKEN', 'TANDEMISE_YOUTRACK_PROJECT'].every((k) => process.env[k])) {
  console.error('--real-youtrack needs TANDEMISE_YOUTRACK_URL, TANDEMISE_YOUTRACK_TOKEN and TANDEMISE_YOUTRACK_PROJECT.');
  process.exit(2);
}

// ---------------------------------------------------------------- fresh install
const killFromFile = (file, key) => { if (existsSync(file)) { try { for (const pid of [JSON.parse(readFileSync(file, 'utf8'))[key]].flat()) process.kill(pid); } catch { /* gone */ } } };
try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
killFromFile(`${LINK}/env.json`, 'pid');
killFromFile(`${LINK}/fakes.json`, 'pids');
await sleep(1500);
// Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `tdm-intake-run-${Date.now().toString(36)}`);
mkdirSync(real, { recursive: true });
rmSync(LINK, { force: true });
symlinkSync(real, LINK);
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

// ---------------------------------------------------------------- the fakes
log('fakes');
const children = [];
async function startFake(name, script, args = []) {
  const dir = `${LINK}/${name}`;
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [join(repoRoot, 'scratch', script), '--port', '0', '--state', dir, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  const deadline = Date.now() + 15_000;
  while (!existsSync(`${dir}/url`)) {
    if (Date.now() > deadline) throw new Error(`${script} did not start`);
    await sleep(100);
  }
  return readFileSync(`${dir}/url`, 'utf8').trim();
}
// The fake's own states, plus Draft for I15 (#135): a new issue still starts Open.
const YT_STATES = ['Open', 'Submitted', 'In Progress', 'In Review', 'Fixed', 'Done', "Won't fix", 'Duplicate', 'Obsolete', 'Draft'].join(',');
const ytUrl = REAL ? process.env.TANDEMISE_YOUTRACK_URL : await startFake('youtrack', 'fake-youtrack.mjs', ['--project', 'ACME', '--token', 'perm:acceptance', '--login', 'tandemise-bot', '--states', YT_STATES]);
const sentryUrl = await startFake('sentry', 'fake-sentry.mjs', ['--token', 'sntrys_acceptance', '--org', 'acme', '--project', 'web', '--repos', 'acme/web']);
const slackUrl = await startFake('slack', 'fake-slack.mjs', ['--workspace', 'acme', '--app-token', 'xapp-acceptance', '--bot-token', 'xoxb-acceptance']);
// I10's second address for the tracker (Ruling 23): it would take the same token, so a request carrying it shows.
if (!REAL) await startFake('youtrack-b', 'fake-youtrack.mjs', ['--project', 'ACME', '--token', 'perm:acceptance', '--login', 'tandemise-bot']);
writeFileSync(`${LINK}/fakes.json`, JSON.stringify({ pids: children.map((c) => c.pid) }));
const stopFakes = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } };

// The board a team already has: one ready item with a Done-when, one in progress, one in review, one done.
if (!REAL) {
  const put = (issue) => fetch(`${ytUrl}/_fake/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(issue) });
  await put({ idReadable: 'ACME-1', summary: 'Checkout fails on Safari', type: 'Task', state: 'Open', description: 'Customers on Safari 17 cannot pay.\n\n## Done when\n- [ ] Checkout completes on Safari 17' });
  await put({ idReadable: 'ACME-2', summary: 'Dark mode for the settings page', type: 'Task', state: 'In Progress', assignee: 'kim' });
  await put({ idReadable: 'ACME-3', summary: 'Release notes for 2.4', type: 'Task', state: 'In Review' });
  await put({ idReadable: 'ACME-4', summary: 'Old login crash', type: 'Bug', state: 'Fixed' });
}

// The fake GitHub: the project's remote is acme/web; nothing in these scenarios files GitHub issues.
const ghBin = installFakeGh(`${LINK}/gh`, { login: 'acme-bot' });

// The project's checkout exists before setup registers it, with its GitHub remote (acme/web, the repository
// the fake Sentry links): the remote is read when the repository is added, and a closure names the commit
// in that repository (Sentry's `inCommit`, spec §8). The files are setup.mjs's own, so the project is the same.
{
  const project = `${LINK}/project`;
  mkdirSync(`${project}/.tandemise/workflows`, { recursive: true });
  writeFileSync(`${project}/README.md`, '# Acceptance project\n');
  writeFileSync(`${project}/package.json`, JSON.stringify({ name: 'acceptance-project', private: true, scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(`${project}/.gitignore`, '.tandemise/out/\nnode_modules/\n');
  // A fix as a team would run it: the spec covers the item's criteria, the change is made in its own
  // worktree (so the mission has a commit), QA verifies every criterion, and a release candidate closes it.
  writeFileSync(`${project}/.tandemise/workflows/intake-fix.yaml`, [
    'name: Intake fix',
    'description: A filed bug, fixed in its own worktree and verified against every criterion (intake acceptance).',
    'steps:',
    '  - key: spec',
    '    role: product',
    '    objective: Write the spec for the fix.',
    '    outputs: [ProductSpec]',
    '    gate: artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1',
    '  - key: build',
    '    role: development',
    '    dependsOn: [spec]',
    '    objective: Make the fix.',
    '    inputs: [ProductSpec]',
    '    isolation: worktree',
    '    outputs: [ChangeSet]',
    '  - key: qa',
    '    role: qa',
    '    dependsOn: [build]',
    '    objective: Verify the fix against every criterion.',
    '    inputs: [ProductSpec]',
    '    isolation: none',
    '    outputs: [QAReport]',
    '    gate: artifact.QAReport.exists && qa.criteria_failed == 0',
    '  - key: release',
    '    role: release',
    '    dependsOn: [qa]',
    '    objective: Assemble the release candidate for the fix.',
    '    inputs: [QAReport]',
    '    outputs: [ReleaseCandidate]',
    '    gate: artifact.ReleaseCandidate.exists && qa.criteria_unverified == 0 && qa.blocking_defects == 0',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/web.git'], { cwd: project, stdio: 'ignore' });
}

log('setup');
execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), LINK], {
  env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, SCRIPTED_DELAY_MS: '800', SCRIPTED_STATE_DIR: `${LINK}/scripted-state` },
  stdio: ['ignore', 'pipe', 'inherit'],
});

// ---------------------------------------------------------------- the project's intake
const env = JSON.parse(readFileSync(`${LINK}/env.json`, 'utf8'));
const api = async (method, path, body) => {
  const res = await fetch(`${env.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const ws = env.workspaceId;
const desk = (await api('GET', `/v1/workflows?workspaceId=${ws}`)).find((w) => w.name === 'Intake fix')?.id;
if (!desk) throw new Error('no Intake fix workflow in the acceptance project');
// The token first: saving the config checks the mapping against the tracker (spec §6.2).
await api('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: REAL ? process.env.TANDEMISE_YOUTRACK_TOKEN : 'perm:acceptance' });
await api('PUT', `/v1/workspaces/${ws}/intake/config`, {
  tracker: {
    kind: 'youtrack', url: ytUrl, project: REAL ? process.env.TANDEMISE_YOUTRACK_PROJECT : 'ACME',
    board: `project: ${REAL ? process.env.TANDEMISE_YOUTRACK_PROJECT : 'ACME'} #Unresolved`,
    states: { ready: ['Open', 'Submitted'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'] },
    onComplete: 'in_review',
    workflows: { Bug: desk, Task: desk },
  },
  intake: {
    sources: [
      { id: 'sentry-web', kind: 'sentry', instance: 'acme/web', api: sentryUrl, every: '60m', filter: { minEvents: 20, window: '24h' }, create: { type: 'Bug' }, closeOnDone: true },
      { id: 'slack-support', kind: 'slack', instance: 'acme.slack.com#support', api: slackUrl, create: { type: 'Bug' }, closeOnDone: true },
      { id: 'web-form', kind: 'custom', instance: 'web-form', create: { type: 'Task' } },
    ],
  },
});
await api('PUT', `/v1/workspaces/${ws}/intake/sources/sentry-web/secret`, { name: 'token', value: 'sntrys_acceptance' });
await api('PUT', `/v1/workspaces/${ws}/intake/sources/slack-support/secret`, { name: 'appToken', value: 'xapp-acceptance' });
await api('PUT', `/v1/workspaces/${ws}/intake/sources/slack-support/secret`, { name: 'botToken', value: 'xoxb-acceptance' });

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
const all = ['i01-board.mjs', 'i02-sentry.mjs', 'i03-slack-same-error.mjs', 'i04-held-back.mjs', 'i05-unsure.mjs', 'i06-start.mjs', 'i07-complete.mjs', 'i08-close-the-loop.mjs', 'i09-cli.mjs', 'i10-brain-sources-and-moved-tracker.mjs', 'i11-factory-ux.mjs', 'i12-setup-papercuts.mjs', 'i13-start-eligibility.mjs', 'i14-token-clears-board-problem.mjs', 'i15-refine-draft.mjs'];
const scenarios = all
  .filter((file) => !REAL || ['i01', 'i02', 'i06'].some((id) => file.startsWith(id)))
  .filter((file) => !only || only.some((o) => file.includes(o)));

let failed = null;
for (const file of scenarios) {
  log(file);
  const code = await new Promise((done) => {
    const child = spawn(process.execPath, [join(here, 'suite', file)], {
      stdio: 'inherit',
      env: { ...process.env, ACCEPTANCE_SCRATCH: LINK, CDP_PORT: String(PORT), ACCEPTANCE_EVIDENCE_DIR: `${EVIDENCE}/`, INTAKE_REAL_YOUTRACK: REAL ? '1' : '0' },
    });
    child.on('close', done);
  });
  const evidence = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
  const id = `I${Number(file.slice(1, 3))}`;
  if (code !== 0 || !evidence.some((e) => e.id === id) || evidence.some((e) => !e.ok)) { failed ??= file; if (!keepGoing) break; }
}

// ---------------------------------------------------------------- stop what this run started
// --hold leaves the window, daemon and fakes up for inspection; the next run cleans them up.
if (!process.argv.includes('--hold')) {
  try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
  try { execFileSync('pkill', ['-f', `user-data-dir=${LINK}/electron`]); } catch { /* none */ }
  try { process.kill(env.pid); } catch { /* gone */ }
  stopFakes();
}

// ---------------------------------------------------------------- report
const results = readdirSync(EVIDENCE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(EVIDENCE, f), 'utf8')));
const order = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15'];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const missing = scenarios.map((f) => `I${Number(f.slice(1, 3))}`).filter((id) => !results.some((r) => r.id === id));
const lines = [
  '# Intake acceptance report',
  '',
  `Run: ${new Date().toISOString()} · build ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim()} · fresh install at ${real} · ${REAL ? 'real YouTrack' : 'fake YouTrack, Sentry and Slack'}`,
  `Result: **${failed ? `${keepGoing ? 'FAILED at' : 'STOPPED at'} ${failed}` : results.every((r) => r.ok) && missing.length === 0 ? 'ALL PASS' : 'FAILURES'}** (${results.filter((r) => r.ok).length}/${scenarios.length} scenarios)`,
  '',
  '| Scenario | Result | Checks |',
  '|---|---|---|',
  ...results.map((r) => `| ${r.id} — ${r.title} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`),
  ...missing.map((id) => `| ${id} | DID NOT RUN | — |`),
  '',
  ...results.flatMap((r) => [
    `## ${r.id} — ${r.title}`,
    '',
    ...r.notes.map((n) => `- note: ${n}`),
    ...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.observed === undefined ? '' : ` — \`${JSON.stringify(c.observed).slice(0, 220).replace(/`/g, "'")}\``}`),
    ...r.shots.map((s) => `- screenshot: \`${s.split('/').slice(-1)[0]}\``),
    '',
  ]),
];
writeFileSync(join(EVIDENCE, 'REPORT.md'), lines.join('\n'));
if (!REAL && !only) {
  rmSync(DOCS, { recursive: true, force: true });
  mkdirSync(DOCS, { recursive: true });
  for (const f of readdirSync(EVIDENCE).filter((x) => x.endsWith('.png') || x === 'REPORT.md')) copyFileSync(join(EVIDENCE, f), join(DOCS, f));
}
console.log(`\n${lines.slice(0, 6 + results.length + missing.length + 2).join('\n')}`);
process.exit(failed || missing.length > 0 || !results.every((r) => r.ok) ? 1 : 0);
