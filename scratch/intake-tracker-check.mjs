// Intake's primary trackers (spec 2026-10-30-intake-design.md §6): the
// `PrimaryTracker` port's pure helpers and its adapters, each driven against
// an in-process fake. Never a real tracker.
//
//   npm run build && node scratch/intake-tracker-check.mjs
//
// Sections grow with the plan's tasks. Task 4 pins the pure helpers and the
// YouTrack adapter against `scratch/fake-youtrack.mjs`. Task 5 adds the
// GitHub Issues adapter against `scratch/fake-gh.mjs` (first on PATH), the
// tracker resolver, and the daemon refusing a mapping the tracker lacks.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addComment, calls, commentsOf, installFakeGh, putLabels, readState, writeState } from './fake-gh.mjs';
import { startFakeYouTrack } from './fake-youtrack.mjs';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const finish = () => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
};

const D = await import('@tandemise/domain');
const I = await import('@tandemise/integrations-core');
const K = await import('@tandemise/kernel');

const STATES = ['Open', 'Submitted', 'In Progress', 'In Review', 'Fixed', 'Done', "Won't fix", 'Duplicate', 'Obsolete'];

// ------------------------------------------------------------------ pure
section('pure: refs, markers and the Sources section');
{
  check('trackerRef is <tracker>:<key>', D.trackerRef?.('youtrack', 'GAR-12') === 'youtrack:GAR-12' && D.trackerRef?.('github', 'acme/web#42') === 'github:acme/web#42');
  check('markerLine is an HTML comment', D.markerLine?.('tandemise:sources') === '<!-- tandemise:sources -->' && D.markerLine?.('tandemise:activity') === '<!-- tandemise:activity -->');
  const parsed = D.parseSourcesSection?.('x\n\n## Sources\n- Sentry · acme/web · https://s.test/1\n- Slack thread · https://slack.test/a');
  check('parseSourcesSection lists the URLs', eq(parsed, ['https://s.test/1', 'https://slack.test/a']), parsed);
  check('a description with no Sources section lists none', eq(D.parseSourcesSection?.('just text\n- https://x.test/1'), []));
  const section1 = D.sourcesSection?.(['Sentry · acme/web · 132 events, 41 users · https://s.test/1']);
  check('sourcesSection renders the heading and one line per source', section1 === '## Sources\n- Sentry · acme/web · 132 events, 41 users · https://s.test/1', section1);
  check('sourcesSection round-trips through parseSourcesSection', eq(D.parseSourcesSection?.(`D\n\n${section1}\n\nRecorded by Tandemise.`), ['https://s.test/1']));

  const one = D.sourcesCommentWith?.(null, { url: 'https://s.test/1', title: 'Sentry · acme/web', context: '132 events\nreported by @sam' });
  const two = D.sourcesCommentWith?.(one, { url: 'https://slack.test/a', title: 'Slack thread', context: '' });
  const again = D.sourcesCommentWith?.(two, { url: 'https://s.test/1', title: 'Sentry · acme/web', context: '1320 events' });
  check('the sources comment lists each URL once, in the order first seen', eq(D.parseSourcesSection?.(again), ['https://s.test/1', 'https://slack.test/a']), again);
  check('a repeated URL has its line replaced, not appended', typeof again === 'string' && again.includes('1320 events') && !again.includes('132 events\n') && again.split('https://s.test/1').length === 2, again);
  check('copied context is escaped: @mentions are broken', typeof one === 'string' && !one.includes('@sam') && one.includes('@​sam'), one);
  check('sourcesCommentBody renders entries as the Sources section', typeof D.sourcesCommentBody === 'function' && eq(D.parseSourcesSection?.(D.sourcesCommentBody([{ url: 'https://a.test/1', title: 'A', context: '' }])), ['https://a.test/1']));
}

section('pure: what Start refuses (#136)');
{
  const cfg = { buildTypes: ['Bug', 'Task'], repoTag: 'repo:web' };
  const refuse = (item, config = cfg) => D.startRefusal?.(item, config);
  check('a plain Task with no tags or subtasks may start', refuse({ type: 'Task' }) === null);
  check('a container: Has 4 subtasks. Start one of them.', refuse({ type: 'Task', subtasks: 4 }) === 'Has 4 subtasks. Start one of them.', refuse({ type: 'Task', subtasks: 4 }));
  check('one subtask is said in the singular', refuse({ type: 'Task', subtasks: 1 }) === 'Has 1 subtask. Start it instead.', refuse({ type: 'Task', subtasks: 1 }));
  check('no open subtasks is not a container', refuse({ type: 'Task', subtasks: 0 }) === null);
  check('a Spike: this project starts Bug and Task items.', refuse({ type: 'Spike' }) === 'Spike: this project starts Bug and Task items.', refuse({ type: 'Spike' }));
  check('three build types read as a list', refuse({ type: 'Epic' }, { buildTypes: ['Bug', 'Task', 'Story'] }) === 'Epic: this project starts Bug, Task and Story items.');
  check('types match without regard to case', refuse({ type: 'bug' }) === null);
  check('no buildTypes: every type is buildable', refuse({ type: 'Spike' }, {}) === null && refuse({ type: 'Spike' }, { buildTypes: [] }) === null);
  check('an item with no type is not refused for its type', refuse({}) === null);
  check('another repository: Belongs to another repository (repo:api).', refuse({ type: 'Bug', tags: ['urgent', 'repo:api'] }) === 'Belongs to another repository (repo:api).', refuse({ type: 'Bug', tags: ['repo:api'] }));
  check("an item carrying this project's tag may start, even with another", refuse({ type: 'Bug', tags: ['repo:api', 'Repo:Web'] }) === null);
  check('an item with no repository tag may start', refuse({ type: 'Bug', tags: ['urgent'] }) === null);
  check('no repoTag: another repository tag refuses nothing', refuse({ type: 'Bug', tags: ['repo:api'] }, {}) === null);
  check("another repository's Spike container is refused for the repository first",
    refuse({ type: 'Spike', subtasks: 2, tags: ['repo:api'] }) === 'Belongs to another repository (repo:api).');
}

// ------------------------------------------------------------------ youtrack
section('pure: the mission header for a tracker item (#105)');
{
  const G = await import('@tandemise/domain/tracker-goal');
  const goal = D.trackerGoal({
    label: 'GitHub', key: '#97', starterName: 'Demostenes Garcia', url: 'https://github.com/tandemise/tandemise/issues/97',
    title: 'docs: say how to add Claude Code',
    description: '## What happened\n\nQUICKSTART step 2 says Claude Code is **detected automatically**; it is not, you press `Discover runtimes`.\n\n## Done when\n\n- QUICKSTART step 2 says to press **Discover runtimes**\n- `npm run ci` passes.',
    sources: [],
  });
  const parts = G.parseTrackerGoal(goal);
  check('a tracker goal parses into its lead', parts?.label === 'GitHub' && parts.key === '#97' && parts.starter === 'Demostenes Garcia' && parts.url.endsWith('/issues/97'), parts);
  check('its summary is the first prose paragraph, Markdown out', parts?.summary === 'QUICKSTART step 2 says Claude Code is detected automatically; it is not, you press Discover runtimes.', parts?.summary);
  check('a hand-written goal is not a tracker goal', G.parseTrackerGoal('Make the onboarding faster') === null);
  const long = G.parseTrackerGoal(D.trackerGoal({ label: 'YouTrack', key: 'APP-1', starterName: 'Ana', url: 'https://x.youtrack.cloud/issue/APP-1', title: 't', description: `${'word '.repeat(80)}end.`, sources: [] }));
  check('a long summary is cut short', long !== null && long.summary.length <= G.GOAL_SUMMARY_CHARS + 1 && long.summary.endsWith('…'), long?.summary);
  check('inline Markdown reads as text', G.plainInline('Press **Discover runtimes** in `Settings`, see [docs](https://x)') === 'Press Discover runtimes in Settings, see docs');
}

section('youtrack: the adapter against the fake');
let Y;
try {
  Y = await import('@tandemise/integration-youtrack');
} catch (e) {
  check('@tandemise/integration-youtrack loads', false, String(e?.message ?? e));
  finish();
}
const fake = await startFakeYouTrack({ project: 'GAR', states: STATES, types: ['Bug', 'Task'], token: 'perm:test', login: 'tandemise-bot' });
try {
  const yt = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:test' });
  check('kind and capabilities', yt.kind === 'youtrack' && eq(yt.capabilities, { editComments: true, attachments: true, duplicateLinks: true }), yt.capabilities);

  const described = await yt.describe();
  check('describe() returns the nine states and the types', eq(described.states, STATES) && eq(described.types, ['Bug', 'Task']), described);
  check('describe() lists every field name', ['State', 'Type', 'Assignee'].every((f) => described.fields.includes(f)), described.fields);

  const mapping = (states, onComplete = 'in_review') => ({
    kind: 'youtrack', url: fake.url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete,
    states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'], ...states },
  });
  const bad = D.stateMappingProblem(mapping({ in_progress: 'In Review!' }), described);
  check("a mapping naming a missing state: YouTrack has no state 'In Review!' in GAR. Its states are: …",
    bad === "YouTrack has no state 'In Review!' in GAR. Its states are: Open, Submitted, In Progress, In Review, Fixed, Done, Won't fix, Duplicate, Obsolete.", bad);
  const noReview = mapping({});
  const { in_review: _dropped, ...withoutReview } = noReview.states;
  const missing = D.stateMappingProblem({ ...noReview, states: withoutReview }, described);
  check('in_review absent with onComplete in_review: Without an in-review state, a finished mission can only mark the task done.',
    missing === 'Without an in-review state, a finished mission can only mark the task done.', missing);
  check('in_review absent with onComplete done is fine', D.stateMappingProblem({ ...noReview, states: withoutReview, onComplete: 'done' }, described) === null);
  check('a valid mapping has no problem', D.stateMappingProblem(mapping({}), described) === null);

  const created = await yt.create({ title: 'T', description: 'D\n\n## Sources\n- Sentry · acme/web · https://s.test/1', type: 'Bug' });
  check("create() returns key 'GAR-1' and ref youtrack:GAR-1", created.key === 'GAR-1' && created.ref === 'youtrack:GAR-1' && created.title === 'T', created);
  check('create() reads the item back: type Bug, state Open, a url on the tracker', created.type === 'Bug' && created.state === 'Open' && created.url === `${fake.url}/issue/GAR-1`, created);
  check('the fake recorded one command, Type Bug', eq(fake.commands.map((c) => c.query), ['Type Bug']) && fake.commands[0].issues[0].idReadable === 'GAR-1', fake.commands);
  check('every request carried the token and asked for JSON', fake.calls.length > 0 && fake.calls.every((c) => c.authorization === 'Bearer perm:test' && c.accept === 'application/json'));

  const found = await yt.search({ url: 'https://s.test/1', limit: 5 });
  check('search({ url }) finds GAR-1', eq(found.map((i) => i.key), ['GAR-1']), found.map((i) => i.key));
  const searchCall = fake.calls.findLast((c) => c.path === '/api/issues' && c.method === 'GET');
  check('search({ url }) is a quoted query scoped to the project', searchCall?.query.get('query') === 'project: GAR "https://s.test/1"' && searchCall?.query.get('$top') === '5', searchCall?.query.get('query'));
  check('search({ url }) of an unknown URL finds nothing', (await yt.search({ url: 'https://s.test/2', limit: 5 })).length === 0);

  const second = await yt.create({ title: "TypeError: cannot read 'id' of undefined", description: 'x', fields: { Subsystem: 'Web' } });
  check('fields are set by one command', fake.commands.at(-1)?.query === 'Subsystem Web', fake.commands.at(-1));
  await yt.search({ text: "TypeError: cannot read 'id' of undefined in checkout", unresolvedOnly: true, limit: 20 });
  const textCall = fake.calls.findLast((c) => c.path === '/api/issues' && c.method === 'GET');
  check('search({ text }) asks for the unresolved items with the title words', textCall?.query.get('query') === 'project: GAR #Unresolved typeerror read id undefined checkout' && textCall?.query.get('$top') === '20', textCall?.query.get('query'));
  const byText = await yt.search({ text: "TypeError: cannot read 'id' of undefined", unresolvedOnly: true, limit: 20 });
  check('search({ text }) finds the item whose title has those words', eq(byText.map((i) => i.key), [second.key]), byText.map((i) => i.key));
  const longTitle = 'one two three four five six seven eight nine ten';
  await yt.search({ text: longTitle, limit: 20 });
  check('search({ text }) sends at most 8 words, and no #Unresolved unless asked',
    fake.calls.findLast((c) => c.path === '/api/issues' && c.method === 'GET')?.query.get('query') === 'project: GAR one two three four five six seven eight');

  const ref = created.ref;
  const c1 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v1' });
  const c2 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v2' });
  const onGar1 = fake.comments.get('GAR-1') ?? [];
  check('comment() twice leaves exactly one comment on GAR-1', onGar1.length === 1, onGar1);
  check('its text starts with the marker and ends with v2', onGar1[0]?.text.startsWith('<!-- tandemise:activity -->') && onGar1[0]?.text.endsWith('v2'), onGar1[0]?.text);
  check('the second call edited the first comment', c1.commentId === c2.commentId && c1.commentId === onGar1[0]?.id, { c1, c2 });
  const c3 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v3', knownId: c1.commentId });
  check('a known id is edited in place', c3.commentId === c1.commentId && (fake.comments.get('GAR-1') ?? []).length === 1 && fake.comments.get('GAR-1')[0].text.endsWith('v3'));
  const c4 = await yt.comment(ref, { marker: 'tandemise:activity', body: 'v4', knownId: '999-999' });
  check('a known id that is gone falls back to the comment found by marker', c4.commentId === c1.commentId && fake.comments.get('GAR-1')[0].text.endsWith('v4'), c4);

  fake.putComment(second.key, { author: 'someone-else', text: '<!-- tandemise:activity -->\n\nI copied the marker.' });
  const c5 = await yt.comment(second.ref, { marker: 'tandemise:activity', body: 'ours' });
  const onSecond = fake.comments.get(second.key) ?? [];
  check("another user's comment with the marker is not adopted: a new comment is posted",
    onSecond.length === 2 && onSecond[0].text.endsWith('I copied the marker.') && onSecond[1].id === c5.commentId && onSecond[1].author === 'tandemise-bot', onSecond);

  await yt.link(ref, { url: 'https://slack.test/a', title: 'Slack thread', context: 'Ana: checkout is broken' });
  await yt.link(ref, { url: 'https://slack.test/a', title: 'Slack thread', context: 'Ana: checkout is broken again' });
  const sourcesComments = (fake.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:sources -->'));
  check('link() twice with the same URL keeps one sources comment', sourcesComments.length === 1, fake.comments.get('GAR-1'));
  check('…with one line for that URL, carrying the latest context', sourcesComments[0]?.text.split('https://slack.test/a').length === 2 && sourcesComments[0]?.text.includes('broken again'), sourcesComments[0]?.text);
  await yt.link(ref, { url: 'https://s.test/9', title: 'Sentry · acme/web', context: '' });
  const afterThird = (fake.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:sources -->'));
  check('a new URL is added to the same comment', afterThird.length === 1 && eq(D.parseSourcesSection(afterThird[0].text), ['https://slack.test/a', 'https://s.test/9']), afterThird[0]?.text);
  check('search({ url }) finds an item by a URL in its sources comment', eq((await yt.search({ url: 'https://slack.test/a', limit: 5 })).map((i) => i.key), ['GAR-1']));

  await yt.transition(ref, 'In Progress');
  check('transition() sends the command State {In Progress} (a value with a space is braced)', fake.commands.at(-1)?.query === 'State {In Progress}' && fake.commands.at(-1)?.issues[0].idReadable === 'GAR-1', fake.commands.at(-1));
  const got = await yt.get(ref);
  check("get() then shows state 'In Progress'", got.state === 'In Progress' && got.key === 'GAR-1', got);

  await yt.markDuplicate(second.ref, ref);
  check('markDuplicate(GAR-2, GAR-1) sends the command duplicates GAR-1 to GAR-2', fake.commands.at(-1)?.query === 'duplicates GAR-1' && fake.commands.at(-1)?.issues[0].idReadable === 'GAR-2', fake.commands.at(-1));
  // Ruling 26: a repeated merge. YouTrack's links are a set, so the same command again changes nothing and comments nothing.
  const gar2Comments = (fake.comments.get('GAR-2') ?? []).length;
  await yt.markDuplicate(second.ref, ref);
  check('markDuplicate again: still one duplicates link on GAR-2, and no comment',
    fake.issues.get('GAR-2')?.links.filter((l) => l.type === 'duplicates').length === 1 && (fake.comments.get('GAR-2') ?? []).length === gar2Comments,
    { links: fake.issues.get('GAR-2')?.links, comments: (fake.comments.get('GAR-2') ?? []).length });
  await yt.assign(ref, 'ana');
  check('assign() sends the command Assignee <login>', fake.commands.at(-1)?.query === 'Assignee ana' && (await yt.get(ref)).assignee === 'ana');
  check('viewer() is the signed-in login', (await yt.viewer()) === 'tandemise-bot');

  // GAR-2 is a duplicate now, so resolved; GAR-1 is fixed by a person; GAR-3 is new.
  fake.setState('GAR-1', 'Fixed');
  fake.putIssue({ summary: 'Fresh' });
  const board = await yt.board({ query: 'project: GAR #Unresolved', limit: 50 });
  check('board() runs the given query: resolved items are not on it', eq(board.map((i) => i.key), ['GAR-3']), board.map((i) => i.key));
  const all = await yt.board({ query: 'project: GAR', limit: 50 });
  check('board() maps every item', eq(all.map((i) => i.key).sort(), ['GAR-1', 'GAR-2', 'GAR-3']) && all.every((i) => i.ref.startsWith('youtrack:') && typeof i.updatedAt === 'string' && typeof i.createdAt === 'string'));
  const since = await yt.board({ query: 'project: GAR', updatedSince: all.find((i) => i.key === 'GAR-3').updatedAt, limit: 50 });
  check('board({ updatedSince }) keeps only the items updated since', eq(since.map((i) => i.key), ['GAR-3']), since.map((i) => i.key));
  check('refFromUrl() knows its own items and nothing else',
    yt.refFromUrl(`${fake.url}/issue/GAR-12/checkout-breaks`) === 'youtrack:GAR-12' && yt.refFromUrl(`${fake.url}/issue/OTHER-1`) === null && yt.refFromUrl('https://s.test/1') === null);

  const notThere = await refusal(() => yt.get(D.trackerRef('youtrack', 'GAR-404')));
  check('get() of a missing item is NOT_FOUND', notThere?.code === 'NOT_FOUND', notThere?.message);

  const wrong = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:wrong' });
  const refused = await refusal(() => wrong.search({ url: 'https://s.test/1', limit: 5 }));
  check("a wrong token: INTEGRATION_FAILED, YouTrack refused the token. Make a new permanent token and save it in the project's tracker settings.",
    refused?.code === 'INTEGRATION_FAILED' && refused?.message === "YouTrack refused the token. Make a new permanent token and save it in the project's tracker settings.", { code: refused?.code, message: refused?.message });

  const braced = await yt.create({ title: 'Braced values', description: 'x', fields: { Subsystem: 'Web App', Priority: 'Major' } });
  check('a multi-word field value is braced, a single word is not: Subsystem {Web App} Priority Major',
    fake.commands.at(-1)?.query === 'Subsystem {Web App} Priority Major' && fake.issues.get(braced.key)?.fields?.Subsystem === 'Web App', fake.commands.at(-1));
  const unbraced = await refusal(() => fetch(`${fake.url}/api/commands`, {
    method: 'POST', headers: { authorization: 'Bearer perm:test', accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'State In Progress', issues: [{ idReadable: braced.key }] }),
  }).then((r) => { if (!r.ok) throw new Error(String(r.status)); }));
  check('the fake, like YouTrack, refuses an unbraced multi-word value', unbraced !== null && fake.issues.get(braced.key)?.state === 'Open', unbraced?.message);
  const withFile = await yt.create({ title: 'With a file', description: 'x', attachments: [{ name: 'trace.txt', mediaType: 'text/plain', content: new TextEncoder().encode('stack') }] });
  check('an attachment with content is uploaded to the item', eq((fake.attachments.get(withFile.key) ?? []).map((a) => a.name), ['trace.txt']), fake.attachments.get(withFile.key));

  // #136: tags and open subtasks, as the board and a fresh read report them.
  const parent = fake.putIssue({ summary: 'Container of work', state: 'Open', type: 'Task', tags: ['repo:web'] });
  fake.putIssue({ summary: 'First part', state: 'Open', type: 'Task', parent: parent.idReadable });
  fake.putIssue({ summary: 'Second part', state: 'Open', type: 'Task', parent: parent.idReadable });
  fake.putIssue({ summary: 'Third part, done', state: 'Done', type: 'Task', parent: parent.idReadable });
  const spike = fake.putIssue({ summary: 'Research the cache', state: 'Open', type: 'Spike', tags: ['repo:api', 'research'] });
  const read = await yt.get(D.trackerRef('youtrack', parent.idReadable));
  check('get() counts the open subtasks: 2 of 3', read.subtasks === 2, read);
  check('get() reports the tags', eq(read.tags, ['repo:web']), read.tags);
  check('every issue read asks for the tags and the subtasks', fake.calls.findLast((c) => c.path.startsWith('/api/issues/'))?.query.get('fields')?.includes('tags(name)')
    && fake.calls.findLast((c) => c.path.startsWith('/api/issues/'))?.query.get('fields')?.includes('subtasks(issues(idReadable,resolved))'));
  const onBoard = await yt.board({ query: 'project: GAR #Unresolved', limit: 50 });
  const boardSpike = onBoard.find((i) => i.key === spike.idReadable);
  const plain = onBoard.find((i) => i.title === 'First part');
  check('board() reports the type, tags and subtasks too', boardSpike?.type === 'Spike' && eq(boardSpike?.tags, ['repo:api', 'research']) && boardSpike?.subtasks === 0
    && onBoard.find((i) => i.key === parent.idReadable)?.subtasks === 2, boardSpike);
  check('an item with neither has no tags and no open subtasks', plain !== undefined && eq(plain.tags, []) && plain.subtasks === 0, plain);

  // The composition seam: the module contributes a factory for `kind: youtrack`.
  check('integrations-core exports PRIMARY_TRACKER_FACTORIES', I.PRIMARY_TRACKER_FACTORIES !== undefined && K.isMultiToken(I.PRIMARY_TRACKER_FACTORIES));
  const container = K.compose(new K.Container(), Y.youtrackIntegrationModule);
  const factories = container.resolveAll(I.PRIMARY_TRACKER_FACTORIES);
  const factory = factories.find((f) => f.kind === 'youtrack');
  check('the youtrack module contributes a youtrack factory', factory !== undefined, factories.map((f) => f.kind));
  const built = factory?.create(mapping({}), 'perm:test');
  check('the factory builds a working tracker from the config and the credential', built !== undefined && (await built.viewer()) === 'tandemise-bot');
  const noToken = await refusal(() => factory.create(mapping({}), undefined));
  check('the factory refuses without a credential', noToken?.code === 'PRECONDITION_FAILED', noToken?.message);

  // Ruling 26: a 429 with Retry-After makes this tracker wait, refusing in plain words rather than asking again.
  let ytNow = Date.parse('2026-10-30T12:00:00Z');
  const paced = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:test', now: () => ytNow });
  fake.rateLimitNext('/api/issues', 30);
  const slowed = await refusal(() => paced.search({ text: 'Fresh', limit: 5 }));
  check('YouTrack answers 429 with Retry-After: 30 → a retryable INTEGRATION_FAILED: YouTrack asked Tandemise to slow down; it waits 30 s before asking again.',
    slowed?.code === 'INTEGRATION_FAILED' && slowed?.retryable === true && slowed?.message === 'YouTrack asked Tandemise to slow down; it waits 30 s before asking again.', { code: slowed?.code, retryable: slowed?.retryable, message: slowed?.message });
  const askedBefore = fake.calls.length;
  ytNow += 10_000;
  const held = await refusal(() => paced.get(ref));
  check('…10 s later the next call is refused without asking YouTrack: it waits 20 s',
    held?.code === 'INTEGRATION_FAILED' && held?.retryable === true && held?.message === 'YouTrack asked Tandemise to slow down; it waits 20 s before asking again.' && fake.calls.length === askedBefore,
    { message: held?.message, asked: fake.calls.length - askedBefore });
  ytNow += 21_000;
  const resumed = await refusal(() => paced.search({ text: 'Fresh', limit: 5 }));
  check('…and once the wait is over it asks again', resumed === null && fake.calls.length === askedBefore + 1, { error: resumed?.message, asked: fake.calls.length - askedBefore });

  fake.delayNext('/api/users/me', 300);
  const slow = new Y.YouTrackTracker({ url: fake.url, project: 'GAR', token: 'perm:test', timeoutMs: 50 });
  const timedOut = await refusal(() => slow.viewer());
  check('a request past its timeout fails as INTEGRATION_FAILED, retryable', timedOut?.code === 'INTEGRATION_FAILED' && timedOut?.retryable === true, { code: timedOut?.code, message: timedOut?.message });
} catch (e) {
  check('the youtrack section ran', false, String(e?.stack ?? e));
} finally {
  await fake.close();
}

// ------------------------------------------------------------------ github
section('github: GhPrimaryTracker against the fake gh');
const G = await import('@tandemise/integration-github');
const app = await import('@tandemise/application');
const ghRoot = mkdtempSync(join(tmpdir(), 'tdi-trk-'));
const GH = join(ghRoot, 'gh');
const ghBin = installFakeGh(GH);
// A real process runner with the fake gh first on PATH, as in p14-issues-check.
const exec = {
  run: (req) => new Promise((resolve) => {
    execFile(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, ...(req.env ?? {}) }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout, stderr, timedOut: false, durationMs: 0, command: [req.command, ...(req.args ?? [])].join(' ') });
    });
  }),
};
const GH_STATES = { ready: ['open'], in_progress: 'status: in progress', in_review: 'status: in review', done: ['closed'], wont_do: ['closed'] };
const ghConfig = (states = GH_STATES) => ({ kind: 'github-issues', repo: 'acme/web', board: 'is:open', states, onComplete: 'in_review' });
try {
  putLabels(GH, 'acme/web', ['bug', 'status: in progress', 'status: in review']);
  check('the module contributes a github-issues factory', K.compose(new K.Container(), G.githubIntegrationModule).resolveAll(I.PRIMARY_TRACKER_FACTORIES).some((f) => f.kind === 'github-issues'));
  check('the state labels are the mapped states but open and closed', eq(G.githubStateLabels(GH_STATES), ['status: in progress', 'status: in review']));
  const gt = G.githubTrackerFactory(() => exec).create(ghConfig(), undefined);
  check('kind and capabilities', gt.kind === 'github-issues' && eq(gt.capabilities, { editComments: true, attachments: false, duplicateLinks: false }), gt.capabilities);

  const described = await gt.describe();
  check("describe(): states are open, closed and the repo's labels; no types or fields", eq(described, { states: ['open', 'closed', 'bug', 'status: in progress', 'status: in review'], types: [], fields: [] }), described);
  check('a mapping of existing labels has no problem', D.stateMappingProblem(ghConfig(), described) === null);
  const ghBad = D.stateMappingProblem(ghConfig({ ...GH_STATES, in_progress: 'status: doing' }), described);
  check("a label the repo lacks: GitHub has no state 'status: doing' in acme/web. Its states are: …",
    ghBad === "GitHub has no state 'status: doing' in acme/web. Its states are: open, closed, bug, status: in progress, status: in review.", ghBad);

  const made = await gt.create({ title: 'Checkout breaks', description: 'D\n\n## Sources\n- Sentry · acme/web · https://s.test/gh1', type: 'Bug' });
  check("create() on acme/web returns #1, ref github:acme/web#1", made.key === '#1' && made.ref === 'github:acme/web#1' && made.url === 'https://github.com/acme/web/issues/1' && made.state === 'open' && made.title === 'Checkout breaks', made);
  const createCall = calls(GH).find((c) => c.args[0] === 'issue' && c.args[1] === 'create');
  check('create() names the repo explicitly', createCall?.args.includes('--repo') && createCall.args[createCall.args.indexOf('--repo') + 1] === 'acme/web', createCall?.args);
  const byUrl = await gt.search({ url: 'https://s.test/gh1', limit: 5 });
  check('search({ url }) finds #1 through gh search issues', eq(byUrl.map((i) => i.key), ['#1']) && byUrl[0].state === 'open', byUrl);
  check('search({ url }) is gh search issues "<url>" --repo', calls(GH).some((c) => c.args[0] === 'search' && c.args[1] === 'issues' && c.args[2] === '"https://s.test/gh1"' && c.args.includes('--repo')));
  check('search({ url }) of an unknown URL finds nothing', (await gt.search({ url: 'https://s.test/nope', limit: 5 })).length === 0);
  const byText = await gt.search({ text: 'Checkout breaks on Safari', unresolvedOnly: true, limit: 10 });
  const textCall = calls(GH).findLast((c) => c.args[0] === 'issue' && c.args[1] === 'list');
  check('search({ text }) is gh issue list --search "<words> in:title" --state open', textCall?.args[textCall.args.indexOf('--search') + 1] === 'checkout breaks safari in:title' && textCall.args[textCall.args.indexOf('--state') + 1] === 'open', textCall?.args);
  check('…and finds nothing when a word is missing from the title', byText.length === 0, byText);
  check('search({ text }) finds the item whose title has the words', eq((await gt.search({ text: 'checkout breaks', unresolvedOnly: true, limit: 10 })).map((i) => i.key), ['#1']));

  await gt.transition(made.ref, 'status: in progress');
  const inProgress = await gt.get(made.ref);
  check('the state label is not among the tags (#136)', Array.isArray(inProgress.tags) && !inProgress.tags.includes('status: in progress'), inProgress.tags);
  check("transition(#1, 'status: in progress'): the labels have it and state reads it",
    readState(GH).repos['acme/web'].issues[0].labels.some((l) => l.name === 'status: in progress') && inProgress.state === 'status: in progress', inProgress);
  await gt.transition(made.ref, 'status: in review');
  const labels1 = readState(GH).repos['acme/web'].issues[0].labels.map((l) => l.name);
  check('moving to another state label drops the first: one state label at a time', labels1.includes('status: in review') && !labels1.includes('status: in progress') && (await gt.get(made.ref)).state === 'status: in review', labels1);
  await gt.transition(made.ref, 'closed');
  check("transition(#1, 'closed') -> state 'closed'", (await gt.get(made.ref)).state === 'closed');
  await gt.transition(made.ref, 'open');
  const reopened = await gt.get(made.ref);
  const labels2 = readState(GH).repos['acme/web'].issues[0].labels.map((l) => l.name);
  check("transition(#1, 'open') reopens it with no state labels", reopened.state === 'open' && !labels2.some((l) => l.startsWith('status:')), { state: reopened.state, labels2 });
  check('the reopen went through gh issue reopen', calls(GH).some((c) => c.args[0] === 'issue' && c.args[1] === 'reopen'));
  await gt.transition(made.ref, 'closed');
  await gt.transition(made.ref, 'status: in progress');
  check('a state label on a closed issue reopens it first', (await gt.get(made.ref)).state === 'status: in progress');
  // Ruling 16: a repository that has never had the state labels (P14 adopted as the board).
  putLabels(GH, 'acme/web', ['bug']);
  const fresh = G.githubTrackerFactory(() => exec).create(ghConfig(), undefined);
  await fresh.transition(made.ref, 'open');
  await fresh.transition(made.ref, 'status: in review');
  check('moving to a state label the repository lacks creates the label first', (await fresh.get(made.ref)).state === 'status: in review'
    && calls(GH).some((c) => c.args[0] === 'label' && c.args[1] === 'create' && c.args[2] === 'status: in review'));
  putLabels(GH, 'acme/web', ['bug', 'status: in progress', 'status: in review']);
  const unmapped = await refusal(() => gt.transition(made.ref, 'wontfix'));
  check('a state that is not mapped is refused', unmapped?.code === 'VALIDATION', unmapped?.code);

  const k1 = await gt.comment(made.ref, { marker: 'tandemise:activity', body: 'v1' });
  const k2 = await gt.comment(made.ref, { marker: 'tandemise:activity', body: 'v2' });
  const onOne = commentsOf(GH, 'acme/web', 1);
  check('comment() with a marker twice edits one comment', onOne.length === 1 && k1.commentId === k2.commentId && onOne[0].body.startsWith('<!-- tandemise:activity -->') && onOne[0].body.endsWith('v2'), onOne);
  const k3 = await gt.comment(made.ref, { marker: 'tandemise:activity', body: 'v3', knownId: '424242' });
  check('a known id that is gone falls back to the comment found by marker', k3.commentId === k1.commentId && commentsOf(GH, 'acme/web', 1).length === 1 && commentsOf(GH, 'acme/web', 1)[0].body.endsWith('v3'), k3);
  const other = await gt.create({ title: 'Second', description: 'x' });
  addComment(GH, 'acme/web', 2, '<!-- tandemise:activity -->\n\nI copied the marker.', 'someone-else');
  await gt.comment(other.ref, { marker: 'tandemise:activity', body: 'ours' });
  check("another user's comment with the marker is not adopted", commentsOf(GH, 'acme/web', 2).length === 2 && commentsOf(GH, 'acme/web', 2)[0].body.endsWith('I copied the marker.'));

  // Ruling 26: the marker comment is looked for on every page of the issue's comments, not the first only.
  const paged = await gt.create({ title: 'Many comments', description: 'x' });
  const pagedNumber = Number(paged.key.slice(1));
  for (let i = 0; i < 3; i++) addComment(GH, 'acme/web', pagedNumber, `chatter ${i}`, 'someone-else');
  await gt.comment(paged.ref, { marker: 'tandemise:activity', body: 'first' });
  writeState(GH, { ...readState(GH), pageSize: 2 });
  const pagesBefore = calls(GH).length;
  await gt.comment(paged.ref, { marker: 'tandemise:activity', body: 'second' });
  const pagedComments = commentsOf(GH, 'acme/web', pagedNumber);
  check('a marker comment on the second page (GitHub pages comments) is found and edited, not posted again',
    pagedComments.length === 4 && pagedComments.filter((c) => c.body.startsWith('<!-- tandemise:activity -->')).length === 1 && pagedComments[3].body.endsWith('second'),
    pagedComments.map((c) => c.body));
  check('…read with gh api --paginate', calls(GH).slice(pagesBefore).some((c) => c.args[0] === 'api' && c.args.includes('--paginate') && c.args.some((a) => a.includes(`/issues/${pagedNumber}/comments`))),
    calls(GH).slice(pagesBefore).map((c) => c.args.join(' ')));
  const { pageSize: _pageSize, ...unpaged } = readState(GH);
  writeState(GH, unpaged);
  await gt.transition(paged.ref, 'closed');

  await gt.link(made.ref, { url: 'https://slack.test/g', title: 'Slack thread', context: 'Ana: broken' });
  await gt.link(made.ref, { url: 'https://slack.test/g', title: 'Slack thread', context: 'Ana: broken again' });
  const ghSources = commentsOf(GH, 'acme/web', 1).filter((c) => c.body.startsWith('<!-- tandemise:sources -->'));
  check('link() twice with the same URL keeps one sources comment with one line', ghSources.length === 1 && ghSources[0].body.split('https://slack.test/g').length === 2 && ghSources[0].body.includes('broken again'), ghSources);
  check('search({ url }) finds an item by a URL in its sources comment', eq((await gt.search({ url: 'https://slack.test/g', limit: 5 })).map((i) => i.key), ['#1']));

  await gt.markDuplicate(other.ref, made.ref);
  const dupComments = commentsOf(GH, 'acme/web', 2);
  check('markDuplicate(#2, #1) comments "Duplicate of #1." under its marker and closes #2',
    dupComments.at(-1)?.body === '<!-- tandemise:duplicate -->\n\nDuplicate of #1.' && (await gt.get(other.ref)).state === 'closed', dupComments.at(-1));
  // Ruling 26: a repeated merge edits that comment rather than adding one.
  await gt.markDuplicate(other.ref, made.ref);
  const dupAgain = commentsOf(GH, 'acme/web', 2);
  check('markDuplicate again adds no comment', dupAgain.length === dupComments.length && dupAgain.filter((c) => c.body.includes('Duplicate of #1.')).length === 1, dupAgain.map((c) => c.body));

  const board = await gt.board({ query: 'is:open', limit: 50 });
  check("board() runs the team's query: the closed duplicate is not on it", eq(board.map((i) => i.key), ['#1']), board.map((i) => i.key));
  check('viewer() is the signed-in login', (await gt.viewer()) === 'tandemise-owner');
  check('refFromUrl() knows the issues of its repo and nothing else',
    gt.refFromUrl('https://github.com/acme/web/issues/12') === 'github:acme/web#12'
    && gt.refFromUrl('https://github.com/Acme/Web/issues/12#issuecomment-1') === 'github:acme/web#12'
    && gt.refFromUrl('https://github.com/acme/other/issues/12') === null
    && gt.refFromUrl('https://github.com/acme/web/pull/12') === null
    && gt.refFromUrl('https://s.test/1') === null);
  // Ruling 26: GitHub's rate limits (gh reports them on stderr) make this tracker wait, not ask again.
  let ghNow = Date.parse('2026-10-30T12:00:00Z');
  const ghPaced = new G.GhPrimaryTracker(exec, { repo: 'acme/web', stateLabels: G.githubStateLabels(GH_STATES), now: () => ghNow });
  writeState(GH, { ...readState(GH), failNext: 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)' });
  const ghSlowed = await refusal(() => ghPaced.search({ text: 'checkout breaks', limit: 5 }));
  check('gh reports a secondary rate limit → a retryable INTEGRATION_FAILED: GitHub asked Tandemise to slow down; it waits 60 s before asking again.',
    ghSlowed?.code === 'INTEGRATION_FAILED' && ghSlowed?.retryable === true && ghSlowed?.message === 'GitHub asked Tandemise to slow down; it waits 60 s before asking again.', { code: ghSlowed?.code, retryable: ghSlowed?.retryable, message: ghSlowed?.message });
  const ghAsked = calls(GH).length;
  ghNow += 15_000;
  const ghHeld = await refusal(() => ghPaced.search({ url: 'https://s.test/gh1', limit: 5 }));
  check('…15 s later the next search is refused without running gh: it waits 45 s',
    ghHeld?.retryable === true && ghHeld?.message === 'GitHub asked Tandemise to slow down; it waits 45 s before asking again.' && calls(GH).length === ghAsked, { message: ghHeld?.message, ran: calls(GH).length - ghAsked });
  ghNow += 46_000;
  check('…and once the wait is over gh runs again', eq((await ghPaced.search({ text: 'checkout breaks', limit: 5 })).map((i) => i.key), ['#1']) && calls(GH).length === ghAsked + 1);
  writeState(GH, { ...readState(GH), failNext: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' });
  const ghPrimary = await refusal(() => ghPaced.search({ text: 'checkout breaks', limit: 5 }));
  check('"API rate limit exceeded" waits too', ghPrimary?.retryable === true && ghPrimary?.message === 'GitHub asked Tandemise to slow down; it waits 60 s before asking again.', ghPrimary?.message);

  const gone = await refusal(() => gt.get(D.trackerRef('github', 'acme/web#404')));
  check('get() of a missing issue is NOT_FOUND', gone?.code === 'NOT_FOUND', { code: gone?.code, message: gone?.message });
  const noRepo = await refusal(() => G.githubTrackerFactory(() => exec).create({ ...ghConfig(), repo: undefined }, undefined));
  check('the factory refuses without a repo', noRepo?.code === 'PRECONDITION_FAILED', noRepo?.message);
} catch (e) {
  check('the github section ran', false, String(e?.stack ?? e));
}

// ------------------------------------------------------------------ resolver
section('resolver: a project\'s tracker from its config and the secret store');
const fake2 = await startFakeYouTrack({ project: 'GAR', states: STATES, types: ['Bug', 'Task'], token: 'perm:test', login: 'tandemise-bot' });
try {
  const memorySecrets = () => {
    const values = new Map();
    let n = 0;
    return {
      backend: 'memory',
      store: async (name, value) => { const ref = `memory:${name}:${++n}`; values.set(ref, value); return ref; },
      resolve: async (ref) => values.get(ref),
      remove: async (ref) => { values.delete(ref); },
      list: async () => [...values.keys()],
    };
  };
  const ytConfig = (states = {}) => ({
    kind: 'youtrack', url: fake2.url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete: 'in_review',
    states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix"], ...states },
  });
  const configs = new Map();
  const source = { origin: 'local', read: (ws) => ({ tracker: configs.get(ws) ?? null, sources: [], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } }) };
  const secrets = memorySecrets();
  const factories = K.compose(new K.Container(), Y.youtrackIntegrationModule, G.githubIntegrationModule);
  factories.bind(I.COMMAND_EXECUTOR, () => exec, { source: 'check' });
  const origins = new Map();
  const originStore = { get: (ws, c) => origins.get(`${ws}|${c}`), set: (ws, c, o) => { if (o === null) origins.delete(`${ws}|${c}`); else origins.set(`${ws}|${c}`, o); } };
  const resolver = new app.TrackerResolver({ config: source, secrets, origins: originStore, factories: () => factories.resolveAll(I.PRIMARY_TRACKER_FACTORIES), log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } });

  const none = await refusal(() => resolver.for('ws_none'));
  check("no tracker: Set this project's tracker first.", none?.message === "Set this project's tracker first.", none?.message);
  configs.set('ws_yt', ytConfig());
  check('the secret name is intake:<ws>:tracker', app.trackerSecretName('ws_yt') === 'intake:ws_yt:tracker');
  await resolver.saveCredential('ws_yt', 'perm:test');
  const { tracker, config } = await resolver.for('ws_yt');
  check('a youtrack config with its token stored resolves to a YouTrackTracker', tracker instanceof Y.YouTrackTracker && config.project === 'GAR' && (await tracker.viewer()) === 'tandemise-bot');
  check('the same config resolves to the same tracker (cached)', (await resolver.for('ws_yt')).tracker === tracker);
  check('validate() of a valid mapping is null', (await resolver.validate('ws_yt')) === null);
  configs.set('ws_yt', ytConfig({ in_progress: 'In Review!' }));
  const v = await resolver.validate('ws_yt');
  check('validate() with the bad mapping returns the Task 4 sentence', v === "YouTrack has no state 'In Review!' in GAR. Its states are: Open, Submitted, In Progress, In Review, Fixed, Done, Won't fix, Duplicate, Obsolete.", v);
  check('a changed config builds a new tracker', (await resolver.for('ws_yt')).tracker !== tracker);
  await resolver.saveCredential('ws_yt', 'perm:wrong');
  check('a new credential replaces the old one in the store', (await secrets.list()).filter((r) => r.includes(':intake:ws_yt:tracker:')).length === 1);
  const wrongToken = await refusal(() => resolver.validate('ws_yt'));
  check('…and the tracker is rebuilt with it', wrongToken?.code === 'INTEGRATION_FAILED', wrongToken?.message);
  configs.set('ws_x', { ...ytConfig(), kind: 'jira' });
  const unknown = await refusal(() => resolver.for('ws_x'));
  check("an unknown kind: Tandemise can't use 'jira' as a tracker yet.", unknown?.message === "Tandemise can't use 'jira' as a tracker yet.", unknown?.message);
  configs.set('ws_gh', ghConfig());
  check('a github-issues config resolves to a GhPrimaryTracker with no credential', (await resolver.for('ws_gh')).tracker instanceof G.GhPrimaryTracker);
  check('problemWith() refuses a mapping the tracker lacks before it is saved', (await resolver.problemWith('ws_gh', ghConfig({ ...GH_STATES, in_progress: 'status: doing' })))?.startsWith("GitHub has no state 'status: doing' in acme/web."));
  check('problemWith() is null when the tracker cannot be asked yet (no token saved)', (await resolver.problemWith('ws_new', ytConfig({ in_progress: 'In Review!' }))) === null);
} catch (e) {
  check('the resolver section ran', false, String(e?.stack ?? e));
} finally {
  await fake2.close();
}

// ------------------------------------------------------------------ origin
// Ruling 23: a credential is bound to the origin it was saved for. A brain
// (or anyone editing the configuration) moving the tracker's URL never sends
// the token to the new host until this machine's person confirms it.
section('resolver: the tracker token stays with the address it was saved for (Ruling 23)');
{
  const ytA = await startFakeYouTrack({ project: 'GAR', states: STATES, types: ['Bug', 'Task'], token: 'perm:test', login: 'tandemise-bot' });
  const ytB = await startFakeYouTrack({ project: 'GAR', states: STATES, types: ['Bug', 'Task'], token: 'perm:test', login: 'tandemise-bot' });
  try {
    const values = new Map();
    let n = 0;
    const secrets = {
      backend: 'memory',
      store: async (name, value) => { const ref = `memory:${name}:${++n}`; values.set(ref, value); return ref; },
      resolve: async (ref) => values.get(ref),
      remove: async (ref) => { values.delete(ref); },
      list: async () => [...values.keys()],
    };
    const origins = new Map();
    const originStore = {
      get: (ws, credential) => origins.get(`${ws}|${credential}`),
      set: (ws, credential, origin) => { if (origin === null) origins.delete(`${ws}|${credential}`); else origins.set(`${ws}|${credential}`, origin); },
    };
    const yt = (url) => ({
      kind: 'youtrack', url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete: 'in_review',
      states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix"] },
    });
    const configs = new Map();
    const source = { origin: 'brain', read: (ws) => ({ tracker: configs.get(ws) ?? null, sources: [], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } }) };
    const factories = K.compose(new K.Container(), Y.youtrackIntegrationModule);
    const resolver = new app.TrackerResolver({
      config: source, secrets, origins: originStore, factories: () => factories.resolveAll(I.PRIMARY_TRACKER_FACTORIES),
      log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    });
    const withToken = (fake) => fake.calls.filter((c) => c.authorization === 'Bearer perm:test').length;

    configs.set('ws_o', yt(ytA.url));
    await resolver.saveCredential('ws_o', 'perm:test');
    check('saving the token records the origin it was saved for', originStore.get('ws_o', 'tracker') === new URL(ytA.url).origin, originStore.get('ws_o', 'tracker'));
    await (await resolver.for('ws_o')).tracker.viewer();
    check('…and the tracker at that address gets it', withToken(ytA) > 0);

    // The brain moves the tracker to B.
    configs.set('ws_o', yt(ytB.url));
    const moved = await refusal(() => resolver.for('ws_o'));
    const sentence = `This project's tracker now points at ${new URL(ytB.url).origin}. Confirm the new address in Settings → Intake before Tandemise sends your token there.`;
    check('a moved tracker URL is refused in plain words', moved?.message === sentence, moved?.message);
    check('…no request carrying the token reaches the new address', withToken(ytB) === 0, ytB.calls.length);
    const mismatch = resolver.originMismatch('ws_o');
    check('…originMismatch names the current and the saved address', mismatch?.current === new URL(ytB.url).origin && mismatch?.saved === new URL(ytA.url).origin, mismatch);
    check('problemWith() on the moved URL sends nothing either', (await resolver.problemWith('ws_o', yt(ytB.url))) === null && withToken(ytB) === 0);

    resolver.confirmOrigin('ws_o');
    check('after confirming, there is no mismatch', resolver.originMismatch('ws_o') === null);
    check('…and the tracker at the new address gets the token', (await (await resolver.for('ws_o')).tracker.viewer()) === 'tandemise-bot' && withToken(ytB) > 0);

    // A token saved before origins were recorded adopts the address on first use.
    configs.set('ws_legacy', yt(ytA.url));
    await secrets.store(app.trackerSecretName('ws_legacy'), 'perm:test');
    check('a token with no recorded origin is used…', (await (await resolver.for('ws_legacy')).tracker.viewer()) === 'tandemise-bot');
    check('…and adopts the address of its first use', originStore.get('ws_legacy', 'tracker') === new URL(ytA.url).origin, originStore.get('ws_legacy', 'tracker'));
  } catch (e) {
    check('the origin section ran', false, String(e?.stack ?? e));
  } finally {
    await ytA.close();
    await ytB.close();
  }
}

// ------------------------------------------------------------------ daemon
section('daemon: PUT intake/config checks the mapping against the tracker');
{
  const home = join(ghRoot, 'home');
  const PATH = process.env.PATH;
  process.env.PATH = `${ghBin}:${PATH}`;
  delete process.env.TANDEMISE_CLOCK_OFFSET_MS;
  globalThis.__sqlite ??= await import('node:sqlite');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  try {
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
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
    const ws = (await api('POST', '/v1/workspaces', { name: 'Tracker' })).body?.workspace?.id;
    const bad = await api('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: ghConfig({ ...GH_STATES, in_progress: 'status: doing' }) });
    check("a mapping naming a missing label is refused: PRECONDITION_FAILED, GitHub has no state 'status: doing' in acme/web. …",
      bad.body?.error?.code === 'PRECONDITION_FAILED' && bad.body.error.message === "GitHub has no state 'status: doing' in acme/web. Its states are: open, closed, bug, status: in progress, status: in review.", bad);
    check('…and nothing is saved', (await api('GET', `/v1/workspaces/${ws}/intake/config`)).body?.tracker === null);
    const good = await api('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: ghConfig() });
    check('a mapping of existing labels is saved', good.status === 200 && good.body?.tracker?.repo === 'acme/web', good);
    check('the daemon asked the fake gh for the labels', calls(GH).filter((c) => c.args[0] === 'label' && c.args[1] === 'list').length >= 2);
  } catch (e) {
    check('the daemon section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    process.env.PATH = PATH;
    rmSync(ghRoot, { recursive: true, force: true });
  }
}

finish();
