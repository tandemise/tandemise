// PM173 (#173) — An approved merge survives the base branch moving. Main must be up to date to merge, and
// someone else's change lands on it after the Review and merge card is filed. The person presses Merge in
// the Inbox: Tandemise brings the pull request up to date, sees that only the base came in, waits for CI
// on the new head and merges that head, with no second card. (A hand edit after Merge voids the approval;
// scratch/merge-check.mjs covers that path, which a window can't time against the daemon's next look.)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { setRepo } from '../../../fake-gh.mjs';
import { REPO, ghCalls, openMission, prs, repositoryId, ship, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-merge-flow');
const GH = `${SCRATCH}/gh`;
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM173', 'An approved merge survives the base branch moving: no second card, the new head merges');
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm173-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};
const other = `${SCRATCH}/other-pm173`;
const git = (...args) => execFileSync('git', ['-c', 'user.name=Someone Else', '-c', 'user.email=someone@example.invalid', ...args], { cwd: other, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const green = [{ name: 'build', status: 'completed', conclusion: 'success' }];

/** A factory mission planned at once; answers its id. */
async function start(title) {
  const made = await api.post('/v1/missions', { workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), title, goal: title, workflowPreset: 'auto', planNow: true });
  return made.id ?? made.mission?.id;
}
const reviewCards = async (id) => (await c.approvals(id)).filter((a) => a.title.startsWith('Review and merge'));
const feedTitles = async (id) => (await c.events(id)).map((e) => e.body);

/** Merge on the card, from the Inbox, as a person does it. */
async function mergeInInbox(title) {
  await page.navigate('#/inbox');
  await until(async () => (await page.evaluate('document.body.innerText')).includes(title), { label: `Inbox shows ${title}`, timeoutMs: 30_000 });
  await c.decideInInbox(title, { option: 'Merge' });
}

try {
  const policy = (await api.get(`/v1/workspaces/${c.env.workspaceId}/merge-policy`)).policy;
  if (policy.autoMerge !== 'off') await api.put(`/v1/workspaces/${c.env.workspaceId}/merge-policy`, { policy: { ...policy, autoMerge: 'off' } });
  // Main must be up to date to merge; CI is green on every commit.
  setRepo(GH, REPO, { defaultChecks: green, protection: { required_status_checks: { strict: true, contexts: ['build'] } } });
  execFileSync('git', ['clone', '-q', `${SCRATCH}/origin.git`, other]);

  // ------------------------------------------------------------ main moves after Merge
  const a = await start('fix: the settings title is wrong');
  ev.note(`mission ${a}`);
  const cardA = await until(async () => (await reviewCards(a)).find((x) => x.status === 'PENDING'), { label: 'Review and merge', timeoutMs: 150_000 });
  const headBefore = (await ship(c, a)).prs[0]?.headSha ?? prs().at(-1)?.headRefOid;
  writeFileSync(join(other, 'OTHER.md'), 'someone else\'s change\n');
  git('pull', '-q', '--no-rebase', 'origin', 'main');
  git('add', 'OTHER.md');
  git('commit', '-q', '-m', 'someone else lands on main');
  git('push', '-q', 'origin', 'HEAD:main');
  ev.note('someone else\'s commit landed on main after the card was filed');
  await mergeInInbox(cardA.title);
  const done = await waitStatus(c, a, ['COMPLETE'], 90_000).catch(() => null);
  ev.check('Merge once: it merges after bringing the pull request up to date', done === 'COMPLETE', done);
  const cards = await reviewCards(a);
  ev.check('…with no second Review and merge card', cards.length === 1 && cards[0].status === 'APPROVED', cards.map((x) => [x.title, x.status]));
  ev.check('…it brought the pull request up to date', ghCalls().some((x) => x.args[0] === 'pr' && x.args[1] === 'update-branch'));
  const kept = (await feedTitles(a)).find((b) => b.type === 'merge.approval_kept');
  const merge = ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'merge').at(-1)?.args ?? [];
  ev.check('…and merged the new head, the commit CI checked', kept !== undefined && merge[merge.indexOf('--match-head-commit') + 1] === kept.toHead && kept.toHead !== headBefore, { kept, merge });
  await openMission(c, a, 'timeline');
  const feed = await until(async () => { const t = await page.evaluate('document.body.innerText'); return t.includes('Your approval stands: only the base branch came in') && t; }, { label: 'feed row', timeoutMs: 20_000 }).catch(() => page.evaluate('document.body.innerText'));
  ev.check('the feed says the approval stands because only the base came in', feed.includes('Your approval stands: only the base branch came in'), feed.slice(0, 1200));
  await page.evaluate(`[...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.includes('Your approval stands'))?.scrollIntoView({ block: 'center' })`);
  await sleep(500);
  await shot('approval-kept');

  setRepo(GH, REPO, { protection: undefined });
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
