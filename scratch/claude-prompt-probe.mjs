// Probe: which first-run dialogs real Claude Code shows for a set of flags.
// Never answers a dialog (that would write the person's Claude config); it
// reads the screen for a few seconds, prints the text, and kills the CLI.
//
//   node scratch/claude-prompt-probe.mjs <cwd> <seconds> -- <claude args...>
import pty from 'node-pty';

const [cwd, seconds, sep, ...args] = process.argv.slice(2);
if (sep !== '--') throw new Error('usage: <cwd> <seconds> -- <args...>');

const env = { ...process.env, TERM: 'xterm-256color' };
const child = pty.spawn(process.env.CLAUDE_BIN ?? 'claude', args, { cols: 120, rows: 40, cwd, env, name: 'xterm-256color' });
let raw = '';
child.onData((d) => { raw += d; });
// PROBE_KEYS (a JSON string) is typed once, PROBE_AT seconds in; the screen after it follows a marker.
if (process.env.PROBE_KEYS) {
  setTimeout(() => { raw += '\n=== typed ===\n'; child.write(JSON.parse(process.env.PROBE_KEYS)); }, Number(process.env.PROBE_AT ?? 4) * 1000);
}
await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
child.kill();
// eslint-disable-next-line no-control-regex
const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ' ').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b./g, '');
const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
const seen = new Set();
for (const l of lines) { if (!seen.has(l)) { seen.add(l); console.log(l); } }
