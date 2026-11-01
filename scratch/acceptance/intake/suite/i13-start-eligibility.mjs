// I13 — What Start offers (#136). The project says, in Settings → Intake, that it builds Bug and Task items
// and that its repository's tag is repo:web. On the Board a container (two open subtasks), a Spike and a Bug
// tagged repo:api stay listed, each with its type and the reason beside a disabled Start; a plain Task tagged
// repo:web still starts. The daemon refuses a Start of the three in the same words.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REAL_YOUTRACK, boardRow, openBoard, yt } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I13', 'Start is off for a container, a type the project does not build and another repository\'s item');
if (REAL_YOUTRACK) { ev.note('Seeds items: not run against a real YouTrack.'); c.close(); ev.save(); process.exit(0); }

// The project's rules, set the way a person would, on a fresh form (a scenario before may have left a draft).
await page.navigate('#/home'); await sleep(600);
await page.navigate('#/settings');
await until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Intake"]'))`), { label: 'Settings → Intake', timeoutMs: 20_000 });
await page.fill('In progress', 'In Progress');
await page.fill('Types to build', 'Bug, Task');
await page.fill('Repository tag', 'repo:web');
await page.evaluate(`document.querySelector('section[aria-label="Intake"] input[placeholder="repo:web"]').scrollIntoView({ block: 'center' })`);
await sleep(300);
await page.screenshot(ev.shot('settings-start-rules'));
await page.click('Save tracker', { within: 'section[aria-label="Intake"]' });
const saved = await until(async () => {
  const t = (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/config`)).tracker;
  return t?.repoTag === 'repo:web' && t;
}, { label: 'the rules are saved', timeoutMs: 20_000 }).catch(() => null);
ev.check('proof (API): the tracker now builds Bug and Task, for repo:web', JSON.stringify(saved?.buildTypes) === '["Bug","Task"]' && saved?.repoTag === 'repo:web', saved);

// The tracker's items, seeded through the fake's own door.
const container = await yt.put({ summary: 'Checkout redesign (pull the subtasks)', state: 'Open', type: 'Task', tags: ['repo:web'] });
await yt.put({ summary: 'Checkout redesign: the address form', state: 'Open', type: 'Task', tags: ['repo:web'], parent: container.idReadable });
await yt.put({ summary: 'Checkout redesign: the summary card', state: 'Open', type: 'Task', tags: ['repo:web'], parent: container.idReadable });
const spike = await yt.put({ summary: 'Research a faster product cache', state: 'Open', type: 'Spike', tags: ['repo:web'] });
const other = await yt.put({ summary: 'The orders API times out', state: 'Open', type: 'Bug', tags: ['repo:api'] });
const plain = await yt.put({ summary: 'Add a footer to the receipt page', description: '## Done when\n- [ ] The receipt page shows a footer', state: 'Open', type: 'Task', tags: ['repo:web'] });

await openBoard(c);
await until(() => boardRow(c, plain.idReadable), { label: `${plain.idReadable} on the Board`, timeoutMs: 30_000 });
const card = (key) => page.evaluate(`(() => {
  const r = document.querySelector('[data-board-item=${JSON.stringify(key)}]');
  if (!r) return null;
  const start = r.querySelector('.board__start');
  return {
    type: r.querySelector('.board__type')?.innerText.trim() ?? null,
    reason: r.querySelector('.board__blocked')?.innerText.trim() ?? null,
    start: start ? { disabled: start.disabled } : null,
    group: r.closest('[data-board-group]')?.getAttribute('data-board-group') ?? null,
  };
})()`);
const expectations = [
  [container.idReadable, 'the container', 'Task', 'Has 2 subtasks. Start one of them.'],
  [spike.idReadable, 'the Spike', 'Spike', 'Spike: this project starts Bug and Task items.'],
  [other.idReadable, "another repository's Bug", 'Bug', 'Belongs to another repository (repo:api).'],
];
for (const [key, what, type, reason] of expectations) {
  const seen = await card(key);
  ev.check(`${what} (${key}) stays on the Board under Ready, its type ${type} shown`, seen?.group === 'ready' && seen.type === type, seen);
  ev.check(`…with "${reason}" beside a disabled Start`, seen?.reason === reason && seen.start?.disabled === true, seen);
}
const plainCard = await card(plain.idReadable);
ev.check(`a plain Task (${plain.idReadable}) shows its type and Start is on`, plainCard?.type === 'Task' && plainCard.reason === null && plainCard.start?.disabled === false, plainCard);
await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(container.idReadable)}]').scrollIntoView({ block: 'center' })`);
await sleep(400);
await page.screenshot(ev.shot('board-start-off'));

// The daemon says the same, whatever presses Start.
for (const [key, , , reason] of expectations) {
  let said = null;
  try { await c.api.post(`/v1/workspaces/${c.env.workspaceId}/board/start`, { key }); } catch (e) { said = { status: e.status, message: e.body?.error?.message ?? null }; }
  ev.check(`proof (API): Start of ${key} is refused in the same words`, said?.message === reason && said.status === 409, said);
}
const untouched = await Promise.all(expectations.map(([key]) => yt.issue(key)));
ev.check('proof (fake YouTrack): none of the three moved', untouched.every((i) => i.state === 'Open'), untouched.map((i) => `${i.idReadable} ${i.state}`));

// A plain Task still starts.
await openBoard(c);
await until(() => boardRow(c, plain.idReadable), { label: `${plain.idReadable} on the Board`, timeoutMs: 20_000 });
await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(plain.idReadable)}] .board__start').click()`);
const id = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'the mission opens', timeoutMs: 30_000 });
ev.check(`Start on ${plain.idReadable} opens its mission`, typeof id === 'string' && id.startsWith('msn_'), id);
const state = await until(async () => { const i = await yt.issue(plain.idReadable); return i?.state === 'In Progress' && i.state; }, { label: 'In Progress', timeoutMs: 20_000 }).catch(() => null);
ev.check(`proof (fake YouTrack): ${plain.idReadable} is In Progress`, state === 'In Progress', state);
await sleep(1000);
await page.screenshot(ev.shot('plain-task-started'));
c.close(); ev.save();
