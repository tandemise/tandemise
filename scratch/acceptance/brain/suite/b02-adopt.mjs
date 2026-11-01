// B2 — A second home links the same remote with "Use an existing brain": the preview lists the items; after
// Link, Team → Roles shows the same Developer model as home 1 (brain-model).
import { Evidence } from '../../p0/lib/evidence.mjs';
import { brainSectionText, clickIn, home2, openBrainSection, roleModelInWindow, typeInto } from '../common.mjs';

const c = await home2();
const ev = new Evidence('B2', 'A second home uses the existing brain and gets the same factory');
await openBrainSection(c);
await clickIn(c, 'section[aria-label="Brain"]', 'Use an existing brain');
await c.until(() => c.page.evaluate(`Boolean(document.querySelector('[aria-label="Use an existing brain"]'))`), { label: 'adopt form', timeoutMs: 10_000 });
await typeInto(c, 'Brain repository', 'github.com/acme/brain');
await c.sleep(300);
await clickIn(c, '[aria-label="Use an existing brain"]', 'Preview');
await c.until(() => c.page.evaluate(`Boolean(document.querySelector('[aria-label="Brain preview"]'))`), { label: 'brain preview', timeoutMs: 60_000 });
const rows = await c.page.evaluate(`[...document.querySelectorAll('[aria-label="Brain preview"] tbody tr')].map((r) => r.getAttribute('aria-label'))`);
ev.check('the preview lists the items, item by item', rows.length > 5, rows.slice(0, 12));
ev.check('the Developer is a Change (brain-model is new here)', rows.includes('Developer: Change'), rows.filter((r) => r.startsWith('Developer')));
await c.page.evaluate(`document.querySelector('[aria-label="Brain preview"]').scrollIntoView({ block: 'start' })`);
await c.sleep(300);
await c.page.screenshot(ev.shot('preview'));
await clickIn(c, '[aria-label="Brain preview"]', 'Link');
const text = await c.until(async () => { const t = await brainSectionText(c); return t.includes('Up to date') && t; }, { label: 'linked', timeoutMs: 60_000 });
ev.check('home 2 is linked to the same remote', text.includes('github.com/acme/brain') && text.includes('Up to date'), text.slice(0, 200));
await c.page.screenshot(ev.shot('linked'));
const model = await roleModelInWindow(c, 'Developer');
ev.check("Team → Roles → Developer shows home 1's model (brain-model)", model === 'brain-model', model);
await c.page.screenshot(ev.shot('team-roles'));
c.close(); ev.save();
