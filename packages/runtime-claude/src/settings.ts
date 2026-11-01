import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { RuntimeSettingField } from '@tandemise/domain';
import { TandemiseError } from '@tandemise/shared';

/**
 * Profile settings that shape the child's environment.
 *
 * Profiles deliberately cannot carry arbitrary environment variables: a free
 * map is where an `ANTHROPIC_API_KEY` ends up, and Tandemise does not put
 * credentials in its database (MVP.md §P8). But one variable is not a secret
 * and is the difference between "this profile is a distinct worker" and "every
 * profile is the same account": `CLAUDE_CONFIG_DIR`, which selects the config,
 * credentials and settings a Claude Code install runs under.
 *
 * So it is exposed as a typed, single-purpose setting rather than as env. Two
 * profiles pointing at two config directories are two independent workers -
 * different login, different MCP servers, different settings - which is what
 * capability routing needs to be able to tell them apart.
 */

/** Per-session variables an agent CLI exports to its own children. */
export const PARENT_SESSION_ENV = [
  // A live IPC channel and its bearer token, scoped to the parent session.
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  // Identity of the parent run. Inherited, these make a fresh worker present
  // itself as a continuation of whoever launched the daemon.
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_PID',
  // Describe the parent binary and its chosen effort, not this profile's.
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_EFFORT',
] as const;

/**
 * The absolute config directory this profile runs under, or null to inherit.
 *
 * `~` is expanded because the value is typed by a human in a settings field,
 * where `~/.claude` is the natural way to write it - and a literal `~`
 * directory is never what they meant.
 */
export function resolveConfigDir(settings: Readonly<Record<string, unknown>>): string | null {
  const raw = settings['configDir'];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw TandemiseError.validation('Runtime setting `configDir` must be a path.', { got: typeof raw });
  }

  const trimmed = raw.trim();
  const expanded = trimmed === '~' ? homedir()
    : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2))
    : trimmed;

  if (!isAbsolute(expanded)) {
    throw TandemiseError.validation(
      'Runtime setting `configDir` must be an absolute path or start with `~/`.',
      { configDir: trimmed },
    );
  }
  return normalize(expanded);
}

/**
 * What a Claude Code profile may configure.
 *
 * `configDir` is listed first because it is the setting that makes two profiles
 * two *workers* rather than two names for one account; model and permission
 * mode only shape a single run.
 */
export const CLAUDE_SETTINGS_SCHEMA: readonly RuntimeSettingField[] = [
  {
    key: 'configDir',
    label: 'Config directory',
    kind: 'text',
    placeholder: '~/.claude',
    hint: 'Sets CLAUDE_CONFIG_DIR for this profile: its login, settings and MCP servers. Leave blank to use whatever the daemon inherited.',
  },
  {
    key: 'model',
    label: 'Model',
    kind: 'text',
    placeholder: 'inherit the CLI default',
    hint: 'Passed as --model. An alias like `opus` or `haiku`, or a full model id. A role or workflow step can choose another model; this is the default.',
  },
  {
    key: 'userSettings',
    label: 'Your Claude settings',
    kind: 'select',
    options: [
      { value: '', label: 'Keep them out of workers' },
      { value: 'inherit', label: 'Let workers load them' },
    ],
    hint: 'Your personal hooks, plugins, skills and instructions. Kept out by default: they change how a worker behaves in ways its role never asked for, and some record what it does. The repository\u2019s own .claude settings always apply.',
  },
  {
    key: 'permissionMode',
    label: 'Permission mode',
    kind: 'select',
    options: [
      { value: '', label: 'Decide from the run\u2019s grants' },
      { value: 'default', label: 'default' },
      { value: 'plan', label: 'plan' },
      { value: 'acceptEdits', label: 'acceptEdits' },
      { value: 'bypassPermissions', label: 'bypassPermissions' },
    ],
    hint: 'Overrides what Tandemise would infer. The policy engine still gates every tool call regardless.',
  },
  {
    key: 'display',
    label: 'Display for agents',
    kind: 'select',
    options: [
      { value: '', label: 'None' },
      { value: 'virtual', label: 'A virtual display (xvfb-run, Linux)' },
      { value: 'host', label: 'This computer\u2019s display' },
    ],
    hint: 'Lets a step open the app it changed and prove a UI change on screen. A virtual display needs xvfb-run installed; this computer\u2019s display lets agents open windows you can see. Every run also gets its own empty TANDEMISE_HOME, never yours.',
  },
] as const;
