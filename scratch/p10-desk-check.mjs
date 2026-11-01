// P10: the owner's desk. Home counts what needs me, what is moving, how much
// of "done" is verified, the month's spend against its limit and what is
// stuck; a status report is rendered from stored facts, never by a model.
//
//   npm run build && node scratch/p10-desk-check.mjs
//
// The renderer first, pure (fixed facts give fixed text, and it parses as a
// StatusReport), then the engine over a real SQLite file seeded with one
// mission per shape and a fixed clock: the desk numbers, and the report
// rendered twice - and again from a copy of the database file - is the same
// bytes. Then a real daemon: two reports are v1 and v2 of one line.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const section = (t) => console.log(`\n== ${t}`);

const D = await import('@tandemise/domain');
const A = await import('@tandemise/artifacts');
const app = await import('@tandemise/application');

// ------------------------------------------------------------------ the renderer, pure
section('pure: the template over fixed facts');
const minutes = (m) => ({ agentMs: m * 60_000, tokens: null, costUsd: null, runs: 1 });
const FACTS = {
  project: 'Acme site',
  asOf: '2026-09-26T08:00:00.000Z',
  month: '2026-09',
  needsYou: 1,
  active: 2, wipLimit: 2, queued: 1,
  criteria: { verified: 4, counted: 6, missions: 2 },
  monthLimits: D.evaluateLimits([{ metric: 'agent_minutes', amount: 30, warnPercent: 80 }], minutes(25.5)),
  monthUsage: minutes(25.5),
  stalled: 1,
  missions: [
    {
      title: 'Greeting page', status: 'BLOCKED', statusReason: "Task 'release' is blocked.",
      liveness: { kind: 'waiting', reason: null, action: null },
      criteria: { verified: 1, counted: 3, failed: [], notVerified: ['AC2', 'AC3'], notCovered: [] },
      limits: D.evaluateLimits([{ metric: 'agent_minutes', amount: 30, warnPercent: 80 }], minutes(15)),
      waitingOn: ['“release” exhausted its retries'],
      lastGateFailure: { taskKey: 'release', detail: 'Not met: qa.criteria_unverified is 2, needs 0' },
    },
    {
      title: 'Offline mode', status: 'BLOCKED', statusReason: "'release' was left blocked by a human.",
      liveness: { kind: 'stalled', reason: "'release' is blocked: A human declined to retry this task.", action: 'Retry release' },
      criteria: { verified: 3, counted: 3, failed: [], notVerified: [], notCovered: [] },
      limits: [],
      waitingOn: [],
      lastGateFailure: null,
    },
  ],
  backlog: [
    { title: 'Dark theme', priority: 'high', position: 1, ready: true, readiness: 'Plan', held: null, refining: false },
    { title: 'Search', priority: 'normal', position: null, ready: false, readiness: 'Answer 1 question to plan', held: null, refining: false },
  ],
};
{
  check('renderStatusReport exists', typeof D.renderStatusReport === 'function', typeof D.renderStatusReport);
  const text = D.renderStatusReport(FACTS);
  check('the same facts render the same text', text === D.renderStatusReport(structuredClone(FACTS)));
  const body = A.stripFrontMatter(text);
  for (const h of ['# Status report: Acme site', '## At a glance', '## Missions', '### Greeting page', '### Offline mode', '## Backlog', '## How this report was made']) {
    check(`heading "${h}"`, body.split('\n').includes(h), body.slice(0, 400));
  }
  const lines = body.split('\n');
  const has = (line) => lines.includes(line);
  check('"Needs you: 1"', has('- Needs you: 1'), lines.slice(0, 12));
  check('"Working on: 2 of 2 · 1 queued"', has('- Working on: 2 of 2 · 1 queued'));
  check('"Criteria verified: 4 of 6, across 2 missions in progress"', has('- Criteria verified: 4 of 6, across 2 missions in progress'));
  check('"This month (2026-09): 25.5 / 30 agent min (85%)"', has('- This month (2026-09): 25.5 / 30 agent min (85%)'));
  check('"Stalled: 1"', has('- Stalled: 1'));
  check('the criteria line names the keys not verified', has('- Criteria: 1 of 3 verified; AC2, AC3 not verified.'), lines.filter((l) => l.includes('Criteria')));
  check('the last gate failure is quoted verbatim, with its step', has('- Last gate failure (release): Not met: qa.criteria\\_unverified is 2, needs 0'));
  check('what waits on the person', has('- Waiting on you: “release” exhausted its retries.'), lines.filter((l) => l.includes('Waiting')));
  check('a stalled mission says why and what to press', has("- Stalled: 'release' is blocked: A human declined to retry this task. Next: Retry release."));
  check('a mission limit reads as its bar and percent', has('- Limit: 15 / 30 agent min (50%).'));
  check('no limit reads as such', has('- Limit: no limit set.'));
  check('the backlog in pull order, then what is not queued', has('1. Dark theme · High · Ready to plan') && has('- Not queued: Search · Normal · Answer 1 question to plan') && body.indexOf('Dark theme') < body.indexOf('Search'));
  const withMarkup = D.renderStatusReport({ ...FACTS, missions: [{ ...FACTS.missions[1], title: 'K1 SCRIPTED_FAIL_RELEASE *now* [x]' }] });
  check('titles are printed literally: Markdown markup is escaped in the body, not in the front matter', withMarkup.includes('### K1 SCRIPTED\\_FAIL\\_RELEASE \\*now\\* \\[x\\]') && !withMarkup.split('---')[1].includes('\\_'), withMarkup.match(/### K1.*/)?.[0]);
  check('the body never carries the time', !body.includes('2026-09-26') && !/\d{2}:\d{2}/.test(body), body.match(/.*\d{2}:\d{2}.*/)?.[0]);
  const parsed = A.parseArtifact('StatusReport', text);
  check('the rendered file parses as a StatusReport', parsed.ok, parsed.ok ? null : parsed.error);
  check('its front matter carries asOf and the headline', parsed.ok && parsed.value.frontMatter.asOf === FACTS.asOf && parsed.value.frontMatter.handoff.headline.startsWith('1 needs you'), parsed.ok ? parsed.value.frontMatter : null);
  const later = D.renderStatusReport({ ...FACTS, asOf: '2026-09-27T08:00:00.000Z' });
  check('a later clock changes only the front matter', A.stripFrontMatter(later) === body && later !== text);
  const empty = A.stripFrontMatter(D.renderStatusReport({ ...FACTS, needsYou: 0, active: 0, wipLimit: null, queued: 0, criteria: { verified: 0, counted: 0, missions: 0 }, monthLimits: [], monthUsage: minutes(12), stalled: 0, missions: [], backlog: [] }));
  check('empty cases say so plainly', empty.includes('Nothing is in progress or paused.\n\n## Backlog') && empty.includes('The backlog is empty.') && empty.includes('- This month (2026-09): no monthly limit set; 12 agent minutes used.') && empty.includes('- Working on: 0 · no limit · 0 queued') && empty.includes('- Criteria verified: none yet'), empty);
  const source = readFileSync(join(here, '../packages/domain/dist/entities/status-report.js'), 'utf8');
  check('the renderer reads no clock and no randomness', !/Date\.now\(|new Date\(|Math\.random\(|toLocale/.test(source));
  check('the StatusReport template has the renderer\'s headings', ['## At a glance', '## Missions', '## Backlog', '## How this report was made'].every((h) => A.renderArtifactTemplate('StatusReport').includes(h)));
  check('month banner words', D.monthBannerText(FACTS.monthLimits[0]).startsWith('Monthly limit at 85% — only urgent and high work will be pulled.'), D.monthBannerText(FACTS.monthLimits[0]));
  check('WIP banner words', D.wipBannerText({ active: 2, limit: 2, queued: 3 }) === 'Working on 2 of 2 — 3 queued missions wait for a free slot. The next ready one is planned as soon as one finishes.', D.wipBannerText({ active: 2, limit: 2, queued: 3 }));
}

// ------------------------------------------------------------ the engine, seeded
async function engineHarness(HOME, clock) {
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths } = await import('@tandemise/shared');
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
  const log = createLogger({ level: 'error', base: { component: 'p10-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log }),
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
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
  const services = app.createServices(container);
  const repo = {
    workspaces: container.resolve(app.WORKSPACE_REPOSITORY),
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    criteria: container.resolve(app.MISSION_CRITERIA_REPOSITORY),
    evaluations: container.resolve(app.EVALUATION_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
  };
  const db = container.resolve(persistenceTokens.DATABASE);
  return { container, services, repo, db };
}

// The clock is fixed: the report is a function of the rows and this instant only.
const NOW = Date.now();
const fixedClock = (ms) => ({ now: () => new Date(ms).toISOString(), epochMs: () => ms });

section('engine: a seeded project, the desk numbers and a report rendered twice');
{
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tdk-'));
  const COPY = mkdtempSync(join(tmpdir(), 'tdk-copy-'));
  const h = await engineHarness(HOME, fixedClock(NOW));
  try {
    const caller = { personId: h.services.identity.localPerson().id };
    const ws = (await h.services.workspaces.create(caller, { name: 'Acme site' })).workspace.id;
    h.repo.workspaces.update(ws, { maxActiveMissions: 2, monthlyLimits: [{ metric: 'agent_minutes', amount: 30, warnPercent: 80 }] });
    h.db.handle.pragma('foreign_keys = OFF'); // specs, runs and QA point at rows this fixture does not create
    const at = (s) => new Date(NOW - 3_600_000 + s * 1000).toISOString();
    const make = async (title, status, { statusReason = null, queued = false, priority, doneWhen = ['It greets the visitor', 'It works offline'] } = {}) => {
      const m = await h.services.missions.create(caller, { workspaceId: ws, goal: title, title, ...(doneWhen.length > 0 ? { successCriteria: doneWhen } : {}), ...(queued ? { queued: true } : {}), ...(priority ? { priority } : {}) });
      h.repo.missions.update(m.id, { status, statusReason });
      return m.id;
    };
    let n = 0;
    const addTask = (missionId, key, status, extra = {}) => h.repo.tasks.add({
      id: `tsk_${missionId.slice(4, 12)}_${key}_${n++}`, missionId, key, title: `Step ${key}`, objective: 'o', roleId: 'product',
      dependsOn: extra.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['ProductSpec'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 1_800_000, capabilities: [] },
      approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
      completionGate: null, status, statusReason: extra.statusReason ?? null, attempts: extra.attempts ?? 1, remediatesTaskId: null, repositoryId: null,
      executor: 'agent', waitPolicy: null, orderHint: n, staffingOverride: null, round: 1,
      createdAt: at(0), updatedAt: at(1), startedAt: at(1), finishedAt: null,
    });
    const addCard = (missionId, taskId, title) => h.repo.approvals.create({
      id: `apr_seed_${n++}`, workspaceId: ws, missionId, taskId, runId: null, kind: 'intervention', status: 'PENDING', risk: 'read',
      title, rationale: 'r', effect: 'e', evidence: [],
      options: [{ id: 'approve', label: 'Retry' }, { id: 'reject', label: 'Leave blocked' }],
      recommendedOptionId: null, selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: at(30), decidedAt: null, expiresAt: null,
      addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
    });
    // A spec with three criteria covering U1 and U2, then a QA reading written after them.
    const specAndQa = (missionId, qaTaskId, outcomes) => {
      h.repo.criteria.replaceSpecCriteria(missionId, `art_spec_${missionId}`, ['AC1', 'AC2', 'AC3'].map((key, i) => ({ key, statement: `Criterion ${i + 1}`, covers: ['U1', 'U2'] })));
      h.repo.evaluations.createEvaluation({
        id: `evl_${missionId.slice(4)}`, missionId, taskId: qaTaskId, runId: null, evaluatorRoleId: 'qa', verdict: 'pass', summary: 's', findings: [],
        criteriaCoverage: outcomes.map((outcome, i) => ({ criterionId: `AC${i + 1}`, criterion: `AC${i + 1}`, outcome, evidence: `scripted ${outcome}` })),
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      });
    };
    const usage = (missionId, min) => h.db.handle.prepare('INSERT INTO usage_records (run_id, mission_id, wall_time_ms, recorded_at) VALUES (?, ?, ?, ?)').run(`run_seed_${n++}`, missionId, Math.round(min * 60_000), new Date(NOW).toISOString());
    const gate = (missionId, taskId, passed, detail) => h.repo.events.append({ id: `evt_seed_${n++}`, workspaceId: ws, missionId, taskId, body: { type: 'gate.evaluated', gate: 'qa.criteria_unverified == 0', passed, ...(detail ? { detail } : {}) }, createdAt: at(20 + n) });

    // A: QA verified one of three; its release exhausted its retries and asks the person (a card).
    const a = await make('Greeting page', 'BLOCKED', { statusReason: "Task 'release' is blocked." });
    addTask(a, 'spec', 'SUCCEEDED');
    const aQa = addTask(a, 'qa', 'SUCCEEDED');
    const aRelease = addTask(a, 'release', 'BLOCKED', { statusReason: 'Gate not met', attempts: 2 });
    addCard(a, aRelease.id, '“release” exhausted its retries');
    specAndQa(a, aQa.id, ['PASS', 'SKIP', 'SKIP']);
    gate(a, aRelease.id, false, 'Not met: qa.criteria_unverified is 2, needs 0');
    h.services.limits.setMissionLimits(a, [{ metric: 'agent_minutes', amount: 30, warnPercent: 80 }]);
    usage(a, 15);
    // B: QA verified three of three; its release was left blocked: stalled, "Retry release".
    const b = await make('Offline mode', 'BLOCKED', { statusReason: "'release' was left blocked by a human." });
    addTask(b, 'spec', 'SUCCEEDED');
    const bQa = addTask(b, 'qa', 'SUCCEEDED');
    const bRelease = addTask(b, 'release', 'BLOCKED', { statusReason: 'A human declined to retry this task.', attempts: 2 });
    specAndQa(b, bQa.id, ['PASS', 'PASS', 'PASS']);
    gate(b, bRelease.id, false, 'Not met: artifact.ReleaseCandidate.exists is false');
    gate(b, bQa.id, true);
    usage(b, 10.5);
    // C: paused by the person: not in progress, parked.
    const c = await make('Paused work', 'PAUSED', { statusReason: 'Paused by the user. Running tasks will finish.' });
    addTask(c, 'implement', 'READY');
    // The backlog: a queued ready draft (high) and a draft not queued.
    await make('Dark theme', 'DRAFT', { queued: true, priority: 'high' });
    await make('Search', 'DRAFT');

    const home = await h.services.projections.home(ws);
    const m = home.metrics;
    check('home carries metrics', m !== undefined, Object.keys(home));
    check('needsYou 2: the release card and the stalled mission, which waits on a person too (#151)', m?.needsYou === 2, m);
    check('working on 2 of 2, 1 queued (the paused one is not in progress)', m?.active === 2 && m.wipLimit === 2 && m.queued === 1, m);
    check('criteria 4 of 6 verified across 2 missions', m?.criteriaVerified === 4 && m.criteriaTotal === 6 && m.criteriaMissions === 2, m);
    check('stalled 1 (= liveness.stalled)', m?.stalled === 1 && m.stalled === h.services.liveness.stalled(ws).length, m);
    check('month usage 25.5 of 30 agent minutes, 85%', m?.monthUsage?.length === 1 && m.monthUsage[0].bar === '25.5 / 30 agent min' && Math.round(m.monthUsage[0].percent) === 85, m?.monthUsage);
    check('banners: the month warning, then WIP full', (home.banners ?? []).map((x) => x.kind).join(',') === 'month_warn,wip_full', home.banners);
    check('the month banner reads "Monthly limit at 85% — only urgent and high work will be pulled"', home.banners?.[0]?.text.startsWith('Monthly limit at 85% — only urgent and high work will be pulled.'), home.banners?.[0]);
    check('the P8 project alert stays in the API (the window shows one of the two)', home.limitAlerts.some((x) => x.scope === 'project' && x.level === 'soft'), home.limitAlerts);
    const summaries = await h.services.missions.list({ workspaceId: ws });
    const crit = (id) => summaries.find((s) => s.mission.id === id)?.criteria;
    check('mission rows carry their criteria: A 1 of 3, B 3 of 3', crit(a)?.verified === 1 && crit(a)?.counted === 3 && crit(b)?.verified === 3 && crit(b)?.counted === 3, [crit(a), crit(b)]);

    // The report, twice from the same rows, then from a copy of the database file.
    const facts = h.services.desk.reportFacts(ws);
    const first = D.renderStatusReport(facts);
    const second = D.renderStatusReport(h.services.desk.reportFacts(ws));
    check('rendered twice from the same DB: byte-identical', first === second && first.length > 200, first.length);
    const body = A.stripFrontMatter(first);
    check('the report lists A, B, then the paused one (backlog order); drafts are in the backlog only', body.indexOf('### Greeting page') > 0 && body.indexOf('### Greeting page') < body.indexOf('### Offline mode') && body.indexOf('### Offline mode') < body.indexOf('### Paused work') && !body.includes('### Dark theme'), body);
    check('the paused mission is parked', body.split('### Paused work')[1]?.includes('- Parked: nothing runs until you resume it.'), body.split('### Paused work')[1]);
    check('A: "1 of 3 verified; AC2, AC3 not verified" and its gate text verbatim', body.includes('- Criteria: 1 of 3 verified; AC2, AC3 not verified.') && body.includes('- Last gate failure (release): Not met: qa.criteria\\_unverified is 2, needs 0'), body);
    check('A: its limit and its card', body.includes('- Limit: 15 / 30 agent min (50%).') && body.includes('- Waiting on you: “release” exhausted its retries.'));
    check('B: stalled with "Retry release"; its last failure, not its later pass', body.includes("- Stalled: 'release' is blocked: A human declined to retry this task. Next: Retry release.") && body.includes('- Last gate failure (release): Not met: artifact.ReleaseCandidate.exists is false'), body);
    check('the backlog: Dark theme queued first; Search not queued', body.includes('1. Dark theme · High · Ready to plan') && body.includes('- Not queued: Search · Normal'), body.split('## Backlog')[1]);
    check('at a glance: the desk numbers', ['- Needs you: 2', '- Working on: 2 of 2 · 1 queued', '- Criteria verified: 4 of 6, across 2 missions in progress', '- Stalled: 1'].every((l) => body.includes(l)) && /- This month \(\d{4}-\d{2}\): 25\.5 \/ 30 agent min \(85%\)/.test(body), body.split('## Missions')[0]);

    h.db.handle.exec(`VACUUM INTO '${join(COPY, 'copy.db').replace(/'/g, "''")}'`);
    const h2Home = join(COPY, 'home');
    mkdirSync(h2Home, { recursive: true });
    writeFileSync(join(h2Home, 'tandemise.db'), readFileSync(join(COPY, 'copy.db')));
    const h2 = await engineHarness(h2Home, fixedClock(NOW));
    const fromCopy = D.renderStatusReport(h2.services.desk.reportFacts(ws));
    check('rendered from a copy of the database file: byte-identical', fromCopy === first, fromCopy.length);
    const h3 = await engineHarness(h2Home, fixedClock(NOW + 5 * 60_000));
    const laterReport = D.renderStatusReport(h3.services.desk.reportFacts(ws));
    check('a later clock changes the front matter only', A.stripFrontMatter(laterReport) === body && laterReport !== first);
    h2.db.close?.(); h3.db.close?.();

    // Stored: two reports are v1 and v2 of one line, under a holder no list shows.
    const r1 = await h.services.desk.writeStatusReport(ws, caller);
    const r2 = await h.services.desk.writeStatusReport(ws, caller);
    check('writeStatusReport returns the artifact and its version', typeof r1.artifactId === 'string' && r1.version === 1 && r2.version === 2, [r1, r2]);
    const read1 = await h.services.artifacts.read(r1.artifactId);
    const read2 = await h.services.artifacts.read(r2.artifactId);
    check('both stored bodies are the rendered report, byte for byte', read1.body === first && read2.body === first, [read1.body.length, first.length]);
    check('v2 supersedes v1; the reader lists both versions', read2.manifest.supersedes === r1.artifactId && read1.manifest.supersededBy === r2.artifactId && read2.versions.map((v) => v.version).join(',') === '1,2', read2.versions);
    check('the report is by Tandemise, answered for by the person who asked, and not over budget', read2.manifest.author?.name === 'Tandemise' && read2.manifest.overBudget === false && read2.manifest.type === 'StatusReport', read2.manifest.author);
    const holder = h.repo.missions.get(read2.manifest.missionId);
    check('the holder is "Status reports", workflow status-reports, COMPLETE', holder?.title === 'Status reports' && holder.workflowPreset === D.REPORT_HOLDER_PRESET && holder.status === 'COMPLETE', holder);
    check('no list shows the holder', !h.repo.missions.list({ workspaceId: ws }).some((x) => x.id === holder.id) && !(await h.services.missions.list({ workspaceId: ws })).some((s) => s.mission.id === holder.id));
    check('the desk numbers do not change for it', eq((await h.services.projections.home(ws)).metrics, m));
    check('the Artifacts list shows the latest report', h.services.artifacts.search(ws, '').some((x) => x.id === r2.artifactId) && !h.services.artifacts.search(ws, '').some((x) => x.id === r1.artifactId));
    const r3 = await h.services.desk.writeStatusReport(ws, caller);
    check('a third report is v3 of the same holder', r3.version === 3 && h.repo.artifacts.get(r3.artifactId)?.missionId === holder.id);
  } finally {
    clearInterval(keepAlive);
    rmSync(HOME, { recursive: true, force: true });
    rmSync(COPY, { recursive: true, force: true });
  }
}

function eq(x, y) { return JSON.stringify(x) === JSON.stringify(y); }

// ---------------------------------------------------------------- the daemon
section('daemon: the route and the home read');
const root = mkdtempSync(join(tmpdir(), 'tdk-d-'));
const home = join(root, 'h');
const repoDir = join(root, 'r');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Desk Tester\n\temail = desk@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# desk check\n');
execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
const { startDaemon } = await import('../apps/daemon/dist/main.js');
const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 500 });
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
try {
  const ws = (await api('POST', '/v1/workspaces', { name: 'Desk', repositoryPath: repoDir })).body?.workspace?.id;
  await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Say hello', successCriteria: ['It says hello'], queued: true });
  const homeView = (await api('GET', `/v1/home?workspaceId=${ws}`)).body;
  check('GET /v1/home has metrics and banners', homeView?.metrics?.active === 0 && homeView.metrics.queued === 1 && homeView.metrics.wipLimit === null && Array.isArray(homeView.banners), homeView?.metrics);
  const one = await api('POST', `/v1/workspaces/${ws}/status-report`);
  const two = await api('POST', `/v1/workspaces/${ws}/status-report`);
  check('POST /v1/workspaces/:id/status-report → 200 with the artifact id and version', one.status === 200 && one.body.version === 1 && two.body.version === 2, [one, two]);
  const a1 = (await api('GET', `/v1/artifacts/${one.body.artifactId}`)).body;
  const a2 = (await api('GET', `/v1/artifacts/${two.body.artifactId}`)).body;
  check('the two bodies are identical after the front matter', A.stripFrontMatter(a1.body) === A.stripFrontMatter(a2.body) && a1.body.includes('# Status report: Desk'), a1.body.slice(0, 300));
  check('v2 lists v1 and v2', a2.versions?.map((v) => v.version).join(',') === '1,2', a2.versions);
  const missing = await api('POST', '/v1/workspaces/wsp_missing/status-report');
  check('an unknown project is 404', missing.status === 404, missing);
  const missions = (await api('GET', `/v1/missions?workspaceId=${ws}`)).body;
  check('the holder is not in GET /v1/missions', Array.isArray(missions) && missions.every((s) => s.mission.title !== 'Status reports'), missions?.map?.((s) => s.mission.title));
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
console.log('ALL P10 DESK CHECKS PASSED');
