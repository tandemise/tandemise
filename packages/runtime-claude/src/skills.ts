import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SKILL_FILE, splitStepSkill } from '@tandemise/domain';
import type { SkillResolution } from '@tandemise/runtimes-core';
import { resolveConfigDir } from './settings.js';

/** A plugin install as Claude Code records it in `plugins/installed_plugins.json`. */
export interface InstalledPlugin {
  readonly name: string;
  readonly marketplace: string;
  readonly version: string;
  readonly installPath: string;
  readonly scope: string;
}

/**
 * The plugins Claude Code installed under a config folder (#129, #131), from
 * its own record (version 2: `{ plugins: { "name@marketplace": [{ scope,
 * installPath, version }] } }`). Installs sharing a folder are listed once; a
 * missing or malformed record is an empty list, and `onUnreadable` hears why
 * when the file exists but can't be read.
 */
export async function installedPlugins(configDir: string, onUnreadable?: (error: unknown) => void): Promise<readonly InstalledPlugin[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onUnreadable?.(e);
    return [];
  }
  const plugins = (raw as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== 'object' || plugins === null) return [];
  const out: InstalledPlugin[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(plugins).sort()) {
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : '';
    const installs = (plugins as Record<string, unknown>)[key];
    for (const install of Array.isArray(installs) ? installs : []) {
      const { installPath, version, scope } = (install ?? {}) as { installPath?: unknown; version?: unknown; scope?: unknown };
      if (typeof installPath !== 'string' || installPath === '' || seen.has(installPath)) continue;
      seen.add(installPath);
      out.push({
        name, marketplace, installPath,
        version: typeof version === 'string' ? version : '',
        scope: typeof scope === 'string' ? scope : 'user',
      });
    }
  }
  return out;
}

/** The config folder a profile's runs use: its own, else the one the daemon inherited, else ~/.claude. */
export function profileConfigDir(settings: Readonly<Record<string, unknown>>): string {
  return resolveConfigDir(settings) ?? (process.env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude'));
}

/**
 * Where a skill a step runs comes from for this profile (#131), read from the
 * same files Claude Code reads, or why it can't be run. Nothing is executed.
 *
 * - `plugin:skill`: the plugin must be installed in the profile's config
 *   folder with that skill (or command); the run loads that one plugin with
 *   `--plugin-dir`, so it works whether or not the person's own settings are
 *   let in.
 * - `skill`: the repository's own `.claude/skills/<skill>` (in one of
 *   `folders`), or the person's own `<config>/skills/<skill>` when the
 *   profile lets workers load their settings.
 */
export async function resolveClaudeSkill(
  settings: Readonly<Record<string, unknown>>, name: string, folders: readonly string[],
): Promise<SkillResolution> {
  const configDir = profileConfigDir(settings);
  const { plugin, skill } = splitStepSkill(name);
  if (plugin !== null) {
    const all = await installedPlugins(configDir);
    const installs = all.filter((p) => p.name === plugin);
    if (installs.length === 0) {
      const others = [...new Set(all.map((p) => p.name))];
      return {
        ok: false,
        reason: `The plugin ${plugin} isn't installed for this Claude Code profile (config folder ${configDir}), so /${name} can't run. `
          + `Install it with \`claude plugin install\` under that folder, or set the profile's Config directory to where it is installed.`
          + (others.length > 0 ? ` Installed there: ${others.join(', ')}.` : ''),
      };
    }
    for (const install of installs) {
      if (await isFile(join(install.installPath, 'skills', skill, SKILL_FILE)) || await isFile(join(install.installPath, 'commands', `${skill}.md`))) {
        return { ok: true, pluginDirs: [install.installPath], from: `plugin ${plugin} ${install.version} at ${install.installPath}`.replace(/\s+/g, ' ') };
      }
    }
    const has = await skillNames(join(installs[0]!.installPath, 'skills'));
    return {
      ok: false,
      reason: `The plugin ${plugin} ${installs[0]!.version} is installed but has no skill ${skill}`
        + (has.length > 0 ? `; it has ${has.join(', ')}.` : '.'),
    };
  }
  for (const folder of folders) {
    const path = join(folder, '.claude', 'skills', skill);
    if (await isFile(join(path, SKILL_FILE))) return { ok: true, pluginDirs: [], from: path };
  }
  const personal = join(configDir, 'skills', skill);
  if (await isFile(join(personal, SKILL_FILE))) {
    if (settings['userSettings'] === 'inherit') return { ok: true, pluginDirs: [], from: personal };
    return {
      ok: false,
      reason: `${skill} is one of your own skills (${personal}), and this profile keeps your Claude settings out of workers. `
        + 'Import it on the Skills screen and pin it to the step, or set the profile’s “Your Claude settings” to “Let workers load them”.',
    };
  }
  return {
    ok: false,
    reason: `There is no skill ${skill} in the repository's .claude/skills, in the step's pinned skills, or in your own skills (${join(configDir, 'skills')}). `
      + 'A plugin’s skill is written plugin:skill.',
  };
}

async function skillNames(root: string): Promise<string[]> {
  try {
    const out: string[] = [];
    for (const name of (await readdir(root)).sort()) if (await isFile(join(root, name, SKILL_FILE))) out.push(name);
    return out;
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
