import { createHash, randomBytes } from 'node:crypto';
import type {
  AttachmentRef, EvalBlobPort, IntakeAttachment, IntakeConfig, IntakeConfigSource, IntakeLink, IntakeLinkedBy, IntakeRepositoryPort, IntakeRunner,
  IntakeSignal, IntakeSimilarity, IntakeSourceConfig, MemberRepositoryPort, PrimaryTracker, ProjectionBusPort, SecretStorePort, SignalStatus, TrackerConfig,
  TrackerItem, TrackerItemRepositoryPort, TrackerRef, UnitOfWork, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  dailyCapReason, evaluateNoise, linkChangeMatters, linkWritten, sourceLabel, titleTokens, trackerLabel,
} from '@tandemise/domain';
import {
  formatIntakeIssues, intakePushBody, pushedSignals, updateIntakeConfigRequest, validateIntakeSignal,
  type IngestResultView, type InboxIntakeDecisionView, type IntakeConfigView, type IntakeDecision, type IntakeOriginMismatchView, type IntakeSignalV1,
  type IntakeSignalView, type IntakeTokenMintedView,
} from '@tandemise/api-contract';
import type { Clock, IntakeTokenId, Logger, SignalId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage } from '@tandemise/shared';
import { requireSeat, type Caller } from '../support/identity.js';
import { SlidingWindowLimit } from '../intake/rate-limit.js';
import type { TrackerResolver } from '../intake/tracker-resolver.js';
import { createDraft, sourceEntry } from '../intake/item-text.js';
import { sourceOnByDefault } from '../intake/runner-host.js';
import { mismatchOf, sourceCredential, sourceMovedSentence, sourceOrigin, trackerMovedSentence } from '../intake/credential-origin.js';

/**
 * Who a push is for: one project and one of its sources. From an intake token
 * the scope is the token's; from the daemon token it is named by the caller
 * (spec §2 "Auth").
 */
export interface IntakeScope {
  readonly workspaceId: WorkspaceId;
  readonly sourceId: string;
  /** Null when the push came with the daemon token (the desktop, the CLI). */
  readonly tokenId: IntakeTokenId | null;
}

export interface IntakeDeps {
  readonly intake: IntakeRepositoryPort;
  readonly config: IntakeConfigSource;
  /**
   * The project's tracker for the pipeline (plan Task 7), and the check of a
   * tracker's state mapping before it is saved (plan Task 5).
   */
  readonly trackers: Pick<TrackerResolver, 'problemWith' | 'for' | 'saveCredential' | 'originMismatch' | 'confirmOrigin'>;
  /**
   * The shipped runners, read per call: a source with no `api` sends its
   * secrets to its runner's default base, the address they are bound to (Ruling 23).
   */
  readonly runners: () => readonly IntakeRunner[];
  /** Where a source's secrets are kept (plan Task 11): only their refs are in `intake_sources`. */
  readonly secrets: Pick<SecretStorePort, 'store' | 'remove'>;
  /** The board cache: every item the pipeline creates, links or asks about (plan Task 7). */
  readonly items: TrackerItemRepositoryPort;
  /** Ranks the tracker's candidates (spec §5 step 4); lexical by default. */
  readonly similarity: IntakeSimilarity;
  /** Completes a link, caches its item and sets the signal's status together. */
  readonly unitOfWork: UnitOfWork;
  /** Inline attachments, content-addressed (spec §1 "Attachments"). */
  readonly blobs: EvalBlobPort;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get' | 'list'>;
  /** Tells open windows the Intake tab and the Inbox changed; optional for harnesses. */
  readonly projections?: Pick<ProjectionBusPort, 'invalidate'>;
  readonly members: MemberRepositoryPort;
  readonly clock: Clock;
  readonly log: Logger;
  /**
   * `TrackerService.trackerChanged`: the tracker's token, address or mapping
   * was saved, so the board's cached problem is stale and it is read again
   * (#134). Resolved per call; optional for harnesses.
   */
  readonly trackerChanged?: (workspaceId: WorkspaceId) => void;
}

/** Spec §2: each token, 60 signals a minute by default. */
export const INTAKE_SIGNALS_PER_MINUTE = 60;
/** What an intake token starts with, so a stray one is recognisable in a log or a shell history. */
export const INTAKE_TOKEN_PREFIX = 'tdi_';
const UNREADABLE_TITLE = '(unreadable signal)';
/** Plan Task 7: a signal the tracker could not take is tried again no more than once a minute. */
export const INTAKE_RETRY_EVERY_MS = 60_000;
/** How many exact-URL hits are worth reading; any one of them is the item. */
const URL_SEARCH_LIMIT = 5;
/** Spec §5 step 4: the tracker's own search, top 20. */
const TEXT_SEARCH_LIMIT = 20;
/**
 * The statuses a new reading runs the pipeline for. A `needs_decision` signal
 * waits for its person, a dismissed one stays dismissed, and the closure
 * states belong to closing the loop (plan Task 13).
 */
const PIPELINE_STATUSES: ReadonlySet<SignalStatus> = new Set<SignalStatus>(['received', 'held_back', 'linked', 'created']);

/** The tracker and its configuration, for one pass over one signal. */
interface TrackerContext {
  readonly tracker: PrimaryTracker;
  readonly config: TrackerConfig;
}

/**
 * The intake pipeline (spec §4), one service for every runner.
 *
 * Validate against `tandemise.intake/v1` and record (plan Task 3): everything
 * that enters is recorded, a rejected signal included, with the reason the
 * push is answered with. Then, in the background and one signal at a time per
 * project (plan Task 7): filter noise, dedupe, then create or link in the
 * primary tracker. A link is written `pending` before the tracker call and
 * `done` after it, so a crash between the two is finished on restart instead
 * of filing twice: a pending create searches the tracker by its exact URL
 * before it creates (Review Focus 1).
 *
 * Signal text is data: nothing read from a signal selects the project, the
 * source, the tracker or a threshold. The scope comes from the token, or from
 * the daemon-token caller, and a signal that names another source is refused.
 */
export class IntakeService {
  readonly #limit: SlidingWindowLimit;
  /** One pipeline per project, in arrival order: an outcome is stored before the next signal runs (spec §4 step 5). */
  readonly #queues = new Map<WorkspaceId, Promise<void>>();
  /** Every pass started and not finished, for `settle()`. */
  readonly #running = new Set<Promise<void>>();
  /** Signals waiting in a queue, so a tick does not queue them twice. */
  readonly #queued = new Set<SignalId>();
  /** When each signal last went through the pipeline, for the once-a-minute retry. */
  readonly #lastAttemptMs = new Map<SignalId, number>();
  #recovered = false;

  constructor(private readonly deps: IntakeDeps) {
    this.#limit = new SlidingWindowLimit(deps.clock, INTAKE_SIGNALS_PER_MINUTE);
  }

  // ------------------------------------------------------------------ pushing

  /**
   * The scope of an HTTP push. With an intake token, the token decides, and a
   * query naming another project or source is refused. With the daemon token,
   * the query must name both.
   */
  pushScope(fromToken: IntakeScope | null, workspace: string | null, source: string | null): IntakeScope {
    if (fromToken !== null) {
      if ((source !== null && source !== fromToken.sourceId) || (workspace !== null && workspace !== fromToken.workspaceId)) {
        throw tokenScopeRefusal(fromToken.sourceId);
      }
      return fromToken;
    }
    if (workspace === null || workspace === '' || source === null || source === '') {
      throw TandemiseError.validation('Name the project and the source: ?workspace=<id>&source=<id>.');
    }
    return { workspaceId: asId<'WorkspaceId'>(workspace), sourceId: source, tokenId: null };
  }

  /**
   * One signal. Refusals (no tracker, unknown source, wrong source, rate) throw; an invalid signal is recorded as rejected.
   * `fromRunner`: a shipped runner's push through the runner host (plan Task 10). The per-minute limit is
   * spec §2's per-token limit for pushes from outside; a poll of 100 labelled issues is not one, and is not counted.
   */
  async ingest(scope: IntakeScope, raw: unknown, options?: { readonly fromRunner?: boolean }): Promise<IngestResultView> {
    const source = this.#admit(scope, [raw], options?.fromRunner !== true);
    return this.#record(scope, source, raw);
  }

  /** A push body: one signal or `{ signals: [...] }`. Each signal is checked on its own (RULINGS.md Ruling 2). */
  async ingestMany(scope: IntakeScope, body: unknown): Promise<readonly IngestResultView[]> {
    const parsed = intakePushBody.safeParse(body === undefined ? {} : body);
    if (!parsed.success) throw TandemiseError.validation(formatIntakeIssues(parsed.error));
    const raws = pushedSignals(parsed.data);
    const source = this.#admit(scope, raws);
    const results: IngestResultView[] = [];
    for (const raw of raws) results.push(await this.#record(scope, source, raw));
    return results;
  }

  /**
   * Everything that refuses a whole push, before anything is recorded: the
   * project, its tracker, the source, a signal naming another source, and
   * the rate limit, which counts signals rather than requests.
   */
  #admit(scope: IntakeScope, raws: readonly unknown[], rateLimited = true): IntakeSourceConfig {
    if (this.deps.workspaces.get(scope.workspaceId) === undefined) throw TandemiseError.notFound('Workspace', scope.workspaceId);
    const config = this.deps.config.read(scope.workspaceId);
    if (config.tracker === null) throw new TandemiseError('CONFLICT', "Set this project's tracker first.");
    const source = config.sources.find((s) => s.id === scope.sourceId);
    if (source === undefined) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${scope.sourceId}'.`, { details: { sourceId: scope.sourceId } });
    }
    for (const raw of raws) {
      const named = readableSource(raw);
      if (named !== null && (named.kind !== source.kind || named.instance !== source.instance)) {
        throw scope.tokenId !== null
          ? tokenScopeRefusal(source.id)
          : TandemiseError.permissionDenied(`Signals for '${source.id}' must name it as their source (${source.kind}, ${source.instance}).`);
      }
    }
    const key = scope.tokenId ?? `daemon:${scope.workspaceId}:${scope.sourceId}`;
    if (rateLimited && !this.#limit.take(key, raws.length)) {
      throw new TandemiseError('RATE_LIMITED', `Too many signals from this source: at most ${INTAKE_SIGNALS_PER_MINUTE} a minute.`, { retryable: true });
    }
    return source;
  }

  async #record(scope: IntakeScope, source: IntakeSourceConfig, raw: unknown): Promise<IngestResultView> {
    const checked = validateIntakeSignal(raw);
    if (!checked.ok) {
      const fingerprint = checked.fingerprint ?? `invalid:${source.id}:${sha256(JSON.stringify(raw) ?? '').slice(0, 16)}`;
      const signal = this.deps.intake.recordRejected(scope.workspaceId, source.id, fingerprint, checked.title ?? UNREADABLE_TITLE, checked.reason);
      this.deps.log.info('intake.signal_rejected', { workspaceId: scope.workspaceId, sourceId: source.id, fingerprint });
      return { fingerprint, signalId: signal.id, status: 'rejected', reason: checked.reason };
    }
    const { signal, firstTime } = this.deps.intake.upsertSignal(scope.workspaceId, source.id, checked.signal, this.deps.clock.now());
    await this.#keepAttachments(signal, checked.signal);
    this.deps.log.info('intake.signal_recorded', { workspaceId: scope.workspaceId, sourceId: source.id, fingerprint: signal.fingerprint, firstTime });
    this.#invalidate();
    // The push is answered with what was recorded; the tracker is talked to
    // after, so a slow tracker never holds a runner's request open.
    this.#enqueue(signal, 'reading');
    return { fingerprint: signal.fingerprint, signalId: signal.id, status: signal.status, reason: signal.reason };
  }

  /**
   * Inline content is stored by sha256, URLs are kept as links and never
   * fetched (spec §1: no SSRF surface). A repeat push adds only what is new.
   */
  async #keepAttachments(signal: IntakeSignal, parsed: IntakeSignalV1): Promise<void> {
    const list = parsed.attachments ?? [];
    if (list.length === 0) return;
    const kept = this.deps.intake.attachments(signal.id);
    for (const a of list) {
      const entry: Omit<IntakeAttachment, 'signalId'> = a.contentBase64 !== undefined
        ? { name: a.name, mediaType: a.mediaType, blobSha256: await this.deps.blobs.put(Buffer.from(a.contentBase64, 'base64')), url: null }
        : { name: a.name, mediaType: a.mediaType, blobSha256: null, url: a.url ?? null };
      const known = kept.some((k) => k.name === entry.name && k.blobSha256 === entry.blobSha256 && k.url === entry.url);
      if (!known) this.deps.intake.addAttachment(signal.id, entry);
    }
  }

  // ------------------------------------------------------------------ the pipeline (plan Task 7)

  /**
   * Scheduler hook. The first call finishes every link a crash left pending
   * (`recover`); every call queues the `received` signals whose last attempt
   * is a minute old, so a tracker that was down is tried again. Returns at
   * once: the work runs in the background, one signal at a time per project.
   */
  tick(): void {
    try {
      if (!this.#recovered) {
        this.#recovered = true;
        this.#recover();
      }
      const nowMs = this.deps.clock.epochMs();
      const waiting = new Set<SignalId>();
      for (const workspace of this.deps.workspaces.list()) {
        for (const signal of this.deps.intake.listSignals(workspace.id, { statuses: ['received'] })) {
          waiting.add(signal.id);
          if (this.#queued.has(signal.id)) continue;
          const last = this.#lastAttemptMs.get(signal.id);
          if (last !== undefined && nowMs - last < INTAKE_RETRY_EVERY_MS) continue;
          this.#enqueue(signal, 'retry');
        }
      }
      // Only waiting signals need their last attempt remembered.
      for (const id of this.#lastAttemptMs.keys()) if (!waiting.has(id)) this.#lastAttemptMs.delete(id);
    } catch (e) {
      this.deps.log.warn('intake.tick_failed', { error: errorMessage(e) });
    }
  }

  /** Resolves when every pass started so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  /**
   * A person's answer to an Inbox card (spec §5 step 4): `same` links the
   * signal to the candidate, `new` files a new item past the daily cap, and
   * `not_work` dismisses it. Runs in the project's queue, so it never races
   * the pipeline over the same signal.
   */
  async decide(caller: Caller, signalId: SignalId, decision: IntakeDecision): Promise<IntakeSignalView> {
    const found = this.#requireSignal(signalId);
    requireSeat(this.deps, found.workspaceId, caller);
    return this.#serial(found.workspaceId, async () => {
      const signal = this.#requireSignal(signalId);
      if (signal.status !== 'needs_decision') throw new TandemiseError('CONFLICT', 'This signal was already decided.');
      if (decision === 'not_work') {
        this.deps.intake.setStatus(signal.id, 'dismissed', 'You marked this as not work.');
        this.deps.log.info('intake.signal_dismissed', { signalId, by: caller.personId });
      } else if (decision === 'same') {
        const candidate = signal.candidateRef;
        if (candidate === null) {
          throw new TandemiseError('PRECONDITION_FAILED', 'There is no task to link this to. Choose New task or Not work.');
        }
        await this.#attempt(signal, (ctx) => this.#linkTo(ctx, signal, candidate as TrackerRef, 'person', null));
      } else {
        // A person's "new task" is not counted against the cap: the cap only
        // stops a flood from filing on its own (spec §4.1).
        await this.#attempt(signal, (ctx) => this.#create(ctx, signal));
      }
      this.#invalidate();
      return this.#signalView(this.#requireSignal(signalId));
    });
  }

  /** Runs a `received` signal through the pipeline now, rather than at the next minute's retry. */
  async retry(caller: Caller, signalId: SignalId): Promise<IntakeSignalView> {
    const found = this.#requireSignal(signalId);
    requireSeat(this.deps, found.workspaceId, caller);
    if (found.status !== 'received') {
      throw new TandemiseError('PRECONDITION_FAILED', 'Only a signal that is waiting for the tracker can be tried again.');
    }
    await this.#serial(found.workspaceId, () => this.#process(signalId, 'retry'));
    return this.#signalView(this.#requireSignal(signalId));
  }

  /** The Inbox cards intake raises: signals waiting on a person (plan Task 7). */
  decisions(workspaceId: WorkspaceId): readonly InboxIntakeDecisionView[] {
    return this.deps.intake.listSignals(workspaceId, { statuses: ['needs_decision'] }).map((s) => {
      const item = s.candidateRef === null ? undefined : this.deps.items.byRef(workspaceId, s.candidateRef);
      return {
        signalId: s.id,
        title: s.title,
        sourceLabel: sourceLabel(s.kind),
        question: s.reason ?? '',
        candidate: item === undefined ? null : { key: item.key, title: item.title, url: item.url },
        reason: s.reason,
        receivedAt: s.firstSeenAt,
      };
    });
  }

  /**
   * Every link a crash left `pending`, in any project, is finished first
   * (Review Focus 1): a link to a known item is written again (idempotent),
   * and a create searches the tracker by the signal's exact URL before it
   * creates, so the item exists once whether the crash came before or after
   * the tracker answered.
   */
  #recover(): void {
    for (const link of this.deps.intake.pendingLinks()) {
      const signal = this.deps.intake.getSignal(link.signalId);
      if (signal !== undefined) this.#enqueue(signal, 'recover');
    }
  }

  /** Queues a pass over a signal. Never rejects: a failure is on the signal, or logged. */
  #enqueue(signal: IntakeSignal, why: 'reading' | 'retry' | 'recover'): void {
    this.#queued.add(signal.id);
    void this.#serial(signal.workspaceId, async () => {
      this.#queued.delete(signal.id);
      await this.#process(signal.id, why === 'retry' ? 'retry' : 'any');
    }).catch((e: unknown) => {
      this.deps.log.warn('intake.process_crashed', { signalId: signal.id, error: errorMessage(e) });
    });
  }

  #serial<T>(workspaceId: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(workspaceId) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.#queues.set(workspaceId, tail);
    this.#running.add(tail);
    void tail.then(() => {
      this.#running.delete(tail);
      if (this.#queues.get(workspaceId) === tail) this.#queues.delete(workspaceId);
    });
    return run;
  }

  /**
   * One pass over one signal, in the plan's order: a pending link first, then
   * the local index, noise, dedupe, the daily cap, and create. `retry` passes
   * only touch a signal still `received`.
   */
  async #process(signalId: SignalId, mode: 'any' | 'retry'): Promise<void> {
    const signal = this.deps.intake.getSignal(signalId);
    if (signal === undefined) return;
    this.#lastAttemptMs.set(signalId, this.deps.clock.epochMs());
    const link = this.deps.intake.linkFor(signalId);
    if (link?.status === 'pending') {
      await this.#attempt(signal, (ctx) => this.#finishPending(ctx, signal, link));
      return;
    }
    if (mode === 'retry' && signal.status !== 'received') return;
    if (!PIPELINE_STATUSES.has(signal.status)) return;
    const config = this.deps.config.read(signal.workspaceId);
    if (config.tracker === null) return;
    // 2.1 The local index: this fingerprint already has its item.
    if (link?.status === 'done') {
      await this.#relink(signal, link, config.tracker);
      return;
    }
    const source = config.sources.find((s) => s.id === signal.sourceId);
    if (source === undefined) {
      this.deps.log.warn('intake.source_gone', { signalId, sourceId: signal.sourceId });
      return;
    }
    // 1. Noise, re-evaluated on every reading: 3 events can become 300.
    const noise = evaluateNoise(signal, source.filter, this.deps.clock.now());
    if (noise.verdict === 'held_back') {
      if (signal.status !== 'held_back' || signal.reason !== noise.reason) {
        this.deps.intake.setStatus(signalId, 'held_back', noise.reason);
        this.#invalidate();
      }
      return;
    }
    await this.#attempt(signal, (ctx) => this.#dedupeAndFile(ctx, signal, config));
  }

  /** Spec §5 steps 2 to 4, the daily cap, then create (plan Task 7). */
  async #dedupeAndFile(ctx: TrackerContext, signal: IntakeSignal, config: IntakeConfig): Promise<void> {
    const ws = signal.workspaceId;
    // 2.2 The source is the tracker: a GitHub issue of the tracker repository is that item.
    const own = ctx.tracker.refFromUrl?.(signal.url) ?? null;
    if (own !== null) {
      const link = this.deps.intake.createPendingLink(ws, signal.id, own, 'source_is_item');
      this.#complete(signal, link, own, null, 'linked', null);
      return;
    }
    // 2.3 Exact URL: every item Tandemise files or links lists its sources' URLs.
    const byUrl = oldest(unresolved(await ctx.tracker.search({ url: signal.url, unresolvedOnly: true, limit: URL_SEARCH_LIMIT }), ctx.config));
    if (byUrl !== null) {
      this.deps.items.upsert(ws, byUrl);
      await this.#linkTo(ctx, signal, byUrl.ref, 'url', null);
      return;
    }
    // 2.4 Similarity among unresolved items.
    const best = await this.#bestCandidate(ctx, signal, config.similarity.ask);
    if (best !== null && best.score >= config.similarity.link) {
      this.deps.items.upsert(ws, best.item);
      await this.#linkTo(ctx, signal, best.item.ref, 'similarity', best.score);
      return;
    }
    if (best !== null && best.score >= config.similarity.ask) {
      this.deps.items.upsert(ws, best.item);
      this.deps.intake.setStatus(signal.id, 'needs_decision', `Is this the same as ${best.item.key}?`, { candidateRef: best.item.ref, score: best.score });
      this.#invalidate();
      return;
    }
    // 3. The daily cap: past it, a person decides (spec §4.1).
    const now = this.deps.clock.now();
    if (this.deps.intake.createdToday(ws, signal.sourceId, `${now.slice(0, 10)}T00:00:00.000Z`) >= config.dailyCap) {
      this.deps.intake.setStatus(signal.id, 'needs_decision', dailyCapReason(config.dailyCap), { candidateRef: null, score: null });
      this.#invalidate();
      return;
    }
    // 4. Create.
    await this.#create(ctx, signal);
  }

  /**
   * The best unresolved candidate by `IntakeSimilarity`, ties to the older
   * item. The tracker's search wants every word, so a candidate whose title
   * lacks one of the signal's words is not found by the full title; when that
   * search finds nothing at or above `ask`, one broader search with the
   * title's first ⌈ask × n⌉ words follows (RULINGS ruling 12).
   */
  async #bestCandidate(ctx: TrackerContext, signal: IntakeSignal, ask: number): Promise<{ item: TrackerItem; score: number } | null> {
    const seen = new Map<string, TrackerItem>();
    const add = (items: readonly TrackerItem[]): void => { for (const i of unresolved(items, ctx.config)) if (!seen.has(i.ref)) seen.set(i.ref, i); };
    add(await ctx.tracker.search({ text: signal.title, unresolvedOnly: true, limit: TEXT_SEARCH_LIMIT }));
    let best = this.#rank(signal, seen);
    const words = titleTokens(signal.title);
    const fewer = Math.max(1, Math.ceil(words.length * ask));
    if ((best === null || best.score < ask) && fewer < words.length) {
      add(await ctx.tracker.search({ text: words.slice(0, fewer).join(' '), unresolvedOnly: true, limit: TEXT_SEARCH_LIMIT }));
      best = this.#rank(signal, seen);
    }
    return best;
  }

  #rank(signal: IntakeSignal, candidates: ReadonlyMap<string, TrackerItem>): { item: TrackerItem; score: number } | null {
    let best: { item: TrackerItem; score: number } | null = null;
    for (const item of candidates.values()) {
      const score = this.deps.similarity.score({ title: signal.title, description: signal.description, url: signal.url }, item);
      if (best === null || score > best.score || (score === best.score && item.createdAt < best.item.createdAt)) best = { item, score };
    }
    return best;
  }

  /** Links the signal to an existing item: pending link, the sources comment, then done. */
  async #linkTo(ctx: TrackerContext, signal: IntakeSignal, ref: TrackerRef, by: IntakeLinkedBy, score: number | null): Promise<void> {
    const link = this.deps.intake.createPendingLink(signal.workspaceId, signal.id, ref, by, score);
    await ctx.tracker.link(ref, sourceEntry(signal, sourceLabel(signal.kind)));
    this.#complete(signal, link, ref, null, 'linked', linkWritten(signal.impact, this.#cachedResolved(signal.workspaceId, ref, ctx.config)));
  }

  /**
   * Files a new item. The link is written first, with no ref: if the daemon
   * dies before the tracker answers, `#finishPending` searches by URL before
   * it creates again.
   */
  async #create(ctx: TrackerContext, signal: IntakeSignal): Promise<void> {
    const link = this.deps.intake.createPendingLink(signal.workspaceId, signal.id, null, 'created');
    const item = await ctx.tracker.create(await this.#draft(ctx, signal));
    this.#complete(signal, link, item.ref, item, 'created', linkWritten(signal.impact, false));
  }

  /** Finishes a link a crash or a failed call left pending (Review Focus 1). */
  async #finishPending(ctx: TrackerContext, signal: IntakeSignal, link: IntakeLink): Promise<void> {
    if (link.itemRef !== null) {
      const ref = link.itemRef as TrackerRef;
      if (link.linkedBy === 'source_is_item') {
        this.#complete(signal, link, ref, null, 'linked', null);
        return;
      }
      // Idempotent: a URL already in the sources comment has its entry replaced, not added.
      await ctx.tracker.link(ref, sourceEntry(signal, sourceLabel(signal.kind)));
      this.#complete(signal, link, ref, null, 'linked', linkWritten(signal.impact, this.#cachedResolved(signal.workspaceId, ref, ctx.config)));
      return;
    }
    // A create that may or may not have reached the tracker: the exact URL decides.
    const found = oldest(unresolved(await ctx.tracker.search({ url: signal.url, unresolvedOnly: true, limit: URL_SEARCH_LIMIT }), ctx.config));
    if (found !== null) this.deps.log.info('intake.pending_create_adopted', { signalId: signal.id, ref: found.ref });
    const item = found ?? await ctx.tracker.create(await this.#draft(ctx, signal));
    this.#complete(signal, link, item.ref, item, 'created', linkWritten(signal.impact, false));
  }

  /**
   * 2.1: the signal again. Its status reads `linked`; the sources comment is
   * updated only when the change matters (spec §6.1), and a tracker that fails
   * here leaves the link as it is: the next reading tries again.
   */
  async #relink(signal: IntakeSignal, link: IntakeLink, config: TrackerConfig): Promise<void> {
    const ref = link.itemRef as TrackerRef;
    const resolved = this.#cachedResolved(signal.workspaceId, ref, config);
    if (link.linkedBy !== 'source_is_item' && linkChangeMatters(link.written, { impact: signal.impact, itemResolved: resolved })) {
      try {
        const { tracker } = await this.deps.trackers.for(signal.workspaceId);
        await tracker.link(ref, sourceEntry(signal, sourceLabel(signal.kind)));
        this.deps.intake.setLinkWritten(link.id, linkWritten(signal.impact, resolved));
      } catch (e) {
        this.deps.log.warn('intake.sources_update_failed', { signalId: signal.id, ref, error: errorMessage(e) });
      }
    }
    if (signal.status !== 'linked' || signal.reason !== null) {
      this.deps.intake.setStatus(signal.id, 'linked', null);
      this.#invalidate();
    }
  }

  /**
   * Runs a step against the project's tracker. Any failure leaves the signal
   * `received`, with the reason in plain words, and the minute's retry (or a
   * restart's recover) picks it up; a pending link stays pending for that.
   */
  async #attempt(signal: IntakeSignal, step: (ctx: TrackerContext) => Promise<void>): Promise<void> {
    const kind = this.deps.config.read(signal.workspaceId).tracker?.kind ?? 'tracker';
    try {
      await step(await this.deps.trackers.for(signal.workspaceId));
    } catch (e) {
      const message = errorMessage(e).replace(/[.\s]+$/, '');
      this.deps.intake.setStatus(signal.id, 'received', `Couldn't reach ${trackerLabel(kind)}: ${message}. Tandemise will try again.`);
      this.deps.log.warn('intake.tracker_failed', { signalId: signal.id, workspaceId: signal.workspaceId, error: errorMessage(e) });
      this.#invalidate();
    }
  }

  /** The link done, its item cached and the signal's status, in one transaction. */
  #complete(
    signal: IntakeSignal, link: IntakeLink, ref: TrackerRef, item: TrackerItem | null,
    status: 'linked' | 'created', written: ReturnType<typeof linkWritten> | null,
  ): void {
    this.deps.unitOfWork.transaction(() => {
      this.deps.intake.completeLink(link.id, ref);
      if (item !== null) this.deps.items.upsert(signal.workspaceId, item);
      this.deps.intake.setLinkWritten(link.id, written);
      this.deps.intake.setStatus(signal.id, status, null, { candidateRef: null, score: link.score });
    });
    this.deps.log.info('intake.signal_filed', { signalId: signal.id, ref, status, linkedBy: link.linkedBy });
    this.#invalidate();
  }

  /**
   * The new item's text (spec §6.1). Inline attachments are uploaded when the
   * tracker takes uploads; every other attachment is listed in the description.
   */
  async #draft(ctx: TrackerContext, signal: IntakeSignal): Promise<Parameters<PrimaryTracker['create']>[0]> {
    const source = this.deps.config.read(signal.workspaceId).sources.find((s) => s.id === signal.sourceId) ?? {};
    const uploads: AttachmentRef[] = [];
    const listed: { name: string; url: string | null }[] = [];
    for (const a of this.deps.intake.attachments(signal.id)) {
      const content = a.blobSha256 !== null && ctx.tracker.capabilities.attachments ? await this.deps.blobs.get(a.blobSha256) : null;
      if (content !== null) uploads.push({ name: a.name, mediaType: a.mediaType, content });
      else listed.push({ name: a.name, url: a.url });
    }
    const draft = createDraft(signal, source, sourceLabel(signal.kind), listed);
    return uploads.length === 0 ? draft : { ...draft, attachments: uploads };
  }

  /** Whether the board cache last saw the item resolved (a mapped done or won't-do state). */
  #cachedResolved(workspaceId: WorkspaceId, ref: string, config: TrackerConfig): boolean {
    const item = this.deps.items.byRef(workspaceId, ref);
    return item !== undefined && isResolved(item.state, config);
  }

  #requireSignal(signalId: SignalId): IntakeSignal {
    const signal = this.deps.intake.getSignal(signalId);
    if (signal === undefined) throw TandemiseError.notFound('Signal', signalId);
    return signal;
  }

  #invalidate(): void {
    this.deps.projections?.invalidate('intake');
  }

  // ------------------------------------------------------------------ reading

  list(workspaceId: WorkspaceId, filter: { readonly statuses?: readonly SignalStatus[]; readonly limit?: number }): readonly IntakeSignalView[] {
    this.#requireWorkspace(workspaceId);
    return this.deps.intake.listSignals(workspaceId, filter).map((s) => this.#signalView(s));
  }

  #signalView(s: IntakeSignal): IntakeSignalView {
    return {
      id: s.id,
      sourceId: s.sourceId,
      fingerprint: s.fingerprint,
      sourceLabel: s.kind === '' ? s.sourceId : sourceLabel(s.kind),
      instance: s.instance,
      key: s.key,
      url: s.url,
      title: s.title,
      status: s.status,
      reason: s.reason,
      occurrences: s.occurrences,
      impact: s.impact,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      itemRef: this.deps.intake.linkFor(s.id)?.itemRef ?? null,
    };
  }

  // ------------------------------------------------------------------ configuration

  config(workspaceId: WorkspaceId): IntakeConfigView {
    this.#requireWorkspace(workspaceId);
    const read = this.deps.config.read(workspaceId);
    const origin = this.deps.config.originFor?.(workspaceId) ?? this.deps.config.origin;
    // Whether each source runs on this machine (Ruling 22): its row, else the origin's default.
    const enabled = Object.fromEntries(read.sources.map((s) => [s.id, this.deps.intake.source(workspaceId, s.id)?.enabled ?? origin !== 'brain']));
    return { origin, editable: this.deps.config.write !== undefined && origin === 'local', ...read, enabled, originMismatch: this.#originMismatch(workspaceId, read.sources) };
  }

  /**
   * Every saved credential whose configured address is no longer the one it
   * was saved for (Ruling 23): Settings → Intake asks to use the new one.
   */
  #originMismatch(workspaceId: WorkspaceId, sources: readonly IntakeSourceConfig[]): IntakeConfigView['originMismatch'] {
    const runners = this.deps.runners();
    const moved: Record<string, IntakeOriginMismatchView> = {};
    for (const source of sources) {
      if (Object.keys(this.deps.intake.source(workspaceId, source.id)?.secretRefs ?? {}).length === 0) continue;
      const m = mismatchOf(this.deps.intake.credentialOrigins, workspaceId, sourceCredential(source.id), sourceOrigin(source, runners));
      if (m !== null) moved[source.id] = { ...m, message: sourceMovedSentence(m.current) };
    }
    const tracker = this.deps.trackers.originMismatch(workspaceId);
    return { tracker: tracker === null ? null : { ...tracker, message: trackerMovedSentence(tracker.current) }, sources: moved };
  }

  /**
   * "Use the new address" for the tracker (Ruling 23): the saved token is
   * bound to the tracker's address as configured now. Answers the config view.
   */
  confirmTrackerOrigin(caller: Caller, workspaceId: WorkspaceId): IntakeConfigView {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const moved = this.deps.trackers.originMismatch(workspaceId);
    this.deps.trackers.confirmOrigin(workspaceId);
    this.deps.log.info('intake.tracker_origin_confirmed', { workspaceId, from: moved?.saved ?? null, to: moved?.current ?? null });
    this.#trackerChanged(workspaceId);
    return this.config(workspaceId);
  }

  /**
   * "Use the new address" for one source (Ruling 23): its saved secrets are
   * bound to its address as configured now, and the refusal on the source
   * is cleared. Answers the config view.
   */
  confirmSourceOrigin(caller: Caller, workspaceId: WorkspaceId, sourceId: string): IntakeConfigView {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const source = this.deps.config.read(workspaceId).sources.find((s) => s.id === sourceId);
    if (source === undefined) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${sourceId}'.`, { details: { sourceId } });
    }
    const origin = sourceOrigin(source, this.deps.runners());
    const from = this.deps.intake.credentialOrigins.get(workspaceId, sourceCredential(sourceId)) ?? null;
    this.deps.intake.credentialOrigins.set(workspaceId, sourceCredential(sourceId), origin);
    const row = this.deps.intake.source(workspaceId, sourceId);
    if (row !== undefined && row.lastError === sourceMovedSentence(origin)) this.deps.intake.saveSource(workspaceId, sourceId, { lastError: null });
    this.deps.log.info('intake.source_origin_confirmed', { workspaceId, sourceId, from, to: origin });
    return this.config(workspaceId);
  }

  /**
   * Switches a configured source on or off on this machine only (Ruling 22):
   * `intake_sources.enabled`, never the configuration, so a source from the
   * brain can be run by the one person who switches it on.
   */
  setSourceEnabled(caller: Caller, workspaceId: WorkspaceId, sourceId: string, enabled: boolean): IntakeConfigView {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const source = this.deps.config.read(workspaceId).sources.find((s) => s.id === sourceId);
    if (source === undefined) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${sourceId}'.`, { details: { sourceId } });
    }
    const row = this.deps.intake.source(workspaceId, sourceId);
    this.deps.intake.saveSource(workspaceId, sourceId, {
      ...(row === undefined ? { kind: source.kind } : {}),
      enabled,
      ...(enabled ? { enabledBy: caller.personId } : {}),
    });
    this.deps.log.info('intake.source_switched', { workspaceId, sourceId, enabled });
    return this.config(workspaceId);
  }

  /**
   * Takes the request unparsed: its file schemas fill defaults, so the parsed
   * shape differs from what a client sends, and parsing here keeps the zod
   * types out of the route.
   */
  async configure(caller: Caller, workspaceId: WorkspaceId, body: unknown): Promise<IntakeConfigView> {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const parsed = updateIntakeConfigRequest.safeParse(body === undefined ? {} : body);
    if (!parsed.success) throw TandemiseError.validation(formatIntakeIssues(parsed.error));
    const request = parsed.data;
    const write = this.deps.config.write?.bind(this.deps.config);
    if (write === undefined || (this.deps.config.originFor?.(workspaceId) ?? this.deps.config.origin) === 'brain') {
      throw new TandemiseError('PRECONDITION_FAILED', "This project's intake is set in its brain. Change it there.");
    }
    // A mapping naming a state the tracker doesn't have is refused in its own
    // words before anything is saved (spec §6.2, plan Task 5).
    if (request.tracker !== undefined && request.tracker !== null) {
      const problem = await this.deps.trackers.problemWith(workspaceId, request.tracker);
      if (problem !== null) throw new TandemiseError('PRECONDITION_FAILED', problem);
    }
    write(workspaceId, {
      ...(request.tracker === undefined ? {} : { tracker: request.tracker }),
      ...(request.intake === undefined ? {} : { intake: request.intake }),
    });
    if (request.tracker !== undefined) this.#trackerChanged(workspaceId);
    return this.config(workspaceId);
  }

  // ------------------------------------------------------------------ secrets

  /**
   * Saves one of a source's named secrets in the local secret store (spec §2,
   * plan Task 11) and records its ref in `intake_sources.secret_refs`,
   * replacing, and removing from the store, the one saved before under that
   * name. An empty value only removes it. The secret never reaches a config
   * file or the brain. The source's row is created here when it has none yet,
   * with the machine's default, as the runner host would (RULINGS rulings 15
   * and 22): on for local configuration, off for a source from the brain.
   */
  async saveSourceSecret(caller: Caller, workspaceId: WorkspaceId, sourceId: string, secret: { readonly name: string; readonly value: string }): Promise<void> {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    const source = this.deps.config.read(workspaceId).sources.find((s) => s.id === sourceId);
    if (source === undefined) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${sourceId}'.`, { details: { sourceId } });
    }
    const row = this.deps.intake.source(workspaceId, sourceId);
    const old = row?.secretRefs[secret.name];
    const refs: Record<string, string> = { ...(row?.secretRefs ?? {}) };
    if (secret.value === '') delete refs[secret.name];
    else refs[secret.name] = await this.deps.secrets.store(`intake:${workspaceId}:source:${sourceId}:${secret.name}`, secret.value);
    this.deps.intake.saveSource(workspaceId, sourceId, {
      ...(row === undefined ? { kind: source.kind, enabled: sourceOnByDefault(this.deps.config, workspaceId), enabledBy: caller.personId } : {}),
      secretRefs: refs,
    });
    // Ruling 23: the source's secrets go only to the address they were saved for.
    this.deps.intake.credentialOrigins.set(workspaceId, sourceCredential(sourceId),
      Object.keys(refs).length === 0 ? null : sourceOrigin(source, this.deps.runners()));
    // After the new ref is recorded, so a failure here leaves a stray secret, never a source without one.
    if (old !== undefined) {
      await this.deps.secrets.remove(old).catch((e: unknown) => {
        this.deps.log.warn('intake.secret_remove_failed', { workspaceId, sourceId, name: secret.name, error: errorMessage(e) });
      });
    }
    this.deps.log.info('intake.source_secret_saved', { workspaceId, sourceId, name: secret.name, removed: secret.value === '' });
  }

  /**
   * Saves the project's tracker token (RULINGS ruling 17): Task 10 left
   * `TrackerResolver.saveCredential` with no route, so Settings → Intake
   * (plan Task 14) saves it here.
   */
  async saveTrackerSecret(caller: Caller, workspaceId: WorkspaceId, value: string): Promise<void> {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    await this.deps.trackers.saveCredential(workspaceId, value);
    this.deps.log.info('intake.tracker_secret_saved', { workspaceId });
    this.#trackerChanged(workspaceId);
  }

  /** Never fails the save it follows: the board is only a cache of the tracker. */
  #trackerChanged(workspaceId: WorkspaceId): void {
    try {
      this.deps.trackerChanged?.(workspaceId);
    } catch (e) {
      this.deps.log.warn('intake.board_refresh_after_save_failed', { workspaceId, error: errorMessage(e) });
    }
  }

  // ------------------------------------------------------------------ tokens

  /**
   * A push token for one source, shown once (spec §2). Only its sha256 is
   * stored, so a lost token is revoked and minted again, never recovered.
   */
  mintToken(caller: Caller, workspaceId: WorkspaceId, sourceId: string): IntakeTokenMintedView {
    this.#requireWorkspace(workspaceId);
    requireSeat(this.deps, workspaceId, caller);
    if (!this.deps.config.read(workspaceId).sources.some((s) => s.id === sourceId)) {
      throw new TandemiseError('NOT_FOUND', `This project has no intake source '${sourceId}'.`, { details: { sourceId } });
    }
    const token = `${INTAKE_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
    const row = this.deps.intake.tokens.create(workspaceId, sourceId, sha256(token), caller.personId);
    this.deps.log.info('intake.token_minted', { workspaceId, sourceId, tokenId: row.id });
    return { id: row.id, token };
  }

  /**
   * Revoking takes a seat in the token's project (Ruling 26). Anyone else is
   * told there is no such token, as for an id that never existed, so a token
   * id says nothing about another project.
   */
  revokeToken(caller: Caller, id: IntakeTokenId): void {
    const row = this.deps.intake.tokens.byId(id);
    if (row === undefined) throw TandemiseError.notFound('Intake token', id);
    try {
      requireSeat(this.deps, row.workspaceId, caller);
    } catch {
      throw TandemiseError.notFound('Intake token', id);
    }
    this.deps.intake.tokens.revoke(id);
    this.deps.log.info('intake.token_revoked', { workspaceId: row.workspaceId, tokenId: id });
  }

  /** The scope an intake token grants, or null for anything else, revoked tokens included. */
  resolveToken(token: string): IntakeScope | null {
    if (!token.startsWith(INTAKE_TOKEN_PREFIX)) return null;
    const row = this.deps.intake.tokens.byHash(sha256(token));
    if (row === undefined || row.revokedAt !== null) return null;
    return { workspaceId: row.workspaceId, sourceId: row.sourceId, tokenId: row.id };
  }

  #requireWorkspace(workspaceId: WorkspaceId): void {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
  }
}

function tokenScopeRefusal(sourceId: string): TandemiseError {
  return TandemiseError.permissionDenied(`This token can only push to '${sourceId}'.`, { sourceId });
}

/** The source a raw signal names, when both parts are strings; validation says the rest. */
function readableSource(raw: unknown): { kind: string; instance: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = (raw as { source?: unknown }).source;
  if (typeof source !== 'object' || source === null) return null;
  const { kind, instance } = source as { kind?: unknown; instance?: unknown };
  return typeof kind === 'string' && typeof instance === 'string' ? { kind, instance } : null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The items the mapping does not count as resolved (a done or won't-do state). */
function unresolved(items: readonly TrackerItem[], config: TrackerConfig): readonly TrackerItem[] {
  return items.filter((i) => !isResolved(i.state, config));
}

function isResolved(state: string, config: TrackerConfig): boolean {
  return config.states.done.includes(state) || config.states.wont_do.includes(state);
}

/**
 * The oldest of several items, ties to the lower key: the one a duplicate
 * merge keeps too (plan Task 8), so every daemon converges on the same item.
 */
function oldest(items: readonly TrackerItem[]): TrackerItem | null {
  let best: TrackerItem | null = null;
  for (const i of items) {
    if (best === null || i.createdAt < best.createdAt || (i.createdAt === best.createdAt && i.key.localeCompare(best.key, 'en', { numeric: true }) < 0)) best = i;
  }
  return best;
}
