// N6 (#131) — A step runs the team's own skill instead of its role's prompt. A Claude Code profile runs
// scratch/fixtures/stub-claude.mjs (it records the argv and prompt it got, and reports the skills a real Claude
// Code would load from them) under a fixture config folder where a plugin "team" is installed. The scripted
// runtime is switched off for the scenario, so the steps route to it.
//   - "P13 missing team skill" asks for team:fix-bug, which the plugin lacks: the step card says "Runs
//     /team:fix-bug", the step stops before any run with the reason, and the Inbox asks.
//   - "P13 team skill" runs team:build-feature: the run's prompt starts with the slash command, the plugin is
//     loaded with --plugin-dir, the gate holds and the mission completes; the drawer says which skill ran.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, closeDrawer, settle } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const c = await context();
const { page, until, sleep, api, env } = c;
const ev = new Evidence('N6', "A step runs the team's own skill; a skill the worker lacks stops the step loudly (#131)");

// The team's plugin, installed the way Claude Code records an install, in the profile's own config folder.
const config = `${SCRATCH}/n6-claude-config`;
const plugin = `${config}/plugins/cache/team-market/team/2.4.0`;
put(`${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'team', version: '2.4.0' }));
put(`${plugin}/skills/build-feature/SKILL.md`, '---\nname: build-feature\ndescription: Build a feature the team way.\n---\nPlan, test first, implement.\n');
put(`${plugin}/skills/review-pr/SKILL.md`, '---\nname: review-pr\ndescription: Review a pull request.\n---\nReview.\n');
put(`${config}/plugins/installed_plugins.json`, JSON.stringify({ version: 2, plugins: { 'team@team-market': [{ scope: 'user', installPath: plugin, version: '2.4.0' }] } }));
const claude = `${SCRATCH}/n6-claude`;
writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${resolve(here, '../../../fixtures/stub-claude.mjs')}" "$@"\n`);
chmodSync(claude, 0o755);
const records = () => (existsSync(`${config}/records`) ? readdirSync(`${config}/records`).sort() : []).map((f) => JSON.parse(readFileSync(`${config}/records/${f}`, 'utf8')));

// Setup shortcut: the Claude Code profile on the stub, and the scripted one off for this scenario.
const created = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code (stub)', workspaceId: null, executablePath: claude, settings: { configDir: config }, maxConcurrent: 2, enabled: true });
const claudeId = created.profile?.id ?? created.id;
await api.patch(`/v1/runtimes/${env.scriptedProfileId}`, { enabled: false });

try {
  const run = Date.now().toString(36);
  // ---------------------------------------------------------------- the skill the plugin lacks
  const missingGoal = `N6 missing ${run}`;
  const missingId = await c.createMission(missingGoal, { workflow: 'P13 missing team skill' });
  await c.approvePlan(missingId, (await api.get(`/v1/missions/${missingId}`)).mission.title);
  await until(async () => (await c.task(missingId, 'implement'))?.status === 'BLOCKED', { label: 'implement blocked', timeoutMs: 60_000 });
  const blocked = await c.task(missingId, 'implement');
  ev.check('the step is BLOCKED with the reason: the plugin has no fix-bug, and what it has', /team 2\.4\.0 is installed but has no skill fix-bug; it has build-feature, review-pr/.test(blocked.statusReason ?? ''), blocked.statusReason);
  ev.check('proof (API): no run was started and no attempt spent', blocked.runCount === 0 && blocked.attempts === 0 && records().every((r) => !r.prompt.includes(missingGoal)), { runCount: blocked.runCount, attempts: blocked.attempts });
  await page.navigate(`#/missions/${missingId}/plan`);
  await until(() => page.evaluate(`Boolean(document.querySelector('[aria-label="Runs skill"]'))`), { label: 'step card skill line', timeoutMs: 15_000 });
  const cardLine = await page.evaluate(`document.querySelector('[aria-label="Runs skill"]').innerText`);
  ev.check('the step card says "Runs /team:fix-bug"', cardLine.trim() === 'Runs /team:fix-bug', cardLine);
  await page.screenshot(ev.shot('blocked-step-card'));

  await c.ui.inbox('Everyone');
  const inbox = await until(async () => { const t = await page.text('main'); return t.includes('needs a skill that isn’t installed') && t; }, { label: 'inbox card', timeoutMs: 20_000 });
  ev.check('Inbox: "‘Implement’ needs a skill that isn’t installed"', inbox.includes('‘Implement’ needs a skill that isn’t installed'), inbox.slice(0, 600));
  await c.ui.openItem('‘Implement’ needs a skill that isn’t installed');
  const card = await page.text('main');
  ev.check('the card names /team:fix-bug, the reason, Retry and Leave blocked', card.includes('/team:fix-bug') && card.includes('has no skill fix-bug') && card.includes('Retry') && card.includes('Leave blocked'), card.slice(0, 1500));
  await page.screenshot(ev.shot('inbox-card'));

  // ---------------------------------------------------------------- the skill the plugin has
  const goal = `N6 run ${run}`;
  const id = await c.createMission(goal, { workflow: 'P13 team skill' });
  await c.approvePlan(id, (await api.get(`/v1/missions/${id}`)).mission.title);
  const status = await settle(c, id);
  ev.check('the mission completes', status === 'COMPLETE', { status, task: (await c.task(id, 'implement'))?.statusReason });
  const rec = records().find((r) => r.prompt.includes(goal));
  ev.check('proof (stub record): the prompt starts with "/team:build-feature <mission title>"', rec?.prompt.startsWith(`/team:build-feature ${goal}`), rec?.prompt.slice(0, 160));
  ev.check('proof (stub record): only that plugin was loaded, the person\'s settings kept out', rec?.argv.join(' ').includes(`--plugin-dir ${plugin}`) && rec.argv.join(' ').includes('--setting-sources project,local'), rec?.argv);
  ev.check("proof (stub record): the skill's note replaced the Developer's instructions; the ChangeSet is still asked for",
    rec?.prompt.includes("This step runs the team's own skill /team:build-feature") && !rec.prompt.includes('You are the Developer for this mission') && /### ChangeSet → /.test(rec.prompt), rec?.prompt.slice(0, 900));
  await c.openTaskDrawer(id, 'Implement');
  const drawer = await page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.querySelector('[aria-label="Runs the skill"]')?.innerText ?? ''`);
  ev.check('the drawer: "Runs the skill /team:build-feature … instead of the role\'s instructions"', drawer.startsWith('Runs the skill /team:build-feature') && drawer.includes("instead of the role's instructions"), drawer);
  await sleep(300);
  await page.screenshot(ev.shot('drawer'));
  await closeDrawer(c);
  const log = JSON.stringify(c.sql('SELECT body FROM run_events WHERE mission_id = ? ORDER BY sequence', id));
  ev.check('proof (SQL): the log names the skill and the plugin it came from', log.includes('Runs the skill /team:build-feature') && log.includes('plugin team 2.4.0 at'), log.slice(0, 400));
} finally {
  await api.patch(`/v1/runtimes/${env.scriptedProfileId}`, { enabled: true });
  await api.patch(`/v1/runtimes/${claudeId}`, { enabled: false });
}

c.close(); ev.save();
