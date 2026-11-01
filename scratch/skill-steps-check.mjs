// #131: a step runs one of the team's own Claude Code skills instead of its role's prompt.
//
//   npm run build && node scratch/skill-steps-check.mjs
//
// Pure rules first (names, arguments, the workflow field, planner.yaml's
// stepSkills, the Claude Code argv and the init check), then where a skill is
// found for a profile, then a real daemon (startDaemon, in process) whose
// Claude Code profile runs scratch/fixtures/stub-claude.mjs: a stand-in that
// records the argv and prompt it got and reports a `system/init` record built
// from the `--plugin-dir` it was given. The profile's config folder is a
// fixture with a plugin installed the way Claude Code records one; nothing
// reads the real home.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const D = await import('@tandemise/domain');
const C = await import('@tandemise/runtime-claude');
const A = await import('@tandemise/application');

section('pure: names and arguments');
{
  check('plugin:skill and a plain name are skill names', D.stepSkillProblem('team:build-feature') === null && D.stepSkillProblem('tdd') === null);
  check('two colons, a space or an empty part are not', ['a:b:c', 'two words', ':x', 'x:'].every((n) => D.stepSkillProblem(n) !== null));
  check('split', eq(D.splitStepSkill('team:fix-bug'), { plugin: 'team', skill: 'fix-bug' }) && eq(D.splitStepSkill('tdd'), { plugin: null, skill: 'tdd' }));
  const args = D.stepSkillArgs('{{item.key}} {{ item.url }} -- {{mission.title}} {{other.thing}}', { item: { key: 'KEY-12', url: 'https://t/KEY-12', title: 'T' }, missionTitle: 'Fix it' });
  check('args: the item, the mission, anything else left as written', args === 'KEY-12 https://t/KEY-12 -- Fix it {{other.thing}}', args);
  check('args without an item: empty, and spaces collapsed', D.stepSkillArgs('{{item.key}}  for {{mission.title}}', { item: null, missionTitle: 'M' }) === 'for M');
  const words = D.stepSkillInstructions({ name: 'team:build-feature', args: '' });
  check('the instructions name the skill and what Tandemise owns', words.includes('/team:build-feature') && /pull request/.test(words) && /tracker item/.test(words), words);
}

section('pure: a workflow step and planner.yaml');
{
  const wf = D.parseWorkflowDefinition({ name: 'W', steps: [
    { key: 'implement', role: 'development', objective: 'Build.', outputs: ['ChangeSet'], runSkill: { name: 'team:build-feature', args: '{{item.key}}' } },
    { key: 'review', role: 'review', objective: 'Review.', dependsOn: ['implement'] },
  ] });
  check('a workflow step parses runSkill', wf.ok, wf.error);
  const plan = D.compileWorkflow(wf.value, {});
  check('and the planned task carries it, args untouched until the run', eq(plan.value?.tasks[0].runSkill, { name: 'team:build-feature', args: '{{item.key}}' }) && plan.value?.tasks[1].runSkill === undefined, plan.value?.tasks);
  check('a bad skill name is refused', !D.parseWorkflowDefinition({ name: 'W', steps: [{ key: 'a', role: 'development', objective: 'A.', runSkill: { name: 'two words' } }] }).ok);
  const parsed = D.parsePlannerConfig({ stepSkills: [
    { class: 'implement', when: 'profile.type == "fix"', skill: 'team:fix-bug', args: '{{item.key}}' },
    { class: 'implement', skill: 'team:build-feature' },
    { class: 'review', skill: 'team:review-pr' },
    { class: 'review', when: 'profile.nonsense ==', skill: 'team:never' },
  ] });
  check('planner.yaml: stepSkills parse; a rule whose when cannot be read is dropped and said', parsed.config.stepSkills.length === 3 && parsed.problems.some((p) => p.path === 'stepSkills.3.when'), parsed);
  const tasks = (keys) => ({ summary: 's', tasks: keys.map(([key, roleId, executor]) => ({ key, title: key, objective: key, roleId, executor: executor ?? 'agent', dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [], executionPolicy: { isolation: 'worktree', maxWallTimeMs: 1, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 1, onExhausted: 'block' }, completionGate: null })) });
  const base = tasks([['implement', 'development'], ['review', 'review'], ['ship', 'ship', 'ship']]);
  const ctx = (type) => D.profileRuleContext({ type, size: 's', risk: 'low', areas: [], repos: [], signals: [], source: 'rules', basis: 'predicted' });
  const fix = A.withStepSkills(base, parsed.config, ctx('fix').facts, ctx('fix').predicates);
  check('a fix: implement runs fix-bug (first match), review runs review-pr, ship nothing', eq(fix.tasks.map((t) => t.runSkill?.name ?? null), ['team:fix-bug', 'team:review-pr', null]), fix.tasks.map((t) => t.runSkill));
  const feature = A.withStepSkills(base, parsed.config, ctx('feature').facts, ctx('feature').predicates);
  check('a feature: implement runs build-feature', feature.tasks[0].runSkill?.name === 'team:build-feature', feature.tasks[0].runSkill);
  const own = A.withStepSkills({ ...base, tasks: [{ ...base.tasks[0], runSkill: { name: 'mine', args: '' } }] }, parsed.config, ctx('fix').facts, ctx('fix').predicates);
  check("a step's own runSkill wins", own.tasks[0].runSkill?.name === 'mine');
}

section('pure: the Claude Code run');
{
  const profile = (settings = {}) => ({ id: 'rtp', workspaceId: null, adapterId: 'claude-code', name: 'c', executablePath: null, args: [], settings, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: '', updatedAt: '' });
  const req = (extra) => ({ runId: 'r', profile: profile(), prompt: 'THE STEP CONTEXT', workingDirectory: tmpdir(), grants: [], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 1, signal: new AbortController().signal, log: null, ...extra });
  const skill = { name: 'team:build-feature', args: 'KEY-12', pluginDirs: ['/p/team/2.4.0'] };
  const fresh = C.buildInvocation(req({ skill }), null);
  check('a fresh run starts with the slash command and its args, the step context after', fresh.args[1] === '/team:build-feature KEY-12\n\nTHE STEP CONTEXT', fresh.args[1]);
  check('and loads that one plugin with --plugin-dir, the person\'s settings still kept out', fresh.args.join(' ').includes('--plugin-dir /p/team/2.4.0') && fresh.args.join(' ').includes('--setting-sources project,local'), fresh.args);
  const resumed = C.buildInvocation(req({ skill }), 'sess-1');
  check('a resumed session is not sent the command again, but keeps the plugin', resumed.args[1] === 'THE STEP CONTEXT' && resumed.args.includes('--plugin-dir'), resumed.args.slice(0, 3));
  check('no skill: the prompt as it was, no --plugin-dir', C.buildInvocation(req({}), null).args[1] === 'THE STEP CONTEXT' && !C.buildInvocation(req({}), null).args.includes('--plugin-dir'));
  const init = (skills) => JSON.stringify({ type: 'system', subtype: 'init', skills, slash_commands: skills });
  check('init: the skill is there', C.missingSkill(init(['team:build-feature', 'tdd']), 'team:build-feature') === null);
  const missing = C.missingSkill(init(['team:review-pr', 'tdd']), 'team:build-feature');
  check('init: missing, named, with what the plugin did have', /started without the skill \/team:build-feature/.test(missing ?? '') && missing.includes('/team:review-pr') && !missing.includes('/tdd'), missing);
  check('any other line is not judged', C.missingSkill('{"type":"assistant"}', 'x') === null && C.missingSkill('not json', 'x') === null);
}

// ---------------------------------------------------------------- fixtures
const root = mkdtempSync(join(tmpdir(), 'tdm131-'));
const config = join(root, 'claude-config');
const plugin = join(config, 'plugins/cache/team-market/team/2.4.0');
put(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'team', version: '2.4.0' }));
put(join(plugin, 'skills/build-feature/SKILL.md'), '---\nname: build-feature\ndescription: Build a feature the team way.\n---\nPlan, test first, implement.\n');
put(join(plugin, 'skills/review-pr/SKILL.md'), '---\nname: review-pr\ndescription: Review a pull request.\n---\nReview.\n');
put(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'team@team-market': [{ scope: 'user', installPath: plugin, version: '2.4.0' }] } }));
put(join(config, 'skills/solo/SKILL.md'), '---\nname: solo\ndescription: A personal skill.\n---\nSolo.\n');
const repo = join(root, 'r');
put(join(repo, '.claude/skills/repo-style/SKILL.md'), '---\nname: repo-style\ndescription: This repository\'s style.\n---\nShort.\n');

section('where a step\'s skill is found for a profile');
{
  const s = { configDir: config };
  const ok = await C.resolveClaudeSkill(s, 'team:build-feature', [repo]);
  check('a plugin skill: found, with the one plugin folder to load', ok.ok && eq(ok.pluginDirs, [plugin]) && ok.from.includes('team 2.4.0'), ok);
  const none = await C.resolveClaudeSkill(s, 'team:fix-bug', [repo]);
  check('a plugin without that skill: says which it has', !none.ok && /team 2.4.0 is installed but has no skill fix-bug; it has build-feature, review-pr/.test(none.reason), none);
  const gone = await C.resolveClaudeSkill(s, 'other:x', [repo]);
  check('a plugin not installed: names the config folder and what is installed', !gone.ok && gone.reason.includes(config) && gone.reason.includes('Installed there: team'), gone);
  const own = await C.resolveClaudeSkill(s, 'repo-style', [repo]);
  check("the repository's own skill: found, nothing extra to load", own.ok && eq(own.pluginDirs, []), own);
  const kept = await C.resolveClaudeSkill(s, 'solo', [repo]);
  check('a personal skill while the profile keeps your settings out: refused, with both ways out', !kept.ok && /Import it on the Skills screen/.test(kept.reason) && /Let workers load them/.test(kept.reason), kept);
  const let_ = await C.resolveClaudeSkill({ ...s, userSettings: 'inherit' }, 'solo', [repo]);
  check('the same skill when the profile lets your settings in: found', let_.ok, let_);
  const nowhere = await C.resolveClaudeSkill(s, 'nowhere', [repo]);
  check('a name found nowhere: says where it looked', !nowhere.ok && /no skill nowhere/.test(nowhere.reason), nowhere);
}

// ---------------------------------------------------------------- the daemon
const home = join(root, 'h');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Skills Tester\n\temail = skills@example.com\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.TANDEMISE_SKILLS_DISCOVER_DIR = join(root, 'no-personal-skills');
delete process.env.TANDEMISE_OWNER_NAME;
rmSync(join(repo, '.claude'), { recursive: true, force: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
put(join(repo, 'README.md'), '# skill steps check\n');
put(join(repo, '.gitignore'), '.tandemise/out/\n');
put(join(repo, 'package.json'), JSON.stringify({ name: 's', private: true, scripts: { test: 'node -e "process.exit(0)"' } }));
const step = (key, skill) => ({ key, title: key === 'implement' ? 'Implement' : key, role: 'development', objective: 'Build the hello page.', outputs: ['ChangeSet'], gate: 'artifact.ChangeSet.exists', runSkill: { name: skill, args: '{{mission.title}} {{item.key}}' } });
const yaml = (wf) => JSON.stringify(wf, null, 2);
put(join(repo, '.tandemise/workflows/skill-run.yaml'), yaml({ name: 'Skill run', steps: [step('implement', 'team:build-feature')] }));
put(join(repo, '.tandemise/workflows/skill-missing.yaml'), yaml({ name: 'Skill missing', steps: [step('implement', 'team:fix-bug')] }));
put(join(repo, '.tandemise/workflows/role-run.yaml'), yaml({ name: 'Role run', steps: [{ key: 'implement', title: 'Implement', role: 'development', objective: 'Build the hello page.', outputs: ['ChangeSet'], gate: 'artifact.ChangeSet.exists' }] }));
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

const claude = join(root, 'claude');
writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${resolve(here, 'fixtures/stub-claude.mjs')}" "$@"\n`);
chmodSync(claude, 0o755);
const records = () => (existsSync(join(config, 'records')) ? readdirSync(join(config, 'records')).sort() : [])
  .map((f) => JSON.parse(readFileSync(join(config, 'records', f), 'utf8')));

globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
const api = async (method, path, body) => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, ms = 60_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};

try {
  section('migration 028');
  check('mission_tasks.run_skill', sql("SELECT name FROM pragma_table_info('mission_tasks')").some((c) => c.name === 'run_skill'));

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Skill steps', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...wsRes.body.workspace.autonomy, planApproval: 'auto' } });
  const runtime = await api('POST', '/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code (stub)', workspaceId: null, executablePath: claude, settings: { configDir: config }, maxConcurrent: 2, enabled: true });
  check('a Claude Code profile on the stub, its config folder the fixture', runtime.status === 200, runtime.body);

  const create = async (goal, preset) => {
    const res = await api('POST', '/v1/missions', { workspaceId: ws, goal, workflowPreset: preset, successCriteria: ['The steps finish'], planNow: true });
    const id = res.body?.mission?.id;
    if (id !== undefined) {
      await poll(() => /Ready to start/.test(sql('SELECT status_reason AS r FROM missions WHERE id = ?', id)[0]?.r ?? '') || sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status !== 'PLANNING', 20_000);
      await api('POST', `/v1/missions/${id}/start`);
    }
    return id;
  };
  const status = (id) => sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status;
  const implement = async (id) => { const t = (await api('GET', `/v1/missions/${id}/tasks`)).body; return (t.tasks ?? t).find((x) => x.key === 'implement'); };
  const settled = (id) => poll(async () => { const t = await implement(id); return ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(t?.status) ? t : undefined; });

  section('a step that runs the team\'s plugin skill');
  {
    const id = await create('Skill run one', 'skill-run');
    const task = await settled(id);
    check('the step succeeds and the mission completes', task?.status === 'SUCCEEDED' && (await poll(() => status(id) === 'COMPLETE', 20_000)), { task: task?.status, reason: task?.statusReason, mission: status(id) });
    check('the task carries the skill and its args template', eq(task?.runSkill, { name: 'team:build-feature', args: '{{mission.title}} {{item.key}}' }), task?.runSkill);
    const rec = records().find((r) => r.prompt.includes('Skill run one') || r.prompt.startsWith('/team:build-feature'));
    check('the run got the slash command first, the args filled', rec?.prompt.startsWith('/team:build-feature Skill run one\n\n'), rec?.prompt.slice(0, 120));
    check('the plugin was loaded with --plugin-dir, the person\'s settings still kept out', rec?.argv.join(' ').includes(`--plugin-dir ${plugin}`) && rec.argv.join(' ').includes('--setting-sources project,local'), rec?.argv);
    check("the session had it (the stub's init)", rec?.skills.includes('team:build-feature'), rec?.skills);
    check("the skill's instructions replace the role's; the step's outputs are still asked for",
      rec?.prompt.includes("This step runs the team's own skill /team:build-feature") && !rec.prompt.includes('You are the Developer for this mission') && /### ChangeSet → /.test(rec.prompt), rec?.prompt.slice(0, 1500));
    check('and it is told what Tandemise owns', /opening or merging the pull request/.test(rec?.prompt ?? ''));
    check('the gate held: a ChangeSet artifact', task?.gate?.passed === true || sql("SELECT COUNT(*) AS n FROM artifacts WHERE mission_id = ? AND type = 'ChangeSet'", id)[0].n >= 1, task?.gate);
    const notes = JSON.stringify(sql('SELECT body FROM run_events WHERE mission_id = ? ORDER BY sequence', id));
    check('the log says which skill ran and where it came from', notes.includes('Runs the skill /team:build-feature Skill run one (plugin team 2.4.0 at'), notes.slice(0, 600));
  }

  section("the factory: planner.yaml's stepSkills fill the plan's steps");
  {
    put(join(repo, '.tandemise/factory/planner.yaml'), [
      'version: 1',
      'stepSkills:',
      '  - class: implement',
      '    when: \'profile.type == "fix"\'',
      '    skill: team:fix-bug',
      '  - class: implement',
      '    skill: team:build-feature',
      "    args: '{{item.key}}'",
      '  - class: review',
      '    skill: team:review-pr',
      '',
    ].join('\n'));
    const res = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Add a greeting to the hello page', workflowPreset: 'auto', successCriteria: ['The page greets the visitor'], planNow: true });
    const id = res.body?.mission?.id;
    const tasks = await poll(async () => { const t = (await api('GET', `/v1/missions/${id}/tasks`)).body; const list = t?.tasks ?? t; return Array.isArray(list) && list.length > 0 ? list : undefined; }, 30_000);
    const byClass = Object.fromEntries((tasks ?? []).map((t) => [t.key, t.runSkill?.name ?? null]));
    const code = (tasks ?? []).find((t) => t.roleId === 'development');
    console.log('       planned:', JSON.stringify(byClass));
    check('the code step runs team:build-feature (not a fix), review steps team:review-pr, the ship step nothing',
      code?.runSkill?.name === 'team:build-feature' && code.runSkill.args === '{{item.key}}'
        && (tasks ?? []).filter((t) => t.roleId === 'review').every((t) => t.runSkill?.name === 'team:review-pr')
        && (tasks ?? []).filter((t) => t.executor === 'ship').every((t) => (t.runSkill ?? null) === null),
      byClass);
    await api('POST', `/v1/missions/${id}/cancel`);
    rmSync(join(repo, '.tandemise/factory'), { recursive: true, force: true });
  }

  section('the role prompt is unchanged for a step without one');
  {
    const before = records().length;
    const id = await create('Role run one', 'role-run');
    await settled(id);
    const rec = records().slice(before).find((r) => r.prompt.includes('Role run one'));
    check('no slash command, no --plugin-dir, the role\'s instructions', rec !== undefined && !rec.prompt.startsWith('/') && !rec.argv.includes('--plugin-dir') && rec.prompt.includes('You are the Developer for this mission'), rec?.prompt.slice(0, 200));
  }

  section('a skill the plugin does not have stops the step before anything runs');
  {
    const before = records().length;
    const id = await create('Skill missing one', 'skill-missing');
    const task = await settled(id);
    check('BLOCKED with the reason', task?.status === 'BLOCKED' && /team 2.4.0 is installed but has no skill fix-bug; it has build-feature, review-pr/.test(task.statusReason ?? ''), { status: task?.status, reason: task?.statusReason });
    check('no run was started and no attempt spent', records().length === before && task?.attempts === 0 && task?.runCount === 0, { runs: records().length - before, attempts: task?.attempts, runCount: task?.runCount });
    const cards = (await api('GET', `/v1/approvals?missionId=${id}`)).body;
    const card = (cards.approvals ?? cards).map((a) => a.approval ?? a).find((a) => a.taskId === task?.id && a.kind === 'intervention');
    check('a card: "‘Implement’ needs a skill that isn’t installed", Retry / Leave blocked', card?.title === '‘Implement’ needs a skill that isn’t installed' && eq(card.options.map((o) => o.label), ['Retry', 'Leave blocked']), card ?? cards);
  }

  section('a session that started without the skill is stopped at once');
  {
    writeFileSync(join(config, 'hide-skills'), '');
    const before = records().length;
    const id = await create('Skill hidden one', 'skill-run');
    const task = await settled(id);
    check('BLOCKED: Claude Code started without the skill', task?.status === 'BLOCKED' && /Claude Code started without the skill \/team:build-feature/.test(task.statusReason ?? ''), { status: task?.status, reason: task?.statusReason });
    check('one run was started and the attempt given back', records().length === before + 1 && task?.attempts === 0, { runs: records().length - before, attempts: task?.attempts });
    check('nothing of the work happened (the stub was stopped at init): no ChangeSet', sql("SELECT COUNT(*) AS n FROM artifacts WHERE mission_id = ? AND type = 'ChangeSet'", id)[0].n === 0, sql('SELECT type FROM artifacts WHERE mission_id = ?', id));
    const cards = (await api('GET', `/v1/approvals?missionId=${id}`)).body;
    const card = (cards.approvals ?? cards).map((a) => a.approval ?? a).find((a) => a.taskId === task?.id && a.kind === 'intervention' && a.status === 'PENDING');
    check('the same card', card?.title === '‘Implement’ needs a skill that isn’t installed', card);
    rmSync(join(config, 'hide-skills'));
    const decided = await api('POST', `/v1/approvals/${card?.id}/decide`, { optionId: 'approve' });
    check('Retry once the skill loads', decided.status === 200, decided.body);
    const after = await poll(async () => { const t = await implement(id); return t?.status === 'SUCCEEDED' ? t : undefined; });
    check('then the step runs the skill and succeeds', after?.status === 'SUCCEEDED', (await implement(id))?.statusReason);
  }
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('ALL SKILL STEPS CHECKS PASSED');
process.exit(0);
