// #162: a step's agent is not pointed at the person's own Tandemise window.
//
// The daemon inherits the window's launch environment (Electron's
// ELECTRON_RUN_AS_NODE, an AppImage's paths, a DevTools port someone exported,
// the daemon's own TANDEMISE_PORT, inspector flags in NODE_OPTIONS). None of
// that may reach a worker: not Claude Code's allowlisted environment, not the
// whole-environment runtimes (Codex, a generic CLI). And the factory script
// opens the window's DevTools port only when asked, on a random port.
//
//   npm run build && node scratch/app-port-env-check.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const R = await import('@tandemise/runtimes-core');
const { ClaudeCodeAdapter } = await import('@tandemise/runtime-claude');
const { ids, nullLogger } = await import('@tandemise/shared');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};

/** What a daemon started by the window, from an AppImage, can carry. */
const POINTERS = {
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_RENDERER_URL: 'http://localhost:5173',
  APPIMAGE: '/opt/apps/Tandemise.AppImage',
  APPDIR: '/tmp/.mount_TandemXYZ',
  OWD: '/home/me',
  FACTORY_CDP_PORT: '9371',
  TANDEMISE_CDP_PORT: '9372',
  REMOTE_DEBUGGING_PORT: '9372',
  TANDEMISE_PORT: '47100',
};
const KEPT = { PATH: '/usr/bin', HOME: '/home/me', ELECTRON_MIRROR: 'https://mirror.example/electron/' };
const source = { ...KEPT, ...POINTERS, NODE_OPTIONS: '--max-old-space-size=4096 --inspect=127.0.0.1:9229' };
const dir = mkdtempSync(join(tmpdir(), 'tdm-app-port-'));

try {
  console.log('\n== the agent env plan (every runtime)');
  const plan = R.agentEnvPlan({ runId: 'run_a', display: 'off', source, homeRoot: join(dir, 'homes') });
  const missing = Object.keys(POINTERS).filter((n) => !plan.unset.includes(n));
  check('every variable that points at the person\'s app is removed', missing.length === 0, { missing, unset: plan.unset });
  check('inspector flags leave NODE_OPTIONS, the rest stays', plan.env.NODE_OPTIONS === '--max-old-space-size=4096', plan.env.NODE_OPTIONS);
  check('an install mirror is not a pointer at the app and stays', !plan.unset.includes('ELECTRON_MIRROR'), plan.unset);
  const onlyInspect = R.agentEnvPlan({ runId: 'run_b', display: 'off', source: { NODE_OPTIONS: '--inspect-brk' }, homeRoot: join(dir, 'homes') });
  check('NODE_OPTIONS that only opened a debugger is removed', onlyInspect.unset.includes('NODE_OPTIONS'), onlyInspect);

  console.log('\n== a runtime that inherits the whole environment (Codex, a generic CLI)');
  const worker = R.workerEnv({ runId: 'run_c', grants: [] }, source);
  const leaked = Object.keys(POINTERS).filter((n) => n in worker);
  check('none of it reaches the worker', leaked.length === 0, leaked);
  check('its NODE_OPTIONS has no inspector', worker.NODE_OPTIONS === '--max-old-space-size=4096', worker.NODE_OPTIONS);
  check('and it still gets PATH, HOME and its own TANDEMISE_HOME', worker.PATH === '/usr/bin' && worker.HOME === '/home/me' && worker.TANDEMISE_HOME?.includes('tandemise-agent-homes'), worker);

  console.log('\n== Claude Code (an allowlisted environment)');
  const saved = { ...process.env };
  Object.assign(process.env, POINTERS, { NODE_OPTIONS: source.NODE_OPTIONS });
  try {
    const now = new Date().toISOString();
    const profile = { id: ids.runtimeProfile(), workspaceId: ids.workspace(), adapterId: 'claude-code', name: 'p', executablePath: process.execPath, args: [], settings: {}, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now, updatedAt: now };
    const request = { runId: ids.run(), profile, prompt: 'x', workingDirectory: dir, grants: [], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 1000, signal: new AbortController().signal, log: nullLogger };
    const held = new ClaudeCodeAdapter().interactive(null, request, { sessionFile: join(dir, 's'), initialPrompt: null });
    const claudeLeaked = Object.keys(POINTERS).filter((n) => n in held.env);
    check('a Claude Code session gets none of it', claudeLeaked.length === 0, claudeLeaked);
    check('…and no inspector flag in NODE_OPTIONS', !/--inspect/.test(held.env.NODE_OPTIONS ?? ''), held.env.NODE_OPTIONS);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }

  console.log('\n== the factory script');
  const script = readFileSync(join(root, 'scripts', 'factory.sh'), 'utf8');
  check('it no longer opens a well-known DevTools port by default', !/remote-debugging-port="?\$port/.test(script) && !/FACTORY_CDP_PORT:-9371/.test(script), script.match(/.*remote-debugging.*/g));
  check('the port is opened only when asked (start --cdp or FACTORY_CDP=1), on a random port', /--cdp/.test(script) && /FACTORY_CDP/.test(script) && /--remote-debugging-port=0/.test(script), script.match(/.*(--cdp|FACTORY_CDP|remote-debugging).*/g));
  check('the port it got is written to a file only the person can read', /umask 077/.test(script), null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
