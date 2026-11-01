import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NotificationHealth } from '../shared/bridge.js';
import {
  DESKTOP_ENTRY_MARKER, assessLinux, assessOther, desktopEntryText, desktopId, gnomeAppSettingsPath,
  parseGsettingsBoolean, parseServerInformation, type LinuxFacts,
} from './notify-delivery.js';

interface Run {
  readonly ok: boolean;
  readonly stdout: string;
  /** The error's first line, when the command ran and failed. */
  readonly error: string | null;
  /** The command is not installed. */
  readonly missing: boolean;
}

function run(file: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4_000, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true, stdout, error: null, missing: false });
        return;
      }
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      const first = (stderr || error.message).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'failed';
      resolve({ ok: false, stdout, error: first.replace(/^Error: /, ''), missing });
    });
  });
}

/**
 * Reads, from the operating system, whether Tandemise's notifications reach
 * the person (Settings → Notifications), and adds or removes the `.desktop`
 * entry an AppImage lacks. Read-only apart from that entry, which is only
 * written on the person's click.
 */
export class NotificationHealthProbe {
  readonly #id: string;

  constructor(
    private readonly iconPath: string,
    desktopName = process.env['CHROME_DESKTOP'] ?? 'tandemise.desktop',
    private readonly platform: string = process.platform,
  ) {
    this.#id = desktopId(desktopName);
  }

  /** Where the desktop looks for applications: `$XDG_DATA_HOME`, then `$XDG_DATA_DIRS`. */
  #dataHome(): string {
    const value = process.env['XDG_DATA_HOME'];
    return value !== undefined && value !== '' ? value : join(homedir(), '.local', 'share');
  }

  #dataDirs(): string[] {
    const value = process.env['XDG_DATA_DIRS'];
    return [this.#dataHome(), ...(value !== undefined && value !== '' ? value : '/usr/local/share:/usr/share').split(':').filter((d) => d !== '')];
  }

  #userEntryPath(): string {
    return join(this.#dataHome(), 'applications', `${this.#id}.desktop`);
  }

  /** Tandemise's `.desktop` entry, wherever the desktop would find it (a .deb puts it in /usr/share). */
  entryPath(): string | null {
    if (this.platform !== 'linux') return null;
    for (const dir of this.#dataDirs()) {
      const path = join(dir, 'applications', `${this.#id}.desktop`);
      if (existsSync(path)) return path;
    }
    return null;
  }

  #entryIsOurs(path: string | null): boolean {
    if (path !== this.#userEntryPath()) return false;
    try {
      return readFileSync(path, 'utf8').includes(DESKTOP_ENTRY_MARKER);
    } catch {
      return false;
    }
  }

  async linuxFacts(supported: boolean): Promise<LinuxFacts> {
    const entryPath = this.entryPath();
    const info = await run('gdbus', [
      'call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.GetServerInformation',
    ]);
    const server = info.missing ? null : info.ok ? (parseServerInformation(info.stdout) ?? { error: 'an answer Tandemise could not read' }) : { error: info.error ?? 'no answer' };
    const gnome = server !== null && !('error' in server) && server.name === 'gnome-shell';
    const read = async (schema: string, key: string): Promise<boolean | null> => {
      const r = await run('gsettings', ['get', schema, key]);
      return r.ok ? parseGsettingsBoolean(r.stdout) : null;
    };
    const appSchema = `org.gnome.desktop.notifications.application:${gnomeAppSettingsPath(this.#id)}`;
    // GNOME keys its per-app settings by the `.desktop` entry; without one it uses only the global switch.
    const known = gnome && entryPath !== null;
    return {
      supported,
      server,
      globalBanners: gnome ? await read('org.gnome.desktop.notifications', 'show-banners') : null,
      appEnabled: known ? await read(appSchema, 'enable') : null,
      appBanners: known ? await read(appSchema, 'show-banners') : null,
      entryPath,
      entryOurs: this.#entryIsOurs(entryPath),
      appImage: typeof process.env['APPIMAGE'] === 'string' && process.env['APPIMAGE'] !== '',
    };
  }

  async health(supported: boolean, lastFailure: NotificationHealth['lastFailure']): Promise<NotificationHealth> {
    if (this.platform !== 'linux') return assessOther(this.platform, supported, lastFailure);
    return assessLinux(await this.linuxFacts(supported), lastFailure);
  }

  /**
   * Adds Tandemise to the person's apps: `~/.local/share/applications/<id>.desktop`
   * running this AppImage, with the icon beside it. Only for an AppImage, which
   * has nothing installed; a .deb already has its entry.
   */
  installDesktopEntry(): void {
    const appImage = process.env['APPIMAGE'];
    if (this.platform !== 'linux' || appImage === undefined || appImage === '') {
      throw new Error('Only the AppImage needs Tandemise added to your apps; this install already has its entry or does not use one.');
    }
    if (this.entryPath() !== null) return;
    const iconDir = join(this.#dataHome(), 'icons', 'hicolor', '512x512', 'apps');
    const icon = join(iconDir, `${this.#id}.png`);
    mkdirSync(iconDir, { recursive: true });
    // Read through Electron's asar-aware fs; copyFile does not see inside the archive.
    writeFileSync(icon, readFileSync(this.iconPath));
    const entry = this.#userEntryPath();
    mkdirSync(join(this.#dataHome(), 'applications'), { recursive: true });
    writeFileSync(entry, desktopEntryText({ exec: appImage, icon, id: this.#id }), { mode: 0o644 });
  }

  /** Takes back the entry (and icon) Tandemise added; never one it did not write. */
  removeDesktopEntry(): void {
    const entry = this.#userEntryPath();
    if (!this.#entryIsOurs(entry)) throw new Error('Tandemise did not add this entry, so it leaves it alone.');
    rmSync(entry, { force: true });
    rmSync(join(this.#dataHome(), 'icons', 'hicolor', '512x512', 'apps', `${this.#id}.png`), { force: true });
  }
}
