// Hold and interact: the domain half
// (docs/superpowers/specs/2026-10-30-hold-and-interact-design.md).
//
//   npm run build && node scratch/hold-check.mjs
const D = await import('@tandemise/domain');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

section('pure: the HELD status');
{
  check('HELD is a task status', D.TASK_STATUSES.includes('HELD'));
  check('HELD is active', D.ACTIVE_TASK_STATUSES.includes('HELD'));
  check('HELD is parked, so it does not count against the concurrency ceiling', D.isTaskParked('HELD'));
  check('HELD is not finished', !D.isTaskFinished('HELD'));
  check('interactive_resume is a runtime capability', D.RUNTIME_CAPABILITIES.includes('interactive_resume'));
  check('holdable statuses', JSON.stringify(D.HOLDABLE_TASK_STATUSES) === JSON.stringify(['READY', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL']));
  check('the hold events are in the semantic timeline',
    D.isSemanticEvent({ type: 'task.held' }) && D.isSemanticEvent({ type: 'task.hold_ended' }));
}

section('pure: holdRefusal');
{
  const task = (extra = {}) => ({ title: 'Build the page', executor: 'agent', status: 'RUNNING', ...extra });
  const input = (extra = {}, t = {}) => ({
    task: task(t), mission: {}, trial: false, liveRun: true, outputUnderReview: true,
    runtimeHasInteractive: true, openHold: null, holderName: null, ...extra,
  });
  const r = (extra, t) => D.holdRefusal(input(extra, t));
  check('a done step', r({}, { status: 'SUCCEEDED' }) === 'This step is done; request changes instead.', r({}, { status: 'SUCCEEDED' }));
  check('a person\'s step', r({}, { executor: 'human' }) === "'Build the page' is a person's step; there is no agent to hold.", r({}, { executor: 'human' }));
  check('an eval trial', r({ trial: true }) === "Eval trials can't be held.");
  check('running but the stream ended', r({ liveRun: false }) === "It's checking its work. You can hold it once that's done.");
  check('a runtime with no interactive mode', r({ runtimeHasInteractive: false }) === 'Only Claude Code steps can be held for now.');
  const at = new Date(2026, 9, 30, 9, 5, 0).toISOString();
  const hold = { id: 'hld_x', startedAt: at, endedAt: null };
  check('already held, by name and time', r({ openHold: hold, holderName: 'Ana' }, { status: 'HELD' }) === 'Held by Ana since 09:05.', r({ openHold: hold, holderName: 'Ana' }, { status: 'HELD' }));
  check('a held step whose hold is ending says so', r({}, { status: 'HELD' }) === 'Its hold is ending; it goes back to the queue in a moment.', r({}, { status: 'HELD' }));
  check('a start approval comes first', r({ outputUnderReview: false }, { status: 'AWAITING_APPROVAL' }) === 'Approve the start first, then you can hold it.');
  for (const status of D.HOLDABLE_TASK_STATUSES) check(`${status} is holdable`, r({}, { status }) === null, r({}, { status }));
  check('output under review is holdable', r({ outputUnderReview: true }, { status: 'AWAITING_APPROVAL' }) === null);
  check('a pending step is refused with some reason', typeof r({}, { status: 'PENDING' }) === 'string');
}

section('pure: nowLine and describeHoldEnd');
{
  const tool = (name, input) => ({ type: 'tool.started', tool: name, inputSummary: JSON.stringify(input) });
  check('nothing yet', D.nowLine(null) === 'Starting…');
  check('an edit', D.nowLine(tool('Edit', { file_path: 'src/app/page.tsx', old_string: 'a' })) === 'Editing src/app/page.tsx');
  check('a command', D.nowLine(tool('Bash', { command: 'npm test' })) === 'Running npm test');
  check('a read', D.nowLine(tool('Read', { file_path: 'a/b.ts' })) === 'Reading a/b.ts');
  const wt = '/tmp/home/missions/m/worktrees/design-1';
  check('a path inside the worktree reads relative to it', D.nowLine(tool('Edit', { file_path: `${wt}/src/app/page.tsx` }), wt) === 'Editing src/app/page.tsx');
  check('a changed file inside the worktree too', D.nowLine({ type: 'file.changed', path: `${wt}/.tandemise/out/DesignBrief.md`, change: 'add' }, `${wt}/`) === 'Editing .tandemise/out/DesignBrief.md');
  check('a path outside the worktree is left whole', D.nowLine(tool('Read', { file_path: '/etc/hosts' }), wt) === 'Reading /etc/hosts');
  check('a sibling that only shares the prefix is left whole', D.nowLine(tool('Read', { file_path: `${wt}-2/x.ts` }), wt) === `Reading ${wt}-2/x.ts`);
  check('a tandemise tool never shows its raw name', D.nowLine(tool('mcp__tandemise__x', {})) === 'Using a Tandemise tool');
  const long = 'x'.repeat(200);
  const m = D.nowLine({ type: 'message', text: long });
  check('long text is cut to 80', m.length === 80 && m.endsWith('…') && m === `${'x'.repeat(79)}…`, m.length);
  check('short text is kept', D.nowLine({ type: 'message', text: 'Looking' }) === 'Looking');
  const hold = (extra) => ({ ending: 'continued', diffStat: null, ...extra });
  check('describeHoldEnd names the outcome', /continu/i.test(D.describeHoldEnd(hold({}))) && /releas/i.test(D.describeHoldEnd(hold({ ending: 'released' }))));
}

section('persistence: migration 022 and the hold repository');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Container, compose } = await import('@tandemise/kernel');
  const P = await import('@tandemise/persistence');
  const container = new Container();
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-hold-'));
  compose(container, P.persistenceModule({ path: join(dir, 'h.db') }));
  const db = container.resolve(P.DATABASE);
  db.handle.exec(`
    INSERT INTO workspaces (id,name,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
      VALUES ('ws1','W','balanced','{}','{}','balanced','{}','2026-01-01','2026-01-01');
    INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
      VALUES ('m1','ws1','T','G','[]','[]','EXECUTING','balanced','p','2026-01-01','2026-01-01');
    INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
      VALUES ('t1','m1','k1','T1','O','design','[]','[]','[]','{}','{}','{}','RUNNING','2026-01-01','2026-01-01');
  `);
  let held = null;
  try { db.handle.prepare("UPDATE mission_tasks SET status = 'HELD' WHERE id = 't1'").run(); } catch (e) { held = String(e.message); }
  check('a task row can be written with status HELD', held === null, held);
  const sql = db.handle.prepare("SELECT sql FROM sqlite_master WHERE name = 'mission_tasks'").get().sql;
  check("sqlite_master for mission_tasks contains 'HELD'", sql.includes("'HELD'"));

  const repo = container.resolve(P.TASK_HOLD_REPOSITORY);
  const hold = (id, extra = {}) => ({
    id, taskId: 't1', missionId: 'm1', heldBy: 'mem1', fromStatus: 'RUNNING', runtimeProfileId: 'rp1',
    sessionBefore: 's-1', sessionAfter: null, ptyPid: null, startedAt: '2026-01-02T00:00:00.000Z',
    endedAt: null, endedBy: null, ending: null, consumedAt: null, diffStat: null, dir: '/h/hld1', ...extra,
  });
  repo.create(hold('hld1'));
  check('openFor finds the open hold', repo.openFor('t1')?.id === 'hld1');
  let second = null;
  try { repo.create(hold('hld2')); } catch (e) { second = String(e.message); }
  check('a second open hold for the same task throws', second !== null && /UNIQUE/i.test(second), second);
  check('no pending continuation while open', repo.pendingContinuation('t1') === undefined);

  const stat = { files: 2, insertions: 5, deletions: 1 };
  repo.update('hld1', { endedAt: '2026-01-02T01:00:00.000Z', endedBy: 'mem1', ending: 'continued', sessionAfter: 's-2', diffStat: stat });
  check('openFor is empty once ended', repo.openFor('t1') === undefined);
  const pending = repo.pendingContinuation('t1');
  check('pendingContinuation returns the ended continued hold', pending?.id === 'hld1' && pending.sessionAfter === 's-2'
    && JSON.stringify(pending.diffStat) === JSON.stringify(stat), pending);
  repo.update('hld1', { consumedAt: '2026-01-02T02:00:00.000Z' });
  check('pendingContinuation returns nothing once consumedAt is set', repo.pendingContinuation('t1') === undefined);
  repo.create(hold('hld3', { startedAt: '2026-01-03T00:00:00.000Z' }));
  check('a new hold may open after the first ended', repo.openFor('t1')?.id === 'hld3');
  repo.update('hld3', { endedAt: '2026-01-03T01:00:00.000Z', ending: 'released' });
  check('a released hold is never a pending continuation', repo.pendingContinuation('t1') === undefined);
  check('listByMission lists in start order', repo.listByMission('m1').map((h) => h.id).join() === 'hld1,hld3');
  check('get round-trips', repo.get('hld1')?.consumedAt === '2026-01-02T02:00:00.000Z');
  db.close();
}

section('runtime: interactive invocations');
{
  const { ids, nullLogger } = await import('@tandemise/shared');
  const { buildInvocation, buildInteractiveInvocation, ClaudeCodeAdapter } = await import('@tandemise/runtime-claude');
  const { FakeRuntimeAdapter } = await import('@tandemise/runtime-generic');
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const now = new Date().toISOString();
  const profile = (adapterId, settings = {}) => ({
    id: ids.runtimeProfile(), workspaceId: ids.workspace(), adapterId, name: 'p', executablePath: null, args: [],
    settings, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now, updatedAt: now,
  });
  const req = (p, extra = {}) => ({
    runId: ids.run(), profile: p, prompt: 'do it', workingDirectory: tmpdir(), grants: ['filesystem.write'], allowedRoots: [],
    mcpConfigPath: '/tmp/mcp.json', maxWallTimeMs: 1000, signal: new AbortController().signal, log: nullLogger, ...extra,
  });
  const after = (args, flag) => args[args.indexOf(flag) + 1];

  const p = profile('claude-code', { configDir: '/tmp/cfg-x' });
  const r = req(p);
  const opts = { sessionFile: '/tmp/some dir/it\'s.session', initialPrompt: 'start here' };
  const headless = buildInvocation(r, 'sess_1').args;
  const inter = buildInteractiveInvocation(r, 'sess_1', opts);
  const a = inter.args;
  check('interactive args have no -p, stream-json or --verbose',
    !a.includes('-p') && !a.includes('stream-json') && !a.includes('--output-format') && !a.includes('--verbose'), a);
  check('interactive resumes the session', after(a, '--resume') === 'sess_1');
  for (const f of ['--permission-mode', '--mcp-config', '--setting-sources', '--allowed-tools']) {
    check(`${f} matches the headless value`, after(a, f) === after(headless, f), [after(a, f), after(headless, f)]);
  }
  check('--strict-mcp-config is present', a.includes('--strict-mcp-config'));
  const settings = JSON.parse(after(a, '--settings'));
  const hook = settings.hooks.SessionStart[0].hooks[0];
  check('SessionStart hook runs the daemon\'s own runtime as Node, never a node off PATH, naming the session file',
    hook.type === 'command' && hook.command.startsWith(`ELECTRON_RUN_AS_NODE=1 '${process.execPath}' -e '`) && hook.command.includes('/tmp/some dir/it'), hook);
  // The hook command really works through a shell, quotes and spaces in the path included.
  const dir = mkdtempSync(join(tmpdir(), 'hold-rt-'));
  const sf = join(dir, "it's here.session");
  const hookCmd = JSON.parse(after(buildInteractiveInvocation(r, null, { sessionFile: sf, initialPrompt: null }).args, '--settings'))
    .hooks.SessionStart[0].hooks[0].command;
  await new Promise((done) => {
    // With no PATH at all: a packaged app may have no `node` to find.
    const sh = spawn('/bin/sh', ['-c', hookCmd], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '' } });
    sh.stdin.end(JSON.stringify({ session_id: 'sess_hook', hook_event_name: 'SessionStart' }));
    sh.on('close', done);
  });
  check('the hook writes session_id to the session file, with nothing on PATH', existsSync(sf) && readFileSync(sf, 'utf8') === 'sess_hook');
  // #117: what the person types is kept, so a retry after the hold never undoes it.
  const pf = join(dir, "person's said.jsonl");
  const withPrompts = JSON.parse(after(buildInteractiveInvocation(r, null, { sessionFile: sf, initialPrompt: null, promptsFile: pf }).args, '--settings'));
  check('no promptsFile, no UserPromptSubmit hook', JSON.parse(after(buildInteractiveInvocation(r, null, { sessionFile: sf, initialPrompt: null }).args, '--settings')).hooks.UserPromptSubmit === undefined);
  const promptCmd = withPrompts.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? '';
  for (const prompt of ['Make it "System follows your desktop setting." on Linux', "it's fine\nsecond line"]) {
    await new Promise((done) => {
      const sh = spawn('/bin/sh', ['-c', promptCmd], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '' } });
      sh.stdin.end(JSON.stringify({ session_id: 'sess_hook', hook_event_name: 'UserPromptSubmit', prompt }));
      sh.on('close', done);
    });
  }
  const said = existsSync(pf) ? readFileSync(pf, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check('the UserPromptSubmit hook appends each message the person sends, with the time, nothing on PATH',
    said.length === 2 && said[0].prompt === 'Make it "System follows your desktop setting." on Linux' && said[1].prompt === "it's fine\nsecond line"
      && !Number.isNaN(Date.parse(said[0].at)), said);
  const whole = new ClaudeCodeAdapter().interactive('sess_1', req({ ...p, executablePath: process.execPath }), opts);
  check('env carries CLAUDE_CONFIG_DIR and TERM', whole.env.CLAUDE_CONFIG_DIR === '/tmp/cfg-x' && whole.env.TERM === 'xterm-256color', whole.env);
  check('cwd is the worktree and sessionFile is passed through',
    whole.cwd === tmpdir() && whole.sessionFile === opts.sessionFile && whole.file === process.execPath && whole.args.includes('--resume'));
  const fresh = buildInteractiveInvocation(r, null, opts).args;
  check('a fresh session passes the initial prompt last, without --resume',
    fresh.at(-1) === 'start here' && !fresh.includes('--resume'), fresh.slice(-3));
  check('adapter declares interactive_resume', new ClaudeCodeAdapter().baseCapabilities.includes('interactive_resume'));

  const fake = new FakeRuntimeAdapter();
  check('the fake declares interactive_resume', fake.baseCapabilities.includes('interactive_resume'));
  const fsf = join(dir, 'fake.session');
  const fpf = join(dir, 'fake-said.jsonl');
  const inv = fake.interactive('abc', req(profile('fake'), { workingDirectory: dir }), { sessionFile: fsf, initialPrompt: null, promptsFile: fpf });
  const out = await new Promise((done) => {
    const c = spawn(inv.file, inv.args, { cwd: inv.cwd, env: { ...process.env, ...inv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; });
    c.stdin.write('hello\nwrite a.txt\n/exit\n');
    c.on('close', (code) => done({ buf, code }));
  });
  check('the fake echoes input, writes files and exits 0',
    out.code === 0 && out.buf.includes('Fake session abc') && out.buf.includes('> hello') && out.buf.includes('> write a.txt')
    && existsSync(join(dir, 'a.txt')), out);
  check('the fake records its session id', /^fake-session-/.test(readFileSync(fsf, 'utf8')));
  const fakeSaid = existsSync(fpf) ? readFileSync(fpf, 'utf8').trim().split('\n').map((l) => JSON.parse(l).prompt) : [];
  check('the fake records what the person typed, not /exit', fakeSaid.join('|') === 'hello|write a.txt', fakeSaid);
  rmSync(dir, { recursive: true, force: true });

  const { RuntimeManager, RuntimeRegistry } = await import('@tandemise/runtimes-core');
  const mgr = new RuntimeManager({ registry: new RuntimeRegistry([fake, { ...fake, id: 'no-interactive', interactive: undefined }]) });
  let refusal;
  try { mgr.interactive(profile('no-interactive'), null, req(profile('no-interactive')), opts); } catch (e) { refusal = e; }
  check('the manager refuses an adapter without interactive support',
    refusal?.code === 'CONFLICT' && /Only Claude Code steps can be held/.test(refusal.message), refusal);
}

// ------------------------------------------------------------------ engine
async function engineHarness(HOME, bindExtra = () => {}, moduleOptions = {}) {
  const { mkdirSync } = await import('node:fs');
  const app = await import('@tandemise/application');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const A = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');

  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'hold-check' } });
  const container = new Container();
  compose(
    container,
    persistenceTokens.persistenceModule({ path: paths.db, logger: log }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo', ...moduleOptions }),
  );
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  bindExtra(container, app);
  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    feedback: container.resolve(app.FEEDBACK_REPOSITORY),
    holds: container.resolve(app.TASK_HOLD_REPOSITORY),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  return { services, scheduler, repo, paths, until, container, app };
}

section('engine: stopping into a hold and continuing from it');
{
  const { mkdtempSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids, nullLogger } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const { RUNTIME_MANAGER } = await import('@tandemise/runtimes-core');
  const { APPROVAL_FACTORY } = await import('@tandemise/policy');
  const keepAlive = setInterval(() => {}, 1000);
  const h = await engineHarness(mkdtempSync(join(tmpdir(), 'thold-')));
  const { app } = h;
  const now = () => systemClock.now();

  const FB_ALL = '^\\d+\\. (fb_[0-9a-z]{20}) \\(';
  const brief = ({ headline = 'Onboarding designed', changed = null } = {}) => [
    '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', `  headline: ${headline}`,
    ...(changed === null ? [] : ['  changed:', ...changed.flatMap((c) => [`    - what: ${JSON.stringify(c.what)}`, `      feedback: ${JSON.stringify(c.feedback)}`])]),
    'flows:', '  - onboarding', '---', '', '# Onboarding', '', `${headline}.`, '',
  ].join('\n');
  const IN_ROUND = { promptIncludes: 'Feedback to address' };
  const write = (content, when) => ({ kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content, ...(when ? { when } : {}) });
  const cited = () => write(brief({ headline: 'Onboarding, shorter', changed: [{ what: 'Shortened the intro', feedback: '{{fb}}' }] }), IN_ROUND);
  const promptFile = { kind: 'write-file', path: 'prompts/{{runId}}.txt', content: '{{prompt}}' };
  const session = (id) => ({ kind: 'checkpoint', sessionId: id, label: 'session.init' });
  const done = { kind: 'complete', summary: 'done' };
  const profile = (name, steps) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
    settings: { script: { steps, resume: 'ok', captures: { fb: FB_ALL } } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const P = {
    slow: profile('slow', [session('sess-slow'), promptFile, write(brief()), { kind: 'delay', ms: 30000 }, done]),
    quick: profile('quick', [session('sess-quick'), promptFile, write(brief()), { kind: 'delay', ms: 0 }, done]),
    a: profile('a', [promptFile, write(brief()), cited(), done]),
    b: profile('b', [promptFile, write(brief()), cited(), done]),
    a5: profile('a5', [session('sess-a5'), promptFile, write(brief()), done]),
    a6: profile('a6', [session('sess-a6'), promptFile, write(brief()), done]),
    // Writes nothing: whatever it hands in is what the person left in the out folder.
    c: profile('c', [promptFile, done]),
  };
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Hold' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const agent = (name, profileIds) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: ['design'], runtimeProfileIds: profileIds }).id;
  const AG = {
    slow: agent('Slow', [P.slow]), quick: agent('Quick', [P.quick]),
    ab: agent('Two runtimes', [P.a, P.b]), a5b: agent('Moves runtimes', [P.a5, P.b]),
    ba6: agent('Prefers its session', [P.b, P.a6]), c: agent('Hands in', [P.c]),
  };

  let seq = 0;
  const addTask = async (agentId, extra = {}) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Design onboarding', title: `H${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const id = h.repo.tasks.add({
      id: ids.task(), missionId: mission.id, key: 'doc', title: 'doc', objective: 'o', roleId: 'design',
      dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
      retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
      status: 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
      executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: { assignees: [agentId] },
      createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null, ...extra,
    }).id;
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, dir, id };
  };
  const task = (id) => h.repo.tasks.get(id);
  const runsOf = (id) => [...h.repo.runs.listByTask(id)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const promptOf = (dir, run) => { const p = join(dir, 'prompts', `${run?.id}.txt`); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
  const resumedFrom = (run) => h.repo.events.listByRun(run.id).find((e) => e.body.type === 'checkpoint' && e.body.label === 'session.resumed')?.body.externalSessionId ?? null;
  const idle = (id) => !h.scheduler.activeTaskIds().includes(id) && !h.repo.runs.listByTask(id).some((r) => r.status === 'RUNNING' || r.status === 'STARTING');
  const settled = (id) => h.until(() => idle(id) && ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status), 20000);
  const hold = (t, extra = {}) => {
    const record = {
      id: `hld_${ids.task()}`, taskId: t.id, missionId: t.mission.id, heldBy: owner, fromStatus: 'RUNNING', runtimeProfileId: P.b,
      sessionBefore: 's1', sessionAfter: 's2', ptyPid: null, startedAt: now(), endedAt: now(), endedBy: owner, ending: 'continued',
      consumedAt: null, diffStat: null, dir: join(h.paths.root, 'holds', t.id), ...extra,
    };
    h.repo.holds.create(record);
    return record;
  };
  const holdsOf = (t) => h.repo.holds.listByMission(t.mission.id).filter((x) => x.taskId === t.id);

  // ---- 1. A running task is held: the run ends RESUMABLE, the task stays HELD (Review Focus 5)
  const one = await addTask(AG.slow);
  await h.until(() => runsOf(one.id).some((r) => r.status === 'RUNNING' && r.externalSessionId === 'sess-slow'));
  h.repo.tasks.update(one.id, { status: 'HELD', statusReason: 'Held by you.' });
  h.scheduler.cancelTask(one.id, new app.TaskHeld());
  await h.until(() => idle(one.id));
  const heldRun = runsOf(one.id).at(-1);
  check('1: the held run ends RESUMABLE, keeping its session', heldRun?.status === 'RESUMABLE' && heldRun.externalSessionId === 'sess-slow', heldRun);
  check('1: the task stays HELD, not READY or CANCELLED', task(one.id).status === 'HELD', task(one.id).status);
  check('1: isTaskHeld reads the abort reason', (() => { const c = new AbortController(); c.abort(new app.TaskHeld()); return app.isTaskHeld(c.signal) && !app.isTaskHeld(new AbortController().signal); })());
  for (let i = 0; i < 5; i++) await h.scheduler.tick();
  check('1: the mission stays EXECUTING across ticks', h.repo.missions.get(one.mission.id).status === 'EXECUTING', h.repo.missions.get(one.mission.id));
  check('1: a HELD task is never dispatched', task(one.id).status === 'HELD' && runsOf(one.id).length === 1, runsOf(one.id).map((r) => r.status));

  // ---- 2. The hold lands as the stream ends (Review Focus 1)
  const manager = h.container.resolve(RUNTIME_MANAGER);
  const triggers = new Map(); // taskId -> the event type the hold lands on
  const original = manager.start.bind(manager);
  manager.start = (request) => {
    const inner = original(request);
    const taskId = h.repo.runs.get(request.runId)?.taskId;
    const on = triggers.get(taskId);
    if (on === undefined) return inner;
    return (async function* () {
      for await (const event of inner) {
        if (event.type === on && triggers.has(taskId)) {
          triggers.delete(taskId);
          h.repo.tasks.update(taskId, { status: 'HELD', statusReason: 'Held by you.' });
          h.scheduler.cancelTask(taskId, new app.TaskHeld());
        }
        yield event;
      }
    })();
  };
  for (const on of ['checkpoint', 'completed']) {
    const two = await addTask(AG.quick);
    triggers.set(two.id, on);
    await h.until(() => !triggers.has(two.id) && idle(two.id));
    const s = task(two.id).status;
    check(`2 (${on}): the task is HELD or the pass settled, never READY or CANCELLED`,
      !triggers.has(two.id) && !['READY', 'CANCELLED', 'RUNNING'].includes(s) && (s === 'HELD' || ['SUCCEEDED', 'AWAITING_APPROVAL', 'FAILED'].includes(s)), { s, reason: task(two.id).statusReason });
  }
  manager.start = original;

  // ---- control: without a hold the two-runtime agent runs on runtime A
  const ctl = await addTask(AG.ab);
  await settled(ctl.id);
  check('control: with no hold the agent runs on its first runtime (A)', runsOf(ctl.id)[0]?.runtimeProfileId === P.a, runsOf(ctl.id)[0]);

  // ---- 3. A pending continuation resumes the captured session on the hold's profile, spending no attempt
  const three = await addTask(AG.ab, { status: 'HELD', attempts: 1 });
  const h3 = hold(three);
  h.repo.tasks.update(three.id, { status: 'READY', statusReason: null });
  await settled(three.id);
  const [r3] = runsOf(three.id);
  check('3: the next run is on profile B and resumes s2', r3?.runtimeProfileId === P.b && resumedFrom(r3) === 's2' && r3.externalSessionId === 's2', { r3, resumed: r3 && resumedFrom(r3) });
  check('3: the task attempts is unchanged', task(three.id).attempts === 1, task(three.id).attempts);
  check('3: the hold is consumed', h.repo.holds.get(h3.id)?.consumedAt != null, h.repo.holds.get(h3.id));
  check('3: the prompt starts with the continuation prompt', promptOf(three.dir, r3).startsWith(app.CONTINUATION_PROMPT), promptOf(three.dir, r3).slice(0, 300));
  check('3: CONTINUATION_PROMPT is the spec text', app.CONTINUATION_PROMPT === 'A person held this task and worked with you directly in this session. Their changes are in the worktree. Continue the task from where things stand now and finish it.');
  check('3: the pass settles normally', task(three.id).status === 'SUCCEEDED', { s: task(three.id).status, r: task(three.id).statusReason });

  // ---- 4. A note left while HELD is queued and delivered once by the continuation (Review Focus 4)
  const four = await addTask(AG.ab, { status: 'HELD', attempts: 1 });
  const NOTE = 'Make the intro one line ZX-NOTE-4';
  const given = h.services.feedback.give(caller, four.id, { text: NOTE });
  check('4: a note on a HELD task is queued', h.repo.feedback.get(given.feedback.id)?.status === 'queued', h.repo.feedback.get(given.feedback.id));
  for (let i = 0; i < 3; i++) await h.scheduler.tick();
  check('4: the sweep leaves it queued while the task is HELD', h.repo.feedback.get(given.feedback.id)?.status === 'queued', h.repo.feedback.get(given.feedback.id)?.status);
  hold(four);
  h.repo.tasks.update(four.id, { status: 'READY', statusReason: null });
  await settled(four.id);
  const [r4] = runsOf(four.id);
  const p4 = promptOf(four.dir, r4);
  check('4: the continuation prompt carries the note exactly once', p4.startsWith(app.CONTINUATION_PROMPT) && p4.split(NOTE).length === 2, p4.slice(0, 600));
  check('4: the note was delivered (in the round, then addressed)', ['in_round', 'addressed'].includes(h.repo.feedback.get(given.feedback.id)?.status) && runsOf(four.id).length === 1,
    { fb: h.repo.feedback.get(given.feedback.id)?.status, runs: runsOf(four.id).map((r) => r.purpose) });

  // ---- released: the captured session is resumed on the hold's profile with the normal prompt
  const rel = await addTask(AG.ab, { status: 'HELD', attempts: 1 });
  const hr = hold(rel, { ending: 'released', sessionAfter: 's3' });
  h.repo.tasks.update(rel.id, { status: 'READY', statusReason: null });
  await settled(rel.id);
  const [rr] = runsOf(rel.id);
  check('released: resumes s3 on profile B, with the normal prompt, no attempt spent',
    rr?.runtimeProfileId === P.b && resumedFrom(rr) === 's3' && !promptOf(rel.dir, rr).startsWith(app.CONTINUATION_PROMPT) && promptOf(rel.dir, rr).length > 0 && task(rel.id).attempts === 1,
    { rr, p: promptOf(rel.dir, rr).slice(0, 200), a: task(rel.id).attempts });
  check('released: the hold is consumed', h.repo.holds.get(hr.id)?.consumedAt != null);

  // ---- 5. A RESUMABLE run on profile A is not resumed on profile B
  const five = await addTask(AG.a5b);
  await settled(five.id);
  const [r5a] = runsOf(five.id);
  check('5: setup: the first run was on A with a session', r5a?.runtimeProfileId === P.a5 && r5a.externalSessionId === 'sess-a5', r5a);
  h.repo.runs.update(r5a.id, { status: 'RESUMABLE' });
  h.repo.profiles.update(P.a5, { enabled: false });
  h.repo.tasks.update(five.id, { status: 'READY', statusReason: null });
  h.repo.missions.update(five.mission.id, { status: 'EXECUTING' });
  await h.until(() => runsOf(five.id).length > 1 && idle(five.id), 20000);
  const r5b = runsOf(five.id)[1];
  check('5: the run routed to B does not resume A\'s session', r5b?.runtimeProfileId === P.b && resumedFrom(r5b) === null && r5b.externalSessionId !== 'sess-a5', { r5b, resumed: r5b && resumedFrom(r5b), s: task(five.id).status, why: task(five.id).statusReason, runs: runsOf(five.id).map((r) => [r.status, r.runtimeProfileId]) });
  check('5: A\'s handle is retired once the fresh run on B starts', h.repo.runs.get(r5a.id)?.status === 'INTERRUPTED', h.repo.runs.get(r5a.id)?.status);
  h.repo.profiles.update(P.a5, { enabled: true });

  // ---- 5b. A RESUMABLE run on an available profile is preferred over the agent's first runtime
  {
    h.repo.profiles.update(P.b, { enabled: false });
    const pref = await addTask(AG.ba6);
    await settled(pref.id);
    h.repo.profiles.update(P.b, { enabled: true });
    const [first] = runsOf(pref.id);
    check('5b: setup: the first run was on A6 with a session', first?.runtimeProfileId === P.a6 && first.externalSessionId === 'sess-a6', first);
    h.repo.runs.update(first.id, { status: 'RESUMABLE' });
    const attempts = task(pref.id).attempts;
    h.repo.tasks.update(pref.id, { status: 'READY', statusReason: null });
    h.repo.missions.update(pref.mission.id, { status: 'EXECUTING' });
    await h.until(() => runsOf(pref.id).length > 1 && idle(pref.id), 20000);
    const second = runsOf(pref.id)[1];
    check('5b: the restart resumes on A6, not on B listed first', second?.runtimeProfileId === P.a6 && resumedFrom(second) === 'sess-a6' && task(pref.id).attempts === attempts,
      { second, resumed: second && resumedFrom(second), a: task(pref.id).attempts, attempts });
  }

  // ---- 8. A continuation whose runtime is gone blocks, and the hold waits unread
  {
    const gone = await addTask(AG.ab, { status: 'HELD', attempts: 1 });
    const hg = hold(gone, { runtimeProfileId: P.a5 });
    h.repo.tasks.update(gone.id, { status: 'READY', statusReason: null });
    await h.until(() => task(gone.id).status === 'BLOCKED', 10000);
    check('8: the task is BLOCKED and says why', task(gone.id).status === 'BLOCKED'
      && task(gone.id).statusReason === "The runtime holding this task's session is no longer available to its agent.", { s: task(gone.id).status, r: task(gone.id).statusReason });
    check('8: nothing ran and the hold is unread', runsOf(gone.id).length === 0 && h.repo.holds.get(hg.id)?.consumedAt === null, { runs: runsOf(gone.id).length, hold: h.repo.holds.get(hg.id) });
  }

  // ---- 9. Output written to the task's out folder during the hold survives into the continuation
  {
    const { writeFileSync } = await import('node:fs');
    const kept = await addTask(AG.c, { status: 'HELD', attempts: 1 });
    const out = join(kept.dir, '.tandemise', 'out', kept.id);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'DesignBrief.md'), brief({ headline: 'Written during the hold' }));
    hold(kept, { runtimeProfileId: P.c });
    h.repo.tasks.update(kept.id, { status: 'READY', statusReason: null });
    await settled(kept.id);
    const harvested = h.repo.artifacts.listByTask(kept.id);
    check('9: the continuation harvests what the person wrote during the hold', task(kept.id).status === 'SUCCEEDED'
      && harvested.some((a) => a.type === 'DesignBrief' && a.handoff?.headline === 'Written during the hold'),
      { s: task(kept.id).status, r: task(kept.id).statusReason, a: harvested.map((a) => [a.type, a.handoff?.headline]) });
  }

  // ---- 6. ask_human while HELD leaves the status HELD
  {
    const t = task(one.id);
    const tool = app.createAskHumanTool({
      approvals: h.repo.approvals, approvalFactory: h.container.resolve(APPROVAL_FACTORY), tasks: h.repo.tasks,
      address: (tk, w) => h.container.resolve(app.REVIEW_PIPELINE).questionAddressFor(tk, w), waiter: h.container.resolve(app.APPROVAL_WAITER),
      deadlines: new app.RunDeadlines(), recorder: h.container.resolve(app.EVENT_RECORDER), clock: systemClock,
    });
    const assignment = { id: 'asg_hold_check', workspaceId: ws, missionId: one.mission.id, taskId: t.id, roleId: 'design' };
    const c = new AbortController();
    const call = tool.execute({ assignment, assignmentId: assignment.id, runId: null, workingDirectory: one.dir, logger: nullLogger, signal: c.signal }, { question: 'Which style?' });
    const during = task(one.id).status;
    c.abort();
    await call;
    check('6: ask_human while HELD never writes AWAITING_INPUT', during === 'HELD' && task(one.id).status === 'HELD', { during, after: task(one.id).status });
  }

  // ---- 7. Recovery leaves a HELD task alone and clears a dead terminal's pid
  {
    // A run row left RUNNING under the held task, as a daemon dying mid-hold would leave it.
    h.repo.runs.update(heldRun.id, { status: 'RUNNING', pid: null });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const h7 = hold(one, { endedAt: null, endedBy: null, ending: null, sessionAfter: null, sessionBefore: 'sess-slow', ptyPid: dead });
    const live = await addTask(AG.slow, { status: 'HELD' });
    const h7b = hold(live, { endedAt: null, endedBy: null, ending: null, ptyPid: process.pid });
    const report = await h.container.resolve(app.RECOVERY_SERVICE).run();
    check('7: recovery leaves the HELD task HELD', task(one.id).status === 'HELD' && task(live.id).status === 'HELD', { s: task(one.id).status, report });
    check('7: a dead terminal pid is cleared on the open hold', h.repo.holds.get(h7.id)?.ptyPid === null, h.repo.holds.get(h7.id));
    check('7: a live terminal pid is kept', h.repo.holds.get(h7b.id)?.ptyPid === process.pid, h.repo.holds.get(h7b.id));
    // The daemon died between ending a hold and putting its task back in the queue.
    const between = await addTask(AG.slow, { status: 'HELD' });
    hold(between);
    await h.container.resolve(app.RECOVERY_SERVICE).run();
    check('7: a HELD task whose hold has ended goes back to the queue', task(between.id).status === 'READY', task(between.id));
  }

  clearInterval(keepAlive);
  await h.container.dispose();
}


section('service: hold, continue and release');
{
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids, nullLogger } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const { RUNTIME_MANAGER } = await import('@tandemise/runtimes-core');
  const { APPROVAL_FACTORY } = await import('@tandemise/policy');
  const keepAlive = setInterval(() => {}, 1000);

  /** The terminal host, recorded: what was opened and ended, and an exit the check can fire. */
  class RecordingSessions {
    calls = [];
    snapshot = () => null;
    #open = new Set();
    #listeners = new Set();
    available() { return { ok: true }; }
    /** How long `end` takes before the process is gone, and what the check looks at just before it goes. */
    endDelayMs = 0;
    beforeExit = null;
    /** An `end` that throws, as a host whose process will not die might. */
    endFails = false;
    open(holdId, inv) {
      // As the PTY host: a second session for the same hold is an error.
      if (this.#open.has(holdId)) throw new Error(`Session ${holdId} is already open`);
      this.calls.push({ op: 'open', holdId, inv, at: this.snapshot(holdId) }); this.#open.add(holdId); return { pid: 4242 };
    }
    isOpen(holdId) { return this.#open.has(holdId); }
    async end(holdId) {
      this.calls.push({ op: 'end', holdId });
      if (this.endDelayMs > 0) await new Promise((r) => setTimeout(r, this.endDelayMs));
      if (this.endFails) throw new Error('the terminal would not end');
      this.beforeExit?.(holdId);
      this.exit(holdId, 0);
    }
    onExit(cb) { this.#listeners.add(cb); return () => this.#listeners.delete(cb); }
    exit(holdId, code = 0) { this.#open.delete(holdId); for (const cb of this.#listeners) cb(holdId, code); }
    opened(holdId) { return this.calls.filter((c) => c.op === 'open' && c.holdId === holdId); }
    ended(holdId) { return this.calls.some((c) => c.op === 'end' && c.holdId === holdId); }
  }
  const sessions = new RecordingSessions();
  // The skills store, in memory: what a pin's hash reads back.
  const skillStore = new Map();
  const skillFiles = {
    discoverRoot: () => '', discover: async () => ({ exists: false, folders: [] }),
    scan: async (folder) => ({ folder, files: [], sizeBytes: 0, problem: 'unused' }), fetchGit: async () => { throw new Error('unused'); },
    store: async (hash, files) => { skillStore.set(hash, files); }, read: async (hash) => skillStore.get(hash) ?? null, drop: async () => undefined,
  };
  const HOME = mkdtempSync(join(tmpdir(), 'thold-svc-'));
  const binder = (into) => (container, app) => {
    container.bind(app.INTERACTIVE_SESSIONS, () => into, { source: 'check' });
    container.rebind(app.SKILL_FILES, () => skillFiles, { source: 'check' });
  };
  const h = await engineHarness(HOME, binder(sessions), { holdStopWaitMs: 400 });
  const { app } = h;
  const now = () => systemClock.now();
  const manager = h.container.resolve(RUNTIME_MANAGER);
  const interactiveCalls = [];
  const interactive = manager.interactive.bind(manager);
  manager.interactive = (profile, sessionRef, request, opts) => { interactiveCalls.push({ sessionRef, request, opts }); return interactive(profile, sessionRef, request, opts); };

  const brief = [
    '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', '  headline: Onboarding designed',
    'flows:', '  - onboarding', '---', '', '# Onboarding', '', 'Onboarding designed.', '',
  ].join('\n');
  const write = { kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: brief };
  const session = (id) => ({ kind: 'checkpoint', sessionId: id, label: 'session.init' });
  const done = { kind: 'complete', summary: 'done' };
  const profile = (name, steps) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
    settings: { script: { steps, resume: 'ok' } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const P = {
    slow: profile('slow', [session('sess-slow'), write, { kind: 'delay', ms: 30000 }, done]),
    quick: profile('quick', [session('sess-quick'), write, done]),
    stuck: profile('stuck', [session('sess-stuck'), write, { kind: 'delay', ms: 30000 }, done]),
    lone: profile('lone', [session('sess-lone'), write, done]),
  };
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Hold service' })).workspace.id;
  // Room for every step this section leaves running, so a sibling waits on its lease, not on the ceiling.
  h.container.resolve(app.WORKSPACE_REPOSITORY).update(ws, { concurrency: { maxTotalWorkers: 50, perRuntime: {} } });
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const ownerName = h.container.resolve(app.MEMBER_REPOSITORY).get(owner).name;
  const anaPerson = h.services.team.createPerson(caller, { displayName: 'Ana' });
  const ana = h.services.team.addMember(caller, ws, { kind: 'person', personId: anaPerson.id, reportsTo: owner }).id;
  const anaCaller = { personId: anaPerson.id };
  const boPerson = h.services.team.createPerson(caller, { displayName: 'Bo' });
  h.services.team.addMember(caller, ws, { kind: 'person', personId: boPerson.id, reportsTo: owner });
  const boCaller = { personId: boPerson.id };
  const agent = (name, profileIds, reportsTo = owner) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo, roleIds: ['design'], runtimeProfileIds: profileIds }).id;
  // Ana answers for this one, so she may take it; Bo answers for nothing of it.
  const AG = {
    slow: agent('Slow', [P.slow]), quick: agent('Quick', [P.quick]), anas: agent('Ana\'s', [P.slow], ana),
    stuck: agent('Stuck', [P.stuck]), lone: agent('Lone', [P.lone]),
  };

  let seq = 0;
  const addTask = async (agentId, extra = {}) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Design onboarding', title: `S${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    execFileSync('git', ['-C', dir, 'add', 'README.md']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-m', 'init']);
    const id = h.repo.tasks.add({
      id: ids.task(), missionId: mission.id, key: 'doc', title: 'doc', objective: 'o', roleId: 'design',
      dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
      retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
      status: 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
      executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: { assignees: [agentId] },
      createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null, ...extra,
    }).id;
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, dir, id };
  };
  const task = (id) => h.repo.tasks.get(id);
  const runsOf = (id) => [...h.repo.runs.listByTask(id)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const liveRun = (id) => h.repo.runs.listByTask(id).some((r) => r.status === 'RUNNING' || r.status === 'STARTING');
  const idle = (id) => !h.scheduler.activeTaskIds().includes(id) && !liveRun(id);
  const eventsOf = (t, type) => h.repo.events.listByMission(t.mission.id).filter((e) => e.taskId === t.id && e.body.type === type).map((e) => e.body);
  const openHold = (t) => h.repo.holds.openFor(t.id);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  sessions.snapshot = (holdId) => {
    const hold = h.repo.holds.get(holdId);
    return { status: task(hold.taskId).status, live: liveRun(hold.taskId), runs: runsOf(hold.taskId).map((r) => r.status) };
  };

  // ---- RUNNING: HELD is written, the run is stopped, then the terminal opens in the checkout
  const run = await addTask(AG.slow);
  await h.until(() => runsOf(run.id).some((r) => r.status === 'RUNNING' && r.externalSessionId === 'sess-slow'));
  await h.services.holds.hold(run.id, caller);
  const hRun = openHold(run);
  const [openRun] = sessions.opened(hRun?.id);
  check('running: the terminal opened after HELD was written and the run had stopped',
    openRun?.at?.status === 'HELD' && openRun.at.live === false && openRun.at.runs.at(-1) === 'RESUMABLE', openRun?.at);
  check('running: the invocation works in the checkout and records its session in the hold folder',
    openRun?.inv.cwd === run.dir && openRun.inv.sessionFile === join(hRun.dir, 'session-id')
    && hRun.dir === join(h.paths.mission(ws, run.mission.id), 'holds', hRun.id) && typeof openRun.inv.env === 'object', { inv: openRun?.inv, dir: hRun?.dir });
  check('running: it resumes the run\'s session on its profile', interactiveCalls.at(-1)?.sessionRef === 'sess-slow'
    && hRun.runtimeProfileId === P.slow && hRun.sessionBefore === 'sess-slow' && hRun.ptyPid === 4242, { call: interactiveCalls.at(-1)?.sessionRef, hRun });
  check('running: task.held is recorded with where it came from', eventsOf(run, 'task.held').some((e) => e.holdId === hRun.id && e.fromStatus === 'RUNNING' && e.heldBy === owner && e.sessionBefore === 'sess-slow'), eventsOf(run, 'task.held'));
  check('running: the task is HELD, by name', task(run.id).status === 'HELD' && task(run.id).statusReason === `Held by ${ownerName}.`, task(run.id));
  check('running: the HEAD at hold start is kept in the hold folder', existsSync(join(hRun.dir, 'head.txt'))
    && readFileSync(join(hRun.dir, 'head.txt'), 'utf8').trim() === execFileSync('git', ['-C', run.dir, 'rev-parse', 'HEAD']).toString().trim());
  const holdAssignment = [...h.container.resolve(app.ASSIGNMENT_REPOSITORY).listByTask(run.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const runAssignment = h.container.resolve(app.ASSIGNMENT_REPOSITORY).get(runsOf(run.id)[0].assignmentId);
  // The hold's gateway is built from this assignment (RunScopedToolGateway.for), so its tools follow these grants.
  check('the run had human.ask; the hold\'s gateway grants do not', runAssignment.grants.some((g) => g.capability === 'human.ask')
    && holdAssignment.id !== runAssignment.id && holdAssignment.grants.length > 0 && !holdAssignment.grants.some((g) => g.capability === 'human.ask'),
    { run: runAssignment.grants.map((g) => g.capability), hold: holdAssignment.grants.map((g) => g.capability) });
  check('terminalFor names the open hold', h.services.holds.terminalFor(run.id) === hRun.id);
  const twice = await refusal(() => h.services.holds.hold(run.id, anaCaller));
  check('a held task is refused, by name', twice?.code === 'CONFLICT' && new RegExp(`^Held by ${ownerName} since \\d\\d:\\d\\d\\.$`).test(twice.message), twice?.message);

  // ---- Continue: only the holder; the hold ends, the terminal ends, the diff is measured
  const notHolder = await refusal(() => h.services.holds.continue(run.id, anaCaller));
  check('continue by someone else is refused in exact words', notHolder?.code === 'CONFLICT'
    && notHolder.message === `Only ${ownerName} can continue this hold; you can release it.`, notHolder?.message);
  writeFileSync(join(run.dir, 'held.txt'), 'one\ntwo\n');
  writeFileSync(join(run.dir, 'README.md'), 'hello again\n');
  await h.services.holds.continue(run.id, caller);
  const ended = h.repo.holds.get(hRun.id);
  const [endedEvent] = eventsOf(run, 'task.hold_ended');
  check('continue: the terminal is ended and the task is READY', sessions.ended(hRun.id) && task(run.id).status === 'READY', { s: task(run.id).status, calls: sessions.calls.filter((c) => c.holdId === hRun.id).map((c) => c.op) });
  check('continue: the hold ended as continued, by the holder', ended.ending === 'continued' && ended.endedBy === owner && ended.endedAt !== null && openHold(run) === undefined, ended);
  check('continue: task.hold_ended carries the diff stat, the new file included',
    endedEvent?.ending === 'continued' && endedEvent.diffStat?.files === 2 && endedEvent.diffStat.insertions === 3 && endedEvent.diffStat.deletions === 1
    && typeof endedEvent.durationMs === 'number', endedEvent);
  check('continue: terminalFor is empty again', h.services.holds.terminalFor(run.id) === null);

  // ---- AWAITING_INPUT: the question card is withdrawn and gone from the pending list
  const asked = await addTask(AG.anas);
  await h.until(() => runsOf(asked.id).some((r) => r.status === 'RUNNING' && r.externalSessionId === 'sess-slow'));
  const tool = app.createAskHumanTool({
    approvals: h.repo.approvals, approvalFactory: h.container.resolve(APPROVAL_FACTORY), tasks: h.repo.tasks,
    address: (tk, w) => h.container.resolve(app.REVIEW_PIPELINE).questionAddressFor(tk, w), waiter: h.container.resolve(app.APPROVAL_WAITER),
    deadlines: new app.RunDeadlines(), recorder: h.container.resolve(app.EVENT_RECORDER), clock: systemClock,
  });
  const assignment = { id: 'asg_hold_svc', workspaceId: ws, missionId: asked.mission.id, taskId: asked.id, roleId: 'design' };
  const askAbort = new AbortController();
  const question = tool.execute({ assignment, assignmentId: assignment.id, runId: null, workingDirectory: asked.dir, logger: nullLogger, signal: askAbort.signal }, { question: 'Which style?' });
  await h.until(() => task(asked.id).status === 'AWAITING_INPUT');
  const choice = h.repo.approvals.pendingForTask(asked.id).find((a) => a.kind === 'choice');
  check('awaiting input: setup: a question card is pending', task(asked.id).status === 'AWAITING_INPUT' && choice !== undefined, task(asked.id).status);
  await h.services.holds.hold(asked.id, caller);
  askAbort.abort();
  await question.catch(() => undefined);
  const pendingNow = await h.services.approvals.list({ status: 'pending' });
  check('awaiting input: the question card is withdrawn', h.repo.approvals.get(choice.id)?.status === 'CANCELLED'
    && !JSON.stringify(pendingNow).includes(choice.id), h.repo.approvals.get(choice.id)?.status);
  check('awaiting input: the task is HELD and its terminal open', task(asked.id).status === 'HELD' && sessions.opened(openHold(asked)?.id).length === 1);

  // ---- Release by another member who may take the task
  const hAsked = openHold(asked);
  const boRelease = await refusal(() => h.services.holds.release(asked.id, boCaller));
  check('release by someone the take rule refuses is refused', boRelease?.code === 'CONFLICT' && /cannot release 'doc'/.test(boRelease.message)
    && openHold(asked)?.id === hAsked.id, boRelease?.message);
  await h.services.holds.release(asked.id, anaCaller);
  const released = h.repo.holds.get(hAsked.id);
  check('release: another member may release; the hold ends released, by them', released.ending === 'released' && released.endedBy === ana
    && task(asked.id).status === 'READY' && sessions.ended(hAsked.id)
    && eventsOf(asked, 'task.hold_ended').some((e) => e.ending === 'released' && e.endedBy === ana), released);

  // ---- AWAITING_APPROVAL on the output: holding is a request for changes, so a round begins
  const review = await addTask(AG.quick, { approvalPolicy: { beforeStart: false, onCompletion: true } });
  await h.until(() => idle(review.id) && task(review.id).status === 'AWAITING_APPROVAL', 20000);
  const roundBefore = task(review.id).round ?? 1;
  const card = h.repo.approvals.pendingForTask(review.id)[0];
  check('output review: setup: the output waits for approval', task(review.id).status === 'AWAITING_APPROVAL' && card !== undefined, { s: task(review.id).status, r: task(review.id).statusReason });
  await h.services.holds.hold(review.id, caller);
  check('output review: a new round begins (round +1) and the card is set aside', (task(review.id).round ?? 1) === roundBefore + 1
    && h.repo.approvals.get(card.id)?.status !== 'PENDING' && h.repo.approvals.pendingForTask(review.id).length === 0,
    { round: task(review.id).round, roundBefore, card: h.repo.approvals.get(card.id)?.status });
  check('output review: the round says who held it, and the task is HELD', eventsOf(review, 'task.round_started').length === 1
    && eventsOf(review, 'task.status').some((e) => e.reason === `Held by ${ownerName} to change it directly.`) && task(review.id).status === 'HELD',
    eventsOf(review, 'task.status'));
  check('output review: the terminal resumes the settled session', interactiveCalls.at(-1)?.sessionRef === 'sess-quick', interactiveCalls.at(-1)?.sessionRef);

  // ---- READY: the target is provisioned and the session starts fresh, with the task's prompt
  const fresh = await addTask(AG.quick);
  await h.services.holds.hold(fresh.id, caller);
  const hFresh = openHold(fresh);
  const freshCall = interactiveCalls.at(-1);
  const targets = h.container.resolve(app.EXECUTION_TARGET_REPOSITORY).listByMission(fresh.mission.id).filter((t) => t.taskId === fresh.id);
  check('ready: the target is provisioned', targets.length > 0 && targets.every((t) => t.status !== 'FAILED'), targets.map((t) => t.status));
  check('ready: the terminal opens fresh, with the task\'s prompt', freshCall?.sessionRef === null && typeof freshCall.opts.initialPrompt === 'string'
    && freshCall.opts.initialPrompt.length > 0 && sessions.opened(hFresh?.id).length === 1 && hFresh.sessionBefore === null && runsOf(fresh.id).length === 0,
    { ref: freshCall?.sessionRef, prompt: freshCall?.opts.initialPrompt?.slice(0, 80) });

  // ---- The terminal exits on its own: the task stays HELD, and Continue uses the hook's session
  writeFileSync(join(hFresh.dir, 'session-id'), 'sess-from-hook\n');
  sessions.exit(hFresh.id, 0);
  await new Promise((r) => setTimeout(r, 50));
  check('exit: the task stays HELD and the pid is cleared', task(fresh.id).status === 'HELD' && h.repo.holds.get(hFresh.id).ptyPid === null
    && h.services.holds.terminalFor(fresh.id) === null, h.repo.holds.get(hFresh.id));
  await h.services.holds.reopen(fresh.id, caller);
  check('reopen: the terminal opens again on the hook\'s session', sessions.opened(hFresh.id).length === 2 && interactiveCalls.at(-1)?.sessionRef === 'sess-from-hook'
    && h.repo.holds.get(hFresh.id).ptyPid === 4242, interactiveCalls.at(-1)?.sessionRef);
  sessions.exit(hFresh.id, 0);
  await new Promise((r) => setTimeout(r, 50));
  await h.services.holds.continue(fresh.id, caller);
  check('exit then continue: the hold ends with the session-file value', h.repo.holds.get(hFresh.id).sessionAfter === 'sess-from-hook'
    && h.repo.holds.get(hFresh.id).ending === 'continued' && task(fresh.id).status === 'READY', h.repo.holds.get(hFresh.id));

  // ---- A missing session file falls back to what the hold knew
  {
    const r2 = await addTask(AG.slow);
    await h.until(() => runsOf(r2.id).some((r) => r.status === 'RUNNING' && r.externalSessionId === 'sess-slow'));
    await h.services.holds.hold(r2.id, caller);
    const h2 = openHold(r2);
    await h.services.holds.release(r2.id, caller);
    check('no session file: the hold ends on the session it started from', h.repo.holds.get(h2.id).sessionAfter === 'sess-slow', h.repo.holds.get(h2.id));
  }


  // ---- Leases: a hold keeps its checkout from the in-place work that shares it, until it ends
  const leaseRepo = h.container.resolve(app.LEASE_REPOSITORY);
  const repoDir = mkdtempSync(join(tmpdir(), 'thold-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), 'repo\n');
  execFileSync('git', ['-C', repoDir, 'add', 'README.md']);
  execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '-m', 'init']);
  const repo = h.container.resolve(app.REPO_REPOSITORY).create({
    id: ids.repository(), workspaceId: ws, name: 'shared', path: repoDir, defaultBranch: 'main', remoteUrl: null,
    checks: { install: null, typecheck: null, lint: null, test: null, build: null, devServer: null, devServerUrl: null },
  });
  const inPlace = { repositoryId: repo.id, executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: ['filesystem.write'] } };
  const leasesOf = (id) => leaseRepo.listAll().filter((l) => l.holderTaskId === id);
  const QUEUED = 'Queued: another task is working directly in this repository checkout, and tasks that run in place take turns.';
  const leaseA = await addTask(AG.quick, inPlace);
  const leaseB = await addTask(AG.quick, inPlace);
  await h.services.holds.hold(leaseA.id, caller);
  check('leases: a READY hold takes the checkout lease and works in the repository', leasesOf(leaseA.id).some((l) => l.resourceKey === `repository:${repo.id}:worktree`)
    && sessions.opened(openHold(leaseA)?.id)[0]?.inv.cwd === repoDir, { leases: leaseRepo.listAll(), cwd: sessions.opened(openHold(leaseA)?.id)[0]?.inv.cwd });
  await h.until(() => task(leaseB.id).statusReason === QUEUED, 3000);
  check('leases: an in-place sibling waits while the hold lasts', task(leaseB.id).status === 'READY' && runsOf(leaseB.id).length === 0
    && task(leaseB.id).statusReason === QUEUED, { s: task(leaseB.id).status, r: task(leaseB.id).statusReason });
  const leaseRefused = await refusal(() => h.services.holds.hold(leaseB.id, caller));
  check('leases: holding the sibling is refused in the queued words, taking nothing', leaseRefused?.code === 'CONFLICT' && leaseRefused.message === QUEUED
    && openHold(leaseB) === undefined && leasesOf(leaseB.id).length === 0, leaseRefused?.message);
  sessions.exit(openHold(leaseA).id, 0);
  await new Promise((r) => setTimeout(r, 50));
  check('leases: the terminal exiting keeps the lease (the hold is not over)', leasesOf(leaseA.id).length === 1);
  await h.services.holds.continue(leaseA.id, caller);
  check('leases: continue gives the lease back', leasesOf(leaseA.id).length === 0, leaseRepo.listAll());
  await h.until(() => task(leaseA.id).status !== 'READY' || task(leaseB.id).status !== 'READY', 5000);
  await h.until(() => idle(leaseA.id) && idle(leaseB.id) && !['READY', 'RUNNING'].includes(task(leaseA.id).status) && !['READY', 'RUNNING'].includes(task(leaseB.id).status), 20000);
  const leaseC = await addTask(AG.quick, inPlace);
  await h.services.holds.hold(leaseC.id, caller);
  const cHeld = leasesOf(leaseC.id).length;
  await h.services.holds.release(leaseC.id, caller);
  check('leases: release gives the lease back', cHeld === 1 && leasesOf(leaseC.id).length === 0, { cHeld, now: leaseRepo.listAll() });

  // ---- Skills: a missing pin refuses a READY hold; a present one is installed for the session
  {
    const D = await import('@tandemise/domain');
    const ghost = [{ name: 'ghost', version: 1, hash: '0'.repeat(64) }];
    const missingTask = await addTask(AG.quick, { skills: ghost });
    const missingRefused = await refusal(() => h.services.holds.hold(missingTask.id, caller));
    check('skills: a missing pinned skill refuses the hold in the attempt\'s words', missingRefused?.code === 'CONFLICT'
      && missingRefused.message === D.missingSkillReason(ghost) && task(missingTask.id).status === 'READY' && openHold(missingTask) === undefined, missingRefused?.message);

    const md = new TextEncoder().encode('---\nname: house-style\ndescription: Write in the house style ZX-SKILL.\n---\n\n# House style\nShort sentences.\n');
    const files = [{ path: 'SKILL.md', size: md.length, bytes: md }];
    const hash = D.hashSkillFiles(files);
    skillStore.set(hash, files);
    const pin = { name: 'house-style', version: 1, hash };
    const fakeAdapter = manager.registry.tryAdapter(FAKE_ADAPTER_ID);
    fakeAdapter.skillsFolder = () => '.claude/skills';
    const withSkill = await addTask(AG.quick, { skills: [pin] });
    await h.services.holds.hold(withSkill.id, caller);
    const installedAt = join(withSkill.dir, '.claude', 'skills', 'house-style', 'SKILL.md');
    check('skills: the pinned skill is installed in the hold\'s checkout', task(withSkill.id).status === 'HELD' && existsSync(installedAt)
      && readFileSync(installedAt, 'utf8').includes('ZX-SKILL') && sessions.opened(openHold(withSkill)?.id).length === 1, { s: task(withSkill.id).status, r: task(withSkill.id).statusReason });
    check('skills: the fresh session\'s prompt names it', (interactiveCalls.at(-1)?.opts.initialPrompt ?? '').includes('house-style'));
    await h.services.holds.release(withSkill.id, caller);
    check('skills: removed again from a checkout that is not a worktree once the hold ends', !existsSync(installedAt));
    delete fakeAdapter.skillsFolder;
  }

  // ---- Failures after the commit leave the task HELD, in the daemon's words, giving back what was taken
  {
    // The run will not stop: the hold waits, gives up, and opens nothing.
    const stuck = await addTask(AG.stuck);
    await h.until(() => runsOf(stuck.id).some((r) => r.status === 'RUNNING' && r.externalSessionId === 'sess-stuck'));
    const slotsBefore = manager.inFlight(P.stuck);
    const cancel = h.scheduler.cancelTask;
    h.scheduler.cancelTask = () => {};
    await h.services.holds.hold(stuck.id, caller);
    const hStuck = openHold(stuck);
    const TIMEOUT = "The agent's run did not stop in time. Open the terminal again in a moment.";
    check('stop timeout: HELD, with the daemon\'s sentence, no terminal and no slot taken', task(stuck.id).status === 'HELD' && task(stuck.id).statusReason === TIMEOUT
      && sessions.opened(hStuck.id).length === 0 && manager.inFlight(P.stuck) === slotsBefore && liveRun(stuck.id), { r: task(stuck.id).statusReason, slots: [slotsBefore, manager.inFlight(P.stuck)] });
    await h.services.holds.reopen(stuck.id, caller);
    check('reopen beside a live run waits for it, and opens nothing while it lives', sessions.opened(hStuck.id).length === 0
      && task(stuck.id).statusReason === TIMEOUT && liveRun(stuck.id));
    h.scheduler.cancelTask = cancel;
    // The run learns a later session as it ends; the terminal must resume that one.
    const live = runsOf(stuck.id).at(-1);
    h.repo.runs.update(live.id, { externalSessionId: 'sess-stuck-later' });
    await h.services.holds.reopen(stuck.id, caller);
    check('reopen: the run is stopped first, then the terminal resumes the session it ended on', sessions.opened(hStuck.id).length === 1
      && sessions.opened(hStuck.id)[0].at.live === false && interactiveCalls.at(-1)?.sessionRef === 'sess-stuck-later'
      && h.repo.holds.get(hStuck.id).sessionBefore === 'sess-stuck-later' && task(stuck.id).statusReason === `Held by ${ownerName}.`,
      { opened: sessions.opened(hStuck.id).map((c) => c.at), ref: interactiveCalls.at(-1)?.sessionRef, hold: h.repo.holds.get(hStuck.id) });
    await h.services.holds.release(stuck.id, caller);

    // The target cannot be made: nothing is spawned and no slot is held.
    const executor = h.container.resolve(app.TASK_EXECUTOR);
    const prepare = executor.prepareHold;
    executor.prepareHold = async () => ({ ok: false, reason: 'Target provisioning failed: the disk is full.' });
    const noTarget = await addTask(AG.lone);
    const loneBefore = manager.inFlight(P.lone);
    await h.services.holds.hold(noTarget.id, caller);
    executor.prepareHold = prepare;
    check('prepare fails: HELD, with its sentence, nothing opened, no slot', task(noTarget.id).status === 'HELD'
      && task(noTarget.id).statusReason === 'Target provisioning failed: the disk is full.' && sessions.opened(openHold(noTarget).id).length === 0
      && manager.inFlight(P.lone) === loneBefore, task(noTarget.id).statusReason);
    await h.services.holds.release(noTarget.id, caller);

    // The terminal host throws: the slot and the target are given back.
    const open = sessions.open;
    sessions.open = () => { throw new Error('The terminal could not start: no pty.'); };
    const noPty = await addTask(AG.lone);
    await h.services.holds.hold(noPty.id, caller);
    sessions.open = open;
    const targetsOf = h.container.resolve(app.EXECUTION_TARGET_REPOSITORY).listByMission(noPty.mission.id).filter((t) => t.taskId === noPty.id);
    check('open throws: HELD, with its sentence, slot and target given back', task(noPty.id).status === 'HELD'
      && task(noPty.id).statusReason === 'The terminal could not start: no pty.' && manager.inFlight(P.lone) === loneBefore
      && targetsOf.length > 0 && targetsOf.every((t) => t.status !== 'IN_USE') && openHold(noPty).ptyPid === null,
      { r: task(noPty.id).statusReason, slots: manager.inFlight(P.lone), targets: targetsOf.map((t) => t.status) });
    await h.services.holds.reopen(noPty.id, caller);
    check('open throws, then reopen works and takes one slot', sessions.opened(openHold(noPty).id).length === 1 && manager.inFlight(P.lone) === loneBefore + 1
      && task(noPty.id).statusReason === `Held by ${ownerName}.`);
    await h.services.holds.release(noPty.id, caller);
    check('the slot is given back when the hold ends', manager.inFlight(P.lone) === loneBefore);
  }

  // ---- Continue: the next pass never starts beside the terminal (the hold ends first, READY only once it is gone)
  {
    const slow = await addTask(AG.lone);
    await h.services.holds.hold(slow.id, caller);
    const hSlow = openHold(slow);
    let atExit = null;
    sessions.endDelayMs = 600;
    sessions.beforeExit = (id) => {
      if (id === hSlow.id) atExit = { runs: runsOf(slow.id).length, status: task(slow.id).status, ended: h.repo.holds.get(hSlow.id).endedAt !== null };
    };
    let ticking = true;
    const ticker = (async () => { while (ticking) { await h.scheduler.tick(); await new Promise((r) => setTimeout(r, 40)); } })();
    await h.services.holds.continue(slow.id, caller);
    ticking = false;
    await ticker;
    sessions.endDelayMs = 0;
    sessions.beforeExit = null;
    check('continue: while the terminal is still exiting the hold has ended, the task is still HELD, and no run exists',
      atExit?.runs === 0 && atExit.status === 'HELD' && atExit.ended, atExit);
    check('continue: once the terminal is gone the task leaves HELD, with task.status HELD -> READY',
      task(slow.id).status !== 'HELD' && eventsOf(slow, 'task.status').some((e) => e.from === 'HELD' && e.to === 'READY'), task(slow.id).status);
    await h.until(() => runsOf(slow.id).length > 0 && idle(slow.id), 10000);
    check('continue: then the continuation runs', runsOf(slow.id).length === 1 && task(slow.id).status === 'SUCCEEDED', { runs: runsOf(slow.id).length, s: task(slow.id).status });
  }

  // ---- A terminal that will not end still lets the step go back to the queue
  {
    const stubborn = await addTask(AG.lone);
    await h.services.holds.hold(stubborn.id, caller);
    const hStub = openHold(stubborn);
    sessions.endFails = true;
    const thrown = await refusal(() => h.services.holds.release(stubborn.id, caller));
    sessions.endFails = false;
    check('end fails: release still ends the hold and the task is READY, never stuck HELD', thrown === null
      && h.repo.holds.get(hStub.id).ending === 'released' && task(stubborn.id).status === 'READY', { thrown: thrown?.message, s: task(stubborn.id).status });
    sessions.exit(hStub.id, 0);
  }

  // ---- Hold operations on one hold take turns
  {
    // Continue while the hold still waits for its run to stop: no terminal is left open for the ended hold.
    const racing = await addTask(AG.stuck);
    await h.until(() => runsOf(racing.id).some((r) => r.status === 'RUNNING' && r.externalSessionId === 'sess-stuck'));
    const cancel = h.scheduler.cancelTask;
    h.scheduler.cancelTask = () => {};
    const holding = h.services.holds.hold(racing.id, caller).catch((e) => e);
    await h.until(() => task(racing.id).status === 'HELD', 3000);
    const hRace = openHold(racing);
    const continuing = h.services.holds.continue(racing.id, caller).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    h.scheduler.cancelTask = cancel;
    h.scheduler.cancelTask(racing.id, new app.TaskHeld());
    const [held, continued] = await Promise.all([holding, continuing]);
    check('race: continue during the stop wait leaves no terminal open for the ended hold',
      !(held instanceof Error) && !(continued instanceof Error) && h.repo.holds.get(hRace.id).endedAt !== null && !sessions.isOpen(hRace.id)
      && task(racing.id).status === 'READY', { held: held?.message, continued: continued?.message, open: sessions.isOpen(hRace.id), s: task(racing.id).status });
    await h.until(() => idle(racing.id), 5000);

    // Two reopen calls at once open exactly one terminal, and neither leaves an error behind.
    const twin = await addTask(AG.lone);
    await h.services.holds.hold(twin.id, caller);
    const hTwin = openHold(twin);
    sessions.exit(hTwin.id, 0);
    await new Promise((r) => setTimeout(r, 50));
    const results = await Promise.all([h.services.holds.reopen(twin.id, caller).catch((e) => e), h.services.holds.reopen(twin.id, caller).catch((e) => e)]);
    check('race: two reopens open one terminal and say nothing went wrong', sessions.opened(hTwin.id).length === 2 && sessions.isOpen(hTwin.id)
      && results.every((r) => !(r instanceof Error)) && task(twin.id).statusReason === `Held by ${ownerName}.`,
      { opened: sessions.opened(hTwin.id).length, results: results.map((r) => r?.message ?? 'ok'), r: task(twin.id).statusReason });
    await h.services.holds.release(twin.id, caller);
  }

  // ---- A trial mission is refused
  {
    const trial = await addTask(AG.quick);
    const { DATABASE } = await import('@tandemise/persistence');
    h.container.resolve(DATABASE).handle.prepare('UPDATE missions SET eval_trial_id = ? WHERE id = ?').run(ids.evalTrial(), trial.mission.id);
    const before = sessions.calls.length;
    const refused = await refusal(() => h.services.holds.hold(trial.id, caller));
    check('a trial mission is refused, and nothing opens', refused?.code === 'CONFLICT' && refused.message === "Eval trials can't be held."
      && task(trial.id).status === 'READY' && openHold(trial) === undefined && sessions.calls.length === before, refused?.message);
  }

  // ---- A daemon restart mid-hold: the held checkout stays the person's
  {
    const keeper = await addTask(AG.quick, inPlace);
    const sibling = await addTask(AG.quick, inPlace);
    await h.services.holds.hold(keeper.id, caller);
    const hKeep = openHold(keeper);
    await h.until(() => task(sibling.id).statusReason === QUEUED, 3000);
    const leaseBefore = leasesOf(keeper.id).map((l) => l.id);
    // Shutdown: the application's own teardown ends the terminal it opened.
    const live = sessions.isOpen(hKeep.id);
    await h.container.dispose();
    check('shutdown: disposing the application ends the hold\'s open terminal', live && sessions.ended(hKeep.id) && !sessions.isOpen(hKeep.id));

    const sessions2 = new RecordingSessions();
    const h2 = await engineHarness(HOME, binder(sessions2), { holdStopWaitMs: 400, holdLeaseRenewMs: 100 });
    const leases2 = h2.container.resolve(h2.app.LEASE_REPOSITORY);
    const held2 = () => leases2.listAll().filter((l) => l.holderTaskId === keeper.id);
    await h2.container.resolve(h2.app.RECOVERY_SERVICE).run();
    const afterRecovery = held2().map((l) => l.id);
    h2.services.holds.resume();
    for (let i = 0; i < 6; i++) { await h2.scheduler.tick(); await new Promise((r) => setTimeout(r, 40)); }
    const t2 = (id) => h2.repo.tasks.get(id);
    check('restart: recovery leaves the open hold\'s checkout lease alone', leaseBefore.length === 1 && afterRecovery.join() === leaseBefore.join(), { before: leaseBefore, afterRecovery });
    check('restart: the hold takes up that same lease again, not a new one', held2().map((l) => l.id).join() === leaseBefore.join()
      && t2(keeper.id).statusReason === `Held by ${ownerName}.`, { before: leaseBefore, after: leases2.listAll(), r: t2(keeper.id).statusReason });
    check('restart: an in-place sibling stays queued', t2(sibling.id).status === 'READY' && h2.repo.runs.listByTask(sibling.id).length === 0
      && t2(sibling.id).statusReason === QUEUED, { s: t2(sibling.id).status, r: t2(sibling.id).statusReason });

    // Losing the claim afterwards (it lapsed and someone took it) is said on the step, not only logged.
    for (const l of held2()) leases2.release(l.id);
    await h2.until(() => t2(keeper.id).statusReason !== `Held by ${ownerName}.`, 3000);
    check('lease lost: the held step says so', t2(keeper.id).status === 'HELD'
      && t2(keeper.id).statusReason === 'Your hold lost its claim on this checkout, so other work may start in it. Continue or release when you can.',
      t2(keeper.id).statusReason);
    await h2.services.holds.release(keeper.id, { personId: h2.services.identity.localPerson().id });
    check('restart: the hold still ends normally', t2(keeper.id).status === 'READY' && h2.repo.holds.get(hKeep.id).ending === 'released');
    await h2.container.dispose();
  }

  clearInterval(keepAlive);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
