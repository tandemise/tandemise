// #107: an agent run gets its own TANDEMISE_HOME, never the person's, and a
// display only when its profile asks: this computer's, or a virtual one under
// xvfb-run.
//
//   npm run build && node scratch/agent-env-check.mjs
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const R = await import('@tandemise/runtimes-core');
const { ClaudeCodeAdapter } = await import('@tandemise/runtime-claude');
const CLAUDE_SETTINGS_SCHEMA = new ClaudeCodeAdapter().settingsSchema;
const { ids, nullLogger } = await import('@tandemise/shared');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'agent-env-'));
const homeRoot = join(dir, 'homes');
const source = { PATH: '/usr/bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', TANDEMISE_HOME: '/home/me/.tandemise' };

const off = R.agentEnvPlan({ runId: 'run_a', display: 'off', source, homeRoot });
check('every run gets its own TANDEMISE_HOME, made empty', off.env.TANDEMISE_HOME === join(homeRoot, 'run_a') && existsSync(off.env.TANDEMISE_HOME) && readdirSync(off.env.TANDEMISE_HOME).length === 0, off);
check('never the person\'s', off.env.TANDEMISE_HOME !== source.TANDEMISE_HOME);
check('off: no display and no wrapper', off.wrap === null && off.env.DISPLAY === undefined && off.display === 'no display', off);
const host = R.agentEnvPlan({ runId: 'run_b', display: 'host', source, homeRoot });
check('host: this computer\'s display passes through', host.env.DISPLAY === ':0' && host.env.WAYLAND_DISPLAY === 'wayland-0' && host.env.XDG_RUNTIME_DIR === '/run/user/1000' && host.wrap === null, host);
const virtual = R.agentEnvPlan({ runId: 'run_c', display: 'virtual', source, homeRoot, platform: 'linux', xvfbRun: '/usr/bin/xvfb-run' });
check('virtual: runs under xvfb-run -a, with no host display', virtual.wrap?.[0] === '/usr/bin/xvfb-run' && virtual.wrap[1] === '-a' && virtual.env.DISPLAY === undefined, virtual);
const missing = R.agentEnvPlan({ runId: 'run_d', display: 'virtual', source, homeRoot, platform: 'linux', xvfbRun: null });
check('virtual without xvfb-run says so and runs without', missing.wrap === null && missing.display === 'no display (xvfb-run is not installed)', missing);
check('the setting reads off, host or virtual', R.agentDisplaySetting({}) === 'off' && R.agentDisplaySetting({ display: 'host' }) === 'host' && R.agentDisplaySetting({ display: 'nonsense' }) === 'off');
check('Claude Code profiles offer it', CLAUDE_SETTINGS_SCHEMA.some((f) => f.key === 'display' && f.options.some((o) => o.value === 'virtual')));

// The adapter: a held session's invocation carries the run's home, and runs under the wrapper when asked.
const bin = join(dir, 'bin');
const { mkdirSync } = await import('node:fs');
mkdirSync(bin);
writeFileSync(join(bin, 'xvfb-run'), '#!/bin/sh\nexec "$@"\n');
chmodSync(join(bin, 'xvfb-run'), 0o755);
const now = new Date().toISOString();
const profile = (settings) => ({ id: ids.runtimeProfile(), workspaceId: ids.workspace(), adapterId: 'claude-code', name: 'p', executablePath: process.execPath, args: [], settings, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now, updatedAt: now });
const req = (settings) => ({ runId: ids.run(), profile: profile(settings), prompt: 'x', workingDirectory: dir, grants: [], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 1000, signal: new AbortController().signal, log: nullLogger });
const PATH = process.env.PATH;
const oldHome = process.env.TANDEMISE_HOME;
process.env.TANDEMISE_HOME = '/home/me/.tandemise';
try {
  const plain = new ClaudeCodeAdapter().interactive(null, req({}), { sessionFile: join(dir, 's'), initialPrompt: null });
  check('a held session gets its run\'s TANDEMISE_HOME, not the daemon\'s', typeof plain.env.TANDEMISE_HOME === 'string' && plain.env.TANDEMISE_HOME !== '/home/me/.tandemise' && plain.env.TANDEMISE_HOME.includes('tandemise-agent-homes'), plain.env.TANDEMISE_HOME);
  check('and runs the CLI itself', plain.file === process.execPath, plain.file);
  if (process.platform === 'linux') {
    process.env.PATH = `${bin}:${PATH}`;
    const wrapped = new ClaudeCodeAdapter().interactive(null, req({ display: 'virtual' }), { sessionFile: join(dir, 's'), initialPrompt: null });
    check('a virtual display wraps the CLI in xvfb-run -a', wrapped.file === join(bin, 'xvfb-run') && wrapped.args[0] === '-a' && wrapped.args.includes(process.execPath), [wrapped.file, wrapped.args.slice(0, 5)]);
  }
} finally {
  process.env.PATH = PATH;
  if (oldHome === undefined) delete process.env.TANDEMISE_HOME; else process.env.TANDEMISE_HOME = oldHome;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
