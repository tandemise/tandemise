import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectionTopic, RunEventRecord } from '@tandemise/domain';
import type { TaskFeedbackView } from '@tandemise/api-contract';
import { useDaemon } from './connection.js';
import { useWorkspaceId } from './workspace.js';
import type { DaemonClient } from './daemon.js';

/**
 * Query keys, centralised.
 *
 * The daemon's `invalidate` messages arrive as coarse topics, so the key shape
 * has to line up with those topics exactly - `TOPIC_KEYS` below is the
 * translation, and it only stays correct if every key is minted here.
 */
/**
 * Workspace-scoped keys carry the workspace id last, so switching project
 * refetches instead of showing the previous one's data. The id goes last
 * because `invalidateTopic` matches on the key's first element.
 */
export const keys = {
  system: ['system'] as const,
  home: (ws?: string) => ['home', ws ?? 'all'] as const,
  workspaces: ['workspaces'] as const,
  missions: (filter?: string, ws?: string) => ['missions', filter ?? 'all', ws ?? 'all'] as const,
  // Under 'missions': every mission change, a pull included, refreshes it.
  backlog: (ws?: string) => ['missions', 'backlog', ws ?? 'all'] as const,
  // Under 'missions' too: a routine adding a mission, or skipping one, is a missions change.
  routines: (ws?: string) => ['missions', 'routines', ws ?? 'all'] as const,
  // Under 'missions' too: a check adds drafts, and the chips on missions read it.
  issues: (ws?: string) => ['missions', 'issues', ws ?? 'all'] as const,
  // Under 'workspaces': a changed limit refreshes it; runs finishing are picked up by its interval.
  usage: (ws?: string) => ['workspaces', 'usage', ws ?? 'all'] as const,
  // Under 'workspaces': a saved role changes "Used by", and it refreshes with the roles.
  skills: (ws?: string) => ['workspaces', 'skills', ws ?? 'all'] as const,
  skillsFound: (ws?: string) => ['workspaces', 'skills-found', ws ?? 'all'] as const,
  skillVersion: (id: string, version: number) => ['workspaces', 'skill-version', id, String(version)] as const,
  // Under 'workspaces': an export or an import changes what it says.
  setup: (ws?: string) => ['workspaces', 'setup', ws ?? 'all'] as const,
  // Under 'workspaces': writing the defaults changes where the files come from; routing moves as outcomes land.
  factory: (ws?: string) => ['workspaces', 'factory', ws ?? 'all'] as const,
  routing: (ws?: string) => ['workspaces', 'routing', ws ?? 'all'] as const,
  mergePolicy: (ws?: string) => ['workspaces', 'merge-policy', ws ?? 'all'] as const,
  // The brain (#51): under 'workspaces', so a sync, a link or a lesson refreshes them.
  brain: (ws?: string) => ['workspaces', 'brain', ws ?? 'all'] as const,
  brainEntries: (ws: string | undefined, q: string) => ['workspaces', 'brain-entries', ws ?? 'all', q] as const,
  brainProposals: (ws?: string) => ['workspaces', 'brain-proposals', ws ?? 'all'] as const,
  brainFactory: (ws?: string) => ['workspaces', 'brain-factory', ws ?? 'all'] as const,
  // Under 'mission': a run's record moves with the mission it belongs to.
  runBrain: (runId: string) => ['mission', 'run-brain', runId] as const,
  mission: (id: string) => ['mission', id] as const,
  // Under 'mission' and scoped by id, so the mission's own invalidations refresh it.
  missionArtifacts: (id: string, all: boolean) => ['mission', id, 'artifacts', all ? 'all' : 'live'] as const,
  // Under 'mission' too: a feed changes on exactly the topics the mission detail does.
  missionFeed: (id: string, doneLimit: number | 'all') => ['mission', id, 'feed', String(doneLimit)] as const,
  // Under 'mission' too: artifacts and tasks changing refresh it with the rest of the mission.
  missionCriteria: (id: string) => ['mission', id, 'criteria'] as const,
  missionRefinement: (id: string) => ['mission', id, 'refinement'] as const,
  // Under 'mission' too: planning, a lane switch and the ship step all change the mission's tasks.
  planDecision: (id: string) => ['mission', id, 'plan-decision'] as const,
  ship: (id: string) => ['mission', id, 'ship'] as const,
  missionEvents: (id: string) => ['mission-events', id] as const,
  // Not under 'mission': the drawer and the reader read it outside a mission's screen, so it is refreshed with every task change.
  taskFeedback: (id: string) => ['mission-task-feedback', id] as const,
  approvals: (ws?: string) => ['approvals', ws ?? 'all'] as const,
  inbox: (ws?: string) => ['inbox', ws ?? 'all'] as const,
  artifacts: (q: string, ws?: string) => ['artifacts', q, ws ?? 'all'] as const,
  artifact: (id: string) => ['artifact', id] as const,
  runtimes: (ws?: string) => ['runtimes', ws ?? 'all'] as const,
  roles: (ws?: string) => ['roles', ws ?? 'all'] as const,
  integrations: (ws?: string) => ['integrations', ws ?? 'all'] as const,
  workflows: (ws?: string) => ['workflows', ws ?? 'all'] as const,
  settings: ['settings'] as const,
  me: ['me'] as const,
  team: (ws?: string) => ['team', ws ?? 'all'] as const,
  staffing: (ws?: string) => ['staffing', ws ?? 'all'] as const,
  // Evals (P3b): no stream topic reaches these yet, so a run's own poll (useEvalRun) is what moves them along.
  evalSuites: (ws?: string) => ['evals', 'suites', ws ?? 'all'] as const,
  evalCases: (suiteId: string) => ['evals', 'cases', suiteId] as const,
  evalRuns: (suiteId: string) => ['evals', 'runs', suiteId] as const,
  evalRun: (id: string) => ['evals', 'run', id] as const,
  runScoreSummary: (ws: string | undefined, days: 7 | 30 | 90) => ['evals', 'run-scores', ws ?? 'all', String(days)] as const,
  // Intake (plan Task 14): under 'intake', which every signal, board and closure change invalidates.
  board: (ws?: string) => ['intake', 'board', ws ?? 'all'] as const,
  intakeSignals: (ws?: string) => ['intake', 'signals', ws ?? 'all'] as const,
  intakeConfig: (ws?: string) => ['intake', 'config', ws ?? 'all'] as const,
};

const TOPIC_KEYS: Readonly<Record<ProjectionTopic, readonly (readonly string[])[]>> = {
  // A mission's status alone can make it stalled, which is an Inbox row (P9).
  // The Board shows each item's mission status in words (intake), so it follows too.
  missions: [['home'], ['missions'], ['mission'], ['inbox'], ['intake', 'board']],
  // A step's reason is the Board's "Waiting for a free slot on …" (#101), so the Board follows tasks too.
  tasks: [['mission'], ['home'], ['inbox'], ['mission-task-feedback'], ['intake', 'board']],
  // A decided review card or check can record a note, so a task's thread follows approvals too.
  approvals: [['approvals'], ['home'], ['mission'], ['inbox'], ['mission-task-feedback']],
  artifacts: [['artifacts'], ['mission'], ['artifact']],
  runtimes: [['runtimes'], ['home']],
  integrations: [['integrations']],
  targets: [['mission']],
  // Members and staffing have no topic of their own; they change with the workspace.
  // Roles too: a saved role was never re-read, so the editor kept saying "Unsaved changes" after a save.
  workspaces: [['workspaces'], ['home'], ['settings'], ['workflows'], ['team'], ['staffing'], ['me'], ['roles']],
  decisions: [['mission']],
  checks: [['mission'], ['home']],
  criteria: [['mission']],
  // A refinement decision changes the mission's readiness and the inbox row that asks for it.
  // The backlog shows each draft's readiness too.
  refinement: [['mission'], ['inbox'], ['home'], ['missions']],
  // A pull request opened (#53): the ship card, and later the Inbox's review rows.
  ship: [['mission'], ['inbox']],
  // A signal that needs a decision is an Inbox card (intake, plan Task 7).
  intake: [['inbox'], ['home'], ['intake']],
  // Claims with the team: Home's "Who's working on what", a mission's claim banner and its Inbox row.
  coordination: [['coordination'], ['mission'], ['inbox'], ['team']],
};

export function invalidateTopic(
  queryClient: ReturnType<typeof useQueryClient>,
  topic: ProjectionTopic,
  missionId?: string,
): void {
  for (const key of TOPIC_KEYS[topic] ?? []) {
    const scoped = missionId && (key[0] === 'mission' || key[0] === 'mission-events') ? [...key, missionId] : key;
    void queryClient.invalidateQueries({ queryKey: scoped });
  }
}

// ------------------------------------------------------------------ queries

export function useSystem() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.system, queryFn: () => daemon.system(), staleTime: 60_000 });
}

export function useHome() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.home(workspaceId), queryFn: () => daemon.home(workspaceId) });
}

export function useWorkspaces() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.workspaces, queryFn: () => daemon.workspaces(), staleTime: 30_000 });
}

export function useMissions(status?: string) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.missions(status, workspaceId),
    queryFn: () => daemon.missions({ workspaceId, ...(status ? { status: status as never } : {}) }),
  });
}

/** This month's usage against the project's monthly limits (P8). */
export function useWorkspaceUsage() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.usage(workspaceId),
    queryFn: () => daemon.workspaceUsage(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
}

/** Setup as code (P15): the last export of this project from this machine. */
export function useSetupStatus() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.setup(workspaceId),
    queryFn: () => daemon.setupStatus(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
  });
}

/** Project → Factory (#53): the factory files and where each came from. */
export function useFactory() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.factory(workspaceId), queryFn: () => daemon.factory(workspaceId ?? ''), enabled: Boolean(workspaceId) });
}

/** Project → Merge: the merge policy (#53 §8.4). */
export function useMergePolicy() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.mergePolicy(workspaceId), queryFn: () => daemon.mergePolicy(workspaceId ?? ''), enabled: Boolean(workspaceId) });
}

/** Project → Factory → Routing: measured outcomes per step class and bucket. */
export function useRouting() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.routing(workspaceId), queryFn: () => daemon.routing(workspaceId ?? ''), enabled: Boolean(workspaceId), refetchInterval: 30_000 });
}

/** The project's brain: link, sync and counts (#51). */
export function useBrain() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.brain(workspaceId), queryFn: () => daemon.brain(workspaceId ?? ''), enabled: Boolean(workspaceId) });
}

export function useBrainEntries(q: { scope?: string; state?: string; history?: boolean }, enabled = true) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.brainEntries(workspaceId, JSON.stringify(q)),
    queryFn: () => daemon.brainEntries(workspaceId ?? '', q),
    enabled: Boolean(workspaceId) && enabled,
  });
}

export function useBrainProposals(enabled = true) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.brainProposals(workspaceId), queryFn: () => daemon.brainProposals(workspaceId ?? ''), enabled: Boolean(workspaceId) && enabled, refetchInterval: 5_000 });
}

export function useBrainFactory(enabled = true) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.brainFactory(workspaceId), queryFn: () => daemon.brainFactory(workspaceId ?? ''), enabled: Boolean(workspaceId) && enabled });
}

export function useRunBrain(runId: string | null) {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.runBrain(runId ?? ''), queryFn: () => daemon.runBrain(runId ?? ''), enabled: runId !== null });
}

/** The project's backlog and work-in-progress limit (P7). */
export function useBacklog() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.backlog(workspaceId),
    queryFn: () => daemon.backlog(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    placeholderData: (previous) => previous,
  });
}

/**
 * The project's skills library (P13). Polled while the screen is open: "Update
 * available" is the daemon re-reading each local source folder.
 */
export function useSkills(poll = false) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.skills(workspaceId),
    queryFn: () => daemon.skills(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    ...(poll ? { refetchInterval: 5_000 } : {}),
    placeholderData: (previous) => previous,
  });
}

/** What the discovery root holds (~/.claude/skills unless configured otherwise). */
export function useDiscoveredSkills(enabled: boolean) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.skillsFound(workspaceId),
    queryFn: () => daemon.discoverSkills(workspaceId ?? ''),
    enabled: enabled && Boolean(workspaceId),
  });
}

export function useSkillVersion(skillId: string | null, version: number | null) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.skillVersion(skillId ?? '', version ?? 0),
    queryFn: () => daemon.skillVersion(skillId ?? '', version ?? 1),
    enabled: skillId !== null && version !== null,
  });
}

/** GitHub issue sync (P14). Polled: "Last checked 2 min ago" is the daemon's word for its own clock. */
export function useIssues() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.issues(workspaceId),
    queryFn: () => daemon.issues(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
}

/** The project's routines (P11). Polled: "Next: Mon 09:00" is the daemon's word for its own clock. */
export function useRoutines() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.routines(workspaceId),
    queryFn: () => daemon.routines(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
}

/** Where coordination stands: local only, or with a team relay. Polled: "Offline since" is the daemon's word. */
export function useCoordinationStatus() {
  const daemon = useDaemon();
  return useQuery({
    queryKey: ['coordination', 'status'] as const,
    queryFn: () => daemon.coordinationStatus(),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
}

/** "Who's working on what" in this project. */
export function useCoordinationClaims() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: ['coordination', 'claims', workspaceId ?? ''] as const,
    queryFn: () => daemon.coordinationClaims(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    placeholderData: (previous) => previous,
  });
}

export function useMission(id: string) {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.mission(id), queryFn: () => daemon.mission(id), enabled: id.length > 0 });
}

/**
 * The most finished cards one feed request may ask for: the daemon refuses a
 * larger `doneLimit`. "Show all" asks for this many, so a mission with more
 * finished work than this shows the latest ones and says so.
 */
/** The Done-when ledger of a mission: criteria, what covers them, and what QA found. */
export function useMissionCriteria(id: string) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionCriteria(id),
    queryFn: () => daemon.missionCriteria(id),
    enabled: id.length > 0,
    placeholderData: (previous) => previous,
  });
}

/** A DRAFT mission's refinement: proposals, questions and whether it is ready to plan. */
export function useMissionRefinement(id: string, enabled = true) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionRefinement(id),
    queryFn: () => daemon.missionRefinement(id),
    enabled: enabled && id.length > 0,
    placeholderData: (previous) => previous,
    // The stream says when a pass lands; polling while one runs covers a dropped frame.
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 2_000 : false),
  });
}

/** "Why these steps" for a mission the factory planned; null before it is planned. */
export function usePlanDecision(id: string) {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.planDecision(id), queryFn: () => daemon.planDecision(id), enabled: id.length > 0, placeholderData: (previous) => previous });
}

/** The ship step and the pull requests it opened (#53). */
export function useShip(id: string, enabled = true) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.ship(id),
    queryFn: () => daemon.ship(id),
    enabled: enabled && id.length > 0,
    placeholderData: (previous) => previous,
    // Opening takes a push and a `gh` call; polling while it does covers a dropped frame.
    refetchInterval: (query) => (query.state.data?.stage === 'opening' ? 2_000 : false),
  });
}

export const FEED_ALL_DONE_LIMIT = 500;

/**
 * A mission's feed of short cards. `doneLimit: 'all'` lists finished cards up to
 * `FEED_ALL_DONE_LIMIT`, for "Show N more"; the default keeps the list to the daemon's latest few.
 */
export function useMissionFeed(id: string, doneLimit: number | 'all' = 5) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionFeed(id, doneLimit),
    queryFn: () => daemon.missionFeed(id, doneLimit === 'all' ? { doneLimit: FEED_ALL_DONE_LIMIT } : { doneLimit }),
    enabled: id.length > 0,
    // Keeps the cards on screen while "Show N more" fetches the longer list, instead of flashing a skeleton.
    placeholderData: (previous) => previous,
  });
}

export function useMissionEvents(id: string): UseQueryResult<readonly RunEventRecord[]> {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionEvents(id),
    queryFn: () => daemon.missionEvents(id, { limit: 500 }),
    enabled: id.length > 0,
  });
}

/** A task's feedback thread and the round its open notes wait on. */
export function useTaskFeedback(taskId: string | null): UseQueryResult<TaskFeedbackView> {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.taskFeedback(taskId ?? ''),
    queryFn: () => daemon.taskFeedback(taskId as string),
    enabled: Boolean(taskId),
  });
}

export function useApprovals() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.approvals(workspaceId), queryFn: () => daemon.approvals(workspaceId) });
}

/** Everything waiting on a person in this project. Behind the always-mounted nav badge, so one request. */
/**
 * The project's board, from the tracker cache (intake spec §7). The daemon
 * refreshes it on its own tick; a mission's status on a row follows missions.
 */
export function useBoard() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.board(workspaceId),
    queryFn: () => daemon.board(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
    placeholderData: (previous) => previous,
  });
}

/** Every signal the project recorded, newest first (intake spec §7, the Intake tab). */
export function useIntakeSignals() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.intakeSignals(workspaceId),
    queryFn: () => daemon.intakeSignals(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    refetchInterval: 10_000,
    placeholderData: (previous) => previous,
  });
}

/** The project's tracker and sources, and whether they are edited here or in the brain. */
export function useIntakeConfig() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.intakeConfig(workspaceId),
    queryFn: () => daemon.intakeConfig(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
  });
}

export function useInboxView() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.inbox(workspaceId),
    queryFn: () => daemon.inbox(workspaceId as string),
    enabled: workspaceId !== undefined,
  });
}

export function useArtifactSearch(query: string) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.artifacts(query, workspaceId),
    queryFn: () => daemon.artifacts({ workspaceId, q: query || undefined }),
  });
}

/** A mission's artifacts: live versions only, or every version when `includeSuperseded`. */
export function useMissionArtifacts(missionId: string, includeSuperseded: boolean) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionArtifacts(missionId, includeSuperseded),
    queryFn: () => daemon.missionArtifacts(missionId, includeSuperseded ? { includeSuperseded: true } : undefined),
    // Keeps the rows on screen while the toggle fetches the other set, instead of flashing a skeleton.
    placeholderData: (previous) => previous,
  });
}

export function useArtifact(id: string | null) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.artifact(id ?? ''),
    queryFn: () => daemon.artifact(id as string),
    enabled: Boolean(id),
  });
}

export function useRuntimes() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.runtimes(workspaceId), queryFn: () => daemon.runtimes(workspaceId) });
}

export function useRoles() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.roles(workspaceId), queryFn: () => daemon.roles(workspaceId), staleTime: 30_000 });
}

/** The one-click catalog. It changes only when the daemon does. */
export function useConnectors() {
  const daemon = useDaemon();
  return useQuery({ queryKey: ['integrations', 'connectors'], queryFn: () => daemon.connectors(), staleTime: 5 * 60_000 });
}

export function useIntegrations() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.integrations(workspaceId), queryFn: () => daemon.integrations(workspaceId) });
}

/**
 * What this project can run.
 *
 * Its own workflow files come first; the built-in presets fill in behind them.
 * Refetched on a short stale time because a workflow is a file the user edits
 * in another window - waiting for a restart to see a change they just saved is
 * exactly the friction that makes an authoring format feel dead.
 */
export function useWorkflows() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.workflows(workspaceId),
    queryFn: () => daemon.workflows(workspaceId as string),
    enabled: workspaceId !== undefined,
    staleTime: 5_000,
  });
}

export function useSettings() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.settings, queryFn: () => daemon.settings(), staleTime: 30_000 });
}

// ------------------------------------------------------------ team and people

export function useMe() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.me, queryFn: () => daemon.me(), staleTime: 60_000 });
}

/** The principal's member id in the selected project; "for me" is judged against it. */
export function useMyMemberId(): string | null {
  const workspaceId = useWorkspaceId();
  return useMe().data?.memberships.find((m) => m.workspaceId === workspaceId)?.memberId ?? null;
}

export function useTeam() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.team(workspaceId),
    queryFn: () => daemon.team(workspaceId as string),
    enabled: workspaceId !== undefined,
    // No stream topic covers members yet, so a screen that shows the team refetches on open.
    staleTime: 0,
  });
}

export function useStaffing() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.staffing(workspaceId),
    queryFn: () => daemon.getStaffing(workspaceId as string),
    enabled: workspaceId !== undefined,
  });
}

// -------------------------------------------------------------------- evals (P3b)

export function useEvalSuites() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.evalSuites(workspaceId),
    queryFn: () => daemon.evalSuites(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
  });
}

export function useEvalCases(suiteId: string | null) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.evalCases(suiteId ?? ''),
    queryFn: () => daemon.evalCases(suiteId ?? ''),
    enabled: suiteId !== null,
  });
}

export function useEvalRuns(suiteId: string | null) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.evalRuns(suiteId ?? ''),
    queryFn: () => daemon.evalRuns(suiteId ?? ''),
    enabled: suiteId !== null,
  });
}

/** A run's own detail, polled every 2s while it may still be going - nothing streams its progress yet. */
export function useEvalRun(id: string | null, options: { readonly poll: boolean } = { poll: false }) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.evalRun(id ?? ''),
    queryFn: () => daemon.evalRun(id ?? ''),
    enabled: id !== null,
    ...(options.poll ? { refetchInterval: 2_000 } : {}),
  });
}

/** "From your runs" (spec B1): real-run summaries by role and model. */
export function useRunScoreSummary(days: 7 | 30 | 90 = 30) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.runScoreSummary(workspaceId, days),
    queryFn: () => daemon.runScoreSummary(workspaceId ?? '', days),
    enabled: Boolean(workspaceId),
  });
}

// ---------------------------------------------------------------- mutations

/**
 * A mutation that refreshes whatever the daemon would have invalidated anyway.
 * The socket will usually beat this, but a user who acts while the socket is
 * reconnecting still sees their change land.
 */
export function useDaemonMutation<TArgs, TResult>(
  run: (daemon: DaemonClient, args: TArgs) => Promise<TResult>,
  topics: readonly ProjectionTopic[],
  missionId?: string,
  /** Runs on success even when the component that started it has unmounted, unlike `mutate`'s own callback. */
  onSuccess?: (result: TResult) => void,
) {
  const daemon = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => run(daemon, args),
    onSuccess: (result) => {
      for (const topic of topics) invalidateTopic(queryClient, topic, missionId);
      onSuccess?.(result);
    },
  });
}
