// #147 on the real Claude Code and the real `gh`: a worker built exactly as
// the Claude Code adapter builds it is asked to use GitHub from its shell.
// Spends a little real usage.
//
//   CLAUDE_CONFIG_DIR_FOR_CHECK=<a throwaway, signed-in config dir> node scratch/worker-credentials-live.mjs
//
// The config dir must be one of its own (never ~/.claude.json): Claude Code
// may write to it. Only `gh auth status` (which masks the token) and the
// account's login are asked for; nothing is written to GitHub.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ClaudeCodeAdapter } = await import('@tandemise/runtime-claude');
const { ids, nullLogger } = await import('@tandemise/shared');

const configDir = process.env.CLAUDE_CONFIG_DIR_FOR_CHECK;
if (!configDir) throw new Error('set CLAUDE_CONFIG_DIR_FOR_CHECK to a throwaway, signed-in Claude config dir');
const claude = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim();
const control = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
console.log(`control (the person's own shell): gh api user -> exit ${control.status}, login ${control.stdout.trim() || '(none)'}`);

const dir = mkdtempSync(join(tmpdir(), 'worker-live-'));
const now = new Date().toISOString();
const profile = { id: ids.runtimeProfile(), workspaceId: ids.workspace(), adapterId: 'claude-code', name: 'p', executablePath: claude, args: [], settings: { configDir }, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: now, updatedAt: now };
const request = { runId: ids.run(), profile, prompt: 'x', workingDirectory: dir, grants: ['filesystem.write', 'shell', 'github.pr.create'], allowedRoots: [], mcpConfigPath: null, maxWallTimeMs: 300000, signal: new AbortController().signal, log: nullLogger };
const { env } = new ClaudeCodeAdapter().interactive(null, request, { sessionFile: join(dir, 's'), initialPrompt: null });

const prompt = 'Run exactly these two shell commands with the Bash tool, one after the other: `gh auth status` and `gh api user --jq .login`. Then reply with one line per command: the command, its exit code, and the first line of its output. Do not try anything else.';
const out = spawnSync(claude, ['-p', prompt, '--model', 'haiku', '--permission-mode', 'acceptEdits', '--allowed-tools', 'Bash', '--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd: dir, env, encoding: 'utf8', timeout: 240000 });
console.log(`\nworker (Claude Code ${spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout.trim()}), exit ${out.status}:\n${out.stdout.trim()}`);
if (out.stderr.trim()) console.log(`stderr: ${out.stderr.trim().slice(0, 500)}`);
const signedOut = /not logged in|gh auth login|exit code[: ]+[1-9]/i.test(out.stdout) && !out.stdout.includes(control.stdout.trim() || '\u0000');
console.log(`\n${control.status === 0 && signedOut ? 'PASS' : 'CHECK BY HAND'}: the person is signed in, the worker's gh is not`);
rmSync(dir, { recursive: true, force: true });
