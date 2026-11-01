// I6 — A person writes a Done-when on the Sentry item in YouTrack, then presses Start on the Board. The mission
// opens with the item's criterion; the fake YouTrack shows the item In Progress and one comment that starts
// `<!-- tandemise:activity -->`. A second Start is refused in the daemon's words.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REAL_YOUTRACK, boardGroups, boardRow, openBoard, readScenarioState, writeScenarioState, yt } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I6', 'Start opens a mission with the item\'s criteria and the tracker follows');
const { sentryKey } = readScenarioState();
const CRITERION = 'Checkout no longer throws when the basket is empty';

if (!REAL_YOUTRACK) {
  const item = await yt.issue(sentryKey);
  await yt.edit(sentryKey, { description: `Seen on an empty basket at checkout.\n\n## Done when\n- [ ] ${CRITERION}\n\n${item.description}` });
}
await openBoard(c);
const row = await until(() => boardRow(c, sentryKey), { label: `${sentryKey} on the Board`, timeoutMs: 20_000 });
ev.check(`${sentryKey} is Ready with Start enabled`, row.text.includes('Start') && await page.evaluate(`!document.querySelector('[data-board-item=${JSON.stringify(sentryKey)}] .board__start').disabled`), row.text);
await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(sentryKey)}] .board__start').click()`);
const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'the mission opens', timeoutMs: 30_000 });
ev.check('Start opens the mission', id.startsWith('msn_'), id);
await sleep(1500);
const doneWhen = await until(() => page.evaluate(`document.querySelector('[aria-label="Done when"]')?.innerText ?? ''`), { label: 'Done when', timeoutMs: 20_000 });
if (!REAL_YOUTRACK) ev.check("the mission's Done when is the item's criterion", doneWhen.includes(CRITERION), doneWhen);
const mission = (await c.api.get(`/v1/missions/${id}`)).mission;
ev.check('the mission was planned, never queued', mission.status !== 'DRAFT' && mission.queued !== true, { status: mission.status, queued: mission.queued });
await page.screenshot(ev.shot('mission'));

if (!REAL_YOUTRACK) {
  const state = await until(async () => { const i = await yt.issue(sentryKey); return i?.state === 'In Progress' && i.state; }, { label: 'In Progress', timeoutMs: 20_000 });
  ev.check(`proof (fake YouTrack): ${sentryKey} is In Progress`, state === 'In Progress', state);
  const activity = await until(async () => { const list = (await yt.comments(sentryKey)).filter((x) => x.text.startsWith('<!-- tandemise:activity -->')); return list.length > 0 && list; }, { label: 'the activity comment', timeoutMs: 20_000 });
  ev.check('proof (fake YouTrack): one comment starting <!-- tandemise:activity -->', activity.length === 1 && activity[0].text.includes('Started in Tandemise by'), activity.map((x) => x.text));
}

await openBoard(c);
const started = await until(async () => (await boardGroups(c)).inProgress?.rows.find((r) => r.key === sentryKey), { label: 'the row under In progress', timeoutMs: 20_000 });
const actions = await page.evaluate(`(() => { const row = document.querySelector('[data-board-item=${JSON.stringify(sentryKey)}]'); const open = row?.querySelector('.board__open'); return { start: !!row?.querySelector('.board__start'), open: open ? { text: open.innerText.trim(), href: open.getAttribute('href') } : null }; })()`);
ev.check(`${sentryKey} moved under In progress, with its mission's status in words`, /Mission: (Planning|Awaiting plan approval|Executing)/.test(started.text), started.text);
// #108: an item with a mission offers Open mission, not a Start that can only be refused.
ev.check('…and offers Open mission instead of Start', actions.start === false && actions.open?.text.startsWith('Open mission') && actions.open.href.endsWith(`/missions/${id}`), actions);
await page.screenshot(ev.shot('board-started'));
writeScenarioState({ missionId: id, missionTitle: mission.title });
c.close(); ev.save();
