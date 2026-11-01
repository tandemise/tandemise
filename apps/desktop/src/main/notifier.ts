import { Notification, type BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';
import type { DaemonConnector } from './daemon-connection.js';
import type { NotificationHealth, NotificationOpen, NotificationTestResult } from '../shared/bridge.js';
import { afterDelivery, mayTake, testResult, type Delivery } from './notify-delivery.js';
import type { NotificationHealthProbe } from './notify-health.js';

/** One notice as the daemon's `POST /v1/notifications/take` returns it (P16). */
interface Notice {
  readonly title: string;
  readonly body: string;
  readonly route: string;
  readonly workspaceId: string | null;
  readonly ids: readonly string[];
  readonly shape: string;
}

/** What the test hook records for every notification Tandemise tried to show. */
export interface NotificationRecord extends Notice {
  readonly at: string;
  /** From the Settings button, not from the Inbox. */
  readonly test: boolean;
  /** The window was hidden or not focused when it was shown. */
  readonly windowVisible: boolean;
  /** The operating system took it. When it did not, its ids went back to the daemon. */
  readonly delivered: boolean;
  /** Why not, when it was not delivered. */
  readonly reason: string | null;
}

const POLL_MS = Number(process.env['TANDEMISE_NOTIFY_POLL_MS'] ?? '') || 5_000;
/** Test hook: every notice is appended to this file as one JSON line, and the debug IPC is enabled. */
const RECORD_FILE = process.env['TANDEMISE_NOTIFY_RECORD'] ?? null;
/** Linux answers at once (the server replies with an id); macOS and Windows within a moment. */
const ANSWER_TIMEOUT_MS = 10_000;

export const TEST_NOTICE = {
  title: 'Notifications are on',
  body: 'This is how Tandemise will tell you something needs you.',
} as const;

/**
 * Asks the daemon what is new in the Inbox and shows it (P16 spec §3).
 *
 * Lives in the main process so it keeps working while the window is hidden or
 * closed to the tray. The daemon decides what to announce and records it; this
 * class reports whether the person is already looking at the Inbox, shows what
 * comes back, and hands back to the daemon whatever the operating system
 * refused, so nothing is recorded as notified that never reached the screen.
 */
export class Notifier {
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #paused = false;
  /** After a refusal: no taking until then (FAILURE_PAUSE_MS). */
  #pausedUntil: number | null = null;
  #lastFailure: NotificationHealth['lastFailure'] = null;
  /** Test override for "is the window focused": a window driven over CDP may not have OS focus. */
  #focusOverride: boolean | null = null;
  readonly #records: NotificationRecord[] = [];
  /** Kept referenced until closed: a garbage-collected Notification loses its click handler. */
  readonly #live = new Set<Notification>();

  constructor(
    private readonly connector: DaemonConnector,
    private readonly window: () => BrowserWindow | null,
    private readonly open: (target: NotificationOpen) => void,
    private readonly probe: NotificationHealthProbe,
    /** Shown in the notification on Linux when the desktop has no Tandemise entry to take the icon from. */
    private readonly iconPath: string,
  ) {}

  static get recording(): boolean {
    return RECORD_FILE !== null;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One round trip. Skipped while one is in flight, paused, with no daemon, or when nothing can be shown. */
  async poll(): Promise<number> {
    const connection = this.connector.status.connection;
    if (this.#busy || this.#paused || this.connector.status.phase !== 'connected' || connection === null) return 0;
    if (!mayTake({ supported: Notification.isSupported(), pausedUntil: this.#pausedUntil, now: Date.now() })) return 0;
    this.#busy = true;
    const headers = { authorization: `Bearer ${connection.token}`, 'x-tandemise-api-version': 'v1', 'content-type': 'application/json' };
    try {
      const res = await fetch(`${connection.url}/v1/notifications/take`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ suppress: this.#lookingAtInbox() }),
      });
      if (!res.ok) return 0;
      const { notices } = (await res.json()) as { notices: readonly Notice[] };
      let delivered = 0;
      for (const notice of notices) {
        const delivery = await this.#show(notice, false);
        if (delivery.accepted) {
          delivered++;
        } else if (notice.ids.length > 0) {
          // Not shown, so not notified: the daemon announces these again once the system takes them.
          await fetch(`${connection.url}/v1/notifications/release`, { method: 'POST', headers, body: JSON.stringify({ ids: notice.ids }) });
        }
      }
      return delivered;
    } catch {
      // The daemon restarting is normal; the connector reports it, and the next poll retries.
      return 0;
    } finally {
      this.#busy = false;
    }
  }

  /** Settings → "Send a test notification". Touches nothing in the daemon. */
  async test(): Promise<NotificationTestResult> {
    const delivery = await this.#show({ ...TEST_NOTICE, route: '/settings', workspaceId: null, ids: [], shape: 'test' }, true);
    return testResult(delivery, await this.health(), process.platform);
  }

  /** Settings → Notifications: what the operating system says about notifications reaching the person. */
  health(): Promise<NotificationHealth> {
    return this.probe.health(Notification.isSupported(), this.#lastFailure);
  }

  /** The acceptance suite's handle on what a person would see and click (only with TANDEMISE_NOTIFY_RECORD). */
  async debug(op: string, arg: unknown): Promise<unknown> {
    switch (op) {
      case 'list': return this.#records;
      case 'click': {
        const record = this.#records[typeof arg === 'number' ? arg : this.#records.length - 1];
        if (record === undefined) throw new Error('No such notification.');
        this.#click(record);
        return record;
      }
      case 'hide': this.window()?.hide(); return true;
      case 'window': {
        const window = this.window();
        return window === null || window.isDestroyed() ? null : { visible: window.isVisible(), focused: window.isFocused() };
      }
      case 'focus': this.#focusOverride = typeof arg === 'boolean' ? arg : null; return this.#focusOverride;
      case 'pause': this.#paused = true; return true;
      case 'resume': this.#paused = false; return true;
      case 'poll': {
        const paused = this.#paused;
        this.#paused = false;
        this.#pausedUntil = null;
        try { return await this.poll(); } finally { this.#paused = paused; }
      }
      default: throw new Error(`Unknown notification debug op '${op}'.`);
    }
  }

  /** Visible, focused and on the Inbox: the person is already looking at what would be announced. */
  #lookingAtInbox(): boolean {
    const window = this.window();
    if (window === null || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return false;
    if (!(this.#focusOverride ?? window.isFocused())) return false;
    const hash = safeHash(window.webContents.getURL());
    return hash === '#/inbox' || hash.startsWith('#/inbox/') || hash.startsWith('#/inbox?');
  }

  /** Shows one notice and waits for the system's answer: it took it (`show`) or refused it (`failed`). */
  async #show(notice: Notice, test: boolean): Promise<Delivery> {
    const window = this.window();
    const windowVisible = window !== null && !window.isDestroyed() && window.isVisible();
    const answer = Notification.isSupported()
      ? await this.#native(notice, () => record)
      : { accepted: false, reason: 'This system has no notification support Tandemise can use.' };
    const at = new Date().toISOString();
    const next = afterDelivery(answer, Date.now());
    let delivery: Delivery = answer;
    if (!answer.accepted) {
      this.#pausedUntil = next.pausedUntil;
      // Electron reports a refusal without a reason on Linux; the probe says what the system says.
      const reason = answer.reason !== null && answer.reason !== '' ? answer.reason : (await this.health()).summary;
      this.#lastFailure = { at, reason };
      delivery = { accepted: false, reason };
    } else if (!test) {
      this.#lastFailure = null;
    }
    const record: NotificationRecord = {
      ...notice, at, test, windowVisible, delivered: delivery.accepted, reason: delivery.reason,
    };
    this.#records.push(record);
    if (RECORD_FILE !== null) {
      try { appendFileSync(RECORD_FILE, JSON.stringify(record) + '\n'); } catch { /* the record is a test aid only */ }
    }
    return delivery;
  }

  #native(notice: Notice, record: () => NotificationRecord): Promise<Delivery> {
    // An AppImage the desktop has no entry for: the notification carries the icon itself.
    const icon = process.platform === 'linux' && this.probe.entryPath() === null ? this.iconPath : undefined;
    const native = new Notification({ title: notice.title, body: notice.body, ...(icon === undefined ? {} : { icon }) });
    this.#live.add(native);
    native.on('click', () => this.#click(record()));
    native.on('close', () => this.#live.delete(native));
    return new Promise<Delivery>((resolve) => {
      let answered = false;
      const answer = (delivery: Delivery): void => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        if (!delivery.accepted) this.#live.delete(native);
        resolve(delivery);
      };
      // No answer at all is not a refusal: keep it recorded rather than announce it twice.
      const timer = setTimeout(() => answer({ accepted: true, reason: null }), ANSWER_TIMEOUT_MS);
      native.once('show', () => answer({ accepted: true, reason: null }));
      native.once('failed', (_event, error) => answer({ accepted: false, reason: typeof error === 'string' ? error : null }));
      native.show();
    });
  }

  #click(record: NotificationRecord): void {
    this.open({ route: record.route, workspaceId: record.workspaceId });
  }
}

function safeHash(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return '';
  }
}
