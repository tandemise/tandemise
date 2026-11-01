// #104: the daemon closes listening sockets it inherited (the window's DevTools
// port), so the port is free once the window quits.
//
//   npm run build && node scratch/inherited-fd-check.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};

const listen = () => new Promise((done, fail) => { const s = createServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => done(s)); });
const freeToBind = (port) => new Promise((done) => { const s = createServer(); s.once('error', () => done(false)); s.listen(port, '127.0.0.1', () => s.close(() => done(true))); });

/** A child that inherits `server` as fd 3, optionally runs closeInheritedListeners, and stays alive until told. */
async function withChild(server, closeIt) {
  const module = join(root, 'apps/daemon/dist/inherited-fds.js');
  const script = `const m = await import(${JSON.stringify(module)}); const closed = ${closeIt} ? m.closeInheritedListeners() : []; process.stdout.write(JSON.stringify(closed) + '\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit', server._handle], windowsHide: true });
  const closed = await new Promise((done) => child.stdout.once('data', (d) => done(JSON.parse(String(d)))));
  return { closed, end: () => new Promise((done) => { child.once('close', done); child.stdin.end(); }) };
}

if (process.platform !== 'linux') {
  console.log('  skip (reads /proc; Linux only)');
} else {
  // Without the fix the inherited listener keeps the port after its owner closes it.
  {
    const server = await listen();
    const port = server.address().port;
    const child = await withChild(server, false);
    await new Promise((done) => server.close(done));
    check('a child that does nothing keeps the inherited port taken', await freeToBind(port) === false, port);
    await child.end();
  }
  {
    const server = await listen();
    const port = server.address().port;
    const child = await withChild(server, true);
    check('closeInheritedListeners closes the inherited listening socket (fd 3)', child.closed.includes(3), child.closed);
    await new Promise((done) => server.close(done));
    check('so the port is free once its owner closes it, while the child lives on', await freeToBind(port) === true, port);
    await child.end();
  }
  {
    const { closeInheritedListeners } = await import(join(root, 'apps/daemon/dist/inherited-fds.js'));
    check('with nothing inherited it closes nothing', closeInheritedListeners().length === 0);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
