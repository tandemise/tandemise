/**
 * #51: the brain, one git repository per project for memory and the factory.
 *
 * Proves, against the built packages, local bare repositories as remotes and a
 * fake `gh` on PATH (never the network):
 *
 *   - pure: paths, writer ids, scrubbing, the brain.yaml codec, remote names;
 *   - persistence: migration 023, workspace_brains, runs.brain, brain_passes
 *     counted in measured_usage, proposals;
 *   - codec: tracker/intake/mcps files and a brain root for the setup codec;
 *   - git: the git and gh adapters (append-only, rebase, protected, offline);
 *   - link: create, adopt, local, unlink, sync;
 *   - factory: the database as a cache of factory/, write-through, precedence;
 *   - fold / ledger / select / loading / tools / signals / classify / promotion;
 *   - intake config: the brain's IntakeConfigSource.
 *
 *   npm run build && node scratch/brain-check.mjs [--only=pure,git]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const wants = (name) => only === null || only.has(name);
const section = (t) => console.log(`\n== ${t}`);

const shared = await import('@tandemise/shared');
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

const HOME = mkdtempSync(join(tmpdir(), 'tdm-brain-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ------------------------------------------------------------------ pure
if (wants('pure')) {
  section('pure: paths, writer ids, scrubbing, brain.yaml, remotes');
  const paths = shared.createPaths('/x');
  check('createPaths(..).brain(ws) is <root>/brains/<ws>', typeof paths.brain === 'function' && paths.brain('ws_1') === '/x/brains/ws_1', paths.brain);
  check('createPaths(..).brains is <root>/brains', paths.brains === '/x/brains');
  check('makeWriterId slugs the handle and keeps 6 hex', D.makeWriterId?.('Ana Smith', 'a1b2c3d4e5') === 'ana-smith-a1b2c3');

  const repos = [{ name: 'garipass', path: '/home/ana/src/garipass' }];
  const tok = D.scrubForBrain?.('use ghp_' + 'a'.repeat(36), repos);
  check('a GitHub token becomes [redacted secret]', tok && 'text' in tok && tok.text.includes('[redacted secret]') && !tok.text.includes('ghp_'), tok);
  const rel = D.scrubForBrain?.('edit /home/ana/src/garipass/src/app/page.tsx', repos);
  check('a path inside a repository becomes repo-relative', rel?.text === 'edit garipass:src/app/page.tsx', rel);
  const abs = D.scrubForBrain?.('read /etc/ssh/config', repos);
  check('any other absolute path is refused in words', abs?.refused === "A lesson can't name a path on your machine. Name the file inside its repository instead.", abs);
  const plain = D.scrubForBrain?.('Run npm run ci before a PR.', repos);
  check('plain text is unchanged', plain?.text === 'Run npm run ci before a PR.', plain);
  check('the secret refusal sentence', D.BRAIN_SECRET_REFUSAL === "A lesson can't contain a secret; it was left out.");

  const m = app.readBrainManifest?.('version: 1\nproject: Garipass\n');
  check('brain.yaml defaults', m?.manifest?.promotion?.autoApply === 'off' && m.manifest.promotion.minHelpful === 3 && m.manifest.promotion.minMissions === 2 && m.manifest.humanEdits === 'direct' && Array.isArray(m.manifest.repositories) && m.manifest.repositories.length === 0, m);
  const bad = app.readBrainManifest?.('version: 1\nproject: G\npromotion:\n  autoApply: always\n');
  check('autoApply: always is a problem naming autoApply', typeof bad?.problem === 'string' && bad.problem.includes('autoApply'), bad);
  const once = m && app.renderBrainManifest(m.manifest);
  check('renderBrainManifest is stable', once !== undefined && once === app.renderBrainManifest(app.readBrainManifest(once).manifest), once);
  check('remoteOf normalises ssh and https', app.remoteOf?.('git@github.com:garipass/brain.git') === 'github.com/garipass/brain' && app.remoteOf('https://github.com/garipass/brain.git') === 'github.com/garipass/brain' && app.remoteOf('https://github.com/garipass/brain') === 'github.com/garipass/brain');
  check('layout constants', app.BRAIN_GITATTRIBUTES === 'memory/ledger/** merge=union\n' && app.BRAIN_FACTORY === 'factory' && app.BRAIN_EVALS === 'evals');
}

// ------------------------------------------------------------------ persistence
if (wants('persistence')) {
  section('persistence: migration 023, links, runs.brain, passes in measured usage, proposals');
  const { Container, compose } = await import('@tandemise/kernel');
  const P = await import('@tandemise/persistence');
  const { ids, systemClock } = shared;
  const now = () => systemClock.now();
  const container = new Container();
  compose(container, P.persistenceModule({ path: join(HOME, 'persist.db'), clock: systemClock }));
  const db = container.resolve(P.DATABASE);
  check('schemaVersion is 23 or later (the brain is 023)', P.schemaVersion(db) >= 23 && P.MIGRATIONS.some((m) => m.version === 23 && m.name === 'brain'), P.schemaVersion(db));
  const ws = ids.workspace();
  container.resolve(P.WORKSPACE_REPOSITORY).create({
    id: ws, name: 'Garipass', defaultRepositoryId: null,
    autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
    concurrency: { maxTotalWorkers: 3, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced',
    knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
  });
  const brains = container.resolve(P.WORKSPACE_BRAIN_REPOSITORY);
  const link = {
    workspaceId: ws, remote: 'github.com/garipass/brain', defaultBranch: 'main', clonePath: '/x/brains/ws',
    writerId: 'ana-a1b2c3', lastPulledSha: null, lastPushedSha: null, lastSyncAt: null,
    lastSyncError: "Couldn't reach github.com.", fallbackBranch: null, linkedAt: now(),
  };
  brains.create(link);
  check('a workspace_brains row round-trips', JSON.stringify(brains.get(ws)) === JSON.stringify(link), brains.get(ws));
  check('update patches a link', brains.update(ws, { lastPulledSha: 'abc' }).lastPulledSha === 'abc' && brains.list().length === 1);

  const missionId = ids.mission();
  container.resolve(P.MISSION_REPOSITORY).create({ id: missionId, workspaceId: ws, repositoryId: null, title: 'M', goal: 'g', constraints: [], successCriteria: [] });
  const taskId = ids.task();
  container.resolve(P.TASK_REPOSITORY).replaceAll(missionId, [{
    id: taskId, missionId, key: 'build', title: 'Build', objective: 'do', roleId: 'development', dependsOn: [],
    requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [], executionPolicy: { isolation: 'worktree', maxWallTimeMs: 1000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
    completionGate: null, status: 'RUNNING', statusReason: null, attempts: 0, remediatesTaskId: null, orderHint: 0,
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  }]);
  const profileId = ids.runtimeProfile();
  container.resolve(P.RUNTIME_PROFILE_REPOSITORY).create({ id: profileId, workspaceId: ws, adapterId: 'fake', name: 'Fake', executablePath: null, args: [], settings: {}, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now(), updatedAt: now() });
  const targetId = ids.executionTarget();
  container.resolve(P.EXECUTION_TARGET_REPOSITORY).create({ id: targetId, workspaceId: ws, missionId, taskId, kind: 'worktree', name: 'wt', workingDirectory: '/tmp/wt', branch: 'b', baseBranch: 'main', status: 'READY', detail: null, createdAt: now(), releasedAt: null });
  const assignmentId = ids.workerAssignment();
  container.resolve(P.ASSIGNMENT_REPOSITORY).create({ id: assignmentId, workspaceId: ws, missionId, taskId, roleId: 'development', runtimeProfileId: profileId, executionTargetId: targetId, grants: [], budgets: { maxWallTimeMs: 1000, maxAttempts: 1 }, createdAt: now() });
  const runs = container.resolve(P.RUN_REPOSITORY);
  const brain = { sha: 'abc', rules: ['memory/rules/project.md'], loaded: [{ id: 'w:1', net: 2 }], indexed: 0, fetched: [], proposed: [] };
  const mkRun = (extra) => ({ id: ids.run(), missionId, taskId, assignmentId, attempt: 1, status: 'RUNNING', roleId: 'development', runtimeProfileId: profileId, executionTargetId: targetId, externalSessionId: null, pid: null, exitCode: null, errorCode: null, errorMessage: null, usage: null, startedAt: now(), finishedAt: null, heartbeatAt: null, ...extra });
  const withBrain = runs.create(mkRun({ brain }));
  const without = runs.create(mkRun({ attempt: 2 }));
  check('runs.brain round-trips', JSON.stringify(runs.get(withBrain.id).brain) === JSON.stringify(brain), runs.get(withBrain.id).brain);
  check('a run without brain reads null', runs.get(without.id).brain === null);
  check('runs.update keeps brain', runs.update(withBrain.id, { status: 'SUCCEEDED' }).brain?.sha === 'abc' && runs.get(withBrain.id).brain?.sha === 'abc');

  const limits = container.resolve(P.LIMIT_REPOSITORY);
  runs.recordUsage(without.id, { inputTokens: 10, outputTokens: 5, costUsd: 1 });
  const before = limits.usageForMission(missionId).costUsd;
  const records = container.resolve(P.BRAIN_RECORD_REPOSITORY);
  const pass = (cost) => ({ id: `bps_${Math.random().toString(16).slice(2)}`, workspaceId: ws, missionId, taskId, kind: 'reflect', signal: 'hold', runtimeProfileId: profileId, model: 'm', status: 'ok', reason: null, usage: cost === undefined ? null : { inputTokens: 1, outputTokens: 1, costUsd: cost, wallTimeMs: 10 }, createdAt: now() });
  records.insertPass(pass(0.25));
  const after = limits.usageForMission(missionId).costUsd;
  check('a reflector pass adds its cost to the mission usage', Math.abs(after - before - 0.25) < 1e-9, { before, after });
  records.insertPass(pass(null));
  check('a pass with no cost leaves the cost unchanged (not 0)', limits.usageForMission(missionId).costUsd === after);
  check('passes are listed by workspace since a time', records.passes(ws, '2000-01-01T00:00:00.000Z').length === 2);

  const prop = { id: 'p1', workspaceId: ws, lessonIds: ['w:1'], targets: ['memory/rules/project.md'], classification: 'small', reasons: [], branch: 'tandemise/promote/p1', state: 'evaluating', evalRunId: null, verdict: null, prUrl: null, appliedSha: null, createdAt: now(), updatedAt: now() };
  records.upsertProposal(prop);
  records.upsertProposal({ ...prop, state: 'open', prUrl: 'https://x/pull/1' });
  check('upsertProposal keeps one row with the second state', records.proposals(ws).length === 1 && records.proposal('p1').state === 'open' && records.proposal('p1').lessonIds[0] === 'w:1');
  brains.remove(ws);
  check('remove drops the link', brains.get(ws) === undefined);
  await container.dispose();
}

// ------------------------------------------------------------------ fake gh + git config
// `gh` is a script first on PATH; its state lives under HOME. A git config
// (passed as GIT_CONFIG_GLOBAL) turns https://github.com/ into the local
// bare repositories the fake gh creates, so nothing touches the network.
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const FAKE = {
  bin: join(HOME, 'bin'), log: join(HOME, 'gh-log.jsonl'), state: join(HOME, 'gh-state'),
  remotes: join(HOME, 'remotes'), gitconfig: join(HOME, 'gitconfig'),
};
mkdirSync(FAKE.bin, { recursive: true });
mkdirSync(FAKE.remotes, { recursive: true });
writeFileSync(join(FAKE.bin, 'gh'), `#!/bin/sh\nFAKE_GH_LOG='${FAKE.log}' FAKE_GH_STATE='${FAKE.state}' FAKE_GH_REMOTES='${FAKE.remotes}' exec '${process.execPath}' '${join(here, 'brain-fixtures', 'fake-gh.mjs')}' "$@"\n`);
chmodSync(join(FAKE.bin, 'gh'), 0o755);
writeFileSync(FAKE.gitconfig, `[url "file://${FAKE.remotes}/"]\n\tinsteadOf = https://github.com/\n[protocol "file"]\n\tallow = always\n[user]\n\tname = Check\n\temail = check@localhost\n[init]\n\tdefaultBranch = main\n`);
process.env.PATH = `${FAKE.bin}:${process.env.PATH}`;
process.env.GIT_CONFIG_GLOBAL = FAKE.gitconfig;
const ghLog = () => (existsSync(FAKE.log) ? readFileSync(FAKE.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const bare = (name) => {
  const dir = join(HOME, 'bare', `${name}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--bare', '-q', '-b', 'main');
  return dir;
};
let supervisor = null;
async function brainRepo() {
  const EL = await import('@tandemise/execution-local');
  supervisor ??= new EL.NodeProcessSupervisor(quiet);
  return new EL.GitBrainRepo(supervisor, quiet, () => ({ GIT_CONFIG_GLOBAL: FAKE.gitconfig }));
}
async function brainHost() {
  const { GhBrainHost } = await import('@tandemise/integration-github');
  const EL = await import('@tandemise/execution-local');
  supervisor ??= new EL.NodeProcessSupervisor(quiet);
  const exec = {
    async run(req) {
      const r = await supervisor.run({ command: req.command, args: req.args ?? [], cwd: req.cwd ?? HOME, env: req.env ?? {}, stdin: req.stdin, timeoutMs: req.timeoutMs });
      return { command: req.command, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: 0, timedOut: r.timedOut };
    },
  };
  return new GhBrainHost(exec);
}

// ------------------------------------------------------------------ codec
// A P15 snapshot fixture, used by the codec section and later ones.
const roleFixture = (id, name, model, extra = {}) => ({
  id, name, summary: `${name} summary`, instructions: `Do the ${id} work well.`, capabilities: ['repository.read'],
  produces: [], consumes: [], isolation: 'worktree', outputContract: '', model, escalate: [], economyModel: null,
  runtime: [], skills: [], ...extra,
});
const skillHash = 'a'.repeat(64);
const snapshotFixture = {
  project: {
    name: 'Garipass', autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
    maxTotalWorkers: 3, knowledge: { codingStandards: 'Use the design tokens.' }, wipLimit: null, monthlyLimits: [], missionLimits: [],
  },
  roles: [roleFixture('development', 'Developer', 'strong-model', { skills: [{ name: 'tdd', version: 1, hash: skillHash }] }), roleFixture('review', 'Reviewer', null)],
  workflows: [{ file: 'build-feature.yaml', content: 'id: build-feature\nname: Build a feature\nsteps: []\n' }],
  routines: [{ name: 'Nightly', kind: 'mission', goal: 'Tidy up', successCriteria: [], priority: 'normal', limits: null, workflow: null, schedule: { type: 'daily', at: '03:00' } }],
  skills: [{ name: 'tdd', version: 1, hash: skillHash, source: { kind: 'git', url: 'https://github.com/garipass/skills', subpath: 'tdd' } }],
  issues: null,
};
const mcpsFixture = [
  { name: 'GitHub', provider: 'github', capabilities: ['github.read', 'github.write'], connect: { kind: 'cli', command: 'gh' } },
  { name: 'YouTrack', provider: 'mcp', capabilities: ['issues.read', 'issues.write'], connect: { kind: 'mcp', url: 'https://youtrack.example.com/mcp' } },
];
// renderSetup(snapshotFixture).hash computed from origin/main's build, before
// this change: a P15 export without the new files is byte-identical to today's.
const P15_BASELINE_HASH = '717200293e5b';

if (wants('codec')) {
  section('codec: tracker, intake and mcps files; a brain root');
  const base = app.renderSetup(snapshotFixture);
  if (process.argv.includes('--print-baseline')) console.log('BASELINE', base.hash);
  check('with no new fields the export is byte-identical to P15 (hash literal)', base.hash === P15_BASELINE_HASH, base.hash);
  const nulls = app.renderSetup({ ...snapshotFixture, mcps: null, tracker: null, intake: null });
  check('null mcps/tracker/intake add nothing', nulls.hash === base.hash);
  const tracker = 'tracker:\n  kind: youtrack\n';
  const full = app.renderSetup({ ...snapshotFixture, mcps: mcpsFixture, tracker, intake: null });
  const added = full.files.map((f) => f.path).filter((p) => !base.files.some((b) => b.path === p)).sort();
  check('the rendered set gains exactly mcps.yaml and tracker.yaml', JSON.stringify(added) === JSON.stringify(['mcps.yaml', 'tracker.yaml']), added);
  const mcpsText = full.files.find((f) => f.path === 'mcps.yaml')?.content ?? '';
  check('mcps.yaml names gh and no credential', mcpsText.includes('command: gh') && !/credentialRef|env|token/i.test(mcpsText), mcpsText);
  const files = Object.fromEntries(full.files.map((f) => [f.path, f.content]));
  const read = app.readSetup(files);
  check('readSetup round-trips mcps', JSON.stringify(read.snapshot.mcps) === JSON.stringify(app.readSetup(Object.fromEntries(app.renderSetup(read.snapshot).files.map((f) => [f.path, f.content]))).snapshot.mcps) && read.snapshot.mcps?.length === 2, read.snapshot.mcps);
  check('readSetup carries tracker byte for byte', read.snapshot.tracker === tracker && read.problems.length === 0, read.problems);
  const items = app.diffSetup({ ...snapshotFixture, mcps: [] }, read, { library: [], stored: new Set(), repositories: [], integrations: [{ provider: 'github', name: 'GitHub' }] });
  const yt = items.find((i) => i.id === 'mcps:YouTrack');
  check('a missing MCP is an add row saying what to connect', yt?.action === 'add' && yt.detail === 'This project needs YouTrack. Connect it.' && yt.problem === null && yt.choice === null, yt);
  check('a connected MCP is same', items.find((i) => i.id === 'mcps:GitHub')?.action === 'same');
  check('the tracker is an item', items.find((i) => i.id === 'tracker:project')?.name === 'Tracker and state mapping');

  const { FileSetupFolder } = await import('../apps/daemon/dist/setup-folder.js');
  const dir = join(HOME, 'codec-brain');
  mkdirSync(join(dir, 'factory', 'roles'), { recursive: true });
  writeFileSync(join(dir, 'factory', 'tracker.yaml'), tracker);
  writeFileSync(join(dir, 'factory', 'notes.txt'), 'hello');
  writeFileSync(join(dir, 'factory', 'mcps.yaml'), mcpsText);
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
  const folder = await new FileSetupFolder(quiet).read(dir, { root: 'factory' });
  check('FileSetupFolder reads a brain root', folder?.files['tracker.yaml'] === tracker && folder.files['mcps.yaml'] === mcpsText, folder);
  check('and lists other files as ignored', folder?.ignored.includes('notes.txt'), folder?.ignored);
}

// ------------------------------------------------------------------ git
if (wants('git')) {
  section('git: the brain repository adapter and the gh host');
  const repo = await brainRepo();
  const remote = bare('git1');
  const a = join(HOME, 'git1-a');
  await repo.init(a, 'main');
  const manifest = 'version: 1\nproject: Garipass\n';
  await repo.commit(a, [{ path: 'brain.yaml', mode: 'write', content: manifest }], 'chore: create', null);
  await repo.setRemote(a, remote);
  check('init + commit + push is pushed', (await repo.push(a, 'main', { setUpstream: true })) === 'pushed');
  check('the bare repo has one commit', git(remote, 'log', '--oneline', 'main').trim().split('\n').length === 1);

  const b = join(HOME, 'git1-b');
  await repo.clone(remote, b);
  const head = await repo.head(b);
  check('a clone reads brain.yaml at head', (await repo.readAt(b, head, 'brain.yaml')) === manifest);
  check('listAt of a missing dir is empty', (await repo.listAt(b, head, 'memory')).length === 0);
  check('readAt of a missing file is null', (await repo.readAt(b, head, 'nope.md')) === null);

  const ledger = 'memory/ledger/2026/10/w.jsonl';
  await repo.commit(a, [{ path: ledger, mode: 'append', content: 'a\n' }], 'chore: one', null);
  await repo.commit(a, [{ path: ledger, mode: 'append', content: 'a\n' }], 'chore: two', null);
  check('two appends give a\\na\\n', readFileSync(join(a, ledger), 'utf8') === 'a\na\n');
  let refused = null;
  try { await repo.commit(a, [{ path: ledger, mode: 'write', content: 'x' }], 'chore: bad', null); } catch (e) { refused = e.message; }
  check('a write to a ledger file is refused', refused === 'Ledger files are append-only.', refused);
  check('the file is untouched by the refused write', readFileSync(join(a, ledger), 'utf8') === 'a\na\n');
  await repo.push(a, 'main');

  // Concurrent writers: own ledger files never conflict.
  await repo.commit(a, [{ path: 'memory/ledger/2026/10/a.jsonl', mode: 'append', content: '{"a":1}\n' }], 'chore: a', null);
  await repo.commit(b, [{ path: 'memory/ledger/2026/10/b.jsonl', mode: 'append', content: '{"b":1}\n' }], 'chore: b', null);
  check('the first push wins', (await repo.push(a, 'main')) === 'pushed');
  check('the second is rejected', (await repo.push(b, 'main')) === 'rejected');
  const rebased = await repo.fetchAndRebase(b, 'main');
  check('fetchAndRebase reports no conflict on ledger files', rebased.conflicted.length === 0 && rebased.offline === null, rebased);
  check('then the push goes through', (await repo.push(b, 'main')) === 'pushed');

  // A real conflict on a rules file, with an unpushed ledger commit before it.
  await repo.fetchAndRebase(a, 'main');
  await repo.commit(a, [{ path: 'memory/rules/project.md', mode: 'write', content: 'from a\n' }], 'chore: rules a', null);
  await repo.push(a, 'main');
  await repo.commit(b, [{ path: 'memory/ledger/2026/10/b.jsonl', mode: 'append', content: '{"b":2}\n' }], 'chore: lessons from b', null);
  await repo.commit(b, [{ path: 'memory/rules/project.md', mode: 'write', content: 'from b\n' }], 'chore: rules b', null);
  const conflict = await repo.fetchAndRebase(b, 'main');
  check('a rules conflict is reported', JSON.stringify(conflict.conflicted) === JSON.stringify(['memory/rules/project.md']), conflict);
  check('no rebase is left in progress', !existsSync(join(b, '.git', 'rebase-merge')) && !existsSync(join(b, '.git', 'rebase-apply')));
  const moved = await repo.moveUnpushedTo(b, 'tandemise/local/b/x', 'main');
  check('moveUnpushedTo moves only the rules commit', moved.length === 1, moved);
  check('the branch holds the rules change', git(b, 'show', 'tandemise/local/b/x:memory/rules/project.md') === 'from b\n');
  check('the ledger commit stays on main, on top of origin/main', git(b, 'show', 'main:memory/ledger/2026/10/b.jsonl').includes('{"b":2}') && git(b, 'rev-parse', 'main~1').trim() === (await repo.head(b, 'refs/remotes/origin/main')));
  check('and main has no rules change of its own', git(b, 'show', 'main:memory/rules/project.md') === 'from a\n');
  // A commit that fails leaves the file exactly as it was.
  const ledgerBefore = readFileSync(join(b, 'memory/ledger/2026/10/b.jsonl'));
  writeFileSync(join(b, '.git', 'index.lock'), '');
  let failedCommit = false;
  try { await repo.commit(b, [{ path: 'memory/ledger/2026/10/b.jsonl', mode: 'append', content: '{"b":3}\n' }], 'chore: fails', null); } catch { failedCommit = true; }
  rmSync(join(b, '.git', 'index.lock'), { force: true });
  check('a failed commit throws and restores the ledger file byte for byte', failedCommit && readFileSync(join(b, 'memory/ledger/2026/10/b.jsonl')).equals(ledgerBefore));
  // A rebase that fails with nothing conflicted is a failure, not a success.
  await repo.commit(a, [{ path: 'memory/rules/other.md', mode: 'write', content: 'x\n' }], 'chore: other', null);
  await repo.push(a, 'main');
  writeFileSync(join(b, 'memory/rules/project.md'), 'dirty, not committed\n');
  const dirty = await repo.fetchAndRebase(b, 'main');
  check('a rebase blocked by a dirty tree reports failed', typeof dirty.failed === 'string' && dirty.conflicted.length === 0, dirty);
  git(b, 'checkout', '--', 'memory/rules/project.md');

  // Protected branch.
  const prot = bare('protected');
  writeFileSync(join(prot, 'hooks', 'pre-receive'), '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n');
  chmodSync(join(prot, 'hooks', 'pre-receive'), 0o755);
  const c = join(HOME, 'git1-c');
  await repo.init(c, 'main');
  await repo.commit(c, [{ path: 'brain.yaml', mode: 'write', content: manifest }], 'chore: create', null);
  await repo.setRemote(c, prot);
  check('a protected branch push is protected', (await repo.push(c, 'main')) === 'protected');

  // Offline.
  renameSync(remote, `${remote}.gone`);
  let threw = false;
  let off;
  try { off = await repo.fetchAndRebase(a, 'main'); } catch { threw = true; }
  check('offline fetch never throws and says why', !threw && typeof off?.offline === 'string' && off.offline.length > 0, off);
  renameSync(`${remote}.gone`, remote);

  // Fake gh.
  const host = await brainHost();
  const pr = await host.openPr({ clone: a, head: 'tandemise/x', base: 'main', title: 'T', body: 'B', draft: true });
  check('openPr returns the fake URL', pr.url.endsWith('/pull/1'), pr);
  const line = ghLog().find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('the gh log has --draft and the body on stdin', line?.argv.includes('--draft') && line.stdin === 'B', line);
  check('findPr finds it by head', (await host.findPr(a, 'tandemise/x'))?.url === pr.url);
  check('prState reads open', (await host.prState(a, pr.url)) === 'open');
  check('the host is available', (await host.available()).ok === true);

  // Sharing into a repository a person made first (dogfood #112): empty is used, one with commits is refused in words.
  const made = await host.createRepo('acme', 'made-first');
  const again = await host.createRepo('acme', 'made-first').catch((e) => e);
  check('createRepo on a repository that exists and is empty uses it', again?.remote === made.remote && made.remote === 'https://github.com/acme/made-first.git', again?.message ?? again);
  const seeded = join(HOME, 'seeded');
  mkdirSync(seeded, { recursive: true });
  git(seeded, 'init', '-q', '-b', 'main');
  git(seeded, 'commit', '-q', '--allow-empty', '-m', 'someone else');
  git(seeded, 'push', '-q', join(FAKE.remotes, 'acme', 'made-first.git'), 'main');
  const taken = await host.createRepo('acme', 'made-first').catch((e) => e);
  check('createRepo on a repository with commits is refused, pointing at Use an existing brain',
    taken?.code === 'CONFLICT' && /has commits/.test(taken.message) && /Use an existing brain/.test(taken.message), taken?.message ?? taken);
}

// ------------------------------------------------------------------ fold
if (wants('fold')) {
  section('fold: a deterministic fold over the memory ledger');
  const W = ['ana-a1b2c3', 'ben-d4e5f6', 'cy-0a0b0c'];
  const t = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
  const id = (w, n) => `${w}:${String(n).padStart(26, '0')}`;
  const scope = { role: 'development' };
  const add = (w, n, text, extra = {}) => ({ op: 'add', id: id(w, n), at: t(n), by: w, entry: { kind: 'lesson', text, scope, source: { signal: 'person', mission: `M${n}` }, state: 'active', ...extra } });
  const vote = (w, n, target, v, why = 'reflector', mission) => ({ op: 'vote', id: target, at: t(n), by: w, vote: v, why, ...(mission ? { mission } : {}) });
  const events = [];
  for (let i = 0; i < 12; i++) events.push(add(W[i % 3], i + 1, `Lesson number ${i} about the build.`));
  events.push(add(W[0], 20, 'Run npm run ci before a PR.'));
  events.push(add(W[1], 21, 'run  npm run ci, before a PR'));
  for (let i = 0; i < 10; i++) events.push(vote(W[i % 3], 30 + i, id(W[i % 3], (i % 12) + 1), i % 4 === 0 ? 'harmful' : 'helpful'));
  events.push(vote(W[2], 41, id(W[1], 21), 'helpful', 'reflector', 'M20'));
  events.push(vote(W[2], 42, id(W[0], 20), 'helpful', 'reflector', 'M21'));
  for (let i = 0; i < 12; i++) events.push({ op: 'confirm', id: id(W[(i + 1) % 3], (i % 12) + 1), at: t(50 + i), by: W[(i + 1) % 3], mission: `X${i}` });
  events.push({ op: 'accept', id: id(W[0], 4), at: t(60), by: W[2] });
  events.push({ op: 'retire', id: id(W[1], 5), at: t(61), by: W[0], reason: 'Old.' });
  check('the fixture has 40 events across 3 writers', events.length === 40, events.length);

  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const now = t(100);
  const reference = JSON.stringify(D.foldLedger?.(events, [], now));
  let same = typeof D.foldLedger === 'function';
  for (let i = 0; i < 100 && same; i++) same = JSON.stringify(D.foldLedger(shuffle(events), [], now)) === reference;
  check('100 shuffles fold to the same memory', same);

  const memory = D.foldLedger?.(events, [], now);
  const ci = memory?.entries.filter((e) => D.normaliseText(e.text) === D.normaliseText('Run npm run ci before a PR.'));
  check('duplicate adds are one entry with the earlier id', ci?.length === 1 && ci[0].id === id(W[0], 20), ci?.map((e) => e.id));
  check('votes on either id sum on the winner', ci?.[0]?.helpful === 2, ci?.[0]);
  check('the winner counts both missions', ci?.[0]?.missions.length === 2, ci?.[0]?.missions);

  const pv = D.foldLedger?.([add(W[0], 1, 'Person voted.'), vote(W[1], 2, id(W[0], 1), 'helpful', 'person')], [], now);
  check('a person vote counts 3', pv?.entries[0]?.net === 3, pv?.entries[0]);

  const sup = D.foldLedger?.([add(W[0], 1, 'Old way.'), add(W[0], 2, 'New way.'), { op: 'supersede', id: id(W[0], 1), at: t(3), by: W[0], successor: id(W[0], 2), invalidAt: t(3) }], [], now);
  const old = sup?.entries.find((e) => e.id === id(W[0], 1));
  check('a superseded entry stays, invalid from invalidAt', old?.invalidAt === t(3) && old.supersededBy === id(W[0], 2), old);
  check('and is not loadable after', old !== undefined && D.isLoadable(old, t(4)) === false);

  const harm = D.foldLedger?.([add(W[0], 1, 'Bad advice.'), ...[2, 3, 4].map((n) => vote(W[1], n, id(W[0], 1), 'harmful', 'reflector', `H${n}`))], [], now);
  check('3 harmful votes flag it and stop it loading', harm?.entries[0]?.flags.harmful === true && D.isLoadable(harm.entries[0], now) === false, harm?.entries[0]);

  const staleNow = new Date(Date.parse(t(1)) + 91 * 86_400_000).toISOString();
  const stale = D.foldLedger?.([add(W[0], 1, 'Old but fine.')], [], staleNow);
  check('91 days unconfirmed is stale but still loads', stale?.entries[0]?.flags.stale === true && D.isLoadable(stale.entries[0], staleNow) === true, stale?.entries[0]?.flags);

  const cand = (extra) => D.foldLedger([add(W[0], 1, 'Maybe this.', { state: 'candidate', source: { signal: 'agent', mission: 'M1' } }), ...extra], [], now).entries[0];
  check('a candidate does not load alone', D.isLoadable?.(cand([]), now) === false);
  check('a confirm from the same mission is not enough', D.isLoadable?.(cand([{ op: 'confirm', id: id(W[0], 1), at: t(2), by: W[1], mission: 'M1' }]), now) === false);
  check('a confirm from another mission makes it load', D.isLoadable?.(cand([{ op: 'confirm', id: id(W[0], 1), at: t(2), by: W[1], mission: 'M2' }]), now) === true);
  check('accept makes it load', D.isLoadable?.(cand([{ op: 'accept', id: id(W[0], 1), at: t(2), by: W[1] }]), now) === true);
  check('reject never loads', D.isLoadable?.(cand([{ op: 'reject', id: id(W[0], 1), at: t(2), by: W[1] }, { op: 'confirm', id: id(W[0], 1), at: t(3), by: W[1], mission: 'M2' }]), now) === false);

  const eidAdd = { ...add(W[0], 1, 'Counted once.'), eid: 'w:e1' };
  const eidVote = { ...vote(W[1], 2, id(W[0], 1), 'helpful', 'person', 'M9'), eid: 'w:e2' };
  const twice = D.foldLedger([eidAdd, eidVote, eidVote], [], now).entries[0];
  check('an event appended twice (same eid) folds once', twice?.helpful === 3, twice);
  const repeat = D.foldLedger([add(W[0], 1, 'Repeat.'), vote(W[1], 2, id(W[0], 1), 'helpful', 'person', 'MA'), vote(W[1], 3, id(W[0], 1), 'helpful', 'person', 'MA'), vote(W[1], 4, id(W[0], 1), 'helpful', 'person', 'MB')], [], now).entries[0];
  check('a writer votes once per mission; two missions are two supporters', repeat?.helpful === 6 && repeat.supporters === 2, repeat);
  const promoted = [add(W[0], 1, 'Promoted.'), { op: 'promote', id: id(W[0], 1), at: t(2), by: W[0], target: 'x', pr: 'https://pr/1' }];
  const closedTwice = D.foldLedger([...promoted, { op: 'unpromote', id: id(W[0], 1), at: t(3), by: W[0], pr: 'https://pr/1' }, { op: 'unpromote', id: id(W[0], 1), at: t(4), by: W[1], pr: 'https://pr/1' }], [], now).entries[0];
  check('two daemons closing the same PR leave the lesson active, no longer promoted', closedTwice?.state === 'active' && closedTwice.promoted === null && closedTwice.netSinceRejected === 0 && D.isLoadable(closedTwice, now), closedTwice);

  const lines = [JSON.stringify(add(W[0], 1, 'Good line.')), '{not json', '{"op":"explode"}', JSON.stringify(vote(W[0], 2, id(W[2], 9), 'helpful'))];
  const parsed = lines.map((l, i) => D.parseLedgerLine?.(l, 'memory/ledger/2026/10/ana-a1b2c3.jsonl', i + 1));
  const evs = parsed.filter((p) => p && !('problem' in p));
  const probs = parsed.filter((p) => p && 'problem' in p);
  const folded = D.foldLedger?.(evs, probs, now);
  check('bad lines are three problems naming file and line', folded?.problems.length === 3 && folded.problems.every((p) => p.problem.startsWith('memory/ledger/2026/10/ana-a1b2c3.jsonl line ')), folded?.problems);
  check('an unknown id is named in words', folded?.problems.some((p) => p.problem === "memory/ledger/2026/10/ana-a1b2c3.jsonl line 4: refers to an entry this brain doesn't have."), folded?.problems);
  check('the good entry is intact', folded?.entries.length === 1 && folded.entries[0].text === 'Good line.');
}

// ------------------------------------------------------------------ select
if (wants('select')) {
  section('select: scope ranking, the lesson budget, the index');
  const now = '2026-10-30T00:00:00.000Z';
  let n = 0;
  const entry = (text, scope, extra = {}) => ({
    id: `w-a1b2c3:${String(++n).padStart(26, '0')}`, kind: 'lesson', text, scope, source: { signal: 'person', mission: 'M' }, state: 'active',
    helpful: 0, harmful: 0, net: 0, addedAt: now, lastConfirmedAt: now, missions: ['M'], confirmedElsewhere: false,
    invalidAt: null, supersededBy: null, retired: null, promoted: null, netSinceRejected: null, flags: { harmful: false, stale: false }, ...extra,
  });
  const task = { repos: ['garipass'], role: 'development', step: 'build', files: ['garipass:src/app/page.tsx'] };
  const mem = (entries) => ({ entries, aliases: {}, problems: [] });
  const step0 = entry('Step lesson.', { step: 'build' });
  const proj9 = entry('Project lesson.', {}, { net: 9, helpful: 9 });
  const picked = D.selectBrain?.(mem([proj9, step0]), task, now);
  check('a step lesson with net 0 ranks above a project one with net 9', picked?.lessons[0]?.id === step0.id && picked.lessons[1]?.id === proj9.id, picked?.lessons);
  const thirty = Array.from({ length: 30 }, (_, i) => entry(`${String(i).padStart(2, '0')}${'x'.repeat(198)}`, {}));
  const budget = D.selectBrain?.(mem(thirty), task, now);
  check('30 lessons of 200 chars: 20 loaded, 10 indexed', budget?.lessons.length === 20 && budget.index.length === 10, [budget?.lessons.length, budget?.index.length]);
  check('an index line is the first 80 characters', budget?.index[0]?.title.length === 80);
  const hundred = Array.from({ length: 100 }, (_, i) => entry(`${String(i).padStart(3, '0')}${'y'.repeat(197)}`, {}));
  check('the index is capped at 40', D.selectBrain?.(mem(hundred), task, now).index.length === 40);
  check('a paths glob matches a repo-relative file', D.matchScope?.({ paths: ['src/**/*.tsx'] }, { ...task, files: ['garipass:src/app/page.tsx'] }) === 'paths');
  check('and not a .ts file', D.matchScope?.({ paths: ['src/**/*.tsx'] }, { ...task, files: ['garipass:src/app/page.ts'] }) === null);
  check('a lesson for another role does not match', D.matchScope?.({ role: 'review' }, task) === null);
  const harmful = entry('Harmful.', {}, { flags: { harmful: true, stale: false }, harmful: 3, net: -3 });
  const superseded = entry('Superseded.', {}, { invalidAt: '2026-01-01T00:00:00.000Z', supersededBy: 'x' });
  const sel = D.selectBrain?.(mem([harmful, superseded]), task, now);
  check('harmful and superseded entries are never selected', sel?.lessons.length === 0 && sel.index.length === 0, sel);
}

// ------------------------------------------------------------------ classify
if (wants('classify')) {
  section('classify: small, structural or refused, decided by code from the diff');
  const c = (diff) => D.classifyBrainChange?.(diff) ?? { class: null, reasons: [] };
  const role = (front, body) => `---\n${front}---\n\n${body}\n`;
  const devFront = 'id: development\nname: Developer\nmodel: strong-model\n';
  const wf = 'name: Build\nsteps:\n  - key: plan\n    role: architecture\n    approvals: [plan]\n  - key: build\n    role: development\n    completionGate: checks.tests == PASS\n';
  const rows = [
    ['lines added at the end of project.md', [{ path: 'memory/rules/project.md', before: '# Rules\n\nA.\n', after: '# Rules\n\nA.\nB.\n' }], 'small'],
    ['lines added in the middle', [{ path: 'memory/rules/project.md', before: 'A.\nC.\n', after: 'A.\nB.\nC.\n' }], 'small'],
    ['a new rules file', [{ path: 'memory/rules/role-development.md', before: null, after: '# Developer\n\nB.\n' }], 'small'],
    ['a role body line added, front matter unchanged', [{ path: 'factory/roles/development.md', before: role(devFront, 'Do it.'), after: role(devFront, 'Do it.\nTest first.') }], 'small'],
    ['CRLF before, LF after, same lines plus one', [{ path: 'memory/rules/project.md', before: 'A.\r\nB.\r\n', after: 'A.\nB.\nC.\n' }], 'small'],
    ['one line reworded', [{ path: 'memory/rules/project.md', before: 'A.\nB.\n', after: 'A.\nB!\n' }], 'structural', 'Removes or rewords a line in memory/rules/project.md.'],
    ['a line removed from role instructions', [{ path: 'factory/roles/development.md', before: role(devFront, 'Do it.\nTest.'), after: role(devFront, 'Do it.') }], 'structural', 'Removes or rewords a line in factory/roles/development.md.'],
    ['a role model change', [{ path: 'factory/roles/development.md', before: role(devFront, 'Do it.'), after: role(devFront.replace('strong-model', 'other-model'), 'Do it.') }], 'structural', "Changes development's settings (model, skills, capabilities or isolation)."],
    ['a workflow step removed', [{ path: 'factory/workflows/build.yaml', before: wf, after: wf.split('  - key: build')[0] }], 'structural', 'Changes the workflow build.'],
    ['approvals removed', [{ path: 'factory/workflows/build.yaml', before: wf, after: wf.replace('    approvals: [plan]\n', '') }], 'structural', 'Removes or relaxes an approval or a gate.'],
    ['a gate changed', [{ path: 'factory/workflows/build.yaml', before: wf, after: wf.replace('checks.tests == PASS', 'true') }], 'structural', 'Removes or relaxes an approval or a gate.'],
    ['project settings', [{ path: 'factory/tandemise.yaml', before: 'version: 1\n', after: 'version: 1\nwipLimit: 3\n' }], 'structural', 'Changes project settings.'],
    ['autonomy relaxed', [{ path: 'factory/tandemise.yaml', before: 'project:\n  autonomy:\n    planApproval: ask\n', after: 'project:\n  autonomy:\n    planApproval: auto\n' }], 'structural', 'Removes or relaxes an approval or a gate.'],
    ['tracker', [{ path: 'factory/tracker.yaml', before: null, after: 'tracker: {}\n' }], 'structural', 'Changes the tracker mapping.'],
    ['intake', [{ path: 'factory/intake.yaml', before: null, after: 'sources: []\n' }], 'structural', 'Changes the tracker mapping.'],
    ['mcps', [{ path: 'factory/mcps.yaml', before: 'mcps: []\n', after: 'mcps:\n  - name: X\n' }], 'structural', 'Changes the MCPs the project needs.'],
    ['an mcp added is a new integration', [{ path: 'factory/mcps.yaml', before: 'mcps: []\n', after: 'mcps:\n  - name: X\n' }], 'structural', 'Adds a capability or an integration.'],
    ['routines', [{ path: 'factory/routines.yaml', before: 'routines: []\n', after: 'routines:\n  - name: N\n' }], 'structural', 'Changes routines.'],
    ['issues', [{ path: 'factory/issues.yaml', before: null, after: 'repositories: []\n' }], 'structural', 'Changes issue settings.'],
    ['skills.lock', [{ path: 'factory/skills.lock', before: 'version: 1\n', after: 'version: 1\nskills: []\n' }], 'structural', 'Changes pinned skills.'],
    ['vendored skills', [{ path: 'skills/tdd/abc/SKILL.md', before: null, after: 'x\n' }], 'structural', 'Changes pinned skills.'],
    ['brain.yaml', [{ path: 'brain.yaml', before: 'version: 1\n', after: 'version: 1\nhumanEdits: pr\n' }], 'structural', 'Changes brain.yaml.'],
    ['a capability added to a role', [{ path: 'factory/roles/development.md', before: role(devFront, 'Do it.'), after: role(`${devFront}capabilities:\n  - github.write\n`, 'Do it.') }], 'structural', 'Adds a capability or an integration.'],
    ['rules added plus skills.lock', [{ path: 'memory/rules/project.md', before: 'A.\n', after: 'A.\nB.\n' }, { path: 'factory/skills.lock', before: 'version: 1\n', after: 'version: 1\nx: 1\n' }], 'structural', 'Changes pinned skills.'],
    ['anything under evals/', [{ path: 'evals/gates.yaml', before: null, after: 'suites: []\n' }], 'refused', 'The evals folder can only be changed by a person.'],
  ];
  for (const [label, diff, cls, reason] of rows) {
    const got = c(diff);
    check(`${label} → ${cls}`, got.class === cls && (reason === undefined || got.reasons.includes(reason)), got);
  }
}

// ------------------------------------------------------------------ harness
// The application composed over a real database, with the daemon's disk
// adapters and the brain's git and gh adapters, as bootstrap binds them.
async function brainHarness(name) {
  const home = join(HOME, name);
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = shared;
  const persistenceTokens = await import('@tandemise/persistence');
  const A = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
  const { FileSetupFolder } = await import('../apps/daemon/dist/setup-folder.js');
  const { DaemonSkillFiles } = await import('../apps/daemon/dist/skill-files.js');
  const paths = createPaths(home);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'brain-check' } });
  const clock = systemClock;
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: name === 'home2' ? 'Ben Ortiz' : 'Ana Smith' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const key of Object.keys(app)) {
    const appToken = app[key]; const provider = persistenceTokens[key];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${key}` });
  }
  const published = [];
  const subscribers = new Set();
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: (e) => { published.push(e); for (const s of subscribers) s(e); }, subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); } }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  container.rebind(app.WORKFLOW_SOURCE, () => new FileWorkflowSource(quiet), { source: 'check' });
  container.rebind(app.SETUP_FOLDER, () => new FileSetupFolder(quiet), { source: 'check' });
  container.rebind(app.SKILL_FILES, () => new DaemonSkillFiles(paths.skills, join(home, 'claude-skills'), quiet), { source: 'check' });
  const repoPort = await brainRepo();
  const hostPort = await brainHost();
  container.rebind(app.BRAIN_REPO, () => repoPort, { source: 'check' });
  container.rebind(app.BRAIN_HOST, () => hostPort, { source: 'check' });
  container.bind(app.BRAIN_WORKTREE_DIFF, () => async (dir) => { try { return execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' }); } catch { return ''; } }, { source: 'check' });
  const ctx = await import('@tandemise/context');
  const prompts = [];
  const realCompiler = ctx.createContextCompiler();
  container.rebind(ctx.CONTEXT_COMPILER, () => ({ compile: (req) => { const c = realCompiler.compile(req); prompts.push({ taskId: req.task.id, prompt: c.prompt, truncated: c.truncated }); return c; } }), { source: 'check' });
  const services = app.createServices(container);
  container.resolve(app.BRAIN_INTAKE_CONFIG);
  const r = (t) => container.resolve(t);
  const caller = { personId: services.identity.localPerson().id };
  const repoDir = join(home, 'code');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q', '-b', 'main');
  writeFileSync(join(repoDir, 'README.md'), '# garipass\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'init');
  const ws = (await services.workspaces.create(caller, { name: 'Garipass', repositoryPath: repoDir })).workspace.id;
  return { home, paths, container, services, r, caller, ws, repoDir, published, subscribers, brainRepo: repoPort, prompts };
}

// ------------------------------------------------------------------ link
let H1 = null;
let H2 = null;
if (wants('link') || wants('factory') || wants('ledger') || wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake')) {
  H1 = await brainHarness('home1');
  H2 = await brainHarness('home2');
}
const remoteDir = join(FAKE.remotes, 'garipass', 'brain.git');
const tokenText = 'ghp_' + 'z'.repeat(36);

if (H1 !== null) {
  section('link: create, adopt, keep local, unlink, sync');
  const { services: s1, r: r1, caller: c1, ws: ws1 } = H1;
  // Home 1 has a reviewer with a model and a token in its instructions, a GitHub integration, and an accepted decision.
  const reviewer = s1.roles.list(ws1).find((x) => x.id === 'review');
  s1.roles.upsert({ ...reviewer, workspaceId: ws1, instructions: `Review carefully. Use ${tokenText} for nothing.`, models: { model: 'strong-model', escalate: [], economyModel: null } });
  r1(app.INTEGRATION_REPOSITORY).create({ id: shared.ids.integration(), workspaceId: ws1, providerId: 'github', name: 'GitHub', transport: 'cli', config: {}, credentialRef: null, enabledCapabilities: ['github.read'], enabled: true, createdAt: shared.systemClock.now(), updatedAt: shared.systemClock.now() });
  const decision = (id) => ({ id, workspaceId: ws1, missionId: null, title: 'Use SQLite for state', context: 'One machine.', decision: 'SQLite with WAL.', rationale: 'Simple.', alternatives: [{ title: 'Postgres', summary: 'A server.' }], consequences: ['No server.'], status: 'accepted', owner: 'ana', relatedArtifacts: [], supersedes: null, createdAt: shared.systemClock.now(), decidedAt: shared.systemClock.now() });
  r1(app.DECISION_REPOSITORY).create(decision(shared.ids.decision()));
  s1.workspaces.update(ws1, { knowledge: { productVision: 'Calm software.', architecturePrinciples: null, codingStandards: 'Run npm run ci.', designSystem: null, glossary: null } });

  const before = ghLog().length;
  const view = await s1.brain.link(c1, ws1, { mode: 'create', owner: 'garipass', name: 'brain' });
  const created = ghLog().slice(before).find((l) => l.argv[0] === 'repo');
  check('create runs gh repo create --private', created?.argv.join(' ') === 'repo create garipass/brain --private', created);
  check('the view is linked and up to date', view.linked === true && view.status === 'up_to_date' && view.statusLine.startsWith('Up to date'), view);
  const tree = git(remoteDir, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean);
  for (const f of ['brain.yaml', 'README.md', '.gitattributes', 'factory/tandemise.yaml', 'factory/roles/development.md', 'memory/rules/project.md']) {
    check(`the bare repo has ${f}`, tree.includes(f), tree);
  }
  check('.gitattributes is the union rule', git(remoteDir, 'show', 'main:.gitattributes') === app.BRAIN_GITATTRIBUTES);
  const p15 = app.renderSetup(await s1.setup.snapshotFor(ws1, { mcps: false }));
  const mismatched = p15.files.filter((f) => { try { return git(remoteDir, 'show', `main:factory/${f.path}`) !== f.content; } catch { return true; } }).map((f) => f.path);
  check('every P15 file is byte-identical under factory/', mismatched.length === 0, mismatched);
  check('mcps.yaml is in the brain', tree.includes('factory/mcps.yaml'));
  check('a decision file is in the brain', tree.some((f) => /^memory\/decisions\/use-sqlite-for-state-[0-9a-f]{8}\.md$/.test(f)), tree);
  const rules = git(remoteDir, 'show', 'main:memory/rules/project.md');
  check('project.md carries the knowledge fields in order', rules.indexOf('## Product vision') >= 0 && rules.indexOf('## Product vision') < rules.indexOf('## Coding standards') && rules.includes('Run npm run ci.'), rules);

  let second = null;
  try { await s1.brain.link(c1, ws1, { mode: 'create', owner: 'garipass', name: 'brain' }); } catch (e) { second = e.message; }
  check('a second brain is refused in words', second === 'This project already has a brain: github.com/garipass/brain.', second);

  const factoryText = tree.filter((f) => f.startsWith('factory/')).map((f) => git(remoteDir, 'show', `main:${f}`)).join('\n');
  const profileIds = r1(app.RUNTIME_PROFILE_REPOSITORY).list().map((p) => p.id);
  check('factory/ has no runtime profile id', !profileIds.some((id) => factoryText.includes(id)));
  check('routines.yaml has no enabled key', !/^\s*enabled:/m.test(tree.includes('factory/routines.yaml') ? git(remoteDir, 'show', 'main:factory/routines.yaml') : ''));
  check('factory/ has no absolute path', !/(^|[\s'"])\/(home|Users|tmp|private)\//.test(factoryText));
  const all = git(remoteDir, 'log', '-p', '--all');
  check('no ghp_ token anywhere in the brain', !all.includes('ghp_'), all.slice(0, 200));

  // Adopt from a second home.
  const { services: s2, caller: c2, ws: ws2 } = H2;
  const preview = await s2.brain.link(c2, ws2, { mode: 'adopt', remote: 'github.com/garipass/brain' });
  check('adopt previews role:development as same', preview.items?.find((i) => i.id === 'role:development')?.action === 'same', preview.items?.map((i) => [i.id, i.action]));
  check('adopt previews the missing GitHub connection', preview.items?.find((i) => i.id === 'mcps:GitHub')?.detail === 'This project needs GitHub. Connect it.');
  check('adopt counts the brain', preview.brain?.rules >= 1 && preview.brain.mcpsNeeded.includes('GitHub'), preview.brain);
  const adopted = await s2.brain.applyAdopt(c2, ws2, { hash: preview.hash, choices: {} });
  check('after applyAdopt home 2 is linked', adopted.linked === true && adopted.remote === 'github.com/garipass/brain', adopted);
  const model = (s, w, id) => s.roles.list(w).find((x) => x.id === id)?.models?.model ?? null;
  check("home 2's Reviewer model equals home 1's", model(s2, ws2, 'review') === 'strong-model' && model(s2, ws2, 'development') === model(s1, ws1, 'development'));
  check('the two homes have different writer ids', s1.brain.view(ws1).writerId !== s2.brain.view(ws2).writerId, [s1.brain.view(ws1).writerId, s2.brain.view(ws2).writerId]);

  // Decisions are content-named.
  const d1 = app.decisionFile(decision(shared.ids.decision()));
  const d2 = app.decisionFile(decision(shared.ids.decision()));
  check('the same decision on two machines is one file name', d1.path === d2.path, [d1.path, d2.path]);

  // Offline.
  const pinned = s1.brain.view(ws1).lastPulledSha;
  renameSync(remoteDir, `${remoteDir}.gone`);
  const off = await s1.brain.sync(ws1, 'person');
  check('offline: status and words', off.status === 'offline' && off.statusLine.startsWith('Working from your copy of the brain'), off);
  check('offline: pin still returns the old head', (await s1.brain.pin(ws1)) === pinned);
  renameSync(`${remoteDir}.gone`, remoteDir);
  const back = await s1.brain.sync(ws1, 'person');
  check('back online: up to date again', back.status === 'up_to_date', back);

  // Local only, then unlink, on a third project.
  const ws3 = (await s1.workspaces.create(c1, { name: 'Side', repositoryPath: H1.repoDir })).workspace.id;
  const ghBefore = ghLog().length;
  const local = await s1.brain.link(c1, ws3, { mode: 'local' });
  check('local: status local_only with no gh call', local.status === 'local_only' && ghLog().length === ghBefore && local.statusLine === 'This brain is only on this machine. Share it to work with others.', local);
  const rolesBefore = JSON.stringify(s1.roles.list(ws3).map((x) => [x.id, x.models]));
  const unlinked = await s1.brain.unlink(c1, ws3);
  check('unlink: the row is gone', unlinked.linked === false && r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws3) === undefined);
  check('unlink: the clone stays', existsSync(join(H1.paths.brain(ws3), 'brain.yaml')));
  check('unlink: roles unchanged', JSON.stringify(s1.roles.list(ws3).map((x) => [x.id, x.models])) === rolesBefore);
  let evalsRefused = null;
  try { await s1.brain.readAt(ws1, pinned, 'evals/gates.yaml'); } catch (e) { evalsRefused = e.message; }
  check('readAt refuses evals/', evalsRefused === 'The evals folder can only be changed by a person.', evalsRefused);
}

// ------------------------------------------------------------------ factory
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
let scratchN = 0;
/** A person's own clone of the brain: edit, commit, push. */
function scratchEdit(edits, message = 'chore: edit by hand', remote = remoteDir) {
  const dir = join(HOME, `scratch-${++scratchN}`);
  execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'ignore' });
  for (const [path, content] of Object.entries(edits)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'function' ? content(existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null) : content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}
const scratchEditOn = (remote, edits) => scratchEdit(edits, 'chore: edit by hand', remote);
const commitCount = () => Number(git(remoteDir, 'rev-list', '--count', 'main').trim());
const withModel = (text, model) => {
  const read = app.readRole('roles/development.md', text);
  return app.renderRole({ ...read.role, model });
};

if (H1 !== null && (wants('factory') || wants('ledger') || wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('factory: the database is a cache of factory/, your edits write through');
  const { services: s1, r: r1, caller: c1, ws: ws1 } = H1;
  const { services: s2, ws: ws2 } = H2;

  // A routine made here writes through to the brain.
  const routine = s1.routines.create(c1, ws1, { name: 'Nightly tidy', kind: 'mission', goal: 'Tidy up', successCriteria: ['Nothing is left untidy.'], priority: 'normal', limits: null, workflowPreset: null, schedule: { type: 'daily', at: '03:00' }, enabled: false }).routine;
  await sleep(3000);
  await s1.brain.sync(ws1, 'person');
  check('a new routine writes through to factory/routines.yaml', git(remoteDir, 'show', 'main:factory/routines.yaml').includes('Nightly tidy'));
  // Personal fields: switch it on and route Developer here.
  s1.routines.update(routine.id, { enabled: true });
  const profileX = r1(app.RUNTIME_PROFILE_REPOSITORY).list()[0]?.id ?? 'rt-x';
  s1.workspaces.update(ws1, { routing: { development: [profileX] } });
  await sleep(2600);
  await s1.brain.sync(ws1, 'person');
  const beforeCount = commitCount();
  const beforeGh = ghLog().length;

  scratchEdit({
    'factory/roles/development.md': (t) => withModel(t, 'other-model'),
    'factory/routines.yaml': (t) => t.replace("at: \"03:00\"", "at: \"04:30\"").replace("at: '03:00'", "at: '04:30'").replace('at: 03:00', 'at: 04:30'),
  });
  const afterEdit = commitCount();
  await s1.brain.sync(ws1, 'person');
  const dev = s1.roles.list(ws1).find((x) => x.id === 'development');
  check('a pushed role edit reaches the database after sync (no preview)', dev?.models?.model === 'other-model', dev?.models);
  const tidy = r1(app.ROUTINE_REPOSITORY).list(ws1).find((x) => x.name === 'Nightly tidy');
  check('the routine took the brain schedule', tidy?.schedule?.at === '04:30', tidy?.schedule);
  check('this machine keeps the routine switched on', tidy?.enabled === true, tidy?.enabled);
  check('routing still names this machine\'s profile', JSON.stringify(s1.workspaces.view(ws1).workspace.routing.development) === JSON.stringify([profileX]));
  await sleep(2600);
  check('the refresh did not write back (loop guard)', commitCount() === afterEdit && ghLog().length === beforeGh, { beforeCount, afterEdit, now: commitCount() });

  // Write-through, direct.
  const devRole = s1.roles.list(ws1).find((x) => x.id === 'development');
  s1.roles.upsert({ ...devRole, workspaceId: ws1, models: { model: 'third-model', escalate: [], economyModel: null } });
  await sleep(3000);
  const last = git(remoteDir, 'log', '-1', '--format=%an%x1f%s', 'main').trim().split('\x1f');
  check('your edit is a commit on main within 3 s', git(remoteDir, 'show', 'main:factory/roles/development.md').includes('third-model') && last[1].startsWith('chore: '), last);
  check('the commit is authored by you', last[0] === s1.identity.localPerson().displayName, last);

  // Write-through, as a pull request.
  scratchEdit({ 'brain.yaml': (t) => t.replace('humanEdits: direct', 'humanEdits: pr') });
  await s1.brain.sync(ws1, 'person');
  const ghBefore = ghLog().length;
  s1.roles.upsert({ ...s1.roles.list(ws1).find((x) => x.id === 'development'), workspaceId: ws1, models: { model: 'fourth-model', escalate: [], economyModel: null } });
  await sleep(3000);
  const prLine = ghLog().slice(ghBefore).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('with humanEdits: pr your edit opens a PR from tandemise/edit/', prLine?.argv[prLine.argv.indexOf('--head') + 1]?.startsWith('tandemise/edit/'), prLine?.argv);
  check('and main is unchanged', !git(remoteDir, 'show', 'main:factory/roles/development.md').includes('fourth-model'));
  scratchEdit({ 'brain.yaml': (t) => t.replace('humanEdits: pr', 'humanEdits: direct') });
  await s1.brain.sync(ws1, 'person');

  // Three-way write-through: the clone has a teammate's role change the database has not taken yet.
  scratchEdit({ 'factory/roles/review.md': (t) => withModel(t.replace('id: review', 'id: development'), 'teammate-model').replace('id: development', 'id: review') });
  const link3 = r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1);
  await H1.brainRepo.fetchAndRebase(link3.clonePath, 'main');
  s1.roles.upsert({ ...s1.roles.list(ws1).find((x) => x.id === 'development'), workspaceId: ws1, models: { model: 'fifth-model', escalate: [], economyModel: null } });
  await s1.brain.settleEdits(ws1);
  check("your edit writes only what you changed; a teammate's newer role is not reverted", git(remoteDir, 'show', 'main:factory/roles/review.md').includes('teammate-model') && git(remoteDir, 'show', 'main:factory/roles/development.md').includes('fifth-model'));
  await s1.brain.sync(ws1, 'person');
  check("the next sync brings the teammate's role in", s1.roles.list(ws1).find((x) => x.id === 'review')?.models?.model === 'teammate-model');

  // MCPs carry no machine path.
  r1(app.INTEGRATION_REPOSITORY).create({ id: shared.ids.integration(), workspaceId: ws1, providerId: 'mcp', name: 'Local MCP', transport: 'mcp', config: { command: '/home/ana/bin/yt-mcp --stdio' }, credentialRef: null, enabledCapabilities: [], enabled: true, createdAt: shared.systemClock.now(), updatedAt: shared.systemClock.now() });
  const mcps = (await s1.setup.snapshotFor(ws1, { mcps: true })).mcps ?? [];
  check('an MCP command keeps its name, not its path', mcps.find((m) => m.name === 'Local MCP')?.connect.command === 'yt-mcp --stdio', mcps);

  // Workflow precedence.
  const wf = (name) => `name: ${name}\ndescription: One step.\nsteps:\n  - key: build\n    role: development\n    objective: Build it.\n    outputs: [ChangeSet]\n    gate: artifact.ChangeSet.exists\n`;
  mkdirSync(join(H1.repoDir, '.tandemise', 'workflows'), { recursive: true });
  writeFileSync(join(H1.repoDir, '.tandemise', 'workflows', 'build-feature.yaml'), wf('From the code repo'));
  scratchEdit({ 'factory/workflows/build-feature.yaml': wf('From the brain') });
  await s1.brain.sync(ws1, 'person');
  const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
  const listed = await app.listProjectWorkflows({ workflows: new FileWorkflowSource(quiet), brain: s1.brain }, ws1, [H1.repoDir]);
  const bf = listed.workflows.find((w) => w.id === 'build-feature');
  check('a brain workflow wins over the code repo', bf?.origin === 'brain' && bf.definition?.name === 'From the brain', bf);
  check('the code repo copy is listed as shadowed', listed.shadowed.some((w) => w.id === 'build-feature' && w.origin === 'repository'));
  const viaService = await s1.workflows.list(ws1);
  check('the workflow service lists the brain one', viaService.find((w) => w.id === 'build-feature')?.name === 'From the brain', viaService.map((w) => [w.id, w.name]));

  // Vendored skills close P15 Ruling 14.
  const skillText = '---\nname: tdd\ndescription: Test first.\n---\n\nWrite the failing test first.\n';
  const skillHashV = D.hashSkillFiles([{ path: 'SKILL.md', bytes: Buffer.from(skillText) }]);
  scratchEdit({
    [`skills/tdd/${skillHashV.slice(0, 12)}/SKILL.md`]: skillText,
    'factory/skills.lock': `skills:\n  - hash: ${skillHashV}\n    name: tdd\n    source:\n      kind: git\n      subpath: tdd\n      url: https://github.com/garipass/skills\n    version: 1\nversion: 1\n`,
    'factory/roles/review.md': (t) => { const read = app.readRole('roles/review.md', t); return app.renderRole({ ...read.role, skills: [{ name: 'tdd', version: 1, hash: skillHashV }] }); },
  });
  const ws4 = (await s2.workspaces.create(H2.caller, { name: 'Third', repositoryPath: H2.repoDir })).workspace.id;
  const pv = await s2.brain.link(H2.caller, ws4, { mode: 'adopt', remote: 'github.com/garipass/brain' });
  check('the adopt preview has no Needs import for a vendored skill', !pv.items.some((i) => i.needsImport !== null), pv.items.filter((i) => i.needsImport !== null).map((i) => i.id));
  await s2.brain.applyAdopt(H2.caller, ws4, { hash: pv.hash, choices: {} });
  check('the skill is in the store after adopt', (await s2.skills.content(skillHashV)) !== null);
  check('the reviewer pins it', (s2.roles.list(ws4).find((x) => x.id === 'review')?.skills ?? []).some((p) => p.name === 'tdd'));
  await s1.brain.sync(ws1, 'person');
  check('home 1 fills its store from the brain on sync', (await s1.skills.content(skillHashV)) !== null);

  // A conflict on a rules file becomes a PR.
  const link1 = r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1);
  await H1.brainRepo.commit(link1.clonePath, [{ path: 'memory/rules/project.md', mode: 'write', content: '# Mine\n' }], 'chore: rules here', null);
  scratchEdit({ 'memory/rules/project.md': '# Theirs\n' });
  const ghC = ghLog().length;
  const conflicted = await s1.brain.sync(ws1, 'person');
  const cpr = ghLog().slice(ghC).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('a conflicting change opens a PR from tandemise/local/', cpr?.argv[cpr.argv.indexOf('--head') + 1]?.startsWith('tandemise/local/'), cpr?.argv);
  check('the sync error says what conflicts', r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1).lastSyncError?.startsWith('Your change to memory/rules/project.md conflicts'), r1(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1).lastSyncError);
  check('the cache follows origin/main', git(remoteDir, 'rev-parse', 'main').trim() === conflicted.lastPulledSha, conflicted);
  await s2.brain.sync(ws2, 'person');
}

// ------------------------------------------------------------------ ledger
const ledgerFiles = (dir) => {
  const out = {};
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const p = rel === '' ? name.name : `${rel}/${name.name}`;
      if (name.isDirectory()) walk(p); else out[p] = readFileSync(join(dir, p));
    }
  };
  walk('memory/ledger');
  return out;
};
const missionFor = (h, title, extra = {}) => {
  const id = shared.ids.mission();
  h.r(app.MISSION_REPOSITORY).create({ id, workspaceId: h.ws, repositoryId: null, title, goal: 'g', constraints: [], successCriteria: [], ...extra });
  return id;
};

if (H1 !== null && (wants('ledger') || wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('ledger: append, batch, history, Remember this');
  const { services: s1, caller: c1, ws: ws1 } = H1;
  const { services: s2, caller: c2, ws: ws2 } = H2;
  const clone1 = H1.r(app.WORKSPACE_BRAIN_REPOSITORY).get(ws1).clonePath;
  // A recorder on the port: no ledger path may ever be a write or a delete.
  const badWrites = [];
  for (const h of [H1, H2]) {
    const original = h.brainRepo.commit.bind(h.brainRepo);
    if (!h.brainRepo.__recorded) {
      h.brainRepo.commit = async (clone, files, ...rest) => {
        for (const f of files) if (f.path.startsWith('memory/ledger/') && f.mode !== 'append') badWrites.push(f.path);
        return original(clone, files, ...rest);
      };
      h.brainRepo.__recorded = true;
    }
  }
  await s1.brain.sync(ws1, 'person');
  const r1 = await s1.brain.remember(c1, ws1, { text: 'Run npm run ci before opening a PR.', scope: { role: 'development' } });
  check('remember answers in words', r1.message === 'Saved. Agents on Developer will see it from the next run.', r1.message);
  await s1.brain.flush(ws1);
  const before = ledgerFiles(clone1);
  const r2 = await s1.brain.remember(c1, ws1, { text: 'Prefer small pull requests.' });
  await s1.brain.vote(c1, r1.entry.id, { vote: 'helpful' });
  const cand = await s1.brain.append(ws1, [{ op: 'add', entry: { kind: 'lesson', text: 'Maybe cache the build.', scope: {}, source: { signal: 'agent', mission: 'M' }, state: 'candidate' } }], { actor: 'agent' });
  await s1.brain.accept(c1, cand[0].id);
  const cand2 = await s1.brain.append(ws1, [{ op: 'add', entry: { kind: 'lesson', text: 'Skip the tests on Fridays.', scope: {}, source: { signal: 'agent', mission: 'M' }, state: 'candidate' } }], { actor: 'agent' });
  await s1.brain.reject(c1, cand2[0].id);
  await s1.brain.retire(c1, r2.entry.id, { reason: 'We changed our mind.' });
  const done = missionFor(H1, 'Ship onboarding', { status: 'COMPLETE' });
  H1.r(app.MISSION_REPOSITORY).update(done, { status: 'COMPLETE' });
  await s1.brain.missionEnded(done);
  await s1.brain.flush(ws1);
  const after = ledgerFiles(clone1);
  const prefixes = Object.entries(before).every(([p, bytes]) => after[p] !== undefined && after[p].subarray(0, bytes.length).equals(bytes));
  check('every ledger file is a byte prefix of its next version', prefixes && Object.keys(before).length > 0, Object.keys(before));
  check('no ledger path was ever written or deleted', badWrites.length === 0, badWrites);
  const listed = s1.brain.entries(ws1, {});
  check('remembered lessons are listed, active', listed.some((e) => e.id === r1.entry.id && e.state === 'active' && e.sourceLabel === 'you' && e.scopeLabel === 'Developer'), listed.map((e) => [e.text, e.state, e.sourceLabel, e.scopeLabel]));
  check('a person vote counts three', listed.find((e) => e.id === r1.entry.id)?.net === 3);
  check('accept and reject are recorded', listed.find((e) => e.id === cand[0].id)?.state === 'accepted' && listed.find((e) => e.id === cand2[0].id)?.state === 'rejected', [cand.length, cand2.length, listed.find((e) => e.id === cand[0]?.id)?.state, listed.find((e) => e.id === cand2[0]?.id)?.state]);
  check('a retired lesson is history, not listed', !listed.some((e) => e.id === r2.entry.id));
  const withHistory = s1.brain.entries(ws1, { includeHistory: true });
  check('the retired lesson shows under history', withHistory.some((e) => e.id === r2.entry.id && e.retired !== null));
  const hist = withHistory.filter((e) => e.kind === 'history');
  check('a finished mission adds one history entry', hist.length === 1 && hist[0].text.startsWith('Ship onboarding — completed.'), hist.map((e) => e.text));
  check('history is not in the default list', !listed.some((e) => e.kind === 'history'));
  const trial = missionFor(H1, 'Trial run', { status: 'COMPLETE', evalTrialId: 'etr_x' });
  H1.r(app.MISSION_REPOSITORY).update(trial, { status: 'COMPLETE' });
  await s1.brain.missionEnded(trial);
  await s1.brain.flush(ws1);
  check('a trial mission adds nothing', s1.brain.entries(ws1, { includeHistory: true }).filter((e) => e.kind === 'history').length === 1);

  // Scrubbing.
  const secret = await s1.brain.remember(c1, ws1, { text: `Use token ghp_${'x'.repeat(36)} for the API.` });
  await s1.brain.flush(ws1);
  check('a token is saved as [redacted secret]', secret.entry.text.includes('[redacted secret]') && !secret.entry.text.includes('ghp_'), secret.entry.text);
  check('the remote never sees ghp_x', !git(remoteDir, 'log', '-p', '--all').includes('ghp_x'));
  let pathRefused = null;
  try { await s1.brain.remember(c1, ws1, { text: 'see /etc/hosts' }); } catch (e) { pathRefused = e.message; }
  check('a machine path is refused with the sentence', pathRefused === "A lesson can't name a path on your machine. Name the file inside its repository instead.", pathRefused);
  let scopeRefused = null;
  try { await s1.brain.remember(c1, ws1, { text: 'Scoped badly.', scope: { paths: ['/home/ana/secret/**'] } }); } catch (e) { scopeRefused = e.message; }
  check('a scope naming a machine path is refused', scopeRefused !== null && scopeRefused.includes('scope'), scopeRefused);
  const relScope = await s1.brain.remember(c1, ws1, { text: 'Scoped well.', scope: { paths: [`${H1.repoDir}/src/**`] } });
  check('a scope inside a repository becomes repo-relative', JSON.stringify(relScope.entry.scope.paths) === JSON.stringify(['src/**']), relScope.entry.scope);

  // Two writers converge.
  await s2.brain.sync(ws2, 'person');
  const mine = [];
  for (const [s, c, w, tag] of [[s1, c1, ws1, 'A'], [s2, c2, ws2, 'B']]) {
    for (let i = 0; i < 3; i++) mine.push({ s, w, e: (await s.brain.remember(c, w, { text: `Writer ${tag} lesson ${i}.` })).entry });
  }
  await s1.brain.sync(ws1, 'person');
  await s2.brain.sync(ws2, 'person');
  await s1.brain.sync(ws1, 'person');
  const bLesson = mine.find((m) => m.e.text === 'Writer B lesson 0.').e.id;
  const aLesson = mine.find((m) => m.e.text === 'Writer A lesson 0.').e.id;
  await s1.brain.vote(c1, bLesson, { vote: 'helpful' });
  await s2.brain.vote(c2, aLesson, { vote: 'harmful' });
  const both = await Promise.all([s1.brain.sync(ws1, 'person'), s2.brain.sync(ws2, 'person')]);
  await s1.brain.sync(ws1, 'person');
  await s2.brain.sync(ws2, 'person');
  const v1 = s1.brain.view(ws1);
  const v2 = s2.brain.view(ws2);
  check('both clones end on the same head', v1.lastPulledSha === v2.lastPulledSha && v1.lastPulledSha !== null, [v1.lastPulledSha, v2.lastPulledSha]);
  const m1 = await s1.brain.memoryAt(ws1, v1.lastPulledSha);
  const m2 = await s2.brain.memoryAt(ws2, v2.lastPulledSha);
  check('both folds are equal', JSON.stringify(m1) === JSON.stringify(m2));
  check('no sync reported a conflict', both.every((v) => !v.problems.some((p) => p.includes('conflicts'))) && v1.problems.every((p) => !p.includes('conflicts')), both.map((v) => v.problems));
  check('votes from both writers counted', m1.entries.find((e) => e.id === bLesson)?.helpful === 3 && m1.entries.find((e) => e.id === aLesson)?.harmful === 3);

  // A protected default branch: lessons go to one standing PR.
  const wsP = (await s1.workspaces.create(c1, { name: 'Guarded', repositoryPath: H1.repoDir })).workspace.id;
  await s1.brain.link(c1, wsP, { mode: 'create', owner: 'garipass', name: 'guarded' });
  const guarded = join(FAKE.remotes, 'garipass', 'guarded.git');
  writeFileSync(join(guarded, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = "refs/heads/main" ]; then echo "GH006: Protected branch update failed" >&2; exit 1; fi; done\nexit 0\n');
  chmodSync(join(guarded, 'hooks', 'pre-receive'), 0o755);
  const ghP = ghLog().length;
  await s1.brain.remember(c1, wsP, { text: 'Guarded lesson one.' });
  await s1.brain.flush(wsP);
  await s1.brain.remember(c1, wsP, { text: 'Guarded lesson two.' });
  await s1.brain.flush(wsP);
  const writer = s1.brain.view(wsP).writerId;
  const prs = ghLog().slice(ghP).filter((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('a protected branch gets exactly one standing PR', prs.length === 1 && prs[0].argv[prs[0].argv.indexOf('--title') + 1] === `Lessons from ${writer}`, prs.map((p) => p.argv));
  check('the lessons are on tandemise/ledger/<writer>', git(guarded, 'log', '--format=%s', `tandemise/ledger/${writer}`).includes(`chore: lessons from ${writer}`));
  const pv = s1.brain.view(wsP);
  check('the Brain section says lessons go to a pull request', pv.status === 'protected' && pv.statusLine.startsWith('Your default branch is protected, so lessons go to a pull request: https://'), pv);
}

// ------------------------------------------------------------------ loading
const runTaskIn = async (h, { key = 'build', role = 'development', steps = [{ kind: 'complete', summary: 'done' }], title = 'Load the brain' } = {}) => {
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const now = () => shared.systemClock.now();
  const profileId = h.r(app.RUNTIME_PROFILE_REPOSITORY).create({
    id: shared.ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: `fake-${Math.random().toString(16).slice(2, 8)}`, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const owner = h.services.team.me(h.caller).memberships.find((m) => m.workspaceId === h.ws).memberId;
  const agent = h.services.team.addMember(h.caller, h.ws, { kind: 'agent', name: `Agent ${profileId.slice(-4)}`, reportsTo: owner, roleIds: [role], runtimeProfileIds: [profileId] }).id;
  const mission = await h.services.missions.create(h.caller, { workspaceId: h.ws, goal: 'Prove the brain loads', title });
  const taskId = shared.ids.task();
  h.r(app.TASK_REPOSITORY).add({
    id: taskId, missionId: mission.id, key, title: key, objective: `Do ${key}`, roleId: role, dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
    retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' }, completionGate: null, status: 'READY', statusReason: null,
    attempts: 0, remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: { assignees: [agent] },
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  });
  h.r(app.MISSION_REPOSITORY).update(mission.id, { status: 'EXECUTING' });
  const scheduler = h.r(app.SCHEDULER);
  for (let i = 0; i < 300; i++) {
    await scheduler.tick();
    const t = h.r(app.TASK_REPOSITORY).get(taskId);
    if (['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(t.status)) break;
    await sleep(40);
  }
  const task = h.r(app.TASK_REPOSITORY).get(taskId);
  const run = h.r(app.RUN_REPOSITORY).listByTask(taskId).at(-1);
  return { mission, task, run, prompt: h.prompts.find((p) => p.taskId === taskId)?.prompt ?? '' };
};

if (H1 !== null && (wants('loading') || wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('loading: rules and lessons in the prompt, runs.brain, one commit per attempt');
  const { services: s1, caller: c1, ws: ws1 } = H1;
  // Home 1's mission repo for a local target needs git in the Tandemise home.
  if (!existsSync(join(H1.paths.root, '.git'))) {
    execFileSync('git', ['init', '-q', '-b', 'main', H1.paths.root]);
    execFileSync('git', ['-C', H1.paths.root, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  }
  s1.workspaces.update(ws1, { knowledge: { productVision: null, architecturePrinciples: null, codingStandards: 'OLD-CODING-STANDARDS-FIELD', designSystem: null, glossary: null } });
  scratchEdit({ 'memory/rules/project.md': '# Project rules\n\nAlways run npm run ci.\n' });
  await s1.brain.sync(ws1, 'person');
  const lesson = await s1.brain.remember(c1, ws1, { text: 'DEV-LESSON: keep components small.', scope: { role: 'development' } });
  await s1.brain.sync(ws1, 'person');
  const view = s1.brain.view(ws1);
  const first = await runTaskIn(H1);
  check('the task ran', first.task.status === 'SUCCEEDED', [first.task.status, first.task.statusReason]);
  check('the prompt has the project rules', first.prompt.includes('Project rules') && first.prompt.includes('Always run npm run ci.'), first.prompt.slice(0, 400));
  check('the prompt has the role lesson', first.prompt.includes('DEV-LESSON: keep components small.'));
  check("the workspace's knowledge field is replaced by the rules", !first.prompt.includes('OLD-CODING-STANDARDS-FIELD'));
  check('runs.brain records the sha the run read', first.run?.brain?.sha === view.lastPulledSha, [first.run?.brain, view.lastPulledSha]);
  check('runs.brain lists the rules file', JSON.stringify(first.run?.brain?.rules) === JSON.stringify(['memory/rules/project.md']), first.run?.brain?.rules);
  check('runs.brain lists the lesson it loaded', first.run?.brain?.loaded.some((l) => l.id === lesson.entry.id));

  // One commit per attempt: a retry in the same round reuses the sha, a new round gets the new one.
  const supply = H1.r(app.BRAIN_CONTEXT_SUPPLY);
  const t = H1.r(app.TASK_REPOSITORY).get(first.task.id);
  const mission = H1.r(app.MISSION_REPOSITORY).get(first.mission.id);
  const role = s1.roles.list(ws1).find((r) => r.id === 'development');
  const repos = H1.r(app.REPO_REPOSITORY).listByWorkspace(ws1);
  scratchEdit({ 'memory/rules/project.md': '# Project rules\n\nAlways run npm run ci.\n\nNEW-RULE-AFTER-RUN.\n' });
  await s1.brain.sync(ws1, 'person');
  const retry = await supply.forAttempt({ task: t, mission, role, repositories: repos, round: t.round ?? 1, previousRuns: [first.run], trial: null });
  check('a retry in the same round reads the same commit', retry?.record.sha === first.run.brain.sha && !retry.request.rules.some((r) => r.text.includes('NEW-RULE-AFTER-RUN')), retry?.record.sha);
  const next = await supply.forAttempt({ task: { ...t, round: 2 }, mission, role, repositories: repos, round: 2, previousRuns: [first.run], trial: null });
  check('a new round reads the new commit', next?.record.sha === s1.brain.view(ws1).lastPulledSha && next.request.rules.some((r) => r.text.includes('NEW-RULE-AFTER-RUN')), next?.record.sha);

  // Under budget pressure the lessons go before the rules.
  const { createContextCompiler } = await import('@tandemise/context');
  const compiler = createContextCompiler();
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `w:${i}`, text: `Lesson ${i}: ${'z'.repeat(180)}`, net: 0 }));
  const baseReq = {
    role, workspaceName: 'Garipass', knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
    mission, task: t, dependencyArtifacts: [], decisions: [], evidence: [], grants: [], outputContract: { artifacts: [], workingDirectory: '/w', completionGate: null, notes: [] },
  };
  const tight = compiler.compile({ ...baseReq, maxChars: 6000, brain: { sha: 'abc', rules: [{ path: 'memory/rules/project.md', text: 'Always run npm run ci.' }], lessons: many, index: [] } });
  check('under pressure the lessons are summarized or dropped', tight.truncated.some((x) => x.section === 'Lessons from earlier work'), tight.truncated);
  check('and the rules stay', tight.prompt.includes('Project rules') && tight.prompt.includes('Always run npm run ci.'));
  check('with no brain the prompt is byte-identical', compiler.compile(baseReq).prompt === compiler.compile({ ...baseReq, brain: undefined }).prompt);

  // Rules are capped, per file and in total, with a pointer to brain.read.
  const capped = app.capRules([{ path: 'memory/rules/project.md', text: 'p'.repeat(10_000) }, ...[1, 2, 3].map((n) => ({ path: `memory/rules/repo-${n}.md`, text: 'r'.repeat(7_000) }))]);
  check('a long rules file is cut at 8,000 with a brain.read pointer', capped[0].text.length < 8_300 && capped[0].text.includes('brain.read("memory/rules/project.md")'));
  check('the total stays under 24,000 and names what did not fit', capped.reduce((n, r) => n + r.text.length, 0) <= 24_400 && capped.at(-1).text.includes('"memory/rules/repo-3.md"'), capped.map((r) => [r.path, r.text.length]));

  // Trials read their frozen knowledge, or only a candidate's rules.
  const trialOff = await supply.forAttempt({ task: t, mission, role, repositories: repos, round: 1, previousRuns: [], trial: { role, knowledge: baseReq.knowledge, decisions: [], answers: [] } });
  check('a trial without brain rules gets no brain', trialOff === undefined);
  const trialOn = await supply.forAttempt({ task: t, mission, role, repositories: repos, round: 1, previousRuns: [], trial: { role, knowledge: baseReq.knowledge, decisions: [], answers: [], brainRules: [{ path: 'memory/rules/project.md', text: 'CANDIDATE RULE' }] } });
  check('a trial with brain rules gets rules only', trialOn?.request.rules[0]?.text === 'CANDIDATE RULE' && trialOn.request.lessons.length === 0 && trialOn.request.index.length === 0, trialOn?.request);
}

// ------------------------------------------------------------------ tools
if (H1 !== null && (wants('tools') || wants('signals') || wants('promotion') || wants('intake'))) {
  section('tools: brain.read, brain.search, brain.propose, and what each run knew');
  const { services: s1, caller: c1, ws: ws1 } = H1;
  // A case in the brain's evals/ that nothing an agent sees may ever contain.
  scratchEdit({ 'evals/cases/c1/case.json': '{"marker":"SECRET-EVAL-MARKER"}\n' });
  await s1.brain.sync(ws1, 'person');
  const npmLesson = await s1.brain.remember(c1, ws1, { text: 'NPM: run npm ci, not npm install, in CI.', scope: { role: 'development' } });
  await s1.brain.sync(ws1, 'person');
  const ran = await runTaskIn(H1, { title: 'Tools run' });
  check('the tools run succeeded', ran.task.status === 'SUCCEEDED', [ran.task.status, ran.task.statusReason]);
  const { BUILT_IN_TOOLS } = await import('@tandemise/integrations-core');
  const tools = Object.fromEntries(H1.container.resolveAll(BUILT_IN_TOOLS).filter((t) => t.name.startsWith('brain.')).map((t) => [t.name, t]));
  check('three brain tools are built in, read-only, on repository.read', ['brain.read', 'brain.search', 'brain.propose'].every((n) => tools[n]?.capability === 'repository.read' && tools[n]?.risk === 'read'), Object.keys(tools));
  const assignment = H1.r(app.ASSIGNMENT_REPOSITORY).get(ran.run.assignmentId);
  const ctx = { assignment, assignmentId: assignment.id, runId: ran.run.id, workingDirectory: H1.home, logger: quiet, exec: { run: async () => ({}) }, signal: new AbortController().signal };
  const call = async (name, input) => { try { return (await tools[name].execute(ctx, tools[name].inputSchema.parse(input))).output; } catch (e) { return { thrown: e.message }; } };
  const outputs = [];
  const read = await call('brain.read', { id: npmLesson.entry.id });
  outputs.push(read);
  check('brain.read returns the lesson', read?.entry?.text === 'NPM: run npm ci, not npm install, in CI.' && Array.isArray(read.history), read);
  check('and records it as fetched on the run', H1.r(app.RUN_REPOSITORY).get(ran.run.id).brain?.fetched.includes(npmLesson.entry.id));
  const search = await call('brain.search', { query: 'npm' });
  outputs.push(search);
  check('brain.search finds at most 20, each matching', Array.isArray(search?.results) && search.results.length >= 1 && search.results.length <= 20 && search.results.every((r) => r.text.toLowerCase().includes('npm')), search);
  const proposed = [];
  for (let i = 0; i < 6; i++) proposed.push(await call('brain.propose', { text: `Proposal ${i}: cache node_modules.`, scope: { role: 'development' } }));
  outputs.push(...proposed);
  const runBrain = H1.r(app.RUN_REPOSITORY).get(ran.run.id).brain;
  check('five proposals are recorded on the run', runBrain?.proposed.length === 5, runBrain?.proposed);
  check('the sixth is refused in words', proposed[5]?.message === "You've proposed 5 lessons in this run; that's the limit.", proposed[5]);
  check('a proposal is a candidate from an agent', s1.brain.entries(ws1, {}).some((e) => e.id === runBrain?.proposed[0] && e.state === 'candidate' && e.sourceLabel === 'an agent'));
  const evalRead = await call('brain.read', { id: 'evals/cases/c1/case.json' });
  outputs.push(evalRead);
  check('brain.read of an evals path is just an unknown id', evalRead?.message === 'No lesson with that id in this brain.', evalRead);
  outputs.push(await call('brain.search', { query: 'SECRET' }), await call('brain.search', { query: 'marker' }));
  const view = await s1.brain.runBrain(ran.run.id);
  check('no tool result, prompt or run view contains anything from evals/', ![...outputs, view].some((o) => JSON.stringify(o).includes('SECRET-EVAL-MARKER')) && !H1.prompts.some((p) => p.prompt.includes('SECRET-EVAL-MARKER')));
  const NOTE = 'If you learned something the next person doing this step should know, call brain.propose with one short sentence.';
  const listsPropose = /Integration tools available to you:[^\n]*brain\.propose/.test(ran.prompt);
  check('the run was offered brain.propose', listsPropose, ran.prompt.match(/Integration tools available to you:[^\n]*/)?.[0]);
  check("the prompt's contract notes carry the brain.propose line once", ran.prompt.split(NOTE).length === 2);
  const unlinked = (await s1.workspaces.create(c1, { name: 'No brain', repositoryPath: H1.repoDir })).workspace.id;
  const bare1 = await runTaskIn({ ...H1, ws: unlinked }, { title: 'No brain run' });
  check('without a brain there is no brain.propose line', bare1.task.status === 'SUCCEEDED' && !bare1.prompt.includes(NOTE) && bare1.run.brain === null, [bare1.task.status, bare1.run?.brain]);
  check('the run view summarises what it knew', view.summary === 'Loaded 1 rules file and 2 lessons; read 1 more.' || /^Loaded 1 rules file and \d+ lessons?; read 1 more\.$/.test(view.summary), view.summary);
  check('the run view lists the fetched lesson and the proposals', view.fetched.some((e) => e.id === npmLesson.entry.id) && view.proposed.length === 5 && view.shortSha === view.sha.slice(0, 7));
}

// ------------------------------------------------------------------ signals
if (H1 !== null && (wants('signals') || wants('promotion') || wants('intake'))) {
  section('signals: holds, rejections and gates become lessons through the reflector');
  const { services: s1, caller: c1, ws: ws1 } = H1;
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const now = () => shared.systemClock.now();
  const fence = (obj) => `Here is what I learned.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
  const reply = (marker, obj) => ({ kind: 'message', text: typeof obj === 'string' ? obj : fence(obj), when: { promptIncludes: marker } });
  const reflectorProfile = H1.r(app.RUNTIME_PROFILE_REPOSITORY).create({
    id: shared.ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'reflector', executablePath: null, args: [],
    settings: { script: { steps: [
      reply('HOLD-DIFF-LINE', { lessons: [{ text: 'Keep the header sticky on mobile.', scope: { role: 'development' } }], tags: [] }),
      reply('design tokens', { lessons: [{ text: 'Use the design tokens, never hex colours.', scope: { role: 'development' } }], tags: [] }),
      reply('GATE-FIXED', { lessons: [{ text: 'Run the migrations before the tests.', scope: { step: 'build' } }], tags: [] }),
      reply('VOTE-ME', { lessons: [], tags: [{ id: '__LOADED__', tag: 'harmful' }] }),
      reply('SAY-SECRET', { lessons: [{ text: 'Set API_KEY=abcd1234 first.', scope: {} }], tags: [] }),
      reply('BROKEN-JSON', 'not json'),
      { kind: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      { kind: 'complete', summary: 'reflected' },
    ] } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  s1.workspaces.update(ws1, { routing: { development: [reflectorProfile] } });
  const signals = H1.r(app.BRAIN_SIGNALS);
  await signals.start();
  const learned = () => H1.published.filter((e) => e.body.type === 'brain.learned');
  const passes = () => H1.r(app.BRAIN_RECORD_REPOSITORY).passes(ws1, '2000-01-01T00:00:00.000Z');
  const promptOf = (pass) => { const f = join(H1.paths.workspace(ws1), 'brain-passes', pass.id, 'prompt.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
  const publish = (mission, task, body) => H1.r(app.EVENT_RECORDER).record({ workspaceId: ws1, missionId: mission.id, taskId: task.id }, body);

  // A hold: the person changed a file in the worktree, then pressed Continue.
  const held = await runTaskIn(H1, { title: 'Held mission' });
  const workdir = H1.r(app.EXECUTION_TARGET_REPOSITORY).get(held.run.executionTargetId).workingDirectory;
  writeFileSync(join(workdir, 'held-change.txt'), `HOLD-DIFF-LINE and a token ghp_${'h'.repeat(36)}\n`);
  if (!existsSync(join(workdir, '.git'))) { git(workdir, 'init', '-q', '-b', 'main'); }
  git(workdir, 'add', '-N', 'held-change.txt');
  const passesBefore = passes().length;
  publish(held.mission, held.task, { type: 'task.hold_ended', holdId: 'hold_1', ending: 'continued', endedBy: null, sessionAfter: null, durationMs: 30_000, diffStat: { files: 1, insertions: 1, deletions: 0 } });
  await signals.idle();
  const holdPass = passes().slice(passesBefore);
  check('a hold runs the reflector once', holdPass.length === 1 && holdPass[0].kind === 'reflect' && holdPass[0].status === 'ok', holdPass);
  check("the reflector's evidence has the worktree diff", promptOf(holdPass[0]).includes('HOLD-DIFF-LINE'));
  const holdLesson = s1.brain.entries(ws1, {}).find((e) => e.text === 'Keep the header sticky on mobile.');
  check('the hold made an active lesson from your hold', holdLesson?.state === 'active' && holdLesson.sourceLabel === 'your hold', holdLesson);
  check('a brain.learned event names it', learned().some((e) => e.body.text === 'Keep the header sticky on mobile.' && e.body.signal === 'hold'));

  const p2 = passes().length;
  publish(held.mission, held.task, { type: 'task.hold_ended', holdId: 'hold_2', ending: 'released', endedBy: null, sessionAfter: null, durationMs: 30_000, diffStat: { files: 0, insertions: 0, deletions: 0 } });
  await signals.idle();
  check('a short released hold with no diff runs nothing', passes().length === p2);

  // A rejection: a request-changes round with a note.
  const rejected = await runTaskIn(H1, { title: 'Rejected mission' });
  const note = H1.r(app.FEEDBACK_REPOSITORY).create({ id: shared.ids.feedback(), taskId: rejected.task.id, artifactId: null, authorId: 'mem_x', recordedBy: 'mem_x', text: 'Use the design tokens, not hex colours.', attachments: [], status: 'open', round: 2, createdAt: now(), updatedAt: now() });
  const p3 = passes().length;
  publish(rejected.mission, rejected.task, { type: 'task.round_started', round: 2, feedbackIds: [note.id], downstream: 'none', redone: [] });
  await signals.idle();
  const rejPass = passes().slice(p3)[0];
  check('the rejection note reaches the reflector', rejPass !== undefined && promptOf(rejPass).includes('Use the design tokens, not hex colours.'));
  const rejLesson = s1.brain.entries(ws1, {}).find((e) => e.text === 'Use the design tokens, never hex colours.');
  check('it made an active lesson from the change you asked for', rejLesson?.state === 'active' && rejLesson.sourceLabel === 'a change you asked for', rejLesson);

  // A gate that failed, then passed: a candidate.
  const gated = await runTaskIn(H1, { title: 'Gated mission' });
  const secondRun = H1.r(app.RUN_REPOSITORY).create({ ...gated.run, id: shared.ids.run(), attempt: gated.run.attempt + 1 });
  const score = (attempt, passed) => ({ runId: attempt === 1 ? gated.run.id : secondRun.id, taskId: gated.task.id, missionId: gated.mission.id, workspaceId: ws1, roleId: 'development', model: null, skills: [], attempt, round: 1, purpose: null, gatePassed: passed, gateDetail: passed ? 'ok' : 'GATE-FIXED: tests failed', facts: { 'checks.tests': passed ? 'PASS' : 'FAIL' }, criteria: null, overBudget: 0, inputTokens: null, outputTokens: null, costUsd: null, wallTimeMs: null, evalTrial: false, scoredAt: now() });
  H1.r(app.RUN_SCORE_REPOSITORY).insert(score(1, false));
  H1.r(app.RUN_SCORE_REPOSITORY).insert(score(2, true));
  publish(gated.mission, gated.task, { type: 'gate.evaluated', gate: 'checks.tests == PASS', passed: true });
  await signals.idle();
  const gateLesson = s1.brain.entries(ws1, {}).find((e) => e.text === 'Run the migrations before the tests.');
  check('a gate that failed then passed is a candidate', gateLesson?.state === 'candidate' && gateLesson.sourceLabel === 'a failed check', gateLesson);
  check('a candidate does not load until confirmed elsewhere', gateLesson !== undefined && !D.isLoadable(s1.brain.memory(ws1).entries.find((e) => e.id === gateLesson.id), now()));

  // Votes from the reflector's tags on what the run loaded.
  const voted = await runTaskIn(H1, { title: 'VOTE-ME mission' });
  const loadedId = voted.run.brain?.loaded[0]?.id;
  const before = s1.brain.memory(ws1).entries.find((e) => e.id === loadedId)?.harmful ?? 0;
  const refl = H1.r(app.RUNTIME_PROFILE_REPOSITORY).get(reflectorProfile);
  const steps = refl.settings.script.steps.map((s) => (s.when?.promptIncludes === 'VOTE-ME' ? { ...s, text: s.text.replace('__LOADED__', loadedId) } : s));
  H1.r(app.RUNTIME_PROFILE_REPOSITORY).update(reflectorProfile, { settings: { script: { steps } } });
  const vnote = H1.r(app.FEEDBACK_REPOSITORY).create({ id: shared.ids.feedback(), taskId: voted.task.id, artifactId: null, authorId: 'mem_x', recordedBy: 'mem_x', text: 'VOTE-ME please.', attachments: [], status: 'open', round: 2, createdAt: now(), updatedAt: now() });
  publish(voted.mission, voted.task, { type: 'task.round_started', round: 2, feedbackIds: [vnote.id], downstream: 'none', redone: [] });
  await signals.idle();
  check('a harmful tag is one reflector vote', loadedId !== undefined && (s1.brain.memory(ws1).entries.find((e) => e.id === loadedId)?.harmful ?? 0) === before + 1, [loadedId, before]);

  // A failure never blocks the task.
  const broken = await runTaskIn(H1, { title: 'Broken mission' });
  const bnote = H1.r(app.FEEDBACK_REPOSITORY).create({ id: shared.ids.feedback(), taskId: broken.task.id, artifactId: null, authorId: 'mem_x', recordedBy: 'mem_x', text: 'BROKEN-JSON here.', attachments: [], status: 'open', round: 2, createdAt: now(), updatedAt: now() });
  const entriesBefore = s1.brain.memory(ws1).entries.length;
  const p5 = passes().length;
  publish(broken.mission, broken.task, { type: 'task.round_started', round: 2, feedbackIds: [bnote.id], downstream: 'none', redone: [] });
  await signals.idle();
  const bad = passes().slice(p5)[0];
  check('invalid JSON is a failed pass with a reason', bad?.status === 'failed' && typeof bad.reason === 'string' && bad.reason.length > 0, bad);
  check('and nothing is written', s1.brain.memory(ws1).entries.length === entriesBefore);
  check('the task is untouched', H1.r(app.TASK_REPOSITORY).get(broken.task.id).status === broken.task.status);

  // Scrubbing on the way in.
  const secretRun = await runTaskIn(H1, { title: 'Secret mission' });
  const snote = H1.r(app.FEEDBACK_REPOSITORY).create({ id: shared.ids.feedback(), taskId: secretRun.task.id, artifactId: null, authorId: 'mem_x', recordedBy: 'mem_x', text: 'SAY-SECRET now.', attachments: [], status: 'open', round: 2, createdAt: now(), updatedAt: now() });
  publish(secretRun.mission, secretRun.task, { type: 'task.round_started', round: 2, feedbackIds: [snote.id], downstream: 'none', redone: [] });
  await signals.idle();
  await s1.brain.sync(ws1, 'person');
  check('a secret in reflector output is saved redacted', s1.brain.entries(ws1, {}).some((e) => e.text.startsWith('Set API_KEY=') && e.text.includes('[redacted secret]')), s1.brain.entries(ws1, {}).filter((e) => e.text.includes('API_KEY')).map((e) => e.text));
  const log = git(remoteDir, 'log', '-p', '--all');
  check('the remote never sees the reflector secret or the hold token', !log.includes('abcd1234') && !log.includes('ghp_hhhh'));

  // Trials teach nothing.
  const trialMission = missionFor(H1, 'Trial mission', { evalTrialId: 'etr_trial' });
  const p6 = passes().length;
  H1.r(app.EVENT_RECORDER).record({ workspaceId: ws1, missionId: trialMission, taskId: held.task.id }, { type: 'task.round_started', round: 2, feedbackIds: [note.id], downstream: 'none', redone: [] });
  await signals.idle();
  check('a trial round runs no reflector', passes().length === p6);
  check('every reflector prompt is free of evals/', passes().every((p) => !promptOf(p).includes('SECRET-EVAL-MARKER')));
  check('the reflector spends on the economy model and counts its usage', passes().some((p) => p.usage?.costUsd === 0.01));
  await signals.stop();
}

// ------------------------------------------------------------------ promotion
if (H1 !== null && (wants('promotion') || wants('intake'))) {
  section('promotion: eligibility, the promoter, evals, auto-apply, PRs and their fate');
  const { services: s1, caller: c1 } = H1;
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const now = () => shared.systemClock.now();
  const promoRemote = join(FAKE.remotes, 'garipass', 'promo.git');
  const wsP = (await s1.workspaces.create(c1, { name: 'Promo', repositoryPath: H1.repoDir })).workspace.id;
  await s1.brain.link(c1, wsP, { mode: 'create', owner: 'garipass', name: 'promo' });
  const promoterProfile = H1.r(app.RUNTIME_PROFILE_REPOSITORY).create({
    id: shared.ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'promoter', executablePath: null, args: [],
    settings: { script: { steps: [{ kind: 'message', text: 'unset' }, { kind: 'complete' }] } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  s1.workspaces.update(wsP, { routing: { development: [promoterProfile], architecture: [promoterProfile], review: [promoterProfile] } });
  const promoterSays = (files) => H1.r(app.RUNTIME_PROFILE_REPOSITORY).update(promoterProfile, { settings: { script: { steps: [
    { kind: 'message', text: `\`\`\`json\n${JSON.stringify({ files })}\n\`\`\`` }, { kind: 'complete' },
  ] } } });
  const taskIn = (title) => {
    const missionId = shared.ids.mission();
    H1.r(app.MISSION_REPOSITORY).create({ id: missionId, workspaceId: wsP, repositoryId: null, title, goal: 'g', constraints: [], successCriteria: [] });
    const taskId = shared.ids.task();
    H1.r(app.TASK_REPOSITORY).add({ id: taskId, missionId, key: 'build', title: 'build', objective: 'o', roleId: 'development', dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [], executionPolicy: { isolation: 'none', maxWallTimeMs: 1000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' }, completionGate: null, status: 'SUCCEEDED', statusReason: null, attempts: 1, remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 0, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null });
    return taskId;
  };
  const tA = taskIn('Mission A');
  const tB = taskIn('Mission B');
  const tC = taskIn('Mission C');
  const evalStub = { result: null, calls: [], async run(ws, suites, ref) { this.calls.push({ suites, ref }); return this.result; } };
  H1.container.rebind(app.BRAIN_PROMOTION_EVALS, () => evalStub, { source: 'check' });
  const scoreOf = (pass, cost = 1, failed = 0) => ({ gatePassRate: pass, firstAttemptPassRate: pass, criteria: { verified: 1, failed, unverified: 0 }, meanAttempts: 1, overBudget: 0, tokens: { mean: 1, total: 1 }, costUsd: { mean: cost, total: cost }, wallTimeMs: { mean: 1, total: 1 }, trials: { completed: 1, blocked: 0, failed: 0, errored: 0 } });
  const card = (cand, base = scoreOf(1)) => ({ baseline: base, candidate: cand, difference: {}, perCase: [], fewRepeats: true });
  const lessonFor = async (text, scope = { role: 'development' }) => {
    const r = await s1.brain.remember(c1, wsP, { text, scope });
    await s1.brain.vote(c1, r.entry.id, { vote: 'helpful', taskId: tA });
    await s1.brain.vote(c1, r.entry.id, { vote: 'helpful', taskId: tB });
    await s1.brain.vote(c1, r.entry.id, { vote: 'helpful', taskId: tB });
    return r.entry.id;
  };
  const mainOf = () => git(promoRemote, 'rev-parse', 'main').trim();

  // 1. No suite: a PR saying "Not evaluated", even with autoApply: small.
  scratchEditOn(promoRemote, { 'brain.yaml': (t) => t.replace('autoApply: off', 'autoApply: small') });
  await s1.brain.sync(wsP, 'person');
  const l1 = await lessonFor('PROMO-ONE: write the test first.');
  check('three thumbs-up across two missions make it eligible', s1.brain.eligiblePromotions(wsP).some((b) => b.lessonIds.includes(l1)), s1.brain.eligiblePromotions(wsP));
  const current1 = '';
  promoterSays([{ path: 'memory/rules/role-development.md', content: `${current1}# Developer\n\n- Write the test first.\n` }]);
  const before1 = mainOf();
  const g1 = ghLog().length;
  const [p1] = await s1.brain.proposePromotions(wsP);
  const pr1 = ghLog().slice(g1).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('with no suite a PR is opened, not applied', p1?.state === 'open' && p1.verdict === 'not_evaluated' && pr1 !== undefined, p1);
  check('the PR body names the lesson and says Not evaluated', pr1?.stdin.includes('PROMO-ONE: write the test first.') && pr1.stdin.includes('Not evaluated: this project has no promotion evals yet.'), pr1?.stdin);
  check('the rule does not reach main', (() => { try { git(promoRemote, 'show', 'main:memory/rules/role-development.md'); return false; } catch { return true; } })());
  check('the lesson shows as promoted', s1.brain.entries(wsP, {}).find((e) => e.id === l1)?.promoted?.pr === p1?.prUrl);

  // 2. Small and passing, with autoApply: small and a suite.
  scratchEditOn(promoRemote, { 'evals/gates.yaml': 'suites:\n  - name: smoke\n    repeats: 1\n    spendCapUsd: 2\nrule:\n  maxCostFactor: 1.25\n' });
  await s1.brain.sync(wsP, 'person');
  const l2 = await lessonFor('PROMO-TWO: keep functions short.', { repo: 'code' });
  evalStub.result = [{ suite: 'smoke', scorecard: card(scoreOf(1)), problem: null }];
  promoterSays([{ path: 'memory/rules/repo-code.md', content: '# code\n\n- Keep functions short.\n' }]);
  const before2 = mainOf();
  const all2 = await s1.brain.proposePromotions(wsP);
  const [p2] = all2.filter((p) => p.lessonIds.includes(l2));
  const msg2 = p2?.appliedSha ? git(promoRemote, 'show', '-s', '--format=%B', p2.appliedSha) : '';
  const onMain = p2?.appliedSha ? (() => { try { git(promoRemote, 'merge-base', '--is-ancestor', p2.appliedSha, 'main'); return true; } catch { return false; } })() : false;
  check('a small passing promotion applies on its own', p2?.state === 'applied' && mainOf() !== before2 && onMain && git(promoRemote, 'show', 'main:memory/rules/repo-code.md').includes('Keep functions short.'), p2);
  check('its commit carries the trailers', msg2.includes(`Tandemise-Promotion: ${p2?.id}`) && msg2.includes('Tandemise-Eval:'), msg2);
  const promoterPrompts = H1.r(app.BRAIN_RECORD_REPOSITORY).passes(wsP, '2000-01-01T00:00:00.000Z').filter((x) => x.kind === 'promote')
    .map((x) => { const f = join(H1.paths.workspace(wsP), 'brain-passes', x.id, 'prompt.md'); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
  check('the promoter ran and never saw evals/', promoterPrompts.length >= 2 && promoterPrompts.every((t) => t !== null && !t.includes('spendCapUsd') && !t.includes('SECRET-EVAL-MARKER')), promoterPrompts.length);
  const reverted = await s1.brain.revertProposal(c1, p2.id);
  check('revert adds a revert commit', reverted.state === 'reverted' && git(promoRemote, 'log', '-1', '--format=%s', 'main').startsWith('Revert promotion'), reverted);

  // 3. Structural: a role's model changes. A PR even when passing.
  const roleNow = git(promoRemote, 'show', 'main:factory/roles/development.md');
  const l3 = await lessonFor('PROMO-THREE: use the stronger model for builds.', { role: 'development', step: 'build' });
  promoterSays([{ path: 'memory/rules/project.md', content: `${git(promoRemote, 'show', 'main:memory/rules/project.md')}\n- Use the stronger model.\n` }, { path: 'factory/roles/development.md', content: withModel(roleNow, 'stronger-model') }]);
  const g3 = ghLog().length;
  const p3 = (await s1.brain.promoteEntry(c1, l3, { target: 'role' }));
  const pr3 = ghLog().slice(g3).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('a structural promotion is a PR even when passing', p3?.state === 'open' && p3.classification === 'structural', p3);
  check("its Classification names the role's settings", pr3?.stdin.includes('## Classification') && pr3.stdin.includes("Changes development's settings"), pr3?.stdin);

  // 4. Failing evals: a draft.
  const l4 = await lessonFor('PROMO-FOUR: lint before commit.', { repo: 'other' });
  evalStub.result = [{ suite: 'smoke', scorecard: card(scoreOf(0.5)), problem: null }];
  promoterSays([{ path: 'memory/rules/repo-other.md', content: '# other\n\n- Lint before commit.\n' }]);
  const g4 = ghLog().length;
  const p4 = (await s1.brain.proposePromotions(wsP)).find((p) => p.lessonIds.includes(l4));
  const pr4 = ghLog().slice(g4).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create');
  check('a failing promotion opens a draft titled Did not pass evals', p4?.state === 'draft' && pr4?.argv.includes('--draft') && pr4.argv[pr4.argv.indexOf('--title') + 1].startsWith('Did not pass evals: '), pr4?.argv);

  // 5. Refused: the promoter touched evals/.
  const l5 = await lessonFor('PROMO-FIVE: never relax the gate.', { role: 'review' });
  promoterSays([{ path: 'evals/gates.yaml', content: 'suites: []\n' }]);
  const g5 = ghLog().length;
  const p5 = (await s1.brain.proposePromotions(wsP)).find((p) => p.lessonIds.includes(l5));
  check('a promotion touching evals/ is refused: no branch, no PR', p5 === undefined && ghLog().slice(g5).every((l) => l.argv[1] !== 'create') && !git(promoRemote, 'branch', '--list').includes(`promote/${app.promotionId([l5])}`), p5);
  check('and a note says why', s1.brain.view(wsP).problems.some((p) => p.includes('The evals folder can only be changed by a person.')), s1.brain.view(wsP).problems);

  // 6. Two daemons, the same lessons: one PR.
  const wsQ = (await H2.services.workspaces.create(H2.caller, { name: 'Promo too', repositoryPath: H2.repoDir })).workspace.id;
  const pq = await H2.services.brain.link(H2.caller, wsQ, { mode: 'adopt', remote: 'github.com/garipass/promo' });
  await H2.services.brain.applyAdopt(H2.caller, wsQ, { hash: pq.hash, choices: {} });
  await s1.brain.sync(wsP, 'person');
  await H2.services.brain.sync(wsQ, 'person');
  const g6 = ghLog().length;
  const adopted = await H2.services.brain.proposeLessons(wsQ, [l1]);
  check('the second daemon adopts the open PR (same id and branch)', adopted?.id === p1.id && adopted.branch === p1.branch && adopted.prUrl === p1.prUrl && ghLog().slice(g6).every((l) => l.argv[1] !== 'create'), adopted);

  // 7. Fate: the PR was closed unmerged.
  writeFileSync(join(FAKE.state, String(Number(/pull\/(\d+)/.exec(p1.prUrl)[1]))), 'CLOSED');
  await s1.brain.sync(wsP, 'person');
  check('a closed PR is closed with reject events', s1.brain.proposals(wsP).find((p) => p.id === p1.id)?.state === 'closed' && s1.brain.entries(wsP, {}).find((e) => e.id === l1)?.promoted === null);
  check('the lesson is not eligible again until +3 net', !s1.brain.eligiblePromotions(wsP).some((b) => b.lessonIds.includes(l1)));
  await s1.brain.vote(c1, l1, { vote: 'helpful', taskId: tC });
  check('one more thumbs-up (+3) makes it eligible again', s1.brain.eligiblePromotions(wsP).some((b) => b.lessonIds.includes(l1)));

  // 9. A secret in the promoter's draft never reaches the brain.
  const l9 = await lessonFor('PROMO-NINE: rotate keys.', { repo: 'nine' });
  evalStub.result = null;
  promoterSays([{ path: 'memory/rules/repo-nine.md', content: `# nine\n\n- Rotate keys; the old one was ghp_${'k'.repeat(36)}.\n` }]);
  scratchEditOn(promoRemote, { 'evals/gates.yaml': 'suites: []\n' });
  await s1.brain.sync(wsP, 'person');
  const p9 = (await s1.brain.proposePromotions(wsP)).find((p) => p.lessonIds.includes(l9));
  check('a promoter draft is scrubbed before it is committed', p9 !== undefined && !git(promoRemote, 'log', '-p', '--all').includes('ghp_kkk') && git(promoRemote, 'show', `${p9.branch}:memory/rules/repo-nine.md`).includes('[redacted secret]'), p9);

  // 10. A teammate edits the target while the promotion is evaluated: no auto-apply, a PR instead.
  scratchEditOn(promoRemote, { 'evals/gates.yaml': 'suites:\n  - name: smoke\n    repeats: 1\n    spendCapUsd: 2\n' });
  await s1.brain.sync(wsP, 'person');
  const l10 = await lessonFor('PROMO-TEN: name tests after behaviour.', { repo: 'ten' });
  scratchEditOn(promoRemote, { 'memory/rules/repo-ten.md': '# ten\n\n- A teammate wrote this first.\n' });
  await s1.brain.sync(wsP, 'person');
  promoterSays([{ path: 'memory/rules/repo-ten.md', content: '# ten\n\n- A teammate wrote this first.\n- Name tests after behaviour.\n' }]);
  evalStub.result = [{ suite: 'smoke', scorecard: card(scoreOf(1)), problem: null }];
  const realRun = evalStub.run.bind(evalStub);
  evalStub.run = async (...args) => {
    scratchEditOn(promoRemote, { 'memory/rules/repo-ten.md': '# ten\n\n- A teammate wrote this first.\n- And another line meanwhile.\n' });
    await s1.brain.sync(wsP, 'person');
    return realRun(...args);
  };
  const p10 = (await s1.brain.proposePromotions(wsP)).find((p) => p.lessonIds.includes(l10));
  evalStub.run = realRun;
  const ten = git(promoRemote, 'show', 'main:memory/rules/repo-ten.md');
  check('a target that moved during evals is not applied on its own', p10 !== undefined && p10.state === 'open' && p10.prUrl !== null, p10);
  check("the teammate's line on main survives", ten.includes('And another line meanwhile.') && !ten.includes('Name tests after behaviour.'), ten);
  const l11 = await lessonFor('PROMO-ELEVEN: one change per commit.', { repo: 'eleven' });
  scratchEditOn(promoRemote, { 'memory/rules/repo-eleven.md': '# eleven\n\n- Keep this line.\n' });
  await s1.brain.sync(wsP, 'person');
  // The promoter drafted from an older file and leaves the teammate's line out.
  promoterSays([{ path: 'memory/rules/repo-eleven.md', content: '# eleven\n\n- One change per commit.\n' }]);
  const p11 = (await s1.brain.proposePromotions(wsP)).find((p) => p.lessonIds.includes(l11));
  check('a draft that drops a line on the current file is structural, a PR', p11?.classification === 'structural' && p11.state === 'open' && git(promoRemote, 'show', 'main:memory/rules/repo-eleven.md').includes('Keep this line.'), p11);

  // 8. Local-only: accept merges locally.
  const wsL = (await s1.workspaces.create(c1, { name: 'Local promo', repositoryPath: H1.repoDir })).workspace.id;
  await s1.brain.link(c1, wsL, { mode: 'local' });
  s1.workspaces.update(wsL, { routing: { development: [promoterProfile] } });
  const rl = await s1.brain.remember(c1, wsL, { text: 'PROMO-LOCAL: small commits.', scope: { role: 'development' } });
  promoterSays([{ path: 'memory/rules/role-development.md', content: '# Developer\n\n- Small commits.\n' }]);
  const pl = await s1.brain.promoteEntry(c1, rl.entry.id, {});
  check('a local-only proposal waits as open', pl?.state === 'open' && pl.prUrl === null, pl);
  const accepted = await s1.brain.acceptProposal(c1, pl.id);
  const localClone = H1.r(app.WORKSPACE_BRAIN_REPOSITORY).get(wsL).clonePath;
  check('accept merges it locally', accepted.state === 'accepted' && git(localClone, 'show', 'main:memory/rules/role-development.md').includes('Small commits.'), accepted);
}

// ------------------------------------------------------------------ intake config
if (H1 !== null && wants('intake')) {
  section("intake config: the brain serves intake's tracker and sources (#52's IntakeConfigSource)");
  const { services: s1, caller: c1, ws: ws1 } = H1;
  const source = H1.r(app.BRAIN_INTAKE_CONFIG);
  const wsNone = (await s1.workspaces.create(c1, { name: 'No brain intake', repositoryPath: H1.repoDir })).workspace.id;
  check('with no brain it is the local source (defaults here) and says local', JSON.stringify(source.read(wsNone)) === JSON.stringify(app.INTAKE_DEFAULTS) && source.originFor(wsNone) === 'local');
  const tracker = 'tracker:\n  kind: youtrack\n  url: https://yt.example\n  project: GAR\n  board: "project: GAR"\n  states:\n    ready: [Open]\n    in_progress: In Progress\n    done: [Fixed]\n    wont_do: []\n  onComplete: done\n';
  scratchEdit({ 'factory/tracker.yaml': tracker });
  await s1.brain.sync(ws1, 'person');
  const read = source.read(ws1);
  check('a pushed tracker.yaml is read after sync', read.tracker?.kind === 'youtrack' && read.tracker.states.in_progress === 'In Progress', read);
  check('intake defaults when intake.yaml is missing', read.dailyCap === 20 && read.similarity.link === 0.85 && read.sources.length === 0);
  check('it says brain for a linked project', source.originFor(ws1) === 'brain' && source.origin === 'brain');
  scratchEdit({ 'factory/tracker.yaml': 'tracker:\n  kind: youtrack\n  board: x\n' });
  await s1.brain.sync(ws1, 'person');
  check('a broken tracker.yaml keeps the last good config', source.read(ws1).tracker?.kind === 'youtrack');
  check('and the Brain section names the file first', s1.brain.view(ws1).problems[0]?.startsWith('factory/tracker.yaml:'), s1.brain.view(ws1).problems);
  let refused = null;
  try { source.write(ws1, { tracker: null }); } catch (e) { refused = e.message; }
  check("writing a linked project's intake is refused in words", refused === "Set in this project's brain.", refused);
  const reads = [];
  const realReadAt = s1.brain.readAt.bind(s1.brain);
  s1.brain.readAt = async (ws, sha, path) => { reads.push(path); return realReadAt(ws, sha, path); };
  await s1.brain.remember(c1, ws1, { text: 'Only memory changes here.' });
  await s1.brain.sync(ws1, 'person');
  s1.brain.readAt = realReadAt;
  check('a sync that changed only memory/ does not re-read either file', !reads.some((p) => p === 'factory/tracker.yaml' || p === 'factory/intake.yaml'), reads.filter((p) => p.startsWith('factory/')));
}

// ------------------------------------------------------------------ end
rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
