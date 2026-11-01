import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray, session } from 'electron';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaemonConnector } from './daemon-connection.js';
import { Notifier } from './notifier.js';
import { NotificationHealthProbe } from './notify-health.js';
import { IPC, TEST_HOOKS_ARGUMENT, type NotificationOpen } from '../shared/bridge.js';
import { aboutPanelOptions, appAboutFacts, installApplicationMenu } from './about.js';
import { WINDOW_BACKGROUND } from '../shared/brand.js';

const here = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];

const APP_NAME = 'Tandemise';
/** electron-builder's `appId` (electron-builder.config.mjs), which the NSIS installer gives its shortcut. */
const APP_USER_MODEL_ID = 'dev.tandemise.desktop';
/** Real-app suites only: exposes the About panel options to the renderer (see `TandemiseTestBridge`). */
const testHooks = process.env['TANDEMISE_TEST_HOOKS'] === '1';
/** Built from `@tandemise/design`'s `assets/app-icon.svg` by `npm run icons`. */
const appIconPath = join(here, '../../build/icon.png');

/**
 * Name and icon, before anything can read them.
 *
 * A packaged build takes both from the bundle, but unpackaged Electron falls
 * back to its own: the menu bar, the dock, the About panel and every system
 * dialog say "Electron" and show its default icon. Since this app is run
 * unpackaged for development, setting them here is what makes the running app
 * recognisably itself.
 */
app.setName(APP_NAME);
const aboutOptions = aboutPanelOptions(appIconPath);
app.setAboutPanelOptions(aboutOptions);
if (isDev && process.platform === 'darwin') {
  const icon = nativeImage.createFromPath(appIconPath);
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
}
/**
 * Windows shows a toast only for an app whose AppUserModelID matches a Start
 * menu shortcut; the NSIS installer's shortcut carries electron-builder's
 * `appId`. Linux names the app through package.json `desktopName` instead.
 */
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

const connector = new DaemonConnector();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set by the tray's Quit item; distinguishes "close the window" from "stop the app". */
let quitting = false;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    // The canvas colour, so the window does not flash before the first paint.
    backgroundColor: nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    title: APP_NAME,
    // Windows and Linux take the window icon from here; macOS uses the bundle.
    ...(process.platform === 'darwin' ? {} : { icon: appIconPath }),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      ...(testHooks ? { additionalArguments: [TEST_HOOKS_ARGUMENT] } : {}),
    },
  });

  window.once('ready-to-show', () => window.show());

  // Closing the window leaves missions running (MVP.md §7.3); only an explicit
  // Quit tears the app down.
  window.on('close', (event) => {
    if (quitting || process.platform !== 'darwin') return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    mainWindow = null;
  });

  // Nothing in this app has a legitimate reason to open a second window or to
  // navigate away from the bundle; both are how a compromised renderer escapes.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });

  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(here, '../renderer/index.html'));

  return window;
}

function showWindow(): void {
  mainWindow ??= createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * A clicked notification (P16): bring the window forward, then tell the
 * renderer where to go. A window still loading gets the route once it has.
 */
function openFromNotification(target: NotificationOpen): void {
  showWindow();
  const contents = mainWindow?.webContents;
  if (!contents) return;
  const send = (): void => contents.send(IPC.notificationOpen, target);
  if (contents.isLoading()) contents.once('did-finish-load', send);
  else send();
}

const notificationProbe = new NotificationHealthProbe(appIconPath);
const notifier = new Notifier(connector, () => mainWindow, openFromNotification, notificationProbe, appIconPath);

function createTray(): void {
  const icon = nativeImage.createFromPath(join(here, '../../resources/trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: showWindow },
      { type: 'separator' },
      {
        label: `Quit ${APP_NAME}`,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

/**
 * Content Security Policy. The renderer loads no remote code and talks only to
 * the loopback daemon; `connect-src` is the one directive that must stay open,
 * and only to 127.0.0.1 (MVP.md §7.2).
 */
function applyContentSecurityPolicy(): void {
  const policy = [
    "default-src 'none'",
    "script-src 'self'" + (isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''),
    // Vite injects styles as <style> tags at runtime, in dev and in production.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*${isDev ? ' ws:' : ''}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });

  // Deny every powerful web API outright, except writing plain text to the
  // clipboard: "Copy diagnostics" and the copyable ids need it, and Chromium
  // asks for it even on a click. Reading the clipboard stays denied.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write'),
  );
}

function registerIpc(): void {
  ipcMain.handle(IPC.daemonStatus, () => connector.status);
  ipcMain.handle(IPC.daemonReconnect, () => connector.refresh());

  ipcMain.handle(IPC.selectDirectory, async (_event, title: unknown) => {
    // Acceptance hook: a native folder dialog cannot be driven over CDP, so a
    // test run names the folder in a file instead (P15). Unset in a normal launch.
    const picked = process.env.TANDEMISE_TEST_PICK_DIRECTORY;
    if (picked !== undefined && picked !== '') {
      try {
        return readFileSync(picked, 'utf8').trim() || null;
      } catch {
        return null;
      }
    }
    const result = await dialog.showOpenDialog({
      title: typeof title === 'string' ? title : 'Choose a repository',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Choose',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
    // Only http(s) - `file:` or `javascript:` here would be an arbitrary-open primitive.
    if (typeof url !== 'string') return;
    const parsed = safeUrl(url);
    if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) await shell.openExternal(url);
  });

  ipcMain.handle(IPC.notificationTest, () => notifier.test());
  ipcMain.handle(IPC.notificationHealth, () => notifier.health());
  // Writes to the person's apps folder, so only from the Settings button they clicked.
  ipcMain.handle(IPC.notificationDesktopEntry, (_event, action: unknown) => {
    if (action === 'install') notificationProbe.installDesktopEntry();
    else if (action === 'remove') notificationProbe.removeDesktopEntry();
    else throw new Error(`Unknown action '${String(action)}'.`);
    return notifier.health();
  });
  ipcMain.handle(IPC.notificationDebug, (_event, op: unknown, arg: unknown) => {
    if (!Notifier.recording) throw new Error('Notification debugging is only available with TANDEMISE_NOTIFY_RECORD set.');
    return notifier.debug(typeof op === 'string' ? op : '', arg);
  });

  ipcMain.handle(IPC.revealInFinder, async (_event, path: unknown) => {
    if (typeof path === 'string' && path.length > 0) shell.showItemInFolder(path);
  });

  ipcMain.handle(IPC.appInfo, () => appAboutFacts());
  if (testHooks) ipcMain.handle(IPC.testAboutPanelOptions, () => ({ ...aboutOptions }));
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

connector.on('status', (status) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.daemonStatusChanged, status);
  }
});

/**
 * One installed app per person. Opening it again (a second click in the dock or
 * the applications menu, which on Linux and Windows starts a new process)
 * focuses the window already open, instead of a second app racing the first to
 * start or replace the daemon. Development runs are left alone: test harnesses
 * and developers run several windows side by side, each with its own data dir.
 */
const primaryInstance = isDev || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on('second-instance', () => { if (app.isReady()) showWindow(); });

app.whenReady().then(() => {
  if (!primaryInstance) return;
  applyContentSecurityPolicy();
  installApplicationMenu();
  registerIpc();
  createTray();
  mainWindow = createWindow();

  void connector.refresh().finally(() => connector.watch());
  // Polls whether or not a window is open, so a hidden app still reaches the person.
  notifier.start();

  app.on('activate', showWindow);
});

app.on('window-all-closed', () => {
  // Deliberately does not quit: the tray keeps the app alive so background
  // missions survive closing the last window (MVP.md §7.3).
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  notifier.stop();
  tray?.destroy();
});
