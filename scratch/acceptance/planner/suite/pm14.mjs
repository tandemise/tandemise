// PM14 (#196, #200) — Rounds that CI starts are bounded, and checked against CI as it is now.
// - A step that changes nothing ships nothing: the ship card reads "Nothing to ship" and the mission completes
//   without a pull request.
// - A CI round whose pass leaves the code as it was stops at once: an Inbox card "… made no change in round N"
//   offers Try again, Hold and Cancel the mission, and Cancel the mission cancels it.
// - A mission paused in a CI round, whose check passes again during the pause: Resume drops the round, the
//   Timeline says so, and the mission goes straight to Review and merge without running the code step again.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { setChecks, setRepo } from '../../../fake-gh.mjs';
import { REPO, ghCalls, headerAction, openMission, prs, repositoryId, ship, shipCardText, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-ci-rounds');
const GH = `${SCRATCH}/gh`;
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM14', 'CI rounds are bounded and checked against CI now: nothing to ship, no identical redo, a cleared round dropped');
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm14-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};

async function start(title, goal) {
  const made = await api.post('/v1/missions', {
    workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), title, goal, workflowPreset: 'auto', planNow: true,
  });
  return made.id ?? made.mission?.id;
}
const tasks = async (id) => (await api.get(`/v1/missions/${id}`)).tasks ?? [];
const taskOf = async (id, key) => (await tasks(id)).find((t) => t.key === key);
const creates = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'create').length;

try {
  // ------------------------------------------------ nothing to ship
  setRepo(GH, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'failure', logTail: 'main is red' }], followPushes: true });
  const before = creates();
  const a = await start('fix: typo already fixed on main', 'The typo is already fixed on main. SCRIPTED_NO_CHANGE');
  ev.note(`mission ${a}`);
  await waitStatus(c, a, ['COMPLETE', 'BLOCKED', 'FAILED'], 150_000);
  const view = await ship(c, a);
  ev.check('GET /ship: "Nothing to ship"', view.headline === 'Nothing to ship' && view.status === 'Nothing to ship: the change is already on main.', view);
  ev.check('no pull request was opened', creates() === before, creates() - before);
  ev.check('the mission is complete', (await api.get(`/v1/missions/${a}`)).mission.status === 'COMPLETE');
  await openMission(c, a);
  const card = await shipCardText(c, a, (t) => t.includes('Nothing to ship'));
  ev.check('the ship card says "Nothing to ship: the change is already on main."', card.includes('Nothing to ship: the change is already on main.'), card);
  await sleep(400);
  await shot('nothing-to-ship');

  // ------------------------------------------------ an identical redo
  const b = await start('fix: a test that keeps failing', 'The unit test fails. SCRIPTED_SAME_IN_ROUND');
  ev.note(`mission ${b}`);
  const stopped = await until(async () => (await c.approvals(b, 'PENDING')).find((x) => /made no change in round \d+$/.test(x.title)), { label: 'no-change card', timeoutMs: 180_000 });
  const impl = await taskOf(b, 'implement');
  ev.check('a CI round that left the code as it was stops the code step at once', impl.status === 'BLOCKED' && impl.round >= 2 && new RegExp(`^Round ${impl.round} made no change`).test(impl.statusReason ?? ''), [impl.status, impl.round, impl.statusReason]);
  ev.check('…the card offers Try again, Hold and Cancel the mission', stopped.options.map((o) => o.label).join() === 'Try again,Hold,Cancel the mission', stopped.options);
  ev.check('…and the ship step did not run CI again', (await taskOf(b, 'ship')).status === 'PENDING', (await taskOf(b, 'ship')).statusReason);
  await page.navigate('#/inbox');
  await until(async () => (await page.evaluate('document.body.innerText')).includes(stopped.title), { label: 'Inbox card', timeoutMs: 30_000 });
  await page.evaluate(`[...document.querySelectorAll('button, [role=button]')].find((el) => el.innerText.includes(${JSON.stringify(stopped.title)}))?.click()`);
  await sleep(800);
  const inbox = await page.evaluate('document.body.innerText');
  ev.check('the Inbox shows the card with its three choices', inbox.includes(stopped.title) && inbox.includes('Try again') && inbox.includes('Cancel the mission'), inbox.slice(0, 1500));
  await shot('no-change-card');
  await c.decideInInbox(stopped.title, { option: 'Cancel the mission' });
  await waitStatus(c, b, ['CANCELLED'], 30_000);
  ev.check('Cancel the mission cancels it', (await api.get(`/v1/missions/${b}`)).mission.status === 'CANCELLED');

  // ------------------------------------------------ a round whose cause cleared while paused
  setRepo(GH, REPO, { followPushes: false, defaultChecks: [{ name: 'unit', status: 'in_progress', conclusion: null }] });
  const d = await start('fix: a flaky unit test', 'The unit test is flaky.');
  ev.note(`mission ${d}`);
  const waiting = await until(async () => { const v = await ship(c, d); return v.stage === 'ci' && v.prs.length > 0 && v; }, { label: 'ship waits for CI', timeoutMs: 150_000 });
  const pr = prs().find((p) => p.number === waiting.prs[0].number);
  await openMission(c, d);
  await headerAction(c, 'Pause');
  await waitStatus(c, d, ['PAUSED'], 30_000);
  const fail = { name: 'unit', conclusion: 'failure', logTail: 'flaky: timed out after 5000 ms', startedAt: '2026-01-01T00:01:00Z' };
  setChecks(GH, REPO, pr.headRefOid, [fail]);
  await until(async () => ((await taskOf(d, 'implement'))?.round ?? 1) >= 2, { label: 'round 2 starts', timeoutMs: 60_000 });
  const attemptsBefore = (await taskOf(d, 'implement')).attempts;
  // Someone re-runs the check on GitHub during the pause, and it passes on the same commit.
  setChecks(GH, REPO, pr.headRefOid, [fail, { name: 'unit', conclusion: 'success', startedAt: '2026-01-01T00:05:00Z' }]);
  await openMission(c, d);
  await headerAction(c, 'Resume');
  const review = await until(async () => (await c.approvals(d, 'PENDING')).find((x) => x.title.startsWith('Review and merge')), { label: 'Review and merge', timeoutMs: 120_000 });
  const implD = await taskOf(d, 'implement');
  ev.check('the round is dropped: implement stands, round 2 never ran', implD.status === 'SUCCEEDED' && implD.attempts === attemptsBefore && (implD.statusReason ?? '').startsWith('Round 2 dropped: unit passes now on commit'), [implD.status, implD.attempts, attemptsBefore, implD.statusReason]);
  ev.check('the mission went straight to Review and merge', review.title === `Review and merge #${pr.number}: ${pr.title}`, review.title);
  await page.navigate(`#/missions/${d}/timeline`);
  const timeline = await until(async () => {
    const t = await page.evaluate('document.body.innerText');
    return t.includes('is dropped') && t;
  }, { label: 'timeline note', timeoutMs: 30_000 }).catch(() => page.evaluate('document.body.innerText'));
  ev.check('the Timeline says the round was dropped and the mission goes on to ship', timeline.includes("so round 2 of 'implement' is dropped and the mission goes on to ship"), timeline.slice(0, 2000));
  await page.evaluate(`[...document.querySelectorAll('li, article, div')].reverse().find((el) => el.children.length < 6 && el.innerText.includes('is dropped and the mission goes on to ship'))?.scrollIntoView({ block: 'center' })`);
  await sleep(600);
  await shot('round-dropped-timeline');
  setRepo(GH, REPO, { defaultChecks: [] });
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
