// PM15 (#184) — A merge that fails after Merge is never silent. GitHub refuses the merge (as gh refused a
// field in #183). The ship step blocks with a "Merge failed" card naming GitHub's reason, with Retry merge,
// Open the pull request and "I'll merge it in GitHub"; Home counts it in Needs you, in the tile and the
// list; the Inbox shows it. Once GitHub takes merges again, Retry merge merges it.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { setRepo } from '../../../fake-gh.mjs';
import { ghCalls, repositoryId, REPO, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-merge-flow');
const GH = `${SCRATCH}/gh`;
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM15', 'A merge that fails after Merge blocks with a card that names why; Home and the Inbox show it; Retry merge merges');
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm15-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};
const REFUSED = "GraphQL: Field 'mergeCommitBody' doesn't exist on type 'MergePullRequestInput'";
const merges = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'merge').length;

try {
  const policy = (await api.get(`/v1/workspaces/${c.env.workspaceId}/merge-policy`)).policy;
  if (policy.autoMerge !== 'off') await api.put(`/v1/workspaces/${c.env.workspaceId}/merge-policy`, { policy: { ...policy, autoMerge: 'off' } });
  setRepo(GH, REPO, { defaultChecks: [{ name: 'build', status: 'completed', conclusion: 'success' }], refuseMerge: REFUSED });
  const made = await api.post('/v1/missions', { workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), title: 'fix: the about page has a typo', goal: 'fix: the about page has a typo', workflowPreset: 'auto', planNow: true });
  const id = made.id ?? made.mission?.id;
  ev.note(`mission ${id}; GitHub refuses every merge with: ${REFUSED}`);
  const review = await until(async () => (await c.approvals(id, 'PENDING')).find((x) => x.title.startsWith('Review and merge')), { label: 'Review and merge', timeoutMs: 150_000 });
  await page.navigate('#/inbox');
  await until(async () => (await page.evaluate('document.body.innerText')).includes(review.title), { label: 'Inbox card', timeoutMs: 30_000 });
  const before = merges();
  await c.decideInInbox(review.title, { option: 'Merge' });
  const failed = await until(async () => (await c.approvals(id, 'PENDING')).find((x) => x.title.startsWith('Merge failed')), { label: 'Merge failed card', timeoutMs: 60_000 });
  const step = await c.task(id, 'ship');
  ev.check('the step is blocked, saying GitHub\'s reason', step.status === 'BLOCKED' && (step.statusReason ?? '').includes(REFUSED), [step.status, step.statusReason]);
  ev.check('a "Merge failed" card names the reason', failed.rationale.includes(REFUSED), failed.rationale);
  ev.check('…with Retry merge and "I\'ll merge it in GitHub"', failed.options.map((o) => o.label).join('|') === "Retry merge|I'll merge it in GitHub", failed.options);
  ev.check('…and Open the pull request', failed.evidence.some((e) => e.kind === 'link' && e.label === 'Open the pull request'), failed.evidence);
  ev.check('a refusal a retry can\'t change was tried once', merges() - before === 1, merges() - before);

  // Home: counted in Needs you, in the tile and the list.
  await page.navigate('#/');
  const home = await until(async () => { const t = await page.evaluate('document.body.innerText'); return t.includes(failed.title) && t; }, { label: 'Home lists it', timeoutMs: 30_000 }).catch(() => page.evaluate('document.body.innerText'));
  const tile = Number(home.match(/Needs you\s*\n\s*(\d+)/)?.[1] ?? '0');
  ev.check('Home: the Needs you tile counts it', tile >= 1 && !home.includes('Nothing waits on you'), home.slice(0, 500));
  ev.check('Home: "Needs you now" lists it', home.includes(failed.title), home.slice(0, 1500));
  await shot('home');

  // The Inbox card, opened.
  await page.navigate('#/inbox');
  await until(async () => (await page.evaluate('document.body.innerText')).includes(failed.title), { label: 'Inbox shows it', timeoutMs: 30_000 });
  await c.ui.openItem(failed.title, 'Everyone');
  await sleep(800);
  const card = await page.evaluate('document.body.innerText');
  ev.check('Inbox: the card reads the reason, Retry merge, I\'ll merge it in GitHub and Open the pull request', card.includes(REFUSED) && card.includes('Retry merge') && card.includes("I'll merge it in GitHub") && card.includes('Open the pull request'), card.slice(0, 1500));
  await shot('inbox-card');

  // GitHub takes merges again: Retry merge merges it.
  setRepo(GH, REPO, { refuseMerge: undefined });
  await c.decideInInbox(failed.title, { option: 'Retry merge' });
  const done = await waitStatus(c, id, ['COMPLETE'], 60_000).catch(() => null);
  ev.check('Retry merge merges it and the mission completes', done === 'COMPLETE', done);
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
setRepo(GH, REPO, { refuseMerge: undefined });
c.close(); ev.save();
