// I16 (#154, #210) — The factory reads the kind of work from the tracker item itself, and a command in an item's
// reproduction steps is not what the change is.
// - A YouTrack "User Story" with a plain title is planned as a feature: "Why these steps" says the tracker calls it
//   a User Story, and no quick model is asked.
// - An item with no type, tagged "bug", whose "Steps to reproduce" run `npm run db:migrate` (in a code span and a
//   fenced block), is planned as a fix from its tag, at low risk, and not in the careful lane.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { boardRow, openBoard, yt, ytB } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I16', 'The tracker item\'s type and labels decide the kind of work; a reproduction command does not raise risk');

// I10 leaves the project's tracker moved to fake YouTrack B, so the items go where the Board reads now.
const urlB = (() => { try { return ytB.url().replace(/\/+$/, ''); } catch { return null; } })();
const trackerUrl = ((await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/config`)).tracker?.url ?? '').replace(/\/+$/, '');
const tracker = urlB !== null && trackerUrl === urlB ? ytB : yt;

const STORY = 'GAR-60';
const BUG = 'GAR-61';
await tracker.put({
  idReadable: STORY, summary: 'Export the board', type: 'User Story', state: 'Open',
  description: 'People want to take the board into a spreadsheet to plan the week with their team.\n\n## Done when\n- [ ] The board has an Export button\n- [ ] The file opens in a spreadsheet',
});
await tracker.put({
  idReadable: BUG, summary: 'Export test fails on a clean checkout', type: null, tags: ['bug'], state: 'Open',
  description: [
    'The export test fails on a clean checkout, before anything else runs.',
    '',
    '## Steps to reproduce',
    '',
    '1. Clone the repository and run `npm run db:migrate`.',
    '2. Run the export test:',
    '',
    '```',
    'npm run db:migrate && npm test -- export',
    '```',
    '',
    '## Done when',
    '- [ ] The export test passes on a clean checkout',
  ].join('\n'),
});
await c.api.post(`/v1/workspaces/${c.env.workspaceId}/board/refresh`);

/** Starts an item from the Board with "Factory decides"; answers the mission id. */
async function start(key) {
  await openBoard(c);
  await until(() => boardRow(c, key), { label: `${key} on the Board`, timeoutMs: 20_000 });
  const lane = await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(key)}] select.board__lane')?.value ?? null`);
  ev.check(`${key}: the Board's lane is "Factory decides"`, lane === 'auto', lane);
  await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(key)}] .board__start').click()`);
  return until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: `${key}: the mission opens`, timeoutMs: 30_000 });
}

/** "Why these steps" on the Plan tab, and the lane line above it. */
async function why(id) {
  await page.navigate(`#/missions/${id}/plan`); await sleep(1500);
  const decided = await until(() => page.evaluate(`document.querySelector('[aria-label="What decided it"]')?.innerText ?? ''`), { label: 'What decided it', timeoutMs: 60_000 });
  const all = await page.evaluate(`document.querySelector('section[aria-label="Why these steps"]')?.innerText ?? ''`);
  return { decided, all };
}

try {
  const story = await start(STORY);
  ev.note(`${STORY} → ${story}`);
  const s = await why(story);
  ev.check('a User Story is planned as a feature, because the tracker says so', s.decided.includes('Type feature: the tracker calls it a User Story.'), s.decided);
  ev.check('…and no quick model was asked what kind of work it is', !s.all.includes("Couldn't tell"), s.all.slice(0, 1200));
  await page.screenshot(ev.shot('story-why'));

  const bug = await start(BUG);
  ev.note(`${BUG} → ${bug}`);
  const b = await why(bug);
  ev.check('an item tagged "bug" with a plain title is planned as a fix, from its tag', b.decided.includes('Type fix: it has the label "bug".'), b.decided);
  ev.check('a db:migrate command in its reproduction steps does not make it risky', /Risk low: /.test(b.decided) && !b.decided.includes('"migrate"'), b.decided);
  ev.check('…so it is not in the careful lane', !/Careful lane/.test(b.all) && /(Quick|Standard) lane/.test(b.all), b.all.slice(0, 1200));
  ev.check('…and no quick model was asked', !b.all.includes("Couldn't tell"), b.all.slice(0, 1200));
  await page.screenshot(ev.shot('bug-why'));
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
