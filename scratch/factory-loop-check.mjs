// The factory loop is fast and unblocks itself (#111, #106, #117).
//
//   npm run build && node scratch/factory-loop-check.mjs
//
// Dogfooding Tandemise on its own repository: a one-paragraph docs change took
// 38 minutes, a one-line fix 84, and both needed a person to unblock them. The
// time went to the test suite run twice per step (once by the agent, once by
// the gate), a hard 10-minute check budget that the suite overran, a timeout
// read as the agent's failure so the whole step re-ran and timed out again,
// and a retry that undid what a person had asked for during a hold. Each
// section below is one of those, on a real git worktree with the fake runtime.
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const D = await import('@tandemise/domain');
const E = await import('@tandemise/evaluation');

section('pure: which checks a change needs (#106)');
{
  const { config } = D.parsePlannerConfig({
    areas: [
      { name: 'docs', paths: ['docs/**', '**/*.md'], checks: { tests: 'none', typecheck: null } },
      { name: 'design', paths: ['packages/design/**'], checks: { tests: 'npm run check:design' } },
      { name: 'app', paths: ['apps/**'] },
    ],
    checks: { budgets: { tests: 25 } },
  });
  check('planner.yaml reads areas[].checks, with none as "not needed"', config.areas[0].checks.tests === null && config.areas[1].checks.tests === 'npm run check:design', config.areas);
  check('planner.yaml reads checks.budgets', config.checks.budgets.tests === 25, config.checks);
  const docsOnly = D.selectCheck('tests', ['docs/a.md', 'README.md'], config.areas);
  check('a docs-only change needs no test run', docsOnly.kind === 'not_needed' && docsOnly.files === 2, docsOnly);
  check('...and says so in a person\'s words', /touches only the docs area \(2 files\)/.test(D.notNeededDetail(docsOnly)), D.notNeededDetail(docsOnly));
  const design = D.selectCheck('tests', ['packages/design/src/a.ts', 'docs/x.md'], config.areas);
  check('a design-only change runs the design area\'s command, once', design.kind === 'commands' && design.commands.length === 1 && design.commands[0] === 'npm run check:design', design);
  check('a file outside any area with checks runs the repository\'s command', D.selectCheck('tests', ['apps/x.ts', 'docs/a.md'], config.areas).kind === 'repository');
  check('a file in no area runs the repository\'s command', D.selectCheck('tests', ['src/x.ts'], config.areas).kind === 'repository');
  check('an area that does not name a check runs the repository\'s command for it', D.selectCheck('lint', ['docs/a.md'], config.areas).kind === 'repository');
  check('no changed files runs the repository\'s command (not knowing never narrows)', D.selectCheck('tests', [], config.areas).kind === 'repository');
  check('the shipped planner skips tests for docs', D.selectCheck('tests', ['docs/QUICKSTART.md'], (await import('@tandemise/application')).SHIPPED_PLANNER_CONFIG.areas).kind === 'not_needed');
}

section('pure: check budgets (#111)');
{
  check('the repository\'s budget wins over the factory\'s', D.checkBudgetMinutes('tests', { tests: 30 }, { tests: 20 }) === 30);
  check('the factory\'s budget applies when the repository sets none', D.checkBudgetMinutes('tests', {}, { tests: 20 }) === 20);
  check('the default is 10 minutes', D.checkBudgetMinutes('tests', undefined, undefined) === 10 && D.DEFAULT_CHECK_BUDGET_MINUTES === 10);
  const runner = E.createCommandCheckRunner({ execute: async () => ({ exitCode: 143, stdout: '', stderr: '', durationMs: 600008, timedOut: true }) });
  const result = await runner.run({ name: 'checks.tests', command: 'npm test', timeoutMs: 600000 }, { missionId: 'm', taskId: 't', runId: null, cwd: '/' });
  check('a killed check is TIMEOUT, not FAIL', result.outcome === 'TIMEOUT', result.outcome);
  check('its detail says it ran out of time after 10 min and that this says nothing about the work',
    /ran out of time.*10 min budget/.test(result.detail) && /says nothing about the work/.test(result.detail), result.detail);
  check('TIMEOUT is a check outcome the store accepts', D.CHECK_OUTCOMES.includes('TIMEOUT'));
}

section('engine');
const keepAlive = setInterval(() => {}, 1000);
const HOME = mkdtempSync(join(tmpdir(), 'tfl-'));
const h = await engineHarness(HOME);
const { systemClock, ids } = await import('@tandemise/shared');
const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
const now = () => systemClock.now();

const caller = { personId: h.services.identity.localPerson().id };
const ws = (await h.services.workspaces.create(caller, { name: 'Loop' })).workspace.id;
const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
const workspaces = h.container.resolve(h.app.WORKSPACE_REPOSITORY);
workspaces.update(ws, { concurrency: { ...workspaces.get(ws).concurrency, maxTotalWorkers: 4 } });
const profile = (name, steps) => h.repo.profiles.create({
  id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
  args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4,
  createdAt: now(), updatedAt: now(),
}).id;
const agentOn = (name, profileId) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: ['development'], runtimeProfileIds: [profileId] }).id;

// A real repository, with a test command that leaves a mark each time it runs.
const repoDir = join(HOME, 'repo');
mkdirSync(join(repoDir, 'src'), { recursive: true });
mkdirSync(join(repoDir, 'docs'), { recursive: true });
writeFileSync(join(repoDir, 'docs', 'QUICKSTART.md'), '# Quickstart\n');
writeFileSync(join(repoDir, 'src', 'a.js'), 'export const a = 1;\n');
execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
execFileSync('git', ['-C', repoDir, 'add', '.']);
execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-m', 'init']);
const RAN = join(HOME, 'tests-ran.log');
const runsOfTests = () => (existsSync(RAN) ? readFileSync(RAN, 'utf8').split('\n').filter(Boolean).length : 0);
const repositories = h.container.resolve(h.app.REPO_REPOSITORY);
const repository = repositories.create({
  id: ids.repository(), workspaceId: ws, name: 'repo', path: repoDir, defaultBranch: 'main', remoteUrl: null,
  checks: { ...D.NO_CHECKS, test: `echo ran >> ${RAN} && test ! -e src/broken.js` },
});

let seq = 0;
const addMission = async (t) => {
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: t.goal ?? 'Change the repository', title: `L${++seq}`, repositoryId: t.repositoryId ?? repository.id });
  const row = {
    id: ids.task(), missionId: mission.id, key: t.key, title: t.key, objective: t.objective ?? 'Make the change', roleId: 'development',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'worktree', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: t.maxAttempts ?? 2, backoffMs: 0, onExhausted: 'block' },
    completionGate: t.completionGate ?? 'checks.tests == PASS', status: 'READY', statusReason: null,
    attempts: 0, remediatesTaskId: null, repositoryId: t.repositoryId ?? repository.id, executor: 'agent', waitPolicy: null, orderHint: 0,
    staffingOverride: { assignees: [t.agent] },
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  };
  h.repo.tasks.add(row);
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  return { mission, id: row.id };
};
const task = (id) => h.repo.tasks.get(id);
const settled = (id, ms = 20000) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status), ms);
const checksOf = (id) => h.container.resolve(h.app.EVALUATION_REPOSITORY).listChecks(id);
const outDir = (id) => `.tandemise/out/${id}`;
// The prompt is written where git never sees it: the out folder is ignored.
const savePrompt = { kind: 'write-file', path: '.tandemise/out/prompt-{{runId}}.txt', content: '{{prompt}}' };
const promptsOf = (id) => {
  const target = h.container.resolve(h.app.EXECUTION_TARGET_REPOSITORY).listByMission(task(id).missionId).find((t) => t.taskId === id);
  return h.repo.runs.listByTask(id).sort((a, b) => a.attempt - b.attempt || a.startedAt.localeCompare(b.startedAt))
    .map((r) => { try { return readFileSync(join(target.workingDirectory, `.tandemise/out/prompt-${r.id}.txt`), 'utf8'); } catch { return ''; } });
};
void outDir;

// ---- (a) a docs-only change in the quick lane: no test suite, and fast
{
  const before = runsOfTests();
  const agent = agentOn('Docs', profile('docs', [savePrompt, { kind: 'write-file', path: 'docs/QUICKSTART.md', content: '# Quickstart\n\nAdd Claude Code with Discover runtimes.\n' }, { kind: 'complete' }]));
  const started = Date.now();
  const m = await addMission({ key: 'docs_only', agent });
  await settled(m.id);
  const elapsed = Date.now() - started;
  const tests = checksOf(m.id).filter((c) => c.name === 'checks.tests');
  check('(a) a docs-only step succeeds on the tests gate', task(m.id).status === 'SUCCEEDED', `${task(m.id).status}: ${task(m.id).statusReason}`);
  check('(a) the test suite never ran for it', runsOfTests() === before, runsOfTests() - before);
  check('(a) the tests fact says why it was not run', tests.length === 1 && tests[0].command === null && /Not run: this change touches only the docs area/.test(tests[0].detail), tests);
  check('(a) Start to done in under 10 seconds with the fake runtime', elapsed < 10_000, elapsed);
  const prompt = promptsOf(m.id)[0] ?? '';
  check('(a) the prompt names the check Tandemise runs after it, and says not to run the full suite',
    prompt.includes('Tandemise itself runs these checks') && prompt.includes('checks.tests: `echo ran') && prompt.includes('Do not run these full commands yourself'), prompt.slice(-900));
}

// ---- (b) a code change: tests run once, and a later step on the same tree reuses the result
{
  const agent = agentOn('Code', profile('code', [{ kind: 'write-file', path: 'src/a.js', content: 'export const a = 2;\n' }, { kind: 'complete' }]));
  const before = runsOfTests();
  const m = await addMission({ key: 'code', agent });
  await settled(m.id);
  check('(b) a code step succeeds', task(m.id).status === 'SUCCEEDED', `${task(m.id).status}: ${task(m.id).statusReason}`);
  check('(b) the test suite ran exactly once', runsOfTests() - before === 1, runsOfTests() - before);
  const measured = checksOf(m.id).find((c) => c.name === 'checks.tests');
  check('(b) the result records the tree it measured', typeof measured?.treeSha === 'string' && measured.treeSha.length >= 40, measured);

  // A second step that measures the very same tree (a review on the change's branch, the judge, a re-check).
  const target = h.container.resolve(h.app.EXECUTION_TARGET_REPOSITORY).listByMission(task(m.id).missionId).find((t) => t.taskId === m.id);
  const checks = h.container.resolve(h.app.CHECK_SERVICE);
  const execution = await import('@tandemise/execution-local');
  void execution;
  const fakeTarget = {
    kind: 'worktree', workingDirectory: target.workingDirectory,
    describe: () => ({ ...target, baseBranch: target.branch }),
    exec: async (req) => {
      const out = execFileSync(req.command, req.args ?? [], { cwd: req.cwd ?? target.workingDirectory, encoding: 'utf8' });
      return { exitCode: 0, stdout: out, stderr: '', durationMs: 1, timedOut: false };
    },
  };
  const again = await checks.run({ task: task(m.id), repository, target: fakeTarget, runId: null, scope: { workspaceId: ws, missionId: task(m.id).missionId, taskId: m.id }, signal: new AbortController().signal });
  const reused = again.find((c) => c.name === 'checks.tests');
  check('(b) a later step on the same tree reuses the result instead of running the suite again',
    runsOfTests() - before === 1 && reused?.outcome === 'PASS' && /Not run again: the same code was already measured/.test(reused.detail), { runs: runsOfTests() - before, reused });
}

// ---- (c) a check that runs out of time: never the agent's fault, asked once, no agent re-run
{
  const slow = repositories.create({
    id: ids.repository(), workspaceId: ws, name: 'slow', path: repoDir, defaultBranch: 'main', remoteUrl: null,
    // 0.02 min = 1.2 s, then 2.4 s on the second run; the command takes 6 s.
    checks: { ...D.NO_CHECKS, test: 'sleep 6', budgets: { tests: 0.02 } },
  });
  const agent = agentOn('Slow', profile('slow', [{ kind: 'write-file', path: 'src/slow.js', content: 'export const s = 1;\n' }, { kind: 'complete' }]));
  const m = await addMission({ key: 'slow_tests', agent, repositoryId: slow.id, maxAttempts: 3 });
  await settled(m.id, 30000);
  const t = task(m.id);
  const tests = checksOf(m.id).filter((c) => c.name === 'checks.tests');
  check('(c) the step blocks for a person rather than retrying', t.status === 'BLOCKED', `${t.status}: ${t.statusReason}`);
  check('(c) the agent ran once: a timeout spends no retry on the agent', h.repo.runs.listByTask(m.id).length === 1 && t.attempts === 1, { runs: h.repo.runs.listByTask(m.id).length, attempts: t.attempts });
  check('(c) the check ran twice, the second time with twice the budget, and both read TIMEOUT',
    tests.length === 2 && tests.every((c) => c.outcome === 'TIMEOUT') && /after 1 s, then after 2 s/.test(tests[1].detail), tests.map((c) => [c.outcome, c.detail]));
  check('(c) the row says plainly the check ran out of time and it is not the work\'s fault',
    /^The tests check ran out of time before it finished\. That is not a fault in the work\./.test(t.statusReason ?? '') && /Project settings → Repositories/.test(t.statusReason ?? ''), t.statusReason);
  const card = h.repo.approvals.pendingForTask(m.id)[0];
  check('(c) the card names the timeout, not exhausted retries', card?.title.endsWith('a check ran out of time') && !/exhausted/.test(card.title), card?.title);
}

// ---- (d) a retry after a hold keeps what the person said, and stays in scope
{
  const scope = { kind: 'write-file', path: 'scratch/unrelated-check.mjs', content: '// made green\n', when: { promptIncludes: 'Your previous attempt' } };
  const fixed = { kind: 'write-file', path: 'src/broken.js', content: '', when: { promptIncludes: 'Your previous attempt' } };
  const agent = agentOn('Retry', profile('retry', [
    savePrompt,
    { kind: 'write-file', path: 'src/theme.js', content: 'export const label = "System follows your desktop setting.";\n' },
    { kind: 'write-file', path: 'src/broken.js', content: 'throw 1;\n' },
    fixed, scope, { kind: 'complete' },
  ]));
  // A test command that fails while src/broken.js has content, passes once it is empty.
  const strict = repositories.create({
    id: ids.repository(), workspaceId: ws, name: 'strict', path: repoDir, defaultBranch: 'main', remoteUrl: null,
    checks: { ...D.NO_CHECKS, test: 'test ! -s src/broken.js' },
  });
  const m = await addMission({ key: 'held_then_retried', agent, repositoryId: strict.id, maxAttempts: 2 });
  // The person held this step before and told it something; the session recorded it.
  const holdDir = join(HOME, 'holds', 'h1');
  mkdirSync(holdDir, { recursive: true });
  writeFileSync(join(holdDir, 'person-said.jsonl'), `${JSON.stringify({ at: '2026-11-01T18:10:00.000Z', prompt: 'On Linux make it "System follows your desktop setting."' })}\n`);
  const holds = h.container.resolve(h.app.TASK_HOLD_REPOSITORY);
  holds.create({
    id: `hold_${ids.task().slice(5)}`, taskId: m.id, missionId: task(m.id).missionId, heldBy: owner, fromStatus: 'READY', runtimeProfileId: 'none',
    sessionBefore: null, sessionAfter: null, ptyPid: null, startedAt: '2026-11-01T18:06:00.000Z', endedAt: '2026-11-01T18:26:00.000Z',
    endedBy: owner, ending: 'released', consumedAt: '2026-11-01T18:26:01.000Z', diffStat: null, dir: holdDir,
  });
  await settled(m.id);
  const prompts = promptsOf(m.id);
  check('(d) the step fails once, then the retry passes', task(m.id).status === 'SUCCEEDED' && prompts.length === 2, { s: task(m.id).status, r: task(m.id).statusReason, n: prompts.length });
  // The out folder is cleared for each attempt, so the retry's prompt is the one left to read.
  const retryPrompt = prompts[1] ?? '';
  check('(d) the retry\'s prompt quotes what the person said during the hold, as binding',
    retryPrompt.includes('What a person told this step directly (binding)') && retryPrompt.includes('> On Linux make it "System follows your desktop setting."')
      && retryPrompt.includes('what the person said wins'), retryPrompt.slice(-1200));
  check('(d) the retry is told to build on its committed work and keep the change scoped',
    (prompts[1] ?? '').includes('build on it, do not start over') && (prompts[1] ?? '').includes('do not edit files outside it'), (prompts[1] ?? '').slice(-1500));
  const scopeCheck = checksOf(m.id).find((c) => c.name === 'scope.retry');
  check('(d) the retry\'s edit outside the change is flagged with the file it touched',
    scopeCheck?.outcome === 'FAIL' && scopeCheck.detail.includes('scratch/unrelated-check.mjs') && !scopeCheck.detail.includes('src/broken.js'), scopeCheck);
}

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
  const log = createLogger({ level: 'error', base: { component: 'factory-loop-check' } });
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
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
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
  return { app, container, services, scheduler, repo, until };
}
