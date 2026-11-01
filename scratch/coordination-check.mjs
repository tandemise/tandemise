// The optional relay's shared pieces: the wire contract, the coordination
// schema and rules, the store, the mailbox and the local mode
// (docs/superpowers/specs/2026-10-30-relay-design.md).
//
//   npm run build && node scratch/coordination-check.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const R = await import('../packages/api-contract/dist/relay.js');

section('contract');
{
  check('RELAY_API_VERSION is 1', R.RELAY_API_VERSION === '1');
  check('the relay api header', R.RELAY_API_HEADER === 'x-tandemise-relay-api');
  check('a pull of 51 is refused', R.mailboxPullRequest.safeParse({ project: 'p', max: 51, leaseSeconds: 10 }).success === false);
  check('a pull of 50 passes', R.mailboxPullRequest.safeParse({ project: 'p', max: 50, leaseSeconds: 10 }).success === true);
  check('a watch frame parses', R.relayClientFrame.safeParse({ type: 'watch', projects: ['a'] }).success === true);
  check('a chat frame does not', R.relayClientFrame.safeParse({ type: 'chat' }).success === false);
  check('an invite for 31 days is refused', R.createInviteRequest.safeParse({ role: 'member', displayName: 'Bo', expiresInDays: 31 }).success === false);
}

const C = await import('../packages/coordination/dist/index.js');
const Database = (await import('better-sqlite3')).default;
const tmp = mkdtempSync(join(tmpdir(), 'tdm-coord-'));
let dbn = 0;
const openDb = () => {
  const db = new Database(join(tmp, `c${++dbn}.db`));
  db.pragma('journal_mode = WAL');
  return db;
};
const H = 3_600_000;

section('rules');
{
  check('github refs lowercase the repo', C.itemKey(C.githubItemRef('Acme/App', 7)) === 'acme/app#7', C.githubItemRef('Acme/App', 7));
  check('a youtrack key keeps its case', C.itemKey('youtrack:ACME-123') === 'ACME-123');
  check('normalising lowercases the tracker only', C.normalizeItemRef(' YouTrack:ACME-1 ') === 'youtrack:ACME-1');
  let threw = null;
  try { C.normalizeItemRef('nope'); } catch (e) { threw = e.message; }
  check('a ref with no tracker throws', threw === 'Not a tracker item: nope', threw);
  check('held by someone else', C.heldBySentence({ holderName: 'Ana', itemRef: 'youtrack:ACME-123', startedAt: '2026-10-30T10:42:00Z', self: false, deviceLabel: 'x', timeZone: 'UTC' }) === 'Ana is working on ACME-123 since 10:42.');
  check('held by you elsewhere', C.heldBySentence({ holderName: 'Ana', itemRef: 'youtrack:ACME-123', startedAt: '2026-10-30T10:42:00Z', self: true, deviceLabel: 'Work laptop' }) === "You're already working on this on Work laptop.");
  const now = new Date('2026-10-30T20:00:00');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const base = { holderMemberId: 'ana', holderName: 'Ana', itemRef: 'youtrack:ACME-123', now, staleAfterMs: C.DEFAULT_STALE_AFTER_MS };
  const member = { memberId: 'bo', role: 'member' };
  const fresh = C.takeOverRefusal({ ...base, actor: member, holderLastSeenAt: ago(H) });
  check('a member may not take over a fresh claim', fresh === 'Only an admin can take over ACME-123 while Ana is around. Anyone can once Ana has been away for 24 hours.', fresh);
  check('a member may take over a stale one', C.takeOverRefusal({ ...base, actor: member, holderLastSeenAt: ago(25 * H) }) === null);
  check('an admin may take over a fresh one', C.takeOverRefusal({ ...base, actor: { memberId: 'cy', role: 'admin' }, holderLastSeenAt: ago(H) }) === null);
  check('nobody takes over their own', C.takeOverRefusal({ ...base, actor: { memberId: 'ana', role: 'admin' }, holderLastSeenAt: ago(H) }) === 'This is already yours.');
  check('never seen', C.lastSeenLabel(null, now) === 'never seen');
  check('minutes ago', C.lastSeenLabel(ago(5 * 60_000), now) === 'last seen 5 minutes ago', C.lastSeenLabel(ago(5 * 60_000), now));
  check('yesterday', C.lastSeenLabel(ago(30 * H), now) === 'last seen yesterday', C.lastSeenLabel(ago(30 * H), now));
  check('days ago', C.lastSeenLabel(ago(72 * H), now) === 'last seen 3 days ago', C.lastSeenLabel(ago(72 * H), now));
  check('the most present device wins', C.presenceOf([{ deviceId: 'a', memberId: 'm', status: 'away', lastSeenAt: '' }, { deviceId: 'b', memberId: 'm', status: 'online', lastSeenAt: '' }], 'm') === 'online');
  check('no device is offline', C.presenceOf([], 'm') === 'offline');
  const t1 = C.newDeviceToken();
  check('device token format', /^trd_[A-Za-z0-9_-]{43}$/.test(t1), t1);
  check('two tokens differ', t1 !== C.newDeviceToken());
  const code = C.newInviteCode();
  check('invite code format (128 bits)', /^TRI-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{6}$/.test(code), code);
  check('a pasted code is normalised', C.normalizeInviteCode(` ${code.toLowerCase()} `) === code);
  check('slug is 128-bit base64url', /^[A-Za-z0-9_-]{22}$/.test(C.newSlug()));
  check('hash compare', C.safeEqualHex(C.hashSecret('x'), C.hashSecret('x')) && !C.safeEqualHex(C.hashSecret('x'), C.hashSecret('y')));
  const db = openDb();
  const first = C.migrateCoordination(db);
  const second = C.migrateCoordination(db);
  check('migrations run once', first.from === 0 && first.to === 1 && second.from === 1 && second.to === 1, { first, second });
  check('the version is recorded', db.prepare(`SELECT value FROM coord_meta WHERE key='schema_version'`).get().value === '1');
}

const clockAt = (iso) => {
  let t = Date.parse(iso);
  const clock = () => new Date(t);
  clock.advance = (ms) => { t += ms; };
  return clock;
};
const reasonOf = (fn) => { try { fn(); return null; } catch (e) { return e.reason ?? e.message; } };

section('store');
{
  const db = openDb();
  C.migrateCoordination(db);
  const clock = clockAt('2026-10-30T10:00:00Z');
  const s = new C.CoordinationStore(db, clock);
  const team = s.ensureTeam('Team');
  check('ensureTeam is idempotent', s.ensureTeam('Other').id === team.id && s.team().name === 'Team');
  const adminInvite = s.createInvite({ role: 'admin', displayName: 'Ana', createdBy: null });
  const ana = s.redeemInvite({ code: adminInvite.code, displayName: 'Ana', deviceLabel: 'Ana laptop' });
  check('an admin invite redeems', ana.deviceToken.startsWith('trd_') && s.member(ana.memberId).role === 'admin');
  check('a second redeem is refused', reasonOf(() => s.redeemInvite({ code: adminInvite.code, displayName: 'X', deviceLabel: 'x' })) === 'invite_used');
  const late = s.createInvite({ role: 'member', displayName: 'Late', createdBy: ana.memberId });
  clock.advance(8 * 24 * H);
  check('an expired invite is refused', reasonOf(() => s.redeemInvite({ code: late.code, displayName: 'L', deviceLabel: 'l' })) === 'invite_expired');
  check('a garbage code is refused', reasonOf(() => s.redeemInvite({ code: 'TRI-NOPE', displayName: 'L', deviceLabel: 'l' })) === 'invite_invalid');
  const bo = s.redeemInvite({ code: s.createInvite({ role: 'member', displayName: 'Bo', createdBy: ana.memberId }).code, displayName: 'Bo', deviceLabel: 'Bo desktop' });
  const anaAuth = s.deviceByToken(ana.deviceToken);
  check('a token finds its device', anaAuth?.id === ana.deviceId && anaAuth.role === 'admin', anaAuth);
  check('a wrong token finds nothing', s.deviceByToken('trd_nope') === null);
  const seq0 = s.seq();
  const item = { projectKey: 'p', itemRef: 'github:Acme/App#7', itemTitle: 'Fix it', itemUrl: 'https://github.com/acme/app/issues/7' };
  const a1 = s.claim({ ...item, localRef: 'm_a', memberId: ana.memberId, deviceId: ana.deviceId });
  check('the first claim wins', a1.kind === 'claimed' && a1.claim.itemRef === 'github:acme/app#7', a1);
  const seq1 = s.seq();
  const b1 = s.claim({ ...item, localRef: 'm_b', memberId: bo.memberId, deviceId: bo.deviceId });
  check('the second is held by the first, by name', b1.kind === 'held' && b1.self === false && b1.claim.memberName === 'Ana', b1);
  const anaPhone = s.createDevice(ana.memberId, 'Ana phone');
  const a2 = s.claim({ ...item, localRef: 'm_a2', memberId: ana.memberId, deviceId: anaPhone.device.id });
  check('the same person on another computer is held, self', a2.kind === 'held' && a2.self === true, a2);
  check('only the holder or an admin releases', reasonOf(() => s.release(a1.claim.id, 'released', { memberId: bo.memberId, role: 'member' })) === 'not_holder');
  const released = s.release(a1.claim.id, 'released', { memberId: ana.memberId, role: 'admin' });
  check('the holder releases', released.state === 'ended' && released.endedReason === 'released');
  const b2 = s.claim({ ...item, localRef: 'm_b', memberId: bo.memberId, deviceId: bo.deviceId });
  check('then a fresh claim succeeds', b2.kind === 'claimed', b2);
  s.touchDevice(bo.deviceId);
  check('a member may not take over a fresh claim', reasonOf(() => s.takeOver(b2.claim.id, { memberId: ana.memberId, deviceId: ana.deviceId, role: 'member', localRef: 'x' })) === 'take_over_refused');
  const taken = s.takeOver(b2.claim.id, { memberId: ana.memberId, deviceId: ana.deviceId, role: 'admin', localRef: 'm_a3' });
  const old = s.claimById(b2.claim.id);
  check('an admin takes over: old ended taken_over, by the admin', old.state === 'ended' && old.endedReason === 'taken_over' && old.endedBy === ana.memberId, old);
  check('exactly one active claim', s.activeClaims(['p']).length === 1 && s.activeClaims(['p'])[0].id === taken.id);
  clock.advance(25 * H);
  const back = s.takeOver(taken.id, { memberId: bo.memberId, deviceId: bo.deviceId, role: 'member', localRef: 'm_b2' });
  check('a member takes over a stale claim', back.memberId === bo.memberId);
  check('history lists the item\'s claims', s.claimHistory('p', 'github:acme/app#7').length === 4);
  check('claimByLocalRef', s.claimByLocalRef('m_b2')?.id === back.id);
  const seqP = s.seq();
  s.setPresence(ana.deviceId, 'online');
  check('presence is per device, member online', s.members().find((m) => m.id === ana.memberId).presence === 'online');
  const seqM = s.seq();
  check('the last admin cannot be removed', reasonOf(() => s.removeMember(ana.memberId, ana.memberId)) === 'last_admin');
  const ended = s.removeMember(bo.memberId, ana.memberId);
  check('removing a member ends their claims as removed', ended.length === 1 && ended[0].endedReason === 'removed', ended);
  check('and revokes their devices', s.devices(bo.memberId).every((d) => d.revokedAt !== null) && s.deviceByToken(bo.deviceToken)?.revokedAt);
  check('seq strictly increases across claim, presence and member writes', seq0 < seq1 && seq1 < seqP && seqP < seqM && seqM < s.seq(), [seq0, seq1, seqP, seqM, s.seq()]);
}

const freshStore = (iso = '2026-10-30T10:00:00Z') => {
  const db = openDb();
  C.migrateCoordination(db);
  const clock = clockAt(iso);
  const s = new C.CoordinationStore(db, clock);
  s.ensureTeam('Team');
  s.hooksBase = 'https://relay.example.com';
  return { db, clock, s };
};
const req = (body, headers = {}) => ({ method: 'POST', query: '', headers: C.filterWebhookHeaders(headers), contentType: 'application/json', body: Buffer.from(body) });

section('mailbox');
{
  const { s, clock } = freshStore();
  const ep = s.createEndpoint({ projectKey: 'p', name: 'Sentry', source: 'sentry', handshake: 'none', createdBy: null });
  check('an endpoint has a public URL', ep.url === `https://relay.example.com/hooks/${ep.slug}`, ep.url);
  const headers = C.filterWebhookHeaders({ cookie: 'a', authorization: 'b', 'sentry-hook-signature': 's', 'x-forwarded-for': '1', connection: 'close' });
  check('cookies, credentials and hop-by-hop headers are dropped; signatures kept', JSON.stringify(Object.keys(headers).sort()) === JSON.stringify(['sentry-hook-signature', 'x-forwarded-for']), headers);
  const m1 = s.storeRequest(ep.id, req('{"x":1}', { 'sentry-hook-signature': 's' })).id;
  const a = s.pull('p', 'A', 10, 30);
  check('device A leases the message', a.length === 1 && a[0].id === m1 && Buffer.from(a[0].bodyBase64, 'base64').toString() === '{"x":1}');
  check('device B gets nothing while A holds it', s.pull('p', 'B', 10, 30).length === 0);
  clock.advance(31_000);
  const b = s.pull('p', 'B', 10, 30);
  check('after the lease, B gets it, second attempt', b.length === 1 && b[0].attempts === 2, b);
  const ackA = s.ack([m1], 'A');
  check('A\'s ack of a lost lease is ignored', ackA.ignored[0] === m1 && ackA.acked.length === 0, ackA);
  const ackB = s.ack([m1], 'B');
  check('B\'s ack lands', ackB.acked[0] === m1, ackB);
  check('and the body is gone', s.db.prepare('SELECT body, body_bytes FROM coord_mailbox WHERE id = ?').get(Number(m1)).body === null);
  const m2 = s.storeRequest(ep.id, req('{"y":2}')).id;
  for (let i = 0; i < 10; i++) { s.pull('p', 'A', 10, 1); clock.advance(2000); }
  check('the 11th pull parks it', s.pull('p', 'A', 10, 1).length === 0);
  check('the endpoint shows one parked', s.endpoints()[0].parked === 1, s.endpoints()[0]);
  s.retryParked(m2);
  check('retry makes it pullable again', s.pull('p', 'A', 10, 30).length === 1);
  s.ack([m2], 'A');
  // sweep
  s.storeRequest(ep.id, req('{"old":1}'));
  clock.advance(25 * H);
  let swept = C.sweep(s, C.DEFAULT_RETENTION);
  check('acked rows older than 24 h are deleted', swept.deletedAcked === 2, swept);
  clock.advance(14 * 24 * H);
  swept = C.sweep(s, C.DEFAULT_RETENTION);
  check('unacked rows older than 14 days are dropped and counted', swept.expiredUnacked === 1 && s.endpoints()[0].droppedCount === 1, { swept, ep: s.endpoints()[0] });
  // cap
  const capped = freshStore();
  capped.s.retention = { ...C.DEFAULT_RETENTION, maxMessages: 3 };
  const e2 = capped.s.createEndpoint({ projectKey: 'p', name: 'x', source: 'x', handshake: 'none', createdBy: null });
  const ids = [1, 2, 3, 4].map((n) => capped.s.storeRequest(e2.id, req(`{"n":${n}}`)).id);
  const left = capped.s.pull('p', 'A', 50, 30).map((m) => m.id);
  check('the cap drops the oldest unacked', JSON.stringify(left) === JSON.stringify(ids.slice(1)) && capped.s.endpoints()[0].dropFlag === true, { left, ids });
  // handshakes
  const q = (o) => new URLSearchParams(o);
  const hub = { handshake: 'meta_hub', handshakeSecret: 'vt' };
  const ok = C.handshakeResponse(hub, { method: 'GET', query: q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '123' }), contentType: null, body: Buffer.alloc(0) });
  check('meta hub echoes the challenge with the right token', ok?.status === 200 && ok.body === '123', ok);
  const bad = C.handshakeResponse(hub, { method: 'GET', query: q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'no', 'hub.challenge': '123' }), contentType: null, body: Buffer.alloc(0) });
  check('and refuses a wrong one', bad?.status === 403, bad);
  const echo = C.handshakeResponse({ handshake: 'echo_challenge', handshakeSecret: null }, { method: 'POST', query: q({}), contentType: 'application/json', body: Buffer.from('{"type":"url_verification","challenge":"abc"}') });
  check('echo challenge echoes', echo?.status === 200 && echo.body === 'abc', echo);
  check('none is never a handshake', C.handshakeResponse({ handshake: 'none', handshakeSecret: null }, { method: 'GET', query: q({ 'hub.mode': 'subscribe' }), contentType: null, body: Buffer.alloc(0) }) === null);
}

section('transfer');
{
  const src = freshStore();
  const ana = src.s.createMember({ displayName: 'Ana', role: 'admin' });
  const dev = src.s.createDevice(ana.id, 'laptop').device;
  for (const n of [7, 8]) src.s.claim({ projectKey: 'p', itemRef: `github:acme/app#${n}`, itemTitle: `#${n}`, itemUrl: null, localRef: `m${n}`, memberId: ana.id, deviceId: dev.id });
  const ep = src.s.createEndpoint({ projectKey: 'p', name: 'Sentry', source: 'sentry', handshake: 'none', createdBy: ana.id });
  src.s.storeRequest(ep.id, req('{"hello":1}'));
  const lines = C.exportLines(src.s);
  check('the export starts with its meta line', JSON.parse(lines[0]).kind === 'meta' && JSON.parse(lines[0]).schemaVersion === 1);
  const dst = freshStore();
  const report = C.importLines(dst.s, lines, 'empty', null);
  const shape = (s) => s.activeClaims().map((c) => [c.itemRef, c.memberId, c.localRef, c.memberName]);
  check('active claims round-trip', JSON.stringify(shape(dst.s)) === JSON.stringify(shape(src.s)), { a: shape(src.s), b: shape(dst.s) });
  check('endpoint slugs round-trip', dst.s.endpoints()[0]?.slug === ep.slug && report.endpoints === 1);
  const body = dst.s.pull('p', 'A', 10, 30).map((m) => Buffer.from(m.bodyBase64, 'base64').toString());
  check('message bodies round-trip', JSON.stringify(body) === JSON.stringify(['{"hello":1}']) && report.messages === 1, body);
  const before = dst.s.seq();
  check('importing into a store with data is refused', reasonOf(() => C.importLines(dst.s, lines, 'empty', null)) === 'relay_not_empty');
  check('and writes nothing', dst.s.seq() === before && dst.s.endpoints().length === 1);
  const bo = dst.s.createMember({ displayName: 'Bo', role: 'member' });
  const boDev = dst.s.createDevice(bo.id, 'bo').device;
  const own = C.importLines(dst.s, lines, 'own-claims', { memberId: bo.id, deviceId: boDev.id });
  check('own-claims reports a held item with its holder', own.claims.length === 2 && own.claims.every((c) => c.result === 'held' && c.holderName === 'Ana'), own);
}

section('local');
{
  const db = openDb();
  C.migrateCoordination(db);
  const s = new C.CoordinationStore(db, clockAt('2026-10-30T10:00:00Z'));
  const l1 = new C.LocalCoordination(s, { displayName: 'Dee', deviceLabel: 'Dee laptop' });
  new C.LocalCoordination(s, { displayName: 'Dee', deviceLabel: 'Dee laptop' });
  check('constructing twice makes one member and one device', s.members().length === 1 && s.devices().length === 1, { m: s.members().length, d: s.devices().length });
  check('the local person is the admin, and online', s.members()[0].role === 'admin' && s.members()[0].presence === 'online');
  check('status is local', l1.status().kind === 'local' && l1.mode === 'local');
  const item = { projectKey: 'p', itemRef: 'github:acme/app#7', itemTitle: 'x', itemUrl: null };
  const first = await l1.claim({ ...item, localRef: 'm1' });
  const again = await l1.claim({ ...item, localRef: 'm1' });
  const second = await l1.claim({ ...item, localRef: 'm2' });
  check('claiming', first.kind === 'claimed' && again.kind === 'claimed' && again.claim.id === first.claim.id);
  check('a second mission on the same item is held by you', second.kind === 'held_by' && second.self === true && second.sentence === "You're already working on this on Dee laptop.", second);
}

section('parity');
{
  // The daemon's boot path: its own migrations, then coordination's, then the daemon-only tables.
  const P = await import('../packages/persistence/dist/index.js');
  const daemon = P.openDatabase({ path: join(tmp, 'daemon.db') });
  P.migrate(daemon);
  const first = C.migrateCoordination(daemon.handle);
  const firstDaemon = C.migrateCoordinationDaemon(daemon.handle);
  const relay = openDb();
  C.migrateCoordination(relay);
  const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const schemaOf = (db) => Object.fromEntries(db.prepare(`SELECT name, sql FROM sqlite_master WHERE name LIKE 'coord_%' OR name LIKE 'idx_coord_%'`).all().map((r) => [r.name, norm(r.sql)]));
  const d = schemaOf(daemon.handle);
  const r = schemaOf(relay);
  const shared = Object.keys(r).filter((n) => n !== 'sqlite_autoindex');
  check('every shared table exists in the daemon database', C.COORD_SHARED_TABLES.every((t) => t in d), Object.keys(d));
  const diff = shared.filter((n) => d[n] !== r[n]);
  check('and its SQL (tables and indexes) is identical to the relay\'s', diff.length === 0 && shared.length >= C.COORD_SHARED_TABLES.length, diff);
  check('the daemon boot migrates coordination once', first.from === 0 && first.to === 1 && firstDaemon.to === 1);
  check('a second boot is a no-op', JSON.stringify(C.migrateCoordination(daemon.handle)) === '{"from":1,"to":1}' && JSON.stringify(C.migrateCoordinationDaemon(daemon.handle)) === '{"from":1,"to":1}');
  check('the outbox and the claim sync are daemon-only', 'coord_outbox' in d && 'coord_claim_sync' in d && !('coord_outbox' in r) && !('coord_claim_sync' in r));
  check('the daemon\'s own migration list is untouched by coordination', !P.MIGRATIONS.some((m) => /coord_/.test(m.up ?? '') || /coord/.test(m.name)));
  daemon.close();
}

section('relay client: a sync asked for mid-sync is not lost');
{
  const CR = await import('../packages/coordination-relay/dist/index.js');
  const db = openDb();
  C.migrateCoordination(db);
  C.migrateCoordinationDaemon(db);
  const store = new C.CoordinationStore(db);
  let snapshots = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes('/snapshot')) {
      snapshots++;
      await new Promise((r) => setTimeout(r, 50));
      const body = { seq: snapshots, team: { id: 't', name: 'T' }, you: { memberId: 'm', deviceId: 'd', role: 'admin' }, members: [], devices: [], presence: [], claims: [], endpoints: [], serverTime: new Date().toISOString(), staleAfterMs: 86_400_000 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  // Port 9 refuses at once, so the stream fails fast and only the snapshots are counted.
  const rc = new CR.RelayCoordination({ store, url: 'http://127.0.0.1:9', token: async () => 'trd_x', memberId: 'm', deviceId: 'd', fetch: fakeFetch });
  await Promise.all([rc.start(), rc.start()]);
  check('a second sync requested during the first runs after it (two snapshots, not one)', snapshots === 2, snapshots);
  rc.stop();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
