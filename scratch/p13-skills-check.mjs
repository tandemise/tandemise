// P13: the skills library. A skill (a folder with SKILL.md) is imported by
// content hash as a numbered version, pinned to roles and workflow steps, and
// each run gets exactly its pinned version - as .claude/skills/<name>/ for a
// runtime that reads a skills folder, else appended to its prompt - and
// records name, version and hash. A pinned skill whose content is missing
// refuses the run with a named reason and an intervention card.
//
//   npm run build && node scratch/p13-skills-check.mjs
//
// Pure rules first; then a real daemon (startDaemon, in process) whose
// discovery root is a fixture folder (never the real home), with the scripted
// agent recording which skills it found in its folder and in its prompt.
//
// #129: discovery also lists the skills of each plugin Claude Code installed
// (`<config>/plugins/installed_plugins.json`; the config folder is the
// discovery root's parent here), each repository's `.claude/skills`, and the
// skills inside a folder that only groups them.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (s) => new TextEncoder().encode(s);

const D = await import('@tandemise/domain');

section('pure: the content hash');
{
  const a = [{ path: 'SKILL.md', bytes: bytes('x') }, { path: 'ref/a.md', bytes: bytes('y') }];
  const h = D.hashSkillFiles(a);
  check('is 64 hex characters', /^[0-9a-f]{64}$/.test(h ?? ''), h);
  check('does not depend on file order', D.hashSkillFiles([...a].reverse()) === h);
  check('changes with one byte', D.hashSkillFiles([a[0], { path: 'ref/a.md', bytes: bytes('z') }]) !== h);
  check('changes with a renamed file', D.hashSkillFiles([a[0], { path: 'ref/b.md', bytes: bytes('y') }]) !== h);
  check('does not confuse a boundary between path and bytes', D.hashSkillFiles([{ path: 'ab', bytes: bytes('c') }]) !== D.hashSkillFiles([{ path: 'a', bytes: bytes('bc') }]));
  check('short hash is 12 characters', D.shortHash(h).length === 12);
}

section('pure: SKILL.md front matter, names, refs');
{
  const fm = D.parseSkillFrontMatter('---\nname: tdd\ndescription: "Write the test first."\nlicense: MIT\n---\n\n# TDD\nBody.\n');
  check('name and description', fm.name === 'tdd' && fm.description === 'Write the test first.', fm);
  check('body without the front matter', fm.body === '# TDD\nBody.\n', fm.body);
  const folded = D.parseSkillFrontMatter('---\nname: x\ndescription: >\n  Two lines\n  folded.\n---\nB');
  check('a folded description', folded.description === 'Two lines folded.', folded.description);
  check('no front matter: nulls and the whole body', eq(D.parseSkillFrontMatter('# Just text'), { name: null, description: null, body: '# Just text' }));
  check('a name with a space is refused', D.skillNameProblem('My Skill') !== null && D.skillNameProblem('house-style') === null && D.skillNameProblem('a.b_c-1') === null);
  check('refs: bare name is latest', eq(D.parseSkillRef('tdd'), { name: 'tdd', version: 'latest' }));
  check('refs: name@2', eq(D.parseSkillRef('tdd@2'), { name: 'tdd', version: 2 }));
  check('refs: name@latest', eq(D.parseSkillRef('tdd@latest'), { name: 'tdd', version: 'latest' }));
  check('refs: bad ones are null', D.parseSkillRef('tdd@0') === null && D.parseSkillRef('tdd@v2') === null && D.parseSkillRef('two words') === null && D.parseSkillRef('@1') === null);
}

section('pure: pins');
{
  const lib = { tdd: [{ version: 1, hash: 'h1' }, { version: 2, hash: 'h2' }], style: [{ version: 1, hash: 's1' }] };
  const catalog = { versionsOf: (n) => lib[n] };
  const r1 = D.resolveSkillPins({ role: [{ name: 'tdd', version: 1 }], step: [{ name: 'style', version: 'latest' }], stepKey: 'implement' }, catalog);
  check('role pin at its version, step latest made concrete', eq(r1.pins, [{ name: 'tdd', version: 1, hash: 'h1', from: 'role' }, { name: 'style', version: 1, hash: 's1', from: 'step' }]) && r1.problems.length === 0, r1);
  const r2 = D.resolveSkillPins({ role: [{ name: 'tdd', version: 1 }], step: [{ name: 'tdd', version: 'latest' }] }, catalog);
  check("a step's pin wins over its role's", eq(r2.pins, [{ name: 'tdd', version: 2, hash: 'h2', from: 'step' }]), r2);
  const r3 = D.resolveSkillPins({ role: [], step: [{ name: 'tdd', version: 3 }, { name: 'nope', version: 'latest' }], stepKey: 'implement' }, catalog);
  check('an unknown version and an unknown skill are named', r3.pins.length === 0 && /version 3, but the library has versions 1–2/.test(r3.problems[0]) && /'nope', which is not in this project's skills library/.test(r3.problems[1]), r3.problems);
  check('facts: all received', eq(D.skillFacts([{ name: 'tdd', version: 1, hash: 'h1' }], [{ name: 'tdd', version: 1, hash: 'h1', via: 'folder' }]), { loaded: 1, missing: 0 }));
  check('facts: a different hash counts as missing', eq(D.skillFacts([{ name: 'tdd', version: 1, hash: 'h1' }], [{ name: 'tdd', version: 1, hash: 'hX', via: 'prompt' }]), { loaded: 1, missing: 1 }));
  check('facts: no run yet', eq(D.skillFacts([{ name: 'tdd', version: 1, hash: 'h1' }], null), { loaded: 0, missing: 1 }));
  const section2 = D.skillPromptSection([
    { name: 'tdd', version: 1, description: 'Tests first.', via: 'folder', body: 'unused', otherFiles: [] },
    { name: 'style', version: 2, description: 'House style.', via: 'prompt', body: '# Style\nShort sentences.', otherFiles: ['ref/words.md'] },
  ]);
  check('prompt section: a clear heading', section2?.startsWith('## Skills pinned to this step'), section2);
  check('prompt section: a folder skill is one line', section2?.includes('- Installed in .claude/skills/tdd (v1): Tests first.') && !section2.includes('unused'), section2);
  check('prompt section: a prompt skill carries its SKILL.md', section2?.includes('### Skill: style (v2)') && section2.includes('Short sentences.') && section2.includes('ref/words.md'), section2);
  check('no skills: no section', D.skillPromptSection([]) === null);
  const long = D.skillPromptSection([{ name: 'big', version: 1, description: '', via: 'prompt', body: 'x'.repeat(50_000), otherFiles: [] }]);
  check('a very long SKILL.md is cut in the prompt, saying so', long.length < 41_000 && long.includes('(This SKILL.md is 50,000 characters; the first 40,000 are shown.)'), long.length);
  check('missing reason names skill, version and hash', D.missingSkillReason([{ name: 'lint-rules', version: 1, hash: 'abcdef0123456789' }]) === "Skill 'lint-rules' v1 (abcdef012345) is missing from the skills library. Import it again on the Skills screen, then choose Retry.");
}

section('workflow file: skills');
{
  const parsed = D.parseWorkflowDefinition({ name: 'S', steps: [{ key: 'a', role: 'development', objective: 'A.', skills: ['tdd@2', 'style'] }, { key: 'b', role: 'review', objective: 'B.' }] });
  check('parses', parsed.ok, parsed.error);
  const plan = D.compileWorkflow(parsed.value, {});
  check('skill refs reach the planned task', eq(plan.value?.tasks[0].skillRefs, [{ name: 'tdd', version: 2 }, { name: 'style', version: 'latest' }]), plan.value?.tasks[0]);
  check('a step without skills has none', plan.value?.tasks[1].skillRefs === undefined);
  check('a bad ref is refused', !D.parseWorkflowDefinition({ name: 'S', steps: [{ key: 'a', role: 'development', objective: 'A.', skills: ['tdd@v2'] }] }).ok);
}

section('runtimes: where skills are read from');
{
  const claude = await import('@tandemise/runtime-claude');
  const generic = await import('@tandemise/runtime-generic');
  const profile = (adapterId, settings) => ({ id: 'rtp_x', workspaceId: null, adapterId, name: adapterId, executablePath: null, args: [], settings, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: '', updatedAt: '' });
  check('Claude Code reads .claude/skills', new claude.ClaudeCodeAdapter({}).skillsFolder(profile('claude-code', {})) === '.claude/skills');
  check('Claude Code workers still keep the person\'s own settings out', claude.buildInvocation({ runId: 'r', profile: profile('claude-code', {}), prompt: 'x', workingDirectory: tmpdir(), grants: [], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 1, signal: new AbortController().signal, log: null }, null).args.join(' ').includes('--setting-sources project,local'));
  const g = new generic.GenericCliAdapter({});
  check('Generic reads .claude/skills only when its settings say so', g.skillsFolder(profile('generic-cli', { command: 'a', skillsFolder: true })) === '.claude/skills' && g.skillsFolder(profile('generic-cli', { command: 'a' })) === null);
}

section('vocabulary');
{
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  check('skills.loaded and skills.missing are published', ['skills.loaded', 'skills.missing'].every((n) => GATE_FACT_VOCABULARY.some((f) => f.name === n && f.type === 'number')));
}

// ---------------------------------------------------------------- fixtures
const root = mkdtempSync(join(tmpdir(), 'tdm13-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const argsDir = join(root, 'args');
const promptDir = join(root, 'prompts');
const found = join(root, 'claude-skills');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Skills Tester\n\temail = skills@example.com\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCRIPTED_DELAY_MS = '0';
process.env.SCRIPTED_ARGS_DIR = argsDir;
process.env.SCRIPTED_PROMPT_DIR = promptDir;
process.env.SCRIPTED_STATE_DIR = join(root, 'state');
process.env.TANDEMISE_SKILLS_DISCOVER_DIR = found;
// The scripted agent names the skills it found in its handoff.
process.env.SCRIPTED_ECHO_SKILLS = '1';
delete process.env.TANDEMISE_OWNER_NAME;

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const witness = join(root, 'executed');
put(join(found, 'tdd/SKILL.md'), '---\nname: tdd\ndescription: Write the failing test first.\n---\n\n# TDD\nRed, green, refactor.\n');
// A script in a skill is data: importing must never run it.
put(join(found, 'tdd/scripts/setup.sh'), `#!/bin/sh\ntouch ${witness}\n`);
put(join(found, 'house-style/SKILL.md'), '---\nname: house-style\ndescription: How our copy reads.\n---\n\nShort sentences. Plain words.\n');
put(join(found, 'house-style/words.md'), 'Say "you", not "the user".\n');
put(join(found, 'notes-only/README.md'), 'No skill here.\n');
put(join(found, 'escape/SKILL.md'), '---\nname: escape\ndescription: Links out.\n---\nx\n');
symlinkSync('/etc/hosts', join(found, 'escape/hosts'));
put(join(found, 'huge/SKILL.md'), '---\nname: huge\ndescription: Too big.\n---\nx\n');
// #129: a folder that only groups skills (one level down), with a non-skill beside them.
put(join(found, 'synced/alpha/SKILL.md'), '---\nname: alpha\ndescription: The first grouped skill.\n---\nA.\n');
put(join(found, 'synced/beta/SKILL.md'), '---\nname: beta\ndescription: The second grouped skill.\n---\nB.\n');
put(join(found, 'synced/notes/README.md'), 'Not a skill.\n');
// #129: a plugin Claude Code installed, recorded the way it records one. The
// config folder is the discovery root's parent: the fixture root, never ~/.claude.
const pluginPath = join(root, 'plugins/cache/testmarket/acme/1.2.3');
put(join(pluginPath, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'acme', version: '1.2.3' }));
put(join(pluginPath, 'skills/hello/SKILL.md'), '---\nname: hello\ndescription: Say hello the team way.\n---\nHello.\n');
put(join(pluginPath, 'skills/review/SKILL.md'), '---\nname: review\ndescription: Review a change the team way.\n---\nReview.\n');
put(join(root, 'plugins/installed_plugins.json'), JSON.stringify({
  version: 2,
  plugins: { 'acme@testmarket': [{ scope: 'user', installPath: pluginPath, version: '1.2.3', installedAt: '2026-11-01T00:00:00.000Z' }] },
}));
writeFileSync(join(found, 'huge/blob.bin'), Buffer.alloc(5 * 1024 * 1024 + 10, 1));
// A repository with the lint rules in a subfolder, imported by file:// URL.
const skillsRepo = join(root, 'skills-repo');
execFileSync('git', ['init', '-q', '-b', 'main', skillsRepo], { stdio: 'ignore' });
put(join(skillsRepo, 'skills/lint-rules/SKILL.md'), '---\nname: lint-rules\ndescription: The lint rules we keep.\n---\n\nNo unused imports.\n');
put(join(skillsRepo, 'README.md'), 'skills\n');
execFileSync('git', ['add', '.'], { cwd: skillsRepo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'skills'], { cwd: skillsRepo, stdio: 'ignore' });

execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# skills check\n');
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 's', private: true, scripts: { test: 'node -e "process.exit(0)"' } }));
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
for (const f of ['p13-skills.yaml', 'p13-lint.yaml', 'p13-unknown.yaml']) copyFileSync(join(here, 'acceptance/p0/workflows', f), join(repo, '.tandemise/workflows', f));
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

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
const records = (marker) => (existsSync(argsDir) ? readdirSync(argsDir) : []).sort()
  .map((f) => JSON.parse(readFileSync(join(argsDir, f), 'utf8'))).filter((r) => r.goal.includes(marker));

try {
  section('migration 018');
  {
    const system = await api('GET', '/v1/system');
    check('schema version is at least 18', system.body?.schemaVersion >= 18, system.body?.schemaVersion);
    const cols = (t) => sql(`SELECT name FROM pragma_table_info('${t}')`).map((c) => c.name);
    check('skills and skill_versions tables', cols('skills').includes('name') && cols('skill_versions').includes('hash'));
    check('role_templates.skills, mission_tasks.skills, runs.skills', cols('role_templates').includes('skills') && cols('mission_tasks').includes('skills') && cols('runs').includes('skills'));
  }

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Skills', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...wsRes.body.workspace.autonomy, planApproval: 'auto' } });
  const settings = (extra) => ({ command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'ndjson', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'], ...extra });
  const runtime = await api('POST', '/v1/runtimes', { adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null, settings: settings({ skillsFolder: true }), maxConcurrent: 4, enabled: true });
  const profileId = runtime.body?.profile?.id ?? runtime.body?.id;
  check('a scripted runtime that reads .claude/skills', runtime.status === 200, runtime.body);

  // #129: a skill the repository keeps in its own .claude/skills (left untracked, so no commit holds it).
  put(join(repo, '.claude/skills/repo-style/SKILL.md'), '---\nname: repo-style\ndescription: How this repository is written.\n---\nKeep it short.\n');

  section('discover: the fixture root, never the real home');
  const disc = await api('GET', `/v1/workspaces/${ws}/skills/discover`);
  const by = (name) => disc.body?.skills?.find((s) => s.folder === name && s.originId.startsWith('personal:'));
  const byInvocation = (name) => disc.body?.skills?.find((s) => s.invocation === name);
  {
    check('the root is the fixture folder', disc.body?.root === found && disc.body?.exists === true, disc.body?.root);
    const personal = disc.body?.skills?.filter((s) => s.originId.startsWith('personal:')).map((s) => s.folder);
    check('seven personal folders listed, the grouped ones walked', eq(personal, ['escape', 'house-style', 'huge', 'notes-only', 'synced/alpha', 'synced/beta', 'tdd']), personal);
    check('tdd: named, described, importable', by('tdd')?.name === 'tdd' && by('tdd')?.description === 'Write the failing test first.' && by('tdd')?.importable === true && by('tdd')?.fileCount === 2 && by('tdd')?.invocation === 'tdd', by('tdd'));
    check('a folder without SKILL.md is refused', /No SKILL.md/.test(by('notes-only')?.problem ?? ''), by('notes-only')?.problem);
    check('a link outside the folder is refused', /hosts links outside the skill folder/.test(by('escape')?.problem ?? ''), by('escape')?.problem);
    check('over 5 MB is refused', /limit is 5 MB/.test(by('huge')?.problem ?? ''), by('huge')?.problem);
    check('a grouping folder is not one broken skill: its skills are importable, named, and not invoked by Claude Code',
      by('synced/alpha')?.name === 'alpha' && by('synced/alpha')?.importable === true && by('synced/alpha')?.invocation === null && by('synced/beta')?.problem === null && by('synced') === undefined,
      [by('synced/alpha'), by('synced')]);
    const hello = byInvocation('acme:hello');
    check('a plugin skill is listed as plugin:skill and imports as plugin-skill', hello?.name === 'acme-hello' && hello?.description === 'Say hello the team way.' && hello?.importable === true && byInvocation('acme:review')?.name === 'acme-review', hello);
    const origin = (s) => disc.body?.origins?.find((o) => o.id === s?.originId);
    check('its origin names the plugin, version, marketplace and folder', origin(hello)?.kind === 'plugin' && origin(hello)?.label === 'Plugin acme 1.2.3' && origin(hello)?.detail === 'testmarket' && origin(hello)?.root === join(pluginPath, 'skills'), origin(hello));
    const repoSkill = byInvocation('repo-style');
    check("the repository's own .claude/skills is listed under the repository", repoSkill?.name === 'repo-style' && origin(repoSkill)?.kind === 'project' && origin(repoSkill)?.label === 'Repository s' && origin(repoSkill)?.root === join(repo, '.claude/skills'), [repoSkill, origin(repoSkill)]);
    check('origins in order: yours, the plugin, the repository', eq(disc.body?.origins?.map((o) => o.kind), ['personal', 'plugin', 'project']), disc.body?.origins);
    check('nothing was executed', !existsSync(witness));
  }

  section('#129: importing a plugin skill, a grouped skill and a repository skill');
  {
    const pv = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(pluginPath, 'skills/hello') } });
    check('preview of a plugin skill: "acme-hello", a new skill', pv.status === 200 && pv.body?.name === 'acme-hello' && pv.body.outcome === 'New skill' && pv.body.source?.plugin === 'acme', pv.body);
    const imp = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'claude', path: join(pluginPath, 'skills/hello') }, hash: pv.body?.hash });
    check('imported as acme-hello v1, its source naming the plugin', imp.body?.version === 1 && imp.body.skill?.name === 'acme-hello' && /^Plugin acme · /.test(imp.body.skill?.sourceLabel ?? ''), imp.body);
    const up = await api('POST', `/v1/skills/${imp.body?.skill?.id}/update`);
    check('Update reads the plugin folder again under the same name', up.status === 200 && up.body?.created === 'unchanged', up.body);
    const gpv = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(found, 'synced/alpha') } });
    check('a grouped skill previews by its own name', gpv.body?.name === 'alpha' && gpv.body.problem === null, gpv.body);
    const rpv = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(repo, '.claude/skills/repo-style') } });
    check("a repository's skill previews as a Claude skill", rpv.status === 200 && rpv.body?.name === 'repo-style', rpv.body);
    const elsewhere = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(pluginPath, '.claude-plugin') } });
    check('a folder discovery did not list is refused as a Claude skill', elsewhere.status === 400, elsewhere.status);
    const after = (await api('GET', `/v1/workspaces/${ws}/skills/discover`)).body?.skills?.find((s) => s.invocation === 'acme:hello');
    check('discovery then says it is in the library', after?.libraryLabel === 'In library as acme-hello v1' && after.importable === false, after);
    const del = await api('DELETE', `/v1/skills/${imp.body?.skill?.id}`);
    check('and it can be removed again (the rest of this check counts three skills)', del.status === 204, del.status);
  }

  section('preview, then import exactly that');
  let tddHash;
  {
    const pv = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(found, 'tdd') } });
    tddHash = pv.body?.hash;
    check('preview: files, SKILL.md, "New skill"', pv.status === 200 && eq(pv.body.files.map((f) => f.path), ['SKILL.md', 'scripts/setup.sh']) && pv.body.skillMd.includes('Red, green') && pv.body.outcome === 'New skill' && pv.body.problem === null, pv.body);
    const bad = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(found, 'escape') } });
    check('preview of a refused folder says why', bad.status === 200 && bad.body.problem !== null && bad.body.hash === null, bad.body);
    const stale = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'path', path: join(found, 'house-style') }, hash: 'a'.repeat(64) });
    check('an import whose content no longer has the previewed hash: 409', stale.status === 409 && /changed since you previewed/.test(stale.body?.message ?? JSON.stringify(stale.body)), stale);
    const outside = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: repo } });
    check('a "Your Claude skills" source outside the root is refused', outside.status === 400, outside.status);
    const imp = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'claude', path: join(found, 'tdd') }, hash: tddHash });
    check('import: tdd v1', imp.status === 200 && imp.body.created === 'skill' && imp.body.version === 1 && imp.body.message === 'Imported tdd v1.', imp.body);
    check('stored under its hash in the home', existsSync(join(home, 'skills', tddHash, 'scripts/setup.sh')));
    check('still nothing executed', !existsSync(witness));
    const hs = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(found, 'house-style') } });
    const hsImp = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'claude', path: join(found, 'house-style') }, hash: hs.body.hash });
    check('import: house-style v1', hsImp.body?.version === 1, hsImp.body);
    const again = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'claude', path: join(found, 'tdd') } });
    check('preview of the same content: "Already in the library as tdd v1"', again.body?.outcome === 'Already in the library as tdd v1' && again.body.changes === false, again.body?.outcome);
    const same = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'claude', path: join(found, 'tdd') }, hash: tddHash });
    check('re-import of the same content: unchanged, no v2', same.body?.created === 'unchanged' && same.body.version === 1, same.body);
    const gitPv = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'git', url: `file://${skillsRepo}`, subpath: 'skills/lint-rules' } });
    check('a git source with a subfolder previews (shallow clone)', gitPv.body?.name === 'lint-rules' && eq(gitPv.body.files.map((f) => f.path), ['SKILL.md']), gitPv.body);
    const gitImp = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'git', url: `file://${skillsRepo}`, subpath: 'skills/lint-rules' }, hash: gitPv.body?.hash });
    check('import from git: lint-rules v1', gitImp.body?.version === 1 && gitImp.body.skill.sourceLabel === `file://${skillsRepo} · skills/lint-rules`, gitImp.body);
    const traversal = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'git', url: `file://${skillsRepo}`, subpath: '../x' } });
    check('a subfolder that climbs out is refused', traversal.status === 400, traversal.status);
  }

  section('list: versions, sources, update available');
  const lib = async () => (await api('GET', `/v1/workspaces/${ws}/skills`)).body;
  const skill = async (name) => (await lib()).skills.find((s) => s.name === name);
  {
    const l = await lib();
    check('three skills, sorted by name', eq(l.skills.map((s) => s.name), ['house-style', 'lint-rules', 'tdd']), l.skills.map((s) => s.name));
    check('local source current; git unchecked', (await skill('tdd')).sourceStatus === 'current' && (await skill('lint-rules')).sourceStatus === 'unchecked');
    check('latest carries hash, files and a size label', (await skill('tdd')).latest.hash === tddHash && /^2 files · /.test((await skill('tdd')).latest.sizeLabel), (await skill('tdd')).latest);
  }

  section('roles pin a version; omitted keeps; unknown refused; delete refused while used');
  const roles = async () => (await api('GET', `/v1/roles?workspaceId=${ws}`)).body;
  const setRole = async (id, skills) => {
    const role = (await roles()).find((r) => r.id === id);
    const { createdAt, updatedAt, builtIn, workspaceId, ...rest } = role;
    return api('PUT', `/v1/roles/${id}`, { ...rest, workspaceId: ws, ...(skills === undefined ? {} : { skills }) });
  };
  {
    const r = await setRole('development', [{ name: 'tdd', version: 1 }]);
    check('PUT role with skills', r.status === 200 && eq(r.body.skills, [{ name: 'tdd', version: 1 }]), r.body);
    const keep = await setRole('development');
    check('a PUT without skills keeps them', eq(keep.body?.skills, [{ name: 'tdd', version: 1 }]), keep.body?.skills);
    const unknown = await setRole('development', [{ name: 'tdd', version: 9 }]);
    check('a version the library lacks: 400 naming it', unknown.status === 400 && /version 9/.test(JSON.stringify(unknown.body)), unknown.body);
    check('"Used by" names the role and version', eq((await skill('tdd')).usedBy.map((u) => [u.roleId, u.version]), [['development', 1]]));
    const del = await api('DELETE', `/v1/skills/${(await skill('tdd')).id}`);
    check('delete refused while a role uses it (409)', del.status === 409 && /Used by Developer/.test(JSON.stringify(del.body)), del.body);
  }

  section('an upstream edit: "Update available"; updating is explicit; the role keeps v1');
  let tddV2Hash;
  {
    writeFileSync(join(found, 'tdd/SKILL.md'), '---\nname: tdd\ndescription: Write the failing test first.\n---\n\n# TDD\nRed, green, refactor. Commit on green.\n');
    check('the list says update_available', (await skill('tdd')).sourceStatus === 'update_available');
    check('discover says it is newer than v1', /Newer than tdd v1/.test((await api('GET', `/v1/workspaces/${ws}/skills/discover`)).body.skills.find((s) => s.folder === 'tdd').libraryLabel ?? ''));
    const up = await api('POST', `/v1/skills/${(await skill('tdd')).id}/update`);
    tddV2Hash = up.body?.skill?.latest?.hash;
    check('Update imports v2', up.body?.created === 'version' && up.body.version === 2 && tddV2Hash !== tddHash, up.body);
    check('versions newest first; source current again', eq((await skill('tdd')).versions.map((v) => v.version), [2, 1]) && (await skill('tdd')).sourceStatus === 'current');
    check('the role still pins v1', eq((await roles()).find((r) => r.id === 'development').skills, [{ name: 'tdd', version: 1 }]));
    const v1 = await api('GET', `/v1/skills/${(await skill('tdd')).id}/versions/1`);
    check('version 1 still reads its own SKILL.md', v1.status === 200 && !v1.body.skillMd.includes('Commit on green') && v1.body.hash === tddHash, v1.body);
  }

  const create = async (goal, preset, extra = {}) => {
    const res = await api('POST', '/v1/missions', { workspaceId: ws, goal, workflowPreset: preset, successCriteria: ['The steps finish'], planNow: true, ...extra });
    const id = res.body?.mission?.id;
    if (id !== undefined) {
      await poll(() => /Ready to start/.test(sql('SELECT status_reason AS r FROM missions WHERE id = ?', id)[0]?.r ?? '') || sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status !== 'PLANNING', 20_000);
      await api('POST', `/v1/missions/${id}/start`);
    }
    return { id, res };
  };
  const status = (id) => sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status;
  const tasksOf = async (id) => { const t = (await api('GET', `/v1/missions/${id}/tasks`)).body; return t.tasks ?? t; };

  section('a run on a worktree gets its pinned skills as folders, excluded from commits');
  let firstMission;
  {
    const { id } = await create('Skills S1', 'p13-skills');
    firstMission = id;
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    check('the mission completes', status(id) === 'COMPLETE', { status: status(id), tasks: sql("SELECT key, status, status_reason FROM mission_tasks WHERE mission_id = ?", id) });
    const tasks = await tasksOf(id);
    const impl = tasks.find((t) => t.key === 'implement');
    check('the task pinned tdd v1 (role) and house-style v1 (step latest)', eq(impl?.skills?.map((p) => [p.name, p.version, p.hash, p.from]), [['tdd', 1, tddHash, 'role'], ['house-style', 1, impl?.skills?.[1]?.hash, 'step']]), impl?.skills);
    check('the run recorded both, as folders', eq(impl?.latestRun?.skills?.map((s) => [s.name, s.version, s.via]), [['tdd', 1, 'folder'], ['house-style', 1, 'folder']]), impl?.latestRun?.skills);
    check('its gate measured skills.loaded 2 and skills.missing 0', impl?.gate?.facts?.['skills.loaded'] === 2 && impl?.gate?.facts?.['skills.missing'] === 0, impl?.gate);
    const review = tasks.find((t) => t.key === 'review');
    check('the review step pins none and its gate read skills.loaded 0', eq(review?.skills, []) && review?.gate?.facts?.['skills.loaded'] === 0, { skills: review?.skills, gate: review?.gate });
    const rec = records('Skills S1');
    check('the agent found both folders in .claude/skills and nothing in its prompt', eq(rec[0]?.skills?.folder, ['house-style', 'tdd']) && eq(rec[0]?.skills?.prompt, []), rec.map((r) => r.skills));
    const cwd = rec[0]?.skills?.cwd;
    const installed = cwd === undefined ? '' : readFileSync(join(cwd, '.claude/skills/tdd/SKILL.md'), 'utf8');
    check('the worktree holds v1 of tdd, not the edited source (the pin holds)', installed.includes('Red, green, refactor.') && !installed.includes('Commit on green'), installed);
    check('with its other files', cwd !== undefined && existsSync(join(cwd, '.claude/skills/tdd/scripts/setup.sh')));
    const exclude = cwd === undefined ? '' : readFileSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { cwd }).toString().trim(), 'utf8');
    check('info/exclude lists the skill folders', exclude.includes('/.claude/skills/tdd/') && exclude.includes('/.claude/skills/house-style/'), exclude);
    const committed = cwd === undefined ? '' : execFileSync('git', ['log', '--name-only', '--format=', '-n', '5'], { cwd }).toString();
    check('no commit contains .claude/skills', !committed.includes('.claude'), committed);
    check('git status shows nothing of them', cwd !== undefined && !execFileSync('git', ['status', '--porcelain'], { cwd }).toString().includes('.claude'));
    check('the person\'s own checkout got nothing', !existsSync(join(repo, '.claude/skills/tdd')) && !existsSync(join(repo, '.claude/skills/house-style')));
    check('nothing was executed along the way', !existsSync(witness));
  }

  section('a runtime without a skills folder gets SKILL.md in its prompt');
  {
    await api('PATCH', `/v1/runtimes/${profileId}`, { settings: settings({}) });
    const { id } = await create('Skills S2', 'p13-skills');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    check('the mission completes', status(id) === 'COMPLETE', status(id));
    const impl = (await tasksOf(id)).find((t) => t.key === 'implement');
    check('the run recorded both, via the prompt', eq(impl?.latestRun?.skills?.map((s) => [s.name, s.version, s.via]), [['tdd', 1, 'prompt'], ['house-style', 1, 'prompt']]), impl?.latestRun?.skills);
    const rec = records('Skills S2');
    check('the agent found them in its prompt, not in a folder', eq(rec[0]?.skills?.prompt, ['house-style', 'tdd']) && eq(rec[0]?.skills?.folder, []), rec.map((r) => r.skills));
    const prompts = readdirSync(promptDir).map((f) => readFileSync(join(promptDir, f), 'utf8')).filter((p) => p.includes('Skills S2') && p.includes('### Skill: tdd (v1)'));
    check('the prompt has the heading and the v1 body', prompts.length >= 1 && prompts[0].includes('## Skills pinned to this step') && prompts[0].includes('Red, green, refactor.') && !prompts[0].includes('Commit on green') && prompts[0].includes('Say "you"') === false && prompts[0].includes('words.md'), prompts[0]?.slice(-900));
    const first = (await tasksOf(firstMission)).find((t) => t.key === 'implement');
    check('the first mission still shows tdd v1 with its old hash', first?.latestRun?.skills?.[0]?.hash === tddHash);
    await api('PATCH', `/v1/runtimes/${profileId}`, { settings: settings({ skillsFolder: true }) });
  }

  section('moving the role to v2 is explicit and reaches new tasks only');
  {
    await setRole('development', [{ name: 'tdd', version: 2 }]);
    const { id } = await create('Skills S3', 'p13-skills');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)));
    const impl = (await tasksOf(id)).find((t) => t.key === 'implement');
    check('a new mission gets tdd v2', impl?.latestRun?.skills?.[0]?.version === 2 && impl.latestRun.skills[0].hash === tddV2Hash, impl?.latestRun?.skills);
    const first = (await tasksOf(firstMission)).find((t) => t.key === 'implement');
    check('the first task keeps its v1 pin', first?.skills?.[0]?.version === 1 && first.skills[0].hash === tddHash);
  }

  section('planning refuses a workflow that pins a skill the library lacks');
  {
    const { id } = await create('Skills unknown', 'p13-unknown');
    const reason = await poll(() => { const m = sql('SELECT status, status_reason AS r FROM missions WHERE id = ?', id)[0]; return m && m.status !== 'PLANNING' && m.status !== 'DRAFT' ? m : undefined; }, 20_000)
      ?? sql('SELECT status, status_reason AS r FROM missions WHERE id = ?', id)[0];
    const notes = JSON.stringify(sql("SELECT body FROM run_events WHERE mission_id = ? ORDER BY sequence", id));
    check("the reason names the step and the skill", /no-such-skill/.test(`${reason?.r ?? ''} ${notes}`), { reason, notes: notes.slice(-600) });
    check('no task was created', sql('SELECT COUNT(*) AS n FROM mission_tasks WHERE mission_id = ?', id)[0].n === 0);
  }

  section('missing content refuses the run by name; re-import and Retry complete it');
  {
    const lint = await skill('lint-rules');
    rmSync(join(home, 'skills', lint.latest.hash), { recursive: true, force: true });
    const { id } = await create('Skills S4', 'p13-lint');
    await poll(() => ['COMPLETE', 'BLOCKED', 'FAILED'].includes(status(id)) || (sql("SELECT status FROM mission_tasks WHERE mission_id = ? AND key = 'check_lint'", id)[0]?.status === 'BLOCKED'));
    const check_lint = (await tasksOf(id)).find((t) => t.key === 'check_lint');
    check('the step is BLOCKED with the skill named', check_lint?.status === 'BLOCKED' && /Skill 'lint-rules' v1 \([0-9a-f]{12}\) is missing from the skills library/.test(check_lint.statusReason ?? ''), { status: check_lint?.status, reason: check_lint?.statusReason });
    check('no run was started for it', check_lint?.runCount === 0 && check_lint?.attempts === 0, { runs: check_lint?.runCount, attempts: check_lint?.attempts });
    const cards = (await api('GET', `/v1/approvals?missionId=${id}`)).body;
    const card = (cards.approvals ?? cards).map((a) => a.approval ?? a).find((a) => a.taskId === check_lint?.id && a.kind === 'intervention' && a.status === 'PENDING');
    check('an intervention card: "‘Check lint’ needs a skill that is missing", Retry / Leave blocked', card?.title === '‘Check lint’ needs a skill that is missing' && eq(card.options.map((o) => o.label), ['Retry', 'Leave blocked']), card ?? cards);
    const pv = await api('POST', `/v1/workspaces/${ws}/skills/preview`, { source: { kind: 'git', url: `file://${skillsRepo}`, subpath: 'skills/lint-rules' } });
    const re = await api('POST', `/v1/workspaces/${ws}/skills`, { source: { kind: 'git', url: `file://${skillsRepo}`, subpath: 'skills/lint-rules' }, hash: pv.body.hash });
    check('re-importing the same files restores the content (same hash, still v1)', re.body?.created === 'unchanged' && existsSync(join(home, 'skills', lint.latest.hash)), re.body);
    const decided = await api('POST', `/v1/approvals/${card?.id}/decide`, { optionId: 'approve' });
    check('Retry accepted', decided.status === 200, decided.body);
    await poll(() => status(id) === 'COMPLETE', 60_000);
    check('the mission completes', status(id) === 'COMPLETE', { status: status(id), tasks: sql("SELECT key, status, status_reason FROM mission_tasks WHERE mission_id = ?", id) });
    const after = (await tasksOf(id)).find((t) => t.key === 'check_lint');
    check('the run got lint-rules v1 and kept its full attempt budget', after?.latestRun?.skills?.[0]?.name === 'lint-rules' && after.retryPolicy.maxAttempts >= 2, { skills: after?.latestRun?.skills, policy: after?.retryPolicy });
  }

  section('deleting an unused skill removes content nobody names');
  {
    const lint = await skill('lint-rules');
    const del = await api('DELETE', `/v1/skills/${lint.id}`);
    check('204', del.status === 204, del);
    check('its content is gone from the store', !existsSync(join(home, 'skills', lint.latest.hash)));
    check('tdd content stays', existsSync(join(home, 'skills', tddHash)));
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
console.log('ALL P13 SKILLS CHECKS PASSED');
process.exit(0);
