// Shared by the P10 scenarios: the desk on Home, its cards and banners, and the
// status report in the artifact reader.
import { readState, writeState } from '../p0/lib/ctx.mjs';

export { readState, writeState };
export { resetStaffing, waitTask, interventionText } from '../p5/common.mjs';

export const WORKFLOW = 'P10 desk';

/** New mission from the window: the goal (carrying the scripted knobs), the Done-when lines, the P10 workflow. */
export async function createMission(c, goal, lines) {
  const { page, until, sleep } = c;
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await sleep(400);
  await page.fill('What outcome do you want?', goal);
  await page.fill('Done when', lines.join('\n'));
  await page.select('Repository', 'acceptance-project');
  await page.select('Workflow', WORKFLOW);
  await page.click('Plan mission …');
  return until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
}
export { cleanSlate, openBacklog, setLimit, addToBacklog, statusOf } from '../p7/common.mjs';

/** Home, freshly read. */
export async function openHome(c) {
  await c.page.navigate('#/');
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('section[aria-label="Desk"]'))`), { label: 'the desk', timeoutMs: 20_000 });
  await c.sleep(800);
}

/** One desk card's visible text on one line ("Needs you 1 Decisions and steps in your inbox"), or ''. */
export const deskCard = (c, label) => c.page.evaluate(`(document.querySelector('section[aria-label="Desk"] a[data-desk=${JSON.stringify(label)}]')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);

/** Waits until a card reads `prefix` (the numbers refresh as the daemon's facts change). */
export async function waitCard(c, label, prefix, timeoutMs = 30_000) {
  return c.until(async () => { const t = await deskCard(c, label); return t.startsWith(prefix) && t; }, { label: `card "${prefix}"`, timeoutMs, everyMs: 700 })
    .catch(async () => deskCard(c, label));
}

/** Clicks a desk card, as a person would. */
export async function clickCard(c, label) {
  const ok = await c.page.evaluate(`(() => { const a = document.querySelector('section[aria-label="Desk"] a[data-desk=${JSON.stringify(label)}]'); if (!a) return false; a.click(); return true; })()`);
  if (!ok) throw new Error(`no desk card "${label}"`);
  await c.sleep(1200);
}

/** Home's banners, one string each. */
export const bannerTexts = (c) => c.page.evaluate(`[...document.querySelectorAll('.banner')].filter((b) => b.offsetParent).map((b) => b.innerText.replace(/\\s+/g, ' ').trim())`);

/** Clicks "Status report" on Home and waits for the reader to open the new report; returns its artifact id. */
export async function writeReport(c) {
  await openHome(c);
  const before = await c.page.evaluate('location.hash');
  await c.page.click('Status report');
  const id = await c.until(async () => { const h = await c.page.evaluate('location.hash'); return h !== before && /#\/artifacts\/art_/.test(h) && h.split('/')[2]; }, { label: 'report opened', timeoutMs: 30_000 });
  await c.until(async () => (await readerText(c)).includes('How this report was made'), { label: 'report in the reader', timeoutMs: 20_000 });
  await c.sleep(600);
  return id;
}

/** The reader pane's visible text. */
export const readerText = (c) => c.page.evaluate(`document.querySelector('.reader__pane')?.innerText ?? ''`);
