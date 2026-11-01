// Shared by the brain (#51) scenarios: both homes' windows, the bare remote, the fake gh's log.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH, context, readState, writeState } from '../p0/lib/ctx.mjs';
import { client, loadEnv, sleep, until } from '../p0/lib/api.mjs';
import { connect } from '../p0/lib/cdp.mjs';

export { readState, writeState, sleep, until };

export const ACC = JSON.parse(readFileSync(`${SCRATCH}/brain-acceptance.json`, 'utf8'));
export const REMOTE = join(ACC.remotes, 'acme', 'brain.git');
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: ACC.gitconfig } });
export const ghLog = () => (existsSync(ACC.log) ? readFileSync(ACC.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const remoteLog = () => git(REMOTE, 'log', '-p', '--all');

/** Home 1's window (the run's main context). */
export async function home1() {
  const c = await context();
  await size(c);
  return c;
}

/** Home 2's window: the same helpers on the second installation. */
export async function home2() {
  const env = loadEnv(ACC.link2);
  const api = client(env);
  const page = await connect(ACC.port2, { timeoutMs: 90_000 });
  await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
  const c = { env, api, page, until, sleep, close: () => page.close?.() };
  await size(c);
  return c;
}

async function size(c) {
  await c.page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
}

/** Project → the Brain section, scrolled into view; returns its text. */
export async function openBrainSection(c) {
  await c.page.navigate('#/project');
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('section[aria-label="Brain"]'))`), { label: 'Brain section', timeoutMs: 30_000 });
  await c.page.evaluate(`document.querySelector('section[aria-label="Brain"]').scrollIntoView({ block: 'start' })`);
  await sleep(400);
  return brainSectionText(c);
}

export const brainSectionText = (c) => c.page.evaluate(`document.querySelector('section[aria-label="Brain"]')?.innerText ?? ''`);

/** Clicks a visible, enabled button inside `selector` whose text starts with `label`. */
export async function clickIn(c, selector, label) {
  const ok = await c.page.evaluate(`(() => {
    const s = document.querySelector(${JSON.stringify(selector)});
    const b = s && [...s.querySelectorAll('button,a')].find((x) => x.offsetParent && !x.disabled && x.innerText.trim().startsWith(${JSON.stringify(label)}));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  })()`);
  if (!ok) throw new Error(`no enabled "${label}" in ${selector}`);
}

/** Types into an input by aria-label, the way React sees it. */
export async function typeInto(c, ariaLabel, value) {
  const ok = await c.page.evaluate(`(() => {
    const el = document.querySelector('[aria-label=${JSON.stringify(ariaLabel)}]');
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`no field "${ariaLabel}"`);
}

/** Team → Roles → <role>: the value of its "Model" field. */
export async function roleModelInWindow(c, roleName) {
  const { page } = c;
  await page.navigate('#/team/roles');
  await c.until(() => page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].some((r) => r.querySelector('.list__title')?.innerText.trim() === ${JSON.stringify(roleName)})`), { label: 'roles list', timeoutMs: 20_000 });
  await page.evaluate(`[...document.querySelectorAll('.reader__list .list__row')].find((r) => r.querySelector('.list__title')?.innerText.trim() === ${JSON.stringify(roleName)}).click()`);
  await c.until(() => page.evaluate(`Boolean(document.querySelector('section[aria-label="Models"]'))`), { label: 'Models section', timeoutMs: 10_000 });
  await sleep(600);
  return page.evaluate(`[...document.querySelectorAll('section[aria-label="Models"] input')].find((i) => i.getAttribute('aria-label') === 'Model')?.value ?? null`);
}

/** A person's own clone of the brain: edit, commit, push. */
export function editBrainByHand(edits, message = 'chore: edit by hand') {
  const dir = mkdtempSync(join(tmpdir(), 'tdm-brain-hand-'));
  git(tmpdir(), 'clone', '-q', REMOTE, dir);
  for (const [path, fn] of Object.entries(edits)) {
    const file = join(dir, path);
    writeFileSync(file, typeof fn === 'function' ? fn(existsSync(file) ? readFileSync(file, 'utf8') : null) : fn);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}

/** A mission on the "Build only" workflow, through the window, approved and run to the end. */
export async function runBuildMission(c, goal) {
  const id = await c.createMission(goal, { workflow: 'Build only' });
  const title = (await c.api.get(`/v1/missions/${id}`)).mission.title;
  await c.approvePlan(id, title);
  const status = await c.until(async () => { const s = (await c.api.get(`/v1/missions/${id}`)).mission.status; return ['COMPLETE', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(s) && s; }, { label: 'mission settles', timeoutMs: 180_000, everyMs: 1000 });
  const tasks = await c.api.get(`/v1/missions/${id}/tasks`);
  return { id, title, status, task: tasks.find((t) => t.key === 'build') ?? tasks[0] };
}

/** The Brain screen's Lessons list, row by row: text and counters. */
export const lessonRows = (c) => c.page.evaluate(`[...document.querySelectorAll('[aria-label="Lesson list"] .brain__row')].map((r) => ({ text: r.querySelector('.brain__text')?.innerText ?? '', counters: r.querySelector('[aria-label="Counters"]')?.innerText ?? '', state: r.dataset.state }))`);

export async function openBrainTab(c, tab) {
  await c.page.navigate(`#/brain/${tab}`);
  await c.until(() => c.page.evaluate(`Boolean(document.querySelector('[role=tablist]')) && [...document.querySelectorAll('[role=tab]')].some((t) => t.getAttribute('aria-selected') === 'true' && t.innerText.trim().toLowerCase() === ${JSON.stringify(tab)})`), { label: `Brain ${tab} tab`, timeoutMs: 20_000 });
  await sleep(800);
}
