# The relay: an optional, slim, self-hosted coordination server

Status: design, 2026-10-30. This is the fifth sub-project of the software-factory pivot (#56). It is tracked in #54. Background and the owner's binding decisions are in `2026-10-30-tandemise-pivot-notes.md`.

## Why

Tandemise today is one person on one machine. The daemon binds `127.0.0.1` and nothing else (`apps/daemon/src/http/server.ts`, property 1), every request acts as the single local person (`apps/daemon/src/main.ts`: `identityResolver: () => ({ personId: services.identity.localPerson().id })`), and `IdentityPort` is still marked "P4 replaces this with account-backed resolution" (`packages/application/src/support/identity.ts`).

The pivot changes the unit from a person to a team, without moving any work off people's machines. A team needs three things a single laptop can't give it:

- **Who is working on what.** Two people should not start the same tracker item without knowing it. Today this guard exists only inside one install, for person steps (`MissionService.claimTask`, `packages/application/src/services/mission-service.ts:613`: "two people doing the same work without knowing it is the failure this exists to prevent").
- **Who is on the team.** Members and their access, shared across machines.
- **A public address for webhooks.** Some sources only push (Sentry webhooks, WhatsApp Business). A laptop behind NAT has no public URL, and #52 already says those sources "need the optional server's mailbox or a tunnel".

The relay is the smallest server that provides those three things and nothing else.

## Goals

1. A team runs its own relay with `docker compose up`. One container, one SQLite file on a volume, no other services.
2. A daemon connected to a relay shows, live, who is working on which tracker item, and refuses to let a second person silently start an item someone else holds.
3. Members join with a single-use invite and get a per-device token. An admin can revoke a device.
4. A webhook source can post to the relay. The relay stores the request as received, and a team member's daemon pulls it, processes it locally, and acks it.
5. Working solo needs no relay. The same data lives in the daemon's own database, in the same tables with the same shape, and moves to a relay later with one action.
6. Losing the relay, or the network, never stops local work.

## Non-goals (this sub-project)

- **A board.** The board is the project's primary tracker (#52). The relay keeps claims and presence *on top of* tracker items. It doesn't store the backlog, states, or comments.
- **Project configuration.** Repositories, MCPs, the factory definition and memory live in the brain repo (#51). The relay doesn't store them or sync them.
- **Running anything.** No agents, no runtimes, no git, no MCP, no scheduling, no decisions. The relay runs no code on behalf of a webhook, either; it only stores the request.
- **Interpreting webhooks.** Signature checks and parsing belong to the local runner for each source (#52). The relay stores raw bytes and headers.
- **Sharing missions, runs, artifacts or terminals.** These stay on the machine that ran them. Remote terminal access from #50 is out of scope.
- **Accounts, SSO, OAuth or email.** Invites are codes that an admin hands over however the team likes.
- **A web UI on the relay.** The desktop is the UI, through the daemon. The relay ships a tiny admin CLI for bootstrapping only.
- **Packaging the desktop** (#58).

## Anti-goals (what it must never become)

- **Multi-tenant SaaS.** One instance is one team. There is no tenant column, no signup and no billing.
- **A messaging system.** No chat, no comments, no notifications text between people (pivot notes, "What it must NOT be"). Presence and claims are facts, not messages.
- **The source of truth for work.** If the relay is deleted, the team loses who-is-on-what and unread webhooks. It loses no work, no configuration and no history that matters.
- **A requirement.** No feature that works solo today may start depending on the relay.
- **Heavy.** No Postgres, Redis, queue, or background workers. If a feature needs one of those, it doesn't belong in the relay.

## Approaches considered

1. **A dedicated slim relay process (Node 22, `node:http` + `ws` + SQLite), in this monorepo as `apps/relay`** *(chosen)*.
   - It is the smallest thing that meets every goal. It needs about a dozen routes, one WebSocket, six tables.
   - It shares the wire types with the daemon at compile time, so the two can't drift.
   - It reuses what the repo already depends on: `ws` (`apps/daemon/package.json`) and `better-sqlite3` (`scripts/packages.mjs`, persistence).
   - Cost: a second deployable and a Dockerfile to maintain.
2. **Run `tandemd` itself in a "server mode"** (headless, bound to `0.0.0.0`).
   - No new process, and the data model is already there.
   - Rejected. It drags in the whole engine: runtimes, the scheduler, Playwright and native modules. It breaks the daemon's loopback-only invariant, which the server code states as non-negotiable ("There is no configuration that binds 0.0.0.0", `server.ts`). And it makes "the server runs no agents" a promise rather than a fact.
3. **No server: use the tracker and third parties.** Claims become the tracker's assignee and "In progress" state, presence is inferred from tracker activity, and webhooks go through a public forwarder (smee.io, ngrok) or a tunnel.
   - Nothing to host.
   - Rejected as *the* answer. Tracker assignee has no liveness or "since when". Each tracker has different write permissions and rate limits. Polling is slow. A public forwarder sends the team's webhooks through someone else's service. It stays available as an option: a solo person with a tunnel can point it at their own daemon's local mailbox (see "The webhook mailbox"). Writing the tracker's own "in progress" state when work starts is #52's job, and it happens in addition to a relay claim, not instead of it.

A peer-to-peer or CRDT design (no server, daemons sync with each other) was ruled out quickly. It can't give a public webhook URL, and laptops are rarely online at the same time.

## Monorepo or separate repo (my call)

**`apps/relay` in this monorepo now, built so that splitting it out into `tandemise/relay` later is mechanical.** #54's comment leaves this open.

Why the monorepo:
- It ships tonight. One CI, one `npm run ci`, one release-please version, no package publishing.
- The relay and the daemon compile against the same contract types in the same build, so a wire change that breaks one breaks the build.
- Acceptance has to start a relay and two daemons together. That's easiest when they are in the same checkout, the same way `scratch/` checks start a daemon today.

Why it stays splittable:
- **The relay imports exactly two internal modules:** `@tandemise/api-contract/relay` (wire types) and `@tandemise/coordination` (schema and rules). Nothing else: not `domain`, `application`, `persistence` or `kernel`.
- **`npm run check:boundaries` enforces this.** Today `scripts/check-boundaries.mjs` only walks `packages/*`. It gains a rule for `apps/relay/src` that allows only those two `@tandemise/*` specifiers, plus `ws`, `better-sqlite3` and `node:*`.
- **`@tandemise/api-contract/relay` is a subpath with no runtime imports except `zod`.** The `./for-me` and `./about` subpaths in `packages/api-contract/package.json` already follow this pattern.
- **The split path** (when the relay needs its own release cadence or contributors):
  1. `git filter-repo --path apps/relay --path packages/coordination` into `tandemise/relay`.
  2. Publish `@tandemise/coordination` and the contract subpath, as `@tandemise/relay-contract`, to npm from whichever repo owns them. Tandemise then depends on the published versions.
  3. The relay keeps its own `RELAY_API_VERSION` from day one, so the split doesn't change the protocol.

## Data model

One schema, owned by a new package `packages/coordination`. Every table is prefixed `coord_` so it can live inside the daemon's database without colliding. The same DDL runs in the daemon's SQLite file (solo, and as a mirror in relay mode) and in the relay's own SQLite file. That is what "the same shape" means here: not a similar schema, but the same one.

A relay instance is one team. A team has one or more **projects**. A project is identified by a `projectKey`, a stable string. Once #51 lands, the key is the brain repo's identity (for example `github.com/acme/brain`). Until then, a workspace gets a `coordination.projectKeys[workspaceId]` setting. Its default is the workspace's first repository's remote, normalised (`github.com/acme/app`), so two people's installs of one repository agree without setting anything; with no remote, it is the workspace id. The key is written to the setting on first use and kept, so a remote added or changed later never moves a workspace's claims to another project. *(Amended at build time; controller ruling.)*

| Table | Fields | Notes |
|---|---|---|
| `coord_meta` | `key`, `value` | `schema_version`, `team_id`, `team_name`, `created_at`. One team per database. |
| `coord_members` | `id`, `display_name`, `handles` (JSON), `role` (`admin`\|`member`), `status` (`active`\|`removed`), `created_at`, `updated_at` | People only. Agents are not members of the relay: an agent "acts on its owner's authority" (`packages/domain/src/entities/member.ts`), so its owner holds its claims. |
| `coord_devices` | `id`, `member_id`, `label`, `token_hash`, `created_at`, `last_seen_at`, `revoked_at` | One row per daemon install. Only the SHA-256 of the token is stored. |
| `coord_invites` | `id`, `code_hash`, `role`, `display_name`, `created_by`, `created_at`, `expires_at`, `redeemed_at`, `redeemed_by` | Single use. Expires after 7 days by default. |
| `coord_claims` | `id`, `project_key`, `item_ref`, `item_title`, `item_url`, `member_id`, `device_id`, `local_ref`, `state` (`active`\|`ended`), `ended_reason` (`done`\|`released`\|`taken_over`\|`removed`), `ended_by`, `started_at`, `ended_at`, `seq` | Unique partial index on `(project_key, item_ref) WHERE state = 'active'`. That index is the conflict rule. |
| `coord_presence` | `device_id` (PK), `member_id`, `status` (`online`\|`away`), `last_seen_at` | Not a history. One row per device, overwritten. |
| `coord_endpoints` | `id`, `project_key`, `slug`, `name`, `source` (free text, for example `sentry`), `handshake` (`none`\|`meta_hub`\|`echo_challenge`), `handshake_secret`, `created_by`, `created_at`, `disabled_at` | A webhook URL. `slug` is 128 random bits, base64url. |
| `coord_mailbox` | `id` (monotonic), `endpoint_id`, `received_at`, `method`, `query`, `headers` (JSON), `content_type`, `body` (BLOB), `lease_device`, `lease_until`, `attempts`, `acked_at`, `acked_by` | One stored request. |

Field rules:
- **`item_ref`** is a normalised tracker key: `<tracker>:<key>`, for example `youtrack:ACME-123` or `github:acme/acme#42`. Normalisation lives in `coordination` so the daemon and the relay agree. Today's GitHub issue links (`packages/persistence/src/migrations/019_issues.ts`: `github_repo`, `issue_number`) map to `github:<github_repo>#<issue_number>`. #52 adds the other trackers.
- **`local_ref`** is opaque to the relay: the daemon's mission id. It lets the holder's own daemon tie a claim back to its mission. Other members never see it resolved.
- **`seq`** is a team-wide monotonic counter, bumped on every claim, presence or member change. Clients use it to skip stale frames. It is not a change log.
- **Relay member ↔ local person.** The local `Person.handles` map ("External identities, e.g. `{ github: 'demogar', slack: 'U123' }`", `member.ts`) gains a `relay` handle: `<relay host>/<member id>`. No new column is needed on `people`. Local `AccessLevel` (`owner`/`admin`/`member`/`guest`) keeps governing what a person may do *in their own install*. The relay's two roles only govern the relay: admins invite, remove members, revoke devices and manage endpoints.

Schema versioning: `coordination` ships its own tiny migration list, which follows the same rules as `packages/persistence/src/migrations/index.ts` (append-only; a released migration is immutable). It records its version in `coord_meta.schema_version`. Both the relay and the daemon call `migrateCoordination(db)` at boot. The daemon's `MIGRATIONS` list is not touched, so the two version streams can't tangle.

## Packages and layers

| Piece | Where | Layer | Depends on | What it holds |
|---|---|---|---|---|
| Wire types | `packages/api-contract/src/relay.ts`, exported as `@tandemise/api-contract/relay` | 2 (existing) | `zod` only | Request/response shapes, stream frames, `RELAY_API_VERSION`, error codes. |
| Schema and rules | `packages/coordination` (new) | 3 | `api-contract` (relay subpath) | DDL and migrations; `CoordinationStore`, written against a minimal `SqlHandle` interface (`prepare`, `transaction`) so it never imports `better-sqlite3` itself; `itemRef` normalisation; claim, take-over and retention rules as pure functions. Not a provider package. |
| Relay client | `packages/coordination-relay` (new) | 4, provider | `coordination`, `api-contract` | HTTP via global `fetch`, WebSocket via Node 22's global `WebSocket`. Keeps the local mirror and outbox in the daemon's `coord_*` tables. |
| Port | `packages/application/src/ports.ts`, token `COORDINATION` in `tokens.ts` | 5 | | `CoordinationPort` (below). The application never learns which implementation it got. |
| Wiring | `apps/daemon/src/bootstrap.ts` | app | | Binds `COORDINATION` to the local store or the relay client, from settings. bootstrap is "the single place in Tandemise that is allowed to name a concrete provider". It hands the store the persistence `DATABASE` handle (`packages/persistence/src/tokens.ts`). |
| Relay server | `apps/relay` (new) | app | `api-contract/relay`, `coordination`, `ws`, `better-sqlite3` | HTTP + WS server, admin CLI, Dockerfile, compose file. |

`scripts/packages.mjs` gains `coordination` (L3) and `coordination-relay` (L4, added to `PROVIDER_PACKAGES`). `check-boundaries.mjs` gains the `apps/relay` allowlist described above.

## The coordination port

The application talks to one port. A sketch, not the final signature:

```ts
interface CoordinationPort {
  readonly mode: 'local' | 'relay';
  status(): CoordinationStatus;              // local | connected | offline(since, pendingOps) | refused(reason)

  claim(input: { projectKey: string; itemRef: string; itemTitle: string; itemUrl: string | null;
                 localRef: string }): Promise<ClaimResult>;   // claimed | held_by(other) | queued_offline
  release(claimId: string, reason: 'done' | 'released'): Promise<void>;
  takeOver(claimId: string): Promise<ClaimResult>;            // refused unless stale or admin (rules below)
  claims(projectKey: string): readonly ClaimView[];           // active claims, from the local copy
  members(): readonly CoordMemberView[];
  presence(): readonly PresenceView[];
  onChange(listener: (topic: 'claims' | 'members' | 'presence' | 'mailbox') => void): () => void;

  mailbox: {
    pull(projectKey: string, max: number): Promise<readonly MailboxMessage[]>;   // leased
    ack(ids: readonly string[]): Promise<void>;
  };
}
```

Reads (`claims`, `members`, `presence`) always come from the local `coord_*` tables, synchronously. They never block on the network, so UI views and the scheduler stay as fast offline as online.

### Implementation 1: local (solo)

`LocalCoordination` is a `CoordinationStore` over the daemon's own database.
- **Members.** The local person, mirrored as the only `admin`.
- **Claims.** Enforced by the same unique index. This still matters solo: it keeps one person from starting the same tracker item twice from two missions.
- **Presence.** Just "you".
- **Mailbox.** Real, but fed only by local senders: a runner pushing over the daemon's HTTP API (#52), or a tunnel the person set up to their own daemon. Nothing is exposed by default, and the daemon stays loopback-only.

### Implementation 2: relay client

`RelayCoordination` wraps the same `CoordinationStore`, used as a **mirror plus an outbox**.
- **Writes** (`claim`, `release`, `takeOver`, `ack`) go to the relay first.
  - If the relay is reachable, its answer is applied to the mirror.
  - If it isn't, the write is recorded in `coord_outbox` (`id`, `op`, `payload`, `created_at`, `attempts`, `last_error`), applied to the mirror as *provisional*, and `claim` returns `queued_offline`.
- **The mirror is refreshed** from a snapshot on every (re)connect, and from WebSocket frames between snapshots.
- **The outbox drains in order** on reconnect. Conflicts are handled as in "Offline behaviour".

### Where the engine calls it

- **Starting a mission linked to a tracker item** calls `claim` before the first task is dispatched. Today that link is `missions.issue_link_id`; #52 generalises it.
  - `held_by` refuses the start in plain words: "Ana is working on ACME-123 since 10:42."
  - A mission with no tracker item claims nothing.
- **Completing a mission** releases its claim with `done`. Cancelling it, or the person pressing **Stop working on this**, releases it with `released`.
- **The daemon's intake runners (#52)** call `mailbox.pull` on their own tick and `ack` after they have recorded the item. Recording means created or linked in the tracker, per "create or link, never duplicate".

### Moving from solo to a relay

1. An admin brings up a relay, and gets a one-time admin invite from the container log or from `docker compose exec relay tandemise-relay invite --role admin`.
2. In the desktop: **Settings → Team relay → Connect**, then enter the relay URL and the invite code.
3. The daemon redeems the invite: `POST /relay/v1/invites/redeem` with `{ code, displayName, deviceLabel }`, and gets back `{ memberId, deviceToken, team }`.
   - The token goes into the existing `SecretStorePort` (`packages/domain/src/ports/secrets.ts`).
   - The settings file records only the URL and the secret's reference.
4. **Import.** If the relay is empty and the person is its first admin, the daemon offers **Bring my local data**: the active claims, the endpoints and the unacked mailbox. These go up in one `POST /relay/v1/import`, which is accepted only into an empty relay, all or nothing.
   - On a relay that already has data, only the person's own active claims are pushed. Each one goes through normal `claim` semantics, so a conflict is reported per item.
   - Local named people become **suggested invites**, not accounts, because the relay can't vouch for someone who has never redeemed a code.
5. bootstrap rebinds `COORDINATION` to `RelayCoordination` on the next start. The settings change also restarts the coordination module in place, without a daemon restart.
6. **Disconnect** goes back to `LocalCoordination`. It keeps the mirror's rows, marked as last seen from the relay, and keeps the person's own active claims as local ones. Nothing is deleted.

Export/import is also exposed as a file (`tandemise coordination export`: JSON lines plus `schema_version`) so moving between relays, or backing one up, uses the same format.

## Auth

**Two separate trust zones, never bridged:**
- **Desktop ↔ daemon** stays exactly as it is: loopback, the per-install bearer token, the CORS rules (`server.ts`, `identity.ts`). The relay never connects *into* a daemon. The daemon only makes outbound requests, so no inbound listener is added and the loopback invariant holds.
- **Daemon ↔ relay** uses a per-device bearer token over HTTPS.

**Invites.**
- An admin creates one from the desktop (through the daemon) or the relay CLI: role, display name, expiry.
- The code is 128 random bits shown once, formatted for copying (`TRI-XXXX-XXXX-XXXX-XXXX`). Only its hash is stored.
- Redeeming creates the member (or attaches a new device to an existing member, if an admin issued a "new device" invite for them) and returns a device token.

**Device tokens.**
- Format `trd_<base64url(32 bytes)>`. Stored as SHA-256; lookup by hash, then a constant-time compare, mirroring `verifyBearer`.
- Sent as `Authorization: Bearer …`, on HTTP and on the WebSocket handshake. The daemon is a Node client and can set handshake headers, so there is no `?token=` query fallback on the relay. The daemon needs that fallback only because browsers can't set them (`server.ts#handleUpgrade`).
- Every authenticated request updates `coord_devices.last_seen_at`, throttled to once a minute.

**Bootstrap.**
- On first start with an empty database, the relay creates the team (`RELAY_TEAM_NAME`) and one admin invite, and prints the code to stdout once.
- `tandemise-relay invite --role admin` makes another one, for when the log is lost. It needs shell access to the container, which is the root of trust for a self-hosted server.

**Roles.**

| Action | admin | member |
|---|---|---|
| Read members, claims, presence | yes | yes |
| Claim, release own claim | yes | yes |
| Take over a **stale** claim | yes | yes |
| Take over a **fresh** claim | yes | no |
| Pull and ack mailbox | yes | yes |
| Create invites, remove members, revoke devices | yes | no |
| Create, disable and rotate endpoints | yes | no |
| Import | yes, on an empty relay | no |

**Removing a member** revokes all of their devices and ends their active claims with `removed`. Their history rows stay.

## Protocol

Plain HTTP/JSON under `/relay/v1`, one WebSocket, and the unauthenticated webhook ingress.

**Versioning.**
- Every request carries `X-Tandemise-Relay-Api: 1` (`RELAY_API_VERSION`). A mismatch is refused, with the same wording style as the daemon's version check (`server.ts`).
- The relay has its own API version, separate from the daemon's `API_VERSION`, because a team may upgrade the relay and its laptops at different times. The relay supports the current and the previous version.

**Routes.**

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /relay/v1/health` | none | `{ ok, apiVersion }`. No data. |
| `POST /relay/v1/invites/redeem` | invite code in body | Join; returns a device token. Rate-limited per IP. |
| `GET /relay/v1/snapshot?projects=a,b` | device | `{ seq, team, members, devices(own), presence, claims(active, for those projects), endpoints(admin) }`. |
| `POST /relay/v1/claims` | device | Claim. `201` with the claim, or `409 CONFLICT` (`details.reason: "claim_held"`) with the holder's claim. |
| `POST /relay/v1/claims/:id/release` | holder or admin | End with `done` or `released`. |
| `POST /relay/v1/claims/:id/take-over` | rules above | Ends the old claim with `taken_over` and creates a new one, atomically. |
| `GET /relay/v1/claims?project=&item=` | device | Claim history for one item (the last 20). |
| `POST /relay/v1/invites`, `DELETE /relay/v1/members/:id`, `DELETE /relay/v1/devices/:id` | admin | Membership. |
| `POST /relay/v1/endpoints`, `POST /relay/v1/endpoints/:id/disable` | admin | Webhook URLs. |
| `POST /relay/v1/mailbox/pull` | device | `{ project, max ≤ 50, leaseSeconds ≤ 300 }` → leased messages. |
| `POST /relay/v1/mailbox/ack` | device | `{ ids }`; only the lease holder can ack. |
| `POST /relay/v1/leases` | device | `{ project, scope: "source", key, ttlSeconds }` → `{ granted, expiresAt, holderName, deviceLabel }`. A short, in-memory lease (intake spec §3): the holding device renews it, anyone takes a lapsed one. Lost on a relay restart until the next renewal. At most 200 live leases per device (`429`). Added by intake (#52). |
| `POST /relay/v1/import` | admin | One-shot move from solo (see above). |
| `GET /relay/v1/stream` | device (WebSocket) | Live changes. |
| `POST\|PUT\|GET /hooks/:slug` | none (see mailbox) | Webhook ingress. |

Errors use the daemon's error envelope (`ApiErrorBody`, `packages/api-contract/src/errors.ts`; its `ErrorCode` set is reused, with relay-specific reasons in `details.reason`), so the desktop renders relay refusals exactly like daemon refusals, in plain words.

**The stream.** It follows the daemon's own rule (`packages/api-contract/src/stream.ts`): the socket is only the notification edge, and correctness comes from HTTP.

```ts
type RelayServerFrame =
  | { type: 'hello'; apiVersion: string; seq: number; serverTime: string }
  | { type: 'claim'; seq: number; claim: ClaimView }          // created or ended
  | { type: 'presence'; seq: number; presence: PresenceView }
  | { type: 'members'; seq: number }                          // re-read the snapshot
  | { type: 'mailbox'; project: string; pending: number }     // hint only; never the payload
  | { type: 'pong'; t: number };
type RelayClientFrame =
  | { type: 'watch'; projects: readonly string[] }
  | { type: 'presence'; status: 'online' | 'away' }
  | { type: 'ping'; t: number };
```

- On every (re)connect the client reads `/snapshot` and then applies frames whose `seq` is greater than the snapshot's.
- A gap in `seq` causes a fresh snapshot. The data is small (active claims and presence), so the relay keeps no change log and offers no replay.
- The client pings every 20 s. The relay closes a socket that has been silent for 60 s.

## Presence

- **Online** means the device has an open stream socket.
- **Away** means the daemon is up but the desktop has been idle for 10 minutes. The daemon already knows the desktop's activity through its own stream clients.
- **Offline** means no socket. `last_seen_at` says since when.
- Presence is per device and is shown per member as the "most present" of their devices.
- **No activity text is sent.** "What someone is working on" is their active claims, which are already facts. Presence doesn't carry a "Now" line or mission names, which keeps the relay dumb and keeps local work private.

## Claims: semantics and conflicts

- **A claim means "this person is working on this tracker item".** It holds one item, for one project, for one person (through one device).
- **One active claim per item.** The unique partial index on `(project_key, item_ref) WHERE state='active'` makes the relay's commit order the only arbiter. Client clocks never decide anything.
- **Two people start the same item:**
  - The first `INSERT` to commit wins.
  - The second gets `409 CONFLICT` (`details.reason: "claim_held"`) with the holder's name and `started_at`, and its daemon refuses to start the mission: "Ana is working on ACME-123 since 10:42."
  - The desktop offers **Take over** only where the rules allow it, plus **Not now**.
  - There is no "start anyway" that leaves two active claims. Silent parallel work is the failure this exists to prevent.
- **Same person, second device or second mission:** `409 CONFLICT` (`details.reason: "claim_held"`) with `self: true`. The desktop says "You're already working on this on <device>", and offers to open the existing mission if it is on this machine.
- **Claims do not expire.** Closing a laptop doesn't mean the work is abandoned, and the relay makes no decisions. A claim ends only through release, mission completion, take-over, or removing the member.
- **Stale.** A claim is *stale* when none of its holder's devices has been seen for `RELAY_STALE_AFTER` (default 24 h).
  - The desktop labels it: "Ana · last seen yesterday".
  - Any member may take over a stale claim. Only an admin may take over a fresh one.
  - A take-over is recorded (`ended_reason: taken_over`, `ended_by`). The original holder's daemon sees it on its next snapshot and shows "Bruno took over ACME-123", with the mission left as it is (below).
- **The relay never stops anyone's work.** When a daemon learns that its claim ended with `taken_over` or `removed`, it does not cancel the mission. It marks the mission **Unclaimed** (a banner on the mission, and an Inbox row for the person). The person decides: **Stop**, **Take it back** (normal take-over rules), or **Keep going without a claim**. Decisions belong to people and their local engine, never to the relay.
- **Tracker state is separate.** Moving the tracker item to "In progress" or assigning it is #52's job, done through the brain's state mapping. The relay doesn't call trackers.

## Offline behaviour

| Situation | What happens |
|---|---|
| Relay unreachable at daemon start | The mirror serves reads. Status is **offline since …**. Local work is unaffected. |
| Claim while offline | Recorded in the outbox and shown as **pending** ("Will tell the team when you're back online"). The mission starts: local work is never blocked by the network. |
| Reconnect, pending claim is free | Accepted. The mirror marks it confirmed. |
| Reconnect, someone claimed it meanwhile | The relay returns `409`. The local claim becomes **conflicted**, and the mission gets the Unclaimed banner: "Ana started ACME-123 at 10:40, while you were offline." Same three choices as above. The relay's order wins. |
| Release or ack while offline | Queued in the outbox, and applied on reconnect. Ack of an expired lease is ignored: the message was re-leased and may be processed twice, so intake must be idempotent by message id (below). |
| Relay down for good | **Settings → Team relay → Disconnect** falls back to local, keeping the mirror. |

The outbox is drained in order, with backoff (1 s doubling to 5 min). An op that keeps failing with a non-retryable error is surfaced in Settings, not retried forever.

## The webhook mailbox

**Receive.**
- An admin creates an endpoint for a project and gets a URL: `https://relay.example.com/hooks/<slug>`. They paste it into Sentry, Meta or anything else.
- `POST`/`PUT` to that URL stores `method`, `query`, the headers and the raw body, and answers `202` immediately. The relay never parses the body.
- Header handling: hop-by-hop headers, `Cookie` and `Authorization` are dropped. Signature headers (for example `Sentry-Hook-Signature`, `X-Hub-Signature-256`) are kept, because the local runner verifies them.

**Handshakes.** Some sources need a synchronous answer before they will send anything. The relay supports a short, fixed list, and nothing else:
- `meta_hub`: Meta (WhatsApp) `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. The relay echoes the challenge if the token equals the endpoint's `handshake_secret`.
- `echo_challenge`: a JSON body `{ "type": "url_verification", "challenge": … }` is answered with the challenge and not stored.
- Adding a handshake is a code change in `coordination` with a check. It is never configuration.

**Limits.**
- 1 MB per body (`413` beyond). The daemon's routes use the same per-route cap pattern (`maxBodyBytes`, `router.ts`).
- 60 requests per minute per endpoint, with a burst of 120 (`429` beyond).
- A disabled endpoint answers `404`, so it looks the same as an unknown slug.

**Pull.**
- A daemon calls `pull` for the projects it has intake runners for.
- The relay leases up to `max` unacked messages in `id` order to that device (`lease_device`, `lease_until = now + leaseSeconds`, `attempts += 1`).
- A leased message is invisible to other pulls until its lease expires. Delivery is **at least once**, to **one** device at a time. The work lands in the shared tracker, and every member's runners would otherwise create the same item.
- The `mailbox` hint frame tells connected daemons to pull now, instead of on their next tick.

**Ack.**
- The leasing device acks after it has recorded the item (created or linked in the tracker).
- The daemon also keeps the ids it has processed (in the intake's own table, #52), so a redelivery after a lost ack is a no-op.
- A message leased 10 times without an ack is **parked**: it is no longer leased, and it shows in Settings → Team relay → Webhooks as "couldn't be processed", with the last device that tried. An admin can retry or drop it.

**Retention.** Configurable by environment, with these defaults:
- An acked message's body is deleted at once. The row is kept for 24 h for "last received" displays, then deleted.
- Unacked messages are kept for 14 days, then deleted and counted on the endpoint (`dropped_count`).
- The mailbox is capped at 10,000 messages or 200 MB across all endpoints. When the cap is hit, the oldest *unacked* message is dropped first, and the endpoint is flagged so the desktop can say "Webhooks were dropped because nobody picked them up".
- A sweep runs every 10 minutes inside the relay process; there is no separate worker.

**Solo.** The local mailbox has the same tables and the same pull/ack path. Local runners and an optional user-run tunnel can drop requests into it through the daemon's own API: `POST /v1/hooks/:slug`, authenticated with the daemon's bearer token unless the person explicitly enables an unauthenticated loopback hook. Moving to a relay moves unacked messages with the import.

## Deployment

`apps/relay` ships these files:
- **`Dockerfile`**, multi-stage.
  - The build stage runs `npm ci` and builds only the workspaces the relay needs: `api-contract`, `coordination` and `relay`.
  - The runtime stage is `node:22-bookworm-slim` with production dependencies only. `better-sqlite3` uses its prebuilt binary, so there is no compiler in the final image.
  - It runs as the non-root `node` user, `EXPOSE 8787`, with `HEALTHCHECK` on `/relay/v1/health`.
  - Target image size: under 120 MB **compressed**, the size a pull downloads (measured with `docker save | gzip`). The `node:22-bookworm-slim` base alone is about 200 MB unpacked, so an unpacked target would rule out the base this spec chose. *(Amended at build time; controller ruling.)*
- **`compose.yaml`**: one `relay` service, a named volume `relay-data:/data`, the port `8787:8787`, `restart: unless-stopped`.
  - An optional `caddy` service, under a compose profile (`--profile tls`), terminates TLS with automatic certificates for `RELAY_PUBLIC_URL`.
  - Teams with their own reverse proxy skip it.
- **`.env.example`**:

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TEAM_NAME` | `Team` | Used once, on first start. |
| `RELAY_PUBLIC_URL` | (required unless loopback) | Builds webhook URLs. Must be `https://` unless the host is loopback, or the relay refuses to start. `RELAY_INSECURE_HTTP=1` overrides this for a LAN-only setup, and logs a warning on every start. |
| `RELAY_PORT` | `8787` | |
| `RELAY_DB` | `/data/relay.db` | The SQLite file, in WAL mode. |
| `RELAY_STALE_AFTER` | `24h` | |
| `RELAY_MAILBOX_*` | see above | Retention and caps. |
| `RELAY_LOG_LEVEL` | `info` | |

**Backup** is the volume, or `tandemise-relay export`, the same JSONL format as the daemon's export. **Upgrade** is pulling the new image; `migrateCoordination` runs at boot.

**The relay process itself** is one Node process with no cluster and no workers. Target: under 60 MB RSS at idle, and it starts in under a second.

**Image publishing.** CI builds the image on every PR, to prove the Dockerfile. Release-please's release job pushes `ghcr.io/tandemise/relay:<version>` and `:latest`. The tag follows the monorepo version until a split.

## Security

- **Network exposure is the relay's whole attack surface,** so its routes are few and its dependencies are two (`ws`, `better-sqlite3`), plus `zod` through the contract.
- **Secrets at rest.**
  - The relay stores token hashes and invite-code hashes only.
  - Endpoint `handshake_secret`s are stored in clear, because the relay must compare them. They are verify-tokens, not signing keys.
  - Webhook signing secrets never reach the relay. The local runner holds them in the person's `SecretStorePort`.
- **Brute force.**
  - Token and invite lookups are by hash.
  - Failed auth is rate-limited per IP: 10 per minute, then `429` for 10 minutes.
  - Webhook slugs are 128-bit and unguessable. The ingress route returns the same `404` for unknown and disabled slugs.
- **No CORS.** The relay sends no `Access-Control-Allow-*` headers. Only daemons talk to it, and a browser page can't read it.
- **TLS** is required off-loopback (see `RELAY_PUBLIC_URL`). The daemon refuses an `http://` relay URL that isn't loopback, unless the person ticks **I understand this is unencrypted**.
- **Webhook bodies are untrusted data.**
  - They are stored as bytes and handed to runners as data.
  - A runner must never pass them to an agent as instructions without the intake contract's framing (#52).
  - Bodies are never logged. Logs record the endpoint id, size and status only.
- **Least data.**
  - A claim carries the tracker key, title and URL, because the team needs those to recognise the item.
  - It carries no mission content. `local_ref` is an opaque id.
  - Presence carries no activity text.
- **Removal is immediate.** Revoking a device closes its socket at once and fails its next request.
- **One team per instance,** so there is no cross-tenant data path to get wrong.
- **The daemon gains no inbound surface.** Every relay interaction is an outbound request from `coordination-relay`, under the daemon's existing process and secret store.

## What the desktop shows

The desktop talks only to the daemon, never to the relay. The renderer is a control surface (AGENTS.md, `npm run check:boundaries`). The daemon exposes `/v1/coordination/*` (status, members, presence, claims, endpoints, connect, disconnect, invites, take-over), and adds an invalidation topic `coordination` to the existing stream (`ProjectionTopic`, `stream.ts`).

- **Home → "Who's working on what"**: one row per active claim in the current project. Each row has the member's name and presence dot, the tracker key and title (linked to the tracker), and "since 10:42". Your own claims come first. Stale claims say "last seen …". Conflicted or pending claims of yours carry a plain badge.
- **Team screen** (`apps/desktop/src/renderer/src/screens/team/Team.tsx`): relay members, with presence and their active claims. Admins see devices (label, last seen, **Revoke**) and **Invite someone**, which shows the code once, with a copy button. Local agents and roles stay as they are.
- **Starting a mission** on a held item: the refusal in plain words, with **Take over** when allowed. Missions show **Unclaimed** or **Pending** banners when those states apply.
- **Settings → Team relay**:
  - **Local only**: an explanation, and **Connect**.
  - **Connected to <host>**, with the team name.
  - **Offline since …**, with the number of pending changes.
  - **Disconnect**.
  - **Webhooks** (admins): create an endpoint (name, project, source, handshake), copy its URL, see last received / pending / parked / dropped, retry or drop parked messages.
- Copy follows the UI conventions: "you", plain verbs, no raw enums. Colours come from `palette.css`/`theme.css`, enforced by `npm run check:design`.

## Acceptance

Proven three ways, following the repo's existing patterns.

**Offline checks**, added to `OFFLINE_CHECKS` in `scripts/run-checks.mjs` so `npm run ci` runs them:
- `scratch/coordination-check.mjs` exercises the store in-process against a temp SQLite file:
  - claim, conflict, self-conflict;
  - release and take-over rules (stale and fresh, admin and member);
  - `itemRef` normalisation;
  - mailbox lease, ack, expiry and re-lease, parking after 10 attempts, retention sweep, the cap;
  - migrations applied twice are a no-op;
  - export → import round trip.
- `scratch/relay-check.mjs` starts the built `apps/relay` on an ephemeral port with a temp `RELAY_DB`, then:
  1. Bootstrap prints an admin invite; redeem it; a second redeem of the same code is refused.
  2. Two members on two device tokens. Both claim `github:acme/app#7` at the same moment: exactly one `201`, one `409 CONFLICT` (`details.reason: "claim_held"`) naming the winner.
  3. A stream subscriber receives the `claim` frame. A reconnect with a stale `seq` gets a consistent snapshot.
  4. Take-over is refused for a member on a fresh claim, allowed for an admin, and allowed for a member after the stale clock passes (test clock knob, like `TANDEMISE_CLOCK_OFFSET_MS`).
  5. Webhook: `POST /hooks/<slug>` → `202`. Pull leases it to device A; device B's pull gets nothing; after the lease expires, B gets it; ack by A is refused, ack by B succeeds.
  6. `meta_hub` handshake echoes the challenge with the right token, and refuses it with a wrong one.
  7. Limits: 1 MB+1 → `413`; the rate limit → `429`; unknown slug and disabled slug → identical `404`.
  8. A revoked device's open socket is closed, and its next request is `401`.
  9. Non-loopback bind with an `http://` public URL refuses to start.
- `scratch/coordination-daemon-check.mjs` starts one relay and **two daemons** from this checkout, each with a fresh `TANDEMISE_HOME`, the same way `scratch/e2e-daemon.mjs` starts one:
  1. Daemon A, solo, starts a mission linked to an issue: a local claim exists.
  2. A connects to the relay with the admin invite and imports: the claim appears on the relay.
  3. B joins with a member invite. Starting the same item on B is refused with A's name.
  4. Stop the relay. B starts another item: the claim is pending. A also starts it while offline from B's view: on restart, exactly one wins, and the loser's mission shows Unclaimed and is still running.
  5. Completing A's mission releases the claim on the relay.
  6. A webhook posted to the relay is pulled and acked by exactly one daemon.
  7. Disconnect on A falls back to local and keeps its own claims.

**Real app** (AGENTS.md: "Prove UI/behaviour changes in the real app"):
- `scratch/acceptance/relay/` drives two desktop windows over CDP (`electron-vite dev`, fresh homes, daemons from this checkout, a relay from this checkout), the way `scratch/desktop-live-check.mjs` does. It asserts the DOM for:
  - **Settings → Team relay** going from Local only to Connected to Offline.
  - The Home "Who's working on what" list updating in window B within 2 s of window A starting a mission.
  - The refusal copy in B, and the Unclaimed banner after a take-over.
  - The Team screen invite flow.
  - Screenshots go to `docs/superpowers/evidence/2026-10-30-relay/`.
- **Docker**: `docker compose -f apps/relay/compose.yaml up -d`, health is green, one daemon connects, a claim round-trips, and `docker compose down && up` keeps the data. This one is run by hand; CI only builds the image.
- `npm run ci` is green, including the new boundary rule for `apps/relay`.

## Build order

Each step is shippable and leaves solo users unaffected:
1. `api-contract/relay`, `packages/coordination` (store, rules, migrations), `coordination-check`.
2. `LocalCoordination`, the `COORDINATION` port, claim on mission start and release on end, daemon `/v1/coordination/*`, Home list.
3. `apps/relay` server, CLI, Dockerfile, compose, `relay-check`.
4. `coordination-relay` client: mirror, outbox, stream, connect/import/disconnect, Settings and Team UI, `coordination-daemon-check`.
5. Mailbox endpoints and pull/ack. These wire to intake when #52 lands; until then, a stub runner that records and acks proves the path.

## Left to the builder

- Exact route payloads and zod schemas, within the shapes above.
- How `itemRef` normalises each tracker beyond GitHub; #52 owns the list.
- The idle threshold for "away" and the ping intervals, within the values above.
- Whether `coord_outbox` lives in `coordination` or only in `coordination-relay`. It is only ever written in relay mode.
- The admin CLI's exact commands (`invite`, `export`, `import`, `revoke`).
- Caddyfile details for the `tls` profile.

## Calls made without the owner

The owner gave autonomy within the pivot direction. These are my calls and are open to correction:
- **Monorepo `apps/relay` now; split later along a boundary the build enforces.** The relay imports only `@tandemise/api-contract/relay` and `@tandemise/coordination`.
- **One schema, literally shared.** The daemon and the relay run the same `coord_*` DDL from `packages/coordination`, with its own version stream, outside the daemon's `MIGRATIONS` list.
- **Claims are exclusive and never expire.** Staleness unlocks take-over for members; admins can always take over. There is no "start anyway" that leaves two active claims.
- **The relay never stops work.** A lost claim makes a mission Unclaimed, and the person decides.
- **Offline claims don't block local work.** They queue, and the relay's commit order settles conflicts on reconnect.
- **Relay roles are only `admin` and `member`.** Local access levels keep governing each install. Agents are never relay members.
- **Webhooks are stored raw and verified locally.** The relay knows two handshakes (Meta hub, echo challenge) and nothing about signatures.
- **Mailbox delivery is at least once, to one device at a time, by lease.** Intake must be idempotent by message id.
- **Presence carries no activity text.** "Who's working on what" comes from claims alone.
- **No web UI on the relay.** The desktop, through the daemon, is the UI. A CLI exists for bootstrap and recovery.
- **SQLite through `better-sqlite3`, not `node:sqlite`.** The repo already ships and trusts it, and `node:sqlite` is still experimental on Node 22. `coordination`'s `SqlHandle` interface keeps a later swap to one adapter.
- **The relay has its own API version** (`RELAY_API_VERSION`), separate from the daemon's, and supports the previous version for one release.
