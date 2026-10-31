// H12 — The terminal panel is accessible (WCAG 2.1 AA): axe finds nothing, the terminal is a named region,
// screen reader mode puts xterm's output in the accessibility tree, F6 takes focus out of the terminal and back
// (2.1.2, no keyboard trap: the terminal keeps Tab and Escape for the program), Tab stays in the panel, and
// Escape outside the terminal closes the panel. Runs after H1, on its open panel, and leaves it open for H2.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { axe, iconNames, press } from '../../a11y/lib/audit.mjs';
import { cardHold, openFeed, paint, panelButton, panelLabel, readState, screenText, shoot, stepOf, typeLine, waitScreen } from '../common.mjs';

const c = await context();
const { page, sleep } = c;
const ev = new Evidence('H12', 'The terminal panel works with a keyboard and a screen reader');
const { main: missionId } = readState();
const step = await stepOf(c, missionId);
ev.check('the panel is open on the held step', (await panelLabel(c)) === `Terminal: ${step.title}`, await panelLabel(c));

const focused = () => page.evaluate(`(() => { const a = document.activeElement; return { terminal: !!a?.closest('.xterm'), inPanel: !!a?.closest('.terminal-panel'), name: (a?.innerText || a?.getAttribute('aria-label') || a?.tagName || '').trim() }; })()`);

for (const scheme of ['dark', 'light']) {
  await page.evaluate(`localStorage.setItem('tandemise.theme', '${scheme}'); document.documentElement.setAttribute('data-theme', '${scheme}')`);
  await paint(c); await sleep(600); await paint(c);
  const found = await axe(page, { context: `document.querySelector('.terminal-panel')` });
  ev.check(`${scheme}: axe (WCAG 2.0/2.1 A+AA) finds nothing in the panel`, found.ok, found.problems.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} (${n.summary.slice(0, 160)})`).join(' | ')}`));
}
const names = await iconNames(page);
ev.check('every control has an accessible name', names.ok, names.problems);
const region = await page.evaluate(`(() => { const r = document.querySelector('.terminal-panel__xterm'); return { role: r?.getAttribute('role'), label: r?.getAttribute('aria-label'), keys: document.getElementById(r?.getAttribute('aria-describedby') ?? '')?.innerText ?? '' }; })()`);
ev.check('the terminal is a named region, described by how to leave it', region.role === 'group' && region.label === `Terminal for ${step.title}` && region.keys.includes('F6'), region);

// Screen reader mode, as a person turns it on: the button reports its state and xterm builds its accessibility tree.
await panelButton(c, 'Screen reader mode');
await sleep(500);
const reader = await page.evaluate(`({ pressed: [...document.querySelectorAll('.terminal-panel button')].find((b) => b.innerText.trim() === 'Screen reader mode')?.getAttribute('aria-pressed'), tree: !!document.querySelector('.terminal-panel .xterm-accessibility') })`);
ev.check('Screen reader mode is a toggle that turns on xterm\'s accessibility tree', reader.pressed === 'true' && reader.tree, reader);
await panelButton(c, 'Screen reader mode');

// Into the terminal, then out with F6: Tab and Escape in the terminal belong to the program.
await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
await press(page, 'Tab');
await sleep(200);
ev.check('Tab in the terminal stays in the terminal (the program gets it)', (await focused()).terminal, await focused());
await press(page, 'F6');
await sleep(200);
const out = await focused();
ev.check('F6 moves focus out of the terminal to the panel\'s buttons', !out.terminal && out.inPanel, out);
const visible = await page.evaluate(`getComputedStyle(document.activeElement).outlineStyle !== 'none'`);
ev.check('and that button shows its focus ring', visible);
await shoot(c, ev, 'focus-out-of-terminal');
let stayed = true;
for (let i = 0; i < 12; i++) { await press(page, 'Tab'); await sleep(60); if (!(await focused()).inPanel) stayed = false; }
ev.check('Tab cycles inside the panel (it is a modal dialog)', stayed);
// The cycle includes the terminal itself; start the way back from one of the buttons.
if ((await focused()).terminal) { await press(page, 'F6'); await sleep(150); }
await press(page, 'F6');
await sleep(200);
ev.check('F6 again goes back into the terminal', (await focused()).terminal, await focused());

// The Tabs that reached the program are on its input line: end that line, so H2 types onto a clean one.
await typeLine(c, '');

// Escape in the terminal is the program's (Claude Code interrupts with it): the panel stays, focus stays, and the
// program gets the byte. The PTY echoes ESC as "^[", and the fake echoes the line it read.
await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
await press(page, 'Escape');
await sleep(300);
ev.check('Escape in the terminal leaves the panel open', (await panelLabel(c)) === `Terminal: ${step.title}`, await panelLabel(c));
ev.check('and focus in the terminal', (await focused()).terminal, await focused());
await typeLine(c, 'escprobe');
const echoed = await waitScreen(c, 'escprobe').catch(() => screenText(c));
ev.check('the program received the Escape (its line reads "^[escprobe")', echoed.includes('^[escprobe'), echoed.split('\n').filter((l) => l.includes('escprobe')));

// F6 while Continue is in flight: Continue and Release are disabled, so F6 goes to the next control outside the
// terminal; with every control disabled it goes to the panel itself. Never stuck in the terminal (2.1.2).
// The continue request is held at the network layer and failed afterwards, so the hold is untouched.
await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/continue*', requestStage: 'Request' }] });
const paused = new Promise((resolve) => { page.onEvent = (msg) => { if (msg.method === 'Fetch.requestPaused') resolve(msg.params.requestId); }; });
await panelButton(c, 'Continue');
const requestId = await Promise.race([paused, sleep(10_000).then(() => null)]);
const pending = await page.evaluate(`[...document.querySelectorAll('.terminal-panel__actions button')].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }))`);
ev.check('Continue is pending: Continue and Release are disabled', requestId !== null && pending.filter((b) => b.disabled).length >= 2, pending);
await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
await press(page, 'F6');
await sleep(200);
const pendingOut = await page.evaluate(`(() => { const a = document.activeElement; return { terminal: !!a.closest('.xterm'), disabled: !!a.disabled, name: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40) }; })()`);
ev.check('F6 leaves the terminal for an enabled control while Continue is pending', !pendingOut.terminal && !pendingOut.disabled, pendingOut);
await page.evaluate(`document.querySelectorAll('.terminal-panel button').forEach((b) => { b.dataset.h12 = String(b.disabled); b.disabled = true; })`);
await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
await press(page, 'F6');
await sleep(200);
const noneOut = await page.evaluate(`(() => { const a = document.activeElement; return { terminal: !!a.closest('.xterm'), panel: a.classList.contains('terminal-panel') }; })()`);
ev.check('with every control disabled, F6 moves focus to the panel itself', !noneOut.terminal && noneOut.panel, noneOut);
await page.evaluate(`document.querySelectorAll('.terminal-panel button').forEach((b) => { b.disabled = b.dataset.h12 === 'true'; delete b.dataset.h12; })`);
if (requestId) await page.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
await page.send('Fetch.disable');
await sleep(500);

// Escape outside the terminal closes the panel; the hold and its session keep running. The focused button's
// tooltip is showing, and the first Escape dismisses it (1.4.13); the next closes the panel.
// From the terminal (the step above left focus on the panel itself), F6 goes out to a button.
await page.evaluate(`document.querySelector('.terminal-panel .xterm-helper-textarea')?.focus()`);
await press(page, 'F6');
await sleep(150);
await press(page, 'Escape');
await sleep(300);
if ((await panelLabel(c)) !== '') { await press(page, 'Escape'); await sleep(500); }
ev.check('Escape on the panel\'s buttons closes the panel (after dismissing the button\'s tooltip)', (await panelLabel(c)) === '', await panelLabel(c));
const held = await stepOf(c, missionId);
ev.check('proof (API): the step is still HELD after closing', held.status === 'HELD', held.status);

// Leave it as H2 expects: open again from the card.
await openFeed(c, missionId);
const again = await cardHold(c, 'design');
ev.check('its card offers Open terminal', again?.text === 'Open terminal', again);
await page.evaluate(`[...document.querySelector('[data-feed-card="design"]').querySelectorAll('button')].find((x) => x.innerText.trim() === 'Open terminal').click()`);
await c.until(async () => (await panelLabel(c)) !== '', { label: 'the terminal panel again', timeoutMs: 20_000 });
await page.evaluate(`localStorage.setItem('tandemise.theme', 'system'); document.documentElement.removeAttribute('data-theme')`);
c.close(); ev.save();
