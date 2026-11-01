import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CORE_CAPABILITIES, anyCapabilityMatches, type Capability } from '@tandemise/domain';
import { forgeIsolation } from './forge-isolation.js';

/**
 * What an agent run gets beyond the allowlisted environment (#107).
 *
 * - Its own `TANDEMISE_HOME`, always. An agent working on Tandemise itself
 *   (or any tool that reads that variable) starts a dev daemon or desktop that
 *   would otherwise use the person's real `~/.tandemise`. Each run gets an
 *   empty directory of its own instead.
 * - A display, when the profile asks for one, so a code step can prove a UI
 *   change in the real app: `host` passes this computer's display through
 *   (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`); `virtual` runs the agent
 *   under `xvfb-run -a` when it is installed (Linux), a display of its own that
 *   nobody sees. Off by default: an agent with a display can open windows.
 */

export type AgentDisplay = 'off' | 'host' | 'virtual';

export const DISPLAY_ENV = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const;

/** The display a profile's `display` setting asks for. */
export function agentDisplaySetting(settings: Readonly<Record<string, unknown>>): AgentDisplay {
  const value = settings['display'];
  return value === 'host' || value === 'virtual' ? value : 'off';
}

/** The run's own TANDEMISE_HOME, created empty on first use. */
export function agentHome(runId: string, root: string = join(tmpdir(), 'tandemise-agent-homes')): string {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The first `name` on PATH, or null. */
export function onPath(name: string, path: string | undefined = process.env['PATH']): string | null {
  for (const dir of (path ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface AgentEnvPlan {
  /** Variables to set on the child, over the allowlisted environment. */
  readonly env: Readonly<Record<string, string>>;
  /** A command to run the agent under (`xvfb-run -a …`), or null. */
  readonly wrap: readonly string[] | null;
  /** Which display the run has, in words, for its log: "no display", "this computer's display", "a virtual display (xvfb-run)". */
  readonly display: string;
  /** Variables removed last: the code-host credentials a worker must not hold (#147). */
  readonly unset: readonly string[];
  /** What the run's shell can reach on the code host, in words. */
  readonly forge: string;
}

export function agentEnvPlan(input: {
  readonly runId: string;
  readonly display: AgentDisplay;
  readonly source?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeRoot?: string;
  readonly xvfbRun?: string | null;
  /** The step's grants: only `git.push` keeps git's credentials (#147). */
  readonly grants?: readonly Capability[];
}): AgentEnvPlan {
  const source = input.source ?? process.env;
  const home = agentHome(input.runId, input.homeRoot);
  const forge = forgeIsolation({ ghConfigDir: `${home}-gh`, push: anyCapabilityMatches(input.grants ?? [], CORE_CAPABILITIES.gitPush), source });
  const env: Record<string, string> = { ...forge.set, TANDEMISE_HOME: home };
  const extra = { unset: forge.unset, forge: forge.summary };
  if (input.display === 'host') {
    let any = false;
    for (const name of DISPLAY_ENV) {
      const value = source[name];
      if (value !== undefined && value !== '') { env[name] = value; any = true; }
    }
    return { env, ...extra, wrap: null, display: any ? "this computer's display" : 'no display (this computer has none to share)' };
  }
  if (input.display === 'virtual') {
    const platform = input.platform ?? process.platform;
    const xvfb = input.xvfbRun !== undefined ? input.xvfbRun : platform === 'linux' ? onPath('xvfb-run', source['PATH']) : null;
    if (xvfb !== null) return { env, ...extra, wrap: [xvfb, '-a', '-s', '-screen 0 1440x900x24'], display: 'a virtual display (xvfb-run)' };
    return { env, ...extra, wrap: null, display: 'no display (xvfb-run is not installed)' };
  }
  return { env, ...extra, wrap: null, display: 'no display' };
}

/**
 * The environment of a runtime that inherits the daemon's whole environment
 * (Codex, a generic CLI): that environment, with the run's own TANDEMISE_HOME
 * and without the person's code-host credentials (#147).
 */
export function workerEnv(request: { readonly runId: string; readonly grants: readonly Capability[] }, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const plan = agentEnvPlan({ runId: request.runId, display: 'off', grants: request.grants, source });
  const env: NodeJS.ProcessEnv = { ...source, ...plan.env };
  for (const name of plan.unset) delete env[name];
  return env;
}
