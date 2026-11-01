import type { AppAboutFacts } from '@tandemise/api-contract/about';

/**
 * The whole surface the renderer is allowed to reach outside its sandbox.
 *
 * This file is shared by the main process, the preload script and the renderer
 * so that all three agree on one shape. Keeping it small is the point: every
 * member here is a hole in the sandbox, so anything that can be done with a
 * `fetch` to the daemon must be done that way instead of being added here
 * (MVP.md §7.1, §32).
 */

/** Connection details for the local daemon, read from `~/.tandemise/daemon.json`. */
export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

export type DaemonPhase =
  /** Looking for, or waiting on, `daemon.json`. */
  | 'connecting'
  /** We asked the OS to start a daemon and are polling for its handshake file. */
  | 'spawning'
  | 'connected'
  /** No daemon, and we could not start one. `detail` says why. */
  | 'unavailable';

export interface DaemonStatus {
  readonly phase: DaemonPhase;
  readonly connection: DaemonConnection | null;
  readonly detail: string;
  /** Path we looked in, surfaced in the error state so the user can check it. */
  readonly handshakePath: string;
  readonly updatedAt: string;
}

/** Where a clicked notification takes the window (P16). */
export interface NotificationOpen {
  readonly route: string;
  /** The project to switch to first, or null to stay on the current one. */
  readonly workspaceId: string | null;
}

/**
 * Whether a notification from Tandemise reaches the person, as far as the app
 * can tell from the operating system (Settings → Notifications).
 *
 * - `ready`: the system takes notifications and shows them as banners.
 * - `hidden`: the system takes them but shows no banner (GNOME's Do Not
 *   Disturb, banners or notifications turned off for Tandemise); they wait in
 *   the system's notification list.
 * - `unavailable`: the system takes none. Nothing is recorded as notified, so
 *   every item is announced once it can be.
 * - `unknown`: the system does not say (macOS and Windows keep the person's
 *   choice to themselves); a test notification is the way to check.
 */
export type NotificationReach = 'ready' | 'hidden' | 'unavailable' | 'unknown';

export interface NotificationHealth {
  readonly reach: NotificationReach;
  /** One plain sentence on what happens to a notification now. */
  readonly summary: string;
  /** What to do about it, or null when nothing needs doing. */
  readonly advice: string | null;
  /** The notification server, "GNOME Shell 50.1"; null when the platform has none to name. */
  readonly server: string | null;
  /**
   * Linux only: the app's `.desktop` entry, which is how the desktop finds the
   * name and icon to show on a notification. An AppImage installs none of its
   * own; `install` offers to add one (with the person's consent, from Settings),
   * `remove` takes back the one Tandemise added.
   */
  readonly desktopEntry: {
    readonly state: 'installed' | 'missing' | 'not-applicable';
    readonly offer: 'install' | 'remove' | null;
    readonly path: string | null;
  };
  /** The last notification the system refused, if any since the app started. */
  readonly lastFailure: { readonly at: string; readonly reason: string } | null;
}

/** What "Send a test notification" found out. */
export interface NotificationTestResult {
  /** The notification server took it (it answered with an id; macOS and Windows reported it shown). */
  readonly accepted: boolean;
  /** `yes`: a banner is on screen now. `no`: taken, but no banner. `unknown`: the system does not say. */
  readonly shown: 'yes' | 'no' | 'unknown';
  /** One sentence for Settings. */
  readonly message: string;
  readonly health: NotificationHealth;
}

export type Platform = 'darwin' | 'win32' | 'linux' | (string & {});

export interface TandemiseBridge {
  readonly platform: Platform;
  getDaemonStatus(): Promise<DaemonStatus>;
  /** Re-runs discovery (and auto-spawn); resolves with the resulting status. */
  reconnectDaemon(): Promise<DaemonStatus>;
  onDaemonStatus(listener: (status: DaemonStatus) => void): () => void;
  /** Native directory picker. Resolves null when the user cancels. */
  selectDirectory(title?: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
  /** Settings → "Send a test notification" (P16): whether the system took it, and whether it shows. */
  testNotification(): Promise<NotificationTestResult>;
  /** Settings → Notifications: whether notifications reach the person, and why not. */
  notificationHealth(): Promise<NotificationHealth>;
  /** Linux AppImage: add (`install`) or take back (`remove`) Tandemise's `.desktop` entry. Only on the person's click. */
  notificationDesktopEntry(action: 'install' | 'remove'): Promise<NotificationHealth>;
  /** A notification was clicked: open this route. Returns an unsubscribe. */
  onNotificationOpen(listener: (target: NotificationOpen) => void): () => void;
  /**
   * Acceptance-suite hook (list, click, hide, window, focus, pause, resume, poll).
   * Rejects unless the app was started with TANDEMISE_NOTIFY_RECORD.
   */
  notificationsDebug(op: string, arg?: unknown): Promise<unknown>;
  /** Version, build, Electron, Chromium, Node and OS of this app, for Settings → About. */
  getAppInfo(): Promise<AppAboutFacts>;
}

/**
 * Exposed as `window.tandemiseTest` only when the app runs with
 * `TANDEMISE_TEST_HOOKS=1`, for the real-app suites: the macOS About panel is a
 * native window CDP cannot read, so a suite reads the options it was given.
 */
export interface TandemiseTestBridge {
  aboutPanelOptions(): Promise<Record<string, unknown>>;
}

/** IPC channel names, kept in one place so a typo fails at compile time. */
export const IPC = {
  daemonStatus: 'daemon:status',
  daemonReconnect: 'daemon:reconnect',
  daemonStatusChanged: 'daemon:status-changed',
  selectDirectory: 'dialog:select-directory',
  openExternal: 'shell:open-external',
  revealInFinder: 'shell:reveal',
  notificationTest: 'notifications:test',
  notificationOpen: 'notifications:open',
  notificationDebug: 'notifications:debug',
  notificationHealth: 'notifications:health',
  notificationDesktopEntry: 'notifications:desktop-entry',
  appInfo: 'app:info',
  testAboutPanelOptions: 'test:about-panel-options',
} as const;

/** The renderer argument that tells the preload to expose the test bridge. */
export const TEST_HOOKS_ARGUMENT = '--tandemise-test-hooks';
