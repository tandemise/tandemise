// PM174 (#174) — A merge Tandemise runs on a person's Merge is recorded as merged on approval, not as a merge
// in GitHub. The repository allows auto-merge and requires a check, so Merge in the Inbox queues it on
// GitHub; GitHub then merges it under the person's own gh login. The outcome is `merged`, keeping who
// approved it and the card; the step and the Timeline say "Merged on your approval".
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { putPullRequest, setRepo } from '../../../fake-gh.mjs';
import { REPO, openMission, prs, repositoryId, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-merge-flow');
const GH = `${SCRATCH}/gh`;
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM174', 'A merge on your approval is recorded as merged on approval, not merged by a person in GitHub');
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm174-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};

try {
  const policy = (await api.get(`/v1/workspaces/${c.env.workspaceId}/merge-policy`)).policy;
  if (policy.autoMerge !== 'off') await api.put(`/v1/workspaces/${c.env.workspaceId}/merge-policy`, { policy: { ...policy, autoMerge: 'off' } });
  setRepo(GH, REPO, {
    defaultChecks: [{ name: 'build', status: 'completed', conclusion: 'success' }],
    autoMergeAllowed: true, autoMergeQueues: true, protection: { required_status_checks: { strict: false, contexts: ['build'] } },
  });
  const made = await api.post('/v1/missions', { workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), title: 'fix: the help link is wrong', goal: 'fix: the help link is wrong', workflowPreset: 'auto', planNow: true });
  const id = made.id ?? made.mission?.id;
  ev.note(`mission ${id}`);
  const card = await until(async () => (await c.approvals(id, 'PENDING')).find((x) => x.title.startsWith('Review and merge')), { label: 'Review and merge', timeoutMs: 150_000 });
  await page.navigate('#/inbox');
  await until(async () => (await page.evaluate('document.body.innerText')).includes(card.title), { label: 'Inbox card', timeoutMs: 30_000 });
  await c.decideInInbox(card.title, { option: 'Merge' });
  const pr = await until(async () => prs().find((p) => (card.evidence ?? []).some((e) => e.value === p.url) && p.autoMerge != null), { label: 'queued on GitHub', timeoutMs: 60_000 });
  ev.check('Merge queued it on GitHub', pr !== undefined);
  // GitHub merges it once the check passes, as the person whose gh login Tandemise used.
  putPullRequest(GH, REPO, { ...pr, state: 'MERGED', mergedBy: { login: 'acme-bot' }, mergeCommit: { oid: 'a'.repeat(40) } });
  const done = await waitStatus(c, id, ['COMPLETE'], 60_000).catch(() => null);
  ev.check('the mission completes', done === 'COMPLETE', done);
  const outcomes = c.sql('SELECT body FROM outcomes WHERE mission_id = ?', id).map((r) => JSON.parse(r.body));
  const merged = outcomes.find((o) => o.kind === 'merged');
  ev.check('its outcome is merged on approval, not merged_by_person', merged !== undefined && !outcomes.some((o) => o.kind === 'merged_by_person'), outcomes.map((o) => o.kind));
  ev.check('…keeping who approved it and the card', merged?.merge?.approval?.by === c.me && merged?.merge?.approval?.card === card.id, merged?.merge);
  const step = await c.task(id, 'ship');
  ev.check('the ship step says merged on your approval', (step.statusReason ?? '').startsWith('Merged on your approval'), step.statusReason);
  await openMission(c, id, 'timeline');
  const text = await until(async () => { const t = await page.evaluate('document.body.innerText'); return t.includes('Merged on your approval') && t; }, { label: 'timeline row', timeoutMs: 20_000 }).catch(() => page.evaluate('document.body.innerText'));
  ev.check('the Timeline says "Merged on your approval", never "Merged in GitHub"', text.includes('Merged on your approval') && !text.includes('Merged in GitHub'), text.slice(-1500));
  await page.evaluate(`[...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.includes('Merged on your approval')).pop()?.scrollIntoView({ block: 'center' })`);
  await sleep(500);
  await shot('merged-on-approval');
  setRepo(GH, REPO, { autoMergeAllowed: false, autoMergeQueues: false, protection: undefined });
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
