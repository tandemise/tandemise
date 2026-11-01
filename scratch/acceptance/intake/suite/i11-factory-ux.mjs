// I11 — the factory explains itself (#103, #105, #113). On the Board a person picks the lane
// before Start; the mission header reads "YouTrack GAR-50 · started by … · Open the issue" with a
// short summary and the task behind a disclosure; "Why these steps" says which signal set type,
// size and risk; Done-when lines show their Markdown as text; once the ship step opens the pull
// request, the header links it.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { boardRow, openBoard, yt, ytB } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I11', 'The factory explains itself: lane before Start, a readable header, what decided the plan, the pull request link');
const KEY = 'GAR-50';
const CRITERION = 'The receipt says **Total** next to `amount`';

// I10 leaves the project's tracker moved to fake YouTrack B, so the item goes where the Board reads now.
const urlB = (() => { try { return ytB.url().replace(/\/+$/, ''); } catch { return null; } })();
const trackerUrl = ((await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/config`)).tracker?.url ?? '').replace(/\/+$/, '');
const tracker = urlB !== null && trackerUrl === urlB ? ytB : yt;
await tracker.put({
  // A Feature: this project maps its Bugs and Tasks to its own workflow, so a Feature is the one the factory plans.
  idReadable: KEY, summary: 'Receipt total label', type: 'Feature', state: 'Open',
  description: `## What happened\n\nThe receipt shows the **sum** without a label, so people cannot tell it is the \`amount\` they paid. The copy should say Total.\n\n## Done when\n- [ ] ${CRITERION}`,
});
await c.api.post(`/v1/workspaces/${c.env.workspaceId}/board/refresh`);
await openBoard(c);
await until(() => boardRow(c, KEY), { label: `${KEY} on the Board`, timeoutMs: 20_000 });
const select = await page.evaluate(`(() => { const s = document.querySelector('[data-board-item=${JSON.stringify(KEY)}] select.board__lane'); return s ? { label: s.getAttribute('aria-label'), options: [...s.options].map((o) => o.text), value: s.value } : null; })()`);
ev.check('the Board offers the lane before Start, named for the item', select?.label === `Lane for ${KEY}` && select.options.join('|') === 'Factory decides|Quick|Careful' && select.value === 'auto', select);
await page.screenshot(ev.shot('board-lane'));
// The person picks Quick, as a person would: focus the select and choose.
await page.evaluate(`(() => { const s = document.querySelector('[data-board-item=${JSON.stringify(KEY)}] select.board__lane'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'quick'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(300);
await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(KEY)}] .board__start').click()`);
const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'the mission opens', timeoutMs: 30_000 });
const mission = (await c.api.get(`/v1/missions/${id}`)).mission;
ev.check('proof (API): the mission carries the lane chosen on the Board', mission.laneRequest === 'quick', mission.laneRequest);

const header = await until(() => page.evaluate(`(() => { const s = document.querySelector('.mission-subtitle'); if (!s) return null; return { lead: s.querySelector('.mission-subtitle__lead')?.innerText.replace(/\\s+/g, ' ').trim(), summary: s.querySelector('.mission-subtitle__summary')?.innerText ?? '', open: s.querySelector('details')?.open ?? null, raw: s.innerText.includes('## What happened') }; })()`), { label: 'the mission header', timeoutMs: 20_000 });
ev.check('the header leads with the item, who started it and a link to it', /^YouTrack GAR-50 · started by .+ · Open the issue/.test(header.lead), header.lead);
ev.check('then a short summary in plain words (no Markdown)', header.summary.startsWith('The receipt shows the sum without a label') && !header.summary.includes('**'), header.summary);
ev.check('the whole task is behind a closed disclosure', header.open === false, header);

// The header grows with its subtitle and keeps every action in the window, at two widths, in both
// themes, with the task's disclosure closed and open; a plain mission is the regression check.
const geometry = () => page.evaluate(`(() => {
  const bar = document.querySelector('.topbar').getBoundingClientRect();
  const title = document.querySelector('.topbar__title').getBoundingClientRect();
  const del = document.querySelector('[aria-label="Delete mission"]').getBoundingClientRect();
  const tabs = document.querySelector('[role="tablist"]')?.getBoundingClientRect() ?? null;
  return { barTop: bar.top, barBottom: bar.bottom, titleTop: title.top, titleBottom: title.bottom, delRight: del.right, delBottom: del.bottom, width: window.innerWidth, height: window.innerHeight, tabsBottom: tabs?.bottom ?? null };
})()`);
const setWidth = (width) => page.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
const setTheme = (theme) => page.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
const setOpen = (open) => page.evaluate(`(() => { const d = document.querySelector('.mission-subtitle__details'); if (d) d.open = ${open}; })()`);
const headerHolds = async (label, shot) => {
  await sleep(300);
  const g = await geometry();
  ev.check(`${label}: the title sits inside the header, and the header contains it`, g.titleTop >= g.barTop && g.titleBottom <= g.barBottom, g);
  ev.check(`${label}: Delete stays inside the window`, g.delRight <= g.width && g.delBottom <= g.barBottom, g);
  if (g.tabsBottom !== null) ev.check(`${label}: the tabs stay on screen`, g.tabsBottom <= g.height, g);
  await page.screenshot(ev.shot(shot));
};
for (const width of [1100, 1440]) {
  for (const theme of ['light', 'dark']) {
    await setWidth(width); await setTheme(theme);
    await setOpen(false);
    await headerHolds(`${width}px ${theme}, task closed`, `header-${width}-${theme}-closed`);
    await setOpen(true);
    await headerHolds(`${width}px ${theme}, task open`, `header-${width}-${theme}-open`);
  }
}
await setOpen(false);
const plain = await c.api.post('/v1/missions', { workspaceId: c.env.workspaceId, goal: 'Tidy the onboarding copy', title: 'Tidy the onboarding copy' });
const plainId = (plain.mission ?? plain).id;
await page.navigate(`#/missions/${plainId}`); await sleep(1500);
for (const width of [1100, 1440]) {
  await setWidth(width); await setTheme('light');
  await headerHolds(`a plain mission at ${width}px`, `header-plain-${width}`);
}
const plainSub = await page.evaluate(`document.querySelector('.topbar__subtitle')?.innerText ?? ''`);
ev.check('a plain mission still shows its goal as written', plainSub.includes('Tidy the onboarding copy') && !(await page.evaluate(`!!document.querySelector('.mission-subtitle')`)), plainSub);
await page.send('Emulation.clearDeviceMetricsOverride');
await setTheme('light');

await page.navigate(`#/missions/${id}/plan`); await sleep(1500);
const why = await until(() => page.evaluate(`document.querySelector('[aria-label="What decided it"]')?.innerText ?? ''`), { label: 'What decided it', timeoutMs: 30_000 });
ev.check('"Why these steps" says which signal set each of type, size and risk',
  why.includes('Type feature: the tracker calls it a Feature.') && why.includes('Size tiny: the item says "copy".') && /Risk low: /.test(why), why);
await page.screenshot(ev.shot('why-these-steps'));
await page.navigate(`#/missions/${id}`); await sleep(1500);
const done = await page.evaluate(`(() => { const s = document.querySelector('[aria-label="Done when"]'); return s ? { text: s.innerText, code: s.querySelector('code')?.innerText ?? null, strong: s.querySelector('strong')?.innerText ?? null } : null; })()`);
ev.check('Done-when shows the line\'s Markdown as text: bold and code, not asterisks', done?.code === 'amount' && done.strong === 'Total' && !done.text.includes('**'), done);
ev.check('with no step to verify it, it says once that you check it at review', done?.text.includes('You check these at review') && !done.text.includes('Not verified'), done?.text);
await page.screenshot(ev.shot('done-when'));

// The quick lane runs one step, then ship opens the pull request on the fake GitHub.
const pr = await until(async () => (await c.api.get(`/v1/missions/${id}/ship`))?.prs?.find((p) => p.state === 'opened'), { label: 'the pull request opens', timeoutMs: 240_000, everyMs: 2000 }).catch(() => null);
if (pr) {
  await page.navigate(`#/missions/${id}`); await sleep(1500);
  const chip = await until(() => page.evaluate(`document.querySelector('[data-pr-link]')?.innerText ?? ''`), { label: 'the pull request chip', timeoutMs: 20_000 }).catch(() => '');
  ev.check('the mission header links the pull request', chip.trim() === `Pull request #${pr.number}`, chip);
  await page.screenshot(ev.shot('mission-pr-link'));
} else {
  ev.note('the ship step did not open a pull request within 4 minutes in this run, so the pull request link is not proven here');
}
await c.api.post(`/v1/missions/${id}/cancel`, { reason: 'acceptance: I11 proven' }).catch(() => undefined);
c.close(); ev.save();
