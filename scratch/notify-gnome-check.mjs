// Real notifications on GNOME, end to end: the desktop app from this checkout
// (electron-vite dev, CDP), a daemon on a fresh TANDEMISE_HOME, and GNOME
// Shell's own notification server, with the D-Bus traffic captured.
//
// Run it inside the private headless GNOME Shell, so the person's own desktop
// settings are never touched (Do Not Disturb is switched in the private one):
//
//   npm run build
//   NOTIFY_NESTED_DIR=/tmp/tdm-gnome sh scratch/notify-gnome-nested.sh node scratch/notify-gnome-check.mjs [evidence-dir]
//
// 1. An Inbox card while the app runs as an AppImage with no .desktop entry:
//    a real banner (the notification carries the icon itself); a click on the
//    banner opens the Inbox; the card is recorded as notified.
// 2. Settings → Notifications offers to add Tandemise to the apps; adding it
//    writes the entry and icon; the test notification reports it was taken and
//    is showing; GNOME now names the app and shows its icon.
// 3. Do Not Disturb on: Settings says so, and the test reports "no banner".
// 4. No notification server (the app on a bus with none): the card is not
//    recorded as notified, Settings says why, and the test reports "Not delivered".
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const PORT = Number(process.env.NOTIFY_CDP_PORT ?? 9851);
const work = mkdtempSync(join(tmpdir(), 'tdm-notify-gnome-'));
const evidence = process.argv[2] ?? join(work, 'evidence');
mkdirSync(evidence, { recursive: true });
const home = join(work, 'home');
const repoDir = join(work, 'repo');
const record = join(work, 'notifications.jsonl');
const fakeAppImage = join(work, 'Tandemise-0.11.0-linux-x86_64.AppImage');
const helper = join(root, 'scratch/notify-gnome-shell.py');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, { label, timeoutMs = 20_000, everyMs = 300 }) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
};

if (!process.env.WAYLAND_DISPLAY || !process.env.DBUS_SESSION_BUS_ADDRESS) {
  console.error('Run this inside scratch/notify-gnome-nested.sh (it needs a GNOME Shell session of its own).');
  process.exit(2);
}

const procs = [];
const stopAll = () => { for (const p of procs.splice(0)) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } } };
process.on('exit', stopAll);

const shell = (...args) => execFileSync('python3', ['-I', helper, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const shot = (name) => { const file = join(evidence, name); shell('shot', file); return file; };
const gsettings = (...args) => execFileSync('gsettings', args, { encoding: 'utf8', windowsHide: true }).trim();

// ------------------------------------------------------------------ D-Bus capture (read-only)
const monitor = spawn('dbus-monitor', ['--session', "interface='org.freedesktop.Notifications'", "type='method_return'", "type='error'"], {
  stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true,
});
procs.push(monitor);
let dbusText = '';
monitor.stdout.on('data', (b) => { dbusText += b.toString(); });

/** The Notify calls Electron made (the first hop, before GNOME's proxy adds x-shell-*), each with the server's reply. */
function notifyCalls() {
  const messages = dbusText.split(/\n(?=\S)/);
  const calls = [];
  for (const m of messages) {
    const head = m.split('\n')[0];
    if (!/member=Notify$/.test(head) || /x-shell-sender/.test(m)) continue;
    const sender = /sender=(\S+)/.exec(head)?.[1];
    const serial = /serial=(\d+)/.exec(head)?.[1];
    const strings = [...m.matchAll(/^ {3}string "(.*)"$/gm)].map((x) => x[1]);
    const reply = messages.find((r) => r.startsWith('method return') && r.includes(`destination=${sender} `) && new RegExp(`reply_serial=${serial}$`, 'm').test(r.split('\n')[0]));
    const error = messages.find((r) => r.startsWith('error') && r.includes(`destination=${sender} `) && new RegExp(`reply_serial=${serial}$`, 'm').test(r.split('\n')[0]));
    calls.push({
      call: m,
      appName: strings[0], title: strings[2], body: strings[3],
      desktopEntry: /string "desktop-entry"\s+variant\s+string "([^"]*)"/.exec(m)?.[1] ?? null,
      imageData: /string "image-data"/.test(m),
      reply: reply ?? null,
      id: reply ? Number(/uint32 (\d+)/.exec(reply)?.[1]) : null,
      error: error ?? null,
    });
  }
  return calls;
}

// ------------------------------------------------------------------ daemon and app
execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore', windowsHide: true });
writeFileSync(join(repoDir, 'README.md'), '# notify gnome check\n');
execFileSync('git', ['-c', 'user.name=Notify', '-c', 'user.email=notify@example.com', 'add', '.'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
execFileSync('git', ['-c', 'user.name=Notify', '-c', 'user.email=notify@example.com', 'commit', '-q', '-m', 'init'], { cwd: repoDir, stdio: 'ignore', windowsHide: true });
writeFileSync(fakeAppImage, '#!/bin/sh\necho "stands in for the AppImage in this check"\n', { mode: 0o755 });

let daemonProc = null;
let token = null;
let daemonUrl = null;
async function startDaemon() {
  daemonProc = spawn(process.execPath, [join(root, 'apps/daemon/dist/main.js')], {
    cwd: root, stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, TANDEMISE_HOME: home, TANDEMISE_LOG_LEVEL: 'error' },
  });
  procs.push(daemonProc);
  const conn = await until(() => {
    try { const c = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')); return c.pid === daemonProc.pid && c; } catch { return false; }
  }, { label: 'daemon.json', timeoutMs: 30_000 });
  token = conn.token;
  daemonUrl = conn.url;
}
async function stopDaemon() {
  try { process.kill(-daemonProc.pid, 'SIGTERM'); } catch { /* gone */ }
  await until(() => { try { process.kill(daemonProc.pid, 0); return false; } catch { return true; } }, { label: 'daemon stopped' });
  procs.splice(procs.indexOf(daemonProc), 1);
}
const api = async (method, path, body) => {
  const res = await fetch(`${daemonUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
/** A pending card in the Inbox, written with the daemon stopped (its connection would not see it otherwise). */
async function seedCard(ws, id, title) {
  await stopDaemon();
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(join(home, 'tandemise.db'));
  try {
    db.prepare(`INSERT INTO approvals (id, workspace_id, mission_id, task_id, run_id, kind, status, risk, title, rationale, effect, evidence, options,
      recommended_option_id, selected_option_id, decided_by, decision_note, created_at, decided_at, expires_at, addressees, escalation_level, escalate_at, recorded_by)
      VALUES (?, ?, NULL, NULL, NULL, 'intervention', 'PENDING', 'read', ?, 'r', 'e', '[]', ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, '[]', 0, NULL, 'system')`)
      .run(id, ws, title, JSON.stringify([{ id: 'approve', label: 'Go on' }, { id: 'reject', label: 'Stop' }]), new Date().toISOString());
  } finally { db.close(); }
  await startDaemon();
}
const notified = () => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).notificationState?.notified ?? [];

let app = null;
let page = null;
const appLog = openSync(join(work, 'app.log'), 'a');
async function startApp(extraEnv = {}) {
  app = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${PORT}`], {
    cwd: desktop, stdio: ['ignore', appLog, appLog], detached: true, windowsHide: true,
    env: {
      ...process.env, TANDEMISE_HOME: home, TANDEMISE_NOTIFY_RECORD: record, TANDEMISE_NOTIFY_POLL_MS: '1000', APPIMAGE: fakeAppImage, ...extraEnv,
    },
  });
  procs.push(app);
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.startsWith('http://')); } catch { return false; }
  }, { label: 'renderer', timeoutMs: 90_000, everyMs: 500 });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? 'evaluation failed');
    return m.result?.result?.value;
  };
  page = { ws, send, evaluate };
  await until(() => evaluate('document.readyState === "complete" && !!window.tandemise'), { label: 'bridge' });
}
async function stopApp() {
  page?.ws.close();
  try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ }
  await until(async () => { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return false; } catch { return true; } }, { label: 'app stopped' });
  procs.splice(procs.indexOf(app), 1);
}
const debug = (op, arg) => page.evaluate(`window.tandemise.notificationsDebug(${JSON.stringify(op)}${arg === undefined ? '' : `, ${JSON.stringify(arg)}`})`);
const SECTION = 'section[aria-label="Notifications"]';
async function openSettings() {
  await page.evaluate(`location.hash = '#/settings'`);
  await until(() => page.evaluate(`!!document.querySelector('${SECTION} [data-notify-reach]') && document.querySelector('${SECTION} [data-notify-reach]').dataset.notifyReach !== 'checking'`), { label: 'Notifications section' });
  await page.evaluate(`document.querySelector('${SECTION}').scrollIntoView({ block: 'start' })`);
}
const sectionState = () => page.evaluate(`(() => {
  const s = document.querySelector('${SECTION}');
  return {
    reach: s.querySelector('[data-notify-reach]')?.dataset.notifyReach,
    pill: s.querySelector('[data-notify-reach] .badge')?.textContent,
    summary: s.querySelector('[data-notify-summary]')?.textContent,
    banner: s.querySelector('[data-notify-banner]')?.textContent ?? null,
    failure: s.querySelector('[data-notify-failure]')?.textContent ?? null,
    testResult: s.querySelector('[data-notify-test-result]')?.textContent ?? '',
    entryOffer: s.querySelector('[data-notify-desktop-entry]')?.dataset.notifyDesktopEntry ?? null,
  };
})()`);
const clickButton = (text) => page.evaluate(`(() => {
  const b = [...document.querySelectorAll('${SECTION} button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
  if (!b) return false; b.click(); return true;
})()`);
async function sendTest() {
  const before = notifyCalls().length;
  await page.evaluate(`(() => { const r = document.querySelector('${SECTION} [data-notify-test-result]'); if (r) r.textContent = ''; })()`);
  check('the "Send a test notification" button is there', await clickButton('Send a test notification'));
  const state = await until(async () => { const s = await sectionState(); return s.testResult !== '' && s; }, { label: 'test result' });
  await sleep(500);
  return { state, calls: notifyCalls().slice(before) };
}
const screenshotPage = async (name) => {
  const { result } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(evidence, name), Buffer.from(result.data, 'base64'));
};

const summary = { steps: [] };
try {
  await sleep(500);
  await startDaemon();
  const ws = (await api('POST', '/v1/workspaces', { name: 'Notify', repositoryPath: repoDir })).body?.workspace?.id;
  check('a project to put cards in', typeof ws === 'string', ws);
  const server = execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.GetServerInformation'], { encoding: 'utf8', windowsHide: true }).trim();
  check('the notification server is GNOME Shell 50', /'gnome-shell', 'GNOME', '50\./.test(server), server);
  summary.server = server;
  summary.globalBanners = gsettings('get', 'org.gnome.desktop.notifications', 'show-banners');

  // ---------------------------------------------------------------- 1
  section('1. An Inbox card, as an AppImage with no .desktop entry: a real banner, and a click opens the Inbox');
  check('no Tandemise entry in this session\'s apps', !existsSync(join(process.env.XDG_DATA_HOME, 'applications/tandemise.desktop')));
  await startApp();
  await debug('pause');
  await debug('hide');
  await seedCard(ws, 'apr_gnome_1', 'Allow a network call');
  const callsBefore = notifyCalls().length;
  await until(async () => (await debug('poll')) > 0 || (await debug('list')).length > 0, { label: 'a notice', timeoutMs: 30_000, everyMs: 1000 });
  const first = (await debug('list')).at(-1);
  check('the main process showed "Decision needed" for the card, and the system took it', first?.title === 'Decision needed' && first.body === 'Allow a network call' && first.delivered === true && first.ids.join() === 'apr_gnome_1', first);
  await sleep(700);
  const call1 = notifyCalls().slice(callsBefore).find((c) => c.title === 'Decision needed');
  check('D-Bus: Notify "Decision needed" from app "Tandemise" with the desktop-entry hint "tandemise"', call1?.appName === 'Tandemise' && call1.desktopEntry === 'tandemise', call1 && { ...call1, call: undefined });
  check('D-Bus: with no .desktop entry the notification carries the icon itself (image-data)', call1?.imageData === true);
  check('D-Bus: GNOME Shell answered with a notification id', Number.isInteger(call1?.id) && call1.id > 0, call1?.reply);
  check('the card is recorded as notified', notified().includes('apr_gnome_1'), notified());
  shot('1-banner-appimage-no-entry.png');
  summary.steps.push({ step: 1, notify: call1?.call, reply: call1?.reply });
  shell('click', '640', '85');
  const hash = await until(async () => { const h = await page.evaluate('location.hash'); return h.startsWith('#/inbox') && h; }, { label: 'the Inbox after the click' });
  const win = await debug('window');
  check('clicking the banner brought the window back on the Inbox', hash.startsWith('#/inbox') && win?.visible === true, { hash, win });
  await sleep(400);
  shot('1-after-click-inbox.png');
  check('D-Bus: GNOME reported the click (ActionInvoked "default")', /member=ActionInvoked\n {3}uint32 \d+\n {3}string "default"/.test(dbusText));

  // ---------------------------------------------------------------- 2
  section('2. Settings offers to add Tandemise to the apps; the test reports "showing"');
  await openSettings();
  let s = await sectionState();
  check('Settings: ready on GNOME Shell 50, but no Tandemise icon without an entry', s.reach === 'ready' && /GNOME Shell 50\.\d+ shows Tandemise's notifications as banners/.test(s.summary) && /no Tandemise icon/.test(s.summary), s);
  check('Settings offers "Add to apps" (and writes nothing until clicked)', s.entryOffer === 'install' && !existsSync(join(process.env.XDG_DATA_HOME, 'applications/tandemise.desktop')), s);
  await screenshotPage('2-settings-offer-add-to-apps.png');
  check('click "Add to apps"', await clickButton('Add to apps'));
  s = await until(async () => { const x = await sectionState(); return x.entryOffer === 'remove' && x; }, { label: 'entry added' });
  const entryFile = join(process.env.XDG_DATA_HOME, 'applications/tandemise.desktop');
  const entry = existsSync(entryFile) ? readFileSync(entryFile, 'utf8') : '';
  check('the entry runs this AppImage, names the window class, and is marked as Tandemise\'s', entry.includes(`Exec=${fakeAppImage} %U`) && entry.includes('StartupWMClass=tandemise') && entry.includes('X-Tandemise-Added-From-Settings=true'), entry);
  const iconLine = /^Icon=(.*)$/m.exec(entry)?.[1];
  check('its icon was written next to it', iconLine !== undefined && existsSync(iconLine), iconLine);
  writeFileSync(join(evidence, 'tandemise.desktop'), entry);
  s = await sectionState();
  check('Settings: ready, the icon note and the offer are gone', s.reach === 'ready' && !/no Tandemise icon/.test(s.summary) && s.banner === null, s);
  await sleep(6000); // GNOME notices the new entry (it watches the applications folder)
  const t2 = await sendTest();
  check('test: "GNOME Shell 50 took it and shows it as a banner now"', /^GNOME Shell 50\.\d+ took it and shows it as a banner now\.$/.test(t2.state.testResult), t2.state);
  const call2 = t2.calls.find((c) => c.title === 'Notifications are on');
  check('D-Bus: the test Notify was answered with an id; no image-data now that GNOME has the app icon', Number.isInteger(call2?.id) && call2.imageData === false && call2.desktopEntry === 'tandemise', call2 && { ...call2, call: undefined });
  shot('2-banner-test-with-entry.png');
  summary.steps.push({ step: 2, notify: call2?.call, reply: call2?.reply });
  shell('click', '871', '60'); // the banner's close button; GNOME keeps banners up while nobody moves the pointer

  // ---------------------------------------------------------------- 3
  section('3. Do Not Disturb (in this private session): Settings says so, and the test reports "no banner"');
  gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'false');
  await page.evaluate(`location.hash = '#/inbox'`);
  await sleep(300);
  await openSettings();
  // The section shows what it last read at once and reads the system again on opening.
  s = await until(async () => { const x = await sectionState(); return x.reach === 'hidden' && x; }, { label: 'Do Not Disturb in Settings', timeoutMs: 10_000 }).catch(() => sectionState());
  check('Settings: hidden, "Do Not Disturb is on", and how to turn it off', s.reach === 'hidden' && /Do Not Disturb is on/.test(s.banner ?? '') && /Turn off Do Not Disturb/.test(s.banner ?? '') && s.pill === 'No banners', s);
  await screenshotPage('3-settings-do-not-disturb.png');
  const t3 = await sendTest();
  check('test: taken, but "shows no banner" because of Do Not Disturb', /took it but shows no banner/.test(t3.state.testResult) && /Do Not Disturb/.test(t3.state.testResult), t3.state);
  check('D-Bus: GNOME still answered with an id (it went to the list)', Number.isInteger(t3.calls.find((c) => c.title === 'Notifications are on')?.id));
  shot('3-desktop-do-not-disturb-no-banner.png');
  gsettings('set', 'org.gnome.desktop.notifications', 'show-banners', 'true');

  // ---------------------------------------------------------------- 4
  section('4. No notification server: nothing recorded as notified, and Settings says why');
  await stopApp();
  const noBus = `unix:path=${join(work, 'no-bus')}`;
  await startApp({ DBUS_SESSION_BUS_ADDRESS: noBus });
  await debug('pause');
  await seedCard(ws, 'apr_gnome_2', 'Merge the release branch');
  await until(async () => { await debug('poll'); return (await debug('list')).some((r) => r.ids.includes('apr_gnome_2')); }, { label: 'the refused notice', timeoutMs: 30_000, everyMs: 1000 });
  const refused = (await debug('list')).find((r) => r.ids.includes('apr_gnome_2'));
  check('the system refused it, and the record says why', refused.delivered === false && /No notification server answers|Could not connect/.test(refused.reason ?? ''), refused);
  await sleep(500);
  check('the card is NOT recorded as notified (it was released)', !notified().includes('apr_gnome_2') && notified().includes('apr_gnome_1'), notified());
  await openSettings();
  s = await sectionState();
  check('Settings: "Not delivered", no notification server, nothing recorded', s.reach === 'unavailable' && s.pill === 'Not delivered' && /No notification server answers/.test(s.banner ?? '') && /nothing is recorded as notified/.test(s.banner ?? ''), s);
  check('Settings shows the last refusal and that it is announced again', /Last refused/.test(s.failure ?? '') && /announced again/.test(s.failure ?? ''), s.failure);
  const t4 = await sendTest();
  check('test: "Not delivered: No notification server answers …"', /^Not delivered: No notification server answers/.test(t4.state.testResult), t4.state);
  await screenshotPage('4-settings-no-server.png');
  await stopApp();

  section('4b. The server is back: the released card is announced');
  await startApp();
  await debug('pause');
  await until(async () => { await debug('poll'); return (await debug('list')).some((r) => r.ids.includes('apr_gnome_2') && r.delivered); }, { label: 'the card again', timeoutMs: 30_000, everyMs: 1000 });
  check('announced once a server takes it, and now recorded', notified().includes('apr_gnome_2'), notified());
  await sleep(500);
  shot('4b-banner-after-server-back.png');
  await page.evaluate(`location.hash = '#/settings'`);
  await openSettings();
  check('"Remove from apps" takes the entry back', await clickButton('Remove from apps'));
  await until(async () => (await sectionState()).entryOffer === 'install', { label: 'entry removed' });
  check('the entry Tandemise added is gone', !existsSync(entryFile));
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await sleep(300);
  // The whole capture stays in the work dir (image-data makes it megabytes); the evidence keeps
  // Electron's Notify calls with GNOME's replies, and the server's signals, image bytes elided.
  writeFileSync(join(work, 'dbus-monitor.log'), dbusText);
  const elide = (m) => m.replace(/array of bytes \[[\s\S]*?\n\s*\]/g, 'array of bytes [ …the icon\'s RGBA pixels, elided… ]');
  const excerpt = [
    ...notifyCalls().flatMap((c) => [elide(c.call), c.reply ?? c.error ?? '(no reply captured)', '']),
    ...dbusText.split(/\n(?=\S)/).filter((m) => /member=(ActionInvoked|NotificationClosed|ActivationToken)$/.test(m.split('\n')[0])),
  ].join('\n');
  writeFileSync(join(evidence, 'dbus-notify.txt'), excerpt + '\n');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ...summary, steps: summary.steps.map((s) => ({ ...s, notify: s.notify && elide(s.notify) })), passed, failures }, null, 2));
  stopAll();
}

console.log(`\nevidence: ${evidence} (work: ${work})`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('ALL GNOME NOTIFICATION CHECKS PASSED');
