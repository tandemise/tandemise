// P3a: outside contributions, part 1 - the pure types, schemas, events and the
// liveness split that every later P3 task builds on. A contribution (a file
// or a link) is one shape wherever it arrives; a workspace handoff link may
// carry a path instead of a url; a skipped plan stage must name a real
// upload; and a parked agent task waits on a person, not the scheduler.
// In process, over the real services: pinning, and the lazy intake that
// turns an upload into a typed artifact the planner may skip a stage for.
//
//   npm run build && node scratch/p3-contributions-check.mjs
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS } from '@tandemise/persistence';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const D = await import('@tandemise/domain');
const A = await import('@tandemise/artifacts');

section('pure: contributions, links, plans, liveness');

check('decodedSize of 4 base64 chars is 3', D.decodedSize('YWJj') === 3);
check('decodedSize honours padding', D.decodedSize('YQ==') === 1);
check('the cap is 24 MB', D.CONTRIBUTION_MAX_BYTES === 25165824);

const ok = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'Repo', kind: 'workspace', path: 'docs/spec.md' }] });
check('a workspace link may carry a path and no url', ok.success, ok.error?.issues);
const bad = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'PR', kind: 'pr', url: 'https://x/1', path: 'a' }] });
check('a pr link with a path is refused', !bad.success && bad.error.issues.some((i) => /only a workspace link may carry a path/.test(i.message)), bad.success ? bad.data : bad.error.issues);
const file = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'doc', url: 'file:///etc/passwd' }] });
check('a non-workspace link stays http(s) only', !file.success);
const noUrlNoPath = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'other' }] });
check('a non-workspace link without a url is refused', !noUrlNoPath.success && noUrlNoPath.error.issues.some((i) => /link url must be a full URL/.test(i.message)), noUrlNoPath.success ? noUrlNoPath.data : noUrlNoPath.error.issues);
const bareWorkspace = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'workspace' }] });
check('a workspace link with neither url nor path says so', !bareWorkspace.success && bareWorkspace.error.issues.some((i) => /a workspace link needs a url or a path/.test(i.message)), bareWorkspace.success ? bareWorkspace.data : bareWorkspace.error.issues);

// A minimal planned task: the shape validateMissionPlan already accepts
// (copied from the `task` fixture in scratch/p15-setup-check.mjs), parameterised
// by key, output type and dependencies since this check needs several shapes.
const minimalTask = (key, outputType, dependsOn) => ({
  key, title: key, objective: 'o', roleId: key, dependsOn, requiredCapabilities: [], inputArtifacts: [],
  expectedOutputs: [outputType], executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
  approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' },
  completionGate: null,
});
const ctx = (extra = {}) => ({ knownRoleIds: new Set(['design']), satisfiableCapabilities: new Set(), ...extra });

const pre = [{ id: 'art_up', type: 'ProductSpec' }];
const plan = {
  summary: 's',
  tasks: [/* a design task depending on nothing */ minimalTask('design', 'DesignBrief', [])],
  skipped: [{ stage: 'product', outputType: 'ProductSpec', artifactId: 'art_up', reason: 'upload' }],
};
const good = D.validateMissionPlan(plan, ctx({ preexistingArtifacts: pre }));
check('a skipped stage naming a real upload validates', good.ok, good.ok ? good.value : good.error);
const badSkip = D.validateMissionPlan({ ...plan, skipped: [{ ...plan.skipped[0], artifactId: 'art_nope' }] }, ctx({ preexistingArtifacts: pre }));
check('a skipped stage naming an unknown artifact is an error', !badSkip.ok && badSkip.error.some((e) => /not an upload of type ProductSpec/.test(e.message)), badSkip.ok ? badSkip.value : badSkip.error);

// taskLiveness is the real per-task classifier (liveness.ts); AWAITING_EXTERNAL
// now splits on executor (T8 wait vs T8b parked agent). `moves` is true, as it
// is for any task in a working mission's row.
const wctx = { byKey: new Map(), carded: new Set(), moves: true };
check('T8: a waiting wait-step is moving', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'wait' }, wctx).standing === 'moving');
check('T8b: a parked agent task waits on a person', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'agent' }, wctx).standing === 'waiting');

check('the new events are in the semantic list', ['task.parked_external', 'task.unparked', 'task.handed_back', 'mission.intake_completed'].every((t) => D.SEMANTIC_EVENT_TYPES.has(t)));
// Final review: each type a stage can be covered by or continued as has a
// name of its own; anything else is its CamelCase split into words.
check('outputTypeLabel names the linkable and skippable types one by one',
  eq(['ProductSpec', 'ProblemBrief', 'DesignBrief', 'ImplementationPlan', 'ChangeSet'].map(D.outputTypeLabel), ['Spec', 'Brief', 'Design', 'Implementation plan', 'Change']),
  ['ProductSpec', 'ProblemBrief', 'DesignBrief', 'ImplementationPlan', 'ChangeSet'].map(D.outputTypeLabel));
check('any other type is split into words', D.outputTypeLabel('ReviewReport') === 'Review report' && D.outputTypeLabel('Evidence') === 'Evidence', [D.outputTypeLabel('ReviewReport'), D.outputTypeLabel('Evidence')]);
check('an acronym stays together', D.outputTypeLabel('QAPlan') === 'QA plan' && D.outputTypeLabel('QAReport') === 'QA report', [D.outputTypeLabel('QAPlan'), D.outputTypeLabel('QAReport')]);
{
  const { pickGitCredentialEnv } = await import('@tandemise/application');
  const picked = pickGitCredentialEnv({ SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: '/bin/askpass', SSH_ASKPASS: '', GITHUB_TOKEN: 'secret', PATH: '/bin' });
  check('only the git credential variables that are set are passed to a PR fetch', eq(picked, { SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: '/bin/askpass' }), picked);
}

check('P3a added no migration: P3b\'s 020 follows 019', MIGRATIONS.find((m) => m.version === 20)?.name === 'evals' && MIGRATIONS.some((m) => m.version === 19), MIGRATIONS.map((m) => `${m.version}:${m.name}`));

// ------------------------------------------------------ the gh PR resolver
// The real GhPullRequestSnapshots over a scripted executor: which URLs reach
// gh at all, what a not-found exit becomes, and how a huge diff is cut.
section('github: pull request snapshots');
{
  const G = await import('@tandemise/integration-github');
  const ran = [];
  const scripted = (reply) => ({ run: async (req) => { ran.push(req); return { stdout: '', stderr: '', timedOut: false, durationMs: 0, command: ['gh', ...req.args].join(' '), exitCode: 0, ...reply(req) }; } });
  const view = { number: 7, title: 'Add greeting', body: 'Greets people.', headRefName: 'feat/greet', headRefOid: 'abc123', url: 'https://github.com/acme/app/pull/7' };
  const ok = new G.GhPullRequestSnapshots(scripted((req) => (req.args[1] === 'view' ? { stdout: JSON.stringify(view) } : { stdout: 'diff --git a/x b/x\n+hi\n' })));
  check('a non-PR URL never reaches gh', (await ok.read('https://www.figma.com/file/x', '/tmp')) === null && ran.length === 0, ran);
  const snap = await ok.read('https://github.com/acme/app/pull/7', '/tmp');
  check('a PR URL reads view and diff in the given cwd', eq(ran.map((r) => r.args.slice(0, 2)), [['pr', 'view'], ['pr', 'diff']]) && ran.every((r) => r.cwd === '/tmp'), ran);
  check('the snapshot carries repo, number, head and diff', snap?.repo === 'acme/app' && snap.number === 7 && snap.headRefOid === 'abc123' && snap.headRefName === 'feat/greet' && snap.diff.includes('+hi'), snap);
  const missing = new G.GhPullRequestSnapshots(scripted(() => ({ exitCode: 1, stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)' })));
  check('gh\'s real missing-PR text is null, not an error', (await missing.read('https://github.com/acme/app/pull/7', '/tmp')) === null);
  const denied = new G.GhPullRequestSnapshots(scripted(() => ({ exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration' })));
  check('a no-access exit is null, not an error', (await denied.read('https://github.com/acme/app/pull/7', '/tmp')) === null);
  const huge = new G.GhPullRequestSnapshots(scripted((req) => (req.args[1] === 'view' ? { stdout: JSON.stringify(view) } : { stdout: `${'+'.repeat(99)}\n`.repeat(30_000) })));
  const cut = await huge.read('https://github.com/acme/app/pull/7', '/tmp');
  check('a diff over 2 MB is cut and says so', cut !== null && Buffer.byteLength(cut.diff) <= 2 * 1024 * 1024 + 64 && cut.diff.endsWith('… diff truncated at 2 MB'), cut?.diff.slice(-80));
}

// ------------------------------------------------------ pinning, in process
// Real SQLite, real artifact store and real services, composed as
// scratch/p14-issues-check.mjs composes them, so the PR resolver can be
// rebound to a stub before anything resolves it.
async function engineHarness(HOME, prStub, configure = () => {}) {
  const app = await import('@tandemise/application');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
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
  const clock = systemClock;
  const log = createLogger({ level: 'error', base: { component: 'p3-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log, clock }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => clock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => { throw new Error('unused'); } }), { source: 'check' });
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
  container.rebind(app.PULL_REQUEST_SNAPSHOTS, () => prStub, { source: 'check' });
  configure(container, app);
  const services = app.createServices(container);
  return { app, container, services, paths, artifacts: container.resolve(app.ARTIFACT_REPOSITORY), repositories: container.resolve(app.REPO_REPOSITORY) };
}

section('daemon: pinning');
{
  const HOME = mkdtempSync(join(tmpdir(), 'tdm-p3-'));
  const checkout = join(HOME, 'checkout');
  mkdirSync(join(checkout, 'docs'), { recursive: true });
  writeFileSync(join(checkout, 'docs/a.md'), '# a\n');
  // A link that sits inside the repository but resolves to somewhere else.
  symlinkSync('/tmp', join(checkout, 'escape'));
  const PR = 'https://github.com/acme/app/pull/7';
  const cwds = [];
  // Swappable, so later checks can put the real resolver or a failing
  // repository behind the same bound port.
  let reader = null;
  const stub = {
    read: async (url, cwd) => {
      cwds.push(cwd);
      if (reader !== null) return reader(url, cwd);
      return url === PR
        ? { url: PR, number: 7, repo: 'acme/app', headRefName: 'feat/greet', headRefOid: 'deadbeef', title: 'Add greeting', body: 'Greets people.', diff: 'diff --git a/x b/x\n+hi\n' }
        : null;
    },
  };
  const h = await engineHarness(HOME, stub);
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Contributions' })).workspace.id;
    h.repositories.create({ id: 'rep_p3', workspaceId: ws, name: 'app', path: checkout, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Ship the greeting', title: 'Greeting' });
    const C = h.container.resolve(h.app.CONTRIBUTION_SERVICE);
    const me = h.container.resolve(h.app.MEMBER_REPOSITORY).findPersonMember(ws, caller.personId);
    const evidence = () => h.artifacts.listByMission(mission.id, 'Evidence');
    const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const b64 = (text) => Buffer.from(text).toString('base64');

    const file = { kind: 'file', filename: 'brief.md', mediaType: 'text/markdown', dataBase64: b64('# The brief\n') };
    const one = await C.pin({ missionId: mission.id, caller, contribution: file });
    const two = await C.pin({ missionId: mission.id, caller, contribution: file });
    check('a file pins as Evidence', one.evidence.type === 'Evidence' && one.filename === 'brief.md' && one.mediaType === 'text/markdown' && one.resolved === null, one);
    check('two pins of the same bytes are two manifests over one blob', one.evidence.id !== two.evidence.id && one.evidence.contentRef === two.evidence.contentRef && one.evidence.contentRef.startsWith('sha256:'), [one.evidence.contentRef, two.evidence.contentRef]);
    check('the file ref names the stored blob and the filename', one.evidence.sourceRefs.some((r) => r.kind === 'file' && r.value === one.evidence.contentRef && r.label === 'brief.md'), one.evidence.sourceRefs);
    check('the pin is on record, authored and recorded by you', h.artifacts.get(one.evidence.id)?.authorId === me?.id && h.artifacts.get(one.evidence.id)?.recordedBy === me?.id, h.artifacts.get(one.evidence.id));
    const long = await C.pin({ missionId: mission.id, caller, contribution: { ...file, filename: `${'x'.repeat(70)}.md` } });
    check('a long filename is cut to 60 characters with an ellipsis', long.evidence.title.length === 60 && long.evidence.title.endsWith('…'), long.evidence.title);

    const pr = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR } });
    const ref = (kind) => pr.evidence.sourceRefs.find((r) => r.kind === kind)?.value;
    check('a PR link is read in the workspace repository', cwds.includes(checkout), cwds);
    // This checkout is not a git repository and the harness's runner cannot
    // run git, so the head cannot be fetched: the PR's own branch name is
    // never recorded in its place, since it may not exist here.
    check('the PR Evidence carries url, github.pr and git.commit, and no git.branch it could not fetch', ref('url') === PR && ref('github.pr') === 'acme/app#7' && ref('git.commit') === 'deadbeef' && ref('git.branch') === undefined, pr.evidence.sourceRefs);
    const prBody = (await h.container.resolve(h.app.ARTIFACT_STORE).read(pr.evidence.id)).body;
    check('the PR Evidence is its title, body and diff', prBody.startsWith('# Add greeting\n\nGreets people.\n\n## Diff\n\n```diff\n') && prBody.includes('+hi'), prBody);
    check('the resolved snapshot comes back', pr.resolved?.headRefOid === 'deadbeef' && pr.mediaType === 'text/markdown', pr.resolved);

    // A diff that itself holds a fence (a changed README) must not close the block around it.
    reader = async (url) => ({ url, number: 9, repo: 'acme/app', headRefName: 'docs', headRefOid: 'f00d', title: 'Document it', body: 'Shows ```` in prose.', diff: 'diff --git a/README.md b/README.md\n+```js\n+greet()\n+```\n' });
    const fencedPr = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: 'https://github.com/acme/app/pull/9' } });
    reader = null;
    const fencedBody = (await h.container.resolve(h.app.ARTIFACT_STORE).read(fencedPr.evidence.id)).body;
    check('a diff holding ``` is fenced longer than any backtick run near it', fencedBody.includes('## Diff\n\n`````diff\n') && fencedBody.trimEnd().endsWith('\n`````') && fencedBody.includes('+```js\n+greet()\n+```\n'), fencedBody);

    // A queued draft with uploads joins the queue only once every upload is
    // pinned: until then the backlog cannot pull it into planning, and a
    // refused upload removes a mission nothing has started on.
    const workspaces = h.container.resolve(h.app.WORKSPACE_REPOSITORY);
    const missionRepo = h.container.resolve(h.app.MISSION_REPOSITORY);
    workspaces.update(ws, { maxActiveMissions: 5 });
    const slowPin = async (goal, answer) => {
      let release;
      const gate = new Promise((r) => { release = r; });
      reader = async (url) => { await gate; return answer(url); };
      const creating = h.services.missions.create(caller, { workspaceId: ws, goal, successCriteria: ['It is queued safely'], queued: true, uploads: [{ kind: 'link', url: 'https://github.com/acme/app/pull/11' }] });
      const outcome = creating.then((m) => ({ mission: m }), (error) => ({ error }));
      await new Promise((r) => setTimeout(r, 50));
      const pending = missionRepo.list({ workspaceId: ws }).find((m) => m.goal === goal);
      const pulledWhilePending = await h.services.backlog.pull();
      const afterPull = pending === undefined ? undefined : missionRepo.get(pending.id);
      release();
      const done = await outcome;
      reader = null;
      return { pending, pulledWhilePending, afterPull, ...done };
    };
    const slowOk = await slowPin('Queue me once pinned', (url) => ({ url, number: 11, repo: 'acme/app', headRefName: 'x', headRefOid: 'abc', title: 'Slow', body: '', diff: '+x\n' }));
    check('while a slow upload pins, the draft is not queued', slowOk.pending !== undefined && slowOk.pending.queuedAt === null, slowOk.pending);
    check('and the backlog does not pull it into planning', slowOk.pulledWhilePending.length === 0 && slowOk.afterPull?.status === 'DRAFT', { pulled: slowOk.pulledWhilePending, status: slowOk.afterPull?.status });
    check('once pinned, it is queued', slowOk.mission?.queuedAt !== null && missionRepo.get(slowOk.mission?.id)?.queuedAt !== null, slowOk.mission ?? slowOk.error?.message);
    if (slowOk.mission !== undefined) missionRepo.update(slowOk.mission.id, { queuedAt: null });
    const slowRefused = await slowPin('Refuse me once pinned', () => null);
    check('a slow upload that is refused removes the draft', slowRefused.error?.code === 'VALIDATION' && missionRepo.list({ workspaceId: ws }).every((m) => m.goal !== 'Refuse me once pinned'), slowRefused.error?.message);
    check('and nothing was pulled or planned for it meanwhile', slowRefused.pending?.queuedAt === null && slowRefused.pulledWhilePending.length === 0 && slowRefused.afterPull?.status === 'DRAFT', { pending: slowRefused.pending?.queuedAt, pulled: slowRefused.pulledWhilePending, status: slowRefused.afterPull?.status });
    workspaces.update(ws, { maxActiveMissions: null });

    const FIGMA = 'https://www.figma.com/file/x';
    const bare = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: FIGMA } }));
    check('a link nothing can read, without an export, is refused', bare?.code === 'unreadable_link' && bare.message === 'Nothing here can read that link. Attach an export of it.', bare && { code: bare.code, message: bare.message });
    const exported = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: FIGMA, export: { filename: 'frame.png', mediaType: 'image/png', dataBase64: b64('PNGBYTES') } } });
    const exportBody = await h.container.resolve(h.app.ARTIFACT_STORE).readBinary(exported.evidence.id);
    check('with an export it pins the export bytes', Buffer.from(exportBody).toString() === 'PNGBYTES' && exported.mediaType === 'image/png' && exported.resolved === null, Buffer.from(exportBody).toString());
    check('the export carries the url and the file', exported.evidence.sourceRefs.some((r) => r.kind === 'url' && r.value === FIGMA) && exported.evidence.sourceRefs.some((r) => r.kind === 'file' && r.value === exported.evidence.contentRef), exported.evidence.sourceRefs);

    // The real resolver over gh's own words for a PR that does not exist.
    const G = await import('@tandemise/integration-github');
    const gone = new G.GhPullRequestSnapshots({ run: async (req) => ({ exitCode: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 404. (repository.pullRequest)', timedOut: false, durationMs: 0, command: ['gh', ...req.args].join(' ') }) });
    reader = (url, cwd) => gone.read(url, cwd);
    const missingPr = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: 'https://github.com/acme/app/pull/404' } }));
    check('a missing PR with no export is unreadable, in the person\'s words', missingPr?.code === 'unreadable_link' && missingPr.message === 'Nothing here can read that link. Attach an export of it.', missingPr && { code: missingPr.code, message: missingPr.message });

    // Two repositories: the first one's gh fails outright, the second reads the PR.
    const second = join(HOME, 'second');
    mkdirSync(second, { recursive: true });
    h.repositories.create({ id: 'rep_p3_b', workspaceId: ws, name: 'app-b', path: second, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    const tried = [];
    reader = async (url, cwd) => {
      tried.push(cwd);
      if (cwd === checkout) throw new Error('gh exited 1: something broke in this checkout');
      return { url, number: 7, repo: 'acme/app', headRefName: 'feat/greet', headRefOid: 'cafe', title: 'Add greeting', body: '', diff: '+hi\n' };
    };
    const viaSecond = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR } });
    check('a failing first repository still resolves through the second', viaSecond.resolved?.headRefOid === 'cafe' && eq(tried, [checkout, second]), { tried, resolved: viaSecond.resolved });
    reader = async () => { throw new Error('gh exited 1: signed out'); };
    const allFail = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR } }));
    check('when every repository fails and there is no export, the failure is said', /signed out/.test(allFail?.message ?? ''), allFail?.message);
    const allFailExport = await C.pin({ missionId: mission.id, caller, contribution: { kind: 'link', url: PR, export: { filename: 'pr.txt', mediaType: 'text/plain', dataBase64: b64('exported') } } });
    check('when every repository fails an export is still pinned', allFailExport.resolved === null && allFailExport.filename === 'pr.txt', allFailExport);
    reader = null;

    const before = evidence().length;
    const big = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'file', filename: 'big.bin', mediaType: 'application/octet-stream', dataBase64: Buffer.alloc(D.CONTRIBUTION_MAX_BYTES + 1).toString('base64') } }));
    check('24 MB + 1 byte is too large', big?.code === 'too_large' && big.message === 'That file is larger than 24 MB.', big && { code: big.code, message: big.message });
    const empty = await refusal(() => C.pin({ missionId: mission.id, caller, contribution: { kind: 'file', filename: 'nothing.txt', mediaType: 'text/plain', dataBase64: '' } }));
    check('an empty file is refused', empty?.code === 'empty', empty && { code: empty.code, message: empty.message });
    check('a refused pin writes no artifact', evidence().length === before, [before, evidence().length]);

    const inside = await C.resolveWorkspacePath(ws, 'docs/a.md');
    check('a path inside the repository resolves to it', inside.endsWith('/checkout/docs/a.md'), inside);
    const up = await refusal(() => C.resolveWorkspacePath(ws, '../x'));
    check('a path with .. is refused', up?.code === 'outside_workspace', up && { code: up.code, message: up.message });
    const roundTrip = await refusal(() => C.resolveWorkspacePath(ws, 'docs/../docs/a.md'));
    check('a .. is refused even when it would land inside', roundTrip?.code === 'outside_workspace', roundTrip && { code: roundTrip.code, message: roundTrip.message });
    const link = await refusal(() => C.resolveWorkspacePath(ws, 'escape'));
    check('a symlink out of the repository is refused', link?.code === 'outside_workspace', link && { code: link.code, message: link.message });
    const artifactPath = await C.resolveWorkspacePath(ws, `blobs/${one.evidence.sha256.slice(0, 2)}/${one.evidence.sha256}`);
    check('a path inside the artifact root resolves', artifactPath.endsWith(one.evidence.sha256), artifactPath);
  } finally {
    h.container.resolve((await import('@tandemise/persistence')).DATABASE).close?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ------------------------------------------------ intake and skipped stages
// Uploads pinned at creation are converted once, lazily, at the first
// refinement or planning; an intake ProductSpec that passes the Done-when
// check lets the planner skip the product stage, which becomes a SKIPPED
// placeholder. One fake profile plays every part, each step keyed to the
// prompt it answers, so the intake and the planner never see each other's
// steps.
section('daemon: intake and skips');
{
  // Short: a run's tool bridge socket lives under HOME, and macOS caps its path near 104 bytes.
  const HOME = mkdtempSync(join(tmpdir(), 'tpi-'));
  const checkout = join(HOME, 'checkout');
  mkdirSync(join(checkout, '.tandemise', 'workflows'), { recursive: true });
  // The project's own workflow: one step, and nothing a planner could skip.
  writeFileSync(join(checkout, '.tandemise/workflows/p3-flow.yaml'), [
    'name: P3 own flow', 'steps:',
    '  - key: brief', '    role: product', '    objective: Write the problem brief for the greeting.', '    outputs: [ProblemBrief]', '',
  ].join('\n'));
  // Planning and intake read a real checkout.
  const { execFileSync } = await import('node:child_process');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=P3', '-c', 'user.email=p3@example.com', ...args], { cwd: checkout, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const { FileWorkflowSource } = await import('../apps/daemon/dist/workflow-source.js');
  const h = await engineHarness(HOME, { read: async () => null }, (container, app) => {
    container.rebind(app.WORKFLOW_SOURCE, () => new FileWorkflowSource({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }), { source: 'check' });
  });
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Intake' })).workspace.id;
    h.repositories.create({ id: 'rep_p3_intake', workspaceId: ws, name: 'app', path: checkout, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    h.container.resolve(h.app.WORKSPACE_REPOSITORY).update(ws, { defaultRepositoryId: 'rep_p3_intake' });

    const spec = [
      '---', 'type: ProductSpec', 'schemaVersion: 1', 'title: Greeting spec',
      'handoff:', '  headline: The greeting, specified from your upload',
      'acceptanceCriteria:', '  - id: AC1', '    statement: The page greets the visitor by name', '    covers:', '      - U1',
      '---', '', '## Scope', '', 'A greeting.', '', '## Acceptance criteria', '', '- AC1: the page greets the visitor by name.', '',
    ].join('\n');
    const planJson = (artifactId, inputArtifacts = [{ type: 'ProductSpec', required: true }]) => JSON.stringify({
      summary: 'The upload is the spec, so design starts from it.',
      tasks: [{ key: 'design', title: 'Design the greeting', objective: 'Design the greeting from the spec.', roleId: 'design', dependsOn: [], inputArtifacts, expectedOutputs: ['DesignBrief'] }],
      skipped: [{ stage: 'product', outputType: 'ProductSpec', artifactId, reason: 'Your upload is the spec.' }],
    });
    const INTAKE = { promptIncludes: 'Turn the uploaded input into' };
    const PLANNER = { promptIncludes: 'You are the Planner' };
    const script = (skipId, inputs) => ({
      resume: 'ok',
      captures: { dest: 'Write it to `([^`]+)`', upload: '^- ProductSpec "[^"]*" \\(id ([^)]+)\\)' },
      steps: [
        { kind: 'write-file', path: 'prompts/intake-{{runId}}.txt', content: '{{prompt}}', when: INTAKE },
        { kind: 'write-file', path: '{{dest}}', content: spec, when: INTAKE },
        { kind: 'write-file', path: 'prompts/planner-{{runId}}.txt', content: '{{prompt}}', when: PLANNER },
        { kind: 'message', text: planJson(skipId, inputs), when: PLANNER },
        { kind: 'complete', summary: 'done' },
      ],
    });
    const profile = await h.services.runtimes.create({ adapterId: 'fake', name: 'Scripted', workspaceId: ws, settings: { script: script('{{upload}}') }, maxConcurrent: 4 });
    const profiles = h.container.resolve(h.app.RUNTIME_PROFILE_REPOSITORY);
    const events = h.container.resolve(h.app.EVENT_REPOSITORY);
    const intakes = (missionId) => events.listByMission(missionId).filter((e) => e.body.type === 'mission.intake_completed').map((e) => e.body);
    const tasksOf = (missionId) => h.container.resolve(h.app.TASK_REPOSITORY).listByMission(missionId);
    const b64 = (text) => Buffer.from(text).toString('base64');
    const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const { readdirSync, readFileSync } = await import('node:fs');
    const plannerPrompts = (goal) => {
      let files = [];
      try { files = readdirSync(join(checkout, 'prompts')).filter((f) => f.startsWith('planner-')); } catch { /* none yet */ }
      return files.map((f) => readFileSync(join(checkout, 'prompts', f), 'utf8')).filter((p) => p.includes(goal));
    };
    const upload = { kind: 'file', filename: 'greeting-spec.md', mediaType: 'text/markdown', dataBase64: b64('# Greeting\n\nGreet the visitor by name.\n\n## Acceptance criteria\n\n- The page greets the visitor by name.\n') };

    // ---- creation pins, and runs no intake
    const GOAL = 'Greet the visitor by name';
    const m = await h.services.missions.create(caller, { workspaceId: ws, goal: GOAL, title: 'Greeting', successCriteria: ['The page greets the visitor by name'], uploads: [upload] });
    const evidence = h.artifacts.listByMission(m.id, 'Evidence');
    check('creating with an upload pins it as Evidence with no task', evidence.length === 1 && evidence[0].taskId === null && evidence[0].sourceRefs[0]?.label === 'greeting-spec.md', evidence);
    check('the pinned upload is on the timeline', events.listByMission(m.id).some((e) => e.body.type === 'artifact.created' && e.body.artifactId === evidence[0]?.id));
    check('creation runs no intake', intakes(m.id).length === 0, intakes(m.id));

    // ---- planning runs intake once, and the planner skips the covered stage
    await h.services.planning.plan(m.id);
    const first = intakes(m.id);
    const made = h.artifacts.listByMission(m.id).filter((a) => a.type === 'ProductSpec');
    const intake = made[0];
    check('planning runs intake once', first.length === 1 && first[0].uploads === 1 && first[0].failed.length === 0, first);
    check('intake made one ProductSpec with no task', made.length === 1 && intake.taskId === null, made);
    check('the event lists what intake made', eq(first[0]?.produced, [{ artifactId: intake?.id, type: 'ProductSpec' }]), first[0]);
    check('the intake artifact carries the upload\'s refs', eq(intake?.sourceRefs, evidence[0]?.sourceRefs), intake?.sourceRefs);
    check('intake is authored by the runtime, recorded by the system, answered for by the creator',
      intake?.authorId === D.RUNTIME_ACTOR && intake?.recordedBy === D.SYSTEM_ACTOR && intake?.responsibleId === m.createdBy, intake);
    const link = intake?.handoff?.links?.find((l) => l.kind === 'workspace');
    check('a local upload gets a workspace link to its stored blob', link?.path === `blobs/${evidence[0]?.sha256.slice(0, 2)}/${evidence[0]?.sha256}` && link.url === undefined, intake?.handoff);
    const listPrompts = () => { try { return readdirSync(join(checkout, 'prompts')); } catch { return []; } };
    const ledger = h.container.resolve(h.app.MISSION_CRITERIA_REPOSITORY).listActive(m.id);
    check('a covering intake spec joins the Done-when ledger like a product step\'s', ledger.some((c) => c.key === 'AC1' && c.specArtifactId === intake?.id), ledger.map((c) => [c.key, c.source, c.specArtifactId]));
    const intakePrompt = listPrompts().filter((f) => f.startsWith('intake-')).map((f) => readFileSync(join(checkout, 'prompts', f), 'utf8'))[0] ?? '';
    check('the intake prompt names the upload and its fixed objective', intakePrompt.includes('greeting-spec.md') && intakePrompt.includes('preserving its content. The Evidence is the source of truth.'), intakePrompt.slice(0, 600));
    const prompts = plannerPrompts(GOAL);
    check('the planner is told the upload covers a stage', prompts.length === 1 && prompts[0].includes(`- ProductSpec "Greeting spec" (id ${intake?.id})`)
      && prompts[0].includes('An upload already covers a stage when a preexisting artifact of that stage\'s output type exists. Omit the stage and name it under `skipped` with the artifact it was covered by.'), prompts.map((p) => p.slice(-2500)));

    const tasks = tasksOf(m.id);
    const placeholder = tasks.find((t) => t.status === 'SKIPPED');
    const design = tasks.find((t) => t.key === 'design');
    check('the skipped stage is a SKIPPED placeholder', placeholder?.roleId === 'product' && eq(placeholder.expectedOutputs, ['ProductSpec']) && placeholder.completionGate === null, placeholder);
    check('the placeholder says which upload covers it', placeholder?.statusReason === 'Covered by your upload: greeting-spec.md', placeholder?.statusReason);
    check('the stage that reads the spec depends on the placeholder', design !== undefined && design.dependsOn.includes(placeholder?.key), design?.dependsOn);
    const detail = await h.services.projections.missionDetail(m.id);
    check('the plan validates on read', eq(detail.planIssues, []), detail.planIssues);
    const view = detail.tasks.find((t) => t.id === placeholder?.id);
    check('the placeholder is covered by the upload', view?.coveredBy?.filename === 'greeting-spec.md' && view.coveredBy.artifactId === intake?.id, view?.coveredBy);
    check('other tasks are covered by nothing', detail.tasks.filter((t) => t.id !== placeholder?.id).every((t) => t.coveredBy === null), detail.tasks.map((t) => t.coveredBy));
    check('the mission lists its upload and what intake made of it', detail.uploads?.length === 1 && detail.uploads[0].evidenceId === evidence[0]?.id
      && detail.uploads[0].filename === 'greeting-spec.md' && detail.uploads[0].mediaType === 'text/markdown' && detail.uploads[0].intakeArtifactId === intake?.id, detail.uploads);

    // ---- the same bytes again, then a replan: one blob, still one intake
    const again = await h.container.resolve(h.app.CONTRIBUTION_SERVICE).pin({ missionId: m.id, caller, contribution: upload });
    check('the same bytes pinned again are the same blob', again.evidence.contentRef === evidence[0]?.contentRef);
    await h.services.planning.plan(m.id);
    check('a replan runs no second intake', intakes(m.id).length === 1 && h.artifacts.listByMission(m.id).filter((a) => a.type === 'ProductSpec').length === 1, intakes(m.id));
    check('the replan still skips the covered stage', tasksOf(m.id).filter((t) => t.status === 'SKIPPED').length === 1, tasksOf(m.id).map((t) => [t.key, t.status]));

    // ---- an intake spec that leaves a Done-when line uncovered covers nothing
    const GOAL2 = 'Greet the visitor and say goodbye';
    const m2 = await h.services.missions.create(caller, { workspaceId: ws, goal: GOAL2, title: 'Greeting and goodbye', successCriteria: ['The page greets the visitor by name', 'The page says goodbye'], uploads: [upload] });
    await h.services.planning.plan(m2.id);
    const intake2 = h.artifacts.listByMission(m2.id).filter((a) => a.type === 'ProductSpec');
    check('intake still runs for an uncovered spec', intakes(m2.id).length === 1 && intake2.length === 1, intakes(m2.id));
    const ledger2 = h.container.resolve(h.app.MISSION_CRITERIA_REPOSITORY).listActive(m2.id);
    check('an uncovered intake spec stays off the ledger', ledger2.every((c) => c.specArtifactId === null), ledger2.map((c) => [c.key, c.specArtifactId]));
    const prompts2 = plannerPrompts(GOAL2);
    check('the planner is not offered an uncovered spec', prompts2.length > 0 && prompts2.every((p) => !p.includes(`(id ${intake2[0]?.id})`)), prompts2.map((p) => p.slice(-1500)));
    // Now the planner names the real intake artifact: still not an upload it may skip for.
    profiles.update(profile.id, { settings: { script: script(intake2[0]?.id ?? 'none') } });
    await h.services.planning.plan(m2.id);
    const rejected = events.listByMission(m2.id).filter((e) => e.body.type === 'note' && /skipped stage 'product' names .*which is not an upload of type ProductSpec/.test(e.body.text));
    check('a plan skipping the product stage for an uncovered spec is rejected', rejected.some((e) => e.body.text.includes(intake2[0]?.id)), events.listByMission(m2.id).filter((e) => e.body.type === 'note').map((e) => e.body.text));
    check('no placeholder is made for an uncovered spec', tasksOf(m2.id).length > 0 && tasksOf(m2.id).every((t) => t.status !== 'SKIPPED'), tasksOf(m2.id).map((t) => [t.key, t.status]));
    profiles.update(profile.id, { settings: { script: script('{{upload}}') } });

    // ---- refinement is the first of the two, when it comes first
    const GOAL3 = 'Greet the visitor in their language';
    const m3 = await h.services.missions.create(caller, { workspaceId: ws, goal: GOAL3, title: 'Localised greeting', successCriteria: ['The page greets the visitor by name'], uploads: [upload] });
    h.services.refinement.begin(caller, m3.id);
    await h.services.refinement.settled(m3.id);
    check('the first refinement runs intake', intakes(m3.id).length === 1, intakes(m3.id));
    await h.services.planning.plan(m3.id);
    check('planning after refinement runs no second intake', intakes(m3.id).length === 1 && tasksOf(m3.id).some((t) => t.status === 'SKIPPED'), intakes(m3.id));

    // ---- refine first with no Done-when lines: the spec covers only once U1 is accepted
    const GOAL5 = 'Greet the visitor, lines to come';
    const m5 = await h.services.missions.create(caller, { workspaceId: ws, goal: GOAL5, title: 'Greeting, refined', uploads: [upload] });
    h.services.refinement.begin(caller, m5.id);
    await h.services.refinement.settled(m5.id);
    const intake5 = h.artifacts.listByMission(m5.id).find((a) => a.type === 'ProductSpec');
    const criteriaRepo = h.container.resolve(h.app.MISSION_CRITERIA_REPOSITORY);
    const specRows = (id) => criteriaRepo.listActive(id).filter((c) => c.source === 'spec');
    check('refinement converts the upload before any line exists', intakes(m5.id).length === 1 && intake5 !== undefined && specRows(m5.id).length === 0, { intakes: intakes(m5.id), rows: specRows(m5.id) });
    h.services.refinement.addCriterion(caller, m5.id, { statement: 'The page greets the visitor by name' });
    await h.services.planning.plan(m5.id);
    check('once U1 is accepted the plan skips the product stage', tasksOf(m5.id).some((t) => t.status === 'SKIPPED' && t.roleId === 'product'), tasksOf(m5.id).map((t) => [t.key, t.status]));
    check('and the spec it skipped for is the ledger\'s spec', specRows(m5.id).length > 0 && specRows(m5.id).every((c) => c.specArtifactId === intake5?.id), specRows(m5.id).map((c) => [c.key, c.specArtifactId]));
    check('still one intake', intakes(m5.id).length === 1, intakes(m5.id));
    // A line the spec does not cover arrives: it covers nothing any more.
    criteriaRepo.addUserCriteria(m5.id, ['The page says goodbye']);
    await h.services.planning.plan(m5.id);
    const prompts5 = plannerPrompts(GOAL5);
    check('a spec that stops covering is not offered', prompts5.length >= 2 && !prompts5[prompts5.length - 1].includes(`(id ${intake5?.id})`) && prompts5.some((p) => p.includes(`(id ${intake5?.id})`)), prompts5.map((p) => p.slice(-800)));
    check('and no placeholder is made for it', tasksOf(m5.id).every((t) => t.status !== 'SKIPPED'), tasksOf(m5.id).map((t) => [t.key, t.status]));

    // ---- a stage after a skip reads the upload, even when the planner did not list it
    // A planner that leaves `inputArtifacts` empty still gets a design step
    // that waits on the placeholder and may read the intake spec, so its run
    // is given the upload that replaced the stage before it.
    profiles.update(profile.id, { settings: { script: script('{{upload}}', []) } });
    const GOAL6 = 'Greet the visitor, inputs unnamed';
    const m6 = await h.services.missions.create(caller, { workspaceId: ws, goal: GOAL6, title: 'Greeting, unnamed inputs', successCriteria: ['The page greets the visitor by name'], uploads: [upload] });
    await h.services.planning.plan(m6.id);
    profiles.update(profile.id, { settings: { script: script('{{upload}}') } });
    const placeholder6 = tasksOf(m6.id).find((t) => t.status === 'SKIPPED');
    const design6 = tasksOf(m6.id).find((t) => t.key === 'design');
    const intake6 = h.artifacts.listByMission(m6.id).find((a) => a.type === 'ProductSpec');
    check('a root step with no inputs named waits on the placeholder', placeholder6 !== undefined && design6?.dependsOn.includes(placeholder6.key), design6?.dependsOn);
    check('and may read its type, optionally', design6?.inputArtifacts.some((r) => r.type === 'ProductSpec' && r.required === false), design6?.inputArtifacts);
    {
      const scheduler = h.container.resolve(h.app.SCHEDULER);
      const runs = h.container.resolve(h.app.RUN_REPOSITORY);
      const runInputs = h.container.resolve(h.app.RUN_INPUT_REPOSITORY);
      const missionRepo = h.container.resolve(h.app.MISSION_REPOSITORY);
      for (const approval of h.container.resolve(h.app.APPROVAL_REPOSITORY).list({ missionId: m6.id, statuses: ['PENDING'] })) {
        await h.services.approvals.decide(caller, approval.id, { optionId: D.APPROVE_OPTION }).catch(() => {});
      }
      if (missionRepo.get(m6.id).status !== 'EXECUTING') missionRepo.update(m6.id, { status: 'EXECUTING' });
      const end = Date.now() + 15000;
      while (Date.now() < end && runs.listByTask(design6.id).length === 0) {
        await scheduler.tick();
        await new Promise((r) => setTimeout(r, 40));
      }
      const run6 = runs.listByTask(design6.id)[0];
      check('its run is given the intake spec as an input', run6 !== undefined && runInputs.listByRun(run6.id).includes(intake6?.id), { run: run6?.id, inputs: run6 && runInputs.listByRun(run6.id), intake: intake6?.id, status: tasksOf(m6.id).map((t) => [t.key, t.status, t.statusReason]) });
      while (Date.now() < end && scheduler.activeTaskIds().length > 0) {
        await scheduler.tick();
        await new Promise((r) => setTimeout(r, 40));
      }
      missionRepo.update(m6.id, { status: 'CANCELLED' });
    }

    // ---- a project's own workflow never skips
    const m4 = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Run our own flow', title: 'Own flow', successCriteria: ['The page greets the visitor by name'], workflowPreset: 'p3-flow', uploads: [upload] });
    await h.services.planning.plan(m4.id);
    check('an authored workflow still runs intake', intakes(m4.id).length === 1, intakes(m4.id));
    check('an authored workflow gets no placeholder', eq(tasksOf(m4.id).map((t) => [t.key, t.status]), [['brief', 'READY']]), tasksOf(m4.id).map((t) => [t.key, t.status]));

    // ---- a refused upload creates no mission
    const before = h.container.resolve(h.app.MISSION_REPOSITORY).list({}).length;
    const refused = await refusal(() => h.services.missions.create(caller, { workspaceId: ws, goal: 'Build from a figma link', uploads: [{ kind: 'link', url: 'https://www.figma.com/file/x' }] }));
    check('a bare unreadable link at creation is a 400', refused?.code === 'VALIDATION' && refused.message === 'Nothing here can read that link. Attach an export of it.', refused && { code: refused.code, message: refused.message });
    check('the refused upload left no mission behind', h.container.resolve(h.app.MISSION_REPOSITORY).list({}).length === before, [before, h.container.resolve(h.app.MISSION_REPOSITORY).list({}).length]);
  } finally {
    h.container.resolve((await import('@tandemise/persistence')).DATABASE).close?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ------------------------------------------------ park and hand back
// "Continue elsewhere" and "Hand back" over the real engine: a fake runtime
// drives each agent step, the scheduler is ticked by hand, and the PR
// resolver is the same stub as above. Each scenario is its own mission; the
// first has a project of its own so the Desk and Inbox counts are exact.
section('daemon: park and hand back');
{
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const keepAlive = setInterval(() => {}, 1000);
  // Short: the tool bridge's unix socket lives under HOME, and macOS caps its path near 104 bytes.
  const HOME = mkdtempSync(join(tmpdir(), 'tpk-'));
  const PR = 'https://github.com/acme/app/pull/7';
  // Known to gh, but its head is nowhere this checkout can fetch it from.
  const PR_UNFETCHABLE = 'https://github.com/acme/app/pull/8';
  // The project's checkout and the "GitHub" it fetches from: a local bare
  // repository holding the pull request's head only as `refs/pull/7/head`,
  // as GitHub does. The PR's own branch (feat/greet) is never local, as for a
  // fork, a web edit or another machine's work.
  const checkout = join(HOME, 'checkout');
  const remoteRepo = join(HOME, 'remote.git');
  mkdirSync(checkout, { recursive: true });
  const gitc = (...args) => execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.com', ...args], { cwd: checkout, stdio: 'pipe' }).toString().trim();
  const commitFile = (name) => { writeFileSync(join(checkout, name), `${name}\n`); gitc('add', name); gitc('commit', '-q', '-m', name); };
  gitc('init', '-q', '-b', 'main');
  commitFile('README.md');
  execFileSync('git', ['init', '-q', '-b', 'main', '--bare', remoteRepo]);
  // Named for GitHub and rewritten to the bare repository, with no `origin`:
  // the fetch has to find the remote whose configured URL is acme/app.
  gitc('config', `url.${remoteRepo}.insteadOf`, 'https://github.com/acme/app.git');
  gitc('remote', 'add', 'acme', 'https://github.com/acme/app.git');
  gitc('push', '-q', 'acme', 'main');
  gitc('checkout', '-q', '-b', 'feat/greet');
  commitFile('greet.txt');
  const prSha = gitc('rev-parse', 'HEAD');
  gitc('push', '-q', 'acme', 'HEAD:refs/pull/7/head');
  gitc('checkout', '-q', 'main');
  gitc('branch', '-q', '-D', 'feat/greet');
  // Two agent worktree branches: the one a hand-back replaces, and another step's.
  for (const [branch, file] of [['agent/build', 'agent.txt'], ['agent/other', 'other.txt']]) {
    gitc('checkout', '-q', '-b', branch);
    commitFile(file);
    gitc('checkout', '-q', 'main');
  }
  // More pull requests, each set up by the scenario that hands it back.
  const extraPrs = new Map();
  const stub = {
    read: async (url) => (extraPrs.has(url) ? extraPrs.get(url) : url === PR
      ? { url: PR, number: 7, repo: 'acme/app', headRefName: 'feat/greet', headRefOid: prSha, title: 'Add greeting', body: 'Greets people.', diff: 'diff --git a/x b/x\n+hi\n' }
      : url === PR_UNFETCHABLE
        ? { url, number: 8, repo: 'acme/app', headRefName: 'feat/elsewhere', headRefOid: 'feedface', title: 'From a fork', body: '', diff: '+fork\n' }
        : null),
  };
  // Only git runs for real, so fetching a handed-back pull request's head is
  // exercised end to end; anything else keeps the harness's refusal.
  const { COMMAND_EXECUTOR } = await import('@tandemise/integrations-core');
  const { execFile } = await import('node:child_process');
  const gitCalls = [];
  const gitOnly = {
    run: (req) => new Promise((resolve, reject) => {
      if (req.command !== 'git') { reject(new Error('unused')); return; }
      gitCalls.push({ args: [...(req.args ?? [])], env: { ...(req.env ?? {}) }, cwd: req.cwd });
      const started = Date.now();
      execFile('git', [...(req.args ?? [])], { cwd: req.cwd, env: { ...process.env, ...(req.env ?? {}) }, timeout: req.timeoutMs }, (error, stdout, stderr) => resolve({
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, timedOut: false,
        durationMs: Date.now() - started, command: ['git', ...(req.args ?? [])].join(' '),
      }));
    }),
  };
  // The daemon binds this to its own ssh-agent socket and askpass helpers; a
  // fake one proves they reach the fetch.
  const h = await engineHarness(HOME, stub, (container, app) => {
    container.rebind(COMMAND_EXECUTOR, () => gitOnly, { source: 'check' });
    container.bind(app.GIT_CREDENTIAL_ENV, () => () => ({ SSH_AUTH_SOCK: '/tmp/fake-agent.sock' }), { source: 'check' });
  });
  const scheduler = h.container.resolve(h.app.SCHEDULER);
  const repo = {
    tasks: h.container.resolve(h.app.TASK_REPOSITORY),
    missions: h.container.resolve(h.app.MISSION_REPOSITORY),
    runs: h.container.resolve(h.app.RUN_REPOSITORY),
    events: h.container.resolve(h.app.EVENT_REPOSITORY),
    profiles: h.container.resolve(h.app.RUNTIME_PROFILE_REPOSITORY),
    feedback: h.container.resolve(h.app.FEEDBACK_REPOSITORY),
    runInputs: h.container.resolve(h.app.RUN_INPUT_REPOSITORY),
    workspaces: h.container.resolve(h.app.WORKSPACE_REPOSITORY),
  };
  const now = () => systemClock.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(40);
    }
    return fn();
  };
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const b64 = (text) => Buffer.from(text).toString('base64');
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const brief = (headline = 'Greeting designed', changed = null) => [
      '---', 'type: DesignBrief', 'title: Greeting design', 'handoff:', `  headline: ${headline}`,
      ...(changed === null ? [] : ['  changed:', `    - what: ${JSON.stringify(changed)}`, '      feedback: "{{fb}}"']),
      'flows:', '  - greeting', '---', '', '# Greeting', '', `${headline}.`, '',
    ].join('\n');
    const IN_ROUND = { promptIncludes: 'Feedback to address' };
    const write = (content, when) => ({ kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content, ...(when ? { when } : {}) });
    const promptFile = { kind: 'write-file', path: 'prompts/{{runId}}.txt', content: '{{prompt}}' };
    const done = { kind: 'complete', summary: 'done' };
    const profile = (name, steps, extra = {}) => repo.profiles.create({
      id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
      settings: { script: { steps, ...extra } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
    }).id;
    const slowProfile = profile('slow', [promptFile, write(brief()), { kind: 'delay', ms: 4000 }, done]);
    // The consumer writes another type: a DesignBrief downstream would itself supersede design's.
    const problem = ['---', 'type: ProblemBrief', 'title: Greeting problem', 'handoff:', '  headline: The problem, from the design', 'successMetric: Visitors are greeted', '---', '', '# Problem', '', 'Greet people.', ''].join('\n');
    const readerProfile = profile('reader', [{ kind: 'write-file', path: '.tandemise/out/ProblemBrief.md', content: problem }, done]);
    const quickProfile = profile('quick', [promptFile, write(brief()), write(brief('Greeting, revised', 'Used the attached frames'), IN_ROUND), done], { captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' } });

    const project = async (name) => {
      const ws = (await h.services.workspaces.create(caller, { name })).workspace.id;
      const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
      const agent = (label, profileId) => h.services.team.addMember(caller, ws, { kind: 'agent', name: label, reportsTo: owner, roleIds: ['design'], runtimeProfileIds: [profileId] }).id;
      return { ws, owner, slow: agent('Slow designer', slowProfile), quick: agent('Quick designer', quickProfile), reader: agent('Reader', readerProfile) };
    };
    let seq = 0;
    const addMission = async (p, defs) => {
      const mission = await h.services.missions.create(caller, { workspaceId: p.ws, goal: 'Design the greeting', title: `Park ${++seq}` });
      const dir = h.paths.mission(p.ws, mission.id);
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
      const t = {};
      for (const d of defs) {
        t[d.key] = repo.tasks.add({
          id: ids.task(), missionId: mission.id, key: d.key, title: d.key, objective: 'o', roleId: 'design',
          dependsOn: d.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: d.inputArtifacts ?? [], expectedOutputs: d.expectedOutputs ?? ['DesignBrief'],
          executionPolicy: { isolation: d.isolation ?? 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
          retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
          status: d.status ?? (d.dependsOn ? 'PENDING' : 'READY'), statusReason: d.statusReason ?? null, attempts: 0, remediatesTaskId: null, repositoryId: null,
          executor: d.executor ?? 'agent', waitPolicy: d.waitPolicy ?? null, orderHint: d.orderHint ?? 0, staffingOverride: d.agent ? { assignees: [d.agent] } : null,
          createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
        }).id;
      }
      repo.missions.update(mission.id, { status: 'EXECUTING' });
      return { mission, dir, t };
    };
    const task = (id) => repo.tasks.get(id);
    const eventsOf = (missionId, type) => repo.events.listByMission(missionId).filter((e) => e.body.type === type);
    const live = (id, type) => { const all = h.artifacts.listByTask(id).filter((a) => type === undefined || a.type === type); const sup = new Set(all.map((a) => a.supersedes)); return all.filter((a) => !sup.has(a.id)); };
    const runsOf = (id) => [...repo.runs.listByTask(id)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const file = { kind: 'file', filename: 'frames.md', mediaType: 'text/markdown', dataBase64: b64('# Frames\n\nThe greeting, drawn in Figma.\n') };

    // ---- park a running step, then hand it back with a file
    const solo = await project('Parking');
    repo.workspaces.update(solo.ws, { concurrency: { ...repo.workspaces.get(solo.ws).concurrency, maxTotalWorkers: 1 } });
    const one = await addMission(solo, [{ key: 'design', agent: solo.slow, orderHint: 0 }, { key: 'other', agent: solo.quick, orderHint: 1 }]);
    await until(() => runsOf(one.t.design).some((r) => r.status === 'RUNNING'));
    check('the design step is running and holds the only slot', task(one.t.design).status === 'RUNNING' && task(one.t.other).status === 'READY', [task(one.t.design).status, task(one.t.other).status]);
    const parked = await h.services.missions.parkTask(one.t.design, caller, { tool: 'Figma' });
    check('parkTask answers with the parked view', parked.status === 'AWAITING_EXTERNAL' && parked.parkedExternal?.tool === 'Figma', parked);
    await until(() => !scheduler.activeTaskIds().includes(one.t.design));
    check('park while running: the run aborts and the step stays AWAITING_EXTERNAL, not CANCELLED', task(one.t.design).status === 'AWAITING_EXTERNAL' && task(one.t.design).statusReason === 'Continued in Figma', task(one.t.design));
    const parkEvents = eventsOf(one.mission.id, 'task.parked_external');
    check('task.parked_external is recorded with the tool', parkEvents.length === 1 && parkEvents[0].body.tool === 'Figma' && parkEvents[0].taskId === one.t.design, parkEvents.map((e) => e.body));
    const runsBefore = runsOf(one.t.design).length;
    scheduler.wake();
    await scheduler.tick();
    await scheduler.tick();
    check('a parked step is not dispatched again', runsOf(one.t.design).length === runsBefore && task(one.t.design).status === 'AWAITING_EXTERNAL', [runsBefore, runsOf(one.t.design).length, task(one.t.design).status]);
    await until(() => task(one.t.other).status === 'SUCCEEDED');
    check('the parked step leaves the concurrency ceiling: the next step runs', task(one.t.other).status === 'SUCCEEDED', task(one.t.other));
    const view = (await h.services.projections.missionTasks(one.mission.id)).find((v) => v.id === one.t.design);
    check('TaskView.parkedExternal names the tool and the park time', view?.parkedExternal?.tool === 'Figma' && view.parkedExternal.since === parkEvents[0].createdAt, view?.parkedExternal);
    check('a step never parked has parkedExternal null', (await h.services.projections.missionTasks(one.mission.id)).find((v) => v.id === one.t.other)?.parkedExternal === null);
    check('the Desk counts one step waiting on a person', h.services.desk.metrics(solo.ws).needsYou === 1, h.services.desk.metrics(solo.ws).needsYou);
    const facts = h.services.desk.reportFacts(solo.ws).missions.find((m) => m.title === one.mission.title);
    check('the status report says the parked step waits on a person', facts?.waitingOn.includes("'design' waits on a person"), facts?.waitingOn);
    const inbox = h.services.projections.inbox(solo.ws);
    const row = inbox.parked?.[0];
    check('the Inbox lists "Waiting for your work in Figma"', inbox.parked?.length === 1 && row.title === 'Waiting for your work in Figma' && row.taskId === one.t.design && row.missionId === one.mission.id, inbox.parked);
    check('its action opens the mission at that step', row?.href === `/missions/${one.mission.id}?task=${one.t.design}`, row?.href);
    check('the parked row is for the person who parked it', eq(row?.forIds, [solo.owner]), row?.forIds);
    check('the mission is waiting, not moving', h.services.liveness.classify(one.mission.id).kind === 'waiting', h.services.liveness.classify(one.mission.id));

    const artifactsBefore = h.artifacts.listByMission(one.mission.id).length;
    const handed = await h.services.missions.handBack(one.t.design, caller, { note: 'Designed in Figma. The frames are attached.', contribution: file });
    const [out] = live(one.t.design, 'DesignBrief');
    check('hand back: the step succeeded in round 2', task(one.t.design).status === 'SUCCEEDED' && task(one.t.design).round === 2 && handed.task.status === 'SUCCEEDED', task(one.t.design));
    check('hand back: one new DesignBrief, round 2, supersedes nothing the agent never finished', handed.artifacts.length === 1 && out?.id === handed.artifacts[0].id && out.round === 2 && out.supersedes === null, out);
    check('hand back: written and recorded by you, assigned to you', out?.authorId === solo.owner && out.recordedBy === solo.owner && task(one.t.design).assigneeId === solo.owner, [out?.authorId, out?.recordedBy, task(one.t.design).assigneeId]);
    check('hand back: the handoff headline is the note', out?.handoff?.headline === 'Designed in Figma.', out?.handoff);
    const evidence = h.artifacts.listByTask(one.t.design).find((a) => a.type === 'Evidence');
    check('hand back: the file is pinned as Evidence on the step', evidence !== undefined && evidence.sourceRefs.some((r) => r.kind === 'file' && r.label === 'frames.md'), evidence);
    check('hand back: the output carries the Evidence\'s refs', evidence !== undefined && evidence.sourceRefs.every((r) => out?.sourceRefs.some((o) => o.kind === r.kind && o.value === r.value)), out?.sourceRefs);
    check('hand back: a workspace link opens the stored file', out?.handoff?.links.some((l) => l.kind === 'workspace' && l.path === `blobs/${evidence?.sha256.slice(0, 2)}/${evidence?.sha256}`), out?.handoff?.links);
    const handedEvents = eventsOf(one.mission.id, 'task.handed_back');
    check('task.handed_back is recorded', handedEvents.length === 1 && eq(handedEvents[0].body.artifactIds, [out?.id]) && handedEvents[0].body.round === 2 && handedEvents[0].body.contribution === 'file', handedEvents.map((e) => e.body));
    check('the new output is on the timeline', eventsOf(one.mission.id, 'artifact.created').some((e) => e.body.artifactId === out?.id));
    const after = (await h.services.projections.missionTasks(one.mission.id)).find((v) => v.id === one.t.design);
    check('a handed-back step is no longer parked', after?.parkedExternal === null, after?.parkedExternal);
    check('nothing waits on a person any more', h.services.desk.metrics(solo.ws).needsYou === 0 && (h.services.projections.inbox(solo.ws).parked ?? []).length === 0);
    const artifactsAfter = h.artifacts.listByMission(one.mission.id).length;
    const again = await refusal(() => h.services.missions.handBack(one.t.design, caller, { note: 'Once more.', contribution: file }));
    check('a second hand-back is a 409', again?.code === 'CONFLICT', again && { code: again.code, message: again.message });
    check('a refused hand-back writes nothing', h.artifacts.listByMission(one.mission.id).length === artifactsAfter && artifactsAfter === artifactsBefore + 2, [artifactsBefore, artifactsAfter, h.artifacts.listByMission(one.mission.id).length]);

    // ---- a ChangeSet handed back from a pull request carries its head
    const p = await project('Hand backs');
    // A pull request link is read in one of the project's checkouts.
    h.repositories.create({ id: 'rep_p3_park', workspaceId: p.ws, name: 'app', path: checkout, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
    const targetRepo = h.container.resolve(h.app.EXECUTION_TARGET_REPOSITORY);
    // The worktree an agent's run of a step leaves behind, as the executor records it.
    const worktreeOf = (missionId, taskId, branch) => targetRepo.create({
      id: ids.executionTarget(), workspaceId: p.ws, missionId, taskId, kind: 'worktree', name: branch, workingDirectory: checkout,
      branch, baseBranch: 'main', status: 'READY', detail: null, createdAt: now(), releasedAt: null,
    });
    const two = await addMission(p, [{ key: 'build', agent: p.quick, expectedOutputs: ['ChangeSet'] }]);
    const buildTarget = worktreeOf(two.mission.id, two.t.build, 'agent/build');
    await h.services.missions.parkTask(two.t.build, caller, { tool: 'Cursor' });
    check('a READY step can be parked', task(two.t.build).status === 'AWAITING_EXTERNAL' && task(two.t.build).statusReason === 'Continued in Cursor', task(two.t.build));
    check('the pull request\'s branch is not in the checkout before the hand-back', !gitc('branch', '--list').includes('feat/greet') && !gitc('branch', '--list').includes('tandemise/pr-7'), gitc('branch', '--list'));

    // Fetching fails for a change: refused, and nothing is written.
    const beforeRefused = h.artifacts.listByMission(two.mission.id).length;
    const unfetchable = await refusal(() => h.services.missions.handBack(two.t.build, caller, { note: 'From a fork.', contribution: { kind: 'link', url: PR_UNFETCHABLE } }));
    check('a change whose pull request cannot be fetched is refused', unfetchable?.code === 'VALIDATION' && unfetchable.message === "Couldn't fetch that pull request into app. Fetch or push its branch, then hand it back again.", unfetchable && { code: unfetchable.code, message: unfetchable.message });
    check('the refusal writes nothing and leaves the step parked', h.artifacts.listByMission(two.mission.id).length === beforeRefused && task(two.t.build).status === 'AWAITING_EXTERNAL' && targetRepo.get(buildTarget.id).status === 'READY',
      { artifacts: h.artifacts.listByMission(two.mission.id).length, status: task(two.t.build).status, target: targetRepo.get(buildTarget.id).status });

    const fromPr = await h.services.missions.handBack(two.t.build, caller, { note: 'Built it in Cursor; the PR is up.', contribution: { kind: 'link', url: PR } });
    const change = fromPr.artifacts[0];
    const ref = (kind) => change?.sourceRefs.find((r) => r.kind === kind)?.value;
    check('the pull request\'s head is fetched into tandemise/pr-7 at its head commit', gitc('rev-parse', 'refs/heads/tandemise/pr-7') === prSha, gitc('branch', '--list'));
    check('the ChangeSet carries the PR\'s head commit and the fetched branch', change?.type === 'ChangeSet' && ref('git.commit') === prSha && ref('git.branch') === 'tandemise/pr-7' && ref('github.pr') === 'acme/app#7', change?.sourceRefs);
    check('its handoff links the pull request', change?.handoff?.links.some((l) => l.kind === 'pr' && l.url === PR), change?.handoff?.links);
    check('task.handed_back says it was a link', eventsOf(two.mission.id, 'task.handed_back')[0]?.body.contribution === 'link');
    check('the step\'s own worktree is retired', targetRepo.get(buildTarget.id).status === 'RELEASED' && targetRepo.get(buildTarget.id).releasedAt !== null, targetRepo.get(buildTarget.id));

    // Integration merges the pull request's branch for the step, not the agent's.
    const otherId = repo.tasks.add({ ...task(two.t.build), id: ids.task(), key: 'other', title: 'other', status: 'SUCCEEDED', statusReason: null, round: 1 }).id;
    worktreeOf(two.mission.id, otherId, 'agent/other');
    repo.missions.update(two.mission.id, { repositoryId: 'rep_p3_park', baseBranch: 'main' });
    const integrated = await h.container.resolve(h.app.BRANCH_INTEGRATION_SERVICE).integrate(repo.missions.get(two.mission.id));
    const merged = integrated.results.map((r) => r.branch).sort();
    check('integration takes a handed-back change from its pull request branch', eq(merged, ['agent/other', 'tandemise/pr-7']) && integrated.results.every((r) => r.merged), integrated);
    check('and never merges the agent branch it replaced', !merged.includes('agent/build'), merged);
    repo.missions.update(two.mission.id, { status: 'CANCELLED' });

    // Fetching fails for anything but a change: handed back, with no branch.
    {
      const m = await addMission(p, [{ key: 'design', agent: p.quick }]);
      await h.services.missions.parkTask(m.t.design, caller, { tool: 'Figma' });
      const handed = await refusal(() => h.services.missions.handBack(m.t.design, caller, { note: 'Designed on a fork.', contribution: { kind: 'link', url: PR_UNFETCHABLE } }));
      const [design] = live(m.t.design, 'DesignBrief');
      check('a design from an unfetchable pull request is handed back without a branch', handed === null && design !== undefined
        && design.sourceRefs.some((r) => r.kind === 'git.commit' && r.value === 'feedface') && !design.sourceRefs.some((r) => r.kind === 'git.branch'), handed?.message ?? design?.sourceRefs);
    }

    // ---- where a pull request's head comes from (re-review: multi-repository, wrong sha, local commit, credentials)
    {
      // A contributor's clone of a remote: a commit made there exists only on the remote once pushed.
      const cloneOf = (remote, name) => { const dir = join(HOME, name); execFileSync('git', ['clone', '-q', remote, dir], { stdio: 'pipe' }); return dir; };
      const commitOn = (base, file, refspec, cwd = checkout, remoteName = 'acme') => {
        const g = (...args) => execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
        g('checkout', '-q', '-b', `tmp-${file}`, base);
        writeFileSync(join(cwd, file), `${file}\n`); g('add', file); g('commit', '-q', '-m', file);
        const sha = g('rev-parse', 'HEAD');
        if (refspec) g('push', '-q', remoteName, `HEAD:${refspec}`);
        g('checkout', '-q', base === 'main' ? 'main' : base);
        g('branch', '-q', '-D', `tmp-${file}`);
        return sha;
      };
      const pr = (n, headRefOid) => {
        const url = `https://github.com/acme/app/pull/${n}`;
        extraPrs.set(url, { url, number: n, repo: 'acme/app', headRefName: `feat/${n}`, headRefOid, title: `PR ${n}`, body: '', diff: `+${n}\n` });
        return { kind: 'link', url };
      };
      const hasRef = (cwd, ref) => { try { execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, stdio: 'pipe' }); return true; } catch { return false; } };
      const refAt = (cwd, ref) => execFileSync('git', ['rev-parse', ref], { cwd, stdio: 'pipe' }).toString().trim();
      // A second checkout, first for the mission, whose origin is another
      // repository that has its own pull request 12 and 13.
      const unrelated = join(HOME, 'unrelated');
      const unrelatedRemote = join(HOME, 'unrelated.git');
      mkdirSync(unrelated, { recursive: true });
      const gu = (...args) => execFileSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.com', ...args], { cwd: unrelated, stdio: 'pipe' }).toString().trim();
      gu('init', '-q', '-b', 'main'); writeFileSync(join(unrelated, 'x.txt'), 'x\n'); gu('add', '.'); gu('commit', '-q', '-m', 'x');
      execFileSync('git', ['init', '-q', '-b', 'main', '--bare', unrelatedRemote]);
      gu('remote', 'add', 'origin', unrelatedRemote); gu('push', '-q', 'origin', 'main');
      const unrelatedClone = cloneOf(unrelatedRemote, 'unrelated-clone');
      const otherSha = commitOn('main', 'other-12.txt', 'refs/pull/12/head', unrelatedClone, 'origin');
      commitOn('main', 'other-13.txt', 'refs/pull/13/head', unrelatedClone, 'origin');
      h.repositories.create({ id: 'rep_p3_unrelated', workspaceId: p.ws, name: 'unrelated', path: unrelated, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
      const acmeClone = cloneOf(remoteRepo, 'acme-clone');
      const sha12 = commitOn('main', 'pr-12.txt', 'refs/pull/12/head', acmeClone, 'origin');
      const changeMission = async () => {
        const m = await addMission(p, [{ key: 'build', agent: p.quick, expectedOutputs: ['ChangeSet'] }]);
        repo.missions.update(m.mission.id, { repositoryId: 'rep_p3_unrelated' });
        await h.services.missions.parkTask(m.t.build, caller, { tool: 'Cursor' });
        return m;
      };
      const m12 = await changeMission();
      gitCalls.length = 0;
      const back12 = await refusal(() => h.services.missions.handBack(m12.t.build, caller, { note: 'PR 12.', contribution: pr(12, sha12) }));
      check('two repositories: the head is fetched where the remote is the PR\'s repository, not the mission\'s first checkout', back12 === null
        && hasRef(checkout, 'refs/heads/tandemise/pr-12') && refAt(checkout, 'refs/heads/tandemise/pr-12') === sha12 && !hasRef(unrelated, 'refs/heads/tandemise/pr-12'),
        { error: back12?.message, unrelated: hasRef(unrelated, 'refs/heads/tandemise/pr-12'), otherSha });
      const fetch12 = gitCalls.find((c) => c.args[0] === 'fetch');
      check('the fetch carries the person\'s ssh-agent socket', fetch12?.env.SSH_AUTH_SOCK === '/tmp/fake-agent.sock' && fetch12.env.GIT_TERMINAL_PROMPT === '0', fetch12);
      check('and never fetches through the other checkout\'s origin', gitCalls.filter((c) => c.args[0] === 'fetch').every((c) => c.cwd === checkout && c.args[1] === '--no-tags' && c.args[2] === 'acme'), gitCalls.filter((c) => c.args[0] === 'fetch'));

      // Only the unrelated origin has pull 13: acme's remote does not, and origin is never tried for it.
      const m13 = await changeMission();
      const sha13 = refAt(unrelatedRemote, 'refs/pull/13/head');
      const refused13 = await refusal(() => h.services.missions.handBack(m13.t.build, caller, { note: 'PR 13.', contribution: pr(13, sha13) }));
      check('a PR only another repository\'s origin has is refused, and nothing is fetched there', refused13?.message === "Couldn't fetch that pull request into app. Fetch or push its branch, then hand it back again."
        && !hasRef(unrelated, 'refs/heads/tandemise/pr-13') && task(m13.t.build).status === 'AWAITING_EXTERNAL', refused13?.message);

      // The remote's pull 14 moved since gh read it: the forced ref is taken away again.
      commitOn('main', 'pr-14.txt', 'refs/pull/14/head', acmeClone, 'origin');
      const m14 = await changeMission();
      const refused14 = await refusal(() => h.services.missions.handBack(m14.t.build, caller, { note: 'PR 14.', contribution: pr(14, '1'.repeat(40)) }));
      check('a fetch that lands on another commit is refused and leaves no tandemise/pr-14', refused14?.code === 'VALIDATION' && !hasRef(checkout, 'refs/heads/tandemise/pr-14'), { error: refused14?.message, ref: hasRef(checkout, 'refs/heads/tandemise/pr-14') });

      // The refusal's advice works: the commit is here now (fetched or pushed by hand), and no fetch is needed.
      const sha15 = commitOn('main', 'pr-15.txt', null);
      const m15 = await changeMission();
      gitCalls.length = 0;
      const back15 = await refusal(() => h.services.missions.handBack(m15.t.build, caller, { note: 'PR 15, fetched by hand.', contribution: pr(15, sha15) }));
      check('a head commit already in a checkout is accepted without a fetch', back15 === null && refAt(checkout, 'refs/heads/tandemise/pr-15') === sha15
        && !gitCalls.some((c) => c.args[0] === 'fetch'), { error: back15?.message, calls: gitCalls.map((c) => c.args.join(' ')) });
      for (const m of [m12, m13, m14, m15]) repo.missions.update(m.mission.id, { status: 'CANCELLED' });

      // ---- a later agent round builds on the handed-back pull request
      const changeSet = (headline, changed) => ['---', 'type: ChangeSet', 'title: Build', 'handoff:', `  headline: ${headline}`,
        ...(changed ? ['  changed:', `    - what: ${JSON.stringify(changed)}`, '      feedback: "{{fb}}"'] : []),
        'branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []', '---', '', `${headline}.`, ''].join('\n');
      const coderProfile = profile('coder', [
        { kind: 'write-file', path: 'code-{{runId}}.txt', content: 'code\n' },
        { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet('Built') },
        { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet('Built again', 'Tidied it'), when: IN_ROUND },
        done,
      ], { captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' } });
      const coder = h.services.team.addMember(caller, p.ws, { kind: 'agent', name: 'Coder', reportsTo: p.owner, roleIds: ['design'], runtimeProfileIds: [coderProfile] }).id;
      const inWorktree = async (extra = []) => {
        const m = await addMission(p, [{ key: 'build', agent: coder, expectedOutputs: ['ChangeSet'], isolation: 'worktree' }, ...extra]);
        repo.missions.update(m.mission.id, { repositoryId: 'rep_p3_park', baseBranch: 'main' });
        // Settled: the run has also let go of its worktree, not only finished the step.
        await until(() => task(m.t.build).status === 'SUCCEEDED' && !scheduler.activeTaskIds().includes(m.t.build), 30000);
        return m;
      };
      const worktreesOf = (taskId) => targetRepo.listByMission(task(taskId).missionId).filter((t) => t.taskId === taskId && t.kind === 'worktree').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const r = await inWorktree();
      const [first] = worktreesOf(r.t.build);
      check('the agent\'s first round ran in its own worktree', task(r.t.build).status === 'SUCCEEDED' && first?.branch !== null && existsSync(first.workingDirectory), first);
      const sha16 = commitOn('main', 'pr-16.txt', 'refs/pull/16/head', acmeClone, 'origin');
      await h.services.missions.parkTask(r.t.build, caller, { tool: 'Cursor' });
      const back16 = await h.services.missions.handBack(r.t.build, caller, { note: 'Finished in a PR.', contribution: pr(16, sha16) });
      check('after a PR hand-back the step\'s worktree is removed and its branch points at the PR head',
        back16.task.status === 'SUCCEEDED' && !existsSync(first.workingDirectory) && refAt(checkout, `refs/heads/${first.branch}`) === sha16,
        { exists: existsSync(first.workingDirectory), branch: first.branch, at: hasRef(checkout, first.branch) && refAt(checkout, first.branch), sha16 });
      await h.services.feedback.giveWithAttachments(caller, r.t.build, { text: 'Tidy it', attachments: [] });
      await until(() => task(r.t.build).status === 'SUCCEEDED' && runsOf(r.t.build).length === 2, 30000);
      const latest = worktreesOf(r.t.build).at(-1);
      let onPr = false;
      try { execFileSync('git', ['merge-base', '--is-ancestor', sha16, latest.branch], { cwd: checkout }); onPr = true; } catch { /* not built on it */ }
      const [round] = live(r.t.build, 'ChangeSet');
      check('the next agent round\'s worktree is built on the PR commit', runsOf(r.t.build).length === 2 && onPr && latest.id !== first.id,
        { runs: runsOf(r.t.build).length, onPr, latest: latest?.branch, status: task(r.t.build).status });
      check('its ChangeSet is the live one and names the step\'s branch', round?.createdByRunId !== null && round.sourceRefs.some((x) => x.kind === 'git.branch' && x.value === latest.branch), round?.sourceRefs);
      const otherTask = repo.tasks.add({ ...task(r.t.build), id: ids.task(), key: 'other', title: 'other', status: 'SUCCEEDED', statusReason: null, round: 1, dependsOn: [] }).id;
      targetRepo.create({ id: ids.executionTarget(), workspaceId: p.ws, missionId: r.mission.id, taskId: otherTask, kind: 'worktree', name: 'other', workingDirectory: checkout, branch: 'agent/other', baseBranch: 'main', status: 'READY', detail: null, createdAt: now(), releasedAt: null });
      const merged16 = await h.container.resolve(h.app.BRANCH_INTEGRATION_SERVICE).integrate(repo.missions.get(r.mission.id));
      const buildMerge = merged16.results.find((x) => x.taskKey === 'build');
      let integratedPr = false;
      try { execFileSync('git', ['merge-base', '--is-ancestor', sha16, repo.missions.get(r.mission.id).integrationBranch], { cwd: checkout }); integratedPr = true; } catch { /* dropped */ }
      check('integration merges the round\'s branch, which contains the PR', buildMerge?.merged === true && buildMerge.branch === latest.branch && integratedPr, merged16);
      repo.missions.update(r.mission.id, { status: 'CANCELLED' });

      // ---- a change handed back as a file: nothing downstream is cut from the retired agent branch
      const f = await inWorktree();
      const [agentTarget] = worktreesOf(f.t.build);
      await h.services.missions.parkTask(f.t.build, caller, { tool: 'Cursor' });
      await h.services.missions.handBack(f.t.build, caller, { note: 'The patch is attached.', contribution: { kind: 'file', filename: 'change.patch', mediaType: 'text/plain', dataBase64: b64('+patched\n') } });
      const next = repo.tasks.add({
        id: ids.task(), missionId: f.mission.id, key: 'review', title: 'review', objective: 'o', roleId: 'design',
        dependsOn: ['build'], requiredCapabilities: [], inputArtifacts: [{ type: 'ChangeSet', required: true }], expectedOutputs: ['ProblemBrief'],
        executionPolicy: { isolation: 'worktree', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null, status: 'PENDING', statusReason: null, attempts: 0,
        remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 1, staffingOverride: { assignees: [p.reader] },
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
      await until(() => worktreesOf(next).length > 0 && task(next).status === 'SUCCEEDED', 30000);
      const reviewTarget = worktreesOf(next)[0];
      check('after a file hand-back, work downstream is cut from the mission base, not the retired agent branch', reviewTarget?.baseBranch === 'main' && agentTarget?.branch !== reviewTarget?.baseBranch,
        { review: reviewTarget?.baseBranch, agent: agentTarget?.branch });
      const mergedF = await h.container.resolve(h.app.BRANCH_INTEGRATION_SERVICE).integrate(repo.missions.get(f.mission.id));
      check('and integration merges nothing for the file-handed change', !mergedF.results.some((x) => x.taskKey === 'build'),
        { mergedF, targets: worktreesOf(f.t.build).map((t) => [t.branch, t.status]), changes: h.artifacts.listByTask(f.t.build).filter((a) => a.type === 'ChangeSet').map((a) => [a.id, a.supersedes, a.createdByRunId, a.sourceRefs]) });
      repo.missions.update(f.mission.id, { status: 'CANCELLED' });
    }

    // ---- a cancelled mission takes no hand-back
    const three = await addMission(p, [{ key: 'design', agent: p.quick }]);
    await h.services.missions.parkTask(three.t.design, caller, { tool: 'Figma' });
    repo.missions.update(three.mission.id, { status: 'CANCELLED' });
    const count3 = h.artifacts.listByMission(three.mission.id).length;
    const closed = await refusal(() => h.services.missions.handBack(three.t.design, caller, { note: 'Too late.', contribution: file }));
    check('hand back on a cancelled mission is a 409 and writes nothing', closed?.code === 'CONFLICT' && h.artifacts.listByMission(three.mission.id).length === count3, closed && { code: closed.code, message: closed.message });

    // ---- a hand-back whose output cannot be written leaves no pin and stays parked
    {
      const m = await addMission(p, [{ key: 'design', agent: p.quick }]);
      await h.services.missions.parkTask(m.t.design, caller, { tool: 'Figma' });
      const store = h.container.resolve(h.app.ARTIFACT_STORE);
      const write = store.write;
      store.write = async (req) => { if (req.type !== 'Evidence') throw new Error('disk full'); return write.call(store, req); };
      let failed;
      try {
        failed = await refusal(() => h.services.missions.handBack(m.t.design, caller, { note: 'Done.', contribution: file }));
      } finally {
        store.write = write;
      }
      check('a failed write fails the hand-back', /disk full/.test(failed?.message ?? ''), failed?.message);
      check('it leaves no Evidence behind and the step parked', h.artifacts.listByMission(m.mission.id).length === 0 && task(m.t.design).status === 'AWAITING_EXTERNAL',
        { artifacts: h.artifacts.listByMission(m.mission.id).map((a) => a.type), status: task(m.t.design).status });
    }

    // ---- a READY dependent is held while its input is away, then reads round 2
    {
      const m = await addMission(p, [{ key: 'design', agent: p.quick }]);
      await until(() => task(m.t.design).status === 'SUCCEEDED');
      // Promoted but not yet dispatched: the scheduler is not ticked until after the park.
      const dependent = repo.tasks.add({
        id: ids.task(), missionId: m.mission.id, key: 'read', title: 'read', objective: 'o', roleId: 'design',
        dependsOn: ['design'], requiredCapabilities: [], inputArtifacts: [{ type: 'DesignBrief', required: true }], expectedOutputs: ['ProblemBrief'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null, status: 'READY', statusReason: null, attempts: 0,
        remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 1, staffingOverride: { assignees: [p.reader] },
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
      await h.services.missions.parkTask(m.t.design, caller, { tool: 'Figma' });
      check('park holds a READY dependent', task(dependent).status === 'PENDING' && task(dependent).statusReason === "Waiting for 'design' from Figma.", task(dependent));
      await scheduler.tick();
      await scheduler.tick();
      check('the held dependent does not run while its input is away', runsOf(dependent).length === 0 && task(dependent).status === 'PENDING', task(dependent));
      const back = await h.services.missions.handBack(m.t.design, caller, { note: 'Redrawn in Figma.', contribution: file });
      await until(() => task(dependent).status === 'SUCCEEDED');
      check('after the hand-back it runs on round 2', task(dependent).status === 'SUCCEEDED' && runsOf(dependent).length === 1
        && repo.runInputs.listByRun(runsOf(dependent)[0].id).includes(back.artifacts[0]?.id), runsOf(dependent).map((r) => repo.runInputs.listByRun(r.id)));
    }

    // ---- a run that throws as it is stopped keeps the park
    {
      const m = await addMission(p, [{ key: 'design', agent: p.slow }]);
      // The runtime itself must be running, not only the attempt: the park has to abort a live run.
      await until(() => runsOf(m.t.design).some((r) => r.status === 'RUNNING'));
      // The run's final write fails, so the aborted attempt surfaces as a throw
      // in the executor. Patched on the class: the executor holds its own reference.
      const proto = Object.getPrototypeOf(repo.runs);
      const update = proto.update;
      let thrown = 0;
      proto.update = function (id, patch) {
        if (this.get(id)?.taskId === m.t.design && patch.status !== undefined && patch.status !== 'RUNNING') { thrown++; throw new Error('disk went away'); }
        return update.call(this, id, patch);
      };
      try {
        await h.services.missions.parkTask(m.t.design, caller, { tool: 'Figma' });
        await until(() => !scheduler.activeTaskIds().includes(m.t.design));
      } finally {
        proto.update = update;
      }
      check('the aborted attempt threw', thrown > 0, { thrown, runs: runsOf(m.t.design).map((r) => [r.status, r.errorMessage]) });
      check('a throw after the park keeps the step AWAITING_EXTERNAL', task(m.t.design).status === 'AWAITING_EXTERNAL' && task(m.t.design).statusReason === 'Continued in Figma', task(m.t.design));
      const back = await refusal(() => h.services.missions.handBack(m.t.design, caller, { note: 'Done in Figma.', contribution: file }));
      check('and it is handed back', back === null && task(m.t.design).status === 'SUCCEEDED' && task(m.t.design).round === 2, back?.message ?? task(m.t.design));
    }

    // ---- downstream: work that read round 1 is redone or kept
    const downstream = async (choice) => {
      const m = await addMission(p, [{ key: 'design', agent: p.quick }]);
      await until(() => task(m.t.design).status === 'SUCCEEDED');
      const [round1] = live(m.t.design, 'DesignBrief');
      await h.services.missions.parkTask(m.t.design, caller, { tool: 'Figma' });
      // Constructed: parking holds the READY dependents it finds, so a
      // consumer of round 1 is added after the park. Hand-back still applies
      // redo/keep to whatever did read the old version.
      const consumer = repo.tasks.add({
        id: ids.task(), missionId: m.mission.id, key: 'review', title: 'review', objective: 'o', roleId: 'design',
        dependsOn: ['design'], requiredCapabilities: [], inputArtifacts: [{ type: 'DesignBrief', required: true }], expectedOutputs: ['ProblemBrief'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null, status: 'READY', statusReason: null, attempts: 0,
        remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 1, staffingOverride: { assignees: [p.reader] },
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
      await until(() => task(consumer).status === 'SUCCEEDED');
      const readRound1 = repo.runInputs.listByRun(runsOf(consumer)[0].id).includes(round1.id);
      const result = await h.services.missions.handBack(m.t.design, caller, { note: 'Redrawn in Figma.', contribution: file, ...(choice === undefined ? {} : { downstream: choice }) });
      return { m, round1, consumer, readRound1, result };
    };
    const redo = await downstream('redo');
    check('downstream: the consumer read round 1', redo.readRound1);
    check('hand back after a finished round supersedes it', redo.result.artifacts[0]?.supersedes === redo.round1.id, redo.result.artifacts[0]);
    check('redo: the consumer goes back to wait for the new version', ['PENDING', 'READY'].includes(task(redo.consumer).status) && task(redo.consumer).statusReason === 'Redone after design round 2', task(redo.consumer));
    await until(() => task(redo.consumer).status === 'SUCCEEDED' && runsOf(redo.consumer).length === 2);
    check('redo: it runs again on the handed-back version', runsOf(redo.consumer).length === 2 && repo.runInputs.listByRun(runsOf(redo.consumer)[1].id).includes(redo.result.artifacts[0]?.id), runsOf(redo.consumer).map((r) => repo.runInputs.listByRun(r.id)));
    const keep = await downstream(undefined);
    check('keep (the default): the consumer stays done and is flagged stale', task(keep.consumer).status === 'SUCCEEDED' && task(keep.consumer).needsAttention === true
      && eventsOf(keep.m.mission.id, 'task.attention').some((e) => e.body.taskId === keep.consumer && e.body.kind === 'stale_input'), task(keep.consumer));

    // ---- a parked step with work downstream of it cannot be parked again
    const consumed = await refusal(() => h.services.missions.parkTask(keep.m.t.design, caller, { tool: 'Figma' }));
    check('a step whose output was consumed cannot be parked (409)', consumed?.code === 'CONFLICT', consumed && { code: consumed.code, message: consumed.message });

    // ---- a note with a file: pinned, stored, and read by the round
    const five = await addMission(p, [{ key: 'design', agent: p.quick }]);
    await until(() => task(five.t.design).status === 'SUCCEEDED');
    const given = await h.services.feedback.giveWithAttachments(caller, five.t.design, { text: 'Match the attached frames', attachments: [file, { kind: 'link', url: 'https://www.figma.com/file/x', label: 'Figma' }] });
    const row5 = repo.feedback.get(given.feedback.id);
    const attached = row5?.attachments.find((a) => a.kind === 'artifact');
    check('the note stores the file as an artifact attachment and the link as a link', attached !== undefined && row5.attachments.some((a) => a.kind === 'link' && a.url === 'https://www.figma.com/file/x'), row5?.attachments);
    check('the attachment is Evidence pinned on the step', h.artifacts.get(attached?.artifactId)?.type === 'Evidence' && h.artifacts.get(attached?.artifactId)?.taskId === five.t.design, h.artifacts.get(attached?.artifactId));
    check('the note started round 2', given.roundStarted === 2, given);
    await until(() => task(five.t.design).status === 'SUCCEEDED' && task(five.t.design).round === 2 && runsOf(five.t.design).length === 2);
    const round2 = runsOf(five.t.design)[1];
    check('the round\'s run has the attachment in run_inputs', round2 !== undefined && repo.runInputs.listByRun(round2.id).includes(attached?.artifactId), round2 && repo.runInputs.listByRun(round2.id));
    const promptPath = round2 === undefined ? '' : join(five.dir, 'prompts', `${round2.id}.txt`);
    const prompt = promptPath !== '' && existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '';
    check('the round\'s prompt lists the file and the link', prompt.includes('frames.md') && prompt.includes('The greeting, drawn in Figma.') && prompt.includes('https://www.figma.com/file/x'), prompt.slice(0, 1500));
    check('the round\'s previous output is its own DesignBrief, not the attachment', !prompt.includes('Evidence, to edit and write back'), prompt.slice(0, 1500));

    // ---- take it back: the park is called off and the agent runs the step again
    {
      const m = await addMission(p, [{ key: 'design', agent: p.quick }]);
      await until(() => task(m.t.design).status === 'SUCCEEDED');
      const dependent = repo.tasks.add({
        id: ids.task(), missionId: m.mission.id, key: 'read', title: 'read', objective: 'o', roleId: 'design',
        dependsOn: ['design'], requiredCapabilities: [], inputArtifacts: [{ type: 'DesignBrief', required: true }], expectedOutputs: ['ProblemBrief'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null, status: 'READY', statusReason: null, attempts: 0,
        remediatesTaskId: null, repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 1, staffingOverride: { assignees: [p.reader] },
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
      await h.services.missions.parkTask(m.t.design, caller, { tool: 'Figma' });
      check('the park holds the dependent', task(dependent).status === 'PENDING' && task(dependent).statusReason === "Waiting for 'design' from Figma.", task(dependent));
      const runsBefore = runsOf(m.t.design).length;
      const back = await h.services.missions.unparkTask(m.t.design, caller);
      check('take it back: the step is READY with no reason, and not parked', back.status === 'READY' && back.parkedExternal === null && task(m.t.design).status === 'READY' && task(m.t.design).statusReason === null, [back.status, back.parkedExternal, task(m.t.design).statusReason]);
      const unparked = eventsOf(m.mission.id, 'task.unparked');
      check('task.unparked is recorded with the tool', unparked.length === 1 && unparked[0].body.tool === 'Figma' && unparked[0].taskId === m.t.design, unparked.map((e) => e.body));
      check('the dependent no longer waits on Figma, only on the step', task(dependent).status === 'PENDING' && task(dependent).statusReason === null, task(dependent));
      const second = await refusal(() => h.services.missions.unparkTask(m.t.design, caller));
      check('a second take-back is a 409', second?.code === 'CONFLICT', second && { code: second.code, message: second.message });
      const artifactsBefore = h.artifacts.listByMission(m.mission.id).length;
      const late = await refusal(() => h.services.missions.handBack(m.t.design, caller, { note: 'Too late.', contribution: file }));
      check('a hand-back after a take-back is a 409 and writes nothing', late?.code === 'CONFLICT' && h.artifacts.listByMission(m.mission.id).length === artifactsBefore, late && { code: late.code, message: late.message });
      await until(() => task(m.t.design).status === 'SUCCEEDED' && runsOf(m.t.design).length === runsBefore + 1);
      check('the step is dispatched again and succeeds', task(m.t.design).status === 'SUCCEEDED' && runsOf(m.t.design).length === runsBefore + 1, [task(m.t.design).status, runsOf(m.t.design).length]);
      await until(() => task(dependent).status === 'SUCCEEDED');
      const [newest] = live(m.t.design, 'DesignBrief');
      check('then the dependent is released and runs on its newest output', task(dependent).status === 'SUCCEEDED' && runsOf(dependent).length === 1
        && repo.runInputs.listByRun(runsOf(dependent)[0].id).includes(newest?.id), runsOf(dependent).map((r) => repo.runInputs.listByRun(r.id)));
      const notParked = await addMission(p, [{ key: 'design', agent: p.quick }]);
      const never = await refusal(() => h.services.missions.unparkTask(notParked.t.design, caller));
      check('a step that was never parked cannot be taken back (409)', never?.code === 'CONFLICT', never && { code: never.code, message: never.message });
    }

    // ---- what cannot be parked
    const six = await addMission(p, [{ key: 'watch', executor: 'wait', status: 'PENDING', waitPolicy: { command: 'true', everyMs: 1000, timeoutMs: 5000 } }]);
    repo.tasks.update(six.t.watch, { status: 'READY' });
    const wait = await refusal(() => h.services.missions.parkTask(six.t.watch, caller, { tool: 'Figma' }));
    check('a wait step cannot be parked (409)', wait?.code === 'CONFLICT', wait && { code: wait.code, message: wait.message });
    const seven = await addMission(p, [{ key: 'notes', agent: p.quick, expectedOutputs: ['ProblemBrief'] }]);
    const unlinkable = await refusal(() => h.services.missions.parkTask(seven.t.notes, caller, { tool: 'Figma' }));
    check('a step with no linkable output cannot be parked (409)', unlinkable?.code === 'CONFLICT', unlinkable && { code: unlinkable.code, message: unlinkable.message });

    // ---- a stage covered by an upload is not retried or reopened
    const eight = await addMission(p, [{ key: 'product', status: 'SKIPPED', statusReason: 'Covered by your upload: spec.md', expectedOutputs: ['ProductSpec'] }]);
    const COVERED = 'This step is covered by your upload; replan to run it.';
    const retried = await refusal(() => h.services.missions.retryTask(caller, eight.t.product, {}));
    check('retrying a covered placeholder is a 409', retried?.code === 'CONFLICT' && retried.message === COVERED, retried && { code: retried.code, message: retried.message });
    const reopened = await refusal(() => h.services.feedback.startRound(caller, eight.t.product, { feedbackIds: ['fb_aaaaaaaaaaaaaaaaaaaa'], downstream: 'none' }));
    check('starting a round on a covered placeholder is a 409', reopened?.code === 'CONFLICT' && reopened.message === COVERED, reopened && { code: reopened.code, message: reopened.message });
    check('the placeholder is still skipped', task(eight.t.product).status === 'SKIPPED');
  } finally {
    clearInterval(keepAlive);
    await h.container.dispose?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- http: contributions
// Task 5: the daemon routes for uploads, park, hand-back, artifact paths and
// workspace links, and the per-route body cap that lets a 24 MB file through
// while every other route keeps the global 8 MiB ceiling. Real HTTP, over the
// real router and a real HttpServer wrapping engineHarness's services - the
// same composition scratch/p14-issues-check.mjs and friends drive through
// `startDaemon`, but built directly here so a task can be seeded straight
// into the repository (as the pure "park and hand back" section above does)
// without first running it through the scheduler.
section('http: contributions');
{
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { createLogger, systemClock, ids } = await import('@tandemise/shared');
  const { buildRouter } = await import('../apps/daemon/dist/routes.js');
  const { HttpServer } = await import('../apps/daemon/dist/http/server.js');

  const HOME = mkdtempSync(join(tmpdir(), 'tdm-p3-http-'));
  const checkout = join(HOME, 'checkout');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'README.md'), '# http check\n');
  execFileSync('git', ['-c', 'user.name=P3', '-c', 'user.email=p3@example.com', 'init', '-q', '-b', 'main', checkout], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, '-c', 'user.name=P3', '-c', 'user.email=p3@example.com', 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', checkout, '-c', 'user.name=P3', '-c', 'user.email=p3@example.com', 'commit', '-q', '-m', 'init'], { stdio: 'ignore' });

  const h = await engineHarness(HOME, { read: async () => null });
  const token = 'p3-http-check-token';
  const log = createLogger({ level: 'error', base: { component: 'p3-http-check' } });
  const router = buildRouter(h.services);
  const http = new HttpServer({
    token, router, log,
    identityResolver: () => ({ personId: h.services.identity.localPerson().id }),
    onUpgrade: () => {},
    port: 0,
  });
  const url = await http.listen();
  const { request: httpRequest } = await import('node:http');
  /**
   * Plain `node:http`, not `fetch`: the router aborts reading an over-cap
   * body mid-stream (the two checks below), and on a fast loopback link the
   * server can close the socket before this side has finished writing a 9-25
   * MB request - a real, observed race, not a hypothetical one. `fetch`
   * (undici) surfaces that as an uncaught `TypeError: fetch failed` that
   * crashes the process rather than a rejected promise a `try/catch` can
   * reach; `agent: false` (a fresh connection per call, never pooled) plus an
   * explicit `error` handler on the request turns the same event into an
   * ordinary result. A socket closing before the whole body lands is itself
   * proof the server did not hang waiting for it - that counts as a refusal
   * too, just one with no parseable response to inspect.
   */
  const api = (method, path, body) => new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const target = new URL(`${url}${path}`);
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const req = httpRequest(target, {
      method, agent: false,
      headers: {
        authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        settle({ status: res.statusCode, body: text ? JSON.parse(text) : undefined, ms: Date.now() - started, reset: false });
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') { settle({ status: 0, body: undefined, ms: Date.now() - started, reset: true }); return; }
      reject(err);
    });
    if (payload === undefined) req.end(); else req.end(payload);
  });
  const missions = h.container.resolve(h.app.MISSION_REPOSITORY);
  const tasks = h.container.resolve(h.app.TASK_REPOSITORY);
  const b64Of = (bytes) => Buffer.alloc(bytes).toString('base64');

  try {
    const created = await api('POST', '/v1/workspaces', { name: 'HTTP contributions', repositoryPath: checkout });
    const ws = created.body?.workspace?.id;
    check('the workspace is created with its repository', created.status === 200 && typeof ws === 'string', created.body);

    // ---- the per-route body cap: bigger on the three contribution routes, unchanged everywhere else
    const tenMb = await api('POST', '/v1/missions', {
      workspaceId: ws, goal: 'Ship the greeting', uploads: [{ kind: 'file', filename: 'big.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(10 * 1024 * 1024) }],
    });
    check('a 10 MB upload succeeds (over the global 8 MiB cap, under the contribution cap)', tenMb.status === 200 && tenMb.body?.mission?.id !== undefined, { status: tenMb.status, error: tenMb.body?.error });
    check('the 10 MB upload is pinned as Evidence', tenMb.status === 200 && h.artifacts.listByMission(tenMb.body.mission.id, 'Evidence').length === 1);

    // Exactly at the cap: the ruling's +1 MiB router headroom exists so a
    // request the schema accepts (a file at precisely 24 MB decoded, plus
    // workspaceId/goal/filename/JSON punctuation around it) is never refused
    // by the byte count alone.
    const atCap = await api('POST', '/v1/missions', {
      workspaceId: ws, goal: 'Ship a file at exactly the limit',
      uploads: [{ kind: 'file', filename: 'exact.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(D.CONTRIBUTION_MAX_BYTES) }],
    });
    check('a file of exactly 24 MB decoded succeeds on create', atCap.status === 200 && atCap.body?.mission?.id !== undefined, { status: atCap.status, error: atCap.body?.error });

    const missionsBeforeRefusal = missions.list({ workspaceId: ws }).length;
    const twentyFiveMb = await api('POST', '/v1/missions', {
      workspaceId: ws, goal: 'Ship another greeting', uploads: [{ kind: 'file', filename: 'huge.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(25 * 1024 * 1024) }],
    });
    // A 25 MB file's base64 (~33.3 MiB) is already over the router's own cap
    // (32 MiB base64 + 1 MiB headroom) before the request body is even fully
    // read, so the router's own message answers here, not the schema's or
    // `ContributionError`'s more precise per-file text (checked directly
    // below, for a file just over the schema's cap but still under the
    // router's). A clean 400 is the common case; a reset connection (the
    // socket closing before every byte of a 25 MB body lands) is the same
    // refusal racing the client's own write, so either counts, but only a
    // clean response has a message to check.
    check('a 25 MB upload is refused, not a timeout', (twentyFiveMb.status === 400 || twentyFiveMb.reset) && twentyFiveMb.ms < 10_000, { status: twentyFiveMb.status, reset: twentyFiveMb.reset, ms: twentyFiveMb.ms });
    check('the refusal names the limit, as the router\'s own message', twentyFiveMb.reset || twentyFiveMb.body?.error?.message?.includes('The files you added are larger than 24 MB.'), twentyFiveMb.body?.error);
    check('no mission and no Evidence is left behind by the refused upload', missions.list({ workspaceId: ws }).length === missionsBeforeRefusal, { before: missionsBeforeRefusal, after: missions.list({ workspaceId: ws }).length });

    // A single file just over the schema's per-file cap, but still comfortably
    // under the router's wider one: this is the request that actually proves
    // the schema (not the router) speaks the precise per-file text, and that
    // one oversized file alone never gets the aggregate wording.
    const justOverSchemaCap = D.CONTRIBUTION_MAX_BYTES + 300_000;
    const missionsBeforeSingleOver = missions.list({ workspaceId: ws }).length;
    const singleOver = await api('POST', '/v1/missions', {
      workspaceId: ws, goal: 'Ship a file just over the limit',
      uploads: [{ kind: 'file', filename: 'over.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(justOverSchemaCap) }],
    });
    check('a single file just over 24 MB (still under the router cap) gets the per-file message, not the aggregate one', singleOver.status === 400 && singleOver.body?.error?.message?.includes('That file is larger than 24 MB.') && !singleOver.body?.error?.message?.includes('add up'), singleOver.body?.error);
    check('no mission is left behind by the single-file refusal', missions.list({ workspaceId: ws }).length === missionsBeforeSingleOver, { before: missionsBeforeSingleOver, after: missions.list({ workspaceId: ws }).length });

    // Two files, each safely under the per-file cap, whose total decoded
    // bytes exceed it: the aggregate refinement (spec A1's ruling), not the
    // per-file one - the router cap has enough headroom to let this reach
    // the schema at all.
    const sizeA = Math.floor(D.CONTRIBUTION_MAX_BYTES / 2);
    const sizeB = (D.CONTRIBUTION_MAX_BYTES + 200_000) - sizeA;
    const missionsBeforeAggregate = missions.list({ workspaceId: ws }).length;
    const twoFiles = await api('POST', '/v1/missions', {
      workspaceId: ws, goal: 'Ship two files that add up',
      uploads: [
        { kind: 'file', filename: 'a.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(sizeA) },
        { kind: 'file', filename: 'b.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(sizeB) },
      ],
    });
    check('two files that individually pass but add up past 24 MB are refused with the aggregate message', twoFiles.status === 400 && twoFiles.body?.error?.message?.includes('These files add up to more than 24 MB. Add the rest later as feedback.'), twoFiles.body?.error);
    check('no mission and no Evidence is left behind by the aggregate refusal', missions.list({ workspaceId: ws }).length === missionsBeforeAggregate, { before: missionsBeforeAggregate, after: missions.list({ workspaceId: ws }).length });

    const nineMbElsewhere = await api('POST', '/v1/workspaces', { name: 'x'.repeat(9 * 1024 * 1024) });
    check('a 9 MiB body to an unrelated route is still refused (global 8 MiB cap)', nineMbElsewhere.status === 400 || nineMbElsewhere.reset, nineMbElsewhere.body?.error);

    // ---- park and hand back, over HTTP
    const addParkableTask = (missionId, key) => tasks.add({
      id: ids.task(), missionId, key, title: key, objective: 'o', roleId: 'design',
      dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
      retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
      status: 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
      executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null,
      createdAt: systemClock.now(), updatedAt: systemClock.now(), startedAt: null, finishedAt: null,
    }).id;

    const missionRes = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Design the greeting' });
    const missionId = missionRes.body.mission.id;
    missions.update(missionId, { status: 'EXECUTING' });
    const taskId = addParkableTask(missionId, 'design');

    const parked = await api('POST', `/v1/tasks/${taskId}/park`, { tool: 'Figma' });
    check('POST park answers with the parked TaskView', parked.status === 200 && parked.body?.status === 'AWAITING_EXTERNAL' && parked.body?.parkedExternal?.tool === 'Figma', parked.body);

    const file = { kind: 'file', filename: 'frames.md', mediaType: 'text/markdown', dataBase64: Buffer.from('# Frames\n\nThe greeting, drawn in Figma.\n').toString('base64') };

    // Take it back over HTTP, then park again for the hand-back below.
    const unparked = await api('POST', `/v1/tasks/${taskId}/unpark`);
    check('POST unpark answers with the READY TaskView', unparked.status === 200 && unparked.body?.status === 'READY' && unparked.body?.parkedExternal === null, unparked.body);
    const unparkedAgain = await api('POST', `/v1/tasks/${taskId}/unpark`);
    check('a second POST unpark is a 409', unparkedAgain.status === 409, unparkedAgain.body);
    const reparked = await api('POST', `/v1/tasks/${taskId}/park`, { tool: 'Figma' });
    check('a step taken back can be parked again', reparked.status === 200 && reparked.body?.parkedExternal?.tool === 'Figma', reparked.body);
    const handed = await api('POST', `/v1/tasks/${taskId}/hand-back`, { note: 'Designed in Figma. The frames are attached.', contribution: file });
    check('POST hand-back answers with {task, artifacts}', handed.status === 200 && handed.body?.task?.status === 'SUCCEEDED' && handed.body?.artifacts?.length === 1 && handed.body.artifacts[0].round === 2, handed.body);

    // Exactly at the cap through hand-back too, with the longest note the
    // schema allows: the same +1 MiB router headroom has to cover this
    // envelope as well, not just a bare upload's.
    const missionRes2 = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Design another greeting' });
    const missionId2 = missionRes2.body.mission.id;
    missions.update(missionId2, { status: 'EXECUTING' });
    const taskId2 = addParkableTask(missionId2, 'design2');
    await api('POST', `/v1/tasks/${taskId2}/park`, { tool: 'Figma' });
    const atCapFile = { kind: 'file', filename: 'exact-handback.bin', mediaType: 'application/octet-stream', dataBase64: b64Of(D.CONTRIBUTION_MAX_BYTES) };
    const handedAtCap = await api('POST', `/v1/tasks/${taskId2}/hand-back`, { note: 'x'.repeat(4000), contribution: atCapFile });
    check('a file of exactly 24 MB decoded with a 4000-char note succeeds on hand-back', handedAtCap.status === 200 && handedAtCap.body?.task?.status === 'SUCCEEDED', { status: handedAtCap.status, error: handedAtCap.body?.error });

    // ---- GET /v1/artifacts/:id/path
    const evidence = h.artifacts.listByTask(taskId).find((a) => a.type === 'Evidence');
    const pathRes = await api('GET', `/v1/artifacts/${evidence?.id}/path`);
    check('GET artifact path is absolute and exists', pathRes.status === 200 && pathRes.body?.path?.startsWith('/') && existsSync(pathRes.body.path), pathRes.body);

    // ---- POST /v1/workspace-links/resolve
    // `.endsWith`, not equality: macOS resolves the check's tmpdir through a
    // symlink (/var -> /private/var), so `realpath` disagrees with `checkout`
    // on the prefix alone, exactly as the pure pinning section above notes.
    const insideLink = await api('POST', '/v1/workspace-links/resolve', { workspaceId: ws, path: 'README.md' });
    check('a workspace link inside the repository resolves', insideLink.status === 200 && insideLink.body?.path?.endsWith('/checkout/README.md'), insideLink.body);
    const outsideLink = await api('POST', '/v1/workspace-links/resolve', { workspaceId: ws, path: '../escape' });
    check('a workspace link outside every root is refused 400', outsideLink.status === 400 && outsideLink.body?.error?.details?.code === 'outside_workspace', outsideLink.body?.error);
  } finally {
    await http.close();
    await h.container.dispose?.();
    rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log('ALL P3 CONTRIBUTIONS CHECKS PASSED');
process.exit(0);
