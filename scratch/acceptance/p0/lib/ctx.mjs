// Shared context for acceptance scenarios: the daemon client, the window, the
// team lookups and the few UI gestures every scenario repeats.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv, client, until, sleep } from './api.mjs';
import { connect } from './cdp.mjs';
import { ui as makeUi } from './ui.mjs';

export const SCRATCH = process.env.ACCEPTANCE_SCRATCH ?? '/tmp/tdm-p0';
const STATE = `${SCRATCH}/state.json`;

export function readState() { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}; }
export function writeState(patch) { writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2)); }

export async function context() {
  const env = loadEnv(SCRATCH);
  const api = client(env);
  const page = await connect(Number(process.env.CDP_PORT ?? 9333), { timeoutMs: 90_000 });
  const ui = makeUi(page);
  // A freshly launched window takes a while to find its daemon; nothing a scenario does is meaningful before that.
  await page.waitForText('Daemon connected', { timeoutMs: 90_000 });
  // The window on this port must be the one this run launched. Another Tandemise window on the same
  // CDP port (a person's own app, another run) talks to another daemon, and every step would act on it.
  const shownPort = (await page.evaluate('document.body.innerText')).match(/Daemon connected\s*·\s*(\d+)/)?.[1];
  const ownPort = new URL(env.url).port;
  if (shownPort !== undefined && shownPort !== ownPort) {
    page.close();
    throw new Error(`the window on CDP port ${process.env.CDP_PORT ?? 9333} is connected to the daemon on ${shownPort}, not this run's (${ownPort}); another Tandemise window holds that port`);
  }
  const me = (await api.get('/v1/me')).memberships.find((m) => m.workspaceId === env.workspaceId).memberId;
  const team = async () => (await api.get(`/v1/workspaces/${env.workspaceId}/team`)).members;
  const id = async (name) => { const m = (await team()).find((x) => x.name === name); if (!m) throw new Error(`no member ${name}`); return m.id; };

  const ctx = {
    env, api, page, ui, me, team, id, until, sleep,
    tasks: async (missionId) => Object.fromEntries((await api.get(`/v1/missions/${missionId}/tasks`)).map((t) => [t.key, t])),
    task: async (missionId, key) => (await api.get(`/v1/missions/${missionId}/tasks`)).find((t) => t.key === key),
    approvals: async (missionId, status) => (await api.get(`/v1/approvals?missionId=${missionId}${status ? `&status=${status}` : ''}`)).map((v) => v.approval),

    /** Confirms a risky decision if the app asks for it. */
    async confirmIfAsked() {
      await sleep(500);
      await page.evaluate(`(() => { const d = document.querySelector('[role=dialog], dialog[open], .modal'); if (!d) return; const b = [...d.querySelectorAll('button')].filter(b => b.offsetParent && b.innerText.trim() !== 'Cancel'); b[b.length-1]?.click(); })()`);
      await sleep(300);
    },

    /** New mission on a named workflow; the title is the goal, so mode names in it reach the scripted agent. */
    async createMission(title, { workflow = 'P0 acceptance' } = {}) {
      await page.navigate('#/missions/new');
      await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
      await sleep(400);
      await page.fill('What outcome do you want?', title);
      // A request is planned only once it says what done means (P6); these suites are about what happens after.
      await page.fill('Done when', 'The acceptance scenario finishes its steps');
      await page.select('Repository', 'acceptance-project');
      await page.select('Workflow', workflow);
      await page.click('Plan mission …');
      return until(async () => { const h = await page.evaluate('location.hash'); return /#\/missions\/msn_/.test(h) && h.split('/')[2]; }, { label: 'mission page', timeoutMs: 30_000 });
    },

    /** Opens an Inbox item and decides it with the option labelled `option`, optionally on someone's behalf. */
    async decideInInbox(title, { filter = 'Everyone', option = 'Approve', recordingFor, note, confirm = true } = {}) {
      await ui.openItem(title, filter);
      if (option !== 'Approve') await ui.radio(option);
      if (note) {
        const filled = await page.evaluate(`(() => { const t = [...document.querySelectorAll('textarea')].find(x => x.offsetParent); if (!t) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t, ${JSON.stringify(note)}); t.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
        if (!filled) throw new Error('no note field');
      }
      if (recordingFor) await page.select('Recording for', recordingFor);
      const submit = await page.evaluate(`(() => { const b = [...document.querySelectorAll('button')].filter(x => x.offsetParent && !x.closest('[role=dialog]')); const want = ${JSON.stringify(option)}; const cand = b.filter(x => { const t = x.innerText.trim(); return t === want || t === 'Answer: ' + want || t.startsWith('Answer: ' + want); }); const el = cand[cand.length-1]; if (!el) return null; el.scrollIntoView({block:'center'}); el.click(); return el.innerText.trim(); })()`);
      if (!submit) throw new Error(`no submit button for "${option}" on "${title}"`);
      // A decision that opens a dialog of its own (the impact question after "Needs changes") is answered by the scenario.
      if (confirm) await this.confirmIfAsked();
      return submit;
    },

    async approvePlan(missionId, title) {
      await until(async () => (await ctx.approvals(missionId, 'PENDING')).some((a) => a.kind === 'plan'), { label: 'plan approval', timeoutMs: 60_000 });
      await ctx.decideInInbox(`Approve the plan for ${title}`, { filter: 'For me' });
      // A one-task mission on the fake runtime can finish between two polls, so a completed mission counts as started too.
      await until(async () => ['EXECUTING', 'COMPLETE'].includes((await api.get(`/v1/missions/${missionId}`)).mission.status), { label: 'executing', timeoutMs: 30_000 });
      // The mission moving on is not proof the click landed as an approval by
      // me: a race or a stale button could have decided nothing, or decided it
      // for someone else. Assert the record itself rather than infer it.
      const plan = (await ctx.approvals(missionId)).find((a) => a.kind === 'plan');
      if (plan === undefined) throw new Error(`approvePlan: no plan approval found for mission ${missionId} after approving`);
      if (plan.status !== 'APPROVED' || plan.decidedBy !== me) {
        throw new Error(`approvePlan: expected the plan approval APPROVED by ${me}, got status=${plan.status} decidedBy=${plan.decidedBy}`);
      }
    },

    /** Visible text of the topmost dialog whose label starts with `prefix`, or '' when none is open. */
    dialogText: (prefix = '') => page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter((x) => (x.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(prefix)})).pop(); return d ? d.innerText : ''; })()`),
    /** The shell's one-line flash, or ''. */
    flash: () => page.evaluate(`document.querySelector('.flash')?.innerText ?? ''`),
    /** A feed card's text, by task key. */
    cardText: (key) => page.evaluate(`document.querySelector('[data-feed-card=${JSON.stringify(key)}]')?.innerText ?? ''`),

    /**
     * In the open composer ("Request changes to …"): types the note, optionally records it for someone, and sends.
     * Returns what the composer showed before sending and the flash that followed.
     */
    async sendComposer(note, { recordingFor, shot } = {}) {
      await until(async () => (await ctx.dialogText('Request changes to')).includes('What should change?'), { label: 'composer', timeoutMs: 10_000 });
      await page.fill('What should change?', note);
      if (recordingFor) await page.select('Recording for', recordingFor);
      const composer = await ctx.dialogText('Request changes to');
      const bodyWhileOpen = await page.text('body');
      if (shot) await page.screenshot(shot);
      // The composer can sit on top of a task drawer whose footer has its own "Request changes": send from the composer itself.
      const sent = await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].filter((x) => (x.getAttribute('aria-label') ?? '').startsWith('Request changes to')).pop(); const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Request changes' && !x.disabled); if (!b) return false; b.click(); return true; })()`);
      if (!sent) throw new Error('composer has no enabled Request changes button');
      const flash = await until(async () => (await ctx.flash()) || ((await ctx.dialogText('Round ')) ? '(impact dialog)' : ''), { label: 'flash or impact dialog after sending', timeoutMs: 10_000 }).catch(() => '');
      return { composer, bodyWhileOpen, flash };
    },

    /** Opens the composer from a feed card's "Request changes" and sends the note. */
    async requestChangesOnCard(missionId, cardKey, note, opts = {}) {
      await page.navigate(`#/missions/${missionId}`); await sleep(1500);
      const opened = await until(() => page.evaluate(`(() => { const card = document.querySelector('[data-feed-card=${JSON.stringify(cardKey)}]'); const b = card && [...card.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Request changes'); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`), { label: `Request changes on card ${cardKey}`, timeoutMs: 15_000 });
      if (!opened) throw new Error(`no Request changes on card ${cardKey}`);
      return ctx.sendComposer(note, opts);
    },

    /** Opens a task's drawer from the Plan tab. */
    async openTaskDrawer(missionId, taskTitle) {
      await page.navigate(`#/missions/${missionId}/plan`); await sleep(1500);
      const ok = await until(() => page.evaluate(`(() => { const b = [...document.querySelectorAll('button.taskcard')].find((x) => x.querySelector('.taskcard__title')?.innerText.trim() === ${JSON.stringify(taskTitle)}); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; })()`), { label: `plan card ${taskTitle}`, timeoutMs: 15_000 });
      if (!ok) throw new Error(`no plan card "${taskTitle}"`);
      await until(async () => (await ctx.dialogText(taskTitle)) !== '', { label: `drawer ${taskTitle}`, timeoutMs: 10_000 });
      await sleep(600);
    },

    /** Mission header action ("Pause", "Resume"). */
    async missionAction(missionId, label) {
      if (!(await page.evaluate('location.hash')).startsWith(`#/missions/${missionId}`)) { await page.navigate(`#/missions/${missionId}`); await sleep(1500); }
      await until(() => page.evaluate(`[...document.querySelectorAll('button')].some((b) => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)})`), { label: `header ${label}`, timeoutMs: 15_000 });
      await page.click(label);
    },

    /** A staffing entry for one role, merged over what is there. */
    staff: (patch) => api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, patch),
    feedback: async (taskId) => api.get(`/v1/tasks/${taskId}/feedback`),
    events: async (missionId) => { const e = await api.get(`/v1/missions/${missionId}/events?limit=1000`); return e.events ?? e; },
    /** Every prompt the scripted agent was given, oldest first. */
    prompts: () => (existsSync(`${SCRATCH}/prompts`) ? readdirSync(`${SCRATCH}/prompts`).sort().map((f) => readFileSync(`${SCRATCH}/prompts/${f}`, 'utf8')) : []),
    /** Read-only SQL against the daemon's database, for records the API does not expose (runs, run inputs). */
    sql(query, ...params) {
      const db = new DatabaseSync(`${env.home}/tandemise.db`, { readOnly: true });
      try { return db.prepare(query).all(...params); } finally { db.close(); }
    },
    runs: (taskId) => ctx.sql('SELECT id, attempt, status, round, purpose, external_session_id AS sessionId, runtime_profile_id AS profileId, started_at AS startedAt, error_code AS errorCode, error_message AS errorMessage FROM runs WHERE task_id = ? ORDER BY started_at, rowid', taskId),

    close() { page.close(); },
  };
  return ctx;
}
