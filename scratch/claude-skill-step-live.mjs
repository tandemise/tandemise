// #131 against the real `claude` CLI: what the adapter decides from Claude Code's own init record.
//
//   node scratch/claude-skill-step-live.mjs <claude config dir> <plugin name>:<skill>
//
// Give it a throwaway CLAUDE_CONFIG_DIR where the plugin was installed with `claude plugin install`
// (never your own ~/.claude). It resolves the skill the way a step does, runs the real CLI once with
// it, and once with a skill the plugin lacks (the files check skipped, so only the init check can
// catch it), and prints what each run reported. Without a login the first run ends signed out after
// its init record: that still proves the plugin loaded and the skill was there.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@tandemise/shared';
import { ClaudeCodeAdapter, buildInvocation, resolveClaudeSkill } from '@tandemise/runtime-claude';

const [config, name] = process.argv.slice(2);
if (!config || !name) { console.error('usage: claude-skill-step-live.mjs <claude config dir> <plugin:skill>'); process.exit(2); }
const work = mkdtempSync(join(tmpdir(), 'tdm-skill-live-'));
const settings = { configDir: config };
const profile = { id: 'rtp_live', workspaceId: null, adapterId: 'claude-code', name: 'live', executablePath: null, args: [], settings, capabilities: [], enabled: true, maxConcurrent: 1, createdAt: '', updatedAt: '' };
const log = createLogger({ level: 'error', base: {} });

const found = await resolveClaudeSkill(settings, name, [work]);
console.log('resolve', name, '->', JSON.stringify(found));
if (!found.ok) process.exit(1);

const adapter = new ClaudeCodeAdapter();
const runOnce = async (skillName) => {
  const request = {
    runId: `run_live_${Date.now()}`, profile, prompt: 'Reply with the word READY.', workingDirectory: work, grants: [], allowedRoots: [],
    mcpConfigPath: null, maxWallTimeMs: 90_000, signal: new AbortController().signal, log,
    skill: { name: skillName, args: 'KEY-1', pluginDirs: found.pluginDirs },
  };
  console.log(`\n== ${skillName}`);
  console.log('argv:', buildInvocation(request, null).args.slice(0, 2).map((a) => JSON.stringify(a)).join(' '), '…', buildInvocation(request, null).args.filter((a, i, all) => all[i - 1] === '--plugin-dir').join(' '));
  for await (const event of adapter.start(request)) {
    if (event.type === 'failed' || event.type === 'completed' || event.type === 'message') console.log(event.type, JSON.stringify(event).slice(0, 300));
  }
};
await runOnce(name);
await runOnce(`${name.split(':')[0]}:ghost-skill`);
