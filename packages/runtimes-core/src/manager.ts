import type {
  AgentEvent, InteractiveInvocation, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import { Err, Ok, TandemiseError, errorMessage, nullLogger, systemClock } from '@tandemise/shared';
import type { Clock, Logger, Result, RunId, RuntimeProfileId } from '@tandemise/shared';
import { token } from '@tandemise/kernel';
import type { AgentRuntimeAdapter, InteractiveOptions, RunRequest, SlotReservation, SlotRetention } from './adapter.js';
import type { RuntimeRegistry } from './registry.js';

/** How long a health probe is reused. Short enough for a polling UI to feel live. */
export const DEFAULT_HEALTH_TTL_MS = 10_000;

/**
 * How long a reservation may go unstarted before it is reclaimed. A backstop
 * for a caller that forgot to release, not the normal path - long enough to
 * cover provisioning a large worktree.
 */
export const RESERVATION_TTL_MS = 5 * 60_000;

/**
 * The backstop for a slot a finished run kept for its follow-up. Longer than
 * an unstarted reservation's, because it waits across harvesting and checks,
 * which can run a repository's whole test suite.
 */
export const RETAINED_SLOT_TTL_MS = 60 * 60_000;

export interface RuntimeSelection {
  readonly profile: RuntimeProfile;
  readonly adapter: AgentRuntimeAdapter;
  readonly health: RuntimeHealth;
  /** Held from selection. Hand it to `start()`, or release it if the run never starts. */
  readonly reservation: SlotReservation;
}

/** Why a candidate was passed over. Surfaced verbatim so routing is explainable. */
export interface RuntimeRejection {
  readonly profileId: RuntimeProfileId;
  /** The profile's name, for reasons a person reads. */
  readonly profileName: string;
  readonly reason: string;
  /**
   * The candidate could run this, just not right now. A caller that finds only
   * busy candidates should wait for a slot rather than treat it as a failure.
   */
  readonly busy?: true;
  /**
   * The candidate is waiting on a person (its health carries `actionRequired`).
   * Like `busy`, a reason to wait rather than fail - just a longer wait.
   */
  readonly awaitingPerson?: true;
}

/**
 * The rejections as one line a person reads: "'Scripted agent': missing
 * capabilities: mcp". Profiles are named, not identified - a raw id in a
 * blocked banner tells nobody which runtime to fix.
 */
export function describeRejections(rejections: readonly RuntimeRejection[]): string {
  return rejections.map((r) => `'${r.profileName}': ${r.reason}`).join('; ');
}

/** True when every candidate was capable and merely out of slots. */
export function onlyBusy(failure: RuntimeSelectionFailure): boolean {
  return failure.rejections.length > 0 && failure.rejections.every((r) => r.busy === true);
}

/** Every candidate will be usable again without the work changing: busy, or waiting on a person. */
export function onlyWaiting(failure: RuntimeSelectionFailure): boolean {
  return failure.rejections.length > 0
    && failure.rejections.every((r) => r.busy === true || r.awaitingPerson === true);
}

export interface RuntimeSelectionFailure {
  readonly requiredCapabilities: readonly RuntimeCapability[];
  readonly rejections: readonly RuntimeRejection[];
}

export interface RuntimeManagerOptions {
  readonly registry: RuntimeRegistry;
  readonly clock?: Clock;
  readonly log?: Logger;
  readonly healthTtlMs?: number;
}

interface ReservationHandle extends SlotReservation {
  /** Transfers the slot to a run. False if already released, expired, or for another profile. */
  takeOver(profileId: RuntimeProfileId): boolean;
}

interface CachedHealth {
  readonly health: RuntimeHealth;
  readonly expiresAt: number;
  /** Invalidates when the profile itself is edited, not only on TTL expiry. */
  readonly revision: string;
}

/**
 * Discovery, health, concurrency and capability routing for every runtime
 * (MVP.md §9.4, §10).
 *
 * The manager is deliberately vendor-blind: it reads `profile.adapterId`,
 * resolves it through the registry, and asks the adapter what it can do. There
 * is no branch anywhere in this class on a runtime's name, which is the
 * property that lets a mission be re-run on a different worker without the
 * scheduler changing (MVP.md §P2).
 */
export class RuntimeManager {
  readonly #registry: RuntimeRegistry;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #healthTtlMs: number;
  readonly #health = new Map<RuntimeProfileId, CachedHealth>();
  readonly #inFlight = new Map<RuntimeProfileId, number>();
  /** Live reservations this manager issued; a foreign or stale handle is not honoured. */
  readonly #reservations = new Set<ReservationHandle>();

  constructor(options: RuntimeManagerOptions) {
    this.#registry = options.registry;
    this.#clock = options.clock ?? systemClock;
    this.#log = options.log ?? nullLogger;
    this.#healthTtlMs = options.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  }

  get registry(): RuntimeRegistry {
    return this.#registry;
  }

  /**
   * Probes every adapter for a locally installed runtime. Used by onboarding
   * and by Settings → Runtimes; failures are reported as `detected: false`
   * rather than thrown, because one broken adapter must not hide the others.
   */
  async discoverAll(): Promise<readonly RuntimeDiscovery[]> {
    return Promise.all(this.#registry.all().map(async ({ adapter }) => {
      try {
        return await adapter.discover();
      } catch (e) {
        this.#log.warn('runtime discovery failed', { runtime: adapter.id, error: errorMessage(e) });
        return {
          adapterId: adapter.id,
          displayName: adapter.displayName,
          detected: false,
          executablePath: null,
          version: null,
          capabilities: [],
          detail: `Discovery failed: ${errorMessage(e)}`,
          suggestedSettings: {},
        } satisfies RuntimeDiscovery;
      }
    }));
  }

  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[] {
    const adapter = this.#registry.tryAdapter(profile.adapterId);
    return adapter ? adapter.capabilities(profile) : [];
  }

  /**
   * Health for one profile, cached for `healthTtlMs`. The UI polls this; a
   * cache miss costs a process spawn, so an uncached poll loop would spawn a
   * `--version` child several times a second.
   */
  async health(profile: RuntimeProfile, options: { refresh?: boolean } = {}): Promise<RuntimeHealth> {
    const revision = `${profile.adapterId}@${profile.updatedAt}`;
    const cached = this.#health.get(profile.id);
    if (!options.refresh && cached && cached.revision === revision && cached.expiresAt > this.#clock.epochMs()) {
      return cached.health;
    }

    const adapter = this.#registry.tryAdapter(profile.adapterId);
    const health = adapter
      ? await this.#probe(adapter, profile)
      : this.#unavailable(profile, `No adapter registered for '${profile.adapterId}'`);

    this.#health.set(profile.id, { health, revision, expiresAt: this.#clock.epochMs() + this.#healthTtlMs });
    return health;
  }

  /** Drops cached health, e.g. after the user edits a profile's executable path. */
  invalidateHealth(profileId?: RuntimeProfileId): void {
    if (profileId === undefined) this.#health.clear();
    else this.#health.delete(profileId);
  }

  inFlight(profileId: RuntimeProfileId): number {
    return this.#inFlight.get(profileId) ?? 0;
  }

  isSaturated(profile: RuntimeProfile): boolean {
    return this.inFlight(profile.id) >= Math.max(1, profile.maxConcurrent);
  }

  /**
   * Capability routing (MVP.md §9.4): the first candidate that is enabled, has
   * a registered adapter, offers every required capability, has spare
   * concurrency, and is healthy.
   *
   * Candidate order is the caller's preference order and is honoured, with one
   * refinement: a fully healthy profile always beats a degraded one, so a
   * runtime nursing a quota warning is used as a fallback rather than as the
   * first choice. Failure returns the per-candidate reasons, because "no
   * runtime available" with no explanation is the least actionable message an
   * orchestrator can produce.
   */
  async select(
    candidates: readonly RuntimeProfile[],
    requiredCapabilities: readonly RuntimeCapability[] = [],
  ): Promise<Result<RuntimeSelection, RuntimeSelectionFailure>> {
    const rejections: RuntimeRejection[] = [];
    const eligible: Array<{ profile: RuntimeProfile; adapter: AgentRuntimeAdapter }> = [];

    for (const profile of candidates) {
      const reason = this.#rejectCheaply(profile, requiredCapabilities);
      if (reason !== null) {
        rejections.push({ profileId: profile.id, profileName: profile.name, reason });
        continue;
      }
      if (this.isSaturated(profile)) {
        rejections.push({ profileId: profile.id, profileName: profile.name, reason: this.#saturationReason(profile), busy: true });
        continue;
      }
      // Safe: `#rejectCheaply` returns a reason when the adapter is unknown.
      eligible.push({ profile, adapter: this.#registry.adapter(profile.adapterId) });
    }

    let degraded: { profile: RuntimeProfile; adapter: AgentRuntimeAdapter; health: RuntimeHealth } | null = null;
    for (const { profile, adapter } of eligible) {
      const health = await this.health(profile);
      if (health.state === 'healthy') {
        // Saturation is re-read after the await: another selection may have
        // taken the last slot while this one was probing health.
        if (this.isSaturated(profile)) {
          rejections.push({ profileId: profile.id, profileName: profile.name, reason: this.#saturationReason(profile), busy: true });
          continue;
        }
        return Ok({ profile, adapter, health, reservation: this.#reserve(profile.id) });
      }
      if (health.state === 'degraded') {
        degraded ??= { profile, adapter, health };
        continue;
      }
      rejections.push({
        profileId: profile.id,
        profileName: profile.name,
        reason: `${health.state}: ${health.actionRequired ?? health.detail}`,
        ...(health.actionRequired === undefined ? {} : { awaitingPerson: true as const }),
      });
    }

    if (degraded !== null) {
      if (this.isSaturated(degraded.profile)) {
        rejections.push({ profileId: degraded.profile.id, profileName: degraded.profile.name, reason: this.#saturationReason(degraded.profile), busy: true });
        return Err({ requiredCapabilities, rejections });
      }
      this.#log.warn('routing to a degraded runtime', {
        runtime: degraded.profile.adapterId,
        detail: degraded.health.detail,
      });
      return Ok({ ...degraded, reservation: this.#reserve(degraded.profile.id) });
    }
    return Err({ requiredCapabilities, rejections });
  }

  /**
   * A slot held by a process that is not a run: a person's terminal on a held
   * task, which is a live runtime process from the moment it spawns. Taken even
   * when the profile is full, because the process exists either way, and kept
   * with no expiry until it is released, because a hold lasts as long as the
   * person works.
   */
  occupy(profile: RuntimeProfile): SlotReservation {
    return this.#reserve(profile.id, false, null);
  }

  /**
   * Holds a slot from selection until a run takes it over or it is released.
   * The TTL is a backstop so a caller that never releases cannot saturate a
   * profile forever.
   */
  #reserve(profileId: RuntimeProfileId, retained = false, ttlMs: number | null = retained ? RETAINED_SLOT_TTL_MS : RESERVATION_TTL_MS): SlotReservation {
    // A retained slot is already counted in flight: the run that held it
    // passes it on without ever giving it back.
    if (!retained) this.#claim(profileId);
    let held = true;
    const timer = ttlMs === null ? undefined : setTimeout(() => {
      this.#reservations.delete(reservation);
      if (!held) return;
      held = false;
      this.#log.warn('runtime reservation expired unstarted', { profileId });
      this.#release(profileId);
    }, ttlMs);
    timer?.unref?.();
    const reservation: ReservationHandle = {
      release: () => {
        this.#reservations.delete(reservation);
        if (!held) return;
        held = false;
        clearTimeout(timer);
        this.#release(profileId);
      },
      takeOver: (forProfile) => {
        if (!held || forProfile !== profileId) return false;
        held = false;
        clearTimeout(timer);
        return true;
      },
    };
    this.#reservations.add(reservation);
    return reservation;
  }

  /** True when `start` inherits a reserved slot rather than needing its own. */
  #inherit(request: RunRequest): boolean {
    const candidate = request.reservation as ReservationHandle | undefined;
    if (candidate === undefined || !this.#reservations.has(candidate)) return false;
    this.#reservations.delete(candidate);
    return candidate.takeOver(request.profile.id);
  }

  #saturationReason(profile: RuntimeProfile): string {
    return `saturated: ${this.inFlight(profile.id)}/${profile.maxConcurrent} runs in flight`;
  }

  /**
   * Runs one attempt, holding a concurrency slot for the duration of the
   * stream. Callers should prefer this over `adapter.start` directly: the slot
   * is what `isSaturated` and therefore routing depend on.
   */
  start(request: RunRequest): AsyncIterable<AgentEvent> {
    const adapter = this.#registry.adapter(request.profile.adapterId);
    // The slot is claimed here, synchronously, rather than inside the generator.
    // An async generator's body does not run until the first `next()`, so a
    // caller that had started a run but not yet consumed an event still showed
    // as idle - and two schedulers would both route to the same
    // `maxConcurrent: 1` profile.
    if (!this.#inherit(request)) this.#claim(request.profile.id);
    return this.#tracked(request.profile.id, adapter.start(request), request.retainSlot);
  }

  resume(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent> {
    const adapter = this.#registry.adapter(request.profile.adapterId);
    if (adapter.resume === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', `Runtime '${adapter.id}' cannot resume a session`, {
        details: { adapterId: adapter.id, sessionRef },
      });
    }
    if (!this.#inherit(request)) this.#claim(request.profile.id);
    return this.#tracked(request.profile.id, adapter.resume(sessionRef, request), request.retainSlot);
  }

  /** The interactive invocation for a hold, or a conflict when the runtime has none. */
  interactive(
    profile: RuntimeProfile,
    sessionRef: string | null,
    request: RunRequest,
    opts: InteractiveOptions,
  ): InteractiveInvocation {
    const adapter = this.#registry.adapter(profile.adapterId);
    if (adapter.interactive === undefined) {
      throw new TandemiseError('CONFLICT', 'Only Claude Code steps can be held for now.');
    }
    return adapter.interactive(sessionRef, request, opts);
  }

  async cancel(profile: RuntimeProfile, runId: RunId): Promise<void> {
    await this.#registry.adapter(profile.adapterId).cancel(runId);
  }

  /** The OS process backing a live run, for the supervisor's process table. */
  pid(profile: RuntimeProfile, runId: RunId): number | null {
    return this.#registry.tryAdapter(profile.adapterId)?.pid(runId) ?? null;
  }

  /** First-match-wins reasons that need no process spawn. */
  #rejectCheaply(profile: RuntimeProfile, required: readonly RuntimeCapability[]): string | null {
    if (!profile.enabled) return 'profile is disabled';
    const adapter = this.#registry.tryAdapter(profile.adapterId);
    if (adapter === undefined) return `no adapter registered for '${profile.adapterId}'`;
    const offered = new Set(adapter.capabilities(profile));
    const missing = required.filter((c) => !offered.has(c));
    if (missing.length > 0) return `missing capabilities: ${missing.join(', ')}`;
    return null;
  }

  async #probe(adapter: AgentRuntimeAdapter, profile: RuntimeProfile): Promise<RuntimeHealth> {
    try {
      return await adapter.healthCheck(profile);
    } catch (e) {
      return this.#unavailable(profile, errorMessage(e));
    }
  }

  #unavailable(profile: RuntimeProfile, detail: string): RuntimeHealth {
    return {
      profileId: profile.id,
      state: 'unavailable',
      version: null,
      detail,
      checkedAt: this.#clock.now(),
      quotaWarning: null,
    };
  }

  #claim(profileId: RuntimeProfileId): void {
    this.#inFlight.set(profileId, this.inFlight(profileId) + 1);
  }

  #release(profileId: RuntimeProfileId): void {
    const next = this.inFlight(profileId) - 1;
    if (next <= 0) this.#inFlight.delete(profileId);
    else this.#inFlight.set(profileId, next);
  }

  /**
   * Releases the slot claimed by `start`/`resume` once the stream ends, however
   * it ends - normal completion, an error, or the consumer abandoning the
   * iterator, which `finally` covers because a `for await` that breaks early
   * calls `return()` on the generator.
   */
  async *#tracked(
    profileId: RuntimeProfileId,
    events: AsyncIterable<AgentEvent>,
    retain: SlotRetention | undefined,
  ): AsyncIterable<AgentEvent> {
    try {
      yield* events;
    } finally {
      if (retain === undefined) {
        this.#release(profileId);
      } else {
        // Converted in the same synchronous step that would have freed it, so
        // no selection can see the profile idle in between.
        retain.reservation?.release();
        retain.reservation = this.#reserve(profileId, true);
      }
    }
  }
}

export const RUNTIME_MANAGER = token<RuntimeManager>('RuntimeManager');
