#!/usr/bin/env node
// A stand-in for tandemd.
//
// It implements the HTTP + WebSocket surface of @tandemise/api-contract with
// fixture data, so the desktop app can be built and inspected before the real
// daemon exists. It writes a daemon.json handshake exactly where the app looks
// for one, and pushes a live-ish event stream so the mission timeline moves.
//
//   node mock/server.mjs                     → writes ~/.tandemise/daemon.json
//   TANDEMISE_HOME=/tmp/x node mock/server.mjs
//
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import * as fx from './fixtures.mjs';

const HOME = process.env.TANDEMISE_HOME ?? join(homedir(), '.tandemise');
const HANDSHAKE = join(HOME, 'daemon.json');
const TOKEN = randomBytes(24).toString('hex');
const API = '/v1';

// ------------------------------------------------------------- mutable state

const state = {
  missions: structuredClone(fx.missions),
  // Fixture tasks predate rounds; every TaskView carries a round and a feedback thread.
  tasks: Object.fromEntries(Object.entries(structuredClone(fx.tasksByMission)).map(([id, tasks]) => [id, tasks.map((t) => ({ round: 1, feedback: [], attention: null, ...t }))])),
  approvals: structuredClone(fx.approvals),
  runtimes: structuredClone(fx.runtimes),
  integrations: structuredClone(fx.integrations),
  roles: structuredClone(fx.roles),
  repositories: structuredClone(fx.repositories),
  workspace: structuredClone(fx.workspace),
  settings: structuredClone(fx.settings),
  checks: structuredClone(fx.checks),
  artifacts: structuredClone(fx.artifacts),
  events: [],
  sequence: 0,
};

// Attach checks and artifacts to their tasks, the way the daemon's projection would.
for (const tasks of Object.values(state.tasks)) {
  for (const task of tasks) {
    task.checks = state.checks.filter((check) => check.taskId === task.id);
    task.outputArtifacts = state.artifacts.filter((a) => a.manifest.taskId === task.id).map((a) => a.manifest);
    const approval = state.approvals.find((a) => a.approval.taskId === task.id && a.approval.status === 'PENDING');
    task.pendingApprovalId = approval?.approval.id ?? null;
  }
}

const sockets = new Set();

function emit(missionId, body, { taskId = null, runId = null, roleId = null, runtimeProfileId = null } = {}) {
  state.sequence += 1;
  const record = {
    id: `evt_${state.sequence}`,
    workspaceId: fx.WORKSPACE_ID,
    missionId,
    taskId,
    runId,
    sequence: state.sequence,
    roleId,
    runtimeProfileId,
    body,
    createdAt: new Date().toISOString(),
  };
  state.events.push(record);
  broadcast({ type: 'event', record });
  return record;
}

function invalidate(topic, missionId) {
  broadcast({ type: 'invalidate', topic, ...(missionId ? { missionId } : {}) });
}

function broadcast(message) {
  const frame = encodeFrame(JSON.stringify(message));
  for (const socket of sockets) {
    if (socket.writable) socket.write(frame);
  }
}

// Seed the history so the timeline is not empty on first load.
seedHistory();

function seedHistory() {
  const t = (role, body, taskKey) =>
    emit('msn_checkout', body, {
      roleId: role,
      taskId: taskKey ? `tsk_checkout_${taskKey}` : null,
      runId: taskKey ? `run_${taskKey}` : null,
      runtimeProfileId: 'rtp_claude',
    });

  t(null, { type: 'mission.status', from: 'DRAFT', to: 'PLANNING' });
  t(null, { type: 'mission.status', from: 'PLANNING', to: 'AWAITING_PLAN_APPROVAL', reason: 'Plan approval is on for this workspace.' });
  t(null, { type: 'approval.resolved', approvalId: 'apr_plan_checkout', status: 'APPROVED', option: 'approve' });
  t(null, { type: 'mission.status', from: 'AWAITING_PLAN_APPROVAL', to: 'EXECUTING' });

  t('product', { type: 'run.started', attempt: 1, runtime: 'Claude Code', target: 'local' }, 'spec');
  t('product', { type: 'message', text: 'Reviewed the existing sign-in flow and the last quarter of support tickets. Password reset is 41% of volume.' }, 'spec');
  t('product', { type: 'artifact.created', artifactId: 'art_spec' }, 'spec');
  t('product', { type: 'run.finished', status: 'SUCCEEDED', durationMs: 780_000 }, 'spec');

  t('design', { type: 'run.started', attempt: 1, runtime: 'Claude Code', target: 'local' }, 'design');
  t('design', { type: 'artifact.created', artifactId: 'art_design' }, 'design');
  t('design', { type: 'run.finished', status: 'SUCCEEDED', durationMs: 960_000 }, 'design');

  t('architecture', { type: 'run.started', attempt: 1, runtime: 'Codex', target: 'local' }, 'architecture');
  t('architecture', { type: 'message', text: 'Compared three WebAuthn libraries. Chose @simplewebauthn/server because it avoids a native dependency.' }, 'architecture');
  t('architecture', { type: 'artifact.created', artifactId: 'art_arch' }, 'architecture');
  t('architecture', { type: 'run.finished', status: 'SUCCEEDED', durationMs: 1_320_000 }, 'architecture');

  t('development', { type: 'run.started', attempt: 1, runtime: 'Claude Code', target: 'wt/passkey-impl' }, 'implement');
  for (const path of [
    'src/auth/passkey.ts',
    'src/auth/challenges.ts',
    'src/routes/auth.ts',
    'migrations/0042_user_credentials.sql',
    'web/src/auth/PasskeyButton.tsx',
    'web/src/auth/SignInForm.tsx',
    'web/src/settings/Security.tsx',
    'e2e/passkey.spec.ts',
  ]) {
    t('development', { type: 'file.changed', path, change: 'add' }, 'implement');
  }
  for (const [name, outcome, detail] of [
    ['checks.typecheck', 'PASS', 'tsc --noEmit, 0 errors.'],
    ['checks.lint', 'PASS', 'eslint, 0 errors, 2 warnings.'],
    ['checks.tests', 'PASS', '212 passed, 0 failed, 3 skipped.'],
    ['checks.build', 'PASS', 'vite build, 1.2 MB gzipped.'],
  ]) {
    t('development', { type: 'check.result', name, outcome, detail }, 'implement');
  }
  t('development', { type: 'gate.evaluated', gate: 'checks.typecheck == PASS && checks.tests == PASS', passed: true, detail: 'All gate conditions met.' }, 'implement');
  t('development', { type: 'artifact.created', artifactId: 'art_changeset' }, 'implement');
  t('development', { type: 'run.finished', status: 'SUCCEEDED', durationMs: 5_040_000 }, 'implement');

  t('review', { type: 'run.started', attempt: 1, runtime: 'Codex', target: 'wt/passkey-impl' }, 'review');
  t('review', { type: 'message', text: 'Found 2 blocking issues: the passkey challenge is not bound to the issuing session, and the password fallback is hidden exactly when a user needs it.' }, 'review');
  t('review', { type: 'artifact.created', artifactId: 'art_review' }, 'review');
  t('review', { type: 'gate.evaluated', gate: 'review.blocking_findings == 0', passed: false, detail: 'Gate failed: review.blocking_findings was 2, expected 0. Dependent tasks stay pending until they are remediated.' }, 'review');
  t('review', { type: 'run.finished', status: 'SUCCEEDED', durationMs: 1_260_000 }, 'review');

  t(null, { type: 'note', text: 'Generated a remediation task for the 2 blocking findings.', level: 'info' });
  t('development', { type: 'run.started', attempt: 1, runtime: 'Claude Code', target: 'wt/passkey-impl' }, 'remediate');
  t('development', { type: 'approval.requested', approvalId: 'apr_choice' }, 'remediate');

  // Other missions.
  emit('msn_billing', { type: 'approval.requested', approvalId: 'apr_release' }, { roleId: 'release', taskId: 'tsk_billing_release' });
  emit('msn_billing', { type: 'mission.status', from: 'EXECUTING', to: 'BLOCKED', reason: 'The release role needs authorisation to open a pull request.' }, {});
  emit('msn_a11y', { type: 'mission.status', from: 'READY_TO_SHIP', to: 'COMPLETE' }, {});
}

// ------------------------------------------------------- live event ticker

const LIVE_EVENTS = [
  { roleId: 'development', body: { type: 'tool.started', tool: 'Read', inputSummary: 'src/auth/challenges.ts' } },
  { roleId: 'development', body: { type: 'file.changed', path: 'src/auth/challenges.ts', change: 'edit' } },
  { roleId: 'development', body: { type: 'file.changed', path: 'src/auth/passkey.ts', change: 'edit' } },
  { roleId: 'development', body: { type: 'message', text: 'Bound each challenge to the session that requested it, and added a test that replays a challenge across sessions.' } },
  { roleId: 'development', body: { type: 'tool.started', tool: 'Bash', inputSummary: 'npm run typecheck' } },
  { roleId: 'development', body: { type: 'check.result', name: 'checks.typecheck', outcome: 'PASS', detail: 'tsc --noEmit, 0 errors.' } },
  { roleId: 'development', body: { type: 'file.changed', path: 'web/src/auth/SignInForm.tsx', change: 'edit' } },
  { roleId: 'development', body: { type: 'message', text: 'The password fallback now renders unconditionally, which is what acceptance criterion 4 asks for.' } },
  { roleId: 'development', body: { type: 'tool.started', tool: 'Bash', inputSummary: 'npm test -- passkey' } },
  { roleId: 'development', body: { type: 'check.result', name: 'checks.tests', outcome: 'PASS', detail: '214 passed, 0 failed.' } },
  { roleId: 'development', body: { type: 'usage', inputTokens: 48_200, outputTokens: 9_140, costUsd: null } },
  { roleId: 'development', body: { type: 'raw', channel: 'stdout', text: '> orbital-api@0.4.2 typecheck\n> tsc --noEmit' } },
];

let tick = 0;
setInterval(() => {
  const next = LIVE_EVENTS[tick % LIVE_EVENTS.length];
  tick += 1;
  emit('msn_checkout', next.body, {
    roleId: next.roleId,
    taskId: 'tsk_checkout_remediate',
    runId: 'run_remediate',
    runtimeProfileId: 'rtp_claude',
  });
  if (tick % 6 === 0) invalidate('missions', 'msn_checkout');
}, 1_800);

// ------------------------------------------------------------------ routing

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', '/health', () => ({ status: 'ok' }));

route('GET', '/system', () => ({
  daemonVersion: '0.1.0-mock',
  daemonBuild: 'dev',
  apiVersion: 'v1',
  schemaVersion: 3,
  startedAt: STARTED_AT,
  pid: process.pid,
  home: HOME,
  platform: process.platform,
  nodeVersion: process.version,
}));

route('GET', '/home', () => {
  const summaries = Object.keys(state.missions).map(summarize);
  return {
    workspace: state.workspace,
    activeMissions: summaries.filter((s) => ['EXECUTING', 'PLANNING', 'REVIEWING', 'QA', 'READY_TO_SHIP'].includes(s.mission.status)),
    blockedMissions: summaries.filter((s) => ['BLOCKED', 'AWAITING_PLAN_APPROVAL', 'PAUSED'].includes(s.mission.status)),
    recentMissions: summaries.filter((s) => ['COMPLETE', 'RELEASED', 'FAILED', 'CANCELLED'].includes(s.mission.status)),
    pendingApprovals: state.approvals.filter((a) => a.approval.status === 'PENDING'),
    runtimes: state.runtimes,
    recentEvents: state.events.slice(-25),
  };
});

route('GET', '/workspaces', () => [{ workspace: state.workspace, repositories: state.repositories, roles: state.roles }]);
route('GET', '/workspaces/:id', () => ({ workspace: state.workspace, repositories: state.repositories, roles: state.roles }));
route('PATCH', '/workspaces/:id', (_p, body) => {
  Object.assign(state.workspace, body, { updatedAt: new Date().toISOString() });
  if (body.routing) state.workspace.routing = { ...state.workspace.routing, ...body.routing };
  invalidate('workspaces');
  return state.workspace;
});

route('GET', '/workspaces/:id/repositories', () => state.repositories);
route('POST', '/workspaces/:id/repositories', (_p, body) => {
  const repository = {
    id: `rep_${createHash('sha1').update(body.path).digest('hex').slice(0, 8)}`,
    workspaceId: fx.WORKSPACE_ID,
    name: body.name ?? body.path.split('/').filter(Boolean).pop(),
    path: body.path,
    defaultBranch: 'main',
    remoteUrl: null,
    checks: { install: null, typecheck: null, lint: null, test: null, build: null, devServer: null, devServerUrl: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.repositories.push(repository);
  invalidate('workspaces');
  return repository;
});
route('DELETE', '/repositories/:id', (params) => {
  state.repositories = state.repositories.filter((r) => r.id !== params.id);
  invalidate('workspaces');
  return null;
});
route('POST', '/repositories/probe', (_p, body) => ({
  path: body.path,
  isGitRepository: true,
  name: body.path.split('/').filter(Boolean).pop(),
  defaultBranch: 'main',
  currentBranch: 'main',
  remoteUrl: null,
  isClean: true,
  detectedChecks: { install: 'npm ci', typecheck: 'npm run typecheck', lint: null, test: 'npm test', build: 'npm run build', devServer: null, devServerUrl: null },
  languages: ['TypeScript'],
  warnings: [],
}));

route('GET', '/missions', (_p, _b, query) => {
  let summaries = Object.keys(state.missions).map(summarize);
  if (query.status) summaries = summaries.filter((s) => s.mission.status === query.status);
  return summaries;
});

route('GET', '/missions/:id', (params) => detailFor(params.id));

route('POST', '/missions', (_p, body) => {
  const id = `msn_${randomBytes(4).toString('hex')}`;
  state.missions[id] = {
    id,
    workspaceId: body.workspaceId,
    repositoryId: body.repositoryId ?? null,
    title: body.title ?? titleFrom(body.goal),
    goal: body.goal,
    constraints: body.constraints ?? [],
    successCriteria: body.successCriteria ?? [],
    status: body.planNow ? 'PLANNING' : 'DRAFT',
    autonomy: body.autonomy ?? 'balanced',
    workflowPreset: body.workflowPreset ?? 'feature-delivery',
    integrationBranch: null,
    baseBranch: body.baseBranch ?? null,
    statusReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };
  state.tasks[id] = [];
  emit(id, { type: 'mission.status', from: 'DRAFT', to: 'PLANNING' });
  invalidate('missions');
  // Planning takes a beat, then produces a graph - the same shape the real daemon has.
  setTimeout(() => planMission(id), 2_500);
  return detailFor(id);
});

route('POST', '/missions/:id/plan', (params) => {
  planMission(params.id);
  return detailFor(params.id);
});

for (const [action, next] of [
  ['start', 'EXECUTING'],
  ['pause', 'PAUSED'],
  ['resume', 'EXECUTING'],
  ['cancel', 'CANCELLED'],
]) {
  route('POST', `/missions/:id/${action}`, (params) => {
    const mission = state.missions[params.id];
    if (!mission) throw notFound('Mission not found.');
    emit(params.id, { type: 'mission.status', from: mission.status, to: next });
    mission.status = next;
    mission.updatedAt = new Date().toISOString();
    if (action === 'start') mission.startedAt ??= new Date().toISOString();
    invalidate('missions', params.id);
    return detailFor(params.id);
  });
}

route('DELETE', '/missions/:id', (params) => {
  delete state.missions[params.id];
  delete state.tasks[params.id];
  invalidate('missions');
  return null;
});

route('GET', '/missions/:id/events', (params, _b, query) => {
  const after = Number(query.afterSequence ?? 0);
  const limit = Number(query.limit ?? 500);
  let events = state.events.filter((e) => e.missionId === params.id && e.sequence > after);
  if (query.semanticOnly === 'true') events = events.filter((e) => e.body.type !== 'raw');
  return events.slice(-limit);
});

// The Done-when ledger: the mission's lines as U1…, unverified. The mock has no QA to trace them against.
route('GET', '/missions/:id/criteria', (params) => {
  const detail = detailFor(params.id);
  return (detail.mission.successCriteria ?? []).map((statement, i) => ({
    id: `crt_mock_${i}`, key: `U${i + 1}`, statement, source: 'user', covers: [], coveredBy: [], result: 'UNVERIFIED',
    evidence: '', qaArtifactId: null, specArtifactId: null, counted: true, uncovered: false, createdAt: detail.mission.createdAt,
  }));
});

// Refinement (P6): the mock never runs a pass; a draft is ready when it has Done-when lines.
route('GET', '/missions/:id/refinement', (params) => {
  const detail = detailFor(params.id);
  const lines = detail.mission.successCriteria ?? [];
  const ready = lines.length > 0;
  return {
    missionId: params.id, state: 'idle', failure: null, artifactId: null, headline: null,
    criteria: lines.map((statement, i) => ({
      id: `crt_mock_${i}`, key: `U${i + 1}`, statement, status: 'accepted', origin: 'request', decidedBy: null, decidedById: null,
      createdAt: detail.mission.createdAt, decidedAt: null,
    })),
    questions: [],
    readiness: {
      ready, criteria: lines.length, openQuestions: 0, proposedPending: 0,
      label: ready ? 'Plan' : 'Add at least one Done-when criterion to plan',
      detail: ready ? 'All gate conditions met.' : 'Not met: ready.criteria is 0, needs >= 1',
    },
  };
});

// The mission feed, projected simply: the mock has one person, so every open
// approval and every person step is "mine". Enough to render the Feed tab.
route('GET', '/missions/:id/feed', (params, _b, query) => {
  const detail = detailFor(params.id);
  const doneLimit = Number(query.doneLimit ?? 5);
  const DONE = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'];
  const cards = detail.tasks.filter((t) => t.status !== 'PENDING').map((task) => {
    const artifact = detail.artifacts.filter((a) => a.taskId === task.id)[0] ?? null;
    // A check for me is "Needs you" too, but a decision that holds work up comes first.
    const open = state.approvals.filter((v) => v.approval.taskId === task.id && v.approval.status === 'PENDING');
    const approval = open.find((v) => v.approval.kind !== 'check') ?? open[0] ?? null;
    const section = approval || task.status === 'AWAITING_HUMAN' ? 'needs_you' : DONE.includes(task.status) ? 'done' : 'in_progress';
    return {
      taskId: task.id, key: task.key, title: task.title, roleName: task.roleName ?? null, status: task.status,
      statusReason: task.statusReason ?? null, section, doneBy: null, responsible: null, recordedBy: null,
      artifactId: artifact?.id ?? null, artifactTitle: artifact?.title ?? null,
      handoff: artifact ? artifact.handoff ?? (artifact.summary ? { headline: artifact.summary, points: [], needs: null, changed: [], links: [] } : null) : null,
      moreArtifacts: 0, overBudget: false, superseded: false, supersededByTaskKey: null,
      pendingApproval: section === 'needs_you' && approval ? approval : null,
      humanAction: task.status === 'AWAITING_HUMAN' ? 'complete' : null,
      planDecision: null,
      updatedAt: task.updatedAt ?? detail.mission.updatedAt,
      round: task.round ?? 1,
      openFeedback: (task.feedback ?? []).filter((f) => f.status === 'open' || f.status === 'queued'),
      changed: [],
      canRequestChanges: task.executor !== 'wait',
    };
  });
  const done = cards.filter((c) => c.section === 'done');
  return {
    missionId: params.id,
    needsYou: cards.filter((c) => c.section === 'needs_you'),
    inProgress: cards.filter((c) => c.section === 'in_progress'),
    done: done.slice(0, doneLimit),
    doneTotal: done.length,
  };
});

route('GET', '/missions/:id/artifacts', (params) => state.artifacts.filter((a) => a.manifest.missionId === params.id).map((a) => a.manifest));

route('GET', '/artifacts', (_p, _b, query) => {
  const needle = (query.q ?? '').toLowerCase();
  return state.artifacts
    .filter((a) => !needle || a.manifest.title.toLowerCase().includes(needle) || a.body.toLowerCase().includes(needle))
    .map((a) => a.manifest);
});

route('GET', '/artifacts/:id', (params) => {
  const artifact = state.artifacts.find((a) => a.manifest.id === params.id);
  if (!artifact) throw notFound('Artifact not found.');
  return artifact;
});

route('POST', '/tasks/:id/retry', (params) => {
  for (const tasks of Object.values(state.tasks)) {
    const task = tasks.find((t) => t.id === params.id);
    if (task) {
      task.status = 'RUNNING';
      task.attempts += 1;
      task.statusReason = null;
      emit(task.missionId, { type: 'task.status', from: 'FAILED', to: 'RUNNING', reason: 'Retried by you.' }, { taskId: task.id, roleId: task.roleId });
      invalidate('tasks', task.missionId);
    }
  }
  return null;
});

// Feedback, simply: a note is added to the task and a finished task goes again as the next round.
// There are no dependents in the mock, so no impact dialog; enough to exercise the composer and the thread.
function taskById(id) {
  for (const tasks of Object.values(state.tasks)) {
    const task = tasks.find((t) => t.id === id);
    if (task) return task;
  }
  throw notFound('Task not found.');
}

route('POST', '/tasks/:id/feedback', (params, body) => {
  const task = taskById(params.id);
  const running = task.status === 'RUNNING' || task.status === 'AWAITING_INPUT';
  const startsRound = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL'].includes(task.status);
  task.round = task.round ?? 1;
  if (startsRound) task.round += 1;
  const item = {
    id: `fb_mock${Date.now().toString(36)}`, taskId: task.id, artifactId: body.artifactId ?? null,
    author: { id: 'mem_you', name: 'You', kind: 'person' }, recordedBy: null, text: body.text,
    status: running ? 'queued' : startsRound ? 'in_round' : 'open', round: startsRound || running ? task.round : null,
    createdAt: new Date().toISOString(),
  };
  task.feedback = [...(task.feedback ?? []), item];
  if (startsRound) task.status = 'READY';
  emit(task.missionId, { type: 'feedback.given', feedbackId: item.id, status: item.status, excerpt: item.text.slice(0, 140) }, { taskId: task.id, roleId: task.roleId });
  if (startsRound) emit(task.missionId, { type: 'task.round_started', round: task.round, feedbackIds: [item.id], downstream: 'none', redone: [] }, { taskId: task.id, roleId: task.roleId });
  invalidate('tasks', task.missionId);
  return { feedback: item, impact: null, roundStarted: startsRound ? task.round : null, roundNotes: startsRound ? 1 : 0 };
});

route('GET', '/tasks/:id/feedback', (params) => {
  const task = taskById(params.id);
  return { taskId: task.id, round: task.round ?? 1, items: task.feedback ?? [], pendingImpact: null };
});

route('POST', '/feedback/:id/dismiss', (params) => {
  for (const tasks of Object.values(state.tasks)) {
    for (const task of tasks) {
      const item = (task.feedback ?? []).find((f) => f.id === params.id);
      if (item) {
        item.status = 'dismissed';
        invalidate('tasks', task.missionId);
        return item;
      }
    }
  }
  throw notFound('That note no longer exists.');
});

route('GET', '/approvals', () => state.approvals);

route('POST', '/approvals/:id/decide', (params, body) => {
  const view = state.approvals.find((a) => a.approval.id === params.id);
  if (!view) throw notFound('Approval not found.');
  // Request changes is stored as a rejection, as the daemon does: the card is answered, and the work goes again.
  const approved = body.optionId !== 'reject' && body.optionId !== 'request_changes';
  Object.assign(view.approval, {
    status: approved ? 'APPROVED' : 'REJECTED',
    selectedOptionId: body.optionId,
    decisionNote: body.note ?? null,
    decidedBy: 'you',
    decidedAt: new Date().toISOString(),
  });
  if (view.approval.missionId) {
    emit(view.approval.missionId, { type: 'approval.resolved', approvalId: view.approval.id, status: view.approval.status, option: body.optionId });
    const mission = state.missions[view.approval.missionId];
    if (mission && mission.status === 'BLOCKED' && approved) {
      emit(mission.id, { type: 'mission.status', from: 'BLOCKED', to: 'EXECUTING', reason: 'You approved the pending request.' });
      mission.status = 'EXECUTING';
      mission.statusReason = null;
    }
  }
  invalidate('approvals');
  invalidate('missions');
  return view;
});

route('GET', '/runtimes', () => state.runtimes);
route('POST', '/runtimes/discover', () => fx.discoveries);
route('POST', '/runtimes', (_p, body) => {
  const profile = {
    id: `rtp_${randomBytes(3).toString('hex')}`,
    workspaceId: fx.WORKSPACE_ID,
    adapterId: body.adapterId,
    name: body.name,
    executablePath: body.executablePath ?? null,
    args: body.args ?? [],
    settings: body.settings ?? {},
    capabilities: ['reasoning', 'shell', 'filesystem'],
    enabled: body.enabled ?? true,
    maxConcurrent: body.maxConcurrent ?? 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.runtimes.push({
    profile,
    health: { profileId: profile.id, state: 'unknown', version: null, detail: 'Not probed yet. Run a health check.', checkedAt: new Date().toISOString(), quotaWarning: null },
    adapterDisplayName: body.adapterId === 'generic-cli' ? 'Generic CLI' : body.adapterId,
    activeRuns: 0,
    rolesRouted: [],
  });
  invalidate('runtimes');
  return profile;
});
route('PATCH', '/runtimes/:id', (params, body) => {
  const view = state.runtimes.find((r) => r.profile.id === params.id);
  if (!view) throw notFound('Runtime not found.');
  Object.assign(view.profile, body, { updatedAt: new Date().toISOString() });
  invalidate('runtimes');
  return view.profile;
});
route('DELETE', '/runtimes/:id', (params) => {
  state.runtimes = state.runtimes.filter((r) => r.profile.id !== params.id);
  invalidate('runtimes');
  return null;
});
route('POST', '/runtimes/:id/health', (params) => {
  const view = state.runtimes.find((r) => r.profile.id === params.id);
  if (!view) throw notFound('Runtime not found.');
  view.health = { ...view.health, checkedAt: new Date().toISOString() };
  invalidate('runtimes');
  return view;
});

route('GET', '/roles', () => state.roles);
route('PUT', '/roles/:id', (params, body) => {
  const role = state.roles.find((r) => r.id === params.id);
  if (!role) throw notFound('Role not found.');
  Object.assign(role, body, { updatedAt: new Date().toISOString() });
  invalidate('workspaces');
  return role;
});

route('GET', '/integrations', () => state.integrations);
route('POST', '/integrations', (_p, body) => {
  const view = {
    integration: {
      id: `itg_${randomBytes(3).toString('hex')}`,
      workspaceId: body.workspaceId,
      providerId: body.providerId,
      name: body.name,
      transport: body.providerId === 'github' ? 'cli' : body.providerId,
      config: body.config ?? {},
      credentialRef: body.secret ? `keychain://tandemise/${body.providerId}` : null,
      enabledCapabilities: body.enabledCapabilities ?? [],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    health: { state: 'unknown', detail: 'Not probed yet.', checkedAt: new Date().toISOString() },
    availableCapabilities: [],
  };
  state.integrations.push(view);
  invalidate('integrations');
  return view;
});
route('PATCH', '/integrations/:id', (params, body) => {
  const view = state.integrations.find((i) => i.integration.id === params.id);
  if (!view) throw notFound('Integration not found.');
  Object.assign(view.integration, body, { updatedAt: new Date().toISOString() });
  invalidate('integrations');
  return view;
});
route('DELETE', '/integrations/:id', (params) => {
  state.integrations = state.integrations.filter((i) => i.integration.id !== params.id);
  invalidate('integrations');
  return null;
});

route('GET', '/settings', () => state.settings);
route('PATCH', '/settings', (_p, body) => {
  Object.assign(state.settings, body);
  invalidate('workspaces');
  return state.settings;
});

// ------------------------------------------------------------------ helpers

function summarize(missionId) {
  const mission = state.missions[missionId];
  const tasks = state.tasks[missionId] ?? [];
  const events = state.events.filter((e) => e.missionId === missionId);
  const running = tasks.find((t) => t.status === 'RUNNING');
  return {
    mission,
    progress: progressFor(missionId),
    repositoryName: state.repositories.find((r) => r.id === mission.repositoryId)?.name ?? null,
    currentActivity: running ? `${running.roleName}: ${running.title}` : mission.statusReason,
    lastEventAt: events[events.length - 1]?.createdAt ?? mission.updatedAt,
  };
}

function progressFor(missionId) {
  const tasks = state.tasks[missionId] ?? [];
  return {
    totalTasks: tasks.length,
    completed: tasks.filter((t) => t.status === 'SUCCEEDED').length,
    running: tasks.filter((t) => t.status === 'RUNNING').length,
    blocked: tasks.filter((t) => t.status === 'BLOCKED' || t.status === 'AWAITING_APPROVAL').length,
    failed: tasks.filter((t) => t.status === 'FAILED').length,
    pendingApprovals: state.approvals.filter((a) => a.approval.missionId === missionId && a.approval.status === 'PENDING').length,
  };
}

function detailFor(missionId) {
  const mission = state.missions[missionId];
  if (!mission) throw notFound('Mission not found.');
  const tasks = state.tasks[missionId] ?? [];
  return {
    mission,
    progress: progressFor(missionId),
    repository: state.repositories.find((r) => r.id === mission.repositoryId) ?? null,
    tasks,
    artifacts: state.artifacts.filter((a) => a.manifest.missionId === missionId).map((a) => a.manifest),
    approvals: state.approvals.filter((a) => a.approval.missionId === missionId).map((a) => a.approval),
    decisions: fx.decisions.filter((d) => d.missionId === missionId),
    targets: fx.targets.filter((t) => t.missionId === missionId),
    checks: state.checks.filter((c) => c.missionId === missionId),
    evaluations: fx.evaluations.filter((e) => e.missionId === missionId),
    metrics: fx.metricsByMission[missionId] ?? emptyMetrics(),
    plan: tasks.length > 0 ? { summary: planSummary(mission), tasks: [] } : null,
    planIssues: [],
  };
}

function planSummary(mission) {
  return `${mission.workflowPreset.replace(/-/g, ' ')} workflow: specification, then design and architecture in parallel, then implementation behind a typecheck-and-tests gate, then an independent review, then QA and a release candidate.`;
}

function emptyMetrics() {
  return { wallClockMs: 0, runtimeActiveMs: 0, humanWaitMs: 0, retries: 0, failures: 0, filesChanged: 0, commits: 0, reviewFindings: 0, qaDefects: 0, inputTokens: null, outputTokens: null, costUsd: null, runtimeFallbacks: 0 };
}

/** Gives a freshly created mission a plausible graph, so the DAG is never empty. */
function planMission(missionId) {
  const mission = state.missions[missionId];
  if (!mission) return;
  const shape = [
    ['spec', 'Write the specification', 'product', 0, []],
    ['design', 'Design the interaction', 'design', 1, ['spec']],
    ['architecture', 'Choose the technical approach', 'architecture', 1, ['spec']],
    ['implement', 'Implement the change', 'development', 2, ['design', 'architecture']],
    ['review', 'Review against the specification', 'review', 3, ['implement']],
    ['qa', 'Verify the acceptance criteria', 'qa', 4, ['review']],
    ['release', 'Assemble the release candidate', 'release', 5, ['qa']],
  ];
  state.tasks[missionId] = shape.map(([key, title, roleId, level, dependsOn], index) => ({
    id: `tsk_${missionId.slice(4)}_${key}`,
    missionId,
    key,
    title,
    objective: `${title} for: ${mission.goal}`,
    roleId,
    roleName: state.roles.find((r) => r.id === roleId)?.name ?? roleId,
    level,
    dependsOn,
    requiredCapabilities: roleId === 'development' ? ['filesystem.write', 'shell.exec'] : ['repository.read'],
    inputArtifacts: [],
    expectedOutputs: [],
    executionPolicy: { isolation: roleId === 'development' ? 'worktree' : 'none', maxWallTimeMs: 1_800_000, capabilities: [] },
    approvalPolicy: { beforeStart: roleId === 'release', onCompletion: false },
    retryPolicy: { maxAttempts: 2, backoffMs: 5000, onExhausted: 'block' },
    completionGate: roleId === 'development' ? 'checks.typecheck == PASS && checks.tests == PASS' : null,
    status: index === 0 ? 'READY' : 'PENDING',
    statusReason: index === 0 ? null : `Waiting on ${dependsOn.join(', ')}.`,
    attempts: 0,
    remediatesTaskId: null,
    orderHint: index,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    round: 1,
    feedback: [],
    latestRun: null,
    runCount: 0,
    outputArtifacts: [],
    checks: [],
    gate: null,
    pendingApprovalId: null,
    runtimeName: null,
    targetName: null,
  }));
  mission.status = 'AWAITING_PLAN_APPROVAL';
  emit(missionId, { type: 'mission.status', from: 'PLANNING', to: 'AWAITING_PLAN_APPROVAL', reason: 'Plan approval is on for this workspace.' });
  invalidate('missions', missionId);
  invalidate('tasks', missionId);
}

function titleFrom(goal) {
  const words = goal.replace(/[.!?].*$/s, '').split(/\s+/).slice(0, 6).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function notFound(message) {
  const error = new Error(message);
  error.code = 'NOT_FOUND';
  error.status = 404;
  return error;
}

// --------------------------------------------------------------- http server

const STARTED_AT = new Date().toISOString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-tandemise-api-version');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return void res.writeHead(204).end();

  if (!url.pathname.startsWith(API)) return void send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown path.', details: {}, retryable: false } });

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    return void send(res, 403, { error: { code: 'PERMISSION_DENIED', message: 'Missing or invalid bearer token.', details: {}, retryable: false } });
  }

  const path = url.pathname.slice(API.length) || '/';
  const match = routes.map((r) => ({ r, params: matchRoute(r, req.method, path) })).find((candidate) => candidate.params);
  if (!match) return void send(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${path}.`, details: {}, retryable: false } });

  let body = undefined;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    body = raw ? JSON.parse(raw) : {};
  }

  try {
    const result = await match.r.handler(match.params, body ?? {}, Object.fromEntries(url.searchParams));
    if (result === null || result === undefined) return void res.writeHead(204).end();
    send(res, 200, result);
  } catch (error) {
    send(res, error.status ?? 500, {
      error: { code: error.code ?? 'INTERNAL', message: error.message, details: {}, retryable: (error.status ?? 500) >= 500 },
    });
  }
});

function matchRoute(route, method, path) {
  if (route.method !== method) return null;
  const expected = route.pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i++) {
    const segment = expected[i];
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual[i]);
    else if (segment !== actual[i]) return null;
  }
  return params;
}

function send(res, status, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

// ---------------------------------------------------------- websocket server
// A minimal RFC 6455 server: handshake, text frames out, ping/close in. Pulling
// in `ws` for a mock the UI only reads from would be more moving parts, not fewer.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/v1/stream' || url.searchParams.get('token') !== TOKEN) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
  );
  socket.setNoDelay(true);
  sockets.add(socket);

  socket.write(
    encodeFrame(JSON.stringify({ type: 'hello', apiVersion: 'v1', daemonVersion: '0.1.0-mock', serverTime: new Date().toISOString() })),
  );

  socket.on('data', (chunk) => {
    // Only opcode 0x8 (close) and 0x9 (ping) need a response; client text
    // frames are subscribe/ping, and the mock broadcasts to everyone anyway.
    const opcode = chunk[0] & 0x0f;
    if (opcode === 0x8) socket.end();
  });
  const drop = () => sockets.delete(socket);
  socket.on('close', drop);
  socket.on('error', drop);
});

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

// --------------------------------------------------------------- entry point

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  mkdirSync(HOME, { recursive: true });
  writeFileSync(
    HANDSHAKE,
    JSON.stringify({ url: `http://127.0.0.1:${port}`, token: TOKEN, pid: process.pid, startedAt: STARTED_AT }, null, 2),
  );
  console.log(`mock tandemd listening on http://127.0.0.1:${port}`);
  console.log(`handshake written to ${HANDSHAKE}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      rmSync(HANDSHAKE);
    } catch {
      /* already gone */
    }
    process.exit(0);
  });
}
