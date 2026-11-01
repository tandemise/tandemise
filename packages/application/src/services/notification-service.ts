import type { MemberRepositoryPort, NotifyItem, NotifyPreferences, WorkspaceRepositoryPort } from '@tandemise/domain';
import {
  RAISE_LIMIT_OPTION, inQuietHours, normalizeNotifyPreferences, normalizeNotifyState, planNotifications, quietForLabel, releaseNotified,
} from '@tandemise/domain';
import type {
  InboxView, NotificationPreferencesView, NotificationReleaseView, NotificationTakeView, UpdateNotificationPreferencesRequest,
} from '@tandemise/api-contract';
import { isApprovalWaitingOnMember, isHumanTaskForMember } from '@tandemise/api-contract';
import type { Clock, WorkspaceId } from '@tandemise/shared';
import type { SettingsStorePort } from '../ports.js';
import type { Caller } from '../support/identity.js';

/** Keys in the daemon's settings file; no table and no migration (P16 ruling 2). */
export const NOTIFY_PREFERENCES_KEY = 'notifications';
export const NOTIFY_STATE_KEY = 'notificationState';

export interface NotificationDeps {
  readonly workspaces: WorkspaceRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly settings: SettingsStorePort;
  /** The Inbox projection: the one source of what can be announced. */
  readonly inbox: (workspaceId: WorkspaceId) => InboxView;
  /** Quiet hours are read on this clock, in the daemon's local time zone. */
  readonly clock: Clock;
}

/**
 * Desktop notifications (P16 spec §3).
 *
 * The desktop main process asks `take` every few seconds; this service reads
 * the Inbox for every project, hands it to the pure diff in the domain and
 * stores what was announced before answering. Computing and recording in one
 * call is what makes "never twice" hold across desktop restarts.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationDeps) {}

  preferences(): NotificationPreferencesView {
    const preferences = this.#preferences();
    return { ...preferences, quietNow: inQuietHours(preferences.quietHours, this.#minuteOfDay()) };
  }

  updatePreferences(patch: UpdateNotificationPreferencesRequest): NotificationPreferencesView {
    const current = this.#preferences();
    const next: NotifyPreferences = {
      kinds: { ...current.kinds, ...(patch.kinds ?? {}) },
      quietHours: patch.quietHours === undefined ? current.quietHours : patch.quietHours,
    };
    this.deps.settings.write({ [NOTIFY_PREFERENCES_KEY]: next });
    return this.preferences();
  }

  /** What to show now, recorded as announced before it is returned. */
  take(caller: Caller, options: { readonly suppress?: boolean } = {}): NotificationTakeView {
    const stored = this.deps.settings.read();
    const plan = planNotifications({
      items: this.items(caller),
      state: normalizeNotifyState(stored[NOTIFY_STATE_KEY]),
      preferences: normalizeNotifyPreferences(stored[NOTIFY_PREFERENCES_KEY]),
      minuteOfDay: this.#minuteOfDay(),
      suppress: options.suppress ?? false,
    });
    this.deps.settings.write({ [NOTIFY_STATE_KEY]: plan.state });
    return { notices: plan.notice === null ? [] : [plan.notice] };
  }

  /**
   * The desktop took a notice but the operating system did not accept it: the
   * ids go back to "not yet announced", so the next `take` offers them again.
   */
  release(ids: readonly string[]): NotificationReleaseView {
    const stored = this.deps.settings.read();
    const state = normalizeNotifyState(stored[NOTIFY_STATE_KEY]);
    const next = releaseNotified(state, ids);
    const released = state.notified.length + state.held.length - next.notified.length - next.held.length;
    if (released > 0) this.deps.settings.write({ [NOTIFY_STATE_KEY]: next });
    return { released };
  }

  /** Every Inbox item for the caller, in every project, as the diff sees it (spec §1). */
  items(caller: Caller): NotifyItem[] {
    return this.deps.workspaces.list().flatMap((workspace) => {
      const me = this.deps.members.listByWorkspace(workspace.id)
        .find((m) => m.kind === 'person' && m.personId === caller.personId && m.status === 'active')?.id ?? null;
      return itemsFromInbox(workspace.id, this.deps.inbox(workspace.id), me);
    });
  }

  #preferences(): NotifyPreferences {
    return normalizeNotifyPreferences(this.deps.settings.read()[NOTIFY_PREFERENCES_KEY]);
  }

  #minuteOfDay(): number {
    const at = new Date(this.deps.clock.epochMs());
    return at.getHours() * 60 + at.getMinutes();
  }
}

const missionRoute = (missionId: string | null): string => (missionId === null ? '/inbox' : `/missions/${missionId}`);
const joined = (...parts: ReadonlyArray<string | null | undefined>): string => parts.filter((p): p is string => !!p).join(' · ');

/** The Inbox rows that are for this member, with the ids the desktop Inbox uses. */
export function itemsFromInbox(workspaceId: string, inbox: InboxView, memberId: string | null): NotifyItem[] {
  const forMe = (forIds: readonly string[]): boolean => forIds.length === 0 || (memberId !== null && forIds.includes(memberId));
  const items: NotifyItem[] = [];
  for (const view of inbox.approvals) {
    const a = view.approval;
    if (a.status !== 'PENDING') continue;
    if (!isApprovalWaitingOnMember({ kind: a.kind, addresseeIds: view.addressees.map((x) => x.id) }, memberId)) continue;
    const limit = a.kind === 'intervention' && a.taskId === null && a.options.some((o) => o.id === RAISE_LIMIT_OPTION);
    items.push({
      id: a.id,
      kind: limit ? 'limits' : 'decisions',
      workspaceId,
      title: limit ? 'Limit reached' : 'Decision needed',
      body: joined(a.title, view.missionTitle),
      route: missionRoute(a.missionId),
    });
  }
  for (const task of inbox.tasks) {
    const people = {
      assigneeId: task.assignee?.id ?? null,
      claimableIds: task.claimable.map((c) => c.id),
      escalatedToIds: task.escalatedTo.map((c) => c.id),
    };
    if (!isHumanTaskForMember(people, memberId)) continue;
    items.push({ id: task.id, kind: 'decisions', workspaceId, title: 'Your step is waiting', body: joined(task.title, task.missionTitle), route: missionRoute(task.missionId) });
  }
  for (const r of inbox.refinements) {
    if (!forMe(r.forIds)) continue;
    items.push({
      id: `refinement:${r.missionId}`,
      kind: 'refinements',
      workspaceId,
      title: 'Decide before planning',
      body: joined(`${r.toDecide} to decide`, r.missionTitle),
      route: missionRoute(r.missionId),
    });
  }
  for (const s of inbox.stalled) {
    if (!forMe(s.forIds)) continue;
    items.push({ id: `stalled:${s.missionId}`, kind: 'stalled', workspaceId, title: 'Mission stalled', body: joined(s.missionTitle, s.reason), route: '/inbox/stalled' });
  }
  for (const run of inbox.silentRuns) {
    if (!forMe(run.forIds)) continue;
    items.push({
      id: `quiet:${run.runId}`,
      kind: 'quiet',
      workspaceId,
      title: 'Agent gone quiet',
      body: joined(`${run.taskKey} quiet for ${quietForLabel(run.quietForMs)}`, run.missionTitle),
      route: '/inbox',
    });
  }
  return items;
}
