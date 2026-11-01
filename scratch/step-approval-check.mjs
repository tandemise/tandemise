/**
 * A step a person approved does not ask again for the calls its card named,
 * and a call that does ask parks the step on the person (#141).
 *
 * Found on a real run on 0.10.0: the "open the pull request" step was
 * approved with `github.pr.create` on its card, and the tool broker filed a
 * second card for that very call. Nobody saw it, the run spent its 900 s
 * budget waiting, the card was cancelled, and the retry opened the pull
 * request without asking. Its card said RUNNING the whole time.
 *
 * Everything runs through the real engine: the scheduler, the executor's
 * deadline, the run's MCP gateway, the broker and the policy engine. The fake
 * runtime makes the call for real (its `call` step) and GitHub is the fake `gh`.
 *
 *   A. Step approved, call named on its card: no second card, the PR is opened.
 *   B. Step approved, two attempts: neither asks.
 *   C. No step approval: the call asks, the step reads AWAITING_INPUT, and
 *      the run's clock stops - the card outlives three wall-time budgets and
 *      the run still opens the PR once it is answered.
 *   D. A card cancelled with its attempt is asked again on the retry; nothing
 *      happens without an answer.
 *   E. A Claude worker granted the gated tool cannot open the PR from its
 *      shell instead.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineHarness, realExecutor, git, REPO } from './planner-harness.mjs';

let bad = 0;
const check = (n, c, d = '') => {
  if (c) console.log(`  ok   ${n}`);
  else { bad++; console.log(`  FAIL ${n}${d === '' ? '' : `  ${typeof d === 'string' ? d : JSON.stringify(d)}`}`); }
};
const section = (s) => console.log(`\n${s}`);

const keepAlive = setInterval(() => {}, 1000);
const { systemClock, ids } = await import('@tandemise/shared');
const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
const G = await import('@tandemise/integration-github');
const fake = await import('./fake-gh.mjs');

const base = mkdtempSync(join(tmpdir(), 'tdm-step-approval-'));
const ghDir = join(base, 'gh');
const bin = fake.installFakeGh(ghDir);
const checkout = join(base, 'web');
mkdirSync(checkout);
git(checkout, 'init', '-q', '-b', 'main');
writeFileSync(join(checkout, 'README.md'), '# web\n');
git(checkout, 'add', '.');
git(checkout, 'commit', '-q', '-m', 'init');

const h = await engineHarness(join(base, 'home'), { commandExecutor: realExecutor(bin), modules: [G.githubIntegrationModule] });
execFileSync('git', ['init', '-q', '-b', 'main', h.paths.root]);
const now = () => systemClock.now();
const caller = { personId: h.services.identity.localPerson().id };
const ws = (await h.services.workspaces.create(caller, { name: 'Ship' })).workspace.id;
const repository = h.repo.repositories.create({
  id: ids.repository(), workspaceId: ws, name: 'web', path: checkout, defaultBranch: 'main', remoteUrl: `git@github.com:${REPO}.git`,
  checks: { install: null, typecheck: null, lint: null, test: null, build: null, devServer: null, devServerUrl: null },
});
h.repo.workspaces.update(ws, { defaultRepositoryId: repository.id });
h.container.resolve(h.app.INTEGRATION_REPOSITORY).create({
  id: ids.integration(), workspaceId: ws, providerId: 'github', name: 'GitHub', transport: 'cli', config: {}, credentialRef: null,
  enabledCapabilities: ['github.read', 'github.pr.create'], enabled: true, createdAt: now(), updatedAt: now(),
});
// The release role of a factory that opens pull requests, as the brain's was.
const roles = h.container.resolve(h.app.ROLE_REPOSITORY);
const release = roles.get('release', ws);
roles.upsert({ ...release, workspaceId: ws, defaultCapabilities: [...release.defaultCapabilities, 'github.pr.create'], updatedAt: now() });

const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
const agentFor = (name, steps) => {
  const profileId = h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    // The fake makes MCP calls with its `call` step; the profile says so, as a real one would.
    args: [], settings: { script: { steps } }, capabilities: ['reasoning', 'filesystem', 'shell', 'git', 'tool_calling', 'session_resume', 'mcp'],
    enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  return h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: ['release'], runtimeProfileIds: [profileId] }).id;
};
const openPr = (head) => ({ kind: 'call', tool: 'github.pr.create', input: { repo: REPO, title: `feat: ${head}`, head, body: 'Closes #1' } });

let seq = 0;
const addStep = async ({ agent, beforeStart, maxWallTimeMs = 60000, maxAttempts = 1 }) => {
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Open the pull request', title: `S${++seq}` });
  const row = {
    id: ids.task(), missionId: mission.id, key: 'open_pr', title: 'Open the pull request', objective: 'Open a pull request.', roleId: 'release',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs, capabilities: ['github.pr.create', 'repository.read', 'artifact.write'] },
    approvalPolicy: { beforeStart, onCompletion: false }, retryPolicy: { maxAttempts, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status: 'READY', statusReason: null,
    attempts: 0, remediatesTaskId: null, repositoryId: repository.id, executor: 'agent', waitPolicy: null, orderHint: 0,
    staffingOverride: { assignees: [agent] },
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  };
  h.repo.tasks.add(row);
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  return row.id;
};
const task = (id) => h.repo.tasks.get(id);
const cards = (id) => h.repo.approvals.list({}).filter((a) => a.taskId === id);
const startCard = (id) => cards(id).find((a) => a.title.startsWith('Start '));
const toolCards = (id) => cards(id).filter((a) => a.title.startsWith('Allow '));
const pendingTool = (id) => toolCards(id).find((a) => a.status === 'PENDING');
const prs = (head) => (fake.readState(ghDir).repos[REPO]?.prs ?? []).filter((p) => p.headRefName === head);
const runs = (id) => h.repo.runs.listByTask(id);
const settled = (id) => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(task(id).status);
const approve = (card) => h.services.approvals.decide(caller, card.id, { optionId: 'approve' });

// ---------------------------------------------------------------------------
section('A. a step approved with github.pr.create on its card');
{
  const id = await addStep({ agent: agentFor('A', [openPr('feat/a'), { kind: 'complete', summary: 'done' }]), beforeStart: true });
  const start = await h.until(() => startCard(id));
  check('the step asks before it starts, naming the call', start !== undefined && start.effect.includes('github.pr.create'), start?.effect);
  await approve(start);
  await h.until(() => settled(id) || pendingTool(id) !== undefined, 20000);
  check('no second card is filed for the call the step card named', toolCards(id).length === 0, toolCards(id).map((a) => `${a.title} ${a.status}`));
  check('the pull request is opened', prs('feat/a').length === 1, fake.readState(ghDir).repos[REPO]);
  check('the step finishes', task(id).status === 'SUCCEEDED', `${task(id).status}: ${task(id).statusReason}`);
  for (const card of toolCards(id).filter((a) => a.status === 'PENDING')) await approve(card);
  await h.until(() => settled(id), 10000);
}

// ---------------------------------------------------------------------------
section('B. the same step approval holds on every attempt');
{
  const id = await addStep({
    agent: agentFor('B', [openPr('feat/b'), { kind: 'fail', code: 'FLAKY', message: 'Something else went wrong.', retryable: true }]),
    beforeStart: true, maxAttempts: 2,
  });
  await approve(await h.until(() => startCard(id)));
  for (let i = 0; i < 4 && !settled(id); i++) {
    await h.until(() => settled(id) || pendingTool(id) !== undefined, 20000);
    const card = pendingTool(id);
    if (card !== undefined) await approve(card);
  }
  check('both attempts ran', runs(id).length === 2, runs(id).map((r) => r.status));
  check('neither attempt asked again', toolCards(id).length === 0, toolCards(id).map((a) => `${a.title} ${a.status}`));
  check('one pull request, not two', prs('feat/b').length === 1);
}

// ---------------------------------------------------------------------------
section('C. a call that asks parks the step and stops its clock');
{
  const budget = 1500;
  const id = await addStep({ agent: agentFor('C', [openPr('feat/c'), { kind: 'complete', summary: 'done' }]), beforeStart: false, maxWallTimeMs: budget });
  const card = await h.until(() => pendingTool(id), 20000);
  check('the call asks (no step approval covers it)', card !== undefined);
  await h.sleep(300);
  check('the step reads as waiting on you, not RUNNING', task(id).status === 'AWAITING_INPUT', `${task(id).status}: ${task(id).statusReason}`);
  // Three budgets of a person not answering.
  await h.until(() => false, budget * 3);
  const live = card === undefined ? undefined : h.repo.approvals.get(card.id);
  check('the card is still waiting after three budgets', live?.status === 'PENDING', live?.status);
  check('the run did not time out', runs(id).every((r) => r.errorCode !== 'TIMEOUT'), runs(id).map((r) => `${r.status} ${r.errorCode}`));
  check('the run is the only attempt and still live', runs(id).length === 1 && ['STARTING', 'RUNNING'].includes(runs(id)[0].status), runs(id).map((r) => r.status));
  if (live?.status === 'PENDING') await approve(live);
  await h.until(() => settled(id), 20000);
  check('answered, the call goes through', prs('feat/c').length === 1);
  check('and the step finishes', task(id).status === 'SUCCEEDED', `${task(id).status}: ${task(id).statusReason}`);
}

// ---------------------------------------------------------------------------
section('D. a card cancelled with its attempt is asked again on the retry');
{
  const id = await addStep({ agent: agentFor('D', [openPr('feat/d'), { kind: 'complete', summary: 'done' }]), beforeStart: false, maxAttempts: 2 });
  const first = await h.until(() => pendingTool(id), 20000);
  check('attempt 1 asks', first !== undefined);
  await h.services.missions.retryTask(caller, id, { stopRun: true });
  await h.until(() => runs(id).length === 2 && pendingTool(id) !== undefined, 20000);
  const second = pendingTool(id);
  check('attempt 1\'s card is closed, not left asking', first !== undefined && h.repo.approvals.get(first.id).status !== 'PENDING');
  check('attempt 2 asks again', second !== undefined && second.id !== first?.id, toolCards(id).map((a) => a.status));
  check('nothing was opened without an answer', prs('feat/d').length === 0);
  if (second !== undefined) await approve(second);
  await h.until(() => settled(id), 20000);
  check('answered, attempt 2 opens it', prs('feat/d').length === 1 && task(id).status === 'SUCCEEDED', task(id).status);
}

// ---------------------------------------------------------------------------
section('E. the gated tool is the only way to the same action');
{
  const { buildInvocation } = await import('@tandemise/runtime-claude');
  const argsFor = (grants) => buildInvocation({
    runId: 'r', profile: { settings: {} }, prompt: 'p', workingDirectory: base, grants, allowedRoots: [], mcpConfigPath: join(base, 'mcp.json'),
  }, null).args;
  const disallowed = (args) => (args[args.indexOf('--disallowed-tools') + 1] ?? '').split(',');
  const withTool = argsFor(['shell.exec', 'filesystem.write', 'github.pr.create']);
  check('a worker with the github.pr.create tool cannot run `gh pr create` in its shell',
    withTool.includes('--disallowed-tools') && disallowed(withTool).includes('Bash(gh pr create:*)'), withTool);
  const shellOnly = argsFor(['shell.exec', 'filesystem.write']);
  check('a worker without the tool keeps its shell as it was', !shellOnly.includes('--disallowed-tools') || !disallowed(shellOnly).some((t) => t.startsWith('Bash(gh')), shellOnly);
}

// ---------------------------------------------------------------------------
section('F. a step approval never widens what policy allows');
{
  const { createPolicyEngine } = await import('@tandemise/policy');
  const policy = createPolicyEngine();
  const autonomy = { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' };
  const grant = (capability, scope = [REPO]) => ({ capability, resourceScope: scope, approvalMode: 'auto', expiresAt: null });
  const ask = (capability, resource, extra = {}) => policy.evaluate({
    capability, resource, grants: [grant('github.pr.create'), grant('shell.exec', ['/work'])], autonomy, ...extra,
  }).outcome;
  check('without it, the call asks', ask('github.pr.create', REPO) === 'require_approval');
  check('with the call on the card, it is allowed', ask('github.pr.create', REPO, { stepApproved: ['github.pr.create'] }) === 'allow');
  check('a call the card did not name still asks',
    policy.evaluate({ capability: 'github.issue.create', resource: REPO, grants: [grant('github')], autonomy, stepApproved: ['github.pr.create'] }).outcome === 'require_approval');
  check('a capability with no grant is still denied',
    policy.evaluate({ capability: 'github.pr.create', resource: REPO, grants: [], autonomy, stepApproved: ['github.pr.create'] }).outcome === 'deny');
  check('a repository outside the grant is still denied', ask('github.pr.create', 'evil/repo', { stepApproved: ['github.pr.create'] }) === 'deny');
  check('a workspace that forbids external writes still denies',
    ask('github.pr.create', REPO, { stepApproved: ['github.pr.create'], autonomy: { ...autonomy, externalWrites: 'deny' } }) === 'deny');
  check('a destructive shell command still asks',
    policy.evaluate({ capability: 'shell.exec', resource: '/work', command: 'rm -rf /work/src', grants: [grant('shell.exec', ['/work'])], autonomy, stepApproved: ['shell.exec'] }).outcome === 'require_approval');
  check('a destructive capability still asks',
    policy.evaluate({ capability: 'github.branch.delete', resource: REPO, grants: [grant('github')], autonomy, stepApproved: ['github.branch.delete'] }).outcome === 'require_approval');
  check('a release still asks',
    policy.evaluate({ capability: 'github.pr.merge', resource: REPO, grants: [grant('github')], autonomy, stepApproved: ['github.pr.merge'] }).outcome === 'require_approval');

  const { stepApprovedCapabilities, STEP_CAPABILITIES_LABEL } = h.app;
  const at = (ms) => new Date(Date.parse('2026-10-31T10:00:00.000Z') + ms).toISOString();
  const assignment = { missionId: 'm1', taskId: 't1', createdAt: at(0) };
  const card = (patch) => ({ taskId: 't1', kind: 'action', status: 'APPROVED', decidedAt: at(-1000), evidence: [{ kind: 'text', label: STEP_CAPABILITIES_LABEL, value: 'github.pr.create, repository.read' }], ...patch });
  const read = (list) => stepApprovedCapabilities({ list: () => list }, assignment);
  check('the start card binds the capabilities it listed', read([card({})]).join() === 'github.pr.create,repository.read', read([card({})]));
  check('another step\'s card binds nothing', read([card({ taskId: 't2' })]).length === 0);
  check('a card decided after the attempt began binds nothing', read([card({ decidedAt: at(1000) })]).length === 0);
  check('a card without the list (older, or a tool card) binds nothing', read([card({ evidence: [{ kind: 'text', label: 'Capability', value: 'github.pr.create' }] })]).length === 0);
}

await h.scheduler.drain?.();
clearInterval(keepAlive);
console.log(bad === 0 ? '\nstep-approval-check: all passed' : `\nstep-approval-check: ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
