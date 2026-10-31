#!/usr/bin/env node
// WCAG 2.1 AA in the real desktop window: every screen and state, in the light and dark themes.
//
//   npm run build && node scratch/acceptance/a11y/run-all.mjs [--keep-painting] [--only=home,inbox] [--attach]
//                                                            [--no-keyboard] [--no-reflow] [--report-only]
//
// 1. Seeds a fresh install with the neutral demo data (scratch/docs-screenshots/seed.mjs: project "Taskly",
//    owner "Sam", four agents on a scripted runtime), with the daemon from this checkout and the window
//    from `electron-vite dev` over CDP.
// 2. Visits every screen and state below, in dark and in light, and on each runs (lib/audit.mjs):
//    axe-core's WCAG 2.0/2.1 A+AA rules, the landmark and heading structure (one main, one h1, no skipped
//    level), an accessible name on every control, and a scripted keyboard pass (skip link first, focus
//    visible on every stop, no trap; in a dialog, focus stays inside and Escape closes it). Once per
//    screen, in dark: reflow at 320 CSS px (1.4.10), at 640 (200% text, 1.4.4) and the 1.4.12 text spacing.
// 3. Then the first-run screen (a home with no project) and the daemon-down screen (a window whose daemon
//    cannot start), with the same probes.
//
// Any problem fails the run. The held step's terminal panel is covered by the hold suite (H12), which has the
// fake session runtime it needs. Evidence: docs/superpowers/evidence/2026-10-31-wcag/ (results.json, REPORT.md,
// focus and reflow screenshots).
//
//   --attach       use a window seed.mjs already started (DOCS_ROOT, A11Y_CDP_PORT); skips first-run and daemon-down
//   --report-only  write the report but exit 0 (for the "before" baseline)
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../p0/lib/cdp.mjs';
import { keepPainting } from '../p0/lib/frame-pump.mjs';
import { axe, iconNames, keyboard, press, reflow, structure, textSpacing, watchLiveRegions } from './lib/audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const ROOT = process.env.DOCS_ROOT ?? '/tmp/tdm-a11y';
const PORT = Number(process.env.A11Y_CDP_PORT ?? 9373);
const EVIDENCE = process.env.A11Y_EVIDENCE ?? join(repoRoot, 'docs/superpowers/evidence/2026-10-31-wcag');
const arg = (name) => process.argv.includes(`--${name}`);
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const attach = arg('attach');
const doKeyboard = !arg('no-keyboard');
const doReflow = !arg('no-reflow');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\n### ${m}`);
mkdirSync(join(EVIDENCE, 'shots'), { recursive: true });

// ------------------------------------------------------------------ the seeded window
if (!attach) {
  log('seed (fresh home, daemon from this checkout, electron-vite dev over CDP)');
  execFileSync(process.execPath, [join(repoRoot, 'scratch/docs-screenshots/seed.mjs')], {
    env: { ...process.env, DOCS_ROOT: ROOT, DOCS_CDP_PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
keepPainting([PORT]);
const S = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'));
const page = await connect(PORT, { timeoutMs: 90_000 });
await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
// The window may sit behind others on an idle display; the page must still behave as focused for Tab to move.
await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
// The display's pointer may rest over the window (xvfb puts it mid-screen): park it in an empty corner, so no hover
// state or hover tooltip colours a measurement or takes an Escape.
await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1279, y: 799 });

const theme = async (t) => {
  await page.evaluate(`localStorage.setItem('tandemise.theme', '${t}'); document.documentElement.setAttribute('data-theme', '${t}')`);
  await sleep(FADE_MS);
};
/** Waits until `expression` is true in the page (polled), or fails naming `label`. */
const waitFor = async (expression, label, timeoutMs = 30_000) => {
  for (const end = Date.now() + timeoutMs; ;) {
    if (await page.evaluate(`Boolean(${expression})`)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(150);
  }
};
/**
 * The screen at `hash` has loaded: its route is current, its page title (the one h1) is drawn, no skeleton is
 * left, and the DOM has been still for a moment (the queries behind it have answered).
 */
const settled = `(() => {
  const now = document.body.innerText.length;
  const still = window.__a11yLast === now;
  window.__a11yLast = now;
  return !!document.querySelector('main h1') && !document.querySelector('.skeleton') && still;
})()`;
const go = async (hash) => {
  await page.navigate(hash);
  await waitFor(`location.hash === ${JSON.stringify(hash)}`, `route ${hash}`);
  await page.evaluate('window.__a11yLast = -1');
  await waitFor(settled, `${hash} to load`);
  await waitFor(settled, `${hash} to settle`);
};
/** A dialog is open: in the DOM, then given its fade-in (axe measures colours as painted). */
const dialogShown = async (label) => {
  await waitFor(`document.querySelector('[role=dialog], [role=alertdialog]')`, label);
  await sleep(FADE_MS);
};
/** The enter animations (`--duration-slow` and less), the only fixed wait left. */
const FADE_MS = 300;
const escape = () => press(page, 'Escape');
const dialogOpen = () => page.evaluate(`!!document.querySelector('[role=dialog], [role=alertdialog]')`);
const clickSelector = async (selector) => {
  const ok = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
  if (!ok) throw new Error(`nothing matches ${selector}`);
};

/**
 * Every screen and state. `open` brings the window there from anywhere; `modal` states are judged as an
 * open dialog (focus stays inside, Escape closes it); `wait` is how long the screen takes to settle.
 */
const STATES = [
  { name: 'home', open: () => go('#/') },
  { name: 'board', open: () => go('#/board') },
  { name: 'board-intake', open: () => go('#/board/intake') },
  { name: 'missions', open: () => go('#/missions/in-progress') },
  { name: 'missions-backlog', open: () => go('#/missions/backlog') },
  { name: 'missions-routines', open: () => go('#/missions/routines') },
  { name: 'routine-dialog', modal: true, open: async () => { await go('#/missions/routines'); await page.click('New routine'); await dialogShown('the routine dialog'); } },
  { name: 'new-mission', open: () => go('#/missions/new') },
  { name: 'mission-feed', open: () => go(`#/missions/${S.a}/feed`) },
  { name: 'mission-plan', open: () => go(`#/missions/${S.a}/plan`) },
  { name: 'mission-timeline', open: () => go(`#/missions/${S.a}/timeline`) },
  { name: 'mission-artifacts', open: () => go(`#/missions/${S.a}/artifacts`) },
  { name: 'mission-checks', open: () => go(`#/missions/${S.a}/checks`) },
  { name: 'mission-metrics', open: () => go(`#/missions/${S.a}/metrics`) },
  { name: 'task-drawer', modal: true, open: async () => { await go(`#/missions/${S.a}/plan`); await clickSelector('.taskcard'); await dialogShown('the task drawer'); } },
  { name: 'mission-cancel-confirm', modal: true, open: async () => { await go(`#/missions/${S.a}/feed`); await page.click('Cancel'); await dialogShown('the cancel confirmation'); } },
  { name: 'mission-limit', open: () => go(`#/missions/${S.d}`) },
  { name: 'mission-limit-metrics', open: () => go(`#/missions/${S.d}/metrics`) },
  { name: 'mission-get-ready', open: () => go(`#/missions/${S.h}`) },
  { name: 'mission-stalled', open: () => go(`#/missions/${S.b}`) },
  { name: 'inbox', open: () => go('#/inbox') },
  { name: 'inbox-stalled', open: () => go('#/inbox/stalled') },
  { name: 'artifacts', open: () => go('#/artifacts') },
  { name: 'artifact-reader', open: async () => { await go('#/artifacts'); await clickSelector('main .list__row, main [data-artifact-row], main button.artifactrow'); await waitFor(`document.querySelector('main .reader__title') && !document.querySelector('main .skeleton')`, 'the artifact reader'); } },
  { name: 'repositories', open: () => go('#/project') },
  { name: 'team', open: () => go('#/team') },
  { name: 'team-staffing', open: () => go('#/team/staffing') },
  { name: 'team-roles', open: () => go('#/team/roles') },
  { name: 'skills', open: () => go('#/skills') },
  { name: 'evals', open: () => go('#/evals?tab=suites') },
  { name: 'evals-runs', open: () => go('#/evals?tab=runs') },
  { name: 'evals-yours', open: () => go('#/evals?tab=yours') },
  { name: 'runtimes', open: () => go('#/runtimes') },
  { name: 'integrations', open: () => go('#/integrations') },
  { name: 'brain', open: () => go('#/brain/sync') },
  { name: 'brain-lessons', open: () => go('#/brain/lessons') },
  { name: 'brain-proposals', open: () => go('#/brain/proposals') },
  { name: 'brain-factory', open: () => go('#/brain/factory') },
  { name: 'settings', open: () => go('#/settings') },
  { name: 'settings-intake', open: () => go('#/settings/intake') },
  { name: 'command-palette', modal: true, open: async () => {
    await go('#/');
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: ${process.platform === 'darwin'}, ctrlKey: ${process.platform !== 'darwin'}, bubbles: true }))`);
    await dialogShown('the command palette');
  } },
  // Narrowed to one match, its list no longer scrolls, so nothing but the field takes Tab: the trap must hold it.
  { name: 'command-palette-filtered', modal: true, open: async () => {
    await go('#/');
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: ${process.platform === 'darwin'}, ctrlKey: ${process.platform !== 'darwin'}, bubbles: true }))`);
    await dialogShown('the command palette');
    await page.fill('Jump to a mission, or type a command', 'Settings');
    await waitFor(`document.querySelectorAll('.palette__item').length === 1`, 'one match');
  } },
];

const results = [];
const record = (state, scheme, check, res) => {
  results.push({ state, scheme, check, ok: res.ok, count: res.problems.length, problems: res.problems });
  const mark = res.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${scheme.padEnd(5)} ${check.padEnd(10)} ${res.ok ? '' : `${res.problems.length} problem(s)`}`);
  if (!res.ok) for (const p of res.problems.slice(0, 6)) console.log(`         - ${typeof p === 'string' ? p : `${p.id}: ${p.help} (${p.nodes.length} node(s): ${p.nodes.slice(0, 3).map((n) => n.target).join(' | ')})`}`);
};
const fail = (state, scheme, check, error) => record(state, scheme, check, { ok: false, problems: [`could not run: ${error.message.split('\n')[0]}`] });

/** Every probe on whatever is on screen now. */
async function audit(state, scheme, { modal = false, deep = false, reopen } = {}) {
  record(state, scheme, 'axe', await axe(page));
  if (!modal) record(state, scheme, 'structure', await structure(page));
  record(state, scheme, 'names', await iconNames(page));
  if (doKeyboard) {
    const kb = await keyboard(page, { modal });
    record(state, scheme, 'keyboard', kb);
    if (modal) {
      // An open tooltip takes the first Escape (1.4.13: dismissable without moving focus); the dialog the next.
      const tooltip = await page.evaluate(`[...document.querySelectorAll('[role=tooltip]')].some((t) => t.checkVisibility())`);
      if (tooltip) {
        await escape();
        await waitFor(`![...document.querySelectorAll('[role=tooltip]')].some((t) => t.checkVisibility())`, 'the tooltip to close', 3000);
      }
      await escape();
      const closed = await waitFor(`!document.querySelector('[role=dialog], [role=alertdialog]')`, 'the dialog to close', 3000).then(() => true, () => false);
      const at = closed ? '' : await page.evaluate(`(() => { const a = document.activeElement; return (a?.tagName ?? '') + ' ' + (a?.getAttribute('aria-label') || a?.innerText || a?.type || '').slice(0, 40); })()`);
      record(state, scheme, 'escape', { ok: closed, problems: closed ? [] : [`Escape did not close the dialog (focus on ${at})`] });
      if (reopen) await reopen();
    }
  }
  if (deep && doReflow && !modal) {
    const name = `${state}-${scheme}`;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 256, deviceScaleFactor: 2, mobile: false });
    await waitFor('document.documentElement.clientWidth <= 320', 'the 320px layout');
    await sleep(FADE_MS);
    if (['home', 'mission-plan', 'inbox', 'settings', 'new-mission', 'missions'].includes(state)) await page.screenshot(join(EVIDENCE, 'shots', `reflow-320-${name}.png`));
    record(state, scheme, 'reflow-320', await reflow(page, { width: 320, height: 256 }));
    record(state, scheme, 'zoom-200', await reflow(page, { width: 640, height: 400 }));
    await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    await waitFor('document.documentElement.clientWidth > 1000', 'the desktop layout');
    record(state, scheme, 'spacing', await textSpacing(page));
  }
}

for (const state of STATES) {
  if (only && !only.includes(state.name)) continue;
  log(state.name);
  for (const scheme of ['dark', 'light']) {
    try {
      await theme(scheme);
      if (await dialogOpen()) { await escape(); await waitFor(`!document.querySelector('[role=dialog]')`, 'no dialog'); }
      await state.open();
      await page.evaluate('window.scrollTo(0, 0)');
      await audit(state.name, scheme, { modal: state.modal, deep: scheme === 'dark' });
      if (state.modal && (await dialogOpen())) { await escape(); await waitFor(`!document.querySelector('[role=dialog]')`, 'no dialog'); }
    } catch (error) {
      fail(state.name, scheme, 'open', error);
    }
  }
}

// ------------------------------------------------------------- focus screenshots and the live regions
if (!only || only.includes('focus')) {
  log('focus and live regions');
  await theme('dark');
  await go('#/');
  await page.evaluate(`(() => { const a = document.createElement('span'); a.tabIndex = -1; document.body.prepend(a); a.focus(); a.remove(); })()`);
  await press(page, 'Tab');
  await sleep(FADE_MS);
  await page.screenshot(join(EVIDENCE, 'shots', 'focus-skip-link-dark.png'));
  for (let i = 0; i < 3; i++) await press(page, 'Tab');
  await sleep(FADE_MS);
  await page.screenshot(join(EVIDENCE, 'shots', 'focus-nav-dark.png'));
  await theme('light');
  await sleep(FADE_MS);
  await page.screenshot(join(EVIDENCE, 'shots', 'focus-nav-light.png'));
  await go(`#/missions/${S.a}/plan`);
  await clickSelector('.taskcard');
  await dialogShown('the task drawer');
  // Two stops into the drawer: a focus ring over its light surface.
  await press(page, 'Tab');
  await press(page, 'Tab');
  await sleep(FADE_MS);
  await page.screenshot(join(EVIDENCE, 'shots', 'focus-drawer-light.png'));
  await escape();
  await theme('dark');
  // 4.1.3: a screen with live agent work must not announce every "Now" update; 20 s of a running mission.
  await go(`#/missions/${S.c}/feed`);
  const announced = await watchLiveRegions(page, 20_000);
  const ok = announced.length <= 4;
  record('live-regions', 'dark', 'status', { ok, problems: ok ? [] : [`${announced.length} live-region updates in 20s on a running mission: ${announced.slice(0, 5).join(' | ')}`] });
}
page.close();

// ------------------------------------------------------------- first run and daemon down (own windows)
async function separateWindow(name, { withDaemon }) {
  log(name);
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const port = PORT + (withDaemon ? 1 : 2);
  let daemon = null;
  const env = { ...process.env, TANDEMISE_HOME: join(dir, 'home') };
  if (withDaemon) {
    daemon = spawn(process.execPath, [join(repoRoot, 'apps/daemon/dist/main.js')], { env: { ...env, TANDEMISE_OWNER_NAME: 'Sam' }, stdio: 'ignore', detached: true });
    daemon.unref();
    for (const end = Date.now() + 20_000; !existsSync(join(dir, 'home', 'daemon.json')); ) { if (Date.now() > end) throw new Error('daemon did not start'); await sleep(200); }
  } else {
    env.TANDEMISE_DAEMON_ENTRY = join(dir, 'no-daemon', 'main.js');
  }
  const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(repoRoot, 'apps/desktop'), env, stdio: 'ignore', detached: true,
  });
  desktop.unref();
  keepPainting([port]);
  try {
    const p = await connect(port, { timeoutMs: 120_000 });
    await p.waitForText(withDaemon ? 'project' : 'daemon is not running', { timeoutMs: 120_000 });
    await p.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    for (const end = Date.now() + 30_000; !(await p.evaluate(`!!document.querySelector('main h1')`)); ) { if (Date.now() > end) throw new Error('the screen did not draw'); await sleep(150); }
    const saved = page;
    for (const scheme of ['dark', 'light']) {
      await p.evaluate(`localStorage.setItem('tandemise.theme', '${scheme}'); document.documentElement.setAttribute('data-theme', '${scheme}')`);
      await sleep(FADE_MS);
      record(name, scheme, 'axe', await axe(p));
      // A screen of its own, before there is anything to navigate to: a main and an h1, no nav.
      record(name, scheme, 'structure', await structure(p, { nav: false }));
      record(name, scheme, 'names', await iconNames(p));
      if (doKeyboard) record(name, scheme, 'keyboard', await keyboard(p, { expectSkip: false }));
      if (scheme === 'dark' && doReflow) {
        await p.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 256, deviceScaleFactor: 2, mobile: false });
        for (const end = Date.now() + 10_000; !(await p.evaluate('document.documentElement.clientWidth <= 320')) && Date.now() < end; ) await sleep(100);
        await sleep(FADE_MS);
        await p.screenshot(join(EVIDENCE, 'shots', `reflow-320-${name}-dark.png`));
        record(name, scheme, 'reflow-320', await reflow(p, { width: 320, height: 256 }));
        record(name, scheme, 'zoom-200', await reflow(p, { width: 640, height: 400 }));
        await p.send('Emulation.setDeviceMetricsOverride', DESKTOP);
        record(name, scheme, 'spacing', await textSpacing(p));
      }
    }
    void saved;
    p.close();
  } catch (error) {
    fail(name, 'dark', 'open', error);
  } finally {
    try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
    if (daemon) try { process.kill(daemon.pid, 'SIGTERM'); } catch { /* gone */ }
  }
}

if (!attach) {
  execFileSync(process.execPath, [join(repoRoot, 'scratch/docs-screenshots/stop.mjs')], { env: { ...process.env, DOCS_ROOT: ROOT }, stdio: 'inherit' });
  if (!only || only.includes('first-run')) await separateWindow('first-run', { withDaemon: true });
  if (!only || only.includes('daemon-down')) await separateWindow('daemon-down', { withDaemon: false });
}

// ------------------------------------------------------------------ report
const byState = new Map();
for (const r of results) {
  const row = byState.get(r.state) ?? { state: r.state, axe: { dark: 0, light: 0 }, other: 0, failures: [] };
  if (r.check === 'axe') row.axe[r.scheme] = r.problems.reduce((n, v) => n + (v.nodes?.length ?? 1), 0);
  else row.other += r.count;
  if (!r.ok) row.failures.push(`${r.scheme} ${r.check}`);
  byState.set(r.state, row);
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(EVIDENCE, process.env.A11Y_RESULTS_NAME ?? 'results.json'), JSON.stringify(results, null, 2));
const lines = [
  '# Accessibility run (WCAG 2.1 AA, real window)',
  '',
  `${new Date().toISOString()} · ${results.length} checks · ${failed.length} failing`,
  '',
  '| Screen / state | axe nodes (dark) | axe nodes (light) | other problems | failing checks |',
  '|---|---|---|---|---|',
  ...[...byState.values()].map((r) => `| ${r.state} | ${r.axe.dark} | ${r.axe.light} | ${r.other} | ${r.failures.join(', ') || '—'} |`),
  '',
];
writeFileSync(join(EVIDENCE, process.env.A11Y_REPORT_NAME ?? 'REPORT.md'), lines.join('\n'));
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} checks pass. Report: ${join(EVIDENCE, 'REPORT.md')}`);
process.exit(failed.length === 0 || arg('report-only') ? 0 : 1);
