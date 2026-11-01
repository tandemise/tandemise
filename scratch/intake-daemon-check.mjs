// Intake over the wire (spec 2026-10-30-intake-design.md §2, plan Task 3):
// a real daemon from `dist`, a fresh TANDEMISE_HOME and TANDEMISE_OFFLINE=1.
// Custom runners push with an intake token that opens exactly one source's
// push route and nothing else, and the `tandemise` CLI pushes with the
// daemon's own connection file. Task 11: a source's secrets and the tracker's
// token saved over the API, and the opt-in webhook listener the local
// settings switch on.
//
//   npm run build && node scratch/intake-daemon-check.mjs
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeYouTrack } from './fake-youtrack.mjs';
import { startFakeSentry } from './fake-sentry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

/** Runs the CLI as its own process, asynchronously, so the in-process daemon keeps answering. */
const cli = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [join(repo, 'apps/daemon/dist/cli.js'), ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
  });
});

section('daemon: intake config, tokens, pushes and the CLI');
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-intake-'));
  const home = join(root, 'h');
  process.env.TANDEMISE_OFFLINE = '1';
  delete process.env.TANDEMISE_CLOCK_OFFSET_MS;
  delete process.env.TANDEMISE_INTAKE_TOKEN;
  delete process.env.TANDEMISE_URL;
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  let fake;
  try {
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const call = async (method, path, body, bearer = token) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const signal = (over = {}) => ({
      schema: 'tandemise.intake/v1', source: { kind: 'custom', instance: 'custom-feed' }, key: 'h1',
      url: 'https://feed.test/h1', title: 'Pushed over HTTP', ...over,
    });

    const ws = (await call('POST', '/v1/workspaces', { name: 'Intake' })).body?.workspace?.id;
    check('a project exists', typeof ws === 'string', ws);

    // 6. The versions this daemon accepts.
    const schema = await call('GET', '/v1/intake/schema');
    check('GET /v1/intake/schema answers the accepted versions', schema.status === 200 && JSON.stringify(schema.body) === JSON.stringify({ accepted: ['tandemise.intake/v1'] }), schema);

    // With no tracker, a push is refused before anything is recorded.
    const early = await call('POST', `/v1/intake/signals?workspace=${ws}&source=custom-feed`, signal());
    check("a push with no tracker is 409: Set this project's tracker first.", early.status === 409 && early.body?.error?.message === "Set this project's tracker first.", early);

    // 1. The local config: a youtrack tracker and two custom sources.
    const config = {
      tracker: {
        kind: 'youtrack', url: 'https://yt.test', project: 'GAR', board: 'project: GAR #Unresolved',
        states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
      },
      intake: { sources: [{ id: 'custom-feed', kind: 'custom', instance: 'custom-feed' }, { id: 'other-feed', kind: 'custom', instance: 'other-feed' }] },
    };
    const put = await call('PUT', `/v1/workspaces/${ws}/intake/config`, config);
    check('PUT intake/config stores the tracker and sources', put.status === 200 && put.body?.origin === 'local' && put.body?.tracker?.project === 'GAR' && put.body?.sources?.length === 2 && put.body?.dailyCap === 20, put);
    const got = await call('GET', `/v1/workspaces/${ws}/intake/config`);
    check('GET intake/config reads it back', got.status === 200 && got.body?.sources?.[1]?.id === 'other-feed', got);
    const badPut = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...config.tracker, url: undefined } });
    check('PUT intake/config refuses a youtrack tracker with no url (400)', badPut.status === 400, badPut);
    // Ruling 22: whether each source runs on this machine, and the switch.
    check('GET intake/config says each local source is on here', got.body?.enabled?.['custom-feed'] === true && got.body?.enabled?.['other-feed'] === true, got.body?.enabled);
    const off = await call('PUT', `/v1/workspaces/${ws}/intake/sources/other-feed/enabled`, { enabled: false });
    check('PUT intake/sources/:sourceId/enabled switches it off here, answering the config view', off.status === 200 && off.body?.enabled?.['other-feed'] === false && off.body?.enabled?.['custom-feed'] === true, off);
    const offUnknown = await call('PUT', `/v1/workspaces/${ws}/intake/sources/nope/enabled`, { enabled: true });
    check('…an unknown source is a 404, and a bad body a 400', offUnknown.status === 404 && (await call('PUT', `/v1/workspaces/${ws}/intake/sources/other-feed/enabled`, { enabled: 'yes' })).status === 400, offUnknown);
    await call('PUT', `/v1/workspaces/${ws}/intake/sources/other-feed/enabled`, { enabled: true });

    // 2. A token for one source, shown once.
    const minted = await call('POST', `/v1/workspaces/${ws}/intake/tokens`, { sourceId: 'custom-feed' });
    const intakeToken = minted.body?.token;
    check('POST intake/tokens answers a tdi_ token, once', minted.status === 200 && typeof intakeToken === 'string' && intakeToken.startsWith('tdi_') && typeof minted.body?.id === 'string', minted);

    // 3. The token pushes to its source.
    const pushed = await call('POST', '/v1/intake/signals', signal(), intakeToken);
    check('POST /v1/intake/signals with the token is 202, received', pushed.status === 202 && pushed.body?.results?.[0]?.status === 'received' && pushed.body.results[0].fingerprint === 'custom:custom-feed:h1', pushed);
    const batch = await call('POST', '/v1/intake/signals', { signals: [signal({ key: 'h2' }), signal({ key: 'h3', priority: 'high' })] }, intakeToken);
    check('a batch answers one result per signal; a bad one is rejected, not the batch', batch.status === 202 && batch.body?.results?.length === 2 && batch.body.results[0].status === 'received' && batch.body.results[1].status === 'rejected' && batch.body.results[1].reason.includes('priority'), batch);

    // 4. ...and to no other.
    const sentence = "This token can only push to 'custom-feed'.";
    const viaQuery = await call('POST', '/v1/intake/signals?source=other-feed', signal(), intakeToken);
    check('the token with ?source=other-feed is 403 with the sentence', viaQuery.status === 403 && viaQuery.body?.error?.message === sentence, viaQuery);
    const viaBody = await call('POST', '/v1/intake/signals', signal({ source: { kind: 'custom', instance: 'other-feed' } }), intakeToken);
    check('the token with a body for another source is 403 with the sentence', viaBody.status === 403 && viaBody.body?.error?.message === sentence, viaBody);

    // 5. An intake token opens nothing else; a random token opens nothing at all.
    const elsewhere = await call('GET', '/v1/workspaces', undefined, intakeToken);
    check('the intake token on /v1/workspaces is 403', elsewhere.status === 403 && elsewhere.body?.error?.message === 'Missing or invalid daemon token.', elsewhere);
    const random = await call('GET', '/v1/workspaces', undefined, 'tdi_' + 'z'.repeat(32));
    check('a random token on /v1/workspaces is 403: Missing or invalid daemon token.', random.status === 403 && random.body?.error?.message === 'Missing or invalid daemon token.', random);
    const randomPush = await call('POST', '/v1/intake/signals', signal(), 'tdi_' + 'z'.repeat(32));
    check('a random token on the push route is 403', randomPush.status === 403, randomPush);

    // The daemon token pushes for a named project and source.
    const own = await call('POST', `/v1/intake/signals?workspace=${ws}&source=other-feed`, signal({ source: { kind: 'custom', instance: 'other-feed' }, key: 'o1' }));
    check('the daemon token pushes with ?workspace=&source=', own.status === 202 && own.body?.results?.[0]?.fingerprint === 'custom:other-feed:o1', own);
    const unnamed = await call('POST', '/v1/intake/signals', signal());
    check('the daemon token without ?workspace=&source= is 400', unnamed.status === 400, unnamed);

    // A revoked token stops working at once.
    const spare = await call('POST', `/v1/workspaces/${ws}/intake/tokens`, { sourceId: 'custom-feed' });
    const revoked = await call('DELETE', `/v1/intake/tokens/${spare.body?.id}`);
    const afterRevoke = await call('POST', '/v1/intake/signals', signal(), spare.body?.token);
    check('DELETE intake/tokens/:id revokes the token', revoked.status === 204 && afterRevoke.status === 403, { revoked, afterRevoke });

    // 7. The CLI, through daemon.json.
    const env = { TANDEMISE_HOME: home };
    const run = await cli(['intake', 'push', '--source', 'custom-feed', '--title', 'T', '--url', 'https://x.test/1', '--key', 'k1'], env);
    check('tandemise intake push exits 0 and prints <fingerprint>: <status>', run.code === 0 && run.stdout.trim() === 'custom:custom-feed:k1: received', run);
    const listed = await call('GET', `/v1/workspaces/${ws}/intake/signals`);
    check('the pushed signal is listed', listed.status === 200 && listed.body?.some((s) => s.fingerprint === 'custom:custom-feed:k1' && s.status === 'received'), listed);
    const rejectedOnly = await call('GET', `/v1/workspaces/${ws}/intake/signals?status=rejected`);
    check('the list filters by status', rejectedOnly.status === 200 && rejectedOnly.body?.length === 1 && rejectedOnly.body[0].fingerprint === 'custom:custom-feed:h3', rejectedOnly);

    // The CLI with an intake token from the environment, and its refusals.
    const withToken = await cli(['intake', 'push', '--source', 'custom-feed', '--title', 'T2', '--url', 'https://x.test/2', '--key', 'k2'], { TANDEMISE_HOME: join(root, 'nowhere'), TANDEMISE_URL: daemon.url, TANDEMISE_INTAKE_TOKEN: intakeToken });
    check('the CLI pushes with TANDEMISE_URL and TANDEMISE_INTAKE_TOKEN', withToken.code === 0 && withToken.stdout.trim() === 'custom:custom-feed:k2: received', withToken);
    const refused = await cli(['intake', 'push', '--source', 'other-feed', '--title', 'T', '--url', 'https://x.test/3', '--key', 'k3'], { TANDEMISE_HOME: join(root, 'nowhere'), TANDEMISE_URL: daemon.url, TANDEMISE_INTAKE_TOKEN: intakeToken });
    check("a refusal exits 1 with the daemon's words", refused.code === 1 && refused.stderr.includes(sentence), refused);
    const usage = await cli(['intake', 'push', '--title', 'T'], env);
    check('a usage error exits 2', usage.code === 2, usage);
    await call('POST', '/v1/workspaces', { name: 'Second' });
    const ambiguous = await cli(['intake', 'push', '--source', 'custom-feed', '--title', 'T', '--url', 'https://x.test/1', '--key', 'k1'], env);
    check('with two projects and no --project: exit 2, Name the project with --project.', ambiguous.code === 2 && ambiguous.stderr.includes('Name the project with --project.'), ambiguous);
    const named = await cli(['intake', 'push', '--project', ws, '--source', 'custom-feed', '--title', 'T', '--url', 'https://x.test/1', '--key', 'k1'], env);
    // k1 was pushed before: since Task 7 its answer carries why it still waits (this daemon has no YouTrack token).
    check('--project names it', named.code === 0 && named.stdout.split('\n')[0] === 'custom:custom-feed:k1: received'
      && /^ {2}Couldn't reach YouTrack: .* Tandemise will try again\.$/.test(named.stdout.split('\n')[1] ?? ''), named);

    // 8. `tandemise start <key>` (plan Task 8), against a fake YouTrack.
    fake = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
    fake.putIssue({ summary: 'Checkout fails on Safari', description: '## Done when\n- [ ] Checkout works on Safari', state: 'Open' });
    const app = await import('@tandemise/application');
    const toFake = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...config.tracker, url: fake.url } });
    check('the project now points at the fake YouTrack', toFake.status === 200 && toFake.body?.tracker?.url === fake.url, toFake);
    // Saved after the URL is set, so the token is bound to the fake's address (Ruling 23).
    await daemon.container.resolve(app.TRACKER_RESOLVER).saveCredential(ws, 'perm:test');
    const refreshed = await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    check('POST board/refresh answers the board with GAR-1 ready', refreshed.status === 200 && refreshed.body?.trackerLabel === 'YouTrack' && refreshed.body?.groups?.ready?.some((i) => i.key === 'GAR-1' && i.startable.ok === true), refreshed);
    const boardRead = await call('GET', `/v1/workspaces/${ws}/board`);
    check('GET board reads the cache', boardRead.status === 200 && boardRead.body?.groups?.ready?.some((i) => i.key === 'GAR-1'), boardRead);
    const started = await cli(['start', 'GAR-1', '--project', ws], env);
    check('tandemise start GAR-1 prints Started GAR-1: <mission title>', started.code === 0 && started.stdout.trim() === 'Started GAR-1: Checkout fails on Safari', started);
    check('…and YouTrack shows GAR-1 In Progress', fake.issues.get('GAR-1')?.state === 'In Progress', fake.issues.get('GAR-1')?.state);
    const startedAgain = await cli(['start', 'GAR-1', '--project', ws], env);
    check("a second start exits 1 with the daemon's words", startedAgain.code === 1 && startedAgain.stderr.trim() === 'GAR-1 already has a mission: Checkout fails on Safari.', startedAgain);
    const viaRoute = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: 'GAR-1' });
    check('POST board/start refuses it as 409 too', viaRoute.status === 409 && viaRoute.body?.error?.message === 'GAR-1 already has a mission: Checkout fails on Safari.', viaRoute);
    // #103: the lane chosen on the Board before Start goes with the mission.
    fake.putIssue({ summary: 'Typo on the receipt', description: '## Done when\n- [ ] The receipt says "Total"', state: 'Open' });
    await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    const quick = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: 'GAR-2', lane: 'careful' });
    check('POST board/start with a lane starts the mission with it', quick.status === 200 && quick.body?.mission?.laneRequest === 'careful', quick.body?.mission ?? quick);
    const badLane = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: 'GAR-2', lane: 'fast' });
    check('a lane that is not quick or careful is a 400', badLane.status === 400, badLane);

    // #136: a container, a type the project does not build and another repository's item are on the board, not startable.
    const scoped = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...config.tracker, url: fake.url, buildTypes: ['Bug', 'Task'], repoTag: 'repo:web' } });
    check('PUT intake/config keeps buildTypes and repoTag', scoped.status === 200 && JSON.stringify(scoped.body?.tracker?.buildTypes) === '["Bug","Task"]' && scoped.body?.tracker?.repoTag === 'repo:web', scoped.body?.tracker ?? scoped);
    const badTag = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...config.tracker, url: fake.url, repoTag: 'web' } });
    check('a repoTag without a prefix is a 400', badTag.status === 400, badTag);
    const container = fake.putIssue({ summary: 'Container of the checkout work', state: 'Open', type: 'Task' });
    for (const n of [1, 2, 3, 4]) fake.putIssue({ summary: `Checkout part ${n}`, state: 'Open', type: 'Task', parent: container.idReadable });
    const spike = fake.putIssue({ summary: 'Research a faster cache', state: 'Open', type: 'Spike' });
    const elsewhereItem = fake.putIssue({ summary: 'Fix the API timeout', state: 'Open', type: 'Bug', tags: ['repo:api'] });
    const plainTask = fake.putIssue({ summary: 'Add the web footer', description: '## Done when\n- [ ] The footer shows', state: 'Open', type: 'Task', tags: ['repo:web'] });
    const scopedBoard = await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    const ready = scopedBoard.body?.groups?.ready ?? [];
    const card = (key) => ready.find((i) => i.key === key);
    check('the container shows: Has 4 subtasks. Start one of them.', card(container.idReadable)?.startable?.reason === 'Has 4 subtasks. Start one of them.', card(container.idReadable));
    check('the Spike shows: Spike: this project starts Bug and Task items.', card(spike.idReadable)?.startable?.reason === 'Spike: this project starts Bug and Task items.' && card(spike.idReadable)?.type === 'Spike', card(spike.idReadable));
    check("another repository's item shows: Belongs to another repository (repo:api).", card(elsewhereItem.idReadable)?.startable?.reason === 'Belongs to another repository (repo:api).', card(elsewhereItem.idReadable));
    check('a plain Task stays startable and carries its type', card(plainTask.idReadable)?.startable?.ok === true && card(plainTask.idReadable)?.type === 'Task', card(plainTask.idReadable));
    check('the subtasks are on the board and startable', ready.filter((i) => i.title.startsWith('Checkout part')).length === 4 && ready.filter((i) => i.title.startsWith('Checkout part')).every((i) => i.startable.ok === true));
    for (const [item, reason] of [[container, 'Has 4 subtasks. Start one of them.'], [spike, 'Spike: this project starts Bug and Task items.'], [elsewhereItem, 'Belongs to another repository (repo:api).']]) {
      const refusedStart = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: item.idReadable });
      check(`POST board/start ${item.idReadable} is 409: ${reason}`, refusedStart.status === 409 && refusedStart.body?.error?.message === reason && fake.issues.get(item.idReadable)?.state === 'Open', refusedStart);
    }
    // Read fresh: a Task that became a container since the last refresh is refused too.
    const grown = fake.putIssue({ summary: 'Grows a subtask', state: 'Open', type: 'Task' });
    await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    fake.putIssue({ summary: 'Its only part', state: 'Open', type: 'Task', parent: grown.idReadable });
    const grownStart = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: grown.idReadable });
    check('Start reads the item fresh: a new subtask refuses it (Has 1 subtask. Start it instead.)', grownStart.status === 409 && grownStart.body?.error?.message === 'Has 1 subtask. Start it instead.', grownStart);
    const plainStart = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: plainTask.idReadable });
    check('a plain Task still starts', plainStart.status === 200 && fake.issues.get(plainTask.idReadable)?.state === 'In Progress', plainStart.body?.mission ?? plainStart);
  } catch (e) {
    check('the daemon section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

section('daemon: secrets over the API and the opt-in webhook listener (plan Task 11)');
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-hooks-'));
  const home = join(root, 'h');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  let fake;
  let sentry;
  let fakeB;
  let sentryB;
  try {
    // A free port for the listener, named in the local settings before the daemon starts.
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const hookPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ intakeWebhookPort: hookPort }));

    fake = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
    sentry = await startFakeSentry({ token: 'sntrys_test', org: 'acme', project: 'web' });
    sentry.putIssue({ id: '501', title: 'TypeError: basket is null', culprit: 'basket.ts', count: '132', userCount: 41 });
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const call = async (method, path, body) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const ws = (await call('POST', '/v1/workspaces', { name: 'Hooks' })).body?.workspace?.id;
    const put = await call('PUT', `/v1/workspaces/${ws}/intake/config`, {
      tracker: {
        kind: 'youtrack', url: fake.url, project: 'GAR', board: 'project: GAR #Unresolved',
        states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
      },
      intake: { sources: [{ id: 'sentry-web', kind: 'sentry', instance: 'acme/web', api: sentry.url }] },
    });
    check('a project with a fake YouTrack and a fake Sentry source', put.status === 200, put);

    const trackerSecret = await call('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: 'perm:test' });
    check('PUT intake/tracker/secret saves the tracker token (204)', trackerSecret.status === 204, trackerSecret);
    const emptyTracker = await call('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: '' });
    check('…an empty tracker token is a 400', emptyTracker.status === 400, emptyTracker);
    const sourceSecret = await call('PUT', `/v1/workspaces/${ws}/intake/sources/sentry-web/secret`, { name: 'token', value: 'sntrys_test' });
    check('PUT intake/sources/:sourceId/secret saves the Sentry token (204)', sourceSecret.status === 204, sourceSecret);
    const unknownSource = await call('PUT', `/v1/workspaces/${ws}/intake/sources/nope/secret`, { name: 'token', value: 'x' });
    check("…for a source the project doesn't have it is 404", unknownSource.status === 404, unknownSource);
    const badName = await call('PUT', `/v1/workspaces/${ws}/intake/sources/sentry-web/secret`, { name: '../x', value: 'x' });
    check('…a secret name that is not a word is 400', badName.status === 400, badName);
    const config = await call('GET', `/v1/workspaces/${ws}/intake/config`);
    check('…and no secret is in the config', config.status === 200 && !JSON.stringify(config.body).includes('sntrys_test') && !JSON.stringify(config.body).includes('perm:test'), config);
    const settingsText = readFileSync(join(home, 'settings.json'), 'utf8');
    check('…nor in settings.json', !settingsText.includes('sntrys_test') && !settingsText.includes('perm:test'));

    const checked = await call('POST', `/v1/workspaces/${ws}/intake/check`);
    check('Check sources now reads Sentry with the saved token and files GAR-1 in YouTrack with the saved one',
      checked.status === 200 && sentry.calls.some((c) => c.authorization === 'Bearer sntrys_test')
      && fake.issues.get('GAR-1')?.summary === 'TypeError: basket is null', { status: checked.status, board: checked.body, issue: fake.issues.get('GAR-1')?.summary });

    const hookUrl = `http://127.0.0.1:${hookPort}`;
    const delivered = await fetch(`${hookUrl}/hooks/${ws}/sentry-web`, { method: 'POST', body: '{"data":{}}' });
    check('with intakeWebhookPort set, the listener answers POST /hooks/<workspace>/sentry-web with 202', delivered.status === 202, delivered.status);
    const unconfigured = await Promise.all([`${hookUrl}/hooks/sentry-web`, `${hookUrl}/hooks/${ws}/nope`].map((u) => fetch(u, { method: 'POST', body: '{}' }).then((r) => r.status)));
    check('…and 404 for the old path and for a source the project does not configure (Ruling 24)', unconfigured.every((s) => s === 404), unconfigured);
    const apiOnHook = await fetch(`${hookUrl}/v1/health`);
    check('…and serves nothing of the API (GET /v1/health is 404)', apiOnHook.status === 404, apiOnHook.status);
    check('…on its own port, not the API\'s', new URL(daemon.url).port !== String(hookPort));

    // Ruling 23: both addresses move. Neither token goes to the new host until
    // the person confirms it, through the two confirm-origin routes.
    fakeB = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
    sentryB = await startFakeSentry({ token: 'sntrys_test', org: 'acme', project: 'web' });
    sentryB.putIssue({ id: '502', title: 'ReferenceError: cart is not defined', culprit: 'cart.ts', count: '90', userCount: 12 });
    const before = (await call('GET', `/v1/workspaces/${ws}/intake/config`)).body;
    const moved = await call('PUT', `/v1/workspaces/${ws}/intake/config`, {
      tracker: { ...before.tracker, url: fakeB.url },
      intake: { sources: [{ ...before.sources[0], api: sentryB.url }] },
    });
    check('the tracker URL and the Sentry api both move', moved.status === 200, moved);
    const ytB = new URL(fakeB.url).origin;
    const snB = new URL(sentryB.url).origin;
    check('the config view names the moved addresses (originMismatch)',
      moved.body?.originMismatch?.tracker?.current === ytB && moved.body?.originMismatch?.tracker?.saved === new URL(fake.url).origin
      && moved.body?.originMismatch?.sources?.['sentry-web']?.current === snB && moved.body?.originMismatch?.sources?.['sentry-web']?.saved === new URL(sentry.url).origin, moved.body?.originMismatch);
    const board = await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    check("the board's problem is the refusal", board.body?.problem === `This project's tracker now points at ${ytB}. Confirm the new address in Settings → Intake before Tandemise sends your token there.`, board.body?.problem);
    await call('POST', `/v1/workspaces/${ws}/intake/check`);
    check('…no request carrying either token reaches the new hosts',
      !fakeB.calls.some((c) => c.authorization === 'Bearer perm:test') && !sentryB.calls.some((c) => c.authorization === 'Bearer sntrys_test'),
      { yt: fakeB.calls.length, sentry: sentryB.calls.length });
    const noSource = await call('POST', `/v1/workspaces/${ws}/intake/sources/nope/confirm-origin`);
    check('confirming a source the project does not have is 404', noSource.status === 404, noSource);
    const trackerOk = await call('POST', `/v1/workspaces/${ws}/intake/tracker/confirm-origin`);
    check('POST intake/tracker/confirm-origin answers the config view with no tracker mismatch', trackerOk.status === 200 && trackerOk.body?.originMismatch?.tracker === null, trackerOk);
    const sourceOk = await call('POST', `/v1/workspaces/${ws}/intake/sources/sentry-web/confirm-origin`);
    check('POST intake/sources/:sourceId/confirm-origin clears that source', sourceOk.status === 200 && sourceOk.body?.originMismatch?.sources?.['sentry-web'] === undefined, sourceOk);
    const after = await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    check('after confirming, the board reads the new tracker with the token', after.body?.problem === null && fakeB.calls.some((c) => c.authorization === 'Bearer perm:test'), after.body?.problem);
    await call('POST', `/v1/workspaces/${ws}/intake/check`);
    check('…and Sentry is polled at its new address with its token', sentryB.calls.some((c) => c.authorization === 'Bearer sntrys_test'));
  } catch (e) {
    check('the webhook listener section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    await fake?.close();
    await sentry?.close();
    await fakeB?.close();
    await sentryB?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

section('daemon: Refine a draft, write it back as ready, then Start it (#135)');
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-refine-'));
  const home = join(root, 'h');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  let fake;
  try {
    fake = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot', states: ['Draft', 'Open', 'In Progress', 'In Review', 'Done', "Won't fix"] });
    fake.putIssue({ idReadable: 'GAR-7', summary: 'Pay on Safari', description: 'Customers on Safari cannot pay.', state: 'Draft' });
    fake.putIssue({ idReadable: 'GAR-8', summary: 'Ready already', description: '## Done when\n- [ ] It works', state: 'Open' });
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const call = async (method, path, body) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const ws = (await call('POST', '/v1/workspaces', { name: 'Refine' })).body?.workspace?.id;
    await call('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: 'perm:test' });
    const tracker = {
      kind: 'youtrack', url: fake.url, project: 'GAR', board: 'project: GAR #Unresolved',
      states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
    };
    const noDraft = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...tracker, states: { ...tracker.states, draft: ['Drafty'] } } });
    check('a draft state YouTrack lacks is refused before it is saved', noDraft.status >= 400 && /no state 'Drafty'/.test(noDraft.body?.error?.message ?? ''), noDraft.body);
    const put = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker: { ...tracker, states: { ...tracker.states, draft: ['Draft'] } } });
    check('the mapping takes an optional draft state', put.status === 200 && JSON.stringify(put.body?.tracker?.states?.draft) === '["Draft"]', put.body?.tracker?.states);

    const board = (await call('POST', `/v1/workspaces/${ws}/board/refresh`)).body;
    const draftRow = board?.groups?.draft?.find((i) => i.key === 'GAR-7');
    check('the board has a Draft group with GAR-7: Refine offered, Start refused', draftRow?.refine?.ok === true && draftRow.refine.refinement === null
      && draftRow.startable.ok === false && draftRow.startable.reason === 'Refine it first' && !board.groups.ready.some((i) => i.key === 'GAR-7'), draftRow);
    const startDraft = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: 'GAR-7' });
    check('Start on a draft is 409: GAR-7 is a draft in YouTrack. Refine it first.', startDraft.status === 409 && startDraft.body?.error?.message === 'GAR-7 is a draft in YouTrack. Refine it first.', startDraft.body);
    const refineReady = await call('POST', `/v1/workspaces/${ws}/board/refine`, { key: 'GAR-8' });
    check('Refine on a ready item is 409', refineReady.status === 409 && /not a draft/.test(refineReady.body?.error?.message ?? ''), refineReady.body);

    const writesBefore = fake.calls.filter((c) => c.method === 'POST').length;
    const refined = await call('POST', `/v1/workspaces/${ws}/board/refine`, { key: 'GAR-7' });
    const missionId = refined.body?.mission?.id;
    check('POST board/refine makes a draft mission linked to GAR-7', refined.status === 200 && refined.body?.mission?.status === 'DRAFT' && typeof missionId === 'string', refined.body?.mission ?? refined);
    const again = await call('POST', `/v1/workspaces/${ws}/board/refine`, { key: 'GAR-7' });
    check('…a second Refine answers the same mission', again.body?.mission?.id === missionId, again.body?.mission?.id);
    // Several write-back passes (every 5 s at a 200 ms tick would be one; wait for two).
    await new Promise((r) => setTimeout(r, 6_000));
    const writesDuring = fake.calls.filter((c) => c.method === 'POST').slice(writesBefore);
    check('Refine, and the passes after it, write nothing to YouTrack', writesDuring.length === 0 && fake.issues.get('GAR-7')?.state === 'Draft'
      && (fake.comments.get('GAR-7') ?? []).length === 0, writesDuring.map((c) => c.path));

    const early = await call('POST', `/v1/workspaces/${ws}/board/ready`, { key: 'GAR-7' });
    check('Write and mark ready before anything is accepted is refused in words', early.status >= 400 && /Add at least one Done-when criterion on its mission first\./.test(early.body?.error?.message ?? ''), early.body);
    const waiting = (await call('GET', `/v1/workspaces/${ws}/board`)).body?.groups?.draft?.find((i) => i.key === 'GAR-7');
    check('the card says what is left, not ready', waiting?.refine?.refinement?.ready === false && waiting.refine.refinement.sentence === 'Add at least one Done-when criterion on its mission, then write it to YouTrack.', waiting?.refine);

    await call('POST', `/v1/missions/${missionId}/criteria`, { statement: 'Checkout completes on Safari 17' });
    const readyRow = (await call('GET', `/v1/workspaces/${ws}/board`)).body?.groups?.draft?.find((i) => i.key === 'GAR-7');
    check('with a Done-when line the card is ready to write', readyRow?.refine?.refinement?.ready === true && readyRow.refine.refinement.sentence === 'Ready to write to YouTrack: 1 Done-when line.', readyRow?.refine);
    const written = await call('POST', `/v1/workspaces/${ws}/board/ready`, { key: 'GAR-7' });
    const issue = fake.issues.get('GAR-7');
    check('POST board/ready writes the description with its Done-when section', written.status === 200
      && issue?.description === 'Customers on Safari cannot pay.\n\n## Done when\n- [ ] Checkout completes on Safari 17', issue?.description);
    check('…moves GAR-7 to Open', issue?.state === 'Open', issue?.state);
    const comments = fake.comments.get('GAR-7') ?? [];
    check('…and posts the activity comment: Refined in Tandemise by <name>: 1 Done-when line. Moved from Draft to Open.',
      comments.length === 1 && /^<!-- tandemise:activity -->\n\nRefined in Tandemise by .+: 1 Done-when line\. Moved from Draft to Open\.$/.test(comments[0].text), comments.map((c) => c.text));
    const nowReady = written.body?.groups?.ready?.find((i) => i.key === 'GAR-7');
    check('the board answered has GAR-7 ready, Start offered, its mission still the draft', nowReady?.startable?.ok === true && nowReady.mission?.id === missionId && written.body.groups.draft.length === 0, nowReady);
    await new Promise((r) => setTimeout(r, 6_000));
    check('…and no pass moves it to In Progress on its own', fake.issues.get('GAR-7')?.state === 'Open', fake.issues.get('GAR-7')?.state);

    const started = await call('POST', `/v1/workspaces/${ws}/board/start`, { key: 'GAR-7' });
    check('Start adopts the refined mission rather than making a second one', started.status === 200 && started.body?.mission?.id === missionId && started.body.mission.status !== 'DRAFT', started.body?.mission ?? started);
    check('…GAR-7 moves to In Progress', fake.issues.get('GAR-7')?.state === 'In Progress', fake.issues.get('GAR-7')?.state);
    const after = fake.comments.get('GAR-7') ?? [];
    check('…and the activity comment, edited in place, keeps the refined line on top of Started', after.length === 1
      && /^<!-- tandemise:activity -->\n\nRefined in Tandemise by .+\n\nStarted in Tandemise by /.test(after[0].text), after.map((c) => c.text));
    const missions = (await call('GET', `/v1/missions?workspaceId=${ws}`)).body;
    const list = Array.isArray(missions) ? missions : missions?.missions ?? [];
    check('one mission for GAR-7', list.filter((s) => (s.mission ?? s).title === 'Pay on Safari').length === 1, list.length);

    // #185: the write-back only adds. An item with its own Acceptance criteria, and one with its own Done when.
    const own = {
      'GAR-20': { body: 'Receipts are hard to read.\n\n## Acceptance criteria\n- AC01: The total is bold\n- AC02: The date is shown\n\n## Notes\nLeave the logo alone.\n', added: ['- AC03: The receipt prints on A4'] },
      'GAR-21': { body: 'Search is slow.\n\n## Done when\n- [ ] Results show within a second\n', added: ['- [ ] The receipt prints on A4'] },
    };
    for (const [key, item] of Object.entries(own)) {
      fake.putIssue({ idReadable: key, summary: `Own criteria ${key}`, description: item.body, state: 'Draft' });
      await call('POST', `/v1/workspaces/${ws}/board/refresh`);
      const m = (await call('POST', `/v1/workspaces/${ws}/board/refine`, { key })).body?.mission?.id;
      const view = (await call('GET', `/v1/missions/${m}/refinement`)).body;
      const fromItem = view?.criteria?.filter((c) => c.status === 'accepted') ?? [];
      check(`${key}: the item's own lines read "From ${key}", not "Added by you"`, fromItem.length > 0 && fromItem.every((c) => c.origin === 'tracker' && c.originLabel === `From ${key}`), fromItem.map((c) => [c.statement, c.origin, c.originLabel]));
      await call('POST', `/v1/missions/${m}/criteria`, { statement: 'The receipt prints on A4' });
      const done = await call('POST', `/v1/workspaces/${ws}/board/ready`, { key });
      const body = fake.issues.get(key)?.description ?? '';
      const lines = body.split('\n');
      const mine = item.body.split('\n');
      let at = 0;
      const extra = [];
      for (const l of lines) { if (at < mine.length && l === mine[at]) at++; else extra.push(l); }
      check(`${key}: every line of the item is kept byte for byte, and only the decided line was added`, done.status === 200 && at === mine.length
        && JSON.stringify(extra) === JSON.stringify(item.added), { status: done.status, extra, body });
    }
  } catch (e) {
    check('the refine section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

section("daemon: saving the tracker token clears the board's cached problem (#134)");
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-token-'));
  const home = join(root, 'h');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  let fake;
  try {
    fake = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
    fake.putIssue({ summary: 'Checkout fails on Safari', description: '## Done when\n- [ ] Checkout works on Safari', state: 'Open' });
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const call = async (method, path, body) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const until = async (cond, ms = 10_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return Boolean(await cond());
    };
    const ws = (await call('POST', '/v1/workspaces', { name: 'Token' })).body?.workspace?.id;
    const tracker = {
      kind: 'youtrack', url: fake.url, project: 'GAR', board: 'project: GAR #Unresolved',
      states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
    };
    // The order a person may take in Settings → Intake: the tracker first, the token after.
    const put = await call('PUT', `/v1/workspaces/${ws}/intake/config`, { tracker });
    check('the tracker is saved before any token', put.status === 200, put);
    const cachedProblem = await until(async () => /permanent token/.test((await call('GET', `/v1/workspaces/${ws}/board`)).body?.problem ?? ''));
    const before = (await call('GET', `/v1/workspaces/${ws}/board`)).body;
    check('without a token the board caches the "Save a YouTrack permanent token" problem', cachedProblem && before?.groups?.ready?.length === 0, before);

    const saved = await call('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: 'perm:test' });
    check('the token is saved (204)', saved.status === 204, saved);
    // No POST board/refresh: the next 2-minute tick is far away, so only the save can have read it.
    const cleared = await until(async () => {
      const board = (await call('GET', `/v1/workspaces/${ws}/board`)).body;
      return board?.problem === null && board?.groups?.ready?.some((i) => i.key === 'GAR-1');
    });
    const after = (await call('GET', `/v1/workspaces/${ws}/board`)).body;
    check('GET board answers no problem and GAR-1 ready right after the token is saved, without a refresh', cleared, after);

    // A wrong token is still said: the save reads the board again, and that read sets the problem again.
    await call('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: 'perm:wrong' });
    const wrong = await until(async () => /Couldn't reach YouTrack/.test((await call('GET', `/v1/workspaces/${ws}/board`)).body?.problem ?? ''));
    check('…and a token YouTrack refuses sets the problem again, in its own words', wrong, (await call('GET', `/v1/workspaces/${ws}/board`)).body?.problem);
  } catch (e) {
    check('the token section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

section('daemon: a custom source reads and acks its closures (plan Task 13)');
{
  const root = mkdtempSync(join(tmpdir(), 'tdi-closures-'));
  const home = join(root, 'h');
  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon;
  let fake;
  try {
    fake = await startFakeYouTrack({ project: 'GAR', token: 'perm:test', login: 'tandemise-bot' });
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    const token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const call = async (method, path, body, bearer = token) => {
      const res = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const until = async (cond, ms = 10_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return Boolean(await cond());
    };
    const ws = (await call('POST', '/v1/workspaces', { name: 'Closures' })).body?.workspace?.id;
    const put = await call('PUT', `/v1/workspaces/${ws}/intake/config`, {
      tracker: {
        kind: 'youtrack', url: fake.url, project: 'GAR', board: 'project: GAR #Unresolved',
        states: { ready: ['Open'], in_progress: 'In Progress', done: ['Done'], wont_do: ["Won't fix"] }, onComplete: 'done',
      },
      intake: { sources: [{ id: 'custom-feed', kind: 'custom', instance: 'custom-feed' }, { id: 'other-feed', kind: 'custom', instance: 'other-feed' }] },
    });
    await call('PUT', `/v1/workspaces/${ws}/intake/tracker/secret`, { value: 'perm:test' });
    check('a project with a fake YouTrack and two custom sources', put.status === 200, put);
    const minted = await call('POST', `/v1/workspaces/${ws}/intake/tokens`, { sourceId: 'custom-feed' });
    const intakeToken = minted.body?.token;
    const pushed = await call('POST', '/v1/intake/signals', {
      schema: 'tandemise.intake/v1', source: { kind: 'custom', instance: 'custom-feed' }, key: 'c1',
      url: 'https://feed.test/c1', title: 'Export to CSV drops the last row', reply: { address: 'ticket-77' },
    }, intakeToken);
    check('the custom token pushes c1', pushed.status === 202 && pushed.body?.results?.[0]?.fingerprint === 'custom:custom-feed:c1', pushed);
    const signalOf = async () => (await call('GET', `/v1/workspaces/${ws}/intake/signals`)).body?.find((s) => s.fingerprint === 'custom:custom-feed:c1');
    check('…and it lands in YouTrack as GAR-1', await until(async () => (await signalOf())?.status === 'created') && fake.issues.get('GAR-1')?.summary === 'Export to CSV drops the last row', await signalOf());

    const empty = await call('GET', '/v1/intake/closures', undefined, intakeToken);
    check('before the item is done, the feed is empty', empty.status === 200 && Array.isArray(empty.body?.closures) && empty.body.closures.length === 0, empty);
    fake.setState('GAR-1', 'Done');
    const refreshed = await call('POST', `/v1/workspaces/${ws}/board/refresh`);
    check('the item set to Done in YouTrack, then refresh', refreshed.status === 200, refreshed);

    const env = { TANDEMISE_HOME: home };
    const listed = await cli(['intake', 'closures', '--source', 'custom-feed'], env);
    const line = listed.stdout.trim().split('\n');
    const [closureId, fp, state] = (line[0] ?? '').split(' ');
    check('tandemise intake closures --source custom-feed lists one pending closure: <id> <fingerprint> <state>',
      listed.code === 0 && line.length === 1 && closureId?.startsWith('clo') && fp === 'custom:custom-feed:c1' && state === 'pending', listed);
    check('…and the signal reads closure_pending (the tick never closes a custom closure itself)', (await signalOf())?.status === 'closure_pending', await signalOf());

    const feed = await call('GET', '/v1/intake/closures', undefined, intakeToken);
    const item = feed.body?.closures?.[0];
    check('the token reads its feed: id, fingerprint, key, url, kind, item, prUrl and the reply address',
      feed.status === 200 && feed.body?.closures?.length === 1 && item?.id === closureId && item?.fingerprint === 'custom:custom-feed:c1' && item?.key === 'c1'
      && item?.url === 'https://feed.test/c1' && item?.kind === 'done' && item?.item?.key === 'GAR-1' && typeof item?.item?.url === 'string'
      && item?.prUrl === null && item?.reply?.address === 'ticket-77' && item?.state === 'pending', feed);
    const after = await call('GET', `/v1/intake/closures?after=${closureId}`, undefined, intakeToken);
    check('…after=<id> answers what came after it', after.status === 200 && after.body?.closures?.length === 0, after);
    const otherFeed = await call('GET', '/v1/intake/closures?sourceId=other-feed', undefined, intakeToken);
    check("…another source's feed is refused (403)", otherFeed.status === 403, otherFeed);
    const noProject = await call('GET', '/v1/intake/closures?sourceId=custom-feed');
    check('the daemon token without ?workspace= is 400', noProject.status === 400, noProject);
    const otherToken = (await call('POST', `/v1/workspaces/${ws}/intake/tokens`, { sourceId: 'other-feed' })).body?.token;
    const foreignAck = await call('POST', `/v1/intake/closures/${closureId}/ack`, { ok: true }, otherToken);
    check("another source's token cannot ack it (404)", foreignAck.status === 404, foreignAck);
    const retryByToken = await call('POST', `/v1/intake/closures/${closureId}/retry`, undefined, intakeToken);
    check('an intake token cannot reach retry (403)', retryByToken.status === 403, retryByToken);

    const acked = await cli(['intake', 'closures', '--source', 'custom-feed', '--ack', closureId], env);
    check('tandemise intake closures --ack <id> marks it closed', acked.code === 0 && acked.stdout.trim() === `${closureId} custom:custom-feed:c1 closed`, acked);
    check('…and the signal shows closed', (await signalOf())?.status === 'closed', await signalOf());
    const relisted = await cli(['intake', 'closures', '--source', 'custom-feed'], env);
    check('…the list says closed', relisted.code === 0 && relisted.stdout.trim() === `${closureId} custom:custom-feed:c1 closed`, relisted);
    const usage = await cli(['intake', 'closures', '--source', 'custom-feed', '--error', 'nope'], env);
    check('--error without --ack is a usage error (2)', usage.code === 2, usage);
  } catch (e) {
    check('the closures section ran', false, String(e?.stack ?? e));
  } finally {
    await daemon?.stop();
    await fake?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
