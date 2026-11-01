// Intake (spec 2026-10-30-intake-design.md): anything that might be work,
// from any source, lands as one item in the project's primary tracker.
//
//   npm run build && node scratch/intake-check.mjs
//
// Sections grow with the plan's tasks. Task 1 pins the contract
// (`tandemise.intake/v1`, its limits and the config file schemas) and the
// pure rules the pipeline is built on.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const C = await import('@tandemise/api-contract');
const D = await import('@tandemise/domain');

// ------------------------------------------------------------------ contract
section('contract: tandemise.intake/v1');
{
  // The spec §1 example, with a 10-byte inline attachment.
  const example = () => ({
    schema: 'tandemise.intake/v1',
    source: { kind: 'sentry', instance: 'acme/web' },
    key: '4501234567',
    url: 'https://acme.sentry.io/issues/4501234567/',
    title: "TypeError: cannot read 'id' of undefined",
    description: 'Checkout breaks when the cart is empty.',
    reporter: { name: 'Sam Ortiz', handle: 'sam', url: 'https://github.com/sam' },
    occurredAt: '2026-10-30T09:12:00Z',
    attachments: [
      { name: 'trace.txt', mediaType: 'text/plain', url: 'https://acme.sentry.io/trace.txt' },
      { name: 'screen.png', mediaType: 'image/png', contentBase64: Buffer.alloc(10, 7).toString('base64') },
    ],
    impact: { level: 'error', events: 132, users: 41, firstSeen: '2026-10-29T08:00:00Z', lastSeen: '2026-10-30T09:12:00Z', release: 'web@2026.10.29' },
    labels: ['checkout'],
    reply: { address: 'sentry:acme/web:4501234567' },
    kindHint: 'bug',
  });
  const S = C.intakeSignalV1;
  check('the contract is exported', S !== undefined && C.INTAKE_SCHEMA_V1 === 'tandemise.intake/v1' && eq(C.ACCEPTED_INTAKE_SCHEMAS, ['tandemise.intake/v1']));
  if (S === undefined) {
    console.log(`\n${passed} passed, ${failures.length + 1} failed`);
    process.exit(1);
  }
  const ok = S.safeParse(example());
  check('the spec §1 example parses', ok.success, ok.error?.issues);
  check('its fingerprint is <kind>:<instance>:<key>', ok.success && D.fingerprintOf(ok.data) === 'sentry:acme/web:4501234567');
  check('only the five required fields parse alone', S.safeParse({ schema: 'tandemise.intake/v1', source: { kind: 'my-feed', instance: 'x' }, key: 'k', url: 'https://x.test/1', title: 'T' }).success);

  const text = (r) => (r.success ? '' : C.formatIntakeIssues(r.error));
  const pri = S.safeParse({ ...example(), priority: 'high' });
  check('an unknown field (priority) is refused and named', !pri.success && text(pri).includes('priority'), text(pri));
  check('a signal cannot choose the project', !S.safeParse({ ...example(), project: 'other' }).success);
  check('a v2-only field is refused inside v1', !S.safeParse({ ...example(), severityScore: 3 }).success);
  check('another schema is refused', !S.safeParse({ ...example(), schema: 'tandemise.intake/v2' }).success);
  check('a bad source kind is refused', !S.safeParse({ ...example(), source: { kind: 'Sentry!', instance: 'x' } }).success);

  const http = S.safeParse({ ...example(), url: 'http://acme.sentry.io/x' });
  check('http links are refused in plain words', !http.success && text(http).includes('Only https links are accepted.'), text(http));
  check('a reporter http link is refused too', !S.safeParse({ ...example(), reporter: { url: 'http://x.test' } }).success);
  check('an attachment http link is refused too', !S.safeParse({ ...example(), attachments: [{ name: 'a', mediaType: 'text/plain', url: 'http://x.test/a' }] }).success);

  const att = (bytes) => ({ name: 'a.bin', mediaType: 'application/octet-stream', contentBase64: Buffer.alloc(bytes, 1).toString('base64') });
  check('11 attachments are refused', !S.safeParse({ ...example(), attachments: Array.from({ length: 11 }, () => att(1)) }).success);
  check('10 attachments parse', S.safeParse({ ...example(), attachments: Array.from({ length: 10 }, () => att(1)) }).success);
  check('one inline attachment of 1 000 000 bytes parses', S.safeParse({ ...example(), attachments: [att(1_000_000)] }).success);
  const big = S.safeParse({ ...example(), attachments: [att(1_000_001)] });
  check('one inline attachment of 1 000 001 bytes is refused', !big.success, text(big));
  const many = S.safeParse({ ...example(), attachments: Array.from({ length: 6 }, () => att(900_000)) });
  check('six of 900 000 bytes (5.4 MB in all) are refused', !many.success, text(many));
  check('an attachment with both a url and inline content is refused', !S.safeParse({ ...example(), attachments: [{ ...att(1), url: 'https://x.test/a' }] }).success);
  check('an attachment with neither is refused', !S.safeParse({ ...example(), attachments: [{ name: 'a', mediaType: 'text/plain' }] }).success);
  check('inline content that is not base64 is refused', !S.safeParse({ ...example(), attachments: [{ name: 'a', mediaType: 'text/plain', contentBase64: 'not base64!' }] }).success);

  check('reporter.email is refused', !S.safeParse({ ...example(), reporter: { name: 'Sam', email: 'sam@x.test' } }).success);
  check('a title over 200 is refused', !S.safeParse({ ...example(), title: 'x'.repeat(201) }).success);
  check('a description over 20 000 is refused', !S.safeParse({ ...example(), description: 'x'.repeat(20_001) }).success);
  check('an unknown impact level is refused', !S.safeParse({ ...example(), impact: { level: 'critical' } }).success);
  check('an unknown kind hint is refused', !S.safeParse({ ...example(), kindHint: 'chore' }).success);

  // The push body: one signal, or a batch whose signals are checked one by one.
  const B = C.intakePushBody;
  check('a batch of 51 is refused', !B.safeParse({ signals: Array.from({ length: 51 }, example) }).success);
  check('a batch of 50 parses', B.safeParse({ signals: Array.from({ length: 50 }, example) }).success);
  check('a batch with one bad signal still parses as a batch', B.safeParse({ signals: [example(), { ...example(), priority: 'high' }] }).success);
  check('one signal parses as a push body', B.safeParse(example()).success);
  check('an empty batch is refused', !B.safeParse({ signals: [] }).success);

  const good = C.validateIntakeSignal(example());
  check('validateIntakeSignal accepts a good signal', good.ok && good.signal.key === '4501234567');
  const bad = C.validateIntakeSignal({ ...example(), priority: 'high', url: 'http://x.test' });
  check('validateIntakeSignal lists the issues in one readable line', !bad.ok && bad.reason.includes('priority') && bad.reason.includes('url: Only https links are accepted.') && bad.issues.length === 2, bad);
  check('…and keeps the fingerprint and title it could read', !bad.ok && bad.fingerprint === 'sentry:acme/web:4501234567' && bad.title === example().title, bad);
  const junk = C.validateIntakeSignal('nope');
  check('…and null for what it could not read', !junk.ok && junk.fingerprint === null && junk.title === null, junk);
  const v2 = C.validateIntakeSignal({ ...example(), schema: 'tandemise.intake/v2' });
  check('a schema this daemon does not accept is named', !v2.ok && v2.reason.includes("tandemise.intake/v2"), v2);
}

section('pure: mergeImpact and labels');
{
  const m = D.mergeImpact({ events: 3, users: 1, level: 'warning', lastSeen: 'A' }, { events: 300, users: 2, level: 'error', lastSeen: 'B' });
  check('mergeImpact takes the larger counts, the later lastSeen, the worse level', m.events === 300 && m.users === 2 && m.level === 'error' && m.lastSeen === 'B', m);
  const back = D.mergeImpact({ events: 300, level: 'fatal', firstSeen: '2026-10-01', lastSeen: '2026-10-30', release: 'r1' }, { events: 4, level: 'info', firstSeen: '2026-10-05', lastSeen: '2026-10-29' });
  check('…and never moves backwards', back.events === 300 && back.level === 'fatal' && back.firstSeen === '2026-10-01' && back.lastSeen === '2026-10-30' && back.release === 'r1', back);
  check('…and the newer release wins', D.mergeImpact({ release: 'r1' }, { release: 'r2' }).release === 'r2');
  check('…null on either side is the other', eq(D.mergeImpact(null, { events: 1 }), { events: 1 }) && eq(D.mergeImpact({ users: 2 }, null), { users: 2 }) && D.mergeImpact(null, null) === null);
  check('fingerprintOf', D.fingerprintOf({ source: { kind: 'custom', instance: 'feed' }, key: 'k1' }) === 'custom:feed:k1');
  check('signal statuses', D.SIGNAL_STATUSES.length === 10 && D.SIGNAL_STATUSES.includes('needs_decision') && D.SIGNAL_STATUSES.includes('closure_failed'));
  check('shipped source labels', ['github', 'sentry', 'posthog', 'slack', 'discord'].map(D.sourceLabel).join(',') === 'GitHub,Sentry,PostHog,Slack,Discord');
  check('a custom slug reads as itself', D.sourceLabel('my-feed') === 'my-feed');
}

section('contract: config files (tracker.yaml, intake.yaml)');
{
  const trackerYaml = `
tracker:
  kind: youtrack
  url: https://acme.youtrack.cloud
  project: GAR
  board: "project: GAR #Unresolved sort by: updated desc"
  states:
    ready: [Open, Submitted]
    in_progress: In Progress
    in_review: In Review
    done: [Fixed, Done]
    wont_do: [Won't fix, Duplicate, Obsolete]
  onComplete: in_review
`;
  const t = C.trackerFileV1.safeParse(parseYaml(trackerYaml));
  check('trackerFileV1 parses the spec §6.2 YAML', t.success && t.data.tracker.onComplete === 'in_review' && eq(t.data.tracker.states.done, ['Fixed', 'Done']), t.error?.issues);
  const noReview = parseYaml(trackerYaml);
  delete noReview.tracker.states.in_review;
  check('onComplete in_review without an in_review state is refused', !C.trackerFileV1.safeParse(noReview).success);
  noReview.tracker.onComplete = 'done';
  check('…and parses once onComplete is done', C.trackerFileV1.safeParse(noReview).success);
  const noReady = parseYaml(trackerYaml);
  noReady.tracker.states.ready = [];
  check('an empty ready list is refused', !C.trackerFileV1.safeParse(noReady).success);
  const plainHttp = parseYaml(trackerYaml);
  plainHttp.tracker.url = 'http://acme.youtrack.cloud';
  check('a plain-http tracker url is refused', !C.trackerFileV1.safeParse(plainHttp).success);
  plainHttp.tracker.url = 'http://127.0.0.1:4100';
  check('…but loopback http (fakes, self-hosted on this machine) is allowed', C.trackerFileV1.safeParse(plainHttp).success);
  check('a github-issues tracker parses', C.trackerFileV1.safeParse({ tracker: { kind: 'github-issues', repo: 'acme/web', board: 'is:open', states: { ready: ['open'], in_progress: 'in progress', done: ['closed'], wont_do: [] }, onComplete: 'done' } }).success);

  const intakeYaml = `
sources:
  - id: sentry-web
    kind: sentry
    instance: acme/web
    every: 10m
    filter:
      minLevel: error
      minEvents: 20
      minUsers: 3
      window: 24h
      ignoreTitles: ["ResizeObserver loop", "/^Network ?Error/"]
    create: { type: Bug, fields: { Subsystem: Web } }
  - id: slack-support
    kind: slack
    instance: acme.slack.com#support
    trigger: { emoji: tandemise }
    create: { type: Task }
dailyCap: 20
`;
  const i = C.intakeFileV1.safeParse(parseYaml(intakeYaml));
  check('intakeFileV1 parses the spec §4.1 YAML', i.success && i.data.dailyCap === 20 && i.data.sources.length === 2, i.error?.issues);
  check('…and defaults similarity to { link: 0.85, ask: 0.55 }', i.success && eq(i.data.similarity, { link: 0.85, ask: 0.55 }), i.data?.similarity);
  check('…and closeOnDone / closeWontDo to false', i.success && i.data.sources[0].closeOnDone === false && i.data.sources[0].closeWontDo === false);
  check('dailyCap defaults to 20', C.intakeFileV1.safeParse({ sources: [] }).data?.dailyCap === 20);
  const src = (extra) => ({ sources: [{ id: 'feed', kind: 'custom', instance: 'x', ...extra }] });
  check('a bad source id is refused', !C.intakeFileV1.safeParse({ sources: [{ id: 'Feed!', kind: 'custom', instance: 'x' }] }).success);
  check('two sources with one id are refused', !C.intakeFileV1.safeParse({ sources: [src({}).sources[0], src({}).sources[0]] }).success);
  check('an unknown cadence is refused', !C.intakeFileV1.safeParse(src({ every: '7m' })).success);
  check('an https api override parses', C.intakeFileV1.safeParse(src({ api: 'https://sentry.acme.internal' })).success);
  check('a loopback http api override parses', C.intakeFileV1.safeParse(src({ api: 'http://localhost:4200' })).success);
  check('a remote http api override is refused', !C.intakeFileV1.safeParse(src({ api: 'http://sentry.acme.internal' })).success);
}

section('contract: the JSON Schema for runner authors');
{
  let js = null;
  try { js = JSON.parse(readFileSync(join(repo, 'docs/intake/signal.v1.schema.json'), 'utf8')); } catch (e) { check('docs/intake/signal.v1.schema.json is valid JSON', false, String(e)); }
  if (js) {
    check('docs/intake/signal.v1.schema.json is valid JSON', true);
    check('its properties are the zod shape', eq(Object.keys(js.properties).sort(), Object.keys(C.intakeSignalV1.shape).sort()), Object.keys(js.properties));
    check('it rejects unknown fields', js.additionalProperties === false);
    check('its required fields are the five', eq(js.required, ['schema', 'source', 'key', 'url', 'title']), js.required);
    // Nested objects mirror the zod shapes too, so a runner in another language learns the same rules.
    const shapeOf = (z) => {
      let t = z;
      while (t && !t.shape) t = t._def?.innerType ?? t._def?.schema ?? t._def?.type;
      return t?.shape;
    };
    const resolve = (node) => (node?.$ref ? js.$defs[node.$ref.replace('#/$defs/', '')] : node);
    for (const name of ['source', 'reporter', 'impact', 'reply']) {
      const node = resolve(js.properties[name]);
      check(`${name} mirrors the zod shape and is closed`, node?.additionalProperties === false && eq(Object.keys(node.properties).sort(), Object.keys(shapeOf(C.intakeSignalV1.shape[name])).sort()), node && Object.keys(node.properties ?? {}));
    }
    const attItem = resolve(resolve(js.properties.attachments).items);
    const zAtt = shapeOf(C.intakeSignalV1.shape.attachments);
    check('attachments mirror the zod shape and are closed', attItem?.additionalProperties === false && resolve(js.properties.attachments).maxItems === 10 && eq(Object.keys(attItem.properties).sort(), Object.keys(zAtt ?? {}).sort()), attItem && Object.keys(attItem.properties));
    check('the enums match', eq(resolve(js.properties.impact).properties.level.enum, [...D.IMPACT_LEVELS]) && eq(js.properties.kindHint.enum, [...D.KIND_HINTS]));
    check('the source kind pattern matches', resolve(js.properties.source).properties.kind.pattern === C.INTAKE_SOURCE_KIND_PATTERN.source);
    check('the https rule is in the schema', String(resolve(js.properties.url).pattern ?? '').startsWith('^https://'));
    check('the limits are in the schema', js.properties.title.maxLength === 200 && js.properties.key.maxLength === 200 && js.properties.description.maxLength === 20000);
  }
}

// ------------------------------------------------------------------ noise
// Task 6: the noise filter is a pure function of the aggregated signal and the
// source's rules (spec §4.1). Each row of the plan's table is pinned exactly.
section('noise: evaluateNoise and the daily cap');
{
  const now = '2026-10-30T12:00:00.000Z';
  const rules = { minLevel: 'error', minEvents: 20, minUsers: 3, window: '24h' };
  const sig = (impact, extra = {}) => ({ title: 'TypeError: x', occurrences: 1, impact: { level: 'error', events: 3, users: 2, lastSeen: now, ...impact }, ...extra });
  const held = (reason) => ({ verdict: 'held_back', reason });
  const pass = { verdict: 'pass' };
  const row = (label, got, want) => check(label, eq(got, want), got);
  row('3 events in a 24 h window under minEvents 20 is held back',
    D.evaluateNoise(sig({}), rules, now), held('3 events in 24 h; this source needs 20'));
  row('132 events and 41 people pass', D.evaluateNoise(sig({ events: 132, users: 41 }), rules, now), pass);
  row('132 events but 2 people is held back on users',
    D.evaluateNoise(sig({ events: 132, users: 2 }), rules, now), held('2 people affected; this source needs 3'));
  row('a warning under minLevel error is held back on the level first',
    D.evaluateNoise(sig({ level: 'warning' }), rules, now), held('Level warning; this source takes error and above'));
  row('last seen 3 days ago is outside a 24 h window',
    D.evaluateNoise(sig({ events: 132, users: 41, lastSeen: '2026-10-27T12:00:00.000Z' }), rules, now),
    held('Last seen 3 days ago; this source looks at the last 24 h'));
  row('an ignoreTitles substring holds back first',
    D.evaluateNoise(sig({ events: 132, users: 41 }, { title: 'ResizeObserver loop limit exceeded' }), { ...rules, ignoreTitles: ['ResizeObserver loop'] }, now),
    held("Ignored by this source's rule 'ResizeObserver loop'"));
  check('an ignoreTitles /regex/ holds back',
    D.evaluateNoise(sig({ events: 132, users: 41 }, { title: 'Network Error' }), { ignoreTitles: ['/^Network ?Error/'] }, now).verdict === 'held_back');
  row('no rules pass everything', D.evaluateNoise(sig({ events: 0, users: 0, level: 'info' }), undefined, now), pass);
  row('dailyCapReason(20)', D.dailyCapReason(20), 'This source already filed 20 tasks today; decide on this one.');
  // Beyond the table (Ruling 11): events fall back to occurrences; a rule the
  // signal has no data for does not hold it back.
  row('with no impact, minEvents counts occurrences',
    D.evaluateNoise({ title: 't', occurrences: 4, impact: null }, { minEvents: 5 }, now), held('4 events; this source needs 5'));
  row('…and passes once the occurrences reach it', D.evaluateNoise({ title: 't', occurrences: 5, impact: null }, { minEvents: 5 }, now), pass);
  row('a level, user count or last sighting the signal lacks does not hold it back',
    D.evaluateNoise({ title: 't', occurrences: 1, impact: null }, { minLevel: 'error', minUsers: 3, window: '1h' }, now), pass);
  row('a broken /regex/ rule matches nothing instead of throwing',
    D.evaluateNoise({ title: 'x(', occurrences: 1, impact: null }, { ignoreTitles: ['/x(/'] }, now), pass);
  row('a substring rule ignores case',
    D.evaluateNoise({ title: 'resizeobserver LOOP', occurrences: 1, impact: null }, { ignoreTitles: ['ResizeObserver loop'] }, now).verdict, 'held_back');
  row('one person reads in the singular',
    D.evaluateNoise({ title: 't', occurrences: 1, impact: { users: 1 } }, { minUsers: 3 }, now), held('1 person affected; this source needs 3'));
  row('an age under a day reads in hours',
    D.evaluateNoise({ title: 't', occurrences: 1, impact: { lastSeen: '2026-10-30T07:00:00.000Z' } }, { window: '1h' }, now), held('Last seen 5 hours ago; this source looks at the last 1 h'));
}

// ------------------------------------------------------------------ similarity
// Task 6: the default IntakeSimilarity is lexical (spec §5 step 4).
section('similarity: titleTokens and lexicalSimilarity');
{
  const title = "TypeError: cannot read 'id' of undefined";
  check('titleTokens drops stopwords, one-letter words and repeats', eq(D.titleTokens(title), ['typeerror', 'read', 'id', 'undefined']), D.titleTokens(title));
  const item = (t, description = '') => ({ ref: 'youtrack:GAR-1', key: 'GAR-1', url: 'https://yt.test/issue/GAR-1', title: t, description, state: 'Open', assignee: null, updatedAt: '2026-10-30T00:00:00Z', createdAt: '2026-10-30T00:00:00Z' });
  const sig = (t, url = 'https://acme.sentry.io/issues/1/') => ({ title: t, description: '', url });
  const s = D.lexicalSimilarity(sig(title), item(`${title} in checkout`));
  check('the same error plus " in checkout" scores 0.84, between ask and link', s === 0.84 && s >= D.DEFAULT_INTAKE_SIMILARITY.ask && s < D.DEFAULT_INTAKE_SIMILARITY.link, s);
  check('a title with itself scores 1', D.lexicalSimilarity(sig('Checkout button does nothing on Safari'), item('Checkout button does nothing on Safari')) === 1);
  check('unrelated titles score 0', D.lexicalSimilarity(sig('Export to CSV is slow'), item('Checkout button does nothing on Safari')) === 0);
  check("a candidate whose description holds the signal's URL scores 1",
    D.lexicalSimilarity(sig('Export to CSV is slow'), item('Something else', '## Sources\n- x · https://acme.sentry.io/issues/1/')) === 1);
  const diff = D.lexicalSimilarity(sig('TypeError: read id'), item('RangeError: read id'));
  check('different error types keep only the title words (0.8 × Jaccard)', diff === 0.4, diff);
  check('two titles with no words score 0, not NaN', D.lexicalSimilarity(sig('!!', ''), item('a')) === 0);
}

section('write-back: decideTrackerWriteBack and activityCommentBody (Task 9)');
{
  const mapping = { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate'], onComplete: 'in_review' };
  const decide = (status, over = {}) => D.decideTrackerWriteBack({ mapping, mission: { status }, prOpen: false, pendingApproval: false, upstreamState: 'In Progress', writtenState: 'In Progress', ...over }).transition;
  check("COMPLETE with onComplete 'in_review' → 'In Review'", decide('COMPLETE') === 'In Review', decide('COMPLETE'));
  check("COMPLETE with onComplete 'done' → the first done state", D.decideTrackerWriteBack({ mapping: { ...mapping, onComplete: 'done' }, mission: { status: 'COMPLETE' }, prOpen: false, pendingApproval: false, upstreamState: 'In Progress', writtenState: 'In Progress' }).transition === 'Fixed');
  check("a person's 'Fixed' against the written 'In Progress' → no transition (Review Focus 3)", decide('COMPLETE', { upstreamState: 'Fixed' }) === null);
  check("CANCELLED → 'Open'", decide('CANCELLED') === 'Open', decide('CANCELLED'));
  check("CANCELLED after 'In Review' was written → back to 'Open' (the one way backwards)", decide('CANCELLED', { upstreamState: 'In Review', writtenState: 'In Review' }) === 'Open');
  check("EXECUTING after 'In Review' was written → no transition (never backwards)", decide('EXECUTING', { upstreamState: 'In Review', writtenState: 'In Review' }) === null);
  check("a pull request waiting on a person → 'In Review'", decide('EXECUTING', { prOpen: true, pendingApproval: true }) === 'In Review');
  check('a pull request alone keeps it in progress', decide('EXECUTING', { prOpen: true }) === null);
  check("READY_TO_SHIP → 'In Review'", decide('READY_TO_SHIP') === 'In Review');
  check('nothing written yet → no transition', decide('COMPLETE', { writtenState: null }) === null);

  const steps = [{ title: 'Reproduce on Safari', state: 'done' }, { title: 'Fix the Pay button', state: 'running' }];
  const body = D.activityCommentBody({ starter: 'Ana', missionTitle: 'Checkout fails on Safari', steps, prUrl: null, completed: null, cancelled: null });
  check('activityCommentBody: a two-step plan, one done and one running, line by line', eq(body.split('\n'), [
    'Started in Tandemise by Ana: Checkout fails on Safari.',
    '',
    'Plan:',
    '- [x] Reproduce on Safari',
    '- [ ] Fix the Pay button — running',
  ]), body.split('\n'));
  const full = D.activityCommentBody({
    starter: '@ana', missionTitle: 'Fix | it', steps: [{ title: 'Wait', state: 'waiting' }, { title: 'Hold', state: 'held' }, { title: 'Later', state: 'todo' }],
    prUrl: 'https://github.com/acme/web/pull/7', completed: { rows: [{ key: 'U1', statement: 'Checkout works on Safari', result: 'PASS' }] }, cancelled: null,
  });
  check('…waiting, held and to-do steps, the PR, then the criteria table', eq(full.split('\n'), [
    'Started in Tandemise by @​ana: Fix \\| it.',
    '',
    'Plan:',
    '- [ ] Wait — waiting for a person',
    '- [ ] Hold — held',
    '- [ ] Later',
    '',
    'Pull request: https://github.com/acme/web/pull/7',
    '',
    'Done in Tandemise — 1 of 1 criteria verified.',
    '',
    '| Key | Criterion | Result |',
    '|---|---|---|',
    '| U1 | Checkout works on Safari | Verified |',
  ]), full.split('\n'));
  const stopped = D.activityCommentBody({ starter: 'Ana', missionTitle: 'X', steps: null, prUrl: null, completed: null, cancelled: { readyState: 'Open' } });
  check('…and a cancelled mission says it moved back', stopped.endsWith('\n\nStopped in Tandemise; moved back to Open.'), stopped);
  check('the milestone read back from a body', D.activityMilestoneOf(body) === 'started' && D.activityMilestoneOf(full) === 'completed'
    && D.activityMilestoneOf(D.activityCommentBody({ starter: 'A', missionTitle: 'Pull request: x', steps: null, prUrl: 'https://x.test/pull/1', completed: null, cancelled: null })) === 'pr'
    && D.activityMilestoneOf(D.activityCommentBody({ starter: 'A', missionTitle: 'X', steps: [{ title: 'Done in Tandemise — 1 of 1 criteria verified.', state: 'todo' }], prUrl: null, completed: null, cancelled: null })) === 'started');
}

// ------------------------------------------------------------------ store
// Task 2: migration 024 (Ruling 1) and the intake repositories, on a fresh
// database with a clock the check moves by hand.
section('store: migration and repositories');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Container, compose } = await import('@tandemise/kernel');
  const { ids } = await import('@tandemise/shared');
  const P = await import('@tandemise/persistence');
  const app = await import('@tandemise/application');
  let t = Date.parse('2026-10-30T10:00:00.000Z');
  const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
  const tick = (ms) => { t += ms; };
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-intake-store-'));
  const container = new Container();
  try {
    compose(container, P.persistenceModule({ path: join(dir, 'tandemise.db'), clock }));
    const db = container.resolve(P.DATABASE);

    // 1. The schema is at the last migration in the list (022 on this base, Ruling 1).
    const last = P.MIGRATIONS[P.MIGRATIONS.length - 1];
    const max = db.handle.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    check('schema_migrations reaches the last migration, and 024 is intake (with credential origins, Ruling 23)', max === last.version && P.MIGRATIONS.some((m) => m.version === 24 && m.name === 'intake') && max === P.SCHEMA_VERSION, { max, last: last?.name });
    const tables = new Set(db.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const want = ['intake_sources', 'intake_tokens', 'intake_signals', 'intake_attachments', 'tracker_items', 'intake_links', 'intake_closures', 'tracker_comments', 'intake_webhook_inbox', 'intake_credential_origins'];
    check('the ten intake tables exist', want.every((n) => tables.has(n)), want.filter((n) => !tables.has(n)));

    // The three application tokens carry the persistence tokens' export names,
    // so the daemon's aliasPorts loop binds them (apps/daemon/src/bootstrap.ts).
    const names = ['INTAKE_REPOSITORY', 'TRACKER_ITEM_REPOSITORY', 'WEBHOOK_MAILBOX'];
    check('application and persistence export the three tokens by the same name', names.every((n) => app[n]?.description && P[n]?.description && app[n] !== P[n]));
    if (!names.every((n) => P[n] && app[n])) throw new Error('intake tokens missing');
    for (const n of names) container.bind(app[n], (r) => r.resolve(P[n]), { source: `alias:${n}` });
    const intake = container.resolve(app.INTAKE_REPOSITORY);
    const items = container.resolve(app.TRACKER_ITEM_REPOSITORY);
    const mailbox = container.resolve(app.WEBHOOK_MAILBOX);
    const workspaces = container.resolve(P.WORKSPACE_REPOSITORY);
    const missions = container.resolve(P.MISSION_REPOSITORY);

    const ws = ids.workspace();
    workspaces.create({
      id: ws, name: 'Intake', defaultRepositoryId: null,
      autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
      concurrency: { maxTotalWorkers: 1, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced',
      knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
    });

    // 2. One fingerprint, one row: occurrences count, impact merges, latest text wins.
    const sig = (over = {}) => ({
      schema: 'tandemise.intake/v1', source: { kind: 'sentry', instance: 'acme/web' }, key: '4501',
      url: 'https://acme.sentry.io/issues/4501/', title: 'TypeError in checkout',
      impact: { events: 3, users: 1, level: 'warning', lastSeen: '2026-10-30T09:00:00Z' }, ...over,
    });
    const a = intake.upsertSignal(ws, 'sentry-web', sig(), clock.now());
    tick(60_000);
    const b = intake.upsertSignal(ws, 'sentry-web', sig({ title: 'TypeError in checkout (cart)', impact: { events: 300, users: 2, level: 'error', lastSeen: '2026-10-30T10:00:00Z' } }), clock.now());
    const rows = db.handle.prepare('SELECT COUNT(*) AS n FROM intake_signals WHERE workspace_id = ?').get(ws).n;
    check('a second push of one fingerprint updates the same row', rows === 1 && a.signal.id === b.signal.id, { rows });
    check('firstTime is true, then false', a.firstTime === true && b.firstTime === false);
    check('occurrences count the pushes', b.signal.occurrences === 2, b.signal.occurrences);
    check('impact is merged (3 -> 300 events, error)', b.signal.impact?.events === 300 && b.signal.impact?.users === 2 && b.signal.impact?.level === 'error', b.signal.impact);
    check('the latest title wins and first/last seen are kept', b.signal.title === 'TypeError in checkout (cart)' && b.signal.firstSeenAt < b.signal.lastSeenAt && b.signal.status === 'received', b.signal);
    check('findSignal finds it by fingerprint', intake.findSignal(ws, 'sentry:acme/web:4501')?.id === a.signal.id);

    // A rejected push is recorded, and never undoes a signal already in the pipeline (Ruling 6).
    const rej = intake.recordRejected(ws, 'custom', 'my-feed:x:1', 'Broken', "Unknown field 'priority'.");
    check('a rejected signal is recorded with its reason', rej.status === 'rejected' && rej.reason === "Unknown field 'priority'." && rej.title === 'Broken', rej);
    const kept = intake.recordRejected(ws, 'sentry-web', 'sentry:acme/web:4501', 'x', 'bad');
    check('a bad repeat of a good signal leaves it alone', kept.status === 'received' && kept.title === 'TypeError in checkout (cart)', kept);
    const revived = intake.upsertSignal(ws, 'custom', sig({ source: { kind: 'my-feed', instance: 'x' }, key: '1' }), clock.now());
    check('a valid push after a rejected one enters the pipeline as new', revived.firstTime && revived.signal.id === rej.id && revived.signal.status === 'received' && revived.signal.reason === null, revived);
    check('listSignals filters by status', intake.listSignals(ws, { statuses: ['received'] }).length === 2 && intake.listSignals(ws, { statuses: ['rejected'] }).length === 0);
    const held = intake.setStatus(a.signal.id, 'needs_decision', 'Is this the same as GAR-12?', { candidateRef: 'youtrack:GAR-12', score: 0.7 });
    check('setStatus keeps the reason, candidate and score', held.status === 'needs_decision' && held.candidateRef === 'youtrack:GAR-12' && held.score === 0.7, held);
    intake.addAttachment(a.signal.id, { name: 'trace.txt', mediaType: 'text/plain', url: 'https://acme.sentry.io/t.txt', blobSha256: null });
    check('attachments round-trip', intake.attachments(a.signal.id).length === 1 && intake.attachments(a.signal.id)[0].url === 'https://acme.sentry.io/t.txt');
    let badAttachment = null;
    try { intake.addAttachment(a.signal.id, { name: 'x', mediaType: 'text/plain', url: null, blobSha256: null }); } catch (e) { badAttachment = e; }
    check('an attachment with neither a blob nor a url is refused', badAttachment !== null);

    // 3. One link per signal.
    const link = intake.createPendingLink(ws, a.signal.id, null, 'created');
    let second = null;
    try { intake.createPendingLink(ws, a.signal.id, 'youtrack:GAR-1', 'url'); } catch (e) { second = e; }
    check('a second link for the same signal throws', second !== null && link.status === 'pending');
    check('the pending link is listed for restart', intake.pendingLinks().some((l) => l.id === link.id));
    const done = intake.completeLink(link.id, 'youtrack:GAR-1');
    check('completeLink sets the ref and marks it done', done.status === 'done' && done.itemRef === 'youtrack:GAR-1' && intake.linkFor(a.signal.id)?.status === 'done' && !intake.pendingLinks().some((l) => l.id === link.id));
    intake.createPendingLink(ws, revived.signal.id, 'youtrack:GAR-2', 'similarity', 0.9);
    check("repointLinks moves a duplicate's links", intake.repointLinks(ws, 'youtrack:GAR-2', 'youtrack:GAR-1') === 1 && intake.linksForItem(ws, 'youtrack:GAR-1').length === 2);

    // 4. The daily cap counts only links that created an item, since the day started.
    check('createdToday counts only linked_by=created since the day start',
      intake.createdToday(ws, 'sentry-web', '2026-10-30T00:00:00.000Z') === 1
      && intake.createdToday(ws, 'custom', '2026-10-30T00:00:00.000Z') === 0
      && intake.createdToday(ws, 'sentry-web', '2026-10-31T00:00:00.000Z') === 0);

    // 5. A closure per (signal, kind).
    const c1 = intake.closures.ensure(a.signal.id, 'done');
    const c2 = intake.closures.ensure(a.signal.id, 'done');
    check('closures.ensure twice returns the same closure', c1.id === c2.id && c1.state === 'pending');
    check('a pending closure is due', intake.closures.due(clock.now()).some((c) => c.id === c1.id));
    const closed = intake.closures.update(c1.id, { state: 'closed', attempts: 1, closedAt: clock.now(), externalId: 'reply-1' });
    check('a closed closure is no longer due', closed.state === 'closed' && !intake.closures.due(clock.now()).some((c) => c.id === c1.id) && intake.closures.listForSource(ws, 'sentry-web').length === 1);

    // Tokens are stored by hash only.
    const tok = intake.tokens.create(ws, 'custom', 'a'.repeat(64), 'Demo');
    check('a token is found by its hash', intake.tokens.byHash('a'.repeat(64))?.id === tok.id && tok.revokedAt === null);
    intake.tokens.revoke(tok.id);
    check('a revoked token says so', intake.tokens.byHash('a'.repeat(64))?.revokedAt !== null && intake.tokens.list(ws).length === 1);

    // Sources keep their state per project.
    intake.saveSource(ws, 'sentry-web', { kind: 'sentry', enabled: true, enabledBy: 'Demo', cursor: { since: 'x' } });
    check('a source round-trips and is listed as enabled', intake.source(ws, 'sentry-web')?.cursor?.since === 'x' && intake.listEnabledSources().length === 1 && intake.listSources(ws).length === 1);

    // 6. The board cache, and a mission that points at it.
    const tracked = items.upsert(ws, { ref: 'youtrack:GAR-1', key: 'GAR-1', url: 'https://yt.test/issue/GAR-1', title: 'T', description: 'D', state: 'Open', assignee: null, updatedAt: '2026-10-30T10:00:00Z', createdAt: '2026-10-30T09:00:00Z', type: 'Bug' });
    const again = items.upsert(ws, { ...tracked, state: 'In Progress' });
    check('an item upserts by ref, keeping its id', again.id === tracked.id && again.state === 'In Progress' && items.byKey(ws, 'GAR-1')?.id === tracked.id && items.list(ws).length === 1);
    items.setWrittenState(tracked.id, 'In Progress');
    check('the written state is kept across a refresh', items.upsert(ws, { ...tracked, state: 'In Progress' }).writtenState === 'In Progress');
    items.saveComment(ws, 'youtrack:GAR-1', 'tandemise:activity', 'c-1', 'v1');
    items.saveComment(ws, 'youtrack:GAR-1', 'tandemise:activity', 'c-1', 'v2');
    check('one comment per (item, marker)', items.comment(ws, 'youtrack:GAR-1', 'tandemise:activity')?.body === 'v2');
    const mission = missions.create({ id: ids.mission(), workspaceId: ws, repositoryId: null, title: 'From GAR-1', goal: 'g', trackerItemId: tracked.id });
    check('a mission is written with its tracker item', missions.get(mission.id)?.trackerItemId === tracked.id);
    items.removeMissing(ws, []);
    check("removing the tracker item clears the mission's pointer", items.get(tracked.id) === undefined && missions.get(mission.id)?.trackerItemId === null, missions.get(mission.id)?.trackerItemId);

    // 7. The webhook mailbox: claim, release, ack.
    const id = mailbox.put({ workspaceId: ws, sourceId: 'github', headers: { 'x-github-event': 'issues' }, body: new TextEncoder().encode('{"a":1}') });
    const first = mailbox.pull(10);
    check('put then pull(10) returns the message', first.length === 1 && first[0].id === id && new TextDecoder().decode(first[0].body) === '{"a":1}' && first[0].headers['x-github-event'] === 'issues', first);
    check('a second pull returns nothing (claimed)', mailbox.pull(10).length === 0);
    mailbox.release(id);
    check('after release it is pulled again', mailbox.pull(10).length === 1);
    mailbox.ack(id);
    mailbox.release(id);
    check('after ack it is gone for good', mailbox.pull(10).length === 0);
  } catch (e) {
    check('the store section ran', false, String(e?.stack ?? e));
  } finally {
    await container.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ ingest
// Task 3: IntakeService validates and records what custom runners push, over
// the real application module, the local config source and a hand-moved clock.
// The HTTP route, the token check at the listener and the CLI are pinned by
// scratch/intake-daemon-check.mjs.
section('ingest: validate and record, in process');
{
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths } = await import('@tandemise/shared');
  const P = await import('@tandemise/persistence');
  const A = await import('@tandemise/artifacts');
  const app = await import('@tandemise/application');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER } = await import('@tandemise/integrations-core');
  let t = Date.parse('2026-10-30T10:00:00.000Z');
  const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
  const HOME = mkdtempSync(join(tmpdir(), 'tandemise-intake-ingest-'));
  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'intake-check' } });
  const container = new Container();
  try {
    compose(
      container,
      P.persistenceModule({ path: paths.db, logger: log, clock }),
      A.createArtifactsModule({ paths }),
      policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
      executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
    );
    container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
    container.bind(EXEC_LOGGER, () => log, { source: 'check' });
    container.bind(EXEC_PATHS, () => paths, { source: 'check' });
    container.bind(INT_CLOCK, () => clock, { source: 'check' });
    container.bind(INT_LOGGER, () => log, { source: 'check' });
    container.bind(COMMAND_EXECUTOR, () => ({ run: async () => { throw new Error('unused'); } }), { source: 'check' });
    container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
    const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
    for (const name of Object.keys(app)) {
      const appToken = app[name]; const provider = P[name];
      if (!isToken(appToken) || !isToken(provider)) continue;
      if (!container.has(provider) || container.has(appToken)) continue;
      container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
    }
    container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
    container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
    container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
    container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
    container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
    container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
    container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
    container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
    container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
    container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
    const services = app.createServices(container);
    check('the application exposes the intake service', services.intake !== undefined && app.INTAKE_SERVICE !== undefined && app.INTAKE_CONFIG_SOURCE !== undefined && app.INTAKE_BLOBS !== undefined);
    if (services.intake === undefined) throw new Error('no intake service');
    const intake = services.intake;
    const caller = { personId: services.identity.localPerson().id };
    const ws = (await services.workspaces.create(caller, { name: 'Intake' })).workspace.id;
    const scope = { workspaceId: ws, sourceId: 'custom-feed', tokenId: null };
    const signal = (over = {}) => ({
      schema: 'tandemise.intake/v1', source: { kind: 'custom', instance: 'custom-feed' }, key: 'k1',
      url: 'https://feed.test/k1', title: 'Checkout is slow', ...over,
    });
    const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

    // Nothing configured: there is no tracker to land in.
    const none = await refusal(() => intake.ingest(scope, signal()));
    check("a push with no tracker is refused: Set this project's tracker first.", none?.code === 'CONFLICT' && none?.message === "Set this project's tracker first.", { code: none?.code, message: none?.message });

    const config = container.resolve(app.INTAKE_CONFIG_SOURCE);
    check('the local config source reads an empty project', config.origin === 'local' && config.read(ws).tracker === null && config.read(ws).dailyCap === 20);
    config.write(ws, {
      tracker: {
        kind: 'youtrack', url: 'https://yt.test', project: 'GAR', board: 'project: GAR #Unresolved',
        states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
      },
      intake: { sources: [{ id: 'custom-feed', kind: 'custom', instance: 'custom-feed', closeOnDone: false, closeWontDo: false }], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } },
    });
    const read = config.read(ws);
    check('the local config source round-trips the tracker and sources', read.tracker?.kind === 'youtrack' && read.sources.length === 1 && read.sources[0].id === 'custom-feed', read);
    let badWrite = null;
    try { config.write(ws, { tracker: { kind: 'youtrack', board: 'x', states: { ready: ['Open'], in_progress: 'P', done: ['Done'], wont_do: [] }, onComplete: 'done' } }); } catch (e) { badWrite = e; }
    check('the local config source refuses a youtrack tracker with no url or project', badWrite?.code === 'VALIDATION' && config.read(ws).tracker?.project === 'GAR', badWrite?.message);

    const unknown = await refusal(() => intake.ingest({ ...scope, sourceId: 'nope' }, signal()));
    check("an unknown source is refused: This project has no intake source 'nope'.", unknown?.code === 'NOT_FOUND' && unknown?.message === "This project has no intake source 'nope'.", { code: unknown?.code, message: unknown?.message });

    const first = await intake.ingest(scope, signal());
    t += 1000;
    const second = await intake.ingest(scope, signal({ title: 'Checkout is slow again' }));
    check('a valid signal is received, with no reason', first.status === 'received' && first.reason === null && first.fingerprint === 'custom:custom-feed:k1', first);
    const listed = intake.list(ws, {});
    check('the same fingerprint twice is one signal with occurrences 2', second.signalId === first.signalId && listed.length === 1 && listed[0].occurrences === 2 && listed[0].status === 'received' && listed[0].title === 'Checkout is slow again', listed);

    const bad = await intake.ingest(scope, signal({ key: 'k2', priority: 'high' }));
    const rejected = intake.list(ws, { statuses: ['rejected'] });
    check("an invalid signal is answered and listed as rejected, naming 'priority'", bad.status === 'rejected' && bad.reason?.includes('priority') && rejected.length === 1 && rejected[0].reason?.includes('priority') && rejected[0].fingerprint === 'custom:custom-feed:k2', { bad, rejected });
    const unreadable = await intake.ingest(scope, { schema: 'tandemise.intake/v1', title: 42 });
    check('an unreadable signal gets an invalid:<source>:<hash> fingerprint and a placeholder title', /^invalid:custom-feed:[0-9a-f]{16}$/.test(unreadable.fingerprint ?? '') && intake.list(ws, { statuses: ['rejected'] }).some((s) => s.title === '(unreadable signal)'), unreadable);

    // Inline attachments are stored by sha256; links are only recorded.
    const withFiles = await intake.ingest(scope, signal({ key: 'k3', attachments: [
      { name: 'note.txt', mediaType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') },
      { name: 'trace.txt', mediaType: 'text/plain', url: 'https://feed.test/trace.txt' },
    ] }));
    await intake.ingest(scope, signal({ key: 'k3', attachments: [{ name: 'note.txt', mediaType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }] }));
    const repo = container.resolve(app.INTAKE_REPOSITORY);
    const atts = repo.attachments(withFiles.signalId);
    const blobs = container.resolve(app.INTAKE_BLOBS);
    const inline = atts.find((a) => a.name === 'note.txt');
    check('an inline attachment is stored as a blob, a url attachment as a link, and a repeat adds none',
      atts.length === 2 && inline?.blobSha256?.length === 64 && new TextDecoder().decode(await blobs.get(inline.blobSha256)) === 'hello'
      && atts.find((a) => a.name === 'trace.txt')?.url === 'https://feed.test/trace.txt', atts);

    // Tokens: minted once, stored hashed, scoped to one source, rate-limited per signal.
    const minted = intake.mintToken(caller, ws, 'custom-feed');
    check('a minted token starts tdi_ and resolves to its source', /^tdi_[A-Za-z0-9_-]{32}$/.test(minted.token) && intake.resolveToken(minted.token)?.sourceId === 'custom-feed' && intake.resolveToken(minted.token)?.tokenId === minted.id, minted);
    check('only its sha256 is stored', repo.tokens.list(ws).every((r) => r.tokenHash !== minted.token && r.tokenHash.length === 64));
    check('an unknown token resolves to nothing', intake.resolveToken('tdi_' + 'x'.repeat(32)) === null && intake.resolveToken('nonsense') === null);
    const tokenScope = intake.resolveToken(minted.token);
    const foreign = await refusal(() => intake.ingest(tokenScope, signal({ source: { kind: 'custom', instance: 'other-feed' } })));
    check("a token's push naming another source is refused: This token can only push to 'custom-feed'.", foreign?.code === 'PERMISSION_DENIED' && foreign?.message === "This token can only push to 'custom-feed'.", foreign?.message);
    let limited = null;
    for (let i = 0; i < 61; i++) {
      try { await intake.ingest(tokenScope, signal({ key: `r${i}` })); } catch (e) { limited = { i, e }; break; }
    }
    check('the 61st signal in a minute is refused: Too many signals from this source: at most 60 a minute.',
      limited?.i === 60 && limited.e.code === 'RATE_LIMITED' && limited.e.message === 'Too many signals from this source: at most 60 a minute.', limited && { i: limited.i, code: limited.e.code, message: limited.e.message });
    t += 60_000;
    const after = await refusal(() => intake.ingest(tokenScope, signal({ key: 'r-after' })));
    check('after the minute has passed, a push passes again', after === null, after?.message);
    const revoked = intake.mintToken(caller, ws, 'custom-feed');
    intake.revokeToken(caller, revoked.id);
    check('a revoked token resolves to nothing', intake.resolveToken(revoked.token) === null);
    // Ruling 26: revoking takes a seat in the token's project. Anyone else is
    // told there is no such token, so a token id says nothing about a project.
    const kept = intake.mintToken(caller, ws, 'custom-feed');
    const stranger = { personId: 'person_stranger' };
    const foreignRevoke = await refusal(() => intake.revokeToken(stranger, kept.id));
    check("revoking a token of a project the caller has no seat in is NOT_FOUND, and the token still works",
      foreignRevoke?.code === 'NOT_FOUND' && intake.resolveToken(kept.token) !== null, { code: foreignRevoke?.code, message: foreignRevoke?.message });
    const unknownRevoke = await refusal(() => intake.revokeToken(caller, 'itk_nope'));
    check('revoking a token that does not exist is NOT_FOUND', unknownRevoke?.code === 'NOT_FOUND', unknownRevoke?.code);
  } catch (e) {
    check('the ingest section ran', false, String(e?.stack ?? e));
  } finally {
    // The pipeline runs after each push (Task 7); let it finish before the database closes.
    await container.resolve((await import('@tandemise/application')).INTAKE_SERVICE).settle?.();
    await container.dispose();
    rmSync(HOME, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ pipeline
// Task 7: after recording, a signal is filtered, deduped, then created in or
// linked to the primary tracker, once (spec §4, §5, §6.1). Against the fake
// YouTrack (and the fake gh for "the source is the tracker"), over the real
// application module, a hand-moved clock and a check-owned settings store and
// secret store, so a second container can open the same database as the
// same daemon after a crash (Review Focus 1).
const pipeline = await (async () => {
  const { execFile } = await import('node:child_process');
  const { mkdirSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Container, compose, defineModule } = await import('@tandemise/kernel');
  const { createLogger, createPaths } = await import('@tandemise/shared');
  const P = await import('@tandemise/persistence');
  const A = await import('@tandemise/artifacts');
  const app = await import('@tandemise/application');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const I = await import('@tandemise/integrations-core');
  const Y = await import('@tandemise/integration-youtrack');
  const G = await import('@tandemise/integration-github');
  const { startFakeYouTrack } = await import('./fake-youtrack.mjs');
  const fakeGh = await import('./fake-gh.mjs');

  let t = Date.parse('2026-10-30T10:00:00.000Z');
  const clock = { now: () => new Date(t).toISOString(), epochMs: () => t };
  const log = createLogger({ level: 'error', base: { component: 'intake-check' } });
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
  const ghRoot = mkdtempSync(join(tmpdir(), 'tdi-pipe-gh-'));
  const ghBin = fakeGh.installFakeGh(join(ghRoot, 'gh'));
  const exec = {
    run: (req) => new Promise((resolve) => {
      execFile(req.command, req.args ?? [], { cwd: req.cwd, env: { ...process.env, PATH: `${ghBin}:${process.env.PATH}`, ...(req.env ?? {}) }, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout, stderr, timedOut: false, durationMs: 0, command: [req.command, ...(req.args ?? [])].join(' ') });
      });
    }),
  };

  /**
   * One daemon: a container over `home`'s database. `settings` and `secrets`
   * are handed in, so a second container on the same home is the same daemon
   * restarted. `providers` are the tracker modules it composes.
   */
  async function open({ home, settings, secrets, providers, bindings }) {
    const paths = createPaths(home);
    mkdirSync(paths.root, { recursive: true });
    const container = new Container();
    compose(
      container,
      P.persistenceModule({ path: paths.db, logger: log, clock }),
      A.createArtifactsModule({ paths }),
      policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
      executionCoreModule, executionLocalModule, I.integrationsCoreModule, ...providers, app.createApplicationModule({ localPersonName: 'Demo' }),
    );
    container.bind(EXEC_CLOCK, () => clock, { source: 'check' });
    container.bind(EXEC_LOGGER, () => log, { source: 'check' });
    container.bind(EXEC_PATHS, () => paths, { source: 'check' });
    container.bind(I.CLOCK, () => clock, { source: 'check' });
    container.bind(I.LOGGER, () => log, { source: 'check' });
    container.bind(I.COMMAND_EXECUTOR, () => exec, { source: 'check' });
    container.bind(I.BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
    const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
    for (const name of Object.keys(app)) {
      const appToken = app[name]; const provider = P[name];
      if (!isToken(appToken) || !isToken(provider)) continue;
      if (!container.has(provider) || container.has(appToken)) continue;
      container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
    }
    container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
    container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
    container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
    container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
    container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
    container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
    container.bind(app.SECRET_STORE, () => secrets, { source: 'check' });
    container.bind(app.SETTINGS_STORE, () => settings, { source: 'check' });
    container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home, schemaVersion: 1 }), { source: 'check' });
    container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });
    bindings?.(container);
    const services = app.createServices(container);
    return {
      container, services, intake: services.intake,
      repo: container.resolve(app.INTAKE_REPOSITORY),
      items: container.resolve(app.TRACKER_ITEM_REPOSITORY),
      config: container.resolve(app.INTAKE_CONFIG_SOURCE),
      resolver: container.resolve(app.TRACKER_RESOLVER),
      caller: { personId: services.identity.localPerson().id },
    };
  }

  const ytTracker = (url) => ({
    kind: 'youtrack', url, project: 'GAR', board: 'project: GAR #Unresolved', onComplete: 'in_review',
    states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed', 'Done'], wont_do: ["Won't fix", 'Duplicate', 'Obsolete'] },
    // A Task runs the planned preset with its plan card (the write-back sections drive it); any other type, the factory.
    workflows: { Task: 'feature-delivery' },
  });
  const SOURCES = [
    { id: 'sentry-web', kind: 'sentry', instance: 'acme/web', filter: { minLevel: 'error', minEvents: 20, minUsers: 3, window: '24h' }, create: { type: 'Bug' }, closeOnDone: false, closeWontDo: false },
    { id: 'slack-support', kind: 'slack', instance: 'acme.slack.com#support', closeOnDone: false, closeWontDo: false },
  ];
  const intakeConfig = (over = {}) => ({ sources: SOURCES, dailyCap: 20, similarity: { link: 0.85, ask: 0.55 }, ...over });
  /** A YouTrack project for `d`: the tracker over `fakeUrl`, both sources, and the token saved. */
  async function configureYouTrack(d, fakeUrl) {
    const ws = (await d.services.workspaces.create(d.caller, { name: 'Intake pipeline' })).workspace.id;
    d.config.write(ws, { tracker: ytTracker(fakeUrl), intake: intakeConfig() });
    await d.resolver.saveCredential(ws, 'perm:test');
    return ws;
  }
  const GAR1_TITLE = "TypeError: cannot read 'id' of undefined";
  const sentry = (over = {}) => ({
    schema: 'tandemise.intake/v1', source: { kind: 'sentry', instance: 'acme/web' }, key: '4501234567',
    url: 'https://acme.sentry.io/issues/4501234567/', title: GAR1_TITLE,
    description: 'Checkout breaks when the cart is empty. cc @ana', reporter: { name: 'Sam Ortiz' },
    impact: { level: 'error', events: 132, users: 41, lastSeen: clock.now() }, ...over,
  });
  const slack = (key, title, over = {}) => ({
    schema: 'tandemise.intake/v1', source: { kind: 'slack', instance: 'acme.slack.com#support' }, key,
    url: `https://acme.slack.com/archives/C1/${key}`, title, reporter: { handle: 'dana' }, ...over,
  });
  return {
    app, clock, open, configureYouTrack, intakeConfig, sentry, slack, GAR1_TITLE, memorySecrets, startFakeYouTrack,
    Y, G, I, defineModule, fakeGh, ghRoot, mkdtempSync, tmpdir,
    advance: (ms) => { t += ms; },
  };
})();

section('pipeline: filter, dedupe, then create or link (Task 7)');
const fake = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const { rmSync } = await import('node:fs');
const homes = [];
const newHome = () => { const h = pipeline.mkdtempSync(join(pipeline.tmpdir(), 'tdi-pipe-')); homes.push(h); return h; };
const creates = () => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/issues').length;
const withUrl = (url) => [...fake.issues.values()].filter((i) => i.description.includes(url)).length;
let PA = null;
try {
  const { app, sentry, slack } = pipeline;
  PA = await pipeline.open({ home: newHome(), settings: app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  const ws = await pipeline.configureYouTrack(PA, fake.url);
  const push = async (signal, sourceId = 'sentry-web') => {
    const r = await PA.intake.ingest({ workspaceId: ws, sourceId, tokenId: null }, signal);
    await PA.intake.settle();
    return { ...PA.repo.getSignal(r.signalId), link: PA.repo.linkFor(r.signalId) };
  };

  // 1. Over the bar: a new item, with the Sources section and the type.
  const s1 = await push(sentry());
  const gar1 = fake.issues.get('GAR-1');
  check('1. a signal over the bar is created as GAR-1', s1.status === 'created' && s1.link?.status === 'done' && s1.link?.itemRef === 'youtrack:GAR-1' && s1.link?.linkedBy === 'created', { status: s1.status, reason: s1.reason, link: s1.link });
  check('…its description has the Sources line', gar1?.description.includes('## Sources\n- Sentry · acme/web · 132 events, 41 users · https://acme.sentry.io/issues/4501234567/'), gar1?.description);
  check('…and who recorded it', gar1?.description.includes('Recorded by Tandemise from Sentry, reported by Sam Ortiz.'), gar1?.description);
  check('…the type comes from the source (Type=Bug, set as data)', fake.fieldSets.some((c) => c.issue === 'GAR-1' && c.fields.includes('Type=Bug')), fake.fieldSets);
  check('…copied text never pings anyone (@mentions broken)', gar1?.description.includes('cc @​ana') && !gar1?.description.includes('cc @ana'), gar1?.description);
  check('…and the item is in the board cache', PA.items.byRef(ws, 'youtrack:GAR-1')?.key === 'GAR-1');

  // 2. The same fingerprint again: the local index answers.
  const s2 = await push(sentry());
  check('2. the same fingerprint again is linked, with no new item', s2.status === 'linked' && creates() === 1, { status: s2.status, creates: creates() });

  // 3. Under the bar, then over it on its own.
  const nan = (events) => sentry({ key: '777', url: 'https://acme.sentry.io/issues/777/', title: 'Checkout total shows NaN', impact: { level: 'error', events, users: 5, lastSeen: pipeline.clock.now() } });
  const s3 = await push(nan(3));
  check("3. 3 events is held back: '3 events in 24 h; this source needs 20'", s3.status === 'held_back' && s3.reason === '3 events in 24 h; this source needs 20' && creates() === 1, { status: s3.status, reason: s3.reason });
  const s3b = await push(nan(300));
  check('…and the same fingerprint at 300 events is created as GAR-2', s3b.status === 'created' && s3b.link?.itemRef === 'youtrack:GAR-2' && creates() === 2, { status: s3b.status, reason: s3b.reason, link: s3b.link });

  // 4. Another daemon, its own database, the same tracker: the exact URL answers.
  const PB = await pipeline.open({ home: newHome(), settings: app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  try {
    const wsB = await pipeline.configureYouTrack(PB, fake.url);
    const r = await PB.intake.ingest({ workspaceId: wsB, sourceId: 'sentry-web', tokenId: null }, sentry());
    await PB.intake.settle();
    const sb = PB.repo.getSignal(r.signalId);
    const lb = PB.repo.linkFor(r.signalId);
    check("4. another daemon's same signal is linked by its exact URL, no new item", sb.status === 'linked' && lb?.linkedBy === 'url' && lb?.itemRef === 'youtrack:GAR-1' && creates() === 2, { status: sb.status, reason: sb.reason, link: lb });
    const sourcesComment = (fake.comments.get('GAR-1') ?? []).find((c) => c.text.startsWith('<!-- tandemise:sources -->'));
    check('…and the URL is in its sources comment', sourcesComment?.text.includes('https://acme.sentry.io/issues/4501234567/'), fake.comments.get('GAR-1'));
  } finally {
    await PB.intake.settle();
    await PB.container.dispose();
  }

  // 5. The source is the tracker: a GitHub issue of the tracker repo is that item.
  const PG = await pipeline.open({ home: newHome(), settings: app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.G.githubIntegrationModule] });
  try {
    const wsG = (await PG.services.workspaces.create(PG.caller, { name: 'GitHub intake' })).workspace.id;
    PG.config.write(wsG, {
      tracker: { kind: 'github-issues', repo: 'acme/web', board: 'is:open', onComplete: 'done', states: { ready: ['open'], in_progress: 'status: in progress', done: ['closed'], wont_do: [] } },
      intake: { sources: [{ id: 'gh-web', kind: 'github', instance: 'acme/web', closeOnDone: false, closeWontDo: false }], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } },
    });
    const r = await PG.intake.ingest({ workspaceId: wsG, sourceId: 'gh-web', tokenId: null }, {
      schema: 'tandemise.intake/v1', source: { kind: 'github', instance: 'acme/web' }, key: '9', url: 'https://github.com/acme/web/issues/9', title: 'Checkout button does nothing on Safari',
    });
    await PG.intake.settle();
    const sg = PG.repo.getSignal(r.signalId);
    const lg = PG.repo.linkFor(r.signalId);
    const ghCalls = pipeline.fakeGh.calls(join(pipeline.ghRoot, 'gh'));
    check('5. a GitHub issue of the tracker repo is linked as itself (source_is_item), nothing created', sg.status === 'linked' && lg?.linkedBy === 'source_is_item' && lg?.itemRef === 'github:acme/web#9' && !ghCalls.some((c) => c.args[0] === 'issue' && c.args[1] === 'create'), { status: sg.status, reason: sg.reason, link: lg, ghCalls });
  } finally {
    await PG.intake.settle();
    await PG.container.dispose();
  }

  // 6. Similarity: the same title from another source links; a close one asks.
  const s6 = await push(slack('p1', pipeline.GAR1_TITLE), 'slack-support');
  check('6. the same title from Slack is linked by similarity, score 1', s6.status === 'linked' && s6.link?.linkedBy === 'similarity' && s6.link?.score === 1 && s6.link?.itemRef === 'youtrack:GAR-1' && creates() === 2, { status: s6.status, reason: s6.reason, link: s6.link });
  const s6b = await push(slack('p2', `${pipeline.GAR1_TITLE} in checkout`), 'slack-support');
  check("…a close title needs a decision: 'Is this the same as GAR-1?'", s6b.status === 'needs_decision' && s6b.reason === 'Is this the same as GAR-1?' && s6b.candidateRef === 'youtrack:GAR-1' && s6b.score >= 0.55 && s6b.score < 0.85 && creates() === 2, { status: s6b.status, reason: s6b.reason, candidateRef: s6b.candidateRef, score: s6b.score });
  const inbox = PA.services.projections.inbox(ws).intakeDecisions ?? [];
  check('…and the Inbox asks it, naming the candidate', inbox.length === 1 && inbox[0].signalId === s6b.id && inbox[0].question === 'Is this the same as GAR-1?' && inbox[0].candidate?.key === 'GAR-1' && inbox[0].sourceLabel === 'Slack', inbox);
  const decided = await PA.intake.decide(PA.caller, s6b.id, 'same');
  const s6c = PA.repo.getSignal(s6b.id);
  check("…'same' links it (person), and the Inbox is empty", decided.status === 'linked' && s6c.status === 'linked' && PA.repo.linkFor(s6b.id)?.linkedBy === 'person' && PA.repo.linkFor(s6b.id)?.itemRef === 'youtrack:GAR-1' && (PA.services.projections.inbox(ws).intakeDecisions ?? []).length === 0, { decided, link: PA.repo.linkFor(s6b.id) });

  // 7. Nothing like it: a new item.
  const s7 = await push(slack('p3', 'Export to CSV is slow'), 'slack-support');
  check('7. an unrelated title is created', s7.status === 'created' && s7.link?.itemRef === 'youtrack:GAR-3' && creates() === 3, { status: s7.status, reason: s7.reason, link: s7.link });
  check('…a reporter with no name reads as their handle', fake.issues.get('GAR-3')?.description.includes('Recorded by Tandemise from Slack, reported by dana.'), fake.issues.get('GAR-3')?.description);

  // 8. The daily cap: sentry-web filed GAR-1 and GAR-2 today.
  PA.config.write(ws, { intake: pipeline.intakeConfig({ dailyCap: 2 }) });
  const capped = (key, title) => sentry({ key, url: `https://acme.sentry.io/issues/${key}/`, title });
  const s8 = await push(capped('cap1', 'Login button misaligned on Firefox'));
  check("8. past the daily cap: 'This source already filed 2 tasks today; decide on this one.'", s8.status === 'needs_decision' && s8.reason === 'This source already filed 2 tasks today; decide on this one.' && s8.candidateRef === null && creates() === 3, { status: s8.status, reason: s8.reason, candidateRef: s8.candidateRef });
  const capCard = (PA.services.projections.inbox(ws).intakeDecisions ?? []).find((d) => d.signalId === s8.id);
  check('…the Inbox card has no candidate', capCard !== undefined && capCard.candidate === null && capCard.question === s8.reason, capCard);
  const s8b = await PA.intake.decide(PA.caller, s8.id, 'new');
  check("…'new' creates it, past the cap", s8b.status === 'created' && PA.repo.linkFor(s8.id)?.itemRef === 'youtrack:GAR-4' && creates() === 4, { s8b, link: PA.repo.linkFor(s8.id) });

  // 9. Not work.
  const s9 = await push(capped('cap2', 'Avatar upload spins forever'));
  const s9b = await PA.intake.decide(PA.caller, s9.id, 'not_work');
  check("9. 'not work' dismisses it: 'You marked this as not work.'", s9.status === 'needs_decision' && s9b.status === 'dismissed' && s9b.reason === 'You marked this as not work.' && PA.repo.linkFor(s9.id) === undefined && creates() === 4, { s9: s9.status, s9b });
  let again = null;
  try { await PA.intake.decide(PA.caller, s9.id, 'new'); } catch (e) { again = e; }
  check("…and deciding again is refused: 'This signal was already decided.'", again?.message === 'This signal was already decided.', again?.message);

  // 10. The tracker is down: the signal waits, and a later tick files it.
  PA.config.write(ws, { intake: pipeline.intakeConfig() });
  await fake.stop();
  const s10 = await push(slack('down1', 'Search results ignore the date filter'), 'slack-support');
  check("10. with YouTrack down the signal stays received: Couldn't reach YouTrack: …", s10.status === 'received' && s10.reason?.startsWith("Couldn't reach YouTrack:") && s10.reason?.endsWith('Tandemise will try again.'), { status: s10.status, reason: s10.reason });
  await fake.restart();
  pipeline.advance(10_000);
  PA.intake.tick();
  await PA.intake.settle();
  check('…a tick within the minute does not try again', PA.repo.getSignal(s10.id).status === 'received' && creates() === 4, PA.repo.getSignal(s10.id).status);
  pipeline.advance(61_000);
  PA.intake.tick();
  await PA.intake.settle();
  const s10b = PA.repo.getSignal(s10.id);
  check('…a tick past the minute files it once YouTrack is back', s10b.status === 'created' && s10b.reason === null && creates() === 5, { status: s10b.status, reason: s10b.reason });

  // A repeat whose events grew tenfold updates the same sources comment, never a new one.
  await push(sentry({ impact: { level: 'error', events: 1500, users: 41, lastSeen: pipeline.clock.now() } }));
  const sourcesComments = (fake.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:sources -->'));
  check('a linked signal whose events grew tenfold updates the one sources comment', sourcesComments.length === 1 && sourcesComments[0].text.includes('1500 events'), fake.comments.get('GAR-1'));
  const writes = fake.calls.length;
  await push(sentry({ impact: { level: 'error', events: 1600, users: 41, lastSeen: pipeline.clock.now() } }));
  check('…and a small change writes nothing', fake.calls.slice(writes).every((c) => c.method === 'GET'), fake.calls.slice(writes).map((c) => `${c.method} ${c.path}`));
} catch (e) {
  check('the pipeline section ran', false, String(e?.stack ?? e));
} finally {
  await PA?.intake?.settle?.();
  await PA?.container.dispose();
}

// ------------------------------------------------------------------ crash safety
// Review Focus 1: a crash between the pending link and the tracker call. The
// restarted daemon searches by exact URL before creating, so exactly one item
// exists whether the crash came before or after `create` returned.
section('crash safety: a pending create is finished once after a restart');
try {
  const { app } = pipeline;
  class Crash extends Error {}
  /** A YouTrack factory whose `create` dies before, or right after, the call reaches YouTrack. */
  const crashing = (when) => pipeline.defineModule('crashing-youtrack', (container) => {
    container.contribute(pipeline.I.PRIMARY_TRACKER_FACTORIES, () => ({
      kind: 'youtrack',
      create(config, credential) {
        const real = pipeline.Y.youtrackTrackerFactory.create(config, credential);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'create') {
              return async (draft) => {
                if (when === 'before') throw new Crash('the daemon died before create');
                await target.create(draft);
                throw new Crash('the daemon died after create');
              };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    }), { source: 'check' });
  });
  for (const when of ['before', 'after']) {
    const home = newHome();
    const settings = app.createMemorySettingsStore();
    const secrets = pipeline.memorySecrets();
    const url = `https://acme.sentry.io/issues/crash-${when}/`;
    const first = await pipeline.open({ home, settings, secrets, providers: [crashing(when)] });
    let signalId;
    try {
      const ws = await pipeline.configureYouTrack(first, fake.url);
      const r = await first.intake.ingest({ workspaceId: ws, sourceId: 'sentry-web', tokenId: null }, pipeline.sentry({ key: `crash-${when}`, url, title: when === 'before' ? 'Payment webhook times out' : 'Invoice PDF renders blank' }));
      await first.intake.settle();
      signalId = r.signalId;
      const link = first.repo.linkFor(signalId);
      check(`${when} create: the crash leaves a pending link with no item yet`, link?.status === 'pending' && link?.itemRef === null && link?.linkedBy === 'created', link);
      check(`${when} create: YouTrack holds ${when === 'before' ? 'no' : 'one'} item with the URL`, withUrl(url) === (when === 'before' ? 0 : 1), withUrl(url));
    } finally {
      await first.container.dispose();
    }
    const createsBefore = creates();
    const callsBefore = fake.calls.length;
    const second = await pipeline.open({ home, settings, secrets, providers: [pipeline.Y.youtrackIntegrationModule] });
    try {
      second.intake.tick();
      await second.intake.settle();
      const s = second.repo.getSignal(signalId);
      const link = second.repo.linkFor(signalId);
      check(`${when} create: after the restart exactly one item carries the URL, and the signal is created`, withUrl(url) === 1 && s.status === 'created' && s.reason === null && link?.status === 'done' && link?.itemRef?.startsWith('youtrack:GAR-'), { items: withUrl(url), status: s.status, reason: s.reason, link });
      check(`${when} create: the restart ${when === 'before' ? 'created it once' : 'adopted it by URL, creating nothing'}`, creates() - createsBefore === (when === 'before' ? 1 : 0) && link?.linkedBy === 'created', { created: creates() - createsBefore, link });
      const after = fake.calls.slice(callsBefore);
      const search = after.findIndex((c) => c.method === 'GET' && c.path === '/api/issues' && (c.query.get('query') ?? '').includes(`"${url}"`));
      const create = after.findIndex((c) => c.method === 'POST' && c.path === '/api/issues');
      check(`${when} create: the restart searched by exact URL before any create`, search >= 0 && (create < 0 || search < create), { search, create });
      check(`${when} create: the board cache holds the item`, second.items.byRef(s.workspaceId, link?.itemRef ?? '') !== undefined);
      second.intake.tick();
      await second.intake.settle();
      check(`${when} create: a second tick changes nothing`, withUrl(url) === 1 && second.repo.pendingLinks().length === 0 && creates() - createsBefore === (when === 'before' ? 1 : 0));
    } finally {
      await second.intake.settle();
      await second.container.dispose();
    }
  }
} catch (e) {
  check('the crash safety section ran', false, String(e?.stack ?? e));
} finally {
  await fake.close();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  rmSync(pipeline.ghRoot, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the board (Task 8)
// The board cache: the tracker's board query, grouped by mapped state, with
// the sources each item came from. Then Review Focus 2: two daemons racing on
// one signal leave at most one unresolved item once a board refresh runs.
section('board: the cache, grouped by mapped state, and duplicate merging (Task 8)');
const boardHomes = [];
const boardHome = () => { const h = pipeline.mkdtempSync(join(pipeline.tmpdir(), 'tdi-board-')); boardHomes.push(h); return h; };
const fakeB = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const fakeR = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const SAFARI = 'Checkout fails on Safari';
const DONE_WHEN = 'Clicking Pay on Safari does nothing.\n\n## Done when\n- [ ] Checkout works on Safari';
const boardDaemon = { home: boardHome(), settings: pipeline.app.createMemorySettingsStore(), secrets: pipeline.memorySecrets() };
let BD = null;
let boardWs = null;
try {
  fakeB.putIssue({ summary: SAFARI, description: DONE_WHEN, state: 'Open' });
  fakeB.putIssue({ summary: 'Search ignores the date filter', description: 'Filter by date returns everything.', state: 'In Progress', assignee: 'ana' });
  fakeB.putIssue({ summary: 'Export to CSV is slow', description: 'It takes a minute.', state: 'In Review' });
  BD = await pipeline.open({ ...boardDaemon, providers: [pipeline.Y.youtrackIntegrationModule] });
  boardWs = await pipeline.configureYouTrack(BD, fakeB.url);
  // The person who starts items: the goal and the activity comment name them.
  BD.container.resolve(pipeline.app.PERSON_REPOSITORY).update(BD.caller.personId, { displayName: 'Demo' });
  const tracker = BD.services.tracker;
  check('the services expose the tracker service', tracker !== undefined && typeof tracker?.refreshBoard === 'function');
  const before = tracker.board(boardWs);
  check('before a refresh the board is empty and says it was never read', before.refreshedAt === null && before.groups.ready.length === 0 && before.trackerLabel === 'YouTrack', before);
  const board = await tracker.refreshBoard(boardWs);
  const keys = (list) => list.map((i) => i.key);
  check('refreshBoard groups GAR-1 / GAR-2 / GAR-3 as ready / in progress / in review',
    eq(keys(board.groups.ready), ['GAR-1']) && eq(keys(board.groups.inProgress), ['GAR-2']) && eq(keys(board.groups.inReview), ['GAR-3']) && board.problem === null && board.refreshedAt !== null, board);
  const gar2 = board.groups.inProgress[0];
  check("…an item shows its state and assignee, and one in progress can't be started", gar2?.state === 'In Progress' && gar2?.assignee === 'ana' && gar2?.startable.ok === false && gar2?.startable.reason === 'Already in progress' && gar2?.mission === null, gar2);
  check('…a ready item can be started', board.groups.ready[0]?.startable.ok === true && board.groups.ready[0]?.url.endsWith('/issue/GAR-1'), board.groups.ready[0]);

  // A Sentry signal with GAR-1's title links to it: its chip reads "Sentry · 132 events".
  const r = await BD.intake.ingest({ workspaceId: boardWs, sourceId: 'sentry-web', tokenId: null }, pipeline.sentry({ title: SAFARI }));
  await BD.intake.settle();
  check('a Sentry signal with the same title links to GAR-1', BD.repo.linkFor(r.signalId)?.itemRef === 'youtrack:GAR-1', BD.repo.linkFor(r.signalId));
  const chips = tracker.board(boardWs).groups.ready[0]?.sources;
  check("GAR-1's chips show Sentry · 132 events", eq(chips, [{ label: 'Sentry', detail: '132 events' }]), chips);

  // Ruling 29 (found by I10): the board shows what the board query returns. An
  // item kept in the cache only because a signal points at it (Ruling 13) is
  // not on the board, even while its cached state is still a ready one.
  {
    const cfg = BD.container.resolve(pipeline.app.INTAKE_CONFIG_SOURCE);
    const tracker0 = cfg.read(boardWs).tracker;
    cfg.write(boardWs, { tracker: { ...tracker0, board: 'project: GAR #Unresolved Search' } });
    const narrowed = await tracker.refreshBoard(boardWs);
    const cachedGar1 = BD.container.resolve(pipeline.app.TRACKER_ITEM_REPOSITORY).byRef(boardWs, 'youtrack:GAR-1');
    check('an item the board query no longer returns is not on the board, though a signal keeps it cached',
      !narrowed.groups.ready.some((i) => i.key === 'GAR-1') && eq(keys(narrowed.groups.inProgress), ['GAR-2']) && cachedGar1?.state === 'Open', { ready: keys(narrowed.groups.ready), cached: cachedGar1?.state });
    cfg.write(boardWs, { tracker: tracker0 });
    const back = await tracker.refreshBoard(boardWs);
    check('…and it is back once the query returns it again', back.groups.ready.some((i) => i.key === 'GAR-1'), keys(back.groups.ready));
  }

  // An item the board query no longer returns stays cached while a signal points at it.
  fakeB.setState('GAR-1', 'Fixed');
  const afterFix = await tracker.refreshBoard(boardWs);
  check('a resolved item leaves the board…', !afterFix.groups.ready.some((i) => i.key === 'GAR-1'), afterFix.groups.ready);
  check('…but stays in the cache, re-read, while a signal links to it', BD.items.byKey(boardWs, 'GAR-1')?.state === 'Fixed', BD.items.byKey(boardWs, 'GAR-1'));
  fakeB.setState('GAR-1', 'Open');
  await tracker.refreshBoard(boardWs);
} catch (e) {
  check('the board section ran', false, String(e?.stack ?? e));
}

// Review Focus 2: two daemons, two fresh databases, one tracker, one signal.
try {
  const RA = await pipeline.open({ home: boardHome(), settings: pipeline.app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  const RB = await pipeline.open({ home: boardHome(), settings: pipeline.app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  try {
    const wsA = await pipeline.configureYouTrack(RA, fakeR.url);
    const wsB = await pipeline.configureYouTrack(RB, fakeR.url);
    const daemons = [{ name: 'A', d: RA, ws: wsA }, { name: 'B', d: RB, ws: wsB }];
    /**
     * One race. Which daemon's create lands first is the event loop's call, so
     * the roles are named after it: "A" refreshes first, then "B". With
     * `firstOwnsOlder`, A is the daemon whose item survived (the plan's case: A
     * merges, B follows the duplicate to the survivor); otherwise A owns the
     * newer item and moves its own link while it merges.
     */
    const race = async (n, firstOwnsOlder) => {
      const url = `https://acme.sentry.io/issues/race-${n}/`;
      const signal = pipeline.sentry({ key: `race-${n}`, url, title: n === 1 ? 'Cart badge shows a stale count' : 'Coupon field rejects valid codes' });
      // The first create waits 200 ms before YouTrack reads it, so the other
      // daemon's searches run before either item exists: both miss, both create.
      fakeR.delayNext('/api/issues', 200, 'POST');
      const ids = await Promise.all(daemons.map(({ d, ws }) => d.intake.ingest({ workspaceId: ws, sourceId: 'sentry-web', tokenId: null }, signal)));
      await Promise.all(daemons.map(({ d }) => d.intake.settle()));
      const carrying = () => [...fakeR.issues.values()].filter((i) => i.description.includes(url));
      const both = carrying().sort((a, b) => a.created - b.created);
      check(`race ${n}: both daemons missed and created, so two items carry the URL`, both.length === 2 && daemons.every(({ d }, i) => d.repo.getSignal(ids[i].signalId).status === 'created'), both.map((i) => i.idReadable));
      const [older, newer] = both.map((i) => i.idReadable);
      const ownsOlder = daemons.findIndex(({ d }, i) => d.repo.linkFor(ids[i].signalId)?.itemRef === `youtrack:${older}`);
      const order = (ownsOlder === 0) === firstOwnsOlder ? [0, 1] : [1, 0];
      const [A, B] = order.map((i, role) => ({ ...daemons[i], name: role === 0 ? 'A' : 'B', signalId: ids[i].signalId }));
      const link = (x) => x.d.repo.linkFor(x.signalId)?.itemRef;

      await A.d.services.tracker.refreshBoard(A.ws);
      check(`race ${n}: A's refresh marks the newer item a duplicate of the older (duplicates ${older} on ${newer})`,
        fakeR.commands.some((c) => c.query === `duplicates ${older}` && c.issues[0]?.idReadable === newer), fakeR.commands);
      const sources = (fakeR.comments.get(older) ?? []).find((c) => c.text.startsWith('<!-- tandemise:sources -->'));
      check(`race ${n}: the older item's sources comment holds the URL`, sources?.text.includes(url) === true, fakeR.comments.get(older));
      check(`race ${n}: A's link points to the older item`, link(A) === `youtrack:${older}`, link(A));

      await B.d.services.tracker.refreshBoard(B.ws);
      check(`race ${n}: after B's refresh B's link points to the older item`, link(B) === `youtrack:${older}`, link(B));
      const moved = [A, B].filter((x) => x.d.repo.getSignal(x.signalId).reason !== null).map((x) => ({ daemon: x.name, reason: x.d.repo.getSignal(x.signalId).reason }));
      check(`race ${n}: the moved signal (${firstOwnsOlder ? "B's" : "A's"}) says "Merged ${newer} into ${older}; same source."`,
        eq(moved, [{ daemon: firstOwnsOlder ? 'B' : 'A', reason: `Merged ${newer} into ${older}; same source.` }]), moved);
      const unresolvedWithUrl = carrying().filter((i) => i.resolved === null).map((i) => i.idReadable);
      check(`race ${n}: exactly one unresolved item carries the URL`, eq(unresolvedWithUrl, [older]), unresolvedWithUrl);
      const commands = fakeR.commands.length;
      await A.d.services.tracker.refreshBoard(A.ws);
      await B.d.services.tracker.refreshBoard(B.ws);
      check(`race ${n}: later refreshes merge nothing again`, fakeR.commands.length === commands, fakeR.commands.slice(commands));
    };
    await race(1, true);
    await race(2, false);
  } finally {
    await RA.intake.settle();
    await RB.intake.settle();
    await RA.container.dispose();
    await RB.container.dispose();
  }
} catch (e) {
  check('the race section ran', false, String(e?.stack ?? e));
}

// ------------------------------------------------------------------ Start (Task 8)
// Review Focus 4: Start makes exactly one mission, never queued; a second
// Start, or an item already in progress, is refused with the exact sentence,
// and P7's pull never picks the mission.
section('start: one mission from a tracker item, never queued (Task 8)');
try {
  if (BD === null || boardWs === null) throw new Error('the board section did not open its daemon');
  const tracker = BD.services.tracker;
  const missions = BD.container.resolve(pipeline.app.MISSION_REPOSITORY);
  const criteria = BD.container.resolve(pipeline.app.MISSION_CRITERIA_REPOSITORY);
  const fromTracker = () => missions.list({ workspaceId: boardWs }).filter((m) => m.trackerItemId !== null && m.trackerItemId !== undefined);
  const refusal = async (key) => { try { await tracker.start(BD.caller, boardWs, key); return null; } catch (e) { return e; } };

  const mission = await tracker.start(BD.caller, boardWs, 'GAR-1');
  await BD.intake.settle();
  await tracker.settle();
  const gar1 = BD.items.byKey(boardWs, 'GAR-1');
  const stored = missions.get(mission.id);
  check('Start GAR-1 makes exactly one mission, with its tracker item', fromTracker().length === 1 && stored?.trackerItemId === gar1?.id, fromTracker().map((m) => m.trackerItemId));
  // planNow: planning began at once. With no planner runtime here the preset
  // plans it in the same call, so it is already past PLANNING (RULINGS ruling 13).
  const planned = missions.get(mission.id);
  check('…never queued, and planned at once (its Done-when was parsed)', stored?.queuedAt === null && ['PLANNING', 'AWAITING_PLAN_APPROVAL', 'EXECUTING'].includes(mission.status) && planned?.queuedAt === null, { queuedAt: stored?.queuedAt, status: mission.status });
  check("…its goal starts 'YouTrack GAR-1, started by Demo: '", stored?.goal.startsWith('YouTrack GAR-1, started by Demo: ') === true, stored?.goal);
  check('…quotes the task as written and lists its sources', stored?.goal.includes(`The task as written in the tracker:\n\n${SAFARI}\n\n${DONE_WHEN}`) === true && stored?.goal.includes('\n\nSources:\n- Sentry · acme/web · ') === true, stored?.goal);
  check('…its title is the item title', stored?.title === SAFARI, stored?.title);
  const ledger = criteria.listActive(mission.id);
  check("…its ledger has 'Checkout works on Safari', decided by the tracker", ledger.some((c) => c.statement === 'Checkout works on Safari' && c.decidedBy === 'tracker'), ledger);
  check('…YouTrack shows GAR-1 In Progress', fakeB.issues.get('GAR-1')?.state === 'In Progress', fakeB.issues.get('GAR-1')?.state);
  const activity = (fakeB.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith('<!-- tandemise:activity -->'));
  check('…with one activity comment', activity.length === 1 && activity[0].text.includes(`Started in Tandemise by Demo: ${SAFARI}.`), fakeB.comments.get('GAR-1'));
  check('…and the written state is remembered', BD.items.byKey(boardWs, 'GAR-1')?.writtenState === 'In Progress', BD.items.byKey(boardWs, 'GAR-1'));
  const row = tracker.board(boardWs).groups.inProgress.find((i) => i.key === 'GAR-1');
  check('…the board shows its mission, and it cannot be started again', row?.mission?.id === mission.id && row?.startable.ok === false && row?.startable.reason === 'Has a mission', row);
  // #101: a mission whose next step waits on a saturated runtime says so on the Board,
  // not only "Mission: Executing". The reason is the executor's own deferral words.
  {
    const R = await import('@tandemise/runtimes-core');
    const tasks = BD.container.resolve(pipeline.app.TASK_REPOSITORY);
    const step = tasks.listByMission(mission.id)[0];
    check('…its mission has a step to wait', step !== undefined, tasks.listByMission(mission.id).map((t) => t.status));
    const before = row?.mission?.waiting;
    check('…a mission with nothing waiting says no slot wait', before === null, row?.mission);
    const saved = { status: step.status, statusReason: step.statusReason };
    const busy = R.describeRejections([{ profileId: 'rtp_x', profileName: 'Claude Code', reason: 'saturated: 1/1 runs in flight', busy: true }]);
    tasks.update(step.id, { status: 'READY', statusReason: `Waiting for a runtime slot. ${busy}` });
    const waiting = tracker.board(boardWs).groups.inProgress.find((i) => i.key === 'GAR-1')?.mission;
    check('…a READY step waiting for a runtime slot: "Waiting for a free slot on Claude Code"', waiting?.waiting === 'Waiting for a free slot on Claude Code', waiting);
    tasks.update(step.id, { statusReason: 'Waiting for you: sign in again' });
    const person = tracker.board(boardWs).groups.inProgress.find((i) => i.key === 'GAR-1')?.mission;
    check('…a step waiting on something else is no slot wait', person?.waiting === null, person);
    tasks.update(step.id, saved);
  }

  const second = await refusal('GAR-1');
  check(`a second Start of GAR-1 is refused: "GAR-1 already has a mission: ${SAFARI}."`, second?.code === 'CONFLICT' && second?.message === `GAR-1 already has a mission: ${SAFARI}.` && fromTracker().length === 1, { code: second?.code, message: second?.message });
  const busy = await refusal('GAR-2');
  check('Start of GAR-2 (In Progress, ana) is refused: "GAR-2 is already in progress (ana)."', busy?.code === 'CONFLICT' && busy?.message === 'GAR-2 is already in progress (ana).' && fromTracker().length === 1, { code: busy?.code, message: busy?.message });

  // No Done-when: a draft, not queued, and never pulled.
  fakeB.putIssue({ summary: 'Claims are checked', description: 'Two people, one item.', state: 'Open' });
  fakeB.putIssue({ summary: 'Dark mode toggle forgets its choice', description: 'It resets after a reload.', state: 'Open' });
  // #53 §4 changes #52 §7: with no type mapping the factory decides, and a Start with no
  // Done-when line plans at once in the quick and standard lanes.
  check('with no type mapping, Start lets the factory decide (workflow auto)', stored?.workflowPreset === 'auto', stored?.workflowPreset);
  const plain = await tracker.start(BD.caller, boardWs, 'GAR-5');
  check('an item with no criteria that is not careful plans at once, not queued', plain.status !== 'DRAFT' && missions.get(plain.id)?.queuedAt === null, { status: plain.status, queuedAt: missions.get(plain.id)?.queuedAt });
  // The careful lane still asks for Done-when lines: such an item opens as a draft to refine.
  const careful = fakeB.putIssue({ summary: 'Migrate the sessions schema', description: 'Sessions move to their own table.', state: 'Open' }).idReadable;
  const draft = await tracker.start(BD.caller, boardWs, careful);
  check('a careful item with no criteria starts as a DRAFT, not queued', draft.status === 'DRAFT' && missions.get(draft.id)?.queuedAt === null, { status: draft.status, queuedAt: missions.get(draft.id)?.queuedAt });
  const pulled = await BD.services.backlog.pull();
  check("P7's pull never picks it", pulled.length === 0, pulled);
  const scheduler = BD.container.resolve(pipeline.app.SCHEDULER);
  for (let i = 0; i < 3; i++) await scheduler.tick();
  await BD.intake.settle();
  await tracker.settle();
  check('…and it is still a DRAFT after three scheduler ticks', missions.get(draft.id)?.status === 'DRAFT' && missions.get(draft.id)?.queuedAt === null, missions.get(draft.id)?.status);
} catch (e) {
  check('the start section ran', false, String(e?.stack ?? e));
} finally {
  await BD?.intake?.settle?.();
  await BD?.services?.tracker?.settle?.();
  await BD?.container.dispose();
}

// Ruling 27: a failed Start lets go only of the claim it made (its mission id),
// never another claim the same person holds on the same item.
try {
  const released = [];
  const claims = [
    { id: 'clm_a', itemRef: 'youtrack:GAR-7', memberId: 'mem_ana', localRef: 'msn_live' },
    { id: 'clm_b', itemRef: 'youtrack:GAR-7', memberId: 'mem_ana', localRef: 'msn_failed' },
  ];
  const port = {
    me: () => ({ memberId: 'mem_ana', deviceId: 'dev_1' }),
    claims: () => claims,
    release: async (id) => { released.push(id); },
    onChange: () => {},
    status: () => ({ kind: 'relay' }),
  };
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
  const cs = new pipeline.app.CoordinationService({
    coordination: port, control: null, missions: { get: () => undefined }, issues: { getLink: () => undefined },
    settings: { read: () => ({}), write: () => ({}) }, recorder: { invalidate() {} }, cancelMission: async () => {},
    clock: { now: () => new Date() }, log: quiet,
  });
  await cs.releaseItem('youtrack:GAR-7', 'released', 'msn_failed');
  check("a failed Start's release names its mission: only that claim goes", eq(released, ['clm_b']), released);
  released.length = 0;
  await cs.releaseItem('youtrack:GAR-7', 'done');
  check('…a release without a mission still lets go of every claim of the person on the item', eq(released, ['clm_a', 'clm_b']), released);
  const src = readFileSync(join(repo, 'packages/application/src/services/tracker-service.ts'), 'utf8');
  check("…and Start's failure path passes its pre-named mission id", /releaseItem\(item\.ref, 'released', missionId\)/.test(src));
} catch (e) {
  check('the scoped release section ran', false, String(e?.stack ?? e));
}

// The claim refuses: Start says the claim's own words and makes nothing.
try {
  const refusing = (c) => c.rebind(pipeline.app.INTAKE_CLAIMS, () => ({
    source: async () => true,
    item: async () => ({ ok: false, reason: 'Ana is working on GAR-4 since 10:42.' }),
    releaseItem: async () => {},
  }), { source: 'check' });
  const RD = await pipeline.open({ ...boardDaemon, providers: [pipeline.Y.youtrackIntegrationModule], bindings: refusing });
  try {
    const missions = RD.container.resolve(pipeline.app.MISSION_REPOSITORY);
    const before = missions.list({ workspaceId: boardWs }).length;
    let refused = null;
    try { await RD.services.tracker.start(RD.caller, boardWs, 'GAR-4'); } catch (e) { refused = e; }
    check('with the claim refused, Start says exactly "Ana is working on GAR-4 since 10:42."', refused?.code === 'CONFLICT' && refused?.message === 'Ana is working on GAR-4 since 10:42.' && missions.list({ workspaceId: boardWs }).length === before, { code: refused?.code, message: refused?.message });
    check('…and GAR-4 is not moved', fakeB.issues.get('GAR-4')?.state === 'Open', fakeB.issues.get('GAR-4')?.state);
  } finally {
    await RD.services.tracker.settle();
    await RD.container.dispose();
  }
} catch (e) {
  check('the claims section ran', false, String(e?.stack ?? e));
} finally {
  await fakeB.close();
  await fakeR.close();
  for (const h of boardHomes) rmSync(h, { recursive: true, force: true });
}

// ------------------------------------------------------------------ claims (spec §3, acceptance "Claims"; Ruling 22)
// Two daemons, two databases, one team: Start takes the relay's
// ('tracker_item', ref) claim before the mission exists. While Ana holds
// GAR-1, Bruno's Start is refused in her words, even when the tracker still
// shows the item Open; once her mission ends, the claim is released and his
// Start goes through. Solo (no relay) the other Start sections show it is
// always granted.
section('claims: two daemons share the relay\'s claims; Start refuses with the holder\'s words');
{
  const { sharedTeam, eventBus } = await import('./shared-coordination.mjs');
  const team = sharedTeam(pipeline.clock);
  const fakeC = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
  const claimHomes = [];
  const opened = [];
  try {
    const daemon = async (name) => {
      const home = pipeline.mkdtempSync(join(pipeline.tmpdir(), 'tdi-claims-'));
      claimHomes.push(home);
      const settings = pipeline.app.createMemorySettingsStore();
      const port = team.join(name, `${name}'s laptop`);
      const d = await pipeline.open({
        home, settings, secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule],
        bindings: (c) => {
          c.bind(pipeline.app.COORDINATION, () => port, { source: 'check' });
          c.rebind(pipeline.app.EVENT_BUS, () => eventBus(), { source: 'check' });
        },
      });
      opened.push(d);
      const ws = await pipeline.configureYouTrack(d, fakeC.url);
      // One project on both machines: the brain's identity would name it (relay spec §Data model).
      settings.write({ coordination: { projectKeys: { [ws]: 'github.com/acme/brain' } } });
      d.container.resolve(pipeline.app.PERSON_REPOSITORY).update(d.caller.personId, { displayName: name });
      return { d, ws, name };
    };
    const ana = await daemon('Ana');
    const bruno = await daemon('Bruno');
    fakeC.putIssue({ summary: 'Checkout fails on Safari', description: DONE_WHEN, state: 'Open' });
    const missionsOf = (x) => x.d.container.resolve(pipeline.app.MISSION_REPOSITORY).list({ workspaceId: x.ws }).filter((m) => m.trackerItemId != null);
    const startOf = async (x) => { try { return { mission: await x.d.services.tracker.start(x.d.caller, x.ws, 'GAR-1') }; } catch (e) { return { error: e }; } };

    const a = await startOf(ana);
    check('Ana starts GAR-1', a.mission !== undefined, a.error?.message);
    const held = team.store.activeClaims().filter((c) => c.itemRef === 'youtrack:GAR-1');
    check("…the team holds one claim on youtrack:GAR-1, Ana's, tied to her mission",
      held.length === 1 && held[0].memberName === 'Ana' && held[0].projectKey === 'github.com/acme/brain' && held[0].localRef === a.mission?.id, held);
    // The tracker alone would not stop Bruno: someone moved GAR-1 back to Open.
    fakeC.setState('GAR-1', 'Open');
    const b = await startOf(bruno);
    check('Bruno\'s Start is refused with Ana\'s words: "Ana is working on GAR-1 since HH:MM."',
      b.error?.code === 'CONFLICT' && /^Ana is working on GAR-1 since \d\d:\d\d\.$/.test(b.error?.message ?? ''), { code: b.error?.code, message: b.error?.message });
    check('…before any mission exists on Bruno\'s machine', missionsOf(bruno).length === 0, missionsOf(bruno).map((m) => m.id));
    check('…and GAR-1 is not moved by Bruno', fakeC.issues.get('GAR-1')?.state === 'Open', fakeC.issues.get('GAR-1')?.state);
    const rows = ana.d.services.coordination?.rows?.(ana.ws) ?? [];
    check("Ana's Home lists GAR-1 as hers, with her mission", rows.some((r) => r.itemKey === 'GAR-1' && r.mine && r.missionId === a.mission?.id), rows);

    if (a.mission !== undefined) await ana.d.services.missions.cancel(a.mission.id, 'Not today.');
    await ana.d.services.tracker.settle();
    const after = team.store.activeClaims().filter((c) => c.itemRef === 'youtrack:GAR-1');
    check('cancelling Ana\'s mission releases the claim', after.length === 0, after);
    fakeC.setState('GAR-1', 'Open');
    const b2 = await startOf(bruno);
    check('…then Bruno\'s Start is granted and makes his mission', b2.mission !== undefined && missionsOf(bruno).length === 1, b2.error?.message);
    const bHeld = team.store.activeClaims().filter((c) => c.itemRef === 'youtrack:GAR-1');
    check('…and the team now sees Bruno on GAR-1', bHeld.length === 1 && bHeld[0].memberName === 'Bruno' && bHeld[0].localRef === b2.mission?.id, bHeld);
  } catch (e) {
    check('the shared claims section ran', false, String(e?.stack ?? e));
  } finally {
    for (const d of opened) { await d.intake.settle(); await d.services.tracker.settle(); await d.container.dispose(); }
    await fakeC.close();
    team.close();
    for (const h of claimHomes) rmSync(h, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ write-back (Task 9)
// The tracker follows a started mission: one activity comment, edited at most
// once a minute and always ending on the latest state, and the mapped state
// moves only while the item is where Tandemise left it (Review Focus 3). The
// mission's state is driven through the repositories, as replan-check does.
section('write-back: the activity comment and the state follow the mission (Task 9)');
const wbHomes = [];
const wbHome = () => { const h = pipeline.mkdtempSync(join(pipeline.tmpdir(), 'tdi-wb-')); wbHomes.push(h); return h; };
const fakeW = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const fakeN = await pipeline.startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
const ACTIVITY = '<!-- tandemise:activity -->';
/** The daemon's handles for driving a started mission by hand. */
const driver = (d, ws) => {
  const r = (token) => d.container.resolve(token);
  const repo = {
    missions: r(pipeline.app.MISSION_REPOSITORY), tasks: r(pipeline.app.TASK_REPOSITORY), approvals: r(pipeline.app.APPROVAL_REPOSITORY),
    artifacts: r(pipeline.app.ARTIFACT_REPOSITORY), evaluations: r(pipeline.app.EVALUATION_REPOSITORY), criteria: r(pipeline.app.MISSION_CRITERIA_REPOSITORY),
  };
  let n = 0;
  return {
    repo,
    /** One write-back pass: the scheduler's tracker tick, waited for. */
    pass: async () => { d.services.tracker.tick(); await d.services.tracker.settle(); },
    /** Approves the plan card, which writes the steps and starts EXECUTING. */
    approvePlan: async (missionId) => {
      const card = repo.approvals.list({ missionId, statuses: ['PENDING'] }).find((a) => a.kind === 'plan');
      if (card === undefined) throw new Error(`no plan card on ${missionId}`);
      await d.services.approvals.decide(d.caller, card.id, { optionId: 'approve' });
      return repo.tasks.listByMission(missionId);
    },
    step: (taskId, status) => repo.tasks.update(taskId, { status }),
    /** A handoff that opened a pull request. */
    pullRequest: (missionId, url) => repo.artifacts.create({
      id: `art_wb_${++n}`, workspaceId: ws, missionId, taskId: null, createdByRunId: null, type: 'ChangeSet', title: 'The fix',
      contentRef: `artifacts/wb-${n}.md`, mediaType: 'text/markdown', sha256: 'c'.repeat(64), byteSize: 1, schemaVersion: 1,
      sourceRefs: [{ kind: 'github.pr', value: url }], supersedes: null, summary: 'The fix', createdAt: pipeline.clock.now(),
    }),
    /** A person's decision the mission waits on. */
    pendingCard: (missionId) => {
      const decided = repo.approvals.list({ missionId }).find((a) => a.kind === 'plan');
      return repo.approvals.create({ ...decided, id: `apr_wb_${++n}`, status: 'PENDING', selectedOptionId: null, decidedBy: null, decisionNote: null, decidedAt: null, title: 'Merge the pull request' });
    },
    /** QA verified every active criterion, then the mission completes. */
    complete: (missionId, taskId) => {
      const keys = repo.criteria.listActive(missionId).map((c) => c.key);
      repo.evaluations.createEvaluation({
        id: `evl_wb_${++n}`, missionId, taskId, runId: null, evaluatorRoleId: 'qa', verdict: 'pass', summary: 's', findings: [],
        criteriaCoverage: keys.map((key) => ({ criterionId: key, criterion: key, outcome: 'PASS', evidence: 'scripted' })),
        createdAt: pipeline.clock.now(),
      });
      repo.missions.update(missionId, { status: 'COMPLETE' });
    },
  };
};
let WD = null;
try {
  fakeW.putIssue({ summary: SAFARI, description: DONE_WHEN, state: 'Open', type: 'Task' });
  fakeW.putIssue({ summary: 'Refunds are sent twice', description: 'One click, two refunds.\n\n## Done when\n- [ ] One refund per click', state: 'Open', type: 'Task' });
  fakeW.putIssue({ summary: 'Coupon field rejects valid codes', description: 'SAVE10 is refused.\n\n## Done when\n- [ ] SAVE10 is accepted', state: 'Open', type: 'Task' });
  WD = await pipeline.open({ home: wbHome(), settings: pipeline.app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [pipeline.Y.youtrackIntegrationModule] });
  const ws = await pipeline.configureYouTrack(WD, fakeW.url);
  WD.container.resolve(pipeline.app.PERSON_REPOSITORY).update(WD.caller.personId, { displayName: 'Demo' });
  const tracker = WD.services.tracker;
  const w = driver(WD, ws);
  const activity = (key) => (fakeW.comments.get(key) ?? []).filter((c) => c.text.startsWith(ACTIVITY));
  const edits = () => fakeW.calls.filter((c) => c.method === 'POST' && /^\/api\/issues\/GAR-1\/comments\/[^/]+$/.test(c.path)).length;
  await tracker.refreshBoard(ws);

  const mission = await tracker.start(WD.caller, ws, 'GAR-1');
  await tracker.settle();
  check('Start posts the activity comment derived from the mission: its first line only', activity('GAR-1').length === 1 && activity('GAR-1')[0].text === `${ACTIVITY}\n\nStarted in Tandemise by Demo: ${SAFARI}.`, activity('GAR-1'));

  // 1. The plan is approved and its steps written; one done, the next running.
  const steps = await w.approvePlan(mission.id);
  check('the plan card was approved and wrote at least two steps', steps.length >= 2 && w.repo.missions.get(mission.id)?.status === 'EXECUTING', { steps: steps.map((s) => s.title), status: w.repo.missions.get(mission.id)?.status });
  w.step(steps[0].id, 'SUCCEEDED');
  w.step(steps[1].id, 'RUNNING');
  await w.pass();
  check('within a minute of the last write the comment is not edited yet', edits() === 0 && !activity('GAR-1')[0].text.includes('Plan:'), activity('GAR-1')[0].text);
  pipeline.advance(61_000);
  await w.pass();
  const one = activity('GAR-1');
  check(`61 s later one edit lands: "- [ ] ${steps[1].title} — running"`, edits() === 1 && one[0].text.includes(`- [x] ${steps[0].title}`) && one[0].text.includes(`- [ ] ${steps[1].title} — running`), { edits: edits(), text: one[0]?.text });
  check('…and GAR-1 still has one comment', (fakeW.comments.get('GAR-1') ?? []).length === 1, fakeW.comments.get('GAR-1'));

  // 2. Two changes within 10 s: neither lands before the minute is up; then the latest does.
  pipeline.advance(5_000);
  w.step(steps[1].id, 'AWAITING_HUMAN');
  await w.pass();
  pipeline.advance(5_000);
  w.step(steps[1].id, 'BLOCKED');
  await w.pass();
  check('two changes within 10 s of an edit: nothing is edited before 60 s', edits() === 1 && !activity('GAR-1')[0].text.includes('— held'), { edits: edits() });
  pipeline.advance(50_000);
  await w.pass();
  const latest = activity('GAR-1')[0].text;
  check('at 60 s the latest state lands, once', edits() === 2 && latest.includes(`- [ ] ${steps[1].title} — held`) && !latest.includes('waiting for a person'), { edits: edits(), latest });
  pipeline.advance(61_000);
  await w.pass();
  check('a pass with nothing new edits nothing', edits() === 2, edits());

  // 3. A pull request waiting on a person → In Review.
  w.step(steps[1].id, 'SUCCEEDED');
  w.pullRequest(mission.id, 'https://github.com/acme/web/pull/7');
  const card = w.pendingCard(mission.id);
  pipeline.advance(61_000);
  await w.pass();
  check("a pull request plus a pending approval moves GAR-1 to 'In Review'", fakeW.issues.get('GAR-1')?.state === 'In Review' && WD.items.byKey(ws, 'GAR-1')?.writtenState === 'In Review', { state: fakeW.issues.get('GAR-1')?.state, written: WD.items.byKey(ws, 'GAR-1')?.writtenState });
  check('…and the comment links it', activity('GAR-1')[0].text.includes('\n\nPull request: https://github.com/acme/web/pull/7'), activity('GAR-1')[0].text);

  // 3b. The ship step's pull request (#53) is no handoff link, only a ship.pr_opened event: it counts too.
  fakeW.putIssue({ summary: 'Typo in the settings title', description: 'Settigns.\n\n## Done when\n- [ ] Settings', state: 'Open', type: 'Task' });
  const typo = await tracker.start(WD.caller, ws, 'GAR-4');
  await tracker.settle();
  const typoSteps = await w.approvePlan(typo.id);
  WD.container.resolve(pipeline.app.EVENT_RECORDER).record({ workspaceId: ws, missionId: typo.id, taskId: typoSteps[0]?.id ?? null }, { type: 'ship.pr_opened', repo: 'acme/web', number: 12, url: 'https://github.com/acme/web/pull/12', headSha: 'a'.repeat(40) });
  w.pendingCard(typo.id);
  pipeline.advance(61_000);
  await w.pass();
  check("the ship step's pull request plus a pending approval moves GAR-4 to 'In Review'", fakeW.issues.get('GAR-4')?.state === 'In Review', fakeW.issues.get('GAR-4')?.state);
  check('…and its activity comment links that pull request', activity('GAR-4')[0]?.text.includes('Pull request: https://github.com/acme/web/pull/12') === true, activity('GAR-4')[0]?.text);

  // 4. COMPLETE → onComplete (In Review), with the criteria table.
  w.repo.approvals.update(card.id, { status: 'APPROVED', selectedOptionId: card.options[0]?.id ?? null, decidedAt: pipeline.clock.now() });
  w.complete(mission.id, steps[1].id);
  pipeline.advance(61_000);
  await w.pass();
  const done = activity('GAR-1')[0].text;
  check("COMPLETE leaves GAR-1 in 'In Review' (onComplete) and never moves it back", fakeW.issues.get('GAR-1')?.state === 'In Review', fakeW.issues.get('GAR-1')?.state);
  check("…the comment says 'Done in Tandemise — 1 of 1 criteria verified.' with the table", done.includes('\n\nDone in Tandemise — 1 of 1 criteria verified.\n\n| Key | Criterion | Result |') && /\| \S+ \| Checkout works on Safari \| Verified \|/.test(done), done);
  check('…and it is still one comment', (fakeW.comments.get('GAR-1') ?? []).length === 1);

  // 5. A person resolves GAR-3 before its mission completes: their change wins.
  const coupon = await tracker.start(WD.caller, ws, 'GAR-3');
  await tracker.settle();
  fakeW.setState('GAR-3', 'Fixed');
  const commandsBefore = fakeW.fieldSets.length;
  w.complete(coupon.id, (await w.approvePlan(coupon.id))[0].id);
  pipeline.advance(61_000);
  await w.pass();
  pipeline.advance(61_000);
  await w.pass();
  const gar3Moves = fakeW.fieldSets.slice(commandsBefore).filter((c) => c.issue === 'GAR-3' && c.fields.some((f) => f.startsWith('State=')));
  check("a person's 'Fixed' before COMPLETE: Tandemise writes no transition", fakeW.issues.get('GAR-3')?.state === 'Fixed' && gar3Moves.length === 0, { state: fakeW.issues.get('GAR-3')?.state, gar3Moves });
  check('…but the comment still follows the mission', activity('GAR-3')[0]?.text.includes('Done in Tandemise — ') === true, activity('GAR-3'));

  // 6. CANCELLED → back to the first ready state, said in the comment.
  const refunds = await tracker.start(WD.caller, ws, 'GAR-2');
  await tracker.settle();
  w.repo.missions.update(refunds.id, { status: 'CANCELLED' });
  pipeline.advance(61_000);
  await w.pass();
  check("a CANCELLED mission moves GAR-2 back to 'Open'", fakeW.issues.get('GAR-2')?.state === 'Open' && WD.items.byKey(ws, 'GAR-2')?.writtenState === 'Open', fakeW.issues.get('GAR-2')?.state);
  check("…with 'Stopped in Tandemise; moved back to Open.'", activity('GAR-2')[0]?.text.endsWith('\n\nStopped in Tandemise; moved back to Open.') === true, activity('GAR-2')[0]?.text);
  const settledCalls = fakeW.calls.length;
  pipeline.advance(61_000);
  await w.pass();
  const writes = fakeW.calls.slice(settledCalls).filter((c) => c.method === 'POST');
  check('once everything landed a pass writes nothing', writes.length === 0, writes.map((c) => c.path));
} catch (e) {
  check('the write-back section ran', false, String(e?.stack ?? e));
} finally {
  await WD?.intake?.settle?.();
  await WD?.services?.tracker?.settle?.();
  await WD?.container.dispose();
}

// 7. A tracker that cannot edit comments gets exactly three: started, pull request, completed.
try {
  const noEdits = pipeline.defineModule('youtrack-no-edits', (container) => {
    container.contribute(pipeline.I.PRIMARY_TRACKER_FACTORIES, () => ({
      kind: 'youtrack',
      create(config, credential) {
        const real = pipeline.Y.youtrackTrackerFactory.create(config, credential);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'capabilities') return { ...target.capabilities, editComments: false };
            // Every comment is a new one: this tracker has no edit.
            if (prop === 'comment') return async (ref, c) => ({ commentId: fakeN.putComment(ref.replace(/^youtrack:/, ''), { text: `${ACTIVITY}\n\n${c.body}` }).id });
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
    }), { source: 'check' });
  });
  fakeN.putIssue({ summary: SAFARI, description: DONE_WHEN, state: 'Open', type: 'Task' });
  const ND = await pipeline.open({ home: wbHome(), settings: pipeline.app.createMemorySettingsStore(), secrets: pipeline.memorySecrets(), providers: [noEdits] });
  try {
    const ws = await pipeline.configureYouTrack(ND, fakeN.url);
    const tracker = ND.services.tracker;
    const w = driver(ND, ws);
    const activity = () => (fakeN.comments.get('GAR-1') ?? []).filter((c) => c.text.startsWith(ACTIVITY));
    const mission = await tracker.start(ND.caller, ws, 'GAR-1');
    await tracker.settle();
    const steps = await w.approvePlan(mission.id);
    for (const [i, status] of [[0, 'RUNNING'], [0, 'SUCCEEDED'], [1, 'RUNNING']]) {
      w.step(steps[i].id, status);
      pipeline.advance(61_000);
      await w.pass();
    }
    check('without editable comments, step changes post nothing new', activity().length === 1, activity().map((c) => c.text));
    w.pullRequest(mission.id, 'https://github.com/acme/web/pull/9');
    pipeline.advance(61_000);
    await w.pass();
    w.step(steps[1].id, 'SUCCEEDED');
    pipeline.advance(61_000);
    await w.pass();
    w.complete(mission.id, steps[1].id);
    pipeline.advance(61_000);
    await w.pass();
    pipeline.advance(61_000);
    await w.pass();
    const texts = activity().map((c) => c.text);
    check('exactly 3 comments: started, pull request, completed', texts.length === 3 && !texts[0].includes('Pull request:') && texts[1].includes('Pull request: https://github.com/acme/web/pull/9') && !texts[1].includes('Done in Tandemise') && texts[2].includes('Done in Tandemise — 1 of 1 criteria verified.'), texts);
  } finally {
    await ND.services.tracker.settle();
    await ND.container.dispose();
  }
} catch (e) {
  check('the no-edit tracker section ran', false, String(e?.stack ?? e));
} finally {
  await fakeW.close();
  await fakeN.close();
  for (const h of wbHomes) rmSync(h, { recursive: true, force: true });
}

// ------------------------------------------------------------------ brain config
// The brain (#51) holds a linked project's tracker and sources in
// factory/tracker.yaml and factory/intake.yaml; intake reads them through the
// same IntakeConfigSource, re-validated with its own file schemas (Ruling 21).
section('config: a project linked to a brain reads its intake from the brain');
try {
  const APP = await import('@tandemise/application');
  check('the application exports the brain-aware intake source', typeof APP.LinkedIntakeConfigSource === 'function');
  const store = { data: {}, read() { return this.data; }, write(patch) { this.data = { ...this.data, ...patch }; return this.data; } };
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
  const local = new APP.LocalIntakeConfigSource({ settings: store, log: quiet });
  const linked = new Set(['ws_brain']);
  const brainTracker = { kind: 'youtrack', url: 'https://acme.youtrack.cloud', project: 'GAR', board: 'project: GAR #Unresolved',
    states: { ready: ['Open'], in_progress: 'In Progress', in_review: 'In Review', done: ['Fixed'], wont_do: [] }, onComplete: 'in_review' };
  const brain = {
    originFor: (ws) => (linked.has(ws) ? 'brain' : 'local'),
    read: (ws) => ws === 'ws_brain'
      ? { tracker: brainTracker, sources: [{ id: 'sentry-web', kind: 'sentry', instance: 'acme/web', every: '10m' }, { id: 'BAD ID', kind: 'sentry', instance: 'x' }], dailyCap: 5, similarity: { link: 0.9, ask: 0.6 } }
      : { tracker: null, sources: [], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } },
  };
  const src = new APP.LinkedIntakeConfigSource({ local, brain, log: quiet });
  local.write('ws_local', { tracker: { ...brainTracker, project: 'LOC' } });
  check('an unlinked project reads the local settings', src.read('ws_local').tracker?.project === 'LOC' && src.originFor('ws_local') === 'local');
  const fromBrain = src.read('ws_brain');
  check("a linked project reads the brain's tracker", src.originFor('ws_brain') === 'brain' && fromBrain.tracker?.project === 'GAR' && fromBrain.dailyCap === 5 && fromBrain.similarity.link === 0.9, fromBrain);
  check("a brain source that fails intake's schema is dropped, the valid one kept", eq(fromBrain.sources.map((s) => s.id), ['sentry-web']), fromBrain.sources);
  let refused = null;
  try { src.write('ws_brain', { tracker: null }); } catch (e) { refused = e; }
  check("writing a linked project's intake is refused: Set in this project's brain.", refused?.code === 'CONFLICT' && refused?.message === "Set in this project's brain.", refused?.message);
  check('writing an unlinked project still saves locally', src.write('ws_local', { tracker: null }).tracker === null);
  const noBrain = new APP.LinkedIntakeConfigSource({ local, brain: null, log: quiet });
  check('with no brain module, every project is local', noBrain.originFor('ws_brain') === 'local' && noBrain.read('ws_brain').tracker === null);
} catch (e) {
  check('the brain config section ran', false, String(e?.stack ?? e));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
