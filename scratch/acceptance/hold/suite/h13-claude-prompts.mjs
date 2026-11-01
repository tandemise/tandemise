// H13, on the real Claude Code (#102): holding a code step (write and shell
// granted, so its headless run is in bypassPermissions) opens Claude Code
// without the "Bypass Permissions mode" warning, and the folder-trust question
// is answered from the panel with one click. Releases at the end, so the
// scenario spends only the start of one run. Skipped with --skip-claude.
//
// Set ACCEPTANCE_CLAUDE_CONFIG_DIR to a Claude config dir of its own (signed
// in): the trust answer is then recorded there, never in your own config.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { newMission, holdFromCard, holdsOf, panelButton, panelLabel, panelText, pressKey, screenText, waitStep, shoot } from '../common.mjs';

const c = await context();
const { api, until } = c;
const ev = new Evidence('H13-claude-prompts', 'A held code step on the real Claude Code: no bypass warning, trust answered in one click');
const CODER = 'Code agent';
const KEY = 'build';

let claude = (await api.get('/v1/runtimes')).map((r) => r.profile ?? r).find((p) => p.adapterId === 'claude-code');
if (!claude) {
  claude = await api.post('/v1/runtimes', { adapterId: 'claude-code', name: 'Claude Code', workspaceId: null, executablePath: `${process.env.HOME}/.local/bin/claude`, settings: process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR ? { configDir: process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR } : {}, maxConcurrent: 1, enabled: true });
  claude = claude.profile ?? claude;
}
// Setup: a developer agent on Claude Code (write and shell are the development role's defaults).
const existing = (await c.team()).find((m) => m.name === CODER);
if (!existing) await api.post(`/v1/workspaces/${c.env.workspaceId}/members`, { kind: 'agent', name: CODER, reportsTo: c.me, roleIds: ['development'], runtimeProfileIds: [claude.id] });
ev.note(`setup: ${CODER} runs on Claude Code${process.env.ACCEPTANCE_CLAUDE_CONFIG_DIR ? ' with its own config dir' : ''}`);

const missionId = await newMission(c, `Notes line on Claude ${Date.now().toString(36)}`, 'Hold code');
const running = await waitStep(c, missionId, (t) => t.status === 'RUNNING' && t.latestRun?.status === 'RUNNING', 'Claude running', { key: KEY, timeoutMs: 120_000 });
await until(() => c.runs(running.id).at(-1)?.sessionId, { label: 'Claude session id', timeoutMs: 120_000, everyMs: 300 });
const headless = c.sql("SELECT body FROM run_events WHERE run_id = ? AND type = 'run.started'", c.runs(running.id).at(-1).id).map((r) => JSON.parse(r.body))[0];
ev.note(`the headless run started: ${JSON.stringify(headless).slice(0, 200)}`);
await holdFromCard(c, missionId, KEY);

// Everything Claude draws until it is ready for input, so a warning shown and answered in between is still seen.
// Ready can come first: after H3-claude the config dir may trust the folder already, and an accept-edits
// session shows "accept edits on" where a default one shows "? for shortcuts".
const seen = [];
const look = async () => { const t = await screenText(c); seen.push(t); return t; };
const first = await until(async () => { const t = await look(); return /for shortcuts|accept edits on|trust this folder|Quick safety check|Bypass Permissions/i.test(t) && t; }, { label: 'Claude on screen', timeoutMs: 60_000 });

if (/trust this folder|Quick safety check/i.test(first)) {
  const shown = await until(async () => { const t = await panelText(c); return t.includes('Answer: Yes, I trust this folder') && t; }, { label: 'the one-click answer', timeoutMs: 10_000 }).catch(() => panelText(c));
  ev.check('Claude asks to trust the folder, and the panel offers "Answer: Yes, I trust this folder"', shown.includes('Answer: Yes, I trust this folder'), shown.slice(0, 400));
  const live = await c.page.evaluate("document.querySelector('.terminal-panel__prompt-region')?.getAttribute('role') ?? ''");
  ev.check('the question is announced in a status region', live === 'status', live);
  await shoot(c, ev, 'trust-question-with-answer');
  await panelButton(c, 'Answer: Yes, I trust this folder');
} else {
  ev.note('Claude did not ask to trust the folder (the config dir trusts it already)');
}

// A config dir that has never met the Claude in Chrome extension asks about it once. Its default
// ("No, keep browser tools off") is safe, so the panel offers nothing; a person presses Esc.
const next = await until(async () => { const t = await look(); return /for shortcuts|accept edits on|browser tools off/i.test(t) && !/trust this folder/i.test(t) && t; }, { label: 'Claude past the trust question', timeoutMs: 60_000 }).catch(() => look());
if (/browser tools off/i.test(next)) {
  ev.note('Claude asked once about the Claude in Chrome extension (a fresh config dir); Esc keeps browser tools off');
  await c.sleep(1000);
  await pressKey(c, 'Escape');
}
const ready = await until(async () => { const t = await look(); return /for shortcuts|accept edits on/i.test(t) && !/trust this folder|browser tools off/i.test(t) && t; }, { label: 'Claude ready for input', timeoutMs: 60_000 }).catch(() => look());
ev.check('Claude Code is ready for you after one click', /for shortcuts|accept edits on/i.test(ready), ready.slice(-500));
ev.check('it never showed the Bypass Permissions warning', !seen.some((t) => /Bypass Permissions mode/i.test(t)), seen.find((t) => /Bypass/i.test(t))?.slice(0, 300));
ev.check('it runs in accept-edits mode, with the step\'s shell tools allowed by rule', /accept edits on/i.test(ready), ready.slice(-300));
const after = await panelText(c);
ev.check('the one-click answer is gone once answered', !after.includes('Answer: Yes'), after.slice(0, 300));
await shoot(c, ev, 'claude-ready');

await panelButton(c, 'Release');
await until(async () => (await panelLabel(c)) === '', { label: 'panel closes', timeoutMs: 60_000 });
ev.check('proof (DB): the hold was released', holdsOf(c, running.id)[0]?.ending === 'released', holdsOf(c, running.id)[0]);
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: H13 proven' }).catch(() => undefined);
c.close(); ev.save();
