// I14 — saving the tracker token clears the Board's cached problem (#134).
//
// A second project points at the same fake YouTrack with no token yet, so its
// board caches "Save a YouTrack permanent token…". The person saves the token
// in Settings → Intake, in the window. The board's cache (GET board, which
// never reads the tracker) must then answer the items with no problem without
// anyone pressing refresh, and the Board shows them.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { boardGroups, openBoard, REAL_YOUTRACK, SCRATCH } from '../common.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const c = await context();
const { page, api, until, sleep } = c;
const ev = new Evidence('I14', 'Saving the tracker token clears the Board\'s cached problem');

if (REAL_YOUTRACK) {
  ev.note('Skipped with --real-youtrack: it needs a second project on the fake YouTrack.');
  c.close(); ev.save(); process.exit(0);
}

const ytUrl = readFileSync(join(SCRATCH, 'youtrack', 'url'), 'utf8').trim();
const main = c.env.workspaceId;
const second = (await api.post('/v1/workspaces', { name: 'Token project' })).workspace.id;
ev.check('a second project exists', typeof second === 'string', second);
await api.put(`/v1/workspaces/${second}/intake/config`, {
  tracker: {
    kind: 'youtrack', url: ytUrl, project: 'ACME', board: 'project: ACME #Unresolved',
    states: { ready: ['Open', 'Submitted'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'] },
    onComplete: 'in_review',
  },
});

// The window looks at the second project (the choice is the window's own, per machine).
const look = async (id) => {
  await page.evaluate(`localStorage.setItem('tandemise.workspace', ${JSON.stringify(id)}); location.reload()`);
  await sleep(2500);
};
await look(second);
await openBoard(c);
const problem = await until(async () => (await page.evaluate(`document.querySelector('.board__problem')?.innerText ?? ''`)) || false, { label: 'the problem banner', timeoutMs: 20_000 }).catch(() => '');
ev.check('without a token the Board says to save a YouTrack permanent token', /permanent token/.test(problem), problem);
const cachedBefore = await api.get(`/v1/workspaces/${second}/board`);
ev.check('proof (API): the board cache holds that problem', /permanent token/.test(cachedBefore.problem ?? ''), cachedBefore.problem);
await page.screenshot(ev.shot('board-no-token'));

// Settings → Intake: type the token and press Save token, as a person does.
await page.navigate('#/settings/intake');
await until(() => page.evaluate(`Boolean(document.querySelector('input[type="password"][placeholder="perm:…"]'))`), { label: 'the token field', timeoutMs: 20_000 });
await page.evaluate(`document.querySelector('input[type="password"][placeholder="perm:…"]').focus()`);
await page.send('Input.insertText', { text: 'perm:acceptance' });
await sleep(200);
await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Save token').click()`);
const savedAt = Date.now();

// The cache, not a refresh: GET board never reads the tracker, and the 2-minute tick is not due.
const cleared = await until(async () => {
  const b = await api.get(`/v1/workspaces/${second}/board`);
  return b.problem === null && b.groups.ready.some((i) => i.key === 'ACME-1') && b;
}, { label: 'the board cache without its problem', timeoutMs: 20_000 }).catch(() => null);
ev.check('proof (API): GET board answers no problem and the ready items right after Save token, without a refresh', cleared !== null,
  cleared === null ? (await api.get(`/v1/workspaces/${second}/board`)).problem : { readyKeys: cleared.groups.ready.map((i) => i.key), afterMs: Date.now() - savedAt });

await openBoard(c);
await until(async () => (await boardGroups(c)).ready?.rows?.length > 0, { label: 'the ready items', timeoutMs: 20_000 }).catch(() => null);
const groups = await boardGroups(c);
const bannerAfter = await page.evaluate(`document.querySelector('.board__problem')?.innerText ?? ''`);
ev.check('the Board shows the ready items and no problem banner', bannerAfter === '' && (groups.ready?.rows ?? []).some((r) => r.key === 'ACME-1'), { banner: bannerAfter, ready: (groups.ready?.rows ?? []).map((r) => r.key) });
await page.screenshot(ev.shot('board-after-token'));

// Back to the run's project, so a later scenario sees the window as it was.
await look(main);
c.close(); ev.save();
