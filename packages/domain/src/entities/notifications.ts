/**
 * Desktop notifications (P16): which Inbox items to announce, decided by one
 * pure function over the Inbox and what was already announced.
 *
 * The Inbox projection is the only source of items; this module never looks at
 * missions or runs. That is what keeps a notification and the Inbox row it
 * points at from ever disagreeing: if it is not in the Inbox, nothing is said.
 */

/** The switches in Settings → Notifications, one per kind of Inbox item. */
export const NOTIFY_KINDS = ['decisions', 'refinements', 'stalled', 'quiet', 'limits'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** One Inbox item, as a notification would describe it. */
export interface NotifyItem {
  /** The Inbox id: approval or task id, or `refinement:<m>`, `stalled:<m>`, `quiet:<run>`. */
  readonly id: string;
  readonly kind: NotifyKind;
  readonly workspaceId: string;
  /** Headline when it is announced on its own: "Decision needed". */
  readonly title: string;
  /** One line from the row: "Approve the plan · Add CSV export". */
  readonly body: string;
  /** Desktop route a click opens. */
  readonly route: string;
}

export interface QuietHours {
  /** Local wall clock, `HH:MM`. */
  readonly from: string;
  readonly to: string;
}

export interface NotifyPreferences {
  readonly kinds: Readonly<Record<NotifyKind, boolean>>;
  /** Null: no quiet hours. */
  readonly quietHours: QuietHours | null;
}

export const DEFAULT_NOTIFY_PREFERENCES: NotifyPreferences = {
  kinds: { decisions: true, refinements: true, stalled: true, quiet: true, limits: true },
  quietHours: null,
};

/** What the daemon remembers between polls. */
export interface NotifyState {
  /** Ids announced, or deliberately skipped (kind off, already looking at the Inbox). */
  readonly notified: readonly string[];
  /** Ids that arrived during quiet hours, summarised once they end. */
  readonly held: readonly string[];
}

export const EMPTY_NOTIFY_STATE: NotifyState = { notified: [], held: [] };

/** How many announced ids are remembered; ids still in the Inbox are never forgotten. */
export const NOTIFIED_MEMORY = 500;

export interface Notice {
  readonly title: string;
  readonly body: string;
  readonly route: string;
  /** The project to open, or null when the items span projects. */
  readonly workspaceId: string | null;
  readonly ids: readonly string[];
  /** `item`: one item. `coalesced`: several at once. `summary`: some were held by quiet hours. */
  readonly shape: 'item' | 'coalesced' | 'summary';
}

export interface NotifyPlanInput {
  readonly items: readonly NotifyItem[];
  readonly state: NotifyState;
  readonly preferences: NotifyPreferences;
  /** Local minutes since midnight, 0..1439. */
  readonly minuteOfDay: number;
  /** The person is looking at the Inbox: record, do not announce. */
  readonly suppress: boolean;
}

export interface NotifyPlan {
  readonly notice: Notice | null;
  readonly state: NotifyState;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight for `HH:MM`, or null when it is not a time. */
export function minuteOf(value: string): number | null {
  const match = HHMM.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Inside quiet hours: `from` inclusive, `to` exclusive, wrapping midnight
 * (22:00–07:00). Equal ends mean no quiet hours rather than all day, so a
 * half-edited pair can never silence everything.
 */
export function inQuietHours(quietHours: QuietHours | null, minuteOfDay: number): boolean {
  if (quietHours === null) return false;
  const from = minuteOf(quietHours.from);
  const to = minuteOf(quietHours.to);
  if (from === null || to === null || from === to) return false;
  return from < to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to;
}

/** Reads stored preferences leniently: an unknown or broken value falls back to the default. */
export function normalizeNotifyPreferences(value: unknown): NotifyPreferences {
  const record = isRecord(value) ? value : {};
  const kindsIn = isRecord(record['kinds']) ? record['kinds'] : {};
  const kinds = Object.fromEntries(
    NOTIFY_KINDS.map((kind) => [kind, typeof kindsIn[kind] === 'boolean' ? kindsIn[kind] : DEFAULT_NOTIFY_PREFERENCES.kinds[kind]]),
  ) as Record<NotifyKind, boolean>;
  const q = record['quietHours'];
  const quietHours = isRecord(q) && typeof q['from'] === 'string' && typeof q['to'] === 'string'
    && minuteOf(q['from']) !== null && minuteOf(q['to']) !== null && q['from'] !== q['to']
    ? { from: q['from'], to: q['to'] }
    : null;
  return { kinds, quietHours };
}

export function normalizeNotifyState(value: unknown): NotifyState {
  const record = isRecord(value) ? value : {};
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { notified: ids(record['notified']), held: ids(record['held']) };
}

/**
 * The whole rule (P16 spec §2): current Inbox ids minus the ones already
 * announced, filtered by the switches, held by quiet hours, and folded into at
 * most one notice.
 */
export function planNotifications(input: NotifyPlanInput): NotifyPlan {
  const { preferences, suppress } = input;
  const items = uniqueById(input.items);
  const present = new Set(items.map((i) => i.id));
  const notified = new Set(input.state.notified);
  const held = new Set(input.state.held);

  const fresh = items.filter((i) => !notified.has(i.id) && !held.has(i.id));
  const off = fresh.filter((i) => !preferences.kinds[i.kind]);
  const on = fresh.filter((i) => preferences.kinds[i.kind]);
  // A held id that left the Inbox is resolved; there is nothing to summarise.
  const stillHeld = items.filter((i) => held.has(i.id));

  const remember = (ids: readonly string[]): readonly string[] => rememberIds(input.state.notified, ids, present);

  if (suppress) {
    return { notice: null, state: { notified: remember([...fresh, ...stillHeld].map((i) => i.id)), held: [] } };
  }
  if (inQuietHours(preferences.quietHours, input.minuteOfDay)) {
    return {
      notice: null,
      state: { notified: remember(off.map((i) => i.id)), held: [...stillHeld, ...on].map((i) => i.id) },
    };
  }
  const announce = [...stillHeld, ...on];
  const notice = announce.length === 0 ? null : noticeFor(announce, stillHeld.length > 0);
  return { notice, state: { notified: remember([...off, ...announce].map((i) => i.id)), held: [] } };
}

/**
 * The desktop could not show a notice: forget its ids, so they count as new
 * again and are announced once the operating system can show them. Recording
 * an id as notified is a claim that the person was told; this is what keeps it
 * true when the notification never left the app.
 */
export function releaseNotified(state: NotifyState, ids: readonly string[]): NotifyState {
  const released = new Set(ids);
  return {
    notified: state.notified.filter((id) => !released.has(id)),
    held: state.held.filter((id) => !released.has(id)),
  };
}

/** "3 things need you", or the item's own words when it is alone. */
export function noticeFor(items: readonly NotifyItem[], afterQuietHours: boolean): Notice {
  const workspaces = new Set(items.map((i) => i.workspaceId));
  const workspaceId = workspaces.size === 1 ? (items[0]?.workspaceId ?? null) : null;
  const ids = items.map((i) => i.id);
  const first = items[0];
  if (items.length === 1 && first !== undefined) {
    return afterQuietHours
      ? { title: 'After quiet hours: 1 thing needs you', body: `${first.title}: ${first.body}`, route: first.route, workspaceId, ids, shape: 'summary' }
      : { title: first.title, body: first.body, route: first.route, workspaceId, ids, shape: 'item' };
  }
  const shown = items.slice(0, 2).map((i) => i.body);
  const more = items.length - shown.length;
  const body = more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ');
  const count = `${items.length} things need you`;
  return {
    title: afterQuietHours ? `After quiet hours: ${count}` : count,
    body,
    route: '/inbox',
    workspaceId,
    ids,
    shape: afterQuietHours ? 'summary' : 'coalesced',
  };
}

/** Appends new ids, then forgets the oldest past NOTIFIED_MEMORY, never one still present. */
function rememberIds(previous: readonly string[], added: readonly string[], present: ReadonlySet<string>): readonly string[] {
  const addedSet = new Set(added);
  const all = [...previous.filter((id) => !addedSet.has(id)), ...added];
  let excess = all.length - NOTIFIED_MEMORY;
  if (excess <= 0) return all;
  return all.filter((id) => {
    if (excess > 0 && !present.has(id)) {
      excess--;
      return false;
    }
    return true;
  });
}

function uniqueById(items: readonly NotifyItem[]): NotifyItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
