// Each review step's verdict is its own (#191).
//
//   npm run build && node scratch/review-artifact-scope-check.mjs
//
// The careful lane has two review steps, a security review and "Review the
// change". The second one's ReviewReport write was refused; its gate
// `artifact.ReviewReport.exists` still passed on the security review's report,
// the step succeeded, and its `needs_changes` verdict was lost. It also could
// not read the ProductSpec or ArchitecturePlan it was meant to check against.
// With the fake runtime and real worktrees, this checks that a step's own
// output types are scoped to the step, that a refused write blocks the step
// with a card, that review facts are each review's own, that a step that must
// deliver an artifact is granted the write, and that a reviewer is handed the
// planning documents.
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

const keepAlive = setInterval(() => {}, 1000);
const HOME = mkdtempSync(join(tmpdir(), 'tra-'));
const h = await engineHarness(HOME);
const D = await import('@tandemise/domain');
const { createGrantBuilder } = await import('@tandemise/policy');
const { systemClock, ids } = await import('@tandemise/shared');
const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
const now = () => systemClock.now();

section('grants: a step that must deliver an artifact may write it');
{
  const role = { id: 'review', name: 'Reviewer', defaultCapabilities: ['repository.read', 'filesystem.read', 'shell', 'artifact.write'] };
  const task = { key: 'review', expectedOutputs: ['ReviewReport'], requiredCapabilities: [], executionPolicy: { capabilities: ['repository.read', 'filesystem.read', 'shell'], maxWallTimeMs: 60000 } };
  const grants = createGrantBuilder().build({ role, task, autonomy: { localCodeChanges: 'auto', externalWrites: 'auto', productionRelease: 'ask', planApproval: 'auto', financialActions: 'deny' }, workingDirectory: '/w', artifactRoot: '/a' });
  check('a review step whose plan listed only read capabilities still gets artifact.write', grants.some((g) => g.capability === 'artifact.write'), grants.map((g) => g.capability));
  check('...and nothing that writes the tree', !grants.some((g) => g.capability === 'filesystem.write'));
}

const caller = { personId: h.services.identity.localPerson().id };
const ws = (await h.services.workspaces.create(caller, { name: 'Reviews' })).workspace.id;
const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
const workspaces = h.container.resolve(h.app.WORKSPACE_REPOSITORY);
workspaces.update(ws, { concurrency: { ...workspaces.get(ws).concurrency, maxTotalWorkers: 4 } });
const profile = (name, steps) => h.repo.profiles.create({
  id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
  args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4,
  createdAt: now(), updatedAt: now(),
}).id;
const agentOn = (name, role, steps) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: [role], runtimeProfileIds: [profile(name, steps)] }).id;
const front = (type, extra, body = 'Body.') => ['---', `type: ${type}`, 'schemaVersion: 1', `title: ${type}`, 'handoff:', `  headline: ${type} written`, ...extra, '---', '', `# ${type}`, '', body, ''].join('\n');
const out = (taskId, type) => `.tandemise/out/${taskId}/${type}.md`;
const savePrompt = { kind: 'write-file', path: '.tandemise/out/prompt-{{runId}}.txt', content: '{{prompt}}' };
const MARKER = 'outbox-pattern-for-every-consumer';
const REVIEW = (verdict, findings) => front('ReviewReport', [`verdict: ${verdict}`, 'reviewedRef: HEAD', ...findings]);
const MAJOR = ['findings:', '  - severity: major', '    title: Retries are not idempotent', '    detail: A retried consumer applies the event twice.', '    location: src/a.js', '    suggestedFix: Key the write by event id.'];

const repoDir = join(HOME, 'repo');
mkdirSync(join(repoDir, 'src'), { recursive: true });
writeFileSync(join(repoDir, 'src', 'a.js'), 'export const a = 0;\n');
writeFileSync(join(repoDir, '.gitignore'), '.tandemise/out/\n');
execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
execFileSync('git', ['-C', repoDir, 'add', '.']);
execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-m', 'init']);
const repository = h.container.resolve(h.app.REPO_REPOSITORY).create({
  id: ids.repository(), workspaceId: ws, name: 'repo', path: repoDir, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS,
});
const READ_ONLY = ['repository.read', 'filesystem.read', 'artifact.write', 'shell'];

// A careful-lane mission: architecture → implement → security review → review the change.
const careful = async (title, second) => {
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: title, title, repositoryId: repository.id });
  const T = { architecture: ids.task(), implement: ids.task(), security_review: ids.task(), review: ids.task() };
  const staff = {
    architecture: agentOn(`${title} architect`, 'architecture', [{ kind: 'write-file', path: out(T.architecture, 'ArchitecturePlan'), content: front('ArchitecturePlan', ['components:', '  - outbox', 'risks: []', 'migration: none'], `Use the ${MARKER}.`) }, { kind: 'complete' }]),
    implement: agentOn(`${title} developer`, 'development', [{ kind: 'write-file', path: 'src/a.js', content: 'export const a = 1;\n' }, { kind: 'write-file', path: out(T.implement, 'ChangeSet'), content: front('ChangeSet', ['branch: x', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []']) }, { kind: 'complete' }]),
    security_review: agentOn(`${title} security reviewer`, 'review', [{ kind: 'write-file', path: out(T.security_review, 'ReviewReport'), content: REVIEW('pass', ['findings: []']) }, { kind: 'complete' }]),
    review: agentOn(`${title} reviewer`, 'review', second(T.review)),
  };
  const row = (key, roleId, outputs, dependsOn, inputs, caps) => ({
    id: T[key], missionId: mission.id, key, title: key, objective: `Do ${key}`, roleId,
    dependsOn, requiredCapabilities: [], inputArtifacts: inputs.map((type) => ({ type, required: true })), expectedOutputs: outputs,
    executionPolicy: { isolation: 'worktree', maxWallTimeMs: 60000, capabilities: caps },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
    completionGate: `artifact.${outputs[0]}.exists`, status: dependsOn.length === 0 ? 'READY' : 'PENDING', statusReason: null,
    attempts: 0, remediatesTaskId: null, repositoryId: repository.id, executor: 'agent', waitPolicy: null, orderHint: 0,
    staffingOverride: { assignees: [staff[key]] },
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  });
  const rows = [
    row('architecture', 'architecture', ['ArchitecturePlan'], [], [], []),
    row('implement', 'development', ['ChangeSet'], ['architecture'], [], []),
    row('security_review', 'review', ['ReviewReport'], ['implement'], ['ChangeSet'], READ_ONLY),
    row('review', 'review', ['ReviewReport'], ['security_review'], ['ChangeSet'], READ_ONLY),
  ];
  for (const r of rows) h.repo.tasks.add(r);
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  await h.until(() => ['SUCCEEDED', 'BLOCKED', 'FAILED'].includes(h.repo.tasks.get(T.review).status)
    || ['BLOCKED', 'FAILED'].includes(h.repo.tasks.get(T.security_review).status), 40000);
  return { mission, T };
};
const task = (id) => h.repo.tasks.get(id);
const gates = h.container.resolve(h.app.GATE_SERVICE);
const targetOf = (missionId, id) => h.container.resolve(h.app.EXECUTION_TARGET_REPOSITORY).listByMission(missionId).filter((t) => t.taskId === id).at(-1);
const promptOf = (missionId, id) => {
  const run = h.repo.runs.listByTask(id).at(-1);
  try { return readFileSync(join(targetOf(missionId, id).workingDirectory, `.tandemise/out/prompt-${run.id}.txt`), 'utf8'); } catch { return ''; }
};

section('the second review\'s write is refused');
{
  const { mission, T } = await careful('Refused', (id) => [
    savePrompt,
    { kind: 'tool', tool: 'Write', input: `{"file_path":"${out(id, 'ReviewReport')}"}`, outcome: 'error' },
    { kind: 'message', text: 'Verdict: needs_changes. Major: retries are not idempotent.' },
    { kind: 'complete' },
  ]);
  check('the security review succeeds on its own report', task(T.security_review).status === 'SUCCEEDED', task(T.security_review).statusReason);
  check('the review whose write was refused does not succeed', task(T.review).status === 'BLOCKED', `${task(T.review).status}: ${task(T.review).statusReason}`);
  const facts = gates.factsFor(task(T.review));
  check('its gate does not count the security review\'s ReviewReport', facts['artifact.ReviewReport.exists'] === false, facts['artifact.ReviewReport.exists']);
  check('the row says the output was refused', /could not be saved: the write to \.tandemise\/out\/.*ReviewReport\.md was refused/.test(task(T.review).statusReason ?? ''), task(T.review).statusReason);
  const card = h.repo.approvals.pendingForTask(T.review)[0];
  check('a card asks a person, naming the refusal', card !== undefined && /its output was refused/.test(card.title), card?.title);
  check('QA-like work after it does not start: the mission waits', task(T.review).status !== 'SUCCEEDED');
  const prompt = promptOf(mission.id, T.review);
  check('the reviewer is handed the ArchitecturePlan it checks against, though the step listed only the ChangeSet', prompt.includes(MARKER), prompt.length);
}

section('both reviews write: each verdict is its own');
{
  const { T } = await careful('Both', (id) => [{ kind: 'write-file', path: out(id, 'ReviewReport'), content: REVIEW('needs_changes', MAJOR) }, { kind: 'complete' }]);
  check('both reviews succeed', task(T.security_review).status === 'SUCCEEDED' && task(T.review).status === 'SUCCEEDED', [task(T.security_review).statusReason, task(T.review).statusReason]);
  const security = gates.factsFor(task(T.security_review));
  const general = gates.factsFor(task(T.review));
  check('the security review reads its own verdict (pass, no major findings)', security['review.verdict'] === 'pass' && security['review.major_findings'] === 0, security);
  check('the general review reads its own verdict (needs_changes, one major finding)', general['review.verdict'] === 'needs_changes' && general['review.major_findings'] === 1, general);
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
  const log = createLogger({ level: 'error', base: { component: 'review-artifact-scope-check' } });
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
  return { app, container, services, scheduler, repo, until };
}
