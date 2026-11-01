import { z } from 'zod';
import { OUTCOME_KINDS, type OutcomeEvent } from './outcomes.js';

/**
 * The brain's memory ledger (#51 spec §5): an append-only log of events, one
 * file per writer per month, folded by a pure function into the current
 * memory. No model and no person ever rewrites it: an LLM only proposes deltas
 * (ACE), and the fold merges them deterministically, so every daemon with the
 * same events computes the same memory in whatever order they arrived.
 */

/** One atomic statement; longer than this is not a lesson but an essay. */
export const ENTRY_MAX_CHARS = 400;
/** A person's thumbs up or down outweighs a model's tag: they saw the outcome. */
export const PERSON_VOTE_WEIGHT = 3;
/** Fewer harmful votes than this is noise, however the net reads. */
export const HARMFUL_MIN = 3;
/** ...and the entry must be clearly net harmful before it stops loading. */
export const HARMFUL_NET_MAX = -2;
/** Not confirmed for this long ranks lower and says so; it is never removed for age. */
export const STALE_AFTER_DAYS = 90;

export type Iso = string;
export type EntryId = string;
export type VoteSource = 'reflector' | 'person';
export type EntrySignal = 'hold' | 'rejection' | 'gate' | 'person' | 'agent' | 'mission';

export interface RunRef {
  readonly daemon: string;
  readonly runId: string;
}

export interface EntryScope {
  readonly repo?: string;
  readonly role?: string;
  readonly step?: string;
  readonly paths?: readonly string[];
}

export interface EntryBody {
  readonly kind: 'lesson' | 'convention' | 'history';
  readonly text: string;
  readonly scope: EntryScope;
  readonly source: {
    readonly signal: EntrySignal;
    readonly mission: string;
    readonly tracker?: string;
    readonly run?: RunRef;
  };
  readonly state: 'active' | 'candidate';
}

/**
 * Every event carries `eid`, unique per write, so an event appended twice (a
 * flush retried after a failed commit) folds once. Lines written before `eid`
 * existed have none and are taken as they are.
 */
export type LedgerEvent = (
  | { readonly op: 'add'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly entry: EntryBody }
  | { readonly op: 'vote'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly vote: 'helpful' | 'harmful'; readonly why: VoteSource; readonly run?: RunRef; readonly mission?: string }
  | { readonly op: 'confirm'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly run?: RunRef; readonly mission?: string }
  | { readonly op: 'accept' | 'reject'; readonly id: EntryId; readonly at: Iso; readonly by: string }
  | { readonly op: 'supersede'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly successor: EntryId; readonly invalidAt: Iso }
  | { readonly op: 'promote'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly target: string; readonly pr: string | null }
  | { readonly op: 'retire'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly reason: string }
  /** A promotion's PR closed unmerged: the lesson is no longer promoted by that PR. Idempotent per PR. */
  | { readonly op: 'unpromote'; readonly id: EntryId; readonly at: Iso; readonly by: string; readonly pr: string | null }
  /**
   * What happened to a mission's work (#53 §9.1): routing and learning read
   * these; the lesson fold skips them. Same per-writer, append-only rules.
   */
  | ({ readonly op: 'outcome'; readonly id: string; readonly at: Iso; readonly by: string } & Omit<OutcomeEvent, 'op' | 'id' | 'at' | 'by'>)
) & { readonly eid?: string };

export interface LedgerProblem {
  readonly file: string;
  readonly line: number;
  readonly problem: string;
}

export interface BrainEntry {
  readonly id: EntryId;
  readonly kind: EntryBody['kind'];
  readonly text: string;
  readonly scope: EntryScope;
  readonly source: EntryBody['source'];
  readonly state: 'active' | 'candidate' | 'accepted' | 'rejected';
  readonly helpful: number;
  readonly harmful: number;
  readonly net: number;
  readonly addedAt: Iso;
  readonly lastConfirmedAt: Iso;
  /** Mission titles that added, confirmed or voted on it. */
  readonly missions: readonly string[];
  /** A mission other than its source confirmed it (what a candidate needs to load). */
  readonly confirmedElsewhere: boolean;
  readonly invalidAt: Iso | null;
  readonly supersededBy: EntryId | null;
  readonly retired: { readonly at: Iso; readonly reason: string } | null;
  readonly promoted: { readonly target: string; readonly pr: string | null } | null;
  /** Distinct sources of helpful votes (a writer in one run or mission each); promotion needs two. */
  readonly supporters: number;
  /** Net helpful votes gained since its last rejected promotion (spec §8 "three more"). */
  readonly netSinceRejected: number | null;
  readonly flags: { readonly harmful: boolean; readonly stale: boolean };
}

export interface BrainMemory {
  readonly entries: readonly BrainEntry[];
  /** A duplicate's id → the entry it merged into. */
  readonly aliases: Readonly<Record<string, string>>;
  readonly problems: readonly LedgerProblem[];
}

// ------------------------------------------------------------------ parsing

const runRef = z.object({ daemon: z.string().min(1), runId: z.string().min(1) });
const scopeSchema = z.object({
  repo: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  step: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
}).strict();
const base = { id: z.string().min(3), at: z.string().min(10), by: z.string().min(1), eid: z.string().min(3).optional() };
const eventSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'), ...base,
    entry: z.object({
      kind: z.enum(['lesson', 'convention', 'history']),
      text: z.string().min(1).max(ENTRY_MAX_CHARS),
      scope: scopeSchema,
      source: z.object({
        signal: z.enum(['hold', 'rejection', 'gate', 'person', 'agent', 'mission']),
        mission: z.string(),
        tracker: z.string().optional(),
        run: runRef.optional(),
      }),
      state: z.enum(['active', 'candidate']),
    }),
  }),
  z.object({ op: z.literal('vote'), ...base, vote: z.enum(['helpful', 'harmful']), why: z.enum(['reflector', 'person']), run: runRef.optional(), mission: z.string().optional() }),
  z.object({ op: z.literal('confirm'), ...base, run: runRef.optional(), mission: z.string().optional() }),
  z.object({ op: z.literal('accept'), ...base }),
  z.object({ op: z.literal('reject'), ...base }),
  z.object({ op: z.literal('supersede'), ...base, successor: z.string().min(3), invalidAt: z.string().min(10) }),
  z.object({ op: z.literal('promote'), ...base, target: z.string().min(1), pr: z.string().nullable() }),
  z.object({ op: z.literal('retire'), ...base, reason: z.string() }),
  z.object({ op: z.literal('unpromote'), ...base, pr: z.string().nullable() }),
  z.object({
    op: z.literal('outcome'), ...base,
    mission: z.string().min(1), tracker: z.string().optional(),
    lane: z.enum(['quick', 'standard', 'careful']),
    profile: z.object({ type: z.string(), size: z.string(), risk: z.string(), areas: z.array(z.string()), sensitivity: z.string().optional() }),
    kind: z.enum(OUTCOME_KINDS),
    step: z.object({
      class: z.string(), model: z.string().nullable(), attempt: z.number(), gatePassed: z.boolean(),
      costUsd: z.number().nullable(), wallTimeMs: z.number().nullable(), taskKey: z.string().optional(),
    }).optional(),
    merge: z.object({ verdict: z.enum(['merge', 'ask']), score: z.number(), pr: z.string(), approval: z.object({ by: z.string(), card: z.string().optional() }).optional() }).optional(),
  }),
]);

/** Validates an event the daemon is about to write (the same schema the fold reads with). */
export function validateLedgerEvent(value: unknown): { event: LedgerEvent } | { problem: string } {
  const parsed = eventSchema.safeParse(value);
  if (parsed.success) return { event: parsed.data as LedgerEvent };
  const issue = parsed.error.issues[0];
  return { problem: `${issue?.path.join('.') || '(event)'}: ${issue?.message ?? 'not a ledger event'}` };
}

/** Where a parsed event came from, for "<file> line <n>" problems. Not part of the event. */
const LOCATIONS = new WeakMap<object, { file: string; line: number }>();

export function parseLedgerLine(line: string, file: string, n: number): LedgerEvent | LedgerProblem {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { file, line: n, problem: `${file} line ${n}: isn't valid JSON.` };
  }
  const result = validateLedgerEvent(raw);
  if ('problem' in result) return { file, line: n, problem: `${file} line ${n}: ${result.problem}` };
  LOCATIONS.set(result.event, { file, line: n });
  return result.event;
}

/** Every line of a ledger file, parsed; blank lines are skipped. */
export function parseLedgerFile(text: string, file: string): { events: LedgerEvent[]; problems: LedgerProblem[] } {
  const events: LedgerEvent[] = [];
  const problems: LedgerProblem[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const parsed = parseLedgerLine(line, file, i + 1);
    if ('problem' in parsed) problems.push(parsed);
    else events.push(parsed);
  });
  return { events, problems };
}

// ------------------------------------------------------------------ fold

export function normaliseText(t: string): string {
  return t.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

export function scopeKey(scope: EntryScope): string {
  const out: Record<string, unknown> = {};
  for (const key of ['paths', 'repo', 'role', 'step'] as const) {
    const v = scope[key];
    if (v === undefined) continue;
    out[key] = key === 'paths' ? [...(v as readonly string[])].sort() : v;
  }
  return JSON.stringify(out);
}

interface Mutable {
  id: EntryId;
  kind: EntryBody['kind'];
  text: string;
  scope: EntryScope;
  source: EntryBody['source'];
  state: BrainEntry['state'];
  helpful: number;
  harmful: number;
  addedAt: Iso;
  lastConfirmedAt: Iso;
  missions: Set<string>;
  confirmedElsewhere: boolean;
  invalidAt: Iso | null;
  supersededBy: EntryId | null;
  retired: { at: Iso; reason: string } | null;
  promoted: { target: string; pr: string | null } | null;
  rejectedAtNet: number | null;
  voters: Set<string>;
  supporters: Set<string>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Within one millisecond an entry's `add` comes before anything about it.
const opRank = (e: LedgerEvent): number => (e.op === 'add' ? 0 : 1);

function orderOf(a: LedgerEvent, b: LedgerEvent): number {
  return cmp(a.at, b.at) || opRank(a) - opRank(b) || cmp(a.by, b.by) || cmp(a.id, b.id) || cmp(a.op, b.op) || cmp(JSON.stringify(a), JSON.stringify(b));
}

/**
 * The memory the events describe. Sorted by `(at, by, id)` first, so the
 * result never depends on file or line order. Never drops an entry: a
 * superseded or retired one stays, invalid from a point in time (Zep).
 */
export function foldLedger(events: readonly LedgerEvent[], problems: readonly LedgerProblem[] = [], now?: Iso): BrainMemory {
  const sorted = [...events].sort(orderOf);
  const entries = new Map<EntryId, Mutable>();
  const aliases: Record<string, string> = {};
  const byContent = new Map<string, EntryId>();
  const found: LedgerProblem[] = [...problems];
  const resolve = (id: EntryId): Mutable | undefined => entries.get(aliases[id] ?? id);
  const unknown = (e: LedgerEvent): void => {
    const where = LOCATIONS.get(e);
    found.push(where === undefined
      ? { file: '(ledger)', line: 0, problem: `An event from ${e.by} refers to an entry this brain doesn't have.` }
      : { file: where.file, line: where.line, problem: `${where.file} line ${where.line}: refers to an entry this brain doesn't have.` });
  };
  const net = (m: Mutable): number => m.helpful - m.harmful;
  const confirm = (m: Mutable, at: Iso, mission: string | undefined): void => {
    if (at > m.lastConfirmedAt) m.lastConfirmedAt = at;
    if (mission !== undefined && mission !== '') {
      m.missions.add(mission);
      if (mission !== m.source.mission) m.confirmedElsewhere = true;
    }
  };

  const seenEids = new Set<string>();
  for (const e of sorted) {
    // Outcomes (#53) are read by routing, not folded into lessons.
    if (e.op === 'outcome') continue;
    if (e.eid !== undefined) {
      if (seenEids.has(e.eid)) continue;
      seenEids.add(e.eid);
    }
    if (e.op === 'add') {
      if (entries.has(e.id) || aliases[e.id] !== undefined) continue;
      const key = `${normaliseText(e.entry.text)}\u0000${scopeKey(e.entry.scope)}`;
      const winner = byContent.get(key);
      const target = winner === undefined ? undefined : entries.get(winner);
      if (target !== undefined) {
        // The same lesson written twice is one lesson, seen again (ACE dedupe).
        aliases[e.id] = target.id;
        confirm(target, e.at, e.entry.source.mission);
        continue;
      }
      entries.set(e.id, {
        id: e.id, kind: e.entry.kind, text: e.entry.text, scope: e.entry.scope, source: e.entry.source, state: e.entry.state,
        helpful: 0, harmful: 0, addedAt: e.at, lastConfirmedAt: e.at,
        missions: new Set(e.entry.source.mission === '' ? [] : [e.entry.source.mission]), confirmedElsewhere: false,
        invalidAt: null, supersededBy: null, retired: null, promoted: null, rejectedAtNet: null, voters: new Set(), supporters: new Set(),
      });
      byContent.set(key, e.id);
      continue;
    }
    const m = resolve(e.id);
    if (m === undefined) {
      unknown(e);
      continue;
    }
    switch (e.op) {
      case 'vote': {
        // One vote per writer per run (or mission): a repeated click or a reflector run twice counts once.
        const key = `${e.by}|${e.run?.runId ?? e.mission ?? ''}`;
        if (m.voters.has(key)) break;
        m.voters.add(key);
        const weight = e.why === 'person' ? PERSON_VOTE_WEIGHT : 1;
        if (e.vote === 'helpful') { m.helpful += weight; m.supporters.add(key); } else m.harmful += weight;
        if (e.mission !== undefined && e.mission !== '') m.missions.add(e.mission);
        break;
      }
      case 'confirm':
        confirm(m, e.at, e.mission);
        break;
      case 'accept':
        if (m.state !== 'rejected') m.state = 'accepted';
        break;
      case 'reject':
        m.state = 'rejected';
        break;
      case 'unpromote':
        // Two daemons settling the same closed PR write this twice; only the first matters.
        if (m.promoted !== null && m.promoted.pr === e.pr) {
          m.promoted = null;
          m.rejectedAtNet = net(m);
        }
        break;
      case 'supersede':
        m.invalidAt = e.invalidAt;
        m.supersededBy = aliases[e.successor] ?? e.successor;
        break;
      case 'promote':
        m.promoted = { target: e.target, pr: e.pr };
        break;
      case 'retire':
        m.retired = { at: e.at, reason: e.reason };
        m.invalidAt = e.at;
        break;
    }
  }

  const nowMs = now === undefined ? null : Date.parse(now);
  const out: BrainEntry[] = [...entries.values()].map((m) => {
    const n = net(m);
    return {
      id: m.id, kind: m.kind, text: m.text, scope: m.scope, source: m.source, state: m.state,
      helpful: m.helpful, harmful: m.harmful, net: n, addedAt: m.addedAt, lastConfirmedAt: m.lastConfirmedAt,
      missions: [...m.missions].sort(), confirmedElsewhere: m.confirmedElsewhere, supporters: m.supporters.size,
      invalidAt: m.invalidAt, supersededBy: m.supersededBy, retired: m.retired, promoted: m.promoted,
      netSinceRejected: m.rejectedAtNet === null ? null : n - m.rejectedAtNet,
      flags: {
        harmful: m.harmful >= HARMFUL_MIN && n <= HARMFUL_NET_MAX,
        stale: nowMs !== null && nowMs - Date.parse(m.lastConfirmedAt) > STALE_AFTER_DAYS * 86_400_000,
      },
    };
  }).sort((a, b) => cmp(a.addedAt, b.addedAt) || cmp(a.id, b.id));
  const sortedProblems = [...found].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.problem, b.problem));
  return { entries: out, aliases, problems: sortedProblems };
}

/** Valid at `now`: neither superseded nor retired by then. */
export function isValidAt(e: BrainEntry, now: Iso): boolean {
  return e.invalidAt === null || e.invalidAt > now;
}

/**
 * Whether an entry may load into a prompt (spec §6, §7): a valid lesson or
 * convention, active or accepted (or a candidate a second mission confirmed),
 * and not flagged harmful.
 */
export function isLoadable(e: BrainEntry, now: Iso): boolean {
  if (!isValidAt(e, now)) return false;
  if (e.kind !== 'lesson' && e.kind !== 'convention') return false;
  if (e.flags.harmful) return false;
  if (e.state === 'active' || e.state === 'accepted') return true;
  return e.state === 'candidate' && e.confirmedElsewhere;
}
