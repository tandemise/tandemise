import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  TEST_HOOKS_ARGUMENT,
  type DaemonStatus,
  type NotificationOpen,
  type TandemiseBridge,
  type TandemiseTestBridge,
} from '../shared/bridge.js';

/**
 * The only bridge between the sandboxed renderer and the OS.
 *
 * Every member forwards to a main-process handler that validates its own
 * arguments; nothing here hands the renderer a raw `ipcRenderer`, a module
 * loader, or a path, because any of those would make `contextIsolation`
 * decorative (MVP.md §32).
 */
const bridge: TandemiseBridge = {
  platform: process.platform,
  getDaemonStatus: () => ipcRenderer.invoke(IPC.daemonStatus),
  reconnectDaemon: () => ipcRenderer.invoke(IPC.daemonReconnect),
  onDaemonStatus(listener) {
    const handler = (_event: unknown, status: DaemonStatus): void => listener(status);
    ipcRenderer.on(IPC.daemonStatusChanged, handler);
    return () => {
      ipcRenderer.off(IPC.daemonStatusChanged, handler);
    };
  },
  selectDirectory: (title) => ipcRenderer.invoke(IPC.selectDirectory, title),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  revealInFinder: (path) => ipcRenderer.invoke(IPC.revealInFinder, path),
  testNotification: () => ipcRenderer.invoke(IPC.notificationTest),
  notificationHealth: () => ipcRenderer.invoke(IPC.notificationHealth),
  notificationDesktopEntry: (action) => ipcRenderer.invoke(IPC.notificationDesktopEntry, action),
  onNotificationOpen(listener) {
    const handler = (_event: unknown, target: NotificationOpen): void => listener(target);
    ipcRenderer.on(IPC.notificationOpen, handler);
    return () => {
      ipcRenderer.off(IPC.notificationOpen, handler);
    };
  },
  notificationsDebug: (op, arg) => ipcRenderer.invoke(IPC.notificationDebug, op, arg),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
};

contextBridge.exposeInMainWorld('tandemise', bridge);

// Only when the main process started with TANDEMISE_TEST_HOOKS=1 and passed the
// flag to this renderer; a normal run has no `window.tandemiseTest` at all.
if (process.argv.includes(TEST_HOOKS_ARGUMENT)) {
  const testBridge: TandemiseTestBridge = {
    aboutPanelOptions: () => ipcRenderer.invoke(IPC.testAboutPanelOptions),
  };
  contextBridge.exposeInMainWorld('tandemiseTest', testBridge);
}
