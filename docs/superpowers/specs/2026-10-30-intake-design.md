# Intake: work from any source, into the project's primary tracker

Status: design, 2026-10-30. Third sub-project of the software-factory pivot (#56), tracked in #52. Background and binding decisions are in `2026-10-30-tandemise-pivot-notes.md`. Depends on the brain repo (#51) for project configuration. Uses the optional server (#54) when it exists, never requires it.

## The problem

The work a team does is reported in many places:
- the tracker the team already plans in (YouTrack, GitHub Issues);
- GitHub issues filed by people outside the team;
- Sentry errors and PostHog signals;
- a Slack or Discord thread where someone says "this is broken".

Today Tandemise reads one of these, and only in one way. P14 (`docs/superpowers/specs/2026-09-26-p14-issues-design.md`) turns a labelled GitHub issue into a **Tandemise draft mission** (`IssueService#createDraft`, `packages/application/src/services/issue-service.ts:303`), and may queue it, so the P7 pull plans it on its own. That model has three problems under the pivot:

- **Tandemise becomes a second board.** The backlog of drafts in Tandemise drifts from the team's tracker, which is where a PM actually looks.
- **Work can start without anyone starting it.** A queued draft is pulled into planning by the work-in-progress limit (`scheduler.ts`, `pullBacklog`).
- **It is GitHub-only and duplicates freely.** The same bug reported in Sentry, in Slack and in an issue would become three missions.

## Goal

Anything that might be work, from any source, is **recorded** and lands as **one** task in the project's primary tracker: created if it is new, linked if it already exists. A person looks at the board (the tracker, seen through Tandemise), picks a task and presses **Start**. Only then does a mission exist. While it runs, the tracker shows it in progress, with a single activity comment that follows the work. When the work is done, Tandemise writes the right state back to the tracker and closes the loop at every source: it closes the GitHub issue, resolves the Sentry issue in the fixing commit, and replies once in the Slack thread.

Success means the owner's "normal day" from the pivot notes works: open Tandemise, see the board, press "Check sources now" if it's empty, pick a task, start it. Nobody copies anything between systems, and nothing is reported twice.

## Non-goals (this sub-project)

- **A Tandemise-owned board.** The tracker is the board. Tandemise shows it and acts on it; it never keeps a competing list.
- **Two-way field sync.** Tandemise writes title, description and sources on create; after that it writes only links, its own comments and mapped state transitions. It never mirrors priority, sprints, estimates or assignees back and forth.
- **Messaging.** No chat bot, no conversation in Slack or Discord, no notifications to chat. From chat, only work comes in. To chat, only the loop closure goes out (one reply, plus an optional emoji reaction).
- **Starting work from the tracker or from chat.** Start happens in Tandemise (desktop or CLI). Starting when a person assigns the item to a Tandemise user in the tracker (Linear's agent model) is a later option, noted below.
- **An LLM triage agent.** Dedupe and filtering in this sub-project are deterministic and lexical. An agent that ranks signals (Tembo's daily job) plugs into the same port later.
- **Trackers beyond YouTrack and GitHub Issues.** Linear, Jira and others are later adapters of the same port. GitHub Projects (v2) status fields are later too; the first GitHub adapter maps states to open/closed and labels.
- **Building the server.** #54 builds it. This spec only fixes the shape of the data the server will hold (claims and the webhook mailbox) so the local DB can move there.
- **Inbound webhooks on the daemon's API port.** The API stays loopback-only (`apps/daemon/src/http/server.ts:74`). Webhooks reach the daemon through the server's mailbox or a separate, opt-in listener (below).

## Words

| Word | Meaning |
|---|---|
| **Source** | A place work is reported: one configured GitHub repository, one Sentry project, one Slack workspace, one custom feed. |
| **Runner** | Code that listens to a source and pushes signals. Shipped runners run inside the daemon; custom runners run anywhere and push over HTTP or the CLI. |
| **Signal** | One "something that might be work", in the intake contract. Identified by its **fingerprint** (`<kind>:<instance>:<key>`). A repeat of the same thing updates the same signal. |
| **Primary tracker** | The project's one board (YouTrack project, GitHub repository's issues). Configured in the brain repo. |
| **Tracker item** | A task in the primary tracker (`ACME-12`, `tandemise/tandemise#52`). |
| **Start** | The act, by a person, that turns a tracker item into a Tandemise mission. |
| **Closure** | What Tandemise writes back to a source when the tracker item is done. |

"Intake" already names spec A2's upload intake (`packages/application/src/planning/intake.ts`, an upload turned into a typed artifact). The builder renames that module to `upload-intake.ts` so the new `IntakeService` has the word to itself.

## Approaches considered

1. **The tracker is the board; one agnostic contract; shipped runners in the daemon, custom runners over HTTP/CLI** *(chosen)*.
   - Matches the binding decisions: the tracker stays the single source of truth, and anyone can add a source without touching Tandemise.
   - Deterministic and idempotent: every step is keyed, so a restart, a second tick or a second daemon creates nothing twice.
   - Cost: two tracker adapters, five runners, and a dedupe pipeline to build and test.
2. **Tandemise owns a board and syncs it to trackers.** Rejected by the owner ("Tandemise does not own a board"), and two-way sync is where every integration drifts.
3. **An agent with MCP tools does intake.** "Check sources" runs an agent with the YouTrack, Sentry and Slack MCP servers and asks it to file what matters.
   - No adapters to write, and any MCP works.
   - Rejected as the main path: it is not idempotent (dedupe depends on what the model notices), it costs tokens on every poll, and MCP is request/response, so it can't *listen* to Slack or Discord. It can't promise "never duplicate".
   - Kept for later as an optional triage pass over signals that are already recorded, behind the `SimilarityJudge` port.
4. **No shipped runners; Tandemise only exposes HTTP and people wire n8n or Zapier.** Cheapest, but it needs a public server for most of those tools, which breaks "works with no server", and gives a solo user nothing out of the box. Kept as a supported path (HTTP push), not the only one.

For runners specifically:
- **In-daemon** (chosen for shipped runners): one lifecycle, the daemon's secret store, the daemon's clock for tests, and the coordination claim in one place.
- **Separate processes over stdio, like MCP servers**: better isolation, but process supervision and a second protocol. Rejected for now; a custom runner is already a separate process that speaks HTTP.

## Decisions

### 1. The intake contract (`tandemise.intake/v1`)

A signal is JSON, validated by a zod schema in `@tandemise/api-contract` (`intakeSignalV1`), with a JSON Schema exported to `docs/intake/signal.v1.schema.json` for people who write runners in other languages.

```jsonc
{
  "schema": "tandemise.intake/v1",
  "source": {
    "kind": "sentry",            // shipped kinds, or a custom slug [a-z][a-z0-9-]{1,31}
    "instance": "acme/web"       // which account/project/channel; free text ≤ 200
  },
  "key": "4501234567",           // stable id of the thing inside the source; ≤ 200
  "url": "https://acme.sentry.io/issues/4501234567/",  // link back; https only
  "title": "TypeError: cannot read 'id' of undefined",  // ≤ 200
  "description": "…markdown…",   // ≤ 20 000; untrusted data
  "reporter": { "name": "Sam Ortiz", "handle": "sam", "url": "https://…" },  // all optional; no email
  "occurredAt": "2026-10-30T09:12:00Z",
  "attachments": [
    { "name": "trace.txt", "mediaType": "text/plain", "url": "https://…" },
    { "name": "screen.png", "mediaType": "image/png", "contentBase64": "…" }
  ],
  "impact": {                    // optional; what the noise filter reads
    "level": "error",            // fatal | error | warning | info
    "events": 132, "users": 41,
    "firstSeen": "…", "lastSeen": "…",
    "release": "web@2026.10.29"
  },
  "labels": ["checkout"],        // hints only, never commands
  "reply": { "address": "…" },   // opaque to Tandemise; what the runner needs to close the loop
  "kindHint": "bug"              // bug | request | question; optional
}
```

Rules:
- **The fingerprint is `<kind>:<instance>:<key>`.** It is the deterministic dedupe key. The same fingerprint always updates the same signal.
- **Everything except `schema`, `source`, `key`, `url` and `title` is optional.**
- **Attachments:** at most 10. Inline content at most 1 MB each and 5 MB per signal; anything bigger is a `url`. The daemon never fetches attachment URLs on its own (no SSRF surface). It stores inline ones as artifacts (content-addressed, like uploads) and passes URLs through as links.
- **Text is data.** Title, description, labels and reporter flow only into the tracker item's text and, after Start, into the mission's goal, attributed, as P14 does today. Nothing in a signal can choose the project, the tracker, a state, a filter threshold or which sources are read. The project comes from the source's configuration, and for HTTP pushes from the token.
- **Versioning.** Additive, optional fields can be added inside v1; unknown fields are rejected (strict schema) so a runner learns at once that it is ahead of the daemon. A breaking change is `tandemise.intake/v2`. The daemon then accepts both for at least two minor releases and answers v1 pushes with a `Deprecation` header. `GET /v1/intake/schema` returns the versions it accepts.

### 2. Runners

```ts
// @tandemise/domain (port)
interface IntakeRunner {
  readonly kind: string;                       // 'github' | 'sentry' | 'posthog' | 'slack' | 'discord'
  readonly mode: 'poll' | 'socket' | 'webhook';
  start(ctx: RunnerContext): RunnerHandle;     // ctx.push(signal), ctx.clock, ctx.secrets, ctx.log, ctx.signal
  fromWebhook?(req: { headers; body: Buffer }): readonly IntakeSignalV1[];  // verifies the source's signature
  close?(closure: Closure): Promise<ClosureResult>;   // loop closure at this source
}
```

Shipped runners register through a `multiToken` the way integrations do (`INTEGRATION_PROVIDERS`, `packages/integrations-core/src/provider.ts`). The application names none of them.

| Runner | Package | How it listens | Credential |
|---|---|---|---|
| GitHub issues | `integration-github` | poll `gh issue list` (P14's `GhIssueTracker.listOpen`, `packages/integration-github/src/issues.ts`) | the `gh` session (none stored) |
| Sentry | `intake-runners` | poll the issues API (unresolved, `lastSeen` since the last check); webhook optional | auth token in the secret store |
| PostHog | `intake-runners` | poll error-tracking issues; webhook (from a PostHog destination) optional | personal API key in the secret store |
| Slack | `intake-runners` | Socket Mode, outbound WebSocket | app + bot tokens in the secret store |
| Discord | `intake-runners` | gateway, outbound WebSocket | bot token in the secret store |

- `intake-runners` is a new layer-4 provider package (added to `PROVIDER_PACKAGES` in `scripts/packages.mjs`). It uses Node 22's built-in `fetch` and `WebSocket`, so no new dependency.
- **From chat, only explicit work comes in.** The Slack and Discord runners never read the whole channel into the tracker. A message becomes a signal when a member reacts with the configured emoji (default `:tandemise:`) or mentions the app. The signal is the message and its thread so far; the reply address is the thread.
- **Poll intervals** come from the source's configuration (5, 10, 15, 30 or 60 minutes, as P14), driven by the scheduler tick in the background (`syncIssues` today, `scheduler.ts:68`), so a slow source never delays dispatch. "Check sources now" runs every due poll at once and waits.
- **A runner acts as the person who switched it on, on their machine** (P14 ruling 11). Credentials are that person's, in the local secret store (`apps/daemon/src/secrets.ts`); they never go in the brain repo.

**Custom runners** push over HTTP or the CLI:

- `POST /v1/intake/signals` on the daemon's loopback listener. Body: one signal or `{ signals: [...] }` (at most 50). Answer: `202 { results: [{ fingerprint, signalId, status }] }`. Pushing the same fingerprint again is idempotent: it updates the same signal.
- **Auth:** `Authorization: Bearer <intake token>`. An intake token is minted per custom source in Settings → Intake and shown once. It is stored as a SHA-256 hash and allows exactly two things: pushing signals for that source and reading that source's closures. The daemon token (`apps/daemon/src/http/identity.ts`) is also accepted, for the desktop and the CLI. Each token is rate-limited (60 signals a minute, by default).
- **The CLI.** The repo has no `tandemise` command today. This sub-project adds a thin one (a `bin` in `apps/daemon`) that reads the daemon's connection file and calls the API:
  - `tandemise intake push --source <id> --file signal.json` (or `--title … --url … --key …`);
  - `tandemise intake closures --source <id> [--ack <closureId>]`;
  - `tandemise start <tracker key>` (see §6).
- **Closures for custom sources are pulled, never pushed.** The daemon does not call arbitrary URLs. A custom runner reads `GET /v1/intake/closures?sourceId=…&after=…` and acknowledges each with `POST /v1/intake/closures/:id/ack` (with `ok` or an error text).

**Webhook-only sources** (WhatsApp Business, Sentry or PostHog configured for webhooks):
- **With the server (#54):** the server exposes `POST /hooks/:sourceId/:secret` and stores the raw request in its mailbox. Each daemon pulls the mailbox, claims an item, and hands it to the runner's `fromWebhook`, which verifies the source's signature with the locally held secret. The server stays dumb: it stores bytes and never parses them.
- **Without the server:** an **opt-in, separate webhook listener** on its own loopback port that only serves `POST /hooks/:sourceId`, writes into the local mailbox table, and is exposed by the person's own tunnel (cloudflared, ngrok). It shares nothing with the API listener, so a tunnel never exposes the API.

### 3. Several people, several daemons

Each person's daemon may run the same runners. Two protections, used together:

1. **A claim on the source, when the server exists.** A daemon runs a poll or socket runner only while it holds the claim `('source', sourceId)`, a lease with a heartbeat (TTL 2 minutes, renewed every 30 seconds). Another daemon takes over when the lease lapses. Without a server, the local claim table always grants the claim, so a solo user sees no difference.
2. **Dedupe against the tracker, always.** The tracker is the shared truth. Before creating, every daemon searches the tracker for the signal's exact source URL (§5). Two daemons racing on the same signal can, in a narrow window, both create an item. The next board refresh detects two items carrying the same source URL, links the newer as a duplicate of the older in the tracker, moves its sources and comments over, and records `intake.duplicate_merged`.

Slack Socket Mode already sends each event to only one of an app's open connections, which helps. Discord's gateway sends every event to every connection, so it relies on the claim or on dedupe.

Starting work uses a claim too: `('tracker_item', itemRef)`. That is the server's "who is working on what". Without the server, Start re-reads the item and refuses if it is already in a mapped in-progress state ("ACME-12 is already in progress (Ana).").

### 4. The pipeline

Every signal, from every runner, goes through one service, `IntakeService.ingest(sourceId, signal)` (`packages/application/src/services/intake-service.ts`):

1. **Validate** against the contract. A rejected signal is recorded (`rejected`, with the reason) and the HTTP answer says why.
2. **Record.** Upsert by fingerprint in one transaction: first and last seen, occurrence count, the latest text, impact merged (max of counts, latest release). Everything that enters is recorded, whatever happens next.
3. **Filter noise** (§4.1). A signal under the bar is `held_back`, with the reason. It is re-evaluated whenever the same fingerprint arrives again, so an error that grows from 3 to 300 events crosses the bar on its own.
4. **Dedupe** (§5). This finds `linked` (an existing tracker item), `needs_decision` (a likely match, not sure), or `new`.
5. **Create or link** in the tracker (§6.1). The outcome is stored before the next signal is processed: a link row is written as `pending` before the tracker call and `done` after, as P14 writes the link before its mission (P14 §3), so a crash between the two finds the pending row and completes it instead of creating again.

Signal statuses: `received → held_back | needs_decision | linked | created | rejected | dismissed`, then the closure states `closure_pending → closed | closure_failed`.

Nothing in this pipeline creates a mission or queues anything. It touches only the tracker.

#### 4.1 The noise filter

Rules live per source in the brain repo, so the whole team filters the same way:

```yaml
# brain: factory/intake.yaml (file name provisional; #51 owns the layout)
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
dailyCap: 20     # new tracker items per source per day; the rest wait as needs_decision
```

- The filter is a pure function of the aggregated signal and these rules (`evaluateNoise` in `@tandemise/domain`). It returns `pass` or `held_back` with a reason in plain words ("12 events in 24 h; this source needs 20").
- A source with no `filter` passes everything (a custom runner may already filter).
- **The daily cap** guards against floods: past it, new signals wait as `needs_decision` instead of filling the tracker.
- "A similar existing task" is not a filter rule; it is dedupe (§5). A match links instead of creating.

### 5. Dedupe: deterministic keys first, then similarity

In order, stopping at the first answer:

1. **Local index.** The fingerprint already has a `done` tracker link → `linked` (the same signal again).
2. **The source is the tracker.** If the signal's URL is an item of the primary tracker (a GitHub issue in the tracker repository), it *is* that item → `linked`, with no new item.
3. **Exact URL in the tracker.** Every item Tandemise creates or links carries a **Sources** section listing each source URL (in the description on create, in Tandemise's sources comment on link). `PrimaryTracker.search({ url })` looks for the exact URL. A hit → `linked`. This is what makes dedupe work across daemons with no server.
4. **Similarity.** `PrimaryTracker.search({ text })` asks the tracker's own search for candidates among unresolved items (title words, top 20). `IntakeSimilarity.score(signal, candidate)` ranks them with a lexical score in `@tandemise/domain`: normalised title tokens (Jaccard), shared stack frames or error type for error signals, shared URLs. Thresholds come from the brain (defaults `link ≥ 0.85`, `ask ≥ 0.55`):
   - **≥ link:** linked automatically (`linkedBy: similarity`, score recorded).
   - **between ask and link:** `needs_decision`. An Inbox card asks: "Is this the same as ACME-12?" with **Same task**, **New task** and **Not work**. The card is a decision, not a message. P16 announces it like any other Inbox item.
   - **below ask:** `new`.

`IntakeSimilarity` is a port. The lexical scorer is the default. A later model-backed judge (approach 3) can replace it without changing the pipeline.

### 6. The primary-tracker port

```ts
// @tandemise/domain
interface PrimaryTracker {
  readonly kind: 'youtrack' | 'github-issues' | string;
  readonly capabilities: {
    readonly editComments: boolean;     // the activity comment is edited in place
    readonly attachments: boolean;      // upload vs link
    readonly duplicateLinks: boolean;   // native "duplicates" link
  };
  /** The tracker's real states and fields, to validate the brain's mapping. */
  describe(): Promise<{ states: readonly string[]; types: readonly string[]; fields: readonly string[] }>;
  search(q: { url?: string; text?: string; unresolvedOnly?: boolean; limit: number }): Promise<readonly TrackerItem[]>;
  board(q: { query: string; updatedSince?: string; limit: number }): Promise<readonly TrackerItem[]>;
  get(ref: TrackerRef): Promise<TrackerItem>;
  create(draft: { title: string; description: string; type?: string; fields?: Record<string, string>;
                  attachments?: readonly AttachmentRef[] }): Promise<TrackerItem>;
  /** Adds a source to an existing item: the URL in Tandemise's sources comment, plus the new context. */
  link(ref: TrackerRef, source: { url: string; title: string; context: string }): Promise<void>;
  comment(ref: TrackerRef, c: { marker: string; body: string }): Promise<{ commentId: string }>;   // create or update by marker
  transition(ref: TrackerRef, state: string): Promise<void>;
  markDuplicate?(dup: TrackerRef, of: TrackerRef): Promise<void>;
}

interface TrackerItem { ref: TrackerRef; key: string; url: string; title: string; description: string;
  state: string; assignee: string | null; updatedAt: string; type?: string }
```

Comments follow P14's rules, which already proved themselves: one comment per `(item, marker)` (`tandemise:sources`, `tandemise:activity`), edited instead of re-posted, adopted by marker after a crash, and only the signed-in user's comments are ever adopted (P14 rulings 7 and 8). Copied text is escaped and `@mentions` are broken.

**YouTrack** (`packages/integration-youtrack`, new layer-4 provider package):
- REST over `fetch`: `GET /api/issues?query=`, `POST /api/issues`, `POST /api/issues/{id}/comments`, `POST /api/commands` for state changes (`State In Progress`), the `duplicates` link type for `markDuplicate`, attachments through the issue's attachments endpoint.
- Exact-URL search is a quoted text query scoped to the project.
- Credential: a permanent token per person in the secret store. It is never in the brain repo.
- Why REST and not YouTrack's MCP server: the adapter must be deterministic and testable against a fake HTTP server. Agents can still use the MCP server as a tool.
- Prior art: none of the ~30 systems the owner surveyed integrates YouTrack, so this is a place to stand out.

**GitHub Issues** (`integration-github`, extending `GhIssueTracker`):
- Over `gh`, as P14: `gh issue create`, `gh search issues "<url>" --repo`, `gh issue list --search`, comments through `gh api` (the existing `postComment`/`updateComment`), state through open/closed plus labels the brain maps (`status: in progress` is a label).
- No attachment upload (GitHub has no API for issue attachments): attachments become links, or inline images as artifact links.

#### 6.1 Creating and linking

- **Create:** title from the signal; description is the signal's description, then a **Sources** section (`- Sentry · acme/web · 132 events, 41 users · <url>`), then "Recorded by Tandemise from <source>, reported by <reporter>." Type and fields come from the source's `create` rule. Attachments are uploaded or linked.
- **Link:** the source URL and a short context block (impact, reporter, first lines of the description) go into the item's `tandemise:sources` comment, which is edited in place as sources are added. When a linked signal changes in a way that matters (it reopens, the level rises, the events grow tenfold), the same comment is updated. No new comment is posted.

#### 6.2 State mapping (methodology-agnostic)

The brain maps the tracker's own states to the five Tandemise needs. Nothing else about the team's process is assumed: no sprints, no columns, no WIP rules.

```yaml
# brain: factory/tracker.yaml (file name provisional; #51 owns the layout)
tracker:
  kind: youtrack
  url: https://acme.youtrack.cloud
  project: ACME
  board: "project: ACME #Unresolved sort by: updated desc"
  states:
    ready: [Open, Submitted]       # where intake creates; what the board offers to Start
    in_progress: In Progress
    in_review: In Review
    done: [Fixed, Done]            # the first one is what Tandemise writes
    wont_do: [Won't fix, Duplicate, Obsolete]
  onComplete: in_review            # in_review | done: what Tandemise writes when a mission completes
```

- On load, the daemon calls `describe()` and refuses a mapping that names a state the tracker doesn't have, in plain words, in the project's settings ("YouTrack has no state 'In Review' in ACME. Its states are: …").
- `in_review` may be absent; then `onComplete` must be `done`.
- **A project with no tracker configured has no intake.** Runners can't be switched on, and a push answers `409 "Set this project's tracker first."` See "Migration from P14" for existing users.

### 7. From tracker item to mission: Start

**The board.** A new desktop screen, **Board** (`screens/Board.tsx`), replaces the Backlog as the place to choose work. It lists the tracker items the brain's `board` query returns, grouped by mapped state (Ready, In progress, In review). Each row shows: key, title, source chips ("Sentry · 132 events", "Slack thread"), assignee, the linked mission's status if any, and **Start**. **Check sources now** runs every due runner and refreshes the board. The board is a local cache (`tracker_items`), refreshed on the scheduler tick (every 2 minutes by default) and on open. Tandemise never reorders or edits it.

An **Intake** tab next to it lists every recorded signal with its status and reason (held back, needs decision, linked to ACME-12, closure failed), so "everything entered is recorded" is visible.

**Start** (`POST /v1/tracker-items/:ref/start`, the Board's button, or `tandemise start ACME-12`):

1. Take the `('tracker_item', ref)` claim (or, without the server, re-read the item and refuse if it is already in a mapped in-progress state).
2. Read the item fresh: title, description, Sources, and the linked signals' recorded context.
3. Create the mission through `MissionService.create` (`packages/application/src/services/mission-service.ts:124`), the only way a mission is made, as P14 does. The changes:
   - `origin` gains `trackerItemId` (new `missions.tracker_item_id` column), alongside `routineId` and `issueLinkId`.
   - **Goal:** the item, attributed and quoted as data: "YouTrack ACME-12, started by you: <url>. The task as written in the tracker: …", followed by each source's context.
   - **Done when:** parsed from the description with P14's `parseIssueCriteria`, generalised to `parseCriteria` (`packages/domain/src/entities/issue.ts`), and recorded as coming from the tracker.
   - **Workflow:** from the brain's mapping by item type (`Bug → fix-bug`) when present, else the project's default.
   - **planNow:** true when criteria were found, because the person pressed Start and the P6 readiness gate passes. With no criteria, the mission opens as a draft in refinement. That is still the person's started work, and they refine it there. It is **never queued** for the P7 pull.
4. **After commit:** transition the item to `in_progress`, assign it to the starter when the person has set their tracker login in their local settings (personal, not in the brain), and post the activity comment.

**How the tracker shows progress.** Linear's agent sessions stream every step into the issue; trackers like YouTrack have nothing like that, and every tool call as a comment would be noise. Tandemise keeps **one `tandemise:activity` comment** per item and edits it at milestones:
- started (by whom, the mission link);
- plan approved (the steps, as a checklist);
- each step started, held (#50), waiting for a person, done;
- pull request opened (the link);
- completed (the P5 criteria table, as P14's completion comment).

Edits are throttled to at most one a minute; the last state always lands. Fine-grained "what is it doing now" stays in the app (the "Now" line, #50). A tracker without editable comments (`capabilities.editComments` false) gets a new comment only at started, PR opened and completed.

**State write-back:**

| Mission event | Tracker state written |
|---|---|
| Start | `in_progress` |
| A pull request is opened and waits for a person, or the mission waits on a final human review | `in_review` (if mapped) |
| Mission COMPLETE | `onComplete` (`in_review` or `done`) |
| Mission cancelled | back to the first `ready` state, with a note in the activity comment |

A person changing the state in the tracker always wins. Tandemise writes only on its own transitions, and never moves an item backwards except on cancel.

### 8. Closing the loop

**Closure is triggered by the tracker item reaching a mapped `done` state**, seen on the board refresh, whether Tandemise wrote it or a person did. This keeps the tracker as the single truth: work done by hand closes the loop too. A `wont_do` state closes with the wording "not planned" where the source has it, or not at all (configurable per source, default: nothing goes out).

For each signal linked to the item, one closure row is written (`closure_pending`) and handed to the runner's `close`:

| Source | Closure |
|---|---|
| GitHub issue | A comment ("Fixed in <PR link>; tracked as ACME-12."), then close. P14's guard holds: close only when the source's "close" setting is on. |
| Sentry | Resolve in the fixing commit (`statusDetails.inCommit`) when the merge commit and repository are known and the repo is linked in Sentry, else "resolve in next release" (`inNextRelease`). A regression later reopens it in Sentry, and the runner sees it again as the same fingerprint. |
| PostHog | Mark the error-tracking issue resolved. Signals that aren't error issues (an insight, a survey) close with nothing to write. |
| Slack | One reply in the thread: "Done: <title> · ACME-12 · <PR>". Plus the reaction swap (`:eyes:` → `:white_check_mark:`), if on. |
| Discord | One reply to the original message, same words. |
| Custom | Published on the closures feed (§2) for the runner to act on and acknowledge. |

- Closures are idempotent: one per `(signal, kind)`, with the external id stored (P14's comment pattern).
- Failures retry with backoff (1 minute up to 1 hour), then stay `closure_failed` with the source's own error words, visible in the Intake tab with **Retry**.
- With several daemons, the closure runs under the source's claim. Without a server, a duplicate Slack reply is prevented by checking the thread for Tandemise's own reply before posting.

### 9. Where state lives

Local SQLite, additive migration (`packages/persistence/src/migrations/022_intake.ts` or the next free number). These tables are **the same shape the server (#54) will hold**, so a team can move them later without reshaping anything.

| Table | Holds | Moves to the server? |
|---|---|---|
| `intake_sources` | local enablement per source, poll state, last error, secret refs, who switched it on | no (rules come from the brain; credentials stay local) |
| `intake_tokens` | custom-source token hashes and scopes | yes (access) |
| `intake_signals` | one row per fingerprint: latest text, impact, counts, status, reason | no (re-derived from sources per daemon) |
| `intake_attachments` | signal → artifact or URL | no |
| `tracker_items` | board cache: ref, key, title, state, assignee, url, updated_at | no (the tracker is the truth) |
| `intake_links` | signal ↔ tracker item: `pending\|done`, `linkedBy: created\|url\|source_is_item\|similarity\|person`, score | no |
| `intake_closures` | per `(signal, kind)`: state, attempts, external id, last error, closed_at | no |
| `tracker_comments` | per `(item, marker)`: comment id, last body (P14's `issue_comments` shape) | no |
| `coordination_claims` | `(scope, key)`, holder member, device, expires_at | **yes** (who is working on what) |
| `webhook_mailbox` | source id, received_at, headers, body, claimed_by, claimed_at | **yes** (the mailbox) |

`missions.tracker_item_id` references `tracker_items`, `ON DELETE SET NULL`.

The application uses `CoordinationPort` (claims) and `WebhookMailboxPort`. The local SQLite implementation ships now; #54 adds the server-backed one. Configuration (sources, filters, tracker, state map) lives in the brain repo (#51), read through the brain's config port. Secrets and personal settings (tracker login, which runners run on this machine) live only locally.

### 10. Migration from P14

P14 becomes the first runner:
- `IssueService`'s poll emits `github` signals (fingerprint `github:<owner/name>:<number>`) instead of creating drafts. Its label, interval and close settings move into the source's configuration. The `queued`, `blocked` and `completed` comments are replaced by the tracker's activity comment and the source closure.
- **A project with P14 on and no tracker configured** is offered (once, in Repositories → Issues) to use **that repository's GitHub Issues as its primary tracker**. The labelled issues then *are* the board, with no runner needed for that repository (dedupe step 2). Until the person accepts, P14 keeps its current behaviour, marked deprecated in the UI. That legacy path is removed in the release after intake ships.
- Existing `issue_links` rows migrate to `intake_signals` and `intake_links` with the same fingerprint, so already-linked issues are never re-filed. Missions keep `issue_link_id`.

## Constraints

- Everything executes locally. The server is optional, and every feature works without it; the server only adds claims and a public mailbox.
- Layer rules (`npm run check:boundaries`, `scripts/packages.mjs`):
  - ports and pure logic (contract types, `evaluateNoise`, `IntakeSimilarity`, `parseCriteria`, state mapping) in `domain`;
  - the zod contract in `api-contract`;
  - the runner registry token in `integrations-core`;
  - adapters and runners in layer-4 provider packages (`integration-github`, new `integration-youtrack`, new `intake-runners`);
  - `IntakeService`, `TrackerService` (board, Start, write-back) and `ClosureService` in `application`.
- No new native or WebSocket dependency: Node 22's `fetch` and `WebSocket`.
- The API listener stays loopback-only. The webhook listener is separate, opt-in and serves only `/hooks/:sourceId`.
- Repo artifacts are in English.

## Left to the builder

- Exact table columns, indexes and the migration number.
- The lexical similarity function's details (tokeniser, weights), as long as the offline check's fixtures pass and the thresholds stay brain-configurable.
- Exact copy, following the UI conventions ("you", plain verbs, no raw enums), and how the Board groups and filters.
- The activity comment's layout per tracker (YouTrack markdown vs GitHub markdown).
- The final brain file names, once #51 is specced.

## Acceptance

Per repo conventions: an offline check written first and seen failing, plus proof in the real app.

**Offline:** `scratch/intake-check.mjs`, added to `OFFLINE_CHECKS` (`scripts/run-checks.mjs:13`). It uses real SQLite, the injected clock, and fakes for each external system:
- a fake YouTrack HTTP server;
- the existing fake `gh` (`scratch/fake-gh.mjs`);
- a fake Sentry API;
- a fake Slack Socket Mode server;
- a fake Discord gateway.

It covers:
- **Contract.** Valid v1 accepted; unknown field rejected with the field named; v2-only field rejected by a v1 daemon; attachment limits; `https` only; a signal can't choose the project.
- **Ingest.** HTTP push with an intake token works for its source and is refused for another source; the same fingerprint twice yields one signal with count 2; the rate limit applies; CLI push and closures round-trip.
- **Noise.** Below threshold is `held_back` with the reason; the same fingerprint crossing the threshold later is created; the daily cap turns the excess into `needs_decision`.
- **Dedupe.** Local index; source-is-tracker-item; exact URL found in the tracker from another "daemon" (a second container on a fresh DB); similarity ≥ link links; the middle band produces one Inbox decision, and "Same task" links it; below creates.
- **Crash safety.** Killing the process between the pending link and the tracker call, then restarting, creates exactly one item; two containers racing produce at most one surviving item, and the duplicate is marked and merged on the next refresh.
- **Tracker.** `describe()` validation refuses a bad mapping; create / link / comment-by-marker / transition against both adapters; the sources comment is edited, never duplicated.
- **Start.** Creates exactly one mission with `trackerItemId`, attributed goal and parsed criteria; never queued; transitions to `in_progress`; a second Start, or an item already in progress, is refused; P7's pull never picks it.
- **Write-back.** Milestones edit one activity comment (throttled; the last state lands); PR opened → `in_review`; COMPLETE → `onComplete`; cancel → back to ready.
- **Closure.** A tracker item set to done by a "person" (directly in the fake) closes the loop. GitHub comments and closes only with the setting on; Sentry gets `inCommit` when a commit is known, else `inNextRelease`; Slack gets one thread reply and no second one after a restart; the custom closures feed is acked; a failure retries, then shows `closure_failed`.
- **Claims.** With the local coordination store, a second daemon's source claim is refused while the lease is live and granted after it lapses.
- **P14 migration.** `issue_links` rows become signals with the same fingerprint; a re-check files nothing.

**Real app** (`scratch/acceptance/intake/`, fresh `TANDEMISE_HOME`, daemon from this checkout, `electron-vite dev` over CDP, fakes first on the daemon's PATH / env):

| # | Scenario | Must observe in the window |
|---|---|---|
| I1 | Brain maps a fake YouTrack project; Board opens | the Board lists the fake's Ready items, grouped by mapped state |
| I2 | A fake Sentry issue with 132 events; Check sources now | one new item on the Board with a "Sentry · 132 events" chip; the fake YouTrack recorded one create with a Sources section |
| I3 | The same error reported through a Slack reaction | no new item; the existing item's chips show Slack too; the Intake tab says "Linked to ACME-…" |
| I4 | A Sentry issue with 3 events | not on the Board; the Intake tab says "Held back: 3 events in 24 h; this source needs 20" |
| I5 | A similar-but-unsure signal | an Inbox card "Is this the same as ACME-…?"; "Same task" links it |
| I6 | Start an item | a mission opens with the item's criteria; the fake YouTrack shows In Progress and one activity comment |
| I7 | The mission completes (scripted agent) | the item moves to the mapped `onComplete` state; the activity comment shows the criteria table |
| I8 | The item is set to Done in the fake tracker | Sentry resolved (`inCommit`), one Slack thread reply, the Intake tab shows both closed |
| I9 | `tandemise intake push` from a shell with a custom token | the signal appears in the Intake tab; `tandemise intake closures` lists its closure after I8-style completion |

One opt-in scenario runs against a real YouTrack instance when `TANDEMISE_YOUTRACK_URL` and a token are set, as A15 does for the real Claude.

`npm run ci` is green.

**Suggested build order** (each slice proven before the next):
1. Contract, store, HTTP/CLI ingest, the tracker port with both adapters, dedupe, Board and Start.
2. GitHub runner (P14 migration) and closures.
3. Sentry and PostHog.
4. Slack and Discord.
5. Server-backed claims and mailbox (with #54).

## Calls made without the owner

The owner gave autonomy within the pivot direction. These calls are open to correction:

- **Start happens only in Tandemise** (desktop or CLI), not by moving or assigning the item in the tracker. Assign-to-start, Linear-style, is a later option.
- **Start with criteria plans at once; without criteria it opens a draft for refinement.** Nothing from intake is ever queued for the P7 pull. P7's pull stays for missions a person queues by hand.
- **Progress is one activity comment edited at milestones** (at most once a minute), not a stream of tool events.
- **Closure is triggered by the tracker reaching `done`**, whoever moved it. `wont_do` sends nothing to the source by default.
- **Chat intake needs an explicit act** (an emoji reaction or a mention). A Slack/Discord emoji reaction acknowledgement is on by default; it is not a message.
- **Dedupe and the noise filter are deterministic and lexical** in this sub-project. Unsure matches become an Inbox decision instead of a model's guess.
- **A project with no primary tracker has no intake.** P14 users are offered their repository's GitHub Issues as the tracker; the old P14 draft path is kept one release, deprecated.
- **YouTrack goes through REST, not its MCP server**, for determinism and testability.
- **Shipped runners run inside the daemon; custom runners push over HTTP or the CLI** with a per-source token. Closures for custom runners are a pulled feed, so the daemon never calls arbitrary URLs.
- **Without the server, webhooks use a separate opt-in loopback listener behind the person's own tunnel**, never the API port.
- **Reporter email is not part of the contract** (privacy); name, handle and URL are.
- **A new `tandemise` CLI command** ships with this sub-project, as the first CLI the repo has.
