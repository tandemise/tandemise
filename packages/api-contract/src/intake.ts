import { z } from 'zod';
import {
  DEFAULT_INTAKE_DAILY_CAP,
  DEFAULT_INTAKE_SIMILARITY,
  IMPACT_LEVELS,
  INTAKE_FILTER_WINDOWS,
  INTAKE_SOURCE_CADENCES,
  KIND_HINTS,
  SIGNAL_STATUSES,
  TRACKER_KINDS,
  fingerprintOf,
  type Impact,
  type IntakeSourceConfig,
  type SignalStatus,
  type TrackerConfig,
} from '@tandemise/domain';
import type { IntakeSignalInput } from '@tandemise/domain';

/**
 * The intake contract, `tandemise.intake/v1` (spec 2026-10-30-intake-design.md
 * §1), and the two configuration files intake reads (spec §4.1, §6.2).
 *
 * Its own module, like the other feature contracts. The JSON Schema for runner
 * authors in other languages, `docs/intake/signal.v1.schema.json`, is written
 * by hand (zod 3 has no export, and we add no dependency) and kept honest by
 * `scratch/intake-check.mjs`.
 *
 * Versioning: additive optional fields may be added inside v1. Unknown fields
 * are refused (every object is strict), so a runner learns at once that it is
 * ahead of the daemon. A breaking change is `tandemise.intake/v2`.
 */

export const INTAKE_SCHEMA_V1 = 'tandemise.intake/v1';
/** What `GET /v1/intake/schema` answers. */
export const ACCEPTED_INTAKE_SCHEMAS: readonly string[] = [INTAKE_SCHEMA_V1];

export const INTAKE_SOURCE_KIND_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const INTAKE_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const INTAKE_MAX_TEXT = 200;
export const INTAKE_MAX_DESCRIPTION = 20_000;
export const INTAKE_MAX_URL = 2000;
export const INTAKE_MAX_ATTACHMENTS = 10;
/** Inline content, decoded: anything bigger is a `url` (spec §1 "Attachments"). */
export const INTAKE_MAX_INLINE_BYTES = 1_000_000;
export const INTAKE_MAX_INLINE_BYTES_PER_SIGNAL = 5_000_000;
export const INTAKE_MAX_BATCH = 50;

const HTTPS_ONLY = 'Only https links are accepted.';

function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Every link in a signal is https: the daemon never fetches it, but people click it. */
const httpsUrl = z.string().max(INTAKE_MAX_URL).refine(isHttpsUrl, { message: HTTPS_ONLY });

const isoTime = z.string().datetime({ offset: true });

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded size of standard base64 text, or null when it is not base64. */
export function base64DecodedBytes(value: string): number | null {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const intakeSourceRef = z
  .object({
    kind: z.string().regex(INTAKE_SOURCE_KIND_PATTERN, {
      message: 'Use a lowercase slug: a letter, then 1 to 31 letters, digits or dashes.',
    }),
    instance: z.string().min(1).max(INTAKE_MAX_TEXT),
  })
  .strict();

const intakeReporter = z
  .object({
    name: z.string().min(1).max(INTAKE_MAX_TEXT).optional(),
    handle: z.string().min(1).max(INTAKE_MAX_TEXT).optional(),
    url: httpsUrl.optional(),
  })
  .strict();

const intakeAttachment = z
  .object({
    name: z.string().min(1).max(INTAKE_MAX_TEXT),
    mediaType: z.string().min(1).max(INTAKE_MAX_TEXT),
    url: httpsUrl.optional(),
    contentBase64: z.string().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if ((a.url === undefined) === (a.contentBase64 === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give an attachment either a url or contentBase64, not both.' });
      return;
    }
    if (a.contentBase64 !== undefined) {
      const bytes = base64DecodedBytes(a.contentBase64);
      if (bytes === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentBase64'], message: 'Inline content must be standard base64.' });
      } else if (bytes > INTAKE_MAX_INLINE_BYTES) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contentBase64'], message: 'Inline content is at most 1 MB; link anything bigger with a url.' });
      }
    }
  });

const intakeAttachments = z
  .array(intakeAttachment)
  .max(INTAKE_MAX_ATTACHMENTS)
  .superRefine((list, ctx) => {
    let total = 0;
    for (const a of list) total += a.contentBase64 === undefined ? 0 : (base64DecodedBytes(a.contentBase64) ?? 0);
    if (total > INTAKE_MAX_INLINE_BYTES_PER_SIGNAL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inline content is at most 5 MB per signal; link the rest with a url.' });
    }
  });

const intakeImpact = z
  .object({
    level: z.enum(IMPACT_LEVELS).optional(),
    events: z.number().int().nonnegative().optional(),
    users: z.number().int().nonnegative().optional(),
    firstSeen: isoTime.optional(),
    lastSeen: isoTime.optional(),
    release: z.string().min(1).max(INTAKE_MAX_TEXT).optional(),
  })
  .strict();

/** Opaque to Tandemise: what the runner needs to close the loop (spec §8). */
const intakeReply = z.object({ address: z.string().min(1).max(INTAKE_MAX_URL) }).strict();

/**
 * One signal (spec §1). Everything except `schema`, `source`, `key`, `url` and
 * `title` is optional. There is no field that names a project, a tracker, a
 * state or a threshold: the project comes from the source's configuration and,
 * for HTTP pushes, from the token.
 */
export const intakeSignalV1 = z
  .object({
    schema: z.literal(INTAKE_SCHEMA_V1),
    source: intakeSourceRef,
    key: z.string().min(1).max(INTAKE_MAX_TEXT),
    url: httpsUrl,
    title: z.string().min(1).max(INTAKE_MAX_TEXT),
    description: z.string().max(INTAKE_MAX_DESCRIPTION).optional(),
    reporter: intakeReporter.optional(),
    occurredAt: isoTime.optional(),
    attachments: intakeAttachments.optional(),
    impact: intakeImpact.optional(),
    labels: z.array(z.string().min(1).max(100)).max(20).optional(),
    reply: intakeReply.optional(),
    kindHint: z.enum(KIND_HINTS).optional(),
  })
  .strict();
export type IntakeSignalV1 = z.infer<typeof intakeSignalV1>;

// A signal's impact is the domain's Impact, field for field.
const _impactIsDomain: Impact | undefined = undefined as IntakeSignalV1['impact'];
void _impactIsDomain;

/**
 * Anything that claims to be one signal. The push body only tells one signal
 * from a batch; each signal is then checked on its own with
 * `validateIntakeSignal`, so one bad signal is recorded as rejected instead of
 * sinking the push (plan Task 1, Task 3).
 */
export const intakeSignalV1Raw = z.object({ schema: z.string().max(INTAKE_MAX_TEXT) }).passthrough();

/** `POST /v1/intake/signals`: one signal, or `{ signals: [...] }` of at most 50. */
export const intakePushBody = z.union([
  intakeSignalV1Raw,
  z.object({ signals: z.array(z.unknown()).min(1).max(INTAKE_MAX_BATCH) }).strict(),
]);
export type IntakePushBody = z.infer<typeof intakePushBody>;

/** The signals in a parsed push body, still unchecked. */
export function pushedSignals(body: IntakePushBody): readonly unknown[] {
  return 'schema' in body ? [body] : (body as { signals: unknown[] }).signals;
}

/** One line per issue, `path: message`, in the router's `formatZodIssues` style. */
export function intakeIssueLines(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/** The issues in one readable line, as the router's `formatZodIssues` writes them. */
export function formatIntakeIssues(error: z.ZodError): string {
  return intakeIssueLines(error).join('; ');
}

export type IntakeSignalCheck =
  | { readonly ok: true; readonly signal: IntakeSignalV1 }
  | {
      readonly ok: false;
      /** The issues joined; what a rejected signal's reason says. */
      readonly reason: string;
      readonly issues: readonly string[];
      /** `fingerprintOf` when `source` and `key` could be read, else null. */
      readonly fingerprint: string | null;
      /** The title when it could be read, else null. */
      readonly title: string | null;
    };

const readableIdentity = z.object({ source: intakeSourceRef, key: intakeSignalV1.shape.key }).passthrough();

/**
 * Checks one pushed signal. Never throws. On failure it keeps what it could
 * read, so the pipeline can record the rejection under the right fingerprint
 * and title.
 */
export function validateIntakeSignal(input: unknown): IntakeSignalCheck {
  const parsed = intakeSignalV1.safeParse(input);
  if (parsed.success) return { ok: true, signal: parsed.data };
  const identity = readableIdentity.safeParse(input);
  const fingerprint = identity.success ? fingerprintOf(identity.data) : null;
  const titleRead = intakeSignalV1.shape.title.safeParse(isRecord(input) ? input['title'] : undefined);
  const title = titleRead.success ? titleRead.data : null;
  const schema = isRecord(input) ? input['schema'] : undefined;
  if (typeof schema === 'string' && !ACCEPTED_INTAKE_SCHEMAS.includes(schema)) {
    const reason = `This daemon accepts ${ACCEPTED_INTAKE_SCHEMAS.join(', ')}, not '${schema.slice(0, INTAKE_MAX_TEXT)}'.`;
    return { ok: false, reason, issues: [reason], fingerprint, title };
  }
  const issues = intakeIssueLines(parsed.error);
  return { ok: false, reason: issues.join('; '), issues, fingerprint, title };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ------------------------------------------------------------------ configuration files

function isApiBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol === 'https:') return u.hostname !== '';
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** Self-hosted instances and fakes: https, or plain http only on this machine. */
const apiBaseUrl = z.string().max(INTAKE_MAX_URL).refine(isApiBaseUrl, {
  message: 'Use an https address, or http on 127.0.0.1 or localhost only.',
});

const stateName = z.string().min(1).max(INTAKE_MAX_TEXT);

const trackerStates = z
  .object({
    ready: z.array(stateName).min(1),
    in_progress: stateName,
    in_review: stateName.optional(),
    done: z.array(stateName).min(1),
    wont_do: z.array(stateName),
  })
  .strict();

const trackerConfigFile = z
  .object({
    kind: z.enum(TRACKER_KINDS),
    url: apiBaseUrl.optional(),
    project: z.string().min(1).max(INTAKE_MAX_TEXT).optional(),
    repo: z.string().min(1).max(INTAKE_MAX_TEXT).optional(),
    board: z.string().min(1).max(INTAKE_MAX_URL),
    states: trackerStates,
    onComplete: z.enum(['in_review', 'done']),
    workflows: z.record(z.string().max(INTAKE_MAX_TEXT)).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    // Spec §6.2: `in_review` may be absent; then `onComplete` must be `done`.
    if (t.onComplete === 'in_review' && t.states.in_review === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['onComplete'], message: "Map an in_review state, or set onComplete to done." });
    }
    if (t.kind === 'youtrack') {
      if (t.url === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'Give the YouTrack address.' });
      if (t.project === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['project'], message: 'Give the YouTrack project.' });
    }
    if (t.kind === 'github-issues' && t.repo === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repo'], message: 'Give the GitHub repository as owner/name.' });
    }
  });

/** `factory/tracker.yaml` in the brain, and the local settings' `tracker` alike (spec §6.2). */
export const trackerFileV1 = z.object({ tracker: trackerConfigFile }).strict();
export type TrackerFile = z.infer<typeof trackerFileV1>;

const noiseRules = z
  .object({
    minLevel: z.enum(IMPACT_LEVELS).optional(),
    minEvents: z.number().int().nonnegative().optional(),
    minUsers: z.number().int().nonnegative().optional(),
    window: z.enum(INTAKE_FILTER_WINDOWS).optional(),
    ignoreTitles: z.array(z.string().min(1).max(INTAKE_MAX_TEXT)).max(50).optional(),
  })
  .strict();

export const intakeSourceFile = z
  .object({
    id: z.string().regex(INTAKE_SOURCE_ID_PATTERN, {
      message: 'Use a lowercase id: letters, digits and dashes, at most 63.',
    }),
    kind: intakeSourceRef.shape.kind,
    instance: intakeSourceRef.shape.instance,
    every: z.enum(INTAKE_SOURCE_CADENCES).optional(),
    filter: noiseRules.optional(),
    trigger: z
      .object({
        emoji: z.string().min(1).max(100).optional(),
        mention: z.boolean().optional(),
        label: z.string().min(1).max(100).optional(),
        // Ruling 26: Slack and Discord acknowledge with reactions unless this is false.
        react: z.boolean().optional(),
      })
      .strict()
      .optional(),
    create: z
      .object({
        type: z.string().min(1).max(INTAKE_MAX_TEXT).optional(),
        fields: z.record(z.string().max(INTAKE_MAX_TEXT)).optional(),
      })
      .strict()
      .optional(),
    closeOnDone: z.boolean().default(false),
    closeWontDo: z.boolean().default(false),
    api: apiBaseUrl.optional(),
  })
  .strict();
export type IntakeSourceFile = z.infer<typeof intakeSourceFile>;

/** `factory/intake.yaml` in the brain, and the local settings' `intake` alike (spec §4.1). */
export const intakeFileV1 = z
  .object({
    sources: z.array(intakeSourceFile).default([]),
    dailyCap: z.number().int().nonnegative().default(DEFAULT_INTAKE_DAILY_CAP),
    similarity: z
      .object({
        link: z.number().min(0).max(1).default(DEFAULT_INTAKE_SIMILARITY.link),
        ask: z.number().min(0).max(1).default(DEFAULT_INTAKE_SIMILARITY.ask),
      })
      .strict()
      .refine((s) => s.ask <= s.link, { message: 'The ask score must not be above the link score.' })
      .default({ ...DEFAULT_INTAKE_SIMILARITY }),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.sources.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', i, 'id'], message: `Two sources are called '${s.id}'.` });
      seen.add(s.id);
    });
  });
export type IntakeFile = z.infer<typeof intakeFileV1>;

// The parsed files are the domain's config shapes, so a service reads either.
const _trackerIsDomain: TrackerConfig = undefined as unknown as TrackerFile['tracker'];
const _sourceIsDomain: IntakeSourceConfig = undefined as unknown as IntakeSourceFile;
void _trackerIsDomain;
void _sourceIsDomain;
// A parsed signal is what the store records (plan Task 2).
const _signalIsDomain: IntakeSignalInput = undefined as unknown as IntakeSignalV1;
void _signalIsDomain;

// ------------------------------------------------------------------ views

/** One signal's answer to a push (plan Task 3). */
export interface IngestResultView {
  /** Null when the signal was too broken to read its source and key. */
  readonly fingerprint: string | null;
  readonly signalId: string | null;
  readonly status: SignalStatus;
  /** Plain words: why it was rejected, held back or needs a decision. */
  readonly reason: string | null;
}

/** One recorded signal, for the Intake tab (plan Task 3, Task 14). */
export interface IntakeSignalView {
  readonly id: string;
  readonly sourceId: string;
  readonly fingerprint: string;
  /** `Sentry`, `Slack`, or a custom slug as itself. */
  readonly sourceLabel: string;
  readonly instance: string;
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly status: SignalStatus;
  readonly reason: string | null;
  readonly occurrences: number;
  readonly impact: Impact | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** `<tracker>:<key>` once linked or created, else null. */
  readonly itemRef: string | null;
}

/** One configured source and how it is doing, for Settings → Intake (plan Task 10, Task 14). */
export interface IntakeSourceView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly instance: string;
  readonly enabled: boolean;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
}

/** One tracker item on the board (plan Task 8). */
export interface BoardItemView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly assignee: string | null;
  readonly sources: readonly { readonly label: string; readonly detail: string }[];
  readonly mission: { readonly id: string; readonly status: string; readonly title: string } | null;
  readonly startable: { readonly ok: true } | { readonly ok: false; readonly reason: string };
}

/** The project's board, from the tracker cache (plan Task 8). */
export interface BoardView {
  readonly trackerLabel: string;
  readonly groups: {
    readonly ready: readonly BoardItemView[];
    readonly inProgress: readonly BoardItemView[];
    readonly inReview: readonly BoardItemView[];
  };
  readonly refreshedAt: string | null;
  readonly problem: string | null;
}

/** An Inbox card: is this signal the same as an existing task? (plan Task 7). */
export interface InboxIntakeDecisionView {
  readonly signalId: string;
  readonly title: string;
  readonly sourceLabel: string;
  /** The reason sentence, asked as a question. */
  readonly question: string;
  readonly candidate: { readonly key: string; readonly title: string; readonly url: string } | null;
  readonly reason: string | null;
  readonly receivedAt: string;
}

// ------------------------------------------------------------------ requests (plan Task 3)

/** `GET /v1/workspaces/:id/intake/signals?status=a,b&limit=n`. */
export const intakeSignalsQuery = z
  .object({
    status: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v.trim() === '') return undefined;
        const list = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
        for (const s of list) {
          if (!(SIGNAL_STATUSES as readonly string[]).includes(s)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `'${s.slice(0, 40)}' is not a signal status.` });
            return z.NEVER;
          }
        }
        return list as SignalStatus[];
      }),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export type IntakeSignalsQuery = z.infer<typeof intakeSignalsQuery>;

/**
 * `PUT /v1/workspaces/:id/intake/config` (local origin only). A part left out
 * is kept; `tracker: null` clears the tracker.
 */
export const updateIntakeConfigRequest = z
  .object({
    tracker: trackerConfigFile.nullable().optional(),
    intake: intakeFileV1.optional(),
  })
  .strict();
export type UpdateIntakeConfigRequest = z.infer<typeof updateIntakeConfigRequest>;

/** `POST /v1/workspaces/:id/intake/tokens`. */
export const mintIntakeTokenRequest = z
  .object({ sourceId: intakeSourceFile.shape.id })
  .strict();
export type MintIntakeTokenRequest = z.infer<typeof mintIntakeTokenRequest>;

/** A secret's value, kept only in the local secret store (spec §2); empty removes it. */
const secretValue = z.string().max(8192);

/**
 * `PUT /v1/workspaces/:id/intake/sources/:sourceId/secret` (plan Task 11): one
 * of the source's named secrets (`token`, `clientSecret`, `apiKey`,
 * `webhookSecret`, …), replacing the one saved before under that name. An
 * empty value removes it.
 */
export const saveIntakeSourceSecretRequest = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, { message: 'Name a secret with a letter, then letters, digits or _.' }),
    value: secretValue,
  })
  .strict();
export type SaveIntakeSourceSecretRequest = z.infer<typeof saveIntakeSourceSecretRequest>;

/** `PUT /v1/workspaces/:id/intake/tracker/secret` (plan Task 11, RULINGS ruling 17): the tracker's token. */
export const saveTrackerSecretRequest = z
  .object({ value: secretValue.min(1, { message: 'Paste the token to save.' }) })
  .strict();
export type SaveTrackerSecretRequest = z.infer<typeof saveTrackerSecretRequest>;

/**
 * `POST /v1/intake/signals/:id/decide`, the Inbox card's three answers (spec
 * §5 step 4): the same task as the candidate, a new task, or not work.
 */
export const INTAKE_DECISIONS = ['same', 'new', 'not_work'] as const;
export type IntakeDecision = (typeof INTAKE_DECISIONS)[number];
export const decideIntakeSignalRequest = z
  .object({ decision: z.enum(INTAKE_DECISIONS) })
  .strict();
export type DecideIntakeSignalRequest = z.infer<typeof decideIntakeSignalRequest>;

/**
 * `POST /v1/workspaces/:id/board/start` (plan Task 8): the item's key in the
 * body, since a GitHub ref holds `/` and `#`.
 */
export const startBoardItemRequest = z
  .object({
    key: z.string().trim().min(1, 'Name the item to start.').max(200),
    /** Quick or Careful, chosen on the Board before Start (#103); absent, the factory decides. */
    lane: z.enum(['quick', 'careful']).optional(),
  })
  .strict();
export type StartBoardItemRequest = z.infer<typeof startBoardItemRequest>;

/** The answer to minting: the token is shown this once, and only its sha256 is kept (spec §2). */
export interface IntakeTokenMintedView {
  readonly id: string;
  readonly token: string;
}

/** A project's intake configuration, and whether it can be edited here. */
export interface IntakeConfigView {
  /** `local` is edited in Settings; `brain` in the brain's repository (#51). */
  readonly origin: 'local' | 'brain';
  readonly editable: boolean;
  readonly tracker: TrackerConfig | null;
  readonly sources: readonly IntakeSourceConfig[];
  readonly dailyCap: number;
  readonly similarity: { readonly link: number; readonly ask: number };
  /**
   * Per source id, whether it runs on this machine (Ruling 22): local
   * configuration is on by default, a source from the brain off until
   * switched on here. Not part of the configuration, so it is never saved back.
   */
  readonly enabled: Readonly<Record<string, boolean>>;
  /**
   * Saved credentials whose configured address is no longer the one they were
   * saved for (Ruling 23): `current` is where the configuration points now,
   * `saved` where the token was saved for (scheme, host, port). Tandemise sends
   * neither the tracker token nor a source's secrets to `current` until the
   * person confirms it (`POST …/intake/tracker/confirm-origin`,
   * `POST …/intake/sources/:sourceId/confirm-origin`).
   */
  readonly originMismatch: {
    readonly tracker: IntakeOriginMismatchView | null;
    /** By source id; a source whose address did not move is absent. */
    readonly sources: Readonly<Record<string, IntakeOriginMismatchView>>;
  };
}

/** Where a credential's configuration points now, and where it was saved for (Ruling 23). */
export interface IntakeOriginMismatchView {
  readonly current: string;
  readonly saved: string;
  /** The daemon's refusal, in its own words, as the UI shows it. */
  readonly message: string;
}

/**
 * `PUT /v1/workspaces/:id/intake/sources/:sourceId/enabled` (Ruling 22):
 * runs the source on this machine, or stops it here. Answers the config view.
 */
export const setIntakeSourceEnabledRequest = z
  .object({ enabled: z.boolean() })
  .strict();
export type SetIntakeSourceEnabledRequest = z.infer<typeof setIntakeSourceEnabledRequest>;

/** `POST /v1/intake/signals`'s answer (spec §2). */
export interface IntakePushView {
  readonly results: readonly IngestResultView[];
}

/**
 * One closure on a source's feed (spec §2 "Closures for custom sources are
 * pulled", plan Task 13): what the loop closes, at which item, with which pull
 * request. Additive to the plan's fields: `state` (the CLI prints it),
 * `lastError`, and the signal's own `reply`, which a custom runner set when it
 * pushed and needs back to reply where the work came from.
 */
export interface IntakeClosureView {
  readonly id: string;
  readonly fingerprint: string;
  readonly key: string;
  readonly url: string;
  /** `done`, or `not_planned` for a won't-do item on a source with `closeWontDo`. */
  readonly kind: 'done' | 'not_planned';
  readonly state: 'pending' | 'closed' | 'failed';
  readonly item: { readonly key: string; readonly url: string };
  readonly prUrl: string | null;
  readonly reply: { readonly address: string } | null;
  readonly lastError: string | null;
}

/** `GET /v1/intake/closures?sourceId=&after=`: a source's closures in id order. */
export interface IntakeClosuresView {
  readonly closures: readonly IntakeClosureView[];
}

/** `POST /v1/intake/closures/:id/ack`: the custom runner closed the loop, or says why it could not. */
export const ackIntakeClosureRequest = z
  .object({
    ok: z.boolean(),
    error: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type AckIntakeClosureRequest = z.infer<typeof ackIntakeClosureRequest>;
