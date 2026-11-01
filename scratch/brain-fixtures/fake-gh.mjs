#!/usr/bin/env node
/**
 * A fake `gh` for the brain checks (#51). Never touches the network.
 *
 *   - appends `{ argv, cwd, stdin }` as one JSON line to $FAKE_GH_LOG;
 *   - `auth status` succeeds;
 *   - `repo create <owner>/<name>` runs `git init --bare -b main` at
 *     $FAKE_GH_REMOTES/<owner>/<name>.git and prints its GitHub URL;
 *     it fails, as gh does, when that repository already exists;
 *   - `repo view <owner>/<name> --json isEmpty` says whether it has any ref;
 *   - `pr create` prints https://github.com/garipass/brain/pull/<n> and
 *     remembers the head branch;
 *   - `pr list --head <b>` prints that PR (or []);
 *   - `pr view <url> --json state` prints the state in $FAKE_GH_STATE/<n>, or OPEN.
 *
 * Put a `gh` wrapper that runs this script first on PATH.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
let stdin = '';
if (argv.includes('--body-file') && argv[argv.indexOf('--body-file') + 1] === '-') {
  try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }
}
const log = process.env.FAKE_GH_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ argv, cwd: process.cwd(), stdin })}\n`);
const state = process.env.FAKE_GH_STATE ?? join(process.cwd(), '.fake-gh-state');
mkdirSync(state, { recursive: true });
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const prsFile = join(state, 'prs.json');
const prs = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : [];
const stateOf = (n) => {
  const f = join(state, String(n));
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : 'OPEN';
};

const [a, b] = argv;
if (a === 'auth' && b === 'status') {
  console.log('Logged in to github.com as fake');
  process.exit(0);
}
if (a === 'auth' && b === 'git-credential') process.exit(0);
if (a === 'repo' && b === 'create') {
  const [owner, name] = argv[2].split('/');
  const remotes = process.env.FAKE_GH_REMOTES;
  const dir = join(remotes, owner, `${name}.git`);
  if (existsSync(dir)) {
    console.error('GraphQL: Name already exists on this account (createRepository)');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', dir]);
  console.log(`https://github.com/${owner}/${name}`);
  process.exit(0);
}
if (a === 'repo' && b === 'view') {
  const [owner, name] = argv[2].split('/');
  const dir = join(process.env.FAKE_GH_REMOTES, owner, `${name}.git`);
  if (!existsSync(dir)) {
    console.error(`GraphQL: Could not resolve to a Repository with the name '${owner}/${name}'.`);
    process.exit(1);
  }
  const refs = execFileSync('git', ['-C', dir, 'for-each-ref'], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ isEmpty: refs === '' }));
  process.exit(0);
}
if (a === 'pr' && b === 'create') {
  const n = prs.length + 1;
  prs.push({ n, head: flag('--head'), title: flag('--title'), draft: argv.includes('--draft') });
  writeFileSync(prsFile, JSON.stringify(prs));
  console.log(`https://github.com/garipass/brain/pull/${n}`);
  process.exit(0);
}
if (a === 'pr' && b === 'list') {
  const head = flag('--head');
  const found = prs.filter((p) => p.head === head).map((p) => ({ url: `https://github.com/garipass/brain/pull/${p.n}`, state: stateOf(p.n) }));
  console.log(JSON.stringify(found));
  process.exit(0);
}
if (a === 'pr' && b === 'view') {
  const n = Number(/\/pull\/(\d+)/.exec(argv[2] ?? '')?.[1] ?? 0);
  console.log(JSON.stringify({ state: stateOf(n) }));
  process.exit(0);
}
console.error(`fake gh: unsupported ${argv.join(' ')}`);
process.exit(1);
