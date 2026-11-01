import type {
  RuntimeProfile, RuntimeProfileRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { defaultRuntimeConcurrency } from '@tandemise/domain';
import type { CreateRuntimeProfileRequest, RuntimeDiscoveryView, RuntimeView } from '@tandemise/api-contract';
import type { RuntimeManager } from '@tandemise/runtimes-core';
import type { Clock, RuntimeProfileId } from '@tandemise/shared';
import { TandemiseError, asId, ids } from '@tandemise/shared';
import type { RuntimeService } from '../services.js';
import { BUILT_IN_ROLES } from '../roles/built-in.js';

/**
 * Runtime profiles: discovery, CRUD, health (MVP.md §10.2, §23.6).
 *
 * Two behaviours are worth stating because they are the difference between a
 * usable onboarding and a dead end.
 *
 * **A new profile is routed by default.** A workspace whose routing lists
 * nothing for a role falls back to "any healthy runtime", so the first profile
 * a user creates is usable immediately. But a workspace that *has* expressed a
 * preference for a role gets the new profile appended as a fallback rather than
 * silently ignored - the alternative is a user who adds a second runtime and
 * cannot work out why it is never used.
 *
 * **Health is never inferred from the profile row.** It is asked of the adapter
 * (through the manager's short-lived cache), because "enabled" is a user
 * intention and "healthy" is a fact about the machine right now.
 */
export class RuntimeServiceImpl implements RuntimeService {
  constructor(
    private readonly profiles: RuntimeProfileRepositoryPort,
    private readonly workspaces: WorkspaceRepositoryPort,
    private readonly runtimes: RuntimeManager,
    private readonly clock: Clock,
  ) {}

  async list(workspaceId?: string): Promise<readonly RuntimeView[]> {
    // No workspace means "every profile", not "the global ones": the settings
    // screen opens without a workspace selected and must still show what is
    // configured. `list(null)` would answer the narrower question.
    const profiles = workspaceId === undefined
      ? this.profiles.list()
      : this.profiles.list(asId<'WorkspaceId'>(workspaceId));
    return Promise.all(profiles.map((p) => this.#view(p)));
  }

  async discover(): Promise<readonly RuntimeDiscoveryView[]> {
    // "Configured" is a question about the installation, not about one
    // workspace: an adapter that any workspace already has a profile for is not
    // a new discovery for the onboarding screen to offer.
    const configured = new Set(this.profiles.list().map((p) => p.adapterId));
    const found = await this.runtimes.discoverAll();
    return found.map((d) => ({ ...d, configured: configured.has(d.adapterId) }));
  }

  async create(request: CreateRuntimeProfileRequest): Promise<RuntimeProfile> {
    const adapter = this.runtimes.registry.tryAdapter(request.adapterId);
    if (adapter === undefined) {
      throw TandemiseError.validation(
        `No runtime adapter '${request.adapterId}' is registered.`,
        { available: this.runtimes.registry.ids() },
      );
    }
    adapter.validateSettings?.(request.settings ?? {});
    const now = this.clock.now();
    const profile: RuntimeProfile = {
      id: ids.runtimeProfile(),
      workspaceId: request.workspaceId ? asId<'WorkspaceId'>(request.workspaceId) : null,
      adapterId: request.adapterId,
      name: request.name,
      executablePath: request.executablePath ?? null,
      args: request.args ?? [],
      settings: request.settings ?? {},
      // The adapter's report is a guess about a tool it did not write, so the
      // user is allowed to correct it - they may know this install has
      // `computer_use`, or that their generic CLI can drive a browser. Without
      // an override the capability router could never be told otherwise, and a
      // role requiring something the adapter under-reports would be permanently
      // unroutable. Defaulting to the adapter (rather than to empty) keeps a
      // fully capable runtime from looking inert.
      capabilities: request.capabilities ?? adapter.baseCapabilities,
      enabled: request.enabled ?? true,
      maxConcurrent: request.maxConcurrent ?? defaultRuntimeConcurrency(this.#workerLimit(request.workspaceId ?? null)),
      createdAt: now,
      updatedAt: now,
    };
    const created = this.profiles.create(profile);
    this.#routeByDefault(created);
    return created;
  }

  async update(id: RuntimeProfileId, patch: Partial<CreateRuntimeProfileRequest>): Promise<RuntimeProfile> {
    const existing = this.#require(id);
    if (patch.settings !== undefined) {
      this.runtimes.registry.tryAdapter(existing.adapterId)?.validateSettings?.(patch.settings);
    }
    const updated = this.profiles.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.executablePath !== undefined ? { executablePath: patch.executablePath } : {}),
      ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
      ...(patch.maxConcurrent !== undefined ? { maxConcurrent: patch.maxConcurrent } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: this.clock.now(),
    });
    // An edited executable path or setting invalidates whatever the last probe
    // concluded; keeping the cached answer would show a healthy badge for a
    // binary that no longer exists.
    this.runtimes.invalidateHealth(id);
    return updated;
  }

  remove(id: RuntimeProfileId): void {
    this.#require(id);
    this.profiles.remove(id);
    this.runtimes.invalidateHealth(id);
    for (const workspace of this.workspaces.list()) {
      const routing = Object.fromEntries(
        Object.entries(workspace.routing).map(([role, list]) => [role, list.filter((p) => p !== id)]),
      );
      this.workspaces.update(workspace.id, { routing, updatedAt: this.clock.now() });
    }
  }

  async checkHealth(id: RuntimeProfileId): Promise<RuntimeView> {
    const profile = this.#require(id);
    return this.#view(profile, { refresh: true });
  }

  async #view(profile: RuntimeProfile, options: { refresh?: boolean } = {}): Promise<RuntimeView> {
    const adapter = this.runtimes.registry.tryAdapter(profile.adapterId);
    return {
      profile,
      health: await this.runtimes.health(profile, options),
      adapterDisplayName: adapter?.displayName ?? profile.adapterId,
      settingsSchema: adapter?.settingsSchema ?? [],
      activeRuns: this.runtimes.inFlight(profile.id),
      rolesRouted: this.#rolesRouted(profile),
    };
  }

  #rolesRouted(profile: RuntimeProfile): readonly string[] {
    const roles = new Set<string>();
    for (const workspace of this.workspaces.list()) {
      if (profile.workspaceId !== null && profile.workspaceId !== workspace.id) continue;
      for (const [role, list] of Object.entries(workspace.routing)) {
        if (list.includes(profile.id)) roles.add(role);
      }
    }
    return [...roles].sort();
  }

  /** Appends the profile to every role a workspace has already routed. */
  #routeByDefault(profile: RuntimeProfile): void {
    const known = new Set(BUILT_IN_ROLES.map((r) => r.id));
    for (const workspace of this.workspaces.list()) {
      if (profile.workspaceId !== null && profile.workspaceId !== workspace.id) continue;
      const routing: Record<string, readonly string[]> = { ...workspace.routing };
      let changed = false;
      for (const [role, list] of Object.entries(routing)) {
        if (!known.has(role) || list.includes(profile.id)) continue;
        routing[role] = [...list, profile.id];
        changed = true;
      }
      if (changed) this.workspaces.update(workspace.id, { routing, updatedAt: this.clock.now() });
    }
  }

  /**
   * The worker limit a new profile's default concurrency is capped by: its
   * project's, or - for a profile every project shares - the largest any
   * project allows, since each project's scheduler still holds its own
   * ceiling. Null when there is no project to read.
   */
  #workerLimit(workspaceId: string | null): number | null {
    if (workspaceId !== null) {
      return this.workspaces.get(asId<'WorkspaceId'>(workspaceId))?.concurrency.maxTotalWorkers ?? null;
    }
    const limits = this.workspaces.list().map((w) => w.concurrency.maxTotalWorkers);
    return limits.length === 0 ? null : Math.max(...limits);
  }

  #require(id: RuntimeProfileId): RuntimeProfile {
    const profile = this.profiles.get(id);
    if (profile === undefined) throw TandemiseError.notFound('Runtime profile', id);
    return profile;
  }
}
