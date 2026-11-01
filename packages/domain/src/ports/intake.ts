import type {
  Clock, ClosureId, IntakeLinkId, IntakeTokenId, Logger, SignalId, Timestamp, TrackerItemId, WebhookMessageId, WorkspaceId,
} from '@tandemise/shared';
import type {
  ClosureKind, IntakeAttachment, IntakeClosure, IntakeClosurePatch, IntakeConfig, IntakeLink, IntakeLinkedBy, IntakeLinkWritten, IntakeSignal,
  IntakeSignalInput, IntakeSourceConfig, IntakeSourcePatch, IntakeSourceState, IntakeTokenRow, SignalStatus, TrackerConfig, WebhookMessage,
} from '../entities/intake.js';
import type { SourceEntry, TrackedItem, TrackerCommentMarker, TrackerCommentRow, TrackerItem, TrackerRef } from '../entities/tracker.js';

/**
 * Where a project's intake configuration comes from (plan Task 1; spec §4.1,
 * §6.2). No service reads `settings.json` or a brain file directly: a local
 * implementation over the settings store ships now, and the brain (#51) plugs
 * in a read-only one later that parses `factory/tracker.yaml` and
 * `factory/intake.yaml` with the same schemas.
 */
export interface IntakeConfigSource {
  readonly origin: 'local' | 'brain';
  /**
   * Per project, when it differs (a project linked to a brain reads from it,
   * the others locally). Callers prefer it over `origin` (Ruling 21).
   */
  originFor?(workspaceId: WorkspaceId): 'local' | 'brain';
  /**
   * Never throws. A project with nothing set reads as
   * `{ tracker: null, sources: [], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } }`.
   */
  read(workspaceId: WorkspaceId): IntakeConfig;
  /** Local only: the brain is edited in its repository, not through the daemon. */
  write?(
    workspaceId: WorkspaceId,
    patch: { tracker?: TrackerConfig | null; intake?: Omit<IntakeConfig, 'tracker'> },
  ): IntakeConfig;
}

/**
 * Signals, their links, closures, sources and push tokens (plan Task 2).
 * Synchronous, like every repository port. Everything is keyed so a repeat or
 * a restart finds what is already there: signals by `(workspace, fingerprint)`,
 * links by signal, closures by `(signal, kind)`.
 */
export interface IntakeRepositoryPort {
  source(workspaceId: WorkspaceId, sourceId: string): IntakeSourceState | undefined;
  /** Creates the row on first save, which must name the `kind`. */
  saveSource(workspaceId: WorkspaceId, sourceId: string, patch: IntakeSourcePatch): IntakeSourceState;
  listSources(workspaceId: WorkspaceId): readonly IntakeSourceState[];
  /** Every enabled source, in any project. */
  listEnabledSources(): readonly IntakeSourceState[];

  /**
   * Records a signal in one transaction. A new fingerprint is a new `received`
   * row (`firstTime`). A repeat adds an occurrence, merges the impact
   * (`mergeImpact`), takes the latest text and keeps its status. A repeat of a
   * `rejected` signal that now parses enters the pipeline as new (`firstTime`).
   */
  upsertSignal(workspaceId: WorkspaceId, sourceId: string, signal: IntakeSignalInput, at: Timestamp): { signal: IntakeSignal; firstTime: boolean };
  /**
   * Records a signal that did not parse. A fingerprint already in the pipeline
   * is left as it is and returned: a bad repeat never undoes a good signal.
   */
  recordRejected(workspaceId: WorkspaceId, sourceId: string, fingerprint: string, title: string, reason: string): IntakeSignal;
  getSignal(id: SignalId): IntakeSignal | undefined;
  findSignal(workspaceId: WorkspaceId, fingerprint: string): IntakeSignal | undefined;
  /** Most recently seen first. */
  listSignals(workspaceId: WorkspaceId, filter?: { readonly statuses?: readonly SignalStatus[]; readonly limit?: number }): readonly IntakeSignal[];
  /** `extra` fields that are absent stay as they are; null clears them. */
  setStatus(id: SignalId, status: SignalStatus, reason: string | null, extra?: { readonly candidateRef?: string | null; readonly score?: number | null }): IntakeSignal;
  addAttachment(signalId: SignalId, attachment: Omit<IntakeAttachment, 'signalId'>): void;
  attachments(signalId: SignalId): readonly IntakeAttachment[];

  linkFor(signalId: SignalId): IntakeLink | undefined;
  /** Written before the tracker call. UNIQUE on the signal: a second one throws. The ref is null until a create returns. */
  createPendingLink(workspaceId: WorkspaceId, signalId: SignalId, itemRef: string | null, linkedBy: IntakeLinkedBy, score?: number | null): IntakeLink;
  completeLink(id: IntakeLinkId, itemRef: string): IntakeLink;
  /** Records what was last written to the tracker for the link's signal (plan Task 7). */
  setLinkWritten(id: IntakeLinkId, written: IntakeLinkWritten | null): void;
  /** Moves every link from a duplicate to the item it duplicates; returns how many moved. */
  repointLinks(workspaceId: WorkspaceId, fromRef: string, toRef: string): number;
  linksForItem(workspaceId: WorkspaceId, itemRef: string): readonly IntakeLink[];
  /** Links a crash left `pending`, in any project, oldest first. */
  pendingLinks(): readonly IntakeLink[];
  /** Links with `linked_by = 'created'` for signals of that source, written since `dayStartIso` (the daily cap). */
  createdToday(workspaceId: WorkspaceId, sourceId: string, dayStartIso: string): number;

  readonly closures: {
    /** Returns the existing closure for `(signal, kind)`, or a new `pending` one due now. */
    ensure(signalId: SignalId, kind: ClosureKind): IntakeClosure;
    /** By id: the feed's ack and the Intake tab's Retry name one (plan Task 13). */
    get(id: ClosureId): IntakeClosure | undefined;
    /** Pending closures whose next attempt is at or before `nowIso`, oldest first. */
    due(nowIso: string): readonly IntakeClosure[];
    update(id: ClosureId, patch: IntakeClosurePatch): IntakeClosure;
    /** A source's closures in id order, after `afterId` when given. */
    listForSource(workspaceId: WorkspaceId, sourceId: string, afterId?: string): readonly IntakeClosure[];
  };

  /** The origin each locally saved credential is bound to (Ruling 23). */
  readonly credentialOrigins: CredentialOriginPort;

  readonly tokens: {
    create(workspaceId: WorkspaceId, sourceId: string, tokenHash: string, createdBy: string | null): IntakeTokenRow;
    /** Revoked tokens are returned too, with `revokedAt` set: the caller refuses them. */
    byHash(tokenHash: string): IntakeTokenRow | undefined;
    /** Revoked tokens too; undefined for an id that never existed. */
    byId(id: IntakeTokenId): IntakeTokenRow | undefined;
    revoke(id: IntakeTokenId): void;
    list(workspaceId: WorkspaceId): readonly IntakeTokenRow[];
  };
}

/**
 * Where each of a project's locally saved credentials may be sent (Ruling 23):
 * the origin (scheme, host, port) of the tracker URL or the source's API base
 * it was saved for. A project linked to a brain reads those addresses from
 * the brain's files, so a changed address must never take a person's token
 * with it until that person confirms it. `credential` is `tracker` or
 * `source:<sourceId>`; a null origin forgets the binding.
 */
export interface CredentialOriginPort {
  get(workspaceId: WorkspaceId, credential: string): string | undefined;
  set(workspaceId: WorkspaceId, credential: string, origin: string | null): void;
}

/**
 * The board cache and the comments Tandemise keeps on each item (plan Task 2).
 * The tracker is the truth; this is what the last refresh saw, plus the state
 * Tandemise last wrote.
 */
export interface TrackerItemRepositoryPort {
  /** By `(workspace, ref)`: an existing item keeps its id and written state. */
  upsert(workspaceId: WorkspaceId, item: TrackerItem): TrackedItem;
  get(id: TrackerItemId): TrackedItem | undefined;
  byRef(workspaceId: WorkspaceId, ref: string): TrackedItem | undefined;
  byKey(workspaceId: WorkspaceId, key: string): TrackedItem | undefined;
  list(workspaceId: WorkspaceId): readonly TrackedItem[];
  setWrittenState(id: TrackerItemId, state: string | null): void;
  /** Forgets every cached item of the project not in `keepRefs`. A mission that pointed at one keeps running, unlinked. */
  removeMissing(workspaceId: WorkspaceId, keepRefs: readonly string[]): void;
  comment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker): TrackerCommentRow | undefined;
  saveComment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker, commentId: string, body: string): void;
  dropComment(workspaceId: WorkspaceId, ref: string, marker: TrackerCommentMarker): void;
}

/**
 * Webhook deliveries waiting to be read (plan Global Constraints). The opt-in
 * listener puts; the runners pull. Backed locally by `intake_webhook_inbox`;
 * the relay (#54) can supply its own later.
 */
export interface WebhookMailboxPort {
  /** The project is in the listener's path (`/hooks/:workspaceId/:sourceId`, Ruling 24). */
  put(msg: { readonly workspaceId: WorkspaceId; readonly sourceId: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array }): WebhookMessageId;
  /** Claims up to `max` unclaimed messages, oldest first. */
  pull(max: number): readonly WebhookMessage[];
  /** Done: never pulled again. */
  ack(id: WebhookMessageId): void;
  /** Not done: pulled again by the next `pull`. A message already acked stays done. */
  release(id: WebhookMessageId): void;
  /**
   * Hands back every message claimed before `claimedBefore` and not done: a
   * consumer that died holding them (a crash between `pull` and `ack`).
   * Returns how many. Plan Task 11, RULINGS ruling 17.
   */
  releaseStale(claimedBefore: string): number;
  /** Deletes done messages acked before `doneBefore`; returns how many (Ruling 24). */
  prune(doneBefore: string): number;
  /**
   * Whether a delivery another mailbox handed this daemon (the relay's,
   * keyed `relay:<project key>:<message id>`) was already read here, so a
   * redelivery after a lost ack is a no-op (relay spec, "Ack"; Ruling 24).
   */
  handled(key: string): boolean;
  /** Records such a delivery as read, as a done row with no body; pruned like the others. */
  recordHandled(entry: { readonly key: string; readonly workspaceId: WorkspaceId; readonly sourceId: string }): void;
}

/**
 * A file to attach to a new item. The adapter uploads it when the tracker
 * takes uploads and `content` is here; otherwise it is the caller's to link
 * in the description (GitHub has no upload API, spec §6).
 */
export interface AttachmentRef {
  readonly name: string;
  readonly mediaType: string;
  readonly url?: string;
  readonly content?: Uint8Array;
}

/** What `PrimaryTracker.describe()` reports: the tracker's real states, types and fields. */
export interface TrackerDescription {
  readonly states: readonly string[];
  readonly types: readonly string[];
  readonly fields: readonly string[];
}

/**
 * The project's primary tracker (spec §6). Intake talks to a tracker only
 * through this port; the adapters live in layer-4 provider packages
 * (`integration-youtrack`, `integration-github`).
 *
 * Additive to the spec's shape (plan Task 4): `comment` takes the comment id
 * `TrackerService` last saw as a hint (`knownId`), since the adapter keeps no
 * state; `viewer()` names the signed-in user, the only one whose comments are
 * adopted by marker (P14 ruling 8); `assign` is optional; `refFromUrl` lets
 * dedupe tell that a signal's URL *is* an item of this tracker (spec §5 step 2).
 */
export interface PrimaryTracker {
  readonly kind: 'youtrack' | 'github-issues' | (string & {});
  readonly capabilities: {
    /** The activity comment is edited in place. */
    readonly editComments: boolean;
    /** Upload, rather than link. */
    readonly attachments: boolean;
    /** A native "duplicates" link. */
    readonly duplicateLinks: boolean;
  };
  /** The tracker's real states and fields, to validate the project's mapping (`stateMappingProblem`). */
  describe(): Promise<TrackerDescription>;
  /**
   * `url`: the items whose text (description or comments) holds that exact
   * URL. `text`: the tracker's own search for candidates by title words.
   */
  search(q: { readonly url?: string; readonly text?: string; readonly unresolvedOnly?: boolean; readonly limit: number }): Promise<readonly TrackerItem[]>;
  board(q: { readonly query: string; readonly updatedSince?: string; readonly limit: number }): Promise<readonly TrackerItem[]>;
  /** `NOT_FOUND` when the item is gone. */
  get(ref: TrackerRef): Promise<TrackerItem>;
  create(draft: {
    readonly title: string;
    readonly description: string;
    readonly type?: string;
    readonly fields?: Readonly<Record<string, string>>;
    readonly attachments?: readonly AttachmentRef[];
  }): Promise<TrackerItem>;
  /** Adds a source to an existing item: the URL in Tandemise's sources comment, plus the new context. */
  link(ref: TrackerRef, source: SourceEntry): Promise<void>;
  /**
   * Creates or updates the one comment per `(item, marker)`. Lookup order:
   * `knownId`, then a comment by `viewer()` whose text starts with the marker
   * line, then a new comment. The text always starts with `markerLine(marker)`.
   */
  comment(ref: TrackerRef, c: { readonly marker: string; readonly body: string; readonly knownId?: string }): Promise<{ commentId: string }>;
  transition(ref: TrackerRef, state: string): Promise<void>;
  /**
   * Replaces the item's description (#135): only on a person's "Write … and
   * mark ready" after refining a draft, never on Tandemise's own initiative.
   */
  updateDescription(ref: TrackerRef, description: string): Promise<void>;
  markDuplicate?(dup: TrackerRef, of: TrackerRef): Promise<void>;
  assign?(ref: TrackerRef, login: string): Promise<void>;
  /** The signed-in user's login. */
  viewer(): Promise<string>;
  /** The ref of this tracker's item at `url`, or null when the URL is not one of its items. */
  refFromUrl?(url: string): TrackerRef | null;
}

/**
 * Builds a project's tracker from its configuration and the credential in the
 * local secret store. Contributed per kind through `PRIMARY_TRACKER_FACTORIES`.
 */
export interface PrimaryTrackerFactory {
  readonly kind: string;
  create(config: TrackerConfig, credential: string | undefined): PrimaryTracker;
}

/**
 * Ranks a tracker search's candidates against a signal (spec §5 step 4), from
 * 0 to 1, compared with the project's `similarity.link` and `similarity.ask`.
 * The default is `lexicalSimilarity` (plan Task 6, bound in Task 7); a later
 * model-backed judge can replace it without changing the pipeline.
 */
export interface IntakeSimilarity {
  score(
    signal: { readonly title: string; readonly description: string; readonly url: string },
    candidate: TrackerItem,
  ): number;
}

/**
 * Who may work on what across daemons (plan Global Constraints). Bound to the
 * relay's coordination (Ruling 22): an item claim and a source lease, both in
 * the workspace's project. Without the relay it always grants, so Start falls
 * back to re-reading the item (spec §3).
 */
export interface IntakeClaimsPort {
  /** May this daemon run the source's runner now? */
  source(workspaceId: WorkspaceId, sourceId: string): Promise<boolean>;
  /**
   * Claims an item for Start; a refusal carries the sentence to show.
   * `localRef` is the id the mission will have, so its start finds the claim its own.
   */
  item(input: { readonly workspaceId: WorkspaceId; readonly itemRef: string; readonly itemTitle: string; readonly itemUrl: string; readonly localRef: string }):
    Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** With `localRef`, only the claim made for that mission (Ruling 27). */
  releaseItem(itemRef: string, reason: 'done' | 'released', localRef?: string): Promise<void>;
}

// ------------------------------------------------------------------ runners (plan Task 10; spec §2)

/**
 * What a runner pushes: one `tandemise.intake/v1` signal. The domain cannot
 * import the zod contract, so this is its domain mirror plus the schema
 * line; the pipeline validates every push against the contract all the same,
 * so a runner's bad signal is recorded as rejected like anyone else's.
 */
export type RunnerSignal = IntakeSignalInput & { readonly schema: 'tandemise.intake/v1' };

/** A push's answer, field for field the contract's `IngestResultView`. */
export interface RunnerPushResult {
  readonly fingerprint: string | null;
  readonly signalId: string | null;
  readonly status: SignalStatus;
  readonly reason: string | null;
}

/**
 * What the host hands a runner (spec §2). The source's configuration comes
 * from `IntakeConfigSource`; a secret is resolved by name through the
 * source's `secret_refs` in the local secret store, so a runner never sees a
 * ref or a config file. The cursor is the runner's own, opaque to everyone
 * else, kept in `intake_sources.cursor`.
 */
export interface RunnerContext {
  readonly workspaceId: WorkspaceId;
  readonly source: IntakeSourceConfig;
  /** Into the one pipeline (`IntakeService.ingest`), scoped to this project and source. */
  push(signal: RunnerSignal): Promise<RunnerPushResult>;
  readonly clock: Clock;
  readonly secrets: { get(name: string): Promise<string | undefined> };
  readonly log: Logger;
  /** Aborted when the host stops the runner (shutdown, a changed configuration, a lost claim). */
  readonly signal: AbortSignal;
  readonly cursor: { get(): unknown; set(value: unknown): void };
  /**
   * A socket runner's own word on its connection (Ruling 25): the host writes
   * `message` to the source's `last_error`. `fatal` means the vendor will
   * refuse again (a refused token, intents or scopes): the runner has stopped
   * for good, and the host does not start it again until the source's
   * secrets or configuration change or the person switches it off and on.
   */
  reportError(message: string, options?: { readonly fatal?: boolean }): void;
  /** The socket is open again: the host clears an error reported before (Ruling 25). */
  reportConnected(): void;
}

/** A started runner. A poll runner answers `poll`; a socket runner listens until `stop`. */
export interface RunnerHandle {
  poll?(): Promise<void>;
  stop(): Promise<void>;
}

/** One loop closure, handed to the runner of the signal's source (spec §8). */
export interface Closure {
  readonly kind: ClosureKind;
  readonly signal: {
    readonly fingerprint: string;
    readonly key: string;
    readonly url: string;
    readonly instance: string;
    readonly title: string;
    /** The signal's `reply`, opaque to Tandemise. */
    readonly reply: unknown;
  };
  readonly item: { readonly key: string; readonly url: string };
  readonly prUrl: string | null;
  readonly commit: { readonly sha: string; readonly repo: string } | null;
}

/** `externalId` is what was written at the source (a comment id), or null when nothing was. */
export type ClosureResult =
  | { readonly ok: true; readonly externalId: string | null }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

/** A webhook delivery as the mailbox kept it: the body's bytes exactly as received. */
export interface RunnerWebhookRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /**
   * When the mailbox received it, local or the relay's. A replay window is
   * measured from here, not from when it is read, so a delivery that waited
   * in a mailbox is still read (Ruling 24). Absent: the runner's clock.
   */
  readonly receivedAt?: string;
}

/**
 * One kind of source (spec §2). Shipped runners are contributed through
 * `INTAKE_RUNNERS` (`@tandemise/integrations-core`); the application names
 * none of them. Custom sources have no runner here: they push over HTTP or
 * the CLI and read their closures from the feed.
 *
 * Additive to the spec's shape (plan Task 10): `close` and `fromWebhook` take
 * the context too, since both need the source's secrets, and `fromWebhook`
 * may answer a promise for the same reason. `fromWebhook` throws, in the
 * source's words, when a delivery is not the source's (a bad signature).
 */
export interface IntakeRunner {
  readonly kind: string;
  readonly mode: 'poll' | 'socket' | 'webhook';
  /**
   * The API base the runner calls when the source sets no `api`: with the
   * source's `api`, the address its secrets are bound to (Ruling 23).
   */
  readonly defaultApi?: string;
  start(ctx: RunnerContext): RunnerHandle;
  fromWebhook?(req: RunnerWebhookRequest, ctx: RunnerContext): Promise<readonly RunnerSignal[]> | readonly RunnerSignal[];
  close?(closure: Closure, ctx: RunnerContext): Promise<ClosureResult>;
}
