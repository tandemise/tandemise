// I15 — Refine a tracker Draft from the Board, write it back as ready, then Start it (#135,
// spec 2026-11-01-board-refine-draft-design.md).
//
// The project maps YouTrack's Draft state. A Draft item shows in the Board's Draft group with
// Refine and no Start. Refine makes a draft mission and runs the scripted product agent, and
// writes nothing to YouTrack. The person decides the proposals and answers the question on the
// mission page. Back on the Board, "Write to YouTrack and mark ready" writes the description with
// its Done-when and Decisions sections, moves the item to Open and posts the activity comment.
// Start then plans that same mission and moves the item to In Progress.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { clickInRow, answerWithOption, sectionText } from '../../p6/common.mjs';
import { boardRow, openBoard, REAL_YOUTRACK, yt } from '../common.mjs';

const c = await context();
const { page, api, until, sleep } = c;
const ev = new Evidence('I15', 'Refine a tracker Draft from the Board, write it back as ready, then Start it');

if (REAL_YOUTRACK) {
  ev.note('Skipped with --real-youtrack: it edits an item in the tracker.');
  c.close(); ev.save(); process.exit(0);
}

const ws = c.env.workspaceId;
// Its own key: I11 starts a GAR-50 of its own, whose mission keeps writing to it.
const KEY = 'GAR-150';
const posts = async () => (await yt.state()).calls.filter((x) => x.method === 'POST' && (x.path.includes(KEY) || x.path === '/api/commands'));

// The mapping gains the Draft state, as a person would set it in Settings → Intake. From
// another screen first, so the form is the saved mapping, not an earlier scenario's edit.
await page.navigate('#/'); await sleep(800);
await page.navigate('#/settings/intake');
await until(() => page.evaluate(`[...document.querySelectorAll('label')].some((l) => l.innerText.startsWith('Draft'))`), { label: 'the Draft field', timeoutMs: 20_000 });
const filled = await page.evaluate(`(() => {
  const label = [...document.querySelectorAll('label')].find((l) => l.innerText.startsWith('Draft'));
  const input = label && (label.querySelector('input') ?? document.getElementById(label.htmlFor));
  if (!input) return false;
  input.focus();
  return true;
})()`);
ev.check('Settings → Intake has a Draft field beside the other states', filled === true);
await page.send('Input.insertText', { text: 'Draft' });
await sleep(300);
await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Save tracker' && !b.disabled)?.click()`);
const mapped = await until(async () => {
  const cfg = await api.get(`/v1/workspaces/${ws}/intake/config`);
  return JSON.stringify(cfg.tracker?.states?.draft) === '["Draft"]' && cfg;
}, { label: 'the draft state saved', timeoutMs: 20_000 }).catch(() => null);
ev.check('proof (API): the tracker maps Draft after Save tracker', mapped !== null, mapped?.tracker?.states);

// The item has its own Acceptance criteria section, as a team's template asks for (#185).
const BODY = 'Visitors see a generic page. Make it feel personal.\n\n## Acceptance criteria\n- AC01: The page loads in under two seconds\n- AC02: The page works without JavaScript\n\n## Notes\nKeep the current colours.';
await yt.put({ idReadable: KEY, summary: 'Greet visitors by name', description: BODY, state: 'Draft' });
await openBoard(c);
await until(async () => (await boardRow(c, KEY)) !== undefined, { label: `${KEY} on the board`, timeoutMs: 20_000 });
const draftGroup = await page.evaluate(`(() => {
  const g = document.querySelector('[data-board-group="draft"]');
  const row = g?.querySelector('[data-board-item=${JSON.stringify(KEY)}]');
  return { heading: g?.querySelector('h2')?.innerText.trim() ?? '', label: g?.getAttribute('aria-label'),
    buttons: row ? [...row.querySelectorAll('button')].map((b) => b.innerText.trim()) : [] };
})()`);
ev.check(`the Board shows a Draft group with ${KEY}, offering Refine and no Start`, draftGroup.heading.startsWith('Draft') && draftGroup.label === 'Draft'
  && draftGroup.buttons.some((b) => b.startsWith('Refine')) && !draftGroup.buttons.some((b) => b.startsWith('Start')), draftGroup);
await page.screenshot(ev.shot('draft-group'));

// Refine: the product agent proposes; nothing reaches YouTrack.
const before = (await posts()).length;
await page.evaluate(`[...document.querySelector('[data-board-item=${JSON.stringify(KEY)}]').querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('Refine')).click()`);
const missionId = await until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'the mission page', timeoutMs: 30_000 });
ev.note(`mission ${missionId}`);
const mission = (await api.get(`/v1/missions/${missionId}`)).mission;
ev.check('Refine opens a draft mission linked to the item', mission.status === 'DRAFT' && mission.title === 'Greet visitors by name', { status: mission.status, title: mission.title });
const settled = await until(async () => { const v = await api.get(`/v1/missions/${missionId}/refinement`); return v.state !== 'running' && v; }, { label: 'the refinement', timeoutMs: 120_000, everyMs: 700 });
await sleep(1500);
ev.check('the scripted product agent proposed Done-when lines and asked a question', settled.criteria.filter((x) => x.status === 'proposed').length >= 2 && settled.questions.some((q) => q.status === 'open'),
  { criteria: settled.criteria.map((x) => [x.key, x.status]), questions: settled.questions.map((q) => [q.key, q.status]) });
const afterRefine = (await posts()).slice(before);
const issueAfterRefine = await yt.issue(KEY);
ev.check('proof (fake YouTrack): Refine wrote nothing; the item is still Draft with no comment', afterRefine.length === 0 && issueAfterRefine.state === 'Draft'
  && (await yt.comments(KEY)).length === 0, { writes: afterRefine.map((x) => x.path), state: issueAfterRefine.state });

// The person decides on the mission page.
await clickInRow(c, 'Proposed criteria', 'P1', 'Accept');
await clickInRow(c, 'Proposed criteria', 'P2', 'Accept');
await clickInRow(c, 'Proposed criteria', 'P3', 'Reject');
await answerWithOption(c, 'Q1', 'Only the home page');
await page.screenshot(ev.shot('decided-on-mission'));
const decided = await api.get(`/v1/missions/${missionId}/refinement`);
const doneWhen = await sectionText(c, 'Done when');
ev.check(`the item's own criteria read "From ${KEY}" on the mission, not "Added by you"`, (doneWhen.match(new RegExp(`From ${KEY}`, 'g')) ?? []).length === 2
  && decided.criteria.filter((x) => x.origin === 'tracker').every((x) => x.originLabel === `From ${KEY}`), doneWhen);
ev.check('two accepted, one rejected, the question answered: ready', decided.readiness.ready === true, decided.readiness);
await sleep(6_000);
ev.check('proof (fake YouTrack): still nothing written while the person decided', (await posts()).slice(before).length === 0 && (await yt.issue(KEY)).state === 'Draft');

// Back on the Board: the write is the person's click.
await openBoard(c);
const card = await until(async () => {
  const t = await page.evaluate(`document.querySelector('[data-board-item=${JSON.stringify(KEY)}]')?.innerText ?? ''`);
  return t.includes('Ready to write to YouTrack') && t;
}, { label: 'the ready card', timeoutMs: 20_000 }).catch(() => '');
ev.check('the card says it is ready to write, with Open refinement and the write button', card.includes('Ready to write to YouTrack: 4 Done-when lines.')
  && card.includes('Open refinement') && card.includes('Write to YouTrack and mark ready'), card);
const writeEnabled = await page.evaluate(`[...document.querySelector('[data-board-item=${JSON.stringify(KEY)}]').querySelectorAll('button')].some((b) => b.innerText.startsWith('Write to YouTrack and mark ready') && !b.disabled)`);
ev.check('…and the write button is enabled', writeEnabled === true);
await page.screenshot(ev.shot('ready-to-write'));
await page.evaluate(`[...document.querySelector('[data-board-item=${JSON.stringify(KEY)}]').querySelectorAll('button')].find((b) => b.innerText.startsWith('Write to YouTrack and mark ready')).click()`);

const written = await until(async () => { const i = await yt.issue(KEY); return i.state === 'Open' && i; }, { label: `${KEY} Open in the fake`, timeoutMs: 30_000 }).catch(() => null);
const added = decided.criteria.filter((x) => x.status === 'accepted' && x.origin !== 'tracker').map((x) => x.statement);
const rejected = decided.criteria.filter((x) => x.status === 'rejected').map((x) => x.statement);
// Byte for byte: every line of the item, in order and unchanged; the rest is exactly what was decided here.
const extra = [];
{
  const mine = BODY.split('\n');
  let at = 0;
  for (const line of (written?.description ?? '').split('\n')) { if (at < mine.length && line === mine[at]) at++; else extra.push(line); }
  if (at !== mine.length) extra.unshift('(an original line is missing or changed)');
}
const expected = [`- AC03: ${added[0]}`, `- AC04: ${added[1]}`, '', '## Decisions', '- Which pages should greet the visitor by name? — Only the home page', '- Not now:', `  - ${rejected[0]}`];
ev.check('proof (fake YouTrack): the item is kept byte for byte; only AC03, AC04 and the Decisions (with Not now) were added',
  written !== null && JSON.stringify(extra) === JSON.stringify(expected), { extra, description: written?.description });
ev.check(`proof (fake YouTrack): ${KEY} moved from Draft to Open`, written?.state === 'Open', written?.state);
const comments = await yt.comments(KEY);
ev.check('proof (fake YouTrack): the activity comment says who refined it and what was written', comments.length === 1
  && /Refined in Tandemise by .+: 2 Done-when lines, 1 answered question\. Moved from Draft to Open\./.test(comments[0].text), comments.map((x) => x.text));

await openBoard(c);
const readyRow = await until(async () => {
  const r = await page.evaluate(`(() => { const row = document.querySelector('[data-board-group="ready"] [data-board-item=${JSON.stringify(KEY)}]'); return row ? { text: row.innerText, start: [...row.querySelectorAll('button')].some((b) => b.innerText.trim().startsWith('Start') && !b.disabled) } : null; })()`);
  return r?.start && r;
}, { label: `${KEY} startable in Ready`, timeoutMs: 20_000 }).catch(() => null);
ev.check(`${KEY} is in Ready with Start offered`, readyRow !== null, readyRow);
await page.screenshot(ev.shot('ready-with-start'));

// Start: the same mission is planned, and the item moves on.
await page.evaluate(`[...document.querySelector('[data-board-group="ready"] [data-board-item=${JSON.stringify(KEY)}]').querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('Start')).click()`);
const startedHash = await until(async () => { const h = await page.evaluate('location.hash'); return h.includes(missionId) && h; }, { label: 'the mission page after Start', timeoutMs: 30_000 }).catch(() => null);
ev.check('Start opens the same mission, not a second one', startedHash !== null, startedHash);
const progressed = await until(async () => { const i = await yt.issue(KEY); return i.state === 'In Progress' && i; }, { label: `${KEY} In Progress`, timeoutMs: 30_000 }).catch(() => null);
ev.check(`proof (fake YouTrack): Start moved ${KEY} to In Progress`, progressed !== null, (await yt.issue(KEY)).state);
// #187: Draft → Open → In Progress, and it stays there across write-back passes, with no refusal on its card.
await sleep(7_000);
const stayed = (await yt.issue(KEY)).state;
const states = (await yt.state()).fieldSets.filter((x) => x.issue === KEY).flatMap((x) => x.fields).filter((f) => f.startsWith('State='));
const startedCard = (await api.get(`/v1/workspaces/${c.env.workspaceId}/board`)).groups.inProgress.find((i) => i.key === KEY);
ev.check(`proof (fake YouTrack): ${KEY} went Draft → Open → In Progress and stayed In Progress`, stayed === 'In Progress'
  && JSON.stringify(states) === JSON.stringify(['State=Open', 'State=In Progress']) && (startedCard?.moveProblem ?? null) === null, { stayed, states, moveProblem: startedCard?.moveProblem });
const status = (await api.get(`/v1/missions/${missionId}`)).mission.status;
ev.check('proof (API): the refined mission left draft for planning', status !== 'DRAFT', status);
const finalComments = await yt.comments(KEY);
ev.check('proof (fake YouTrack): one activity comment, the refined line on top of Started', finalComments.length === 1
  && /Refined in Tandemise by .+\n\nStarted in Tandemise by /.test(finalComments[0].text), finalComments.map((x) => x.text));
const missions = c.sql('SELECT count(*) AS n FROM missions WHERE tracker_item_id = (SELECT id FROM tracker_items WHERE key = ?)', KEY)[0].n;
ev.check('proof (SQL): one mission for the item', missions === 1, missions);
await page.screenshot(ev.shot('started'));

c.close(); ev.save();
