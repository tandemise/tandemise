// #157 and #152: the pull request the ship step opens is titled as a
// Conventional Commit whose type says what the change is, and the Review and
// merge card shows that title as GitHub has it, tracker keys in their case.
//
// A squash-merged repository makes the PR title the commit on its default
// branch, and release-please reads it: a fix titled `chore:` never reaches the
// changelog. The type comes from the item's own prefix, then its labels or
// tracker type, then the planner's profile, then the agent's commit; `chore`
// only when nothing says otherwise. The subject is the agent's commit subject
// when there is one (it says what changed), else the item's title.
//
//   npm run build && node scratch/pr-title-check.mjs
const D = await import('@tandemise/domain');
const fake = await import('./fake-gh.mjs');
const { world, REPO } = await import('./planner-harness.mjs');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const keepAlive = setInterval(() => {}, 1000);

section('the title, from what is known (#157)');
const ISSUE = 'Planner tiebreak fails on a valid answer and falls back to the conservative default';
const COMMIT = 'fix: read the first valid json object in the planner tiebreak reply';
const rows = [
  ['a bug-labelled item with a plain title', { type: 'unknown' }, ISSUE, { labelType: 'fix' }, 'fix: planner tiebreak fails on a valid answer and falls back to the conservative default'],
  ['…prefers the agent\'s commit subject, which says what changed', { type: 'unknown' }, ISSUE, { labelType: 'fix', commits: [COMMIT] }, COMMIT],
  ['nothing but the agent\'s commit: its type and subject', { type: 'unknown' }, ISSUE, { commits: ['wip', COMMIT] }, COMMIT],
  ['the planner\'s type wins over the commit\'s, and keeps the commit\'s subject', { type: 'feature' }, 'Export the board', { commits: ['fix: add a csv export'] }, 'feat: add a csv export'],
  ['a commit\'s scope and breaking mark stay with its own type', { type: 'fix' }, ISSUE, { commits: ['fix(planner)!: read the first valid json object'] }, 'fix(planner)!: read the first valid json object'],
  ['a planner default of chore does not hide the commit\'s fix', { type: 'chore' }, ISSUE, { commits: [COMMIT] }, COMMIT],
  ['an item already titled as a Conventional Commit is used as written', { type: 'unknown' }, 'docs: Explain the brain', { labelType: 'fix', commits: [COMMIT] }, 'docs: Explain the brain'],
  ['chore only when nothing says otherwise', { type: 'unknown' }, 'Tidy the scripts folder', {}, 'chore: tidy the scripts folder'],
];
for (const [label, profile, title, hints, want] of rows) {
  const got = D.prTitle(profile, title, hints);
  check(`${label}: "${want}"`, got === want, got);
}

section('tracker keys and names keep their case (#152)');
const cases = [
  ['KEY-77 short summary', 'chore: KEY-77 short summary'],
  ['GAR-12 Settings title', 'chore: GAR-12 Settings title'],
  ['GitHub sign-in breaks', 'chore: GitHub sign-in breaks'],
  ['API returns 500', 'chore: API returns 500'],
  ['Settings title reads Setings', 'chore: settings title reads Setings'],
];
for (const [title, want] of cases) {
  const got = D.prTitle({ type: 'unknown' }, title);
  check(`"${title}" → "${want}"`, got === want, got);
}

section('the ship step and its Review and merge card');
try {
  const w = await world();
  const PS = await import('@tandemise/persistence');
  const app = await import('@tandemise/application');
  const items = w.h.container.resolve(PS.TRACKER_ITEM_REPOSITORY);
  if (w.h.container.tryResolve(app.TRACKER_ITEM_REPOSITORY) === undefined) w.h.container.bind(app.TRACKER_ITEM_REPOSITORY, () => items, { source: 'check' });
  const now = new Date().toISOString();
  // A YouTrack Bug whose summary starts with its key, as a person writes it.
  const item = items.upsert(w.ws, {
    ref: 'youtrack:KEY-77', key: 'KEY-77', url: 'https://acme.youtrack.cloud/issue/KEY-77', title: 'KEY-77 Settings title reads Setings',
    description: 'It reads Setings', state: 'Open', assignee: null, updatedAt: now, createdAt: now, type: 'Bug',
  });
  const made = await w.h.services.missions.create(w.caller, { workspaceId: w.ws, goal: 'The settings title reads Setings', title: 'KEY-77 Settings title reads Setings', workflowPreset: 'auto' });
  const id = made.id ?? made.mission?.id;
  w.h.repo.missions.update(id, { trackerItemId: item.id });
  await w.h.services.planning.plan(id);
  const ship = () => w.h.repo.tasks.listByMission(id).find((t) => t.key === 'ship');
  await w.h.until(() => ['SUCCEEDED', 'BLOCKED', 'FAILED', 'SKIPPED', 'AWAITING_APPROVAL'].includes(ship()?.status), 60000);
  const pr = fake.pullRequests(w.ghDir, REPO).at(-1);
  check('the pull request of a Bug with a plain title is a fix, and keeps the key\'s case', pr?.title === 'fix: KEY-77 Settings title reads Setings', pr?.title);
  check('the ship step asks (no CI here)', ship()?.status === 'AWAITING_APPROVAL', [ship()?.status, ship()?.statusReason]);
  const card = w.h.repo.approvals.list({ missionId: id, statuses: ['PENDING'] }).find((a) => a.title.startsWith('Review and merge'));
  check('the card shows the pull request as GitHub has it: number and title', card?.title === `Review and merge #${pr?.number}: ${pr?.title}`, card?.title);
  check('…never a lower-cased key', !/kEY-77/.test(card?.title ?? ''), card?.title);
} catch (e) {
  failures.push(`ship threw: ${e?.stack ?? e}`);
  console.log(e);
}

clearInterval(keepAlive);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
