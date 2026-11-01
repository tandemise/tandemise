#!/usr/bin/env node
// A stand-in for the GitHub CLI, for P14's offline check and acceptance run.
//
// Installed as an executable `gh` first on the daemon's PATH (installFakeGh),
// it serves issues and comments from <dir>/state.json and appends every call
// to <dir>/calls.jsonl, so a check can say exactly what Tandemise asked GitHub
// to do. It knows only the commands Tandemise's issue sync uses:
//
//   gh auth status
//   gh issue list --repo o/r --label L --state open --limit N --json …
//   gh issue view N --repo o/r --json …
//   gh issue close N --repo o/r
//   gh api user
//   gh api [--hostname h] [--paginate] repos/o/r/issues/N/comments?per_page=100
//     (with `pageSize` in the state: one page without --paginate, every page
//     printed back to back with it, as gh prints them)
//   gh api [--hostname h] -X POST repos/o/r/issues/N/comments -f body=…
//   gh api [--hostname h] -X PATCH repos/o/r/issues/comments/ID -f body=…
//
// And the pull requests the ship step (#53) opens, checks and merges:
//
//   gh pr list --repo o/r --head B --state all --json …
//   gh pr create --repo o/r --head B --base main --title T --body-file -   (body on stdin)
//   gh pr view N --repo o/r --json …
//   gh pr edit N --repo o/r --add-reviewer R…
//   gh pr merge N --repo o/r --squash|--merge|--rebase --match-head-commit SHA [--auto] --subject S --body B
//   gh pr update-branch N --repo o/r
//   gh pr checks B|N [--required] [--repo o/r]   (a plan's CI wait step, with gh's exit codes)
//   gh api repos/o/r                       (allow_auto_merge; `repo view --json autoMergeAllowed` fails, as in gh 2.103)
//   gh api repos/o/r/commits/SHA/check-runs
//   gh api repos/o/r/branches/B/protection
//   gh api repos/o/r/commits?sha=B&since=…
//   gh api repos/o/r/commits/SHA                      (its parent: `parents` in the state, else git's)
//   gh api repos/o/r/actions/runs?head_sha=SHA        (`workflowRuns` in the state, by sha)
//   gh api repos/o/r/actions/runs/ID/jobs
//
// and, for intake's GitHub Issues tracker (intake plan Task 5):
//
//   gh issue create --repo o/r --title T --body B [--label L]…   (prints the URL)
//   gh issue list --repo o/r --search Q --state open|closed|all --limit N --json …
//   gh issue edit N --repo o/r [--add-label L]… [--remove-label L]… [--add-assignee x] [--body B]
//   gh issue reopen N --repo o/r
//   gh search issues "<text>" --repo o/r [--state open|closed] --limit N --json …
//   gh label list --repo o/r --limit N --json name
//   gh label create L --repo o/r [--force]
//
// A search query keeps `is:open`, `is:closed`, `label:x` / `label:"x y"` and
// `in:title` as qualifiers; its other words must all appear (case-insensitive)
// in the title, or in the title and body without `in:title`.
// `gh search issues` matches its text (quotes dropped) as a substring of the
// title, the body or a comment, and answers lowercase states, like gh.
//
// The state directory is passed by the wrapper script (--fake-state <dir>)
// because the daemon hands child processes an allow-listed environment only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);

/** Writes `<dir>/bin/gh` (a wrapper around this script) and an empty state; returns the bin folder for PATH. */
export function installFakeGh(dir, initial = {}) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const wrapper = join(dir, 'bin', 'gh');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" --fake-state "${dir}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  if (!existsSync(join(dir, 'state.json'))) writeState(dir, { login: 'tandemise-owner', nextCommentId: 9001, repos: {}, ...initial });
  if (!existsSync(join(dir, 'calls.jsonl'))) writeFileSync(join(dir, 'calls.jsonl'), '');
  return join(dir, 'bin');
}

/**
 * The state file is written whole (temp file, then rename), so a reader never sees half of it. A parse error is still
 * retried briefly, for a reader on a filesystem where rename isn't atomic.
 */
export function readState(dir) {
  const path = join(dir, 'state.json');
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (!(e instanceof SyntaxError) || attempt >= 50) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export function writeState(dir, state) {
  const tmp = join(dir, `state.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(dir, 'state.json'));
}

/** Adds or replaces an issue; `labels` are names. */
export function putIssue(dir, repo, issue) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  const full = {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.url ?? `https://github.com/${repo}/issues/${issue.number}`,
    updatedAt: issue.updatedAt ?? new Date().toISOString(),
    labels: (issue.labels ?? ['tandemise']).map((name) => ({ name })),
    author: { login: issue.author ?? 'sam' },
    state: issue.state ?? 'OPEN',
  };
  r.issues = [...r.issues.filter((i) => i.number !== issue.number), full];
  writeState(dir, state);
  return full;
}

export function patchIssue(dir, repo, number, patch) {
  const state = readState(dir);
  const issue = state.repos[repo]?.issues.find((i) => i.number === number);
  if (!issue) throw new Error(`no issue ${repo}#${number}`);
  Object.assign(issue, patch, { updatedAt: patch.updatedAt ?? new Date(Date.parse(issue.updatedAt) + 60_000).toISOString() });
  writeState(dir, state);
  return issue;
}

export function commentsOf(dir, repo, number) {
  return readState(dir).repos[repo]?.comments[String(number)] ?? [];
}

/** Adds a comment as someone (a contributor, or the signed-in user when `login` is omitted). */
export function addComment(dir, repo, number, body, login) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  const list = (r.comments[String(number)] ??= []);
  const comment = { id: state.nextCommentId++, body, user: { login: login ?? state.login } };
  list.push(comment);
  writeState(dir, state);
  return comment;
}

/** Adds or replaces a pull request (helpers for a check to move its state). */
export function putPullRequest(dir, repo, pr) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  r.prs = [...(r.prs ?? []).filter((p) => p.number !== pr.number), pr];
  writeState(dir, state);
  return pr;
}

export function pullRequests(dir, repo) {
  return readState(dir).repos[repo]?.prs ?? [];
}

/**
 * The check runs GitHub reports on a commit: `[{ name, status, conclusion, logTail, id?, startedAt?, app? }]`.
 * A re-run is another entry with the same name and a later `startedAt` (or higher `id`), as GitHub lists it.
 */
export function setChecks(dir, repo, sha, checks) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  (r.checks ??= {})[sha] = checks;
  writeState(dir, state);
}

/**
 * The GitHub Actions workflow runs on a commit:
 * `[{ id, name, path, event, head_branch, status, conclusion, html_url, jobs: [{ name, status, conclusion, html_url }] }]`.
 */
export function setRuns(dir, repo, sha, runs) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  (r.workflowRuns ??= {})[sha] = runs;
  writeState(dir, state);
}

export function setRepo(dir, repo, patch) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  Object.assign(r, patch);
  writeState(dir, state);
}

export function calls(dir) {
  return readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Sets the repository's labels, as `gh label list` answers them. */
export function putLabels(dir, repo, names) {
  const state = readState(dir);
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  r.labels = [...names];
  writeState(dir, state);
}

// ------------------------------------------------------------------ the CLI

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Every value of a repeatable flag, in order. */
function flags(args, name) {
  return args.flatMap((a, i) => (a === name && i + 1 < args.length ? [args[i + 1]] : []));
}

/** Does an issue match a `--search` query (qualifiers and words, see the header)? */
function searchMatches(issue, query) {
  let rest = query;
  const labels = [];
  let wantState = null;
  let titleOnly = false;
  rest = rest.replace(/\blabel:(?:"([^"]*)"|(\S+))/g, (_, quoted, bare) => { labels.push(quoted ?? bare); return ' '; });
  rest = rest.replace(/\bis:(open|closed)\b/gi, (_, s) => { wantState = s.toUpperCase(); return ' '; });
  rest = rest.replace(/\bis:issue\b/gi, ' ');
  rest = rest.replace(/\bin:title\b/gi, () => { titleOnly = true; return ' '; });
  const words = rest.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  if (wantState !== null && issue.state !== wantState) return false;
  if (!labels.every((l) => issue.labels.some((x) => x.name === l))) return false;
  const haystack = (titleOnly ? issue.title : `${issue.title}\n${issue.body}`).toLowerCase();
  return words.every((w) => haystack.includes(w));
}

function pick(object, fields) {
  if (fields === undefined) return object;
  return Object.fromEntries(fields.split(',').map((f) => [f, object[f]]));
}

function main(argv) {
  const dir = flag(argv, '--fake-state');
  if (dir === undefined) fail('fake gh: no --fake-state');
  const args = argv.slice(argv.indexOf('--fake-state') + 2);
  appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ args, at: new Date().toISOString() })}\n`);
  const state = readState(dir);
  if (state.failNext) {
    // One scripted failure, e.g. an expired login, for the error path.
    const message = state.failNext;
    delete state.failNext;
    writeState(dir, state);
    fail(message);
  }
  // GitHub down for a while: every call fails while `failAll` is set.
  if (state.failAll) fail(state.failAll);
  const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const repoOf = (name) => state.repos[name] ?? { issues: [], comments: {} };

  const [group, verb] = args;
  if (group === 'pr') { prCommand(dir, state, args, out); return; }
  if (group === 'repo' && verb === 'view') {
    // Like gh 2.103: `autoMergeAllowed` is not a JSON field `repo view` knows.
    if (args.includes('autoMergeAllowed')) fail('Unknown JSON field: "autoMergeAllowed"');
    out({ name: args[2] });
    return;
  }
  if (group === 'auth' && verb === 'status') { process.stderr.write(`Logged in to github.com account ${state.login}\n`); return; }
  if (group === 'issue') {
    const repo = flag(args, '--repo');
    if (repo === undefined) fail('fake gh: --repo is required');
    const r = repoOf(repo);
    if (verb === 'list') {
      const label = flag(args, '--label');
      const wanted = (flag(args, '--state') ?? 'open').toUpperCase();
      const limit = Number(flag(args, '--limit') ?? 30);
      const search = flag(args, '--search');
      const rows = r.issues
        .filter((i) => (wanted === 'ALL' || i.state === wanted) && (label === undefined || i.labels.some((l) => l.name === label)))
        .filter((i) => search === undefined || searchMatches(i, search))
        .sort((a, b) => b.number - a.number)
        .slice(0, limit)
        .map((i) => pick(i, flag(args, '--json')));
      out(rows);
      return;
    }
    if (verb === 'create') {
      const title = flag(args, '--title');
      const body = flag(args, '--body');
      if (title === undefined || body === undefined) fail('fake gh: issue create needs --title and --body');
      const stored = (state.repos[repo] ??= { issues: [], comments: {} });
      const number = Math.max(0, ...stored.issues.map((i) => i.number)) + 1;
      const at = new Date().toISOString();
      const url = `https://github.com/${repo}/issues/${number}`;
      stored.issues.push({
        number, title, body, url, createdAt: at, updatedAt: at,
        labels: flags(args, '--label').map((name) => ({ name })), author: { login: state.login }, state: 'OPEN',
      });
      writeState(dir, state);
      process.stdout.write(`${url}\n`);
      return;
    }
    const number = Number(args[2]);
    const issue = r.issues.find((i) => i.number === number);
    if (issue === undefined) fail(`GraphQL: Could not resolve to an issue or pull request with the number of ${number}. (repository.issue)`);
    if (verb === 'view') { out(pick(issue, flag(args, '--json'))); return; }
    if (verb === 'close') {
      issue.state = 'CLOSED';
      writeState(dir, state);
      process.stderr.write(`✓ Closed issue ${repo}#${number}\n`);
      return;
    }
    if (verb === 'reopen') {
      issue.state = 'OPEN';
      issue.updatedAt = new Date().toISOString();
      writeState(dir, state);
      process.stderr.write(`✓ Reopened issue ${repo}#${number}\n`);
      return;
    }
    if (verb === 'edit') {
      const remove = new Set(flags(args, '--remove-label'));
      const kept = issue.labels.filter((l) => !remove.has(l.name));
      // Like gh: a label the repository doesn't have is refused, when the repository's labels are known.
      for (const name of flags(args, '--add-label')) if (r.labels !== undefined && !r.labels.includes(name)) fail(`could not add label: '${name}' not found`);
      for (const name of flags(args, '--add-label')) if (!kept.some((l) => l.name === name)) kept.push({ name });
      issue.labels = kept;
      const assignees = flags(args, '--add-assignee');
      if (assignees.length > 0) issue.assignees = [...(issue.assignees ?? []), ...assignees.map((login) => ({ login }))];
      const body = flag(args, '--body');
      if (body !== undefined) issue.body = body;
      issue.updatedAt = new Date().toISOString();
      writeState(dir, state);
      process.stdout.write(`${issue.url}\n`);
      return;
    }
    fail(`fake gh: unknown issue command ${verb}`);
  }
  if (group === 'search' && verb === 'issues') {
    const repo = flag(args, '--repo');
    if (repo === undefined) fail('fake gh: --repo is required');
    const r = repoOf(repo);
    const text = (args[2] ?? '').replace(/"/g, '');
    const wanted = flag(args, '--state')?.toUpperCase();
    const limit = Number(flag(args, '--limit') ?? 30);
    const rows = r.issues
      .filter((i) => wanted === undefined || i.state === wanted)
      .filter((i) => [i.title, i.body, ...(r.comments[String(i.number)] ?? []).map((c) => c.body)].some((t) => t.includes(text)))
      .sort((a, b) => b.number - a.number)
      .slice(0, limit)
      .map((i) => pick({ ...i, state: i.state.toLowerCase() }, flag(args, '--json')));
    out(rows);
    return;
  }
  if (group === 'label' && verb === 'create') {
    const repo = flag(args, '--repo');
    if (repo === undefined) fail('fake gh: --repo is required');
    const r = repoOf(repo);
    r.labels ??= [...new Set(r.issues.flatMap((i) => i.labels.map((l) => l.name)))];
    if (!r.labels.includes(args[2])) r.labels.push(args[2]);
    else if (!args.includes('--force')) fail(`label with name "${args[2]}" already exists; use \`--force\` to update its color and description`);
    writeState(dir, state);
    return;
  }
  if (group === 'label' && verb === 'list') {
    const repo = flag(args, '--repo');
    if (repo === undefined) fail('fake gh: --repo is required');
    const r = repoOf(repo);
    const names = r.labels ?? [...new Set(r.issues.flatMap((i) => i.labels.map((l) => l.name)))];
    out(names.map((name) => pick({ name }, flag(args, '--json'))));
    return;
  }
  if (group === 'api') {
    const rest = args.slice(1);
    const method = (flag(rest, '-X') ?? flag(rest, '--method') ?? 'GET').toUpperCase();
    const endpoint = rest.find((a, i) => !a.startsWith('-') && !['-X', '--method', '-f', '--hostname', '-H'].includes(rest[i - 1]));
    const body = rest.find((a, i) => rest[i - 1] === '-f' && a.startsWith('body='))?.slice('body='.length);
    if (endpoint === 'user') { out({ login: state.login }); return; }
    const path = (endpoint ?? '').split('?')[0];
    const repoRead = /^repos\/([^/]+\/[^/]+)$/.exec(path);
    if (repoRead && method === 'GET') { out({ full_name: repoRead[1], allow_auto_merge: repoOf(repoRead[1]).autoMergeAllowed === true }); return; }
    let c = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs$/.exec(path);
    if (c) {
      // A repository's `defaultChecks` stand for every commit that has none of its own;
      // `defaultCheckSequence` answers each read with the next list (the last one repeats), for NONE → PENDING → PASS.
      const r = repoOf(c[1]);
      let runs = (r.checks ?? {})[c[2]];
      if (runs === undefined && Array.isArray(r.defaultCheckSequence) && r.defaultCheckSequence.length > 0) {
        runs = r.defaultCheckSequence[0];
        if (r.defaultCheckSequence.length > 1) { r.defaultCheckSequence.shift(); writeState(dir, state); }
      }
      runs ??= r.defaultChecks ?? [];
      const query = new URLSearchParams((endpoint ?? '').split('?')[1] ?? '');
      const per = Number(query.get('per_page') ?? 30);
      const page = Number(query.get('page') ?? 1);
      const slice = runs.slice((page - 1) * per, page * per);
      out({ total_count: runs.length, check_runs: slice.map((k, i) => ({ id: k.id ?? (page - 1) * per + i + 1, started_at: k.startedAt ?? null, app: { id: k.appId ?? 15368, slug: k.app ?? 'github-actions' }, name: k.name, status: k.status ?? 'completed', conclusion: k.conclusion ?? null, details_url: k.link ?? null, output: { summary: null, text: k.logTail ?? null } })) });
      return;
    }
    // GitHub Actions: a commit's workflow runs (`workflowRuns` per sha), their jobs, and a commit's parent.
    c = /^repos\/([^/]+\/[^/]+)\/actions\/runs$/.exec(path);
    if (c) {
      const sha = new URLSearchParams((endpoint ?? '').split('?')[1] ?? '').get('head_sha');
      const runs = (repoOf(c[1]).workflowRuns ?? {})[sha] ?? [];
      out({ total_count: runs.length, workflow_runs: runs.map(({ jobs, ...run }) => run) });
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (c) {
      const run = Object.values(repoOf(c[1]).workflowRuns ?? {}).flat().find((x) => String(x.id) === c[2]);
      out({ total_count: run?.jobs?.length ?? 0, jobs: run?.jobs ?? [] });
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{7,40})$/.exec(path);
    if (c) {
      let parent = (repoOf(c[1]).parents ?? {})[c[2]];
      if (parent === undefined) {
        try {
          execFileSync('git', ['fetch', '-q', 'origin'], { stdio: 'ignore' });
          parent = execFileSync('git', ['rev-parse', `${c[2]}^`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch { parent = null; }
      }
      out({ sha: c[2], parents: parent === null ? [] : [{ sha: parent }] });
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-suites$/.exec(path);
    if (c) {
      const suites = (repoOf(c[1]).suites ?? {})[c[2]] ?? [];
      out({ total_count: suites.length, check_suites: suites });
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/status$/.exec(path);
    if (c) {
      const statuses = (repoOf(c[1]).statuses ?? {})[c[2]] ?? [];
      const state = statuses.length === 0 ? 'pending' : statuses.some((x) => x.state === 'failure' || x.state === 'error') ? 'failure' : statuses.some((x) => x.state === 'pending') ? 'pending' : 'success';
      out({ state, total_count: statuses.length, statuses });
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/branches\/([^/]+)\/protection$/.exec(path);
    if (c) {
      const p = repoOf(c[1]).protection;
      if (p === undefined) fail('gh: Branch not protected (HTTP 404)');
      out(p);
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/rules\/branches\/([^/]+)$/.exec(path);
    if (c) {
      if (repoOf(c[1]).rulesUnavailable) fail('gh: Resource not accessible by integration (HTTP 403)');
      out(repoOf(c[1]).rules ?? []);
      return;
    }
    c = /^repos\/([^/]+\/[^/]+)\/commits$/.exec(path);
    if (c) {
      out((repoOf(c[1]).mainCommits ?? []).map((k) => ({ sha: k.sha, commit: { message: k.subject } })));
      return;
    }
    let m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (m) {
      const r = (state.repos[m[1]] ??= { issues: [], comments: {} });
      const list = (r.comments[m[2]] ??= []);
      if (method === 'GET') {
        // `state.pageSize` (a check sets it) makes GitHub's paging visible: without
        // --paginate only the first page; with it every page, each printed as its
        // own JSON array one after another, as gh does. Unset, the whole list.
        const size = state.pageSize;
        if (size === undefined) { out(list); return; }
        if (!rest.includes('--paginate')) { out(list.slice(0, size)); return; }
        const pages = [];
        for (let i = 0; i < list.length; i += size) pages.push(JSON.stringify(list.slice(i, i + size)));
        process.stdout.write(`${pages.length === 0 ? '[]' : pages.join('')}\n`);
        return;
      }
      if (method === 'POST') {
        if (body === undefined) fail('fake gh: POST needs -f body=');
        const comment = { id: state.nextCommentId++, body, user: { login: state.login } };
        list.push(comment);
        writeState(dir, state);
        out(comment);
        return;
      }
    }
    m = /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(path);
    if (m && method === 'PATCH') {
      const r = repoOf(m[1]);
      const comment = Object.values(r.comments).flat().find((c) => c.id === Number(m[2]));
      if (comment === undefined) fail('gh: Not Found (HTTP 404)');
      if (comment.user.login !== state.login) fail('gh: Resource not accessible by integration (HTTP 403)');
      comment.body = body;
      writeState(dir, state);
      out(comment);
      return;
    }
    fail(`fake gh: unknown api call ${method} ${endpoint}`);
  }
  fail(`fake gh: unknown command ${args.join(' ')}`);
}

function prCommand(dir, state, args, out) {
  const verb = args[1];
  if (verb === 'checks') { prChecks(state, args); return; }
  const repo = flag(args, '--repo');
  if (repo === undefined) fail('fake gh: --repo is required');
  const r = (state.repos[repo] ??= { issues: [], comments: {} });
  const prs = (r.prs ??= []);
  const save = () => writeState(dir, state);
  if (verb === 'list') {
    const head = flag(args, '--head');
    out(prs.filter((p) => head === undefined || p.headRefName === head).map((p) => pick(p, flag(args, '--json'))));
    return;
  }
  if (verb === 'create') {
    const head = flag(args, '--head');
    const bodyFile = flag(args, '--body-file');
    const body = bodyFile === '-' ? readFileSync(0, 'utf8') : bodyFile !== undefined ? readFileSync(bodyFile, 'utf8') : (flag(args, '--body') ?? '');
    let sha = '0'.repeat(40);
    try { sha = execFileSync('git', ['rev-parse', `refs/heads/${head}`], { encoding: 'utf8' }).trim(); } catch { /* not a local branch */ }
    const number = (state.nextPrNumber ?? 1);
    state.nextPrNumber = number + 1;
    const pr = {
      number, url: `https://github.com/${repo}/pull/${number}`, title: flag(args, '--title') ?? '', body,
      headRefName: head, headRefOid: sha, baseRefName: flag(args, '--base') ?? 'main', state: 'OPEN',
      isDraft: args.includes('--draft'), mergedBy: null, mergeCommit: null, reviewers: [], reviews: [],
    };
    prs.push(pr);
    save();
    process.stdout.write(`${pr.url}\n`);
    return;
  }
  const number = Number(args[2]);
  // Like gh, `pr view` also takes the head branch's name.
  const pr = Number.isNaN(number) ? prs.find((p) => p.headRefName === args[2]) : prs.find((p) => p.number === number);
  if (pr === undefined) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${number}.`);
  if (verb === 'view') { out(pick(pr, flag(args, '--json'))); return; }
  if (verb === 'edit') {
    args.forEach((a, i) => { if (a === '--add-reviewer') pr.reviewers.push(args[i + 1]); });
    save();
    return;
  }
  if (verb === 'update-branch') {
    pr.headRefOid = `${pr.headRefOid.slice(0, 39)}u`.replace(/[^0-9a-fu]/g, '0').replace('u', 'e');
    save();
    return;
  }
  if (verb === 'merge' && args.includes('--disable-auto')) {
    delete pr.autoMerge;
    save();
    return;
  }
  if (verb === 'merge') {
    // A push that lands between a decision and its merge (`moveHeadOnMerge`), once.
    if (r.moveHeadOnMerge) { pr.headRefOid = r.moveHeadOnMerge; delete r.moveHeadOnMerge; save(); }
    const match = flag(args, '--match-head-commit');
    if (match !== pr.headRefOid) fail(`GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)`);
    if (pr.state !== 'OPEN') fail(`GraphQL: Pull request is not open (mergePullRequest)`);
    if (args.includes('--auto')) {
      pr.autoMerge = { method: ['--squash', '--merge', '--rebase'].find((m) => args.includes(m)) };
      // A repository with `autoMergeQueues` holds the merge until its checks pass, as GitHub does.
      if (r.autoMergeQueues) { save(); return; }
    }
    pr.state = 'MERGED';
    pr.mergedBy = { login: state.login };
    // A real squash commit on the base when the remote is a local repository, so a revert has something to undo.
    let oid = `${'f'.repeat(32)}${String(number).padStart(8, '0')}`;
    try {
      const g = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      g('fetch', '-q', 'origin', pr.baseRefName, pr.headRefName);
      const tree = g('rev-parse', `origin/${pr.headRefName}^{tree}`);
      const parent = g('rev-parse', `origin/${pr.baseRefName}`);
      oid = execFileSync('git', ['-c', 'user.name=GitHub', '-c', 'user.email=noreply@github.com', 'commit-tree', tree, '-p', parent, '-m', flag(args, '--subject') ?? pr.title], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      g('push', '-q', 'origin', `${oid}:refs/heads/${pr.baseRefName}`);
    } catch { /* not a local remote: a made-up merge commit */ }
    pr.mergeCommit = { oid };
    pr.mergeSubject = flag(args, '--subject');
    pr.mergeBody = flag(args, '--body');
    save();
    return;
  }
  fail(`fake gh: unknown pr command ${verb}`);
}

/**
 * `gh pr checks <branch|number> [--required] [--repo o/r]`, with gh's exit codes: 0 when every check passed,
 * 8 while any is pending, 1 when one failed or there is nothing to report. With `--required`, a repository
 * without `protection.required_status_checks` has no required checks, so it always answers 1, as gh does.
 * Without --repo, the one repository in the state that has pull requests.
 */
function prChecks(state, args) {
  const repo = flag(args, '--repo') ?? Object.keys(state.repos).find((k) => (state.repos[k].prs ?? []).length > 0);
  const r = repo === undefined ? undefined : state.repos[repo];
  const selector = args.slice(2).find((a, i, all) => !a.startsWith('-') && !['--repo', '-R'].includes(all[i - 1]));
  const pr = (r?.prs ?? []).filter((p) => String(p.number) === selector || p.headRefName === selector).sort((a, b) => b.number - a.number)[0];
  if (pr === undefined) fail(`no pull requests found for branch "${selector}"`);
  if (args.includes('--required') && r.protection?.required_status_checks == null) {
    fail(`no required checks reported on the '${pr.headRefName}' branch`);
  }
  const all = (r.checks ?? {})[pr.headRefOid] ?? r.defaultChecks ?? [];
  // gh shows the latest run of each check, as GitHub does.
  const latest = new Map();
  all.forEach((k, i) => {
    const at = [k.startedAt ?? '', k.id ?? i];
    const known = latest.get(k.name);
    if (known === undefined || at[0] > known.at[0] || (at[0] === known.at[0] && at[1] > known.at[1])) latest.set(k.name, { k, at });
  });
  const runs = [...latest.values()].map((x) => x.k);
  if (runs.length === 0) fail(`no checks reported on the '${pr.headRefName}' branch`);
  for (const k of runs) process.stdout.write(`${k.name}\t${k.status === 'completed' || k.status === undefined ? (k.conclusion ?? 'pass') : 'pending'}\n`);
  if (runs.some((k) => (k.status ?? 'completed') === 'completed' && !['success', 'neutral', 'skipped'].includes(k.conclusion ?? ''))) process.exit(1);
  if (runs.some((k) => (k.status ?? 'completed') !== 'completed')) process.exit(8);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));
