#!/usr/bin/env node
// A stand-in for YouTrack's REST API, for intake's offline checks and
// acceptance run (plan 2026-10-30-intake Task 4). Never a real YouTrack.
//
// In process: `startFakeYouTrack(options)` serves on 127.0.0.1 on a free port
// and hands back its state, so a check can say exactly what the adapter asked
// YouTrack to do. As a script, for the acceptance run:
//
//   node scratch/fake-youtrack.mjs --port 0 --state <dir> [--project ACME] [--token perm:test] [--login tandemise-bot] [--states A,B,…]
//
// it writes its base URL to <dir>/url and persists everything to
// <dir>/state.json after each change (and reads it back on start).
//
// It knows only the endpoints the YouTrack adapter uses:
//
//   GET  /api/users/me
//   GET  /api/admin/projects?query=<shortName>
//   GET  /api/admin/projects/<id>/customFields
//   GET  /api/issues?query=…&$top=N
//   GET  /api/issues/<key>
//   POST /api/issues
//   POST /api/commands                      State X | Type X | Assignee x | <Field> X … | duplicates KEY
//                                           (a value with a space is braced: State {In Progress})
//   GET  /api/issues/<key>/comments
//   POST /api/issues/<key>/comments
//   POST /api/issues/<key>/comments/<id>
//   POST /api/issues/<key>/attachments      (multipart; names only)
//
// The acceptance run seeds, edits and inspects it over HTTP, never through the token:
//
//   POST /_fake/issues          { idReadable?, summary, description, state, type, tags?, parent?, … }  puts an issue
//   POST /_fake/issues/<key>    { state?, description?, … }                             a person edits it
//   GET  /_fake/state                                                                   issues, comments, commands, calls (with their authorization)
//
// Search: `project: P` scopes, `#Unresolved` drops resolved items, a quoted
// string is a substring match on summary, description and comments, and the
// remaining words must all appear in the summary. `sort by: …` is ignored;
// results are newest-updated first.
//
// Tags and subtasks (#136): an issue's `tags` is a list of names, and an issue
// whose `parent` names another is one of that issue's subtasks. An issue read
// answers `tags(name)` and `subtasks(issues(idReadable,resolved))` only when
// its `fields` ask for them, as YouTrack does.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_STATES = ['Open', 'Submitted', 'In Progress', 'In Review', 'Fixed', 'Done', "Won't fix", 'Duplicate', 'Obsolete'];
const DEFAULT_RESOLVED = ['Fixed', 'Done', "Won't fix", 'Duplicate', 'Obsolete'];
const PROJECT_ID = '0-1';

/** A command's words, where `{In Progress}` is one word (braced) and its braces are dropped. */
function commandTokens(query) {
  return [...query.trim().matchAll(/\{([^}]*)\}|(\S+)/g)].map((m) => (m[1] !== undefined ? { text: m[1], braced: true } : { text: m[2], braced: false }));
}

export async function startFakeYouTrack(options = {}) {
  const project = options.project ?? 'ACME';
  const states = options.states ?? DEFAULT_STATES;
  const resolvedStates = new Set(options.resolved ?? DEFAULT_RESOLVED.filter((s) => states.includes(s)));
  const types = options.types ?? ['Bug', 'Task'];
  /** States YouTrack refuses for an unassigned issue, as a team's workflow can (#187). */
  const requireAssignee = options.requireAssignee ?? [];
  const token = options.token ?? 'perm:test';
  const login = options.login ?? 'tandemise-bot';
  const extraFields = options.fields ?? ['Priority', 'Subsystem'];
  const FIELD_NAMES = ['State', 'Type', 'Assignee', ...extraFields];
  const persist = options.stateDir ? join(options.stateDir, 'state.json') : null;

  /** key → issue */
  const issues = new Map();
  /** key → [{ id, text, author, created }] */
  const comments = new Map();
  /** key → [{ name, size }] */
  const attachments = new Map();
  /** every command, in order: { query, issues: [{ idReadable }] } */
  const commands = [];
  /** Fields set through POST /api/issues/<id> customFields (#187), in order: `{ issue, fields: ["State=In Progress"] }`. */
  const fieldSets = [];
  /** every request: { method, path, query (URLSearchParams), authorization, accept } */
  const calls = [];
  const delays = new Map();
  /** path → seconds: the next request there answers 429 with that Retry-After (Ruling 26). */
  const limits = new Map();
  let nextIssue = 1;
  let nextComment = 1;
  let lastTime = 0;
  const now = () => (lastTime = Math.max(Date.now(), lastTime + 1));

  if (persist && existsSync(persist)) {
    const saved = JSON.parse(readFileSync(persist, 'utf8'));
    for (const i of saved.issues ?? []) issues.set(i.idReadable, i);
    for (const [k, v] of saved.comments ?? []) comments.set(k, v);
    for (const [k, v] of saved.attachments ?? []) attachments.set(k, v);
    commands.push(...(saved.commands ?? []));
    nextIssue = saved.nextIssue ?? nextIssue;
    nextComment = saved.nextComment ?? nextComment;
  }
  const save = () => {
    if (!persist) return;
    writeFileSync(persist, JSON.stringify({
      issues: [...issues.values()], comments: [...comments], attachments: [...attachments], commands, nextIssue, nextComment,
    }, null, 2));
  };

  const putIssue = (i) => {
    const key = i.idReadable ?? `${project}-${nextIssue}`;
    const n = Number(key.split('-').pop());
    if (Number.isInteger(n) && n >= nextIssue) nextIssue = n + 1;
    const t = now();
    const issue = {
      id: `2-${n}`, idReadable: key, summary: '', description: '', created: t, updated: t, resolved: null,
      state: states[0], type: null, assignee: null, fields: {}, links: [], tags: [], parent: null, ...i,
    };
    if (i.state !== undefined) issue.resolved = resolvedStates.has(i.state) ? t : null;
    issues.set(key, issue);
    save();
    return issue;
  };
  const setState = (key, state) => {
    const issue = issues.get(key);
    if (!issue) throw new Error(`no issue ${key}`);
    issue.state = state;
    issue.resolved = resolvedStates.has(state) ? now() : null;
    issue.updated = now();
    save();
  };
  const putComment = (key, c) => {
    const list = comments.get(key) ?? [];
    const comment = { id: `4-${nextComment++}`, text: c.text, author: c.author ?? login, created: now() };
    list.push(comment);
    comments.set(key, list);
    save();
    return comment;
  };

  const issueJson = (i, fields = '') => ({
    ...(fields.includes('tags(') ? { tags: (i.tags ?? []).map((name) => ({ $type: 'IssueTag', name })) } : {}),
    ...(fields.includes('subtasks(') ? {
      subtasks: {
        $type: 'IssueLink',
        issues: [...issues.values()].filter((c) => c.parent === i.idReadable)
          .map((c) => ({ $type: 'Issue', idReadable: c.idReadable, resolved: c.resolved })),
      },
    } : {}),
    $type: 'Issue',
    id: i.id,
    idReadable: i.idReadable,
    summary: i.summary,
    description: i.description,
    created: i.created,
    updated: i.updated,
    resolved: i.resolved,
    project: { $type: 'Project', shortName: project },
    customFields: [
      { $type: 'StateIssueCustomField', name: 'State', value: { $type: 'StateBundleElement', name: i.state } },
      { $type: 'SingleEnumIssueCustomField', name: 'Type', value: i.type === null ? null : { $type: 'EnumBundleElement', name: i.type } },
      { $type: 'SingleUserIssueCustomField', name: 'Assignee', value: i.assignee === null ? null : { $type: 'User', login: i.assignee, name: i.assignee } },
      // Like YouTrack, every field of the project, an empty one with a null value.
      ...[...new Set([...extraFields, ...Object.keys(i.fields)])].map((name) => ({ $type: 'SingleEnumIssueCustomField', name, value: i.fields[name] === undefined ? null : { $type: 'EnumBundleElement', name: i.fields[name] } })),
    ],
  });
  const findIssue = (idOrKey) => issues.get(idOrKey) ?? [...issues.values()].find((i) => i.id === idOrKey);

  const matches = (issue, q) => {
    let rest = q.replace(/\bsort by:.*$/i, ' ');
    const quoted = [];
    rest = rest.replace(/"([^"]*)"/g, (_, s) => { quoted.push(s); return ' '; });
    let scoped = null;
    rest = rest.replace(/\bproject:\s*(\{[^}]*\}|\S+)/i, (_, p) => { scoped = p.replace(/[{}]/g, ''); return ' '; });
    let unresolved = false;
    rest = rest.replace(/#Unresolved\b/gi, () => { unresolved = true; return ' '; });
    const words = rest.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
    if (scoped !== null && scoped !== project) return false;
    if (unresolved && issue.resolved !== null) return false;
    const haystack = [issue.summary, issue.description, ...(comments.get(issue.idReadable) ?? []).map((c) => c.text)].join('\n');
    if (!quoted.every((s) => haystack.includes(s))) return false;
    const summary = issue.summary.toLowerCase();
    return words.every((w) => summary.includes(w));
  };

  const applyCommand = (query, issue) => {
    const tokens = query.trim().split(/\s+/);
    if (tokens[0] === 'duplicates') {
      const of = findIssue(tokens[1]);
      if (!of) return `Unknown issue ${tokens[1]}`;
      // A link set, as YouTrack's: the same command again adds nothing.
      if (!issue.links.some((l) => l.type === 'duplicates' && l.of === of.idReadable)) issue.links.push({ type: 'duplicates', of: of.idReadable });
      if (states.includes('Duplicate')) {
        issue.state = 'Duplicate';
        issue.resolved = now();
      }
      return null;
    }
    // Like YouTrack, a value with a space is braced (`State {In Progress}`):
    // a field takes exactly one value, a single word or one braced group, so
    // an unbraced `State In Progress` is refused rather than guessed at.
    const pairs = [];
    for (const t of commandTokens(query)) {
      if (!t.braced && FIELD_NAMES.includes(t.text)) pairs.push([t.text, []]);
      else if (pairs.length === 0) return `Unknown command ${query}`;
      // A second word after a value: the value had a space in it (#187).
      else if (pairs.at(-1)[1].length > 0) return `${pairs.at(-1)[0]} expected: {${[...pairs.at(-1)[1], t.text].join(' ')}}`;
      else pairs.at(-1)[1].push(t.text);
    }
    for (const [field, words] of pairs) {
      const value = words[0] ?? '';
      if (value === '') return `No value for ${field}`;
      // What a real YouTrack answered for `State {In Progress}` (#187): a
      // command does not take a value with a space, braced or not. Set such a
      // value through the issue's customFields instead.
      if (/\s/.test(value)) return `${field} expected: {${value}}`;
      if (field === 'State') {
        if (!states.includes(value)) return `Unknown state ${value}`;
        // A workflow rule some teams have: this state needs an assignee first.
        if (requireAssignee.includes(value) && issue.assignee === null && !pairs.some(([f]) => f === 'Assignee')) return `Assignee is required for ${value}`;
        issue.state = value;
        issue.resolved = resolvedStates.has(value) ? now() : null;
      } else if (field === 'Type') {
        if (!types.includes(value)) return `Unknown type ${value}`;
        issue.type = value;
      } else if (field === 'Assignee') {
        issue.assignee = value;
      } else {
        issue.fields[field] = value;
      }
    }
    return null;
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;
    // The acceptance run's own door (plan Task 14): no token, never something the adapter calls.
    if (path.startsWith('/_fake/')) {
      const raw = await readBody(req);
      const body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
      const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      let k;
      if (req.method === 'POST' && path === '/_fake/issues') return reply(200, putIssue(body));
      if (req.method === 'POST' && (k = path.match(/^\/_fake\/issues\/([^/]+)$/))) {
        const issue = issues.get(decodeURIComponent(k[1]));
        if (!issue) return reply(404, { error: 'no such issue' });
        const { state, ...rest } = body;
        Object.assign(issue, rest);
        issue.updated = now();
        if (state !== undefined) setState(issue.idReadable, state); else save();
        return reply(200, issue);
      }
      if (req.method === 'GET' && path === '/_fake/state') {
        return reply(200, {
          issues: [...issues.values()], comments: Object.fromEntries(comments), commands, fieldSets,
          calls: calls.map((c) => ({ method: c.method, path: c.path, query: c.query.toString(), authorization: c.authorization })),
        });
      }
      return reply(404, { error: `no fake route ${req.method} ${path}` });
    }
    calls.push({ method: req.method, path, query: u.searchParams, authorization: req.headers.authorization ?? null, accept: req.headers.accept ?? null });
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const fail = (status, error, description) => send(status, { error, error_description: description });
    try {
      const raw = await readBody(req);
      // A delay for this method and path wins over one for the path alone.
      const delayKey = delays.has(`${req.method} ${path}`) ? `${req.method} ${path}` : path;
      const delay = delays.get(delayKey);
      if (delay !== undefined) {
        delays.delete(delayKey);
        await new Promise((r) => setTimeout(r, delay));
      }
      const limit = limits.get(path);
      if (limit !== undefined) {
        limits.delete(path);
        if (res.destroyed) return;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(limit) });
        res.end(JSON.stringify({ error: 'Too Many Requests' }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) return fail(401, 'Unauthorized', 'You are not logged in.');
      const json = () => (raw.length === 0 ? {} : JSON.parse(raw.toString('utf8')));
      let m;

      if (req.method === 'GET' && path === '/api/users/me') return send(200, { $type: 'Me', login });
      if (req.method === 'GET' && path === '/api/admin/projects') {
        const q = u.searchParams.get('query') ?? '';
        return send(200, q === '' || q === project ? [{ $type: 'Project', id: PROJECT_ID, shortName: project }] : []);
      }
      if (req.method === 'GET' && (m = path.match(/^\/api\/admin\/projects\/([^/]+)\/customFields$/))) {
        if (m[1] !== PROJECT_ID) return fail(404, 'Not Found', 'Entity with id not found');
        return send(200, [
          { $type: 'StateProjectCustomField', field: { name: 'State' }, bundle: { values: states.map((name) => ({ name })) } },
          { $type: 'EnumProjectCustomField', field: { name: 'Type' }, bundle: { values: types.map((name) => ({ name })) } },
          { $type: 'UserProjectCustomField', field: { name: 'Assignee' } },
          ...extraFields.map((name) => ({ $type: 'EnumProjectCustomField', field: { name }, bundle: { values: [] } })),
        ]);
      }
      if (req.method === 'GET' && path === '/api/issues') {
        const q = u.searchParams.get('query') ?? '';
        const top = Number(u.searchParams.get('$top') ?? 42);
        const found = [...issues.values()].filter((i) => matches(i, q)).sort((a, b) => b.updated - a.updated).slice(0, top);
        return send(200, found.map((i) => issueJson(i, u.searchParams.get('fields') ?? '')));
      }
      if (req.method === 'POST' && path === '/api/issues') {
        const body = json();
        if (body.project?.id !== PROJECT_ID) return fail(400, 'bad_request', 'Unknown project');
        if (typeof body.summary !== 'string' || body.summary === '') return fail(400, 'bad_request', 'Summary is required');
        const issue = putIssue({ summary: body.summary, description: body.description ?? '' });
        return send(200, issueJson(issue, u.searchParams.get('fields') ?? ''));
      }
      if (req.method === 'POST' && path === '/api/commands') {
        const body = json();
        const targets = (body.issues ?? []).map((i) => findIssue(i.idReadable ?? i.id));
        if (targets.length === 0 || targets.some((t) => !t)) return fail(400, 'bad_request', 'Unknown issue');
        for (const issue of targets) {
          const problem = applyCommand(String(body.query ?? ''), issue);
          if (problem) return fail(400, 'bad_request', problem);
          issue.updated = now();
        }
        commands.push({ query: body.query, issues: targets.map((t) => ({ idReadable: t.idReadable })) });
        save();
        return send(200, { $type: 'CommandList', query: body.query });
      }
      if ((m = path.match(/^\/api\/issues\/([^/]+)(\/.*)?$/))) {
        const issue = findIssue(decodeURIComponent(m[1]));
        if (!issue) return fail(404, 'Not Found', 'Entity with id not found');
        const sub = m[2] ?? '';
        const key = issue.idReadable;
        if (req.method === 'GET' && sub === '') return send(200, issueJson(issue, u.searchParams.get('fields') ?? ''));
        if (req.method === 'POST' && sub === '') {
          const body = json();
          if (typeof body.summary === 'string') issue.summary = body.summary;
          if (typeof body.description === 'string') issue.description = body.description;
          // Fields set as data (#187): a bundle value by name, a user by login.
          const sets = Array.isArray(body.customFields) ? body.customFields : [];
          const named = (f) => (Array.isArray(f.value) ? f.value[0] : f.value) ?? {};
          for (const f of sets) {
            if (typeof f.$type !== 'string' || !f.$type.endsWith('IssueCustomField')) return fail(400, 'bad_request', `No $type for ${f.name}`);
            if (f.name === 'State') {
              const value = named(f).name;
              if (!states.includes(value)) return fail(400, 'bad_request', `Unknown state ${value}`);
              const assigning = sets.some((x) => x.name === 'Assignee');
              if (requireAssignee.includes(value) && issue.assignee === null && !assigning) return fail(400, 'bad_request', `Assignee is required for ${value}`);
            } else if (f.name === 'Type' && !types.includes(named(f).name)) return fail(400, 'bad_request', `Unknown type ${named(f).name}`);
          }
          for (const f of sets) {
            const v = named(f);
            if (f.name === 'State') { issue.state = v.name; issue.resolved = resolvedStates.has(v.name) ? now() : null; }
            else if (f.name === 'Type') issue.type = v.name;
            else if (f.name === 'Assignee') issue.assignee = v.login ?? null;
            else issue.fields[f.name] = v.name;
          }
          if (sets.length > 0) fieldSets.push({ issue: issue.idReadable, fields: sets.map((f) => `${f.name}=${named(f).name ?? named(f).login}`) });
          issue.updated = now();
          save();
          return send(200, issueJson(issue, u.searchParams.get('fields') ?? ''));
        }
        if (req.method === 'GET' && sub === '/comments') {
          return send(200, (comments.get(key) ?? []).map((c) => ({ $type: 'IssueComment', id: c.id, text: c.text, author: { $type: 'User', login: c.author } })));
        }
        if (req.method === 'POST' && sub === '/comments') {
          const c = putComment(key, { text: String(json().text ?? ''), author: login });
          issue.updated = now();
          save();
          return send(200, { $type: 'IssueComment', id: c.id });
        }
        if (req.method === 'POST' && (m = sub.match(/^\/comments\/([^/]+)$/))) {
          const c = (comments.get(key) ?? []).find((x) => x.id === m[1]);
          if (!c) return fail(404, 'Not Found', 'Entity with id not found');
          if (c.author !== login) return fail(403, 'Forbidden', 'You cannot edit this comment');
          c.text = String(json().text ?? '');
          issue.updated = now();
          save();
          return send(200, { $type: 'IssueComment', id: c.id });
        }
        if (req.method === 'POST' && sub === '/attachments') {
          const names = [...raw.toString('latin1').matchAll(/filename="([^"]*)"/g)].map((x) => x[1]);
          const list = attachments.get(key) ?? [];
          for (const name of names) list.push({ name, size: raw.length });
          attachments.set(key, list);
          save();
          return send(200, names.map((name, i) => ({ $type: 'IssueAttachment', id: `8-${list.length - names.length + i + 1}`, name })));
        }
      }
      return fail(404, 'Not Found', `No route ${req.method} ${path}`);
    } catch (e) {
      return fail(500, 'server_error', String(e?.message ?? e));
    }
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    issues,
    comments,
    attachments,
    commands,
    fieldSets,
    calls,
    putIssue,
    putComment,
    setState,
    /**
     * The next request to `path` (only a `method` one, when named) waits `ms`
     * before it is read, so what it sees is the state after the wait.
     */
    delayNext(path, ms, method) { delays.set(method === undefined ? path : `${method} ${path}`, ms); },
    /** The next request to `path` answers 429 with `Retry-After: <seconds>` (Ruling 26). */
    rateLimitNext(path, seconds) { limits.set(path, seconds); },
    /**
     * YouTrack goes away: the port stops answering, and everything it holds
     * stays, so `restart()` brings back the same YouTrack on the same URL.
     */
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    restart() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ------------------------------------------------------------------ script mode
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
  };
  const stateDir = arg('state');
  if (!stateDir) {
    console.error('usage: node scratch/fake-youtrack.mjs --port 0 --state <dir> [--project ACME] [--token perm:test] [--login tandemise-bot]');
    process.exit(2);
  }
  mkdirSync(stateDir, { recursive: true });
  const fake = await startFakeYouTrack({
    port: Number(arg('port', '0')),
    stateDir,
    project: arg('project', 'ACME'),
    token: arg('token', 'perm:test'),
    login: arg('login', 'tandemise-bot'),
    // A comma-separated list (`--states 'Open,In Progress,Draft'`); the first is where a new issue starts.
    ...(arg('states') === undefined ? {} : { states: arg('states').split(',') }),
  });
  writeFileSync(join(stateDir, 'url'), fake.url);
  console.log(`fake YouTrack on ${fake.url} (state in ${stateDir})`);
  const stop = () => fake.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
