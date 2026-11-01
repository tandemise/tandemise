import type { ExecutionTargetId, Logger, MissionId, TaskId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import type { ExecutionTargetRecord, TargetKind } from '@tandemise/domain';
import { Registry, type Descriptor } from '@tandemise/kernel';
import type { ExecutionTarget } from './exec.js';
import type { WorkAttribution } from './attribution.js';

export interface ProvisionRequest {
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId | null;
  readonly taskId: TaskId | null;
  readonly kind: TargetKind;
  /** Human-readable name; the on-disk slug and branch name derive from it. */
  readonly name: string;
  /** Absolute path to the user's canonical checkout. Never written to directly. */
  readonly repositoryPath: string;
  /** Mission integration branch, or the repository default when absent. */
  readonly baseBranch?: string;
  /** Explicit branch name; otherwise `tandemise/<mission>/<task>`. */
  readonly branch?: string;
  readonly missionSlug?: string;
  /**
   * Reuse this id instead of minting one. The recovery path passes the id from
   * a persisted record so that re-provisioning after a crash converges on the
   * same target rather than orphaning the old one (MVP.md §21.2).
   */
  readonly id?: ExecutionTargetId;
  /**
   * Bring a reused branch up to `baseBranch` before it is handed out (#138).
   * Set when the base is an upstream step's branch: a round that redoes this
   * step after the upstream step committed again must not run it on the old
   * commit. Fast-forwards when it can, merges when the branch has its own
   * commits, and refuses (CONFLICT) when they conflict.
   */
  readonly syncToBase?: boolean;
}

export interface ReleaseOptions {
  /**
   * Attribute a salvage commit for anything left in the tree. Omitted means
   * "report and retain": uncommitted work is never thrown away silently.
   */
  readonly commitLeftovers?: WorkAttribution;
  readonly commitMessage?: string;
  /** Remove the workspace even if it is dirty. Destructive; caller must mean it. */
  readonly force?: boolean;
}

export interface ReleaseOutcome {
  readonly targetId: ExecutionTargetId;
  /** False when the workspace was deliberately left on disk. */
  readonly released: boolean;
  readonly workingDirectory: string;
  readonly retainedReason: string | null;
  /** Hash of a salvage commit, when one was made. */
  readonly commit: string | null;
}

/**
 * A pluggable kind of execution target. Contributed to
 * `EXECUTION_TARGET_FACTORIES`; nothing in the core names a concrete kind, so
 * adding Docker is "write the factory, contribute it" (MVP.md §11.4).
 */
export interface ExecutionTargetFactory extends Descriptor {
  readonly kind: TargetKind;
  provision(request: ProvisionRequest): Promise<ExecutionTarget>;
  release(target: ExecutionTargetRecord, options?: ReleaseOptions): Promise<ReleaseOutcome>;
}

/**
 * Routes a provision request to the factory for its kind and keeps a handle on
 * everything currently live, so shutdown can dispose targets it never created.
 */
export class ExecutionTargetManager {
  readonly #registry: Registry<ExecutionTargetFactory>;
  readonly #byKind = new Map<TargetKind, ExecutionTargetFactory>();
  readonly #live = new Map<ExecutionTargetId, ExecutionTarget>();

  constructor(
    factories: readonly ExecutionTargetFactory[],
    private readonly log: Logger,
  ) {
    this.#registry = new Registry<ExecutionTargetFactory>('execution target', factories);
    for (const factory of this.#registry.all()) {
      const existing = this.#byKind.get(factory.kind);
      if (existing) {
        throw TandemiseError.validation(
          `Two factories claim target kind '${factory.kind}': ${existing.id} and ${factory.id}`,
        );
      }
      this.#byKind.set(factory.kind, factory);
    }
  }

  kinds(): readonly TargetKind[] {
    return [...this.#byKind.keys()];
  }

  supports(kind: TargetKind): boolean {
    return this.#byKind.has(kind);
  }

  async provision(request: ProvisionRequest): Promise<ExecutionTarget> {
    const factory = this.#require(request.kind);
    const target = await factory.provision(request);
    this.#live.set(target.id, target);
    this.log.info('target.provisioned', {
      targetId: target.id,
      kind: target.kind,
      workspaceId: request.workspaceId,
      missionId: request.missionId ?? undefined,
      taskId: request.taskId ?? undefined,
      workingDirectory: target.workingDirectory,
    });
    return target;
  }

  async release(record: ExecutionTargetRecord, options?: ReleaseOptions): Promise<ReleaseOutcome> {
    const live = this.#live.get(record.id);
    if (live) {
      await live.dispose();
      this.#live.delete(record.id);
    }
    const outcome = await this.#require(record.kind).release(record, options);
    if (!outcome.released) {
      this.log.warn('target.retained', {
        targetId: record.id,
        workingDirectory: outcome.workingDirectory,
        reason: outcome.retainedReason ?? 'unknown',
      });
    } else {
      this.log.info('target.released', { targetId: record.id, commit: outcome.commit ?? undefined });
    }
    return outcome;
  }

  get(id: ExecutionTargetId): ExecutionTarget | undefined {
    return this.#live.get(id);
  }

  live(): readonly ExecutionTarget[] {
    return [...this.#live.values()];
  }

  /** Drops in-process handles. Workspaces on disk are untouched. */
  async disposeAll(): Promise<void> {
    for (const target of this.#live.values()) await target.dispose();
    this.#live.clear();
  }

  #require(kind: TargetKind): ExecutionTargetFactory {
    const factory = this.#byKind.get(kind);
    if (!factory) {
      throw new TandemiseError('TARGET_UNAVAILABLE', `No execution target factory for kind '${kind}'`, {
        details: { kind, available: this.kinds() },
      });
    }
    return factory;
  }
}
