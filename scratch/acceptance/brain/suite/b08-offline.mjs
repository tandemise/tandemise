// B8 — The remote disappears (the bare repository is renamed) and a task starts: the task runs, and
// Brain → Sync says "Working from your copy of the brain".
import { renameSync } from 'node:fs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REMOTE, clickIn, home1, openBrainTab, runBuildMission } from '../common.mjs';

const c = await home1();
const ev = new Evidence('B8', 'Offline, work goes on from your copy of the brain');
renameSync(REMOTE, `${REMOTE}.gone`);
ev.note('renamed the bare repository behind github.com/acme/brain');
try {
  await openBrainTab(c, 'sync');
  await clickIn(c, 'section[aria-label="Brain sync"]', 'Sync now');
  const line = await c.until(() => c.page.evaluate(`(() => { const t = document.querySelector('[aria-label="Brain status line"]')?.innerText ?? ''; return t.startsWith('Working from your copy of the brain') && t; })()`), { label: 'offline line', timeoutMs: 60_000 });
  ev.check('Brain → Sync says it is working from your copy', line.includes("Couldn't reach github.com."), line);
  const run = await runBuildMission(c, `B8 offline page ${Date.now().toString(36)}`);
  ev.check('the task still runs to the end', run.status === 'COMPLETE' && run.task.status === 'SUCCEEDED', [run.status, run.task.status]);
  await openBrainTab(c, 'sync');
  const after = await c.page.evaluate(`document.querySelector('[aria-label="Brain status line"]')?.innerText ?? ''`);
  ev.check('and the Sync tab still says so', after.startsWith('Working from your copy of the brain'), after);
  await c.page.screenshot(ev.shot('offline'));
} finally {
  renameSync(`${REMOTE}.gone`, REMOTE);
}
await clickIn(c, 'section[aria-label="Brain sync"]', 'Sync now');
const back = await c.until(() => c.page.evaluate(`(() => { const t = document.querySelector('[aria-label="Brain status line"]')?.innerText ?? ''; return t.startsWith('Up to date') && t; })()`), { label: 'back online', timeoutMs: 60_000 });
ev.check('back online, it is up to date again', back.startsWith('Up to date'), back);
c.close(); ev.save();
