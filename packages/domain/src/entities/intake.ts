/**
 * Intake (spec 2026-10-30-intake-design.md): anything that might be work, from
 * any source, recorded as a signal and landed as one item in the project's
 * primary tracker.
 *
 * Everything here is pure: the fingerprint that dedupes a signal, how two
 * readings of one signal's impact merge, the words a source kind reads as, and
 * the configuration shapes the pipeline reads through `IntakeConfigSource`.
 * The zod contract and the file schemas live in `@tandemise/api-contract`;
 * these types mirror them so the domain and application layers never depend
 * on the wire format.
 *
 * Signal text is untrusted data (spec §1 "Text is data"). Nothing here reads it
 * for anything but words, so a signal cannot choose a project, a tracker, a
 * state, a threshold or a source.
 */
import type {
  ClosureId, IntakeLinkId, IntakeTokenId, SignalId, Timestamp, WebhookMessageId, WorkspaceId,
} from '@tandemise/shared';

/** Where a signal is in the pipeline (spec §4, §8). */
export const SIGNAL_STATUSES = [
  'received',
  'held_back',
  'needs_decision',
  'linked',
  'created',
  'rejected',
  'dismissed',
  'closure_pending',
  'closed',
  'closure_failed',
] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Spec §1 `impact.level`, least to most severe. */
export const IMPACT_LEVELS = ['info', 'warning', 'error', 'fatal'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const KIND_HINTS = ['bug', 'request', 'question'] as const;
export type KindHint = (typeof KIND_HINTS)[number];

/** What the noise filter reads (spec §1 `impact`, §4.1). Every field is optional. */
export interface Impact {
  readonly level?: ImpactLevel;
  readonly events?: number;
  readonly users?: number;
  /** ISO 8601. */
  readonly firstSeen?: string;
  /** ISO 8601. */
  readonly lastSeen?: string;
  readonly release?: string;
}

/**
 * The deterministic dedupe key (spec §1, "Words"): `<kind>:<instance>:<key>`.
 * The same fingerprint always updates the same signal.
 */
export function fingerprintOf(s: { readonly source: { readonly kind: string; readonly instance: string }; readonly key: string }): string {
  return `${s.source.kind}:${s.source.instance}:${s.key}`;
}

/**
 * One signal read twice (a repeat push, the next poll) keeps its worst news:
 * the larger counts, the earliest first sighting, the latest last sighting,
 * the more severe level. The newer reading's release wins, because a release
 * is a label, not a quantity. Absent fields never erase present ones.
 * ISO 8601 timestamps compare correctly as strings.
 */
export function mergeImpact(prev: Impact | null, next: Impact | null): Impact | null {
  if (prev === null) return next;
  if (next === null) return prev;
  const out: { -readonly [K in keyof Impact]: Impact[K] } = {};
  const level = moreSevere(prev.level, next.level);
  if (level !== undefined) out.level = level;
  const events = pick(prev.events, next.events, (a, b) => Math.max(a, b));
  if (events !== undefined) out.events = events;
  const users = pick(prev.users, next.users, (a, b) => Math.max(a, b));
  if (users !== undefined) out.users = users;
  const firstSeen = pick(prev.firstSeen, next.firstSeen, (a, b) => (a <= b ? a : b));
  if (firstSeen !== undefined) out.firstSeen = firstSeen;
  const lastSeen = pick(prev.lastSeen, next.lastSeen, (a, b) => (a >= b ? a : b));
  if (lastSeen !== undefined) out.lastSeen = lastSeen;
  const release = next.release ?? prev.release;
  if (release !== undefined) out.release = release;
  return out;
}

function pick<T>(a: T | undefined, b: T | undefined, both: (a: T, b: T) => T): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return both(a, b);
}

function moreSevere(a: ImpactLevel | undefined, b: ImpactLevel | undefined): ImpactLevel | undefined {
  return pick(a, b, (x, y) => (IMPACT_LEVELS.indexOf(x) >= IMPACT_LEVELS.indexOf(y) ? x : y));
}

const SHIPPED_SOURCE_LABELS: Readonly<Record<string, string>> = {
  github: 'GitHub',
  sentry: 'Sentry',
  posthog: 'PostHog',
  slack: 'Slack',
  discord: 'Discord',
};

/** The words a source kind reads as. A custom runner's slug is shown as itself. */
export function sourceLabel(kind: string): string {
  return SHIPPED_SOURCE_LABELS[kind] ?? kind;
}

// ------------------------------------------------------------------ configuration

export const TRACKER_KINDS = ['youtrack', 'github-issues'] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];

export const INTAKE_SOURCE_CADENCES = ['5m', '10m', '15m', '30m', '60m'] as const;
export type IntakeSourceCadence = (typeof INTAKE_SOURCE_CADENCES)[number];

export const INTAKE_FILTER_WINDOWS = ['1h', '24h', '7d'] as const;
export type IntakeFilterWindow = (typeof INTAKE_FILTER_WINDOWS)[number];

export const DEFAULT_INTAKE_DAILY_CAP = 20;
export const DEFAULT_INTAKE_SIMILARITY: { readonly link: number; readonly ask: number } = { link: 0.85, ask: 0.55 };

/** Spec §6.2: the tracker's own states mapped to the five Tandemise needs. */
export interface TrackerStatesConfig {
  /** Where intake creates; what the board offers to Start. At least one. */
  readonly ready: readonly string[];
  readonly in_progress: string;
  readonly in_review?: string;
  /** The first one is what Tandemise writes. At least one. */
  readonly done: readonly string[];
  readonly wont_do: readonly string[];
  /**
   * Optional (#135): the tracker's states for work still to be refined. The
   * Board lists them in a Draft group and offers Refine on them, never Start.
   */
  readonly draft?: readonly string[];
}

/** Spec §6.2 `factory/tracker.yaml`'s `tracker`. */
export interface TrackerConfig {
  readonly kind: TrackerKind;
  /** YouTrack's base URL. */
  readonly url?: string;
  /** YouTrack's project short name. */
  readonly project?: string;
  /** GitHub Issues' `owner/name`. */
  readonly repo?: string;
  /** The tracker's own query for the board. */
  readonly board: string;
  readonly states: TrackerStatesConfig;
  /** What Tandemise writes when a mission completes. */
  readonly onComplete: 'in_review' | 'done';
  readonly workflows?: Readonly<Record<string, string>>;
}

/** Spec §4.1 per-source noise rules. */
export interface NoiseRules {
  readonly minLevel?: ImpactLevel;
  readonly minEvents?: number;
  readonly minUsers?: number;
  readonly window?: IntakeFilterWindow;
  /** A plain substring, or `/re/` for a regular expression. */
  readonly ignoreTitles?: readonly string[];
}

/** Spec §4.1 `factory/intake.yaml`'s one source. */
export interface IntakeSourceConfig {
  readonly id: string;
  readonly kind: string;
  readonly instance: string;
  readonly every?: IntakeSourceCadence;
  readonly filter?: NoiseRules;
  /** `react: false` (Ruling 26): a chat source files and closes without reacting to the message. */
  readonly trigger?: { readonly emoji?: string; readonly mention?: boolean; readonly label?: string; readonly react?: boolean };
  readonly create?: { readonly type?: string; readonly fields?: Readonly<Record<string, string>> };
  readonly closeOnDone: boolean;
  readonly closeWontDo: boolean;
  /** Base-URL override for self-hosted instances and fakes: https, or http on loopback only. */
  readonly api?: string;
}

/** Everything the pipeline reads about one project, from wherever it is configured. */
export interface IntakeConfig {
  /** Null when the project has no tracker, and so no intake (spec §6.2). */
  readonly tracker: TrackerConfig | null;
  readonly sources: readonly IntakeSourceConfig[];
  /** New tracker items per source per day; past it, signals wait as `needs_decision`. */
  readonly dailyCap: number;
  readonly similarity: { readonly link: number; readonly ask: number };
}

/** What a project with nothing configured reads as. */
export function emptyIntakeConfig(): IntakeConfig {
  return { tracker: null, sources: [], dailyCap: DEFAULT_INTAKE_DAILY_CAP, similarity: { ...DEFAULT_INTAKE_SIMILARITY } };
}

// ------------------------------------------------------------------ the noise filter (plan Task 6)

export type NoiseVerdict = { readonly verdict: 'pass' } | { readonly verdict: 'held_back'; readonly reason: string };

const WINDOW_MS: Readonly<Record<IntakeFilterWindow, number>> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
const WINDOW_WORDS: Readonly<Record<IntakeFilterWindow, string>> = { '1h': '1 h', '24h': '24 h', '7d': '7 days' };

/**
 * Spec §4.1: a pure function of the aggregated signal and the source's rules.
 * The rules are checked in the plan's order (ignoreTitles, minLevel, window,
 * minEvents, minUsers) and the first one the signal is under gives the reason,
 * in plain words. No rules pass everything (a custom runner may already filter).
 *
 * A rule the signal carries no data for (no level, no user count, no last
 * sighting) does not hold it back: the filter holds back only what it can show
 * is under the bar (Ruling 11). Events fall back to the occurrences Tandemise
 * counted itself, so `minEvents` always applies. A repeat re-evaluates, so an
 * error that grows from 3 to 300 events passes on its own.
 */
export function evaluateNoise(
  signal: { readonly title: string; readonly occurrences: number; readonly impact: Impact | null },
  rules: NoiseRules | undefined,
  nowIso: string,
): NoiseVerdict {
  if (rules === undefined) return { verdict: 'pass' };
  const held = (reason: string): NoiseVerdict => ({ verdict: 'held_back', reason });
  const impact = signal.impact ?? {};

  for (const rule of rules.ignoreTitles ?? []) {
    if (titleMatches(signal.title, rule)) return held(`Ignored by this source's rule '${rule}'`);
  }
  if (rules.minLevel !== undefined && impact.level !== undefined
    && IMPACT_LEVELS.indexOf(impact.level) < IMPACT_LEVELS.indexOf(rules.minLevel)) {
    return held(`Level ${impact.level}; this source takes ${rules.minLevel} and above`);
  }
  if (rules.window !== undefined && impact.lastSeen !== undefined) {
    const age = Date.parse(nowIso) - Date.parse(impact.lastSeen);
    if (age > WINDOW_MS[rules.window]) {
      return held(`Last seen ${ageWords(age)} ago; this source looks at the last ${WINDOW_WORDS[rules.window]}`);
    }
  }
  const events = impact.events ?? signal.occurrences;
  if (rules.minEvents !== undefined && events < rules.minEvents) {
    const span = rules.window === undefined ? '' : ` in ${WINDOW_WORDS[rules.window]}`;
    return held(`${events} ${events === 1 ? 'event' : 'events'}${span}; this source needs ${rules.minEvents}`);
  }
  if (rules.minUsers !== undefined && impact.users !== undefined && impact.users < rules.minUsers) {
    return held(`${impact.users} ${impact.users === 1 ? 'person' : 'people'} affected; this source needs ${rules.minUsers}`);
  }
  return { verdict: 'pass' };
}

/**
 * A plain substring (case ignored), or `/re/flags` for a regular expression.
 * A rule that does not compile matches nothing rather than failing the
 * pipeline. Rules come from the team's configuration, never from a signal.
 */
function titleMatches(title: string, rule: string): boolean {
  const re = /^\/(.+)\/([a-z]*)$/s.exec(rule);
  if (re === null) return title.toLowerCase().includes(rule.toLowerCase());
  try {
    return new RegExp(re[1]!, re[2]).test(title);
  } catch {
    return false;
  }
}

/** Whole days past a day, whole hours past an hour, otherwise whole minutes. */
function ageWords(ms: number): string {
  const unit = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (ms >= 86_400_000) return unit(Math.floor(ms / 86_400_000), 'day');
  if (ms >= 3_600_000) return unit(Math.floor(ms / 3_600_000), 'hour');
  return unit(Math.floor(ms / 60_000), 'minute');
}

/** Spec §4.1 "the daily cap": why a signal past it waits as `needs_decision`. */
export function dailyCapReason(cap: number): string {
  return `This source already filed ${cap} tasks today; decide on this one.`;
}

// ------------------------------------------------------------------ stored records (plan Task 2)

/**
 * A signal as the store reads it: the domain's mirror of `IntakeSignalV1`
 * (`@tandemise/api-contract`), which this layer cannot import. Inline
 * attachment content is not part of it: blobs are stored apart and recorded
 * through `addAttachment`.
 */
export interface IntakeSignalInput {
  readonly source: { readonly kind: string; readonly instance: string };
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly reporter?: IntakeReporter;
  readonly occurredAt?: string;
  readonly impact?: Impact;
  readonly labels?: readonly string[];
  readonly reply?: IntakeReply;
  readonly kindHint?: KindHint;
}

/** Spec §1 `reporter`: never an email address. */
export interface IntakeReporter {
  readonly name?: string;
  readonly handle?: string;
  readonly url?: string;
}

/** Spec §8: opaque to Tandemise, what the runner needs to close the loop. */
export interface IntakeReply {
  readonly address: string;
}

/** One recorded signal, unique per `(workspace, fingerprint)`. */
export interface IntakeSignal {
  readonly id: SignalId;
  readonly workspaceId: WorkspaceId;
  /** The configured source (or the push token's source) it arrived through. */
  readonly sourceId: string;
  readonly fingerprint: string;
  /** Empty on a rejected signal whose source or key could not be read. */
  readonly kind: string;
  readonly instance: string;
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly reporter: IntakeReporter | null;
  readonly impact: Impact | null;
  readonly labels: readonly string[];
  readonly reply: IntakeReply | null;
  readonly kindHint: KindHint | null;
  /** How many times it was pushed or polled; at least 1. */
  readonly occurrences: number;
  readonly firstSeenAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  readonly status: SignalStatus;
  /** Plain words: why it was rejected, held back or needs a decision. */
  readonly reason: string | null;
  /** The item a `needs_decision` signal may be the same as. */
  readonly candidateRef: string | null;
  readonly score: number | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Exactly one of `blobSha256` and `url` is set. */
export interface IntakeAttachment {
  readonly signalId: SignalId;
  readonly name: string;
  readonly mediaType: string;
  readonly blobSha256: string | null;
  readonly url: string | null;
}

/** A source's running state in one project. Its configuration lives in `IntakeConfigSource`. */
export interface IntakeSourceState {
  readonly workspaceId: WorkspaceId;
  readonly sourceId: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly enabledBy: string | null;
  /** Runner-owned and opaque: where the next poll starts. */
  readonly cursor: Readonly<Record<string, unknown>> | null;
  readonly lastCheckedAt: Timestamp | null;
  readonly lastError: string | null;
  /** Secret-store refs by name, never the secrets themselves. */
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** `kind` is required the first time a source is saved. */
export type IntakeSourcePatch = Partial<Pick<IntakeSourceState,
  'kind' | 'enabled' | 'enabledBy' | 'cursor' | 'lastCheckedAt' | 'lastError' | 'secretRefs'>>;

export const INTAKE_LINK_STATUSES = ['pending', 'done'] as const;
export type IntakeLinkStatus = (typeof INTAKE_LINK_STATUSES)[number];

/** How a signal came to point at its item (spec §5). */
export const INTAKE_LINKED_BY = ['created', 'url', 'source_is_item', 'similarity', 'person', 'merged'] as const;
export type IntakeLinkedBy = (typeof INTAKE_LINKED_BY)[number];

/**
 * A signal's one item. Written `pending` before the tracker call and `done`
 * after it. A pending link for a create has no ref yet (plan Global
 * Constraints, Review Focus 1).
 */
export interface IntakeLink {
  readonly id: IntakeLinkId;
  readonly workspaceId: WorkspaceId;
  readonly signalId: SignalId;
  readonly itemRef: string | null;
  readonly status: IntakeLinkStatus;
  readonly linkedBy: IntakeLinkedBy;
  readonly score: number | null;
  /** What Tandemise last wrote to the tracker for this source; null until it wrote. */
  readonly written: IntakeLinkWritten | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * The bar a linked signal's next reading is measured against (spec §6.1, plan
 * Task 7): the level and the event count last written to the tracker, and
 * whether its item was resolved then.
 */
export interface IntakeLinkWritten {
  readonly level?: ImpactLevel;
  readonly events?: number;
  readonly itemResolved?: boolean;
}

/** What a write for this reading records as the next bar. */
export function linkWritten(impact: Impact | null, itemResolved: boolean): IntakeLinkWritten {
  return {
    ...(impact?.level === undefined ? {} : { level: impact.level }),
    ...(impact?.events === undefined ? {} : { events: impact.events }),
    ...(itemResolved ? { itemResolved: true } : {}),
  };
}

/**
 * Spec §6.1: a linked signal's change matters when it reopens (it comes back
 * while its item is resolved), its level rises, or its events grow tenfold
 * against what was last written. Then the same sources comment is updated;
 * anything less writes nothing, so a noisy source never spams the item.
 */
export function linkChangeMatters(written: IntakeLinkWritten | null, now: { readonly impact: Impact | null; readonly itemResolved: boolean }): boolean {
  if (written === null) return false;
  if (now.itemResolved && written.itemResolved !== true) return true;
  const level = now.impact?.level;
  if (level !== undefined && written.level !== undefined && IMPACT_LEVELS.indexOf(level) > IMPACT_LEVELS.indexOf(written.level)) return true;
  const events = now.impact?.events;
  return events !== undefined && written.events !== undefined && events >= 10 * Math.max(written.events, 1);
}

export const CLOSURE_KINDS = ['done', 'not_planned'] as const;
export type ClosureKind = (typeof CLOSURE_KINDS)[number];

export const CLOSURE_STATES = ['pending', 'closed', 'failed'] as const;
export type ClosureState = (typeof CLOSURE_STATES)[number];

/** Closing the loop at one source, exactly once per `(signal, kind)` (spec §8). */
export interface IntakeClosure {
  readonly id: ClosureId;
  readonly signalId: SignalId;
  readonly kind: ClosureKind;
  readonly state: ClosureState;
  readonly attempts: number;
  readonly nextAttemptAt: Timestamp | null;
  /** The source's own id for what it posted (a reply, a comment), once known. */
  readonly externalId: string | null;
  readonly lastError: string | null;
  readonly closedAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export type IntakeClosurePatch = Partial<Pick<IntakeClosure,
  'state' | 'attempts' | 'nextAttemptAt' | 'externalId' | 'lastError' | 'closedAt'>>;

/** A push token, stored by its sha256 hex only (spec §3). */
export interface IntakeTokenRow {
  readonly id: IntakeTokenId;
  readonly workspaceId: WorkspaceId;
  readonly sourceId: string;
  readonly tokenHash: string;
  readonly createdBy: string | null;
  readonly createdAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

/** One webhook delivery, as the opt-in listener received it. */
export interface WebhookMessage {
  readonly id: WebhookMessageId;
  readonly workspaceId: WorkspaceId;
  readonly sourceId: string;
  readonly receivedAt: Timestamp;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}
