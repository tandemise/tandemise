import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SkillFile } from '@tandemise/domain';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, SKILL_FILE, SKILL_IGNORED_NAMES, formatSkillSize, hashSkillFiles } from '@tandemise/domain';
import type { DiscoveredSkillFolder, ScannedSkillFolder, SkillFilesPort } from '@tandemise/application';
import { errorMessage, isPathInside, type Logger } from '@tandemise/shared';
import { installedPlugins } from '@tandemise/runtime-claude';

const run = promisify(execFile);

/** A clone that takes longer than this is abandoned. */
const CLONE_TIMEOUT_MS = 60_000;
/** Folder for the ones that don't exist, "missing" reads better than an ENOENT. */
const NOT_A_FOLDER = 'This folder does not exist or cannot be read.';

class Refused extends Error {}

/**
 * The skills' side of the filesystem (P13): reading the person's folders under
 * the skill rules, cloning a repository, and the content store.
 *
 * Every file is read as bytes and nothing is ever executed. A clone runs git
 * with hooks pointed at /dev/null, no submodules, no tags, no terminal prompt
 * and LFS smudging off, into a temporary folder that is removed afterwards.
 *
 * The store is `<home>/skills/<hash>/…`, shared by every project: identical
 * files are kept once. Content is written to a temporary folder and renamed
 * into place, so a half-written version never exists under its hash; a read
 * re-hashes the files and treats a mismatch as missing.
 */
export class DaemonSkillFiles implements SkillFilesPort {
  constructor(
    private readonly storeRoot: string,
    private readonly root: string,
    private readonly log: Logger,
    /** The Claude config folder whose `plugins/installed_plugins.json` lists the plugins (#129). */
    private readonly claudeConfigDir: string = dirname(root),
  ) {}

  discoverRoot(): string {
    return this.root;
  }

  /**
   * Every skill folder Claude Code keeps (#129), in the order the Skills
   * screen lists them: your own, each installed plugin's, each repository's.
   * Only names are read here; `scan` reads a folder's files.
   */
  async discover(repositories: readonly { name: string; path: string }[] = []): Promise<{ exists: boolean; folders: readonly DiscoveredSkillFolder[] }> {
    const personal = await skillFolders(this.root);
    const folders: DiscoveredSkillFolder[] = personal.folders.map((f) => ({ ...f, origin: 'personal', root: this.root }));
    // Claude Code's own record of what it installed; an unreadable one lists none.
    for (const plugin of await installedPlugins(this.claudeConfigDir, (e) => this.log.warn('skills.plugins_unreadable', { error: errorMessage(e) }))) {
      const skillsRoot = join(plugin.installPath, 'skills');
      for (const f of (await skillFolders(skillsRoot)).folders) {
        folders.push({ ...f, origin: 'plugin', root: skillsRoot, plugin: { name: plugin.name, marketplace: plugin.marketplace, version: plugin.version } });
      }
    }
    for (const repo of repositories) {
      const skillsRoot = join(repo.path, '.claude', 'skills');
      for (const f of (await skillFolders(skillsRoot)).folders) {
        folders.push({ ...f, origin: 'project', root: skillsRoot, repository: repo.name });
      }
    }
    return { exists: personal.exists, folders };
  }

  async scan(folder: string): Promise<ScannedSkillFolder> {
    let root: string;
    try {
      root = await realpath(folder);
      if (!(await stat(root)).isDirectory()) return refused(folder, NOT_A_FOLDER);
    } catch {
      return refused(folder, NOT_A_FOLDER);
    }
    const files: SkillFile[] = [];
    let size = 0;
    const visited = new Set<string>([root]);

    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        if (SKILL_IGNORED_NAMES.includes(name)) continue;
        const path = join(dir, name);
        const rel = prefix === '' ? name : `${prefix}/${name}`;
        const info = await lstat(path);
        let real = path;
        if (info.isSymbolicLink()) {
          try {
            real = await realpath(path);
          } catch {
            throw new Refused(`${rel} is a link to something that does not exist.`);
          }
          if (!isPathInside(root, real)) throw new Refused(`${rel} links outside the skill folder (to ${real}).`);
        }
        const target = info.isSymbolicLink() ? await stat(real) : info;
        if (target.isDirectory()) {
          // A link back up the tree would loop forever.
          if (visited.has(real)) continue;
          visited.add(real);
          await walk(real, rel);
          continue;
        }
        if (!target.isFile()) continue;
        if (files.length + 1 > MAX_SKILL_FILES) throw new Refused(`This skill has more than ${MAX_SKILL_FILES} files; the limit is ${MAX_SKILL_FILES}.`);
        size += target.size;
        if (size > MAX_SKILL_BYTES) {
          throw new Refused(`This skill is over ${formatSkillSize(MAX_SKILL_BYTES)}; the limit is ${formatSkillSize(MAX_SKILL_BYTES)}.`);
        }
        const bytes = new Uint8Array(await readFile(real));
        files.push({ path: rel, size: bytes.byteLength, bytes });
      }
    };

    try {
      await walk(root, '');
    } catch (e) {
      if (e instanceof Refused) return { folder, files: [], sizeBytes: size, problem: e.message };
      return refused(folder, `This folder could not be read: ${errorMessage(e)}`);
    }
    if (!files.some((f) => f.path === SKILL_FILE)) {
      return { folder, files, sizeBytes: size, problem: 'No SKILL.md in this folder. A skill is a folder with a SKILL.md at its top.' };
    }
    return { folder, files, sizeBytes: size, problem: null };
  }

  async fetchGit(source: { url: string; subpath?: string; ref?: string }): Promise<{ folder: string; dispose(): Promise<void> }> {
    if (!/^(https?:\/\/|ssh:\/\/|git@[^:]+:|file:\/\/|\/)/.test(source.url)) {
      throw new Error('Use an https://, ssh://, git@host: or file:// address.');
    }
    const dir = await mkdtemp(join(tmpdir(), 'tandemise-skill-'));
    const dispose = async (): Promise<void> => { await rm(dir, { recursive: true, force: true }); };
    try {
      await run('git', [
        '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always',
        'clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules',
        ...(source.ref === undefined ? [] : ['--branch', source.ref]),
        '--', source.url, join(dir, 'repo'),
      ], {
        timeout: CLONE_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ASKPASS: 'echo' },
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      await dispose();
      const stderr = (e as { stderr?: string }).stderr?.trim().split('\n').pop();
      throw new Error(stderr && stderr.length > 0 ? stderr : errorMessage(e));
    }
    const repo = join(dir, 'repo');
    const folder = source.subpath === undefined || source.subpath === '' ? repo : join(repo, source.subpath);
    if (!isPathInside(repo, folder)) {
      await dispose();
      throw new Error('The subfolder must stay inside the repository.');
    }
    return { folder, dispose };
  }

  async store(hash: string, files: readonly SkillFile[]): Promise<void> {
    const final = this.#dir(hash);
    if (await exists(final)) return;
    await mkdir(this.storeRoot, { recursive: true });
    const staging = await mkdtemp(join(this.storeRoot, `.incoming-${hash.slice(0, 8)}-`));
    try {
      for (const file of files) {
        const path = join(staging, ...file.path.split('/'));
        if (!isPathInside(staging, path)) throw new Error(`Refusing to store ${file.path}.`);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      try {
        await rename(staging, final);
      } catch (e) {
        // Another import stored the same content first: that copy is identical.
        if (!(await exists(final))) throw e;
        await rm(staging, { recursive: true, force: true });
      }
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  }

  async read(hash: string): Promise<readonly SkillFile[] | null> {
    const dir = this.#dir(hash);
    if (!(await exists(dir))) return null;
    const files: SkillFile[] = [];
    const walk = async (current: string): Promise<void> => {
      for (const name of (await readdir(current)).sort()) {
        const path = join(current, name);
        const info = await lstat(path);
        if (info.isDirectory()) { await walk(path); continue; }
        if (!info.isFile()) continue;
        const bytes = new Uint8Array(await readFile(path));
        files.push({ path: relative(dir, path).split(sep).join('/'), size: bytes.byteLength, bytes });
      }
    };
    try {
      await walk(dir);
    } catch (e) {
      this.log.warn('skills.read_failed', { hash, error: errorMessage(e) });
      return null;
    }
    if (hashSkillFiles(files) !== hash) {
      this.log.warn('skills.content_changed', { hash });
      return null;
    }
    return files;
  }

  async drop(hash: string): Promise<void> {
    await rm(this.#dir(hash), { recursive: true, force: true });
  }

  #dir(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Not a skill content hash.');
    return join(this.storeRoot, hash);
  }
}

/**
 * The skill folders under one root, sorted. A folder with a SKILL.md is a
 * skill. A folder without one whose sub-folders have one groups skills: each
 * of those is listed with the group's name (one level only, #129). A folder
 * with neither is listed as itself, so `scan` can say why it isn't a skill.
 */
async function skillFolders(root: string): Promise<{ exists: boolean; folders: { path: string; group: string | null }[] }> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { exists: false, folders: [] };
  }
  const folders: { path: string; group: string | null }[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    // A linked skill folder (a common way to share one) counts, wherever it points.
    if (!(await isFolder(path))) continue;
    if (await isFile(join(path, SKILL_FILE))) {
      folders.push({ path, group: null });
      continue;
    }
    const inner: { path: string; group: string | null }[] = [];
    let children: string[] = [];
    try {
      children = await readdir(path);
    } catch {
      // Unreadable: listed as itself, and the scan says so.
    }
    for (const child of children.sort()) {
      if (child.startsWith('.')) continue;
      const sub = join(path, child);
      if (await isFolder(sub) && await isFile(join(sub, SKILL_FILE))) inner.push({ path: sub, group: name });
    }
    folders.push(...(inner.length > 0 ? inner : [{ path, group: null }]));
  }
  return { exists: true, folders };
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // A dangling link is not a skill.
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function refused(folder: string, problem: string): ScannedSkillFolder {
  return { folder, files: [], sizeBytes: 0, problem };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
