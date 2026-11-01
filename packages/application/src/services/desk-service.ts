import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, ArtifactStorePort, EventRepositoryPort, LimitStatus, MemberRepositoryPort, Mission,
  MissionRepositoryPort, MissionTask, StatusReportBacklogItem, StatusReportFacts, StatusReportMission, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import {
  REPORT_HOLDER_PRESET, REPORT_HOLDER_TITLE, SYSTEM_ACTOR, compareBacklog, isInProgress, isTerminalMissionStatus, isTrialMission, monthBannerText,
  renderStatusReport, statusReportHeadline, statusReportPoints, statusReportTitle, wipBannerText,
} from '@tandemise/domain';
import type {
  BacklogView, HomeBannerView, HomeMetricsView, LimitStatusView, StatusReportWritten, WorkspaceUsageView,
} from '@tandemise/api-contract';
import type { Clock, MissionId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import type { ArtifactMeasurePort, ArtifactParserPort } from '../ports.js';
import type { GateService } from '../engine/gates.js';
import type { LimitService } from './limit-service.js';
import type { LivenessService } from './liveness-service.js';
import type { ReadinessService } from './readiness.js';
import type { EventRecorder } from '../support/event-recorder.js';
import type { Caller } from '../support/identity.js';
import { versionLines } from '../support/artifact-versions.js';
import { parkedExternalOf } from '../support/outside-work.js';

export interface DeskDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly events: EventRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly parser: ArtifactParserPort;
  readonly measure: ArtifactMeasurePort;
  /** P5's trace: the checklist, the gates and the desk read the same one. */
  readonly gates: Pick<GateService, 'trace'>;
  readonly limits: Pick<LimitService, 'usage' | 'missionView'>;
  readonly liveness: Pick<LivenessService, 'classify' | 'stalled' | 'silentRuns'>;
  /** Drafts with something to decide (P6). */
  readonly readiness: Pick<ReadinessService, 'counts'>;
  /** Resolved per call: the backlog is composed with projections, which read this. */
  readonly backlog: (workspaceId: WorkspaceId) => BacklogView;
  readonly recorder: EventRecorder;
  /** The instant a report's facts were read comes from here, never from the system clock. */
  readonly clock: Clock;
}

/**
 * The owner's desk (P10 spec §1-§2).
 *
 * Home's five numbers and the status report are both read from rows, through
 * the services that already own each fact - the backlog (P7) for work in
 * progress, the trace (P5) for criteria, limits (P8) for spend, liveness (P9)
 * for what is stuck - so the desk can never disagree with the screen behind a
 * number. Nothing is stored except the report itself, and the report is a pure
 * function of the facts gathered here.
 */
export class DeskService {
  constructor(private readonly deps: DeskDeps) {}

  metrics(workspaceId: WorkspaceId): HomeMetricsView {
    this.#requireWorkspace(workspaceId);
    const backlog = this.deps.backlog(workspaceId);
    const criteria = this.#criteriaInProgress(workspaceId);
    const month = this.deps.limits.usage(workspaceId);
    return {
      needsYou: this.#needsAPerson(workspaceId),
      active: backlog.active,
      wipLimit: backlog.limit,
      queued: backlog.queued,
      criteriaVerified: criteria.verified,
      criteriaTotal: criteria.counted,
      criteriaMissions: criteria.missions,
      month: month.month,
      monthUsage: month.limits,
      usage: month.usage,
      stalled: this.deps.liveness.stalled(workspaceId).length,
    };
  }

  /**
   * What waits on a person, for anyone: the Inbox's items minus checks (they
   * wait on nobody) and minus stalled rows (counted apart). Counted from rows
   * rather than by building the Inbox, which would name every card a second
   * time on the same Home read.
   */
  #needsAPerson(workspaceId: WorkspaceId): number {
    const cards = this.deps.approvals.list({ workspaceId, statuses: ['PENDING'] }).filter((a) => a.kind !== 'check').length;
    // An eval trial's steps never wait on a person (P3b); they are skipped like its missions are in every list.
    const steps = this.deps.tasks.listByStatus(['AWAITING_HUMAN'])
      .filter((t) => this.#ownedBy(t.missionId, workspaceId)).length;
    // A step parked in another tool waits for the person's hand-back (spec A4).
    const parked = this.deps.tasks.listByStatus(['AWAITING_EXTERNAL'])
      .filter((t) => this.#ownedBy(t.missionId, workspaceId) && this.#isParked(t)).length;
    const refinements = this.deps.missions.list({ workspaceId, statuses: ['DRAFT'] }).filter((m) => {
      const counts = this.deps.readiness.counts(m.id);
      return counts.openQuestions + counts.proposedPending > 0;
    }).length;
    return cards + steps + parked + refinements + this.deps.liveness.silentRuns(workspaceId).length;
  }

  /** A real mission of this workspace: never an eval trial's, which no person is asked about. */
  #ownedBy(missionId: MissionTask['missionId'], workspaceId: WorkspaceId): boolean {
    const mission = this.deps.missions.get(missionId);
    return mission !== undefined && mission.workspaceId === workspaceId && !isTrialMission(mission);
  }

  /** An agent step in AWAITING_EXTERNAL that was parked, not a wait step polling. */
  #isParked(task: MissionTask): boolean {
    if (task.executor !== 'agent') return false;
    return parkedExternalOf(task, this.deps.events.listByMission(task.missionId, { semanticOnly: true })) !== null;
  }

  /** What the numbers mean for what runs next; each only while it is true. */
  banners(workspaceId: WorkspaceId, metrics: HomeMetricsView = this.metrics(workspaceId)): readonly HomeBannerView[] {
    const banners: HomeBannerView[] = [];
    const warned = metrics.monthUsage.filter((s) => s.level === 'soft').sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
    // At 100% the P8 banner ("Monthly limit reached") says it, with the card to decide on.
    if (warned !== undefined && !metrics.monthUsage.some((s) => s.level === 'hard')) {
      banners.push({ kind: 'month_warn', text: monthBannerText(warned), href: '/project' });
    }
    if (metrics.wipLimit !== null && metrics.active >= metrics.wipLimit && metrics.queued > 0) {
      banners.push({ kind: 'wip_full', text: wipBannerText({ active: metrics.active, limit: metrics.wipLimit, queued: metrics.queued }), href: '/missions/backlog' });
    }
    return banners;
  }

  /** Every fact the status report says, read now. */
  reportFacts(workspaceId: WorkspaceId): StatusReportFacts {
    const workspace = this.#requireWorkspace(workspaceId);
    const metrics = this.metrics(workspaceId);
    const month: WorkspaceUsageView = this.deps.limits.usage(workspaceId);
    const open = this.deps.missions.list({ workspaceId })
      .filter((m) => m.status !== 'DRAFT' && !isTerminalMissionStatus(m.status))
      .sort(compareBacklog);
    return {
      project: workspace.name,
      asOf: this.deps.clock.now(),
      month: metrics.month,
      needsYou: metrics.needsYou,
      active: metrics.active,
      wipLimit: metrics.wipLimit,
      queued: metrics.queued,
      criteria: { verified: metrics.criteriaVerified, counted: metrics.criteriaTotal, missions: metrics.criteriaMissions },
      monthLimits: month.limits.map(plainStatus),
      monthUsage: { agentMs: Math.round(month.usage.agentMinutes * 60_000), tokens: month.usage.tokens, costUsd: month.usage.costUsd, runs: month.usage.runs },
      stalled: metrics.stalled,
      missions: open.map((m) => this.#missionFacts(m)),
      backlog: this.deps.backlog(workspaceId).items.map((item): StatusReportBacklogItem => ({
        title: item.summary.mission.title,
        priority: item.priority,
        position: item.queuePosition,
        ready: item.ready,
        readiness: item.readinessLabel,
        refining: item.refining,
        held: item.held,
      })),
    };
  }

  /**
   * Renders the report and stores it as the next version of the project's
   * report line. A report that does not parse is refused: the template is
   * Tandemise's own, so that is a bug, never a document for the person.
   */
  async writeStatusReport(workspaceId: WorkspaceId, caller: Caller): Promise<StatusReportWritten> {
    const facts = this.reportFacts(workspaceId);
    const source = renderStatusReport(facts);
    const parsed = this.deps.parser.parse('StatusReport', source);
    if (!parsed.ok) {
      throw new TandemiseError('INTERNAL', 'The status report did not match its own template.', { details: { issues: parsed.error.map((i) => `${i.path}: ${i.message}`) } });
    }
    const holder = this.#holder(workspaceId);
    const previous = this.deps.artifacts.latest(holder.id, 'StatusReport');
    const title = statusReportTitle(facts.project);
    const headline = statusReportHeadline(facts);
    const manifest = await this.deps.artifactStore.write({
      workspaceId,
      missionId: holder.id,
      taskId: null,
      createdByRunId: null,
      type: 'StatusReport',
      title,
      body: source,
      sourceRefs: [],
      supersedes: previous?.id ?? null,
      summary: headline,
    });
    const measured = this.deps.measure.measure('StatusReport', parsed.value.body);
    const handoff = { headline, points: statusReportPoints(facts), needs: null, changed: [], links: [] };
    const recorded = this.deps.artifacts.create({
      ...manifest,
      authorId: SYSTEM_ACTOR,
      responsibleId: this.deps.members.findPersonMember(workspaceId, caller.personId)?.id ?? null,
      recordedBy: SYSTEM_ACTOR,
      handoff,
      wordCount: measured.mainWords,
      // A note to an agent about length; the daemon writes this one, as long as the work it describes.
      overBudget: false,
    });
    this.deps.recorder.invalidate('artifacts', holder.id);
    const version = versionLines(this.deps.artifacts.listByMission(holder.id)).get(recorded.id)?.version ?? 1;
    return { artifactId: recorded.id, version };
  }

  // ---------------------------------------------------------------- facts

  #missionFacts(mission: Mission): StatusReportMission {
    const verdict = this.deps.liveness.classify(mission);
    const { trace } = this.deps.gates.trace(mission.id);
    const counted = trace.rows.filter((r) => r.counted);
    const tasks = this.deps.tasks.listByMission(mission.id);
    const keyOf = new Map(tasks.map((t) => [t.id as string, t.key]));
    const cards = this.deps.approvals.list({ missionId: mission.id, statuses: ['PENDING'] })
      .filter((a) => a.kind !== 'check')
      .sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id));
    const log = this.deps.events.listByMission(mission.id, { semanticOnly: true });
    const people = [...tasks]
      .filter((t) => t.status === 'AWAITING_HUMAN' || parkedExternalOf(t, log) !== null)
      .sort((a, b) => a.orderHint - b.orderHint || byText(a.key, b.key))
      .map((t) => `'${t.key}' waits on a person`);
    const failures = log
      .filter((e) => e.body.type === 'gate.evaluated' && !e.body.passed);
    const last = failures[failures.length - 1];
    const lastBody = last?.body.type === 'gate.evaluated' ? last.body : null;
    return {
      title: mission.title,
      status: mission.status,
      statusReason: mission.statusReason,
      liveness: { kind: verdict.kind, reason: verdict.reason, action: verdict.action?.label ?? null },
      criteria: {
        verified: trace.verified,
        counted: trace.counted,
        failed: counted.filter((r) => r.result === 'FAIL').map((r) => r.criterion.key),
        notVerified: counted.filter((r) => r.result !== 'PASS' && r.result !== 'FAIL' && !r.uncovered).map((r) => r.criterion.key),
        notCovered: counted.filter((r) => r.uncovered).map((r) => r.criterion.key),
      },
      limits: this.deps.limits.missionView(mission).limits.map(plainStatus),
      waitingOn: [...cards.map((a) => a.title), ...people],
      lastGateFailure: last === undefined || lastBody === null
        ? null
        : { taskKey: last.taskId === null ? null : keyOf.get(last.taskId) ?? null, detail: lastBody.detail ?? `Not met: ${lastBody.gate}` },
    };
  }

  /** P5's trace summed over the missions "Working on" counts, so the two cards talk about the same work. */
  #criteriaInProgress(workspaceId: WorkspaceId): { verified: number; counted: number; missions: number } {
    let verified = 0;
    let counted = 0;
    let missions = 0;
    for (const mission of this.deps.missions.list({ workspaceId })) {
      if (!isInProgress(mission.status)) continue;
      const { trace } = this.deps.gates.trace(mission.id);
      if (trace.counted === 0) continue;
      verified += trace.verified;
      counted += trace.counted;
      missions += 1;
    }
    return { verified, counted, missions };
  }

  /**
   * The project's report holder, created with its first report. Its id is
   * derived from the project's, so it is found without a list (lists never
   * return it) and two projects never share one.
   */
  #holder(workspaceId: WorkspaceId): Mission {
    const id = asId<'MissionId'>(`msn_reports_${workspaceId.replace(/^wsp_/, '')}`) as MissionId;
    const existing = this.deps.missions.get(id);
    if (existing !== undefined) return existing;
    this.deps.missions.create({
      id,
      workspaceId,
      repositoryId: null,
      title: REPORT_HOLDER_TITLE,
      goal: "Holds this project's status reports. It is not work: it is never planned, listed or counted.",
      workflowPreset: REPORT_HOLDER_PRESET,
    });
    return this.deps.missions.update(id, { status: 'COMPLETE', statusReason: 'Holds status reports; never planned.' });
  }

  #requireWorkspace(id: WorkspaceId) {
    const workspace = this.deps.workspaces.get(id);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', id);
    return workspace;
  }
}

/** The measured limit only: the view's words are the window's, the report writes its own. */
function plainStatus(s: LimitStatusView | LimitStatus): LimitStatus {
  return { metric: s.metric, amount: s.amount, warnPercent: s.warnPercent, observed: s.observed, percent: s.percent, level: s.level };
}

/** Code-unit order: the same on every machine, whatever its locale, so the report's order never varies. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
