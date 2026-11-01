// P9: nothing waits silently. Every mission that cannot move gets exactly one
// Inbox item that says what it needs; an agent that goes quiet is reported
// before its wall-time budget is gone. Derived from rows, never from an agent.
//
//   npm run build && node scratch/p9-liveness-check.mjs
//
// The rule first, pure (every mission and task status is in the table, and one
// input per row gets the kind and action the table says), then the engine over
// a real SQLite file with one mission seeded per shape (the number of stalled
// missions equals inbox.stalled.length; no mission has two items for one
// cause), then a real daemon with the scripted agent: J1-J4.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

// ------------------------------------------------------------------ the rule, pure
section('pure: the table names every status');
{
  const missionRows = D.LIVENESS_RULES.filter((r) => r.subject === 'mission');
  const taskRows = D.LIVENESS_RULES.filter((r) => r.subject === 'task');
  check('18 mission rows L1-L18', eq(missionRows.map((r) => r.id), Array.from({ length: 18 }, (_, i) => `L${i + 1}`)), missionRows.map((r) => r.id));
  // P3 split T8 into T8 (a wait step) and T8b (a parked agent task), so the run stays 15 numbered ids plus T8b; a hold adds T8c;
  // a wait past its stall threshold adds T8d (#145).
  check('18 task rows T1-T15 plus T8b, T8c and T8d', eq(taskRows.map((r) => r.id), [...Array.from({ length: 8 }, (_, i) => `T${i + 1}`), 'T8b', 'T8c', 'T8d', ...Array.from({ length: 7 }, (_, i) => `T${i + 9}`)]), taskRows.map((r) => r.id));
  for (const status of D.MISSION_STATUSES) check(`mission status ${status} has a row`, missionRows.some((r) => r.statuses.includes(status)));
  for (const status of D.TASK_STATUSES) check(`task status ${status} has a row`, taskRows.some((r) => r.statuses.includes(status)));
  check('every mission row says its kind', missionRows.every((r) => ['moving', 'waiting', 'parked', 'finished', 'stalled'].includes(r.kind)), missionRows.map((r) => [r.id, r.kind]));
}

section('pure: one input per mission row');
const t = (key, status, extra = {}) => ({ id: `tsk_${key}`, key, title: extra.title ?? `Step ${key}`, status, statusReason: extra.statusReason ?? null, dependsOn: extra.dependsOn ?? [], attempts: extra.attempts ?? 1, orderHint: extra.orderHint ?? 0, executor: extra.executor, overdue: extra.overdue });
const base = { statusReason: null, tasks: [], cards: [], planning: false, refining: false, queued: false, ready: false, readinessLabel: 'Plan', toDecide: 0 };
{
  const cases = [
    ['L1', { status: 'COMPLETE' }, 'finished'],
    ['L1', { status: 'CANCELLED' }, 'finished'],
    ['L1', { status: 'FAILED', tasks: [t('a', 'FAILED')] }, 'finished'],
    ['L2', { status: 'RELEASED' }, 'finished'],
    ['L2', { status: 'OBSERVING' }, 'finished'],
    ['L3', { status: 'PAUSED', statusReason: 'Limit reached: 15 of 12 agent minutes' }, 'waiting'],
    ['L3', { status: 'PAUSED', statusReason: 'Monthly limit reached: this project used 61 of 60 agent minutes this month' }, 'waiting'],
    ['L4', { status: 'PAUSED', statusReason: 'Paused by the user. Running tasks will finish.', tasks: [t('a', 'READY')] }, 'parked'],
    ['L4', { status: 'PAUSED', statusReason: 'Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume.' }, 'parked'],
    ['L5', { status: 'DRAFT', refining: true, queued: true }, 'moving'],
    ['L6', { status: 'DRAFT', toDecide: 2, queued: true }, 'waiting'],
    ['L7', { status: 'DRAFT', queued: false, ready: true }, 'parked'],
    ['L7', { status: 'DRAFT', queued: false, ready: false, readinessLabel: 'Add at least one Done-when criterion to plan' }, 'parked'],
    ['L8', { status: 'DRAFT', queued: true, ready: true }, 'moving'],
    ['L9', { status: 'DRAFT', queued: true, ready: false, readinessLabel: 'Add at least one Done-when criterion to plan' }, 'stalled'],
    ['L10', { status: 'PLANNING', planning: true }, 'moving'],
    ['L11', { status: 'PLANNING', planning: false }, 'stalled'],
    ['L12', { status: 'AWAITING_PLAN_APPROVAL', cards: [{ taskId: null, kind: 'plan' }] }, 'waiting'],
    ['L13', { status: 'AWAITING_PLAN_APPROVAL' }, 'stalled'],
    ['L14', { status: 'EXECUTING' }, 'stalled'],
    ['L14', { status: 'BLOCKED' }, 'stalled'],
    ['L15', { status: 'EXECUTING', tasks: [t('a', 'SUCCEEDED'), t('b', 'READY', { dependsOn: ['a'] })] }, 'moving'],
    ['L15', { status: 'QA', tasks: [t('a', 'SUCCEEDED'), t('b', 'SKIPPED')] }, 'moving'],
    ['L16', { status: 'BLOCKED', tasks: [t('a', 'RUNNING'), t('b', 'BLOCKED', { statusReason: 'No runtime profile is routed to role \'design\'.' })] }, 'moving'],
    ['L17', { status: 'EXECUTING', tasks: [t('a', 'AWAITING_HUMAN')] }, 'waiting'],
    ['L17', { status: 'BLOCKED', tasks: [t('a', 'BLOCKED', { statusReason: 'Gate not met' })], cards: [{ taskId: 'tsk_a', kind: 'intervention' }] }, 'waiting'],
    ['L17', { status: 'BLOCKED', tasks: [t('a', 'SUCCEEDED'), t('b', 'PENDING', { dependsOn: ['a'] })], cards: [{ taskId: 'tsk_a', kind: 'intervention' }] }, 'waiting'],
    ['L18', { status: 'BLOCKED', statusReason: "'a' was left blocked by a human.", tasks: [t('a', 'BLOCKED', { statusReason: 'A human declined to retry this task.' })] }, 'stalled'],
    ['L18', { status: 'EXECUTING', tasks: [t('a', 'BLOCKED', { statusReason: 'A human declined to retry this task.' })], cards: [{ taskId: 'tsk_a', kind: 'check' }] }, 'stalled'],
  ];
  const hit = new Set();
  for (const [rule, input, kind] of cases) {
    const v = D.classifyLiveness({ ...base, ...input });
    hit.add(v.rule);
    check(`${rule}: ${input.status}${input.statusReason ? ` "${input.statusReason.slice(0, 30)}…"` : ''} is ${kind}`, v.rule === rule && v.kind === kind, v);
    if (kind === 'stalled') check(`${rule}: a stalled verdict carries a reason and one action`, typeof v.reason === 'string' && v.reason.length > 0 && v.action !== null, v);
    else check(`${rule}: only a stalled verdict carries an action`, v.action === null, v);
  }
  check('every mission row is reached by an input', D.LIVENESS_RULES.filter((r) => r.subject === 'mission').every((r) => hit.has(r.id)), [...hit]);
}

section('pure: one input per task row, and the action a stall gets');
{
  const inWorking = (tasks, cards = []) => D.classifyLiveness({ ...base, status: 'EXECUTING', tasks, cards });
  const ruleOf = (v, key) => v.tasks.find((x) => x.key === key)?.rule;
  const cases = [
    ['T1', [t('a', 'SUCCEEDED'), t('b', 'PENDING', { dependsOn: ['a'], attempts: 0 })], 'b', 'moving'],
    ['T2', [t('a', 'RUNNING'), t('b', 'PENDING', { dependsOn: ['a'], attempts: 0 })], 'b', 'moving'],
    ['T3', [t('a', 'FAILED', { statusReason: 'Run failed' }), t('b', 'PENDING', { dependsOn: ['a'], attempts: 0 })], 'b', 'stalled'],
    ['T4', [t('a', 'READY', { statusReason: 'Waiting for a runtime slot.' })], 'a', 'moving'],
    ['T5', [t('a', 'RUNNING')], 'a', 'moving'],
    ['T6', [t('a', 'AWAITING_INPUT')], 'a', 'waiting', [{ taskId: 'tsk_a', kind: 'choice' }]],
    ['T7', [t('a', 'AWAITING_HUMAN')], 'a', 'waiting'],
    // P3: T8 now applies only to a wait step; an agent task (the default when
    // no executor is given, spec A4) parked in AWAITING_EXTERNAL is T8b, waiting
    // on the person who took it - it used to read as T8/moving here, which was
    // wrong once AWAITING_EXTERNAL could mean "parked", not just "a wait step".
    ['T8', [t('a', 'AWAITING_EXTERNAL', { executor: 'wait' })], 'a', 'moving'],
    ['T8b', [t('a', 'AWAITING_EXTERNAL', { executor: 'agent' })], 'a', 'waiting'],
    ['T8c', [t('a', 'HELD', { executor: 'agent' })], 'a', 'waiting'],
    // #145: a wait that has looked past its stall threshold, or can't run its command, is what is stuck.
    ['T8d', [t('a', 'AWAITING_EXTERNAL', { executor: 'wait', overdue: true, statusReason: 'Waiting for CI on #12 (1 of 2 checks done).' })], 'a', 'stalled'],
    ['T9', [t('a', 'AWAITING_APPROVAL')], 'a', 'waiting', [{ taskId: 'tsk_a', kind: 'action' }]],
    ['T10', [t('a', 'AWAITING_APPROVAL')], 'a', 'stalled'],
    ['T11', [t('a', 'BLOCKED', { statusReason: 'Gate not met' })], 'a', 'waiting', [{ taskId: 'tsk_a', kind: 'intervention' }]],
    ['T12', [t('a', 'CANCELLED', { statusReason: 'Cancelled before the run finished.' }), t('b', 'BLOCKED', { dependsOn: ['a'], statusReason: 'Blocked by a (CANCELLED).' })], 'b', 'stalled'],
    ['T13', [t('a', 'BLOCKED', { statusReason: "No runtime profile is routed to role 'design'." })], 'a', 'stalled'],
    ['T14', [t('a', 'FAILED', { statusReason: 'Run failed' }), t('b', 'BLOCKED', { dependsOn: ['a'], statusReason: 'Blocked by a (FAILED).' })], 'a', 'stalled'],
    ['T15', [t('a', 'SUCCEEDED'), t('b', 'SKIPPED'), t('c', 'RUNNING')], 'a', 'moving'],
  ];
  const hit = new Set();
  for (const [rule, tasks, key, kind, cards] of cases) {
    const v = inWorking(tasks, cards);
    const r = ruleOf(v, key);
    hit.add(r);
    check(`${rule}: ${tasks.find((x) => x.key === key).status} -> task row ${rule}, mission ${kind}`, r === rule && v.kind === kind, { r, kind: v.kind, rule: v.rule });
  }
  check('every task row is reached by an input', D.LIVENESS_RULES.filter((r) => r.subject === 'task').every((r) => hit.has(r.id)), [...hit]);

  // In a BLOCKED mission the scheduler dispatches nothing: READY and PENDING do not move it.
  const blockedReady = D.classifyLiveness({ ...base, status: 'BLOCKED', tasks: [t('a', 'SUCCEEDED'), t('b', 'READY', { attempts: 0, dependsOn: ['a'] })] });
  check('in a BLOCKED mission a READY step does not move it', blockedReady.kind === 'stalled', blockedReady);
  // Action: the first stall cause in plan order, named by its key.
  const cause = D.classifyLiveness({ ...base, status: 'BLOCKED', tasks: [t('implement', 'BLOCKED', { statusReason: 'A human declined to retry this task.', orderHint: 1 }), t('ship', 'PENDING', { dependsOn: ['implement'], orderHint: 2 })] });
  check('the action retries the blocked step: "Retry implement"', cause.action?.kind === 'retry' && cause.action.label === 'Retry implement' && cause.action.taskId === 'tsk_implement', cause.action);
  check('the reason names the step and quotes why', cause.reason === "'implement' is blocked: A human declined to retry this task.", cause.reason);
  const upstream = D.classifyLiveness({ ...base, status: 'BLOCKED', tasks: [t('build', 'CANCELLED', { statusReason: 'Cancelled before the run finished.' }), t('review', 'BLOCKED', { dependsOn: ['build'], statusReason: 'Blocked by build (CANCELLED).' })] });
  check('a dependency block retries the dead upstream, not the blocked dependent', upstream.action?.label === 'Retry build', upstream.action);
  const rejected = D.classifyLiveness({ ...base, status: 'BLOCKED', statusReason: 'The plan was rejected. Re-plan or change the mission goal.', tasks: [t('a', 'PENDING', { attempts: 0 }), t('b', 'PENDING', { dependsOn: ['a'], attempts: 0 })] });
  check('a rejected plan (nothing started) is re-planned', rejected.rule === 'L18' && rejected.action?.kind === 'replan' && rejected.action.label === 'Re-plan' && rejected.reason === 'The plan was rejected. Re-plan or change the mission goal.', rejected);
  const integration = D.classifyLiveness({ ...base, status: 'BLOCKED', statusReason: 'Branch integration failed: conflict', tasks: [t('a', 'SUCCEEDED')] });
  check('nothing to retry or re-plan: Cancel mission, with the mission\'s own reason', integration.action?.kind === 'cancel' && integration.action.label === 'Cancel mission' && integration.reason === 'Branch integration failed: conflict', integration);
  const empty = D.classifyLiveness({ ...base, status: 'EXECUTING' });
  check('a working mission with no steps can only be cancelled', empty.action?.kind === 'cancel', empty);
  check('a BLOCKED mission with no steps is re-planned', D.classifyLiveness({ ...base, status: 'BLOCKED' }).action?.kind === 'replan');
  const draft = D.classifyLiveness({ ...base, status: 'DRAFT', queued: true, ready: false, readinessLabel: 'Add at least one Done-when criterion to plan' });
  check('L9 says why and offers Refine', draft.action?.kind === 'refine' && draft.reason === 'Queued, but it cannot be planned yet: add at least one Done-when criterion to plan.', draft);
  check('L11 and L13 offer Re-plan', D.classifyLiveness({ ...base, status: 'PLANNING' }).action?.kind === 'replan' && D.classifyLiveness({ ...base, status: 'AWAITING_PLAN_APPROVAL' }).action?.kind === 'replan');
}

section('pure: the silent-run watchdog');
{
  const minute = 60_000;
  const def = D.watchThresholds(D.DEFAULT_QUIET_AFTER_MS, 30 * minute);
  check('quiet after 10 min by default', D.DEFAULT_QUIET_AFTER_MS === 10 * minute && def.quietMs === 10 * minute);
  check('a 30-minute budget is silent after 15 min (half its budget, before 30)', def.silentMs === 15 * minute, def);
  check('a long budget is silent after 30 min (3 x quiet)', D.watchThresholds(10 * minute, 4 * 60 * minute).silentMs === 30 * minute);
  check('never silent before quiet', D.watchThresholds(10 * minute, 5 * minute).silentMs === 10 * minute);
  check('a scaled quiet threshold scales silent', D.watchThresholds(1000, 30 * minute).silentMs === 3000);
  const th = { quietMs: 1000, silentMs: 3000 };
  const at = (ms, snoozed = null) => D.watchLevel({ lastEventAtMs: 0, nowMs: ms, thresholds: th, snoozedUntilMs: snoozed });
  check('active before quiet', at(999).level === 'active');
  check('quiet at the quiet threshold', at(1000).level === 'quiet' && at(1000).quietForMs === 1000);
  check('silent at the silent threshold', at(3000).level === 'silent');
  check('snoozed while the snooze lasts', at(4000, 6000).snoozed === true && at(6000, 6000).snoozed === false);
  check('the words: "34 min", "12 s"', D.quietForLabel(34 * minute + 20_000) === '34 min' && D.quietForLabel(12_400) === '12 s', [D.quietForLabel(34 * minute + 20_000), D.quietForLabel(12_400)]);
  const facts = D.livenessFacts({ stalled: true, silentMs: 90_000 });
  check('facts: mission.stalled 1, run.silent_minutes 1.5', facts['mission.stalled'] === 1 && facts['run.silent_minutes'] === 1.5, facts);
  check('facts: no live run, no run.silent_minutes', !('run.silent_minutes' in D.livenessFacts({ stalled: false, silentMs: null })) && D.livenessFacts({ stalled: false, silentMs: null })['mission.stalled'] === 0);
  const { GATE_FACT_VOCABULARY } = await import('@tandemise/evaluation');
  const names = GATE_FACT_VOCABULARY.map((f) => f.name);
  for (const n of ['mission.stalled', 'run.silent_minutes']) check(`${n} is in the published vocabulary`, names.includes(n));
  const source = readFileSync(join(here, '../packages/application/dist/services/liveness-service.js'), 'utf8');
  check('the liveness service never reads Date.now()', !/Date\.now\(/.test(source));
}

// ------------------------------------------------------------ the engine, seeded
/** The engine as the daemon composes it, over a real SQLite file; no scheduler is started. */
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
  const log = createLogger({ level: 'error', base: { component: 'p9-check' } });
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
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  const services = app.createServices(container);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    criteria: container.resolve(app.MISSION_CRITERIA_REPOSITORY),
    questions: container.resolve(app.MISSION_QUESTION_REPOSITORY),
  };
  const db = container.resolve(persistenceTokens.DATABASE);
  return { container, services, repo, db };
}

section('engine: one mission per shape; stalled count equals inbox.stalled.length');
{
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tlv-'));
  const h = await engineHarness(HOME);
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Liveness' })).workspace.id;
    h.db.handle.pragma('foreign_keys = OFF'); // runs and proposals point at rows this fixture does not create
    const at = (m) => `2026-09-26T10:${String(m).padStart(2, '0')}:00.000Z`;
    const expected = new Map(); // missionId -> { rule, kind, label }
    const make = async (label, status, { statusReason = null, queued = false, doneWhen = true } = {}) => {
      const m = await h.services.missions.create(caller, { workspaceId: ws, goal: label, title: label, ...(doneWhen ? { successCriteria: ['It works'] } : {}), ...(queued ? { queued: true } : {}) });
      h.repo.missions.update(m.id, { status, statusReason });
      return m.id;
    };
    let n = 0;
    const addTask = (missionId, key, status, extra = {}) => h.repo.tasks.add({
      id: `tsk_${missionId.slice(4, 12)}_${key}_${n++}`, missionId, key, title: extra.title ?? `Step ${key}`, objective: 'o', roleId: 'product',
      dependsOn: extra.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['ProductSpec'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 1_800_000, capabilities: [] },
      approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
      completionGate: null, status, statusReason: extra.statusReason ?? null, attempts: extra.attempts ?? 1, remediatesTaskId: null, repositoryId: null,
      executor: extra.executor ?? 'agent', waitPolicy: null, orderHint: extra.orderHint ?? 0, staffingOverride: null, round: 1,
      createdAt: at(0), updatedAt: at(1), startedAt: at(1), finishedAt: null,
    });
    let c = 0;
    const addCard = (missionId, taskId, kind, extra = {}) => h.repo.approvals.create({
      id: `apr_seed_${c++}`, workspaceId: ws, missionId, taskId, runId: null, kind, status: 'PENDING', risk: 'read',
      title: extra.title ?? `${kind} card`, rationale: 'r', effect: 'e', evidence: [],
      options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      recommendedOptionId: null, selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: at(30), decidedAt: null, expiresAt: null,
      addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
    });
    const expect = (id, rule, kind, label) => expected.set(id, { rule, kind, label });

    // Mission rows that live in rows (L5 and L10 are in-memory state: the pure section covers them).
    expect(await make('complete', 'COMPLETE'), 'L1', 'finished');
    expect(await make('released', 'RELEASED'), 'L2', 'finished');
    const limitPaused = await make('limit paused', 'PAUSED', { statusReason: 'Limit reached: 15 of 12 agent minutes' });
    addTask(limitPaused, 'a', 'READY');
    addCard(limitPaused, null, 'intervention', { title: '“limit paused” reached its limit: 15 of 12 agent minutes' });
    expect(limitPaused, 'L3', 'waiting');
    const paused = await make('paused', 'PAUSED', { statusReason: 'Paused by the user. Running tasks will finish.' });
    addTask(paused, 'a', 'READY');
    expect(paused, 'L4', 'parked');
    const deciding = await make('deciding', 'DRAFT', { queued: true, doneWhen: false });
    h.repo.criteria.propose(deciding, 'art_refinement', ['It greets the visitor']);
    expect(deciding, 'L6', 'waiting');
    expect(await make('backlog draft', 'DRAFT', { doneWhen: false }), 'L7', 'parked');
    expect(await make('queued ready', 'DRAFT', { queued: true }), 'L8', 'moving');
    expect(await make('queued not ready', 'DRAFT', { queued: true, doneWhen: false }), 'L9', 'stalled', 'Refine');
    expect(await make('planning orphan', 'PLANNING'), 'L11', 'stalled', 'Re-plan');
    const planCard = await make('plan card', 'AWAITING_PLAN_APPROVAL');
    addTask(planCard, 'a', 'PENDING', { attempts: 0 });
    addCard(planCard, null, 'plan');
    expect(planCard, 'L12', 'waiting');
    const planGone = await make('plan card gone', 'AWAITING_PLAN_APPROVAL');
    addTask(planGone, 'a', 'PENDING', { attempts: 0 });
    expect(planGone, 'L13', 'stalled', 'Re-plan');
    expect(await make('no steps', 'BLOCKED', { statusReason: 'Planning failed: no runtime' }), 'L14', 'stalled', 'Re-plan');
    const running = await make('running', 'EXECUTING');
    addTask(running, 'a', 'RUNNING');
    expect(running, 'L15', 'moving');
    const blockedRunning = await make('blocked but running', 'BLOCKED');
    addTask(blockedRunning, 'a', 'RUNNING');
    addTask(blockedRunning, 'b', 'BLOCKED', { statusReason: 'A human declined to let this task start.' });
    expect(blockedRunning, 'L16', 'moving');
    const human = await make('human step', 'EXECUTING');
    addTask(human, 'a', 'AWAITING_HUMAN', { executor: 'human' });
    expect(human, 'L17', 'waiting');
    const exhausted = await make('exhausted with card', 'BLOCKED');
    const ex = addTask(exhausted, 'implement', 'BLOCKED', { statusReason: 'Gate not met', attempts: 2 });
    addCard(exhausted, ex.id, 'intervention', { title: 'Step implement exhausted its retries' });
    expect(exhausted, 'L17', 'waiting');
    const leftBlocked = await make('left blocked', 'BLOCKED', { statusReason: "'implement' was left blocked by a human." });
    addTask(leftBlocked, 'implement', 'BLOCKED', { statusReason: 'A human declined to retry this task.', attempts: 2 });
    expect(leftBlocked, 'L18', 'stalled', 'Retry implement');
    const rejected = await make('plan rejected', 'BLOCKED', { statusReason: 'The plan was rejected. Re-plan or change the mission goal.' });
    addTask(rejected, 'a', 'PENDING', { attempts: 0 });
    expect(rejected, 'L18', 'stalled', 'Re-plan');
    // Task rows, each the only open step of a working mission.
    const shape = async (label, rows, rule, kind, action, cards = []) => {
      const id = await make(label, 'EXECUTING');
      const made = rows.map(([key, status, extra]) => addTask(id, key, status, extra));
      for (const [key, kindOf] of cards) addCard(id, made.find((x) => x.key === key)?.id ?? null, kindOf);
      expect(id, rule, kind, action);
    };
    await shape('T1 ready to promote', [['a', 'SUCCEEDED'], ['b', 'PENDING', { dependsOn: ['a'], attempts: 0 }]], 'L15', 'moving');
    await shape('T4 deferred', [['a', 'READY', { statusReason: 'Waiting for a runtime slot.' }]], 'L15', 'moving');
    await shape('T6 asking', [['a', 'AWAITING_INPUT']], 'L17', 'waiting', undefined, [['a', 'choice']]);
    await shape('T8 waiting outside', [['a', 'AWAITING_EXTERNAL', { executor: 'wait' }]], 'L15', 'moving');
    await shape('T9 approval', [['a', 'AWAITING_APPROVAL']], 'L17', 'waiting', undefined, [['a', 'action']]);
    await shape('T10 approval gone', [['a', 'AWAITING_APPROVAL']], 'L18', 'stalled', 'Retry a');
    await shape('T12/T14 dead upstream', [['build', 'CANCELLED', { statusReason: 'Cancelled before the run finished.' }], ['review', 'BLOCKED', { dependsOn: ['build'], statusReason: 'Blocked by build (CANCELLED).' }]], 'L18', 'stalled', 'Retry build');
    await shape('T13 no runtime', [['design', 'BLOCKED', { statusReason: "No runtime profile is routed to role 'design'." }]], 'L18', 'stalled', 'Retry design');
    await shape('T13 with only a check card', [['design', 'BLOCKED', { statusReason: 'A human declined to let this task start.' }], ['doc', 'SUCCEEDED']], 'L18', 'stalled', 'Retry design', [['doc', 'check']]);

    for (const [id, want] of expected) {
      const v = h.services.liveness.classify(id);
      check(`classify ${h.repo.missions.get(id).title}: ${want.rule} ${want.kind}${want.label ? ` (${want.label})` : ''}`, v.rule === want.rule && v.kind === want.kind && (want.label === undefined || v.action?.label === want.label), { rule: v.rule, kind: v.kind, action: v.action });
    }

    const inbox = h.services.projections.inbox(ws);
    const stalledIds = [...expected].filter(([, w]) => w.kind === 'stalled').map(([id]) => id).sort();
    check('the number of stalled missions equals inbox.stalled.length', inbox.stalled.length === stalledIds.length, { rows: inbox.stalled.length, stalled: stalledIds.length });
    check('inbox.stalled is exactly the stalled missions', eq(inbox.stalled.map((s) => s.missionId).sort(), stalledIds), inbox.stalled.map((s) => s.missionTitle));
    check('no mission has two Stalled rows', new Set(inbox.stalled.map((s) => s.missionId)).size === inbox.stalled.length);
    // One item per cause: a mission with a Stalled row has no card (other than a check), step row or refinement row.
    const others = (id) => [
      ...inbox.approvals.filter((a) => a.approval.missionId === id && a.approval.kind !== 'check').map((a) => `card:${a.approval.kind}`),
      ...inbox.tasks.filter((x) => x.missionId === id).map(() => 'step'),
      ...inbox.refinements.filter((r) => r.missionId === id).map(() => 'refinement'),
    ];
    const doubled = inbox.stalled.filter((s) => others(s.missionId).length > 0).map((s) => [s.missionTitle, others(s.missionId)]);
    check('no mission has a Stalled row and another Inbox item', doubled.length === 0, doubled);
    const waiting = [...expected].filter(([, w]) => w.kind === 'waiting').map(([id]) => id);
    const unasked = waiting.filter((id) => others(id).length === 0).map((id) => h.repo.missions.get(id).title);
    check('every waiting mission has its item in the Inbox', unasked.length === 0, unasked);
    check('the limit-paused mission has only its card', others(limitPaused).length === 1 && !inbox.stalled.some((s) => s.missionId === limitPaused), others(limitPaused));
    check('the mission the person paused has no row at all', others(paused).length === 0 && !inbox.stalled.some((s) => s.missionId === paused));
    const row = inbox.stalled.find((s) => s.missionId === leftBlocked);
    check('a Stalled row: title, reason, rule and one action', row?.missionTitle === 'left blocked' && row.reason === "'implement' is blocked: A human declined to retry this task." && row.rule === 'L18' && row.action.kind === 'retry' && row.action.label === 'Retry implement' && typeof row.action.taskId === 'string', row);
    const rowsRejected = inbox.stalled.find((s) => s.missionId === rejected);
    check('the rejected plan row says so and offers Re-plan', rowsRejected?.reason === 'The plan was rejected. Re-plan or change the mission goal.' && rowsRejected.action.kind === 'replan' && rowsRejected.action.taskId === null, rowsRejected);

    // The row goes when the action moves the mission: retry the left-blocked step.
    await h.services.missions.retryTask(caller, row.action.taskId, {});
    const after = h.services.projections.inbox(ws);
    check('after "Retry implement" the row is gone', !after.stalled.some((s) => s.missionId === leftBlocked) && after.stalled.length === inbox.stalled.length - 1, after.stalled.map((s) => s.missionTitle));
    check('facts: mission.stalled 1 for a stalled mission, 0 for a moving one', h.services.liveness.facts(rejected)['mission.stalled'] === 1 && h.services.liveness.facts(running)['mission.stalled'] === 0);
  } finally {
    clearInterval(keepAlive);
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the daemon
const root = mkdtempSync(join(tmpdir(), 'tlv-d-'));
const home = join(root, 'h');
const repo = join(root, 'r');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Liveness Tester\n\temail = liveness@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME, SCRIPTED_DELAY_MS: process.env.SCRIPTED_DELAY_MS, SCRIPTED_STATE_DIR: process.env.SCRIPTED_STATE_DIR };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.SCRIPTED_DELAY_MS = '0';
process.env.SCRIPTED_STATE_DIR = join(root, 'scripted-state');
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
writeFileSync(join(repo, 'README.md'), '# liveness check\n');
mkdirSync(join(repo, '.tandemise', 'workflows'), { recursive: true });
for (const f of ['p9-implement.yaml', 'p8-steps.yaml']) copyFileSync(join(here, `acceptance/p0/workflows/${f}`), join(repo, `.tandemise/workflows/${f}`));
execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
// Quiet after 1 s, so silent after 3 s: a hanging agent is reported within the check's time.
const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200, quietMs: 1000 });
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
const poll = async (fn, ms = 60_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(150)) { const v = await fn(); if (v) return v; }
  return undefined;
};
const sql = (q, ...p) => {
  const db = new globalThis.__sqlite.DatabaseSync(join(home, 'tandemise.db'), { readOnly: true });
  try { return db.prepare(q).all(...p); } finally { db.close(); }
};

try {
  section('migration 015');
  {
    const system = await api('GET', '/v1/system');
    check('schema version is at least 15', system.body?.schemaVersion >= 15, system.body?.schemaVersion);
    const cols = sql("SELECT name FROM pragma_table_info('runs')").map((c) => c.name);
    check('runs.last_event_at and runs.watch_snoozed_until exist', cols.includes('last_event_at') && cols.includes('watch_snoozed_until'), cols);
  }

  const wsRes = await api('POST', '/v1/workspaces', { name: 'Liveness', repositoryPath: repo });
  const ws = wsRes.body?.workspace?.id;
  const autonomy = wsRes.body.workspace.autonomy;
  await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...autonomy, planApproval: 'auto' } });
  const runtime = await api('POST', '/v1/runtimes', {
    adapterId: 'generic-cli', name: 'Scripted agent', workspaceId: null,
    settings: { command: process.execPath, args: [resolve(here, 'acceptance/p0/scripted-agent.mjs')], promptVia: 'stdin', outputFormat: 'ndjson', capabilities: ['reasoning', 'tool_calling', 'shell', 'git', 'filesystem', 'mcp'] },
    maxConcurrent: 4, enabled: true,
  });
  check('a scripted runtime', runtime.status === 200, runtime.body);
  const create = async (goal, extra = {}) => {
    const body = (await api('POST', '/v1/missions', { workspaceId: ws, goal, workflowPreset: 'p9-implement', successCriteria: ['The step finishes'], planNow: true, ...extra })).body;
    return body?.mission?.id;
  };
  const start = async (id) => {
    await poll(() => sql('SELECT status FROM missions WHERE id = ?', id)[0]?.status !== 'PLANNING', 20_000);
    return api('POST', `/v1/missions/${id}/start`);
  };
  const mission = (id) => sql('SELECT status, status_reason AS reason FROM missions WHERE id = ?', id)[0];
  const inbox = async () => (await api('GET', `/v1/inbox?workspaceId=${ws}`)).body;
  const stalledFor = async (id) => (await inbox()).stalled.filter((s) => s.missionId === id);

  section('J1: retries exhausted, left blocked, one Stalled row, retried');
  {
    const id = await create('J1 hello SCRIPTED_FAIL_TIMES=2');
    await start(id);
    const card = await poll(() => sql("SELECT * FROM approvals WHERE mission_id = ? AND kind = 'intervention' AND status = 'PENDING'", id)[0], 30_000);
    check('the "exhausted its retries" card', card?.title.endsWith('exhausted its retries'), card?.title);
    check('while the card is open: no Stalled row', (await stalledFor(id)).length === 0);
    const left = await api('POST', `/v1/approvals/${card.id}/decide`, { optionId: 'reject' });
    check('"Leave blocked" is decided', left.status === 200, left.body);
    const rows = await poll(async () => { const r = await stalledFor(id); return r.length > 0 && r; }, 10_000);
    check('exactly one Stalled row', rows?.length === 1, rows);
    check('its action is "Retry implement"', rows?.[0]?.action.label === 'Retry implement' && rows[0].action.kind === 'retry', rows?.[0]);
    check('its reason quotes the step', rows?.[0]?.reason === "'implement' is blocked: A human declined to retry this task.", rows?.[0]?.reason);
    const retried = await api('POST', `/v1/tasks/${rows[0].action.taskId}/retry`, {});
    check('Retry is accepted', retried.status === 200, retried.body);
    const done = await poll(() => mission(id)?.status === 'COMPLETE', 30_000);
    check('attempt 3 writes the step; the mission completes', done === true, mission(id));
    check('three runs', sql('SELECT count(*) AS n FROM runs WHERE mission_id = ?', id)[0].n === 3);
    check('the Stalled row is gone', (await stalledFor(id)).length === 0);
  }

  section('J2: a rejected plan offers Re-plan');
  {
    await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...autonomy, planApproval: 'ask' } });
    const id = await create('J2 hello');
    const plan = await poll(() => sql("SELECT * FROM approvals WHERE mission_id = ? AND kind = 'plan' AND status = 'PENDING'", id)[0], 20_000);
    check('the plan card, and no Stalled row', plan !== undefined && (await stalledFor(id)).length === 0);
    await api('POST', `/v1/approvals/${plan.id}/decide`, { optionId: 'reject' });
    const rows = await poll(async () => { const r = await stalledFor(id); return r.length > 0 && r; }, 10_000);
    check('one Stalled row with "Re-plan"', rows?.length === 1 && rows[0].action.kind === 'replan' && rows[0].action.label === 'Re-plan', rows);
    check('its reason is the mission\'s own', rows?.[0]?.reason?.startsWith('The plan was rejected.'), rows?.[0]?.reason);
    const replanned = await api('POST', `/v1/missions/${id}/plan`);
    check('Re-plan is accepted', replanned.status === 200, replanned.body?.error);
    const again = await poll(() => sql("SELECT id FROM approvals WHERE mission_id = ? AND kind = 'plan' AND status = 'PENDING'", id)[0], 20_000);
    check('a new plan card, and the Stalled row is gone', again !== undefined && again.id !== plan.id && (await stalledFor(id)).length === 0);
    await api('POST', `/v1/missions/${id}/cancel`, { reason: 'check: done' });
    await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...autonomy, planApproval: 'auto' } });
  }

  section('J3: an agent goes quiet; keep waiting, then stop and retry');
  {
    const id = await create('J3 hello SCRIPTED_HANG_ONCE');
    await start(id);
    const task = await poll(async () => (await api('GET', `/v1/missions/${id}/tasks`)).body.find((x) => x.status === 'RUNNING'), 20_000);
    check('the step runs', task !== undefined);
    const quiet = await poll(async () => { const v = (await api('GET', `/v1/missions/${id}/tasks`)).body[0]; return v?.watch?.level === 'quiet' && v; }, 10_000);
    check('the step reads quiet after 1 s (TaskView.watch)', quiet?.watch?.level === 'quiet' && typeof quiet.watch.lastEventAt === 'string', quiet?.watch);
    const silent = await poll(async () => { const r = (await inbox()).silentRuns.filter((s) => s.missionId === id); return r.length > 0 && r; }, 10_000);
    check('one quiet row in the Inbox after 3 s', silent?.length === 1 && silent[0].taskKey === 'implement' && silent[0].quietForMs >= 3000, silent);
    check('a mission with a quiet run is moving, not stalled', (await stalledFor(id)).length === 0);
    const snooze = await api('POST', `/v1/runs/${silent[0].runId}/snooze`);
    check('Keep waiting: 200 with snoozedUntil', snooze.status === 200 && typeof snooze.body?.snoozedUntil === 'string', snooze.body);
    check('the row is hidden', (await inbox()).silentRuns.filter((s) => s.missionId === id).length === 0);
    const back = await poll(async () => { const r = (await inbox()).silentRuns.filter((s) => s.missionId === id); return r.length > 0 && r; }, 10_000);
    check('it comes back after one more silent interval', back?.length === 1);
    // The scheduler's pass writes the note; give it a pass or two after the row came back.
    const noteTexts = async () => { const e = (await api('GET', `/v1/missions/${id}/events?limit=1000`)).body; return (e.events ?? e).filter((r) => r.body.type === 'note').map((r) => r.body.text); };
    const texts = (await poll(async () => { const x = await noteTexts(); return x.some((n) => n.includes('in your inbox')) && x; }, 3000)) || await noteTexts();
    check('the timeline says it once per level: quiet, silent', texts.some((x) => x.startsWith("'implement' has been quiet for") && x.includes('its agent wrote nothing')) && texts.some((x) => x.includes('in your inbox')), texts);
    const notLive = await api('POST', '/v1/runs/run_nope/snooze');
    check('snoozing an unknown run is 404', notLive.status === 404, notLive.status);
    const stop = await api('POST', `/v1/tasks/${task.id}/retry`, { stopRun: true });
    check('Stop and retry is accepted', stop.status === 200, stop.body);
    const done = await poll(() => mission(id)?.status === 'COMPLETE', 30_000);
    check('attempt 2 runs and the mission completes', done === true, mission(id));
    const runs = sql('SELECT status, attempt FROM runs WHERE mission_id = ? ORDER BY started_at', id);
    check('run 1 cancelled, run 2 succeeded', eq(runs.map((r) => r.status), ['CANCELLED', 'SUCCEEDED']), runs);
    check('the quiet row is gone', (await inbox()).silentRuns.length === 0);
    const noLongerLive = await api('POST', `/v1/runs/${silent[0].runId}/snooze`);
    check('snoozing a finished run is 412', noLongerLive.status === 412, noLongerLive.status);
  }

  section('J4: paused, and paused at a limit, are not stalled');
  {
    const id = await create('J4 paused SCRIPTED_HANG_ONCE');
    await start(id);
    await poll(() => sql("SELECT 1 FROM runs WHERE mission_id = ? AND status IN ('STARTING','RUNNING')", id)[0], 20_000);
    await api('POST', `/v1/missions/${id}/pause`);
    const t = (await api('GET', `/v1/missions/${id}/tasks`)).body[0];
    await api('POST', `/v1/tasks/${t.id}/retry`, { stopRun: true });
    await sleep(1500);
    check('paused, its step waiting to run', mission(id)?.status === 'PAUSED', mission(id));
    const box = await inbox();
    check('no Stalled row and no other item for the paused mission', !box.stalled.some((s) => s.missionId === id) && !box.approvals.some((a) => a.approval.missionId === id) && !box.silentRuns.some((s) => s.missionId === id), box.stalled);
    const limited = await create('J4 limit SCRIPTED_USAGE_MIN=5', { workflowPreset: 'p8-steps', limits: [{ metric: 'agent_minutes', amount: 4 }] });
    await start(limited);
    await poll(() => mission(limited)?.status === 'PAUSED', 30_000);
    check('the limited mission is paused at its limit', mission(limited)?.reason?.startsWith('Limit reached:'), mission(limited));
    const box2 = await inbox();
    const cards = box2.approvals.filter((a) => a.approval.missionId === limited);
    check('its limit card is its only Inbox item', cards.length === 1 && !box2.stalled.some((s) => s.missionId === limited), { cards: cards.map((c) => c.approval.title), stalled: box2.stalled });
    check('nothing in the project is stalled', box2.stalled.length === 0, box2.stalled.map((s) => [s.missionTitle, s.rule]));
  }
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await daemon.stop();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('ALL P9 LIVENESS CHECKS PASSED');
