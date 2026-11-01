import type { PlanDecision } from './for-me.js';
import type { InboxIntakeDecisionView } from './intake.js';
import type {
  Approval, ArtifactManifest, ArtifactType, CheckResult, CriteriaCounts, Decision, Evaluation, ExecutionTargetRecord,
  EvalCandidate, EvalRunStatus, EvalTrialStatus,
  Integration, Mission, MissionProgress, MissionTask, Repository, RoleTemplate, Run,
  RunEventRecord, RuntimeHealth, RuntimeProfile, RuntimeDiscovery, RuntimeSettingField, Workspace,
  MissionPlan, PlanValidationIssue, GateOutcome, AccessLevel, Member, Person, Staffing,
  ArtifactHandoff, TaskStatus, FeedbackStatus, MissionPriority, Limit, LimitStatus,
  MissionStatus, StalledAction, WatchLevel, Routine, RoutineOutcome, RoutineTrigger,
  SkillFileEntry, SkillSource, ExternalRef,
} from '@tandemise/domain';

/** A pointer to truth in another system (spec A1), as read on an upload's provenance list. */
export type ExternalRefView = ExternalRef;

/**
 * Read models the UI consumes.
 *
 * The renderer never reads SQLite and never re-derives joins (MVP.md §7.2); it
 * receives projected state. Keeping these shapes here - rather than letting the
 * UI assemble them from six endpoints - is what keeps a mission screen one
 * request instead of a waterfall.
 */

/**
 * Whoever did something, named. Views carry this rather than a bare id so the
 * renderer never has to fetch the team to print "Ana" next to a decision.
 */
export interface ActorRef {
  readonly id: string;
  readonly name: string;
  readonly kind: 'person' | 'agent' | 'system';
}

/** An artifact with the people behind it. */
export interface ArtifactView extends ArtifactManifest {
  readonly author: ActorRef | null;
  readonly responsible: ActorRef | null;
  readonly recordedByRef: ActorRef | null;
}

/**
 * An artifact in a mission's list, placed in its line of versions.
 *
 * The list hides superseded versions unless asked, and a reader that does ask
 * needs "v2 of 3" without walking the chain itself.
 */
export interface MissionArtifactView extends ArtifactView {
  /** 1-based position along the `supersedes` chain: the first version is 1. */
  readonly version: number;
  /** The artifact that replaced this one, or null while it is the live version. */
  readonly supersededBy: string | null;
}

/**
 * One artifact opened in the reader: its manifest placed in its line of
 * versions, the stored body, and the appendix already found.
 *
 * The rule that finds `## Appendix` has to skip code fences and tables, and it
 * lives in `@tandemise/artifacts` next to the word budgets, which the sandboxed
 * renderer cannot import. Splitting here means the collapsed "Appendix (N
 * words)" section counts exactly what the tighten pass counted.
 */
export interface ArtifactReadView {
  readonly manifest: MissionArtifactView;
  readonly body: string;
  /** Words in the appendix, measured like the budget measures them; null when there is none. */
  readonly appendixWords: number | null;
  /**
   * The body cut at its first `## Appendix` heading, front matter removed, the
   * heading itself in neither part. Null when there is no appendix, so the
   * common case does not carry the body twice.
   */
  readonly split: { readonly main: string; readonly appendix: string } | null;
  /**
   * Who the request the handoff's `needs` names is waiting on, while that
   * request is open; null when nothing is being asked. The reader shows
   * `needs` to someone the request is for and "Waiting for ..." to everyone
   * else, judged with the shared for-me rules, as the feed does.
   */
  readonly openRequest: OpenRequest | null;
  /**
   * When this output was set aside, unjudged, because a round reset its task
   * while its pass was settling; null otherwise. A set-aside artifact is not
   * any task's current output and asks for nothing, whatever its handoff says.
   */
  readonly withdrawnAt: string | null;
  /** The round that produced this version; null for output from before rounds were recorded. */
  readonly round: number | null;
  /** Every version of this output of its task, oldest first, for the version switcher. */
  readonly versions: readonly {
    readonly artifactId: string;
    readonly version: number;
    readonly round: number | null;
    readonly createdAt: string;
  }[];
  /** "Changes in vN": the handoff's `changed`, each with the notes it answers. */
  readonly changes: readonly FeedChange[];
  /** The same signal FeedCard uses: false when the task reads no notes, or its mission takes no more rounds. */
  readonly canRequestChanges: boolean;
}

/** One note on a task, named. */
export interface FeedbackView {
  readonly id: string;
  readonly taskId: string;
  readonly artifactId: string | null;
  readonly author: ActorRef | null;
  /** Only when it differs from `author`. */
  readonly recordedBy: ActorRef | null;
  readonly text: string;
  readonly status: FeedbackStatus;
  readonly round: number | null;
  readonly createdAt: string;
}

/** One `handoff.changed` entry with the notes it answers resolved. */
export interface FeedChange {
  readonly what: string;
  readonly declined: boolean;
  /** Unknown ids are dropped: a card never shows a raw id. */
  readonly feedback: readonly Pick<FeedbackView, 'id' | 'text' | 'author' | 'status'>[];
}

/** What reopening a finished task would touch, for the "redo or keep" dialog (spec §3). */
export interface DownstreamImpactView {
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskTitle: string;
  readonly nextRound: number;
  /** The open items the confirmed round will carry. */
  readonly feedbackIds: readonly string[];
  readonly dependents: readonly {
    readonly taskId: string;
    readonly key: string;
    readonly title: string;
    readonly status: TaskStatus;
    /** The version of this task's output the dependent worked from. */
    readonly usedVersion: number;
    readonly running: boolean;
  }[];
  readonly defaultChoice: 'redo' | 'keep';
}

export interface FeedbackGivenView {
  readonly feedback: FeedbackView;
  /** Set when the task finished and its output was used: the round waits for `POST /v1/tasks/:id/rounds`. */
  readonly impact: DownstreamImpactView | null;
  /** The round that started because of this item, when one did. */
  readonly roundStarted: number | null;
  /** Notes that round carries, this one included: open notes waiting on the task join it too. 0 when no round started. */
  readonly roundNotes: number;
}

/** A task's feedback thread: a flat list, not a chat. */
export interface TaskFeedbackView {
  readonly taskId: string;
  readonly round: number;
  readonly items: readonly FeedbackView[];
  /** Non-null while open items wait for a round the task can start; `dependents` may be empty. */
  readonly pendingImpact: DownstreamImpactView | null;
}

export type OpenRequest =
  | { readonly kind: 'approval'; readonly addresseeIds: readonly string[] }
  | {
    readonly kind: 'person_step';
    readonly assigneeId: string | null;
    readonly claimableIds: readonly string[];
    readonly escalatedToIds: readonly string[];
  };

/**
 * One card in a mission's feed: a task that has started, or the plan.
 *
 * Everything a card shows is here, already joined and already judged against
 * the caller, so the feed is one request and the renderer decides nothing
 * about who a card is for.
 */
export interface FeedCard {
  /** Null for the plan card. */
  readonly taskId: string | null;
  /** The task key, or 'plan'. */
  readonly key: string;
  readonly title: string;
  /** Null for the plan, and for a role that no longer resolves. */
  readonly roleName: string | null;
  readonly status: TaskStatus | 'PLAN';
  readonly statusReason: string | null;
  readonly section: 'needs_you' | 'in_progress' | 'done';
  readonly doneBy: ActorRef | null;
  readonly responsible: ActorRef | null;
  /** Only when it differs from `doneBy`, so a card names a second person only when there is one. */
  readonly recordedBy: ActorRef | null;
  /** The primary live artifact: the first expected output that exists, else the newest. */
  readonly artifactId: string | null;
  readonly artifactTitle: string | null;
  /**
   * The primary artifact's handoff. Legacy rows fall back to their summary as
   * the headline. `needs` is shown only while the request it describes is
   * still open, and is null otherwise.
   */
  readonly handoff: ArtifactHandoff | null;
  /** Other live artifacts the task produced, for "+N more". */
  readonly moreArtifacts: number;
  readonly overBudget: boolean;
  /**
   * True when every artifact the task produced has since been replaced, e.g.
   * by a fix task; the card then shows the task's own newest artifact.
   */
  readonly superseded: boolean;
  /** The key of the task whose artifact replaced this card's, when known; for "updated by". */
  readonly supersededByTaskKey: string | null;
  /** The open approval waiting on the caller; only on a needs_you card. */
  readonly pendingApproval: ApprovalView | null;
  /** What the caller can do with a person task that is for them. */
  readonly humanAction: 'complete' | 'claim' | null;
  /**
   * Where the plan stands, on the plan card only (null on a task card):
   * still asked, approved by a person, accepted without asking, rejected, or
   * no longer asked because the request was withdrawn (a cancel or a re-plan).
   * A plan card is never "Approved" unless a decision says so.
   */
  readonly planDecision: PlanDecision | null;
  readonly updatedAt: string;
  /** The task's current round; 1 on the plan card. */
  readonly round: number;
  /**
   * Notes the task has yet to act on, oldest first: open and queued ones, plus
   * in-round ones while that round has not run (READY or PENDING). The card
   * shows the count and the latest.
   */
  readonly openFeedback: readonly FeedbackView[];
  /** The primary artifact's `handoff.changed`, each with the notes it answers. */
  readonly changed: readonly FeedChange[];
  /** A task (not the plan, not a wait step) that has run or has output. */
  readonly canRequestChanges: boolean;
}



export interface MissionFeedView {
  readonly missionId: string;
  readonly needsYou: readonly FeedCard[];
  readonly inProgress: readonly FeedCard[];
  /** Newest first, cut to the requested limit. */
  readonly done: readonly FeedCard[];
  /** Every done card, including those cut from `done`. */
  readonly doneTotal: number;
}

/**
 * One criterion on a mission's Done-when ledger, traced (P5). `result` is
 * derived from the newest QA report every time it is read; nothing here is
 * stored as a verdict.
 */
export interface MissionCriterionView {
  readonly id: string;
  /** `U1…` for the person's lines; the spec's own id (`AC1`) for spec criteria. */
  readonly key: string;
  readonly statement: string;
  readonly source: 'user' | 'spec' | 'implicit';
  /** User keys this spec criterion covers. */
  readonly covers: readonly string[];
  /** Spec keys that cover this user criterion. */
  readonly coveredBy: readonly string[];
  readonly result: 'PASS' | 'FAIL' | 'SKIP' | 'UNVERIFIED';
  /** QA's evidence, or "Through AC1" for a user criterion verified by what covers it. */
  readonly evidence: string;
  /** The QA report the result came from; null until QA has reported on it. */
  readonly qaArtifactId: string | null;
  /** The ProductSpec a spec criterion came from. */
  readonly specArtifactId: string | null;
  /** Counts towards "N of M verified": spec criteria, and user criteria nothing covers. */
  readonly counted: boolean;
  /** A user criterion the current spec leaves uncovered. */
  readonly uncovered: boolean;
  /**
   * What in the plan answers this line next: a spec step that will cover it,
   * a QA step that will verify it, nothing (`none`), or null before there is a plan.
   */
  readonly plannedCheck: 'spec' | 'qa' | 'none' | null;
  readonly createdAt: string;
}

/** Where a DRAFT mission stands against the readiness gate (P6). */
export interface ReadinessView {
  readonly ready: boolean;
  /** Accepted Done-when criteria. */
  readonly criteria: number;
  readonly openQuestions: number;
  readonly proposedPending: number;
  /** What the Plan button says: "Plan", or what is left ("Answer 1 question and decide 3 criteria to plan"). */
  readonly label: string;
  /** The gate's own explanation ("Not met: ready.open_questions is 1, needs 0"). */
  readonly detail: string;
}

/** A criterion as refinement shows it: proposed, accepted, rejected or replaced. */
export interface RefinementCriterionView {
  readonly id: string;
  /** `P<n>` while proposed, rejected or stale; `U<n>` once accepted. */
  readonly key: string;
  readonly statement: string;
  readonly status: 'proposed' | 'accepted' | 'rejected' | 'stale';
  /**
   * Where it came from: the request's own lines, added by hand later,
   * proposed by refinement, a GitHub issue's list (P14), or the tracker item
   * the mission was made from (#185).
   */
  readonly origin: 'request' | 'added' | 'refinement' | 'issue' | 'tracker';
  /** For `tracker`: the line the app shows, `From GAR-71`. Absent from an older daemon. */
  readonly originLabel?: string | null;
  /** `autonomy` when accepted automatically, `person` when someone decided it, null while undecided or for request lines. */
  readonly decidedBy: 'autonomy' | 'person' | null;
  readonly decidedById: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface RefinementQuestionView {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly why: string;
  readonly options: readonly string[];
  readonly status: 'open' | 'answered' | 'stale';
  readonly answer: string | null;
  readonly answeredBy: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
}

/** GET /v1/missions/:id/refinement: everything the "Get it ready" panel shows. */
export interface RefinementView {
  readonly missionId: string;
  /** `running` while a pass is in flight; `failed` when the last pass could not finish. */
  readonly state: 'idle' | 'running' | 'failed';
  /** Why the last pass failed, in words a person can act on. */
  readonly failure: string | null;
  /** The newest Refinement artifact, and its headline. */
  readonly artifactId: string | null;
  readonly headline: string | null;
  readonly criteria: readonly RefinementCriterionView[];
  readonly questions: readonly RefinementQuestionView[];
  readonly readiness: ReadinessView;
}

/** A DRAFT mission with something left to decide before it can be planned. */
export interface InboxRefinementView {
  readonly missionId: string;
  readonly missionTitle: string;
  /** Proposals to decide plus questions to answer. */
  readonly toDecide: number;
  readonly openQuestions: number;
  readonly proposedPending: number;
  /** Who it is for: the mission's creator, or empty when nobody in particular. */
  readonly forIds: readonly string[];
  readonly updatedAt: string;
}

/**
 * A mission nothing moves and nothing asks about (P9): one row per mission,
 * derived on every read, gone as soon as the mission can move again.
 */
export interface InboxStalledView {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly missionStatus: MissionStatus;
  /** The liveness row that decided it (P9 spec §1, L9-L18). */
  readonly rule: string;
  /** What is stuck, in a sentence: "'implement' is blocked: A human declined to retry this task." */
  readonly reason: string;
  /** The one thing to press. */
  readonly action: StalledAction;
  /** Who it is for: the mission's creator, or empty when nobody in particular. */
  readonly forIds: readonly string[];
  /** When the mission last changed. */
  readonly since: string;
  /**
   * The mission's pull request, when what is stuck is its CI wait or its ship
   * step (#145): the row links it. Optional, like every field added after P9.
   */
  readonly pullRequestUrl?: string | null;
  /** The row also offers to cancel the mission, beside its one action (#145). */
  readonly cancellable?: boolean;
}

/** A run that has been silent past its threshold (P9 spec §2). */
export interface InboxSilentRunView {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskTitle: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly attempt: number;
  readonly lastEventAt: string;
  /** Measured when the Inbox was read. */
  readonly quietForMs: number;
  readonly quietAfterMs: number;
  readonly silentAfterMs: number;
  /** The step's wall-time budget: the run is stopped automatically only at this. */
  readonly budgetMs: number;
  readonly forIds: readonly string[];
}

/** How long a running step has been quiet (P9). */
export interface TaskWatchView {
  readonly level: WatchLevel;
  readonly lastEventAt: string;
  readonly quietForMs: number;
  readonly quietAfterMs: number;
  readonly silentAfterMs: number;
  readonly snoozedUntil: string | null;
}

export interface SystemInfo {
  readonly daemonVersion: string;
  /** Short git commit the daemon was built from, or `dev` when unknown. */
  readonly daemonBuild: string;
  readonly apiVersion: string;
  readonly schemaVersion: number;
  readonly startedAt: string;
  readonly pid: number;
  readonly home: string;
  readonly platform: string;
  readonly nodeVersion: string;
}

export interface TaskView extends MissionTask {
  readonly roleName: string;
  /** DAG column, from `planLevels` - lets the UI lay out without a graph lib. */
  readonly level: number;
  readonly latestRun: Run | null;
  readonly runCount: number;
  readonly checks: readonly CheckResult[];
  readonly gate: GateOutcome | null;
  readonly pendingApprovalId: string | null;
  readonly runtimeName: string | null;
  readonly targetName: string | null;
  /**
   * Repository this task works in, named, when it is not the mission's own.
   *
   * Null for the common case, so a single-repository mission shows nothing and
   * only a task that genuinely works somewhere else is called out.
   */
  readonly repositoryName: string | null;
  readonly outputArtifacts: readonly ArtifactView[];
  /**
   * For a person's step, what the steps before it handed over: the live
   * artifacts an agent in its place would have been given, with their
   * handoffs. A person cannot read a prompt, so this is how they see what the
   * previous step found and what it needs from them. Empty for other steps.
   * Optional so a projection built before it still type-checks.
   */
  readonly inputs?: readonly ArtifactView[];
  readonly assignee: ActorRef | null;
  readonly responsible: ActorRef | null;
  /** People who may pick the task up; empty unless it waits in a pool. */
  readonly claimable: readonly ActorRef[];
  /** Who an unanswered pool was opened to: they may take it from its assignee. Empty unless it escalated. */
  readonly escalatedTo: readonly ActorRef[];
  /**
   * Who the task would go to if it became ready now. Set only while PENDING:
   * afterwards `assignee` and `responsible` hold the decided answer.
   */
  readonly wouldBe: {
    readonly assignee: ActorRef | null;
    readonly responsible: ActorRef;
    readonly claimable: readonly ActorRef[];
    readonly executor: 'agent' | 'human';
  } | null;
  /** Required here, unlike on the stored task: a row from before rounds reads as round 1. */
  readonly round: number;
  /** Every note on the task, oldest first, with its status. */
  readonly feedback: readonly FeedbackView[];
  /**
   * Why a task with `needsAttention` stands out; null when it does not.
   * `stale_input`: it was kept on an older version of `upstream` (a task title).
   * `changes_requested`: someone looked at it and said it needs changes.
   */
  readonly attention: {
    readonly kind: 'stale_input' | 'changes_requested';
    readonly upstream: string | null;
    readonly note: string;
  } | null;
  /** How long its live run has been quiet; null unless the step is running (P9). */
  readonly watch: TaskWatchView | null;
  /**
   * Set while "Continue elsewhere" is active (spec A4); null once it is handed
   * back or was never parked. Optional so a projection built before P3 still
   * type-checks; a live one always sends it.
   */
  readonly parkedExternal?: { readonly tool: string; readonly since: string } | null;
  /**
   * For a `SKIPPED` placeholder task, the upload that already covers its stage
   * (spec A2); null otherwise. Optional for the same reason as `parkedExternal`.
   */
  readonly coveredBy?: { readonly artifactId: string; readonly filename: string } | null;
  /** What a live agent step is doing, in plain words, from its latest run event; null unless it is running. */
  readonly now: string | null;
  /** The open hold on this step; null when nobody holds it. `terminalOpen` is false once its terminal exited. */
  readonly hold: {
    readonly holdId: string;
    readonly heldBy: string;
    readonly heldByName: string;
    readonly startedAt: string;
    readonly terminalOpen: boolean;
  } | null;
  /** Whether Hold is offered, and if not, why, in the daemon's own words. */
  readonly holdable: { readonly ok: true } | { readonly ok: false; readonly reason: string };
}

export interface MissionSummary {
  readonly mission: Mission;
  readonly progress: MissionProgress;
  readonly repositoryName: string | null;
  /** Title of whatever is currently happening, for the list row subtitle. */
  readonly currentActivity: string | null;
  readonly lastEventAt: string | null;
  /**
   * Its Done-when ledger as the feed counts it (P5): counted rows that PASS of
   * counted rows. Null for a draft or a mission with nothing to verify yet.
   * Optional so views built before P10 still type-check.
   */
  readonly criteria?: { readonly verified: number; readonly counted: number } | null;
}

export interface MissionDetail {
  readonly mission: Mission;
  readonly progress: MissionProgress;
  readonly repository: Repository | null;
  readonly tasks: readonly TaskView[];
  readonly artifacts: readonly ArtifactView[];
  readonly approvals: readonly Approval[];
  readonly decisions: readonly Decision[];
  readonly targets: readonly ExecutionTargetRecord[];
  readonly checks: readonly CheckResult[];
  readonly evaluations: readonly Evaluation[];
  readonly metrics: MissionMetrics;
  /** Its limits and how much of each it used (P8). */
  readonly limits: MissionLimitsView;
  readonly plan: MissionPlan | null;
  readonly planIssues: readonly PlanValidationIssue[];
  /**
   * Evidence pinned at creation or hand-back, and what intake made of it, if
   * anything (spec A2, A7). Optional so a `MissionDetail` built before P3
   * still type-checks; a live one always sends it.
   */
  readonly uploads?: readonly {
    readonly evidenceId: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly refs: readonly ExternalRefView[];
    readonly intakeArtifactId: string | null;
  }[];
  /** Its tracker item's claim with the team, when it has one (relay spec). */
  readonly claim?: MissionClaimView | null;
}

/** MVP.md §22.2. Values the runtime does not expose stay null, never guessed. */
export interface MissionMetrics {
  readonly wallClockMs: number;
  readonly runtimeActiveMs: number;
  readonly humanWaitMs: number;
  readonly retries: number;
  readonly failures: number;
  readonly filesChanged: number;
  readonly commits: number;
  readonly reviewFindings: number;
  readonly qaDefects: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly runtimeFallbacks: number;
  /**
   * Usage per model the mission's runs were given (P12), most runs first.
   * Optional: a daemon from before P12 does not send it.
   */
  readonly byModel?: readonly ModelUsageView[];
}

/** One model's share of a mission's runs. Tokens and cost stay null when no run of it reported them. */
export interface ModelUsageView {
  /** Null: the runtime's own default (or a run from before P12, with `recorded` false). */
  readonly model: string | null;
  /** What the person reads: the model, "runtime default", or "not recorded". */
  readonly label: string;
  readonly runs: number;
  readonly agentMs: number;
  readonly tokens: number | null;
  readonly costUsd: number | null;
}

export interface RuntimeView {
  readonly profile: RuntimeProfile;
  readonly health: RuntimeHealth;
  readonly adapterDisplayName: string;
  /**
   * What this profile's adapter lets it configure.
   *
   * Optional because a client is not always talking to a daemon of its own
   * vintage - `npm run dev` deliberately reuses a daemon that is already
   * running, so a freshly built renderer routinely meets an older one. A field
   * added to a view is therefore absent, not empty, and code that reads it must
   * say what it does in that case rather than trust the type.
   */
  readonly settingsSchema?: readonly RuntimeSettingField[];
  readonly activeRuns: number;
  readonly rolesRouted: readonly string[];
}

export interface IntegrationView {
  readonly integration: Integration;
  readonly health: { state: string; detail: string; checkedAt: string };
  readonly availableCapabilities: readonly { capability: string; risk: string; description: string }[];
  /** The catalog entry this was connected from, when it was. */
  readonly connectorId: string | null;
  /** The account connected, when the server told us. Never a secret. */
  readonly account: string | null;
  /** Whether it authenticates through a consent screen, and so can be reconnected. */
  readonly reconnectable: boolean;
}

/** A one-click integration in the gallery. */
export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly providerId: string;
  readonly authorization: 'oauth' | 'none';
  readonly usedBy: string;
  readonly homepage: string;
}

export type ConnectionStatus = 'waiting' | 'connecting' | 'connected' | 'failed' | 'cancelled';

/**
 * One attempt to connect an account.
 *
 * The renderer opens `authorizationUrl` in the user's browser and polls this
 * until it settles. Nothing that could finish the exchange - the PKCE verifier,
 * the registered client - is ever in it.
 */
export interface ConnectionAttemptView {
  readonly id: string;
  readonly status: ConnectionStatus;
  readonly name: string;
  readonly connectorId: string | null;
  readonly authorizationUrl: string | null;
  readonly integrationId: string | null;
  readonly error: string | null;
  readonly startedAt: string;
}

export interface ApprovalView {
  readonly approval: Approval;
  readonly missionTitle: string | null;
  readonly taskTitle: string | null;
  readonly roleName: string | null;
  /** Request changes on this card (or, on a card from before it, a reject with a note) starts the task's next round. */
  readonly revisable: boolean;
  /** Who the card is for. Advisory until accounts exist: anyone can still answer. */
  readonly addressees: readonly ActorRef[];
  readonly decidedByRef: ActorRef | null;
  readonly recordedByRef: ActorRef | null;
  readonly escalationLevel: number;
  /**
   * The headline of the first artifact the card cites as evidence, or that
   * artifact's summary when it predates handoffs. Lets an inbox line say what
   * is being approved without opening the document.
   */
  readonly headline: string | null;
}

/** A task waiting on a person, with just what an inbox line needs. */
export interface InboxTaskView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly assignee: ActorRef | null;
  readonly responsible: ActorRef | null;
  readonly claimable: readonly ActorRef[];
  readonly escalatedTo: readonly ActorRef[];
  readonly statusReason: string | null;
  readonly updatedAt: string;
}

/**
 * An agent step parked while a person continues it in another tool (spec A4):
 * it waits for their hand-back, not for the scheduler.
 */
export interface InboxParkedView {
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskTitle: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly tool: string;
  /** "Waiting for your work in Figma". */
  readonly title: string;
  /** When it was parked. */
  readonly since: string;
  /** Opens the mission at the parked step. */
  readonly href: string;
  /** The person who parked it; empty when the log does not say, which is everyone. */
  readonly forIds: readonly string[];
}

/**
 * Everything in a workspace waiting on a person, in one read: open approvals
 * and tasks parked for a human. The nav badge is always mounted, so this is
 * one projection rather than a mission detail per working mission.
 */
export interface InboxView {
  readonly approvals: readonly ApprovalView[];
  readonly tasks: readonly InboxTaskView[];
  /** DRAFT missions whose refinement waits on a person (P6). */
  readonly refinements: readonly InboxRefinementView[];
  /** Missions nothing moves and nothing asks about (P9). */
  readonly stalled: readonly InboxStalledView[];
  /** Runs quiet past their silent threshold and not snoozed (P9). */
  readonly silentRuns: readonly InboxSilentRunView[];
  /**
   * Agent steps parked elsewhere, waiting for a hand-back (spec A4). Optional
   * so an Inbox built before P3 still type-checks; a live one always sends it.
   */
  readonly parked?: readonly InboxParkedView[];
  /**
   * Intake signals waiting on a person: "Is this the same as GAR-12?" or past
   * the daily cap (intake plan Task 7). Optional, like `parked`.
   */
  readonly intakeDecisions?: readonly InboxIntakeDecisionView[];
  /** Missions whose tracker item someone else now holds (relay spec). */
  readonly unclaimed?: readonly InboxUnclaimedView[];
}

/** One DRAFT mission in the backlog, in pull order. */
export interface BacklogItemView {
  readonly summary: MissionSummary;
  readonly priority: MissionPriority;
  /** 1-based among queued missions, in backlog order; null when not queued. */
  readonly queuePosition: number | null;
  /** The readiness gate (P6) passes. */
  readonly ready: boolean;
  /** "Plan" when ready, else what is left to do. */
  readonly readinessLabel: string;
  /** A refinement pass is running on it, so it is not pulled yet. */
  readonly refining: boolean;
  /** Why the monthly spend rule holds it back (P8), or null. */
  readonly held: string | null;
}

/** The project's backlog and work in progress (P7). */
export interface BacklogView {
  readonly workspaceId: string;
  /** The work-in-progress limit; null when off. */
  readonly limit: number | null;
  /** Missions in progress: not DRAFT, not PAUSED, not finished. */
  readonly active: number;
  readonly queued: number;
  /** "Working on 1 of 2 · 3 queued". */
  readonly headline: string;
  /** What happens next, in one sentence. */
  readonly hint: string;
  readonly items: readonly BacklogItemView[];
}

/** One run of a routine, as its row lists it (P11). */
export interface RoutineRunView {
  readonly id: string;
  readonly trigger: RoutineTrigger;
  readonly ranAt: string;
  readonly outcome: RoutineOutcome;
  /** "Created “…”", "Skipped: previous run still active", "Missed 2 runs …". */
  readonly label: string;
  readonly missionId: string | null;
  readonly artifactId: string | null;
}

/** A routine with the words the window shows (P11); labels are the daemon's, from its clock. */
export interface RoutineView {
  readonly routine: Routine;
  /** "Every Monday at 09:00". */
  readonly scheduleLabel: string;
  /** "Next: Mon 09:00", or "Paused". */
  readonly nextRunLabel: string;
  /** The last outcome in words; null before the first run. */
  readonly lastLabel: string | null;
  /** The routine's unfinished mission, if any: why a run would be skipped. */
  readonly activeMissionId: string | null;
  /** The five newest runs, newest first. */
  readonly recent: readonly RoutineRunView[];
}

/** The test clock (only with TANDEMISE_CLOCK_OFFSET_MS). */
export interface TestClockView {
  readonly now: string;
  readonly offsetMs: number;
}

export interface WorkspaceView {
  readonly workspace: Workspace;
  readonly repositories: readonly Repository[];
  readonly roles: readonly RoleTemplate[];
}

export interface HomeView {
  readonly workspace: Workspace | null;
  readonly activeMissions: readonly MissionSummary[];
  readonly blockedMissions: readonly MissionSummary[];
  readonly recentMissions: readonly MissionSummary[];
  readonly pendingApprovals: readonly ApprovalView[];
  readonly runtimes: readonly RuntimeView[];
  readonly recentEvents: readonly RunEventRecord[];
  /** Missions and the project at or over a limit's warning level (P8). */
  readonly limitAlerts: readonly LimitAlertView[];
  /** The desk's numbers (P10); absent only when there is no project. */
  readonly metrics?: HomeMetricsView;
  /** What the numbers mean for what runs next (P10), in order. */
  readonly banners?: readonly HomeBannerView[];
}

/**
 * The owner's desk (P10): five numbers, each read from rows on every request.
 * Nothing here is stored.
 */
export interface HomeMetricsView {
  /** Open cards other than checks, steps parked for a person, refinements to decide, silent runs: for anyone. */
  readonly needsYou: number;
  /** Missions in progress: not DRAFT, not PAUSED, not finished (P7). */
  readonly active: number;
  /** The work-in-progress limit; null when off. */
  readonly wipLimit: number | null;
  readonly queued: number;
  /** P5's trace summed over the missions in progress: counted rows that PASS. */
  readonly criteriaVerified: number;
  readonly criteriaTotal: number;
  /** Missions in progress that have any counted criteria. */
  readonly criteriaMissions: number;
  /** The local month the monthly limits measure, "2026-09". */
  readonly month: string;
  /** The project's monthly limits measured now (P8); empty when none is set. */
  readonly monthUsage: readonly LimitStatusView[];
  /** The month's usage, limit or not. */
  readonly usage: UsageView;
  /** Missions nothing moves and nothing asks about (P9). */
  readonly stalled: number;
}

export interface HomeBannerView {
  /** month_warn: the monthly limit is at its warning level; wip_full: every slot taken, work queued. */
  readonly kind: 'month_warn' | 'wip_full';
  readonly text: string;
  /** Where the banner leads. */
  readonly href: string;
}

/** A status report was rendered and stored (P10). */
export interface StatusReportWritten {
  readonly artifactId: string;
  /** Its place in the project's line of reports, 1-based. */
  readonly version: number;
}

/** One limit as measured now (P8). */
export interface LimitStatusView extends LimitStatus {
  /** "Agent minutes". */
  readonly label: string;
  /** "15 / 30 agent min"; "not reported / $5.00" when the metric is not reported. */
  readonly bar: string;
  /** What this means for the person, when it means something: a warning, a stop, or why it cannot be measured. */
  readonly note: string | null;
}

export interface UsageView {
  readonly agentMinutes: number;
  /** Null when no runtime reported tokens. */
  readonly tokens: number | null;
  /** Null when no runtime reported a cost: never 0 for "not reported". */
  readonly costUsd: number | null;
  readonly runs: number;
}

export interface MissionLimitsView {
  /** Where its limits come from: its own, the project's defaults, or none set. */
  readonly source: 'mission' | 'project' | 'none';
  readonly limits: readonly LimitStatusView[];
  readonly usage: UsageView;
  /** The open "raise or keep paused" card, when work is stopped at a limit. */
  readonly pendingApprovalId: string | null;
}

export interface LimitAlertView {
  readonly scope: 'mission' | 'project';
  readonly missionId: string | null;
  readonly missionTitle: string | null;
  readonly level: 'soft' | 'hard';
  /** One sentence, numbers included, that says what happens next. */
  readonly text: string;
}

/** A project's usage for one local calendar month, against its monthly limits. */
export interface WorkspaceUsageView {
  readonly workspaceId: string;
  /** "2026-09". */
  readonly month: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly usage: UsageView;
  readonly limits: readonly LimitStatusView[];
  readonly defaultMissionLimits: readonly Limit[];
  /** What eval trials spent this month, already inside `usage`; null when their runtime reported no cost (P3b). */
  readonly evalCostUsd: number | null;
  readonly missions: readonly { readonly missionId: string; readonly title: string; readonly usage: UsageView }[];
}

export interface RepositoryProbe {
  readonly path: string;
  readonly isGitRepository: boolean;
  readonly name: string;
  readonly defaultBranch: string | null;
  readonly currentBranch: string | null;
  readonly remoteUrl: string | null;
  readonly isClean: boolean;
  readonly detectedChecks: {
    install: string | null; typecheck: string | null; lint: string | null;
    test: string | null; build: string | null;
    devServer: string | null; devServerUrl: string | null;
  };
  readonly languages: readonly string[];
  readonly warnings: readonly string[];
}

export interface RuntimeDiscoveryView extends RuntimeDiscovery {
  /** True when a profile already exists for this adapter. */
  readonly configured: boolean;
}

/**
 * A workflow this project can run.
 *
 * Covers both kinds without distinguishing them in the type: `path` is set for
 * one the team wrote and null for a built-in, which is the only difference that
 * matters to a caller - and the only one worth showing a user, who wants to
 * know whether the thing they are about to run is theirs.
 */
export interface WorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly path: string | null;
  readonly inputs: readonly { name: string; description: string | null; required: boolean }[];
  readonly steps: readonly { key: string; title: string; executor: 'agent' | 'human' | 'wait' | 'ship' }[];
  /** Non-empty when the file exists but cannot be used. */
  readonly issues: readonly { path: string; message: string }[];
}

// ------------------------------------------------------------ people and team

export interface PersonView extends Person {}

export interface MemberView extends Member {
  /** For an agent, the person it acts for; null for a person member. */
  readonly ownerName: string | null;
  /** Usable right now: not removed, and for an agent, its owner is not removed either. */
  readonly active: boolean;
}

export interface TeamView {
  readonly workspaceId: string;
  /** Removed members included, so work they left behind can still be named. */
  readonly members: readonly MemberView[];
  /** Where the tree starts: members with no manager, or whose manager has left. */
  readonly roots: readonly string[];
  /** What is wrong with the tree as it stands, e.g. an agent whose owner is gone. */
  readonly issues: readonly string[];
}

export interface MeView {
  readonly person: PersonView;
  readonly memberships: readonly { workspaceId: string; memberId: string; access: AccessLevel }[];
}

/** Who a task would go to if it became ready now, and who it escalates to. */
export interface StaffingPreviewView {
  readonly taskId: string;
  readonly resolved: {
    executor: 'agent' | 'human';
    assignee: ActorRef | null;
    responsible: ActorRef;
    claimable: readonly ActorRef[];
    agentCandidates: readonly ActorRef[];
  };
  readonly staffing: Staffing;
  readonly escalation: readonly ActorRef[];
}

// ---------------------------------------------------------------- skills (P13)

export interface SkillVersionView {
  readonly version: number;
  readonly hash: string;
  /** The first 12 hex characters. */
  readonly shortHash: string;
  readonly description: string;
  readonly files: readonly SkillFileEntry[];
  readonly sizeBytes: number;
  /** "3 files · 4.2 KB" */
  readonly sizeLabel: string;
  readonly importedAt: string;
}

/**
 * `current`: the source folder still matches the newest version. `update_available`:
 * it changed (Update imports it as a new version). `missing`: the folder is gone.
 * `unchecked`: a git source, checked only when the person clicks Update.
 */
export type SkillSourceStatus = 'current' | 'update_available' | 'missing' | 'unchecked';

export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  /** "~/.claude/skills/tdd", "/path/to/folder", "https://…/repo.git · skills/tdd" */
  readonly sourceLabel: string;
  readonly sourceStatus: SkillSourceStatus;
  readonly latest: SkillVersionView;
  /** Newest first. */
  readonly versions: readonly SkillVersionView[];
  /** Roles in this project that pin it, and at which version. */
  readonly usedBy: readonly { readonly roleId: string; readonly roleName: string; readonly version: number }[];
}

export interface SkillLibraryView {
  readonly skills: readonly SkillView[];
  /** Where "Your Claude skills" looks (~/.claude/skills unless overridden). */
  readonly discoverRoot: string;
}

/** What importing a folder would do. */
export interface SkillPreviewView {
  readonly source: SkillSource;
  readonly sourceLabel: string;
  /** Null when the folder has no usable name (the problem says why). */
  readonly name: string | null;
  readonly description: string;
  /** Null when the folder was refused before it was read. */
  readonly hash: string | null;
  readonly shortHash: string | null;
  readonly files: readonly SkillFileEntry[];
  readonly sizeBytes: number;
  readonly sizeLabel: string;
  /** The SKILL.md as written, front matter included; null when there is none. */
  readonly skillMd: string | null;
  /** Why it cannot be imported; null when it can. */
  readonly problem: string | null;
  /** "New skill", "New version v2 of tdd", "Already in the library as tdd v1". */
  readonly outcome: string;
  /** False when the content is already a version in the library. */
  readonly changes: boolean;
}

/** Where discovered skills were found (#129): your skills, an installed plugin, a repository. */
export interface DiscoveredSkillOriginView {
  readonly id: string;
  readonly kind: 'personal' | 'plugin' | 'project';
  /** "Your skills", "Plugin acme 1.2.3", "Repository web". */
  readonly label: string;
  /** The plugin's marketplace; null otherwise. */
  readonly detail: string | null;
  /** The folder read. */
  readonly root: string;
}

export interface DiscoveredSkillView {
  /** The folder's name under its root; `group/skill` for a skill inside a grouping folder. */
  readonly folder: string;
  readonly path: string;
  /** Which of `origins` it was found in. */
  readonly originId: string;
  /**
   * How Claude Code invokes it: `acme:hello` for a plugin's, the folder name
   * otherwise. Null for a skill inside a grouping folder: Claude Code loads
   * only top-level folders, so it reaches a worker only by importing it.
   */
  readonly invocation: string | null;
  /** Its name in the library (`<plugin>-<skill>` for a plugin's). */
  readonly name: string | null;
  readonly description: string;
  readonly hash: string | null;
  readonly sizeLabel: string;
  readonly fileCount: number;
  readonly problem: string | null;
  /** "In library as tdd v1", "Newer than tdd v1 in the library", or null when it is not in the library. */
  readonly libraryLabel: string | null;
  /** False when this exact content is already in the library (nothing to import). */
  readonly importable: boolean;
}

export interface DiscoveredSkillsView {
  /** Where your own skills are looked for (~/.claude/skills unless overridden). */
  readonly root: string;
  /** False when that folder does not exist. */
  readonly exists: boolean;
  /** Where the skills below were found, in the order they are listed. */
  readonly origins: readonly DiscoveredSkillOriginView[];
  readonly skills: readonly DiscoveredSkillView[];
}

export interface SkillImportView {
  readonly skill: SkillView;
  readonly version: number;
  /** `skill`: a new skill; `version`: a new version of an existing one; `unchanged`: the content was already there. */
  readonly created: 'skill' | 'version' | 'unchanged';
  /** "Imported tdd v1", "Imported tdd v2", "tdd v1 already has these files". */
  readonly message: string;
}

export interface SkillVersionDetailView extends SkillVersionView {
  readonly skillId: string;
  readonly name: string;
  /** Null when the stored content is missing. */
  readonly skillMd: string | null;
}

// -------------------------------------------------------------------- evals (P3b)
//
// `@tandemise/evaluation` (the scorecard's own home) sits above `api-contract`
// in the layering (`npm run check:boundaries`), so `Scorecard` and
// `RoleModelSummary` cannot be imported here; their shapes are restated
// structurally instead, matching @tandemise/evaluation/src/scorecard.ts.

export interface EvalSuiteView {
  readonly id: string;
  readonly name: string;
  readonly cases: number;
  readonly createdAt: string;
}

export interface EvalCaseView {
  readonly id: string;
  readonly suiteId: string;
  readonly name: string;
  readonly baseSha: string;
  readonly repositoryId: string;
  readonly roleId: string;
  readonly stepTitle: string;
  readonly inputs: readonly { readonly type: ArtifactType; readonly title: string }[];
  readonly criteria: number;
  readonly source: {
    readonly missionId: string;
    readonly missionTitle: string;
    readonly taskId: string;
    /** False once the source mission has since been removed; the case itself still replays fine. */
    readonly missionExists: boolean;
  };
  readonly createdAt: string;
}

export interface EvalTrialView {
  readonly id: string;
  readonly caseId: string;
  readonly caseName: string;
  readonly variant: 'baseline' | 'candidate';
  readonly repeat: number;
  readonly status: EvalTrialStatus;
  readonly reason: string | null;
}

/** Structural copy of `@tandemise/evaluation`'s `VariantScore`. */
export interface VariantScoreView {
  /** `failed` is completed trials whose gate did not pass; `errored` is failed trials with no score. */
  readonly trials: { readonly completed: number; readonly blocked: number; readonly failed: number; readonly errored: number };
  readonly gatePassRate: number | null;
  readonly firstAttemptPassRate: number | null;
  readonly criteria: CriteriaCounts | null;
  readonly meanAttempts: number | null;
  readonly overBudget: number;
  readonly tokens: { readonly mean: number | null; readonly total: number | null };
  readonly costUsd: { readonly mean: number | null; readonly total: number | null };
  readonly wallTimeMs: { readonly mean: number | null; readonly total: number | null };
}

/** Structural copy of `@tandemise/evaluation`'s `ScorecardDifference`. */
export interface ScorecardDifferenceView {
  readonly gatePassRate: number | null;
  readonly firstAttemptPassRate: number | null;
  readonly meanAttempts: number | null;
  readonly overBudget: number;
  readonly meanTokens: number | null;
  readonly meanCostUsd: number | null;
  readonly meanWallTimeMs: number | null;
}

/** Structural copy of `@tandemise/evaluation`'s `Scorecard`, an eval run's baseline-vs-candidate result. */
export interface Scorecard {
  readonly baseline: VariantScoreView;
  readonly candidate: VariantScoreView;
  readonly difference: ScorecardDifferenceView;
  readonly perCase: readonly {
    readonly caseId: string;
    readonly name: string;
    readonly baseline: VariantScoreView;
    readonly candidate: VariantScoreView;
    readonly difference: ScorecardDifferenceView;
  }[];
  readonly fewRepeats: boolean;
}

export interface EvalRunView {
  readonly id: string;
  readonly suiteId: string;
  readonly status: EvalRunStatus;
  readonly reason: string | null;
  readonly repeats: number;
  readonly spendCapUsd: number;
  /**
   * The measured spend: a lower bound when `costUnmeasured`. Null only when no finished run
   * reported a cost at all: unknown is never $0.
   */
  readonly spentUsd: number | null;
  /** True when a finished trial reported no cost, so the cap may not stop this run in time. */
  readonly costUnmeasured: boolean;
  readonly candidate: EvalCandidate;
  /** `done` counts trials with an outcome other than cancelled; `cancelled` counts the rest that ended. */
  readonly progress: { readonly done: number; readonly total: number; readonly cancelled: number };
  readonly trials: readonly EvalTrialView[];
  readonly scorecard: Scorecard | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Structural copy of `@tandemise/evaluation`'s `RoleModelSummary`, the "From your runs" row. */
export interface RoleModelSummary {
  readonly roleId: string;
  readonly model: string | null;
  readonly runs: number;
  readonly firstAttemptPassRate: number | null;
  readonly meanAttemptsToPass: number | null;
  readonly criteriaFailed: number;
  readonly medianCostUsd: number | null;
  readonly medianWallTimeMs: number | null;
}

export type RoleModelSummaryView = RoleModelSummary;

// ---- coordination (the optional relay, docs/superpowers/specs/2026-10-30-relay-design.md)

/** Where this install's coordination stands: local only, or with a team relay. */
export type CoordinationStatusView =
  | { readonly kind: 'local' }
  | { readonly kind: 'connected'; readonly host: string; readonly teamName: string; readonly role: 'admin' | 'member'; readonly memberId: string; readonly offerImport: boolean }
  | { readonly kind: 'offline'; readonly since: string; readonly pendingOps: number; readonly host: string; readonly teamName: string; readonly role: 'admin' | 'member'; readonly memberId: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly host: string };

/** One row of "Who's working on what". */
export interface CoordinationClaimRowView {
  readonly claimId: string;
  readonly memberName: string;
  readonly mine: boolean;
  readonly presence: 'online' | 'away' | 'offline';
  readonly itemKey: string;
  readonly itemTitle: string;
  readonly itemUrl: string | null;
  /** "10:42", in the daemon's time zone. */
  readonly since: string;
  readonly startedAt: string;
  readonly stale: boolean;
  readonly staleLabel: string | null;
  readonly sync: 'confirmed' | 'pending' | 'conflicted' | null;
  /** The mission this row is tied to on this machine, when it is yours. */
  readonly missionId: string | null;
}

/** How a mission's tracker item stands with the team. */
export interface MissionClaimView {
  readonly claimId: string;
  readonly itemKey: string;
  readonly state: 'held' | 'pending' | 'unclaimed';
  readonly sentence: string;
  readonly mayTakeBack: boolean;
}

/** A mission whose claim was lost, waiting on the person's choice. */
export interface InboxUnclaimedView {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly claimId: string;
  readonly itemKey: string;
  readonly sentence: string;
  readonly mayTakeBack: boolean;
  readonly forIds: readonly string[];
}
