import type {
  AutonomySettings, Capability, CapabilityGrant, MissionTask, RiskClass, RoleTemplate,
} from '@tandemise/domain';
import { anyCapabilityMatches } from '@tandemise/domain';
import type { Clock } from '@tandemise/shared';
import { systemClock } from '@tandemise/shared';
import { riskForCapability } from './risk.js';

/**
 * Derives the concrete grants for one assignment from
 * role defaults ∩ task requirements ∩ workspace autonomy (MVP.md §19.2, §27.4).
 *
 * The invariant that matters: **the result is never broader than the role's
 * declared defaults.** A task can ask for less than its role allows; it can
 * never ask for more. That is what makes a role template an auditable
 * permission ceiling rather than a suggestion, and it is checked directly in
 * `narrowToRole` below rather than being left as a property nobody verifies.
 */
export interface GrantBuildRequest {
  readonly role: RoleTemplate;
  readonly task: MissionTask;
  readonly autonomy: AutonomySettings;
  /** The execution target's working directory - the worktree root, normally. */
  readonly workingDirectory: string;
  /** Where this mission's artifacts are written. */
  readonly artifactRoot: string;
  /** Domains the mission may reach. Empty means: no network resource is in scope. */
  readonly allowedDomains?: readonly string[];
  /** Repositories (`owner/name`) the mission may act on. */
  readonly allowedRepositories?: readonly string[];
  /** Integration names a connected-app capability may reach. Absent: every app connected under it. */
  readonly connectedApps?: readonly string[];
  /** Extra read-only roots, e.g. the user's original checkout. */
  readonly readOnlyPaths?: readonly string[];
  /** Grant lifetime. Defaults to the task's wall-time budget. */
  readonly ttlMs?: number;
}

export interface GrantBuilder {
  build(request: GrantBuildRequest): readonly CapabilityGrant[];
}

/** Capabilities whose `resourceScope` entries are filesystem roots. */
const PATH_SCOPED = ['filesystem', 'shell', 'tests', 'git', 'repository.read', 'artifact.write'];
/** Capabilities whose scope entries are hostnames. */
const DOMAIN_SCOPED = ['browser', 'web', 'http'];
/** Capabilities whose scope entries are `owner/name` repository slugs. */
const REPO_SCOPED = ['github', 'gitlab'];
/**
 * Capabilities a connected app publishes its tools under. The resource of such
 * a call is the integration's name.
 */
const APP_SCOPED = ['design', 'planning', 'database', 'deploy', 'monitoring'];

function startsWithAny(capability: Capability, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => capability === p || capability.startsWith(`${p}.`));
}

export function createGrantBuilder(options: { clock?: Clock } = {}): GrantBuilder {
  const clock = options.clock ?? systemClock;

  return {
    build(request: GrantBuildRequest): readonly CapabilityGrant[] {
      const { role, task, autonomy } = request;
      const requested = narrowToRole(role, task);
      const expiresAt = new Date(clock.epochMs() + (request.ttlMs ?? task.executionPolicy.maxWallTimeMs)).toISOString();

      const grants: CapabilityGrant[] = [];
      for (const capability of requested) {
        const risk = riskForCapability(capability);

        // Financial capabilities are not narrowed, not asked about, and not
        // emitted. There is no grant shape that can represent them in v0.1
        // (MVP.md §18.2), so they are dropped before a grant is ever built.
        if (risk === 'financial') continue;

        const approvalMode = modeFor(risk, autonomy);
        grants.push({
          capability,
          resourceScope: scopeFor(capability, request),
          approvalMode,
          expiresAt,
          reason: `${role.name} · ${task.key} (${risk})`,
        });
      }
      return grants;
    },
  };
}

/**
 * Keeps only the capabilities the task asked for that the role actually
 * permits. When a task declares nothing, the role's defaults are used verbatim
 * - the ceiling, never above it.
 */
function narrowToRole(role: RoleTemplate, task: MissionTask): readonly Capability[] {
  const asked = unique([...task.executionPolicy.capabilities, ...task.requiredCapabilities]);
  if (asked.length === 0) return unique(role.defaultCapabilities);
  // Keeping the *task's* string rather than the role's keeps the grant as
  // narrow as possible: role `github` + task `github.pr.create` yields the
  // latter.
  return asked.filter((c) => anyCapabilityMatches(role.defaultCapabilities, c));
}

function modeFor(risk: RiskClass, autonomy: AutonomySettings): CapabilityGrant['approvalMode'] {
  switch (risk) {
    case 'read':
      return 'auto';
    case 'write_reversible':
      return autonomy.localCodeChanges === 'ask' ? 'ask' : 'auto';
    case 'external_side_effect':
      return autonomy.externalWrites === 'deny' ? 'deny' : autonomy.externalWrites === 'ask' ? 'ask' : 'auto';
    case 'destructive':
      return 'ask';
    case 'release':
      return autonomy.productionRelease === 'deny' ? 'deny' : 'ask';
    case 'financial':
      return 'deny';
  }
}

function scopeFor(capability: Capability, request: GrantBuildRequest): readonly string[] {
  if (capability === 'artifact.write') return [request.artifactRoot];
  if (capability === 'filesystem.read' || capability === 'repository.read') {
    return unique([request.workingDirectory, ...(request.readOnlyPaths ?? [])]);
  }
  if (startsWithAny(capability, PATH_SCOPED)) return [request.workingDirectory];
  if (startsWithAny(capability, DOMAIN_SCOPED)) return request.allowedDomains ?? [];
  if (startsWithAny(capability, REPO_SCOPED)) return request.allowedRepositories ?? [];
  // Which apps a worker reaches is already decided by the capability: only
  // integrations the user connected under `design` publish `design` tools, and
  // choosing "who uses it" when connecting is that decision. An empty scope
  // here denied every call - a designer granted `design` was refused
  // `open-design.list_projects` - so a connected-app grant covers the apps
  // connected under it, narrowed further when the caller names them.
  if (startsWithAny(capability, APP_SCOPED)) return request.connectedApps ?? ['*'];
  // Unknown capability families get no resource scope. `matchesScope` treats an
  // empty scope as covering nothing, so this is the default-deny branch.
  return [];
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
