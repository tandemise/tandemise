// A CI wait decided by its pull request (#143, #145): a plan's `wait` step whose
// command is `gh pr checks …` is decided by the pull request's state on GitHub,
// not by the command's exit code, and a wait that doesn't end is Stalled.
//
// Each mission here is planned by the factory, then given the step a careful
// plan written before the fix carried: a wait on `gh pr checks <branch>
// --required`, which the ship step waits behind. The pull request itself is
// opened as a step did it in the field: its branch pushed to the bare origin,
// and the fake `gh` (scratch/fake-gh.mjs) told about it. No real GitHub is
// touched, and the repository has no branch protection, so `--required`
// always exits 1, as it did for the owner.
//
//   npm run build && node scratch/ci-wait-check.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fake = await import('./fake-gh.mjs');
const { world, git, REPO } = await import('./planner-harness.mjs');
const { ids, systemClock } = await import('@tandemise/shared');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const attempt = async (label, fn) => {
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};
const keepAlive = setInterval(() => {}, 1000);

const w = await world();
const { h, ghDir, checkout, ws, caller } = w;
const now = () => systemClock.now();
const green = [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'success' }];
const running = [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null }];
const red = [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', logTail: 'expected 2, got 3' }];
let nextPr = 41;

/** A step's branch, pushed, and its pull request on the fake GitHub. */
const openPr = (branch, checks) => {
  git(checkout, 'checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(checkout, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-q', '-m', `work on ${branch}`);
  git(checkout, 'push', '-q', 'origin', branch);
  const sha = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'checkout', '-q', 'main');
  const number = nextPr++;
  fake.putPullRequest(ghDir, REPO, {
    number, url: `https://github.com/${REPO}/pull/${number}`, title: `Work on ${branch}`, body: '',
    headRefName: branch, headRefOid: sha, baseRefName: 'main', state: 'OPEN', isDraft: false,
    mergedBy: null, mergeCommit: null, reviewers: [], reviews: [],
  });
  if (checks !== null) fake.setChecks(ghDir, REPO, sha, checks);
  return { number, sha, url: `https://github.com/${REPO}/pull/${number}` };
};
const patchPr = (number, patch) => {
  const pr = fake.pullRequests(ghDir, REPO).find((p) => p.number === number);
  fake.putPullRequest(ghDir, REPO, { ...pr, ...patch });
};

/**
 * A mission with the step a plan from before the fix carried: `ci` waits on `command`, ship waits on `ci`.
 * `stranded`: the step is already AWAITING_EXTERNAL, as a previous daemon left it.
 */
const legacyMission = async (title, command, { stranded = false } = {}) => {
  const m = await w.mission(title);
  const ship = h.repo.tasks.listByMission(m.id).find((t) => t.executor === 'ship');
  const ci = {
    ...ship, id: ids.task(), key: 'ci', title: 'Wait for CI on the pull request', objective: 'Wait for the required checks to pass.',
    executor: 'wait', stepClass: null, modelPolicy: null, waitPolicy: { command, everyMs: 100, timeoutMs: 2_700_000 },
    dependsOn: [...ship.dependsOn], status: stranded ? 'AWAITING_EXTERNAL' : 'PENDING', statusReason: stranded ? `Waiting: ${command}` : null,
    attempts: 0, orderHint: ship.orderHint, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  };
  h.repo.tasks.add(ci);
  h.repo.tasks.update(ship.id, { dependsOn: [...ship.dependsOn, 'ci'], orderHint: ship.orderHint + 1 });
  return { m, task: (key) => h.repo.tasks.listByMission(m.id).find((t) => t.key === key) };
};
const creates = () => fake.calls(ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
const stalledRow = (missionId) => h.services.liveness.stalled(ws).find((s) => s.missionId === missionId);

await attempt('legacy --required wait, no required checks, green pull request', async () => {
  section('a legacy `--required` wait on a repository with no required checks, and a green pull request');
  const pr = openPr('feat/green', green);
  const { m, task } = await legacyMission('fix: green pull request', 'gh pr checks feat/green --required', { stranded: true });
  await h.until(() => task('ci')?.status === 'SUCCEEDED' || task('ship')?.status === 'AWAITING_APPROVAL', 30000);
  check('the stranded wait passes on the pull request\'s state, without a replan', task('ci').status === 'SUCCEEDED', [task('ci').status, task('ci').statusReason]);
  check('it says every check passed', /Every check passed on #\d+/.test(task('ci').statusReason ?? ''), task('ci').statusReason);
  await h.until(() => task('ship')?.status === 'AWAITING_APPROVAL', 30000);
  check('the ship step asks for a review', task('ship').status === 'AWAITING_APPROVAL', [task('ship').status, task('ship').statusReason]);
  const card = h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).find((a) => a.title.startsWith('Review and merge'));
  check('"Review and merge" is filed', card !== undefined, h.repo.approvals.list({ missionId: m.id }).map((a) => a.title));
  check('it links the pull request the step opened', card?.evidence.some((e) => e.kind === 'link' && e.value === pr.url), card?.evidence);
  check('no second pull request was opened', creates().length === 0, creates().map((c) => c.args));
  const inbox = h.services.projections.inbox(ws);
  check('the Inbox has it', inbox.approvals.some((v) => v.approval.id === card?.id), inbox.approvals.map((v) => v.approval.title));
  check('Home counts it in Needs you', h.services.desk.metrics(ws).needsYou >= 1, h.services.desk.metrics(ws));
  const view = h.services.factory.ship(m.id);
  check('the mission shows the pull request', view.prs.some((p) => p.number === pr.number && p.url === pr.url), view);
});

await attempt('merged on GitHub during the wait', async () => {
  section('a person merges the pull request on GitHub while the wait runs');
  const pr = openPr('feat/merged', running);
  const { m, task } = await legacyMission('fix: merged by a person', 'gh pr checks feat/merged --required');
  await h.until(() => task('ci')?.status === 'AWAITING_EXTERNAL' && /Waiting for CI on #/.test(task('ci').statusReason ?? ''), 60000);
  check('while CI runs, the wait says so', /Waiting for CI on #\d+ \(1 of 2 checks done\)/.test(task('ci').statusReason ?? ''), [task('ci').status, task('ci').statusReason]);
  check('the mission shows the pull request while it waits', h.services.factory.ship(m.id).prs.some((p) => p.number === pr.number));
  patchPr(pr.number, { state: 'MERGED', mergedBy: { login: 'ana' }, mergeCommit: { oid: 'a'.repeat(40) } });
  await h.until(() => h.repo.missions.get(m.id).status === 'COMPLETE', 30000);
  check('the wait finishes', task('ci').status === 'SUCCEEDED' && /Merged in GitHub by ana/.test(task('ci').statusReason ?? ''), [task('ci').status, task('ci').statusReason]);
  check('the ship step is done as merged by them', task('ship').status === 'SUCCEEDED' && (task('ship').statusReason ?? '').startsWith('Merged in GitHub by ana'), [task('ship').status, task('ship').statusReason]);
  check('the mission is complete', h.repo.missions.get(m.id).status === 'COMPLETE', [h.repo.missions.get(m.id).status, h.repo.missions.get(m.id).statusReason]);
  const kinds = h.repo.outcomes.listByWorkspace(ws, '2000-01-01T00:00:00.000Z').filter((o) => o.mission === m.id).map((o) => o.kind);
  check('the outcome is merged_by_person', kinds.includes('merged_by_person') && !kinds.includes('cancelled'), kinds);
  const decision = h.repo.mergeDecisions.listByMission(m.id).at(-1);
  check('a merge is on record, by them, with its merge commit', decision?.mergedBy === 'ana' && decision?.mergeSha === 'a'.repeat(40), decision);
  check('nothing waits in the Inbox for it', h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).length === 0);
  check('it isn\'t stalled', stalledRow(m.id) === undefined, stalledRow(m.id));
});

await attempt('closed without merging', async () => {
  section('the pull request is closed without merging');
  const pr = openPr('feat/closed', running);
  const { m, task } = await legacyMission('fix: closed unmerged', 'gh pr checks feat/closed --required');
  await h.until(() => task('ci')?.status === 'AWAITING_EXTERNAL' && /Waiting for CI on #/.test(task('ci').statusReason ?? ''), 60000);
  patchPr(pr.number, { state: 'CLOSED' });
  await h.until(() => task('ci')?.status === 'BLOCKED', 30000);
  check('the wait blocks', task('ci').status === 'BLOCKED', [task('ci').status, task('ci').statusReason]);
  check('and says the pull request was closed without merging', (task('ci').statusReason ?? '').includes(`Pull request #${pr.number} was closed without merging`), task('ci').statusReason);
  const row = stalledRow(m.id);
  check('a card in the Inbox says so', row !== undefined && row.reason.includes('closed without merging'), row);
  check('it offers to retry the wait', row?.action.kind === 'retry' && row.action.taskKey === 'ci', row?.action);
  check('it links the pull request and can cancel the mission', row?.pullRequestUrl === pr.url && row?.cancellable === true, row);
  check('ship never ran', task('ship').status === 'PENDING', task('ship').status);
});

await attempt('a long wait is stalled', async () => {
  section('a wait that goes on past its threshold');
  const pr = openPr('feat/slow', running);
  const { m, task } = await legacyMission('fix: slow ci', 'gh pr checks feat/slow --required');
  await h.until(() => task('ci')?.status === 'AWAITING_EXTERNAL' && /Waiting for CI on #/.test(task('ci').statusReason ?? ''), 60000);
  check('a wait that has just started is not stalled', stalledRow(m.id) === undefined, stalledRow(m.id));
  h.repo.tasks.update(task('ci').id, { startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  const row = stalledRow(m.id);
  check('two hours on, it is Stalled', row !== undefined, h.services.liveness.stalled(ws));
  check('the row says what it waits for', row?.reason.startsWith("'ci' is still waiting: Waiting for CI on #"), row?.reason);
  check('with retry, the pull request and cancel', row?.action.kind === 'retry' && row?.pullRequestUrl === pr.url && row?.cancellable === true, row);
  check('Home counts it as Stalled', h.services.desk.metrics(ws).stalled >= 1, h.services.desk.metrics(ws));
  await h.services.missions.retryTask(caller, task('ci').id, {});
  await h.until(() => task('ci')?.status === 'AWAITING_EXTERNAL' && Date.now() - Date.parse(task('ci').startedAt) < 60_000, 10000);
  check('retry starts the wait over', task('ci').status === 'AWAITING_EXTERNAL' && stalledRow(m.id) === undefined, [task('ci').status, task('ci').startedAt, stalledRow(m.id)]);
  fake.setChecks(ghDir, REPO, pr.sha, green);
  await h.until(() => task('ci')?.status === 'SUCCEEDED', 30000);
  check('and passes once CI is green', task('ci').status === 'SUCCEEDED', [task('ci').status, task('ci').statusReason]);
});

await attempt('no checks reported', async () => {
  section('a repository with no checks at all');
  const pr = openPr('feat/nochecks', null);
  const { task } = await legacyMission('fix: no checks', 'gh pr checks feat/nochecks');
  await h.until(() => task('ci')?.status === 'SUCCEEDED', 60000);
  check('the wait passes', task('ci').status === 'SUCCEEDED', [task('ci').status, task('ci').statusReason]);
  check('and says there was nothing to wait for', task('ci').statusReason === `No checks reported on #${pr.number}, so there is nothing to wait for.`, task('ci').statusReason);
});

await attempt('ci failed on the pull request', async () => {
  section('CI fails on the pull request');
  const pr = openPr('feat/red', red);
  const { task } = await legacyMission('fix: red ci', 'gh pr checks feat/red');
  await h.until(() => (task('implement')?.round ?? 1) >= 2, 60000);
  check('the code step goes again, with the failing check', (task('implement').round ?? 1) === 2, [task('implement').round, task('implement').statusReason]);
  await h.until(() => task('ci')?.status === 'AWAITING_EXTERNAL' && /waiting for a new commit/.test(task('ci').statusReason ?? ''), 60000);
  check('the same red commit isn\'t sent back twice', /CI failed on test; waiting for a new commit on #\d+/.test(task('ci').statusReason ?? '') && (task('implement').round ?? 1) === 2, [task('ci').status, task('ci').statusReason, task('implement').round]);
  const sha = 'c'.repeat(40);
  fake.setChecks(ghDir, REPO, sha, green);
  patchPr(pr.number, { headRefOid: sha });
  await h.until(() => task('ci')?.status === 'SUCCEEDED', 30000);
  check('a new green commit ends the wait', task('ci').status === 'SUCCEEDED', [task('ci').status, task('ci').statusReason]);
});

await attempt('waits that are not about a pull request', async () => {
  section('a wait that is not about a pull request keeps its command');
  const ok = await legacyMission('chore: wait on a command', 'git rev-parse --is-inside-work-tree');
  await h.until(() => ok.task('ci')?.status === 'SUCCEEDED', 60000);
  check('a command with arguments runs, and exit 0 ends the wait', ok.task('ci').status === 'SUCCEEDED', [ok.task('ci').status, ok.task('ci').statusReason]);
  const broken = await legacyMission('chore: a wait that cannot run', 'no-such-tandemise-command --flag');
  await h.until(() => (broken.task('ci')?.statusReason ?? '').startsWith("The wait can't run its command"), 60000);
  check('a command that can\'t run says so', (broken.task('ci').statusReason ?? '').startsWith("The wait can't run its command: `no-such-tandemise-command --flag` exited 127"), broken.task('ci').statusReason);
  const row = stalledRow(broken.m.id);
  check('and is Stalled at once, with retry', row?.action.kind === 'retry' && row.action.taskKey === 'ci', h.services.liveness.stalled(ws));
});

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
