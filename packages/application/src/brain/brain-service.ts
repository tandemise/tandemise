import { randomBytes } from 'node:crypto';
import { rename, stat } from 'node:fs/promises';
import { stringify as stringifyYaml } from 'yaml';
import type {
  BrainEntry, BrainHostPort, BrainMemory, BrainRecordRepositoryPort, BrainRepoPort, BrainWrite, DecisionRepositoryPort,
  IssueRepositoryPort, LedgerEvent, MissionRepositoryPort, RunRepositoryPort, RunScoreRepositoryPort, TaskRepositoryPort,
  WorkspaceBrain, WorkspaceBrainRepositoryPort, WriterId,
} from '@tandemise/domain';
import { TERMINAL_MISSION_STATUSES, foldLedger, isTrialMission, isValidAt, makeWriterId } from '@tandemise/domain';
import type { BrainAdoptPreview, BrainEntryView, BrainFactoryView, BrainProposalView, BrainView, RememberView, RunBrainView, SetupItemView } from '@tandemise/api-contract';
import { listProjectWorkflows } from './workflows.js';
import type { Clock, Logger, MissionId, TaskId, TandemisePaths, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage, slugify } from '@tandemise/shared';
import { LedgerReader, type LedgerAt } from './memory.js';
import { LedgerWriter, type LedgerActor, type LedgerEventInput } from './ledger-writer.js';
import { historyEntry } from './history.js';
import { Promotions, type PromotionBundle, type PromotionsDeps } from './promotion.js';
import type { LoadedWorkflow, SettingsStorePort, SkillFilesPort } from '../ports.js';
import { BrainFactory } from './factory-cache.js';
import type { WorkspaceService } from '../services.js';
import type { SetupService } from '../services/setup-service.js';
import type { SkillService } from '../services/skill-service.js';
import type { EventRecorder } from '../support/event-recorder.js';
import type { Caller, IdentityPort } from '../support/identity.js';
import { renderSetup, type SetupChoice } from '../setup/codec.js';
import { BRAIN_PULL_STALE_MS, BRAIN_RULES_WARN_CHARS } from './constants.js';
import { createBrainLayout, scrubDocument } from './create-layout.js';
import { decisionFiles } from './decisions.js';
import {
  BRAIN_EVALS, BRAIN_FACTORY, BRAIN_MANIFEST, BRAIN_RULES, readBrainManifest, remoteOf, type BrainManifest,
} from './layout.js';

export const EVALS_REFUSAL = 'The evals folder can only be changed by a person.';
const INSTALL_ID_KEY = 'brainInstallId';
const DEFAULT_BRANCH = 'main';

export interface BrainServiceDeps {
  readonly brains: WorkspaceBrainRepositoryPort;
  readonly records: BrainRecordRepositoryPort;
  readonly repo: BrainRepoPort;
  readonly host: BrainHostPort;
  readonly setup: Pick<SetupService, 'snapshotFor' | 'previewFiles' | 'applyFiles' | 'isApplyingFromBrain'>;
  readonly skills: Pick<SkillService, 'content'>;
  /** This machine's skills store, filled from the brain's vendored copies (spec §2). */
  readonly skillFiles?: Pick<SkillFilesPort, 'store' | 'read'>;
  readonly decisions: Pick<DecisionRepositoryPort, 'listByWorkspace'>;
  readonly workspaces: Pick<WorkspaceService, 'view'>;
  readonly paths: TandemisePaths;
  readonly settings: SettingsStorePort;
  readonly identity: IdentityPort;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
  /** For the ledger: trial guard, history, "Loaded in N runs" and run links (Task 9). */
  readonly missions?: Pick<MissionRepositoryPort, 'get' | 'list'>;
  readonly tasks?: Pick<TaskRepositoryPort, 'get' | 'listByMission'>;
  readonly runs?: Pick<RunRepositoryPort, 'get' | 'listByMission' | 'update'>;
  readonly runScores?: Pick<RunScoreRepositoryPort, 'list' | 'listByTask'>;
  readonly issues?: Pick<IssueRepositoryPort, 'getLink'>;
  /** The code repositories' workflows, for the Factory tab (shadowed ones, Move into the brain). */
  readonly workflowSource?: import('../ports.js').WorkflowSourcePort;
  /** For promotions (Task 14): the promoter's runtime, the project's rows and the eval port. */
  readonly promotion?: Omit<PromotionsDeps, 'repo' | 'host' | 'records' | 'clock' | 'log' | 'paths'>;
  /**
   * The project's intake as it is set up before it has a brain (#52): a new
   * brain's first commit carries it as `factory/tracker.yaml` and
   * `factory/intake.yaml` (spec §3, "the P15 export of the current setup"),
   * and the person making the brain keeps each source running here (Ruling 22).
   */
  readonly intake?: BrainIntakeExport;
}

/** What a new brain takes from the project's local intake settings. */
export interface BrainIntakeExport {
  /** The local configuration, or null when the project has none. */
  current(workspaceId: WorkspaceId): {
    readonly tracker: unknown;
    readonly sources: readonly { readonly id: string }[];
    readonly dailyCap: number;
    readonly similarity: { readonly link: number; readonly ask: number };
  } | null;
  /** Records each source as on on this machine, by `caller`, unless this machine already says. */
  keepOnHere(caller: Caller, workspaceId: WorkspaceId): void;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  hold: 'your hold', rejection: 'a change you asked for', gate: 'a failed check', person: 'you', agent: 'an agent', mission: 'a mission',
};

/** Something that runs after a sync moved `lastPulledSha` (the factory cache, intake config, promotions). */
export type BrainSyncListener = (workspaceId: WorkspaceId, from: string | null, to: string | null) => Promise<void>;

interface BrainInfo {
  rules: number;
  lessons: number;
  candidates: number;
  mcpsNeeded: number;
  problems: string[];
}

interface PendingAdopt {
  readonly remote: string;
  readonly clonePath: string;
  readonly head: string;
}

/**
 * A project's brain (#51): linking, the daemon's clone, pull and push.
 *
 * The daemon owns its clone under `TANDEMISE_HOME/brains/<workspaceId>/`.
 * Every git call for one project is serialised, so a background pull, a
 * ledger flush and a person's edit never race on the same clone. A failed
 * pull or push never blocks work: the clone stays usable and the Brain
 * section says, in words, what happened.
 */
export class BrainService {
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #info = new Map<string, BrainInfo>();
  readonly #pending = new Map<string, PendingAdopt>();
  readonly #listeners: BrainSyncListener[] = [];
  /**
   * Projects whose listeners have seen their brain since this daemon started
   * (#153). The listeners keep what they read in memory, so a restart starts
   * them empty; until they are told once, the brain's tracker is unknown.
   */
  readonly #announced = new Set<string>();

  readonly #factory: BrainFactory;
  readonly #promotions: Promotions | null;
  readonly #manifests = new Map<string, BrainManifest>();
  readonly #reader: LedgerReader;
  readonly #writer: LedgerWriter;
  /** The ledger at each project's `lastPulledSha`, so listing lessons needs no git call. */
  readonly #ledger = new Map<string, { sha: string; at: LedgerAt }>();

  constructor(private readonly deps: BrainServiceDeps) {
    this.#reader = new LedgerReader(deps.repo);
    this.#writer = new LedgerWriter(this, {
      repo: deps.repo,
      missions: deps.missions ?? { get: () => undefined },
      workspaces: deps.workspaces,
      clock: deps.clock,
      log: deps.log,
    });
    this.#factory = new BrainFactory(this, {
      repo: deps.repo, host: deps.host, setup: deps.setup, skillFiles: deps.skillFiles, identity: deps.identity,
      recorder: deps.recorder, log: deps.log,
    });
    this.resolveConflict = (ws, conflicted) => this.#factory.resolveConflict(ws, conflicted);
    this.beforeAdoptPreview.push(async (_ws, clonePath, head) => { await this.#factory.fillSkills(clonePath, head); });
    this.#promotions = deps.promotion === undefined ? null : new Promotions(this, {
      ...deps.promotion, repo: deps.repo, host: deps.host, records: deps.records, clock: deps.clock, log: deps.log, paths: deps.paths,
    });

  }

  /** A person's edit in the app on this project (Team → Roles, routines, settings): written through (spec §8). */
  edited(workspaceId: WorkspaceId, what: string): void {
    this.#factory.edited(workspaceId, what);
  }

  /** Waits for a scheduled write-through to finish. */
  settleEdits(workspaceId: WorkspaceId): Promise<void> {
    return this.#factory.settle(workspaceId);
  }

  /** The brain's own workflows, read at the last pull (spec §2 precedence). */
  brainWorkflows(workspaceId: WorkspaceId): Promise<readonly LoadedWorkflow[]> {
    return this.#factory.brainWorkflows(workspaceId);
  }

  /**
   * The brain commit this machine's factory rows were last refreshed to. It
   * moves only when a refresh succeeds, so a failed one is retried at the next
   * sync and write-through never takes a stale database for your edit.
   */
  readonly #factoryShas = new Map<string, string>();

  /** Before `lastPulledSha` moves outside a sync: the factory rows still reflect the commit before. */
  #holdFactorySha(workspaceId: WorkspaceId): void {
    const sha = this.deps.brains.get(workspaceId)?.lastPulledSha ?? null;
    if (!this.#factoryShas.has(workspaceId) && sha !== null) this.#factoryShas.set(workspaceId, sha);
  }

  factorySha(workspaceId: WorkspaceId): string | null {
    return this.#factoryShas.get(workspaceId) ?? this.deps.brains.get(workspaceId)?.lastPulledSha ?? null;
  }

  /** Refreshes the database from the brain up to `to`; throws when it could not. */
  async #refreshFactoryTo(workspaceId: WorkspaceId, to: string | null): Promise<string | null> {
    if (to === null) return null;
    const from = this.factorySha(workspaceId);
    if (from === to) return null;
    try {
      await this.#factory.refreshFactory(workspaceId, from, to);
      this.#factoryShas.set(workspaceId, to);
      return null;
    } catch (e) {
      this.deps.log.warn('brain.factory_refresh_failed', { workspaceId, error: errorMessage(e) });
      return `The factory couldn't be updated from the brain: ${errorMessage(e)}`;
    }
  }

  /** A local-only brain moved: its new head is what the next run reads. */
  markPulled(workspaceId: WorkspaceId, sha: string | null): void {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined) return;
    this.#holdFactorySha(workspaceId);
    this.deps.brains.update(workspaceId, { lastPulledSha: sha, lastSyncAt: this.deps.clock.now() });
  }

  /** A problem to show on the Brain section until the next sync. */
  reportProblem(workspaceId: WorkspaceId, problem: string): void {
    this.extraProblems.set(workspaceId, [...(this.extraProblems.get(workspaceId) ?? []), problem]);
    const info = this.#info.get(workspaceId);
    if (info !== undefined) info.problems.push(problem);
    this.deps.log.warn('brain.problem', { workspaceId, problem });
  }

  /** Registers work that follows a sync (Task 6's factory refresh, intake config, promotions). */
  onSync(listener: BrainSyncListener): void {
    this.#listeners.push(listener);
  }

  /** The project's link on this machine, if any. */
  linkOf(workspaceId: WorkspaceId): WorkspaceBrain | undefined {
    return this.deps.brains.get(workspaceId);
  }

  // ------------------------------------------------------------------ view

  view(workspaceId: WorkspaceId): BrainView {
    const row = this.deps.brains.get(workspaceId);
    const info = this.#info.get(workspaceId) ?? { rules: 0, lessons: 0, candidates: 0, mcpsNeeded: 0, problems: [] };
    if (row === undefined) {
      return {
        linked: false, remote: null, remoteUrl: null, writerId: null, lastPulledSha: null, lastPushedSha: null, lastSyncAt: null,
        status: 'unlinked', statusLine: 'This project has no brain yet.', problems: [],
        counts: { rules: 0, lessons: 0, candidates: 0, mcpsNeeded: 0 },
      };
    }
    const when = row.lastSyncAt === null ? '' : ` (last synced ${clockTime(row.lastSyncAt)})`;
    let status: BrainView['status'];
    let statusLine: string;
    const problems = [...info.problems];
    if (row.remote === null) {
      status = 'local_only';
      statusLine = 'This brain is only on this machine. Share it to work with others.';
    } else if (row.lastSyncError !== null && row.lastSyncError.startsWith("Couldn't reach")) {
      status = 'offline';
      statusLine = `Working from your copy of the brain${when}. ${row.lastSyncError}`;
    } else if (row.fallbackBranch !== null) {
      status = 'protected';
      statusLine = `Your default branch is protected, so lessons go to a pull request: ${this.fallbackPr.get(workspaceId) ?? row.fallbackBranch}.`;
    } else {
      status = 'up_to_date';
      statusLine = `Up to date${when}.`;
    }
    if (row.lastSyncError !== null && status !== 'offline') problems.unshift(row.lastSyncError);
    return {
      linked: true,
      remote: row.remote,
      remoteUrl: row.remote !== null && row.remote.startsWith('github.com/') ? `https://${row.remote}` : null,
      writerId: row.writerId,
      lastPulledSha: row.lastPulledSha,
      lastPushedSha: row.lastPushedSha,
      lastSyncAt: row.lastSyncAt,
      status,
      statusLine,
      problems,
      counts: { rules: info.rules, lessons: info.lessons, candidates: info.candidates, mcpsNeeded: info.mcpsNeeded },
    };
  }

  /** The PR a protected default branch sends ledger commits to, once known (Task 9). */
  readonly fallbackPr = new Map<string, string>();

  // ------------------------------------------------------------------ linking

  async link(caller: Caller, workspaceId: WorkspaceId, req: LinkRequest): Promise<BrainView | BrainAdoptPreview> {
    this.deps.workspaces.view(workspaceId);
    const existing = this.deps.brains.get(workspaceId);
    if (existing !== undefined) {
      throw new TandemiseError('CONFLICT', `This project already has a brain: ${existing.remote ?? 'on this machine'}.`);
    }
    return this.#exclusive(workspaceId, async () => {
      switch (req.mode) {
        case 'create': return this.#create(caller, workspaceId, req.owner, req.name);
        case 'local': return this.#local(caller, workspaceId);
        case 'adopt': return this.#adoptPreview(workspaceId, req.remote);
      }
    });
  }

  async applyAdopt(caller: Caller, workspaceId: WorkspaceId, req: { hash: string; choices: Readonly<Record<string, SetupChoice>> }): Promise<BrainView> {
    const pending = this.#pending.get(workspaceId);
    if (pending === undefined) throw TandemiseError.validation('Preview the brain first, then link it.');
    if (this.deps.brains.get(workspaceId) !== undefined) {
      throw new TandemiseError('CONFLICT', `This project already has a brain: ${this.deps.brains.get(workspaceId)?.remote ?? 'on this machine'}.`);
    }
    return this.#exclusive(workspaceId, async () => {
      const files = await this.factoryFiles(pending.clonePath, pending.head);
      const { hash } = await this.deps.setup.previewFiles(workspaceId, files);
      if (hash !== req.hash) throw new TandemiseError('CONFLICT', 'The brain changed since the preview. Preview again.');
      await this.deps.setup.applyFiles(caller, workspaceId, files, { choices: req.choices, mode: 'import' });
      this.deps.brains.create({
        workspaceId, remote: pending.remote, defaultBranch: DEFAULT_BRANCH, clonePath: pending.clonePath, writerId: this.#writerId(),
        lastPulledSha: pending.head, lastPushedSha: pending.head, lastSyncAt: this.deps.clock.now(), lastSyncError: null,
        fallbackBranch: null, linkedAt: this.deps.clock.now(),
      });
      this.#pending.delete(workspaceId);
      this.deps.log.info('brain.adopted', { workspaceId, remote: pending.remote });
      await this.#notify(workspaceId, null, pending.head);
      await this.#refreshInfo(workspaceId);
      this.deps.recorder.invalidate('workspaces');
      return this.view(workspaceId);
    });
  }

  async unlink(caller: Caller, workspaceId: WorkspaceId): Promise<BrainView> {
    void caller;
    // What this machine learned and your last edit reach the brain before it is let go.
    if (this.deps.brains.get(workspaceId) !== undefined) {
      await this.#factory.settle(workspaceId).catch(() => undefined);
      await this.#writer.flush(workspaceId).catch(() => undefined);
    }
    this.#factory.cancel(workspaceId);
    return this.#exclusive(workspaceId, async () => {
      const row = this.deps.brains.get(workspaceId);
      if (row === undefined) return this.view(workspaceId);
      // The database already holds the factory as of lastPulledSha (the cache
      // refresh keeps it current), so nothing else needs copying. The clone stays.
      this.deps.brains.remove(workspaceId);
      this.#info.delete(workspaceId);
      await this.#notify(workspaceId, row.lastPulledSha, null);
      this.deps.log.info('brain.unlinked', { workspaceId });
      this.deps.recorder.invalidate('workspaces');
      return this.view(workspaceId);
    });
  }

  /** "Share this brain": a brain kept on this machine gets a GitHub remote. */
  async share(caller: Caller, workspaceId: WorkspaceId, req: { owner: string; name: string }): Promise<BrainView> {
    void caller;
    return this.#exclusive(workspaceId, async () => {
      const row = this.#require(workspaceId);
      if (row.remote !== null) throw new TandemiseError('CONFLICT', `This brain is already shared: ${row.remote}.`);
      const created = await this.deps.host.createRepo(req.owner, req.name);
      const remote = remoteOf(created.remote);
      await this.deps.repo.setRemote(row.clonePath, remote);
      const pushed = await this.deps.repo.push(row.clonePath, row.defaultBranch, { setUpstream: true });
      const head = await this.deps.repo.head(row.clonePath);
      this.deps.brains.update(workspaceId, {
        remote, lastPushedSha: pushed === 'pushed' ? head : null, lastSyncAt: this.deps.clock.now(),
        lastSyncError: pushed === 'pushed' ? null : `Couldn't reach ${hostOf(remote)}.`,
      });
      this.deps.recorder.invalidate('workspaces');
      return this.view(workspaceId);
    });
  }

  // ------------------------------------------------------------------ sync

  async sync(workspaceId: WorkspaceId, why: 'start' | 'stale' | 'background' | 'person'): Promise<BrainView> {
    if (this.deps.brains.get(workspaceId) === undefined) return this.view(workspaceId);
    // What this machine learned goes up before the pull, so a person's Sync shares it.
    await this.#writer.flush(workspaceId);
    await this.#exclusive(workspaceId, async () => {
      try {
        await this.#syncLocked(workspaceId, why);
      } finally {
        await this.#announceOnce(workspaceId);
      }
    });
    return this.view(workspaceId);
  }

  /**
   * The first sync after a start tells the listeners about the brain as of
   * `lastPulledSha` (from null, as a link does) when the sync itself did not:
   * the head did not move, or the remote was out of reach (#153). Without it,
   * a project whose tracker comes from its brain had none after a restart.
   */
  async #announceOnce(workspaceId: WorkspaceId): Promise<void> {
    if (this.#announced.has(workspaceId)) return;
    const sha = this.deps.brains.get(workspaceId)?.lastPulledSha ?? null;
    if (sha === null) return;
    await this.#notify(workspaceId, null, sha);
    this.deps.recorder.invalidate('workspaces');
  }

  /** The brain commit an attempt reads: the head after a pull, when the last pull is stale. */
  async pin(workspaceId: WorkspaceId): Promise<string | null> {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined) return null;
    const age = row.lastSyncAt === null ? Infinity : this.deps.clock.epochMs() - Date.parse(row.lastSyncAt);
    if (age > BRAIN_PULL_STALE_MS || row.lastPulledSha === null) await this.sync(workspaceId, 'stale');
    return this.deps.brains.get(workspaceId)?.lastPulledSha ?? null;
  }

  /** A file at a commit. `evals/` is never readable this way (spec §8). */
  async readAt(workspaceId: WorkspaceId, sha: string, path: string): Promise<string | null> {
    if (isEvalsPath(path)) throw TandemiseError.validation(EVALS_REFUSAL);
    const row = this.#require(workspaceId);
    return this.deps.repo.readAt(row.clonePath, sha, path);
  }

  /** Files under a directory at a commit, `evals/` excluded. */
  async listAt(workspaceId: WorkspaceId, sha: string, dir: string): Promise<readonly string[]> {
    if (isEvalsPath(dir)) throw TandemiseError.validation(EVALS_REFUSAL);
    const row = this.#require(workspaceId);
    return (await this.deps.repo.listAt(row.clonePath, sha, dir)).filter((p) => !isEvalsPath(p));
  }

  /** A curated text (a rule, a promoter's draft) scrubbed against this project's repositories. */
  scrubDocumentFor(workspaceId: WorkspaceId, text: string): string {
    const repos = this.deps.workspaces.view(workspaceId).repositories.map((r) => ({ name: r.name, path: r.path }));
    return scrubDocument(text, repos);
  }

  /** The brain manifest at a commit; the defaults when it is missing or broken. */
  async manifestAt(workspaceId: WorkspaceId, sha: string): Promise<BrainManifest> {
    const text = await this.readAt(workspaceId, sha, BRAIN_MANIFEST);
    const read = text === null ? null : readBrainManifest(text);
    if (read !== null && 'manifest' in read) return read.manifest;
    return {
      version: 1, project: this.deps.workspaces.view(workspaceId).workspace.name, repositories: [],
      promotion: { autoApply: 'off', minHelpful: 3, minMissions: 2 }, humanEdits: 'direct',
    };
  }

  /** `factory/` at a commit, as setup files relative to it. */
  async factoryFiles(clonePath: string, sha: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const path of await this.deps.repo.listAt(clonePath, sha, BRAIN_FACTORY)) {
      const text = await this.deps.repo.readAt(clonePath, sha, path);
      if (text !== null) files[path.slice(BRAIN_FACTORY.length + 1)] = text;
    }
    return files;
  }

  /**
   * Runs `fn` with this project's clone to itself. Exposed for the ledger
   * writer and write-through, which commit to the same clone.
   */
  exclusive<T>(workspaceId: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    return this.#exclusive(workspaceId, fn);
  }

  /** Pushes the default branch; a rejected push rebases once and tries again (spec §4). */
  async pushLocked(workspaceId: WorkspaceId): Promise<'pushed' | 'rejected' | 'protected' | 'offline' | 'local'> {
    const row = this.#require(workspaceId);
    if (row.remote === null) return 'local';
    let result = await this.deps.repo.push(row.clonePath, row.defaultBranch);
    if (result === 'rejected') {
      const rebased = await this.deps.repo.fetchAndRebase(row.clonePath, row.defaultBranch);
      if (rebased.offline === null && rebased.conflicted.length === 0) result = await this.deps.repo.push(row.clonePath, row.defaultBranch);
    }
    const head = await this.deps.repo.head(row.clonePath);
    this.#holdFactorySha(workspaceId);
    if (result === 'pushed') this.deps.brains.update(workspaceId, { lastPushedSha: head, lastPulledSha: head, lastSyncError: null, lastSyncAt: this.deps.clock.now(), fallbackBranch: null });
    else if (result === 'offline') this.deps.brains.update(workspaceId, { lastSyncError: `Couldn't reach ${hostOf(row.remote)}.` });
    else if (result === 'protected') await this.#ledgerFallback(workspaceId);
    return result;
  }

  /**
   * The default branch refuses this daemon's push (spec §4): its commits go to
   * `tandemise/ledger/<writerId>` and one standing PR, "Lessons from <writerId>".
   */
  async #ledgerFallback(workspaceId: WorkspaceId): Promise<void> {
    const row = this.#require(workspaceId);
    const branch = `tandemise/ledger/${row.writerId}`;
    await this.deps.repo.branch(row.clonePath, branch, `refs/heads/${row.defaultBranch}`);
    const pushed = await this.deps.repo.push(row.clonePath, branch);
    const head = await this.deps.repo.head(row.clonePath);
    this.#holdFactorySha(workspaceId);
    this.deps.brains.update(workspaceId, { fallbackBranch: branch, lastPulledSha: head, lastSyncAt: this.deps.clock.now() });
    if (pushed !== 'pushed') {
      this.reportProblem(workspaceId, `Couldn't push lessons to ${branch}.`);
      return;
    }
    try {
      const found = await this.deps.host.findPr(row.clonePath, branch);
      if (found !== null && found.state === 'open') {
        this.fallbackPr.set(workspaceId, found.url);
        return;
      }
      const pr = await this.deps.host.openPr({
        clone: row.clonePath, head: branch, base: row.defaultBranch, title: `Lessons from ${row.writerId}`, draft: false,
        body: `## What and why\n\nThe default branch of this brain is protected, so the lessons and votes ${row.writerId} records go here. Merge it to share them.\n`,
      });
      this.fallbackPr.set(workspaceId, pr.url);
    } catch (e) {
      this.reportProblem(workspaceId, `Couldn't open the lessons pull request: ${errorMessage(e)}`);
    }
  }

  // ------------------------------------------------------------------ internals

  async #syncLocked(workspaceId: WorkspaceId, why: string): Promise<void> {
    const row = this.#require(workspaceId);
    const from = row.lastPulledSha;
    if (row.remote === null) {
      const head = await this.deps.repo.head(row.clonePath);
      const refreshError = await this.#refreshFactoryTo(workspaceId, head);
      this.deps.brains.update(workspaceId, { lastPulledSha: head, lastSyncAt: this.deps.clock.now(), lastSyncError: refreshError });
      if (head !== from) await this.#notify(workspaceId, from, head);
      await this.#refreshInfo(workspaceId);
      return;
    }
    const pulled = await this.deps.repo.fetchAndRebase(row.clonePath, row.defaultBranch);
    if (pulled.offline !== null) {
      this.deps.log.warn('brain.offline', { workspaceId, why, detail: pulled.offline });
      this.deps.brains.update(workspaceId, { lastSyncError: `Couldn't reach ${hostOf(row.remote)}.` });
      this.deps.recorder.invalidate('workspaces');
      return;
    }
    if (pulled.failed !== undefined) {
      this.deps.log.warn('brain.rebase_failed', { workspaceId, why, detail: pulled.failed });
      this.deps.brains.update(workspaceId, { lastSyncError: `Couldn't update from the brain: ${pulled.failed}` });
      this.deps.recorder.invalidate('workspaces');
      return;
    }
    let syncError: string | null = null;
    if (pulled.conflicted.length > 0) syncError = await this.resolveConflict(workspaceId, pulled.conflicted);
    const ahead = (await this.deps.repo.head(row.clonePath)) !== (await this.deps.repo.head(row.clonePath, `refs/remotes/origin/${row.defaultBranch}`));
    let pushed: string | null = null;
    if (ahead) pushed = await this.pushLocked(workspaceId);
    const head = await this.deps.repo.head(row.clonePath);
    const refreshError = await this.#refreshFactoryTo(workspaceId, head);
    // An offline push keeps its words; a clean sync clears them.
    const pushError = pushed === 'offline' ? (this.deps.brains.get(workspaceId)?.lastSyncError ?? null) : null;
    this.deps.brains.update(workspaceId, {
      lastPulledSha: head, lastSyncAt: this.deps.clock.now(), lastSyncError: refreshError ?? syncError ?? pushError,
      ...(ahead ? {} : { lastPushedSha: this.deps.brains.get(workspaceId)?.lastPushedSha ?? head }),
    });
    if (head !== from) await this.#notify(workspaceId, from, head);
    await this.#refreshInfo(workspaceId);
    // Every sync reads the fate of open promotion PRs (spec §8).
    try {
      await this.#promotions?.settle(workspaceId);
    } catch (e) {
      this.deps.log.warn('brain.settle_failed', { workspaceId, error: errorMessage(e) });
    }
    this.deps.recorder.invalidate('workspaces');
  }

  /**
   * A rebase conflicted on a factory, rules or decisions file (spec §9). The
   * default implementation only reports it; Task 6 replaces it with the move
   * to a branch and a pull request.
   */
  resolveConflict: (workspaceId: WorkspaceId, conflicted: readonly string[]) => Promise<string | null> = async (_ws, conflicted) =>
    `Your change to ${conflicted[0] ?? 'the brain'} conflicts with the brain.`;

  async #notify(workspaceId: WorkspaceId, from: string | null, to: string | null): Promise<void> {
    if (to === null) this.#announced.delete(workspaceId);
    else this.#announced.add(workspaceId);
    for (const listener of this.#listeners) {
      try {
        await listener(workspaceId, from, to);
      } catch (e) {
        this.deps.log.warn('brain.sync_listener_failed', { workspaceId, error: errorMessage(e) });
      }
    }
  }

  /** Counts and problems shown on the Brain section, read at `lastPulledSha`. */
  async #refreshInfo(workspaceId: WorkspaceId): Promise<void> {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined || row.lastPulledSha === null) return;
    const problems: string[] = [];
    const rules = (await this.deps.repo.listAt(row.clonePath, row.lastPulledSha, BRAIN_RULES)).filter((p) => p.endsWith('.md'));
    for (const path of rules) {
      const text = (await this.deps.repo.readAt(row.clonePath, row.lastPulledSha, path)) ?? '';
      if (text.length > BRAIN_RULES_WARN_CHARS) problems.push(`${path} is ${text.length.toLocaleString('en-US')} characters. Every agent reads it, so keep it under ${BRAIN_RULES_WARN_CHARS.toLocaleString('en-US')}.`);
    }
    let mcpsNeeded = 0;
    try {
      const { items } = await this.deps.setup.previewFiles(workspaceId, await this.factoryFiles(row.clonePath, row.lastPulledSha));
      mcpsNeeded = items.filter((i) => i.kind === 'mcps' && i.action === 'add').length;
    } catch (e) {
      problems.push(`The brain's factory could not be read: ${errorMessage(e)}`);
    }
    this.#manifests.set(workspaceId, await this.manifestAt(workspaceId, row.lastPulledSha));
    try {
      const at = await this.#reader.eventsAt(row.clonePath, row.lastPulledSha);
      this.#ledger.set(workspaceId, { sha: row.lastPulledSha, at });
      for (const p of at.problems) problems.push(p.problem);
    } catch (e) {
      problems.push(`The brain's memory could not be read: ${errorMessage(e)}`);
    }
    const memory = this.memory(workspaceId);
    const now = this.deps.clock.now();
    const valid = memory.entries.filter((e) => e.kind !== 'history' && isValidAt(e, now));
    this.#info.set(workspaceId, {
      rules: rules.length,
      lessons: valid.filter((e) => e.state === 'active' || e.state === 'accepted').length,
      candidates: valid.filter((e) => e.state === 'candidate').length,
      mcpsNeeded,
      // Problems another part of the brain names (a broken tracker.yaml) come first.
      problems: [...(this.extraProblems.get(workspaceId) ?? []), ...problems],
    });
  }

  // ------------------------------------------------------------------ factory tab

  async factoryView(workspaceId: WorkspaceId): Promise<BrainFactoryView> {
    const row = this.#require(workspaceId);
    const sha = row.lastPulledSha;
    const files = sha === null ? [] : await this.deps.repo.listAt(row.clonePath, sha, BRAIN_FACTORY);
    const items = sha === null ? [] : (await this.deps.setup.previewFiles(workspaceId, await this.factoryFiles(row.clonePath, sha))).items;
    const paths = this.deps.workspaces.view(workspaceId).repositories.map((r) => r.path);
    const listed = this.deps.workflowSource === undefined ? { workflows: [], shadowed: [] }
      : await listProjectWorkflows({ workflows: this.deps.workflowSource, brain: this }, workspaceId, paths);
    return {
      files,
      mcpsNeeded: items.filter((i) => i.kind === 'mcps' && i.action === 'add').map((i) => ({ name: i.name, detail: i.detail })),
      skillsMissing: items.filter((i) => i.needsImport !== null).map((i) => i.name),
      shadowed: listed.shadowed.map((w) => ({ id: w.id, path: w.path })),
      movable: listed.workflows.filter((w) => w.origin === 'repository').map((w) => ({ id: w.id, path: w.path })),
    };
  }

  /** "Move into the brain": a code-repo workflow is copied into factory/workflows/ as your edit (spec §2). */
  async moveWorkflowIn(caller: Caller, workspaceId: WorkspaceId, workflowId: string): Promise<BrainFactoryView> {
    void caller;
    if (this.deps.workflowSource === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'Workflows cannot be read in this build.');
    const paths = this.deps.workspaces.view(workspaceId).repositories.map((r) => r.path);
    const found = (await this.deps.workflowSource.list(paths)).find((w) => w.id === workflowId);
    if (found === undefined || found.text === undefined) throw TandemiseError.notFound('Workflow', workflowId);
    const file = found.path.split(/[\\/]/).pop() ?? `${workflowId}.yaml`;
    await this.#exclusive(workspaceId, async () => {
      const row = this.#require(workspaceId);
      await this.deps.repo.commit(row.clonePath, [{ path: `${BRAIN_FACTORY}/workflows/${file}`, mode: 'write', content: found.text! }], `chore: move the ${workflowId} workflow into the brain`, this.#author());
      if (row.remote !== null) await this.pushLocked(workspaceId);
      else this.markPulled(workspaceId, await this.deps.repo.head(row.clonePath));
    });
    await this.refreshInfo(workspaceId);
    this.deps.recorder.invalidate('workspaces');
    return this.factoryView(workspaceId);
  }

  // ------------------------------------------------------------------ promotion

  /** The project's brain.yaml as of its last pull; defaults until read. */
  cachedManifest(workspaceId: WorkspaceId): BrainManifest {
    return this.#manifests.get(workspaceId) ?? {
      version: 1, project: '', repositories: [], promotion: { autoApply: 'off', minHelpful: 3, minMissions: 2 }, humanEdits: 'direct',
    };
  }

  /** `evals/` for the promotion gate only: no prompt, tool or person-facing read goes through here (spec §8). */
  async readEvalsForPromotion(workspaceId: WorkspaceId, sha: string, path: string): Promise<string | null> {
    if (!isEvalsPath(path)) throw TandemiseError.validation('Only evals/ is read this way.');
    const row = this.#require(workspaceId);
    return this.deps.repo.readAt(row.clonePath, sha, path);
  }

  /** Every file under `evals/` at a ref, for importing the promotion suites. */
  async evalsFilesForPromotion(workspaceId: WorkspaceId, ref: string): Promise<Record<string, string>> {
    const row = this.#require(workspaceId);
    const sha = (await this.deps.repo.head(row.clonePath, ref)) ?? ref;
    const out: Record<string, string> = {};
    for (const path of await this.deps.repo.listAt(row.clonePath, sha, BRAIN_EVALS)) {
      const text = await this.deps.repo.readAt(row.clonePath, sha, path);
      if (text !== null) out[path] = text;
    }
    return out;
  }

  /** A `brain` eval candidate: `factory/` and `memory/rules` at a branch (spec §8). */
  async candidateAt(workspaceId: WorkspaceId, ref: string): Promise<{ files: Record<string, string>; rules: { path: string; text: string }[] }> {
    const row = this.#require(workspaceId);
    const sha = (await this.deps.repo.head(row.clonePath, `refs/heads/${ref}`)) ?? (await this.deps.repo.head(row.clonePath, ref)) ?? ref;
    const files = await this.factoryFiles(row.clonePath, sha);
    const rules: { path: string; text: string }[] = [];
    for (const path of (await this.deps.repo.listAt(row.clonePath, sha, BRAIN_RULES)).filter((p) => p.endsWith('.md'))) {
      const text = await this.deps.repo.readAt(row.clonePath, sha, path);
      if (text !== null) rules.push({ path, text });
    }
    return { files, rules };
  }

  #promotionsOrThrow(): Promotions {
    if (this.#promotions === null) throw new TandemiseError('PRECONDITION_FAILED', 'Promotions are not available in this build.');
    return this.#promotions;
  }

  eligiblePromotions(workspaceId: WorkspaceId): readonly PromotionBundle[] {
    return this.#promotions?.eligible(workspaceId) ?? [];
  }

  proposePromotions(workspaceId: WorkspaceId): Promise<readonly import('@tandemise/domain').BrainProposal[]> {
    return this.#promotionsOrThrow().proposeEligible(workspaceId);
  }

  proposeLessons(workspaceId: WorkspaceId, lessonIds: readonly string[]): Promise<import('@tandemise/domain').BrainProposal | null> {
    return this.#promotionsOrThrow().propose(workspaceId, lessonIds, {});
  }

  /** Eligible lessons become proposals in the background (after a person's vote, after a background sync). */
  proposeSoon(workspaceId: WorkspaceId): void {
    this.#promotions?.proposeSoon(workspaceId);
  }

  /** "Make this a rule" on one lesson; `role` targets the role's instructions. */
  async promoteEntry(caller: Caller, entryId: string, req: { target?: 'rules' | 'role' | undefined }): Promise<import('@tandemise/domain').BrainProposal | null> {
    void caller;
    const found = this.#requireEntry(entryId);
    return this.#promotionsOrThrow().propose(found.workspaceId, [found.entry.id], req.target === undefined ? {} : { target: req.target });
  }

  proposals(workspaceId: WorkspaceId): readonly import('@tandemise/domain').BrainProposal[] {
    return this.deps.records.proposals(workspaceId);
  }

  /** The Proposals tab, in words. */
  proposalViews(workspaceId: WorkspaceId): readonly BrainProposalView[] {
    const memory = this.memory(workspaceId);
    const local = this.deps.brains.get(workspaceId)?.remote === null;
    const STATE: Readonly<Record<string, string>> = {
      evaluating: 'Being evaluated', open: local ? 'Waiting for you' : 'Pull request open', draft: 'Draft: did not pass evals',
      applied: 'Applied on its own', merged: 'Merged', closed: 'Closed without merging', accepted: 'Accepted', declined: 'Declined', reverted: 'Reverted',
    };
    return this.proposals(workspaceId).map((p) => ({
      id: p.id,
      lessons: p.lessonIds.map((id) => ({ id, text: memory.entries.find((e) => e.id === (memory.aliases[id] ?? id))?.text ?? id })),
      targets: p.targets,
      classification: p.classification,
      classificationLine: `${p.classification === 'small' ? 'Small' : 'Structural'}: ${p.reasons.join(' ')}`,
      reasons: p.reasons,
      state: p.state,
      stateLabel: STATE[p.state] ?? p.state,
      verdict: p.verdict,
      verdictLine: p.verdict === 'passed' ? 'Passed the promotion evals.' : p.verdict === 'failed' ? 'Did not pass the promotion evals.'
        : p.verdict === 'not_evaluated' ? 'Not evaluated: this project has no promotion evals yet.' : 'Evals not run yet.',
      prUrl: p.prUrl,
      canAccept: local && p.state === 'open',
      canRevert: p.state === 'applied',
      updatedAt: p.updatedAt,
    }));
  }

  acceptProposal(caller: Caller, id: string): Promise<import('@tandemise/domain').BrainProposal> {
    void caller;
    return this.#promotionsOrThrow().accept(id);
  }

  declineProposal(caller: Caller, id: string): Promise<import('@tandemise/domain').BrainProposal> {
    void caller;
    return this.#promotionsOrThrow().decline(id);
  }

  revertProposal(caller: Caller, id: string): Promise<import('@tandemise/domain').BrainProposal> {
    void caller;
    return this.#promotionsOrThrow().revert(id);
  }

  // ------------------------------------------------------------------ memory

  /** The project's memory: the ledger at its last pull plus what this machine has not committed yet. */
  memory(workspaceId: WorkspaceId): BrainMemory {
    const cached = this.#ledger.get(workspaceId);
    const pending = this.#writer.pending(workspaceId);
    return foldLedger([...(cached?.at.events ?? []), ...pending], cached?.at.problems ?? [], this.deps.clock.now());
  }

  /** The memory at one commit (what a run read). */
  async memoryAt(workspaceId: WorkspaceId, sha: string): Promise<BrainMemory> {
    const row = this.#require(workspaceId);
    return this.#reader.memoryAt(row.clonePath, sha, this.deps.clock.now());
  }

  /** The only way into the ledger: validated, scrubbed, buffered (spec §5). */
  append(workspaceId: WorkspaceId, events: readonly LedgerEventInput[], opts: { actor: LedgerActor; missionId?: MissionId | null }): Promise<readonly LedgerEvent[]> {
    return this.#writer.append(workspaceId, events, opts);
  }

  /** Commits and pushes this machine's buffered ledger events now. */
  flush(workspaceId: WorkspaceId): Promise<void> {
    return this.#writer.flush(workspaceId);
  }

  /** At shutdown: nothing learned is left in memory. */
  flushAll(): Promise<void> {
    return this.#writer.flushAll();
  }

  entries(workspaceId: WorkspaceId, q: { scope?: string | undefined; state?: BrainEntry['state'] | undefined; includeHistory?: boolean | undefined } = {}): readonly BrainEntryView[] {
    if (this.deps.brains.get(workspaceId) === undefined) return [];
    const now = this.deps.clock.now();
    const loaded = this.#loadedIndex(workspaceId);
    return this.memory(workspaceId).entries
      .filter((e) => q.includeHistory === true || (e.kind !== 'history' && isValidAt(e, now)))
      .filter((e) => q.state === undefined || e.state === q.state)
      .filter((e) => q.scope === undefined || q.scope === '' || scopeMatchesFilter(e, q.scope))
      .map((e) => this.#entryView(workspaceId, e, loaded))
      .sort((a, b) => (b.lastConfirmedAt < a.lastConfirmedAt ? -1 : b.lastConfirmedAt > a.lastConfirmedAt ? 1 : 0) || (a.id < b.id ? -1 : 1));
  }

  /** The ledger events about one entry at a commit (its history, for brain.read). */
  async eventsFor(workspaceId: WorkspaceId, sha: string, entryId: string): Promise<readonly LedgerEvent[]> {
    const row = this.#require(workspaceId);
    const { events } = await this.#reader.eventsAt(row.clonePath, sha);
    const memory = foldLedger(events, [], this.deps.clock.now());
    const ids = new Set([entryId, ...Object.entries(memory.aliases).filter(([, to]) => to === entryId).map(([from]) => from)]);
    return events.filter((e) => ids.has(e.id)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  /** An entry as the screens show it. */
  entryView(workspaceId: WorkspaceId, entry: BrainEntry): BrainEntryView {
    return this.#entryView(workspaceId, entry, this.#loadedIndex(workspaceId));
  }

  /** "What it knew" for one run (spec §11). */
  async runBrain(runId: string): Promise<RunBrainView> {
    const run = this.deps.runs?.get(asId<'RunId'>(runId));
    if (run === undefined) throw TandemiseError.notFound('Run', runId);
    const brain = run.brain ?? null;
    if (brain === null) throw TandemiseError.notFound('Brain record for run', runId);
    const mission = this.deps.missions?.get(run.missionId);
    const workspaceId = mission?.workspaceId;
    const link = workspaceId === undefined ? undefined : this.deps.brains.get(workspaceId);
    const views = (ids: readonly string[]): BrainEntryView[] => {
      if (workspaceId === undefined || link === undefined) return [];
      const current = this.memory(workspaceId);
      const loaded = this.#loadedIndex(workspaceId);
      return ids.flatMap((id) => {
        const e = current.entries.find((x) => x.id === (current.aliases[id] ?? id));
        return e === undefined ? [] : [this.#entryView(workspaceId, e, loaded)];
      });
    };
    const loaded = views(brain.loaded.map((l) => l.id));
    const fetched = views(brain.fetched);
    const proposed = views(brain.proposed);
    const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
    const summary = `Loaded ${plural(brain.rules.length, 'rules file', 'rules files')} and ${plural(brain.loaded.length, 'lesson', 'lessons')}`
      + (brain.fetched.length > 0 ? `; read ${brain.fetched.length} more.` : '.');
    const remote = link?.remote ?? null;
    return {
      sha: brain.sha,
      shortSha: brain.sha.slice(0, 7),
      commitUrl: remote !== null && remote.startsWith('github.com/') ? `https://${remote}/commit/${brain.sha}` : null,
      rules: brain.rules,
      loaded, fetched, proposed, summary,
    };
  }

  /** One entry by id, wherever this machine has it. */
  entry(entryId: string): { workspaceId: WorkspaceId; entry: BrainEntryView } | null {
    for (const link of this.deps.brains.list()) {
      const memory = this.memory(link.workspaceId);
      const id = memory.aliases[entryId] ?? entryId;
      const found = memory.entries.find((e) => e.id === id);
      if (found !== undefined) return { workspaceId: link.workspaceId, entry: this.#entryView(link.workspaceId, found, this.#loadedIndex(link.workspaceId)) };
    }
    return null;
  }

  async remember(caller: Caller, workspaceId: WorkspaceId, req: { text: string; scope?: BrainEntry['scope'] | undefined; taskId?: string | undefined }): Promise<RememberView> {
    void caller;
    const mission = this.#missionOfTask(req.taskId);
    const [event] = await this.append(workspaceId, [{
      op: 'add',
      entry: { kind: 'lesson', text: req.text.trim(), scope: cleanScope(req.scope ?? {}), source: { signal: 'person', mission: mission?.title ?? 'Brain screen' }, state: 'active' },
    }], { actor: 'person', missionId: mission?.id ?? null });
    if (event === undefined) throw TandemiseError.validation("Lessons aren't saved during an eval trial.");
    // "From the next run" has to be true: the lesson is committed now, not at the next batch.
    await this.flush(workspaceId);
    const view = this.entry(event.id);
    if (view === null) throw TandemiseError.validation('That lesson could not be saved.');
    const words = view.entry.scopeLabel === 'Whole project' ? 'the whole project' : view.entry.scopeLabel;
    return { entry: view.entry, message: `Saved. Agents on ${words} will see it from the next run.` };
  }

  async vote(caller: Caller, entryId: string, req: { vote: 'helpful' | 'harmful'; taskId?: string | undefined }): Promise<BrainEntryView> {
    void caller;
    const found = this.#requireEntry(entryId);
    const mission = this.#missionOfTask(req.taskId);
    await this.append(found.workspaceId, [{ op: 'vote', id: found.entry.id, vote: req.vote, why: 'person', ...(mission ? { mission: mission.title } : {}) }], { actor: 'person', missionId: mission?.id ?? null });
    return this.#requireEntry(found.entry.id).entry;
  }

  async accept(caller: Caller, entryId: string): Promise<BrainEntryView> {
    return this.#mark(caller, entryId, { op: 'accept' });
  }

  async reject(caller: Caller, entryId: string): Promise<BrainEntryView> {
    return this.#mark(caller, entryId, { op: 'reject' });
  }

  async retire(caller: Caller, entryId: string, req: { reason?: string | undefined } = {}): Promise<BrainEntryView> {
    return this.#mark(caller, entryId, { op: 'retire', reason: req.reason?.trim() || 'Retired by you.' });
  }

  async #mark(caller: Caller, entryId: string, input: { op: 'accept' } | { op: 'reject' } | { op: 'retire'; reason: string }): Promise<BrainEntryView> {
    void caller;
    const found = this.#requireEntry(entryId);
    await this.append(found.workspaceId, [{ ...input, id: found.entry.id } as LedgerEventInput], { actor: 'person' });
    // Accepting or retiring changes what the next run loads, so it is committed now.
    await this.flush(found.workspaceId);
    return this.#requireEntry(found.entry.id).entry;
  }

  /** A mission finished: one history line, written by code (spec §5). Trials teach nothing. */
  async missionEnded(missionId: MissionId): Promise<void> {
    const mission = this.deps.missions?.get(missionId);
    if (mission === undefined || isTrialMission(mission)) return;
    if (!(TERMINAL_MISSION_STATUSES as readonly string[]).includes(mission.status)) return;
    if (this.deps.brains.get(mission.workspaceId) === undefined) return;
    const tasks = this.deps.tasks?.listByMission(missionId) ?? [];
    const scores = tasks.flatMap((t) => this.deps.runScores?.listByTask(t.id) ?? []);
    const link = mission.issueLinkId ? this.deps.issues?.getLink(mission.issueLinkId) : undefined;
    const entry = historyEntry(mission, tasks, scores, { tracker: link?.url ?? null, taskKeys: new Map(tasks.map((t) => [t.id as string, t.key])) });
    if (entry === null) return;
    await this.append(mission.workspaceId, [{ op: 'add', entry }], { actor: 'daemon', missionId });
    await this.flush(mission.workspaceId);
  }

  #requireEntry(entryId: string): { workspaceId: WorkspaceId; entry: BrainEntryView } {
    const found = this.entry(entryId);
    if (found === null) throw TandemiseError.notFound('Lesson', entryId);
    return found;
  }

  #missionOfTask(taskId: string | undefined): { id: MissionId; title: string } | null {
    if (taskId === undefined) return null;
    const task = this.deps.tasks?.get(asId<'TaskId'>(taskId) as TaskId);
    const mission = task === undefined ? undefined : this.deps.missions?.get(task.missionId);
    return mission === undefined ? null : { id: mission.id, title: mission.title };
  }

  /** "Loaded in N runs": computed here from runs.brain and run scores, never stored (spec §7). */
  #loadedIndex(workspaceId: WorkspaceId): Map<string, { runs: number; passedFirstTime: number }> {
    const out = new Map<string, { runs: number; passedFirstTime: number }>();
    if (this.deps.missions === undefined || this.deps.runs === undefined) return out;
    const scores = new Map((this.deps.runScores?.list(workspaceId, '1970-01-01T00:00:00.000Z') ?? []).map((s) => [s.runId as string, s]));
    for (const mission of this.deps.missions.list({ workspaceId })) {
      for (const run of this.deps.runs.listByMission(mission.id)) {
        for (const loaded of run.brain?.loaded ?? []) {
          const row = out.get(loaded.id) ?? { runs: 0, passedFirstTime: 0 };
          row.runs++;
          const score = scores.get(run.id);
          if (score !== undefined && score.gatePassed && score.attempt === 1) row.passedFirstTime++;
          out.set(loaded.id, row);
        }
      }
    }
    return out;
  }

  #entryView(workspaceId: WorkspaceId, e: BrainEntry, loaded: Map<string, { runs: number; passedFirstTime: number }>): BrainEntryView {
    const row = this.deps.brains.get(workspaceId);
    const roles = this.deps.workspaces.view(workspaceId).roles;
    const scopeParts = [
      e.scope.role === undefined ? null : (roles.find((r) => r.id === e.scope.role)?.name ?? e.scope.role),
      e.scope.repo ?? null,
      e.scope.step === undefined ? null : `step ${e.scope.step}`,
      e.scope.paths === undefined || e.scope.paths.length === 0 ? null : e.scope.paths.join(', '),
    ].filter((x): x is string => x !== null);
    const run = e.source.run !== undefined && row !== undefined && e.source.run.daemon === row.writerId
      ? this.deps.runs?.get(asId<'RunId'>(e.source.run.runId)) : undefined;
    const counts = loaded.get(e.id) ?? { runs: 0, passedFirstTime: 0 };
    const notes: string[] = [];
    if (counts.runs > 0) notes.push(`Loaded in ${counts.runs} ${counts.runs === 1 ? 'run' : 'runs'}, ${counts.passedFirstTime} passed first time`);
    if (e.flags.stale) notes.push(`Not confirmed since ${e.lastConfirmedAt.slice(0, 10)}`);
    if (e.flags.harmful) notes.push('Harmful more often than helpful');
    return {
      id: e.id, kind: e.kind, text: e.text, scope: e.scope, state: e.state, helpful: e.helpful, harmful: e.harmful, net: e.net,
      addedAt: e.addedAt, lastConfirmedAt: e.lastConfirmedAt, missions: e.missions, invalidAt: e.invalidAt, supersededBy: e.supersededBy,
      retired: e.retired, promoted: e.promoted, flags: e.flags,
      scopeLabel: scopeParts.length === 0 ? 'Whole project' : scopeParts.join(' · '),
      sourceLabel: SOURCE_LABEL[e.source.signal] ?? 'a mission',
      sourceMission: e.source.mission,
      runLink: run === undefined ? null : { missionId: run.missionId, taskId: run.taskId, runId: run.id },
      loadedIn: counts,
      notes,
    };
  }

  /** Problems other parts of the brain report for the Brain section (a broken tracker.yaml, say). */
  readonly extraProblems = new Map<string, string[]>();

  /** Lesson counts from the ledger fold (Task 9). */
  setLessonCounts(workspaceId: WorkspaceId, lessons: number, candidates: number): void {
    const info = this.#info.get(workspaceId) ?? { rules: 0, lessons: 0, candidates: 0, mcpsNeeded: 0, problems: [] };
    this.#info.set(workspaceId, { ...info, lessons, candidates });
  }

  async refreshInfo(workspaceId: WorkspaceId): Promise<void> {
    await this.#refreshInfo(workspaceId);
  }

  async #create(caller: Caller, workspaceId: WorkspaceId, owner: string, name: string): Promise<BrainView> {
    const created = await this.deps.host.createRepo(owner, name);
    const remote = remoteOf(created.remote);
    const clonePath = await this.#freshClonePath(workspaceId);
    await this.deps.repo.init(clonePath, DEFAULT_BRANCH);
    const project = this.deps.workspaces.view(workspaceId).workspace.name;
    await this.deps.repo.commit(clonePath, await this.#layout(workspaceId), `chore: create the brain for ${project}`, this.#author());
    await this.deps.repo.setRemote(clonePath, remote);
    const pushed = await this.deps.repo.push(clonePath, DEFAULT_BRANCH, { setUpstream: true });
    const head = await this.deps.repo.head(clonePath);
    this.deps.intake?.keepOnHere(caller, workspaceId);
    this.deps.brains.create({
      workspaceId, remote, defaultBranch: DEFAULT_BRANCH, clonePath, writerId: this.#writerId(),
      lastPulledSha: head, lastPushedSha: pushed === 'pushed' ? head : null, lastSyncAt: this.deps.clock.now(),
      lastSyncError: pushed === 'pushed' ? null : `Couldn't reach ${hostOf(remote)}.`, fallbackBranch: null, linkedAt: this.deps.clock.now(),
    });
    this.deps.log.info('brain.created', { workspaceId, remote });
    await this.#notify(workspaceId, null, head);
    await this.#refreshInfo(workspaceId);
    this.deps.recorder.invalidate('workspaces');
    return this.view(workspaceId);
  }

  async #local(caller: Caller, workspaceId: WorkspaceId): Promise<BrainView> {
    const clonePath = await this.#freshClonePath(workspaceId);
    await this.deps.repo.init(clonePath, DEFAULT_BRANCH);
    const project = this.deps.workspaces.view(workspaceId).workspace.name;
    await this.deps.repo.commit(clonePath, await this.#layout(workspaceId), `chore: create the brain for ${project}`, this.#author());
    const head = await this.deps.repo.head(clonePath);
    this.deps.intake?.keepOnHere(caller, workspaceId);
    this.deps.brains.create({
      workspaceId, remote: null, defaultBranch: DEFAULT_BRANCH, clonePath, writerId: this.#writerId(),
      lastPulledSha: head, lastPushedSha: null, lastSyncAt: this.deps.clock.now(), lastSyncError: null,
      fallbackBranch: null, linkedAt: this.deps.clock.now(),
    });
    await this.#notify(workspaceId, null, head);
    await this.#refreshInfo(workspaceId);
    this.deps.recorder.invalidate('workspaces');
    return this.view(workspaceId);
  }

  async #adoptPreview(workspaceId: WorkspaceId, remoteInput: string): Promise<BrainAdoptPreview> {
    const remote = remoteOf(remoteInput);
    const clonePath = await this.#freshClonePath(workspaceId);
    try {
      await this.deps.repo.clone(remote, clonePath);
    } catch (e) {
      throw TandemiseError.validation(`Couldn't read the brain at ${remote}: ${errorMessage(e)}`);
    }
    const head = await this.deps.repo.head(clonePath);
    if (head === null) throw TandemiseError.validation(`${remote} has no commits yet. Create the brain there first, or choose Create a brain.`);
    for (const listener of this.beforeAdoptPreview) await listener(workspaceId, clonePath, head);
    const files = await this.factoryFiles(clonePath, head);
    const { hash, items } = await this.deps.setup.previewFiles(workspaceId, files);
    this.#pending.set(workspaceId, { remote, clonePath, head });
    const rules = (await this.deps.repo.listAt(clonePath, head, BRAIN_RULES)).filter((p) => p.endsWith('.md')).length;
    return {
      hash,
      items: items as readonly SetupItemView[],
      brain: { rules, lessons: 0, mcpsNeeded: items.filter((i) => i.kind === 'mcps' && i.action === 'add').map((i) => i.name) },
    };
  }

  /** Work that must run on a fresh clone before the adopt preview (Task 6 fills the skills store). */
  readonly beforeAdoptPreview: ((workspaceId: WorkspaceId, clonePath: string, head: string) => Promise<void>)[] = [];

  async #layout(workspaceId: WorkspaceId): Promise<BrainWrite[]> {
    const view = this.deps.workspaces.view(workspaceId);
    const repos = view.repositories.map((r) => ({ name: r.name, path: r.path }));
    const scrub = (t: string): string => scrubDocument(t, repos);
    const snapshot = await this.deps.setup.snapshotFor(workspaceId, { mcps: true });
    const rendered = renderSetup(snapshot);
    const skills: { name: string; hash: string; files: { path: string; content: string }[] }[] = [];
    for (const pin of snapshot.skills ?? []) {
      const files = await this.deps.skills.content(pin.hash);
      if (files === null) continue;
      skills.push({ name: pin.name, hash: pin.hash, files: files.map((f) => ({ path: f.path, content: Buffer.from(f.bytes).toString('utf8') })) });
    }
    const manifest: BrainManifest = {
      version: 1,
      project: view.workspace.name,
      // By remote, never by local path (spec §1): a repository with no remote is left out.
      repositories: view.repositories.filter((r) => r.remoteUrl !== null).map((r) => ({ name: r.name, remote: remoteOf(r.remoteUrl ?? '') })),
      promotion: { autoApply: 'off', minHelpful: 3, minMissions: 2 },
      humanEdits: 'direct',
    };
    // The intake the project has, so linking a brain keeps its Board and sources (#52 Ruling 21).
    const intake = this.deps.intake?.current(workspaceId) ?? null;
    const intakeFiles: { path: string; content: string }[] = [];
    if (intake !== null && intake.tracker !== null && intake.tracker !== undefined) {
      intakeFiles.push({ path: 'tracker.yaml', content: stringifyYaml({ tracker: intake.tracker }) });
    }
    if (intake !== null && intake.sources.length > 0) {
      intakeFiles.push({ path: 'intake.yaml', content: stringifyYaml({ sources: intake.sources, dailyCap: intake.dailyCap, similarity: intake.similarity }) });
    }
    return createBrainLayout({
      manifest,
      setupFiles: [...rendered.files, ...intakeFiles],
      knowledge: view.workspace.knowledge,
      decisions: decisionFiles(this.deps.decisions.listByWorkspace(workspaceId), scrub),
      skills,
      scrub,
    });
  }

  /** The clone path; a clone left by an earlier unlink is moved aside, never deleted. */
  async #freshClonePath(workspaceId: WorkspaceId): Promise<string> {
    const path = this.deps.paths.brain(workspaceId);
    const exists = await stat(path).then(() => true, () => false);
    if (exists) await rename(path, `${path}.unlinked-${this.deps.clock.epochMs()}`);
    return path;
  }

  #writerId(): WriterId {
    const settings = this.deps.settings.read();
    let installId = typeof settings[INSTALL_ID_KEY] === 'string' ? (settings[INSTALL_ID_KEY] as string) : '';
    if (!/^[0-9a-f]{16}$/.test(installId)) {
      installId = randomBytes(8).toString('hex');
      this.deps.settings.write({ [INSTALL_ID_KEY]: installId });
    }
    return makeWriterId(this.deps.identity.localPerson().displayName, installId);
  }

  /** The local person as a git author; their edits are theirs (spec §8). */
  #author(): { name: string; email: string } {
    const person = this.deps.identity.localPerson();
    const handle = person.handles['github'] ?? slugify(person.displayName, 40);
    return { name: person.displayName, email: `${handle}@users.noreply.tandemise.local` };
  }

  author(): { name: string; email: string } {
    return this.#author();
  }

  #require(workspaceId: WorkspaceId): WorkspaceBrain {
    const row = this.deps.brains.get(workspaceId);
    if (row === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'This project has no brain. Link one in Project settings.');
    return row;
  }

  #exclusive<T>(workspaceId: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(workspaceId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    this.#locks.set(workspaceId, settled);
    void settled.then(() => { if (this.#locks.get(workspaceId) === settled) this.#locks.delete(workspaceId); });
    return next;
  }
}

export type LinkRequest =
  | { readonly mode: 'create'; readonly owner: string; readonly name: string }
  | { readonly mode: 'adopt'; readonly remote: string }
  | { readonly mode: 'local' };

function cleanScope(scope: BrainEntry['scope']): BrainEntry['scope'] {
  const out: { repo?: string; role?: string; step?: string; paths?: readonly string[] } = {};
  if (scope.repo !== undefined && scope.repo !== '') out.repo = scope.repo;
  if (scope.role !== undefined && scope.role !== '') out.role = scope.role;
  if (scope.step !== undefined && scope.step !== '') out.step = scope.step;
  if (scope.paths !== undefined && scope.paths.length > 0) out.paths = [...scope.paths];
  return out;
}

/** A Lessons filter: `role:<id>`, `repo:<name>`, `step:<key>` or `project`. */
function scopeMatchesFilter(e: BrainEntry, filter: string): boolean {
  if (filter === 'project') return Object.keys(e.scope).length === 0;
  const [kind, value] = filter.split(':');
  if (kind === 'role') return e.scope.role === value;
  if (kind === 'repo') return e.scope.repo === value;
  if (kind === 'step') return e.scope.step === value;
  return true;
}

export function isEvalsPath(path: string): boolean {
  const p = path.replace(/^\.?\/+/, '');
  return p === BRAIN_EVALS || p.startsWith(`${BRAIN_EVALS}/`);
}

/** The host a person would recognise, for "Couldn't reach github.com." */
export function hostOf(remote: string): string {
  const m = /^([a-z0-9.-]+\.[a-z]{2,})\//i.exec(remote);
  return m?.[1] ?? "the brain's remote";
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
