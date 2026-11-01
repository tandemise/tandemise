import type { RuntimeProfileId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { RuntimeCapability } from '../capability.js';

/**
 * A configured agent runtime.
 *
 * `adapterId` names a registered adapter, never a vendor: swapping Claude Code
 * for another worker is a change of profile, not of mission, role, or artifact
 * (MVP.md §P2).
 */
export interface RuntimeProfile {
  readonly id: RuntimeProfileId;
  readonly workspaceId: WorkspaceId | null;
  readonly adapterId: string;
  readonly name: string;
  readonly executablePath: string | null;
  readonly args: readonly string[];
  /** Adapter-specific settings (model, permission mode, sandbox flags…). */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly RuntimeCapability[];
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * How many runs at once a runtime added without a concurrency of its own may
 * take (#101). A subscription CLI - Claude Code, Codex - is happy running a
 * few sessions side by side, and starting it at 1 made the factory slower
 * than the three terminals it replaces. Never above the project's own worker
 * limit, which the scheduler enforces anyway: a default above it would only
 * read as a promise the project does not keep.
 */
export const DEFAULT_RUNTIME_CONCURRENCY = 3;

/** The concurrency a new runtime starts at, given its project's `maxTotalWorkers` (null: no project to read). */
export function defaultRuntimeConcurrency(maxTotalWorkers: number | null): number {
  if (maxTotalWorkers === null || !Number.isFinite(maxTotalWorkers)) return DEFAULT_RUNTIME_CONCURRENCY;
  return Math.max(1, Math.min(DEFAULT_RUNTIME_CONCURRENCY, Math.floor(maxTotalWorkers)));
}

/** How the executor opens a step's reason when every capable runtime is out of slots. */
export const RUNTIME_SLOT_WAIT_PREFIX = 'Waiting for a runtime slot.';

/**
 * The Board's sentence for a step deferred on saturated runtimes (#101):
 * "Waiting for a free slot on Claude Code", or null when the reason is
 * anything else. Read from the step's reason, which names each runtime the
 * way the runtime manager describes a rejection - `'<name>': saturated: …`,
 * joined by "; ".
 */
export function runtimeSlotWait(statusReason: string | null | undefined): string | null {
  if (typeof statusReason !== 'string' || !statusReason.startsWith(RUNTIME_SLOT_WAIT_PREFIX)) return null;
  const names: string[] = [];
  for (const part of statusReason.slice(RUNTIME_SLOT_WAIT_PREFIX.length).split(/; (?=')/)) {
    const match = /^\s*'(.*)': saturated: /.exec(part);
    const name = match?.[1];
    if (name !== undefined && name !== '' && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return 'Waiting for a free runtime slot';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Waiting for a free slot on ${list}`;
}

/**
 * One setting an adapter understands, described so a UI can offer it.
 *
 * Without this the desktop would have to know that `claude-code` takes a
 * `model` and a `configDir` while some other adapter takes neither - putting
 * vendor knowledge in the renderer, which is precisely what `adapterId` exists
 * to avoid (MVP.md §P2). An adapter describes its own settings; the UI renders
 * whatever it is told and stores the result in `RuntimeProfile.settings`.
 *
 * Deliberately a small, closed set of kinds. A settings form is not a place for
 * arbitrary widgets, and every field here has to round-trip through a plain
 * JSON record.
 */
export interface RuntimeSettingField {
  /** Key within `RuntimeProfile.settings`. */
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'select' | 'number';
  /** Shown under the field. The place to explain what the setting is for. */
  readonly hint?: string;
  readonly placeholder?: string;
  /** Required for `select`, ignored otherwise. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
}

export const RUNTIME_HEALTH_STATES = ['healthy', 'degraded', 'unavailable', 'unknown'] as const;
export type RuntimeHealthState = (typeof RUNTIME_HEALTH_STATES)[number];

export interface RuntimeHealth {
  readonly profileId: RuntimeProfileId;
  readonly state: RuntimeHealthState;
  readonly version: string | null;
  readonly detail: string;
  readonly checkedAt: Timestamp;
  /** Set when the runtime reported a quota/rate limit (MVP.md §22.2). */
  readonly quotaWarning: string | null;
  /**
   * Set when the runtime cannot run until a person does something - sign in
   * again, typically - and says what. Distinct from a plain `unavailable`: the
   * work waiting on this runtime should wait, not fail, because nothing about
   * the work is wrong and the fix is one action away.
   */
  readonly actionRequired?: string;
}

/** What an adapter found on the machine, before the user configures a profile. */
export interface RuntimeDiscovery {
  readonly adapterId: string;
  readonly displayName: string;
  readonly detected: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly capabilities: readonly RuntimeCapability[];
  readonly detail: string;
  /** Suggested settings for a profile created from this discovery. */
  readonly suggestedSettings: Readonly<Record<string, unknown>>;
  /** What this adapter lets a profile configure. Absent means nothing. */
  readonly settingsSchema?: readonly RuntimeSettingField[];
}
