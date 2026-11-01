// I12 — first-ten-minutes papercuts (#108): a repository path can be typed or pasted, and
// Discover runtimes does not offer the Fake Runtime unless developer mode is on.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I12', 'Setup papercuts: a pasted repository path, no Fake Runtime outside developer mode');

// A second repository, made the way a person would before pasting its path.
const repo = join(process.env.ACCEPTANCE_SCRATCH ?? '/tmp', `pasted-${Date.now().toString(36)}`);
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);

await page.navigate('#/project'); await sleep(1500);
const field = await until(() => page.evaluate(`!!document.querySelector('input[aria-label="Repository path"]')`), { label: 'the path field', timeoutMs: 20_000 });
ev.check('Repositories offers a path field beside the folder picker', field === true);
await page.evaluate(`document.querySelector('input[aria-label="Repository path"]').focus()`);
await page.send('Input.insertText', { text: repo });
await sleep(200);
await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Add path').click()`);
const added = await until(async () => {
  const list = await c.api.get(`/v1/workspaces/${c.env.workspaceId}/repositories`);
  return (list.repositories ?? list).some((r) => (r.path ?? r.repository?.path) === repo);
}, { label: 'the pasted repository is added', timeoutMs: 20_000 }).catch(() => false);
ev.check('proof (API): the pasted path is now one of the project\'s repositories', added === true, repo);
await page.screenshot(ev.shot('pasted-path'));

await page.navigate('#/runtimes'); await sleep(1200);
await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Discover runtimes').click()`);
const modal = await until(() => page.evaluate(`document.querySelector('[role="dialog"]')?.innerText ?? ''`), { label: 'the discovery list', timeoutMs: 30_000 });
const settings = await c.api.get('/v1/settings').catch(() => null);
ev.check('with developer mode off, Discover runtimes does not offer the Fake Runtime', settings?.developerMode !== true && !/Fake Runtime/i.test(modal), modal.slice(0, 300));
await page.screenshot(ev.shot('discover-no-fake'));
c.close(); ev.save();
