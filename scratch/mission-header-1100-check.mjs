#!/usr/bin/env node
// #132: at 1100 and 1440px, light and dark, in the real app: the mission header's actions stay
// level with the title whether the task's disclosure is open or closed, and a running step card
// shows `by` and `responsible` in full, with the action row wrapping below them.
//   npm run build && node scratch/mission-header-1100-check.mjs
// The run needs no model: a scripted agent writes the step's output, and a round on it then hangs,
// so the step is really RUNNING. With a display it drives the Electron window (electron-vite dev over
// CDP). With none, Electron cannot open a window (BrowserWindow crashes on the headless platform), so
// H132_BROWSER=1 runs the built renderer in Playwright's Chromium against the same real daemon, with
// the preload bridge shimmed: real CSS and DOM, but not the Electron shell. Needs, first:
//   npx electron-vite build (apps/desktop) and npx playwright install chromium-headless-shell
// Settings: H132_ROOT (scratch folder), H132_OUT (screenshots), H132_CDP (port, must be free).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './acceptance/p0/lib/cdp.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ROOT = process.env.H132_ROOT ?? join(REPO, 'node_modules/.cache/h132/run');
const OUT = process.env.H132_OUT ?? join(ROOT, 'shots');
const PORT = Number(process.env.H132_CDP ?? 9371);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) passed++; else failures.push(name);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

rmSync(ROOT, { recursive: true, force: true });
const home = join(ROOT, 'home');
const project = join(ROOT, 'project');
mkdirSync(home, { recursive: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(project, '.tandemise/workflows'), { recursive: true });
writeFileSync(join(project, 'README.md'), '# Demo\n');
writeFileSync(join(project, '.gitignore'), '.tandemise/out/\n');
writeFileSync(join(project, '.tandemise/workflows/h132.yaml'), `name: Header check
description: One agent step, then a person step that keeps the mission open.
steps:
  - key: implement
    role: development
    objective: Make the change.
    outputs: [ChangeSet]
  - key: sign_off
    role: product
    executor: human
    dependsOn: [implement]
    objective: Sign it off.
    outputs: [Evidence]
`);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: project, stdio: 'ignore', windowsHide: true });
git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'init');

// The first run writes the output through the acceptance suite's scripted agent; once the marker exists, a run hangs.
const marker = join(ROOT, 'hang-now');
const agent = join(ROOT, 'agent.mjs');
writeFileSync(agent, `import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (existsSync(${JSON.stringify(marker)})) { process.stdin.resume(); setInterval(() => {}, 60000); }
else { const c = spawn(process.execPath, [${JSON.stringify(join(REPO, 'scratch/acceptance/p0/scripted-agent.mjs'))}], { stdio: 'inherit', windowsHide: true }); c.on('exit', (code) => process.exit(code ?? 1)); }
`);

const procs = [];
const stop = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stop);

const log = openSync(join(ROOT, 'daemon.log'), 'a');
// A run's socket lives under the home, and a Unix socket path is cut off at 108 bytes (it surfaces as EADDRINUSE).
// From a deep checkout on Linux, the daemon names the same folder through its own /proc entry, which stays short.
const longHome = process.platform === 'linux' && home.length > 60;
const daemon = spawn(longHome ? '/bin/sh' : process.execPath, longHome
  ? ['-c', `TANDEMISE_HOME=/proc/$$/cwd/home exec "$0" ${JSON.stringify(join(REPO, 'apps/daemon/dist/main.js'))}`.replace('"$0"', JSON.stringify(process.execPath))]
  : [join(REPO, 'apps/daemon/dist/main.js')], {
  cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true,
  env: { ...process.env, ...(longHome ? {} : { TANDEMISE_HOME: home }), TANDEMISE_OWNER_NAME: 'Sam Rivera', SCRIPTED_DELAY_MS: '200', SCRIPTED_STATE_DIR: join(ROOT, 'state'), SCRIPTED_PROMPT_DIR: join(ROOT, 'prompts') },
});
procs.push(daemon);
const handshake = join(home, 'daemon.json');
let info;
for (let i = 0; i < 100 && !info; i++) { await sleep(200); if (existsSync(handshake)) { const n = JSON.parse(readFileSync(handshake, 'utf8')); if (n.pid === daemon.pid) info = n; } }
if (!info) throw new Error('the daemon did not start');
const api = async (method, path, body) => {
  const res = await fetch(`${info.url}/v1${path}`, { method, headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};
const until = async (fn, label, timeoutMs = 120_000) => {
  for (const end = Date.now() + timeoutMs; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(500); }
};

const ws = await api('POST', '/workspaces', { name: 'Demo', repositoryPath: project });
const workspaceId = ws.id ?? ws.workspace?.id;
const profile = await api('POST', '/runtimes', {
  adapterId: 'generic-cli', name: 'Demo agent', workspaceId: null,
  settings: { command: 'node', args: [agent], promptVia: 'stdin', outputFormat: 'ndjson', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
  maxConcurrent: 4, enabled: true,
});
const team = await api('GET', `/workspaces/${workspaceId}/team`);
const owner = team.members.find((m) => m.kind === 'person' && m.access === 'owner');
await api('POST', `/workspaces/${workspaceId}/members`, { kind: 'agent', name: 'Coding agent', reportsTo: owner.id, roleIds: ['development'], title: 'Builds the change', runtimeProfileIds: [profile.profile?.id ?? profile.id] });

const title = 'Mission header actions float mid-header and step card meta is squeezed at 1100px';
const goal = `GitHub #132, started by Sam Rivera: https://example.invalid/issues/132

The task as written in the tracker:

${title}

## What happens

With the task open, the header grows, and its actions end up in the middle of it.

${'One more line of the task as written, so the open disclosure makes the header properly tall.\n'.repeat(8)}`;
const created = await api('POST', '/missions', { workspaceId, title, goal, successCriteria: ['The header reads well'], workflowPreset: 'h132', planNow: true });
const missionId = created.mission?.id ?? created.id;
// A plan may wait on a person or be approved by policy; either way the step's first run follows.
const taskOf0 = async () => (await api('GET', `/missions/${missionId}/tasks`)).find((t) => t.key === 'implement');
await until(async () => {
  const plan = (await api('GET', `/approvals?missionId=${missionId}&status=PENDING`)).map((v) => v.approval).find((a) => a.kind === 'plan');
  if (plan) await api('POST', `/approvals/${plan.id}/decide`, { optionId: 'approve' });
  return plan || (await taskOf0())?.status === 'RUNNING' || (await taskOf0())?.status === 'SUCCEEDED';
}, 'the plan to be approved', 60_000).catch(async (e) => { console.error(JSON.stringify(await api('GET', `/missions/${missionId}`)).slice(0, 1500)); throw e; });
const taskOf = async () => (await api('GET', `/missions/${missionId}/tasks`)).find((t) => t.key === 'implement');
const done = await until(async () => { const t = await taskOf(); return t?.status === 'SUCCEEDED' && t; }, 'the first run of the step', 60_000).catch(async (e) => { console.error(JSON.stringify((await api('GET', `/missions/${missionId}/tasks`)).map((t) => ({ key: t.key, status: t.status, why: t.statusReason, assignee: t.assignee?.name })))); throw e; });
writeFileSync(marker, '');
const note = await api('POST', `/tasks/${done.id}/feedback`, { text: 'One more pass, please.' });
if (note.roundStarted === null) await api('POST', `/tasks/${done.id}/rounds`, { feedbackIds: [note.feedback.id], downstream: 'keep' });
await until(async () => (await taskOf())?.status === 'RUNNING', 'the round to run');

const useBrowser = process.env.H132_BROWSER === '1';
const openElectron = async () => {
  const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(REPO, 'apps/desktop'), detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, TANDEMISE_HOME: home },
  });
  procs.push(desktop);
  const cdp = await connect(PORT, { timeoutMs: 120_000 });
  await cdp.waitForText('Daemon connected', { timeoutMs: 90_000 });
  return { ...cdp, setWidth: (width) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false }) };
};
const openBrowser = async () => {
  const { chromium } = await import('playwright');
  const dist = join(REPO, 'apps/desktop/dist/renderer');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = join(dist, path === '/' ? 'index.html' : path);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(5173, 'localhost', r));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const status = { phase: 'connected', connection: { url: info.url, token: info.token, pid: info.pid, version: info.version ?? '0', apiVersion: info.apiVersion ?? 'v1' }, detail: '', handshakePath: handshake, updatedAt: new Date().toISOString() };
  await context.addInitScript((st) => {
    const nothing = async () => undefined;
    window.tandemise = { platform: 'linux', getDaemonStatus: async () => st, reconnectDaemon: async () => st, onDaemonStatus: () => () => {}, selectDirectory: nothing, openExternal: nothing, revealInFinder: nothing, testNotification: nothing, onNotificationOpen: () => () => {}, notificationsDebug: nothing, getAppInfo: async () => ({}) };
  }, status);
  const pw = await context.newPage();
  pw.on('pageerror', (e) => console.log(`       page error: ${e.message}`));
  await pw.goto('http://localhost:5173/');
  await pw.waitForFunction(() => document.body.innerText.includes('Daemon connected'), undefined, { timeout: 60_000 });
  return {
    evaluate: (expression) => pw.evaluate(expression),
    navigate: (hash) => pw.evaluate(`location.hash = ${JSON.stringify(hash)}`),
    setWidth: (width) => pw.setViewportSize({ width, height: 820 }),
    screenshot: (path) => pw.screenshot({ path }),
    close: () => { void browser.close(); server.close(); },
  };
};
const page = await (useBrowser ? openBrowser() : openElectron());
console.log(`  driving: ${useBrowser ? 'built renderer in Chromium (no Electron shell), real daemon' : 'Electron window, real daemon'}`);
await page.navigate(`#/missions/${missionId}`);
await until(() => page.evaluate(`!!document.querySelector('.mission-subtitle__details') && !!document.querySelector('.feedcard[data-section="in_progress"] .feedcard__actions')`), 'the mission and its running card', 30_000);

const measure = () => page.evaluate(`(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
  const title = rect(document.querySelector('.topbar__title'));
  const actions = rect(document.querySelector('.topbar__actions'));
  const firstAction = rect(document.querySelector('.topbar__actions > *'));
  const card = document.querySelector('.feedcard[data-section="in_progress"]');
  const chips = [...card.querySelectorAll('.feedcard__byline .actor')].map((a) => {
    const name = a.querySelector('.actor__name');
    return { text: a.innerText.replace(/\\s+/g, ' ').trim(), clipped: a.scrollWidth > a.clientWidth + 1 || (name ? name.scrollWidth > name.clientWidth + 1 : false) };
  });
  const attribution = card.querySelector('.attribution');
  return {
    width: window.innerWidth, title, actions, firstAction,
    bar: rect(document.querySelector('.topbar')),
    chips, attribution: rect(attribution),
    attributionClipped: attribution.scrollWidth > attribution.clientWidth + 1,
    cardActions: rect(card.querySelector('.feedcard__actions')),
    card: rect(card),
    buttons: [...card.querySelectorAll('.feedcard__actions > *')].map((b) => b.innerText.trim()),
    alignItems: getComputedStyle(document.querySelector('.topbar__inner')).alignItems,
    hscroll: document.documentElement.scrollWidth > window.innerWidth,
  };
})()`);

// Every state, once from the app's own theme switch so a dark render is the app's dark render.
for (const width of [1100, 1440]) {
  for (const theme of ['light', 'dark']) {
    await page.setWidth(width);
    await page.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    const tops = {};
    for (const state of ['closed', 'open']) {
      await page.evaluate(`document.querySelector('.mission-subtitle__details').open = ${state === 'open'}`);
      await sleep(300);
      const m = await measure();
      const label = `${width}px ${theme}, task ${state}`;
      tops[state] = m;
      const mid = m.firstAction.top + m.firstAction.height / 2;
      ok(`${label}: the actions are level with the title`, mid >= m.title.top && mid <= m.title.bottom, { actionMid: mid, title: [m.title.top, m.title.bottom] });
      ok(`${label}: the actions start on the title's row`, Math.abs(m.actions.top - m.title.top) < 1, [m.actions.top, m.title.top]);
      ok(`${label}: the header is top-aligned`, m.alignItems === 'flex-start', m.alignItems);
      ok(`${label}: the header holds its actions`, m.actions.bottom <= m.bar.bottom && m.actions.right <= m.width, { actionsBottom: m.actions.bottom, barBottom: m.bar.bottom });
      ok(`${label}: by and responsible are both there, in full`, m.chips.length === 2 && m.chips[0].text.startsWith('by Coding agent') && /^responsible .*(You|Sam Rivera)/.test(m.chips[1].text) && m.chips.every((c) => !c.clipped) && !m.attributionClipped, m.chips);
      ok(`${label}: the card's actions stay inside the card`, m.cardActions.right <= m.card.right + 1 && m.cardActions.left >= m.card.left, { actions: [m.cardActions.left, m.cardActions.right], card: [m.card.left, m.card.right] });
      ok(`${label}: the page does not scroll sideways`, !m.hscroll);
      if (state === 'open') console.log(`       card actions: ${JSON.stringify(m.buttons)} wrappedBelowMeta=${m.cardActions.top >= m.attribution.bottom}`);
      await page.screenshot(join(OUT, `header-${width}-${theme}-${state}.png`));
    }
    ok(`${width}px ${theme}: opening the task moves the actions not at all`, Math.abs(tops.closed.actions.top - tops.open.actions.top) < 1, [tops.closed.actions.top, tops.open.actions.top]);
    ok(`${width}px ${theme}: opening the task does grow the header`, tops.open.bar.height > tops.closed.bar.height + 40, [tops.closed.bar.height, tops.open.bar.height]);
    if (width === 1100) ok(`1100px ${theme}: the action row wraps below the meta`, tops.closed.cardActions.top >= tops.closed.attribution.bottom, [tops.closed.attribution.bottom, tops.closed.cardActions.top]);
    await page.evaluate(`document.querySelector('.mission-subtitle__details').open = false`);
  }
}

// However tall the crumbs get (wrapped crumbs, larger text), the actions stay on the title's row.
await page.setWidth(1100);
for (const [what, css] of [['taller crumbs', 'padding-bottom: 40px'], ['larger crumb text', 'font-size: 26px']]) {
  await page.evaluate(`(() => { const s = document.createElement('style'); s.id = 'h132-grow'; s.textContent = '.topbar__eyebrow { ${css}; }'; document.head.append(s); })()`);
  await sleep(200);
  const m = await measure();
  const eyebrow = await page.evaluate(`document.querySelector('.topbar__eyebrow').getBoundingClientRect().height`);
  ok(`${what} (${eyebrow}px): the actions start on the title's row`, Math.abs(m.actions.top - m.title.top) < 1, [m.actions.top, m.title.top]);
  await page.screenshot(join(OUT, `header-1100-${what.replace(/ /g, '-')}.png`));
  await page.evaluate(`document.getElementById('h132-grow').remove()`);
}
// The titles have no box in the grid, so their children must opt out of the drag region themselves, or their links stop working.
const regions = await page.evaluate(`['.topbar__eyebrow', '.topbar__title', '.topbar__subtitle', '.topbar__actions'].map((q) => getComputedStyle(document.querySelector(q)).webkitAppRegion)`);
ok('the crumbs, title, subtitle and actions are outside the drag region', regions.every((r) => r === 'no-drag'), regions);
const subtitleLink = await page.evaluate(`(() => { const b = document.querySelector('.mission-subtitle__open').getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.mission-subtitle__open') !== null; })()`);
ok('Open the issue can still be hit', subtitleLink);

// Below the reflow breakpoint the actions wrap to their own row: the step past the crumbs must not follow them there.
await page.setWidth(700);
await page.evaluate(`document.querySelector('.mission-subtitle__details').open = false`);
await sleep(300);
const narrow = await page.evaluate(`(() => { const a = document.querySelector('.topbar__actions'); return { margin: getComputedStyle(a).marginTop, below: a.getBoundingClientRect().top >= document.querySelector('.topbar__titles').getBoundingClientRect().bottom, overflow: document.documentElement.scrollWidth > window.innerWidth }; })()`);
ok('700px: the actions wrap below the titles', narrow.margin === '0px' && narrow.below && !narrow.overflow, narrow);
await page.setWidth(1440);
await sleep(300);
const wide = await measure();
console.log(`       1440 card row: ${JSON.stringify({ attributionRight: wide.attribution.right, actionsLeft: wide.cardActions.left, actionsTop: wide.cardActions.top, attributionBottom: wide.attribution.bottom })}`);

// Other pages share the header: a title with actions, and a plain mission, must still read right.
await page.setWidth(1100);
await page.evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
for (const [name, hash] of [['missions', '#/missions'], ['team', '#/team'], ['inbox', '#/inbox']]) {
  await page.navigate(hash); await sleep(800);
  const g = await page.evaluate(`(() => { const t = document.querySelector('.topbar__title')?.getBoundingClientRect(); const a = document.querySelector('.topbar__actions > *')?.getBoundingClientRect(); return t ? { title: [t.top, t.bottom], action: a ? [a.top, a.bottom] : null } : null; })()`);
  console.log(`       ${name}: ${JSON.stringify(g)}`);
  if (g?.action) ok(`${name}: its action starts level with the title`, Math.abs(g.action[0] - g.title[0]) < 1, g);
  await page.screenshot(join(OUT, `other-${name}-1100.png`));
}

page.close();
console.log(failures.length === 0 ? `✓ ${passed} checks passed` : `✗ ${failures.length} failed of ${passed + failures.length}:\n  ${failures.join('\n  ')}`);
process.exit(failures.length === 0 ? 0 : 1);
