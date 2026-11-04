// PM11 (#143, #145) — A mission planned before the fix: its plan carries a CI wait on
// `gh pr checks <branch> --required`, and the repository has no required checks, so the command
// exits 1 for ever. A step opened the pull request (here: its branch pushed and the fake GitHub
// told). The daemon decides the wait by the pull request instead: a green one files "Review and
// merge", which Home and the Inbox show; a wait that goes on is Stalled, with Open the pull
// request, Retry and Cancel; a merge on GitHub completes the mission as merged by a person.
//
// The wait step is written into the database as the old planner wrote it, which is how such a
// mission looks to an upgraded daemon.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { context, SCRATCH } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { putPullRequest, pullRequests, setChecks } from '../../../fake-gh.mjs';
import { REPO, autoDraft, ghCalls, headerAction, mission, openMission, ship, waitStatus } from '../common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(here, '../../../../docs/superpowers/evidence/2026-11-01-ci-wait');
const GH = `${SCRATCH}/gh`;
const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('PM11', 'A legacy CI wait is decided by its pull request: Review and merge, Stalled, merged by a person');
const git = (...args) => execFileSync('git', ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', ...args], { cwd: c.env.project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `pm11-${name}.png`);
  await page.screenshot(path);
  ev.shots.push(path);
};
const green = [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'success' }];
const running = [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'in_progress', conclusion: null }];

/** A step's branch pushed, and its pull request on the fake GitHub. */
function openPr(branch, checks) {
  git('checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(c.env.project, `${branch.replace(/\//g, '-')}.md`), `${branch}\n`);
  git('add', '.');
  git('commit', '-q', '-m', `work on ${branch}`);
  git('push', '-q', 'origin', branch);
  const sha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  const number = Math.max(0, ...pullRequests(GH, REPO).map((p) => p.number)) + 1;
  const url = `https://github.com/${REPO}/pull/${number}`;
  putPullRequest(GH, REPO, {
    number, url, title: `Work on ${branch}`, body: '', headRefName: branch, headRefOid: sha, baseRefName: 'main',
    state: 'OPEN', isDraft: false, mergedBy: null, mergeCommit: null, reviewers: [], reviews: [],
  });
  setChecks(GH, REPO, sha, checks);
  return { number, sha, url };
}

/** The wait step a plan from before the fix carried, written as that planner wrote it; the ship step waits behind it. */
function addLegacyWait(missionId, branch) {
  const db = new DatabaseSync(`${c.env.home}/tandemise.db`);
  try {
    const shipRow = db.prepare(`SELECT id FROM mission_tasks WHERE mission_id = ? AND executor = 'ship'`).get(missionId);
    const id = `tsk_ci${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const wait = JSON.stringify({ command: `gh pr checks ${branch} --required`, everyMs: 1500, timeoutMs: 2_700_000 });
    db.exec('BEGIN');
    db.prepare(`INSERT INTO mission_tasks (id, mission_id, "key", title, objective, role_id, required_capabilities, input_artifacts, expected_outputs,
        execution_policy, approval_policy, retry_policy, completion_gate, status, status_reason, attempts, remediates_task_id, repository_id, executor,
        wait_policy, retry_feedback, model_policy, skills, step_class, staffing, staffing_override, assignee_id, responsible_id, needs_attention, round,
        order_hint, created_at, updated_at, started_at, finished_at)
      SELECT ?, mission_id, 'ci', 'Wait for CI on the pull request', ?, role_id, '[]', '[]', '[]',
        execution_policy, approval_policy, retry_policy, NULL, 'PENDING', NULL, 0, NULL, repository_id, 'wait',
        ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1,
        order_hint, created_at, updated_at, NULL, NULL
      FROM mission_tasks WHERE id = ?`).run(id, `Wait for the required checks on ${branch} to pass.`, wait, shipRow.id);
    const deps = db.prepare('SELECT depends_on_key AS key, ordinal FROM task_dependencies WHERE task_id = ? ORDER BY ordinal').all(shipRow.id);
    for (const d of deps) db.prepare('INSERT INTO task_dependencies (task_id, depends_on_key, ordinal) VALUES (?, ?, ?)').run(id, d.key, d.ordinal);
    db.prepare('INSERT INTO task_dependencies (task_id, depends_on_key, ordinal) VALUES (?, ?, ?)').run(shipRow.id, 'ci', deps.length);
    db.prepare('UPDATE mission_tasks SET order_hint = order_hint + 1 WHERE id = ?').run(shipRow.id);
    db.exec('COMMIT');
    return id;
  } finally { db.close(); }
}

async function plannedWithLegacyWait(goal, branch, checks) {
  const pr = openPr(branch, checks);
  const id = await autoDraft(c, goal);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  await until(async () => Object.values(await c.tasks(id)).some((t) => t.executor === 'ship'), { label: 'planned', timeoutMs: 60_000 });
  addLegacyWait(id, branch);
  ev.note(`mission ${id}: a legacy wait on \`gh pr checks ${branch} --required\`, pull request #${pr.number}`);
  return { id, pr };
}

const homeText = async () => {
  if ((await page.evaluate('location.hash')) !== '#/') await page.navigate('#/');
  await sleep(1500);
  return page.evaluate('document.body.innerText');
};

const creates = () => ghCalls().filter((x) => x.args[0] === 'pr' && x.args[1] === 'create');
const createdBefore = creates().length;

try {
  // An earlier scenario (PM3) turns auto-merge on, and then a low-risk change merges on its own,
  // which is right. This scenario is about the person being asked, so the project asks again.
  const policy = (await api.get(`/v1/workspaces/${c.env.workspaceId}/merge-policy`)).policy;
  if (policy.autoMerge !== 'off') {
    await api.put(`/v1/workspaces/${c.env.workspaceId}/merge-policy`, { policy: { ...policy, autoMerge: 'off' } });
    ev.note('auto-merge was on from an earlier scenario; turned it off so the merge asks');
  }
  ev.check('auto-merge is off for this project', (await api.get(`/v1/workspaces/${c.env.workspaceId}/merge-policy`)).policy.autoMerge === 'off');

  // ------------------------------------------------------------ a green pull request
  const a = await plannedWithLegacyWait('fix: the settings title is wrong', 'feat/settings-title', green);
  const ciA = await until(async () => { const t = await c.task(a.id, 'ci'); return t?.status === 'SUCCEEDED' && t; }, { label: 'ci passes', timeoutMs: 120_000 });
  ev.check('the legacy `--required` wait passes on the pull request\'s state', /Every check passed on #\d+/.test(ciA.statusReason ?? ''), ciA.statusReason);
  const card = await until(async () => (await c.approvals(a.id, 'PENDING')).find((x) => x.title.startsWith('Review and merge')), { label: 'Review and merge', timeoutMs: 120_000 });
  ev.check('"Review and merge" is filed for it', card !== undefined, card?.title);
  ev.check('…linking the pull request the step opened', card?.evidence.some((e) => e.value === a.pr.url), card?.evidence);
  // Earlier scenarios open their own pull requests: only the creates since this scenario started count.
  const created = creates().slice(createdBefore);
  ev.check('no second pull request was opened', created.length === 0, created.map((x) => x.args));
  const shipA = await ship(c, a.id);
  ev.check('the mission shows the pull request', shipA.prs.some((p) => p.url === a.pr.url), shipA.prs);

  // ------------------------------------------------------------ a wait that goes on
  const b = await plannedWithLegacyWait('fix: the footer link is broken', 'feat/footer-link', running);
  const ciB = await until(async () => { const t = await c.task(b.id, 'ci'); return t?.status === 'AWAITING_EXTERNAL' && /Waiting for CI on #/.test(t.statusReason ?? '') && t; }, { label: 'ci waits', timeoutMs: 120_000 });
  ev.check('while CI runs, the wait says what it waits for', /Waiting for CI on #\d+ \(1 of 2 checks done\)/.test(ciB.statusReason ?? ''), ciB.statusReason);
  {
    const db = new DatabaseSync(`${c.env.home}/tandemise.db`);
    try { db.prepare(`UPDATE mission_tasks SET started_at = ? WHERE mission_id = ? AND "key" = 'ci'`).run(new Date(Date.now() - 2 * 3_600_000).toISOString(), b.id); } finally { db.close(); }
  }
  ev.note('the wait for the second mission is moved two hours back, past its 30-minute stall threshold');

  // ------------------------------------------------------------ Home
  // Nothing else happens to the mission: the daemon's own pass notices the wait is overdue and refreshes the window.
  const home = await until(async () => { const t = await homeText(); return /Stalled\s*\n\s*1/.test(t) && t; }, { label: 'Home stalled', timeoutMs: 45_000 }).catch(() => homeText());
  // "Needs you now" shows the first few items, oldest first; after the earlier scenarios the rest sit behind "N more requests".
  const crowded = /\d+ more requests? in your inbox/.test(home);
  ev.check('Home: Needs you counts the review', /Needs you\s*\n\s*[1-9]/.test(home) && !home.includes('Nothing waits on you'), home.slice(0, 400));
  ev.check('Home: Stalled counts the wait', /Stalled\s*\n\s*1/.test(home) && !home.includes('Everything can move'), home.slice(0, 400));
  // #151: the tile and the list come from one count; the stalled wait offers Retry ci, so it waits on you in both.
  const tile = Number(home.match(/Needs you\s*\n\s*(\d+)/)?.[1] ?? NaN);
  const listed = Number(home.match(/Needs you now\s*\n?\s*(\d+) requests?/)?.[1] ?? 0);
  const badge = Number(home.match(/Inbox\s*\n\s*(\d+)/)?.[1] ?? 0);
  ev.check('Home: the Needs you tile and the Needs you now list agree, and the Inbox badge with them', tile === listed && tile === badge && tile >= 2, { tile, listed, badge });
  ev.check('Home "Needs you now": Review and merge', home.includes('Review and merge'), home);
  ev.check('Home "Needs you now": the stalled wait, with what it waits for (or behind "more requests" when the list is full)',
    crowded || (home.includes('Stalled: fix: the footer link is broken') && home.includes("'ci' is still waiting: Waiting for CI on #")), home);
  await shot('home');

  // ------------------------------------------------------------ Inbox
  await page.navigate('#/inbox');
  await sleep(1500);
  const inbox = await page.evaluate('document.body.innerText');
  ev.check('Inbox: Review and merge', inbox.includes('Review and merge'), inbox.slice(0, 600));
  ev.check('Inbox: the stalled wait', inbox.includes('Stalled: fix: the footer link is broken'), inbox.slice(0, 600));
  await shot('inbox');
  // Home's Stalled number links here.
  await page.navigate('#/inbox/stalled');
  await sleep(1500);
  const stalledText = await page.evaluate('document.body.innerText');
  ev.check('Inbox → Stalled: the wait says what it waits for', stalledText.includes("'ci' is still waiting: Waiting for CI on #"), stalledText.slice(0, 600));
  const rowButtons = await page.evaluate(`[...document.querySelectorAll('[aria-label="Stalled: fix: the footer link is broken"] button')].map((b) => b.innerText.trim())`);
  ev.check('…with Open the pull request, Retry ci and Cancel mission', ['Open the pull request', 'Retry ci', 'Cancel mission'].every((l) => rowButtons.includes(l)), rowButtons);
  await shot('inbox-stalled');

  // ------------------------------------------------------------ merged on GitHub during the wait
  const pr = pullRequests(GH, REPO).find((p) => p.number === b.pr.number);
  putPullRequest(GH, REPO, { ...pr, state: 'MERGED', mergedBy: { login: 'ana' }, mergeCommit: { oid: 'a'.repeat(40) } });
  const done = await waitStatus(c, b.id, ['COMPLETE'], 60_000);
  ev.check('a merge on GitHub completes the mission', done === 'COMPLETE', done);
  const shipB = await c.task(b.id, 'ship');
  ev.check('…its ship step says merged in GitHub by the person', (shipB.statusReason ?? '').startsWith('Merged in GitHub by ana'), shipB.statusReason);
  const kinds = c.sql('SELECT body FROM outcomes WHERE mission_id = ?', b.id).map((r) => JSON.parse(r.body).kind);
  ev.check('…and its outcome is merged_by_person, not cancelled', kinds.includes('merged_by_person') && !kinds.includes('cancelled'), kinds);
  const after = await until(async () => { const t = await homeText(); return /Stalled\s*\n\s*0/.test(t) && t; }, { label: 'Home stalled 0', timeoutMs: 30_000 });
  ev.check('Home: nothing is stalled once it merged', after.includes('Everything can move'), after.slice(0, 400));
  await openMission(c, b.id);
  await shot('merged-mission');
  ev.check('the first mission still waits on you', (await mission(c, a.id)).status !== 'COMPLETE');
} catch (error) {
  ev.check(`threw: ${error.message}`, false);
}
ev.save();
process.exit(ev.ok ? 0 : 1);
