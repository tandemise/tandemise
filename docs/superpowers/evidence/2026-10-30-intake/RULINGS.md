# Intake build rulings

Decisions the builder made where the plan (`docs/superpowers/plans/2026-10-30-intake.md`)
was ambiguous or wrong, decided against the spec
(`docs/superpowers/specs/2026-10-30-intake-design.md`, which is binding).

- Ruling 1 (migration number, Task 2): the plan fixes migration 024 and says to stop
  unless 022 (hold-and-interact) and 023 (brain) are on `main`. Neither exists on any
  branch yet, and `assertOrdered` requires a contiguous list, so 024 cannot run without
  a placeholder, which the plan forbids. The spec allows "`022_intake.ts` or the next
  free number", so intake takes the next free number on its base: **022**
  (`022_intake.ts`). The migration depends on nothing from 022 or 023. At integration,
  whichever of #50, #51 and #52 merges later renumbers to the next free number. That is
  a file rename plus the `version` field, and no shipped database has the number yet.
  Checks read the expected version from the migration list instead of hard-coding 24.
- Ruling 2 (push body, Task 1): the plan's `intakePushBody = z.union([intakeSignalV1Raw, batch])`
  with `intakeSignalV1Raw` as the full signal schema would answer a single bad signal with
  a 400 union error, yet Task 3 records an invalid signal as `rejected` (202). So
  `intakeSignalV1Raw` is the envelope `{ schema: string }` with passthrough: the body only
  tells one signal from a batch, and every signal, single or batched, is then checked on
  its own by `validateIntakeSignal(input)`. That helper never throws and returns either
  the parsed signal or `{ reason, issues, fingerprint, title }` (issues in the router's
  `formatZodIssues` style, fingerprint and title kept when they could be read), which is
  what Task 3 needs to record the rejection. `pushedSignals(body)` lists the signals of
  either form.
- Ruling 3 (size limits stay on the shape, Task 1): the 1 MB per attachment and 5 MB per
  signal limits are refinements on the `attachments` field, not on the signal object, so
  `intakeSignalV1` stays a strict `ZodObject` with a `.shape` (the check compares it with
  the JSON Schema's properties). The JSON Schema says the per-signal total in its
  description, since JSON Schema cannot sum.
- Ruling 4 (config files, Task 1): the plan leaves these to the builder, decided from the
  spec: every config object is strict (a typo in a brain file is refused, not ignored);
  `tracker.url` follows the same rule as a source's `api` (https, or http on loopback
  only, for fakes and self-hosted); a youtrack tracker needs `url` and `project`, a
  github-issues tracker needs `repo`; `onComplete: in_review` needs a mapped `in_review`
  (spec §6.2); source ids are unique; `similarity.ask` must not exceed `similarity.link`.
  `occurredAt`, `impact.firstSeen` and `impact.lastSeen` are ISO 8601 with an offset, so
  `mergeImpact` can compare them as strings.
- Ruling 5 (views, Task 1): `IntakeSignalView` and `IntakeSourceView` have no fields in
  the plan. Task 1 gives them the fields the Intake tab and Settings need (Task 14) from
  the Task 2 table columns; later tasks may add fields, additively.
- Ruling 6 (the store's edge cases, Task 2): decided from the spec's "idempotent by key"
  and "a person's change wins":
  - `upsertSignal` takes `IntakeSignalInput`, a domain mirror of `IntakeSignalV1`
    (domain and persistence cannot import `api-contract`). `api-contract` asserts at
    compile time that a parsed signal is assignable to it.
  - `recordRejected` on a fingerprint already in the pipeline returns that signal
    unchanged: a bad repeat never undoes a good signal. A later valid push of a
    `rejected` fingerprint resets it to `received` with `firstTime: true`, keeping its
    occurrences. A rejected row stores `''` for the instance, key and url it could not
    read, and the kind from the fingerprint's prefix when that is a valid slug.
  - `intake_links.item_ref` is nullable: a pending link for a create has no ref until
    the tracker answers (`completeLink` sets it). `createdToday` counts pending creates
    too, so the cap holds across a crash.
  - `TrackerItem`, `TrackedItem`, `TrackerRef` (branded) and the comment markers live in
    `packages/domain/src/entities/tracker.ts` now, so Task 4 extends that file instead
    of moving them. `TrackerItem.createdAt` is stored as `upstream_created_at`.
  - `intake_attachments` also has `created_at`/`updated_at` ("every table unless noted").
  - The mailbox keeps acked rows (`done_at`) and has no stale-claim sweep yet; a claim
    left by a crash stays claimed until whoever owns the listener (Task 11) releases it.
- Ruling 7 (push scope and refusals, Task 3): decided from spec §1 "Text is data" and §2 "Auth":
  - A push whose signal names a source (`source.kind`, `source.instance`) other than the
    scope's configured source is refused whole, before anything is recorded: with an
    intake token as `PERMISSION_DENIED` "This token can only push to '<id>'." (the plan's
    sentence), with the daemon token as `PERMISSION_DENIED` "Signals for '<id>' must name
    it as their source (<kind>, <instance>)." A token used with `?source=` or `?workspace=`
    naming anything else gets the token sentence. With the daemon token the push must name
    `?workspace=&source=` (400 otherwise); the CLI fills `workspace` itself.
  - Refusal order for a push: project, tracker (409), source (404), source named by a
    signal (403), rate limit (429). The rate limit counts signals and takes a batch all or
    none, so a refused batch uses none of the minute; it is keyed by the token id, and
    daemon-token pushes by `(project, source)`. The window is in memory (a restart forgets
    it).
  - The unreadable-signal fingerprint hashes `JSON.stringify` of the signal as pushed. A
    repeat push adds only attachments not already recorded (same name and blob or url).
  - `INTAKE_BLOBS` defaults to a working in-memory store (`MemoryBlobs`), as the plan says,
    unlike `EVAL_BLOBS`' failing default; the daemon rebinds it to `paths.intakeBlobs`.
  - The router gains a `status` route option so the push answers 202; nothing else changes
    status. `IntakeService.configure` and `ingestMany` take the body unparsed and parse it
    themselves, since the file schemas fill defaults (zod input and output differ).
  - `GET/PUT …/intake/config` answer `IntakeConfigView` (`origin`, `editable`, the config).
    A PUT when the source cannot write (the brain) is `PRECONDITION_FAILED` "This project's
    intake is set in its brain. Change it there." Minting needs a seat and a configured
    source (the 404 sentence). Revoking needs the daemon token only: the token port has no
    lookup by id to find the project's seat.
  - The CLI prints `<fingerprint>: <status>` per result, then the reason, indented, on its
    own line when there is one.
- Ruling 8 (the tracker port and the YouTrack adapter, Task 4): decided from spec §5, §6 and §6.1:
  - The port is spec §6's plus the plan's additions: `comment(ref, { marker, body, knownId? })`,
    `viewer()`, optional `assign?`, and optional `refFromUrl?(url): TrackerRef | null` for
    Task 7's "the source is the tracker" step (spec §5 step 2). `link` takes a `SourceEntry`
    `{ url, title, context }`. `AttachmentRef` is `{ name, mediaType, url?, content? }`: an adapter
    uploads only what has `content`; a URL-only attachment is the caller's to link in the
    description.
  - The sources comment's body is built by pure helpers in `entities/tracker.ts`:
    `sourcesCommentBody(entries)` and `sourcesCommentWith(existing, source)`. Each entry is
    `- <title> · <url>` with its context (at most 6 lines) indented as `  > …`; title and context
    are escaped with `escapeForComment`, so @mentions are broken. A URL already listed has its
    entry replaced in place. `parseSourcesSection` reads the last URL of each `- ` line under
    `## Sources`, in a description or in that comment alike.
  - `stateMappingProblem` checks every named state first (in the order ready, in_progress,
    in_review, done, wont_do), then the in-review rule. The tracker reads as "YouTrack" or
    "GitHub", the place as the project or the repo.
  - `titleTokens` lands now in `entities/similarity.ts`, exactly as Task 6 defines it, because
    the YouTrack text search sends those words; Task 6 adds the scorer to the same file.
  - The YouTrack module contributes its `PRIMARY_TRACKER_FACTORIES` entry now (the plan lists that
    under Task 5), so the new package is not an empty module; Task 5 only adds GitHub's. The
    factory refuses with `PRECONDITION_FAILED` when the URL, project or token is missing.
  - `board({ updatedSince })` filters on the client: the team's board query is sent as written.
    `search({ text })` with no words left after tokenising returns nothing rather than every item.
  - The fake marks an item `Duplicate` (resolved) when it receives `duplicates KEY`, as YouTrack's
    default workflow does.
- Ruling 9 (YouTrack command values, Task 5): a YouTrack command reads a space as the start of
  its next word, so every value the adapter puts in a command (state, type, field values,
  assignee) is braced when it holds a space: `State {In Progress}`, `Subsystem {Web App}`; a
  single word stays bare (`Type Bug`, `Assignee ana`). The fake parses braced values and refuses
  an unbraced multi-word value (`State In Progress`), as YouTrack would misread it. The observable
  result is unchanged: the item's state reads `In Progress`.
- Ruling 10 (GitHub Issues and the resolver, Task 5): decided from spec §6 and §6.2:
  - `GhPrimaryTracker` ignores a draft's `type` and `fields` (GitHub has none; `describe()` reports
    `types: []`, `fields: []`) and its attachments (`capabilities.attachments` is false; the caller
    links them). `stateLabels` are the mapped states but `open`/`closed`, once each, in the
    mapping's order (ready, in_progress, in_review, done, wont_do). `transition` to a state that is
    neither `open`, `closed` nor a mapped label is refused (`VALIDATION`); labels are sent one flag
    each, since `gh` splits a comma-joined value. `search({ url })` asks `gh search issues` for the
    same fields as every read (not only `number,url,title,state`) so it returns whole items;
    `search({ text })` lists `--state open` only with `unresolvedOnly`, `all` otherwise; `board`
    sends the team's query with `--state all` so the query decides. `assign` is
    `gh issue edit --add-assignee`. A missing issue (gh's "Could not resolve to an issue") is
    `NOT_FOUND`. `refFromUrl` matches `https://<host or github.com>/<repo>/issues/<n>`, the repo
    compared case-insensitively. The factory needs `repo` (`PRECONDITION_FAILED` otherwise) and no
    credential: `gh`'s sign-in is it, as in P14.
  - The secret store hands back opaque refs (`<backend>:<name>:<id>` in every daemon backend) and
    intake keeps no table for one ref per project, so `TrackerResolver` finds the credential by
    name among `list()`'s refs (`:intake:<ws>:tracker:`), the last one listed winning.
    `saveCredential(ws, value)` stores a new one, removes the older refs and drops the cached
    tracker. The cache key is the config's JSON plus the credential's sha256.
  - An unknown kind is `PRECONDITION_FAILED` "Tandemise can't use '<kind>' as a tracker yet."
  - `PUT …/intake/config` (now async) checks a tracker it is given with
    `TrackerResolver.problemWith(ws, tracker)` before saving: a mapping naming a state the tracker
    lacks, or an unknown kind, is refused as `PRECONDITION_FAILED` with that sentence and nothing is
    saved. When the tracker cannot be asked yet (no credential saved, unreachable) the config is
    saved unchecked and the reason is logged (`intake.tracker_unchecked`): the credential is saved
    on its own, so a person must be able to set the tracker first. `validate(ws)` checks the saved
    config and throws what the tracker throws.
- Ruling 11 (the noise filter's edges and the scorer, Task 6): the plan's table is pinned row by
  row; where it is silent, decided from spec §4.1 ("a source with no `filter` passes everything",
  reasons "in plain words"):
  - A rule the signal carries no data for (no `impact.level`, `impact.users` or `impact.lastSeen`,
    or a `lastSeen` that does not parse) does not hold it back: the filter holds back only what it
    can show is under the bar. `minEvents` always applies, since events fall back to the
    occurrences Tandemise counted.
  - An `ignoreTitles` substring ignores case. `/re/flags` is a regular expression; one that does
    not compile matches nothing instead of failing the pipeline (the rules are the team's
    configuration, never a signal's text).
  - Reasons: `N events; this source needs M` when the source sets no window (`in 24 h` only with
    one); `1 event` and `1 person affected` in the singular; the window reads `1 h`, `24 h`,
    `7 days`; an age reads in whole days past a day, whole hours past an hour, else minutes.
  - The table's `0.84` is consistent with the formula (tokens `typeerror read id undefined` vs the
    same plus `checkout`: Jaccard 4/5 = 0.8, same error type: 0.8 × 0.8 + 0.2 = 0.84), so neither
    changed. Two titles with no tokens score 0, and an empty signal URL never matches a
    description. `titleTokens` from Task 4 already matched the plan and is unchanged.
  - `IntakeSimilarity.score` takes the signal's `title`, `description` and `url`, and the
    candidate `TrackerItem`; `lexicalSimilarity` reads only the candidate's title and description,
    so it also scores the board cache's `TrackedItem`.
- Ruling 12 (the pipeline, Task 7): decided from spec §4, §5 and §6.1:
  - A pending link for a create stores a **null** `item_ref` (Ruling 6's nullable column), not the plan's
    `pending:<signalId>` pseudo-ref: a pending link with no ref *is* a pending create, everywhere
    (`#finishPending`, the check). `completeLink` sets the real ref.
  - `ingest` answers with what was recorded and queues the pipeline in the background, one signal at a
    time per project (`settle()` waits for it, as `IssueService`'s): a slow tracker never holds a runner's
    push open. A repeat's answer therefore carries the reason it still waits (the daemon check's CLI case
    now accepts the `Couldn't reach …` line under the status).
  - A pending link is finished first on any pass over its signal, whatever the status: a crash in
    `decide` leaves `needs_decision` with a pending link, and recover must still finish it. A pending
    create searches `{ url, unresolvedOnly: true }` and adopts the oldest unresolved hit (ties to the
    lower key, as Task 8's merge keeps); only with no hit does it create. Exact-URL dedupe (step 2.3) picks
    the same way. "Unresolved" is the tracker's flag plus the mapping: a state in `done` or `wont_do` never
    counts as a hit or a candidate.
  - The tracker's text search wants every word (YouTrack and GitHub alike), so a candidate whose title
    lacks one of the signal's words is never found by the full title (the plan's own case: ACME-1's title
    plus " in checkout"). When the full-title search finds nothing at or above `ask`, one broader search with
    the title's first ⌈ask × n⌉ tokens follows. Both searches are `unresolvedOnly`, top 20.
  - "Last count written" needs a record: `intake_links` gains a nullable `written` JSON column
    (`{ level?, events?, itemResolved? }`) in 022 itself (unshipped; Ruling 1), set when a link completes
    and when the sources comment is updated. A change matters when the level rises, the events reach 10×
    the written count, or the board cache shows the item resolved and the last write did not. A
    `source_is_item` link writes nothing and is never updated. A failed update leaves the signal `linked`
    (not `received`) and is retried on the next reading, since `written` did not move.
  - Text: the description is escaped line by line with `escapeForComment` (mentions broken, markers
    defused), and a line that reads as a `Sources` heading is escaped as `\## Sources`, so a signal cannot
    add URLs to what exact-URL dedupe matches. The title only has its mentions broken (it is one line, not
    markdown). URL attachments are listed under `Attachments:` before the Sources section; inline ones
    are uploaded when the tracker takes uploads, otherwise named there.
  - Sentences the plan leaves open: `decide('same')` on a signal with no candidate (the daily cap's) is
    `PRECONDITION_FAILED` "There is no task to link this to. Choose New task or Not work."; `retry` on a
    signal that is not `received` is `PRECONDITION_FAILED` "Only a signal that is waiting for the tracker
    can be tried again." A tracker error's message loses its trailing period inside "Couldn't reach
    <YouTrack|GitHub>: <message>. Tandemise will try again." A failure while deciding leaves the signal
    `received` with that reason and its pending link, which the retry finishes.
  - The daily cap counts from the UTC day start. `ProjectionTopic` gains `'intake'`, so the desktop's
    `TOPIC_KEYS` gains its line (it is an exhaustive record).
- Ruling 13 (the board and Start, Task 8): decided from spec §3, §7 and §9:
  - **The cache keeps what is pointed at.** A refresh forgets an item the board query no longer returns,
    except one a mission (in any status) or a signal's link points at: forgetting it would null
    `missions.tracker_item_id` and drop the signal's chip. `TrackerService` passes those refs in `keepRefs`, so
    `removeMissing` keeps its plain meaning (the store check still pins it). A kept item the cache still holds as
    unresolved is read again (`get`) on each refresh so its state stays true; once cached as resolved it is not
    read again until the query returns it. The board lists the cached items in a mapped ready, in-progress or
    in-review state.
  - **Duplicates.** Unresolved items joined by any shared Sources URL are one group; the oldest survives, ties to the
    lower key. Each newer one has every URL of its Sources section linked to the survivor (its signal's own entry
    when this daemon has the signal, else `Merged from <key>` with the item's title), is marked its duplicate (or
    moved to the first `wont_do` state without `markDuplicate`; with none mapped it is left and logged), and this
    daemon's links move over. A daemon that finds a kept item turned `wont_do` searches the tracker by its linked
    signal's URL for the oldest other unresolved item and moves the links there. Each moved signal keeps its
    status and reads "Merged <newer> into <older>; same source."
  - **The race check delays the create, not the search.** The fake waits before it reads its state, so a delayed
    search would see the other daemon's item and link to it. Delaying the first `POST /api/issues` lets both daemons'
    searches miss; `delayNext` gained an optional method. The check runs the race twice so both paths are pinned:
    the merging daemon owns the survivor (the other follows), and the merging daemon owns the duplicate (it moves
    its own link).
  - **Start.** One Start or refresh at a time per project, so a second Start of an item waits and finds the first's
    mission. Order: a cached item's open mission, the fresh `get`, its open mission again, in progress, the claim;
    a resolved item is not refused (the plan is silent). The claim is released when creating the mission throws.
    A key not cached is read as `youtrack:<KEY>` or `github:<repo>#<n>` (`#42` and `42` alike).
  - **Words.** The goal names the starter by their person's display name. It leaves out an empty description and an
    empty Sources list, each source reads `- <label> · <instance> · <signal title> · <impact words> · <url>`, and a
    goal past 8000 characters ends in `…`. Start writes only the activity comment's first line,
    "Started in Tandemise by <starter>: <mission title>." (Task 9's), and only when the item has none yet. The
    tracker login is the local setting `trackerLogins: { <workspace>: <login> }`. Failures after the commit are
    noted on the mission: the plan's "Couldn't move <key> to <state> in <label>: <message>.", and likewise
    "Couldn't assign <key> to <login> in <label>: <message>." and "Couldn't comment on <key> in <label>: <message>."
    The tick tries again once a minute while the mission is open and the item is still ready and never written, or
    has no activity comment.
  - **The board.** `refreshedAt` is the last refresh in memory, else (after a restart) the newest cached row's.
    A refresh never throws for the tracker: `problem` reads "Couldn't reach <label>: <message>. Tandemise will try
    again." (or "Set this project's tracker first."). Chips: `N events` when the signal counts events, `thread` for
    Slack and Discord, `#<key>` for GitHub, else its impact words or instance; a `source_is_item` link has no chip.
    Board changes invalidate the `intake` topic. The CLI's `start` needs the daemon token: "An intake token can only
    push signals. Start from the machine running Tandemise."
  - **PLANNING.** In the in-process check no planner runtime is composed, so the preset plans the mission inside
    `create` and Start answers `AWAITING_PLAN_APPROVAL` rather than `PLANNING`. The check asserts it left DRAFT
    through planning and was never queued.
- Ruling 14 (write-back and the activity comment, Task 9): decided from spec §7 and Review Focus 3:
  - `activityCommentBody` returns the body **without** the `<!-- tandemise:activity -->` line the plan lists first:
    the adapters' `comment()` already puts the marker line first (as for the sources comment), and a second one
    would be written. Every other line is the plan's, in its order. "Done in Tandemise — <n> of <m> criteria
    verified." always says "criteria" (the plan's sentence, `1 of 1 criteria`); the table is P14's, now shared as
    `criteriaResultTable` in `entities/issue.ts`, which `completedCommentBody` also uses.
  - Step lines from task status (`activityStepState`): SUCCEEDED or SKIPPED is done; AWAITING_INPUT, AWAITING_HUMAN or
    AWAITING_APPROVAL is "waiting for a person"; BLOCKED or FAILED is "held" (the closest to #50's hold until it
    lands); RUNNING or AWAITING_EXTERNAL is running; PENDING, READY and CANCELLED are still to do. Steps are listed
    once the plan is approved (the mission is past DRAFT, PLANNING and AWAITING_PLAN_APPROVAL), in the tasks' order.
  - Start no longer writes its own first line: it calls the same derivation as the pass, so the body is derived from
    state everywhere. `#retryStartWrites` retries only the move and the assignment; a missing comment is the
    write-back pass's (every 5 s; a failed item waits 60 s).
  - An item's latest mission speaks for it (the open one, else the newest). The pass moves the state first, then
    writes the comment. A due move (from the cache) is re-checked against a fresh `get` before transitioning, so a
    person's change made since the last board refresh still wins. The cancelled line ("Stopped in Tandemise; moved
    back to <ready>.") is written only when the item is in the ready state Tandemise wrote: when a person moved it
    first, the comment claims no move. A finished mission whose last state has landed is not read again until a
    restart.
  - Throttle: an edit waits until 60 s after the stored comment's `updated_at`; a missing comment is posted at once.
    Without `editComments`, a new comment (no `knownId`) is posted only when the milestone (started, pull request,
    completed) differs from the one the stored body was written at (`activityMilestoneOf`, which reads only lines
    Tandemise starts), with no edits in between; a cancel posts nothing there (the spec names three milestones).
  - `deliveryLinks(artifacts, missionId)` (`support/delivery-links.ts`) takes the artifact repository and tags each
    link `pr` or `branch`; P14 reads only `label` and `url`, so its comments are unchanged.
- Ruling 15 (the runner port, the host and P14's move, Task 10): decided from spec §2, §3 and §10:
  - **The port.** The domain cannot import the zod contract, so a runner pushes a `RunnerSignal` (the domain
    mirror `IntakeSignalInput` plus `schema`) and gets a `RunnerPushResult` (field for field `IngestResultView`);
    the pipeline validates every push against `tandemise.intake/v1` all the same. `fromWebhook(req, ctx)` and
    `close(closure, ctx)` both take the context (both need the source's secrets), `fromWebhook` may answer a
    promise, and a delivery's body is the mailbox's `Uint8Array`.
  - **Runner pushes are not rate-limited.** Spec §2's 60 a minute is per token, for pushes from outside; a poll
    of 100 labelled issues is not one. `IntakeService.ingest` gains `{ fromRunner: true }`, used only by the host.
  - **Which sources run.** A configured source runs when its project has a tracker and a shipped runner reads its
    kind, unless this machine switched it off: an `intake_sources` row with `enabled: false`. The host's first
    write of a source's row (`last_checked_at`, `last_error`, the cursor) creates it enabled. A custom kind has no
    runner and is never flagged by the tick: it pushes over HTTP or the CLI.
  - **Claims.** A refused source claim skips silently and is asked again no sooner than 30 s; a started socket
    runner's claim is asked every 30 s, and a refusal stops it. A failed poll still records `last_checked_at`
    (with `last_error`), so a broken source is retried at its interval, not every tick. A source taken out of the
    configuration, switched off, or whose project lost its tracker is stopped on the next tick; a changed source
    configuration restarts its runner.
  - **The mailbox.** The local listener's path names only the source id, so the first project (in the
    repository's order) configuring that id with a tracker takes the delivery. A delivery for an id no project
    configures is acked and logged (there is no row to hold an error); one for a source whose kind has no runner,
    or whose runner has no `fromWebhook`, is acked with "No runner for this source." on the source; one for a
    source switched off here is acked and dropped.
  - **The GitHub runner.** A title past the contract's 200 characters and a body past 20 000 are cut with `…`,
    never rejected. The reporter's URL uses the repository's host (`https://<host>/<login>`). `close` writes one
    comment per issue, marked `<!-- tandemise:closure -->` and found again among the signed-in user's comments, so
    a retry after a crash edits it rather than posting twice. `done` closes as `--reason completed` (only with
    `closeOnDone`); `not_planned` with `closeWontDo` comments "Not planned; tracked as <key>." and closes as
    `--reason "not planned"` (`GhIssueTracker.close` gained the optional reason). A key that is not an issue number
    fails without retry.
  - **`adoptAsTracker`.** It needs the repository's `githubRepo` (not P14 being on, so a second call, after P14 is
    off, is the idempotent no-op the plan asks for), waits for a check already running, and refuses with
    `CONFLICT` "This project already has a tracker. Add this repository as a source in Settings → Intake instead."
    when the project's tracker is anything but this repository's GitHub Issues, and with the brain sentence when
    the config cannot be written here. Only links read from the current `githubRepo` migrate (a link from a
    repository set before belongs to no source this project reads), keyed by the configured spelling so the
    runner's fingerprints match. The source also carries P14's label as `trigger.label`, and its `intake_sources`
    row is written enabled, `enabledBy` P14's switcher (else the adopter). `deprecated` is always true: the whole
    card is the legacy path. The mapping is not checked against the repository's labels (`describe()`): the
    `status: in progress` / `status: in review` labels must exist before Start can move an item (left to Task 14's
    Settings or the person).
- Ruling 16 (GitHub state labels, follow-up to Task 10): `adoptAsTracker` maps states to the labels
  `status: in progress` and `status: in review`, which a P14 repository usually lacks, and `gh issue edit
  --add-label` fails on a label that doesn't exist. `GhPrimaryTracker.transition` now runs
  `gh label create <label> --force` (a no-op when it exists) before adding a state label, so Start works on an
  adopted repository. `describe()` still lists only the labels the repository really has, so a mapping saved
  through Settings that names a missing label is refused as spec §6.2 says. The adopted mapping is not
  validated (Ruling 15), and its labels appear on first use. The fake `gh` gained `label create` and, like
  gh, refuses `--add-label` for an unknown label once the repository's labels are known.
- Ruling 17 (Sentry, PostHog, the listener, secrets and stale claims, Task 11): decided from spec §1, §2 and §8:
  - **The package.** `intake-runners` takes no zod (the plan's deps list has none): `http.ts` answers JSON
    unparsed and each runner reads only the fields it maps, leaving out what it can't read. A runner's
    secret is read by name through `ctx.secrets` (`token`/`clientSecret` for Sentry, `apiKey`/`webhookSecret`
    for PostHog); a missing one fails the poll with "Save the <Label> <what> for this source in Settings →
    Intake first.". Both runners set `kindHint: 'bug'`, cut long text with `…` like the GitHub runner, and
    keep only Sentry levels the contract knows (`debug` and `sample` are left out). A 401 is the plan's
    sentence; a 404 is `NOT_FOUND`; 429 and 5xx are retryable.
  - **Closures.** `not_planned` writes nothing at Sentry or PostHog (spec §8 names only `done` for both).
    A closure fails without retry on `NOT_FOUND`, a missing secret or a refused token, and with retry on a
    network failure, timeout, 429 or 5xx. `externalId` is the issue id that was resolved. A PostHog key that
    is not a UUID is "not an error issue" and closes with nothing written.
  - **PostHog's wire format** could not be confirmed against its live reference from here (no reachable
    docs). The runner uses the plan's paths and reads `occurrences`/`users` from the issue or from its
    `aggregations`, whichever is there; the fake answers the plan's shape (`{ results: [...] }`). The check
    pins the mapping. The issue's link is `<base>/project/<id>/error_tracking/<issueId>` on the API's base;
    a signal's link must be https (spec §1) and an http base is only ever loopback (the source's `api` allows
    nothing else), so such a link is written as https.
  - **Webhooks.** A Sentry delivery without `data.issue` (another resource) answers no signal. PostHog
    deliveries are one issue, or `{ issue }`. Both compare the signature or secret in constant time.
  - **The listener** answers 404 with no body for anything but `POST /hooks/<source id>` (the id spelled as
    `INTAKE_SOURCE_ID_PATTERN`), reads a body over 1 MiB to its end before answering 413 (so the sender sees
    the status, not a reset) and cuts the socket past 16 MiB. It stores the headers lowercased, repeats
    joined. `intakeWebhookPort` must be a whole number 0–65535; anything else means no listener. It is
    added to `LifecycleHost` last, so shutdown closes it first.
  - **Stale claims (Ruling 6's open point).** `WebhookMailboxPort` gains `releaseStale(claimedBefore)`. The
    host's first drain frees every claim made before it (the local mailbox has one consumer, this host, so
    such a claim is a crashed process's); later drains free only claims older than ten minutes (an ack that
    failed), so a second consumer the relay adds is never raced for a live delivery.
  - **Secrets over the API.** `PUT /v1/workspaces/:id/intake/sources/:sourceId/secret` `{ name, value }`
    (`IntakeService.saveSourceSecret`) stores the value as `intake:<ws>:source:<id>:<name>`, records the
    ref in `secret_refs[name]`, then removes the ref saved before under that name; an empty value only
    removes it. A source the project's configuration doesn't name is 404. The source's row is created
    enabled when it has none, as the host would. Task 10 left `TrackerResolver.saveCredential` without a
    route, so `PUT /v1/workspaces/:id/intake/tracker/secret` `{ value }` (`saveTrackerSecret`) saves it for
    Settings → Intake (Task 14). Both answer 204 and need a seat in the project.
- Ruling 18 (Slack and Discord, Task 12): decided from spec §1, §2, §3 and §8:
  - **The reply address.** The contract's `reply` is the strict `{ address }`, so the plan's
    `{ channel, thread_ts }` and `{ channelId, messageId }` are written as `address: '<channel>:<thread_ts>'`
    and `'<channelId>:<messageId>'`, the same shape as the key. `close` reads the address, else the key.
  - **Only the source's channel.** An event files something only in the instance's channel (Slack names it by
    id or by name, looked up once through `conversations.info`; Discord by guild and channel id). A reaction on
    a Slack reply files the whole thread, keyed by its root. The title is the root's first line, mentions taken
    out (and Slack's `&amp;`/`&lt;`/`&gt;` undone); the reporter is the person who reacted or mentioned. The
    description's `**<user>:**` is Slack's user id (no `users.info` call per message).
  - **Acknowledgement and swap.** No configuration field switches them, so both are always on (the spec's
    "on by default"). Slack puts `:eyes:` on the thread's root and swaps it for `:white_check_mark:` on `done`;
    Discord puts 👀 on the message and only replies on close (spec §8 names no swap there). A reaction that
    fails is logged and never fails the filing or the closure; "already there" and "not there" are fine.
  - **What closes.** `closeOnDone` is GitHub's guard (spec §8), so a chat source always replies on `done`.
    `not_planned` writes nothing unless `closeWontDo`, then "Not planned: <title> · <key>", found again the
    same way. The own-reply check (Review Focus 5): Slack reads the whole thread (up to ten pages of 200) for a
    message by `auth.test`'s `user_id` or `bot_id` starting with the reply's prefix; Discord reads the messages
    after the original (up to ten pages of 50) for one by `/users/@me` referencing it. The Discord reply sends
    `allowed_mentions: { parse: [] }`, so a title can never ping anyone (text is data).
  - **Sockets.** One `SocketLoop` for both: backoff 1 s doubling to 30 s on real timers, back to 1 s after a
    socket that delivered anything. Slack acks every envelope before any work and reconnects on `disconnect`.
    Discord beats at the asked interval, opens a new socket when a beat goes unacknowledged or on op 7/9, and
    identifies afresh each time (no resume: an event in the gap is missed, and the person reacts again). Events
    are filed one at a time per source. `SourceHttp` gained the `Bot` scheme (Discord) and a body-less send.
  - **Open point.** A missing secret or a refused token at connect is logged and retried with the backoff, but
    is not on the source's `last_error`: the host records only what `start` throws, and secrets are read
    asynchronously. Surfacing it needs a way for a socket runner to report (Task 14's Settings → Intake).
  - **The fakes** take the same `/_fake/…` doors as `fake-sentry.mjs` (`messages`, `emit`, `drop`, `state`)
    and a script mode (`--port 0 --state <dir>`, `<dir>/url`, `state.json`) for the acceptance run.
- Ruling 19 (closing the loop, Task 13): decided from spec §2, §3 and §8:
  - **What closes.** `detect` runs after every successful board refresh (the tick's and `refreshBoard`'s) over the
    project's cached items, so an item the board query no longer returns but a link keeps (Ruling 13) is seen done
    too. Only a `done` link closes: a pending one has not reached the tracker, and a `source_is_item` link is the
    item itself. A signal already in a closure status keeps it (a refresh never sets a closed signal back to
    `closure_pending`). A `wont_do` item writes `not_planned` closures only for sources with `closeWontDo`.
  - **Where it runs.** `ClosureService.tick` runs from `syncIntake`, one pass at a time, and hands each due closure
    to `IntakeRunnerHost.close`, which reuses the runner's context (its secrets) and asks the source's claim first.
    The host answers null, and the closure waits untouched (no attempt counted), when no shipped runner closes that
    kind (a custom source: its feed), the source is switched off on this machine, or the claim is refused. A source
    the project no longer configures fails at once: "This project no longer reads this source." A runner that
    throws counts as a retryable failure. A crash while storing the result leaves the closure as it was; the
    runner's own-reply check makes the next attempt write nothing twice.
  - **The closure's facts.** The item's mission is its open one, else the newest. `prUrl` is its first pull request
    (`deliveryLinks`); `commit` is the `git.commit` ref of its newest artifact, with the repo from
    `githubRepoFromRemote` of the mission's repository, else null. The failure reason keeps the source's words as
    they are: "Couldn't close at Sentry: Sentry answered 500 to PUT /api/0/issues/103/."
  - **Retry and the feed.** `retry` takes a pending or failed closure back to pending, due now, attempts 0, the
    signal `closure_pending`; a closed one is `PRECONDITION_FAILED` "Already closed at <Label>." The feed's view
    adds `state`, `lastError` and the signal's `reply` (the address a custom runner set and needs back to reply)
    to the plan's fields. The daemon token names `?workspace=&sourceId=` (400 otherwise, as a push); an intake
    token reads only its own source (403 "This token can only read the closures of '<id>'."), and acks only its
    own source's closures: any other is `NOT_FOUND` to it. An ack of a closed closure changes nothing; `ok:false`
    without `error` fails it as "The runner could not close it." Retry is daemon-token only (the listener's
    intake paths leave it out). The repository port gained `closures.get(id)`.
  - **The CLI** prints `<id> <fingerprint> <state>` per closure, and the acked closure's line after `--ack`;
    `--error` without `--ack` is a usage error.
- Ruling 20 (the desktop and the real-app proof, Task 14): decided from spec §2, §7, §8 and the acceptance table:
  - **Ports.** The harness uses `CDP_PORT=9352` and `ACCEPTANCE_LINK=/tmp/tdm-intake`, not the plan's 9351:
    another feature's harness runs on the ports next to it.
  - **Configuration.** The brain (#51) is not on main, so `run-all` sets the project's intake through the
    daemon's own routes (`PUT …/intake/tracker/secret`, `PUT …/intake/config`, `PUT …/sources/:id/secret`), the
    same path Settings → Intake writes; nothing is written to `settings.json` by hand. The fake YouTrack gained a
    `/_fake/…` door (seed an issue, a person's edit, the recorded state), like the Sentry and Slack fakes.
  - **One item for I6–I8.** Sentry's `inCommit` needs the item's mission to have a commit (Ruling 19), so I6
    starts the item Sentry filed in I2 (and Slack linked in I3), after a person writes its "Done when" in
    YouTrack, and I7 and I8 complete and close that same item. The project's checkout has its GitHub remote
    (acme/web) before it is registered, since the remote is read then, and runs an "Intake fix" workflow whose
    build step works in a worktree, so the mission has a commit. I9's "I8-style completion" is the item set to
    Fixed in the fake: the trigger is the tracker reaching done, whoever moved it (spec §8).
  - **Words the plan did not list.** `received` reads "Waiting for the tracker" with **Try now** (the retry
    route); `closure_pending` reads "Done in <key>; closing at <Label>". A failed closure's reason is already the
    daemon's "Couldn't close at <Label>: …" (Ruling 19), so it is shown as it is rather than as
    "Couldn't close: Couldn't close at …". The Board's mission line is "Mission: <status in words>"; a disabled
    Start's title is the daemon's `startable.reason` ("Has a mission", "Already in progress").
  - **Retry for a closure.** `IntakeSignalView` carries no closure id, so **Retry** reads the source's closures
    feed with the daemon token and retries the one for that fingerprint; no route or view was changed.
  - **Settings → Intake.** It sits in Settings (for the selected project), reached from the Board's empty state
    at `/settings/intake`, which opens the page scrolled to it. No route switches a source off on this machine
    or serves `IntakeSourceView`, so a source's switches are its configuration's `closeOnDone` and
    `closeWontDo`, and its last check and last error are not shown (nor Task 12's open point on socket runners'
    token errors). Item types to workflows (`tracker.workflows`) are kept on save, not edited. A custom source
    added there with no instance takes its id, which is what `tandemise intake push` names. The use-as-tracker
    offer in Repositories → Issues is "once" per repository on this computer (`localStorage`, "Not now").
  - **The Board** reads `POST …/board/refresh` on open (spec §7 "refreshed … on open") and polls every 10 s;
    the missions topic now refreshes it too, so a row's mission status follows. Start opens the mission from the
    mutation itself, not a per-call `onSuccess`: the started row moves to In progress and can unmount before the
    answer arrives (a run caught it: the mission was made and the window stayed on the Board).
  - **Real YouTrack (opt-in).** `run-all --real-youtrack` runs I1, I2 and I6 against `TANDEMISE_YOUTRACK_URL`/
    `_TOKEN`/`_PROJECT` with nothing seeded; it was implemented and not run (no credentials may be used here).
- Ruling 21 (integration with hold-and-interact and the brain): merging `main` brought migrations 022
  (holds) and 023 (brain), so intake's migration is renumbered to **024** (`024_intake.ts`, version 24),
  as Ruling 1 foresaw. `brain-check` now asserts that the schema includes 023, not that it equals it.
  - `INTAKE_CONFIG_SOURCE` is bound to `LinkedIntakeConfigSource`. A project linked to a brain reads
    `factory/tracker.yaml` and `factory/intake.yaml` through the brain's `BrainIntakeConfigSource`
    (`BRAIN_INTAKE_CONFIG`). Every other project reads the local settings.
  - The brain parses its files loosely, so intake checks them again:
    - a tracker that fails `trackerFileV1` reads as no tracker;
    - a source that fails its schema, or repeats an id, is dropped and logged, and the others are kept;
    - an invalid `dailyCap` or `similarity` falls back to its default.
  - The port gains an optional `originFor(ws)`, used by the config view and by `PUT …/intake/config`. A linked
    project's settings read as set in the brain and cannot be edited there: a write is refused with
    `CONFLICT "Set in this project's brain."`.
  - The brain is resolved per call, because the brain's service depends on intake through P14's `IssueService`.
- Ruling 22 (relay claims and per-machine sources, review fix on PR #73): decided from spec §3, §7 and §9 and the
  relay spec:
  - **Item claims are the relay's claims.** `INTAKE_CLAIMS.item`/`releaseItem` are `CoordinationService.claimItem`/
    `releaseItem`: a claim in the workspace's project (`projectKey`) on the tracker item's ref, already
    `<tracker>:<key>` (`youtrack:ACME-12`, `github:acme/web#7`) and normalised by `normalizeItemRef`. Start claims
    before the mission exists, under the id the mission will have: `MissionService.create` takes an optional
    `origin.missionId`, so the mission's own start (`assertMayStart`) finds the claim already its own, and
    `itemFor` maps a mission's `trackerItemId` to its `tracker_items` row. Release follows the relay's rules:
    `done` on COMPLETE, `released` on CANCELLED/FAILED or a Start that failed after claiming. A refusal is the
    holder's sentence ("Ana is working on ACME-12 since 10:42."). Solo (coordination `local`, or none bound) Start
    is always granted, as spec §3 says; your own leftover claim on this computer whose mission is gone or over
    is released and claimed again. A coordination fault never blocks Start.
  - **Source claims are short leases, not item claims.** Relay claims never expire, so the spec's
    `('source', sourceId)` "lease with a heartbeat (TTL 2 minutes, renewed every 30 seconds)" is a new primitive:
    `LeaseTable` in `@tandemise/coordination`, held in memory by the relay (`POST /relay/v1/leases`
    `{ projectKey, scope: 'source', key: sourceId, ttlSeconds }` → `{ granted, expiresAt, holderName,
    deviceLabel }`), so no coordination migration. A relay restart loses leases; the next renewal takes them again.
    The key is the source id within the project key, not the workspace id: each machine has its own workspace
    ids, the project key is what the team shares. `CoordinationPort.lease` is optional; `LocalCoordination`
    always grants, and so does `RelayCoordination` when the relay can't be reached (the network never blocks
    local work; dedupe catches a double read). The runner host renews a poll source's lease every 30 s between
    polls (socket runners already re-ask every 30 s), and a refused source still skips silently.
  - **Sources from the brain are off per machine.** Ruling 15's "the first write creates the row switched on"
    becomes: on for a project whose configuration is local, off when `originFor(ws) === 'brain'`, until that
    machine's person switches it on (`PUT /v1/workspaces/:id/intake/sources/:sourceId/enabled { enabled }`,
    which answers the config view). The same default applies with no row yet, and when saving a source's secret
    creates the row. `IntakeConfigView.enabled` maps each source id to whether it runs here; it is not part of
    the configuration and is never saved back. Settings → Intake shows it as "On this computer", outside the
    brain's read-only form, with the source's secrets there too when the brain sets the rest.
  - **Proof.** intake-check "claims" (two containers on separate databases sharing one team store,
    `scratch/shared-coordination.mjs`: refused with Ana's words before any mission exists, granted after her
    mission ends); intake-runners-check "sources from the brain" and "source leases" (refused while live, granted
    after it lapses); relay-check "source leases" (the HTTP route); intake-daemon-check (the enabled route).
- Ruling 23 (a credential stays with the address it was saved for, review fix on PR #73): decided from spec §2 and
  §6 ("a permanent token per person, never in the brain repo") and Ruling 21:
  - **The threat.** A project linked to a brain reads `tracker.url` and each source's `api` from the brain's files.
    A teammate, or a compromised brain, could change that address, and this machine would send the person's
    locally stored token (`intake:<ws>:tracker`, the refs in `intake_sources.secret_refs`) to the new host.
  - **Binding.** Each credential is bound to the origin (scheme, host and port, `new URL(..).origin`) it was saved
    for, in a new table `intake_credential_origins (workspace_id, credential, origin)`; `credential` is `tracker`
    or `source:<sourceId>`. The table is part of intake's one unreleased migration, 024, rather than a migration
    of its own, so the numbering stays one slot per feature for integration (no shipped database has 024). The port is
    `IntakeRepositoryPort.credentialOrigins` (`CredentialOriginPort`).
  - **What the origin is.** The tracker's is its `url` (YouTrack); a tracker with no URL (GitHub Issues, signed in
    through `gh`) is named by its kind. A source's is its `api`, else its runner's new `IntakeRunner.defaultApi`
    (Sentry, PostHog, Slack, Discord export theirs), else its kind.
  - **Saving binds.** Saving the tracker token records the tracker's address as configured then; with no tracker
    set yet nothing is recorded. Saving a source secret records the source's address; removing its last secret
    forgets the binding.
  - **Using checks.** Just before a credential is used it is compared with the configured address:
    `TrackerResolver` when it builds a tracker (board, Start, write-back, the pipeline), and the runner host
    before a poll, a socket start, a closure, and in `ctx.secrets.get` (so webhooks and anything a runner reads
    later are covered too). A different address is refused, the token is not read, with
    "This project's tracker now points at <origin>. Confirm the new address in Settings → Intake before Tandemise
    sends your token there." (the board's `problem`, verbatim, not "Couldn't reach …") or "This source now points
    at <origin>. Confirm the new address in Settings → Intake before Tandemise sends your token there." (the
    source's `last_error`). A closure for a moved source waits (the host answers null), it is not failed; a webhook
    delivery for one is acked with the refusal as `last_error`, like any delivery a runner refuses (Ruling 17).
    `problemWith` (the mapping check of `PUT …/intake/config`) never asks an address the token is not bound to.
  - **Credentials saved before this fix** have no recorded origin: they adopt the configured address on first use
    (it is recorded then). The same holds for a tracker token saved before any tracker was set.
  - **Every move is confirmed, local ones too.** A person who changes the URL in their own local Settings is asked
    as well: the rule is about where a token goes, not who moved the address, and it keeps one path. `POST
    /v1/workspaces/:id/intake/tracker/confirm-origin` and `POST …/intake/sources/:sourceId/confirm-origin` (a
    seat; 404 for a source the project does not have) re-bind the saved credential to the address configured
    now, clear the source's refusal, and answer the config view.
  - **The view.** `IntakeConfigView.originMismatch = { tracker: { current, saved, message } | null, sources: {
    [id]: { current, saved, message } } }`, `message` being the daemon's sentence. Settings → Intake shows each
    one above the (possibly read-only) form, with "Saved for <saved>." and **Use the new address**.
  - **Proof.** intake-tracker-check "the tracker token stays with the address it was saved for" (two fake
    YouTracks: nothing carrying the token reaches B, the sentence, confirm, then B; and the first-use adoption);
    intake-runners-check "a moved api address gets no token until confirmed" (two fake Sentries); intake-daemon-check
    (both addresses moved over the API, the board's problem, both confirm routes).
- Ruling 24 (one mailbox path for the relay and the listener, review fix on PR #73): decided from spec §2 ("Webhook-only
  sources"), §3, the relay spec ("The webhook mailbox") and Rulings 17 and 22:
  - **The relay's mailbox is drained.** `IntakeRunnerHost` drains the local mailbox, then the team's
    (`CoordinationService.pull`/`ack`, `RelayMailbox` in the host's deps): per project key of each project with a
    tracker and sources, up to 20 messages leased for 60 s. Solo this is the local coordination mailbox, same path.
  - **Endpoint ↔ source.** The relay names no source on an endpoint beyond its free-text kind, so the mapping is the
    endpoint's **name == the intake source id** (`sentry-web`), within the project key. A non-admin device lists no
    endpoints, so `MailboxMessage` gains an optional `endpointName` (the relay's pull joins `coord_endpoints.name`);
    an older relay leaves it out and its messages read as unconfigured.
  - **Same path, under the lease.** A mapped delivery goes through the runner's `fromWebhook` → the pipeline → ack, as
    a local one does, only on the daemon holding the source's lease (Ruling 22, asked once per drain per source). A
    source off on this machine or leased to another daemon is left unacked; its lease lapses in 60 s and the holder
    takes it. A delivery the runner refuses is acked with the runner's words on `last_error`, like a local one. A
    configured source no shipped runner reads webhooks for is acked with "No runner for this source.".
  - **Unconfigured endpoint: the relay's semantics.** Not acked and not read; logged
    (`intake.relay_webhook_unknown_endpoint`). The relay leases it again and parks it after ten leases, which is how
    the relay records "couldn't be processed" for Settings → Team relay → Webhooks (retry or drop there). Acking it
    would drop a teammate's delivery for good. Known cost: a daemon that does not run a source still leases its
    deliveries for 60 s and spends one of the ten attempts each time.
  - **At least once, read once.** The relay spec asks intake to keep the ids it processed: a relay delivery read here
    records a done row `relay:<project key>:<message id>` (no body) in `intake_webhook_inbox`, and a redelivery after
    a lost ack is acked without being read again. `WebhookMailboxPort` gains `handled(key)`/`recordHandled(...)`.
  - **The listener.** `POST /hooks/:workspaceId/:sourceId` only (`/hooks/:sourceId` is gone: two projects may share a
    source id). `startWebhookListener` takes `accepts(workspaceId, sourceId)`, wired in bootstrap to "the workspace
    exists and its intake configuration names the source"; anything else is a 404 before the body is read or stored.
    Each `workspace/source` takes 60 deliveries a minute (`SlidingWindowLimit`, the push limit's class, on the daemon's
    clock); past it `429` with `retry-after: 60`, nothing stored. `put` and `WebhookMessage` carry the workspace id,
    a new `workspace_id` column of `intake_webhook_inbox` in the unreleased migration 024 (no new migration).
  - **Pruning.** Each drain deletes done rows whose `done_at` is over 24 hours old (`WebhookMailboxPort.prune`), the
    relay's own retention for acked rows.
  - **Sentry's replay window.** `fromWebhook` refuses, after the signature check, a `Sentry-Hook-Timestamp` (Unix
    seconds) more than 5 minutes either side of when the delivery was **received**: "This Sentry delivery's timestamp
    is more than 5 minutes from this computer's clock, so it was not read." `RunnerWebhookRequest` gains an optional
    `receivedAt`, which the host passes from either mailbox; absent, it is `ctx.clock`. Measured from receipt, not
    from reading, because the relay keeps deliveries up to 14 days and a team asleep overnight must not lose them.
    The signature does not cover the header, so the window narrows a replay rather than authenticating; dedupe by
    fingerprint and the handled ids make a replay harmless. A delivery without the header is not refused for that.
  - **Proof.** intake-runners-check "relay mailbox" (a shared team store: a signed delivery to the endpoint named
    `sentry-web` becomes one signal and is acked; one to `not-a-source` stays pending, then is parked after ten
    leases; Bruno, refused the lease, leaves a delivery that Ana then reads — it fails with the lease check removed),
    "sentry: webhook" (4 minutes read; 6 minutes old or ahead refused; an hour-old timestamp received an hour ago
    read), "webhook listener" (the workspace path, 404s with nothing stored, 60 then 429 per source, pruning after
    24 h); intake-daemon-check (the daemon's listener on the new path, 404 for the old one and an unconfigured source).
- Ruling 25 (fatal socket errors and Sentry's fallbacks, review fix on PR #73): decided from spec §2, §8 and Ruling 18's
  open point:
  - **Runners report.** `RunnerContext` gains `reportError(message, { fatal })` and `reportConnected()`. The host writes
    `message` to the source's `last_error`, and clears it (with `last_checked_at`) when a socket opens again; neither
    writes anything once the runner's signal is aborted. `SocketLoop` reports every failed connect (a transient one too,
    e.g. "Slack answered ratelimited to apps.connections.open.") and keeps the backoff for it; a socket's `open` is the
    successful connect.
  - **What is fatal.** A refusal the vendor will repeat however long the loop waits stops the loop and is reported
    fatal: a `fatalSocketError` thrown from `connect`, or a close the session names (`onClose` answers a sentence).
    Discord: a 401 from `GET /gateway/bot` and close 4004 → "Discord refused the bot token. Save a new one in Settings →
    Intake."; 4013/4014 → "Discord refused the intents this source needs (message content, reactions). Turn them on for
    the bot in the Discord developer portal, then switch this source off and on in Settings → Intake."; 4010/4011/4012
    → "Discord closed the gateway for good (<code>, <what>). Switch this source off and on in Settings → Intake to try
    again." Slack: `apps.connections.open` answering `invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`
    or `token_expired` → "Slack refused the app-level token. Save a new one in Settings → Intake."; `missing_scope` →
    "Slack's app-level token lacks the connections:write scope. …"; `not_allowed_token_type` → "Slack needs the
    app-level token (xapp-…) to listen, not a bot or user token. …"; a `disconnect` envelope with reason
    `link_disabled` → "Slack turned Socket Mode off for this app. …". Other `disconnect` reasons (`refresh_requested`,
    `warning`), other close codes, a missing secret, the network, 429 and 5xx keep the backoff. The sentences name a
    second step ("then switch this source off and on") where saving a secret would not restart the source.
  - **The host keeps it stopped.** A fatal report marks the running entry with the source's secret refs then. Each
    later tick leaves it stopped, without asking the source's lease (so the lease lapses and a teammate's daemon with
    a working token may take it), while the configuration and the refs are unchanged. A saved secret (every save gets
    a new ref), a changed configuration, or switching the source off and on (the entry is dropped) starts it afresh,
    which clears `last_error` until the next report. A daemon restart tries once more.
  - **Sentry, no releases.** A closure PUT that answers 400 is sent again as `{ status: 'resolved' }` alone: a project
    with no releases refuses `inNextRelease`, and the same fallback covers an `inCommit` Sentry refuses. Other
    failures are as Ruling 17.
  - **Sentry, pages.** `SourceHttp.getPage` answers the body and the `Link` header's next cursor (`rel="next"`, not
    `results="false"`, a non-empty `cursor`). The issues poll and the organization's repositories (for `inCommit`)
    follow it, at most 10 pages per list (Sentry pages by 100); the repositories stop at the page that has the match.
  - **Proof.** intake-runners-check "sentry: a project without releases is resolved plainly", "sentry: issues and
    repositories are read page by page" (5 issues in pages of 2 all pushed; the repository on page 3 → inCommit; 17
    pages → 10 asked), "discord and slack: a refused token stops the socket and says why" (no retry for 2.5 s, none
    on the next tick, a new secret connects and clears), "discord intents (4014) and a Slack scope …" (one try each,
    still stopped on the same secret, off and on reconnects; close 4004), "slack: a link_disabled disconnect …", "slack:
    a passing failure keeps the backoff". The fakes gained `failIdentify(code)` (Discord), `failOpen(error)` and
    `disconnect(reason)` (Slack), and `releases`/`setReleases` and `pageSize`/`setPageSize` with Sentry's `Link`
    header (Sentry).
- Ruling 26 (the minor review findings on PR #73): decided from spec §2, §3, §6, §8 and Rulings 22, 24 and 25:
  - **Revoking a push token.** `IntakeService.revokeToken` (and `DELETE /v1/intake/tokens/:id`) looks the token up
    (`tokens.byId`, new on the port) and requires a seat in its project (`requireSeat`). A token of a project the
    caller has no seat in is `NOT_FOUND`, worded as for an id that never existed, so a token id says nothing about
    another project.
  - **GitHub comments, every page.** `GhIssueTracker.comments` runs `gh api --paginate …/comments?per_page=100` and
    reads gh's pages printed back to back (`[…][…]`), so a marker comment past the first 100 is found and edited, not
    posted again. P14 issue sync reads the same way. `fake-gh` serves pages only when a check sets `pageSize` in its
    state (one page without `--paginate`, all of them with it); otherwise its output is unchanged.
  - **Duplicates, once.** GitHub's `markDuplicate` writes "Duplicate of #n." through the marker mechanism
    (`<!-- tandemise:duplicate -->`, the signed-in user's comment only, edited when found), then closes. The marker
    is the adapter's own lookup and is not stored, so `tracker_comments`' marker CHECK in 024 is unchanged.
    YouTrack's `duplicates X` command is idempotent (its links are a set; the fake now models that) and posts no
    comment; asserted by sending it twice.
  - **Rate limits.** `RateGate` (`@tandemise/integrations-core`) is one tracker adapter instance's wait (the resolver
    caches one instance per project). YouTrack: a 429 waits its `Retry-After` (seconds or an HTTP date; 60 s without
    one; capped at an hour). GitHub: `gh` failing with "secondary rate limit", "API rate limit exceeded" or HTTP 429
    waits 60 s (gh shows no `Retry-After`); every `gh` call of the tracker, searches and comments included, goes
    through it. While the wait lasts calls are refused without being sent, as a retryable `INTEGRATION_FAILED`:
    "YouTrack asked Tandemise to slow down; it waits 30 s before asking again." (GitHub likewise, counting down).
  - **`trigger.react`.** A source's `trigger.react?: boolean` (default true; zod and the domain type) switches the
    chat acknowledgements off: with `false` Slack makes no `reactions.add`/`reactions.remove` at intake or closure,
    and Discord adds no 👀. The reply in the thread is unchanged.
  - **A delivery waits for its secret.** The host's webhook context notes each secret a runner asks for and does not
    get. A delivery the runner then refuses with `PRECONDITION_FAILED` is "waiting": the runner's words (which name
    the secret, e.g. "Save the Sentry client secret for this source in Settings → Intake first.") go on `last_error`,
    and it is not acked. Locally it stays claimed while the drain pulls on (up to 10 batches, so waiting deliveries
    never fill a batch ahead of the others) and is released at the end of the drain; from the relay it is not acked
    and not recorded as handled, so the relay hands it out again. Any other refusal is acked as before (Ruling 24).
  - **Only a running daemon pulls the relay.** Before pulling a project key the host asks whether it runs at least
    one of those projects' sources: on here, read by a shipped runner, not stopped for good (Ruling 25), and its
    lease held. A lease got or refused in the last 30 s is taken as it was; otherwise it is asked, as the pass
    would. A daemon that runs none pulls nothing, which retires Ruling 24's known cost.
  - **Proof.** intake-check (a stranger's revoke is NOT_FOUND and the token still works; an unknown id is NOT_FOUND),
    intake-tracker-check (a marker comment on page 2 edited via `--paginate`; `markDuplicate` twice adds no comment
    on GitHub and no second link on YouTrack; YouTrack 429 + Retry-After 30 then refused for 20 s without a request,
    then asked again; gh's secondary limit and "API rate limit exceeded" likewise), intake-runners-check ("slack:
    trigger.react false …": filed and closed, no reaction calls; "webhooks: a delivery whose source lacks its secret
    waits for it": not acked, the client secret named, read once saved; the relay section: Bruno, who runs no
    source of the project, makes no mailbox pull). Two existing assertions moved with the behaviour: the 61-delivery
    PostHog burst saves its webhook secret first, and the unconfigured endpoint is parked after nine more of Ana's
    drains (Bruno no longer leases it).
- Ruling 27 (acceptance I10, how the brain is set up in the real app): decided from Rulings 22 and 23 and the
  harness rule "no network":
  - **A real brain, on this machine.** I10 links the acceptance project with `POST …/brain { mode: 'local' }` (#70's
    local-only brain: a git repository at `<TANDEMISE_HOME>/brains/<ws>`, no remote), then commits
    `factory/tracker.yaml` and `factory/intake.yaml` there as a teammate would and pulls them with `POST …/brain/sync`.
    No fake remote or `gh` is needed, and the daemon reads the files through `BrainIntakeConfigSource` exactly as
    for a shared brain. The link is made over the daemon's API (setup); everything asserted is driven in the window.
  - **A source id the machine has never seen.** The brain names `sentry-team` (the same fake Sentry as the local
    `sentry-web`): an existing `intake_sources` row keeps its own `enabled`, so only a new id shows the brain's
    default (off). Its token is saved in the window's "On this computer" row, which leaves it off.
  - **The second address.** run-all starts a second fake YouTrack (`youtrack-b`, same project and token, so a request
    carrying the token would be accepted and shows); the brain's second commit moves `tracker.url` to it. I10 runs
    last: it leaves the project linked to the brain.
- Ruling 28 (re-review items on PR #73):
  - **Lease cap.** A device holds at most `MAX_LEASES_PER_DEVICE = 200` live relay leases. Past that, `POST /relay/v1/leases` answers `429 RATE_LIMITED` ("This device already holds 200 source leases; let some go before taking more."). Renewing a lease the device already holds is never refused. The route is listed in the relay spec's route table.
  - **Scoped release on a failed Start.** `releaseItem(itemRef, reason, localRef?)`: when the mission create fails, Start releases only the claim whose `localRef` is its pre-named mission id. A release without `localRef` (mission end) still lets go of all of the person's claims on the item.
  - **Proof.** Both are proven in `relay-check` and `intake-check`, which failed before the change.
- Ruling 29 (the board shows the board query, found by I10): the cache keeps items that a mission or a signal points at, even when the board query no longer returns them (Ruling 13). I10 showed this leaking onto the board: after the tracker moved to YouTrack B, A's `ACME-1` stayed in Ready because a signal was linked to it.
  - `TrackerService` now remembers which refs the last successful read returned, and `board()` lists only those.
  - Until the first read after a daemon start, the whole cache shows.
  - Proven offline in `intake-check`, which failed before the change: a narrowed board query hides a linked, still-Open item, and it reappears once the query returns it again. Proven in the real app by I10.
