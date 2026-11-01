import { z } from 'zod';
import { createEndpointRequest } from './relay.js';
import {
  ACCESS_LEVELS, ARTIFACT_TYPES, CHECK_NAMES, MAX_CHECK_BUDGET_MINUTES, skillNameProblem, AUTONOMY_LEVELS, CONTRIBUTION_MAX_BYTES, decodedSize, LIMIT_METRICS, MAX_LADDER, MAX_MODEL_NAME, MISSION_PRIORITIES, MISSION_STATUSES, OVERSIGHT_MODES, ROUTINE_HOURS, ROUTINE_KINDS, RUNTIME_CAPABILITIES,
  staffingPatchSchema,
} from '@tandemise/domain';

/**
 * Who a person is recording a decision or result for. The stored actor is this
 * member and the principal becomes `recordedBy`, so a lead can enter what a
 * teammate said without the record claiming the lead said it.
 */
const onBehalfOf = z.string().min(1).optional();

/**
 * A file or link handed in from outside a mission (spec A1): an upload at
 * creation, a feedback attachment, or a hand-back's contribution. The base64
 * length cap is `ceil(bytes/3)*4`, so a payload that decodes over
 * `CONTRIBUTION_MAX_BYTES` is refused by its encoded length alone, before
 * anything decodes it. Exported so the router can size its own body cap off
 * this exact number rather than restating it.
 */
export const CONTRIBUTION_BASE64_MAX = Math.ceil(CONTRIBUTION_MAX_BYTES / 3) * 4;
const contributionFile = z.object({
  kind: z.literal('file'),
  filename: z.string().trim().min(1).max(200),
  mediaType: z.string().trim().min(1).max(200),
  dataBase64: z.string().max(CONTRIBUTION_BASE64_MAX, 'That file is larger than 24 MB.'),
});
export const outsideContributionSchema = z.discriminatedUnion('kind', [
  contributionFile,
  z.object({
    kind: z.literal('link'),
    url: z.string().trim().url('link url must be a full URL'),
    label: z.string().trim().min(1).max(200).optional(),
    /** What a link carries when no resolver on this machine can read the link itself. */
    export: contributionFile.omit({ kind: true }).optional(),
  }),
]);
export type OutsideContributionInput = z.infer<typeof outsideContributionSchema>;

/** The decoded bytes a contribution adds to an upload/attachment total: a file's own bytes, a link's export, or none for a bare link. */
function contributionBytes(c: OutsideContributionInput): number {
  if (c.kind === 'file') return decodedSize(c.dataBase64);
  return c.export === undefined ? 0 : decodedSize(c.export.dataBase64);
}

/** Shown when several files, each under the per-file cap, add up past it together (spec A1). */
export const CONTRIBUTION_TOTAL_MESSAGE = 'These files add up to more than 24 MB. Add the rest later as feedback.';

/**
 * An array of contributions (mission uploads, feedback attachments) capped
 * both per file - `contributionFile.dataBase64`'s own `.max`, already applied
 * per item - and in total (spec A1): ten files just under 24 MB each would
 * otherwise add up to an Evidence set nothing else bounds. Skipped when a
 * single contribution already exceeds the per-file cap, so that request's
 * error stays the one-file message rather than gaining a second, redundant one.
 */
function contributionArray(maxItems: number) {
  return z.array(outsideContributionSchema).max(maxItems).superRefine((items, ctx) => {
    const sizes = items.map(contributionBytes);
    if (sizes.some((n) => n > CONTRIBUTION_MAX_BYTES)) return;
    if (sizes.reduce((a, b) => a + b, 0) > CONTRIBUTION_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: CONTRIBUTION_TOTAL_MESSAGE });
    }
  });
}

/**
 * Request schemas.
 *
 * The daemon validates every request body against these before it reaches a
 * service. Parsing at the edge means the application layer can trust its
 * inputs, and it means a bad request produces one precise error rather than a
 * type error three frames deep.
 */

/**
 * A ceiling on agent minutes, tokens or reported US dollars (P8). The warning
 * level defaults to 80%; at 100% work stops and the person is asked.
 */
export const limitSchema = z.object({
  metric: z.enum(LIMIT_METRICS),
  amount: z.number().positive('A limit must be above zero.').max(1e12),
  /** Defaults to 80 (DEFAULT_WARN_PERCENT). */
  warnPercent: z.number().int().min(1).max(99).optional(),
});
/** At most one limit per metric. */
export const limitsSchema = z.array(limitSchema).max(LIMIT_METRICS.length)
  .refine((list) => new Set(list.map((l) => l.metric)).size === list.length, 'Give at most one limit per metric.');
export type LimitInput = z.infer<typeof limitSchema>;

export const createWorkspaceRequest = z.object({
  name: z.string().min(1).max(120),
  repositoryPath: z.string().min(1).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequest>;

export const updateWorkspaceRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  defaultRepositoryId: z.string().nullable().optional(),
  autonomy: z.object({
    planApproval: z.enum(['ask', 'auto']),
    localCodeChanges: z.enum(['auto', 'ask']),
    externalWrites: z.enum(['auto', 'policy', 'ask', 'deny']),
    productionRelease: z.enum(['ask', 'deny']),
    financialActions: z.literal('deny'),
  }).optional(),
  concurrency: z.object({
    maxTotalWorkers: z.number().int().min(1).max(16),
    perRuntime: z.record(z.string(), z.number().int().min(0).max(16)),
  }).optional(),
  routing: z.record(z.string(), z.array(z.string())).optional(),
  /** Missions in progress at once before queued ones wait; null turns the limit (and the pull) off. */
  maxActiveMissions: z.number().int().min(1).max(50).nullable().optional(),
  /** Limits each mission gets unless it sets its own; [] for none. */
  defaultMissionLimits: limitsSchema.optional(),
  /** Limits on the whole project per local calendar month; [] for none. */
  monthlyLimits: limitsSchema.optional(),
  knowledge: z.object({
    productVision: z.string().nullable(),
    architecturePrinciples: z.string().nullable(),
    codingStandards: z.string().nullable(),
    designSystem: z.string().nullable(),
    glossary: z.string().nullable(),
  }).partial().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequest>;

export const addRepositoryRequest = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  checks: z.object({
    install: z.string().nullable(), typecheck: z.string().nullable(),
    lint: z.string().nullable(), test: z.string().nullable(),
    build: z.string().nullable(), devServer: z.string().nullable(),
    devServerUrl: z.string().nullable(),
    /** Minutes per check (#111); replaces the repository's budgets as a whole. */
    budgets: z.record(z.enum(CHECK_NAMES), z.number().positive().max(MAX_CHECK_BUDGET_MINUTES)),
  }).partial().optional(),
});
export type AddRepositoryRequest = z.infer<typeof addRepositoryRequest>;

export const probeRepositoryRequest = z.object({ path: z.string().min(1) });

/** Per role; `null` removes that role's staffing, any other role is left alone. */
export const roleStaffingPatchRequest = z.record(z.string().min(1), staffingPatchSchema.nullable());
export type RoleStaffingPatchRequest = z.infer<typeof roleStaffingPatchRequest>;

export const createMissionRequest = z.object({
  workspaceId: z.string().min(1),
  repositoryId: z.string().min(1).nullable().optional(),
  /** The single natural-language sentence the whole product is built around. */
  goal: z.string().min(3).max(8000),
  title: z.string().min(1).max(200).optional(),
  constraints: z.array(z.string()).max(50).optional(),
  successCriteria: z.array(z.string()).max(50).optional(),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  /** Workflow id: one of the project's own files, a built-in preset, or `auto` for the factory (#53). */
  workflowPreset: z.string().optional(),
  /** For `auto`: you choose the lane instead of the factory (#53 §10). */
  lane: z.enum(['quick', 'careful']).optional(),
  /** Values for the workflow's declared inputs, e.g. `{ issue: '42' }`. */
  workflowInputs: z.record(z.string(), z.string()).optional(),
  baseBranch: z.string().nullable().optional(),
  /** Plan immediately after creation. The common path from the UI. */
  planNow: z.boolean().optional(),
  onBehalfOf,
  /**
   * The mission's staffing per role, the same shape its staffing PATCH takes.
   * Stored with the mission, before planning starts, so no task can become
   * READY - and snapshot its staffing - ahead of it.
   */
  staffing: roleStaffingPatchRequest.optional(),
  /** Orders the backlog and the worker slots; defaults to normal. */
  priority: z.enum(MISSION_PRIORITIES).optional(),
  /** "Add to backlog": created as a queued draft, planned when there is room and it is ready. */
  queued: z.boolean().optional(),
  /** The mission's own limits; absent uses the project's default mission limits. */
  limits: limitsSchema.optional(),
  /** Files or links handed in at creation (spec A2), pinned as Evidence before planning starts. */
  uploads: contributionArray(10).optional(),
});
export type CreateMissionRequest = z.infer<typeof createMissionRequest>;

/**
 * A mission's place in the backlog. `move` swaps it with its neighbour and is
 * the window's way in; `rank` is for scripts. Queue, rank and move are DRAFT
 * only; priority orders dispatch too, so it stays editable until the mission finishes.
 */
export const updateMissionRequest = z.object({
  priority: z.enum(MISSION_PRIORITIES).optional(),
  rank: z.number().finite().optional(),
  queued: z.boolean().optional(),
  move: z.enum(['up', 'down']).optional(),
  /** The mission's own limits (P8); null goes back to the project's defaults. */
  limits: limitsSchema.nullable().optional(),
}).refine((r) => Object.keys(r).length > 0, 'Say what to change: priority, rank, queued, move or limits.');
export type UpdateMissionRequest = z.infer<typeof updateMissionRequest>;

/** A verdict on a proposed criterion; `statement` accepts it in the person's own words. */
export const criterionVerdictRequest = z.object({
  verdict: z.enum(['accept', 'reject']),
  statement: z.string().trim().min(1, 'A criterion needs a statement.').max(2000).optional(),
});
export type CriterionVerdictRequest = z.infer<typeof criterionVerdictRequest>;

export const answerQuestionRequest = z.object({
  text: z.string().trim().min(1, 'An answer needs some text.').max(2000),
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequest>;

export const addCriterionRequest = z.object({
  statement: z.string().trim().min(1, 'A criterion needs a statement.').max(2000),
});
export type AddCriterionRequest = z.infer<typeof addCriterionRequest>;

export const listMissionsQuery = z.object({
  workspaceId: z.string().optional(),
  status: z.enum(MISSION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const decideApprovalRequest = z.object({
  optionId: z.string().min(1),
  note: z.string().max(4000).optional(),
  /** For plan approvals: an edited plan to use instead of the proposed one. */
  editedPlan: z.unknown().optional(),
  /** For a limit card's "Raise limit and resume": the new limit, in the limit's own unit. */
  raiseTo: z.number().positive().max(1e12).optional(),
  onBehalfOf,
});
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequest>;

export const createRuntimeProfileRequest = z.object({
  adapterId: z.string().min(1),
  name: z.string().min(1).max(120),
  workspaceId: z.string().nullable().optional(),
  executablePath: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  enabled: z.boolean().optional(),
  /**
   * Capabilities this profile has on top of what the adapter reports.
   *
   * An adapter's `discover()` is a guess about a tool it did not write, and the
   * user frequently knows better - that this Claude Code install has
   * `computer_use`, or that a generic CLI can drive a browser. Without this the
   * capability router has no way to be corrected: a role requiring `browser`
   * would be permanently unroutable even though the runtime can do it.
   *
   * They are added to the adapter's own capabilities (F5 ruling), never used to
   * take one away. A list equal to the adapter's defaults, in any order, means
   * "no override", so a profile saved with the defaults still follows what its
   * settings declare. Omitted also means "trust the adapter".
   */
  capabilities: z.array(z.enum(RUNTIME_CAPABILITIES)).optional(),
});
export type CreateRuntimeProfileRequest = z.infer<typeof createRuntimeProfileRequest>;

export const updateRuntimeProfileRequest = createRuntimeProfileRequest.partial().omit({ adapterId: true });

/**
 * A person reporting that they have done a `human` task.
 *
 * `result` is whatever they bring back - a Figma URL, the id of the account
 * they created, a paragraph describing what they changed in a console. It is
 * stored as the artifact the step declared it would produce, so the tasks
 * downstream read it exactly as they would read an agent's output; nothing in
 * the rest of the pipeline needs to know a person wrote it.
 */
export const completeTaskRequest = z.object({
  result: z.string().trim().min(1).max(20_000),
  note: z.string().trim().max(2_000).optional(),
  onBehalfOf,
});
export type CompleteTaskRequest = z.infer<typeof completeTaskRequest>;

/** Taking an unassigned pool task, for yourself or for the member named. */
export const claimTaskRequest = z.object({ onBehalfOf });
export type ClaimTaskRequest = z.infer<typeof claimTaskRequest>;

// ------------------------------------------------------------ people and team

export const createPersonRequest = z.object({
  displayName: z.string().trim().min(1).max(120),
  handles: z.record(z.string(), z.string()).optional(),
});
export type CreatePersonRequest = z.infer<typeof createPersonRequest>;

export const updatePersonRequest = createPersonRequest.partial();
export type UpdatePersonRequest = z.infer<typeof updatePersonRequest>;

const memberTitle = z.string().max(120).nullable().optional();

export const addMemberRequest = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    personId: z.string().min(1),
    reportsTo: z.string().min(1).nullable().optional(),
    access: z.enum(ACCESS_LEVELS).optional(),
    oversight: z.enum(OVERSIGHT_MODES).optional(),
    title: memberTitle,
    roleIds: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    name: z.string().trim().min(1).max(120),
    // An agent acts on its owner's authority, so it cannot be added without one.
    reportsTo: z.string().min(1),
    roleIds: z.array(z.string().min(1)).min(1),
    runtimeProfileIds: z.array(z.string().min(1)).optional(),
    integrationIds: z.array(z.string().min(1)).optional(),
    title: memberTitle,
  }),
]);
export type AddMemberRequest = z.infer<typeof addMemberRequest>;

/** Removal has its own endpoint; `status` here only brings a removed member back. */
export const updateMemberRequest = z.object({
  name: z.string().trim().min(1).max(120),
  reportsTo: z.string().min(1).nullable(),
  access: z.enum(ACCESS_LEVELS),
  oversight: z.enum(OVERSIGHT_MODES),
  title: z.string().max(120).nullable(),
  roleIds: z.array(z.string().min(1)),
  runtimeProfileIds: z.array(z.string().min(1)),
  integrationIds: z.array(z.string().min(1)),
  status: z.literal('active'),
}).partial();
export type UpdateMemberRequest = z.infer<typeof updateMemberRequest>;

/** `null` clears the task's own override. */
export const taskStaffingPatchRequest = staffingPatchSchema.nullable();
export type TaskStaffingPatchRequest = z.infer<typeof taskStaffingPatchRequest>;

export const createIntegrationRequest = z.object({
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  name: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()).optional(),
  enabledCapabilities: z.array(z.string()).optional(),
  /** Raw secret; the daemon stores it in the OS credential store and keeps a ref. */
  secret: z.string().optional(),
});
export type CreateIntegrationRequest = z.infer<typeof createIntegrationRequest>;

export const updateIntegrationRequest = createIntegrationRequest.partial().omit({ workspaceId: true, providerId: true })
  // Switching an integration off withdraws its tools from every worker. The
  // desktop has always sent this; the schema used to strip it, so the switch
  // flipped back on the next refresh and nothing was ever withdrawn.
  .extend({ enabled: z.boolean().optional() });

/**
 * Connect an account through its consent screen.
 *
 * Name a curated connector (`figma`), or give a provider and configuration for
 * a server that is not in the catalog. Name an existing integration to
 * reconnect it - an account whose refresh token was revoked keeps its row, its
 * name and every mission reference to it.
 */
export const connectIntegrationRequest = z.object({
  workspaceId: z.string().min(1),
  connectorId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  name: z.string().min(1).max(120).optional(),
  integrationId: z.string().min(1).optional(),
}).refine((r) => r.connectorId !== undefined || r.integrationId !== undefined
  || (r.providerId !== undefined && r.config !== undefined), {
  message: 'Name a connector, an integration to reconnect, or a provider with its configuration.',
});
export type ConnectIntegrationRequest = z.infer<typeof connectIntegrationRequest>;

/** A model name: blank means "not set"; otherwise one word of at most 100 characters (P12). */
const roleModelName = z.string().trim().max(MAX_MODEL_NAME).regex(/^\S*$/, 'A model name is passed to the runtime as one word, without spaces.');

/** A skill's name: it becomes a folder name (P13). */
const skillName = z.string().trim().refine((name) => skillNameProblem(name) === null, {
  message: 'A skill name is letters, digits, dots, dashes or underscores (up to 64).',
});

export const upsertRoleRequest = z.object({
  workspaceId: z.string().min(1),
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  summary: z.string().max(500),
  instructions: z.string().max(20000),
  defaultCapabilities: z.array(z.string()),
  producesArtifacts: z.array(z.enum(ARTIFACT_TYPES)),
  consumesArtifacts: z.array(z.enum(ARTIFACT_TYPES)),
  defaultIsolation: z.enum(['none', 'worktree', 'docker', 'browser']),
  outputContract: z.string().max(8000),
  /**
   * Which models this role's runs use (P12). Omitted keeps what the role has;
   * null clears them. Names are passed to the runtime verbatim: one word each.
   */
  models: z.object({
    model: roleModelName.nullable(),
    escalate: z.array(roleModelName).max(MAX_LADDER),
    economyModel: roleModelName.nullable(),
  }).nullable().optional(),
  /**
   * Skills pinned to this role at a version (P13). Omitted keeps what the role
   * has; null or an empty list clears them. Each must be in the project's library.
   */
  skills: z.array(z.object({
    name: skillName,
    version: z.number().int().min(1),
  })).max(20).nullable().optional(),
});
export type UpsertRoleRequest = z.infer<typeof upsertRoleRequest>;

export const missionEventsQuery = z.object({
  afterSequence: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  semanticOnly: z.coerce.boolean().optional(),
});

export const missionFeedQuery = z.object({
  /** How many done cards to return; the rest are counted in `doneTotal`. */
  doneLimit: z.coerce.number().int().min(0).max(500).optional(),
});

export const missionArtifactsQuery = z.object({
  // An enum, not `z.coerce.boolean()`: that reads the string 'false' as true.
  includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

/** `GET /v1/artifacts`: search stays on current versions unless older ones are asked for. */
export const artifactSearchQuery = z.object({
  workspaceId: z.string().optional(),
  q: z.string().optional(),
  includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const retryTaskRequest = z.object({
  /** Override the runtime for this attempt - the manual fallback escape hatch. */
  runtimeProfileId: z.string().optional(),
  /** Stored as a feedback item and started as a round, so it takes a note's full length. */
  note: z.string().max(4000).optional(),
  /**
   * Capabilities to add before retrying. Still narrowed to the role's own
   * defaults when grants are built, so this widens a task within what its role
   * may do - never beyond it.
   */
  addCapabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  /**
   * Stop the step's live run first (P9 "Stop and retry"): a RUNNING or
   * AWAITING_INPUT step is cancelled and queued again in one decision.
   */
  stopRun: z.boolean().optional(),
});

// ------------------------------------------------------------ feedback and rounds

/** A note on a task's output (spec §2); what it does depends on the task's state. */
export const giveFeedbackRequest = z.object({
  text: z.string().trim().min(1).max(4000),
  /** Feedback about one output of the task; omitted for the whole task. */
  artifactId: z.string().min(1).optional(),
  /** Files or links attached to the note (spec A3); pinned as Evidence and read by the round that picks it up. */
  attachments: contributionArray(5).optional(),
  onBehalfOf,
});
export type GiveFeedbackRequest = z.infer<typeof giveFeedbackRequest>;

// ------------------------------------------------------------ outside contributions (P3)

/** "Continue elsewhere": parks an agent task so the work can continue in another tool (spec A4). */
export const parkTaskRequest = z.object({
  tool: z.string().trim().min(1).max(40),
});
export type ParkTaskRequest = z.infer<typeof parkTaskRequest>;

/** What comes back from a parked task: a note, one contribution, and the downstream choice when it applies (spec A4). */
export const handBackRequest = z.object({
  note: z.string().trim().min(1).max(4000),
  contribution: outsideContributionSchema,
  downstream: z.enum(['redo', 'keep']).optional(),
  onBehalfOf,
});
export type HandBackRequest = z.infer<typeof handBackRequest>;

/** A workspace link inside a note or a hand-back (spec A4): resolved to an absolute path. */
export const resolveWorkspaceLinkRequest = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
});
export type ResolveWorkspaceLinkRequest = z.infer<typeof resolveWorkspaceLinkRequest>;

/** Confirms a round that waited on the downstream choice (spec §3). */
export const startRoundRequest = z.object({
  feedbackIds: z.array(z.string().min(1)).min(1).max(50),
  // "none" says the caller saw nothing downstream; if work used the output since, the round is refused rather than kept silently.
  downstream: z.enum(['redo', 'keep', 'none']),
  redoTaskIds: z.array(z.string().min(1)).max(200).optional(),
  onBehalfOf,
});
export type StartRoundRequest = z.infer<typeof startRoundRequest>;

export const dismissFeedbackRequest = z.object({ onBehalfOf });
export type DismissFeedbackRequest = z.infer<typeof dismissFeedbackRequest>;

/** A new plan for what is left (replan spec); the note says why, and briefs the planner. */
export const replanMissionRequest = z.object({
  note: z.string().max(4000).nullish(),
});
export type ReplanMissionRequest = z.infer<typeof replanMissionRequest>;

export const cancelMissionRequest = z.object({
  reason: z.string().max(500).optional(),
});

/** `GET /v1/workspaces/:id/usage?month=2026-09`; the current local month when absent. */
export const workspaceUsageQuery = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'A month reads like 2026-09.').optional(),
});

/** The schedule presets (P11): daily, weekly or every N hours. Never cron. */
export const routineScheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily'), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Give the time as HH:MM on a 24-hour clock.') }),
  z.object({ type: z.literal('weekly'), day: z.number().int().min(0).max(6), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Give the time as HH:MM on a 24-hour clock.') }),
  z.object({ type: z.literal('hourly'), every: z.number().int().refine((n) => (ROUTINE_HOURS as readonly number[]).includes(n), `Every N hours takes one of ${ROUTINE_HOURS.join(', ')}.`) }),
]);

const routineFields = {
  name: z.string().trim().min(1, 'A routine needs a name.').max(120),
  kind: z.enum(ROUTINE_KINDS),
  goal: z.string().max(8000),
  successCriteria: z.array(z.string().max(2000)).max(50),
  priority: z.enum(MISSION_PRIORITIES),
  limits: limitsSchema.nullable(),
  workflowPreset: z.string().min(1).nullable(),
  schedule: routineScheduleSchema,
  enabled: z.boolean(),
};

/** Creating a routine (P11). A mission routine needs a Done-when line; the service says so. */
export const createRoutineRequest = z.object({
  ...routineFields,
  kind: routineFields.kind.default('mission'),
  goal: routineFields.goal.default(''),
  successCriteria: routineFields.successCriteria.default([]),
  priority: routineFields.priority.optional(),
  limits: routineFields.limits.optional(),
  workflowPreset: routineFields.workflowPreset.optional(),
  enabled: routineFields.enabled.optional(),
});
export type CreateRoutineRequest = z.input<typeof createRoutineRequest>;

export const updateRoutineRequest = z.object(routineFields).partial()
  .refine((r) => Object.keys(r).length > 0, 'Say what to change.');
export type UpdateRoutineRequest = z.infer<typeof updateRoutineRequest>;

/** Test clock (P11): only served when the daemon runs with TANDEMISE_CLOCK_OFFSET_MS. */
export const advanceClockRequest = z.object({
  advanceMs: z.number().int().min(0).max(366 * 24 * 3_600_000),
});
export type AdvanceClockRequest = z.infer<typeof advanceClockRequest>;

// ---------------------------------------------------------------- skills (P13)

/** Where a skill is imported from. A path must be absolute (the desktop's folder picker gives one). */
export const skillSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claude'), path: z.string().trim().min(1).max(4096), plugin: z.string().trim().min(1).max(200).optional() }),
  z.object({ kind: z.literal('path'), path: z.string().trim().min(1).max(4096) }),
  z.object({
    kind: z.literal('git'),
    url: z.string().trim().min(1).max(2048),
    subpath: z.string().trim().max(1024).optional(),
    ref: z.string().trim().max(200).optional(),
  }),
]);
export type SkillSourceRequest = z.infer<typeof skillSourceSchema>;

export const previewSkillRequest = z.object({ source: skillSourceSchema });
export type PreviewSkillRequest = z.infer<typeof previewSkillRequest>;

/** Imports exactly what was previewed: refused (409) when the content no longer has this hash. */
export const importSkillRequest = z.object({
  source: skillSourceSchema,
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'the hash the preview showed'),
});
export type ImportSkillRequest = z.infer<typeof importSkillRequest>;

// -------------------------------------------------------------------- evals (P3b)

export const createEvalSuiteRequest = z.object({ name: z.string().trim().min(1).max(80) });
export type CreateEvalSuiteRequest = z.infer<typeof createEvalSuiteRequest>;

export const saveEvalCaseRequest = z.object({
  suiteId: z.string().optional(),
  newSuiteName: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80),
});
export type SaveEvalCaseRequest = z.infer<typeof saveEvalCaseRequest>;

const skillRef = z.object({ name: z.string().min(1), version: z.union([z.number().int().positive(), z.literal('latest')]) });

/** A candidate to try against a suite's baseline (spec B4): a model swap, a skills swap, or a whole `.tandemise` folder. */
export const evalCandidateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('models'), roles: z.record(z.string(), z.string().min(1)) }),
  z.object({ kind: z.literal('skills'), roles: z.record(z.string(), z.array(skillRef)) }),
  z.object({ kind: z.literal('setup'), folder: z.string().min(1) }),
  z.object({ kind: z.literal('brain'), ref: z.string().min(1) }),
]);
export type EvalCandidateRequest = z.infer<typeof evalCandidateSchema>;

/**
 * Repeats (1-10, default 3) and the spend cap (required, > 0) are range-checked
 * in `EvalService`, not here, so a refusal carries the service's own message
 * rather than a generic zod one.
 */
export const startEvalRunRequest = z.object({
  candidate: evalCandidateSchema,
  repeats: z.number().int().optional(),
  spendCapUsd: z.number().optional(),
});
export type StartEvalRunRequest = z.infer<typeof startEvalRunRequest>;

/** `GET /v1/workspaces/:id/evals/run-scores?days=30`. */
export const runScoresQuery = z.object({ days: z.enum(['7', '30', '90']).default('30') });
export type RunScoresQuery = z.infer<typeof runScoresQuery>;

// ---- coordination (the optional relay, docs/superpowers/specs/2026-10-30-relay-design.md)

/** Settings → Team relay → Connect. */
export const connectRelayRequest = z.object({
  url: z.string().trim().min(1).max(2000),
  code: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(120),
  deviceLabel: z.string().trim().min(1).max(120),
  allowInsecure: z.boolean().default(false),
});
export type ConnectRelayRequest = z.infer<typeof connectRelayRequest>;

/** Which project's claims or mailbox: a workspace (its project key is looked up) or a project key. */
export const projectKeyRequest = z.object({
  workspaceId: z.string().min(1).optional(),
  projectKey: z.string().min(1).optional(),
});
export type ProjectKeyRequest = z.infer<typeof projectKeyRequest>;

/** "Take over", for the mission on this machine that should hold the claim. */
export const takeOverClaimRequest = z.object({ missionId: z.string().min(1).nullable().default(null) });

/** A local runner's pull from the daemon's mailbox. */
export const coordinationPullRequest = projectKeyRequest.extend({
  max: z.number().int().min(1).max(50).default(10),
  leaseSeconds: z.number().int().min(1).max(300).default(60),
});

/** A webhook endpoint created through the daemon: for a workspace's project, or a project key. */
export const coordinationEndpointRequest = createEndpointRequest.omit({ projectKey: true }).merge(projectKeyRequest);
