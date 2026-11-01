// I1 — The project's tracker is a (fake) YouTrack project ACME. The Board opens and lists the fake's
// unresolved items grouped by mapped state: ACME-1 under Ready, ACME-2 under In progress (kim's), ACME-3 under
// In review; ACME-4 (Fixed) is not on it. Settings → Intake shows the tracker and the three sources.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REAL_YOUTRACK, boardGroups, openBoard, yt } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I1', 'The Board lists the tracker\'s items, grouped by mapped state');

const nav = await page.evaluate(`[...document.querySelectorAll('.sidebar__nav .navitem')].map((a) => a.innerText.trim())`);
ev.check('the sidebar has Board right after Home', nav[0] === 'Home' && nav[1] === 'Board', nav);

await openBoard(c);
const groups = await until(async () => { const g = await boardGroups(c); return (g.ready?.rows.length ?? 0) > 0 && g; }, { label: 'board rows', timeoutMs: 30_000 });
ev.check('three groups: Ready, In progress, In review', groups.ready?.heading.startsWith('Ready') && groups.inProgress?.heading.startsWith('In progress') && groups.inReview?.heading.startsWith('In review'), Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.heading])));
const header = await page.text('.board__header');
ev.check('the header names the tracker and offers Check sources now', header.includes('YouTrack') && header.includes('Check sources now'), header);

if (REAL_YOUTRACK) {
  const board = await c.api.get(`/v1/workspaces/${c.env.workspaceId}/board`);
  const keys = (list) => list.map((i) => i.key).sort().join(',');
  ev.check('the window lists what the daemon read from the real YouTrack', keys(groups.ready.rows) === keys(board.groups.ready) && keys(groups.inProgress.rows) === keys(board.groups.inProgress), { window: keys(groups.ready.rows), daemon: keys(board.groups.ready) });
} else {
  const keysOf = (g) => (g?.rows ?? []).map((r) => r.key);
  ev.check('Ready lists ACME-1 "Checkout fails on Safari" with Start', keysOf(groups.ready).join() === 'ACME-1' && groups.ready.rows[0].title === 'Checkout fails on Safari' && groups.ready.rows[0].text.includes('Start'), groups.ready);
  ev.check('In progress lists ACME-2 with its assignee', keysOf(groups.inProgress).join() === 'ACME-2' && groups.inProgress.rows[0].text.includes('kim'), groups.inProgress);
  ev.check('In review lists ACME-3', keysOf(groups.inReview).join() === 'ACME-3', groups.inReview);
  ev.check('ACME-4 (Fixed) is not on the Board', !JSON.stringify(groups).includes('ACME-4'));
  const reads = (await yt.state()).calls.filter((x) => x.method === 'GET' && x.path === '/api/issues' && new URLSearchParams(x.query).get('query') === 'project: ACME #Unresolved');
  ev.check('proof (fake YouTrack): the board query was read as written', reads.length > 0, reads.length);
}
await page.screenshot(ev.shot('board'));

await page.navigate('#/settings');
await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Intake"]'))`), { label: 'Settings → Intake', timeoutMs: 20_000 });
await page.evaluate(`document.querySelector('section[aria-label="Intake"]').scrollIntoView({ block: 'start' })`);
await sleep(600);
const settings = await page.text('section[aria-label="Intake"]');
ev.check('Settings → Intake shows the tracker (YouTrack) and the three sources', settings.includes('YouTrack') && settings.includes('sentry-web') && settings.includes('slack-support') && settings.includes('web-form'), settings.slice(0, 900));
await page.screenshot(ev.shot('settings-intake'));

if (!REAL_YOUTRACK) {
  // A mapping naming a state YouTrack does not have: the daemon's describe() refusal, word for word, and nothing saved.
  const configUrl = `/v1/workspaces/${c.env.workspaceId}/intake/config`;
  const before = await c.api.get(configUrl);
  await page.fill('In progress', 'Doing');
  await page.click('Save tracker', { within: 'section[aria-label="Intake"]' });
  const shown = await until(() => page.evaluate(`document.querySelector('section[aria-label="Intake"] .intake-settings__refusal')?.innerText.trim() ?? ''`), { label: 'the refusal', timeoutMs: 20_000 });
  let daemonSays = null;
  try { await c.api.put(configUrl, { tracker: { ...before.tracker, states: { ...before.tracker.states, in_progress: 'Doing' } } }); } catch (e) { daemonSays = e.body?.error?.message ?? null; }
  ev.check("a state YouTrack lacks is refused, shown in the daemon's own words", daemonSays !== null && shown === daemonSays && shown.includes('Doing'), { shown, daemonSays });
  ev.check('…and nothing was saved', (await c.api.get(configUrl)).tracker.states.in_progress === 'In Progress');
  await page.evaluate(`document.querySelector('section[aria-label="Intake"] .intake-settings__refusal').scrollIntoView({ block: 'center' })`);
  await sleep(400);
  await page.screenshot(ev.shot('settings-refusal'));
}
c.close(); ev.save();
