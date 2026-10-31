import type { Platform } from '../../../shared/bridge.js';

/** The words for the platform's own things, so no screen says "Finder" on Linux. */
export interface PlatformWords {
  /** What reveals a file: "Finder", "File Explorer", or "file manager". */
  readonly fileManager: string;
  /** What the System theme follows: "macOS", "Windows", or "your system". */
  readonly system: string;
}

/**
 * The names a person on `platform` knows. Linux has no single file manager or
 * settings app, so it gets the generic words. `platform` defaults to the one
 * the window runs on; pass one to ask about another.
 */
export function platformWords(platform: Platform = window.tandemise.platform): PlatformWords {
  if (platform === 'darwin') return { fileManager: 'Finder', system: 'macOS' };
  if (platform === 'win32') return { fileManager: 'File Explorer', system: 'Windows' };
  return { fileManager: 'file manager', system: 'your system' };
}
