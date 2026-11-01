import { z } from 'zod';
import type { Notice, NotifyKind, QuietHours } from '@tandemise/domain';

/**
 * Desktop notifications (P16). Kept apart from views.ts and requests.ts: the
 * desktop main process is the only caller of `take`, and the Settings screen
 * the only caller of the preferences.
 */

/** Settings → Notifications. */
export interface NotificationPreferencesView {
  readonly kinds: Readonly<Record<NotifyKind, boolean>>;
  readonly quietHours: QuietHours | null;
  /** Quiet hours are on right now, by the daemon's clock. */
  readonly quietNow: boolean;
}

/** One native notification the desktop should show. */
export type NoticeView = Notice;

export interface NotificationTakeView {
  /** Zero or one today; an array so per-project notices can come later without a new shape. */
  readonly notices: readonly NoticeView[];
}

const time = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Use a 24-hour time like 22:00.');

export const updateNotificationPreferencesRequest = z.object({
  kinds: z.object({
    decisions: z.boolean(),
    refinements: z.boolean(),
    stalled: z.boolean(),
    quiet: z.boolean(),
    limits: z.boolean(),
  }).partial().strict().optional(),
  quietHours: z.object({ from: time, to: time }).strict()
    .refine((q) => q.from !== q.to, 'Quiet hours need a different start and end.')
    .nullable().optional(),
}).strict();
export type UpdateNotificationPreferencesRequest = z.infer<typeof updateNotificationPreferencesRequest>;

export const takeNotificationsRequest = z.object({
  /** The person is already looking at the Inbox: record what is new, announce nothing. */
  suppress: z.boolean().optional(),
}).strict();
export type TakeNotificationsRequest = z.infer<typeof takeNotificationsRequest>;

export const releaseNotificationsRequest = z.object({
  /** The ids of a notice the operating system did not accept; they are announced again later. */
  ids: z.array(z.string().min(1)).min(1).max(500),
}).strict();
export type ReleaseNotificationsRequest = z.infer<typeof releaseNotificationsRequest>;

export interface NotificationReleaseView {
  /** How many ids went back to "not yet announced". */
  readonly released: number;
}
