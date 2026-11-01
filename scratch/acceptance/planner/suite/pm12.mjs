// PM12 (#157, #152) — The pull request is titled with the change's real commit type, and the Review and merge
// card shows it as GitHub has it. Two factory missions whose titles are plain, each starting with a tracker key:
// - the agent commits its work as `fix(settings): …`: the pull request takes that commit's type and subject;
// - the agent writes no commit of its own: the title keeps the key's case (`KEY-78`, never `kEY-78`).
// With no CI on the repository the ship step asks; the card reads "Review and merge #N: <PR title>" in the Inbox.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REPO, prs, repositoryId, ship, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-pr-title');
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM12', 'The pull request is titled with the change\'s commit type; Review and merge shows that title, keys in their case');
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm12-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};

/** A factory mission with this title, planned at once; answers its id. */
async function start(title, goal) {
  const made = await api.post('/v1/missions', {
    workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), title, goal, workflowPreset: 'auto', planNow: true,
  });
  return made.id ?? made.mission?.id;
}

/** Waits for the ship step's pull request and its Review and merge card. */
async function shipped(id) {
  const view = await until(async () => { const v = await ship(c, id); return v.prs.length > 0 && v; }, { label: 'pull request opened', timeoutMs: 150_000 });
  const pr = prs().find((p) => p.number === view.prs[0].number);
  const card = await until(async () => (await c.approvals(id, 'PENDING')).find((a) => a.title.startsWith('Review and merge')), { label: 'Review and merge', timeoutMs: 90_000 });
  return { pr, card };
}

try {
  const SUBJECT = 'fix(settings): spell the settings title right';
  const a = await start('KEY-77 Settings title reads Setings', `The settings page title reads Setings. SCRIPTED_COMMIT="${SUBJECT}"`);
  ev.note(`mission ${a}`);
  await waitStatus(c, a, ['EXECUTING', 'COMPLETE'], 60_000);
  const one = await shipped(a);
  ev.check(`the agent's own commit types and words the pull request: "${SUBJECT}"`, one.pr?.title === SUBJECT, one.pr?.title);
  ev.check(`the card is "Review and merge #${one.pr?.number}: ${SUBJECT}"`, one.card?.title === `Review and merge #${one.pr?.number}: ${SUBJECT}`, one.card?.title);

  // One at a time: the fake GitHub keeps its state in one file, and two creates in the same instant lose one.
  const b = await start('KEY-78 Footer link goes nowhere', 'The footer link goes nowhere.');
  ev.note(`mission ${b}`);

  const two = await shipped(b);
  ev.check('with no commit of the agent\'s own, the tracker key keeps its case', /: KEY-78 Footer link goes nowhere$/.test(two.pr?.title ?? '') && !/kEY-78/.test(two.pr?.title ?? ''), two.pr?.title);
  ev.check('…and the card shows that same title', two.card?.title === `Review and merge #${two.pr?.number}: ${two.pr?.title}`, two.card?.title);
  ev.note(`pull requests on ${REPO}: ${prs().map((p) => `#${p.number} ${p.title}`).join(' | ')}`);

  // ------------------------------------------------------------ the window
  await page.navigate('#/inbox');
  const inbox = await until(async () => {
    const t = await page.evaluate('document.body.innerText');
    return t.includes(`Review and merge #${one.pr?.number}: ${SUBJECT}`) && t.includes(`Review and merge #${two.pr?.number}: ${two.pr?.title}`) && t;
  }, { label: 'Inbox cards', timeoutMs: 30_000 }).catch(() => page.evaluate('document.body.innerText'));
  ev.check('Inbox: the first card reads the pull request\'s own title', inbox.includes(`Review and merge #${one.pr?.number}: ${SUBJECT}`), inbox.slice(0, 900));
  ev.check('Inbox: the second card keeps KEY-78', inbox.includes(`Review and merge #${two.pr?.number}: ${two.pr?.title}`) && !inbox.includes('kEY-78'), inbox.slice(0, 900));
  await sleep(500);
  await shot('inbox');
  await page.navigate(`#/missions/${a}`);
  await sleep(2500);
  const missionText = await page.evaluate('document.body.innerText');
  ev.check('the mission page shows the card with the pull request\'s title', missionText.includes(`Review and merge #${one.pr?.number}: ${SUBJECT}`), missionText.slice(0, 900));
  await shot('mission');
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
