// B1 — Project settings → Brain → Create a brain (acme/brain). The window says "Up to date"; the bare
// repository behind github.com/acme/brain has brain.yaml, factory/roles/development.md and memory/rules/project.md.
import { Evidence } from '../../p0/lib/evidence.mjs';
import { REMOTE, brainSectionText, clickIn, ghLog, git, home1, openBrainSection, typeInto, writeState } from '../common.mjs';

const c = await home1();
const ev = new Evidence('B1', 'Create a brain from Project settings');
// A Developer model to carry to home 2 (B2) and to edit by hand (B3).
const dev = (await c.api.get(`/v1/roles?workspaceId=${c.env.workspaceId}`)).find((r) => r.id === 'development');
await c.api.put('/v1/roles/development', { ...dev, workspaceId: c.env.workspaceId, models: { model: 'brain-model', escalate: [], economyModel: null } });
ev.note('home 1 Developer model set to brain-model through the API, so B2 has something to carry');

const before = await openBrainSection(c);
ev.check('the Brain section offers the three ways in', ['Create a brain', 'Use an existing brain', 'Keep it on this machine'].every((t) => before.includes(t)), before.slice(0, 300));
await c.page.screenshot(ev.shot('unlinked'));
await clickIn(c, 'section[aria-label="Brain"]', 'Create a brain');
await c.until(() => c.page.evaluate(`Boolean(document.querySelector('[aria-label="Create a brain"]'))`), { label: 'create form', timeoutMs: 10_000 });
await typeInto(c, 'GitHub owner', 'acme');
await typeInto(c, 'Repository name', 'brain');
await c.sleep(300);
await clickIn(c, '[aria-label="Create a brain"]', 'Create');
const text = await c.until(async () => { const t = await brainSectionText(c); return t.includes('Up to date') && t; }, { label: 'Up to date', timeoutMs: 60_000 });
ev.check('the window says Up to date', text.includes('Up to date (last synced'), text.slice(0, 300));
ev.check('and names the remote', text.includes('github.com/acme/brain'));
await c.page.screenshot(ev.shot('linked'));

ev.check('the fake gh created a private repository', ghLog().some((l) => l.argv.join(' ') === 'repo create acme/brain --private'));
const tree = git(REMOTE, 'ls-tree', '-r', '--name-only', 'main').split('\n');
ev.check('the bare repo has brain.yaml, factory/roles/development.md and memory/rules/project.md', ['brain.yaml', 'factory/roles/development.md', 'memory/rules/project.md'].every((f) => tree.includes(f)), tree.filter(Boolean).slice(0, 20));
ev.check('the Developer in the brain says brain-model', git(REMOTE, 'show', 'main:factory/roles/development.md').includes('model: brain-model'));
const view = await c.api.get(`/v1/workspaces/${c.env.workspaceId}/brain`);
ev.check('proof (API): linked, up to date', view.linked && view.status === 'up_to_date', view.statusLine);
writeState({ b1: { writerId: view.writerId } });
c.close(); ev.save();
