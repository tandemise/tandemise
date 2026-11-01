import type {
  FactoryFileView, FactoryView, MissionDetail, PlanChipView, PlanDecisionView, RoutingBucketView, RoutingClassView, RoutingModelView, RoutingView,
  ShipPullRequestView, ShipView,
} from '@tandemise/api-contract';
import {
  AUTO_MERGE_OFF, wouldHaveLine, bucketWords, chooseRung, decidingLines, isTerminalMissionStatus, laneBecauseSentence, laneLine, moduleSentence, profileChips, profileLine, routeReasonWords,
  signalSentence, stepClassWords, stepLine, tiebreakSentence, STEP_CLASSES,
  type BucketModelStats, type EventRepositoryPort, type OutcomeStats, type RoutingConfig, type StepClass, type MissionRepositoryPort, type MissionTask, type PlanDecision, type PlanDecisionRepositoryPort,
  type ProfileSignal, type TaskRepositoryPort, type ApprovalRepositoryPort, type MergeDecisionRepositoryPort,
} from '@tandemise/domain';
import { TandemiseError, type MissionId, type WorkspaceId } from '@tandemise/shared';
import { FACTORY_FILES, type FactoryConfigSourcePort, type FactoryFileName } from '../ports.js';
import { SHIPPED_FILES, type FactoryConfig } from '../planning/factory-config.js';
import type { PlannerService } from '../planning/planner-service.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import type { Caller } from '../support/identity.js';
import type { PlanningService, ProjectionService } from '../services.js';
import type { ReadinessService } from './readiness.js';

export interface FactoryServiceDeps {
  readonly planner: PlannerService;
  readonly planning: PlanningService;
  readonly projections: Pick<ProjectionService, 'missionDetail'>;
  readonly readiness: Pick<ReadinessService, 'evaluate'>;
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly planDecisions: PlanDecisionRepositoryPort;
  readonly events: Pick<EventRepositoryPort, 'listByMission'>;
  readonly recorder: EventRecorder;
  /** Where "Write the defaults" writes the factory files. */
  readonly approvals: Pick<ApprovalRepositoryPort, 'list'>;
  readonly mergeDecisions: MergeDecisionRepositoryPort;
  readonly factorySource: Pick<FactoryConfigSourcePort, 'write'>;
}

const STARTABLE: readonly string[] = ['PENDING', 'READY'];

/**
 * The factory as the person sees it (#53 §10, §11): "Why these steps", Plan
 * quick or careful, a lane switch, and the pull request the ship step opened.
 * Every sentence is made here, so the renderer only shows it.
 */
export class FactoryService {
  constructor(private readonly deps: FactoryServiceDeps) {}

  /**
   * Plan, or Plan quick / Plan careful. A lane is stored with the mission
   * before planning. Careful work with no Done-when line isn't planned: it
   * stays a draft to get ready (#53 §4), and the feed says why.
   */
  async plan(missionId: MissionId, lane: 'quick' | 'careful' | undefined, caller: Caller): Promise<MissionDetail> {
    void caller;
    let mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    if (lane !== undefined) {
      if (!this.deps.planner.handles(mission)) {
        throw new TandemiseError('PRECONDITION_FAILED', 'Plan quick and Plan careful are for missions the factory plans; this one follows its own workflow.', { details: { missionId } });
      }
      mission = this.deps.missions.update(missionId, { laneRequest: lane });
      this.deps.recorder.invalidate('missions', missionId);
    }
    if (mission.status === 'DRAFT' && this.deps.planner.handles(mission)) {
      await this.deps.planner.warm(missionId);
      if (!this.deps.planner.skipsReadiness(mission) && !this.deps.readiness.evaluate(missionId).ready) {
        const scope: EventScope = { workspaceId: mission.workspaceId, missionId };
        this.deps.recorder.note(scope, 'This is careful work, so it is planned once it says what done means. Add a Done-when line under Get it ready, then plan it.');
        return this.deps.projections.missionDetail(missionId);
      }
    }
    return this.deps.planning.begin(missionId);
  }

  async planDecision(missionId: MissionId): Promise<PlanDecisionView | null> {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    const decision = this.deps.planDecisions.latest(missionId);
    if (decision === undefined) return null;
    const tasks = this.deps.tasks.listByMission(missionId);
    let modules: readonly { readonly name: string; readonly when: string; readonly add: unknown }[] = [];
    try {
      modules = (await this.deps.planner.config(mission.workspaceId)).planner.modules;
    } catch { /* the names alone still say which rules applied */ }
    const ship = tasks.find((t) => t.executor === 'ship');
    const open = ship !== undefined && STARTABLE.includes(ship.status) && !isTerminalMissionStatus(mission.status);
    const titles = new Map(tasks.map((t) => [t.key, t.title]));
    return {
      missionId,
      lane: decision.lane,
      profileLine: profileLine(decision.profile),
      chips: chips(decision),
      decidedBy: decidingLines(decision.profile),
      // A lane raised by the measured change never had a plan approval: say so, not the careful lane's usual line.
      laneLine: laneLine(decision.lane, decision.steps.filter((s) => s.stepClass !== 'ship').length + 1, decision.basis === 'measured' && decision.skipped.includes('No plan approval.') && decision.lane !== 'quick'),
      laneBecause: laneBecauseSentence(decision.laneBecause),
      skipped: decision.skipped,
      modules: decision.modules.map((name) => moduleSentence(
        modules.find((m) => m.name === name) as Parameters<typeof moduleSentence>[0], name, decision.profile,
      )),
      dropped: decision.dropped.map((d) => (d.name.startsWith('skill ') ? `Left out the ${d.name.slice(6)} skill: ${d.why}` : `${d.name}: ${d.why}`)),
      steps: decision.steps.filter((s) => s.stepClass !== 'ship').map((s) => ({ key: s.key, line: stepLine(s, titles.get(s.key)) })),
      approvals: [...new Set(decision.approvals.map((a) => a.reason))],
      tiebreak: decision.tiebreak === null ? null : tiebreakSentence(decision.tiebreak),
      lightenedByPerson: decision.lightenedByPerson,
      canMakeQuick: open && decision.lane !== 'quick',
      canMakeCareful: open && decision.lane !== 'careful',
      measured: decision.basis === 'measured',
    };
  }

  /** Make it quick (asks first, through a plan card) or Make it careful (adds steps now). */
  async setLane(missionId: MissionId, lane: 'quick' | 'careful', caller: Caller): Promise<PlanDecisionView | null> {
    await this.deps.planner.switchLane(missionId, lane, caller);
    this.deps.recorder.invalidate('tasks', missionId);
    return this.planDecision(missionId);
  }

  /** Project → Factory: where each of the three files came from, and the rules in them that don't parse. */
  async factory(workspaceId: WorkspaceId): Promise<FactoryView> {
    const config = await this.deps.planner.config(workspaceId);
    const repository = this.deps.planner.repositories(workspaceId)[0] ?? null;
    const files: FactoryFileView[] = FACTORY_FILES.map((name) => ({
      name,
      title: FILE_TITLES[name],
      origin: config.origins[name],
      originLine: ORIGIN_WORDS[config.origins[name]],
      path: config.paths[name],
      ref: config.refs[name],
      problems: config.problems.filter((p) => p.file === name).map((p) => p.message),
    }));
    return {
      workspaceId,
      files,
      repositoryName: repository?.name ?? null,
      canWriteDefaults: repository !== null && files.some((f) => f.origin !== 'project'),
    };
  }

  /**
   * Write the defaults into the repository: the shipped files the project
   * doesn't have yet go into its default repository's `.tandemise/factory/`.
   * A file the project already wrote is left as it is.
   */
  async writeDefaults(workspaceId: WorkspaceId, caller: Caller): Promise<FactoryView> {
    void caller;
    const repository = this.deps.planner.repositories(workspaceId)[0];
    if (repository === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', 'This project has no repository to write the factory files into.', { details: { workspaceId } });
    }
    const config = await this.deps.planner.config(workspaceId);
    for (const name of FACTORY_FILES) {
      if (config.origins[name] === 'project') continue;
      await this.deps.factorySource.write(name, repository.path, SHIPPED_FILES[name], workspaceId);
    }
    this.deps.recorder.invalidate('workspaces');
    return this.factory(workspaceId);
  }

  /** Project → Factory → Routing: per step class with a ladder, per bucket, each model's record and where a new step starts. */
  async routing(workspaceId: WorkspaceId): Promise<RoutingView> {
    const { routing } = await this.deps.planner.config(workspaceId);
    const stats = this.deps.planner.routingStats(workspaceId);
    const classes = STEP_CLASSES.filter((cls) => routing.classes[cls] !== undefined).map((cls) => routingClass(cls, routing, stats));
    return {
      workspaceId,
      ruleLine: `A model is chosen once its success rate is confidently at least ${Math.round(routing.target * 100)}%, over at least ${routing.minSamples} similar steps; until then a step starts at its class's default.`,
      classes,
      empty: classes.length === 0 ? "No model ladder is written yet, so every step uses its role's model." : null,
    };
  }

  /** The ship step and the pull requests it opened (part 1: no CI or merge yet). */
  ship(missionId: MissionId): ShipView {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    const tasks = this.deps.tasks.listByMission(missionId);
    const ship = [...tasks].reverse().find((t) => t.executor === 'ship');
    const opened = new Map<string, ShipPullRequestView>();
    for (const event of this.deps.events.listByMission(missionId, { semanticOnly: true })) {
      if (event.body.type !== 'ship.pr_opened') continue;
      const { repo, number, url } = event.body;
      opened.set(`${repo}#${number}`, { repo, number, url, state: 'opened', decision: null });
    }
    const pending = this.deps.approvals.list({ missionId, statuses: ['PENDING'] }).filter((a) => a.taskId === ship?.id);
    for (const [key, pr] of opened) {
      const d = this.deps.mergeDecisions.latestFor(missionId, pr.repo);
      if (d === undefined || d.prNumber !== pr.number) continue;
      const card = pending.find((a) => a.evidence.some((e) => e.label === 'Decision' && e.value === d.id));
      opened.set(key, {
        ...pr,
        decision: {
          id: d.id, verdict: d.verdict, headSha: d.headSha,
          scoreLine: `Risk score ${d.score} of ${d.allowed ?? 0} allowed`,
          reasons: d.reasons,
          factors: d.factors.filter((f) => f.kind === 'score' && f.matched).map((f) => `${f.why ?? f.rule} (+${f.points})`),
          wouldHave: d.reasons.includes(AUTO_MERGE_OFF) ? wouldHaveLine(d) : null,
          policyRef: d.policyRef,
          cardId: card?.id ?? null,
          mergedBy: d.mergedBy, mergeSha: d.mergeSha,
          canRevert: d.mergeSha !== null,
        },
      });
    }
    const prs = [...opened.values()];
    return { missionId, taskId: ship?.id ?? null, prs, ...shipStage(ship, prs.length) };
  }
}

function shipStage(ship: MissionTask | undefined, prs: number): Pick<ShipView, 'stage' | 'headline' | 'status'> {
  if (ship === undefined) return { stage: 'none', headline: 'No pull request', status: 'This mission has no ship step.' };
  if (ship.status === 'SUCCEEDED' && (ship.statusReason ?? '').startsWith('Merged')) {
    return { stage: 'merged', headline: (ship.statusReason ?? '').startsWith('Merged on its own') ? 'Merged on its own' : 'Merged', status: ship.statusReason ?? 'Merged.' };
  }
  if (prs > 0 && !['RUNNING', 'AWAITING_EXTERNAL', 'AWAITING_APPROVAL', 'BLOCKED'].includes(ship.status)) {
    return { stage: 'opened', headline: 'Pull request opened', status: prs === 1 ? 'The pull request is open on GitHub.' : `${prs} pull requests are open on GitHub.` };
  }
  switch (ship.status) {
    case 'AWAITING_EXTERNAL':
      if (/^Waiting for (?:CI|checks|the checks)\b/.test(ship.statusReason ?? '')) return { stage: 'ci', headline: ship.statusReason!, status: 'The pull request is open; Tandemise decides once CI is green on its head commit.' };
      return { stage: 'review', headline: ship.statusReason ?? 'Waiting for you to merge it in GitHub.', status: 'Tandemise finishes when GitHub says it merged.' };
    case 'AWAITING_APPROVAL':
      return { stage: 'review', headline: 'Waiting for your review', status: ship.statusReason ?? 'The merge policy asks for a review.' };
    case 'RUNNING':
      return { stage: 'opening', headline: 'Opening the pull request', status: ship.statusReason ?? 'Opening the pull request.' };
    case 'SUCCEEDED':
      return { stage: 'opened', headline: 'Pull request opened', status: ship.statusReason ?? 'The pull request is open.' };
    case 'SKIPPED':
      return { stage: 'skipped', headline: 'No pull request', status: ship.statusReason ?? 'Nothing was shipped.' };
    case 'CANCELLED':
      return { stage: 'cancelled', headline: 'No pull request', status: 'The mission stopped before the pull request opened.' };
    case 'BLOCKED':
    case 'FAILED':
      // With the pull request open, what stopped is CI or a person's call on it (#194), not opening it.
      return { stage: 'blocked', headline: prs > 0 ? 'The pull request needs you' : "Couldn't open the pull request", status: ship.statusReason ?? "The pull request couldn't be opened." };
    default:
      return { stage: 'waiting', headline: 'Pull request not open yet', status: 'The pull request opens once the steps before it are done.' };
  }
}

/** The three chips, each with the signals that set it. */
function chips(decision: PlanDecision): readonly PlanChipView[] {
  const [type, size, risk] = profileChips(decision.profile);
  const about = (s: ProfileSignal, what: 'type' | 'size' | 'risk'): boolean => {
    const effect = s.effect.replace(/^disagrees:\s*/, '');
    if (what === 'risk') return effect.startsWith('risk ') || effect.startsWith('area ') || effect.startsWith('conservative default');
    return effect.startsWith(`${what} `);
  };
  const of = (what: 'type' | 'size' | 'risk') => decision.profile.signals.filter((s) => about(s, what)).map(signalSentence);
  return [{ label: type, signals: of('type') }, { label: size, signals: of('size') }, { label: risk, signals: of('risk') }];
}

const FILE_TITLES: Readonly<Record<FactoryFileName, string>> = { planner: 'Planner rules', routing: 'Model routing', merge: 'Merge policy' };
const ORIGIN_WORDS: Readonly<Record<FactoryConfig['origins'][FactoryFileName], string>> = {
  brain: 'From the brain',
  project: "From this project's repository",
  home: 'From this computer',
  shipped: 'Built in',
};

const percent = (part: number, n: number): string => (n === 0 ? 'not measured' : `${Math.round((part / n) * 100)}%`);
const usd = (v: number | null): string => (v === null ? 'not reported' : v < 0.01 ? `${(v * 100).toFixed(1)}¢` : `$${v.toFixed(2)}`);
function duration(ms: number | null): string {
  if (ms === null) return 'not reported';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One step class's routing: its ladder, and each bucket it has measured. */
function routingClass(cls: StepClass, routing: RoutingConfig, stats: OutcomeStats): RoutingClassView {
  const ladder = routing.classes[cls]!;
  const buckets = Object.keys(stats.buckets).filter((b) => b.startsWith(`${cls}|`)).sort();
  return {
    stepClass: cls,
    title: stepClassWords(cls),
    ladderLine: `${ladder.ladder.join(', then ')}; a step starts at ${ladder.default} until enough similar steps are measured.`,
    buckets: buckets.map((bucket): RoutingBucketView => {
      // Risk "medium" never probes, so this is the rung a step in this bucket starts at.
      const choice = chooseRung({ cls, bucket, risk: 'medium', config: routing, stats, taskOrdinal: 0 });
      const measured = stats.buckets[bucket] ?? {};
      const names = [...ladder.ladder, ...Object.keys(measured).filter((m) => !ladder.ladder.includes(m)).sort()];
      return {
        key: bucket,
        title: bucketWords(bucket),
        models: names.map((model): RoutingModelView => modelRow(model, measured[model], ladder.ladder.includes(model), choice?.model === model)),
        startingLine: choice === null ? "Uses its role's model." : `Starts at ${choice.model}: ${routeReasonWords(choice.reason)}.`,
      };
    }),
    empty: buckets.length === 0 ? `No similar ${stepClassWords(cls).toLowerCase()} steps measured yet; each starts at ${ladder.default}.` : null,
  };
}

function modelRow(model: string, s: BucketModelStats | undefined, onLadder: boolean, starting: boolean): RoutingModelView {
  const n = s?.n ?? 0;
  return {
    model: model === '' ? 'role model' : model,
    onLadder,
    tasks: n,
    firstPass: percent(s?.firstPass ?? 0, n),
    success: percent(s?.success ?? 0, n),
    medianCost: n === 0 ? 'not measured' : usd(s?.medianCostUsd ?? null),
    medianTime: n === 0 ? 'not measured' : duration(s?.medianWallTimeMs ?? null),
    starting,
  };
}
