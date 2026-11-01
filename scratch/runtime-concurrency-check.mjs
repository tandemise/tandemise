// Issue #101: a runtime added with "Discover runtimes → Add" ran one thing at
// a time, and a mission waiting on a saturated runtime said nothing about it
// on the Board.
//
//   npm run build && node scratch/runtime-concurrency-check.mjs
//
// Pure rules first (the default concurrency and the waiting sentence, built
// from the executor's own reason), then a real daemon in process: a runtime
// created with no concurrency of its own takes the default, capped by the
// project's worker limit.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const D = await import('@tandemise/domain');
const R = await import('@tandemise/runtimes-core');

section('pure: the default concurrency');
{
  check('DEFAULT_RUNTIME_CONCURRENCY is 3', D.DEFAULT_RUNTIME_CONCURRENCY === 3, D.DEFAULT_RUNTIME_CONCURRENCY);
  check('a project allowing 3 workers: 3', D.defaultRuntimeConcurrency?.(3) === 3);
  check('a project allowing 8 workers: still 3', D.defaultRuntimeConcurrency?.(8) === 3);
  check('a project allowing 2 workers: 2, never above it', D.defaultRuntimeConcurrency?.(2) === 2);
  check('a project allowing 1 worker: 1', D.defaultRuntimeConcurrency?.(1) === 1);
  check('no project to read: 3', D.defaultRuntimeConcurrency?.(null) === 3);
}

section('pure: the waiting sentence, from the executor\'s own reason');
{
  // Exactly how the executor words a deferral on a saturated runtime
  // (task-executor.ts, `onlyBusy`): the manager's rejection, described.
  const busy = (name, n) => ({ profileId: `rtp_${n}`, profileName: name, reason: `saturated: ${n}/${n} runs in flight`, busy: true });
  const reason = (rejections) => `Waiting for a runtime slot. ${R.describeRejections(rejections)}`;
  check('one runtime: "Waiting for a free slot on Claude Code"',
    D.runtimeSlotWait?.(reason([busy('Claude Code', 1)])) === 'Waiting for a free slot on Claude Code', D.runtimeSlotWait?.(reason([busy('Claude Code', 1)])));
  check('two runtimes: "… on Claude Code or Codex"',
    D.runtimeSlotWait?.(reason([busy('Claude Code', 1), busy('Codex', 2)])) === 'Waiting for a free slot on Claude Code or Codex');
  check('three runtimes: "… on A, B or C"',
    D.runtimeSlotWait?.(reason([busy('A', 1), busy('B', 1), busy('C', 1)])) === 'Waiting for a free slot on A, B or C');
  check("a name with a colon and a quote survives", D.runtimeSlotWait?.(reason([busy("Ana's: Claude", 1)])) === "Waiting for a free slot on Ana's: Claude");
  check('any other reason is no slot wait', D.runtimeSlotWait?.('Waiting for you: sign in to Claude Code') === null && D.runtimeSlotWait?.(null) === null && D.runtimeSlotWait?.('') === null);
  check('a slot wait with no readable name still says it waits', D.runtimeSlotWait?.('Waiting for a runtime slot. ') === 'Waiting for a free runtime slot');
}

section('daemon: a runtime added with no concurrency takes the default');
const root = mkdtempSync(join(tmpdir(), 'trc-'));
const home = join(root, 'h');
globalThis.__sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
const daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 60_000 });
const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
const api = async (method, path, body) => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
try {
  const wsRes = await api('POST', '/v1/workspaces', { name: 'Concurrency' });
  const ws = wsRes.body?.workspace;
  check('a project with the default worker limit (3)', wsRes.status === 200 && ws?.concurrency?.maxTotalWorkers === 3, wsRes.body);
  // What "Discover runtimes → Add" sends: no maxConcurrent.
  const added = await api('POST', '/v1/runtimes', { adapterId: 'fake', name: 'Discovered', workspaceId: ws.id, settings: {}, enabled: true });
  check('Discover → Add with no concurrency: maxConcurrent 3', added.status === 200 && added.body?.maxConcurrent === 3, added.body);
  const explicit = await api('POST', '/v1/runtimes', { adapterId: 'fake', name: 'Explicit', workspaceId: ws.id, settings: {}, enabled: true, maxConcurrent: 5 });
  check('an explicit concurrency is kept', explicit.status === 200 && explicit.body?.maxConcurrent === 5, explicit.body);

  const lowered = await api('PATCH', `/v1/workspaces/${ws.id}`, { concurrency: { ...ws.concurrency, maxTotalWorkers: 2 } });
  check('the project now allows 2 workers', lowered.status === 200, lowered.body);
  const capped = await api('POST', '/v1/runtimes', { adapterId: 'fake', name: 'Capped', workspaceId: ws.id, settings: {}, enabled: true });
  check('a project allowing 2 workers: maxConcurrent 2', capped.status === 200 && capped.body?.maxConcurrent === 2, capped.body);

  const updated = await api('PATCH', `/v1/runtimes/${added.body.id}`, { maxConcurrent: 4 });
  check('the concurrency can be raised afterwards', updated.status === 200 && updated.body?.maxConcurrent === 4, updated.body);
} catch (e) {
  check('the daemon section ran', false, String(e?.stack ?? e));
} finally {
  await daemon.stop?.();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
