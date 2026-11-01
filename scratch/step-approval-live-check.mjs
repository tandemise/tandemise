/**
 * #141 in the real app: the daemon from this checkout, the desktop over CDP.
 *
 *   node scratch/step-approval-live-check.mjs [<scratch-dir>] [--keep-painting]
 *
 * A fresh TANDEMISE_HOME under <scratch-dir> (a temp folder by default), the
 * fake `gh` first on the daemon's PATH, and the fake runtime calling
 * `github.pr.create` through the run's MCP config, as a worker does.
 *
 *   1. A step approved with github.pr.create on its card opens the pull
 *      request without a second card.
 *   2. A step with no approval asks for the call: its card on the mission says
 *      "Waiting on you" rather than Running, the task reads AWAITING_INPUT, and
 *      the card outlives the run's whole wall-time budget. Approving it from
 *      the app lets the run open the pull request and finish.
 *
 * Screenshots are written next to the home, for the PR.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './acceptance/p0/lib/cdp.mjs';
import { keepPainting } from './acceptance/p0/lib/frame-pump.mjs';
import { installFakeGh, readState } from './fake-gh.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 9341;
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const real = arg !== undefined ? resolve(arg) : mkdtempSync(join(tmpdir(), 'tdm-141-'));
mkdirSync(real, { recursive: true });
// A run's tool socket lives under the home, and a unix socket path is capped
// near 108 bytes: a deep scratch folder is reached through a short link.
const scratch = join(tmpdir(), `tdm141-${process.pid}`);
symlinkSync(real, scratch);
process.on('exit', () => { try { unlinkSync(scratch); } catch { /* gone */ } });
const home = join(scratch, 'home');
const project = join(scratch, 'web');
const shots = join(scratch, 'shots');
mkdirSync(shots, { recursive: true });
const REPO = 'acme/web';
const BUDGET_MS = 20_000;

let bad = 0;
const check = (n, c, d = '') => { if (c) console.log(`  ok   ${n}`); else { bad++; console.log(`  FAIL ${n}${d === '' ? '' : `  ${typeof d === 'string' ? d : JSON.stringify(d)}`}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60_000, label = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
};

// ------------------------------------------------------------------ project
mkdirSync(join(project, '.tandemise', 'workflows'), { recursive: true });
writeFileSync(join(project, 'README.md'), '# web\n');
writeFileSync(join(project, '.gitignore'), '.tandemise/out/\n');
const step = (approval) => [
  'steps:',
  '  - key: open_pr',
  '    title: Open the pull request',
  '    role: release',
  ...(approval ? ['    approval: before'] : []),
  '    objective: Open a pull request for the change.',
  '    capabilities: [github.pr.create, repository.read]',
  `    maxWallTimeMs: ${BUDGET_MS}`,
].join('\n');
writeFileSync(join(project, '.tandemise', 'workflows', 'approved.yaml'), `name: Approved step\ndescription: The step is approved before it starts.\n${step(true)}\n`);
writeFileSync(join(project, '.tandemise', 'workflows', 'unapproved.yaml'), `name: Unapproved step\ndescription: The call asks.\n${step(false)}\n`);
const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=check', '-c', 'user.email=check@example.invalid', ...args], { encoding: 'utf8' });
if (!existsSync(join(project, '.git'))) {
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', `git@github.com:${REPO}.git`);
}

// ------------------------------------------------------------------- daemon
const ghDir = join(scratch, 'gh');
const ghBin = installFakeGh(ghDir);
const procs = [];
const stop = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
  cwd: root, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
  env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error', PATH: `${ghBin}:${process.env.PATH}` },
});
procs.push(daemon);
const handshake = join(home, 'daemon.json');
await until(() => existsSync(handshake) && JSON.parse(readFileSync(handshake, 'utf8')).pid === daemon.pid, 30_000, 'the daemon');
const info = JSON.parse(readFileSync(handshake, 'utf8'));
const api = async (method, path, body) => {
  const res = await fetch(`${info.url}${path}`, {
    method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

try {
  const created = await api('POST', '/v1/workspaces', { name: 'Ship', repositoryPath: project });
  const ws = created.workspace?.id ?? created.id;
  await api('POST', '/v1/integrations', { workspaceId: ws, providerId: 'github', name: 'GitHub', enabledCapabilities: ['github.read', 'github.pr.create'] });
  const release = (await api('GET', `/v1/roles?workspaceId=${ws}`)).find((r) => r.id === 'release');
  await api('PUT', '/v1/roles/release', {
    workspaceId: ws, id: 'release', name: release.name, summary: release.summary, instructions: release.instructions,
    defaultCapabilities: [...release.defaultCapabilities, 'github.pr.create'], producesArtifacts: release.producesArtifacts,
    consumesArtifacts: release.consumesArtifacts, defaultIsolation: release.defaultIsolation, outputContract: release.outputContract,
  });
  const runtime = await api('POST', '/v1/runtimes', {
    adapterId: 'fake', name: 'Opens PRs', workspaceId: null, maxConcurrent: 4, enabled: true,
    capabilities: ['reasoning', 'filesystem', 'shell', 'git', 'tool_calling', 'session_resume', 'mcp'],
    settings: { script: { steps: [
      { kind: 'message', text: 'Opening the pull request.' },
      { kind: 'call', tool: 'github.pr.create', input: { repo: REPO, title: 'feat: {{runId}}', head: 'feat/{{runId}}', body: 'Closes #1' } },
      { kind: 'complete', summary: 'Opened the pull request.' },
    ] } },
  });
  const me = await api('GET', '/v1/me');
  const owner = me.memberships.find((m) => m.workspaceId === ws).memberId;
  await api('POST', `/v1/workspaces/${ws}/members`, { kind: 'agent', name: 'Releaser', reportsTo: owner, roleIds: ['release'], runtimeProfileIds: [runtime.profile?.id ?? runtime.id] });

  const approvals = async (missionId) => (await api('GET', `/v1/approvals?missionId=${missionId}`)).map((v) => v.approval ?? v);
  const tasks = async (missionId) => (await api('GET', `/v1/missions/${missionId}/tasks`)).map((v) => v.task ?? v);
  const decide = (id) => api('POST', `/v1/approvals/${id}/decide`, { optionId: 'approve' });
  const startMission = async (workflow, title) => {
    const m = await api('POST', '/v1/missions', { workspaceId: ws, goal: title, title, workflowPreset: workflow, planNow: true, successCriteria: ['A pull request is open.'] });
    const missionId = m.mission?.id ?? m.id;
    const plan = await until(async () => (await approvals(missionId)).find((a) => a.kind === 'plan' && a.status === 'PENDING'), 30_000, 'the plan card');
    await decide(plan.id);
    return missionId;
  };
  const prs = () => readState(ghDir).repos[REPO]?.prs ?? [];

  // ------------------------------------------------------------- 1. approved
  console.log('\n1. a step approved with github.pr.create on its card');
  const one = await startMission('approved', 'Open the approved PR');
  const start = await until(async () => (await approvals(one)).find((a) => a.title.startsWith('Start ') && a.status === 'PENDING'), 30_000, 'the start card');
  check('the start card names github.pr.create', start.effect.includes('github.pr.create'), start.effect);
  await decide(start.id);
  await until(async () => (await tasks(one)).every((t) => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status))
    || (await approvals(one)).some((a) => a.title.startsWith('Allow ')), 60_000, 'the approved step');
  check('no second card for the call', !(await approvals(one)).some((a) => a.title.startsWith('Allow ')), (await approvals(one)).map((a) => a.title));
  check('the step finished', (await tasks(one))[0].status === 'SUCCEEDED', (await tasks(one))[0]);
  check('the pull request was opened', prs().length === 1, prs());

  // ---------------------------------------------------- 2. waiting on you
  console.log('\n2. a call that asks: the step waits on you');
  const electron = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(scratch, 'electron')}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(root, 'apps/desktop'), stdio: ['ignore', openSync(join(real, 'electron.log'), 'a'), openSync(join(real, 'electron.log'), 'a')], detached: true, env: { ...process.env, TANDEMISE_HOME: home },
  });
  procs.push(electron);
  keepPainting([PORT]);
  const page = await connect(PORT, { timeoutMs: 120_000 });
  await page.waitForText('Ship', { timeoutMs: 60_000 });

  const two = await startMission('unapproved', 'Open the unapproved PR');
  const card = await until(async () => (await approvals(two)).find((a) => a.title.startsWith('Allow ') && a.status === 'PENDING'), 60_000, 'the tool card');
  const askedAt = Date.now();
  check('the call asks', card.title === 'Allow github.pr.create?', card.title);
  await page.navigate(`#/missions/${two}`);
  const text = await page.waitForText('Waiting on you', { timeoutMs: 30_000 }).catch((e) => e.message);
  const badge = await page.evaluate(`[...document.querySelectorAll('.feedcard .badge')].map((b) => b.innerText.trim()).join(' | ')`);
  check('the step card says "Waiting on you"', badge.includes('Waiting on you'), badge);
  check('and not Running', !badge.includes('Running'), badge);
  check('the card names the call', text.includes('Allow github.pr.create?'), text.slice(0, 800));
  check('the task reads AWAITING_INPUT', (await tasks(two))[0].status === 'AWAITING_INPUT', (await tasks(two))[0].status);
  writeFileSync(join(shots, 'waiting-on-you.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

  // The whole budget, and some, with nobody answering.
  await sleep(Math.max(0, BUDGET_MS + 5_000 - (Date.now() - askedAt)));
  const still = (await approvals(two)).find((a) => a.id === card.id);
  check(`the card is still waiting after the ${BUDGET_MS / 1000}s budget`, still.status === 'PENDING', still.status);
  check('the step is still waiting on you', (await tasks(two))[0].status === 'AWAITING_INPUT', (await tasks(two))[0].status);

  // Answer it from the app.
  const clicked = await page.click('Allow once');
  check('the card offers "Allow once" on the mission', clicked !== false);
  await page.waitForText('Allow once?', { timeoutMs: 10_000 }).catch(() => '');
  writeFileSync(join(shots, 'confirm.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const confirmed = await page.click('Allow once', { within: '[role=dialog]' });
  check('and its confirmation', confirmed !== false);
  if (clicked === false || confirmed === false) await decide(card.id);
  await until(async () => (await tasks(two))[0].status === 'SUCCEEDED', 60_000, 'the step to finish');
  check('answered, the step finishes', (await tasks(two))[0].status === 'SUCCEEDED');
  check('and the pull request is opened', prs().length === 2, prs().map((p) => p.headRefName));
  await sleep(1500);
  writeFileSync(join(shots, 'answered.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  page.close();
} catch (e) {
  bad++;
  console.log(`  FAIL threw  ${e.message}`);
}

stop();
console.log(`\nscreenshots: ${join(real, 'shots')}`);
console.log(bad === 0 ? 'step-approval-live-check: all passed' : `step-approval-live-check: ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
