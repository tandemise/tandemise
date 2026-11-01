// #147: a worker's shell cannot use the person's GitHub credentials, while
// the broker's GitHub tools (run by the daemon, with its environment) still
// work.
//
//   npm run build && node scratch/worker-credentials-check.mjs
//
// A stand-in `gh` that behaves like the real one where it matters here: it is
// signed in only through GH_TOKEN / GITHUB_TOKEN or a hosts.yml in its config
// directory (GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else ~/.config/gh), and it
// records every write it was allowed to make. The person is signed in both
// ways. A worker's environment is built exactly as each runtime builds it.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const R = await import('@tandemise/runtimes-core');
const { ClaudeCodeAdapter } = await import('@tandemise/runtime-claude');
const G = await import('@tandemise/integration-github');
const { ids, nullLogger } = await import('@tandemise/shared');

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const root = mkdtempSync(join(tmpdir(), 'worker-creds-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
const writes = join(root, 'writes.jsonl');
mkdirSync(join(home, '.config', 'gh'), { recursive: true });
mkdirSync(bin);
writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: gho_person_secret\n    user: person\n');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const env = process.env;
const dir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'gh') : path.join(env.HOME || '', '.config', 'gh'));
let token = env.GH_TOKEN || env.GITHUB_TOKEN || '';
try { const m = /oauth_token:\\s*(\\S+)/.exec(fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8')); if (!token && m) token = m[1]; } catch {}
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') { if (token) { console.error('Logged in to github.com'); process.exit(0); } console.error('You are not logged into any GitHub hosts. To log in, run: gh auth login'); process.exit(1); }
if (!token) { console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4); }
const write = (args[0] === 'pr' && args[1] === 'create') || (args[0] === 'api' && args.some((a, i) => (a === '-X' || a === '--method') && /POST|PATCH|PUT|DELETE/i.test(args[i + 1] || '')));
if (write) fs.appendFileSync(${JSON.stringify(writes)}, JSON.stringify({ args, token }) + '\\n');
if (args[0] === 'pr' && args[1] === 'list') { console.log('[]'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'create') { console.log('https://github.com/acme/web/pull/7'); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify({ number: 7, url: 'https://github.com/acme/web/pull/7', title: 'T', state: 'OPEN', isDraft: true })); process.exit(0); }
if (args[0] === 'api') { console.log('{"number":8}'); process.exit(0); }
process.exit(0);
`;
writeFileSync(join(bin, 'gh'), FAKE_GH);
chmodSync(join(bin, 'gh'), 0o755);

/** The daemon's own environment: the person, signed in through both a token and gh's config. */
const daemonEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'ghp_person_env', GITHUB_TOKEN: 'ghp_person_env', XDG_CONFIG_HOME: '' };
delete daemonEnv.XDG_CONFIG_HOME;
delete daemonEnv.GH_CONFIG_DIR;
const writesSoFar = () => (existsSync(writes) ? readFileSync(writes, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const shell = (env, command) => spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
const run = { runId: ids.run(), grants: ['filesystem.write', 'shell', 'github.pr.create'] };

section('a worker shell (Codex, generic CLI: the daemon\'s environment minus credentials)');
{
  const env = R.workerEnv(run, daemonEnv);
  check('no token variable reaches it', env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined, Object.keys(env).filter((k) => /TOKEN/.test(k)));
  check('gh gets an empty config directory of the run\'s own', typeof env.GH_CONFIG_DIR === 'string' && env.GH_CONFIG_DIR.includes(run.runId) && !existsSync(join(env.GH_CONFIG_DIR, 'hosts.yml')), env.GH_CONFIG_DIR);
  const before = writesSoFar().length;
  const status = shell(env, 'gh auth status');
  check('gh auth status: signed out', status.status !== 0, status.stderr);
  const pr = shell(env, 'gh pr create --repo acme/web --head b --base main --title T --body x');
  check('gh pr create fails', pr.status !== 0 && /gh auth login/.test(pr.stderr), [pr.status, pr.stderr]);
  const api = shell(env, 'gh api -X POST repos/acme/web/pulls -f head=b -f base=main -f title=T');
  check('gh api -X POST …/pulls fails', api.status !== 0, [api.status, api.stderr]);
  check('…and GitHub saw no write from the worker', writesSoFar().length === before, writesSoFar());
  // The person's git hands out a credential through a helper; the worker's git gets none.
  writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=person; echo password=gho_from_helper; }; f"\n');
  const ask = 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill';
  const personFill = shell({ ...daemonEnv, GIT_TERMINAL_PROMPT: '0' }, ask);
  const workerFill = shell(env, ask);
  check('the person\'s git gives out a credential (the helper works)', personFill.stdout.includes('password=gho_from_helper'), personFill);
  check('the worker\'s git gives out none: its helpers are cleared and it cannot prompt', !workerFill.stdout.includes('password=') && workerFill.status !== 0, [workerFill.status, workerFill.stdout, workerFill.stderr]);
  const curl = shell(env, 'printf %s "${GH_TOKEN}${GITHUB_TOKEN}"');
  check('curl has no token to send: none is in the environment', curl.stdout === '', curl.stdout);
}

section('a Claude Code worker (its allowlisted environment minus credentials)');
{
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, PATH: daemonEnv.PATH, GH_TOKEN: 'ghp_person_env', GITHUB_TOKEN: 'ghp_person_env', SSH_AUTH_SOCK: '/tmp/agent.sock', GIT_ASKPASS: '/usr/bin/askpass' });
  delete process.env.XDG_CONFIG_HOME; delete process.env.GH_CONFIG_DIR;
  try {
    const now = new Date().toISOString();
    const profile = { id: ids.runtimeProfile(), workspaceId: ids.workspace(), adapterId: 'claude-code', name: 'p', executablePath: process.execPath, args: [], settings: {}, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now, updatedAt: now };
    const req = (grants) => ({ runId: ids.run(), profile, prompt: 'x', workingDirectory: root, grants, allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 1000, signal: new AbortController().signal, log: nullLogger });
    const env = new ClaudeCodeAdapter().interactive(null, req(['filesystem.write', 'shell']), { sessionFile: join(root, 's'), initialPrompt: null }).env;
    const before = writesSoFar().length;
    check('no token, no ssh agent, no askpass', env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined && env.SSH_AUTH_SOCK === undefined && env.GIT_ASKPASS === undefined, Object.keys(env));
    check('git\'s credential helpers are cleared and it never prompts', env.GIT_CONFIG_KEY_0 === 'credential.helper' && env.GIT_CONFIG_VALUE_0 === '' && env.GIT_TERMINAL_PROMPT === '0');
    const pr = shell(env, 'gh pr create --repo acme/web --head b --base main --title T --body x');
    const api = shell(env, 'gh api --method POST repos/acme/web/pulls -f head=b');
    check('gh pr create and gh api both fail from its shell', pr.status !== 0 && api.status !== 0, [pr.stderr, api.stderr]);
    check('…and GitHub saw no write', writesSoFar().length === before, writesSoFar());
    const pusher = new ClaudeCodeAdapter().interactive(null, req(['filesystem.write', 'shell', 'git.push']), { sessionFile: join(root, 's'), initialPrompt: null }).env;
    check('a step granted git.push keeps git\'s credentials (ssh agent, and a gh helper with the person\'s config)',
      pusher.SSH_AUTH_SOCK === '/tmp/agent.sock' && pusher.GIT_CONFIG_KEY_0 === 'credential.helper' && pusher.GIT_CONFIG_VALUE_0?.includes(join(home, '.config', 'gh')), { ssh: pusher.SSH_AUTH_SOCK, helper: pusher.GIT_CONFIG_VALUE_0, gh: pusher.GH_CONFIG_DIR });
    const pushPr = shell(pusher, 'gh pr create --repo acme/web --head b --base main --title T --body x');
    check('…but even there gh itself is signed out: no pull request from the shell', pushPr.status !== 0 && pusher.GH_TOKEN === undefined, pushPr.stderr);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

section('the broker: the daemon runs github.pr.create with its own environment');
{
  const daemonExec = {
    run: (req) => {
      const r = spawnSync(req.command, req.args ?? [], { cwd: req.cwd ?? root, env: { ...daemonEnv, ...(req.env ?? {}) }, input: req.stdin, encoding: 'utf8' });
      return Promise.resolve({ exitCode: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), timedOut: false, durationMs: 0, command: req.command });
    },
  };
  const tool = G.githubTools('int_github', G.githubConfigSchema.parse({})).find((t) => t.name === 'github.pr.create');
  const before = writesSoFar().length;
  let out = null; let error = null;
  try { out = await tool.execute({ exec: daemonExec, workingDirectory: root }, tool.inputSchema.parse({ repo: 'acme/web', title: 'T', head: 'b' })); } catch (e) { error = String(e?.message ?? e); }
  const after = writesSoFar();
  check('the broker opens the pull request with the person\'s sign-in', error === null && after.length === before + 1 && after.at(-1).args.slice(0, 2).join(' ') === 'pr create', { error, out, after });
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
