import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPaths, defaultRoot, expandPath, type LogLevel, type TandemisePaths } from '@tandemise/shared';

/**
 * Daemon configuration, resolved once at startup.
 *
 * Everything is overridable by environment variable so that a test run, a
 * second instance for development, and the packaged app can coexist without
 * sharing a database or a worktree root.
 */
export interface DaemonConfig {
  readonly home: string;
  readonly paths: TandemisePaths;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly version: string;
  /**
   * Short git commit this daemon was built from, or `dev`. Written next to the
   * compiled entry by `scripts/write-build-info.mjs` at `npm run build`, so it
   * names the code that is running, not the checkout it happens to sit in.
   */
  readonly build: string;
  /** Disables spawning real agent runtimes. Used by smoke tests. */
  readonly offline: boolean;
  /** Scheduler tick interval. Short enough to feel live, long enough to idle. */
  readonly tickIntervalMs: number;
  /** A run is quiet after this long without an agent event (P9); silent later. Never stops it. */
  readonly quietMs: number;
  /**
   * Test knob (P11): when set, the daemon's one Clock reads real time plus this
   * offset and `POST /v1/test/clock` may move it forward, so a real-app suite
   * reaches a routine's next run without waiting. Null (unset) in normal use.
   */
  readonly clockOffsetMs: number | null;
  /**
   * Where "Your Claude skills" looks (P13): ~/.claude/skills, unless
   * TANDEMISE_SKILLS_DISCOVER_DIR says otherwise - tests point it at a
   * fixture folder so they never read the real home.
   */
  readonly skillsDiscoverRoot: string;
}

export function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const home = overrides.home ?? defaultRoot();
  return {
    home,
    paths: createPaths(home),
    port: overrides.port ?? Number(process.env.TANDEMISE_PORT ?? 0),
    logLevel: overrides.logLevel ?? ((process.env.TANDEMISE_LOG_LEVEL as LogLevel) ?? 'info'),
    version: overrides.version ?? versionFromEnv() ?? '0.10.0', // x-release-please-version
    build: overrides.build ?? buildFromEnv() ?? readBuildInfo(),
    offline: overrides.offline ?? process.env.TANDEMISE_OFFLINE === '1',
    tickIntervalMs: overrides.tickIntervalMs ?? Number(process.env.TANDEMISE_TICK_MS ?? 1500),
    quietMs: overrides.quietMs ?? Number(process.env.TANDEMISE_QUIET_MS ?? 600_000),
    clockOffsetMs: overrides.clockOffsetMs !== undefined ? overrides.clockOffsetMs : clockOffsetFromEnv(),
    skillsDiscoverRoot: overrides.skillsDiscoverRoot
      ?? (process.env.TANDEMISE_SKILLS_DISCOVER_DIR?.trim() ? expandPath(process.env.TANDEMISE_SKILLS_DISCOVER_DIR.trim()) : join(homedir(), '.claude', 'skills')),
  };
}

function clockOffsetFromEnv(): number | null {
  const raw = process.env.TANDEMISE_CLOCK_OFFSET_MS;
  if (raw === undefined || raw.trim() === '') return null;
  const offset = Number(raw);
  return Number.isFinite(offset) ? offset : null;
}

/** Test knob: a packaged-app check plays a daemon left over from an older release. */
function versionFromEnv(): string | null {
  const raw = process.env.TANDEMISE_VERSION?.trim();
  return raw ? raw : null;
}

/** Test knob: a real-app suite names a different build to see the mismatch warning. */
function buildFromEnv(): string | null {
  const raw = process.env.TANDEMISE_BUILD?.trim();
  return raw ? raw : null;
}

/** `dist/build-info.json`, beside this module once compiled; `dev` when absent or unreadable. */
export function readBuildInfo(file: URL = new URL('./build-info.json', import.meta.url)): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const build = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).build : undefined;
    return typeof build === 'string' && /^[0-9a-f]{4,40}$/.test(build) ? build : 'dev';
  } catch {
    return 'dev';
  }
}
