// H3, on the real Claude Code (as A15 does): hold a running Claude step, see
// its own interactive session in the panel, then Continue. The continuation
// resumes the session the terminal captured, spends no attempt, and the step
// ends with its output as usual. Spends real usage; skipped with --skip-claude.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRIPTS, newMission, fakeProfile, holdFromCard, holdsOf, panelButton, panelLabel, panelText, pressKey, screenText, stepOf, useRuntimes, waitStep, shoot } from '../common.mjs';

const c = await context();
const { page, api, until, sleep } = c;
const ev = new Evidence('H3-claude', 'Continue on the real Claude Code: its own session in the panel, then a resumed pass');

let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  // Setup: the same account setting the user's own installation uses.
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR ? { configDir: process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR } : {}, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
}
await useRuntimes(c, [claude.id]);
ev.note('setup: the Design agent runs on Claude Code');

const missionId = await newMission(c, `Onboarding note on Claude ${Date.now().toString(36)}`, 'Hold one');
const running = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.latestRun?.status === 'RUNNING', 'Claude running', { timeoutMs: 120_000 });
// Hold once Claude has told us its session, so there is one to resume.
await until(() => c.runs(running.id).at(-1)?.sessionId, { label: 'Claude session id', timeoutMs: 120_000, everyMs: 300 });
const attempts = (await stepOf(c, missionId)).attempts;
await holdFromCard(c, missionId);
const [hold] = holdsOf(c, running.id);
const stopped = c.runs(running.id).at(-1);
ev.check('proof (DB): the Claude run ended RESUMABLE and the hold starts from its session', stopped.status === 'RESUMABLE' && hold?.sessionBefore === stopped.sessionId, { run: stopped.status, hold });

// Claude's own interactive screen. A first visit to a folder asks whether to trust it, and the panel says how to answer.
const painted = await until(async () => { const t = await screenText(c); return t.trim().length > 40 && t; }, { label: 'Claude on screen', timeoutMs: 60_000 }).catch(() => '');
const hint = 'Claude Code may ask whether to trust this folder';
if (/trust this folder|Quick safety check/i.test(painted)) {
  // Since #122 the panel names the question and answers it in one click, rather than a hint to type.
  const shown = await until(async () => { const t = await panelText(c); return t.includes('Answer: Yes, I trust this folder') && t; }, { label: 'the trust question', timeoutMs: 15_000 }).catch(() => panelText(c));
  ev.check('while Claude asks to trust the folder, the panel says how to answer',
    shown.includes('Claude Code asks whether to trust this folder.') && shown.includes('Answer: Yes, I trust this folder'), shown.slice(0, 300));
  await shoot(c, ev, 'claude-trust');
  // First the easy mistake: Enter on the default, "No, exit". Claude ends, and the panel says what happened and how to go on.
  await c.sleep(1500);
  await pressKey(c, 'Enter');
  const endedText = await until(async () => { const t = await panelText(c); return t.includes('The session ended.') && t; }, { label: 'Claude exits', timeoutMs: 30_000 }).catch(() => panelText(c));
  ev.check('Enter on "No, exit": the panel says "The session ended." and repeats how to answer, next to "Open the terminal again"',
    endedText.includes('The session ended.') && endedText.includes(hint) && endedText.includes('Open the terminal again'), endedText.slice(0, 400));
  await shoot(c, ev, 'claude-exited-at-trust');
  await panelButton(c, 'Open the terminal again');
  await until(async () => /trust this folder|Quick safety check/i.test(await screenText(c)), { label: 'the trust question again', timeoutMs: 60_000 });
  // Then the answer: down to "Yes, I trust this folder", then Enter.
  await c.sleep(1500);
  await pressKey(c, 'ArrowDown');
  await pressKey(c, 'Enter');
} else {
  ev.note('Claude did not ask to trust the folder this time');
}
// Claude's own prompt line, once it is ready for you.
const ready = await until(async () => { const t = await screenText(c); return /for shortcuts/.test(t) && t; }, { label: 'Claude ready for input', timeoutMs: 60_000 }).catch(() => screenText(c));
ev.check('the panel shows Claude Code\'s own session, ready for you ("? for shortcuts")', /for shortcuts/.test(ready), ready.slice(-400));
await shoot(c, ev, 'claude-in-panel');

await panelButton(c, 'Continue');
await until(async () => (await panelLabel(c)) === '', { label: 'panel closes', timeoutMs: 60_000 });
const ended = holdsOf(c, running.id)[0];
ev.check('proof (DB): the terminal\'s session was captured', typeof ended.sessionAfter === 'string' && ended.sessionAfter.length > 0, ended);
ev.note(`session before ${hold?.sessionBefore}, captured ${ended.sessionAfter} (${hold?.sessionBefore === ended.sessionAfter ? 'kept' : 'replaced'} by --resume)`);

// Claude may ask you a question through ask_human (A15 does the same): answer it in the Inbox, keeping everything on this machine.
const deadline = Date.now() + 20 * 60_000;
let done;
for (;;) {
  done = await stepOf(c, missionId);
  if (['AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'BLOCKED'].includes(done.status)) break;
  const question = (await c.approvals(missionId, 'PENDING')).find((a) => a.taskId === done.id && a.kind === 'choice');
  if (question) {
    const option = question.options.find((o) => /brief|written|without/i.test(`${o.label} ${o.description ?? ''}`) && o.id !== 'reject') ?? question.options.find((o) => o.id === 'reject') ?? question.options[0];
    ev.note(`Claude asked "${question.title}"; answered "${option.label}" in the Inbox`);
    await c.decideInInbox(question.title, { filter: 'For me', option: option.label });
  }
  if (Date.now() > deadline) throw new Error('the Claude step did not finish in 20 minutes');
  await sleep(5000);
}
// The first pass after the hold is the continuation; a later one would be the usual retry of an output that failed its contract.
const runs = c.runs(running.id);
const pass = runs[runs.findIndex((r) => r.id === stopped.id) + 1];
const startedAt = pass === undefined ? null : c.sql("SELECT body FROM run_events WHERE run_id = ? AND type = 'run.started'", pass.id).map((r) => JSON.parse(r.body))[0];
ev.check('the step finishes', ['AWAITING_APPROVAL', 'SUCCEEDED'].includes(done.status), { status: done.status, reason: done.statusReason });
ev.check('proof (DB): the continuation ran on Claude Code and took the hold', pass?.profileId === claude.id && holdsOf(c, running.id)[0].consumedAt !== null, pass);
ev.check('proof (DB): the continuation spent no attempt (it ran as the attempt the hold stopped)', startedAt?.attempt === attempts, { before: attempts, continuation: startedAt?.attempt });
ev.check('proof (DB): it resumed the captured session', pass?.sessionId === ended.sessionAfter, { pass: pass?.sessionId, captured: ended.sessionAfter });
if (runs.length > runs.indexOf(pass) + 1) ev.note(`after the continuation, ${runs.length - runs.indexOf(pass) - 1} more pass(es) ran: Claude's output was retried the usual way (${done.attempts} attempts in all)`);
const brief = (await api.get(`/v1/missions/${missionId}/artifacts`)).find((a) => a.taskId === running.id && a.type === 'DesignBrief');
ev.check('proof (API): its DesignBrief was harvested', brief !== undefined, brief?.title);
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
await shoot(c, ev, 'claude-done');
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H3 on Claude proven' }).catch(() => undefined);
// Setup only: back on the fake, so nothing after spends real usage.
await useRuntimes(c, [await fakeProfile(c, 'Hold fake', SCRIPTS.long)]);
c.close(); ev.save();
