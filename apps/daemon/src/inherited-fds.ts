import { closeSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';

/**
 * Closes listening sockets this process inherited but never opened (#104).
 *
 * The desktop starts the daemon detached, and the daemon outlives the window.
 * Chromium does not mark every descriptor close-on-exec, so the daemon used to
 * inherit the window's DevTools socket (`--remote-debugging-port`): the port
 * stayed taken after the window quit, and the daemon could even accept a
 * DevTools connection meant for the window. At the very start of the daemon
 * nothing has listened yet, so every listening TCP socket it holds is one it
 * inherited. Linux only (it reads /proc); elsewhere it does nothing.
 *
 * Returns the descriptors it closed.
 */
export function closeInheritedListeners(proc = '/proc'): number[] {
  if (process.platform !== 'linux') return [];
  const listening = new Set<string>();
  for (const table of ['net/tcp', 'net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(`${proc}/self/${table}`, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // st 0A is LISTEN; column 9 is the socket's inode.
      if (cols[3] === '0A' && cols[9] !== undefined) listening.add(cols[9]);
    }
  }
  if (listening.size === 0) return [];
  const closed: number[] = [];
  let fds: string[];
  try {
    fds = readdirSync(`${proc}/self/fd`);
  } catch {
    return [];
  }
  for (const name of fds) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    let target: string;
    try {
      target = readlinkSync(`${proc}/self/fd/${name}`);
    } catch {
      continue;
    }
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode === undefined || !listening.has(inode)) continue;
    try {
      closeSync(fd);
      closed.push(fd);
    } catch {
      /* already gone */
    }
  }
  return closed;
}
