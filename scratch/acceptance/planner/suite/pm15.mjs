// PM15 (#194) — A failing CI check is classified before Tandemise acts on it.
// - Before GitHub registers a check, the ship card reads "Waiting for checks to start", not "0 of 0".
// - A pull-request title check that fails (the title was changed on GitHub to a plain sentence) is fixed in the
//   ship step: the pull request is retitled as a Conventional Commit, the feed says so, the check runs again and
//   passes, and the mission reaches Review and merge without a second round of the code step.
// - A failing check Tandemise can't place ("deploy-preview") is a card naming the check with its log tail, and the
//   code step is not sent back.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { putPullRequest, setRepo } from '../../../fake-gh.mjs';
import { REPO, ghCalls, prs, repositoryId, ship, shipCardText, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-ci-failures');
const GH = `${SCRATCH}/gh`;
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM15', 'A failing check is classified first: a title is fixed in ship, an unknown check is asked about, no round');
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm15-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};
const TITLE_RULE = { name: 'PR title', pattern: '^(feat|fix|docs|chore|refactor|perf|test|build|ci|revert)(\\([^)]+\\))?!?: [a-z]' };

async function start(title, goal) {
  const made = await api.post('/v1/missions', {
    workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), title, goal, workflowPreset: 'auto', planNow: true,
  });
  return made.id ?? made.mission?.id;
}
const tasks = async (id) => (await api.get(`/v1/missions/${id}`)).tasks ?? [];
const codeRound = async (id) => Math.max(1, ...(await tasks(id)).filter((t) => t.key !== 'ship').map((t) => t.round ?? 1));
const feed = async (id) => (await api.get(`/v1/missions/${id}/events`).catch(() => ({ events: [] }))).events ?? [];

try {
  // ------------------------------------------------ not started yet
  // A workflow is queued on every commit but hasn't created its runs.
  setRepo(GH, REPO, { defaultChecks: [], defaultSuites: [{ status: 'queued', latest_check_runs_count: 0, app: { slug: 'github-actions' } }], titleCheck: undefined });
  const a = await start('fix: typo in the about title', 'The about page title reads Abuot.');
  ev.note(`mission ${a}`);
  await waitStatus(c, a, ['EXECUTING'], 60_000);
  const waiting = await until(async () => { const v = await ship(c, a); return v.stage === 'ci' && v.prs.length > 0 && v; }, { label: 'ship waits for CI', timeoutMs: 150_000 });
  ev.check('GET /ship: "Waiting for checks to start"', waiting.headline === 'Waiting for checks to start', waiting.headline);
  const card = await shipCardText(c, a, (t) => t.includes('Waiting for checks to start'));
  ev.check('the ship card says "Waiting for checks to start", not "0 of 0"', card.includes('Waiting for checks to start') && !card.includes('0 of 0'), card);
  await sleep(400);
  await shot('waiting-for-checks');

  // ------------------------------------------------ a title check, fixed in ship
  // Someone renamed the pull request on GitHub to a plain sentence; then the checks register: unit passes, the
  // title check reads the title and fails.
  const opened = prs().find((p) => p.number === waiting.prs[0].number);
  putPullRequest(GH, REPO, { ...opened, title: 'Typo in the about title' });
  setRepo(GH, REPO, { defaultSuites: [], defaultChecks: [{ name: 'unit', conclusion: 'success' }], titleCheck: TITLE_RULE });
  const asked = await until(async () => (await c.approvals(a, 'PENDING')).find((x) => x.title.startsWith('Review and merge') || x.title.includes('CI failed')), { label: 'review or a card', timeoutMs: 120_000 });
  const now = prs().find((p) => p.number === opened.number);
  ev.check('the title check is fixed by retitling the pull request', new RegExp(TITLE_RULE.pattern).test(now.title) && now.title === 'fix: typo in the about title', now.title);
  ev.check('…through gh pr edit --title', ghCalls().some((x) => x.args[1] === 'edit' && x.args.includes('--title')), ghCalls().filter((x) => x.args[1] === 'edit').map((x) => x.args.join(' ')));
  ev.check('the code step was not sent back (round 1)', (await codeRound(a)) === 1, (await tasks(a)).map((t) => [t.key, t.round, t.status]));
  ev.check('the check ran again and passed, so it asks to Review and merge', asked.title.startsWith('Review and merge'), asked.title);
  await page.navigate(`#/missions/${a}`);
  await sleep(1500);
  const feedText = await page.evaluate('document.body.innerText');
  ev.check('the Feed shows Review and merge, and implement done once', feedText.includes('Review and merge #') && !/Round 2/.test(feedText), feedText.slice(0, 1500));
  await shot('title-fixed-feed');
  await page.navigate(`#/missions/${a}/timeline`);
  const missionText = await until(async () => {
    const t = await page.evaluate('document.body.innerText');
    return t.includes('retitled') && t;
  }, { label: 'feed note', timeoutMs: 30_000 }).catch(() => page.evaluate('document.body.innerText'));
  ev.check('the Timeline says the title was fixed, not the code', missionText.includes(`retitled #${opened.number} to "fix: typo in the about title"`), missionText.slice(0, 1500));
  ev.check('…and shows no second round', !/Round 2/.test(missionText), missionText.slice(0, 1500));
  await sleep(600);
  await shot('title-fixed-timeline');
  void feed;

  // ------------------------------------------------ a check it can't place
  setRepo(GH, REPO, { titleCheck: undefined, defaultChecks: [{ name: 'unit', conclusion: 'success' }, { name: 'deploy-preview', conclusion: 'failure', logTail: 'Error: preview quota reached for this account' }] });
  const b = await start('fix: typo in the footer', 'The footer reads Foter.');
  ev.note(`mission ${b}`);
  const unknown = await until(async () => (await c.approvals(b, 'PENDING')).find((x) => x.title.includes('deploy-preview')), { label: 'unknown-check card', timeoutMs: 180_000 });
  ev.check('a card names the check and asks whether it is about the code', unknown.title.endsWith('CI failed on deploy-preview; is it about the code?'), unknown.title);
  ev.check('…with its log tail', JSON.stringify(unknown.evidence ?? []).includes('preview quota reached'), unknown.evidence);
  ev.check('…and says planner.yaml can classify it', (unknown.effect ?? '').includes('ci.checks'), unknown.effect);
  ev.check('the code step was not sent back (round 1)', (await codeRound(b)) === 1, (await tasks(b)).map((t) => [t.key, t.round, t.status]));
  await page.navigate('#/inbox');
  const inbox = await until(async () => {
    const t = await page.evaluate('document.body.innerText');
    return t.includes('deploy-preview') && t;
  }, { label: 'Inbox card', timeoutMs: 30_000 }).catch(() => page.evaluate('document.body.innerText'));
  ev.check('the Inbox shows the card', inbox.includes('CI failed on deploy-preview; is it about the code?'), inbox.slice(0, 1200));
  await sleep(600);
  await shot('unknown-check-inbox');
  setRepo(GH, REPO, { defaultChecks: [] });
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
