import type { RepositoryId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { AutonomyLevel } from './mission.js';
import type { RoleStaffing } from '../staffing.js';
import type { Limit } from './limits.js';

/**
 * Autonomy is expressed per action class rather than as one global dial, so a
 * user can let local code changes run freely while still gating anything that
 * escapes the machine (MVP.md Appendix A).
 */
export interface AutonomySettings {
  readonly planApproval: 'ask' | 'auto';
  readonly localCodeChanges: 'auto' | 'ask';
  readonly externalWrites: 'auto' | 'policy' | 'ask' | 'deny';
  readonly productionRelease: 'ask' | 'deny';
  readonly financialActions: 'deny';
}

export const DEFAULT_AUTONOMY: AutonomySettings = {
  planApproval: 'ask',
  localCodeChanges: 'auto',
  externalWrites: 'policy',
  productionRelease: 'ask',
  financialActions: 'deny',
};

export interface ConcurrencySettings {
  readonly maxTotalWorkers: number;
  /** Per runtime-profile ceilings, keyed by profile id. */
  readonly perRuntime: Readonly<Record<string, number>>;
}

export const DEFAULT_CONCURRENCY: ConcurrencySettings = { maxTotalWorkers: 3, perRuntime: {} };

/**
 * Ordered runtime preferences per role. The scheduler walks the list and takes
 * the first healthy, capability-satisfying, non-saturated runtime - which is how
 * fallback works without any role knowing a vendor name (MVP.md §P2).
 */
export type RoleRouting = Readonly<Record<string, readonly string[]>>;

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly defaultRepositoryId: RepositoryId | null;
  readonly autonomy: AutonomySettings;
  readonly concurrency: ConcurrencySettings;
  readonly routing: RoleRouting;
  readonly defaultAutonomyLevel: AutonomyLevel;
  /** Workspace knowledge injected by the context compiler (MVP.md §14.2). */
  readonly knowledge: WorkspaceKnowledge;
  /**
   * Who does each role's work in this workspace, as per-role patches over the
   * built-in staffing. Optional so a workspace built without it still
   * typechecks; read back as `{}`.
   */
  readonly staffing?: RoleStaffing;
  /**
   * How many missions may be in progress at once before queued ones wait (P7).
   * Null is off: nothing is pulled from the backlog automatically.
   */
  readonly maxActiveMissions: number | null;
  /** Limits every mission gets unless it sets its own (P8). Empty: none. */
  readonly defaultMissionLimits: readonly Limit[];
  /** Limits on the whole project per local calendar month (P8). Empty: none. */
  readonly monthlyLimits: readonly Limit[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface WorkspaceKnowledge {
  readonly productVision: string | null;
  readonly architecturePrinciples: string | null;
  readonly codingStandards: string | null;
  readonly designSystem: string | null;
  readonly glossary: string | null;
}

export const EMPTY_KNOWLEDGE: WorkspaceKnowledge = {
  productVision: null, architecturePrinciples: null, codingStandards: null,
  designSystem: null, glossary: null,
};

export interface Repository {
  readonly id: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /** Absolute path to the user's real checkout. Never modified directly. */
  readonly path: string;
  readonly defaultBranch: string;
  readonly remoteUrl: string | null;
  /** Commands discovered or configured for deterministic gates (MVP.md §17.1). */
  readonly checks: RepositoryChecks;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface RepositoryChecks {
  readonly install: string | null;
  readonly typecheck: string | null;
  readonly lint: string | null;
  readonly test: string | null;
  readonly build: string | null;
  /** Command that serves the app for browser QA, plus the URL it listens on. */
  readonly devServer: string | null;
  readonly devServerUrl: string | null;
  /**
   * Time budget per check, in minutes (#111). Absent means the factory's
   * `planner.yaml` `checks.budgets`, then {@link DEFAULT_CHECK_BUDGET_MINUTES}.
   * Optional so rows written before it read as "no override".
   */
  readonly budgets?: CheckBudgets;
}

/** The checks a repository can configure, by the short name the gate facts use (`checks.tests`). */
export const CHECK_NAMES = ['install', 'typecheck', 'lint', 'tests', 'build'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export type CheckBudgets = Readonly<Partial<Record<CheckName, number>>>;

/** A check's time budget when neither the repository nor the factory sets one. */
export const DEFAULT_CHECK_BUDGET_MINUTES = 10;
/** The longest budget anyone may set: a check longer than this belongs in CI. */
export const MAX_CHECK_BUDGET_MINUTES = 240;

/** The repository's command field for a check name (`tests` is stored as `test`). */
export function checkCommandField(name: CheckName): 'install' | 'typecheck' | 'lint' | 'test' | 'build' {
  return name === 'tests' ? 'test' : name;
}

/**
 * A check's budget in minutes: the repository's own setting, then the
 * factory's, then the default. The most specific place a person said wins.
 */
export function checkBudgetMinutes(name: CheckName, repository: CheckBudgets | undefined, factory: CheckBudgets | undefined): number {
  return repository?.[name] ?? factory?.[name] ?? DEFAULT_CHECK_BUDGET_MINUTES;
}

export const NO_CHECKS: RepositoryChecks = {
  install: null, typecheck: null, lint: null, test: null, build: null,
  devServer: null, devServerUrl: null,
};
