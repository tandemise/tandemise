// The planner and risk-based merge, the ship step and the merge decision
// (docs/superpowers/specs/2026-10-30-planner-and-merge-design.md §8): a real
// git repository with a bare `origin`, the fake `gh` (scratch/fake-gh.mjs)
// first on PATH recording every call. No real GitHub is ever touched.
//
//   npm run build && node scratch/merge-check.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const GH = await import('@tandemise/integration-github');
const fake = await import('./fake-gh.mjs');
const { engineHarness, memoryFactory } = await import('./planner-harness.mjs');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// MERGE_ONLY=<text> runs only the sections whose label holds it.
const attempt = async (label, fn) => {
  if (process.env.MERGE_ONLY !== undefined && !label.includes(process.env.MERGE_ONLY)) return;
  try { await fn(); } catch (e) { failures.push(label); console.log(`  FAIL ${label} threw: ${e?.stack ?? e}`); }
};
const keepAlive = setInterval(() => {}, 1000);

const { realExecutor, world, git, REPO } = await import('./planner-harness.mjs');


await attempt('ship opens', async () => {
  section('ship opens');
  const prTitles = [
    ['fix', 'fix: typo in the settings title', 'fix: typo in the settings title'],
    ['fix', 'Typo in settings title', 'fix: typo in settings title'],
    ['feature', 'feat: add export', 'feat: add export'],
    ['deps', 'Bump lodash', 'build: bump lodash'],
  ];
  for (const [type, title, want] of prTitles) check(`pr title for ${type} "${title}"`, D.prTitle({ type }, title) === want, D.prTitle({ type }, title));

  // #113: a real body. What changed first, the issue it closes, an honest status per Done-when line, holds.
  const body = D.prBody({
    summary: { headline: 'One file changed: docs/QUICKSTART.md step 2', points: ['Says to press **Discover runtimes**', 'Names the Linux path'] },
    issue: { label: 'GitHub', key: '#97', url: 'https://github.com/acme/app/issues/97', closes: 'Closes #97' },
    criteria: [{ key: 'C1', statement: 'Step 2 names `Discover runtimes`', verified: 'Claimed by the agent, not independently verified' }],
    holds: ['Ana held Implement for 4 min and handed it back; 1 file changed (+2 -0).'],
    why: ['Docs · tiny · low risk; quick lane.'],
    missionId: 'msn_x',
  });
  check('the body leads with the summary', body.startsWith('## Summary\n\nOne file changed: docs/QUICKSTART.md step 2\n\n- Says to press **Discover runtimes**\n- Names the Linux path'), body);
  check('it closes the issue, by GitHub\'s own keyword', body.includes('\n\nCloses #97\n') && body.includes('[GitHub #97](https://github.com/acme/app/issues/97)'), body);
  check('a line nobody verified says so', body.includes('| C1 | Step 2 names `Discover runtimes` | Claimed by the agent, not independently verified |'), body);
  check('holds are listed', body.includes('## Held by a person\n\n- Ana held Implement'), body);
  const bare = D.prBody({ summary: null, issue: null, criteria: [], holds: [], why: [], missionId: 'msn_y' });
  check('with nothing known, it says so plainly and claims nothing', !bare.includes('Closes') && !bare.includes('QA') && bare.includes('No Done-when lines were given.'), bare);
  check('the closing keyword: same repository is #n', D.closingLine('https://github.com/acme/app/issues/97', 'acme/app') === 'Closes #97');
  check('another repository is owner/repo#n', D.closingLine('https://github.com/acme/tracker/issues/5', 'acme/app') === 'Closes acme/tracker#5');
  check('a YouTrack item closes nothing on GitHub', D.closingLine('https://acme.youtrack.cloud/issue/APP-3', 'acme/app') === null);

  const w = await world();
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ['SUCCEEDED', 'BLOCKED', 'FAILED', 'SKIPPED', 'AWAITING_APPROVAL'].includes(ship()?.status), 60000);
  const creates = fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  const implement = w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'implement');
  check('implement succeeded', implement.status === 'SUCCEEDED', [implement.status, implement.statusReason]);
  check('one pr create, titled from the profile, not a draft', creates.length === 1 && creates[0].args.includes('fix: typo in the settings title') && !creates[0].args.includes('--draft'), creates.map((c) => c.args));
  const head = creates[0]?.args[creates[0].args.indexOf('--head') + 1];
  check('the head is the task branch, pushed to origin', typeof head === 'string' && git(w.origin, 'branch', '--list', head).includes(head), [head, git(w.origin, 'branch', '--list')]);
  check('with no CI on the repository, the ship step asks', ship().status === 'AWAITING_APPROVAL', [ship().status, ship().statusReason]);
  check('the ship task kept its executor', ship().executor === 'ship');
  const pr = fake.pullRequests(w.ghDir, REPO)[0];
  check('the body carries no agent claim beyond its handoff', pr !== undefined && !pr.body.includes('ZZ-AGENT-SAYS') && pr.body.includes('Done when'), pr?.body);
  // #113: the change set's headline leads the body; nothing claims a QA report that does not exist.
  const headline = w.h.repo.artifacts.listByMission(m.id).find((a) => a.type === 'ChangeSet')?.handoff?.headline;
  check('the body opens with what changed (the change set\'s headline)', typeof headline === 'string' && pr?.body.startsWith(`## Summary\n\n${headline}`), [headline, pr?.body.slice(0, 200)]);
  check('no "See the QA report" when there is none', !pr?.body.includes('See the QA report'), pr?.body);
  check('pr.opened is recorded', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'ship.pr_opened' && e.body.number === pr.number));
  // Ship again: the pull request is found by its head, not opened twice.
  const flow = new GH.GhPullRequestFlow(realExecutor(join(w.ghDir, 'bin')));
  const again = await flow.open({ cwd: w.checkout, repo: REPO, head, base: 'main', title: 'x', body: 'y' });
  check('opening again finds the same pull request', again.created === false && again.number === pr.number && fake.calls(w.ghDir).filter((c) => c.args[1] === 'create').length === 1);
});

await attempt('decision table, hard rules, no self-report', async () => {
  section('decision table');
  const policy = D.parseMergePolicy(app.SHIPPED_MERGE);
  check('the shipped policy parses', !('error' in policy), policy);
  const on = { ...policy, autoMerge: 'on' };
  const base = {
    changedPaths: ['apps/web/src/pages/settings.tsx'], deletedPaths: [], files: 1, linesAdded: 10, linesRemoved: 2, binaryFiles: 0, repos: 1,
    areas: [], testsTouched: 1, dependenciesChanged: false, lockfileOnly: false, coverageChangedLines: null,
    ci: { state: 'PASS', requiredPresent: true }, reviewRequired: false, checksTests: 'PASS',
    review: { blocking: 0, major: 0, independent: true }, criteria: { unverified: 0, implicit: true },
    process: { lane: 'quick', lightenedByPerson: false, stepsSkipped: 0, holds: 0, changesRequested: 0, escalations: 0, gateRetries: 0, personCommits: 0, revertOfAuto: false },
    history: { areaReverts90d: null, areaRecentRevert: null },
  };
  const v = (patch) => ({ ...base, ...patch, ci: { ...base.ci, ...(patch.ci ?? {}) }, review: { ...base.review, ...(patch.review ?? {}) }, process: { ...base.process, ...(patch.process ?? {}) }, history: { ...base.history, ...(patch.history ?? {}) } });
  const baseDecision = D.decideMerge(base, on);
  check('the base set merges at score 0', baseDecision.verdict === 'merge' && baseDecision.score === 0, baseDecision);
  const rows = [
    ['a migration', v({ changedPaths: ['db/migrations/0042_add_index.sql'] }), 'ask', 'Touches db/migrations/0042_add_index.sql — never merged on its own in this project.'],
    ['a workflow file', v({ changedPaths: ['.github/workflows/ci.yml'] }), 'ask', null],
    ['an env file', v({ changedPaths: ['.env.local'] }), 'ask', null],
    ['the auth area', v({ areas: [{ name: 'auth', sensitivity: 'critical', paths: ['src/auth/session.ts'] }], changedPaths: ['src/auth/session.ts'] }), 'ask', 'Touches src/auth/session.ts — never merged on its own in this project.'],
    ['a deletion in a sensitive area', v({ deletedPaths: ['package.json'], areas: [{ name: 'dependencies', sensitivity: 'sensitive', paths: ['package.json'] }] }), 'ask', null],
    ['the careful lane', v({ process: { lane: 'careful' } }), 'ask', null],
    ['a person committed', v({ process: { personCommits: 1 } }), 'ask', null],
    ['CI failed', v({ ci: { state: 'FAIL' } }), 'ask', 'CI is not green on this commit.'],
    ['tests failed', v({ checksTests: 'FAIL' }), 'ask', null],
    ['blocking findings', v({ review: { blocking: 2 } }), 'ask', null],
    ['450 lines', v({ linesAdded: 400, linesRemoved: 50 }), 'ask', 'Risk score 4 of 2 allowed: over 400 lines changed, over 100 lines changed.'],
    ['120 lines', v({ linesAdded: 100, linesRemoved: 20 }), 'merge', null],
    ['16 files', v({ files: 16 }), 'merge', null],
    ['two repositories', v({ repos: 2 }), 'merge', null],
    ['a recent revert in the area', v({ history: { areaRecentRevert: true } }), 'ask', null],
  ];
  for (const [label, facts, verdict, reason] of rows) {
    const d = D.decideMerge(facts, on);
    check(`${label} → ${verdict}`, d.verdict === verdict && (reason === null || d.reasons.includes(reason)), { verdict: d.verdict, score: d.score, reasons: d.reasons });
  }
  const scores = { '120 lines': 1, '16 files': 2, 'two repositories': 2, 'a recent revert in the area': 3 };
  for (const [label, score] of Object.entries(scores)) {
    const facts = rows.find((r) => r[0] === label)[1];
    check(`${label} scores ${score}`, D.decideMerge(facts, on).score === score, D.decideMerge(facts, on).score);
  }
  const coverage = baseDecision.factors.find((f) => f.rule.startsWith('coverage.changed_lines'));
  check('unmeasured coverage adds nothing and is listed', coverage?.points === 0 && coverage.unmeasured.includes('coverage.changed_lines'), coverage);

  section('hard rules');
  const off = D.decideMerge(base, policy);
  check('auto-merge off always asks, and says what would have happened', off.verdict === 'ask' && off.reasons[0] === D.AUTO_MERGE_OFF && off.wouldMerge === true, off);
  const noCi = D.decideMerge(v({ ci: { state: 'NONE' } }), { ...on, requires: [] });
  check('no CI asks even when the policy omits the CI rule', noCi.verdict === 'ask' && noCi.reasons.includes(D.NO_CI), noCi.reasons);
  check('a required review asks', D.decideMerge(v({ reviewRequired: true }), on).reasons.includes(D.REVIEW_REQUIRED));
  check('a malformed policy asks', D.decideMerge(base, { error: 'bad indent' }).reasons[0] === D.malformedPolicy('bad indent'));
  check('an unmeasured review requirement asks', D.decideMerge(v({ reviewRequired: null }), on).verdict === 'ask');
  check('a policy with a rule that does not lint is an error, never partial', 'error' in D.parseMergePolicy({ ...app.SHIPPED_MERGE, requires: ['item.prefix == "x"'] }));

  section('no self-report');
  const keys = Object.keys(D.MERGE_FACT_ORIGINS).sort();
  check('every fact has a measured origin', keys.every((k) => ['git', 'github', 'daemon', 'ledger'].includes(D.MERGE_FACT_ORIGINS[k])) && eq(keys, Object.keys(base).sort()), keys);
});

await attempt('ship decides, audit, person merge, closed, crash', async () => {
  section('ship decides');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, reviewers: ['sam'] } } });
  const pending = [{ name: 'unit', status: 'in_progress' }, { name: 'lint', status: 'queued' }];
  const prOf = () => fake.pullRequests(w.ghDir, REPO).at(-1);
  // CI is pending on every head this world pushes until the check says otherwise.
  const watch = setInterval(() => { const pr = prOf(); if (pr !== undefined && !(fake.readState(w.ghDir).repos[REPO].checks ?? {})[pr.headRefOid]) fake.setChecks(w.ghDir, REPO, pr.headRefOid, pending); }, 20);
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship()?.status === 'AWAITING_EXTERNAL' && ship().statusReason.startsWith('Waiting for CI'), 60000);
  check('after the PR opens it waits for CI', ship().statusReason === 'Waiting for CI (0 of 2 checks done)', ship().statusReason);
  const sha1 = prOf().headRefOid;
  fake.setChecks(w.ghDir, REPO, sha1, [{ name: 'unit', conclusion: 'success' }, { name: 'lint', conclusion: 'success' }]);
  await w.h.until(() => ship().status === 'AWAITING_APPROVAL', 30000);
  const rows = w.h.repo.mergeDecisions.listByMission(m.id);
  check('green CI → one decision, ask, auto-merge off, would have merged', rows.length === 1 && rows[0].verdict === 'ask' && rows[0].reasons.includes(D.AUTO_MERGE_OFF) && rows[0].wouldMerge === true, rows.map((r) => [r.verdict, r.reasons, r.score]));
  const cards = w.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] });
  check('one Review and merge card', cards.length === 1 && cards[0].kind === 'release' && cards[0].title === `Review and merge #${prOf().number}: fix: typo in the settings title`, cards.map((c) => c.title));
  check('the reviewers in the policy were asked', fake.calls(w.ghDir).some((c) => c.args[1] === 'edit' && c.args.includes('--add-reviewer') && c.args.includes('sam')));

  section('audit');
  const facts = rows[0].facts;
  check('the row keeps every measured fact', Object.keys(D.MERGE_FACT_ORIGINS).every((k) => k in facts), Object.keys(facts));
  check('no agent text reached the facts', !JSON.stringify(facts).includes('ZZ-AGENT-SAYS'));
  const comments = () => fake.readState(w.ghDir).repos[REPO].comments[String(prOf().number)] ?? [];
  check('one PR comment that asks and names the commit', comments().length === 1 && comments()[0].body.includes('Tandemise asks for a review') && comments()[0].body.includes(sha1.slice(0, 7)), comments());
  // A new head: the decision is void and a second is made, editing the same comment.
  const sha2 = 'e'.repeat(40);
  fake.putPullRequest(w.ghDir, REPO, { ...prOf(), headRefOid: sha2 });
  fake.setChecks(w.ghDir, REPO, sha2, [{ name: 'unit', conclusion: 'success' }]);
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length === 2 && fake.calls(w.ghDir).some((c) => c.args.includes('PATCH')), 30000);
  const two = w.h.repo.mergeDecisions.listByMission(m.id);
  check('a moved head voids the decision and decides again on the new sha', two[0].voidedAt !== null && two[1].headSha === sha2, two.map((r) => [r.headSha.slice(0, 7), r.voidedAt]));
  check('the same comment is edited, not a second one', comments().length === 1 && fake.calls(w.ghDir).some((c) => c.args.includes('PATCH')));
  check('the feed says it is checking again', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'note' && e.body.text === 'The pull request changed after it was checked; checking again.'));

  section('person merge');
  fake.putPullRequest(w.ghDir, REPO, { ...prOf(), state: 'MERGED', mergedBy: { login: 'sam' }, mergeCommit: { oid: 'a'.repeat(40) } });
  await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE', 30000);
  check('a merge in GitHub finishes the step and the mission', ship().status === 'SUCCEEDED' && w.h.repo.missions.get(m.id).status === 'COMPLETE', [ship().status, ship().statusReason]);
  check('it is a merged_by_person outcome', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').some((o) => o.mission === m.id && o.kind === 'merged_by_person'));
  check('no pr merge was ever called', !fake.calls(w.ghDir).some((c) => c.args[0] === 'pr' && c.args[1] === 'merge'));

  section('closed');
  const m2 = await w.mission('fix: typo in the footer');
  const ship2 = () => w.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship2()?.status === 'AWAITING_EXTERNAL', 60000);
  fake.setChecks(w.ghDir, REPO, prOf().headRefOid, [{ name: 'unit', conclusion: 'success' }]);
  await w.h.until(() => ship2().status === 'AWAITING_APPROVAL', 30000);
  fake.putPullRequest(w.ghDir, REPO, { ...prOf(), state: 'CLOSED' });
  await w.h.until(() => ship2().status === 'BLOCKED', 30000);
  check('a closed PR blocks with the exact sentence', ship2().statusReason === 'The pull request was closed without merging.', ship2().statusReason);

  section('ci fails');
  const m3 = await w.mission('fix: typo in the header');
  const task3 = (k) => w.h.repo.tasks.listByMission(m3.id).find((t) => t.key === k);
  await w.h.until(() => task3('ship')?.status === 'AWAITING_EXTERNAL', 60000);
  fake.setChecks(w.ghDir, REPO, prOf().headRefOid, [{ name: 'unit', conclusion: 'failure', logTail: 'expected 1 to be 2' }]);
  await w.h.until(() => (task3('implement').round ?? 1) >= 2, 30000);
  const fb = w.h.container.resolve(app.FEEDBACK_REPOSITORY).listByTask(task3('implement').id);
  check('a failing check starts round 2 on implement with the log', (task3('implement').round ?? 1) === 2 && fb.some((f) => f.text.startsWith('CI failed: unit') && f.text.includes('expected 1 to be 2')), fb.map((f) => f.text));
  clearInterval(watch);

  section('crash between decide and merge');
  const w2 = await world();
  const m4 = await w2.mission('fix: typo in the sidebar');
  const ship4 = () => w2.h.repo.tasks.listByMission(m4.id).find((t) => t.key === 'ship');
  await w2.h.until(() => ship4()?.status === 'AWAITING_APPROVAL', 60000);
  const before = w2.h.repo.mergeDecisions.listByMission(m4.id).length;
  // A restart: a new engine over the same database and home adopts the waiting ship step.
  const { engineHarness } = await import('./planner-harness.mjs');
  const GH = await import('@tandemise/integration-github');
  const { realExecutor } = await import('./planner-harness.mjs');
  const exec = realExecutor(`${w2.ghDir}/bin`);
  const again = await engineHarness(w2.h.paths.root, { factory: w2.files, commandExecutor: exec, pullRequests: new GH.GhPullRequestFlow(exec) });
  // Until the restarted engine has looked at the pull request again (a deadline, not a timed sleep).
  const callsBefore = fake.calls(w2.ghDir).length;
  const deadline = Date.now() + 20000;
  while (fake.calls(w2.ghDir).length === callsBefore && Date.now() < deadline) { await again.scheduler.tick(); await again.sleep(50); }
  check('restarted, the engine looks at the waiting pull request again', fake.calls(w2.ghDir).length > callsBefore);
  await again.scheduler.tick();
  check('restarted, it decides nothing twice and merges nothing', again.repo.mergeDecisions.listByMission(m4.id).length === before && !fake.calls(w2.ghDir).some((c) => c.args[1] === 'merge'), again.repo.mergeDecisions.listByMission(m4.id).length);
  check('the ship step is still waiting for a review', again.repo.tasks.listByMission(m4.id).find((t) => t.key === 'ship').status === 'AWAITING_APPROVAL');
});

await attempt('backtest and switch', async () => {
  section('backtest');
  const policy = D.parseMergePolicy(app.SHIPPED_MERGE);
  const facts = (lines) => ({
    changedPaths: ['src/a.ts'], deletedPaths: [], files: 1, linesAdded: lines, linesRemoved: 0, binaryFiles: 0, repos: 1, areas: [], testsTouched: 1,
    dependenciesChanged: false, lockfileOnly: false, coverageChangedLines: null, ci: { state: 'PASS', requiredPresent: true }, reviewRequired: false,
    checksTests: 'PASS', review: { blocking: 0, major: 0, independent: true }, criteria: { unverified: 0, implicit: false },
    process: { lane: 'quick', lightenedByPerson: false, stepsSkipped: 0, holds: 0, changesRequested: 0, escalations: 0, gateRetries: 0, personCommits: 0, revertOfAuto: false },
    history: { areaReverts90d: 0, areaRecentRevert: false },
  });
  // Scores 0, 1, 2 (merge under the current policy), and 3, 4, 5 (asks).
  const withScore = (s) => {
    const f = facts(s === 1 || s >= 4 ? 150 : 10);
    if (s >= 2) f.process.lightenedByPerson = true;
    if (s >= 3) f.process.escalations = 2;
    // 4 adds the lines again, on top of 3
    if (s >= 5) f.criteria.unverified = 1;
    return f;
  };
  const row = (i, s) => ({ id: `mrg_${i}`, workspaceId: 'ws', missionId: `m${i}`, repo: 'acme/web', prNumber: i, headSha: 'a'.repeat(40), policyRef: 'shipped', verdict: 'ask', score: s, allowed: 2, wouldMerge: s <= 2, factors: [], reasons: [], facts: withScore(s), decidedAt: `2026-10-0${i + 1}T00:00:00.000Z`, voidedAt: null, commentId: null, mergedAt: null, mergedBy: null, mergeSha: null });
  const rows = [0, 1, 2, 3, 4, 5].map((s, i) => row(i, s));
  check('the fixture scores 0..5', eq(rows.map((r) => D.decideMerge(r.facts, { ...policy, autoMerge: 'on' }).score), [0, 1, 2, 3, 4, 5]), rows.map((r) => D.decideMerge(r.facts, { ...policy, autoMerge: 'on' }).score));
  const reverted = [{ op: 'outcome', id: 'out_r', at: '2026-10-20T00:00:00.000Z', by: 'A', mission: 'm3', lane: 'quick', profile: { type: 'fix', size: 's', risk: 'low', areas: [] }, kind: 'reverted' }];
  const result = D.backtest(rows, policy, { ...policy, autoMergeAtMost: 4 }, reverted);
  check('a looser candidate merges two more', result.mergedCurrent === 3 && result.mergedCandidate === 5 && result.changed.length === 2, result);
  check('…and says one of those was later reverted', result.changedThenReverted === 1 && result.changed.find((c) => c.decisionId === 'mrg_3')?.revertedOrBroke === true, result.changed);

  section('switch');
  const w = await world({ brain: true });
  const service = w.h.services.mergePolicy;
  const before = await service.get(w.ws);
  check('the policy starts off, built in', before.policy.autoMerge === 'off' && before.origin === 'shipped', before);
  await service.update(w.ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, w.caller);
  check('turning it on writes the repository\'s merge.yaml', w.files.written.merge?.raw.autoMerge === 'on', w.files.written.merge);
  const decisions = w.h.container.resolve(app.DECISION_REPOSITORY).listByWorkspace(w.ws);
  check('…and records a Decision', decisions.length === 1 && decisions[0].title === 'Auto-merge low-risk pull requests in Ship' && decisions[0].status === 'accepted', decisions.map((d) => d.title));
  let refused = null;
  try { await service.update(w.ws, { ...app.SHIPPED_MERGE, autoMerge: 'on' }, { ...w.caller, runtime: true }); } catch (e) { refused = e.message; }
  check('a runtime may not change it', refused === 'Only a person can change the merge policy.', refused);
  // A ship step waiting on a person: stop re-decides it as ask.
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship()?.status === 'AWAITING_APPROVAL' || ship()?.status === 'AWAITING_EXTERNAL', 60000);
  const n = w.h.repo.mergeDecisions.listByMission(m.id).length;
  await service.stop(w.ws, w.caller);
  check('stop writes autoMerge off', w.files.written.merge?.raw.autoMerge === 'off');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length > n, 30000);
  const last = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  check('…and a waiting ship step is decided again, as ask, auto-merge off', last.verdict === 'ask' && last.reasons[0] === D.AUTO_MERGE_OFF, last.reasons);
});

await attempt('reviewed commit', async () => {
  section('reviewed commit');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, autoMerge: 'on' } }, brain: true });
  await w.authorize();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE' || ship()?.status === 'BLOCKED', 60000);
  const merges = () => fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  const decision = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  const call = merges()[0]?.args ?? [];
  check('it merged the decided head, squash', decision?.verdict === 'merge' && call.includes('--squash') && call[call.indexOf('--match-head-commit') + 1] === decision.headSha, { call, decision: decision && [decision.verdict, decision.reasons] });
  check('…with the trailers', (call[call.indexOf('--body') + 1] ?? '').includes(`Tandemise-Merge: auto; score ${decision?.score}/2`) && (call[call.indexOf('--body') + 1] ?? '').includes('Tandemise-Mission:'), call);
  check('the audit row has the merge commit, the step and the mission are done', decision?.mergeSha !== null && decision?.mergedBy === 'tandemise' && ship().status === 'SUCCEEDED' && w.h.repo.missions.get(m.id).status === 'COMPLETE', [decision?.mergeSha, ship().status, ship().statusReason]);
  check('the PR comment says it merged on its own', (fake.readState(w.ghDir).repos[REPO].comments[String(fake.pullRequests(w.ghDir, REPO).at(-1).number)] ?? []).some((c) => c.body.startsWith('Tandemise merged this on its own: risk score')));
  check('a merged outcome is recorded', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').some((o) => o.mission === m.id && o.kind === 'merged'));

  // A push between the decision and the merge: GitHub refuses, the decision is void, a new one merges the new head.
  const moved = 'd'.repeat(40);
  fake.setRepo(w.ghDir, REPO, { moveHeadOnMerge: moved });
  const m2 = await w.mission('fix: typo in the footer');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m2.id).length === 2 && w.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship')?.status === 'AWAITING_APPROVAL', 60000);
  const rows = w.h.repo.mergeDecisions.listByMission(m2.id);
  check('the first decision was voided, the second is on the new sha', rows.length === 2 && rows[0].voidedAt !== null && rows[1].headSha === moved, rows.map((r) => [r.headSha.slice(0, 7), r.voidedAt, r.mergeSha]));
  // The new head is a commit Tandemise didn't push: someone else's, so it asks.
  // The fake's moved head is a commit this machine never sees, so it can't be measured: either way it asks.
  check('…and asks', rows[1].verdict === 'ask' && rows[1].reasons.some((r) => r.startsWith('A person committed') || r.startsWith('Tandemise couldn\'t measure')), rows[1].reasons);
  const m2calls = merges().slice(1);
  check('only the refused merge call was made, on the decided sha', m2calls.length === 1 && m2calls[0].args[m2calls[0].args.indexOf('--match-head-commit') + 1] === rows[0].headSha, m2calls.map((c) => c.args.join(' ')));

  fake.setRepo(w.ghDir, REPO, { autoMergeAllowed: true, protection: { required_status_checks: { strict: false, contexts: ['unit'] } } });
  const m3 = await w.mission('fix: typo in the header');
  await w.h.until(() => w.h.repo.missions.get(m3.id).status === 'COMPLETE', 60000);
  check('with auto-merge allowed on the repository, the merge is queued with --auto', merges().at(-1).args.includes('--auto'), merges().at(-1).args);
  check('every pr merge call carried --match-head-commit', merges().length >= 3 && merges().every((c) => c.args.includes('--match-head-commit')), merges().length);
});

await attempt('revert and watch', async () => {
  section('revert and watch');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, autoMerge: 'on' } }, brain: true });
  await w.authorize();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE', 60000);
  const decision = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  check('the fake merge made a real commit on main', git(w.origin, 'rev-parse', 'main') === decision.mergeSha, [decision.mergeSha]);
  // The revert of an auto-merge may merge on its own (revertAutoMerge). Auto-merge turned off in the brain would end your
  // decision (see 'off in the brain ends your decision'), so it stays on here.
  const revert = await w.h.services.shipActions.revert(decision.id, w.caller);
  check('Revert opens a revert mission', revert.title === 'revert: fix: typo in the settings title' && revert.workflowInputs.revertOfAuto === 'true', revert.title);
  let twice = null;
  try { await w.h.services.shipActions.revert(decision.id, w.caller); } catch (e) { twice = e.message; }
  check('a second Revert of the same merge is refused', twice === 'A revert of this merge is already on its way.', twice);
  await w.h.until(() => w.h.repo.missions.get(revert.id).status === 'COMPLETE' || w.h.repo.tasks.listByMission(revert.id)[0]?.status === 'AWAITING_APPROVAL', 60000);
  const revertPr = fake.pullRequests(w.ghDir, REPO).at(-1);
  const merges = fake.calls(w.ghDir).filter((c) => c.args[1] === 'merge');
  check('…and its PR merges on its own, bound to its head', revertPr.title === 'revert: fix: typo in the settings title' && revertPr.state === 'MERGED' && merges.at(-1).args.includes('--match-head-commit'), [revertPr.title, revertPr.state, w.h.repo.mergeDecisions.listByMission(revert.id).at(-1)?.reasons]);
  check('the original records merge.reverted and a reverted outcome', w.h.repo.events.listByMission(m.id).some((e) => e.body.type === 'merge.reverted') && w.h.repo.outcomes.listByWorkspace(w.ws, '1970').some((o) => o.mission === m.id && o.kind === 'reverted'));
  const revertedBy = w.h.repo.events.listByMission(m.id).find((e) => e.body.type === 'merge.reverted')?.body.by;
  check('…naming who asked for the revert, not Tandemise', typeof revertedBy === 'string' && revertedBy.startsWith('mem_'), revertedBy);
  const migration = D.decideMerge({ ...w.h.repo.mergeDecisions.listByMission(revert.id).at(-1).facts, changedPaths: ['db/migrations/1.sql'] }, D.parseMergePolicy({ ...app.SHIPPED_MERGE, autoMerge: 'off' }));
  check('a revert that touches a migration still asks', migration.verdict === 'ask', migration.reasons);

  // Watching main on a second merge, which you merge yourself: auto-merge off now.
  w.files.files.merge = { ...app.SHIPPED_MERGE, autoMerge: 'off' };
  const m2 = await w.mission('fix: typo in the footer');
  const ship2 = () => w.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship2()?.status === 'AWAITING_APPROVAL', 60000);
  const card = w.h.repo.approvals.list({ missionId: m2.id, statuses: ['PENDING'] })[0];
  await w.h.services.approvals.decide(w.caller, card.id, { optionId: 'approve' });
  await w.h.until(() => w.h.repo.missions.get(m2.id).status === 'COMPLETE', 30000);
  const d2 = w.h.repo.mergeDecisions.listByMission(m2.id).at(-1);
  check('a person\'s Merge on the card merges it', d2.mergeSha !== null && d2.mergedBy !== 'tandemise', [d2.mergedBy, d2.mergeSha]);
  fake.setChecks(w.ghDir, REPO, d2.mergeSha, [{ name: 'unit', conclusion: 'failure', logTail: 'boom' }]);
  const watch = w.h.container.resolve(app.MERGE_WATCH);
  const before = fake.calls(w.ghDir).filter((c) => c.args[1] === 'merge').length;
  await watch.sweep();
  await watch.sweep();
  const broke = w.h.repo.outcomes.listByWorkspace(w.ws, '1970').filter((o) => o.mission === m2.id && o.kind === 'broke_main');
  const cards = w.h.repo.approvals.list({ missionId: m2.id, statuses: ['PENDING'] }).filter((a) => a.title.startsWith('Main is failing after'));
  check('a failing check on the merge commit: one broke_main and one card, after two looks', broke.length === 1 && cards.length === 1, [broke.length, cards.map((c) => c.title)]);
  check('…and nothing was merged or reverted on its own', fake.calls(w.ghDir).filter((c) => c.args[1] === 'merge').length === before && w.h.repo.missions.list({ workspaceId: w.ws }).filter((x) => x.title.startsWith('revert:')).length === 1);
  // A revert someone else made on main.
  fake.setRepo(w.ghDir, REPO, { mainCommits: [{ sha: 'b'.repeat(40), subject: `Revert "${fake.pullRequests(w.ghDir, REPO).find((p) => p.number === d2.prNumber).title}"` }] });
  await watch.sweep();
  await watch.sweep();
  check('a Revert "…" commit on main records reverted once', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').filter((o) => o.mission === m2.id && o.kind === 'reverted').length === 1);
  // Eight days on, the first merge (never broken, its revert aside) — a third merge is clean.
  // Back on: in the brain, and decided again in the app (off in the brain ended the earlier decision).
  w.files.files.merge = { ...app.SHIPPED_MERGE, autoMerge: 'on' };
  await w.authorize();
  const m3 = await w.mission('fix: typo in the header');
  await w.h.until(() => w.h.repo.missions.get(m3.id).status === 'COMPLETE', 60000);
  await watch.sweep(Date.now() + 8 * 86_400_000);
  await watch.sweep(Date.now() + 8 * 86_400_000);
  check('after 8 days with no revert and no broken main: merged_clean, once', w.h.repo.outcomes.listByWorkspace(w.ws, '1970').filter((o) => o.mission === m3.id && o.kind === 'merged_clean').length === 1,
    w.h.repo.tasks.listByMission(m3.id).map((t) => `${t.key}:${t.status}:${t.statusReason ?? ''}`));
});

await attempt('main is judged by its own ci', async () => {
  section('main is judged by its own ci (#186)');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, autoMerge: 'on' } }, brain: true });
  await w.authorize();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const watch = w.h.container.resolve(app.MERGE_WATCH);
  const run = (id, name, path, event, conclusion, jobs) => ({
    id, name, path, event, head_branch: 'main', status: 'completed', conclusion, html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    jobs: jobs.map(([job, c]) => ({ name: job, status: 'completed', conclusion: c, html_url: `https://github.com/${REPO}/actions/runs/${id}/job/${job}` })),
  });
  const ci = (id, jobs) => run(id, 'CI', '.github/workflows/ci.yml', 'push', jobs.some(([, c]) => c === 'failure') ? 'failure' : 'success', jobs);
  const dependabot = (id) => run(id, 'Dependabot Updates', 'dynamic/dependabot/dependabot-updates', 'dynamic', 'failure', [['Dependabot', 'failure']]);
  // GitHub lists every Actions job as a check run on the commit too.
  const checksOf = (runs) => runs.flatMap((r) => r.jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })));
  /** A merged mission; its merge commit and the main commit before it get the runs given. */
  const merged = async (title, mergeRuns, parentRuns) => {
    const m = await w.mission(title);
    await w.h.until(() => w.h.repo.missions.get(m.id).status === 'COMPLETE', 60000);
    const d = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
    const parent = git(w.origin, 'rev-parse', `${d.mergeSha}^`);
    fake.setRepo(w.ghDir, REPO, { parents: { ...(fake.readState(w.ghDir).repos[REPO].parents ?? {}), [d.mergeSha]: parent } });
    fake.setRuns(w.ghDir, REPO, d.mergeSha, mergeRuns);
    fake.setChecks(w.ghDir, REPO, d.mergeSha, checksOf(mergeRuns));
    fake.setRuns(w.ghDir, REPO, parent, parentRuns);
    fake.setChecks(w.ghDir, REPO, parent, checksOf(parentRuns));
    await watch.sweep();
    await watch.sweep();
    const cards = w.h.repo.approvals.list({ missionId: m.id }).filter((a) => a.title.startsWith('Main is failing after'));
    const broke = w.h.repo.outcomes.listByWorkspace(w.ws, '1970').filter((o) => o.mission === m.id && o.kind === 'broke_main');
    const notes = w.h.repo.events.listByMission(m.id).filter((e) => e.body.type === 'note' && e.body.text.startsWith('Main was already failing')).map((e) => e.body.text);
    return { m, d, cards, broke, notes };
  };

  const dyn = await merged('fix: typo in the about title', [ci(101, [['test', 'success']]), dependabot(102)], [ci(91, [['test', 'success']]), dependabot(92)]);
  check('Dependabot `dynamic` runs failing on the merge commit, CI green: no card, no broke_main', dyn.cards.length === 0 && dyn.broke.length === 0, [dyn.cards.map((c) => c.title), dyn.broke.length]);
  check('…and no "already failing" note either: they are not this repository\'s CI', dyn.notes.length === 0, dyn.notes);

  const old = await merged('fix: typo in the contact title', [ci(201, [['test', 'success'], ['lint', 'failure']])], [ci(191, [['test', 'success'], ['lint', 'failure']])]);
  check('a check already failing on the main commit before: no card, no broke_main', old.cards.length === 0 && old.broke.length === 0, [old.cards.map((c) => c.title), old.broke.length]);
  check('…one "already failing" note, naming it, with nothing to revert', old.notes.length === 1 && old.notes[0].includes('CI › lint') && old.notes[0].includes('nothing to revert'), old.notes);

  const fresh = await merged('fix: typo in the pricing title', [ci(301, [['test', 'failure']]), dependabot(302)], [ci(291, [['test', 'success']])]);
  const card = fresh.cards[0];
  check('a check newly failing: one card and one broke_main', fresh.cards.length === 1 && fresh.broke.length === 1, [fresh.cards.length, fresh.broke.length]);
  check('…Leave it is the first option and the recommended one; Revert is neither', card?.options[0]?.label === 'Leave it' && card.recommendedOptionId === card.options[0].id && card.options.find((o) => o.label === 'Revert')?.id !== card.recommendedOptionId, [card?.options, card?.recommendedOptionId]);
  check('…the card says plainly what reverting would do', /Revert opens a pull request that undoes this merge/.test(card?.effect ?? ''), card?.effect);
  const ev = (label) => card?.evidence.find((e) => e.label === label)?.value ?? '';
  check('…the evidence names the workflow and job, and why it counts', ev('CI › test').startsWith('failed. Counted: runs on the push to main.'), card?.evidence);
  check('…and why the Dependabot run does not', ev('Dependabot Updates › Dependabot').includes('Not counted: event "dynamic"'), card?.evidence);
  check('…with a link to the failing run', card?.evidence.some((e) => e.kind === 'link' && e.value.includes('/actions/runs/301')), card?.evidence);
});

await attempt('learning never loosens', async () => {
  section('learning never loosens');
  const fake = await import('./fake-gh.mjs');
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const planner = D.parsePlannerConfig(app.SHIPPED_PLANNER).config;
  const routing = D.parseRoutingConfig({ classes: { implement: { ladder: ['haiku', 'sonnet', 'opus'], default: 'sonnet' } } }).config;
  const merge = D.parseMergePolicy(app.SHIPPED_MERGE);
  const ev = (id, mission, kind) => ({ op: 'outcome', id, at: `2026-10-2${id.length % 9}T00:00:00.000Z`, by: 'A', mission, lane: 'quick', profile: { type: 'fix', size: 's', risk: 'low', areas: ['payments-ui'], sensitivity: 'none' }, kind });
  const events = [ev('out_1', 'm_a', 'reverted'), ev('out_22', 'm_b', 'reverted')];
  const props = D.draftProposals(D.foldOutcomes(events), events, { planner, routing, merge }, {});
  const never = props.find((p) => p.id === 'never-area-payments-ui');
  check('two reverts in an area → one tightening proposal adding it to never', props.length === 1 && never?.kind === 'tighten' && JSON.stringify(never.edit.to.at(-1)) === JSON.stringify({ areas: ['payments-ui'] }), props);

  // Through the service, against a world: a pull request on tandemise/promote/<id> with the evidence and a backtest.
  const w = await world();
  for (const e of events) w.h.repo.outcomes.append({ ...e, at: new Date().toISOString(), workspaceId: w.ws });
  const service = w.h.container.resolve(app.PROPOSAL_SERVICE);
  const opened = await service.sweep();
  const create = fake.calls(w.ghDir).find((c) => c.args[1] === 'create' && c.args.includes('tandemise/promote/never-area-payments-ui'));
  const pr = fake.pullRequests(w.ghDir, REPO).find((p) => p.headRefName === 'tandemise/promote/never-area-payments-ui');
  check('the sweep opens it as a pull request on its promote branch', opened.length === 1 && create !== undefined, opened.map((p) => p.id));
  check('…with both missions and a backtest in the body', pr?.body.includes('m_a') && pr.body.includes('m_b') && pr.body.includes('Backtest:'), pr?.body);
  check('…and the project\'s working tree is untouched', !readdirSync(w.checkout).includes('.tandemise'));
  const branchFile = git(w.origin, 'show', 'tandemise/promote/never-area-payments-ui:.tandemise/factory/merge.yaml');
  check('the branch carries the edited merge.yaml', branchFile.includes('payments-ui'), branchFile.slice(0, 200));
  check('a second sweep opens nothing while it is open', (await service.sweep()).length === 0);
  fake.putPullRequest(w.ghDir, REPO, { ...pr, state: 'CLOSED' });
  check('closed with the same evidence, it is not proposed again', D.draftProposals(D.foldOutcomes(events), events, { planner, routing, merge }, { 'never-area-payments-ui': { state: 'closed', evidence: 2 } }).length === 0);
  const more = [...events, ev('out_333', 'm_c', 'reverted'), ev('out_4444', 'm_d', 'reverted')];
  check('…and is again once the evidence doubles', D.draftProposals(D.foldOutcomes(more), more, { planner, routing, merge }, { 'never-area-payments-ui': { state: 'closed', evidence: 2 } }).length === 1);

  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(18);
  let loosened = 0;
  for (let i = 0; i < 300; i++) {
    const areas = ['auth', 'payments', 'docs', 'ui'];
    const stats = { buckets: {}, areas: {}, steppedIn: {} };
    for (const a of areas) stats.areas[a] = { reverts90d: Math.floor(rnd() * 4), lastRevertAt: null, holds: 0, changesRequested: 0, tasks: 5 };
    for (const a of areas) stats.steppedIn[`implement|${a}`] = Array.from({ length: Math.floor(rnd() * 8) }, () => rnd() < 0.5);
    for (const m of ['haiku', 'sonnet', 'opus']) { const n = Math.floor(rnd() * 30); stats.buckets[`implement|quick|none`] ??= {}; stats.buckets['implement|quick|none'][m] = { n, firstPass: 0, success: Math.floor(rnd() * (n + 1)), holds: 0, changesRequested: 0, reverts: 0, medianCostUsd: null, medianWallTimeMs: null }; }
    const evs = Array.from({ length: 10 }, (_, k) => ({ ...ev(`out_${i}_${k}`, `m${k}`, rnd() < 0.5 ? 'held' : 'reverted'), step: { class: 'implement', model: null, attempt: 1, gatePassed: true, costUsd: null, wallTimeMs: null, taskKey: 'implement' }, profile: { type: 'fix', size: 's', risk: 'low', areas: [areas[k % 4]] } }));
    for (const p of D.draftProposals(stats, evs, { planner, routing, merge }, {})) {
      const to = p.edit.to;
      if (p.kind !== 'tighten') loosened++;
      if (p.file === 'merge' && p.edit.path === 'never' && to.length < p.edit.from.length) loosened++;
      if (p.file === 'routing' && to.length >= p.edit.from.length) loosened++;
      if (p.edit.path === 'autoMergeAtMost' || p.edit.path === 'score') loosened++;
    }
  }
  check('300 random stats tables: nothing ever loosens', loosened === 0, loosened);

  // Who writes the factory files: only a person's edit (merge policy, write the defaults) and the promote branch.
  const dist = join(root, 'packages', 'application', 'dist');
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(dist);
  const writers = files.filter((f) => /factorySource\.write\(|factory\.write\(/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(dist.length + 1)).sort();
  check('only merge-policy-service and factory-service call the factory source\'s write', JSON.stringify(writers) === JSON.stringify(['services/factory-service.js', 'services/merge-policy-service.js']), writers);
});

await attempt('review: auto-merge needs the brain and your decision', async () => {
  section('review: auto-merge needs the brain and your decision');
  const fake = await import('./fake-gh.mjs');
  const on = { ...app.SHIPPED_MERGE, autoMerge: 'on' };
  // Hard rule: a change to Tandemise's own rules always asks.
  const base = {
    changedPaths: ['src/a.ts'], deletedPaths: [], files: 1, linesAdded: 1, linesRemoved: 0, binaryFiles: 0, repos: 1, areas: [], testsTouched: 1,
    dependenciesChanged: false, lockfileOnly: false, coverageChangedLines: null, ci: { state: 'PASS', requiredPresent: true }, reviewRequired: false,
    checksTests: 'PASS', review: { blocking: 0, major: 0, independent: true }, criteria: { unverified: 0, implicit: false },
    process: { lane: 'quick', lightenedByPerson: false, stepsSkipped: 0, holds: 0, changesRequested: 0, escalations: 0, gateRetries: 0, personCommits: 0, revertOfAuto: false },
    history: { areaReverts90d: 0, areaRecentRevert: false },
  };
  const policy = D.parseMergePolicy(on);
  for (const path of ['.tandemise/factory/merge.yaml', 'factory/merge.yaml', 'apps/web/.tandemise/workflows/x.yaml']) {
    const d = D.decideMerge({ ...base, changedPaths: [path] }, policy);
    check(`a change to ${path} always asks`, d.verdict === 'ask' && d.reasons.some((r) => r.includes(path) && r.includes('always asks')), d.reasons);
  }
  // A merge.yaml saying "on" from the repository or this computer is not your decision: it asks.
  const w = await world({ factory: { merge: on } });
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length > 0, 60000);
  const d = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  check('autoMerge: on outside a brain is treated as off', d.verdict === 'ask' && d.reasons[0] === D.AUTO_MERGE_OFF, d.reasons);
  // From the brain, but nobody turned it on in the app: still off.
  const w2 = await world({ factory: { merge: on }, brain: true });
  fake.setRepo(w2.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m2 = await w2.mission('fix: typo in the footer');
  await w2.h.until(() => w2.h.repo.mergeDecisions.listByMission(m2.id).length > 0, 60000);
  check('autoMerge: on in the brain with no recorded decision is treated as off', w2.h.repo.mergeDecisions.listByMission(m2.id).at(-1).verdict === 'ask');
  let refused = null;
  const w3 = await world();
  try { await w3.h.services.mergePolicy.update(w3.ws, on, w3.caller); } catch (e) { refused = e.message; }
  check('turning auto-merge on without a brain is refused', typeof refused === 'string' && refused.includes('brain'), refused);
});

await attempt('review: queued auto-merge is cancelled', async () => {
  section('review: queued auto-merge is cancelled');
  const fake = await import('./fake-gh.mjs');
  const w = await world({ factory: { merge: { ...app.SHIPPED_MERGE, autoMerge: 'on' } }, brain: true });
  await w.authorize();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }], autoMergeAllowed: true, autoMergeQueues: true, protection: { required_status_checks: { strict: false, contexts: ['unit'] } } });
  const m = await w.mission('fix: typo in the settings title');
  const pr = () => fake.pullRequests(w.ghDir, REPO).at(-1);
  await w.h.until(() => pr()?.autoMerge != null, 60000);
  const merges = () => fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  check('with required checks, the merge is queued with --auto', merges().at(-1)?.args.includes('--auto') && pr().state === 'OPEN', merges().map((c) => c.args.join(' ')));
  // Queued: later looks watch it, and never queue it again.
  const queuedOnce = merges().length;
  const lookedBefore = fake.calls(w.ghDir).length;
  const deadline = Date.now() + 10000;
  while (fake.calls(w.ghDir).length < lookedBefore + 6 && Date.now() < deadline) { await w.h.scheduler.tick(); await w.h.sleep(100); }
  check('a queued merge is watched, not queued again on every look', merges().length === queuedOnce && fake.calls(w.ghDir).length >= lookedBefore + 6, merges().map((c) => c.args.join(' ')));
  await w.h.services.mergePolicy.stop(w.ws, w.caller);
  await w.h.until(() => merges().some((c) => c.args.includes('--disable-auto')), 30000);
  check('stopping auto-merge cancels the queued merge on GitHub', merges().some((c) => c.args.includes('--disable-auto')) && pr().autoMerge == null && pr().state === 'OPEN', merges().map((c) => c.args.join(' ')));
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).some((d) => d.voidedAt === null && d.verdict === 'ask'), 30000);
  check('…and the pull request is decided again, as ask', w.h.repo.mergeDecisions.listByMission(m.id).at(-1).verdict === 'ask');
  check('no gh call ever passes --admin', !fake.calls(w.ghDir).some((c) => c.args.includes('--admin')));
  const { readFileSync: rf, readdirSync: rd } = await import('node:fs');
  const ghDist = `${root}/packages/integration-github/dist`;
  check('nothing in the GitHub integration can pass --admin', rd(ghDist).filter((f) => f.endsWith('.js')).every((f) => !rf(`${ghDist}/${f}`, 'utf8').includes('--admin')));
  // No required checks: GitHub's auto-merge would not wait for CI, so it is never used.
  const w2 = await world({ factory: { merge: { ...app.SHIPPED_MERGE, autoMerge: 'on' } }, brain: true });
  await w2.authorize();
  fake.setRepo(w2.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }], autoMergeAllowed: true });
  const m2 = await w2.mission('fix: typo in the header');
  await w2.h.until(() => w2.h.repo.missions.get(m2.id).status === 'COMPLETE', 60000);
  const call = fake.calls(w2.ghDir).filter((c) => c.args[1] === 'merge').at(-1)?.args ?? [];
  check('without required checks, it merges directly (no --auto)', call.length > 0 && !call.includes('--auto'), call);
});

await attempt('review: ci read completely, and not too early', async () => {
  section('review: ci read completely, and not too early');
  const fake = await import('./fake-gh.mjs');
  const { realExecutor } = await import('./planner-harness.mjs');
  const w = await world({ ciGraceMs: 4000 });
  const flow = new GH.GhPullRequestFlow(realExecutor(`${w.ghDir}/bin`));
  const sha = 'c'.repeat(40);
  fake.setChecks(w.ghDir, REPO, sha, [{ name: 'unit', conclusion: 'success' }]);
  fake.setRepo(w.ghDir, REPO, { suites: { [sha]: [{ status: 'queued', latest_check_runs_count: 0, app: { slug: 'github-actions' } }] } });
  check('a workflow that hasn\'t started its runs yet keeps CI pending', (await flow.checks(w.checkout, REPO, sha)).state === 'PENDING');
  fake.setRepo(w.ghDir, REPO, { suites: {}, statuses: { [sha]: [{ context: 'ci/legacy', state: 'failure', description: 'boom' }] } });
  const legacy = await flow.checks(w.checkout, REPO, sha);
  check('a failing commit status (not a check run) fails CI', legacy.state === 'FAIL' && legacy.failing.some((f) => f.name === 'ci/legacy'), legacy);
  fake.setRepo(w.ghDir, REPO, { statuses: {} });
  const many = Array.from({ length: 130 }, (_, i) => ({ name: `job${i}`, conclusion: i === 120 ? 'failure' : 'success' }));
  fake.setChecks(w.ghDir, REPO, sha, many);
  const paged = await flow.checks(w.checkout, REPO, sha);
  check('check runs are read past the first page', paged.total === 130 && paged.state === 'FAIL', [paged.total, paged.state]);

  // Right after the PR opens there is no CI yet: that is waiting, not "no CI".
  fake.setRepo(w.ghDir, REPO, { defaultCheckSequence: [[], [{ name: 'unit', status: 'in_progress' }], [{ name: 'unit', conclusion: 'success' }]] });
  const m = await w.mission('fix: typo in the settings title');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length > 0, 60000);
  const first = w.h.repo.mergeDecisions.listByMission(m.id);
  check('no CI at first, then pending, then green: one decision, on green CI', first.length === 1 && first[0].facts.ci.state === 'PASS', first.map((d) => d.facts.ci.state));
  // Past the grace period with no CI it asks; when CI shows up later for the same head it decides again.
  const w2 = await world({ ciGraceMs: 300 });
  const m2 = await w2.mission('fix: typo in the footer');
  await w2.h.until(() => w2.h.repo.mergeDecisions.listByMission(m2.id).length > 0, 60000);
  const noCi = w2.h.repo.mergeDecisions.listByMission(m2.id)[0];
  check('with no CI after the grace period it asks', noCi.facts.ci.state === 'NONE' && noCi.reasons.includes(D.NO_CI), noCi.reasons);
  fake.setChecks(w2.ghDir, REPO, noCi.headSha, [{ name: 'unit', conclusion: 'success' }]);
  await w2.h.until(() => w2.h.repo.mergeDecisions.listByMission(m2.id).length === 2, 30000);
  const again = w2.h.repo.mergeDecisions.listByMission(m2.id);
  check('…and decides again on the same head once CI appears', again[0].voidedAt !== null && again[1].headSha === noCi.headSha && again[1].facts.ci.state === 'PASS', again.map((d) => [d.facts.ci.state, d.voidedAt]));
});

await attempt('review: rulesets and unknown protection', async () => {
  section('review: rulesets and unknown protection');
  const fake = await import('./fake-gh.mjs');
  const { realExecutor } = await import('./planner-harness.mjs');
  const w = await world();
  const flow = new GH.GhPullRequestFlow(realExecutor(`${w.ghDir}/bin`));
  check('no protection and no rulesets: unprotected', JSON.stringify(await flow.protection(w.checkout, REPO, 'main')) === JSON.stringify({ requiredChecks: false, reviewRequired: false, upToDate: false }));
  fake.setRepo(w.ghDir, REPO, { rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'unit' }] } }] });
  const ruled = await flow.protection(w.checkout, REPO, 'main');
  check('a ruleset that requires a review and checks is read', ruled.reviewRequired === true && ruled.requiredChecks === true && ruled.upToDate === true, ruled);
  fake.setRepo(w.ghDir, REPO, { rules: undefined, rulesUnavailable: true });
  const unknown = await flow.protection(w.checkout, REPO, 'main');
  check('no classic protection and rulesets unreadable: unknown, so it asks', unknown.reviewRequired === null && unknown.requiredChecks === null, unknown);
  // Classic protection asks for checks but no review; rulesets can't be read and could still ask for a review.
  fake.setRepo(w.ghDir, REPO, { rulesUnavailable: true, protection: { required_status_checks: { strict: false, contexts: ['unit'] } } });
  const partial = await flow.protection(w.checkout, REPO, 'main');
  check('classic readable, rulesets unreadable: what classic requires holds, what rulesets could add is unknown', partial.requiredChecks === true && partial.reviewRequired === null && partial.upToDate === null, partial);
});

await attempt('review: a diff that cannot be measured asks', async () => {
  section('review: a diff that cannot be measured asks');
  const fake = await import('./fake-gh.mjs');
  const planner = D.parsePlannerConfig(app.SHIPPED_PLANNER).config;
  const pr = { repo: REPO, number: 1, url: 'u', title: 't', headSha: 'h'.repeat(40), headBranch: 'b', baseBranch: 'main', state: 'OPEN', isDraft: false, mergedBy: null, mergeSha: null };
  const deps = (git) => ({ git, tasks: { listByMission: () => [] }, evaluations: { latestChecksForTask: () => [] }, runScores: { listByTask: () => [] }, criteria: { listActive: () => [] }, planDecisions: { latest: () => undefined } });
  const input = (pushedSha) => ({ mission: { id: 'm', workflowInputs: {} }, repository: {}, pr, baseRef: 'origin/main', checks: { state: 'PASS' }, protection: { requiredChecks: true, reviewRequired: false }, policy: D.parseMergePolicy(app.SHIPPED_MERGE), planner, pushedSha, repos: 1, stats: { areas: {} }, now: Date.now() });
  let threw = null;
  try { await app.measureMergeFacts(deps(async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: bad revision' })), input(null)); } catch (e) { threw = e.message; }
  check('a failing git diff is an error, never an empty change', typeof threw === 'string' && threw.includes('bad revision'), threw);
  // A person's edit in GitHub's web UI: authored by them, committed by noreply@github.com. Merges (Update branch) are
  // left out by --no-merges; commits by Tandemise's own identities (@tandemise.local) are not a person's.
  const gitOf = (ancestor) => async (args) => {
    if (args[0] === 'merge-base') return { exitCode: ancestor ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'log') {
      const byAuthor = args.includes('--format=%ae');
      return { exitCode: 0, stdout: byAuthor ? 'ada@example.com\nbob@example.com\nimplement@tandemise.local' : 'noreply@github.com\nnoreply@github.com\nimplement@tandemise.local', stderr: '' };
    }
    return { exitCode: 0, stdout: args.includes('--numstat') ? '1\t0\tsrc/a.ts' : '', stderr: '' };
  };
  const facts = await app.measureMergeFacts(deps(gitOf(true)), input('p'.repeat(40)));
  check('people\'s web-UI commits (committed by noreply@github.com) count as theirs; Tandemise\'s own does not', facts.process.personCommits === 2, facts.process.personCommits);
  let rewritten = null;
  try { await app.measureMergeFacts(deps(gitOf(false)), input('p'.repeat(40))); } catch (e) { rewritten = e.message; }
  check('a branch that no longer contains the commit Tandemise pushed cannot be measured, so it asks', typeof rewritten === 'string' && rewritten.includes('no longer contains'), rewritten);
  // In the engine: a head that can't be fetched is "couldn't measure", and asks.
  const w = await world();
  fake.setRepo(w.ghDir, REPO, { defaultCheckSequence: [[{ name: 'unit', status: 'in_progress' }], [{ name: 'unit', conclusion: 'success' }]] });
  const m = await w.mission('fix: typo in the settings title');
  await w.h.until(() => fake.pullRequests(w.ghDir, REPO).length > 0, 60000);
  fake.putPullRequest(w.ghDir, REPO, { ...fake.pullRequests(w.ghDir, REPO)[0], headRefOid: '9'.repeat(40) });
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length > 0, 60000);
  const d = w.h.repo.mergeDecisions.listByMission(m.id).at(-1);
  check('a head that isn\'t here asks, saying it couldn\'t measure', d.verdict === 'ask' && d.reasons.some((r) => r.startsWith('Tandemise couldn\'t measure this change')), d.reasons);
});

await attempt('review: a person\'s Merge never hangs or sticks', async () => {
  section('review: a person\'s Merge never hangs or sticks');
  const fake = await import('./fake-gh.mjs');
  const w = await world();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship()?.status === 'AWAITING_APPROVAL', 60000);
  const card = w.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] })[0];
  // The moved head's CI is still running: a Merge that waited for it would hang the request.
  fake.setRepo(w.ghDir, REPO, { moveHeadOnMerge: 'd'.repeat(40), defaultChecks: [{ name: 'unit', status: 'in_progress' }] });
  const t0 = Date.now();
  await w.h.services.approvals.decide(w.caller, card.id, { optionId: 'approve' });
  check('Merge answers at once, whatever GitHub does next', Date.now() - t0 < 3000, Date.now() - t0);
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id)[0].voidedAt !== null && ship().statusReason?.startsWith('Waiting for CI'), 30000);
  check('GitHub refusing (the head moved) voids the decision and the step waits for CI again', w.h.repo.mergeDecisions.listByMission(m.id)[0].voidedAt !== null && ship().status === 'AWAITING_EXTERNAL', [ship().status, ship().statusReason]);
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  // A merge that fails once on GitHub is tried again, because you already said Merge.
  const m2 = await w.mission('fix: typo in the footer');
  const ship2 = () => w.h.repo.tasks.listByMission(m2.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship2()?.status === 'AWAITING_APPROVAL', 60000);
  const card2 = w.h.repo.approvals.list({ missionId: m2.id, statuses: ['PENDING'] })[0];
  const state = fake.readState(w.ghDir); state.failNext = 'gh: Something went wrong (HTTP 502)'; fake.writeState(w.ghDir, state);
  await w.h.services.approvals.decide(w.caller, card2.id, { optionId: 'approve' });
  await w.h.until(() => w.h.repo.missions.get(m2.id).status === 'COMPLETE', 30000);
  check('…and is merged on a later look', w.h.repo.missions.get(m2.id).status === 'COMPLETE' && ship2().status === 'SUCCEEDED', [w.h.repo.missions.get(m2.id).status, w.h.repo.missions.get(m2.id).statusReason, ship2().status, ship2().statusReason, w.h.repo.tasks.listByMission(m2.id).map((t) => t.key + ':' + t.status)]);
});

await attempt('holds reach routing through the real event bus', async () => {
  section('holds reach routing through the real event bus');
  const w = await world();
  const m = await w.mission('fix: typo in the settings title');
  await w.h.until(() => w.h.repo.tasks.listByMission(m.id).some((t) => t.key !== 'ship' && t.status === 'SUCCEEDED'), 60000);
  const task = w.h.repo.tasks.listByMission(m.id).find((t) => t.key !== 'ship');
  // The daemon's own bus and recorder (the harness stubs the bus), wired as module.ts wires them.
  const { InMemoryEventBus } = await import('../apps/daemon/dist/buses.js');
  const bus = new InMemoryEventBus();
  const r = (tok) => w.h.container.resolve(tok);
  const { systemClock: clock } = await import('@tandemise/shared');
  const recorder = new app.EventRecorder(r(app.EVENT_REPOSITORY), bus, r(app.PROJECTION_BUS), clock);
  const outcomes = new app.OutcomeRecorder({
    outcomes: r(app.OUTCOME_REPOSITORY), bus, tasks: r(app.TASK_REPOSITORY), missions: r(app.MISSION_REPOSITORY),
    planDecisions: r(app.PLAN_DECISION_REPOSITORY), runScores: r(app.RUN_SCORE_REPOSITORY), recorder, clock: clock, log: { warn: (...a) => console.log('warn', ...a) },
  });
  await outcomes.start();
  const heldRows = () => r(app.OUTCOME_REPOSITORY).listByWorkspace(m.workspaceId, '1970-01-01T00:00:00Z').filter((o) => o.kind === 'held');
  // Exactly the body HoldService records when a hold ends (#50).
  recorder.record({ workspaceId: m.workspaceId, missionId: m.id, taskId: task.id }, {
    type: 'task.hold_ended', holdId: 'hld_check', ending: 'continued', endedBy: null, sessionAfter: null, durationMs: 1000, diffStat: { files: 1 },
  });
  await w.h.until(() => heldRows().length > 0, 5000).catch(() => {});
  check('a task.hold_ended through the daemon bus becomes a held outcome on that step', heldRows().length === 1 && heldRows()[0].step.taskKey === task.key, heldRows());
  await outcomes.stop();
});

await attempt('review: GitHub down while a pull request waits', async () => {
  section('review: GitHub down while a pull request waits');
  const fake = await import('./fake-gh.mjs');
  const w = await world();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  const ship = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  await w.h.until(() => ship()?.status === 'AWAITING_APPROVAL', 60000);
  const state = fake.readState(w.ghDir); state.failAll = 'gh: Something went wrong (HTTP 502)'; fake.writeState(w.ghDir, state);
  const before = fake.calls(w.ghDir).length;
  const end = Date.now() + 3000;
  while (Date.now() < end) { await w.h.scheduler.tick(); await w.h.sleep(50); }
  const looks = fake.calls(w.ghDir).length - before;
  // Polling every 150 ms, 3 s is 20 looks; backing off (150, 300, 600, 1200 ms …) is about 5.
  check('while GitHub fails, the step backs off instead of trying on every look', looks > 0 && looks <= 6, looks);
  check('…says so on the step, and stays waiting', ship().status === 'AWAITING_APPROVAL' && /GitHub didn't answer/.test(ship().statusReason ?? ''), [ship().status, ship().statusReason]);
  const ok = fake.readState(w.ghDir); delete ok.failAll; fake.writeState(w.ghDir, ok);
  await w.h.until(() => !/GitHub didn't answer/.test(ship().statusReason ?? ''), 20000);
  check('once GitHub answers, the step says what it was waiting for again', ship().status === 'AWAITING_APPROVAL' && ship().statusReason?.startsWith('Waiting for your review'), ship().statusReason);
});

await attempt('review: off in the brain ends your decision', async () => {
  section('review: off in the brain ends your decision');
  const fake = await import('./fake-gh.mjs');
  const on = { ...app.SHIPPED_MERGE, autoMerge: 'on' };
  const w = await world({ factory: { merge: on }, brain: true });
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  await w.authorize();
  // A teammate's brain change turns it off (not the app's switch): the next decision sees off.
  w.files.files.merge = { ...on, autoMerge: 'off' };
  const m1 = await w.mission('fix: typo in the settings title');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m1.id).length > 0, 60000);
  const decisionRepo = w.h.container.resolve(app.DECISION_REPOSITORY);
  const accepted = () => decisionRepo.listByWorkspace(w.ws).filter((d) => d.status === 'accepted' && d.title.startsWith('Auto-merge low-risk pull requests in'));
  check('the brain reading autoMerge: off supersedes the auto-merge Decision', accepted().length === 0, decisionRepo.listByWorkspace(w.ws).map((d) => [d.title, d.status]));
  // A brain pull request later turns it back on: that is not your decision in the app, so it asks.
  w.files.files.merge = on;
  const m2 = await w.mission('fix: typo in the footer');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m2.id).length > 0, 60000);
  const d2 = w.h.repo.mergeDecisions.listByMission(m2.id).at(-1);
  check('…so turning it back on through the brain needs a fresh decision in the app', d2.verdict === 'ask' && d2.reasons[0] === D.AUTO_MERGE_OFF, d2.reasons);
});

await attempt('review: holds are measured, or unmeasured', async () => {
  section('review: holds are measured, or unmeasured');
  const fake = await import('./fake-gh.mjs');
  const w = await world();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const m = await w.mission('fix: typo in the settings title');
  const impl = () => w.h.repo.tasks.listByMission(m.id).find((t) => t.key !== 'ship');
  await w.h.until(() => impl() !== undefined, 30000);
  // A hold on this mission's step, as #50 records it; no outcome event needed to count it.
  const now = new Date().toISOString();
  w.h.container.resolve(app.TASK_HOLD_REPOSITORY).create({
    id: 'hld_check_measure', taskId: impl().id, missionId: m.id, heldBy: 'mem_check', fromStatus: 'RUNNING', runtimeProfileId: 'rtp_check',
    sessionBefore: null, sessionAfter: null, ptyPid: null, startedAt: now, endedAt: now, endedBy: null, ending: 'continued',
    consumedAt: null, diffStat: null, dir: '/tmp/none',
  });
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m.id).length > 0, 60000);
  const facts = w.h.repo.mergeDecisions.listByMission(m.id).at(-1).facts;
  check('process.holds counts the mission\'s holds from the hold records', facts.process?.holds === 1, facts.process?.holds);
  // A mission with no holds measures 0 (the hold store is there), so a rule requiring none passes.
  const m0 = await w.mission('fix: typo in the footer');
  await w.h.until(() => w.h.repo.mergeDecisions.listByMission(m0.id).length > 0, 60000);
  const facts0 = w.h.repo.mergeDecisions.listByMission(m0.id).at(-1).facts;
  check('a mission with no holds measures process.holds = 0, not null', facts0.process?.holds === 0, facts0.process?.holds);
  const none = D.decideMerge(facts0, D.parseMergePolicy({ ...app.SHIPPED_MERGE, autoMerge: 'on', requires: ['ci.state == PASS', 'process.holds == 0'] }));
  check('…and a requires: process.holds == 0 rule passes for it', !none.reasons.some((r) => r.includes('process.holds')), none.reasons);
  // Only when the hold store isn't bound: unmeasured, which a rule on it never passes.
  const policy = D.parseMergePolicy({ ...app.SHIPPED_MERGE, autoMerge: 'on', never: [{ when: 'process.holds > 0' }] });
  const d = D.decideMerge({ ...facts, process: { ...facts.process, holds: null } }, policy);
  check('unmeasured holds (null) make a rule on them ask, never pass', d.verdict === 'ask', d.reasons);
});

await attempt('#184: a merge that fails after Merge asks', async () => {
  section('#184: a merge that fails after Merge asks');
  const fake = await import('./fake-gh.mjs');
  const w = await world();
  fake.setRepo(w.ghDir, REPO, { defaultChecks: [{ name: 'unit', conclusion: 'success' }] });
  const ship = (m) => w.h.repo.tasks.listByMission(m.id).find((t) => t.key === 'ship');
  const merges = () => fake.calls(w.ghDir).filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  const failedCard = (m) => w.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).find((a) => a.title.startsWith('Merge failed'));
  const approve = async (title) => {
    const m = await w.mission(title);
    await w.h.until(() => ship(m)?.status === 'AWAITING_APPROVAL', 60000);
    const card = w.h.repo.approvals.list({ missionId: m.id, statuses: ['PENDING'] }).find((a) => a.title.startsWith('Review and merge'));
    await w.h.services.approvals.decide(w.caller, card.id, { optionId: 'approve' });
    return m;
  };

  // gh refuses the merge for good (#183: a field it doesn't know): a card at once, naming GitHub's reason.
  const REFUSED = 'GraphQL: Field \'mergeCommitBody\' doesn\'t exist on type \'MergePullRequestInput\'';
  fake.setRepo(w.ghDir, REPO, { refuseMerge: REFUSED });
  const before = merges().length;
  const a = await approve('fix: typo in the settings title');
  await w.h.until(() => failedCard(a) !== undefined, 30000).catch(() => {});
  const card = failedCard(a);
  check('a refused merge blocks the step with a card naming the reason', card !== undefined && ship(a).status === 'BLOCKED' && card.rationale.includes(REFUSED) && (ship(a).statusReason ?? '').includes(REFUSED), [ship(a).status, ship(a).statusReason, card?.title]);
  check('…with Retry merge, Open the pull request and "I\'ll merge it in GitHub"', card?.options.map((o) => o.label).join('|') === 'Retry merge|I\'ll merge it in GitHub' && card.evidence.some((e) => e.kind === 'link' && e.label === 'Open the pull request'), card && [card.options, card.evidence]);
  check('…tried once: a refusal a retry can\'t change is not retried', merges().length - before === 1, merges().length - before);
  check('…and it waits on you in the Inbox', card?.kind !== 'check' && card?.addresseeIds?.length !== 0, card?.addresseeIds);
  fake.setRepo(w.ghDir, REPO, { refuseMerge: undefined });
  await w.h.services.approvals.decide(w.caller, card.id, { optionId: 'approve' });
  await w.h.until(() => w.h.repo.missions.get(a.id).status === 'COMPLETE', 30000).catch(() => {});
  check('Retry merge merges it', w.h.repo.missions.get(a.id).status === 'COMPLETE' && ship(a).status === 'SUCCEEDED', [ship(a).status, ship(a).statusReason]);

  // GitHub failing for a while: tried again with backoff, then a card that says how many tries were made.
  fake.setRepo(w.ghDir, REPO, { refuseMerge: 'gh: Something went wrong (HTTP 502)' });
  const before2 = merges().length;
  const b = await approve('fix: typo in the footer');
  await w.h.until(() => failedCard(b) !== undefined, 30000).catch(() => {});
  const card2 = failedCard(b);
  check(`a passing failure is tried ${app.MERGE_TRIES} times before it asks`, merges().length - before2 === app.MERGE_TRIES && card2 !== undefined, merges().length - before2);
  check('…and the card says how many tries were made', (card2?.rationale ?? '').includes(`after ${app.MERGE_TRIES} tries`) && card2.evidence.some((e) => e.label === 'Tries' && e.value === `${app.MERGE_TRIES} of ${app.MERGE_TRIES}`), card2 && [card2.rationale, card2.evidence]);
  await w.h.services.approvals.decide(w.caller, card2.id, { optionId: 'reject' });
  await w.h.until(() => ship(b).status === 'AWAITING_EXTERNAL', 10000).catch(() => {});
  const looks = merges().length;
  const end = Date.now() + 1500;
  while (Date.now() < end) { await w.h.scheduler.tick(); await w.h.sleep(100); }
  check('"I\'ll merge it in GitHub": it waits for you and tries no more', ship(b).status === 'AWAITING_EXTERNAL' && ship(b).statusReason === 'Waiting for you to merge it in GitHub.' && merges().length === looks, [ship(b).status, ship(b).statusReason, merges().length - looks]);
  fake.putPullRequest(w.ghDir, REPO, { ...fake.pullRequests(w.ghDir, REPO).at(-1), state: 'MERGED', mergedBy: { login: 'sam' }, mergeCommit: { oid: 'a'.repeat(40) } });
  await w.h.until(() => w.h.repo.missions.get(b.id).status === 'COMPLETE', 30000).catch(() => {});
  check('…and finishes when GitHub says it merged', w.h.repo.missions.get(b.id).status === 'COMPLETE', ship(b).statusReason);

  // GitHub merges it, but the call answers "Merge already in progress": that is a merge, not a refusal.
  fake.setRepo(w.ghDir, REPO, { refuseMerge: undefined, mergeInProgress: true });
  const before3 = merges().length;
  const e = await approve('fix: typo in the sidebar');
  await w.h.until(() => w.h.repo.missions.get(e.id).status === 'COMPLETE', 30000).catch(() => {});
  const said = [...w.h.repo.events.listByMission(e.id).map((x) => JSON.stringify(x.body)), ship(e).statusReason ?? ''].join('\n');
  check('"Merge already in progress" on a merge that happened: the mission completes', w.h.repo.missions.get(e.id).status === 'COMPLETE' && ship(e).status === 'SUCCEEDED', [ship(e).status, ship(e).statusReason]);
  check('…with one merge call, no card and no refusal said anywhere', merges().length - before3 === 1 && failedCard(e) === undefined && !/refused|didn't take|merge failed/i.test(said), { calls: merges().length - before3, said: said.match(/.{0,80}(refused|didn't take|merge failed).{0,80}/i)?.[0] });
});

// @sections

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
