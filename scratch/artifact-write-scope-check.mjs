/**
 * A run granted `artifact.write` but not `filesystem.write` must be able to
 * deliver its artifact, and only its artifact.
 *
 * Found by running a research mission in the real app: every product, finance
 * and design run did its work and then failed `artifact.*.exists`, because
 * Write was disallowed for any run without `filesystem.write` - the documents
 * ended up pasted into the transcript instead of `.tandemise/out/`.
 *
 * The CLI half (an `Edit(.tandemise/out/**)` rule permits exactly that
 * directory under `--permission-mode default`, and refuses a write elsewhere
 * without prompting) was verified against Claude Code 2.1.269 by hand; this
 * pins the flags that rely on it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildInvocation } = await import(join(root, 'packages/runtime-claude/dist/index.js'));

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}${d ? '  ' + d : ''}`); else { bad++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const invoke = (grants, settings = {}) => buildInvocation({
  runId: 'run_x', prompt: 'p', workingDirectory: '/tmp/wt', grants, allowedRoots: [], mcpConfigPath: null,
  maxWallTimeMs: 1000, signal: new AbortController().signal, log: null,
  profile: { id: 'rt', adapterId: 'claude-code', settings, args: [], executablePath: null },
}, null).args;

console.log('── artifact.write without filesystem.write\n');
{
  const args = invoke(['repository.read', 'filesystem.read', 'artifact.write']);
  const disallowed = flag(args, '--disallowed-tools');
  ok('Write stays offered', !disallowed.split(',').includes('Write'), disallowed);
  ok('Edit stays offered', !disallowed.split(',').includes('Edit'));
  ok('Bash is still disallowed', disallowed.split(',').includes('Bash'));
  ok('NotebookEdit is still disallowed', disallowed.split(',').includes('NotebookEdit'));
  ok('writes are allowed only under .tandemise/out', flag(args, '--allowed-tools') === 'Edit(.tandemise/out/**)', flag(args, '--allowed-tools'));
  ok('permission mode stays default, so unmatched writes are refused', flag(args, '--permission-mode') === 'default');
}

console.log('\n── neither grant: fully read-only, as before\n');
{
  const args = invoke(['repository.read', 'filesystem.read']);
  const disallowed = flag(args, '--disallowed-tools').split(',');
  ok('Write disallowed', disallowed.includes('Write') && disallowed.includes('Edit'));
  ok('no allow rule', !args.includes('--allowed-tools'));
}

console.log('\n── filesystem.write: unscoped, as before\n');
{
  const args = invoke(['filesystem.write', 'shell.exec', 'artifact.write']);
  ok('nothing disallowed', !args.includes('--disallowed-tools'));
  ok('no artifact-only rule', !args.includes('--allowed-tools'));
}

console.log('\n── shell without filesystem.write (review, QA): commands run, edits stay scoped\n');
{
  // Found on a real mission: the reviewer could read the diff but every `npm test`
  // came back "This command requires approval", and the step still passed.
  // Verified against Claude Code 2.1.295: the same argv without the Bash rule
  // refuses `npm test`; with it the command runs.
  for (const [who, grants] of [
    ['review', ['repository.read', 'filesystem.read', 'shell.exec', 'artifact.write']],
    ['qa', ['repository.read', 'filesystem.read', 'shell.exec', 'tests.run', 'browser', 'browser.navigate', 'artifact.write']],
  ]) {
    const args = invoke(grants);
    const allowed = flag(args, '--allowed-tools').split(',');
    ok(`${who}: Bash is allowed by rule`, allowed.includes('Bash'), flag(args, '--allowed-tools'));
    ok(`${who}: BashOutput and KillShell too`, allowed.includes('BashOutput') && allowed.includes('KillShell'));
    ok(`${who}: edits still only under .tandemise/out`, allowed.includes('Edit(.tandemise/out/**)') && !allowed.includes('Edit'));
    ok(`${who}: mode stays default`, flag(args, '--permission-mode') === 'default');
    ok(`${who}: Bash is not disallowed`, !flag(args, '--disallowed-tools').split(',').includes('Bash'));
  }
  const pinned = invoke(['repository.read', 'shell.exec', 'artifact.write'], { permissionMode: 'default' });
  ok('a profile that pins its mode gets no shell rule', !flag(pinned, '--allowed-tools').split(',').includes('Bash'), flag(pinned, '--allowed-tools'));
  const developer = invoke(['filesystem.write', 'shell.exec', 'artifact.write']);
  ok('write + shell bypasses prompts and needs no rule', flag(developer, '--permission-mode') === 'bypassPermissions' && !developer.includes('--allowed-tools'));
}

console.log('\n── profile allow rules are kept alongside\n');
{
  const args = invoke(['artifact.write'], { allowedTools: 'WebFetch' });
  ok('both rules present', flag(args, '--allowed-tools') === 'Edit(.tandemise/out/**),WebFetch', flag(args, '--allowed-tools'));
}

console.log('\n── the user\'s own MCP servers never reach a run\n');
{
  const noTools = invoke(['repository.read']);
  ok('a run with no granted tools is still strict', noTools.includes('--strict-mcp-config'), noTools.join(' '));
  ok('and its MCP config is empty', flag(noTools, '--mcp-config') === '{"mcpServers":{}}');
}

console.log('\n── granted connected-app tools are callable headless\n');
{
  const withTools = buildInvocation({
    runId: 'run_x', prompt: 'p', workingDirectory: '/tmp/wt', grants: ['design', 'artifact.write'], allowedRoots: [],
    mcpConfigPath: '/tmp/mcp.json', maxWallTimeMs: 1000, signal: new AbortController().signal, log: null,
    profile: { id: 'rt', adapterId: 'claude-code', settings: {}, args: [], executablePath: null },
  }, null).args;
  // Verified by hand against Claude Code 2.1.269: without this rule every
  // mcp__tandemise__* call is refused in -p mode; with it the call goes through
  // and Tandemise's own policy gate decides.
  ok('the Tandemise gateway server is allowed', flag(withTools, '--allowed-tools').split(',').includes('mcp__tandemise'), flag(withTools, '--allowed-tools'));
  ok('and only that server', flag(withTools, '--mcp-config') === '/tmp/mcp.json' && withTools.includes('--strict-mcp-config'));
}

console.log('\n── the user\'s personal settings stay out of workers\n');
{
  const isolated = invoke(['repository.read']);
  ok('user settings are excluded by default', flag(isolated, '--setting-sources') === 'project,local', isolated.join(' '));
  const inherited = invoke(['repository.read'], { userSettings: 'inherit' });
  ok('a profile can opt back in', !inherited.includes('--setting-sources'));
}

console.log('\n── a working directory reached through a symlink stays readable\n');
{
  // The child's cwd resolves the link, so Claude Code only trusts the real
  // path; the prompt names the linked one. Seen on a real run: every Glob of
  // the repository was refused ("requested permissions to read from ...").
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tdm-link-')));
  const real = join(base, 'real');
  const extra = join(base, 'extra');
  mkdirSync(real); mkdirSync(extra);
  symlinkSync(real, join(base, 'linked'));
  symlinkSync(extra, join(base, 'extra-linked'));
  const at = (workingDirectory, allowedRoots = []) => buildInvocation({
    runId: 'run_x', prompt: 'p', workingDirectory, grants: ['repository.read'], allowedRoots, mcpConfigPath: null,
    maxWallTimeMs: 1000, signal: new AbortController().signal, log: null,
    profile: { id: 'rt', adapterId: 'claude-code', settings: {}, args: [], executablePath: null },
  }, null).args;
  const dirs = (args) => args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
  const linked = dirs(at(join(base, 'linked')));
  ok('the linked working directory is declared', linked.includes(join(base, 'linked')), linked.join(' '));
  ok('a real working directory declares nothing extra', dirs(at(real)).length === 0, dirs(at(real)).join(' '));
  const roots = dirs(at(real, [join(base, 'extra-linked')]));
  ok('a linked extra root is declared under both spellings', roots.includes(join(base, 'extra-linked')) && roots.includes(extra), roots.join(' '));
  ok('a missing root is still declared as given', dirs(at(real, [join(base, 'nope')])).includes(join(base, 'nope')));
  ok('a root inside the working directory is not declared', dirs(at(real, [join(real, 'sub')])).length === 0);
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n${bad === 0 ? 'ALL ARTIFACT WRITE SCOPE CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
