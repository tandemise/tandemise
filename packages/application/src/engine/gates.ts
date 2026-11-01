import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, CheckResult, CriteriaTrace, Evaluation,
  EvaluationRepositoryPort, GateFacts, GateOutcome, MissionCriteriaRepositoryPort, MissionRepositoryPort, MissionTask, ModelIdentity, RiskClass,
  Run, RunRepositoryPort, RuntimeProfileRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { blockingFindings, evaluateGate, maxRisk, modelsIndependent, skillFacts, traceCriteria } from '@tandemise/domain';
import { riskForCapability } from '@tandemise/policy';
import { GateFactBuilder, evaluateNamedGate } from '@tandemise/evaluation';
import type { MissionId } from '@tandemise/shared';
import { asId } from '@tandemise/shared';

/**
 * Turns everything Tandemise has measured into the fact map a gate reads, and
 * evaluates the gate against it (MVP.md §17.2).
 *
 * Facts are assembled fresh on every call rather than stored. A gate outcome is
 * a *view* of the current evidence: storing it would mean the UI could show a
 * task blocked on a check that has since been re-run and passed. Evaluation is
 * cheap - a handful of indexed reads and a parse of a short expression - so
 * there is nothing to gain by caching it and a real correctness cost.
 *
 * Two assembly rules carry the weight:
 *
 *  - **Time collapses before scope folds.** A check name is measured many times
 *    - once per attempt, and again by every later task working the same code.
 *    Those measurements are not equal evidence: the newest one describes the
 *    code as it stands, and the older ones describe code that no longer exists.
 *    So the results are collapsed to the latest per repository FIRST, and only
 *    then folded across repositories by `withChecks`, which takes the worst.
 *    Getting this backwards makes the retry loop unwinnable - see `#currentChecks`.
 *  - **What was looked for is declared.** `expectingArtifactTypes` makes a
 *    missing output read `false` rather than `undefined`, which is the
 *    difference between "the worker did not write it" and "nobody checked".
 */
export class GateService {
  constructor(
    private readonly tasks: TaskRepositoryPort,
    private readonly artifacts: ArtifactRepositoryPort,
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly approvals: ApprovalRepositoryPort,
    private readonly missions: MissionRepositoryPort,
    /** Optional so a harness built before the ledger still composes; the module always passes it. */
    private readonly criteria?: MissionCriteriaRepositoryPort,
    /** Runs and profiles, for `review.independent` (P12). Optional for the same reason. */
    private readonly runs?: RunRepositoryPort,
    private readonly profiles?: RuntimeProfileRepositoryPort,
  ) {}

  /**
   * `measured` carries what only the attempt in hand knows - what its own
   * ChangeSet says it changed - so it never reads another task's diff.
   */
  factsFor(task: MissionTask, measured: TaskMeasurements = {}): GateFacts {
    const builder = new GateFactBuilder();

    builder.withTask({ attempt: task.attempts, roleId: task.roleId, risk: riskOf(task) });
    if (measured.filesChanged !== undefined) builder.withDiff({ filesChanged: measured.filesChanged });

    builder.withChecks(this.#currentChecks(task.missionId));

    builder.withArtifacts(this.artifacts.listByMission(task.missionId));
    builder.expectingArtifactTypes(task.expectedOutputs);

    const review = this.#latestEvaluation(task.missionId, 'review');
    if (review) builder.withReview(review);

    const qa = this.#latestEvaluation(task.missionId, 'qa');
    // Before withQa: the ledger's coverage replaces the one QA's own list implies.
    builder.withCriteria(this.trace(task.missionId, qa).trace);
    if (qa) {
      builder.withQa({
        criteria: qa.criteriaCoverage,
        blockingDefects: blockingFindings(qa).length,
        verdict: qa.verdict,
      });
    }

    builder.withApprovals(this.approvals.list({ missionId: task.missionId }));
    const independent = this.#independence(task);
    if (independent !== null) builder.withIndependence(independent);
    // P13: measured for every step, so a step gate can require its skills.
    builder.withSkills(skillFacts(task.skills ?? [], this.runs?.listByTask(task.id).at(-1)?.skills ?? null));
    return builder.build();
  }

  /**
   * `review.independent` for a step with `independentOf` (P12): this task's
   * newest run against the newest successful run of the step it names. Null -
   * the fact stays absent, so a gate reading it fails as unmeasured - when
   * either run does not exist yet.
   */
  #independence(task: MissionTask): boolean | null {
    const upstreamKey = task.modelPolicy?.independentOf;
    if (upstreamKey === undefined || this.runs === undefined || this.profiles === undefined) return null;
    const upstream = this.tasks.getByKey(task.missionId, upstreamKey);
    if (upstream === undefined) return null;
    const reviewing = this.runs.listByTask(task.id).at(-1);
    const reviewed = this.runs.listByTask(upstream.id).filter((r) => r.status === 'SUCCEEDED').at(-1);
    if (reviewing === undefined || reviewed === undefined) return null;
    const identity = (run: Run): ModelIdentity => ({
      adapterId: this.profiles?.get(asId<'RuntimeProfileId'>(run.runtimeProfileId))?.adapterId ?? run.runtimeProfileId,
      model: run.model ?? null,
    });
    return modelsIndependent(identity(reviewing), identity(reviewed));
  }

  /**
   * The Done-when ledger traced against the newest QA evaluation - the one the
   * qa.* facts read, so the checklist and the gate can never disagree.
   */
  trace(missionId: MissionId, qa: Evaluation | undefined = this.#latestEvaluation(missionId, 'qa')): { readonly trace: CriteriaTrace; readonly qa: Evaluation | undefined } {
    const live = this.criteria?.listActive(missionId) ?? [];
    return {
      trace: traceCriteria(live, qa === undefined ? null : { results: qa.criteriaCoverage, recordedAt: qa.createdAt }),
      qa,
    };
  }

  /**
   * The gate outcome and every fact the gate could read, from one read of the
   * facts (P3b: a run's score keeps the facts, not just the verdict).
   */
  assess(task: MissionTask, measured: TaskMeasurements = {}): { readonly outcome: GateOutcome | null; readonly facts: GateFacts } {
    const facts = this.factsFor(task, measured);
    return { outcome: task.completionGate === null ? null : evaluateGate(task.completionGate, facts), facts };
  }

  /** `null` when the task declares no completion gate - not a pass, an absence. */
  evaluate(task: MissionTask, measured: TaskMeasurements = {}): GateOutcome | null {
    return task.completionGate === null ? null : this.assess(task, measured).outcome;
  }

  /** One of the named workspace gates (`ready_for_qa`, `ready_to_ship`). */
  evaluateNamed(task: MissionTask, name: string): GateOutcome {
    return evaluateNamedGate(name, this.factsFor(task));
  }

  /**
   * The newest measurement of each check name, per repository.
   *
   * `latestChecks` already keeps only the newest row per (task, name), which
   * collapses a task's own attempts. Tasks are then grouped by the repository
   * they work in, because that - not the task - is what a check measures: two
   * tasks touching the same repo are two measurements of one thing, and the
   * later one supersedes the earlier. Across repositories nothing supersedes
   * anything, so those rows are all returned and `withChecks` folds them
   * worst-wins: a mission does not ship because its second repo went green
   * after its first one went red.
   *
   * A task with no repository of its own inherits the mission's, so a
   * single-repo mission is one scope and its retries clear their own failures.
   * This is the fix for a real mission whose `implement` task burned all 14
   * attempts on a `checks.tests` FAIL recorded by attempt 1, while attempts
   * 3-14 each measured PASS.
   */
  #currentChecks(missionId: MissionId): readonly CheckResult[] {
    // A task leaves `repositoryId` null to mean "the mission's repository", so
    // the null has to be resolved before it is used as an identity - otherwise
    // a task that names the repo explicitly and a sibling that leaves it null
    // land in different scopes for the same code, and neither clears the
    // other's failure.
    const missionRepository = this.missions.get(missionId)?.repositoryId ?? '';
    const scopeOfTask = new Map<string, string>();
    for (const task of this.tasks.listByMission(missionId)) {
      scopeOfTask.set(task.id, task.repositoryId ?? missionRepository);
    }
    const newest = new Map<string, Map<string, CheckResult>>();
    for (const result of this.evaluations.latestChecks(missionId)) {
      const scope = scopeOfTask.get(result.taskId) ?? missionRepository;
      const byName = newest.get(scope) ?? new Map<string, CheckResult>();
      const held = byName.get(result.name);
      if (held === undefined || result.createdAt > held.createdAt) byName.set(result.name, result);
      newest.set(scope, byName);
    }
    return [...newest.values()].flatMap((byName) => [...byName.values()]);
  }

  #latestEvaluation(missionId: MissionId, evaluatorRoleId: string): Evaluation | undefined {
    let latest: Evaluation | undefined;
    for (const task of this.tasks.listByMission(missionId)) {
      for (const evaluation of this.evaluations.listEvaluations(task.id)) {
        if (evaluation.evaluatorRoleId !== evaluatorRoleId) continue;
        if (latest === undefined || evaluation.createdAt >= latest.createdAt) latest = evaluation;
      }
    }
    return latest;
  }
}

export interface TaskMeasurements {
  readonly filesChanged?: number;
}

/**
 * The most consequential thing the task may do. A task that asks for nothing
 * is a read: it can still only look.
 */
function riskOf(task: MissionTask): RiskClass {
  const capabilities = [...task.executionPolicy.capabilities, ...task.requiredCapabilities];
  return capabilities.reduce<RiskClass>((risk, c) => maxRisk(risk, riskForCapability(c)), 'read');
}

