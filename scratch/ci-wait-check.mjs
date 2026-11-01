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

await attempt('a check run again on the same commit', async () => {
  section('a check run again on the same commit: only its latest run counts (#197)');
  const { realExecutor } = await import('./planner-harness.mjs');
  const GH = await import('@tandemise/integration-github');
  const flow = new GH.GhPullRequestFlow(realExecutor(join(ghDir, 'bin')));
  const at = (min) => `2026-01-01T00:${String(min).padStart(2, '0')}:00Z`;
  const fixed = [
    { id: 11, name: 'PR title', conclusion: 'failure', startedAt: at(1), logTail: 'title is not a conventional commit' },
    { id: 12, name: 'build', conclusion: 'success', startedAt: at(1) },
    { id: 13, name: 'PR title', conclusion: 'success', startedAt: at(5) },
  ];
  const broke = [
    { id: 21, name: 'PR title', conclusion: 'success', startedAt: at(1) },
    { id: 22, name: 'build', conclusion: 'success', startedAt: at(1) },
    { id: 23, name: 'PR title', conclusion: 'failure', startedAt: at(5), logTail: 'title is not a conventional commit' },
  ];
  fake.setChecks(ghDir, REPO, 'd'.repeat(40), fixed);
  fake.setChecks(ghDir, REPO, 'e'.repeat(40), broke);
  const a = await flow.checks(checkout, REPO, 'd'.repeat(40));
  check('failed, then passed on the same commit: PASS, two checks', a.state === 'PASS' && a.total === 2 && a.failing.length === 0, a);
  const b = await flow.checks(checkout, REPO, 'e'.repeat(40));
  check('passed, then failed on the same commit: FAIL on that check', b.state === 'FAIL' && b.total === 2 && b.failing.map((f) => f.name).join() === 'PR title', b);

  const pr = openPr('feat/retitled', fixed);
  const { task } = await legacyMission('fix: retitled pull request', 'gh pr checks feat/retitled');
  await h.until(() => task('ci')?.status === 'SUCCEEDED' || (task('implement')?.round ?? 1) >= 2, 60000);
  check('a CI wait on a check that failed and then passed: it passes, and the code step is not sent back', task('ci').status === 'SUCCEEDED' && (task('implement').round ?? 1) === 1, [task('ci').status, task('ci').statusReason, task('implement').round]);
  void pr;
});

await attempt('the same ci failure twice', async () => {
  section('the same CI failure on the same commit does not start another round (#197)');
  const { m, task } = await legacyMission('fix: same red ci', 'true');
  await h.until(() => task('implement')?.status === 'SUCCEEDED', 60000);
  const ship = h.container.resolve(h.app.SHIP_SERVICE);
  const failing = { name: 'test', link: `https://github.com/${REPO}/actions/runs/7`, logTail: 'expected 2, got 3' };
  const prAt = (sha) => ({ repo: REPO, number: 99, url: `https://github.com/${REPO}/pull/99`, title: 'fix: same red ci', headSha: sha, headBranch: 'b', baseBranch: 'main', state: 'OPEN', isDraft: false, mergedBy: null, mergeSha: null });
  const first = await ship.ciFailed(h.repo.missions.get(m.id), task('ship'), [failing], prAt('a'.repeat(40)));
  check('a CI failure sends the code step back once', first.kind === 'reopened' && (task('implement').round ?? 1) === 2, [first, task('implement').round]);
  const again = await ship.ciFailed(h.repo.missions.get(m.id), task('ship'), [failing], prAt('a'.repeat(40)));
  check('the same check failing on the same commit: no new round', again.kind === 'blocked' && (task('implement').round ?? 1) === 2, [again, task('implement').round]);
  const cards = h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).filter((x) => x.title.endsWith('CI fails the same way again'));
  check('…a card says so, with Retry and Leave blocked', cards.length === 1 && cards[0].options.map((o) => o.label).join() === 'Retry,Leave blocked', h.repo.approvals.list({ missionId: m.id }).map((x) => x.title));
  // The round runs; then CI fails again, on the commit it pushed.
  await h.until(() => task('implement')?.status === 'SUCCEEDED', 60000);
  const moved = await ship.ciFailed(h.repo.missions.get(m.id), task('ship'), [failing], prAt('b'.repeat(40)));
  check('a failure on a new commit starts a round as before', moved.kind === 'reopened' && (task('implement').round ?? 1) === 3, [moved, task('implement').round]);
});

const TITLE_RULE = { name: 'PR title', pattern: '^(feat|fix|docs|chore|refactor|perf|test|build|ci|revert)(\\([^)]+\\))?!?: [a-z]' };
const cards = (missionId) => h.repo.approvals.list({ missionId, statuses: ['PENDING'] });
const notes = (missionId) => h.repo.events.listByMission(missionId).filter((e) => e.body.type === 'note').map((e) => e.body.text);

await attempt('a failing title check is fixed in ship', async () => {
  section('a failing pull-request title check is fixed in ship, and never starts a round (#194)');
  fake.setRepo(ghDir, REPO, { titleCheck: TITLE_RULE });
  try {
    const pr = openPr('feat/badtitle', green);
    const { m, task } = await legacyMission('fix: retitle the pull request', 'gh pr checks feat/badtitle');
    await h.until(() => task('ci')?.status === 'SUCCEEDED' || task('ci')?.status === 'BLOCKED' || (task('implement')?.round ?? 1) >= 2, 60000);
    const now = fake.pullRequests(ghDir, REPO).find((p) => p.number === pr.number);
    check('the code step is not sent back for a title', (task('implement').round ?? 1) === 1, [task('implement').round, task('implement').statusReason]);
    check('the pull request is retitled as a Conventional Commit', new RegExp(TITLE_RULE.pattern).test(now.title) && now.title.startsWith('fix: '), now.title);
    check('…through gh pr edit --title', fake.calls(ghDir).some((c) => c.args[1] === 'edit' && c.args.includes('--title')), fake.calls(ghDir).filter((c) => c.args[1] === 'edit').map((c) => c.args));
    check('the feed says why', notes(m.id).some((t) => t.includes('PR title') && t.includes(now.title)), notes(m.id));
    check('the title check passes again, so the wait ends', task('ci').status === 'SUCCEEDED', [task('ci').status, task('ci').statusReason]);
    check('no card was needed', cards(m.id).filter((a) => a.taskId === task('ci').id).length === 0, cards(m.id).map((a) => a.title));
  } finally {
    fake.setRepo(ghDir, REPO, { titleCheck: undefined });
  }
});

await attempt('a pull-request check Tandemise cannot fix', async () => {
  section('a pull-request check Tandemise cannot fix puts a card up, and never starts a round (#194)');
  openPr('feat/labels', [{ name: 'build', conclusion: 'success' }, { name: 'Require labels', conclusion: 'failure', logTail: 'Missing a label: needs one of bug, enhancement' }]);
  const { m, task } = await legacyMission('fix: a pull request without labels', 'gh pr checks feat/labels');
  await h.until(() => task('ci')?.status === 'BLOCKED' || (task('implement')?.round ?? 1) >= 2, 60000);
  check('the code step is not sent back', (task('implement').round ?? 1) === 1, [task('implement').round, task('implement').statusReason]);
  check('the wait stops, naming the check', task('ci').status === 'BLOCKED' && (task('ci').statusReason ?? '').includes('Require labels'), [task('ci').status, task('ci').statusReason]);
  const card = cards(m.id).find((a) => a.taskId === task('ci').id);
  check('a card names the check and quotes its log', card !== undefined && card.title.includes('Require labels') && card.evidence.some((e) => e.value.includes('Missing a label')), card && [card.title, card.evidence]);
  check('…with Retry and Leave blocked', card?.options.map((o) => o.label).join() === 'Retry,Leave blocked', card?.options);
});

await attempt('an unknown check', async () => {
  section('a check Tandemise cannot tell is about code asks a person, and planner.yaml can say (#194)');
  openPr('feat/unknown', [{ name: 'build', conclusion: 'success' }, { name: 'deploy-preview', conclusion: 'failure', logTail: 'quota reached for this account' }]);
  const { m, task } = await legacyMission('fix: an unknown check', 'gh pr checks feat/unknown');
  await h.until(() => task('ci')?.status === 'BLOCKED' || (task('implement')?.round ?? 1) >= 2, 60000);
  check('the code step is not sent back', (task('implement').round ?? 1) === 1, [task('implement').round]);
  const card = cards(m.id).find((a) => a.taskId === task('ci').id);
  check('a card asks, with the check\'s name and log tail', card !== undefined && card.title.includes('deploy-preview') && card.evidence.some((e) => e.value.includes('quota reached')), card && [card.title, card.evidence]);
  check('…and says how planner.yaml can classify it', (card?.effect ?? '').includes('ci.checks'), card?.effect);

  w.files.files.planner = { ...h.app.SHIPPED_PLANNER, ci: { checks: { 'deploy-*': 'code' } } };
  try {
    openPr('feat/unknown2', [{ name: 'deploy-preview', conclusion: 'failure', logTail: 'quota reached for this account' }]);
    const second = await legacyMission('fix: a check planner.yaml calls code', 'gh pr checks feat/unknown2');
    await h.until(() => (second.task('implement')?.round ?? 1) >= 2 || second.task('ci')?.status === 'BLOCKED', 60000);
    check('with `ci.checks: { "deploy-*": code }` it is code: the code step goes again', (second.task('implement').round ?? 1) === 2, [second.task('implement').round, second.task('ci').statusReason]);
  } finally {
    delete w.files.files.planner;
  }
});

await attempt('waiting for checks to start', async () => {
  section('before any check registers, the step says it waits for checks to start (#194)');
  const pr = openPr('feat/notyet', []);
  fake.setRepo(ghDir, REPO, { suites: { [pr.sha]: [{ status: 'queued', latest_check_runs_count: 0, app: { slug: 'github-actions' } }] } });
  const { task } = await legacyMission('fix: checks not started', 'gh pr checks feat/notyet');
  await h.until(() => task('ci')?.status === 'AWAITING_EXTERNAL' && /#\d+/.test(task('ci').statusReason ?? ''), 60000);
  check('the CI wait says "Waiting for checks to start", not "0 of 0"', task('ci').statusReason === `Waiting for checks to start on #${pr.number}.`, task('ci').statusReason);
  fake.setRepo(ghDir, REPO, { suites: {} });
  const slow = await world({ ciGraceMs: 120_000 });
  const m2 = await slow.mission('fix: typo in the settings title');
  const ship2 = () => slow.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship');
  await slow.h.until(() => ship2()?.status === 'AWAITING_EXTERNAL', 60000);
  check('the ship step says "Waiting for checks to start"', ship2().statusReason === 'Waiting for checks to start', ship2().statusReason);
});

/**
 * A mission whose ship step waits on running CI, paused there: the check then fails, the ship step (which keeps
 * reading CI) starts a round on the code step, and nothing runs it while the mission is paused.
 */
const pausedInCiRound = async (title, beforeFailing = () => {}, setup = () => {}) => {
  const base = await world();
  setup(base);
  const running = [{ name: 'unit', status: 'in_progress', conclusion: null }];
  const fail = { name: 'unit', conclusion: 'failure', logTail: 'flaky: timed out after 5000 ms', startedAt: '2026-01-01T00:01:00Z' };
  fake.setRepo(base.ghDir, REPO, { defaultChecks: running });
  const m = await base.mission(title);
  const task = (k) => base.h.repo.tasks.listByMission(m.id).find((t) => t.key === k);
  await base.h.until(() => task('ship')?.status === 'AWAITING_EXTERNAL' && fake.pullRequests(base.ghDir, REPO).length > 0, 60000);
  const head = fake.pullRequests(base.ghDir, REPO).at(-1).headRefOid;
  await base.h.services.missions.pause(m.id);
  beforeFailing(base);
  fake.setChecks(base.ghDir, REPO, head, [fail]);
  await base.h.until(() => (task('implement')?.round ?? 1) >= 2, 30000);
  const runs = () => base.h.repo.runs.listByMission(m.id).filter((r) => r.taskId === task('implement').id).length;
  /** The check is run again on GitHub and passes, on the same commit. */
  const passAgain = () => fake.setChecks(base.ghDir, REPO, head, [fail, { name: 'unit', conclusion: 'success', startedAt: '2026-01-01T00:05:00Z' }]);
  return { base, m, task, head, runs, passAgain };
};

await attempt('a ci round whose cause cleared while paused', async () => {
  section('a CI round paused, its check passing during the pause, and the resume going straight to ship (#200)');
  const { base, m, task, head, runs, passAgain } = await pausedInCiRound('fix: a flaky unit test');
  const before = runs();
  check('paused in round 2 of the code step, before it ran', (task('implement').round ?? 1) === 2 && task('implement').status === 'READY' && before === 1, [task('implement').round, task('implement').status, before]);
  passAgain();
  await base.h.services.missions.resume(m.id);
  await base.h.until(() => task('ship')?.status === 'AWAITING_APPROVAL' || task('implement')?.status === 'RUNNING' || runs() > before, 60000);
  check('the round is dropped: the code step does not run again', runs() === before && task('implement').status === 'SUCCEEDED', [runs(), before, task('implement').status, task('implement').statusReason]);
  check('…and says why', (task('implement').statusReason ?? '').startsWith(`Round 2 dropped: unit passes now on commit ${head.slice(0, 7)}`), task('implement').statusReason);
  check('the feed says so', base.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'note' && e.body.text.includes("so round 2 of 'implement' is dropped and the mission goes on to ship")), base.h.repo.events.listByMission(m.id).filter((e) => e.body.type === 'note').map((e) => e.body.text));
  check('the mission goes straight to ship: Review and merge, on the same commit', task('ship').status === 'AWAITING_APPROVAL' && base.h.repo.mergeDecisions.listByMission(m.id).at(-1)?.headSha === head, [task('ship').status, task('ship').statusReason]);
  check('no second pull request', fake.calls(base.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'create').length === 1);
});

await attempt('a plan-fit card whose cause cleared', async () => {
  section('a plan-fit card in a CI round offers "Re-check and continue to ship", and recommends it once CI passes (#200)');
  const changeSet = (extra) => ['---', 'type: ChangeSet', 'title: Change', 'handoff:', '  headline: Fixed the title', ...extra, 'branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []', '---', '', 'Done.'].join('\n');
  // Round 1 fixes the code. The CI round's pass changes nothing and says the plan no longer fits: only a person
  // can re-run the check. It answers the round's note, as a round must.
  const steps = [
    { kind: 'write-file', path: 'src/settings.ts', content: "export const title = 'Settings';\n" },
    { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet([]) },
    { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', when: { promptIncludes: 'CI failed: unit' }, content: changeSet([
      '  stop: A person must re-run the unit check on GitHub; the code is fine.',
      '  changed:', '    - what: Nothing to change in the code; the check is flaky', '      feedback: {{fb}}',
    ]) },
    { kind: 'complete', summary: 'done' },
  ];
  const { base, m, task, passAgain } = await pausedInCiRound('fix: a test only a person can re-run', undefined, (b) => {
    const dev = b.h.repo.profiles.list().find((p) => p.name === 'dev');
    b.h.repo.profiles.update(dev.id, { settings: { script: { steps, captures: { fb: '(fb_[0-9a-z]{20})' } } } });
  });
  await base.h.services.missions.resume(m.id);
  const card = () => base.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).find((a) => a.options.some((o) => o.id === 'skip_rest'));
  await base.h.until(() => card() !== undefined, 60000);
  check('the card offers "Re-check and continue to ship"', card()?.options.some((o) => o.id === 'recheck_ship' && o.label === 'Re-check and continue to ship'), card()?.options);
  let refused = null;
  try { await base.h.services.approvals.decide(base.caller, card().id, { optionId: 'recheck_ship' }); } catch (e) { refused = e.message; }
  check('while CI still fails, Re-check says so and the card stays open', /unit still fails on commit/.test(refused ?? '') && card() !== undefined, [refused, card()?.status]);
  passAgain();
  await base.h.until(() => card()?.recommendedOptionId === 'recheck_ship', 30000);
  check('once CI passes, the card recommends Re-check, not skipping ship', card()?.recommendedOptionId === 'recheck_ship' && card().options.find((o) => o.id === 'skip_rest')?.recommended !== true, card() && [card().recommendedOptionId, card().options]);
  await base.h.services.approvals.decide(base.caller, card().id, { optionId: 'recheck_ship' });
  await base.h.until(() => task('ship')?.status === 'AWAITING_APPROVAL', 60000);
  check('Re-check drops the round and the mission goes to Review and merge', task('ship').status === 'AWAITING_APPROVAL' && (task('implement').statusReason ?? '').startsWith('Round 2 dropped'), [task('ship').status, task('implement').statusReason]);
});

await attempt('never recommend skipping ship while the pull request is green', async () => {
  section('a plan-fit card never recommends skipping ship while the pull request is open and green (#200)');
  const { recommendedFor } = h.app;
  const options = [{ id: 'skip_rest' }, { id: 'request_changes' }, { id: 'replan_rest' }, { id: 'continue_plan' }];
  check('green and open: Continue as planned', recommendedFor({ options }, { green: true, cleared: false }) === 'continue_plan');
  check('red: Skip the steps after it, as before', recommendedFor({ options }, { green: false, cleared: false }) === 'skip_rest');
  check('in a CI round whose cause cleared: Re-check and continue to ship', recommendedFor({ options: [{ id: 'recheck_ship' }, ...options] }, { green: true, cleared: true }) === 'recheck_ship');
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
