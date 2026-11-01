import type { Clock, Logger, MissionId } from '@tandemise/shared';
import { TandemiseError, asId, errorMessage } from '@tandemise/shared';
import { isTerminalMissionStatus, type IssueRepositoryPort, type Mission, type MissionRepositoryPort, type RepoRepositoryPort, type RunEventRecord, type TrackerItemRepositoryPort } from '@tandemise/domain';
import type {
  CoordinationClaimRowView, CoordinationStatusView, InboxUnclaimedView, MissionClaimView,
} from '@tandemise/api-contract';
import type { ClaimView, CoordDeviceView, CoordMemberView, CreateEndpointRequest, CreateInviteRequest, EndpointView, ImportReport } from '@tandemise/api-contract/relay';
import {
  DEFAULT_STALE_AFTER_MS, clockTime, githubItemRef, isStale, itemKey, lastSeenLabel, normalizeItemRef, presenceOf, takeOverRefusal,
} from '@tandemise/coordination/rules';
import type { CoordinationControlPort, CoordinationPort, SettingsStorePort } from '../ports.js';
import type { EventRecorder } from '../support/event-recorder.js';

export interface CoordinationDeps {
  /** Null when the composition root bound no coordination (older harnesses): everything is a no-op. */
  readonly coordination: CoordinationPort | null;
  readonly control: CoordinationControlPort | null;
  readonly missions: MissionRepositoryPort;
  readonly issues: Pick<IssueRepositoryPort, 'getLink'>;
  /** The board's cache (intake spec §7): a mission started from a tracker item claims it. Optional for older harnesses. */
  readonly trackerItems?: Pick<TrackerItemRepositoryPort, 'get'>;
  /** The workspace's repositories: the first one's remote names its project by default. Optional for older harnesses. */
  readonly repositories?: Pick<RepoRepositoryPort, 'listByWorkspace'>;
  readonly settings: SettingsStorePort;
  readonly recorder: Pick<EventRecorder, 'invalidate'>;
  /** "Stop working on this": cancels the mission. Resolved late, as the mission service composes after this. */
  readonly cancelMission: (id: MissionId, reason: string) => Promise<unknown>;
  readonly clock: Clock;
  readonly log: Logger;
}

export interface TrackerItem {
  readonly itemRef: string;
  readonly itemTitle: string;
  readonly itemUrl: string | null;
}

export const STOPPED_FOR_CLAIM = 'Stopped: someone else is working on this.';
export const PENDING_SENTENCE = "Will tell the team when you're back online.";
/** Intake spec §3: a source's lease lives 2 minutes; the runner host renews it every 30 seconds while it runs the source. */
export const SOURCE_LEASE_SECONDS = 120;

/**
 * Who is working on which tracker item (relay spec, §Where the engine calls
 * it). A mission linked to a tracker item claims it before it starts and
 * releases it when it ends. A claim that is lost never stops work: the mission
 * shows Unclaimed and the person decides.
 */
export class CoordinationService {
  constructor(private readonly deps: CoordinationDeps) {
    deps.coordination?.onChange(() => this.#invalidate());
  }

  get available(): boolean {
    return this.deps.coordination !== null;
  }

  #port(): CoordinationPort {
    if (this.deps.coordination === null) throw new TandemiseError('PRECONDITION_FAILED', 'Coordination is not available in this build.');
    return this.deps.coordination;
  }

  #control(): CoordinationControlPort {
    if (this.deps.control === null) throw new TandemiseError('PRECONDITION_FAILED', 'Coordination is not available in this build.');
    return this.deps.control;
  }

  #invalidate(missionId?: MissionId): void {
    this.deps.recorder.invalidate('coordination', missionId);
  }

  /**
   * The project a workspace's claims belong to (relay spec, §Data model): the
   * `coordination.projectKeys` setting, else its first repository's remote
   * (`github.com/acme/app`, so two people's installs of one repository agree
   * without setting anything), else the workspace id. #51's brain repo
   * identity replaces the middle rule.
   */
  projectKey(workspaceId: string): string {
    const settings = this.deps.settings.read();
    const keys = (settings['coordination'] as { projectKeys?: Record<string, string> } | undefined)?.projectKeys;
    const set = keys?.[workspaceId];
    if (set) return set;
    const remote = this.deps.repositories?.listByWorkspace(asId<'WorkspaceId'>(workspaceId)).find((r) => r.remoteUrl)?.remoteUrl;
    const key = remote ? normalizeRemote(remote) : workspaceId;
    // Kept once chosen: a repository added or re-pointed later must not move this workspace's claims to another project.
    const current = (settings['coordination'] as Record<string, unknown> | undefined) ?? {};
    this.deps.settings.write({ coordination: { ...current, projectKeys: { ...(keys ?? {}), [workspaceId]: key } } });
    return key;
  }

  /** Names a workspace's project explicitly; null goes back to the default. */
  setProjectKey(workspaceId: string, projectKey: string | null): string {
    const settings = this.deps.settings.read();
    const current = (settings['coordination'] as Record<string, unknown> | undefined) ?? {};
    const keys = { ...((current['projectKeys'] as Record<string, string> | undefined) ?? {}) };
    if (projectKey === null || projectKey.trim() === '') delete keys[workspaceId];
    else keys[workspaceId] = projectKey.trim();
    this.deps.settings.write({ coordination: { ...current, projectKeys: keys } });
    this.#invalidate();
    return this.projectKey(workspaceId);
  }

  /**
   * The tracker item a mission works on, or null: the board item Start made
   * it from (intake spec §7; its ref is already `<tracker>:<key>`, e.g.
   * `youtrack:ACME-12`), else its P14 GitHub issue link.
   */
  itemFor(mission: Mission): TrackerItem | null {
    if (mission.trackerItemId !== null && mission.trackerItemId !== undefined) {
      const item = this.deps.trackerItems?.get(mission.trackerItemId);
      if (item !== undefined) return { itemRef: normalizeItemRef(item.ref), itemTitle: item.title, itemUrl: item.url || null };
    }
    if (mission.issueLinkId === null || mission.issueLinkId === undefined) return null;
    const link = this.deps.issues.getLink(mission.issueLinkId);
    if (link === undefined) return null;
    return { itemRef: githubItemRef(link.githubRepo, link.number), itemTitle: link.title, itemUrl: link.url || null };
  }

  /**
   * Intake's Start claims its item before the mission exists (intake spec §3
   * and §7 step 1, Ruling 22), under the mission id it is about to use, so the
   * mission's own start finds the claim already its own. Held by someone else
   * on the team, it is refused in the holder's words. Solo (no relay
   * connected) it is always granted: Start re-reads the item instead.
   */
  async claimItem(input: {
    readonly workspaceId: string; readonly itemRef: string; readonly itemTitle: string; readonly itemUrl: string; readonly localRef: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const port = this.deps.coordination;
    if (port === null) return { ok: true };
    const claim = { projectKey: this.projectKey(input.workspaceId), itemRef: normalizeItemRef(input.itemRef), itemTitle: input.itemTitle, itemUrl: input.itemUrl || null, localRef: input.localRef };
    try {
      let result = await port.claim(claim);
      // Your own claim on this computer, left by a mission that is gone or over (a release that never landed): let it go and claim again.
      if (result.kind === 'held_by' && result.self && result.claim.deviceId === port.me().deviceId && this.#over(result.claim.localRef)) {
        await port.release(result.claim.id, 'released');
        result = await port.claim(claim);
      }
      this.#invalidate();
      if (result.kind !== 'held_by' || port.status().kind === 'local') return { ok: true };
      return { ok: false, reason: result.sentence };
    } catch (e) {
      // A coordination fault is never a reason not to work.
      this.deps.log.warn('item claim failed; starting anyway', { itemRef: input.itemRef, error: errorMessage(e) });
      return { ok: true };
    }
  }

  /** Whether the mission a claim was made for is gone or over. */
  #over(localRef: string | null): boolean {
    if (localRef === null || localRef === '') return true;
    const mission = this.deps.missions.get(asId<'MissionId'>(localRef));
    return mission === undefined || isTerminalMissionStatus(mission.status);
  }

  /** Lets go of your active claims on an item (a Start that failed after claiming). Never throws. */
  /**
   * Releases this member's claims on the item. With `localRef` (a failed
   * Start, Ruling 27), only the claim made for that mission: another of the
   * member's missions on the same item keeps its claim.
   */
  async releaseItem(itemRef: string, reason: 'done' | 'released', localRef?: string): Promise<void> {
    const port = this.deps.coordination;
    if (port === null) return;
    try {
      const ref = normalizeItemRef(itemRef);
      const me = port.me().memberId;
      for (const claim of port.claims().filter((c) => c.itemRef === ref && c.memberId === me && (localRef === undefined || c.localRef === localRef))) {
        await port.release(claim.id, reason);
      }
      this.#invalidate();
    } catch (e) {
      this.deps.log.warn('could not release an item claim', { itemRef, error: errorMessage(e) });
    }
  }

  /**
   * May this daemon run the source now (intake spec §3, Ruling 22)? With the
   * relay connected, only while it holds the lease `('source', sourceId)` in
   * the project: the project key, not the workspace id, since each machine
   * has its own workspace ids. Solo, or with no lease to ask, always yes.
   */
  async sourceClaim(workspaceId: string, sourceId: string): Promise<boolean> {
    const port = this.deps.coordination;
    if (port === null || port.lease === undefined || port.status().kind === 'local') return true;
    try {
      const lease = await port.lease({ projectKey: this.projectKey(workspaceId), scope: 'source', key: sourceId, ttlSeconds: SOURCE_LEASE_SECONDS });
      return lease.granted;
    } catch (e) {
      this.deps.log.warn('source lease failed; running it here', { workspaceId, sourceId, error: errorMessage(e) });
      return true;
    }
  }

  /**
   * Claims the mission's item before it starts. Refuses in plain words when
   * someone else (or you, elsewhere) holds it. Offline claims queue and the
   * mission starts: the network never blocks local work.
   */
  async assertMayStart(mission: Mission): Promise<boolean> {
    const port = this.deps.coordination;
    if (port === null) return false;
    const item = this.itemFor(mission);
    if (item === null) return false;
    const existing = port.claimByLocalRef(mission.id);
    if (existing !== null && existing.state === 'active' && existing.memberId === port.me().memberId) return false;
    let result;
    try {
      result = await port.claim({ projectKey: this.projectKey(mission.workspaceId), ...item, localRef: mission.id });
    } catch (e) {
      // A coordination fault is never a reason not to work.
      this.deps.log.warn('claim failed; starting anyway', { missionId: mission.id, error: errorMessage(e) });
      return false;
    }
    this.#invalidate(mission.id);
    if (result.kind === 'held_by') {
      throw new TandemiseError('CONFLICT', result.sentence, {
        details: {
          reason: 'claim_held', claimId: result.claim.id, self: result.self, takeOver: result.mayTakeOver,
          holderName: result.claim.memberName, itemKey: itemKey(result.claim.itemRef), missionId: mission.id,
        },
      });
    }
    return true;
  }

  /** The start that claimed this mission's item failed after all: release the claim it just made. */
  async abandonStart(mission: Mission): Promise<void> {
    const port = this.deps.coordination;
    if (port === null) return;
    const claim = port.claimByLocalRef(mission.id);
    if (claim === null || claim.state !== 'active' || claim.memberId !== port.me().memberId) return;
    try {
      await port.release(claim.id, 'released');
      this.#invalidate(mission.id);
    } catch (e) {
      this.deps.log.warn('could not release a claim after a failed start', { missionId: mission.id, error: errorMessage(e) });
    }
  }

  /** Mission status changes: the backstop claim, and release when a mission ends. Never throws. */
  async onEvent(record: RunEventRecord): Promise<void> {
    if (record.body.type !== 'mission.status' || this.deps.coordination === null) return;
    const to = record.body.to;
    try {
      const mission = this.deps.missions.get(record.missionId);
      if (mission === undefined) return;
      const port = this.deps.coordination;
      const item = this.itemFor(mission);
      if (item === null) return;
      const mine = port.claimByLocalRef(mission.id);
      if (to === 'EXECUTING') {
        // The backlog, routines and auto-approve start a mission without `start`: claim here.
        if (mine !== null && (mine.state === 'active' || mine.endedReason === 'taken_over' || mine.endedReason === 'removed')) return;
        if (port.claimSync(`lost:${mission.id}`).sync === 'lost') return;
        const result = await port.claim({ projectKey: this.projectKey(mission.workspaceId), ...item, localRef: mission.id });
        if (result.kind === 'held_by') port.markLost(mission.id, result.sentence);
      } else if (to === 'COMPLETE' || to === 'CANCELLED' || to === 'FAILED') {
        if (mine !== null && mine.state === 'active' && mine.memberId === port.me().memberId) {
          await port.release(mine.id, to === 'COMPLETE' ? 'done' : 'released');
        }
      } else {
        return;
      }
      this.#invalidate(mission.id);
    } catch (e) {
      this.deps.log.warn('coordination on a mission change failed', { missionId: record.missionId, error: errorMessage(e) });
    }
  }

  #nameOf(memberId: string | null): string {
    if (memberId === null) return 'Someone';
    return this.#port().members().find((m) => m.id === memberId)?.displayName ?? 'Someone';
  }

  /** Whether you may take the item back from whoever holds it now. */
  #mayTakeBack(claim: ClaimView): boolean {
    const port = this.#port();
    const holder = port.claims(claim.projectKey).find((c) => c.itemRef === claim.itemRef);
    if (holder === undefined) return true;
    const me = port.me();
    return takeOverRefusal({
      actor: { memberId: me.memberId, role: me.role }, holderMemberId: holder.memberId, holderName: holder.memberName,
      itemRef: holder.itemRef, holderLastSeenAt: port.holderLastSeenAt(holder.memberId), now: new Date(this.deps.clock.now()), staleAfterMs: DEFAULT_STALE_AFTER_MS,
    }) === null;
  }

  /** How a mission's item stands with the team; null when it has none or the person chose to keep going. */
  missionClaim(missionId: string): MissionClaimView | null {
    const port = this.deps.coordination;
    if (port === null) return null;
    const mission = this.deps.missions.get(asId<'MissionId'>(missionId));
    if (mission === undefined) return null;
    const claim = port.claimByLocalRef(missionId);
    if (claim === null) {
      const lost = port.claimSync(`lost:${missionId}`);
      if (lost.sync !== 'lost' || lost.decided !== null || isTerminalMissionStatus(mission.status)) return null;
      const item = this.itemFor(mission);
      const key = item === null ? '' : itemKey(item.itemRef);
      const holder = item === null ? undefined : port.claims(this.projectKey(mission.workspaceId)).find((c) => c.itemRef === item.itemRef);
      return {
        claimId: `lost:${missionId}`, itemKey: key, state: 'unclaimed', sentence: lost.note ?? `Someone else is working on ${key}.`,
        mayTakeBack: holder === undefined ? true : this.#mayTakeBack(holder),
      };
    }
    const key = itemKey(claim.itemRef);
    const sync = port.claimSync(claim.id);
    if (sync.decided === 'keep_going') return null;
    const unclaimed = (sentence: string): MissionClaimView | null => isTerminalMissionStatus(mission.status)
      ? null
      : { claimId: claim.id, itemKey: key, state: 'unclaimed', sentence, mayTakeBack: this.#mayTakeBack(claim) };
    if (claim.state === 'ended' && claim.endedReason === 'taken_over') return unclaimed(`${this.#nameOf(claim.endedBy)} took over ${key}.`);
    if (claim.state === 'ended' && claim.endedReason === 'removed') return unclaimed(`You were removed from the team relay, so ${key} is no longer yours there.`);
    if (sync.sync === 'conflicted' || sync.sync === 'lost') return unclaimed(sync.note ?? `Someone else is working on ${key}.`);
    if (claim.state !== 'active') return null;
    if (sync.sync === 'pending') return { claimId: claim.id, itemKey: key, state: 'pending', sentence: PENDING_SENTENCE, mayTakeBack: false };
    return { claimId: claim.id, itemKey: key, state: 'held', sentence: `You're working on ${key}.`, mayTakeBack: false };
  }

  /** Inbox rows: running missions that lost their claim, until the person decides. */
  inboxUnclaimed(workspaceId: string): InboxUnclaimedView[] {
    if (this.deps.coordination === null) return [];
    const live = this.deps.missions.list({ workspaceId: asId<'WorkspaceId'>(workspaceId) })
      .filter((m) => !isTerminalMissionStatus(m.status) && (m.issueLinkId != null || m.trackerItemId != null));
    return live.flatMap((m) => {
      const c = this.missionClaim(m.id);
      if (c === null || c.state !== 'unclaimed') return [];
      return [{
        missionId: m.id, missionTitle: m.title, claimId: c.claimId, itemKey: c.itemKey, sentence: c.sentence,
        mayTakeBack: c.mayTakeBack, forIds: m.createdBy == null ? [] : [m.createdBy],
      }];
    });
  }

  /** "Who's working on what": your own first, then by when they started. */
  rows(workspaceId: string): CoordinationClaimRowView[] {
    const port = this.deps.coordination;
    if (port === null) return [];
    const me = port.me();
    const now = new Date(this.deps.clock.now());
    const presence = port.presence();
    const rows = port.claims(this.projectKey(workspaceId)).map((c): CoordinationClaimRowView => {
      const mine = c.memberId === me.memberId;
      const lastSeen = mine ? now.toISOString() : port.holderLastSeenAt(c.memberId);
      const stale = !mine && isStale(lastSeen, now, DEFAULT_STALE_AFTER_MS);
      const sync = mine ? port.claimSync(c.id).sync : null;
      return {
        claimId: c.id, memberName: mine ? 'You' : c.memberName, mine, presence: mine ? 'online' : presenceOf(presence, c.memberId),
        itemKey: itemKey(c.itemRef), itemTitle: c.itemTitle, itemUrl: c.itemUrl, since: clockTime(c.startedAt), startedAt: c.startedAt,
        stale, staleLabel: stale ? lastSeenLabel(lastSeen, now) : null,
        sync: sync === null ? null : sync === 'lost' ? 'conflicted' : sync, missionId: mine ? c.localRef : null,
      };
    });
    return rows.sort((a, b) => Number(b.mine) - Number(a.mine) || a.startedAt.localeCompare(b.startedAt));
  }

  status(): CoordinationStatusView {
    const port = this.deps.coordination;
    if (port === null) return { kind: 'local' };
    const s = port.status();
    const control = this.deps.control;
    const host = control?.host() ?? '';
    const teamName = control?.teamName() ?? '';
    const { role, memberId } = port.me();
    switch (s.kind) {
      case 'local': return { kind: 'local' };
      case 'connected': return { kind: 'connected', host: s.host, teamName: s.teamName, role, memberId, offerImport: control?.offerImport() ?? false };
      case 'offline': return { kind: 'offline', since: s.since, pendingOps: s.pendingOps, host, teamName, role, memberId };
      case 'refused': return { kind: 'refused', reason: s.reason, host };
    }
  }

  members(): readonly CoordMemberView[] {
    return this.deps.coordination?.members() ?? [];
  }

  presence() {
    return this.deps.coordination?.presence() ?? [];
  }

  /** Take over a claim, for a mission on this machine when there is one (the start dialog's "Take over"). */
  async takeOver(claimId: string, missionId: string | null): Promise<ClaimView> {
    const result = await this.#port().takeOver(claimId, missionId ?? '');
    this.#invalidate(missionId === null ? undefined : asId<'MissionId'>(missionId));
    if (result.kind === 'held_by') {
      throw new TandemiseError('PERMISSION_DENIED', result.sentence, { details: { reason: 'take_over_refused' } });
    }
    return result.claim;
  }

  /** "Take it back": take the item over again for a mission that lost it, or claim it if nobody holds it. */
  async takeBack(missionId: string): Promise<MissionClaimView | null> {
    const port = this.#port();
    const mission = this.deps.missions.get(asId<'MissionId'>(missionId));
    if (mission === undefined) throw TandemiseError.notFound('Mission', missionId);
    const item = this.itemFor(mission);
    if (item === null) return null;
    const projectKey = this.projectKey(mission.workspaceId);
    const holder = port.claims(projectKey).find((c) => c.itemRef === item.itemRef);
    const result = holder === undefined
      ? await port.claim({ projectKey, ...item, localRef: missionId })
      : holder.memberId === port.me().memberId && holder.localRef === missionId
        ? { kind: 'claimed' as const, claim: holder }
        : await port.takeOver(holder.id, missionId);
    if (result.kind === 'held_by') {
      throw new TandemiseError('PERMISSION_DENIED', result.sentence, { details: { reason: 'take_over_refused' } });
    }
    this.#invalidate(mission.id);
    return this.missionClaim(missionId);
  }

  /** "Keep going without a claim": the banner and the Inbox row go; the mission is as it was. */
  keepGoing(missionId: string): void {
    const port = this.#port();
    const claim = port.claimByLocalRef(missionId);
    port.keepGoing(claim?.id ?? `lost:${missionId}`);
    this.#invalidate(asId<'MissionId'>(missionId));
  }

  /** "Stop working on this": cancels the mission, which releases nothing it no longer holds. */
  async stopWorking(missionId: string): Promise<void> {
    await this.deps.cancelMission(asId<'MissionId'>(missionId), STOPPED_FOR_CLAIM);
    this.#invalidate(asId<'MissionId'>(missionId));
  }

  // ---- passthroughs to the control port

  connect(input: Parameters<CoordinationControlPort['connect']>[0]) { return this.#control().connect(input).finally(() => this.#invalidate()); }
  importLocal(): Promise<ImportReport> { return this.#control().importLocal().finally(() => this.#invalidate()); }
  disconnect(): Promise<void> { return this.#control().disconnect().finally(() => this.#invalidate()); }
  createInvite(req: CreateInviteRequest) { return this.#control().createInvite(req); }
  revokeDevice(id: string) { return this.#control().revokeDevice(id).finally(() => this.#invalidate()); }
  removeMember(id: string) { return this.#control().removeMember(id).finally(() => this.#invalidate()); }
  devices(): readonly CoordDeviceView[] { return this.deps.control?.devices() ?? []; }
  createEndpoint(req: CreateEndpointRequest): Promise<EndpointView> { return this.#control().createEndpoint(req); }
  disableEndpoint(id: string) { return this.#control().disableEndpoint(id); }
  retryParked(id: string) { return this.#control().retryParked(id); }
  dropParked(id: string) { return this.#control().dropParked(id); }
  endpoints(): readonly EndpointView[] { return this.deps.control?.endpoints() ?? []; }
  parked() { return this.#control().parked(); }
  failures() { return this.deps.control?.failures() ?? []; }
  exportLines(): string[] { return this.#control().exportLines(); }
  pull(projectKey: string, max: number, leaseSeconds?: number) { return this.#port().mailbox.pull(projectKey, max, leaseSeconds); }
  ack(ids: readonly string[]) { return this.#port().mailbox.ack(ids); }
}

/** `https://github.com/Acme/App.git` or an scp-style `user@host:owner/repo` → `github.com/acme/app`. */
export function normalizeRemote(remote: string): string {
  let r = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(r);
  if (scp) r = `${scp[1]}/${scp[2]}`;
  else r = r.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  return r.toLowerCase();
}
