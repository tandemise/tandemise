// Runs the offline end-to-end checks in `scratch/` - the ones that need no model
// login, no network service, no browser and no macOS permission - one after
// another, and fails if any of them fails. This is what CI runs after the build.
//
// Checks that drive a real runtime (Claude, Codex, Gemini), Electron, Playwright,
// the macOS helper, a real `claude` binary or the Taskly demo app checkout
// (application-check) are left out on purpose; run those by hand (docs/QUICKSTART.md).
//
//   node scripts/run-checks.mjs              # every offline check
//   node scripts/run-checks.mjs resume-check # just the named ones
//
// Each check gets its own TMPDIR. The checks make scratch dirs with
// mkdtemp(tmpdir(), 'tdm-…') and leave them, and on Linux /tmp is on disk until
// reboot (three days of runs left ~2,000 dirs and 11 GB). The dir is removed when
// the check passes and kept, with its path printed, when it fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OFFLINE_CHECKS = [
  'about-check',
  'artifact-lineage-check',
  'artifact-write-scope-check',
  'brain-check',
  'brain-daemon-check',
  'concurrency-check',
  'coordination-check',
  'coordination-app-check',
  'coordination-daemon-check',
  'daemon-node-check',
  'daemon-upgrade-check',
  'demo-agent-check',
  'design-react-check',
  'env-leak-check',
  'agent-env-check',
  'first-run-words-check',
  'execution-check',
  'factory-loop-check',
  'feedback-loop-check',
  'fs-security-check',
  'gate-facts-check',
  'handoff-check',
  'intake-check',
  'intake-daemon-check',
  'intake-runners-check',
  'intake-tracker-check',
  'hold-check',
  'terminal-check',
  'hold-daemon-check',
  'inherited-fd-check',
  'mcp-integration-check',
  'multirepo-check',
  'p3-contributions-check',
  'p3-evals-check',
  'p5-done-when-check',
  'p6-ready-check',
  'p7-backlog-check',
  'p8-limits-check',
  'p9-liveness-check',
  'p10-desk-check',
  'p11-routines-check',
  'p12-models-check',
  'p13-skills-check',
  'p14-issues-check',
  'p16-notify-check',
  'p15-setup-check',
  'oauth-connect-check',
  'persistence-check',
  'plan-fit-check',
  'replan-check',
  'planner-steps-check',
  'planner-check',
  'merge-check',
  'ci-wait-check',
  'routing-check',
  'policy-eval-check',
  'relay-check',
  'resume-check',
  'review-sees-diff-check',
  'routing-overcommit-check',
  'runtime-concurrency-check',
  'round-redo-head-check',
  'rounds-check',
  'schema-constraint-check',
  'secrets-check',
  'shell-benign-check',
  'step-approval-check',
  'signin-check',
  'staffing-check',
  'trust-boundary-check',
  'version-check',
  'workflow-check',
];

const TIMEOUT_MS = 5 * 60_000;

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Keep this name short: daemons under test put Unix sockets in
    // <TANDEMISE_HOME>/sockets/<run id>.sock, and those paths are capped at
    // ~104-108 bytes. A long prefix here pushed hold-daemon-check over the cap.
    const tmp = mkdtempSync(join(tmpdir(), 'tdc-'));
    const child = spawn(process.execPath, [`scratch/${name}.mjs`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tmp },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0;
      if (ok) rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      else output += `\n(${name} scratch files kept in ${tmp})\n`;
      resolve({ name, ok, code: signal ?? code, output, ms: Date.now() - started });
    });
  });
}

const selected = process.argv.slice(2);
const unknown = selected.filter((n) => !OFFLINE_CHECKS.includes(n));
if (unknown.length) {
  console.error(`not an offline check: ${unknown.join(', ')}`);
  process.exit(2);
}

const failed = [];
for (const name of selected.length ? selected : OFFLINE_CHECKS) {
  const result = await run(name);
  console.log(`${result.ok ? '✓' : '✗'} ${name} (${(result.ms / 1000).toFixed(1)}s)`);
  if (!result.ok) {
    failed.push(name);
    console.log(`--- ${name} exited ${result.code} ---\n${result.output}\n--- end ${name} ---`);
  }
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nall offline checks passed');
