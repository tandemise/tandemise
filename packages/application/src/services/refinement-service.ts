import type {
  ArtifactHandoff, ArtifactRepositoryPort, ArtifactStorePort, MemberRepositoryPort, Mission, MissionCriteriaRepositoryPort,
  MissionCriterion, MissionQuestion, MissionQuestionRepositoryPort, MissionRepositoryPort, RepoRepositoryPort, Repository,
  RuntimeProfile, RuntimeProfileRepositoryPort, UnitOfWork, Workspace, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { ARTIFACT_OUT_DIR, AUTONOMY_DECIDER, ISSUE_CRITERIA_AUTHOR, CORE_CAPABILITIES, RUNTIME_ACTOR, SYSTEM_ACTOR, TRACKER_CRITERIA_AUTHOR } from '@tandemise/domain';
import type {
  AddCriterionRequest, AnswerQuestionRequest, CriterionVerdictRequest, RefinementCriterionView, RefinementQuestionView, RefinementView,
} from '@tandemise/api-contract';
import type { ExecutionTarget, ExecutionTargetManager } from '@tandemise/execution-core';
import { describeRejections, onlyBusy } from '@tandemise/runtimes-core';
import type { RuntimeManager, RuntimeSelection } from '@tandemise/runtimes-core';
import type { Clock, CriterionId, Logger, MissionId, QuestionId, TandemisePaths } from '@tandemise/shared';
import { TandemiseError, errorMessage, ids, slugify, summarize } from '@tandemise/shared';
import type { ArtifactMeasurePort, ArtifactParserPort, ArtifactTemplatePort } from '../ports.js';
import type { RefinementService } from '../services.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { requireSeat, type Caller } from '../support/identity.js';
import { buildRefinementPrompt } from '../planning/refinement-prompt.js';
import { refinementTitle } from '../planning/materialize.js';
import { intakeArtifactFor, missionUploads } from '../planning/upload-intake.js';
import type { ReadinessService } from './readiness.js';
import { ensureTandemiseIgnore } from '../support/ignore.js';

/** Refinement borrows the product role's runtime routing: it is the product owner's job. */
const REFINER_ROLE_ID = 'product';
/** One retry with the validator's findings quoted back, as planning does. */
const MAX_REFINE_ATTEMPTS = 2;
const REFINE_WALL_TIME_MS = 10 * 60_000;
/** A busy runtime is waited for, briefly; a refinement is something a person is sitting in front of. */
const REFINE_SLOT_WAIT_MS = 5 * 60_000;
const REFINE_SLOT_POLL_MS = 3_000;

export interface RefinementDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly runtimeManager: RuntimeManager;
  readonly targetManager: ExecutionTargetManager;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly measure: ArtifactMeasurePort;
  readonly parser: ArtifactParserPort;
  readonly templates: ArtifactTemplatePort;
  readonly criteria: MissionCriteriaRepositoryPort;
  readonly questions: MissionQuestionRepositoryPort;
  readonly readiness: ReadinessService;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly paths: TandemisePaths;
  readonly clock: Clock;
  readonly log: Logger;
  /**
   * Converts the mission's uploads before the first pass reads the request
   * (spec A2). Optional for older harnesses; planning's `ensureIntake`, which
   * never throws and does nothing the second time.
   */
  readonly intake?: (missionId: MissionId) => Promise<unknown>;
  /** The key of the tracker item a mission was made from (`GAR-71`), for "From GAR-71" (#185); optional for harnesses. */
  readonly trackerKey?: (missionId: MissionId) => string | null;
}

/** A pass that could not finish, with the sentence the person reads. */
class RefinementFailure extends Error {}

/**
 * Refining a rough request until it is ready to plan (P6 spec §1).
 *
 * A bounded service step, shaped like planning: the product role's runtime,
 * read-only grants plus the right to write its one document, ten minutes, two
 * attempts. What it produces is only ever proposals and questions. Whether the
 * mission is ready is decided by what the person does with them - accepted,
 * rejected, answered - counted by the readiness gate; nothing the pass says
 * about itself moves the mission.
 *
 * A pass that cannot run leaves the mission in DRAFT with a reason. The person
 * can always add a criterion by hand, so a mission is never stuck on a model.
 */
export class RefinementServiceImpl implements RefinementService {
  /** Passes in flight; in memory, because a pass interrupted by a restart wrote nothing and can simply run again. */
  readonly #running = new Map<string, Promise<void>>();
  readonly #failures = new Map<string, string>();

  constructor(private readonly deps: RefinementDeps) {}

  begin(caller: Caller, missionId: MissionId): RefinementView {
    const mission = this.#requireDraft(missionId, 'refined');
    requireSeat(this.deps, mission.workspaceId, caller);
    if (this.#running.has(missionId)) {
      throw new TandemiseError('CONFLICT', 'This request is already being refined. Wait for the proposals, then refine again if you want another pass.', {
        details: { missionId },
      });
    }
    this.#failures.delete(missionId);
    const scope = scopeOf(mission);
    this.deps.recorder.note(scope, 'Refining the request: the product agent is reading it and will propose criteria and ask what it needs.');
    const pass = this.#refine(mission)
      .catch((e: unknown) => {
        const reason = e instanceof RefinementFailure ? e.message : `Refinement failed: ${errorMessage(e)}`;
        this.deps.log.warn('refinement.failed', { missionId, error: reason });
        this.#failures.set(missionId, reason);
        this.deps.recorder.note(scope, reason, 'warn');
      })
      .finally(() => {
        this.#running.delete(missionId);
        this.deps.recorder.invalidate('refinement', missionId);
        this.deps.recorder.invalidate('missions', missionId);
      });
    this.#running.set(missionId, pass);
    this.deps.recorder.invalidate('refinement', missionId);
    return this.view(missionId);
  }

  /** Resolves when the mission's current pass (if any) has settled. For harnesses and shutdown. */
  isRunning(missionId: MissionId): boolean {
    return this.#running.has(missionId);
  }

  async settled(missionId: MissionId): Promise<void> {
    await this.#running.get(missionId);
  }

  view(missionId: MissionId): RefinementView {
    if (this.deps.missions.get(missionId) === undefined) throw TandemiseError.notFound('Mission', missionId);
    const latest = this.deps.artifacts.latest(missionId, 'Refinement');
    const readiness = this.deps.readiness.evaluate(missionId);
    return {
      missionId,
      state: this.#running.has(missionId) ? 'running' : this.#failures.has(missionId) ? 'failed' : 'idle',
      failure: this.#running.has(missionId) ? null : this.#failures.get(missionId) ?? null,
      artifactId: latest?.id ?? null,
      headline: latest?.handoff?.headline ?? latest?.summary ?? null,
      criteria: this.deps.criteria.listUserRows(missionId).map((c) => criterionView(c, () => this.deps.trackerKey?.(missionId) ?? null)),
      questions: this.deps.questions.listByMission(missionId).map(questionView),
      readiness: {
        ready: readiness.ready,
        criteria: readiness.criteria,
        openQuestions: readiness.openQuestions,
        proposedPending: readiness.proposedPending,
        label: readiness.label,
        detail: readiness.detail,
      },
    };
  }

  decide(caller: Caller, criterionId: CriterionId, request: CriterionVerdictRequest): RefinementView {
    const criterion = this.deps.criteria.get(criterionId);
    if (criterion === undefined) throw TandemiseError.notFound('Criterion', criterionId);
    const mission = this.#requireDraft(criterion.missionId, 'changed');
    const seat = requireSeat(this.deps, mission.workspaceId, caller);
    const decided = this.deps.criteria.decide(criterionId, request.verdict, {
      decidedBy: seat.id,
      ...(request.statement === undefined ? {} : { statement: request.statement }),
    });
    this.deps.recorder.note({ ...scopeOf(mission), actorId: seat.id }, request.verdict === 'reject'
      ? `Rejected ${criterion.key}: ${summarize(criterion.statement, 200)}`
      : `Accepted ${criterion.key} as ${decided.key}${decided.statement === criterion.statement ? '' : ', reworded'}: ${summarize(decided.statement, 200)}`);
    this.#changed(mission.id);
    return this.view(mission.id);
  }

  answer(caller: Caller, questionId: QuestionId, request: AnswerQuestionRequest): RefinementView {
    const question = this.deps.questions.get(questionId);
    if (question === undefined) throw TandemiseError.notFound('Question', questionId);
    const mission = this.#requireDraft(question.missionId, 'changed');
    const seat = requireSeat(this.deps, mission.workspaceId, caller);
    const text = request.text.trim();
    if (text.length === 0) throw TandemiseError.validation('An answer needs some text.');
    this.deps.questions.answer(questionId, text, seat.id);
    this.deps.recorder.note({ ...scopeOf(mission), actorId: seat.id }, `Answered ${question.key} (${summarize(question.text, 120)}): ${summarize(text, 200)}`);
    this.#changed(mission.id);
    return this.view(mission.id);
  }

  addCriterion(caller: Caller, missionId: MissionId, request: AddCriterionRequest): RefinementView {
    const mission = this.#requireDraft(missionId, 'changed');
    const seat = requireSeat(this.deps, mission.workspaceId, caller);
    const [added] = this.deps.criteria.addUserCriteria(missionId, [request.statement], seat.id);
    if (added === undefined) throw TandemiseError.validation('A criterion needs a statement.');
    this.deps.recorder.note({ ...scopeOf(mission), actorId: seat.id }, `Added ${added.key}: ${summarize(added.statement, 200)}`);
    this.#changed(missionId);
    return this.view(missionId);
  }

  // ------------------------------------------------------------------ the pass

  async #refine(mission: Mission): Promise<void> {
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    if (workspace === undefined) throw TandemiseError.notFound('Workspace', mission.workspaceId);
    const repository = mission.repositoryId === null ? null : this.deps.repositories.get(mission.repositoryId) ?? null;
    const scope = scopeOf(mission);

    // Before the refinement picks its own runtime: intake runs on the
    // planner's, and what it makes is context the pass should read.
    await this.deps.intake?.(mission.id);

    const candidates = this.#candidates(workspace);
    if (candidates.length === 0) {
      throw new RefinementFailure('No runtime is enabled to refine this request. Enable one in Runtimes and refine again, or add Done-when criteria by hand.');
    }
    const selected = await this.#select(candidates, scope);
    if (!selected.ok) {
      throw new RefinementFailure(
        `No runtime could refine this request (${describeRejections(selected.error.rejections) || 'none available'}). `
        + 'Refine again later, or add Done-when criteria by hand.',
      );
    }
    let target: ExecutionTarget;
    try {
      target = await this.deps.targetManager.provision({
        workspaceId: workspace.id,
        missionId: mission.id,
        taskId: null,
        kind: 'local',
        name: `${slugify(mission.title)}-refining`,
        // With no repository there is nothing to read; the home is a neutral working directory.
        repositoryPath: repository?.path ?? this.deps.paths.root,
        missionSlug: slugify(mission.title),
      });
    } catch (e) {
      selected.value.reservation.release();
      throw new RefinementFailure(`No place to run the refinement could be prepared (${errorMessage(e)}). Refine again, or add Done-when criteria by hand.`);
    }

    try {
      let issues: readonly string[] = [];
      for (let attempt = 1; attempt <= MAX_REFINE_ATTEMPTS; attempt++) {
        const source = await this.#run(selected.value, mission, repository, target, scope, attempt, issues);
        const checked = this.#check(mission.id, source);
        if (checked.ok) {
          await this.#ingest(mission, source, checked.value);
          return;
        }
        issues = checked.error;
        this.deps.recorder.note(scope, `Refinement attempt ${attempt} was unusable: ${issues.join('; ')}`, 'warn');
      }
      throw new RefinementFailure(`The refinement came back unusable twice (${issues.join('; ')}). Refine again, or add Done-when criteria by hand.`);
    } finally {
      selected.value.reservation.release();
      try {
        await this.deps.targetManager.release(target.describe());
      } catch (e) {
        this.deps.log.warn('refinement.target_release_failed', { error: errorMessage(e) });
      }
    }
  }

  /** The product role's routed runtimes, or every enabled one when nobody routed it. */
  #candidates(workspace: Workspace): readonly RuntimeProfile[] {
    const all = this.deps.runtimeProfiles.list(workspace.id).filter((p) => p.enabled);
    const routed = workspace.routing[REFINER_ROLE_ID];
    if (routed === undefined || routed.length === 0) return all;
    return routed.flatMap((id) => all.filter((p) => p.id === id));
  }

  async #select(candidates: readonly RuntimeProfile[], scope: EventScope): ReturnType<RuntimeManager['select']> {
    const deadline = this.deps.clock.epochMs() + REFINE_SLOT_WAIT_MS;
    let announced = false;
    for (;;) {
      const selected = await this.deps.runtimeManager.select(candidates, ['reasoning']);
      if (selected.ok || !onlyBusy(selected.error) || this.deps.clock.epochMs() >= deadline) return selected;
      if (!announced) {
        announced = true;
        this.deps.recorder.note(scope, 'Every runtime that can refine is busy. Waiting for one to free up.');
      }
      await new Promise((resolve) => setTimeout(resolve, REFINE_SLOT_POLL_MS));
    }
  }

  /** One run of the product agent; the document it wrote, or its reply when it could not write one. */
  async #run(
    selection: RuntimeSelection,
    mission: Mission,
    repository: Repository | null,
    target: ExecutionTarget,
    scope: EventScope,
    attempt: number,
    issues: readonly string[],
  ): Promise<string> {
    const { profile, reservation } = selection;
    const dir = `${ARTIFACT_OUT_DIR}/refining-${mission.id}-${attempt}`;
    const file = `${dir}/Refinement.md`;
    const fs = target.filesystem();
    try {
      if (await fs.exists(dir)) await fs.remove(dir, { recursive: true });
      await fs.mkdir(dir);
      await ensureTandemiseIgnore(fs);
    } catch (e) {
      this.deps.log.warn('refinement.out_dir_unavailable', { error: errorMessage(e) });
    }

    const ledger = this.deps.criteria.listUserRows(mission.id);
    const prompt = buildRefinementPrompt({
      mission,
      repository,
      accepted: ledger.filter((c) => c.status === 'accepted').map((c) => ({ key: c.key, statement: c.statement })),
      answered: this.deps.questions.listByMission(mission.id)
        .flatMap((q) => (q.status === 'answered' && q.answer !== null ? [{ text: q.text, answer: q.answer }] : [])),
      rejected: ledger.filter((c) => c.status === 'rejected').map((c) => c.statement),
      uploads: this.#intakeContext(mission.id),
      template: this.deps.templates.render('Refinement') ?? '(write a Refinement document)',
      workingDirectory: target.workingDirectory,
      destination: file,
      issues,
    });

    const runId = ids.run();
    const runScope: EventScope = { ...scope, roleId: REFINER_ROLE_ID, runtimeProfileId: profile.id };
    const signal = AbortSignal.timeout(REFINE_WALL_TIME_MS);
    this.deps.recorder.record(runScope, { type: 'run.started', attempt, runtime: profile.name, target: `${target.kind}:${target.workingDirectory}` });
    const startedAt = this.deps.clock.epochMs();
    const chunks: string[] = [];
    let failure: string | null = null;
    try {
      for await (const event of this.deps.runtimeManager.start({
        runId,
        profile,
        prompt,
        workingDirectory: target.workingDirectory,
        // Refinement reads; its only write is its own document, which
        // artifact.write alone scopes to the out directory.
        grants: [CORE_CAPABILITIES.repositoryRead, CORE_CAPABILITIES.filesystemRead, CORE_CAPABILITIES.artifactWrite],
        allowedRoots: [],
        mcpConfigPath: null,
        maxWallTimeMs: REFINE_WALL_TIME_MS,
        // Honoured on the first attempt only; a retry claims a fresh slot.
        reservation,
        signal,
        log: this.deps.log.child({ runId, missionId: mission.id, runtime: profile.adapterId }),
      })) {
        // No task, so no Run row; the events still belong on the mission's record.
        this.deps.recorder.record(runScope, event);
        if (event.type === 'message') chunks.push(event.text);
        if (event.type === 'failed') failure = `${event.code}: ${event.message}`;
      }
    } catch (e) {
      failure = errorMessage(e);
    }
    this.deps.recorder.record(runScope, {
      type: 'run.finished', status: failure === null ? 'SUCCEEDED' : 'FAILED', durationMs: this.deps.clock.epochMs() - startedAt,
    });
    if (failure !== null) throw new RefinementFailure(`The refinement run failed (${failure}). Refine again, or add Done-when criteria by hand.`);

    try {
      if (await fs.exists(file)) {
        const written = (await fs.read(file)).trim();
        if (written.length > 0) return written;
      }
    } catch (e) {
      this.deps.log.warn('refinement.file_unreadable', { error: errorMessage(e) });
    } finally {
      await fs.remove(dir, { recursive: true }).catch(() => undefined);
    }
    return chunks.join('\n').trim();
  }

  /**
   * The document against its contract and against the mission. A pass that
   * proposes nothing for a request with no criteria has not done its job: the
   * request still could not be planned, so it is sent back once.
   */
  #check(missionId: MissionId, source: string): { ok: true; value: RefinementContent } | { ok: false; error: readonly string[] } {
    if (source.length === 0) return { ok: false, error: [`no Refinement document was written`] };
    const parsed = this.deps.parser.parse('Refinement', source);
    if (!parsed.ok) return { ok: false, error: parsed.error.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)) };
    const front = parsed.value.frontMatter as unknown as RefinementFront;
    const accepted = new Set(this.deps.criteria.listActive(missionId).filter((c) => c.source === 'user').map((c) => normal(c.statement)));
    // A proposal that restates an accepted criterion would only ask the person to decide it twice.
    const statements = [...new Set(front.proposedCriteria.map((c) => c.statement.trim()))].filter((s) => !accepted.has(normal(s)));
    if (accepted.size === 0 && statements.length === 0) {
      return { ok: false, error: ['proposedCriteria: propose at least one criterion. The request has no Done-when criteria yet, so it cannot be planned without one'] };
    }
    return {
      ok: true,
      value: {
        handoff: front.handoff,
        statements,
        questions: front.questions.map((q) => ({ text: q.text, why: q.why ?? '', options: q.options ?? [] })),
        body: parsed.value.body,
      },
    };
  }

  async #ingest(mission: Mission, source: string, content: RefinementContent): Promise<void> {
    // The person may have planned (or cancelled) while the agent was reading:
    // proposals for a request that has moved on would reopen what was decided.
    const current = this.deps.missions.get(mission.id);
    if (current === undefined || current.status !== 'DRAFT') {
      this.deps.recorder.note(scopeOf(mission), 'The refinement finished after the mission left draft, so its proposals were not recorded.', 'warn');
      return;
    }
    const previous = this.deps.artifacts.latest(mission.id, 'Refinement');
    const manifest = await this.deps.artifactStore.write({
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      taskId: null,
      createdByRunId: null,
      type: 'Refinement',
      // Named after the mission, not the agent's title line (see refinementTitle).
      title: refinementTitle(mission.title),
      body: source,
      sourceRefs: [],
      supersedes: previous?.id ?? null,
      summary: content.handoff.headline,
    });
    const measured = this.deps.measure.measure('Refinement', content.body);
    // Written by the product agent; answered for by whoever asked for the mission.
    const recorded = this.deps.artifacts.create({
      ...manifest, authorId: RUNTIME_ACTOR, responsibleId: mission.createdBy ?? null, recordedBy: SYSTEM_ACTOR,
      handoff: content.handoff, wordCount: measured.mainWords, overBudget: false,
    });
    const autonomous = mission.autonomy === 'autonomous';
    const { proposed, asked } = this.deps.unitOfWork.transaction(() => {
      const rows = this.deps.criteria.propose(mission.id, recorded.id, content.statements);
      const questions = this.deps.questions.replaceOpen(mission.id, recorded.id, content.questions);
      // Autonomy decides what an agent may decide: accepting a criterion is
      // reversible scope, answering the person's question is not (P6 ruling 9).
      if (autonomous) for (const row of rows) this.deps.criteria.decide(row.id, 'accept', { decidedBy: AUTONOMY_DECIDER });
      return { proposed: rows, asked: questions };
    });
    const scope = scopeOf(mission);
    this.deps.recorder.record(scope, { type: 'artifact.created', artifactId: recorded.id });
    this.deps.recorder.note(scope, `Refinement proposed ${count(proposed.length, 'criterion', 'criteria')} and asked ${count(asked.length, 'question', 'questions')}.`);
    if (autonomous && proposed.length > 0) {
      this.deps.recorder.note(scope, `Accepted ${count(proposed.length, 'criterion', 'criteria')} automatically (autonomy: autonomous). Questions still wait for you.`);
    }
    this.deps.recorder.invalidate('artifacts', mission.id);
    this.#changed(mission.id);
  }

  // ---------------------------------------------------------------- helpers

  /** What intake made of the uploads, as the pass reads it: an uploaded spec is where Done-when lines come from. */
  #intakeContext(missionId: MissionId): readonly { readonly type: string; readonly title: string; readonly headline: string }[] {
    const artifacts = this.deps.artifacts.listByMission(missionId);
    return missionUploads(artifacts).flatMap((evidence) => {
      const intake = intakeArtifactFor(evidence, artifacts);
      return intake === undefined ? [] : [{ type: intake.type, title: intake.title, headline: intake.handoff?.headline ?? intake.summary ?? '' }];
    });
  }

  #requireDraft(missionId: MissionId, verb: string): Mission {
    const mission = this.deps.missions.get(missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    if (mission.status !== 'DRAFT') {
      throw new TandemiseError('PRECONDITION_FAILED',
        `A mission in ${mission.status} cannot be ${verb} here: refinement happens before planning. Give feedback on its tasks instead.`,
        { details: { missionId, status: mission.status } });
    }
    return mission;
  }

  #changed(missionId: MissionId): void {
    this.deps.recorder.invalidate('refinement', missionId);
    this.deps.recorder.invalidate('criteria', missionId);
    this.deps.recorder.invalidate('missions', missionId);
  }
}

interface RefinementFront {
  readonly title: string;
  readonly handoff: ArtifactHandoff;
  readonly proposedCriteria: readonly { readonly key: string; readonly statement: string }[];
  readonly questions: readonly { readonly key: string; readonly text: string; readonly why?: string; readonly options?: readonly string[] }[];
}

interface RefinementContent {
  readonly handoff: ArtifactHandoff;
  readonly statements: readonly string[];
  readonly questions: readonly { readonly text: string; readonly why: string; readonly options: readonly string[] }[];
  readonly body: string;
}

function scopeOf(mission: Mission): EventScope {
  return { workspaceId: mission.workspaceId, missionId: mission.id };
}

function normal(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function criterionView(c: MissionCriterion, trackerKey: () => string | null): RefinementCriterionView {
  const origin = c.refinementArtifactId !== null || c.status !== 'accepted' || /^P\d+$/.test(c.key)
    ? 'refinement'
    : c.decidedBy === ISSUE_CRITERIA_AUTHOR ? 'issue'
      // Lines read from the tracker item the mission was made from (#185): never "Added by you".
      : c.decidedBy === TRACKER_CRITERIA_AUTHOR ? 'tracker'
        : c.decidedBy !== null ? 'added' : 'request';
  const key = origin === 'tracker' ? trackerKey() : null;
  return {
    ...(origin === 'tracker' ? { originLabel: key === null ? 'From the tracker item' : `From ${key}` } : {}),
    id: c.id,
    key: c.key,
    statement: c.statement,
    status: c.status,
    origin,
    decidedBy: c.decidedBy === null ? null : c.decidedBy === AUTONOMY_DECIDER ? 'autonomy' : 'person',
    decidedById: c.decidedBy === null || c.decidedBy === AUTONOMY_DECIDER ? null : c.decidedBy,
    createdAt: c.createdAt,
    decidedAt: c.decidedAt,
  };
}

function questionView(q: MissionQuestion): RefinementQuestionView {
  return {
    id: q.id,
    key: q.key,
    text: q.text,
    why: q.why,
    options: q.options,
    status: q.status,
    answer: q.answer,
    answeredBy: q.answeredBy,
    createdAt: q.createdAt,
    answeredAt: q.answeredAt,
  };
}

