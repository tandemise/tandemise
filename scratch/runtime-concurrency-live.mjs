/**
 * Issue #101 in the real app: the desktop window (electron-vite dev, over CDP)
 * against a daemon from this checkout, with a fresh TANDEMISE_HOME and a fake
 * YouTrack. Needs a display, so it is not an offline check.
 *
 *   npm run build && node scratch/runtime-concurrency-live.mjs
 *
 * 1. Runtimes → Discover runtimes → Add on "Fake Runtime": its card says 3.
 * 2. The card's Concurrency saves as it changes (a pause, or Enter) and says
 *    "Saved"; an out-of-range value shows the daemon's own words.
 * 3. The Configure panel's Save saves the concurrency too.
 * 4. With the runtime at 1 and two items started from the Board, the second
 *    mission's In-progress row says "Waiting for a free slot on Fake Runtime".
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startFakeYouTrack } from './fake-youtrack.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const PORT = 9327;
const scratch = mkdtempSync(join(tmpdir(), 'trc-live-'));
const home = join(scratch, 'home');
const repo = join(scratch, 'repo');
const gitConfig = join(scratch, 'gitconfig');

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? `  ${detail}` : ''}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const v = await fn(); if (v) return v; }
  return undefined;
};

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (res.ok) { console.error(`something is already debugging on port ${PORT}`); process.exit(1); }
} catch { /* nothing listening */ }

const procs = [];
const stop = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  }
};
process.on('exit', () => { stop(); rmSync(scratch, { recursive: true, force: true }); });

// A repository for the missions to work in.
writeFileSync(gitConfig, '[user]\n\tname = Live Tester\n\temail = live@example.com\n');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig };
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore', env: gitEnv });
writeFileSync(join(repo, 'README.md'), '# live check\n');
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore', env: gitEnv });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore', env: gitEnv });

const yt = await startFakeYouTrack({ project: 'ACME', token: 'perm:test', login: 'tandemise-bot' });
const first = yt.putIssue({ summary: 'Checkout fails on Safari', description: 'Pay does nothing.\n\n## Done when\n- [ ] Checkout works on Safari', state: 'Open' }).idReadable;
const second = yt.putIssue({ summary: 'Search ignores the date filter', description: 'Everything comes back.\n\n## Done when\n- [ ] Search honours the date filter', state: 'Open' }).idReadable;

try {
  const daemon = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
    cwd: root, stdio: 'ignore', detached: true,
    env: { ...gitEnv, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error', TANDEMISE_TICK_MS: '300' },
  });
  procs.push(daemon);
  const connFile = join(home, 'daemon.json');
  await until(() => existsSync(connFile), 30_000);
  const conn = JSON.parse(readFileSync(connFile, 'utf8'));
  const api = async (method, path, body) => {
    const r = await fetch(`${conn.url}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  ok('daemon is up', typeof conn.url === 'string', conn.url);

  // The project, its tracker and plan approval left to the factory.
  const created = await api('POST', '/workspaces', { name: 'Concurrency live', repositoryPath: repo });
  const ws = created.body.workspace;
  await api('PATCH', `/workspaces/${ws.id}`, { autonomy: { ...ws.autonomy, planApproval: 'auto' } });
  const tracker = await api('PUT', `/workspaces/${ws.id}/intake/config`, {
    tracker: {
      kind: 'youtrack', url: yt.url, project: 'ACME', board: 'project: ACME #Unresolved',
      states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
    },
  });
  await api('PUT', `/workspaces/${ws.id}/intake/tracker/secret`, { value: 'perm:test' });
  ok('a project with a fake YouTrack', tracker.status === 200, tracker.body);

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
    } catch { /* not yet */ }
  }
  ok('renderer loaded from the dev server', !!page, page?.url ?? 'no page');
  if (!page) throw new Error('renderer never appeared');

  const cdp = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  cdp.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => cdp.on('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); cdp.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const dir = join(root, 'scratch', 'out', 'runtime-concurrency-live');
    mkdirSync(dir, { recursive: true });
    if (shot.result?.data) writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
  };
  const navigate = (hash) => evalJs(`location.hash = ${JSON.stringify(hash)}; true`);
  const clickButton = (label, scope = 'document') => evalJs(`(() => {
    const b = [...${scope}.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false; b.click(); return true;
  })()`);
  // Types into a React input the way a person does: the native setter, then an input event.
  const typeInto = (selector, value) => evalJs(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  // Focus and blur fire as they would for a person, even when the window is behind another.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await until(async () => ((await evalJs('document.body.innerText')) ?? '').includes('Concurrency live'), 40_000);

  // ---- 1. Discover runtimes → Add
  await navigate('#/runtimes');
  await until(() => evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Discover runtimes'))`));
  await clickButton('Discover runtimes');
  const row = await until(() => evalJs(`(() => {
    const r = [...document.querySelectorAll('.list__row')].find((x) => x.querySelector('.list__title')?.textContent.trim() === 'Fake Runtime');
    return r ? r.innerText : null;
  })()`));
  ok('discovery offers the Fake Runtime', !!row, row);
  await evalJs(`[...document.querySelectorAll('.list__row')].find((x) => x.querySelector('.list__title')?.textContent.trim() === 'Fake Runtime').querySelector('button').click()`);
  await until(() => evalJs(`[...document.querySelectorAll('.list__row')].some((x) => x.innerText.includes('Fake Runtime') && x.innerText.includes('Configured'))`));
  await clickButton('Done');
  const SEL = 'input[aria-label="Concurrency of Fake Runtime"]';
  const shown = await until(() => evalJs(`document.querySelector(${JSON.stringify(SEL)})?.value ?? null`));
  const runtime = (await api('GET', `/runtimes?workspaceId=${ws.id}`)).body.find((v) => v.profile.name === 'Fake Runtime')?.profile;
  ok('Discover → Add starts the runtime at 3 (the card)', shown === '3', shown);
  ok('…and the daemon stored 3', runtime?.maxConcurrent === 3, runtime?.maxConcurrent);
  await screenshot('1-discovered-at-3');

  const statusText = () => evalJs(`document.querySelector(${JSON.stringify(SEL)})?.closest('.row')?.querySelector('[role="status"]')?.textContent ?? null`);
  const stored = async () => (await api('GET', `/runtimes?workspaceId=${ws.id}`)).body.find((v) => v.profile.id === runtime.id)?.profile.maxConcurrent;

  // ---- 2. The card saves as it changes
  await typeInto(SEL, '2');
  const saved2 = await until(async () => (await statusText()) === 'Saved' && (await stored()) === 2, 5_000);
  ok('typing 2 and pausing saves it, without leaving the field, and says "Saved"', !!saved2, { status: await statusText(), stored: await stored() });
  ok('…the field still has focus (nothing was blurred)', await evalJs(`document.activeElement === document.querySelector(${JSON.stringify(SEL)})`));
  await screenshot('2-saved-on-change');

  await typeInto(SEL, '9');
  const refused = await until(async () => { const s = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(SEL)})?.closest('.row')?.querySelector('[role="status"]'); return el?.dataset.concurrencyStatus === 'error' ? el.textContent : null; })()`); return s; }, 5_000);
  ok('an out-of-range 9 shows the daemon\'s refusal in its own words', typeof refused === 'string' && refused.length > 0 && refused !== 'Saved', refused);
  ok('…and nothing was stored', (await stored()) === 2, await stored());
  ok('…while the field keeps what was typed', (await evalJs(`document.querySelector(${JSON.stringify(SEL)})?.value`)) === '9', await evalJs(`document.querySelector(${JSON.stringify(SEL)})?.value`));
  await screenshot('2-refused');

  await typeInto(SEL, '3');
  await evalJs(`document.querySelector(${JSON.stringify(SEL)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  // Read well before the 600 ms pause would have saved it: Enter saves at once.
  await sleep(250);
  ok('Enter saves at once', (await stored()) === 3, await stored());
  await until(async () => (await statusText()) === 'Saved', 3_000);
  ok('…and says "Saved"', (await statusText()) === 'Saved', await statusText());
  await evalJs(`document.querySelector(${JSON.stringify(SEL)}).blur()`);

  // ---- 3. The Configure panel's Save
  await evalJs(`(() => { const card = document.querySelector(${JSON.stringify(SEL)}).closest('article'); [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Configure').click(); })()`);
  const dialogInput = await until(() => evalJs(`(() => { const d = document.querySelector('[role="dialog"]'); const label = d && [...d.querySelectorAll('label')].find((l) => l.textContent.includes('Concurrency')); return label ? true : null; })()`));
  ok('the Configure panel has a Concurrency field', !!dialogInput);
  await evalJs(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const input = d.querySelector('input[type="number"]');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await screenshot('3-configure-panel');
  await clickButton('Save', `document.querySelector('[role="dialog"]')`);
  const panelSaved = await until(async () => (await stored()) === 1, 5_000);
  ok('Configure → Save stores the concurrency (1)', !!panelSaved, await stored());
  const cardFollows = await until(async () => (await evalJs(`document.querySelector(${JSON.stringify(SEL)})?.value`)) === '1', 5_000);
  ok('…and the card follows it', !!cardFollows, await evalJs(`document.querySelector(${JSON.stringify(SEL)})?.value`));

  // ---- 4. The Board says when work waits for a slot
  // Every run of this runtime holds its slot for ten minutes; the planner gets
  // no plan at all and falls back to the preset.
  await api('PATCH', `/runtimes/${runtime.id}`, {
    settings: { script: { steps: [
      { kind: 'complete', summary: 'no plan', when: { promptIncludes: 'You are the Planner for Tandemise' } },
      { kind: 'delay', ms: 600_000 },
      { kind: 'complete', summary: 'done' },
    ] } },
  });
  await api('POST', `/workspaces/${ws.id}/board/refresh`);
  const a = await api('POST', `/workspaces/${ws.id}/board/start`, { key: first });
  const b = await api('POST', `/workspaces/${ws.id}/board/start`, { key: second });
  ok('both items started', a.status === 200 && b.status === 200, [a.status, b.status, a.body?.error, b.body?.error]);
  await navigate('#/board');
  const waiting = await until(() => evalJs(`[...document.querySelectorAll('[data-board-group="inProgress"] [data-board-item]')].map((r) => ({ key: r.dataset.boardItem, text: r.innerText, waiting: r.querySelector('[data-board-waiting]')?.textContent ?? null })).filter((r) => r.waiting)`).then((rows) => (rows?.length ? rows : null)), 60_000);
  ok('an In-progress row says "Waiting for a free slot on Fake Runtime"', waiting?.some((r) => r.waiting === 'Waiting for a free slot on Fake Runtime') === true, waiting ?? (await evalJs(`document.querySelector('[data-board-group="inProgress"]')?.innerText`)));
  const rows = await evalJs(`[...document.querySelectorAll('[data-board-group="inProgress"] [data-board-item]')].map((r) => r.innerText.replace(/\\n/g, ' | '))`);
  console.log('     In progress:', JSON.stringify(rows));
  await screenshot('4-board-waiting');
  cdp.close();
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`  FAIL threw  ${error.stack}`);
}

stop();
await yt.stop();
console.log(`\n${failures.length === 0 ? `ALL ${passed} RUNTIME CONCURRENCY LIVE CHECKS PASSED` : `${passed} passed, ${failures.length} FAILED:\n  - ${failures.join('\n  - ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
