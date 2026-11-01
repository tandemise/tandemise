// The planner and risk-based merge, phase 1: the gate language for factory
// rules, task profiles, lanes, modules, persistence, the factory source and the
// planner service (docs/superpowers/specs/2026-10-30-planner-and-merge-design.md).
//
//   npm run build && node scratch/planner-check.mjs
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attempt = async (label, fn) => {
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};

await attempt('gate language', async () => {
  section('gate language');
  const sum = 'change.lines_added + change.lines_removed > 400';
  check('a sum compares', D.evaluateGate(sum, { 'change.lines_added': 300, 'change.lines_removed': 101 }).passed === true);
  check('a sum under the bound is false', D.evaluateGate(sum, { 'change.lines_added': 300, 'change.lines_removed': 100 }).passed === false);
  check('a sum with a missing operand is false', D.evaluateGate(sum, { 'change.lines_added': 300 }).passed === false);
  const call = 'item.keywords_any("typo", "rename")';
  check('a predicate call reads its arguments', D.evaluateGate(call, {}, { 'item.keywords_any': (a) => a.includes('typo') }).passed === true);
  const missing = D.evaluateGate(call, {});
  check('a call with no predicate is not measured', missing.passed === false && missing.detail.includes('is not measured'), missing.detail);
  const deps = D.gateDependencies('profile.areas_any("auth") && profile.risk == "high"');
  check('dependencies name a call with ()', eq(deps, ['profile.areas_any()', 'profile.risk']), deps);
  const stepLint = D.lintGate('profile.risk == "high"', { stepKey: 'implement', outputs: [], independentOf: false });
  check('a plan fact in a step gate is refused', stepLint[0]?.code === 'not_step_scope', stepLint);
  const callLint = D.lintGate('item.keywords_any("x")', { stepKey: 'implement', outputs: [], independentOf: false });
  check('a call in a step gate is refused', callLint[0]?.code === 'not_step_scope', callLint);
  check('a plan rule may call a plan predicate', eq(D.lintRule('item.keywords_any("typo")', 'plan'), []), D.lintRule('item.keywords_any("typo")', 'plan'));
  check('a plan rule may not read a ship fact', D.lintRule('change.files > 3', 'plan')[0]?.code === 'not_rule_scope');
  check('a ship rule reads ship facts and step checks', eq(D.lintRule('ci.state == PASS && checks.tests != FAIL', 'ship'), []), D.lintRule('ci.state == PASS && checks.tests != FAIL', 'ship'));
  check('a plan rule may not read a step fact', D.lintRule('checks.tests == PASS', 'plan')[0]?.code === 'not_rule_scope');
  check('change.files is a ship fact', D.factDefinition('change.files')?.scope === 'ship');
  check('item.prefix is a plan fact', D.factDefinition('item.prefix')?.scope === 'plan');
  const presets = [
    ['SPEC', app.SPEC_CRITERIA_GATE, { stepKey: 'spec', outputs: ['ProductSpec'], independentOf: false }],
    ['QA', app.QA_CRITERIA_GATE, { stepKey: 'qa', outputs: ['QAReport'], independentOf: false }],
    ['RELEASE', app.RELEASE_CRITERIA_GATE, { stepKey: 'release', outputs: ['ReleaseCandidate'], independentOf: false }],
  ];
  for (const [name, gate, step] of presets) {
    check(`the ${name} preset gate still lints clean`, typeof gate === 'string' && eq(D.lintGate(gate, step), []), [gate, D.lintGate(gate ?? '', step)]);
  }
});

// The spec's §3 planner.yaml as an object, plus the tracker maps Task 4 ships.
const SPEC_PLANNER = {
  version: 1,
  areas: [
    { name: 'migrations', paths: ['**/migrations/**', '**/*.sql'], sensitivity: 'critical' },
    { name: 'auth', paths: ['**/auth/**', '**/session*/**', '**/*oauth*'], sensitivity: 'critical', skills: ['security-review'] },
    { name: 'payments', paths: ['**/billing/**', '**/payment*/**', '**/stripe*/**'], sensitivity: 'critical' },
    { name: 'ci-and-infra', paths: ['.github/**', 'infra/**', '**/Dockerfile', '**/*.tf', '**/docker-compose*.yml'], sensitivity: 'critical' },
    { name: 'dependencies', paths: ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/go.sum', '**/Cargo.lock'], sensitivity: 'sensitive' },
    { name: 'desktop-ui', paths: ['apps/desktop/src/renderer/**'], sensitivity: 'none', skills: ['frontend-design'] },
    { name: 'docs', paths: ['docs/**', '**/*.md'], sensitivity: 'none' },
  ],
  trackerTypes: { Bug: 'fix', Feature: 'feature', Task: 'chore', Chore: 'chore', Docs: 'docs', Security: 'security' },
  labels: { bug: 'fix', enhancement: 'feature', dependencies: 'deps', documentation: 'docs', security: 'security' },
  profile: { rules: [
    { when: 'item.prefix == "docs"', set: { type: 'docs', size: 'xs' } },
    { when: 'item.keywords_any("typo", "copy", "rename")', set: { size: 'xs' } },
    { when: 'item.keywords_any("migrate", "migration", "schema")', set: { risk: 'high' } },
    { when: 'item.keywords_any("redesign", "rewrite", "new screen")', set: { type: 'feature', size: 'l' } },
  ] },
  lanes: [
    { when: 'profile.risk == "high" || profile.size == "l"', lane: 'careful' },
    { when: 'profile.risk == "low" && (profile.size == "xs" || profile.size == "s")', lane: 'quick' },
    { lane: 'standard' },
  ],
  laneWorkflows: { quick: 'quick', standard: 'standard', careful: 'careful' },
  byType: { fix: { standard: 'fix', careful: 'fix-careful' } },
  modules: [
    { name: 'security-review', when: 'profile.areas_any("auth", "payments")', add: { step: { key: 'security_review', class: 'review', role: 'review', after: 'implement', skills: ['security-review'], gate: 'artifact.ReviewReport.exists && review.blocking_findings == 0' } } },
    { name: 'build-must-pass', when: 'profile.areas_any("migrations", "ci-and-infra")', add: { gateClause: { step: 'implement', clause: 'checks.build == PASS' } } },
    { name: 'ui-look', when: 'profile.areas_any("desktop-ui") && profile.type == "feature"', add: { approval: { step: 'implement', when: 'after', reason: 'A person looks at new screens before they ship.' } } },
  ],
  holdApproval: { minTasks: 5, rate: 0.4 },
  tiebreak: 'on',
};

const item = (o = {}) => ({ title: '', description: '', trackerType: null, labels: [], sources: [], criteria: 0, ...o });
const input = (o = {}) => ({ item: item(o.item), paths: o.paths ?? [], repos: o.repos ?? [], projectRepos: o.projectRepos ?? 1, history: null, person: o.person ?? 'auto', tiebreak: o.tiebreak ?? null, basis: 'predicted' });

await attempt('profiles', async () => {
  section('profiles');
  const parsed = D.parsePlannerConfig(SPEC_PLANNER);
  check('the spec planner parses with no problems', parsed.problems.length === 0, parsed.problems);
  const cfg = parsed.config;
  const rows = [
    ['docs title', input({ item: { title: 'docs: fix the install steps' } }), ['docs', 'xs', 'low', 'quick']],
    ['bug typo', input({ item: { trackerType: 'Bug', title: 'Fix typo in settings title' } }), ['fix', 'xs', 'low', 'quick']],
    ['billing feature', input({ item: { trackerType: 'Feature', title: 'Invoices page', criteria: 3 }, paths: ['apps/web/src/billing/page.tsx'] }), ['feature', 'm', 'high', 'careful']],
    ['deps label', input({ item: { labels: ['dependencies'], title: 'Bump lodash' }, paths: ['package-lock.json'] }), ['deps', 's', 'medium', 'standard']],
    ['migrate', input({ item: { title: 'Migrate users table', criteria: 2 } }), ['unknown', 'm', 'high', 'careful']],
    ['billing, you chose quick', input({ item: { trackerType: 'Feature', title: 'Invoices page', criteria: 3 }, paths: ['apps/web/src/billing/page.tsx'], person: 'quick' }), ['feature', 'm', 'high', 'quick']],
    ['bug typo + tiebreak payments', input({ item: { trackerType: 'Bug', title: 'Fix typo in settings title' }, tiebreak: { type: 'fix', size: 'xs', areas: ['payments'], why: 'mentions checkout' } }), ['fix', 'xs', 'high', 'careful']],
    ['bug typo in two repos', input({ item: { trackerType: 'Bug', title: 'Fix typo in settings title' }, repos: ['web', 'api'], projectRepos: 2 }), ['fix', 'm', 'low', 'standard']],
  ];
  const profiles = [];
  for (const [label, inp, [type, size, risk, lane]] of rows) {
    const p = D.profileTask(inp, cfg);
    const l = D.chooseLane(p, cfg, inp.person);
    profiles.push(p);
    check(`${label} → ${type} · ${size} · ${risk} · ${lane}`, p.type === type && p.size === size && p.risk === risk && l.lane === lane, { type: p.type, size: p.size, risk: p.risk, lane: l.lane, signals: p.signals });
  }
  check('your Quick keeps the sensitivity floor, and says so', profiles[5].signals.some((s) => s.name === 'sensitivity floor') && profiles[5].risk === 'high', profiles[5].signals);
  check('a person\'s choice marks the source', profiles[5].source === 'person' && profiles[0].source === 'rules' && profiles[6].source === 'rules+model');
  check('every contribution is a signal', profiles[1].signals.some((s) => s.name === 'tracker type' && s.value === 'Bug' && s.effect === 'type fix'), profiles[1].signals);
  check('tiebreak: type unknown', D.tiebreakReason(rows[4][1], profiles[4]) === 'type_unknown');
  check('tiebreak: not for a clear bug', D.tiebreakReason(rows[1][1], profiles[1]) === null);
  const noPaths = input({ item: { trackerType: 'Bug', title: 'Login fails' }, projectRepos: 2 });
  check('tiebreak: no paths, many repos', D.tiebreakReason(noPaths, D.profileTask(noPaths, cfg)) === 'no_paths_many_repos');
  const clash = input({ item: { trackerType: 'Bug', labels: ['enhancement'], title: 'x' } });
  check('tiebreak: two signals disagree', D.tiebreakReason(clash, D.profileTask(clash, cfg)) === 'rules_disagree');
  const failed = D.profileTask({ ...input({ item: { title: 'Do the thing' } }), tiebreakFailed: 'not json' }, cfg);
  check('a failed tiebreak takes the conservative default and says so', failed.size === 'm' && failed.risk === 'medium' && failed.type === 'unknown' && failed.signals.some((s) => s.effect.includes('conservative default')), failed);
  check('a tiebreak saying low never lowers the floor', D.profileTask(input({ item: { title: 'x' }, paths: ['db/migrations/1.sql'], tiebreak: { type: 'fix', size: 'xs', areas: [], why: 'small' } }), cfg).risk === 'high');
  check('history of reverts raises risk', D.profileTask({ ...input({ item: { trackerType: 'Bug', title: 'Fix typo' } }), history: { medianSize: 'xs', revertRate: 0.5, holdRate: 0, n: 4 } }, cfg).risk === 'medium');
});

await attempt('lanes', async () => {
  section('lanes');
  const cfg = D.parsePlannerConfig(SPEC_PLANNER).config;
  check('a type has its own standard workflow', D.laneWorkflowId('standard', 'fix', cfg) === 'fix');
  check('and its own careful one', D.laneWorkflowId('careful', 'fix', cfg) === 'fix-careful');
  check('other types use the lane workflow', D.laneWorkflowId('quick', 'docs', cfg) === 'quick');
  const p = D.profileTask(input({ item: { title: 'docs: x' } }), cfg);
  check('your Careful wins over the rules', eq(D.chooseLane(p, cfg, 'careful'), { lane: 'careful', because: 'you chose it' }));
  const bad = D.parsePlannerConfig({ ...SPEC_PLANNER, profile: { rules: [{ when: 'item.keywords_any("x"', set: { size: 'l' } }, ...SPEC_PLANNER.profile.rules] } });
  check('a rule that does not parse is reported at its path', bad.problems.length === 1 && bad.problems[0].path === 'profile.rules.0.when', bad.problems);
  check('and the other rules still apply', bad.config.profile.rules.length === 4 && D.profileTask(input({ item: { title: 'docs: x' } }), bad.config).size === 'xs');
  const shipRead = D.parsePlannerConfig({ lanes: [{ when: 'change.files > 3', lane: 'careful' }, { lane: 'standard' }] });
  check('a lane rule reading a ship fact is dropped', shipRead.problems[0]?.path === 'lanes.0.when' && shipRead.config.lanes.length === 1, shipRead.problems);
  check('a broken file falls back and says so', D.parsePlannerConfig({ areas: 'nope' }).problems.length === 1);
  check('step class from role', D.stepClassFor({ roleId: 'qa' }) === 'verify' && D.stepClassFor({ roleId: 'x', executor: 'ship' }) === 'ship' && D.stepClassFor({ roleId: 'review', stepClass: 'investigate' }) === 'investigate' && D.stepClassFor({ roleId: 'custom' }) === 'implement');
  check('glob: migrations', D.matchGlob('**/migrations/**', 'db/migrations/0042_add_index.sql') === true);
  check('glob: terraform', D.matchGlob('**/*.tf', 'infra/main.tf') === true);
  check('glob: docs/** is not src/docs.ts', D.matchGlob('docs/**', 'src/docs.ts') === false);
  check('glob: {a,b} and top level', D.matchGlob('**/*.{ts,tsx}', 'a/b.tsx') && D.matchGlob('**/.env*', '.env.local') && !D.matchGlob('CODEOWNERS', 'x/CODEOWNERS'));
});

await attempt('modules only add', async () => {
  section('modules only add');
  const cfg = D.parsePlannerConfig(SPEC_PLANNER).config;
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(53);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const GATES = [null, 'artifact.ChangeSet.exists', 'checks.tests == PASS', '(artifact.ChangeSet.exists) && checks.lint != FAIL'];
  const mk = (key, deps) => ({
    key, title: key, objective: key, roleId: pick(['development', 'review', 'qa']), dependsOn: deps, requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'worktree', maxWallTimeMs: 1000, capabilities: [] },
    approvalPolicy: { beforeStart: rnd() < 0.2, onCompletion: rnd() < 0.2 },
    retryPolicy: { maxAttempts: 1 + Math.floor(rnd() * 3), backoffMs: 0, onExhausted: 'block' },
    completionGate: pick(GATES),
    ...(rnd() < 0.3 ? { skillRefs: [{ name: 'tdd', version: 'latest' }] } : {}),
  });
  const ctx = D.profileRuleContext({ type: 'feature', size: 'm', risk: 'high', areas: [{ name: 'auth', sensitivity: 'critical' }, { name: 'migrations', sensitivity: 'critical' }, { name: 'desktop-ui', sensitivity: 'none' }], repos: [], signals: [], source: 'rules', basis: 'predicted' });
  let bad = 0;
  let firstBad = null;
  for (let n = 0; n < 200; n++) {
    const count = 1 + Math.floor(rnd() * 6);
    const tasks = [];
    for (let i = 0; i < count; i++) tasks.push(mk(i === 0 ? 'implement' : `t${i}`, tasks.length > 0 && rnd() < 0.7 ? [pick(tasks).key] : []));
    const keys = tasks.map((t) => t.key);
    const generated = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => {
      const step = pick(keys);
      const kind = pick(['gateClause', 'approval', 'skills', 'maxAttempts', 'step']);
      const add = kind === 'gateClause' ? { gateClause: { step, clause: pick(['checks.build == PASS', 'review.blocking_findings == 0']) } }
        : kind === 'approval' ? { approval: { step, when: pick(['before', 'after']), reason: 'r' } }
          : kind === 'skills' ? { skills: { step, skills: ['frontend-design'] } }
            : kind === 'maxAttempts' ? { maxAttempts: { step, atLeast: 1 + Math.floor(rnd() * 4) } }
              : { step: { key: `extra_${i}`, role: 'review', after: step, skills: [] } };
      return { name: `gen-${i}`, when: 'true', add };
    });
    const modules = [...cfg.modules.filter(() => rnd() < 0.6), ...generated];
    const out = D.applyModules({ summary: 's', tasks }, modules, ctx.facts, ctx.predicates);
    for (const before of tasks) {
      const after = out.plan.tasks.find((t) => t.key === before.key);
      const ok = after !== undefined
        && D.gateImplies(before.completionGate, after.completionGate)
        && (!before.approvalPolicy.beforeStart || after.approvalPolicy.beforeStart)
        && (!before.approvalPolicy.onCompletion || after.approvalPolicy.onCompletion)
        && (before.skillRefs ?? []).every((s) => (after.skillRefs ?? []).some((a) => a.name === s.name))
        && after.retryPolicy.maxAttempts >= before.retryPolicy.maxAttempts;
      if (!ok) { bad++; firstBad ??= { before, after, modules: modules.map((m) => m.name) }; }
    }
  }
  check('200 random plans: nothing disappears, gates only tighten', bad === 0, firstBad);
  const base = (key, deps, extra = {}) => ({ ...mk(key, deps), approvalPolicy: { beforeStart: false, onCompletion: false }, completionGate: null, ...extra });
  const two = { summary: 's', tasks: [base('implement', []), { ...base('ship', ['implement']), executor: 'ship', roleId: 'ship' }] };
  const authCtx = D.profileRuleContext({ type: 'fix', size: 'xs', risk: 'high', areas: [{ name: 'auth', sensitivity: 'critical' }], repos: [], signals: [], source: 'rules', basis: 'predicted' });
  const sec = D.applyModules(two, cfg.modules, authCtx.facts, authCtx.predicates);
  const ship = sec.plan.tasks.find((t) => t.key === 'ship');
  check('security-review goes between implement and ship', eq(sec.plan.tasks.map((t) => t.key), ['implement', 'security_review', 'ship']) && ship.dependsOn.includes('security_review') && sec.applied.includes('security-review'), sec.plan.tasks.map((t) => [t.key, t.dependsOn]));
  check('a module naming a missing step is dropped with why', D.applyModules({ summary: 's', tasks: [base('fix', [])] }, cfg.modules, authCtx.facts, authCtx.predicates).dropped[0]?.why === "this plan has no 'implement' step");
  const twoShips = D.compileWorkflow({ name: 'w', inputs: [], steps: [
    { key: 'a', objective: 'x', role: 'development', executor: 'agent', dependsOn: [], capabilities: [], outputs: [], inputs: [], approval: 'none' },
    { key: 'ship', objective: 'x', executor: 'ship', dependsOn: ['a'], capabilities: [], outputs: [], inputs: [], approval: 'none' },
    { key: 'ship_again', objective: 'x', executor: 'ship', dependsOn: ['a'], capabilities: [], outputs: [], inputs: [], approval: 'none' },
  ] }, {});
  check('two ship steps do not compile', !twoShips.ok && twoShips.error.some((i) => i.message === "A workflow has at most one ship step; 'ship_again' is the second."), twoShips);
  const oneShip = D.compileWorkflow({ name: 'w', inputs: [], steps: [
    { key: 'a', objective: 'x', role: 'development', executor: 'agent', dependsOn: [], capabilities: [], outputs: [], inputs: [], approval: 'none' },
    { key: 'ship', objective: 'x', executor: 'ship', dependsOn: ['a'], capabilities: [], outputs: [], inputs: [], approval: 'none' },
  ] }, {});
  const shipTask = oneShip.ok ? oneShip.value.tasks[1] : null;
  check('a ship step compiles with no role', shipTask?.roleId === 'ship' && shipTask.executionPolicy.isolation === 'none' && shipTask.retryPolicy.maxAttempts === 1 && shipTask.stepClass === 'ship', shipTask ?? oneShip);
  const routed = D.resolveModel({ step: { model: 'sonnet', reason: 'routed: sonnet passed 23 of 25' }, role: null, profileModel: null, attempt: 1, pressure: null, runtimeTakesModel: true });
  check('a routed model carries its reason', routed.reason === 'routed: sonnet passed 23 of 25' && routed.source === 'step', routed);
  check('a step model without a reason is still a step override', D.resolveModel({ step: { model: 'sonnet' }, role: null, profileModel: null, attempt: 1, pressure: null, runtimeTakesModel: true }).reason === 'step override');
  check('the implicit criterion is a source', D.CRITERION_SOURCES.includes('implicit') && D.IMPLICIT_CRITERION_KEY === 'I1');
});

await attempt('persistence', async () => {
  section('persistence');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ids, systemClock } = await import('@tandemise/shared');
  const { Container, compose } = await import('@tandemise/kernel');
  const P = await import('@tandemise/persistence');
  const container = new Container();
  compose(container, P.persistenceModule({ path: join(mkdtempSync(join(tmpdir(), 'tdm-planner-')), 'db.sqlite'), clock: systemClock }));
  const db = container.resolve(P.DATABASE);
  const R = {
    workspaces: container.resolve(P.WORKSPACE_REPOSITORY), missions: container.resolve(P.MISSION_REPOSITORY),
    tasks: container.resolve(P.TASK_REPOSITORY), criteria: container.resolve(P.MISSION_CRITERIA_REPOSITORY),
    plans: container.resolve(P.PLAN_DECISION_REPOSITORY), merges: container.resolve(P.MERGE_DECISION_REPOSITORY),
    outcomes: container.resolve(P.OUTCOME_REPOSITORY),
  };
  check('schema version is current and includes the planner migration', P.schemaVersion(db) === P.SCHEMA_VERSION && P.MIGRATIONS.some((m) => m.name === 'planner_and_merge'), P.MIGRATIONS.at(-1)?.name);
  const ws = R.workspaces.create({ id: ids.workspace(), name: 'W', defaultRepositoryId: null, autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' }, concurrency: { maxTotalWorkers: 2, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced', knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null } });
  const mission = R.missions.create({ id: ids.mission(), workspaceId: ws.id, repositoryId: null, title: 'fix: typo', goal: 'g', laneRequest: 'quick' });
  check('a mission keeps its lane request', R.missions.get(mission.id).laneRequest === 'quick');
  let threw = null;
  try { db.handle.prepare("UPDATE missions SET lane_request = 'fast' WHERE id = ?").run(mission.id); } catch (e) { threw = e.code; }
  check('an unknown lane is refused by the schema', threw === 'SQLITE_CONSTRAINT_CHECK', threw);
  const seeded = R.criteria.seed(mission.id, [{ key: D.IMPLICIT_CRITERION_KEY, statement: D.IMPLICIT_CRITERION, source: 'implicit', covers: [] }]);
  const ddl = db.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'mission_criteria'").get().sql;
  check('an implicit criterion is stored', seeded[0]?.source === 'implicit' && ddl.includes("'implicit'"), ddl);
  const now = new Date().toISOString();
  const task = R.tasks.add({ id: ids.task(), missionId: mission.id, repositoryId: null, executor: 'ship', waitPolicy: null, key: 'ship', title: 'Ship', objective: 'o', roleId: 'ship', dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [], executionPolicy: { isolation: 'none', maxWallTimeMs: 1000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'block' }, completionGate: null, stepClass: 'ship', status: 'PENDING', statusReason: null, attempts: 0, remediatesTaskId: null, orderHint: 0, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null });
  const back = R.tasks.get(task.id);
  check('a ship task round-trips with its class', back.executor === 'ship' && back.stepClass === 'ship', back);
  const decision = {
    id: 'pld_1', missionId: mission.id, policyRef: 'shipped', basis: 'predicted',
    profile: { type: 'fix', size: 'xs', risk: 'low', areas: [], repos: [], signals: [], source: 'rules', basis: 'predicted' },
    lane: 'quick', laneBecause: 'x', workflowId: 'quick', modules: [], dropped: [], steps: [{ key: 'implement', stepClass: 'implement', model: null, reason: 'role model', escalate: [] }],
    approvals: [], skipped: ['No plan approval.'], tiebreak: null, lightenedByPerson: false, createdAt: now,
  };
  R.plans.create(decision);
  check('a plan decision round-trips', eq(R.plans.latest(mission.id), decision), R.plans.latest(mission.id));
  const row = (id, at, extra = {}) => ({ id, workspaceId: ws.id, missionId: mission.id, repo: 'o/r', prNumber: 1, headSha: 'a'.repeat(40), policyRef: 'shipped', verdict: 'ask', score: 1, allowed: 2, wouldMerge: true, factors: [], reasons: ['Auto-merge is off for this project.'], facts: { files: 1 }, decidedAt: at, voidedAt: null, commentId: null, mergedAt: null, mergedBy: null, mergeSha: null, ...extra });
  R.merges.create(row('mrg_2', '2026-10-30T10:00:01.000Z'));
  R.merges.create(row('mrg_1', '2026-10-30T10:00:00.000Z'));
  R.merges.update('mrg_2', { mergeSha: 'abc' });
  const updated = R.merges.get('mrg_2');
  check('a merge decision updates only its mutable fields', eq(updated, row('mrg_2', '2026-10-30T10:00:01.000Z', { mergeSha: 'abc' })), updated);
  check('decisions list oldest first', eq(R.merges.listByWorkspace(ws.id, '1970-01-01').map((d) => d.id), ['mrg_1', 'mrg_2']));
  check('latest for a repository', R.merges.latestFor(mission.id, 'o/r').id === 'mrg_2');
  const outcome = (id, at) => ({ op: 'outcome', id, at, by: 'me', mission: mission.id, lane: 'quick', profile: { type: 'fix', size: 'xs', risk: 'low', areas: [] }, kind: 'step_result', step: { class: 'implement', model: null, attempt: 1, gatePassed: true, costUsd: null, wallTimeMs: null } });
  R.outcomes.append({ ...outcome('out_3', '2026-10-30T10:00:03.000Z'), workspaceId: ws.id });
  R.outcomes.append({ ...outcome('out_1', '2026-10-30T10:00:01.000Z'), workspaceId: ws.id });
  R.outcomes.append({ ...outcome('out_2', '2026-10-30T10:00:02.000Z'), workspaceId: ws.id });
  check('outcomes come back in time order', eq(R.outcomes.listByWorkspace(ws.id, '1970-01-01').map((o) => o.id), ['out_1', 'out_2', 'out_3']));
  R.missions.remove(mission.id);
  check('outcomes outlive the mission', R.outcomes.listByWorkspace(ws.id, '1970-01-01').length === 3 && R.merges.listByWorkspace(ws.id, '1970-01-01').length === 0);
});

await attempt('factory source', async () => {
  section('factory source');
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { FileFactoryConfigSource } = await import(`${root}/apps/daemon/dist/factory-config-source.js`);
  const repo = mkdtempSync(join(tmpdir(), 'tdm-factory-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'tdm-factory-home-'));
  const source = new FileFactoryConfigSource(join(home, 'factory'));
  const shipped = await source.read('planner', [repo]);
  check('nothing on disk reads the shipped file', shipped.origin === 'shipped' && shipped.ref === 'shipped' && shipped.path === null, shipped);
  mkdirSync(join(home, 'factory'), { recursive: true });
  writeFileSync(join(home, 'factory', 'planner.yaml'), 'version: 1\ntiebreak: off\n');
  check('a file on this computer wins over the shipped one', (await source.read('planner', [repo])).origin === 'home');
  mkdirSync(join(repo, '.tandemise', 'factory'), { recursive: true });
  writeFileSync(join(repo, '.tandemise', 'factory', 'planner.yaml'), 'version: 1\nlanes:\n  - lane: quick\n');
  const project = await source.read('planner', [repo]);
  check('the project repository wins over this computer', project.origin === 'project' && /^sha256:[0-9a-f]{12}$/.test(project.ref) && project.raw.lanes[0].lane === 'quick', project);
  writeFileSync(join(repo, '.tandemise', 'factory', 'merge.yaml'), 'autoMerge: [on\n  - :\n');
  const broken = await source.read('merge', [repo]);
  check('a merge file that is not YAML keeps its error', typeof broken.error === 'string' && broken.raw === null, broken);
  const loaded = await app.loadFactoryConfig(source, [repo]);
  check('a broken merge policy is never replaced by the shipped one', typeof loaded.merge.error === 'string' && loaded.merge.autoMerge === undefined, loaded.merge);
  check('the planner reads the project file', loaded.planner.lanes[0].lane === 'quick' && loaded.refs.planner === project.ref);
  const written = await source.write('merge', repo, { version: 1, autoMerge: 'off' });
  check('a write lands in the repository', existsSync(join(repo, '.tandemise', 'factory', 'merge.yaml')) && written.path.endsWith('merge.yaml') && readFileSync(written.path, 'utf8').includes('autoMerge: off'));
  check('and reads back', (await source.read('merge', [repo])).raw.autoMerge === 'off');
  const parsed = D.parsePlannerConfig(app.SHIPPED_PLANNER);
  check('the shipped planner parses with no problems', parsed.problems.length === 0, parsed.problems);
  check('the shipped planner has no project-specific area', !parsed.config.areas.some((a) => a.name === 'desktop-ui') && !parsed.config.modules.some((m) => m.name === 'ui-look'));
  check('the shipped merge policy is off', app.SHIPPED_MERGE.autoMerge === 'off' && app.SHIPPED_MERGE.revertAutoMerge === 'on');
  check('the shipped routing has no ladders', eq(app.SHIPPED_ROUTING.classes, {}) && app.SHIPPED_ROUTING.target === 0.8);
  const roles = app.BUILT_IN_ROLES;
  const isolationForRole = (id) => roles.find((r) => r.id === id)?.defaultIsolation;
  for (const hasTestCommand of [false, true]) {
    const lanes = app.laneWorkflows({ hasTestCommand });
    for (const id of ['quick', 'standard', 'careful', 'fix', 'fix-careful']) {
      const compiled = D.compileWorkflow(lanes[id], {}, { isolationForRole });
      const valid = compiled.ok ? D.validateMissionPlan(compiled.value, { knownRoleIds: new Set(roles.map((r) => r.id)), satisfiableCapabilities: new Set(compiled.value.tasks.flatMap((t) => t.requiredCapabilities)) }) : compiled;
      check(`the ${id} lane compiles and validates${hasTestCommand ? ' with a test command' : ''}`, compiled.ok && valid.ok && compiled.value.tasks.at(-1).executor === 'ship', compiled.ok ? valid.error : compiled.error);
    }
  }
  const quick = D.compileWorkflow(app.laneWorkflows({ hasTestCommand: true }).quick, {}, { isolationForRole });
  check('the quick lane is implement then ship, tests in the gate', eq(quick.value.tasks.map((t) => t.key), ['implement', 'ship']) && quick.value.tasks[0].completionGate.includes('checks.tests == PASS'), quick.value?.tasks.map((t) => [t.key, t.completionGate]));
});

await attempt('ceremony, speed and tiebreak', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const { engineHarness, memoryFactory } = await import('./planner-harness.mjs');
  const keepAlive = setInterval(() => {}, 1000);
  const calls = [];
  let reply = { text: JSON.stringify({ type: 'feature', size: 'm', areas: [], why: 'a table change' }), costUsd: 0.002 };
  const tiebreak = { run: async (req) => { calls.push(req); return { ...reply, model: req.model }; } };
  const h = await engineHarness(mkdtempSync(join(tmpdir(), 'tdm-planner-')), { factory: await memoryFactory(), tiebreak });
  execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
  execFileSync('git', ['-C', h.paths.root, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const now = () => systemClock.now();
  const tailored = JSON.stringify({ summary: 'Tailored.', tasks: [{
    key: 'implement', title: 'Implement', objective: 'Do it', roleId: 'development', dependsOn: [], requiredCapabilities: [],
    inputArtifacts: [], expectedOutputs: ['ChangeSet'], executionPolicy: { isolation: 'worktree', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
    completionGate: 'artifact.ChangeSet.exists',
  }] });
  const planner = h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'planner', executablePath: null,
    args: [], settings: { script: { steps: [{ kind: 'message', text: tailored }, { kind: 'complete', summary: 'done' }] } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Factory' })).workspace.id;
  h.services.workspaces.update(ws, { routing: { architecture: [planner] } });
  const plannerRuns = (id) => h.repo.events.listByMission(id).filter((e) => e.body.type === 'run.started').length;
  const make = (title, extra = {}) => h.services.missions.create(caller, { workspaceId: ws, goal: title, title, workflowPreset: 'auto', ...extra });

  section('ceremony');
  const typo = await make('fix: typo in the settings title');
  await h.services.planning.plan(typo.id);
  const after = h.repo.missions.get(typo.id);
  const tasks = h.repo.tasks.listByMission(typo.id);
  const criteria = h.repo.criteria.listActive(typo.id);
  check('a quick auto mission with no criteria plans and starts', after.status === 'EXECUTING' && after.startedAt !== null, [after.status, after.statusReason]);
  check('with no plan approval', h.repo.approvals.list({ missionId: typo.id, statuses: ['PENDING'] }).filter((a) => a.kind === 'plan').length === 0);
  check('its steps are implement then ship', eq(tasks.map((t) => t.key), ['implement', 'ship']) && tasks[1].executor === 'ship' && tasks[1].stepClass === 'ship', tasks.map((t) => [t.key, t.executor]));
  check('it gets one implicit criterion', criteria.length === 1 && criteria[0].source === 'implicit' && criteria[0].statement === D.IMPLICIT_CRITERION, criteria);
  check('and no planner model ran', plannerRuns(typo.id) === 0);
  check('nor the tiebreak', calls.length === 0);
  const decision = h.repo.planDecisions.latest(typo.id);
  check('a plan decision is recorded', decision?.lane === 'quick' && decision.basis === 'predicted' && decision.profile.type === 'fix' && decision.skipped.length > 0, decision);
  check('plan.decided is recorded', h.repo.events.listByMission(typo.id).some((e) => e.body.type === 'plan.decided' && e.body.lane === 'quick'));
  const doc = h.repo.artifacts.latest(typo.id, 'MissionPlan');
  check('the plan document says its lane', doc !== undefined);

  const careful = await make('fix: typo in the billing title', { lane: 'careful' });
  let refused = null;
  try { await h.services.planning.plan(careful.id); } catch (e) { refused = e; }
  check('a careful mission with no criteria still needs readiness', refused?.code === 'PRECONDITION_FAILED', refused?.message);
  h.repo.criteria.addUserCriteria(careful.id, ['The billing title reads Billing.']);
  await h.services.planning.plan(careful.id);
  check('with one criterion it waits for plan approval', h.repo.missions.get(careful.id).status === 'AWAITING_PLAN_APPROVAL', h.repo.missions.get(careful.id).statusReason);
  check('after one planner run', plannerRuns(careful.id) === 1, plannerRuns(careful.id));
  const carefulTasks = h.repo.tasks.listByMission(careful.id);
  check('the tailored plan keeps the ship step', carefulTasks.at(-1)?.executor === 'ship', carefulTasks.map((t) => t.key));

  const preset = await make('fix: typo in the docs title', { workflowPreset: 'quick-change' });
  let presetRefused = null;
  try { await h.services.planning.plan(preset.id); } catch (e) { presetRefused = e; }
  check('a preset mission with no criteria still throws the readiness error', presetRefused?.code === 'PRECONDITION_FAILED');

  section('speed');
  const times = [];
  for (let i = 0; i < 3; i++) {
    const m = await make(`fix: typo number ${i}`);
    const t0 = performance.now();
    await h.services.planning.plan(m.id);
    await h.scheduler.tick();
    const implement = h.repo.tasks.listByMission(m.id).find((t) => t.key === 'implement');
    times.push(implement.status === 'PENDING' ? Infinity : performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  check(`quick planning to a READY step is under ${app.QUICK_PLAN_BUDGET_MS} ms (median ${Math.round(times[1])} ms)`, times[1] < app.QUICK_PLAN_BUDGET_MS, times);

  section('tiebreak');
  const migrate = await make('Migrate users table', { successCriteria: ['Users move.', 'Nothing is lost.'] });
  await h.services.planning.plan(migrate.id);
  const mDecision = h.repo.planDecisions.latest(migrate.id);
  check('the tiebreak runs when the type is unknown', calls.length === 1 && mDecision.tiebreak?.reason === 'type_unknown' && mDecision.profile.type === 'feature', mDecision?.tiebreak);
  check('its spend is recorded', mDecision.tiebreak?.costUsd === 0.002);
  reply = { text: 'not json', costUsd: null };
  const migrate2 = await make('Migrate users table again', { successCriteria: ['Users move.', 'Nothing is lost.'] });
  await h.services.planning.plan(migrate2.id);
  const g = h.repo.planDecisions.latest(migrate2.id);
  check('garbage gives the conservative default and planning goes on', g.profile.type === 'unknown' && g.profile.size === 'm' && g.profile.risk === 'high' && g.profile.signals.some((s) => s.effect.includes('conservative default')) && h.repo.missions.get(migrate2.id).status !== 'PLANNING', g.profile);
  check('an unreported cost stays null', g.tiebreak?.costUsd === null && g.tiebreak?.error !== null, g.tiebreak);
  check('it never ran for the typo', h.repo.planDecisions.latest(typo.id).tiebreak === null);
  clearInterval(keepAlive);
});

await attempt('mid-mission escalation', async () => {
  section('mid-mission escalation');
  const keepAlive = setInterval(() => {}, 1000);
  const { world } = await import('./planner-harness.mjs');
  const w = await world({ scripts: { touch: 'src/auth/session.ts' } });
  const planner = w.h.container.resolve(app.PLANNER_SERVICE);
  const m = await w.mission('fix: typo in the settings title');
  check('it was planned quick', w.h.repo.planDecisions.latest(m.id)?.lane === 'quick');
  const task = (key) => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === key);
  await w.h.until(() => task('security_review') !== undefined, 60000);
  const tasks = w.h.repo.tasks.listByMission(m.id);
  check('a security review was added between implement and ship', task('security_review')?.dependsOn.includes('implement') && task('ship').dependsOn.includes('security_review'), tasks.map((t) => [t.key, t.dependsOn, t.status]));
  check('without an approval card', w.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).length === 0);
  const notes = w.h.repo.events.listByMission(m.id).filter((e) => e.body.type === 'note').map((e) => e.body.text);
  check('the feed says why', notes.includes('It touched src/auth/session.ts, so I added a security review.'), notes.slice(-5));
  check('the latest decision is measured', w.h.repo.planDecisions.latest(m.id)?.basis === 'measured' && w.h.repo.planDecisions.latest(m.id)?.modules.includes('security-review'));
  let late = null;
  try { await planner.switchLane(m.id, 'careful', w.caller); } catch (e) { late = e; }
  const shipStatus = task('ship').status;
  check('switching lanes once the ship step started is refused, or allowed before it', shipStatus === 'PENDING' || shipStatus === 'READY'
    ? late === null : late?.message === "The pull request is already on its way; the lane can't change now.", [shipStatus, late?.message]);

  const docs = await w.mission('Tidy the docs readme', { successCriteria: ['It reads well.', 'Links work.'] });
  const before = w.h.repo.tasks.listByMission(docs.id).map((t) => t.key);
  const added = await planner.escalate(w.h.repo.missions.get(docs.id), ['docs/readme.md']);
  check('a lighter measured profile changes nothing', added.length === 0 && eq(w.h.repo.tasks.listByMission(docs.id).map((t) => t.key), before), [added, before]);

  const std = await w.mission('fix: the export fails for big files', { successCriteria: ['Exports of 1 GB work.', 'Nothing else changes.'] });
  check('a fix with two Done-when lines runs the standard fix lane', eq(w.h.repo.tasks.listByMission(std.id).map((t) => t.key), ['implement', 'review', 'verify', 'ship']), w.h.repo.tasks.listByMission(std.id).map((t) => t.key));
  await planner.switchLane(std.id, 'quick', w.caller);
  const card = w.h.repo.approvals.list({ missionId: std.id, statuses: ['PENDING'] }).find((a) => a.kind === 'plan');
  check('making it quick asks first, and removes nothing yet', card !== undefined && w.h.repo.tasks.listByMission(std.id).length === 4, card?.title);
  await w.h.services.approvals.decide(w.caller, card.id, { optionId: card.options.find((o) => /approve/i.test(o.id))?.id ?? card.options[0].id });
  const after = w.h.repo.tasks.listByMission(std.id);
  check('approved, review and verify are gone and ship follows implement', eq(after.map((t) => t.key), ['implement', 'ship']) && after[1].dependsOn.includes('implement'), after.map((t) => [t.key, t.dependsOn]));
  check('and the lane is quick, made so by you', w.h.repo.missions.get(std.id).laneRequest === 'quick' && w.h.repo.planDecisions.latest(std.id)?.lightenedByPerson === true);
  let notAuto = null;
  const preset = await w.h.services.missions.create(w.caller, { workspaceId: w.ws, goal: 'x', title: 'x', workflowPreset: 'quick-change', successCriteria: ['x'] });
  try { await planner.switchLane(preset.id, 'careful', w.caller); } catch (e) { notAuto = e; }
  check('a mission the factory did not plan has no lane', notAuto?.message === 'Only missions the factory planned have a lane.', notAuto?.message);
  clearInterval(keepAlive);
});

await attempt('plan-time approvals from holds', async () => {
  section('plan-time approvals from holds');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { engineHarness, memoryFactory } = await import('./planner-harness.mjs');
  const keepAlive = setInterval(() => {}, 1000);
  const h = await engineHarness(mkdtempSync(join(tmpdir(), 'tdm-holds-')), { factory: await memoryFactory({ planner: SPEC_PLANNER }) });
  execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
  execFileSync('git', ['-C', h.paths.root, '-c', 'user.name=c', '-c', 'user.email=c@e.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Holds' })).workspace.id;
  const base = Date.UTC(2026, 9, 1);
  for (let i = 0; i < 5; i++) {
    const common = { op: 'outcome', by: 'A', mission: `old${i}`, lane: 'quick', profile: { type: 'fix', size: 's', risk: 'low', areas: ['desktop-ui'], sensitivity: 'none' }, workspaceId: ws };
    const step = { class: 'implement', model: null, attempt: 1, gatePassed: true, costUsd: null, wallTimeMs: null, taskKey: 'implement' };
    h.repo.outcomes.append({ ...common, id: `out_a${i}`, at: new Date(base + i * 1000).toISOString(), kind: 'step_result', step });
    if (i < 3) h.repo.outcomes.append({ ...common, id: `out_b${i}`, at: new Date(base + i * 1000 + 500).toISOString(), kind: 'held', step });
  }
  const make = async (title) => {
    const m = await h.services.missions.create(caller, { workspaceId: ws, goal: title, title, workflowPreset: 'auto' });
    await h.services.planning.plan(m.id);
    return h.repo.tasks.listByMission(m.id).find((t) => t.key === 'implement');
  };
  const ui = await make('fix: panel spacing in apps/desktop/src/renderer/x.tsx');
  check('a desktop-ui implement step people kept stepping into gets an after approval', ui.approvalPolicy.onCompletion === true
    && ui.approvalPolicy.reason === "People stepped in on 3 of the last 5 desktop-ui implement steps, so you'll look at this one before it moves on.", ui.approvalPolicy);
  const docs = await make('docs: fix the install steps in docs/install.md');
  check('a docs task gets none', docs.approvalPolicy.onCompletion === false, docs.approvalPolicy);
  clearInterval(keepAlive);
});

await attempt('brain source', async () => {
  section('brain source');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { engineHarness } = await import('./planner-harness.mjs');
  const EL = await import('@tandemise/execution-local');
  const { nullLogger } = await import('@tandemise/shared');
  const keepAlive = setInterval(() => {}, 1000);
  const base = mkdtempSync(join(tmpdir(), 'tdm-brainsrc-'));
  const gitconfig = join(base, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  const supervisor = new EL.NodeProcessSupervisor(nullLogger);
  const brainRepo = new EL.GitBrainRepo(supervisor, nullLogger, () => ({ GIT_CONFIG_GLOBAL: gitconfig }));
  const boot = async () => {
    const h = await engineHarness(join(base, 'home'), { brainRepo });
    return h;
  };
  const h = await boot();
  execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
  execFileSync('git', ['-C', h.paths.root, '-c', 'user.name=c', '-c', 'user.email=c@e.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const code = join(base, 'code');
  mkdirSync(code);
  execFileSync('git', ['init', '-q', '-b', 'main', code]);
  execFileSync('git', ['-C', code, '-c', 'user.name=c', '-c', 'user.email=c@e.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Brainy', repositoryPath: code })).workspace.id;
  const brain = h.container.resolve(app.BRAIN_SERVICE);
  await brain.link(caller, ws, { mode: 'local' });
  const link = brain.linkOf(ws);
  check('a local brain is linked', link !== undefined && link.lastPulledSha !== null, link);
  // A person writes the brain's planner rules: every task is careful.
  const planner = { ...app.SHIPPED_PLANNER, lanes: [{ lane: 'careful' }] };
  await brain.exclusive(ws, async () => {
    await brainRepo.commit(link.clonePath, [{ path: 'factory/planner.yaml', mode: 'write', content: JSON.stringify(planner) }], 'chore: careful rules', brain.author());
  });
  brain.markPulled(ws, await brainRepo.head(link.clonePath));
  const sha = brain.linkOf(ws).lastPulledSha;
  const plannerService = h.container.resolve(app.PLANNER_SERVICE);
  const config = await plannerService.config(ws);
  check('the planner reads factory/planner.yaml from the brain', config.origins.planner === 'brain' && config.refs.planner === `brain:${sha.slice(0, 12)}` && config.planner.lanes[0].lane === 'careful', [config.origins, config.refs]);
  check('files the brain lacks fall back to the built-in ones', config.origins.merge === 'shipped', config.origins);
  const m = await h.services.missions.create(caller, { workspaceId: ws, goal: 'docs: fix the readme', title: 'docs: fix the readme', workflowPreset: 'auto', successCriteria: ['It reads well.'] });
  const predicted = await plannerService.predict(h.repo.missions.get(m.id));
  check('planning follows the brain\'s rules', predicted.lane === 'careful', predicted.lane);

  // A person's edit to the merge policy is a commit to the brain's factory/merge.yaml.
  await h.services.mergePolicy.update(ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, caller);
  const head = await brainRepo.head(brain.linkOf(ws).clonePath);
  const text = await brainRepo.readAt(brain.linkOf(ws).clonePath, head, 'factory/merge.yaml');
  check('turning auto-merge on writes factory/merge.yaml in the brain', typeof text === 'string' && /autoMerge: on/.test(text), text?.slice(0, 120));
  check('…and the project repository is untouched', !execFileSync('git', ['-C', code, 'ls-files'], { encoding: 'utf8' }).includes('.tandemise/factory'));
  check('…and the merge policy now comes from the brain', (await plannerService.config(ws)).origins.merge === 'brain');

  // Outcomes go into the brain's ledger, once.
  const recorder = h.container.resolve(app.OUTCOME_RECORDER);
  h.repo.planDecisions.create({ id: 'pld_brain', missionId: m.id, policyRef: 'x', basis: 'predicted', profile: { type: 'docs', size: 'xs', risk: 'low', areas: [], repos: [], signals: [], source: 'rules', basis: 'predicted' }, lane: 'quick', laneBecause: 'x', workflowId: 'quick', modules: [], dropped: [], steps: [], approvals: [], skipped: [], tiebreak: null, lightenedByPerson: false, createdAt: new Date().toISOString() });
  const task = { id: 'tsk_brain', missionId: m.id, key: 'implement', executor: 'agent', stepClass: 'implement', roleId: 'development', attempts: 1, modelPolicy: null, status: 'SUCCEEDED' };
  recorder.changesRequested(task);
  await brain.flush(ws);
  const history = h.container.resolve(app.OUTCOME_HISTORY);
  const fromLedger = await history.ledger(ws);
  check('an outcome is appended to the brain\'s ledger as an outcome op', fromLedger.filter((o) => o.mission === m.id && o.kind === 'changes_requested').length === 1, fromLedger);
  const local = h.repo.outcomes.listByWorkspace(ws, '1970').filter((o) => o.mission === m.id);
  await history.refresh(ws);
  const merged = history.listByWorkspace(ws, '1970');
  check('the routing history reads it once, from both', merged.filter((o) => o.mission === m.id).length === local.length && local.length === 1, merged.length);
  // A restart: the same outcome is still there once.
  const h2 = await boot();
  const h2history = h2.container.resolve(app.OUTCOME_HISTORY);
  await h2history.refresh(ws);
  const again = h2history.listByWorkspace(ws, '1970');
  check('after a restart the outcome is still there once', again.filter((o) => o.mission === m.id && o.kind === 'changes_requested').length === 1, again.length);
  check('the brain\'s memory fold is not disturbed by outcome ops', Array.isArray(brain.memory(ws).problems) && !brain.memory(ws).problems.some((p) => /outcome/i.test(p.problem)), brain.memory(ws).problems);
  clearInterval(keepAlive);
});

await attempt('review: brain edits offline and by pull request', async () => {
  section('review: brain edits offline and by pull request');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { engineHarness, realExecutor } = await import('./planner-harness.mjs');
  const EL = await import('@tandemise/execution-local');
  const { nullLogger } = await import('@tandemise/shared');
  const keepAlive = setInterval(() => {}, 1000);
  const base = mkdtempSync(join(tmpdir(), 'tdm-brainedit-'));
  const gitconfig = join(base, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = Check\n\temail = check@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  const brainRepo = new EL.GitBrainRepo(new EL.NodeProcessSupervisor(nullLogger), nullLogger, () => ({ GIT_CONFIG_GLOBAL: gitconfig }));
  mkdirSync(join(base, 'bin'));
  const h = await engineHarness(join(base, 'home'), { brainRepo, commandExecutor: realExecutor(join(base, 'bin')) });
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=c', '-c', 'user.email=c@e.com', ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
  g(h.paths.root, 'commit', '-q', '--allow-empty', '-m', 'init');
  const code = join(base, 'code');
  mkdirSync(code);
  execFileSync('git', ['init', '-q', '-b', 'main', code]);
  g(code, 'commit', '-q', '--allow-empty', '-m', 'init');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Edits', repositoryPath: code })).workspace.id;
  const brain = h.container.resolve(app.BRAIN_SERVICE);
  await brain.link(caller, ws, { mode: 'local' });
  const clone = brain.linkOf(ws).clonePath;
  const bare = join(base, 'brain.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  g(clone, 'remote', 'add', 'origin', bare);
  g(clone, 'push', '-q', 'origin', 'main');
  h.container.resolve(app.WORKSPACE_BRAIN_REPOSITORY).update(ws, { remote: 'example.test/brain' });
  // Turn it on (direct edits), then lose the network and turn it off: it is off here at once, and you are told.
  await h.services.mergePolicy.update(ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, caller);
  g(clone, 'remote', 'set-url', 'origin', join(base, 'nowhere.git'));
  await h.services.mergePolicy.stop(ws, caller);
  const planner = h.container.resolve(app.PLANNER_SERVICE);
  const config = await planner.config(ws);
  check('stopping auto-merge offline takes effect on this machine', config.origins.merge === 'brain' && config.merge.autoMerge === 'off', [config.origins.merge, config.merge.autoMerge]);
  check('…and says the push failed', (brain.extraProblems.get(ws) ?? []).some((p) => p.includes("couldn't be pushed")), brain.extraProblems.get(ws));
  // A brain that asks for edits as pull requests: turning it on opens one and changes nothing here yet.
  g(clone, 'remote', 'set-url', 'origin', bare);
  g(clone, 'push', '-q', 'origin', 'main');
  const manifest = g(clone, 'show', 'HEAD:brain.yaml');
  writeFileSync(join(clone, 'brain.yaml'), manifest.replace(/humanEdits: direct/, 'humanEdits: pr'));
  g(clone, 'commit', '-q', '-am', 'chore: edits by pull request');
  g(clone, 'push', '-q', 'origin', 'main');
  brain.markPulled(ws, g(clone, 'rev-parse', 'HEAD'));
  const opened = [];
  h.container.rebind(app.BRAIN_HOST, () => ({ openPr: async (input) => { opened.push(input); return { url: 'https://github.com/x/brain/pull/9' }; } }), { source: 'check' });
  g(clone, 'commit', '-q', '--allow-empty', '-m', 'an unrelated local commit');
  await h.services.mergePolicy.update(ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, caller);
  check('with humanEdits: pr, the edit opens a pull request in the brain', opened.length === 1 && opened[0].head.startsWith('tandemise/edit/'), opened);
  const onBranch = g(bare, 'show', `${opened[0]?.head}:factory/merge.yaml`);
  check('…whose branch has the edit, cut from origin', onBranch.includes('autoMerge: on') && !g(bare, 'log', '--format=%s', opened[0]?.head).includes('an unrelated local commit'), onBranch.slice(0, 80));
  check('…and nothing changes here until it merges', (await planner.config(ws)).merge.autoMerge === 'off' && g(clone, 'log', '-1', '--format=%s') === 'an unrelated local commit');
  clearInterval(keepAlive);
});

await attempt('a tracker item\'s type profiles the mission', async () => {
  section('a tracker item\'s type profiles the mission');
  const keepAlive = setInterval(() => {}, 1000);
  const { world } = await import('./planner-harness.mjs');
  const w = await world();
  const planner = w.h.container.resolve(app.PLANNER_SERVICE);
  // As intake's Start makes it: a mission pointing at its tracker item (#52).
  const PS = await import('@tandemise/persistence');
  const items = w.h.container.resolve(PS.TRACKER_ITEM_REPOSITORY);
  if (w.h.container.tryResolve(app.TRACKER_ITEM_REPOSITORY) === undefined) w.h.container.bind(app.TRACKER_ITEM_REPOSITORY, () => items, { source: 'check' });
  const item = items.upsert(w.ws, { ref: 'github:acme/web#7', key: '#7', url: 'https://github.com/acme/web/issues/7', title: 'Settings page title', description: 'It reads Setings', state: 'open', assignee: null, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), type: 'Bug' });
  const made = await w.h.services.missions.create(w.caller, { workspaceId: w.ws, goal: 'The settings page title reads Setings', title: 'Settings page title', workflowPreset: 'auto' });
  const id = made.id ?? made.mission?.id;
  const plain = await planner.predict(w.h.repo.missions.get(id));
  w.h.repo.missions.update(id, { trackerItemId: item.id });
  const fromTracker = await planner.predict(w.h.repo.missions.get(id));
  check('a Bug from the tracker profiles as a fix, saying so', fromTracker.profile.type === 'fix' && fromTracker.profile.signals.some((s) => s.name === 'tracker type' && s.value === 'Bug'), fromTracker.profile.signals);
  check('…which the same text alone does not say', !plain.profile.signals.some((s) => s.name === 'tracker type'), plain.profile.signals);
  clearInterval(keepAlive);
});

// @sections

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
