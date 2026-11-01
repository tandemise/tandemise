import type { Approval, ArtifactType, CriterionResult, LimitMetric, MissionPriority, MissionStatus, RoutineTemplate, TaskStatus, TandemiseEventBody } from '@tandemise/domain';

/**
 * The handful of *runtime* values the renderer needs from the domain.
 *
 * Types are imported directly from `@tandemise/domain` everywhere else and cost
 * nothing, but its runtime entry point reaches `@tandemise/shared`, which
 * imports `node:path` and `node:os`. The renderer is sandboxed and has no Node
 * (MVP.md §7.1), so pulling that in would either break the bundle or, worse,
 * ship a shimmed copy of it into a browser context.
 *
 * Every table below is keyed by a domain union, so adding a case in
 * `@tandemise/domain` fails this file at compile time rather than silently
 * drifting.
 */

const TERMINAL: Readonly<Record<MissionStatus, boolean>> = {
  DRAFT: false,
  PLANNING: false,
  AWAITING_PLAN_APPROVAL: false,
  EXECUTING: false,
  REVIEWING: false,
  QA: false,
  READY_TO_SHIP: false,
  RELEASED: false,
  OBSERVING: false,
  COMPLETE: true,
  BLOCKED: false,
  PAUSED: false,
  FAILED: true,
  CANCELLED: true,
};

export function isTerminalMissionStatus(status: MissionStatus): boolean {
  return TERMINAL[status] ?? false;
}

/**
 * Which event types belong in the semantic timeline (MVP.md §23.3). The false
 * entries are the ones the raw log exists for.
 */
const SEMANTIC: Readonly<Record<TandemiseEventBody['type'], boolean>> = {
  message: true,
  thinking_summary: false,
  'tool.started': true,
  'tool.completed': false,
  'file.changed': true,
  'artifact.created': true,
  'approval.requested': true,
  usage: false,
  checkpoint: false,
  completed: true,
  failed: true,
  raw: false,
  'mission.status': true,
  'task.status': true,
  'run.started': true,
  'run.finished': true,
  'check.result': true,
  'gate.evaluated': true,
  'approval.resolved': true,
  'policy.denied': true,
  'approval.escalated': true,
  'review.skipped': true,
  'review.required': true,
  'task.attention': true,
  'artifact.tighten_requested': true,
  'artifact.over_budget': true,
  'feedback.given': true,
  'feedback.addressed': true,
  'feedback.dismissed': true,
  'task.round_started': true,
  'mission.pulled': true,
  'task.parked_external': true,
  'task.unparked': true,
  'task.handed_back': true,
  'task.held': true,
  'task.hold_ended': true,
  'mission.intake_completed': true,
  'plan.decided': true,
  'ship.pr_opened': true,
  'task.outcome': false,
  'merge.decided': true,
  'merge.merged': true,
  'merge.asked': true,
  'merge.approval_kept': true,
  'merge.reverted': true,
  'brain.learned': true,
  note: true,
};

export function isSemanticEvent(body: TandemiseEventBody): boolean {
  return SEMANTIC[body.type] ?? false;
}

const ARTIFACT_TYPE_SET: Readonly<Record<ArtifactType, true>> = {
  ProblemBrief: true,
  ProductSpec: true,
  DesignBrief: true,
  ArchitecturePlan: true,
  ImplementationPlan: true,
  ChangeSet: true,
  ReviewReport: true,
  QAPlan: true,
  QAReport: true,
  ReleaseCandidate: true,
  DecisionRecord: true,
  FinanceReport: true,
  Evidence: true,
  MissionPlan: true,
  Refinement: true,
  StatusReport: true,
};

/**
 * Types a role can produce or consume. A Refinement comes from refining a
 * request before planning and a StatusReport from the daemon, so no role is
 * offered either; the set above still names them so a new type is not missed.
 */
const NOT_ROLE_OUTPUTS: ReadonlySet<ArtifactType> = new Set<ArtifactType>(['Refinement', 'StatusReport']);
export const ARTIFACT_TYPES = (Object.keys(ARTIFACT_TYPE_SET) as ArtifactType[]).filter((t) => !NOT_ROLE_OUTPUTS.has(t)) as readonly ArtifactType[];

export function criteriaCoveragePercent(results: readonly CriterionResult[]): number {
  const scored = results.filter((result) => result.outcome !== 'SKIP');
  if (scored.length === 0) return 0;
  return Math.round((scored.filter((result) => result.outcome === 'PASS').length / scored.length) * 100);
}

/** Mirrors `REJECT_OPTION` in `@tandemise/domain`: the option that declines an approval or a question. */
export const REJECT_OPTION = 'reject';

/** Mirrors `REQUEST_CHANGES_OPTION` in `@tandemise/domain`: an output card's "send it back as the next round, with this note". */
export const REQUEST_CHANGES_OPTION = 'request_changes';

/** Mirrors `NEEDS_CHANGES_OPTION` in `@tandemise/domain`: a check's "needs changes", which with a note is feedback. */
export const NEEDS_CHANGES_OPTION = 'needs_changes';

const PRIORITY_LABELS: Readonly<Record<MissionPriority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

/** Mirrors `MISSION_PRIORITIES` in `@tandemise/domain`, most urgent first. */
export const MISSION_PRIORITIES = Object.keys(PRIORITY_LABELS) as readonly MissionPriority[];

export function priorityLabel(priority: MissionPriority): string {
  return PRIORITY_LABELS[priority] ?? priority;
}

const LIMIT_METRIC_LABELS: Readonly<Record<LimitMetric, { label: string; unit: string }>> = {
  agent_minutes: { label: 'Agent minutes', unit: 'agent minutes' },
  tokens: { label: 'Tokens', unit: 'tokens' },
  usd: { label: 'Cost (USD)', unit: 'USD' },
};

/** Mirrors `LIMIT_METRICS` in `@tandemise/domain` (P8). */
export const LIMIT_METRICS = Object.keys(LIMIT_METRIC_LABELS) as readonly LimitMetric[];
/** Mirrors `DEFAULT_WARN_PERCENT`. */
export const DEFAULT_WARN_PERCENT = 80;
/** Mirrors the two answers to a limit card in `@tandemise/domain`. */
export const RAISE_LIMIT_OPTION = 'raise_limit';
export const KEEP_PAUSED_OPTION = 'keep_paused';

export function limitMetricLabel(metric: LimitMetric): string {
  return LIMIT_METRIC_LABELS[metric]?.label ?? metric;
}

export function limitUnit(metric: LimitMetric): string {
  return LIMIT_METRIC_LABELS[metric]?.unit ?? metric;
}

/** Mirrors the plan-fit answers in `@tandemise/domain`: skip the steps after a stop, or run them as planned. */
export const SKIP_REST_OPTION = 'skip_rest';
export const CONTINUE_PLAN_OPTION = 'continue_plan';
/** Mirrors `REPLAN_REST_OPTION`: plan fit's "Plan the rest again" (replan spec). */
export const REPLAN_REST_OPTION = 'replan_rest';

/** A plan-fit card: a step said the plan no longer fits, and the steps after it wait on this answer. */
export function isPlanFitCard(approval: Approval): boolean {
  return approval.kind === 'intervention' && approval.taskId !== null && approval.options.some((o) => o.id === SKIP_REST_OPTION);
}

/** A limit card: an intervention with no task that offers "Raise limit and resume". */
export function isLimitCard(approval: Approval): boolean {
  return approval.kind === 'intervention' && approval.taskId === null && approval.options.some((o) => o.id === RAISE_LIMIT_OPTION);
}

/** Mirrors `quietForLabel` in `@tandemise/domain` (P9): "34 min", or "12 s" under a minute. */
export function quietFor(ms: number): string {
  return ms < 60_000 ? `${Math.floor(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`;
}

/** MVP.md §7.2. Mirrors `@tandemise/api-contract`, for the same reason as above. */
/** Mirrors `ROUTINE_HOURS` (P11): the "every N hours" presets. */
export const ROUTINE_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;

/** 0 = Sunday, as the daemon counts them; listed Monday first, as a week is read. */
export const WEEKDAY_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' }, { value: 6, label: 'Saturday' }, { value: 0, label: 'Sunday' },
];

/**
 * Mirrors `ROUTINE_TEMPLATES` in `@tandemise/domain` (the renderer may not
 * import runtime values): the three starters on the New routine dialog.
 */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    key: 'dependencies',
    name: 'Weekly dependency updates',
    kind: 'mission',
    goal: 'Update the project\'s dependencies to their latest compatible versions, run the tests, and fix anything the updates break.',
    successCriteria: [
      'Every direct dependency is on its latest compatible version, or the reason it is held back is written down',
      'The test suite passes after the updates',
      'The change lists each updated package with its old and new version',
    ],
    priority: 'normal',
    schedule: { type: 'weekly', day: 1, at: '09:00' },
    description: 'Every Monday at 09:00, a mission to bring dependencies up to date.',
  },
  {
    key: 'failing-checks',
    name: 'Nightly: fix failing checks',
    kind: 'mission',
    goal: 'Find the checks that fail on the default branch (tests, typecheck, lint) and fix the cause of each one.',
    successCriteria: [
      'Every check that failed at the start passes',
      'No test was skipped or deleted to make a check pass',
      'Each fix names the check it repaired and why it failed',
    ],
    priority: 'high',
    schedule: { type: 'daily', at: '02:00' },
    description: 'Every night at 02:00, a high-priority mission to get the checks green.',
  },
  {
    key: 'status-report',
    name: 'Weekly status report',
    kind: 'status_report',
    goal: '',
    successCriteria: [
      'Every mission in progress is listed with its criteria verified',
      'Every open decision is named',
      'This month\'s usage is shown against the monthly limit',
    ],
    priority: 'normal',
    schedule: { type: 'weekly', day: 5, at: '16:00' },
    description: 'Every Friday at 16:00, the status report written from facts. No agent runs.',
  },
];

/**
 * P12 model routing. Mirrors `modelLabel` and `modelPolicyLabel` in
 * @tandemise/domain (entities/models.ts); the renderer may not import values.
 */
export function modelLabel(run: { readonly model?: string | null; readonly modelReason?: string | null }): string {
  if (run.modelReason === null || run.modelReason === undefined) return 'Model: not recorded';
  if (run.model === null || run.model === undefined) return `Model: ${run.modelReason}`;
  return `Model: ${run.model} · ${run.modelReason}`;
}

export function modelPolicyLabel(policy: { readonly model?: string; readonly escalate?: readonly string[]; readonly independentOf?: string } | null | undefined): string | null {
  if (policy === null || policy === undefined) return null;
  const parts: string[] = [];
  if (policy.model) parts.push(`model ${policy.model}`);
  if (policy.escalate && policy.escalate.length > 0) parts.push(`retries use ${policy.escalate.join(', then ')}`);
  if (policy.independentOf) parts.push(`must differ from ${policy.independentOf}`);
  return parts.length === 0 ? null : `This step: ${parts.join(' · ')}`;
}

/** Splits "a, b" or one-per-line into model names; blanks dropped. */
export function modelList(text: string): string[] {
  return text.split(/[\n,]/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * P13 skills. Mirrors `skillPinLabel` / `shortHash` in @tandemise/domain
 * (entities/skill.ts); the renderer may not import values.
 */
export function skillPinLabel(pin: { readonly name: string; readonly version: number; readonly hash: string }): string {
  return `${pin.name} v${pin.version} · ${pin.hash.slice(0, 12)}`;
}

/**
 * The step drawer's skills line: what the newest run received (and how), else
 * what the task pinned; null when it pins none.
 */
export function skillsLine(task: {
  readonly skills?: readonly { readonly name: string; readonly version: number; readonly hash: string }[] | null;
  readonly latestRun?: { readonly skills?: readonly { readonly name: string; readonly version: number; readonly hash: string; readonly via: 'folder' | 'prompt' }[] | null } | null;
}): string | null {
  const received = task.latestRun?.skills ?? null;
  if (received !== null && received.length > 0) {
    return `Skills: ${received.map((s) => `${skillPinLabel(s)}${s.via === 'prompt' ? ' (in prompt)' : ''}`).join(', ')}`;
  }
  const pinned = task.skills ?? [];
  if (pinned.length === 0) return null;
  return `Skills (pinned): ${pinned.map(skillPinLabel).join(', ')}`;
}

/**
 * P3 outside contributions. Mirrors `CONTRIBUTION_MAX_BYTES` (entities/contribution.ts)
 * and the request schema's two refusals word for word, so a file the daemon would
 * refuse is refused in the picker first, in the same words.
 */
export const CONTRIBUTION_MAX_BYTES = 24 * 1024 * 1024;
export const CONTRIBUTION_FILE_MESSAGE = 'That file is larger than 24 MB.';
export const CONTRIBUTION_TOTAL_MESSAGE = 'These files add up to more than 24 MB. Add the rest later as feedback.';

/**
 * What "Continue elsewhere" may take (spec A4). Mirrors `LINKABLE_OUTPUT_TYPES`
 * and the park rule's statuses in the application layer; the daemon still
 * decides, and says why when it refuses.
 */
export const LINKABLE_OUTPUT_TYPES: readonly ArtifactType[] = ['DesignBrief', 'ChangeSet', 'ImplementationPlan', 'ProductSpec'];
export const PARKABLE_TASK_STATUSES: readonly TaskStatus[] = ['READY', 'RUNNING', 'SUCCEEDED'];

/** Where the work most likely goes next, prefilled in "Continue elsewhere" and editable there: a design in Figma, code or a plan in Cursor, a spec in Google Docs. */
export function defaultElsewhereTool(outputs: readonly ArtifactType[]): string {
  if (outputs.includes('DesignBrief')) return 'Figma';
  if (outputs.includes('ChangeSet') || outputs.includes('ImplementationPlan')) return 'Cursor';
  return 'Google Docs';
}

/**
 * Intake (plan Task 14). Mirrors `sourceLabel` in @tandemise/domain
 * (entities/intake.ts): a shipped kind's words, a custom runner's slug as itself.
 */
const INTAKE_SOURCE_LABELS: Readonly<Record<string, string>> = { github: 'GitHub', sentry: 'Sentry', posthog: 'PostHog', slack: 'Slack', discord: 'Discord' };
export function intakeSourceLabel(kind: string): string {
  return INTAKE_SOURCE_LABELS[kind] ?? kind;
}

/** A shipped kind runs inside the daemon; any other kind is a custom runner that pushes with a token. */
export function isShippedIntakeKind(kind: string): boolean {
  return kind in INTAKE_SOURCE_LABELS;
}

/**
 * The secrets each shipped runner reads by name (intake-runners, RULINGS 17 and 18),
 * with the words Settings → Intake asks for them in. Kept only in the local secret store.
 */
export const INTAKE_SOURCE_SECRETS: Readonly<Record<string, readonly { readonly name: string; readonly label: string }[]>> = {
  sentry: [{ name: 'token', label: 'Auth token' }, { name: 'clientSecret', label: 'Webhook client secret' }],
  posthog: [{ name: 'apiKey', label: 'Personal API key' }, { name: 'webhookSecret', label: 'Webhook secret' }],
  slack: [{ name: 'appToken', label: 'App-level token' }, { name: 'botToken', label: 'Bot token' }],
  discord: [{ name: 'botToken', label: 'Bot token' }],
};

export const API_VERSION = 'v1';
export const API_VERSION_HEADER = 'x-tandemise-api-version';
export const STREAM_PATH = '/v1/stream';
