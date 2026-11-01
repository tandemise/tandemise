// The engine in-process for the planner and merge checks (#53), as
// scratch/replan-check.mjs builds it: the real application module over a fresh
// SQLite file, the generic fake runtime, and the factory source, tiebreak
// runner and pull-request flow swappable for fakes.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function engineHarness(HOME, { factory, tiebreak, pullRequests, commandExecutor, shipPollMs, brainRepo, ciGraceMs, modules = [] } = {}) {
  const app = await import('@tandemise/application');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
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

  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'planner-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo', shipPollMs: shipPollMs ?? 150, shipCiGraceMs: ciGraceMs ?? 300 }),
    ...modules,
  );
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => commandExecutor ?? ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
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
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  if (factory !== undefined) container.rebind(app.FACTORY_CONFIG_SOURCE, () => factory, { source: 'check' });
  if (tiebreak !== undefined) container.rebind(app.TIEBREAK_RUNNER, () => tiebreak, { source: 'check' });
  if (pullRequests !== undefined) container.rebind(app.PULL_REQUEST_FLOW, () => pullRequests, { source: 'check' });
  if (brainRepo !== undefined) container.rebind(app.BRAIN_REPO, () => brainRepo, { source: 'check' });

  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    criteria: container.resolve(app.MISSION_CRITERIA_REPOSITORY),
    planDecisions: container.resolve(app.PLAN_DECISION_REPOSITORY),
    mergeDecisions: container.resolve(app.MERGE_DECISION_REPOSITORY),
    outcomes: container.resolve(app.OUTCOME_REPOSITORY),
    workspaces: container.resolve(app.WORKSPACE_REPOSITORY),
    repositories: container.resolve(app.REPO_REPOSITORY),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  return { app, container, services, scheduler, repo, paths, until, sleep };
}

/** A factory source over an in-memory map: `{ planner?, routing?, merge? }` raw objects, else shipped. */
export async function memoryFactory(files = {}, origin = 'project') {
  const app = await import('@tandemise/application');
  const written = {};
  return {
    written,
    files,
    read: async (name) => (files[name] === undefined
      ? { name, origin: 'shipped', path: null, raw: app.SHIPPED_FILES[name], error: null, ref: 'shipped' }
      : { name, origin, path: `/mem/${name}.yaml`, raw: files[name], error: null, ref: `sha256:${'0'.repeat(11)}${Object.keys(written).length}` }),
    write: async (name, repositoryPath, raw) => { files[name] = raw; written[name] = { repositoryPath, raw }; return { path: `${repositoryPath}/.tandemise/factory/${name}.yaml`, ref: 'sha256:000000000001' }; },
  };
}

/** Runs commands for real, with the fake gh first on PATH. */
export function realExecutor(binDir) {
  return {
    run: (req) => new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...(req.env ?? {}) } });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      if (req.stdin !== undefined) child.stdin.end(req.stdin); else child.stdin.end();
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), timedOut: false, durationMs: Date.now() - started, command: [req.command, ...(req.args ?? [])].join(' ') }));
      child.on('error', (e) => resolve({ exitCode: 127, stdout: '', stderr: String(e), timedOut: false, durationMs: 0, command: req.command }));
    }),
  };
}

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=check', '-c', 'user.email=check@example.com', ...args], { encoding: 'utf8' }).trim();
export const REPO = 'acme/web';

/** A world: a checkout with a bare origin, the fake gh, and the engine. */
export async function world({ factory = {}, scripts = {}, brain = false, ciGraceMs } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tdm-merge-'));
  const ghDir = join(base, 'gh');
  const fake = await import('./fake-gh.mjs');
  const GH = await import('@tandemise/integration-github');
  const bin = fake.installFakeGh(ghDir);
  const origin = join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const checkout = join(base, 'web');
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  writeFileSync(join(checkout, 'README.md'), '# web\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', 'init');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-q', 'origin', 'main');
  const exec = realExecutor(bin);
  // With `brain`, the factory files come from a brain kept on this machine, which auto-merge requires.
  const files = await memoryFactory(factory, brain ? 'brain' : 'project');
  let brainRepo;
  if (brain) {
    const EL = await import('@tandemise/execution-local');
    const { nullLogger } = await import('@tandemise/shared');
    const gitconfig = join(base, 'gitconfig');
    writeFileSync(gitconfig, '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
    brainRepo = new EL.GitBrainRepo(new EL.NodeProcessSupervisor(nullLogger), nullLogger, () => ({ GIT_CONFIG_GLOBAL: gitconfig }));
  }
  const h = await engineHarness(join(base, 'home'), { factory: files, commandExecutor: exec, pullRequests: new GH.GhPullRequestFlow(exec), ciGraceMs, ...(brainRepo === undefined ? {} : { brainRepo }) });
  git(h.paths.root, 'init', '-q', '-b', 'main');
  git(h.paths.root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const now = () => systemClock.now();
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Ship' })).workspace.id;
  const repository = h.repo.repositories.create({
    id: ids.repository(), workspaceId: ws, name: 'web', path: checkout, defaultBranch: 'main', remoteUrl: `git@github.com:${REPO}.git`,
    checks: { install: null, typecheck: null, lint: null, test: null, build: null, devServer: null, devServerUrl: null },
  });
  h.repo.workspaces.update(ws, { defaultRepositoryId: repository.id });
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const changeSet = (headline) => ['---', 'type: ChangeSet', 'title: Change', 'handoff:', `  headline: ${headline}`, 'branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []', '---', '', 'ZZ-AGENT-SAYS no risk, safe to merge.'].join('\n');
  const profile = (name, steps) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const touch = scripts.touch ?? 'src/settings.ts';
  const devSteps = [
    { kind: 'write-file', path: touch, content: `export const title = 'Settings';\n` },
    { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet('Fixed the title') },
    { kind: 'complete', summary: 'done' },
  ];
  const dev = profile('dev', scripts.dev ?? devSteps);
  h.services.team.addMember(caller, ws, { kind: 'agent', name: 'Dev', reportsTo: owner, roleIds: ['development', 'review', 'qa', 'product', 'architecture'], runtimeProfileIds: [dev] });
  const mission = async (title, extra = {}) => {
    const m = await h.services.missions.create(caller, { workspaceId: ws, goal: title, title, workflowPreset: 'auto', ...extra });
    await h.services.planning.plan(m.id);
    return m;
  };
  if (brain) await h.container.resolve(h.app.BRAIN_SERVICE).link(caller, ws, { mode: 'local' });
  /** A person turns auto-merge on in the app: the brain's policy plus a recorded Decision. */
  const authorize = async () => h.services.mergePolicy.update(ws, { ...(files.files.merge ?? h.app.SHIPPED_MERGE), autoMerge: 'on' }, caller);
  return { h, ghDir, origin, checkout, ws, caller, mission, files, authorize };
}
