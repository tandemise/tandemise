// I10 — The project is linked to a brain on this machine (#70, `mode: 'local'`) whose factory/tracker.yaml
// and factory/intake.yaml are committed in the brain's repository and pulled with Sync, as a teammate's change
// arrives. (a) Ruling 22: the brain's Sentry source is off on this computer until its person switches it on in
// Settings → Intake ("On this computer"): off → the fake Sentry records no poll on Check sources now; on → it
// is polled; off again → no further polls. (b) Ruling 23: the brain moves the tracker to a second fake
// YouTrack (B). The tracker token was saved for A, so the Board shows the daemon's sentence and B receives no
// request carrying the token, even after Check sources now; **Use the new address** in Settings → Intake
// re-binds it and the Board reads B's items with the token.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, boardGroups, checkSourcesNow, openBoard, sentry, ytB } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('I10', "A brain's source runs here only when switched on; a moved tracker gets no token until confirmed");
const ws = c.env.workspaceId;
const configUrl = `/v1/workspaces/${ws}/intake/config`;
const TOKEN_A = 'perm:acceptance';
const SOURCE = 'sentry-team';
const machineRow = `[data-intake-machine-source="${SOURCE}"]`;

// ------------------------------------------------------------------ the brain
const local = await api.get(configUrl);
ev.check('before: the configuration is local, with the tracker at fake YouTrack A', local.origin === 'local' && local.tracker?.kind === 'youtrack' && typeof local.tracker.url === 'string', { origin: local.origin, url: local.tracker?.url });
const urlA = local.tracker.url;
const urlB = ytB.url();
const linked = await api.post(`/v1/workspaces/${ws}/brain`, { mode: 'local' });
const clone = join(SCRATCH, 'home', 'brains', ws);
ev.check('the project is linked to a brain on this machine (local_only)', linked.linked === true && linked.status === 'local_only' && existsSync(join(clone, '.git')), { status: linked.status, clone });
ev.note(`brain clone: ${clone} (no remote; a commit there and Sync is how a teammate's change arrives)`);

/** Commits the brain's tracker and intake files, as a teammate would, and pulls them with Sync. */
async function brainCommit(tracker, message) {
  // JSON is YAML; the daemon parses both files with the same schemas as the local settings.
  writeFileSync(join(clone, 'factory', 'tracker.yaml'), `${JSON.stringify({ tracker }, null, 2)}\n`);
  writeFileSync(join(clone, 'factory', 'intake.yaml'), `${JSON.stringify({
    sources: [{ id: SOURCE, kind: 'sentry', instance: 'acme/web', api: local.sources.find((s) => s.id === 'sentry-web').api, every: '60m', filter: { minEvents: 20, window: '24h' }, create: { type: 'Bug' }, closeOnDone: true }],
  }, null, 2)}\n`);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Teammate', '-c', 'user.email=teammate@example.invalid', ...args], { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git('add', 'factory/tracker.yaml', 'factory/intake.yaml');
  git('commit', '-q', '-m', message);
  await api.post(`/v1/workspaces/${ws}/brain/sync`);
  return git('rev-parse', 'HEAD').trim();
}
const head1 = await brainCommit(local.tracker, 'chore: the team reads Sentry and files into YouTrack');
const fromBrain = await until(async () => { const v = await api.get(configUrl); return v.origin === 'brain' && v.sources.some((s) => s.id === SOURCE) && v; }, { label: 'the config from the brain', timeoutMs: 20_000 });
ev.check(`after Sync (${head1.slice(0, 7)}): origin brain, one source ${SOURCE}, the tracker at A`, fromBrain.sources.map((s) => s.id).join() === SOURCE && fromBrain.tracker?.url === urlA, { origin: fromBrain.origin, sources: fromBrain.sources.map((s) => s.id), tracker: fromBrain.tracker?.url });
ev.check('API: the brain source is off on this computer (enabled false)', fromBrain.enabled?.[SOURCE] === false, fromBrain.enabled);

// ------------------------------------------------------------------ (a) On this computer
const sentryPolls = async () => (await sentry.state()).calls.filter((x) => x.method === 'GET' && x.path === '/api/0/projects/acme/web/issues/' && x.authorization === 'Bearer sntrys_acceptance').length;
const switchState = () => page.evaluate(`document.querySelector('${machineRow} [role="switch"]')?.getAttribute('aria-checked') ?? null`);
async function openIntakeSettings() {
  await page.navigate('#/settings');
  await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Intake"][data-origin="brain"] ${machineRow}'))`), { label: 'Settings → Intake from the brain', timeoutMs: 30_000 });
  await page.evaluate(`document.querySelector('section[aria-label="Intake"] [aria-label="On this computer"]').scrollIntoView({ block: 'center' })`);
  await sleep(600);
}
// The window learns of the brain's new configuration when it reads it again; a reload is the plainest way.
await page.send('Page.reload', {});
await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
await openIntakeSettings();
const intakeText = await page.text('section[aria-label="Intake"]');
ev.check("Settings → Intake says it is set in the project's brain", intakeText.includes("Set in this project's brain."), intakeText.slice(0, 400));
ev.check(`the window shows "Run ${SOURCE} on this computer" OFF`, (await switchState()) === 'false', await switchState());

// Its token is this computer's, saved in the window (the brain never holds it).
// Scoped to the "On this computer" row: the brain's read-only form above carries a disabled field of the same name.
await page.evaluate(`(() => {
  const el = document.querySelector('${machineRow} input[aria-label="${SOURCE} Auth token"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'sntrys_acceptance');
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(250);
await page.click('Save', { within: machineRow });
// The field empties once the daemon has saved it.
await until(() => page.evaluate(`document.querySelector('${machineRow} input[aria-label="${SOURCE} Auth token"]')?.value === ''`), { label: 'the token saved', timeoutMs: 15_000 });
ev.check('saving its token here leaves it off (API enabled false)', (await api.get(configUrl)).enabled?.[SOURCE] === false && (await switchState()) === 'false');
await page.screenshot(ev.shot('on-this-computer-off'));

const p0 = await sentryPolls();
await openBoard(c);
await checkSourcesNow(c);
await sleep(2_000);
const p1 = await sentryPolls();
ev.check('OFF: Check sources now → the fake Sentry records no poll', p1 === p0, { before: p0, after: p1 });

await openIntakeSettings();
await page.evaluate(`document.querySelector('${machineRow} [role="switch"]').click()`);
await until(async () => (await switchState()) === 'true', { label: 'the switch on', timeoutMs: 15_000 });
const onView = await until(async () => { const v = await api.get(configUrl); return v.enabled?.[SOURCE] === true && v; }, { label: 'API enabled true', timeoutMs: 15_000 });
ev.check('click ON in the window → API enabled true', onView.enabled[SOURCE] === true, onView.enabled);
await page.screenshot(ev.shot('on-this-computer-on'));
await openBoard(c);
await checkSourcesNow(c);
const p2 = await until(async () => { const n = await sentryPolls(); return n > p1 && n; }, { label: 'a Sentry poll', timeoutMs: 30_000 }).catch(() => p1);
ev.check('ON: the runner reads the source → the fake Sentry records a poll with this computer\'s token', p2 > p1, { before: p1, after: p2 });

await openIntakeSettings();
await page.evaluate(`document.querySelector('${machineRow} [role="switch"]').click()`);
await until(async () => (await switchState()) === 'false', { label: 'the switch off', timeoutMs: 15_000 });
const offView = await until(async () => { const v = await api.get(configUrl); return v.enabled?.[SOURCE] === false && v; }, { label: 'API enabled false', timeoutMs: 15_000 });
ev.check('click OFF in the window → API enabled false', offView.enabled[SOURCE] === false, offView.enabled);
await openBoard(c);
await checkSourcesNow(c);
await sleep(3_000);
const p3 = await sentryPolls();
ev.check('OFF again: Check sources now (and the ticks since) → no further polls', p3 === p2, { before: p2, after: p3 });

// ------------------------------------------------------------------ (b) the tracker moves to B
await ytB.put({ idReadable: 'ACME-101', summary: 'Only at the new address', type: 'Task', state: 'Open', description: 'Filed in YouTrack B.' });
await ytB.put({ idReadable: 'ACME-102', summary: 'Also at the new address', type: 'Task', state: 'In Progress', assignee: 'lee' });
const tokenCallsB = async () => (await ytB.state()).calls.filter((x) => x.authorization === `Bearer ${TOKEN_A}`).length;
const callsB0 = (await ytB.state()).calls.filter((x) => !x.path.startsWith('/_fake')).length;
const head2 = await brainCommit({ ...local.tracker, url: urlB }, 'chore: the tracker moved');
const originA = new URL(urlA).origin;
const originB = new URL(urlB).origin;
const SENTENCE = `This project's tracker now points at ${originB}. Confirm the new address in Settings → Intake before Tandemise sends your token there.`;
const moved = await until(async () => { const v = await api.get(configUrl); return v.tracker?.url === urlB && v; }, { label: 'the moved tracker', timeoutMs: 20_000 });
ev.check(`after Sync (${head2.slice(0, 7)}): API originMismatch.tracker names B now and A as saved, with the daemon's sentence`,
  moved.originMismatch?.tracker?.current === originB && moved.originMismatch.tracker.saved === originA && moved.originMismatch.tracker.message === SENTENCE, moved.originMismatch);

await page.send('Page.reload', {});
await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
await openBoard(c);
const problemShown = () => page.evaluate(`document.querySelector('.board__problem')?.innerText.trim() ?? ''`);
const shown = await until(async () => { const t = await problemShown(); return t.includes('now points at') && t; }, { label: "the board's problem", timeoutMs: 30_000 });
const daemonProblem = (await api.get(`/v1/workspaces/${ws}/board`)).problem;
ev.check("the Board shows the daemon's sentence, word for word", shown === SENTENCE && daemonProblem === SENTENCE, { shown, daemonProblem });
await checkSourcesNow(c);
const afterCheck = await problemShown();
const checkError = await page.evaluate(`[...document.querySelectorAll('.board .error-state, .board [role="alert"]')].map((e) => e.innerText.trim()).join(' | ')`);
ev.check('Check sources now: the Board still answers with the same sentence (no read of B)', afterCheck === SENTENCE || checkError.includes(SENTENCE), { afterCheck, checkError });
ev.check('proof (fake YouTrack B): no request carrying the token reached B', (await tokenCallsB()) === 0, { tokenCalls: await tokenCallsB(), anyCalls: (await ytB.state()).calls.filter((x) => !x.path.startsWith('/_fake')).length - callsB0 });
ev.check('nothing from B is on the Board yet', !JSON.stringify(await boardGroups(c)).includes('ACME-101'));
await page.screenshot(ev.shot('board-tracker-moved'));

await page.navigate('#/settings');
const movedSel = 'section[aria-label="Intake"] [data-intake-moved="tracker"]';
await until(() => page.evaluate(`Boolean(document.querySelector('${movedSel}'))`), { label: 'the confirm prompt', timeoutMs: 30_000 });
await page.evaluate(`document.querySelector('${movedSel}').scrollIntoView({ block: 'center' })`);
await sleep(500);
const prompt = await page.text(movedSel);
ev.check(`Settings → Intake shows the prompt: the sentence, "Saved for ${originA}." and Use the new address`, prompt.includes(SENTENCE) && prompt.includes(`Saved for ${originA}.`) && prompt.includes('Use the new address'), prompt);
await page.screenshot(ev.shot('settings-confirm-new-address'));
await page.click('Use the new address', { within: movedSel });
await until(() => page.evaluate(`!document.querySelector('${movedSel}')`), { label: 'the prompt gone', timeoutMs: 15_000 });
const confirmed = await api.get(configUrl);
ev.check('click Use the new address → the prompt disappears and API originMismatch.tracker is null', confirmed.originMismatch?.tracker === null, confirmed.originMismatch);

await openBoard(c);
const groups = await until(async () => { const g = await boardGroups(c); return JSON.stringify(g).includes('ACME-101') && g; }, { label: "B's items on the Board", timeoutMs: 30_000 });
const keys = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.rows.map((r) => r.key)]));
// B numbers its own items too (anything filed after the confirm lands there), so every row must be one of B's, by key and title.
const issuesB = new Map((await ytB.state()).issues.map((i) => [i.idReadable, i.summary]));
const rowsNow = Object.values(groups).flatMap((g) => g.rows);
ev.check("the Board refreshes against B: ACME-101 Ready, ACME-102 In progress, and every row is B's item",
  keys.ready?.includes('ACME-101') && keys.inProgress?.includes('ACME-102') && rowsNow.every((r) => issuesB.get(r.key) === r.title),
  { keys, notB: rowsNow.filter((r) => issuesB.get(r.key) !== r.title).map((r) => `${r.key} ${r.title}`) });
ev.check('…with no problem line', (await problemShown()) === '', await problemShown());
const authed = (await ytB.state()).calls.filter((x) => x.authorization === `Bearer ${TOKEN_A}`);
ev.check('proof (fake YouTrack B): B now receives requests carrying the token (the board read)', authed.length > 0 && authed.some((x) => x.method === 'GET' && x.path.startsWith('/api/')), { count: authed.length, paths: [...new Set(authed.map((x) => `${x.method} ${x.path}`))] });
await page.screenshot(ev.shot('board-new-address'));
c.close(); ev.save();
