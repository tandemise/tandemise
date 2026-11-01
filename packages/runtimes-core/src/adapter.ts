import type { Capability, InteractiveInvocation, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile, RuntimeSettingField } from '@tandemise/domain';
import type { AgentEvent } from '@tandemise/domain';
import type { Logger, RunId } from '@tandemise/shared';
import { multiToken } from '@tandemise/kernel';
import type { Descriptor } from '@tandemise/kernel';

/**
 * The failure code an adapter emits when a resume handle no longer names a
 * session its runtime holds.
 *
 * It is canonical rather than per-vendor because the caller acts on it: this is
 * the one run failure that says nothing about the work, only about a lost
 * continuity, so the right response is to run the attempt again from scratch -
 * not to spend a retry, and certainly not to block the task. Every vendor
 * phrases it differently ("No conversation found with session ID: …"); the
 * adapter is where that phrasing stops.
 */
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';

/**
 * The failure code an adapter emits when its runtime could not authenticate -
 * an expired or revoked login, a missing API key.
 *
 * Canonical for the same reason as {@link SESSION_NOT_FOUND}: the caller acts
 * on it. Every attempt made while signed out fails in seconds for a reason the
 * task cannot influence, so spending the task's retries on it blocks good work
 * on a login. An adapter that emits this should also report the profile as
 * `unavailable` with `actionRequired` until it sees the runtime work again.
 */
export const RUNTIME_SIGNED_OUT = 'RUNTIME_SIGNED_OUT';

/**
 * Everything an adapter needs to execute one attempt (MVP.md §10.1).
 *
 * Note what is *absent*: no credentials, no repository handle, no mission. The
 * adapter launches an already-authenticated local tool (MVP.md §10.3) and is
 * told only what this one run may touch. `grants` is descriptive input to the
 * adapter's own flag mapping - Tandemise's policy layer remains the real gate,
 * because a CLI flag is advice and a policy decision is enforcement.
 */
export interface RunRequest {
  readonly runId: RunId;
  readonly profile: RuntimeProfile;
  /** Already compiled and trust-labelled by the context builder (MVP.md §14.1). */
  readonly prompt: string;
  readonly workingDirectory: string;
  readonly grants: readonly Capability[];
  /** Filesystem roots this run may read/write, beyond `workingDirectory`. */
  readonly allowedRoots: readonly string[];
  readonly mcpConfigPath: string | null;
  /**
   * The model this run is given (P12), already resolved by the engine. A
   * string is passed to the runtime; null means pass nothing (the runtime's
   * own default). Undefined - a caller from before P12 - leaves the adapter to
   * read its profile's own `model` setting.
   */
  readonly model?: string | null;
  readonly maxWallTimeMs: number;
  /** Aborting must terminate the child process, not merely stop iteration. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  /**
   * The slot `RuntimeManager.select` reserved for this run. Passing it hands
   * the slot to the run instead of claiming a second one; omitting it claims
   * afresh, which is right for a run that was never routed.
   */
  readonly reservation?: SlotReservation;
  /**
   * Keeps this run's slot when its stream ends, as a reservation left in
   * `reservation` on this holder, instead of freeing it. For work that may
   * need a follow-up run - a tighten pass, a restarted session - which must
   * not find the slot taken by another task in between. Whoever passes a
   * holder owns what it ends up holding and must release it or hand it on.
   */
  readonly retainSlot?: SlotRetention;
}

/** Receives the slot a finished run kept; see `RunRequest.retainSlot`. */
export interface SlotRetention {
  reservation: SlotReservation | undefined;
}

/**
 * A concurrency slot held between routing and `start()`.
 *
 * Routing and starting are separated by real work - provisioning a worktree
 * takes seconds - so a slot that was only observed free at routing time is a
 * slot two tasks can both be given.
 */
export interface SlotReservation {
  /** Returns the slot if no run took it over. Idempotent. */
  release(): void;
}

/**
 * The single seam between Tandemise and any agent runtime (MVP.md §10.1).
 *
 * `start`/`resume` return an `AsyncIterable` rather than taking a callback so
 * that back-pressure is the consumer's: a slow event writer slows the reader
 * instead of growing an unbounded in-memory queue.
 */
export interface AgentRuntimeAdapter {
  /** Stable adapter id, e.g. `claude-code`. Profiles reference this, never a vendor. */
  readonly id: string;
  readonly displayName: string;
  /**
   * Capabilities the adapter can offer before any profile exists. Used for
   * registry-level routing queries (`Registry.providing('shell')`); the
   * per-profile `capabilities()` is authoritative once a profile is chosen.
   */
  readonly baseCapabilities: readonly RuntimeCapability[];

  /**
   * What a profile of this adapter may configure, for the UI to render.
   *
   * Optional: an adapter with no settings simply omits it, and the settings
   * form then offers nothing rather than guessing.
   */
  readonly settingsSchema?: readonly RuntimeSettingField[];

  /**
   * Reject settings this adapter cannot honour, before a profile is saved.
   *
   * Without it a malformed setting is only discovered when a run spawns, which
   * is both far from the mistake and after a mission has already started.
   * Throws; returning normally means accepted.
   */
  validateSettings?(settings: Readonly<Record<string, unknown>>): void;

  discover(): Promise<RuntimeDiscovery>;
  healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth>;
  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[];
  /**
   * Whether this profile can be given a model per run (P12). Absent means no:
   * the run is recorded as using the runtime's default, never a model that was
   * not passed.
   */
  acceptsModel?(profile: RuntimeProfile): boolean;
  /**
   * Where this profile's runtime reads skills from, relative to its working
   * folder (P13), or null when it reads none. Absent means none: pinned skills
   * then reach the run through its prompt instead.
   */
  skillsFolder?(profile: RuntimeProfile): string | null;

  start(request: RunRequest): AsyncIterable<AgentEvent>;
  /**
   * Continues a run from a handle a previous run produced.
   *
   * A handle can go stale - the runtime prunes its session store, the session
   * was never written because the process died first, or the profile now runs
   * under a different config directory. An adapter that discovers this MUST
   * fail with {@link SESSION_NOT_FOUND} rather than passing its vendor's own
   * error code through, because that is the one failure the caller can undo by
   * simply starting fresh.
   */
  resume?(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: RunId): Promise<void>;
  /**
   * The runtime's own interactive CLI for a hold: the process a person drives
   * in a terminal, resumed in `sessionRef` or (null) started fresh with
   * `initialPrompt`. It records its session id to `sessionFile`, and each
   * message the person sends to `promptsFile` when given. Absent means the
   * runtime cannot be held.
   */
  interactive?(
    sessionRef: string | null,
    request: RunRequest,
    opts: InteractiveOptions,
  ): InteractiveInvocation;

  /**
   * The OS process this run is using, or null when there is none (an in-process
   * runtime) or the run has ended. The supervisor records it so that after a
   * daemon crash it can ask whether the child is still alive before deciding
   * between resume and retry (MVP.md §21.1, §21.2).
   */
  pid(runId: RunId): number | null;
}

export interface RuntimeAdapterDescriptor extends Descriptor {
  readonly adapter: AgentRuntimeAdapter;
}

export function describeAdapter(adapter: AgentRuntimeAdapter): RuntimeAdapterDescriptor {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    provides: adapter.baseCapabilities,
    adapter,
  };
}

/**
 * The plugin seam. Every runtime package contributes here; nothing in the core
 * ever imports a runtime package (MVP.md §26.1).
 */
export const RUNTIME_ADAPTERS = multiToken<AgentRuntimeAdapter>('RuntimeAdapter');

/** What a hold's interactive session is started with. */
export interface InteractiveOptions {
  readonly sessionFile: string;
  readonly initialPrompt: string | null;
  /**
   * Where the session appends what the person types, one JSON line
   * `{ "at": ISO time, "prompt": text }` per message (#117). Every later
   * attempt of the step is told it, so a retry never undoes what a person said.
   */
  readonly promptsFile?: string;
}
