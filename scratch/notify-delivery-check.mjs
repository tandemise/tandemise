// Notifications are recorded as notified only when the operating system took
// them. A notice the system refused (no libnotify, no notification server,
// Windows refusing the toast) goes back to the daemon and is announced again;
// a desktop that cannot show anything is not asked at all; and Settings says
// plainly why a notification does not reach the person (GNOME's Do Not
// Disturb, banners off for the app, no server, an AppImage with no .desktop
// entry).
//
//   npm run build && node scratch/notify-delivery-check.mjs
//
// The desktop's rules (apps/desktop/src/main/notify-delivery.ts) first, then
// the domain's release, then a real daemon: take, release, take again.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

// The module lives in the desktop's main process, which electron-vite bundles;
// it has only type imports, so transpiling the one file is enough.
const ts = require('typescript');
const source = readFileSync(join(root, 'apps/desktop/src/main/notify-delivery.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const N = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const D = await import('@tandemise/domain');

// ------------------------------------------------------------------ recording
section('desktop: only what the system took counts as notified');
{
  const now = 1_000_000;
  const took = N.afterDelivery({ accepted: true, reason: null }, now);
  check('accepted: nothing released, no pause', took.release === false && took.pausedUntil === null, took);
  const refused = N.afterDelivery({ accepted: false, reason: 'no server' }, now);
  check('refused: its ids are released', refused.release === true, refused);
  check('refused: taking pauses for a minute', refused.pausedUntil === now + N.FAILURE_PAUSE_MS && N.FAILURE_PAUSE_MS === 60_000, refused);

  check('no notification support: never take (nothing gets recorded unseen)', N.mayTake({ supported: false, pausedUntil: null, now }) === false);
  check('supported and not paused: take', N.mayTake({ supported: true, pausedUntil: null, now }) === true);
  check('paused after a refusal: do not take yet', N.mayTake({ supported: true, pausedUntil: now + 10, now }) === false);
  check('pause over: take again', N.mayTake({ supported: true, pausedUntil: now, now }) === true);
}

section('domain: releasing ids makes them new again');
{
  const item = (id) => ({ id, kind: 'decisions', workspaceId: 'wsp_a', title: 'Decision needed', body: `Body ${id}`, route: '/inbox' });
  const prefs = D.DEFAULT_NOTIFY_PREFERENCES;
  const first = D.planNotifications({ items: [item('a'), item('b')], state: D.EMPTY_NOTIFY_STATE, preferences: prefs, minuteOfDay: 720, suppress: false });
  check('a take records both', first.state.notified.join() === 'a,b', first.state);
  const released = D.releaseNotified(first.state, first.notice.ids);
  check('release removes both from notified', released.notified.length === 0, released);
  const again = D.planNotifications({ items: [item('a'), item('b')], state: released, preferences: prefs, minuteOfDay: 720, suppress: false });
  check('the next take announces them again, once', again.notice?.ids.join() === 'a,b' && again.notice.title === '2 things need you', again.notice);
  const partial = D.releaseNotified({ notified: ['a', 'b', 'c'], held: ['d'] }, ['b', 'd', 'zzz']);
  check('release takes only the given ids, held ones too, and ignores unknown ones', partial.notified.join() === 'a,c' && partial.held.length === 0, partial);
}

// ------------------------------------------------------------------ what Settings says
section('desktop: Settings → Notifications on GNOME');
const gnome = { name: 'gnome-shell', vendor: 'GNOME', version: '50.1' };
const facts = (over = {}) => ({
  supported: true, server: gnome, globalBanners: true, appEnabled: true, appBanners: true,
  entryPath: '/usr/share/applications/tandemise.desktop', entryOurs: false, appImage: false, ...over,
});
{
  const ready = N.assessLinux(facts(), null);
  check('a .deb on GNOME with banners on: ready, "GNOME Shell 50.1 shows ... as banners", nothing to do', ready.reach === 'ready' && ready.server === 'GNOME Shell 50.1' && /shows Tandemise's notifications as banners/.test(ready.summary) && ready.advice === null && ready.desktopEntry.offer === null, ready);

  const dnd = N.assessLinux(facts({ globalBanners: false }), null);
  check('Do Not Disturb: hidden, says so, and how to turn it off', dnd.reach === 'hidden' && /Do Not Disturb is on/.test(dnd.summary) && /Turn off Do Not Disturb/.test(dnd.advice), dnd);
  const off = N.assessLinux(facts({ appEnabled: false, globalBanners: false }), null);
  check('notifications off for Tandemise wins over Do Not Disturb', off.reach === 'hidden' && /turned off in GNOME Settings/.test(off.summary), off);
  const noBanners = N.assessLinux(facts({ appBanners: false }), null);
  check('banners off for Tandemise: hidden, names the switch', noBanners.reach === 'hidden' && /Notification Banners/.test(noBanners.advice), noBanners);

  const appImage = N.assessLinux(facts({ entryPath: null, appImage: true, appEnabled: null, appBanners: null }), null);
  check('an AppImage with no .desktop entry: still ready, but offers to add Tandemise to the apps', appImage.reach === 'ready' && appImage.desktopEntry.state === 'missing' && appImage.desktopEntry.offer === 'install' && /no Tandemise icon/.test(appImage.summary) && /Add Tandemise to your apps/.test(appImage.advice), appImage);
  const added = N.assessLinux(facts({ entryPath: '/home/p/.local/share/applications/tandemise.desktop', entryOurs: true }), null);
  check('the entry Tandemise added: offers to remove it', added.desktopEntry.offer === 'remove' && added.advice === null, added.desktopEntry);
  const dev = N.assessLinux(facts({ entryPath: null, appImage: false }), null);
  check('not an AppImage and no entry (a dev run): nothing offered', dev.desktopEntry.offer === null && dev.advice === null, dev);
}

section('desktop: Settings → Notifications when nothing can be shown');
{
  const noLib = N.assessLinux(facts({ supported: false }), null);
  check('no libnotify: unavailable, says to install it and that nothing is recorded', noLib.reach === 'unavailable' && /libnotify4/.test(noLib.advice) && /nothing is recorded as notified/.test(noLib.advice), noLib);
  const noServer = N.assessLinux(facts({ server: { error: 'GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.Notifications was not provided by any .service files' }, globalBanners: null }), null);
  check('no notification server: unavailable, with the D-Bus error', noServer.reach === 'unavailable' && /No notification server answers/.test(noServer.summary) && /ServiceUnknown/.test(noServer.summary) && noServer.server === null, noServer);
  const kde = N.assessLinux(facts({ server: { name: 'Plasma', vendor: 'KDE', version: '6.3' }, globalBanners: null, appEnabled: null, appBanners: null }), null);
  check('KDE: ready, named, banners not claimed', kde.reach === 'ready' && kde.server === 'KDE Plasma 6.3' && /takes Tandemise's notifications/.test(kde.summary), kde);
  const failure = { at: '2026-11-01T10:00:00.000Z', reason: 'The notification server refused it.' };
  const blind = N.assessLinux(facts({ server: null, globalBanners: null }), failure);
  check('no gdbus to ask, and a refusal: unavailable, with the reason', blind.reach === 'unavailable' && /refused the last notification/.test(blind.summary) && blind.lastFailure === failure, blind);
}

section('desktop: macOS and Windows');
{
  const mac = N.assessOther('darwin', true, null);
  check('macOS: unknown, points at System Settings → Notifications', mac.reach === 'unknown' && /System Settings → Notifications → Tandemise/.test(mac.advice) && mac.desktopEntry.state === 'not-applicable', mac);
  const win = N.assessOther('win32', true, null);
  check('Windows: unknown, points at Settings → System → Notifications', win.reach === 'unknown' && /Settings → System → Notifications → Tandemise/.test(win.advice), win);
  const winFailed = N.assessOther('win32', true, { at: 'x', reason: 'toast failed' });
  check('Windows refused a toast: unavailable, with the reason', winFailed.reach === 'unavailable' && /toast failed/.test(winFailed.summary), winFailed);
  check('unsupported: unavailable', N.assessOther('darwin', false, null).reach === 'unavailable');
}

section('desktop: what "Send a test notification" reports');
{
  const ready = N.assessLinux(facts(), null);
  const shown = N.testResult({ accepted: true, reason: null }, ready, 'linux');
  check('GNOME took it, banners on: accepted, shown', shown.accepted && shown.shown === 'yes' && /GNOME Shell 50.1 took it and shows it as a banner now/.test(shown.message), shown);
  const hidden = N.testResult({ accepted: true, reason: null }, N.assessLinux(facts({ globalBanners: false }), null), 'linux');
  check('GNOME took it under Do Not Disturb: accepted, not shown, says why', hidden.accepted && hidden.shown === 'no' && /took it but shows no banner/.test(hidden.message) && /Do Not Disturb/.test(hidden.message), hidden);
  const refused = N.testResult({ accepted: false, reason: null }, N.assessLinux(facts({ server: { error: 'ServiceUnknown' } }), null), 'linux');
  check('refused with no reason from Electron: not accepted, the probe says why', !refused.accepted && refused.shown === 'no' && /^Not delivered: No notification server answers/.test(refused.message), refused);
  const mac = N.testResult({ accepted: true, reason: null }, N.assessOther('darwin', true, null), 'darwin');
  check('macOS took it: accepted, shown unknown, where to allow it', mac.accepted && mac.shown === 'unknown' && /System Settings → Notifications/.test(mac.message), mac);
}

section('desktop: reading the system');
{
  check('gdbus GetServerInformation is parsed', JSON.stringify(N.parseServerInformation("('gnome-shell', 'GNOME', '50.1', '1.2')\n")) === JSON.stringify(gnome));
  check('an unreadable answer is null', N.parseServerInformation('') === null);
  check('gsettings booleans', N.parseGsettingsBoolean('true\n') === true && N.parseGsettingsBoolean('false') === false && N.parseGsettingsBoolean('No such schema') === null);
  check('desktop id from desktopName', N.desktopId('tandemise.desktop') === 'tandemise');
  check('GNOME per-app path, canonicalized like the Shell', N.gnomeAppSettingsPath('dev.Tandemise_App') === '/org/gnome/desktop/notifications/application/dev-tandemise-app/');
}

section('desktop: the .desktop entry for an AppImage');
{
  const text = N.desktopEntryText({ exec: '/home/p/Apps/Tandemise 0.11.0.AppImage', icon: '/home/p/.local/share/icons/hicolor/512x512/apps/tandemise.png', id: 'tandemise' });
  check('Exec runs the AppImage, quoted, with %U', text.includes('Exec="/home/p/Apps/Tandemise 0.11.0.AppImage" %U'), text);
  check('StartupWMClass is the window id Electron uses (desktopName)', text.includes('StartupWMClass=tandemise\n'));
  check('name, icon, type, and the marker that lets Tandemise remove only its own', text.includes('Name=Tandemise\n') && text.includes('Icon=/home/p/.local/share/icons/hicolor/512x512/apps/tandemise.png\n') && text.includes('Type=Application\n') && text.includes(N.DESKTOP_ENTRY_MARKER));
  check('a plain path is not quoted', N.quoteExecArgument('/opt/t/tandemise.AppImage') === '/opt/t/tandemise.AppImage');
  check('quotes, $ and backslashes are escaped', N.quoteExecArgument('/a b/"x"$y\\z') === '"/a b/\\"x\\"\\$y\\\\z"');
}

// ------------------------------------------------------------------ a real daemon
section('daemon: take records, release forgets, take announces again');
const tmp = mkdtempSync(join(tmpdir(), 'tdr-'));
const home = join(tmp, 'h');
const repoDir = join(tmp, 'r');
const gitConfig = join(tmp, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Notify Tester\n\temail = notify@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# release check\n');
execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

const sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
let daemon;
let token;
const api = async (method, path, body) => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const start = async () => {
  daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 60_000, clockOffsetMs: 0 });
  token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
};
const addCard = (ws, id, title) => {
  const db = new sqlite.DatabaseSync(join(home, 'tandemise.db'));
  try {
    db.prepare(`INSERT INTO approvals (id, workspace_id, mission_id, task_id, run_id, kind, status, risk, title, rationale, effect, evidence, options,
      recommended_option_id, selected_option_id, decided_by, decision_note, created_at, decided_at, expires_at, addressees, escalation_level, escalate_at, recorded_by)
      VALUES (?, ?, NULL, NULL, NULL, 'intervention', 'PENDING', 'read', ?, 'r', 'e', '[]', ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, '[]', 0, NULL, 'system')`)
      .run(id, ws, title, JSON.stringify([{ id: 'approve', label: 'Go on' }, { id: 'reject', label: 'Stop' }]), new Date().toISOString());
  } finally { db.close(); }
};
const notified = () => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).notificationState?.notified ?? [];

try {
  await start();
  const ws = (await api('POST', '/v1/workspaces', { name: 'Release', repositoryPath: repoDir })).body?.workspace?.id;
  // The daemon's connection does not see rows written behind its back while it runs.
  await daemon.stop();
  addCard(ws, 'apr_rel_1', 'Allow a network call');
  await start();

  const t1 = await api('POST', '/v1/notifications/take', {});
  check('take: one notice for the card, recorded as notified', t1.body.notices.length === 1 && t1.body.notices[0].ids.join() === 'apr_rel_1' && notified().includes('apr_rel_1'), [t1.body, notified()]);
  const r1 = await api('POST', '/v1/notifications/release', { ids: t1.body.notices[0].ids });
  check('release (the system refused it): released 1, no longer notified', r1.status === 200 && r1.body.released === 1 && !notified().includes('apr_rel_1'), [r1, notified()]);
  const t2 = await api('POST', '/v1/notifications/take', {});
  check('the next take announces it again', t2.body.notices.length === 1 && t2.body.notices[0].ids.join() === 'apr_rel_1' && notified().includes('apr_rel_1'), t2.body);
  const t3 = await api('POST', '/v1/notifications/take', {});
  check('and once it was taken, not again', t3.body.notices.length === 0, t3.body);
  const r2 = await api('POST', '/v1/notifications/release', { ids: ['apr_nobody'] });
  check('releasing an id never notified: released 0', r2.status === 200 && r2.body.released === 0, r2);
  const bad = await api('POST', '/v1/notifications/release', { ids: [] });
  check('releasing nothing is a 400', bad.status === 400, bad);
  const extra = await api('POST', '/v1/notifications/release', { ids: ['a'], also: 1 });
  check('an unknown field is a 400', extra.status === 400, extra);
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await daemon?.stop();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('ALL NOTIFY DELIVERY CHECKS PASSED');
