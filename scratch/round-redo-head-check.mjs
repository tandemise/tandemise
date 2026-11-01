// A redo round moves every redone step onto the new work (#138).
//
//   npm run build && node scratch/round-redo-head-check.mjs
//
// implement → review → QA, each in its own worktree. Review passes; feedback on
// implement starts a round that redoes review and QA. implement commits the fix
// on its own branch. Before the fix, the redone review and QA reused their
// worktrees on the old commit: the reviewer reviewed, and QA verified, code
// without the fix, and their reports named the old commit. Now each redone
// step starts from the upstream step's new head, its report's commit is that
// head, and the ship step refuses a branch that is missing a step's final work.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const isAncestor = (cwd, a, b) => { try { execFileSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };

const keepAlive = setInterval(() => {}, 1000);
const HOME = mkdtempSync(join(tmpdir(), 'trr-'));
const h = await engineHarness(HOME);
const D = await import('@tandemise/domain');
const { systemClock, ids } = await import('@tandemise/shared');
const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
const now = () => systemClock.now();

const caller = { personId: h.services.identity.localPerson().id };
const ws = (await h.services.workspaces.create(caller, { name: 'Redo' })).workspace.id;
const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
const workspaces = h.container.resolve(h.app.WORKSPACE_REPOSITORY);
workspaces.update(ws, { concurrency: { ...workspaces.get(ws).concurrency, maxTotalWorkers: 4 } });
const profile = (name, steps) => h.repo.profiles.create({
  id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
  args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4,
  createdAt: now(), updatedAt: now(),
}).id;
const agentOn = (name, role, profileId) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: [role], runtimeProfileIds: [profileId] }).id;

const front = (type, extra) => ['---', `type: ${type}`, 'schemaVersion: 1', `title: ${type}`, 'handoff:', `  headline: ${type} written`, ...extra, '---', '', `# ${type}`, '', 'Body.', ''].join('\n');
const FIX = 'Use version two';
const TASK = { implement: ids.task(), review: ids.task(), verify: ids.task() };
const implementer = agentOn('Implementer', 'development', profile('implement', [
  { kind: 'write-file', path: 'src/a.js', content: 'export const version = 1;\n' },
  { kind: 'write-file', path: 'src/a.js', content: 'export const version = 2;\n', when: { promptIncludes: FIX } },
  { kind: 'write-file', path: `.tandemise/out/${TASK.implement}/ChangeSet.md`, content: front('ChangeSet', ['branch: x', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []']) },
  { kind: 'complete' },
]));
const reviewer = agentOn('Reviewer', 'review', profile('review', [
  { kind: 'write-file', path: `.tandemise/out/${TASK.review}/ReviewReport.md`, content: front('ReviewReport', ['verdict: pass', 'reviewedRef: HEAD', 'findings: []']) },
  { kind: 'complete' },
]));
const tester = agentOn('Tester', 'qa', profile('qa', [
  { kind: 'write-file', path: `.tandemise/out/${TASK.verify}/QAReport.md`, content: front('QAReport', ['results:', '  - criterion: U1', '    outcome: PASS', '    evidence: seen', 'blockingDefects: 0']) },
  { kind: 'complete' },
]));

const repoDir = join(HOME, 'repo');
mkdirSync(join(repoDir, 'src'), { recursive: true });
writeFileSync(join(repoDir, 'src', 'a.js'), 'export const version = 0;\n');
writeFileSync(join(repoDir, '.gitignore'), '.tandemise/out/\n');
execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
git(repoDir, 'add', '.');
git(repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-m', 'init');
const repository = h.container.resolve(h.app.REPO_REPOSITORY).create({
  id: ids.repository(), workspaceId: ws, name: 'repo', path: repoDir, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS,
});

const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Change the version', title: 'Redo', repositoryId: repository.id });
const row = (key, roleId, outputs, dependsOn, agent) => ({
  id: TASK[key], missionId: mission.id, key, title: key, objective: `Do ${key}`, roleId,
  dependsOn, requiredCapabilities: [], inputArtifacts: dependsOn.length === 0 ? [] : [{ type: 'ChangeSet', required: true }], expectedOutputs: outputs,
  executionPolicy: { isolation: 'worktree', maxWallTimeMs: 60000, capabilities: [] },
  approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
  completionGate: `artifact.${outputs[0]}.exists`, status: dependsOn.length === 0 ? 'READY' : 'PENDING', statusReason: null,
  attempts: 0, remediatesTaskId: null, repositoryId: repository.id, executor: 'agent', waitPolicy: null, orderHint: 0,
  staffingOverride: { assignees: [agent] },
  createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
});
const implement = row('implement', 'development', ['ChangeSet'], [], implementer);
const review = row('review', 'review', ['ReviewReport'], ['implement'], reviewer);
const verify = row('verify', 'qa', ['QAReport'], ['implement', 'review'], tester);
for (const t of [implement, review, verify]) h.repo.tasks.add(t);
h.repo.missions.update(mission.id, { status: 'EXECUTING' });

const task = (id) => h.repo.tasks.get(id);
const allDone = () => [implement, review, verify].every((t) => task(t.id).status === 'SUCCEEDED');
const targetOf = (id) => h.container.resolve(h.app.EXECUTION_TARGET_REPOSITORY).listByMission(mission.id).filter((t) => t.taskId === id).at(-1);
const reportCommit = (id) => {
  const live = h.repo.artifacts.listByTask(id);
  const superseded = new Set(live.map((a) => a.supersedes).filter(Boolean));
  const latest = live.filter((a) => !superseded.has(a.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return latest?.sourceRefs.find((r) => r.kind === 'git.commit')?.value ?? null;
};

section('round 1: implement → review → QA');
await h.until(allDone, 30000);
check('all three steps succeed', allDone(), [implement, review, verify].map((t) => `${t.key}:${task(t.id).status}:${task(t.id).statusReason}`));
const oldHead = git(targetOf(implement.id).workingDirectory, 'rev-parse', 'HEAD');
check('review ran on implement\'s head', isAncestor(repoDir, oldHead, git(targetOf(review.id).workingDirectory, 'rev-parse', 'HEAD')));

section('round 2: feedback on implement, downstream redone');
const item = h.rounds.record({ task: task(implement.id), text: FIX, artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
h.rounds.startRound({ task: task(implement.id), feedbackIds: [item.id], downstream: 'redo', actorId: owner });
check('review and QA are reset by the redo', task(review.id).status !== 'SUCCEEDED' && task(verify.id).status !== 'SUCCEEDED', [task(review.id).status, task(verify.id).status]);
await h.until(() => allDone() && (task(review.id).round ?? 1) >= 2, 30000);
check('all three steps succeed again', allDone(), [implement, review, verify].map((t) => `${t.key}:${task(t.id).status}:${task(t.id).statusReason}`));

const implementDir = targetOf(implement.id).workingDirectory;
const newHead = git(implementDir, 'rev-parse', 'HEAD');
check('implement committed the fix on its own branch', newHead !== oldHead && readFileSync(join(implementDir, 'src/a.js'), 'utf8').includes('version = 2'), { oldHead, newHead });
for (const [name, t] of [['review', review], ['QA', verify]]) {
  const dir = targetOf(t.id).workingDirectory;
  const head = git(dir, 'rev-parse', 'HEAD');
  check(`the redone ${name} worktree contains implement's new head`, isAncestor(repoDir, newHead, head), { newHead, head });
  check(`the redone ${name} sees the fixed code`, readFileSync(join(dir, 'src/a.js'), 'utf8').includes('version = 2'), readFileSync(join(dir, 'src/a.js'), 'utf8'));
  const named = reportCommit(t.id);
  check(`the redone ${name}'s report names a commit that contains the fix`, named !== null && isAncestor(repoDir, newHead, named), { named, newHead });
}

section('ship: the branch it opens the pull request from holds every step\'s final work');
const ship = h.container.resolve(h.app.SHIP_SERVICE);
const integration = h.container.resolve(h.app.BRANCH_INTEGRATION_SERVICE);
const shipped = integration.branchesFor(h.repo.missions.get(mission.id)).find((b) => b.taskKey === 'implement')?.branch;
check('ship ships implement\'s branch, which holds the fix', shipped !== undefined && isAncestor(repoDir, newHead, shipped), shipped);
const m = h.repo.missions.get(mission.id);
check('a branch with every step\'s final commit passes the guard', (await ship.missingUpstreamWork(m, repository, shipped)).length === 0);
git(repoDir, 'branch', 'stale-head', oldHead);
const missing = await ship.missingUpstreamWork(m, repository, 'stale-head');
check('a branch without implement\'s final commit is refused, naming the step', missing.some((x) => x.taskKey === 'implement' && x.commit === newHead), missing);

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);

async function engineHarness(home) {
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock: clock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { persistenceModule } = persistenceTokens;
  const A = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const {
    integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER,
  } = await import('@tandemise/integrations-core');
  const app = await import('@tandemise/application');

  const paths = createPaths(home);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'round-redo-head-check' } });
  const container = new Container();
  compose(
    container,
    persistenceModule({ path: paths.db, logger: log }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  // A real runner: the ship guard asks git whether a branch holds each step's commit.
  const { spawnSync } = await import('node:child_process');
  container.bind(COMMAND_EXECUTOR, () => ({
    run: async (req) => {
      const r = spawnSync(req.command, [...(req.args ?? [])], { cwd: req.cwd, encoding: 'utf8', windowsHide: true });
      return { command: req.command, exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false, durationMs: 0 };
    },
  }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  return { app, container, services, scheduler, repo, until, rounds: container.resolve(app.FEEDBACK_ROUNDS) };
}
