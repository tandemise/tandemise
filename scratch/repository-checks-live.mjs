/**
 * #111 in the real app: a repository's checks and their time budgets can be
 * seen and edited in Project settings → Repositories, and what is saved is
 * what the daemon stores.
 *
 *   npm run build && node scratch/repository-checks-live.mjs
 *
 * Same pattern as desktop-live-check.mjs: a fresh TANDEMISE_HOME, the daemon
 * from this checkout, `electron-vite dev` over CDP.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const PORT = 9347;
const home = mkdtempSync(join(tmpdir(), 'tandemise-repo-checks-'));

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${JSON.stringify(detail)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
const stop = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  }
};
process.on('exit', () => { stop(); rmSync(home, { recursive: true, force: true }); });

try {
  const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
    cwd: root, stdio: 'ignore', detached: true,
    env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error' },
  });
  procs.push(daemon);
  const connFile = join(home, 'daemon.json');
  for (let i = 0; i < 120 && !existsSync(connFile); i++) await sleep(250);
  const conn = JSON.parse(readFileSync(connFile, 'utf8'));
  const api = async (method, path, body) => {
    const res = await fetch(`${conn.url}/v1${path}`, {
      method, headers: { authorization: `Bearer ${conn.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const repoDir = join(home, 'repo');
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
  execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const created = await api('POST', '/workspaces', { name: 'Checks project' });
  const workspaceId = created.workspace?.id ?? created.id;
  const repo = await api('POST', `/workspaces/${workspaceId}/repositories`, { path: repoDir, name: 'demo', checks: { test: 'npm test', typecheck: null } });
  ok('a repository with a test command exists', repo?.checks?.test === 'npm test', repo);

  const electron = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`], {
    cwd: desktop, stdio: 'ignore', detached: true, env: { ...process.env, TANDEMISE_HOME: home },
  });
  procs.push(electron);
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500);
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = tabs.find((t) => t.type === 'page' && t.url.startsWith('http://'));
    } catch { /* not listening yet */ }
  }
  if (!page) throw new Error('renderer never appeared');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.on('open', r));
  const evalJs = (expression) => new Promise((res) => {
    const i = ++id;
    pending.set(i, (r) => res(r?.result?.value));
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  const waitFor = async (pred, ms = 20000) => {
    const end = Date.now() + ms;
    let text = '';
    while (Date.now() < end) {
      text = (await evalJs('document.body.innerText')) ?? '';
      if (pred(text)) return text;
      await sleep(300);
    }
    return text;
  };
  const click = (label) => evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return !!b; })()`);
  const fill = (label, value) => evalJs(`(() => {
    const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}));
    const input = l && document.getElementById(l.htmlFor);
    if (!input) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  await waitFor((t) => t.includes('Checks project'));
  await evalJs(`location.hash = '#/project'`);
  let text = await waitFor((t) => t.includes('Repositories') && t.includes('demo'));
  ok('Project settings lists the repository', text.includes('demo'), text.slice(0, 200));
  ok('the row offers its checks', await click('Checks (1 set)'));
  text = await waitFor((t) => t.includes('Tests command'));
  ok('the checks open with each command and budget, saying which gate reads it',
    text.includes('Tests command') && text.includes('Gates read it as checks.tests') && text.includes('Tests time budget (minutes)'), text.slice(0, 600));
  ok('it says a timeout never counts against the agent', text.includes('it never counts against the agent'));
  const shown = await evalJs(`(() => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith('Tests command')); return document.getElementById(l.htmlFor).value; })()`);
  ok('the current test command is shown', shown === 'npm test', shown);

  ok('an out-of-range budget is refused in words', await fill('Tests time budget', '999'));
  await click('Save checks');
  text = await waitFor((t) => t.includes('whole number of minutes'), 5000);
  ok('...with the reason', text.includes('Tests: the time budget is a whole number of minutes from 1 to 240.'));

  await fill('Tests command', 'npm run build && npm run check:boundaries');
  await fill('Tests time budget', '25');
  await click('Save checks');
  text = await waitFor((t) => t.includes('Saved.'), 8000);
  ok('saving says Saved.', text.includes('Saved.'));
  const stored = (await api('GET', `/workspaces/${workspaceId}`));
  const after = (stored.repositories ?? []).find((r) => r.id === repo.id);
  ok('the daemon stored the new command and the 25-minute budget',
    after?.checks?.test === 'npm run build && npm run check:boundaries' && after?.checks?.budgets?.tests === 25, after?.checks);
  ws.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.message}`);
}

stop();
console.log(failures.length === 0 ? `\nALL ${passed} REPOSITORY CHECKS LIVE CHECKS PASSED` : `\n${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
