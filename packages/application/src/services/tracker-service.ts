import type {
  ActivityCommentInput, ApprovalRepositoryPort, ArtifactRepositoryPort, EventRepositoryPort, CriteriaTrace, IntakeClaimsPort, IntakeConfigSource, IntakeRepositoryPort,
  IntakeSignal, MemberRepositoryPort, Mission, MissionRepositoryPort, PersonRepositoryPort,
  PrimaryTracker, ProjectionBusPort, SourceEntry, TrackedItem, TrackerConfig, TrackerItem, TrackerItemRepositoryPort, TrackerRef, UnitOfWork,
  TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  FACTORY_WORKFLOW_ID, activityCommentBody, activityMilestone, activityMilestoneOf, activityStepState, decideTrackerWriteBack, isTerminalMissionStatus, parseCriteria,
  parseSourcesSection, runtimeSlotWait, sourceLabel, trackerGoal, trackerLabel, trackerRef,
} from '@tandemise/domain';
import type { BoardItemView, BoardView, CreateMissionRequest } from '@tandemise/api-contract';
import type { Clock, Logger, MissionId, TrackerItemId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage, ids } from '@tandemise/shared';
import type { SettingsStorePort } from '../ports.js';
import { deliveryLinks, type DeliveryLink } from '../support/delivery-links.js';
import type { EventRecorder } from '../support/event-recorder.js';
import { requireSeat, type Caller } from '../support/identity.js';
import type { TrackerResolver } from '../intake/tracker-resolver.js';
import { impactWords, sourceEntry } from '../intake/item-text.js';
import { isOriginChanged } from '../intake/credential-origin.js';

export interface TrackerServiceDeps {
  readonly config: IntakeConfigSource;
  readonly trackers: Pick<TrackerResolver, 'for'>;
  /** The board cache. */
  readonly items: TrackerItemRepositoryPort;
  /** The signals linked to each item: the board's source chips, and the links a duplicate merge moves. */
  readonly intake: IntakeRepositoryPort;
  readonly missions: Pick<MissionRepositoryPort, 'list' | 'get'>;
  /** `MissionService.create`, the only way a mission is made (spec §7 step 3). Resolved per call. */
  readonly createMission: (caller: Caller, request: CreateMissionRequest, origin: { trackerItemId: TrackerItemId; missionId?: MissionId }) => Promise<Mission>;
  /**
   * Plans a factory mission Start made with no Done-when line (#53 §4): the
   * quick and standard lanes plan at once; a careful one is refused by the
   * readiness gate and stays a draft to refine. Resolved per call.
   */
  readonly planDraft?: (missionId: MissionId) => Promise<unknown>;
  /** Who works on what across daemons; always granted without the relay (#54). */
  readonly claims: IntakeClaimsPort;
  /** Personal settings: `trackerLogins[<workspace>]`, the person's login in the tracker. */
  readonly settings: SettingsStorePort;
  readonly members: MemberRepositoryPort;
  /** The starter's own name, which the goal and the activity comment attribute the work to. */
  readonly people: Pick<PersonRepositoryPort, 'get'>;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get' | 'list'>;
  readonly recorder: Pick<EventRecorder, 'note' | 'invalidate'>;
  /** The plan's steps, for the activity comment's checklist (plan Task 9). */
  readonly tasks: Pick<TaskRepositoryPort, 'listByMission'>;
  /** A PENDING approval: the mission waits on a person. */
  readonly approvals: Pick<ApprovalRepositoryPort, 'list'>;
  /** The mission's handoffs, for its pull request. */
  readonly artifacts: Pick<ArtifactRepositoryPort, 'listByMission'>;
  /** The mission's events: the ship step's pull requests (#53), which are no handoff link. */
  readonly events?: Pick<EventRepositoryPort, 'listByMission'>;
  /** The P5 trace, for the completed criteria table, as P14's completion comment. */
  readonly trace: (missionId: MissionId) => CriteriaTrace;
  /** Tells open windows the board changed; optional for harnesses. */
  readonly projections?: Pick<ProjectionBusPort, 'invalidate'>;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly log: Logger;
  /** `ClosureService.detect`, after each refresh: a done item closes the loop at its sources (plan Task 13). */
  readonly detectClosures?: (workspaceId: WorkspaceId, items: readonly TrackedItem[]) => void;
}

/** Spec §7: the board is refreshed on the scheduler tick every 2 minutes by default. */
export const BOARD_REFRESH_EVERY_MS = 120_000;
/** A Start whose tracker writes failed is tried again no more than once a minute. */
const START_RETRY_EVERY_MS = 60_000;
/** Plan Task 9: the write-back pass runs every 5 s, like P14's. */
const WRITE_BACK_EVERY_MS = 5_000;
/** Spec §7: the activity comment is edited at most once a minute. */
const ACTIVITY_EDIT_EVERY_MS = 60_000;
/** An item whose write-back failed is tried again no sooner than this. */
const WRITE_BACK_RETRY_MS = 60_000;
/** Plan Task 8: the board query's first 200 items. */
const BOARD_LIMIT = 200;
/** How many exact-URL hits are worth reading when a merged item's links move. */
const URL_SEARCH_LIMIT = 5;
const MAX_TITLE = 200;
/** The settings key of each project's tracker login (personal, never in the brain; spec §7 step 4). */
export const TRACKER_LOGINS_SETTINGS_KEY = 'trackerLogins';

/**
 * The board from the project's primary tracker, and Start (spec §7, plan
 * Task 8).
 *
 * The board is a cache (`tracker_items`) of what the brain's board query
 * returns; the tracker is the truth and Tandemise never reorders or edits it.
 * A refresh also merges duplicates: two daemons racing on one signal can both
 * file an item (spec §3), and the refresh that sees two unresolved items
 * carrying the same source URL keeps the older, marks the newer its duplicate
 * and moves the newer's sources and links over. A daemon whose own link
 * points at an item someone else marked duplicate follows it to the survivor
 * (Review Focus 2).
 *
 * Start is the only way a tracker item becomes a mission. It refuses a second
 * mission for the item, an item already in progress, and an item another
 * daemon claims, each in its own words, and it never queues the mission: a
 * started item is the person's work, never P7's to pull (Review Focus 4).
 */
export class TrackerService {
  /** One refresh or Start at a time per project, so neither races the other over the cache. */
  readonly #queues = new Map<WorkspaceId, Promise<void>>();
  readonly #running = new Set<Promise<void>>();
  /** When each project's board was last read, and why it could not be. */
  readonly #refreshes = new Map<WorkspaceId, { at: string | null; problem: string | null }>();
  /**
   * The refs the last successful board read returned, per project. The board
   * shows only these: the cache also keeps items a mission or a signal points
   * at (Ruling 13), which the board query may no longer return (Ruling 29).
   * Unknown until the first read after a start, when the whole cache shows.
   */
  readonly #onBoard = new Map<WorkspaceId, ReadonlySet<string>>();
  readonly #lastRefreshMs = new Map<WorkspaceId, number>();
  readonly #lastStartRetryMs = new Map<WorkspaceId, number>();
  readonly #lastWriteBackMs = new Map<WorkspaceId, number>();
  /** Per item: no write-back before this, after a failure. */
  readonly #writeBackRetryAfter = new Map<TrackerItemId, number>();
  /** Finished missions whose last state has landed: no pass reads them again until a restart. */
  readonly #settled = new Set<MissionId>();

  constructor(private readonly deps: TrackerServiceDeps) {}

  // ------------------------------------------------------------------ the board

  /** The board from the cache, grouped by mapped state; items in a done or won't-do state are not on it. */
  board(workspaceId: WorkspaceId): BoardView {
    this.#requireWorkspace(workspaceId);
    const config = this.deps.config.read(workspaceId).tracker;
    if (config === null) {
      return { trackerLabel: '', groups: { ready: [], inProgress: [], inReview: [] }, refreshedAt: null, problem: "Set this project's tracker first." };
    }
    const cached = this.deps.items.list(workspaceId);
    const missions = this.#missionsByItem(workspaceId);
    const ready: BoardItemView[] = [];
    const inProgress: BoardItemView[] = [];
    const inReview: BoardItemView[] = [];
    const onBoard = this.#onBoard.get(workspaceId);
    for (const item of cached) {
      if (onBoard !== undefined && !onBoard.has(item.ref)) continue;
      const group = config.states.ready.includes(item.state) ? ready
        : item.state === config.states.in_progress ? inProgress
          : config.states.in_review !== undefined && item.state === config.states.in_review ? inReview : null;
      group?.push(this.#itemView(workspaceId, item, config, missions.get(item.id) ?? []));
    }
    // After a restart the cache still says when it was last read.
    const last = this.#refreshes.get(workspaceId);
    const cachedAt = cached.reduce<string | null>((max, i) => (max === null || i.refreshedAt > max ? i.refreshedAt : max), null);
    return {
      trackerLabel: trackerLabel(config.kind),
      groups: { ready, inProgress, inReview },
      refreshedAt: last?.at ?? cachedAt,
      problem: last?.problem ?? null,
    };
  }

  /**
   * Reads the board query again, merges duplicates, and answers the board. A
   * tracker that cannot be reached is the board's `problem`, in plain words;
   * the cache stays as it was.
   */
  async refreshBoard(workspaceId: WorkspaceId): Promise<BoardView> {
    this.#requireWorkspace(workspaceId);
    if (this.deps.config.read(workspaceId).tracker !== null) await this.#serial(workspaceId, () => this.#refresh(workspaceId));
    return this.board(workspaceId);
  }

  /**
   * The project's tracker token, address or mapping was just saved (#134):
   * the board's last problem was about the tracker as it was, so it is
   * dropped at once and the board is read again in the background, rather
   * than on the next 2-minute tick. A read that still fails sets its own
   * problem again.
   */
  trackerChanged(workspaceId: WorkspaceId): void {
    const last = this.#refreshes.get(workspaceId);
    if (last !== undefined) this.#refreshes.set(workspaceId, { at: last.at, problem: null });
    this.#invalidate();
    if (this.deps.config.read(workspaceId).tracker === null) return;
    this.#lastRefreshMs.set(workspaceId, this.deps.clock.epochMs());
    this.#background(workspaceId, () => this.#refresh(workspaceId));
  }

  /**
   * Scheduler hook: each configured project's board every 2 minutes, and the
   * tracker writes a Start could not make, once a minute, and the write-back
   * of every started item's state and activity comment, every 5 s (plan Task
   * 9). Returns at once; the work runs in the background (`settle()` waits
   * for it).
   */
  tick(): void {
    try {
      const nowMs = this.deps.clock.epochMs();
      for (const workspace of this.deps.workspaces.list()) {
        const config = this.deps.config.read(workspace.id).tracker;
        if (config === null) continue;
        const refreshed = this.#lastRefreshMs.get(workspace.id);
        if (refreshed === undefined || nowMs - refreshed >= BOARD_REFRESH_EVERY_MS) {
          this.#lastRefreshMs.set(workspace.id, nowMs);
          this.#background(workspace.id, () => this.#refresh(workspace.id));
        }
        const retried = this.#lastStartRetryMs.get(workspace.id);
        if (retried === undefined || nowMs - retried >= START_RETRY_EVERY_MS) {
          this.#lastStartRetryMs.set(workspace.id, nowMs);
          this.#background(workspace.id, () => this.#retryStartWrites(workspace.id));
        }
        const wrote = this.#lastWriteBackMs.get(workspace.id);
        if (wrote === undefined || nowMs - wrote >= WRITE_BACK_EVERY_MS) {
          this.#lastWriteBackMs.set(workspace.id, nowMs);
          this.#background(workspace.id, () => this.#writeBack(workspace.id));
        }
      }
    } catch (e) {
      this.deps.log.warn('tracker.tick_failed', { error: errorMessage(e) });
    }
  }

  /** Resolves when every refresh and Start begun so far has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  async #refresh(workspaceId: WorkspaceId): Promise<void> {
    const kind = this.deps.config.read(workspaceId).tracker?.kind ?? 'tracker';
    this.#lastRefreshMs.set(workspaceId, this.deps.clock.epochMs());
    try {
      const ctx = await this.deps.trackers.for(workspaceId);
      const fetched = await ctx.tracker.board({ query: ctx.config.board, limit: BOARD_LIMIT });
      for (const item of fetched) this.deps.items.upsert(workspaceId, item);
      await this.#mergeDuplicates(workspaceId, ctx, fetched);
      await this.#followMissing(workspaceId, ctx, new Set(fetched.map((i) => i.ref)));
      // An item the query no longer returns is forgotten, unless a mission or a
      // signal points at it: forgetting it would cut the mission from its item
      // and the signal from its chip (RULINGS ruling 13).
      const keep = new Set<string>(fetched.map((i) => i.ref));
      this.#onBoard.set(workspaceId, new Set(keep));
      const missions = this.#missionsByItem(workspaceId);
      for (const item of this.deps.items.list(workspaceId)) {
        if (missions.has(item.id) || this.deps.intake.linksForItem(workspaceId, item.ref).length > 0) keep.add(item.ref);
      }
      this.deps.items.removeMissing(workspaceId, [...keep]);
      this.#refreshes.set(workspaceId, { at: this.deps.clock.now(), problem: null });
      // Spec §8: an item seen done closes the loop, whoever moved it there.
      try {
        this.deps.detectClosures?.(workspaceId, this.deps.items.list(workspaceId));
      } catch (e) {
        this.deps.log.warn('intake.closure_detect_failed', { workspaceId, error: errorMessage(e) });
      }
    } catch (e) {
      const message = errorMessage(e).replace(/[.\s]+$/, '');
      const previous = this.#refreshes.get(workspaceId);
      // A moved tracker address is not a reach failure: its own sentence says what to do (Ruling 23).
      const problem = isOriginChanged(e) ? e.message : `Couldn't reach ${trackerLabel(kind)}: ${message}. Tandemise will try again.`;
      this.#refreshes.set(workspaceId, { at: previous?.at ?? null, problem });
      this.deps.log.warn('tracker.board_refresh_failed', { workspaceId, error: errorMessage(e) });
    }
    this.#invalidate();
  }

  /**
   * Review Focus 2. Unresolved items that share a source URL (their Sources
   * section) are one piece of work: the oldest survives, ties to the lower
   * key, the same item a pending create adopts (RULINGS ruling 12), so every
   * daemon converges on it. Each newer one has its source URLs linked to the
   * survivor, is marked its duplicate (or moved to the first won't-do state
   * when the tracker has no duplicate link), and this daemon's links move over.
   */
  async #mergeDuplicates(workspaceId: WorkspaceId, ctx: { tracker: PrimaryTracker; config: TrackerConfig }, fetched: readonly TrackerItem[]): Promise<void> {
    const open = fetched.filter((i) => !isResolved(i.state, ctx.config));
    // Items joined by any shared URL are one group (a union-find over refs).
    const parent = new Map<string, string>(open.map((i) => [i.ref, i.ref]));
    const root = (ref: string): string => {
      let r = ref;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const firstByUrl = new Map<string, string>();
    for (const item of open) {
      for (const url of new Set(parseSourcesSection(item.description))) {
        const seen = firstByUrl.get(url);
        if (seen === undefined) firstByUrl.set(url, item.ref);
        else parent.set(root(item.ref), root(seen));
      }
    }
    const groups = new Map<string, TrackerItem[]>();
    for (const item of open) {
      const r = root(item.ref);
      groups.set(r, [...(groups.get(r) ?? []), item]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const older = oldest(group)!;
      for (const newer of group) {
        if (newer.ref !== older.ref) await this.#merge(workspaceId, ctx, newer, older);
      }
    }
  }

  async #merge(workspaceId: WorkspaceId, ctx: { tracker: PrimaryTracker; config: TrackerConfig }, newer: TrackerItem, older: TrackerItem): Promise<void> {
    for (const url of new Set(parseSourcesSection(newer.description))) {
      await ctx.tracker.link(older.ref, this.#entryFor(workspaceId, newer, url));
    }
    if (ctx.tracker.markDuplicate !== undefined) {
      await ctx.tracker.markDuplicate(newer.ref, older.ref);
    } else {
      const wontDo = ctx.config.states.wont_do[0];
      if (wontDo === undefined) {
        this.deps.log.warn('intake.duplicate_unmarked', { workspaceId, newer: newer.ref, older: older.ref });
        return;
      }
      await ctx.tracker.transition(newer.ref, wontDo);
    }
    this.#repoint(workspaceId, newer, older);
    this.deps.items.upsert(workspaceId, await ctx.tracker.get(newer.ref));
    this.deps.log.info('intake.duplicate_merged', { workspaceId, newer: newer.ref, older: older.ref });
  }

  /**
   * A cached item the board query no longer returns, and still pointed at, is
   * read again so its state stays true. One now in a won't-do state (another
   * daemon marked it a duplicate) has its links moved to the unresolved item
   * carrying the same source URL, if there is one.
   */
  async #followMissing(workspaceId: WorkspaceId, ctx: { tracker: PrimaryTracker; config: TrackerConfig }, fetched: ReadonlySet<string>): Promise<void> {
    const missions = this.#missionsByItem(workspaceId);
    for (const item of this.deps.items.list(workspaceId)) {
      if (fetched.has(item.ref) || isResolved(item.state, ctx.config)) continue;
      const links = this.deps.intake.linksForItem(workspaceId, item.ref);
      if (links.length === 0 && !missions.has(item.id)) continue;
      let fresh: TrackerItem;
      try {
        fresh = await ctx.tracker.get(item.ref);
      } catch (e) {
        if (e instanceof TandemiseError && e.code === 'NOT_FOUND') continue;
        throw e;
      }
      if (ctx.config.states.wont_do.includes(fresh.state)) {
        for (const link of links) {
          const signal = this.deps.intake.getSignal(link.signalId);
          if (signal === undefined || signal.url === '') continue;
          const hits = await ctx.tracker.search({ url: signal.url, unresolvedOnly: true, limit: URL_SEARCH_LIMIT });
          const survivor = oldest(hits.filter((h) => h.ref !== item.ref && !isResolved(h.state, ctx.config)));
          if (survivor === null) continue;
          this.deps.items.upsert(workspaceId, survivor);
          this.#repoint(workspaceId, fresh, survivor);
          break;
        }
      }
      this.deps.items.upsert(workspaceId, fresh);
    }
  }

  /** Moves this daemon's links from a duplicate to its survivor, saying so on each signal. */
  #repoint(workspaceId: WorkspaceId, from: TrackerItem, to: TrackerItem): void {
    const moved = this.deps.intake.linksForItem(workspaceId, from.ref);
    if (moved.length === 0) return;
    this.deps.unitOfWork.transaction(() => {
      this.deps.intake.repointLinks(workspaceId, from.ref, to.ref);
      for (const link of moved) {
        const signal = this.deps.intake.getSignal(link.signalId);
        if (signal !== undefined) this.deps.intake.setStatus(signal.id, signal.status, `Merged ${from.key} into ${to.key}; same source.`);
      }
    });
    this.deps.log.info('intake.links_repointed', { workspaceId, from: from.ref, to: to.ref, links: moved.length });
  }

  /** The sources-comment entry for one of a duplicate's URLs: its signal's own when this daemon has it. */
  #entryFor(workspaceId: WorkspaceId, item: TrackerItem, url: string): SourceEntry {
    for (const link of this.deps.intake.linksForItem(workspaceId, item.ref)) {
      const signal = this.deps.intake.getSignal(link.signalId);
      if (signal?.url === url) return sourceEntry(signal, sourceLabel(signal.kind));
    }
    return { url, title: `Merged from ${item.key}`, context: item.title };
  }

  /**
   * "Waiting for a free slot on Claude Code" when a step that could start is
   * held back because its runtimes are full (#101): without it the Board says
   * only "Mission: Executing" while nothing runs.
   */
  #slotWait(mission: Mission): string | null {
    for (const task of this.deps.tasks.listByMission(mission.id)) {
      if (task.status !== 'READY') continue;
      const sentence = runtimeSlotWait(task.statusReason);
      if (sentence !== null) return sentence;
    }
    return null;
  }

  #itemView(workspaceId: WorkspaceId, item: TrackedItem, config: TrackerConfig, missions: readonly Mission[]): BoardItemView {
    const mission = missions.find((m) => !isTerminalMissionStatus(m.status)) ?? missions[0] ?? null;
    const active = mission !== null && !isTerminalMissionStatus(mission.status);
    const sources: { label: string; detail: string }[] = [];
    for (const link of this.deps.intake.linksForItem(workspaceId, item.ref)) {
      const signal = this.deps.intake.getSignal(link.signalId);
      if (signal !== undefined && link.linkedBy !== 'source_is_item') sources.push(chip(signal));
    }
    return {
      id: item.id,
      key: item.key,
      title: item.title,
      url: item.url,
      state: item.state,
      assignee: item.assignee,
      sources,
      mission: mission === null ? null : { id: mission.id, status: mission.status, title: mission.title, waiting: active ? this.#slotWait(mission) : null },
      // The Start refusals, read from the cache without asking the tracker.
      startable: active ? { ok: false, reason: 'Has a mission' }
        : item.state === config.states.in_progress ? { ok: false, reason: 'Already in progress' } : { ok: true },
    };
  }

  // ------------------------------------------------------------------ Start

  /**
   * Starts the item `key` (spec §7): one mission, never queued, then the item
   * moves to in progress in the tracker. Refusals are `CONFLICT` with the
   * sentence to show.
   */
  async start(caller: Caller, workspaceId: WorkspaceId, key: string, lane?: 'quick' | 'careful'): Promise<Mission> {
    this.#requireWorkspace(workspaceId);
    const seat = requireSeat(this.deps, workspaceId, caller);
    const starter = this.deps.people.get(caller.personId)?.displayName ?? seat.name;
    // In the project's queue: a second Start of the same item waits for the
    // first, and then finds its mission (Review Focus 4).
    return this.#serial(workspaceId, () => this.#start(caller, starter, workspaceId, key.trim(), lane));
  }

  async #start(caller: Caller, starter: string, workspaceId: WorkspaceId, key: string, lane?: 'quick' | 'careful'): Promise<Mission> {
    const { tracker, config } = await this.deps.trackers.for(workspaceId);
    const cached = this.deps.items.byKey(workspaceId, key);
    if (cached !== undefined) this.#refuseIfStarted(workspaceId, cached);
    // Read fresh: the cache may be two minutes old, and someone may have taken it meanwhile.
    const fresh = await tracker.get(cached?.ref ?? refForKey(config, key));
    const item = this.deps.items.upsert(workspaceId, fresh);
    this.#refuseIfStarted(workspaceId, item);
    if (fresh.state === config.states.in_progress) {
      throw new TandemiseError('CONFLICT', fresh.assignee === null
        ? `${fresh.key} is already in progress.`
        : `${fresh.key} is already in progress (${fresh.assignee}).`);
    }
    // Claimed before the mission exists (spec §7 step 1), under the id it will
    // have, so the mission's own start finds the claim already its own (Ruling 22).
    const missionId = ids.mission();
    const claim = await this.deps.claims.item({ workspaceId, itemRef: item.ref, itemTitle: item.title, itemUrl: item.url, localRef: missionId });
    if (!claim.ok) throw new TandemiseError('CONFLICT', claim.reason);

    const label = trackerLabel(config.kind);
    const criteria = parseCriteria(fresh.description);
    // The brain's mapping by item type when it names one, else the factory decides (#53: Start → profile → lane).
    const workflow = (fresh.type === undefined ? undefined : config.workflows?.[fresh.type]) ?? FACTORY_WORKFLOW_ID;
    const request: CreateMissionRequest = {
      workspaceId,
      title: missionTitle(fresh),
      goal: trackerGoal({
        label, key: fresh.key, starterName: starter, url: fresh.url, title: fresh.title, description: fresh.description,
        sources: this.#linkedSignals(workspaceId, item.ref).map((s) => ({ label: sourceLabel(s.kind), instance: s.instance, context: goalContext(s) })),
      }),
      successCriteria: [...criteria],
      // Pressing Start passes the readiness gate exactly when a Done-when was
      // found; without one the mission opens as a draft to refine. Never
      // `queued`: a started item is the person's work, not the backlog's.
      ...(criteria.length > 0 ? { planNow: true } : {}),
      workflowPreset: workflow,
      // A lane the person chose on the Board (#103); only the factory plans by lane.
      ...(lane !== undefined && workflow === FACTORY_WORKFLOW_ID ? { lane } : {}),
    };
    let mission: Mission;
    try {
      mission = await this.deps.createMission(caller, request, { trackerItemId: item.id, missionId });
    } catch (e) {
      // Only the claim taken for this Start (its pre-named mission id): a claim
      // the same person holds for another mission on this item stays (Ruling 27).
      await this.deps.claims.releaseItem(item.ref, 'released', missionId).catch(() => {});
      throw e;
    }
    if (criteria.length === 0 && workflow === FACTORY_WORKFLOW_ID && this.deps.planDraft !== undefined) {
      // The quick and standard lanes don't ask for Done-when lines (#53 §4, which changes #52 §7 here);
      // the careful lane does, and its refusal leaves the draft for the person to refine.
      try {
        await this.deps.planDraft(mission.id);
      } catch (e) {
        this.deps.log.info('tracker.start_left_draft', { workspaceId, missionId: mission.id, reason: errorMessage(e) });
      }
    }
    this.deps.log.info('tracker.started', { workspaceId, ref: item.ref, missionId: mission.id, criteria: criteria.length });
    await this.#writeStart(workspaceId, tracker, config, item, mission);
    // The activity comment at once, derived like every later pass (plan Task 9).
    const started = this.deps.missions.get(mission.id) ?? mission;
    try {
      await this.#syncActivity(workspaceId, tracker, config, this.deps.items.get(item.id) ?? item, started);
    } catch (e) {
      this.deps.recorder.note({ workspaceId, missionId: mission.id }, `Couldn't comment on ${fresh.key} in ${label}: ${sentence(e)}.`, 'warn');
    }
    this.deps.recorder.note({ workspaceId, missionId: mission.id }, `Started from ${label} ${fresh.key}.`);
    this.deps.recorder.invalidate('missions', mission.id);
    this.#invalidate();
    return this.deps.missions.get(mission.id) ?? mission;
  }

  #refuseIfStarted(workspaceId: WorkspaceId, item: TrackedItem): void {
    const active = (this.#missionsByItem(workspaceId).get(item.id) ?? []).find((m) => !isTerminalMissionStatus(m.status));
    if (active !== undefined) throw new TandemiseError('CONFLICT', `${item.key} already has a mission: ${active.title}.`);
  }

  /**
   * After the mission is committed (spec §7 step 4): the item moves to in
   * progress and is assigned to the starter when they set their tracker login.
   * The activity comment follows (`#syncActivity`). A failure here never undoes
   * the mission: it is noted on it, and the next tick tries again.
   */
  async #writeStart(workspaceId: WorkspaceId, tracker: PrimaryTracker, config: TrackerConfig, item: TrackedItem, mission: Mission): Promise<void> {
    const scope = { workspaceId, missionId: mission.id };
    const label = trackerLabel(config.kind);
    const target = config.states.in_progress;
    try {
      await tracker.transition(item.ref, target);
      this.deps.unitOfWork.transaction(() => {
        this.deps.items.upsert(workspaceId, { ...item, state: target });
        this.deps.items.setWrittenState(item.id, target);
      });
    } catch (e) {
      this.deps.recorder.note(scope, `Couldn't move ${item.key} to ${target} in ${label}: ${sentence(e)}.`, 'warn');
    }
    const login = this.#trackerLogin(workspaceId);
    if (login !== null && tracker.assign !== undefined) {
      try {
        await tracker.assign(item.ref, login);
      } catch (e) {
        this.deps.recorder.note(scope, `Couldn't assign ${item.key} to ${login} in ${label}: ${sentence(e)}.`, 'warn');
      }
    }
  }

  /**
   * The tracker writes of a Start that failed (the item never reached in
   * progress): tried again while the mission is open and the item is still
   * where Tandemise found it, so a person's own move always wins. A missing
   * activity comment is the write-back pass's to post.
   */
  async #retryStartWrites(workspaceId: WorkspaceId): Promise<void> {
    const config = this.deps.config.read(workspaceId).tracker;
    if (config === null) return;
    const waiting = [...this.#missionsByItem(workspaceId)].flatMap(([itemId, missions]) => {
      const mission = missions.find((m) => !isTerminalMissionStatus(m.status));
      const item = this.deps.items.get(itemId);
      if (mission === undefined || item === undefined) return [];
      return item.writtenState === null && config.states.ready.includes(item.state) ? [{ item, mission }] : [];
    });
    if (waiting.length === 0) return;
    let ctx: { tracker: PrimaryTracker; config: TrackerConfig };
    try {
      ctx = await this.deps.trackers.for(workspaceId);
    } catch (e) {
      this.deps.log.warn('tracker.start_retry_failed', { workspaceId, error: errorMessage(e) });
      return;
    }
    for (const { item, mission } of waiting) await this.#writeStart(workspaceId, ctx.tracker, ctx.config, item, mission);
  }

  // ------------------------------------------------------------------ write-back (plan Task 9)

  /**
   * The tracker follows each started item's mission (spec §7 "How the tracker
   * shows progress", "State write-back"): its mapped state and its activity
   * comment are derived from the mission's state on every pass and compared
   * with what was last written, so the latest state always lands and a
   * restart writes nothing twice. An item's latest mission speaks for it: the
   * open one, else the newest.
   */
  async #writeBack(workspaceId: WorkspaceId): Promise<void> {
    const config = this.deps.config.read(workspaceId).tracker;
    if (config === null) return;
    const nowMs = this.deps.clock.epochMs();
    // Resolved only when something is to be written.
    let ctx: Promise<{ tracker: PrimaryTracker; config: TrackerConfig }> | null = null;
    const tracker = async (): Promise<PrimaryTracker> => (await (ctx ??= this.deps.trackers.for(workspaceId))).tracker;
    for (const [itemId, missions] of this.#missionsByItem(workspaceId)) {
      const mission = missions.find((m) => !isTerminalMissionStatus(m.status)) ?? missions[0];
      if (mission === undefined || this.#settled.has(mission.id)) continue;
      if ((this.#writeBackRetryAfter.get(itemId) ?? 0) > nowMs) continue;
      const item = this.deps.items.get(itemId);
      if (item === undefined) continue;
      try {
        const settled = await this.#bringUpToDate(workspaceId, config, tracker, item, mission);
        this.#writeBackRetryAfter.delete(itemId);
        if (settled && isTerminalMissionStatus(mission.status)) this.#settled.add(mission.id);
      } catch (e) {
        this.#writeBackRetryAfter.set(itemId, nowMs + WRITE_BACK_RETRY_MS);
        this.deps.log.warn('tracker.write_back_failed', { workspaceId, ref: item.ref, missionId: mission.id, error: errorMessage(e) });
      }
    }
  }

  /**
   * One item: the state first (Review Focus 3: only from the state Tandemise
   * last wrote, read fresh, and never backwards except on cancel), then the
   * activity comment, which can then say where a cancel moved it. True when
   * nothing is left to write.
   */
  async #bringUpToDate(
    workspaceId: WorkspaceId, config: TrackerConfig, tracker: () => Promise<PrimaryTracker>, item: TrackedItem, mission: Mission,
  ): Promise<boolean> {
    const links = deliveryLinks(this.deps.artifacts, mission.id, this.deps.events);
    const facts = {
      mapping: { ...config.states, onComplete: config.onComplete },
      mission: { status: mission.status },
      prOpen: links.some((l) => l.kind === 'pr'),
      pendingApproval: this.deps.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).length > 0,
      writtenState: item.writtenState,
    };
    let current = item;
    // The cache says whether a move is due; the tracker, read fresh, says whether it is still allowed.
    if (decideTrackerWriteBack({ ...facts, upstreamState: item.state }).transition !== null) {
      const t = await tracker();
      current = this.deps.items.upsert(workspaceId, await t.get(item.ref));
      const target = decideTrackerWriteBack({ ...facts, upstreamState: current.state }).transition;
      if (target !== null) {
        await t.transition(item.ref, target);
        const moved = current;
        current = this.deps.unitOfWork.transaction(() => {
          const saved = this.deps.items.upsert(workspaceId, { ...moved, state: target });
          this.deps.items.setWrittenState(item.id, target);
          return { ...saved, writtenState: target };
        });
        this.deps.log.info('tracker.state_written', { workspaceId, ref: item.ref, missionId: mission.id, state: target });
        this.#invalidate();
      }
    }
    return this.#syncActivity(workspaceId, tracker, config, current, mission, links);
  }

  /**
   * Writes the activity comment when it differs from what was last written:
   * edited in place at most once a minute (the last state lands on a later
   * pass), or, on a tracker that cannot edit comments, posted anew only when
   * the started, pull-request or completed milestone changes (spec §7). True
   * when the comment is as current as it can be.
   */
  async #syncActivity(
    workspaceId: WorkspaceId, tracker: PrimaryTracker | (() => Promise<PrimaryTracker>), config: TrackerConfig, item: TrackedItem, mission: Mission,
    links: readonly DeliveryLink[] = deliveryLinks(this.deps.artifacts, mission.id, this.deps.events),
  ): Promise<boolean> {
    const input = this.#activityInput(config, item, mission, links);
    const body = activityCommentBody(input);
    const stored = this.deps.items.comment(workspaceId, item.ref, 'tandemise:activity');
    if (stored?.body === body) return true;
    const t = typeof tracker === 'function' ? await tracker() : tracker;
    if (!t.capabilities.editComments) {
      if (stored !== undefined && activityMilestoneOf(stored.body) === activityMilestone(input)) return true;
      const { commentId } = await t.comment(item.ref, { marker: 'tandemise:activity', body });
      this.deps.items.saveComment(workspaceId, item.ref, 'tandemise:activity', commentId, body);
      return true;
    }
    if (stored !== undefined && this.deps.clock.epochMs() - Date.parse(stored.updatedAt) < ACTIVITY_EDIT_EVERY_MS) return false;
    const { commentId } = await t.comment(item.ref, {
      marker: 'tandemise:activity', body, ...(stored === undefined ? {} : { knownId: stored.commentId }),
    });
    this.deps.items.saveComment(workspaceId, item.ref, 'tandemise:activity', commentId, body);
    return true;
  }

  /** What the activity comment says now, from the mission's state alone. */
  #activityInput(config: TrackerConfig, item: TrackedItem, mission: Mission, links: readonly DeliveryLink[]): ActivityCommentInput {
    // The steps once a plan is approved: before that they are only a proposal.
    const planned = !['DRAFT', 'PLANNING', 'AWAITING_PLAN_APPROVAL'].includes(mission.status);
    const tasks = planned ? this.deps.tasks.listByMission(mission.id) : [];
    const readyState = config.states.ready[0];
    return {
      starter: this.#starterOf(mission),
      missionTitle: mission.title,
      steps: tasks.length === 0 ? null : tasks.map((t) => ({ title: t.title, state: activityStepState(t.status) })),
      prUrl: links.find((l) => l.kind === 'pr')?.url ?? null,
      completed: mission.status === 'COMPLETE'
        ? { rows: this.deps.trace(mission.id).rows.map((r) => ({ key: r.criterion.key, statement: r.criterion.statement, result: r.result })) }
        : null,
      // Said once the item is back where the cancel put it: when a person moved it first, the comment claims no move.
      cancelled: mission.status === 'CANCELLED' && readyState !== undefined && item.writtenState === readyState ? { readyState } : null,
    };
  }

  /** Who started the mission: their person's name, else their seat's. */
  #starterOf(mission: Mission): string {
    const createdBy = mission.createdBy ?? null;
    const member = createdBy === null ? undefined : this.deps.members.get(asId<'MemberId'>(createdBy));
    const person = member?.personId === null || member?.personId === undefined ? undefined : this.deps.people.get(member.personId);
    return person?.displayName ?? member?.name ?? 'someone';
  }

  // ------------------------------------------------------------------ helpers

  #linkedSignals(workspaceId: WorkspaceId, ref: string): readonly IntakeSignal[] {
    return this.deps.intake.linksForItem(workspaceId, ref)
      .filter((l) => l.linkedBy !== 'source_is_item')
      .flatMap((l) => { const s = this.deps.intake.getSignal(l.signalId); return s === undefined ? [] : [s]; });
  }

  /** The project's missions started from tracker items, newest first, by item. */
  #missionsByItem(workspaceId: WorkspaceId): ReadonlyMap<TrackerItemId, readonly Mission[]> {
    const map = new Map<TrackerItemId, Mission[]>();
    for (const m of this.deps.missions.list({ workspaceId })) {
      if (m.trackerItemId === undefined || m.trackerItemId === null) continue;
      map.set(m.trackerItemId, [...(map.get(m.trackerItemId) ?? []), m]);
    }
    return map;
  }

  #trackerLogin(workspaceId: WorkspaceId): string | null {
    const logins = this.deps.settings.read()[TRACKER_LOGINS_SETTINGS_KEY];
    if (typeof logins !== 'object' || logins === null) return null;
    const login = (logins as Record<string, unknown>)[workspaceId];
    return typeof login === 'string' && login.trim() !== '' ? login.trim() : null;
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

  #background(workspaceId: WorkspaceId, fn: () => Promise<void>): void {
    void this.#serial(workspaceId, fn).catch((e: unknown) => {
      this.deps.log.warn('tracker.background_failed', { workspaceId, error: errorMessage(e) });
    });
  }

  #requireWorkspace(workspaceId: WorkspaceId): void {
    if (this.deps.workspaces.get(workspaceId) === undefined) throw TandemiseError.notFound('Workspace', workspaceId);
  }

  #invalidate(): void {
    this.deps.projections?.invalidate('intake');
  }
}

/** A source chip: `Sentry · 132 events`, `Slack · thread`. */
function chip(signal: IntakeSignal): { label: string; detail: string } {
  const label = sourceLabel(signal.kind);
  const events = signal.impact?.events;
  if (events !== undefined) return { label, detail: `${events} ${events === 1 ? 'event' : 'events'}` };
  if (signal.kind === 'slack' || signal.kind === 'discord') return { label, detail: 'thread' };
  if (signal.kind === 'github') return { label, detail: `#${signal.key}` };
  return { label, detail: impactWords(signal.impact) ?? signal.instance };
}

/** A linked signal's line in the goal: its title, its impact and its link (`TypeError: … · 132 events, 41 users · <url>`). */
function goalContext(signal: IntakeSignal): string {
  return [signal.title, impactWords(signal.impact), signal.url].filter((x): x is string => x !== null && x !== '').join(' · ');
}

/** The ref for a key typed by a person (`GAR-12`, `#42` or `42`) when the board cache does not have it. */
function refForKey(config: TrackerConfig, key: string): TrackerRef {
  if (config.kind === 'github-issues') return trackerRef('github', `${config.repo ?? ''}#${key.replace(/^.*#/, '')}`);
  return trackerRef('youtrack', key.toUpperCase());
}

function missionTitle(item: Pick<TrackerItem, 'title' | 'key'>): string {
  const title = item.title.replace(/\s+/g, ' ').trim() || item.key;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1)}…`;
}

function isResolved(state: string, config: TrackerConfig): boolean {
  return config.states.done.includes(state) || config.states.wont_do.includes(state);
}

/** The oldest item, ties to the lower key: the one every daemon keeps. */
function oldest(items: readonly TrackerItem[]): TrackerItem | null {
  let best: TrackerItem | null = null;
  for (const i of items) {
    if (best === null || i.createdAt < best.createdAt || (i.createdAt === best.createdAt && i.key.localeCompare(best.key, 'en', { numeric: true }) < 0)) best = i;
  }
  return best;
}

function sentence(e: unknown): string {
  return errorMessage(e).replace(/[.\s]+$/, '');
}
