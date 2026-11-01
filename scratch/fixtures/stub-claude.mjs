// A stand-in for the `claude` CLI (#131) that records what it was given and acts like a run.
//
//   node stub-claude.mjs <claude args>      (wrapped by a two-line shell script as an executable)
//
// It writes { argv, prompt, cwd, skills } to $CLAUDE_CONFIG_DIR/records/<n>.json (only CLAUDE_*
// variables reach a worker), then prints a
// stream-json `system/init` record whose `skills` are what Claude Code would load from the flags
// it got: each `--plugin-dir`'s `skills/*` as `plugin:skill` (the plugin's name from its
// .claude-plugin/plugin.json) and the working folder's `.claude/skills/*`.
// A file named hide-skills in $CLAUDE_CONFIG_DIR makes it report none, as a plugin that fails to load would.
//
// A prompt that starts with a slash command whose skill is not loaded gets the CLI's answer for
// an unknown command and no work. Otherwise it writes each output the prompt asks for
// ("### <Type> → <path>") with a valid front matter, changes a file, and succeeds.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('2.1.316 (Claude Code)'); process.exit(0); }

let prompt = null;
const pluginDirs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-p' || argv[i] === '--print') {
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) prompt = argv[++i];
  } else if (argv[i] === '--plugin-dir') pluginDirs.push(argv[++i]);
}
if (prompt === null) prompt = readFileSync(0, 'utf8');

const skills = [];
for (const dir of pluginDirs) {
  let name = 'plugin';
  try { name = JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).name ?? name; } catch { /* keep */ }
  const root = join(dir, 'skills');
  if (existsSync(root)) for (const s of readdirSync(root).sort()) if (existsSync(join(root, s, 'SKILL.md'))) skills.push(`${name}:${s}`);
}
const local = join(process.cwd(), '.claude/skills');
if (existsSync(local)) for (const s of readdirSync(local).sort()) if (existsSync(join(local, s, 'SKILL.md'))) skills.push(s);
const config = process.env.CLAUDE_CONFIG_DIR ?? process.cwd();
if (existsSync(join(config, 'hide-skills'))) skills.length = 0;

const dir = join(config, 'records');
if (dir) {
  mkdirSync(dir, { recursive: true });
  const n = readdirSync(dir).length;
  writeFileSync(join(dir, `${String(n).padStart(3, '0')}.json`), JSON.stringify({ argv, prompt, cwd: process.cwd(), skills }, null, 2));
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const session = `stub-${process.pid}-${Date.now()}`;
out({ type: 'system', subtype: 'init', session_id: session, skills, slash_commands: skills, plugins: [] });

// Slow enough that a run told to stop at init is stopped before it does anything.
await new Promise((r) => setTimeout(r, 400));

const command = /^\/(\S+)/.exec(prompt)?.[1] ?? null;
if (command !== null && !skills.includes(command)) {
  out({ type: 'result', subtype: 'success', is_error: false, result: `Unknown skill: ${command}`, session_id: session });
  process.exit(0);
}

const FRONT = {
  ChangeSet: 'branch: stub/change\ncommits: []\nfilesChanged: 1\ntestsRun: []\nknownLimitations: []',
  ReviewReport: 'verdict: pass\nreviewedRef: HEAD\nfindings: []',
};
for (const m of prompt.matchAll(/^### ([A-Za-z]+) → (\S+)$/gm)) {
  const [, type, destination] = m;
  const path = resolve(process.cwd(), destination);
  mkdirSync(dirname(path), { recursive: true });
  const ran = command === null ? 'the role prompt' : `the skill /${command}`;
  writeFileSync(path, `---\ntype: ${type}\nschemaVersion: 1\ntitle: "${type} from the stub"\nhandoff:\n  headline: "${type} written by ${ran}"\n  points:\n    - "Ran ${ran}"\n${FRONT[type] ?? ''}\n---\n\n# ${type}\n\nWritten by ${ran}.\n`);
}
appendFileSync(join(process.cwd(), 'stub-change.txt'), `${command ?? 'role prompt'}\n`);
out({ type: 'assistant', message: { content: [{ type: 'text', text: command === null ? 'Done.' : `Ran /${command}.` }] }, session_id: session });
out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: session, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
