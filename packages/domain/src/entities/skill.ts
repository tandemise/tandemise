import { createHash } from 'node:crypto';
import type { SkillId, SkillVersionId, Timestamp, WorkspaceId } from '@tandemise/shared';

/**
 * The skills library (P13): skills the person already has - folders with a
 * `SKILL.md` - imported by content hash, pinned to roles and workflow steps,
 * and handed to each run at exactly the version it was pinned to.
 *
 * Everything here is pure. Reading folders, cloning and the content store are
 * adapters (the daemon's `skill-files.ts`); the executor asks for pins and
 * content and records what each run received.
 */

/** A skill is refused above this many bytes in total. */
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;
/** A skill is refused above this many files. */
export const MAX_SKILL_FILES = 500;
/** The file that makes a folder a skill, at its top level. */
export const SKILL_FILE = 'SKILL.md';
/** Where a runtime that reads a skills folder finds them, relative to its working folder. */
export const SKILLS_FOLDER = '.claude/skills';
/** Shown in place of a hash. */
export const SHORT_HASH_LENGTH = 12;
/** Names never part of a skill's content (version control and Finder litter). */
export const SKILL_IGNORED_NAMES: readonly string[] = ['.git', '.DS_Store'];

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Where a skill came from. `claude` is a folder Claude Code keeps (#129): a
 * personal skill (~/.claude/skills), an installed plugin's skill (`plugin`
 * names the plugin, and the library calls it `<plugin>-<skill>`), or a skill
 * in one of the project's repositories (`.claude/skills`).
 */
export type SkillSource =
  | { readonly kind: 'claude'; readonly path: string; readonly plugin?: string }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'git'; readonly url: string; readonly subpath?: string; readonly ref?: string };

export interface SkillFileEntry {
  /** Relative POSIX path inside the skill folder. */
  readonly path: string;
  readonly size: number;
}

export interface SkillFile extends SkillFileEntry {
  readonly bytes: Uint8Array;
}

export interface Skill {
  readonly id: SkillId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description: string;
  /** The newest import's source. */
  readonly source: SkillSource;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface SkillVersion {
  readonly id: SkillVersionId;
  readonly skillId: SkillId;
  readonly version: number;
  readonly hash: string;
  readonly description: string;
  readonly files: readonly SkillFileEntry[];
  readonly sizeBytes: number;
  readonly source: SkillSource;
  readonly createdAt: Timestamp;
}

/** What a role pins: a skill by name at a version. */
export interface RoleSkill {
  readonly name: string;
  readonly version: number;
}

/** A pin resolved to content: what a task and a run refer to. */
export interface SkillPin {
  readonly name: string;
  readonly version: number;
  readonly hash: string;
  /** Where the pin came from; a step's pin wins over the role's of the same name. */
  readonly from?: 'role' | 'step';
}

/** What a run received, and how. */
export interface RunSkill {
  readonly name: string;
  readonly version: number;
  readonly hash: string;
  /** `folder`: written to `.claude/skills/<name>/`; `prompt`: its SKILL.md appended to the prompt. */
  readonly via: 'folder' | 'prompt';
}

/** A step's `skills:` entry: `tdd`, `tdd@2` or `tdd@latest`. */
export interface SkillRef {
  readonly name: string;
  readonly version: number | 'latest';
}

// ------------------------------------------------------------------ hashing

/**
 * The content hash of a skill: sha-256 over its files sorted by relative path,
 * each as `path \0 size \0 bytes \0`, after a fixed prefix. Only path, size and
 * bytes count - never modes or timestamps - so the same files copied anywhere
 * hash the same, and any change to a byte or a name changes it.
 */
export function hashSkillFiles(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): string {
  const hash = createHash('sha256');
  hash.update('tandemise-skill-v1\0');
  for (const file of [...files].sort((a, b) => comparePaths(a.path, b.path))) {
    hash.update(`${file.path}\0${file.bytes.byteLength}\0`);
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Byte order, not locale order: the hash must not depend on where it is computed. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function shortHash(hash: string): string {
  return hash.slice(0, SHORT_HASH_LENGTH);
}

// ------------------------------------------------------------ SKILL.md front matter

export interface SkillFrontMatter {
  readonly name: string | null;
  readonly description: string | null;
  /** The Markdown after the front matter. */
  readonly body: string;
}

/**
 * Reads `name` and `description` from a SKILL.md's front matter. A small,
 * forgiving reader of the subset skills use (plain, quoted, and folded or
 * literal block values); anything else in the front matter is ignored.
 */
export function parseSkillFrontMatter(text: string): SkillFrontMatter {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (match === null) return { name: null, description: null, body: normalized };
  const lines = match[1]!.split('\n');
  const values: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const key = kv[1]!;
    let value = kv[2]!.trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        block.push(lines[++i]!.trim());
      }
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
      try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    values[key] = value;
  }
  const name = values['name']?.trim();
  const description = values['description']?.trim();
  return {
    name: name === undefined || name === '' ? null : name,
    description: description === undefined || description === '' ? null : description,
    body: normalized.slice(match[0].length).replace(/^\n+/, ''),
  };
}

/**
 * The library name of a plugin's skill (#129): `<plugin>-<skill>`. Claude Code
 * calls it `plugin:skill`, but a library name becomes a folder name under
 * `.claude/skills`, where a colon is not portable, and the prefix keeps two
 * plugins' skills of the same name apart.
 */
export function pluginSkillName(plugin: string, skill: string): string {
  return `${plugin}-${skill}`;
}

/** Why a name cannot be a skill's name (it becomes a folder name), or null. */
export function skillNameProblem(name: string): string | null {
  return NAME.test(name)
    ? null
    : `The name “${name}” can't be a folder name. Use letters, digits, dots, dashes or underscores (up to 64).`;
}

// ------------------------------------------------------------------ refs and pins

/** Parses a step's `skills:` entry. Null when it is not a valid reference. */
export function parseSkillRef(text: string): SkillRef | null {
  const trimmed = text.trim();
  const at = trimmed.lastIndexOf('@');
  const name = at < 0 ? trimmed : trimmed.slice(0, at);
  const version = at < 0 ? 'latest' : trimmed.slice(at + 1);
  if (skillNameProblem(name) !== null) return null;
  if (version === 'latest') return { name, version: 'latest' };
  if (!/^[1-9]\d{0,5}$/.test(version)) return null;
  return { name, version: Number(version) };
}

export function formatSkillRef(ref: SkillRef): string {
  return `${ref.name}@${ref.version}`;
}

/** The library as pin resolution reads it: each skill's versions. */
export interface SkillCatalog {
  versionsOf(name: string): readonly { readonly version: number; readonly hash: string }[] | undefined;
}

export interface ResolvedPins {
  readonly pins: readonly SkillPin[];
  /** One line per ref that could not be resolved. */
  readonly problems: readonly string[];
}

/**
 * The pins a task gets: the step's refs and its role's pins, `latest` made
 * concrete now. A step's pin wins over the role's of the same name. Order: the
 * role's first, then the step's, each as written, so a prompt reads stably.
 */
export function resolveSkillPins(
  input: { readonly role: readonly RoleSkill[]; readonly step: readonly SkillRef[]; readonly stepKey?: string },
  catalog: SkillCatalog,
): ResolvedPins {
  const problems: string[] = [];
  const byName = new Map<string, SkillPin>();
  const resolve = (ref: SkillRef, from: 'role' | 'step'): void => {
    const versions = catalog.versionsOf(ref.name);
    const who = from === 'step' ? `Step '${input.stepKey ?? '?'}'` : 'Its role';
    if (versions === undefined || versions.length === 0) {
      problems.push(`${who} asks for skill '${ref.name}', which is not in this project's skills library.`);
      return;
    }
    const newest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    const chosen = ref.version === 'latest' ? newest : versions.find((v) => v.version === ref.version);
    if (chosen === undefined) {
      const numbers = versions.map((v) => v.version).sort((a, b) => a - b);
      const range = numbers.length === 1 ? `version ${numbers[0]}` : `versions ${numbers[0]}–${numbers[numbers.length - 1]}`;
      problems.push(`${who} asks for skill '${ref.name}' version ${ref.version}, but the library has ${range}.`);
      return;
    }
    // Deleting and adding keeps the step's pin in the step's position.
    byName.delete(ref.name);
    byName.set(ref.name, { name: ref.name, version: chosen.version, hash: chosen.hash, from });
  };
  for (const pin of input.role) resolve({ name: pin.name, version: pin.version }, 'role');
  for (const ref of input.step) resolve(ref, 'step');
  return { pins: [...byName.values()], problems };
}

/** A pin and a run's record of it are the same skill only when name, version and hash all match. */
export function samePin(a: { name: string; version: number; hash: string }, b: { name: string; version: number; hash: string }): boolean {
  return a.name === b.name && a.version === b.version && a.hash === b.hash;
}

/** `skills.loaded` / `skills.missing` for a task's pins against its newest run's record. */
export function skillFacts(pins: readonly SkillPin[], received: readonly RunSkill[] | null): { loaded: number; missing: number } {
  const got = received ?? [];
  return {
    loaded: got.length,
    missing: pins.filter((pin) => !got.some((r) => samePin(pin, r))).length,
  };
}

// ------------------------------------------------------------------ prompt and words

export interface PromptSkill {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly via: 'folder' | 'prompt';
  /** SKILL.md without its front matter; used only when `via` is `prompt`. */
  readonly body: string;
  /** Every other file of the skill, by path. */
  readonly otherFiles: readonly string[];
}

export const SKILLS_PROMPT_HEADING = '## Skills pinned to this step';
/**
 * The most of one SKILL.md a prompt carries. A skill may be 5 MB; a prompt
 * that size would crowd out the task itself, so a longer body is cut, saying
 * so, and the run still records that it was given the skill.
 */
export const MAX_PROMPT_SKILL_CHARS = 40_000;

/**
 * The prompt section that tells a run about its skills. A skill delivered as a
 * folder gets one line (the runtime loads it itself); one delivered through the
 * prompt gets its SKILL.md in full under its own heading.
 */
export function skillPromptSection(skills: readonly PromptSkill[]): string | null {
  if (skills.length === 0) return null;
  const lines: string[] = [
    SKILLS_PROMPT_HEADING,
    '',
    'The person pinned these skills to this step. Use them where they apply.',
    '',
  ];
  const inFolder = skills.filter((s) => s.via === 'folder');
  for (const s of inFolder) {
    lines.push(`- Installed in ${SKILLS_FOLDER}/${s.name} (v${s.version})${s.description ? `: ${s.description}` : ''}`);
  }
  if (inFolder.length > 0) lines.push('');
  for (const s of skills.filter((x) => x.via === 'prompt')) {
    lines.push(`### Skill: ${s.name} (v${s.version})`, '');
    if (s.description) lines.push(`${s.description}`, '');
    const body = s.body.trim();
    lines.push(body.length <= MAX_PROMPT_SKILL_CHARS
      ? body
      : `${body.slice(0, MAX_PROMPT_SKILL_CHARS)}\n\n(This SKILL.md is ${body.length.toLocaleString('en-US')} characters; the first ${MAX_PROMPT_SKILL_CHARS.toLocaleString('en-US')} are shown.)`, '');
    if (s.otherFiles.length > 0) lines.push(`Other files in this skill (not shown): ${s.otherFiles.join(', ')}`, '');
  }
  return lines.join('\n').trimEnd();
}

/** "tdd v1 · a1b2c3d4e5f6" */
export function skillPinLabel(pin: { name: string; version: number; hash: string }): string {
  return `${pin.name} v${pin.version} · ${shortHash(pin.hash)}`;
}

/** The named reason a run is refused for missing skill content. */
export function missingSkillReason(missing: readonly SkillPin[]): string {
  const names = missing.map((p) => `'${p.name}' v${p.version} (${shortHash(p.hash)})`);
  const subject = names.length === 1 ? `Skill ${names[0]} is` : `Skills ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are`;
  return `${subject} missing from the skills library. Import ${names.length === 1 ? 'it' : 'them'} again on the Skills screen, then choose Retry.`;
}

/** "4.2 KB" */
export function formatSkillSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Normalises a stored role skill list: valid names, positive versions, one per name. */
export function normalizeRoleSkills(value: unknown): RoleSkill[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: RoleSkill[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, version } = item as { name?: unknown; version?: unknown };
    if (typeof name !== 'string' || skillNameProblem(name) !== null || seen.has(name)) continue;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) continue;
    seen.add(name);
    out.push({ name, version });
  }
  return out;
}
