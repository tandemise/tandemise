// The relay's engine side: a mission linked to a tracker item claims it before
// it starts, releases it when it ends, and a lost claim never stops the work
// (docs/superpowers/specs/2026-10-30-relay-design.md, §Where the engine calls it).
//
//   npm run build && node scratch/coordination-app-check.mjs
import { mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = await import('@tandemise/application');
const C = await import('@tandemise/coordination');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

/** Forwards to whichever coordination is current, so one engine can be driven local and then fake. */
function switchable(initial) {
  let current = initial;
  const listeners = new Set();
  const emit = (topic) => { for (const l of listeners) l(topic); };
  const proxy = new Proxy({}, {
    get(_, key) {
      if (key === 'onChange') return (l) => { listeners.add(l); return () => listeners.delete(l); };
      if (key === 'mailbox') return current.mailbox;
      const v = current[key];
      return typeof v === 'function' ? v.bind(current) : v;
    },
  });
  return { proxy, emit, use: (impl) => { current = impl; impl.onChange((t) => emit(t)); } };
}

class FakeCoordination {
  mode = 'relay';
  next = 'claimed';
  #claims = [];
  #syncs = new Map();
  #listeners = new Set();
  #n = 0;
  status() { return { kind: 'connected', host: 'relay.test', teamName: 'Team' }; }
  me() { return { memberId: 'me', deviceId: 'dev_me', role: 'member', displayName: 'Demo', deviceLabel: 'Laptop' }; }
  #view(input, memberId, memberName) {
    return {
      id: `fc_${++this.#n}`, projectKey: input.projectKey, itemRef: input.itemRef, itemTitle: input.itemTitle, itemUrl: input.itemUrl,
      memberId, memberName, deviceId: `dev_${memberId}`, deviceLabel: 'x', localRef: input.localRef, state: 'active',
      endedReason: null, endedBy: null, startedAt: new Date().toISOString(), endedAt: null, seq: this.#n,
    };
  }
  async claim(input) {
    if (this.next === 'held_by') {
      const ana = this.#view({ ...input, itemRef: 'youtrack:ACME-123', localRef: null }, 'ana', 'Ana');
      return { kind: 'held_by', claim: ana, self: false, sentence: 'Ana is working on ACME-123 since 10:42.', mayTakeOver: false };
    }
    const c = this.#view(input, 'me', 'Demo');
    this.#claims.push(c);
    if (this.next === 'queued_offline') {
      this.#syncs.set(c.id, { sync: 'pending', note: null, decided: null });
      return { kind: 'queued_offline', claim: c };
    }
    return { kind: 'claimed', claim: c };
  }
  async release(id, reason) { this.#end(id, reason, 'me'); }
  async takeOver(id, localRef) { const old = this.#claims.find((c) => c.id === id); this.#end(id, 'taken_over', 'me'); const c = this.#view({ ...old, localRef }, 'me', 'Demo'); this.#claims.push(c); return { kind: 'claimed', claim: c }; }
  #end(id, reason, by) {
    const i = this.#claims.findIndex((c) => c.id === id);
    if (i >= 0) this.#claims[i] = { ...this.#claims[i], state: 'ended', endedReason: reason, endedBy: by, endedAt: new Date().toISOString() };
  }
  /** Bruno takes the item: our claim ends taken_over and his starts. */
  takenOverByBruno(localRef) {
    const mine = this.claimByLocalRef(localRef);
    this.#end(mine.id, 'taken_over', 'bruno');
    this.#claims.push(this.#view({ ...mine, localRef: null }, 'bruno', 'Bruno'));
    for (const l of this.#listeners) l('claims');
  }
  claims(pk) { return this.#claims.filter((c) => c.state === 'active' && (pk === undefined || c.projectKey === pk)); }
  claimByLocalRef(lr) { return [...this.#claims].reverse().find((c) => c.localRef === lr) ?? null; }
  members() { return [['me', 'Demo'], ['ana', 'Ana'], ['bruno', 'Bruno']].map(([id, displayName]) => ({ id, displayName, role: 'member', status: 'active', presence: 'online', lastSeenAt: null })); }
  presence() { return []; }
  holderLastSeenAt() { return new Date().toISOString(); }
  claimSync(id) { return this.#syncs.get(id) ?? { sync: 'confirmed', note: null, decided: null }; }
  keepGoing(id) { this.#syncs.set(id, { ...this.claimSync(id), decided: 'keep_going' }); }
  markLost(lr, note) { this.#syncs.set(`lost:${lr}`, { sync: 'lost', note, decided: null }); }
  onChange(l) { this.#listeners.add(l); return () => this.#listeners.delete(l); }
  mailbox = { pull: async () => [], ack: async () => ({ acked: [], ignored: [] }) };
}

async function engineHarness(HOME) {
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
  const log = createLogger({ level: 'error', base: { component: 'coordination-app-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
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
  // A real bus: the coordination service listens to mission status changes on it.
  const subs = new Set();
  container.bind(app.EVENT_BUS, () => ({ publish: (r) => { for (const s of subs) s(r); }, subscribe: (l) => { subs.add(l); return () => subs.delete(l); } }), { source: 'check' });
  const invalidated = [];
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: (topic) => invalidated.push(topic), subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  // Coordination: local over the harness's own database, switchable to a fake relay.
  const db = container.resolve(persistenceTokens.DATABASE);
  C.migrateCoordination(db.handle);
  C.migrateCoordinationDaemon(db.handle);
  const store = new C.CoordinationStore(db.handle);
  const local = new C.LocalCoordination(store, { displayName: 'Demo', deviceLabel: 'Demo laptop' });
  const sw = switchable(local);
  local.onChange((t) => sw.emit(t));
  container.bind(app.COORDINATION, () => sw.proxy, { source: 'check' });

  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    issues: container.resolve(app.ISSUE_REPOSITORY),
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
  return { services, scheduler, repo, paths, until, local, sw, store, invalidated, sleep };
}

const { systemClock, ids } = await import('@tandemise/shared');
const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
const D = await import('@tandemise/domain');
const keepAlive = setInterval(() => {}, 1000);
const h = await engineHarness(mkdtempSync(join(tmpdir(), 'tco-')));
execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
execFileSync('git', ['-C', h.paths.root, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
const now = () => systemClock.now();
const OUT = '.tandemise/out/DesignBrief.md';
const brief = ['---', 'type: DesignBrief', 'title: Work', 'handoff:', '  headline: Did it', 'flows:', '  - work', '---', '', '# Work', '', 'Done.', ''].join('\n');
const plain = h.repo.profiles.create({
  id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'plain', executablePath: null,
  args: [], settings: { script: { steps: [{ kind: 'write-file', path: OUT, content: brief }, { kind: 'complete', summary: 'done' }] } },
  capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
}).id;
const caller = { personId: h.services.identity.localPerson().id };
const ws = (await h.services.workspaces.create(caller, { name: 'Coord' })).workspace.id;
const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
const agent = h.services.team.addMember(caller, ws, { kind: 'agent', name: 'Doer', reportsTo: owner, roleIds: ['design'], runtimeProfileIds: [plain] }).id;
const repository = h.repo.repositories.create({ id: 'rep_coord', workspaceId: ws, name: 'app', path: h.paths.root, defaultBranch: 'main', remoteUrl: null, checks: D.NO_CHECKS });
const link7 = h.repo.issues.createLink({ workspaceId: ws, repositoryId: repository.id, githubRepo: 'Acme/App', number: 7, url: 'https://github.com/acme/app/issues/7', title: 'Fix the thing', body: '', author: 'sam', upstreamUpdatedAt: null, state: 'open', criteriaCount: 0 });
const link8 = h.repo.issues.createLink({ workspaceId: ws, repositoryId: repository.id, githubRepo: 'acme/app', number: 8, url: 'https://github.com/acme/app/issues/8', title: 'Another', body: '', author: 'sam', upstreamUpdatedAt: null, state: 'open', criteriaCount: 0 });

let n = 0;
/** A mission with one step: an agent that writes and completes, or a person step that waits. */
const addMission = async ({ link = null, executor = 'agent', status = 'AWAITING_PLAN_APPROVAL' } = {}) => {
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Do the work', title: `C${++n}` }, link ? { issueLinkId: link.id } : undefined);
  const dir = h.paths.mission(ws, mission.id);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  h.repo.tasks.add({
    id: ids.task(), missionId: mission.id, key: 'work', title: 'work', objective: 'Do work', roleId: 'design',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: executor === 'agent' ? ['DesignBrief'] : [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status: 'READY', statusReason: null,
    attempts: 0, remediatesTaskId: null, repositoryId: null, executor, waitPolicy: null, orderHint: 0,
    staffingOverride: executor === 'agent' ? { assignees: [agent] } : null,
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  });
  h.repo.missions.update(mission.id, { status });
  return h.repo.missions.get(mission.id);
};
const status = (id) => h.repo.missions.get(id).status;
const projectKey = ws;
const err = async (p) => p.then(() => null, (e) => e);

section('local mode: an issue-linked mission claims its item');
const m1 = await addMission({ link: link7 });
await h.services.missions.start(m1.id);
const claims = h.local.claims(projectKey);
check('one active claim, for the issue, tied to the mission', claims.length === 1 && claims[0].itemRef === 'github:acme/app#7' && claims[0].localRef === m1.id, claims);
check('the coordination topic was invalidated', h.invalidated.includes('coordination'));
const rows = h.services.coordination.rows(ws);
check('Home lists it as yours', rows.length === 1 && rows[0].mine && rows[0].memberName === 'You' && rows[0].itemKey === 'acme/app#7', rows);

section('a second mission on the same issue is refused');
const m2 = await addMission({ link: link7 });
const refused = await err(h.services.missions.start(m2.id));
check('CONFLICT, in plain words', refused?.code === 'CONFLICT' && refused.message === "You're already working on this on Demo laptop.", refused?.message);
check('with the reason and no take-over (it is yours)', refused?.details?.reason === 'claim_held' && refused.details.takeOver === false && refused.details.self === true, refused?.details);
check('and the mission did not start', status(m2.id) === 'AWAITING_PLAN_APPROVAL', status(m2.id));

section('a mission with no issue claims nothing');
const m3 = await addMission();
await h.services.missions.start(m3.id);
check('it starts', status(m3.id) === 'EXECUTING');
check('and no claim was made', h.local.claims(projectKey).length === 1);

section('ending a mission releases its claim');
await h.until(() => status(m1.id) === 'COMPLETE', 20000);
check('the first mission completed', status(m1.id) === 'COMPLETE', status(m1.id));
await h.sleep(50);
const ended = h.local.claimByLocalRef(m1.id);
check('its claim ended done', ended?.state === 'ended' && ended.endedReason === 'done', ended);
const m4 = await addMission({ link: link8 });
await h.services.missions.start(m4.id);
await h.services.missions.cancel(m4.id, 'Not now.');
await h.sleep(50);
check('a cancelled mission\'s claim ends released', h.local.claimByLocalRef(m4.id)?.endedReason === 'released', h.local.claimByLocalRef(m4.id));
check('so the item is free again', h.local.claims(projectKey).length === 0);
await h.until(() => status(m3.id) === 'COMPLETE', 20000);

section('backstop: a mission running without start claims in the background');
const m5 = await addMission({ link: link8, status: 'PAUSED' });
await h.services.missions.resume(m5.id);
await h.sleep(50);
check('the resumed mission claimed its item within one event', h.local.claimByLocalRef(m5.id)?.state === 'active', h.local.claimByLocalRef(m5.id));
await h.services.missions.cancel(m5.id);

// ---- the rest runs against a fake relay
const fake = new FakeCoordination();
h.sw.use(fake);

section('plan approval on an item someone else holds');
const m6 = await addMission({ link: link7, status: 'AWAITING_PLAN_APPROVAL' });
const card = h.repo.approvals.create({
  id: ids.approval(), workspaceId: ws, missionId: m6.id, taskId: null, runId: null, kind: 'plan', status: 'PENDING', risk: 'read',
  title: 'Approve the plan', rationale: 'r', effect: 'e', evidence: [], options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
  recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: now(), decidedAt: null, expiresAt: null,
});
fake.next = 'held_by';
const onApprove = await err(h.services.approvals.decide(caller, card.id, { optionId: 'approve' }));
check('approving is refused with the holder\'s name', onApprove?.code === 'CONFLICT' && onApprove.message === 'Ana is working on ACME-123 since 10:42.', onApprove?.message);
check('the card stays pending', h.repo.approvals.get(card.id).status === 'PENDING');
check('the mission still waits for approval', status(m6.id) === 'AWAITING_PLAN_APPROVAL', status(m6.id));

section('a lost claim never stops work (Review Focus 3)');
fake.next = 'claimed';
const m7 = await addMission({ link: link7, executor: 'human' });
await h.services.missions.start(m7.id);
await h.until(() => h.repo.tasks.listByMission(m7.id)[0].status === 'AWAITING_HUMAN');
const before = h.repo.tasks.listByMission(m7.id).map((t) => t.status);
fake.takenOverByBruno(m7.id);
const banner = h.services.coordination.missionClaim(m7.id);
check('the mission shows Unclaimed, with who took it', banner?.state === 'unclaimed' && banner.sentence === 'Bruno took over acme/app#7.', banner);
for (let i = 0; i < 3; i++) await h.scheduler.tick();
check('the mission is still running', status(m7.id) === 'EXECUTING', status(m7.id));
check('and its steps are as they were', JSON.stringify(h.repo.tasks.listByMission(m7.id).map((t) => t.status)) === JSON.stringify(before));
const inbox = h.services.projections.inbox(ws);
check('the Inbox has one Unclaimed row', inbox.unclaimed?.length === 1 && inbox.unclaimed[0].missionId === m7.id, inbox.unclaimed);
const detail = await h.services.projections.missionDetail(m7.id);
check('the mission detail carries the banner', detail.claim?.state === 'unclaimed');
h.services.coordination.keepGoing(m7.id);
check('keep going: the banner is gone', h.services.coordination.missionClaim(m7.id) === null);
check('and the Inbox row too', (h.services.projections.inbox(ws).unclaimed ?? []).length === 0);
check('the mission is untouched', status(m7.id) === 'EXECUTING');

section('offline: the claim queues and the mission starts');
fake.next = 'queued_offline';
const m8 = await addMission({ link: link8, executor: 'human' });
await h.services.missions.start(m8.id);
check('it starts', status(m8.id) === 'EXECUTING');
const pending = h.services.coordination.missionClaim(m8.id);
check('and shows pending', pending?.state === 'pending' && pending.sentence === "Will tell the team when you're back online.", pending);

section('stop working on this');
await h.services.coordination.stopWorking(m7.id);
check('cancels the mission with a plain reason', status(m7.id) === 'CANCELLED' && h.repo.missions.get(m7.id).statusReason === app.STOPPED_FOR_CLAIM, h.repo.missions.get(m7.id).statusReason);

clearInterval(keepAlive);
h.scheduler.stop?.();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
