/**
 * #153 in the real app: after a daemon restart, the Board of a project whose
 * tracker comes from its brain still has that tracker.
 *
 * A fresh TANDEMISE_HOME, the daemon from this checkout's `dist` (a fake `gh`
 * first on its PATH, so nothing reaches GitHub), and the desktop window from
 * `electron-vite dev` over CDP. The project is linked to a brain kept on this
 * machine whose `factory/tracker.yaml` names a GitHub Issues tracker; the
 * daemon is stopped and started again with nothing new in the brain, and the
 * Board is read.
 *
 *   npm run build && node scratch/brain-restart-live.mjs [--keep-painting]
 *
 * Env: LIVE_ROOT (a short directory for the run, default a temp dir),
 * CDP_PORT (default 9731), EVIDENCE_DIR (screenshots and a JSON summary).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { installFakeGh, putIssue, putLabels } from './fake-gh.mjs';
import { keepPainting } from './acceptance/p0/lib/frame-pump.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.CDP_PORT ?? 9731);
const ROOT = process.env.LIVE_ROOT ?? mkdtempSync(join(tmpdir(), 'tdm-153-'));
const EVIDENCE = process.env.EVIDENCE_DIR ?? join(ROOT, 'evidence');
const home = join(ROOT, 'home');
mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Live', '-c', 'user.email=live@example.invalid', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const results = [];
const check = (label, ok, observed) => {
  results.push({ label, ok, observed });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -> ${JSON.stringify(observed)?.slice(0, 400)}`}`);
};

const ghBin = installFakeGh(join(ROOT, 'gh'));
putIssue(join(ROOT, 'gh'), 'acme/app', { number: 41, title: 'The settings page title reads Setings', labels: ['bug'] });
putLabels(join(ROOT, 'gh'), 'acme/app', ['bug', 'in progress']);
const gitconfig = join(ROOT, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = Live\n\temail = live@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
const daemonEnv = { ...process.env, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error', TANDEMISE_OFFLINE: '1', PATH: `${ghBin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: gitconfig };

const procs = [];
const stopAll = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);

async function startDaemon() {
  rmSync(join(home, 'daemon.json'), { force: true });
  const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], { cwd: root, stdio: 'ignore', detached: true, env: daemonEnv });
  procs.push(daemon);
  for (let i = 0; i < 120 && !existsSync(join(home, 'daemon.json')); i++) await sleep(250);
  const conn = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  const api = async (method, path, body) => {
    const res = await fetch(`${conn.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { daemon, conn, api };
}

async function stopDaemon(d) {
  try { process.kill(d.conn.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 80; i++) {
    try { process.kill(d.conn.pid, 0); } catch { return; }
    await sleep(250);
  }
}

let failed = false;
try {
  // ---------------------------------------------------------------- a project and its brain
  let d = await startDaemon();
  const project = join(ROOT, 'project');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), '# app\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  const ws = (await d.api('POST', '/v1/workspaces', { name: 'Brain tracker', repositoryPath: project })).body?.workspace?.id;
  const tracker = {
    kind: 'github-issues', repo: 'acme/app', board: 'is:open',
    states: { ready: ['open'], in_progress: 'in progress', done: ['closed'], wont_do: [] }, onComplete: 'done',
  };
  const put = await d.api('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker, intake: { sources: [] } });
  check('the project has a tracker of its own first', put.status === 200 && put.body?.tracker?.repo === 'acme/app', put);
  const linked = await d.api('POST', `/v1/workspaces/${ws}/brain`, { mode: 'local' });
  check('the project is linked to a brain on this machine', linked.body?.status === 'local_only', linked.body?.status);
  const before = (await d.api('GET', `/v1/workspaces/${ws}/intake/config`)).body;
  check('before the restart, intake reads the tracker from the brain', before?.origin === 'brain' && before.tracker?.repo === 'acme/app', before);

  // ---------------------------------------------------------------- restart, nothing new in the brain
  const head = git(join(home, 'brains', ws), 'rev-parse', 'HEAD').trim();
  await stopDaemon(d);
  d = await startDaemon();
  check('the daemon restarted', typeof d.conn.url === 'string', d.conn.url);
  check('…with the brain where it was', git(join(home, 'brains', ws), 'rev-parse', 'HEAD').trim() === head, head);

  // ---------------------------------------------------------------- the window
  const electron = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(ROOT, 'electron')}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(root, 'apps/desktop'), stdio: 'ignore', detached: true, env: { ...process.env, TANDEMISE_HOME: home, PATH: daemonEnv.PATH },
  });
  procs.push(electron);
  keepPainting([PORT]);
  let page;
  for (let i = 0; i < 180 && !page; i++) {
    await sleep(500);
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = tabs.find((t) => t.type === 'page' && t.url.startsWith('http://'));
    } catch { /* not yet */ }
  }
  if (!page) throw new Error('the window never appeared');
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  sock.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise((r) => sock.on('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const path = join(EVIDENCE, `${name}.png`);
    if (r?.data) writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  };

  await sleep(3000);
  await evalJs(`location.hash = '#/board'`);
  let text = '';
  for (let i = 0; i < 60; i++) {
    text = (await evalJs('document.body.innerText')) ?? '';
    if (text.includes("Set this project's tracker first.") || text.includes('The settings page title reads Setings')) break;
    await sleep(500);
  }
  await sleep(500);
  text = (await evalJs('document.body.innerText')) ?? text;
  const board = await shot('board-after-restart');
  check('after the restart the Board does not ask for a tracker', !text.includes("Set this project's tracker first."), text.slice(0, 600));
  check('…and lists the item from the brain\'s tracker', text.includes('The settings page title reads Setings'), text.slice(0, 600));
  console.log(`  screenshot: ${board}`);
  const after = (await d.api('GET', `/v1/workspaces/${ws}/intake/config`)).body;
  check('intake config after the restart has the tracker', after?.origin === 'brain' && after.tracker?.repo === 'acme/app', after);
  sock.close();
} catch (e) {
  failed = true;
  console.log(e);
} finally {
  writeFileSync(join(EVIDENCE, 'brain-restart-live.json'), JSON.stringify({ when: new Date().toISOString(), build: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(), results }, null, 2));
  stopAll();
  try { execFileSync('pkill', ['-f', `user-data-dir=${join(ROOT, 'electron')}`]); } catch { /* none */ }
}
const ok = !failed && results.every((r) => r.ok);
console.log(ok ? '\nall passed' : '\nFAILED');
process.exit(ok ? 0 : 1);
