import type { NotificationHealth, NotificationTestResult } from '../shared/bridge.js';

/**
 * The rules behind desktop notifications reaching the person, kept free of
 * Electron and of the file system so the offline checks can run them
 * (scratch/notify-delivery-check.mjs transpiles this one file).
 *
 * Two things are decided here:
 * - what is recorded as notified: only what the operating system accepted.
 *   A notice it refused goes back to the daemon (`/v1/notifications/release`)
 *   and is announced again once it can be;
 * - what Settings → Notifications says about it, in plain words, from what
 *   the system reports (on Linux: the notification server over D-Bus and,
 *   under GNOME, its notification settings).
 */

/** What the operating system did with one notification. */
export interface Delivery {
  /** It took it: Linux's notification server answered with an id, macOS and Windows reported it shown. */
  readonly accepted: boolean;
  /** Why not, when it did not. */
  readonly reason: string | null;
}

/** How long to wait before asking the daemon again after the system refused a notification. */
export const FAILURE_PAUSE_MS = 60_000;

/**
 * After the system answered: a refused notice is released (its ids are not
 * notified after all), and taking stops for a while, so a desktop with no
 * notification server is not asked every few seconds.
 */
export function afterDelivery(delivery: Delivery, now: number): { readonly release: boolean; readonly pausedUntil: number | null } {
  return delivery.accepted ? { release: false, pausedUntil: null } : { release: true, pausedUntil: now + FAILURE_PAUSE_MS };
}

/**
 * Whether to ask the daemon for what is new. Not when this system cannot show
 * a notification at all: taking would record items as notified that nobody saw.
 */
export function mayTake(input: { readonly supported: boolean; readonly pausedUntil: number | null; readonly now: number }): boolean {
  if (!input.supported) return false;
  return input.pausedUntil === null || input.now >= input.pausedUntil;
}

// ------------------------------------------------------------------ Linux facts

/** `org.freedesktop.Notifications.GetServerInformation`. */
export interface ServerInformation {
  readonly name: string;
  readonly vendor: string;
  readonly version: string;
}

/** What the main process found out about this Linux desktop (see notify-health.ts). */
export interface LinuxFacts {
  /** Electron found libnotify. */
  readonly supported: boolean;
  /** The notification server's answer, its D-Bus error, or null when there was nothing to ask with (no `gdbus`). */
  readonly server: ServerInformation | { readonly error: string } | null;
  /** `org.gnome.desktop.notifications show-banners`: false is GNOME's Do Not Disturb. Null when not GNOME or not readable. */
  readonly globalBanners: boolean | null;
  /** GNOME's per-app `enable` for Tandemise; null unless GNOME knows the app (its `.desktop` entry is installed). */
  readonly appEnabled: boolean | null;
  /** GNOME's per-app `show-banners` for Tandemise; null as above. */
  readonly appBanners: boolean | null;
  /** Where Tandemise's `.desktop` entry was found, or null. */
  readonly entryPath: string | null;
  /** That entry is the one Tandemise added from Settings (it carries the marker). */
  readonly entryOurs: boolean;
  /** Running from an AppImage, which installs no `.desktop` entry of its own. */
  readonly appImage: boolean;
}

/** Marks the `.desktop` entry Tandemise adds, so it only ever removes its own. */
export const DESKTOP_ENTRY_MARKER = 'X-Tandemise-Added-From-Settings=true';

/** `tandemise.desktop` → `tandemise`: the id the desktop knows the app by (and Electron's Wayland app_id). */
export function desktopId(desktopName: string): string {
  return desktopName.replace(/\.desktop$/, '');
}

/** GNOME's per-app notification settings path, keyed the way GNOME Shell canonicalizes the id. */
export function gnomeAppSettingsPath(id: string): string {
  const key = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-');
  return `/org/gnome/desktop/notifications/application/${key}/`;
}

/** `gdbus call` prints `('gnome-shell', 'GNOME', '50.1', '1.2')`. */
export function parseServerInformation(stdout: string): ServerInformation | null {
  const values = [...stdout.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'));
  const [name, vendor, version] = values;
  if (name === undefined || vendor === undefined || version === undefined) return null;
  return { name, vendor, version };
}

/** `gsettings get` prints `true` or `false`. */
export function parseGsettingsBoolean(stdout: string): boolean | null {
  const value = stdout.trim();
  return value === 'true' ? true : value === 'false' ? false : null;
}

/** "GNOME Shell 50.1", "Plasma 6.3", "dunst 1.11". */
export function describeServer(server: ServerInformation): string {
  if (server.name === 'gnome-shell') return `GNOME Shell ${server.version}`;
  if (server.name === 'Plasma') return `KDE Plasma ${server.version}`;
  return `${server.name} ${server.version}`.trim();
}

const isServer = (s: LinuxFacts['server']): s is ServerInformation => s !== null && !('error' in s);

/** Settings → Notifications on Linux. */
export function assessLinux(facts: LinuxFacts, lastFailure: NotificationHealth['lastFailure']): NotificationHealth {
  const desktopEntry: NotificationHealth['desktopEntry'] = facts.entryPath !== null
    ? { state: 'installed', offer: facts.entryOurs ? 'remove' : null, path: facts.entryPath }
    : { state: 'missing', offer: facts.appImage ? 'install' : null, path: null };
  const server = isServer(facts.server) ? describeServer(facts.server) : null;
  const base = { server, desktopEntry, lastFailure };

  if (!facts.supported) {
    return {
      ...base,
      reach: 'unavailable',
      summary: 'This system has no notification library Tandemise can use, so it cannot show notifications.',
      advice: 'Install libnotify (the libnotify4 package on Debian and Ubuntu), then restart Tandemise. Until then nothing is recorded as notified.',
    };
  }
  if (facts.server !== null && !isServer(facts.server)) {
    return {
      ...base,
      reach: 'unavailable',
      summary: `No notification server answers on this desktop session (${facts.server.error}).`,
      advice: 'Notifications need a desktop that shows them (GNOME, KDE Plasma) or a notification daemon such as dunst or mako. Until one runs, nothing is recorded as notified.',
    };
  }
  if (lastFailure !== null && facts.server === null) {
    return {
      ...base,
      reach: 'unavailable',
      summary: `The system refused the last notification: ${lastFailure.reason}`,
      advice: 'Check that a notification server runs on this desktop. What was refused is announced again once one does.',
    };
  }

  const gnome = isServer(facts.server) && facts.server.name === 'gnome-shell';
  if (gnome && facts.appEnabled === false) {
    return {
      ...base,
      reach: 'hidden',
      summary: 'Notifications for Tandemise are turned off in GNOME Settings, so GNOME takes them and shows nothing.',
      advice: 'Turn them on in GNOME Settings → Notifications → Tandemise.',
    };
  }
  if (gnome && facts.globalBanners === false) {
    return {
      ...base,
      reach: 'hidden',
      summary: 'GNOME\'s Do Not Disturb is on: notifications go to the notification list without a banner.',
      advice: 'Turn off Do Not Disturb in the notification list (click the date and time at the top of the screen) or in GNOME Settings → Notifications. What arrived meanwhile is in that list.',
    };
  }
  if (gnome && facts.appBanners === false) {
    return {
      ...base,
      reach: 'hidden',
      summary: 'Banners are off for Tandemise in GNOME Settings: notifications go to the notification list without a banner.',
      advice: 'Turn on Notification Banners in GNOME Settings → Notifications → Tandemise.',
    };
  }

  const shown = gnome ? `${server} shows Tandemise's notifications as banners.` : `${server ?? 'The notification server'} takes Tandemise's notifications.`;
  const missingEntry = facts.entryPath === null;
  return {
    ...base,
    reach: 'ready',
    summary: missingEntry ? `${shown} Without a Tandemise entry in your apps, they show no Tandemise icon.` : shown,
    advice: missingEntry && facts.appImage
      ? 'Add Tandemise to your apps so notifications carry its name and icon, and so GNOME lists Tandemise under Settings → Notifications.'
      : null,
  };
}

/** Settings → Notifications on macOS and Windows, which do not tell an app whether its notifications are allowed. */
export function assessOther(platform: string, supported: boolean, lastFailure: NotificationHealth['lastFailure']): NotificationHealth {
  const system = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'This system';
  const where = platform === 'darwin'
    ? 'System Settings → Notifications → Tandemise'
    : platform === 'win32' ? 'Settings → System → Notifications → Tandemise' : 'your system settings';
  const base = { server: null, desktopEntry: { state: 'not-applicable', offer: null, path: null } as const, lastFailure };
  if (!supported) {
    return { ...base, reach: 'unavailable', summary: `${system} offers no notifications Tandemise can use.`, advice: 'Until it does, nothing is recorded as notified.' };
  }
  if (lastFailure !== null) {
    return { ...base, reach: 'unavailable', summary: `${system} refused the last notification: ${lastFailure.reason}`, advice: `Allow notifications for Tandemise in ${where}. What was refused is announced again.` };
  }
  return {
    ...base,
    reach: 'unknown',
    summary: `${system} does not tell apps whether their notifications are allowed.`,
    advice: `Send a test notification. If none appears, allow notifications for Tandemise in ${where}.`,
  };
}

/** What "Send a test notification" reports, from what the system did with it. */
export function testResult(delivery: Delivery, health: NotificationHealth, platform: string): NotificationTestResult {
  const who = health.server ?? (platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'The system');
  if (!delivery.accepted) {
    const why = delivery.reason !== null && delivery.reason !== '' ? delivery.reason : health.summary;
    return { accepted: false, shown: 'no', message: `Not delivered: ${why}`, health };
  }
  if (health.reach === 'hidden') {
    return { accepted: true, shown: 'no', message: `${who} took it but shows no banner. ${health.summary}`, health };
  }
  if (health.reach === 'ready' && platform === 'linux' && health.server?.startsWith('GNOME Shell') === true) {
    return { accepted: true, shown: 'yes', message: `${who} took it and shows it as a banner now.`, health };
  }
  return {
    accepted: true,
    shown: 'unknown',
    message: `${who} took it. If you do not see it, ${platform === 'linux' ? 'check your desktop\'s notification settings' : `allow notifications for Tandemise in ${platform === 'darwin' ? 'System Settings → Notifications' : 'Settings → System → Notifications'}`}.`,
    health,
  };
}

// ------------------------------------------------------------------ the .desktop entry

/** One argument of a `.desktop` Exec line, quoted the way the Desktop Entry spec asks. */
export function quoteExecArgument(arg: string): string {
  if (!/[\s"'\\`$<>~|&;*?#()]/.test(arg)) return arg;
  return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

/**
 * The entry Tandemise adds for an AppImage, from Settings and only on the
 * person's click. `StartupWMClass` is the id Electron gives its windows (the
 * Wayland app_id), so the desktop ties the running window, the notifications'
 * `desktop-entry` hint and this entry together.
 */
export function desktopEntryText(input: { readonly exec: string; readonly icon: string; readonly id: string }): string {
  return [
    '[Desktop Entry]',
    '# Added by Tandemise from Settings → Notifications; remove it there.',
    'Type=Application',
    'Name=Tandemise',
    'Comment=A local-first desktop OS for running a software company with AI workers.',
    `Exec=${quoteExecArgument(input.exec)} %U`,
    `Icon=${input.icon}`,
    'Terminal=false',
    'Categories=Development;',
    `StartupWMClass=${input.id}`,
    DESKTOP_ENTRY_MARKER,
    '',
  ].join('\n');
}
