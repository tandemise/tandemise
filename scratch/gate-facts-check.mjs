/**
 * A completion gate must read the CURRENT state of the work, never a stale one.
 *
 * Found in the real app: task `implement` of a real mission burned all 14 of its
 * attempts and blocked with `Not met: checks.tests is "FAIL" != FAIL`, while
 * `npm test` had passed on attempts 3-14. Its tests failed exactly once, on
 * attempt 1, two days earlier.
 *
 * Cause: `GateService.factsFor` layered `listChecks(task.id)` - the task's ENTIRE
 * check history, every attempt - into `GateFactBuilder.withChecks`, which folds
 * worst-outcome-wins. One FAIL anywhere in the history pinned the fact to FAIL
 * forever, so no retry could ever clear it. The retry loop was unwinnable.
 *
 * Check facts have two dimensions and they need opposite rules:
 *
 *   - ACROSS TIME (attempts, later tasks on the same code): the latest
 *     measurement wins. A retry exists to clear an earlier failure.
 *   - ACROSS SCOPE (repositories): the worst measurement wins. A mission that
 *     spans two repos must not ship because the second one passed after the
 *     first one failed.
 *
 * Collapse time first, then fold scope. This proves both, and that the second
 * rule - the reason the fold became worst-wins in 2f9b255 - still holds.
 *
 *   node scratch/gate-facts-check.mjs
 *
 * Also: a preset gate never passes on a test result nobody measured. When the
 * repository declares a test command, `checks.tests != FAIL` was true with no
 * result at all, so a build that never ran its tests cleared its gate.
 *
 * Build first: npx tsc -b packages/application
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ids, newId, systemClock } from '../packages/shared/dist/index.js';
import { Container, compose } from '../packages/kernel/dist/index.js';
import {
  APPROVAL_REPOSITORY, ARTIFACT_REPOSITORY, EVALUATION_REPOSITORY, MISSION_REPOSITORY,
  REPO_REPOSITORY, TASK_REPOSITORY, WORKSPACE_REPOSITORY, persistenceModule,
} from '../packages/persistence/dist/index.js';
import { GateService, WORKFLOW_PRESETS, buildPlannerPrompt, findPreset } from '../packages/application/dist/index.js';
import { evaluateGate } from '../packages/domain/dist/index.js';

let passed = 0;
const failures = [];
const check = (label, condition, detail) => {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const dir = mkdtempSync(join(tmpdir(), 'tandemise-gate-facts-'));
const container = new Container();
compose(container, persistenceModule({ path: join(dir, 'tandemise.db'), clock: systemClock }));
const R = {
  workspaces: container.resolve(WORKSPACE_REPOSITORY),
  repos: container.resolve(REPO_REPOSITORY),
  missions: container.resolve(MISSION_REPOSITORY),
  tasks: container.resolve(TASK_REPOSITORY),
  artifacts: container.resolve(ARTIFACT_REPOSITORY),
  evaluations: container.resolve(EVALUATION_REPOSITORY),
  approvals: container.resolve(APPROVAL_REPOSITORY),
};
const gates = new GateService(R.tasks, R.artifacts, R.evaluations, R.approvals, R.missions);

const wsId = ids.workspace();
R.workspaces.create({
  id: wsId, name: 'Acme', defaultRepositoryId: null,
  autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
  concurrency: { maxTotalWorkers: 3, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced',
  knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
});
const mkRepo = (name) => R.repos.create({
  id: ids.repository(), workspaceId: wsId, name, path: `/tmp/${name}`, defaultBranch: 'main', remoteUrl: null,
  checks: { install: 'npm ci', typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test', build: null, devServer: null, devServerUrl: null },
}).id;
const repoA = mkRepo('acme-web');
const repoB = mkRepo('acme-api');

const GATE = 'artifact.ChangeSet.exists && checks.typecheck != FAIL && checks.lint != FAIL && checks.tests != FAIL';
let clock = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, clock++)).toISOString();

function newMission(repositoryId = repoA) {
  const missionId = ids.mission();
  R.missions.create({
    id: missionId, workspaceId: wsId, repositoryId, title: 'Redesign', goal: 'ship it',
    constraints: [], successCriteria: [], autonomy: 'balanced', baseBranch: 'main',
  });
  return missionId;
}

function mkTask(missionId, key, opts = {}) {
  const id = ids.task();
  const now = systemClock.now();
  return {
    id, missionId, key, title: `Task ${key}`, objective: `do ${key}`, roleId: 'development',
    dependsOn: [], requiredCapabilities: ['filesystem.write'], inputArtifacts: [],
    expectedOutputs: ['ChangeSet'],
    executionPolicy: { isolation: 'worktree', maxWallTimeMs: 600000, capabilities: ['shell.exec'] },
    approvalPolicy: { beforeStart: false, onCompletion: false },
    retryPolicy: { maxAttempts: 14, backoffMs: 5000, onExhausted: 'block' },
    completionGate: GATE, status: 'RUNNING', statusReason: null, attempts: opts.attempts ?? 1,
    remediatesTaskId: null, orderHint: opts.orderHint ?? 0,
    createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
    repositoryId: opts.repositoryId ?? null,
  };
}

function recordCheck(missionId, taskId, name, outcome, createdAt) {
  R.evaluations.recordCheck({
    id: newId('chk'),
    missionId, taskId, runId: null, name, outcome,
    detail: `${name} ${outcome}`, command: 'npm test', exitCode: outcome === 'FAIL' ? 1 : 0,
    durationMs: 1000, outputRef: null, createdAt,
  });
}

function changeSet(missionId, taskId) {
  R.artifacts.create({
    id: ids.artifact(), workspaceId: wsId, missionId, taskId, createdByRunId: null,
    type: 'ChangeSet', title: 'the work', contentRef: 'artifacts/cs.md', mediaType: 'text/markdown',
    sha256: 'c'.repeat(64), byteSize: 64, schemaVersion: 1, sourceRefs: [], supersedes: null,
    summary: 'the work', createdAt: at(),
  });
}

// ---------------------------------------------------------------------------
section('a retry clears the failure it was created to fix (the reported bug)');
{
  const missionId = newMission();
  const [task] = R.tasks.replaceAll(missionId, [mkTask(missionId, 'implement', { attempts: 14 })]);
  changeSet(missionId, task.id);
  // Attempt 1 failed its tests. Attempts 2-14 passed them, exactly as the real
  // mission did.
  recordCheck(missionId, task.id, 'checks.tests', 'FAIL', at());
  recordCheck(missionId, task.id, 'checks.lint', 'PASS', at());
  for (let attempt = 2; attempt <= 14; attempt += 1) {
    recordCheck(missionId, task.id, 'checks.install', 'PASS', at());
    recordCheck(missionId, task.id, 'checks.lint', 'PASS', at());
    recordCheck(missionId, task.id, 'checks.typecheck', 'SKIP', at());
    recordCheck(missionId, task.id, 'checks.tests', 'PASS', at());
  }
  const facts = gates.factsFor(R.tasks.get(task.id));
  const outcome = gates.evaluate(R.tasks.get(task.id));
  check('the fact reads the newest measurement, not the worst one ever taken',
    facts['checks.tests'] === 'PASS', `checks.tests = ${facts['checks.tests']}`);
  check('the task that passed its tests 13 times in a row clears its gate',
    outcome.passed === true, outcome.detail);
  check('a SKIPped check does not block a `!= FAIL` condition',
    facts['checks.typecheck'] === 'SKIP');
}

// ---------------------------------------------------------------------------
section('a fix task clears the failure of the task it remediates');
{
  const missionId = newMission();
  const [broken, fix] = R.tasks.replaceAll(missionId, [
    mkTask(missionId, 'implement', { orderHint: 0 }),
    mkTask(missionId, 'address_review', { orderHint: 1 }),
  ]);
  changeSet(missionId, broken.id);
  // The implementer's tests failed and it never ran again - its own latest
  // measurement stays FAIL for good.
  recordCheck(missionId, broken.id, 'checks.tests', 'FAIL', at());
  // The fix task runs later on the same repository and the tests pass.
  recordCheck(missionId, fix.id, 'checks.tests', 'PASS', at());
  const facts = gates.factsFor(R.tasks.get(fix.id));
  check('the later measurement on the same repository wins',
    facts['checks.tests'] === 'PASS', `checks.tests = ${facts['checks.tests']}`);
  check('the fix task can clear its gate', gates.evaluate(R.tasks.get(fix.id)).passed === true);
  check('and so can the task it fixed, which is the same code now',
    gates.evaluate(R.tasks.get(broken.id)).passed === true);
}

// ---------------------------------------------------------------------------
section('a check that is failing RIGHT NOW still blocks (2f9b255 must hold)');
{
  const missionId = newMission();
  const [first, second] = R.tasks.replaceAll(missionId, [
    mkTask(missionId, 'implement', { orderHint: 0 }),
    mkTask(missionId, 'docs', { orderHint: 1 }),
  ]);
  changeSet(missionId, first.id);
  // The docs task ran first and passed; the implementer's tests failed after
  // that and nothing has re-measured them since.
  recordCheck(missionId, second.id, 'checks.tests', 'PASS', at());
  recordCheck(missionId, first.id, 'checks.tests', 'FAIL', at());
  const facts = gates.factsFor(R.tasks.get(second.id));
  check('an unfixed failure is still the newest word on the code',
    facts['checks.tests'] === 'FAIL', `checks.tests = ${facts['checks.tests']}`);
  check('it blocks a sibling task that never measured the tests itself',
    gates.evaluate(R.tasks.get(second.id)).passed === false);
}

// ---------------------------------------------------------------------------
section('one repository passing never masks another repository failing');
{
  const missionId = newMission();
  const [web, api] = R.tasks.replaceAll(missionId, [
    mkTask(missionId, 'web', { orderHint: 0, repositoryId: repoA }),
    mkTask(missionId, 'api', { orderHint: 1, repositoryId: repoB }),
  ]);
  changeSet(missionId, web.id);
  changeSet(missionId, api.id);
  // The API's tests are broken. The web app's tests pass afterwards - later in
  // time, but about entirely different code.
  recordCheck(missionId, api.id, 'checks.tests', 'FAIL', at());
  recordCheck(missionId, web.id, 'checks.tests', 'PASS', at());
  const facts = gates.factsFor(R.tasks.get(web.id));
  check('the mission-level fact reports the broken repository',
    facts['checks.tests'] === 'FAIL', `checks.tests = ${facts['checks.tests']}`);
  check('neither task ships while one repository is red',
    gates.evaluate(R.tasks.get(web.id)).passed === false && gates.evaluate(R.tasks.get(api.id)).passed === false);

  // ...and the repository that was red clears once IT is re-measured.
  recordCheck(missionId, api.id, 'checks.tests', 'PASS', at());
  check('fixing the red repository clears the mission-level fact',
    gates.factsFor(R.tasks.get(web.id))['checks.tests'] === 'PASS');
  check('both tasks can now pass their gate',
    gates.evaluate(R.tasks.get(web.id)).passed === true && gates.evaluate(R.tasks.get(api.id)).passed === true);
}

// ---------------------------------------------------------------------------
section('a blocked gate says which measurement blocked it, and when');
{
  const missionId = newMission();
  const [task] = R.tasks.replaceAll(missionId, [mkTask(missionId, 'implement')]);
  changeSet(missionId, task.id);
  recordCheck(missionId, task.id, 'checks.tests', 'FAIL', '2026-01-01T00:00:00.000Z');
  const outcome = gates.evaluate(R.tasks.get(task.id));
  check('the gate does not pass', outcome.passed === false);
  check('the reason names the failing check in words a person can act on',
    /tests/.test(outcome.detail) && !/is "FAIL" != FAIL/.test(outcome.detail), outcome.detail);
}

// ---------------------------------------------------------------------------
section('what a person is shown is the current state, not every attempt');
{
  const missionId = newMission();
  const [task] = R.tasks.replaceAll(missionId, [mkTask(missionId, 'implement', { attempts: 14 })]);
  recordCheck(missionId, task.id, 'checks.tests', 'FAIL', at());
  for (let attempt = 2; attempt <= 14; attempt += 1) {
    for (const name of ['checks.install', 'checks.lint', 'checks.typecheck', 'checks.tests']) {
      recordCheck(missionId, task.id, name, name === 'checks.typecheck' ? 'SKIP' : 'PASS', at());
    }
  }
  check('the history is still kept in full', R.evaluations.listChecks(task.id).length === 53);
  const shown = R.evaluations.latestChecksForTask(task.id);
  check('a task reports one result per check, not one per attempt',
    shown.length === 4, `${shown.length} rows for 4 checks`);
  check('and each one is the newest measurement',
    shown.find((c) => c.name === 'checks.tests').outcome === 'PASS');
  check('the drawer no longer shows a two-day-old FAIL beside 13 passes',
    shown.every((c) => c.outcome !== 'FAIL'));
}

// ---------------------------------------------------------------------------
section('a task that exhausted its retries is diagnosable, not a dead end');
{
  // The card a person is left with must say what the gate reads NOW. The real
  // one said only "failed its completion gate on every one of its 14 attempts",
  // which was true of the gate and false of the work: the tests had passed 13
  // times running.
  const missionId = newMission();
  const [task] = R.tasks.replaceAll(missionId, [mkTask(missionId, 'implement', { attempts: 14 })]);
  changeSet(missionId, task.id);
  recordCheck(missionId, task.id, 'checks.tests', 'FAIL', at());
  recordCheck(missionId, task.id, 'checks.tests', 'PASS', at());
  const outcome = gates.evaluate(R.tasks.get(task.id));
  check('the live gate outcome is what the card would quote', outcome.passed === true, outcome.detail);
  check('so the person can tell that one more attempt clears it',
    outcome.detail === 'All gate conditions met.');
}

// ---------------------------------------------------------------------------
section('naming the mission repository explicitly is the same scope as leaving it null');
{
  // `repositoryId: null` means "the mission's repository". A plan may spell it
  // out on one task and leave it null on the next; both work the same code, so
  // a measurement on one has to supersede a measurement on the other.
  const missionId = newMission(repoA);
  const [implicit, explicit] = R.tasks.replaceAll(missionId, [
    mkTask(missionId, 'implement', { orderHint: 0 }),                       // repositoryId: null
    mkTask(missionId, 'address_review', { orderHint: 1, repositoryId: repoA }),
  ]);
  changeSet(missionId, implicit.id);
  recordCheck(missionId, implicit.id, 'checks.tests', 'FAIL', at());
  recordCheck(missionId, explicit.id, 'checks.tests', 'PASS', at());
  check('the later measurement wins across the two spellings of one repository',
    gates.factsFor(R.tasks.get(explicit.id))['checks.tests'] === 'PASS',
    gates.factsFor(R.tasks.get(explicit.id))['checks.tests']);
  check('both tasks clear their gate',
    gates.evaluate(R.tasks.get(explicit.id)).passed === true
    && gates.evaluate(R.tasks.get(implicit.id)).passed === true);
}

// ---------------------------------------------------------------------------
section('an unmeasured test result never passes a preset gate');
{
  // The preset gates used to read `checks.tests != FAIL`, which is also true
  // when there is no test result at all. A repository that declares a test
  // command must show a PASS; only one with no test command at all may pass on
  // SKIP, because nothing there can ever be measured.
  const gateOf = (presetId, key, context) =>
    findPreset(presetId).build(context).tasks.find((t) => t.key === key).completionGate;
  const withTests = { hasTestCommand: true };
  const withoutTests = { hasTestCommand: false };

  for (const [presetId, key] of [['feature-delivery', 'implement'], ['bug-investigation', 'fix']]) {
    const gate = gateOf(presetId, key, withTests);
    check(`${presetId}/${key}: a repository with a test command demands a PASS`,
      gate.includes('checks.tests == PASS') && !gate.includes('checks.tests != FAIL'), gate);
    const tolerant = gateOf(presetId, key, withoutTests);
    check(`${presetId}/${key}: a repository without one tolerates SKIP`,
      tolerant.includes('checks.tests != FAIL'), tolerant);
    check(`${presetId}/${key}: no repository information is the tolerant form`,
      gateOf(presetId, key, undefined) === tolerant);

    const missionId = newMission();
    const [task] = R.tasks.replaceAll(missionId, [{ ...mkTask(missionId, key), completionGate: gate }]);
    changeSet(missionId, task.id);
    recordCheck(missionId, task.id, 'checks.typecheck', 'PASS', at());
    const unmeasured = gates.evaluate(R.tasks.get(task.id));
    check(`${presetId}/${key}: with a ChangeSet and no test result the gate is not met`,
      unmeasured.passed === false, unmeasured.detail);
    check(`${presetId}/${key}: and the reason names the missing test result`,
      unmeasured.detail.includes('checks.tests'), unmeasured.detail);
    recordCheck(missionId, task.id, 'checks.tests', 'SKIP', at());
    check(`${presetId}/${key}: a SKIP is not a PASS where a test command exists`,
      gates.evaluate(R.tasks.get(task.id)).passed === false);
    recordCheck(missionId, task.id, 'checks.tests', 'PASS', at());
    const measured = gates.evaluate(R.tasks.get(task.id));
    check(`${presetId}/${key}: once the tests pass the gate is met`, measured.passed === true, measured.detail);

    const bare = newMission();
    const [loose] = R.tasks.replaceAll(bare, [{ ...mkTask(bare, key), completionGate: tolerant }]);
    changeSet(bare, loose.id);
    recordCheck(bare, loose.id, 'checks.tests', 'SKIP', at());
    check(`${presetId}/${key}: without a test command a SKIP still clears it`,
      gates.evaluate(R.tasks.get(loose.id)).passed === true, gates.evaluate(R.tasks.get(loose.id)).detail);
  }

  // The planner starts from the same preset, so it must be handed the same rule.
  const prompt = (test) => buildPlannerPrompt({
    mission: { title: 'x', goal: 'g', constraints: [], successCriteria: [], autonomy: 'balanced' },
    repository: { id: 'r', name: 'acme-web', path: '/x', defaultBranch: 'main', checks: { install: null, typecheck: null, lint: null, test, build: null } },
    roles: [], preset: findPreset('feature-delivery'), availableCapabilities: [], repositoryContext: null,
  });
  const strict = prompt('npm test');
  check('the planner is told to gate on `checks.tests == PASS` when the repository has tests',
    strict.includes('"completionGate": "artifact.ChangeSet.exists && checks.typecheck != FAIL && checks.tests == PASS"')
    && strict.includes('declares a test command') && !strict.includes('Prefer `checks.tests != FAIL`'));
  check('and that SKIP is the only answer when it has none', prompt(null).includes('declares no test command'));
}

// ---------------------------------------------------------------------------
section('a step with no output artifact does not pass');
{
  // Found in P10: the release step's gate read only QA facts, so a release run
  // that wrote nothing passed. A gate replaces the "every expected output was
  // produced" rule (task-executor `decide`), so a gate on a step that declares
  // outputs must itself demand one of them: "the step produced its output" is a
  // measured fact like any other.
  const ownsOutput = (task) => task.completionGate === null || task.expectedOutputs.length === 0
    || task.expectedOutputs.some((type) => task.completionGate.split(/[\s()!&|]+/).includes(`artifact.${type}.exists`));
  for (const preset of WORKFLOW_PRESETS) {
    for (const context of [{ hasTestCommand: true }, { hasTestCommand: false }]) {
      for (const task of preset.build(context).tasks) {
        check(`${preset.id}/${task.key} (${context.hasTestCommand ? 'tests' : 'no tests'}): its gate demands its own output`,
          ownsOutput(task), `${task.expectedOutputs.join(', ')} :: ${task.completionGate}`);
      }
    }
  }

  // The release gate, evaluated: every QA fact green and nothing written.
  const release = findPreset('feature-delivery').build({ hasTestCommand: true }).tasks.find((t) => t.key === 'release_candidate');
  const missionId = newMission();
  const [rc] = R.tasks.replaceAll(missionId, [{
    ...mkTask(missionId, 'release_candidate'), roleId: 'release', expectedOutputs: ['ReleaseCandidate'], completionGate: release.completionGate,
  }]);
  const facts = { ...gates.factsFor(R.tasks.get(rc.id)), 'qa.criteria_unverified': 0, 'qa.blocking_defects': 0 };
  const empty = evaluateGate(release.completionGate, facts);
  check('a release step with no ReleaseCandidate does not pass on QA facts alone', empty.passed === false, empty.detail);
  check('and the reason names the missing release candidate', empty.detail.includes('artifact.ReleaseCandidate.exists'), empty.detail);
  const written = evaluateGate(release.completionGate, { ...facts, 'artifact.ReleaseCandidate.exists': true });
  check('once it is written the same facts pass', written.passed === true, written.detail);

  // The planner is handed the same rule for the gates it writes.
  const text = buildPlannerPrompt({
    mission: { title: 'x', goal: 'g', constraints: [], successCriteria: [], autonomy: 'balanced' },
    repository: null, roles: [], preset: findPreset('feature-delivery'), availableCapabilities: [], repositoryContext: null,
  });
  check('the planner is told every gate must demand the task\'s own output',
    text.includes('must include `artifact.<Type>.exists` for an artifact in') && text.includes('`artifact.ReleaseCandidate.exists'));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? `GATE FACTS READ THE CURRENT STATE (${passed} checks)` : `${failures.length} FAILED of ${passed + failures.length}`}`);
process.exit(failures.length === 0 ? 0 : 1);
