import type {
  PlannedTask, RepoRepositoryPort, RoleRepositoryPort, RoleSkill, RoleTemplate, Skill, SkillCatalog, SkillFile, SkillPin, SkillRepositoryPort,
  SkillSource, SkillVersion,
} from '@tandemise/domain';
import {
  SKILL_FILE, formatSkillSize, hashSkillFiles, parseSkillFrontMatter, pluginSkillName, resolveSkillPins, shortHash, skillNameProblem,
} from '@tandemise/domain';
import type {
  DiscoveredSkillOriginView, DiscoveredSkillView, DiscoveredSkillsView, ImportSkillRequest, SkillImportView, SkillLibraryView, SkillPreviewView,
  SkillSourceRequest, SkillSourceStatus, SkillVersionDetailView, SkillVersionView, SkillView,
} from '@tandemise/api-contract';
import type { Clock, Logger, SkillId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId, ids, isPathInside } from '@tandemise/shared';
import type { DiscoveredSkillFolder, ScannedSkillFolder, SkillFilesPort } from '../ports.js';

export interface SkillDeps {
  /** A linked brain hears of each edit so it can write it through (#51). */
  readonly factoryEdits?: { edited(workspaceId: WorkspaceId, what: string): void };
  readonly skills: SkillRepositoryPort;
  readonly roles: RoleRepositoryPort;
  /** The project's repositories, whose `.claude/skills` discovery reads (#129). Optional for older harnesses. */
  readonly repositories?: Pick<RepoRepositoryPort, 'listByWorkspace'>;
  readonly files: SkillFilesPort;
  readonly clock: Clock;
  readonly log: Logger;
}

/** A folder read and judged: what a preview shows and an import stores. */
interface Judged {
  readonly source: SkillSource;
  readonly scan: ScannedSkillFolder;
  readonly name: string | null;
  readonly description: string;
  readonly hash: string | null;
  readonly skillMd: string | null;
  readonly problem: string | null;
}

/** Previews kept so an import stores exactly the bytes the person saw. */
const PREVIEW_CACHE_SIZE = 16;

/**
 * The skills library (P13): import, versions, updates, deletion, and the pins
 * a task gets.
 *
 * Everything a person imports is read as bytes and stored by content hash;
 * nothing is executed. An import names the hash its preview showed and is
 * refused when the folder no longer has it, so what lands in the library is
 * exactly what was looked at.
 */
export class SkillService {
  readonly #previews = new Map<string, Judged>();

  constructor(private readonly deps: SkillDeps) {}

  // ------------------------------------------------------------------ reading

  async list(workspaceId: WorkspaceId): Promise<SkillLibraryView> {
    const roles = this.deps.roles.list(workspaceId);
    const skills: SkillView[] = [];
    for (const skill of this.deps.skills.list(workspaceId)) {
      skills.push(await this.#view(skill, roles, true));
    }
    return { skills, discoverRoot: this.deps.files.discoverRoot() };
  }

  async discover(workspaceId: WorkspaceId): Promise<DiscoveredSkillsView> {
    const { exists, folders } = await this.deps.files.discover(this.#repositories(workspaceId));
    const found: DiscoveredSkillView[] = [];
    const origins = new Map<string, DiscoveredSkillOriginView>();
    for (const entry of folders) {
      const origin = originOf(entry);
      if (!origins.has(origin.id)) origins.set(origin.id, origin);
      const judged = this.#judge(sourceOf(entry), await this.deps.files.scan(entry.path));
      const existing = judged.name === null ? undefined : this.deps.skills.getByName(workspaceId, judged.name);
      const versions = existing === undefined ? [] : this.deps.skills.versions(existing.id);
      const same = judged.hash === null ? undefined : versions.find((v) => v.hash === judged.hash);
      const newest = versions.at(-1);
      const folder = entry.path.split('/').pop() ?? entry.path;
      found.push({
        folder: entry.group === null ? folder : `${entry.group}/${folder}`,
        path: entry.path,
        originId: origin.id,
        // Claude Code loads only top-level skill folders, and names a plugin's `plugin:skill`.
        invocation: entry.group !== null ? null : entry.plugin === undefined ? folder : `${entry.plugin.name}:${folder}`,
        name: judged.name,
        description: judged.description,
        hash: judged.hash,
        sizeLabel: formatSkillSize(judged.scan.sizeBytes),
        fileCount: judged.scan.files.length,
        problem: judged.problem,
        libraryLabel: existing === undefined || newest === undefined
          ? null
          : same !== undefined
            ? `In library as ${existing.name} v${same.version}`
            : `Newer than ${existing.name} v${newest.version} in the library`,
        importable: judged.problem === null && same === undefined,
      });
    }
    return { root: this.deps.files.discoverRoot(), exists, origins: [...origins.values()], skills: found };
  }

  async preview(workspaceId: WorkspaceId, source: SkillSourceRequest): Promise<SkillPreviewView> {
    const judged = await this.#read(await this.#source(workspaceId, source));
    if (judged.hash !== null && judged.problem === null) this.#remember(judged);
    return this.#previewView(workspaceId, judged);
  }

  async version(skillId: SkillId, version: number): Promise<SkillVersionDetailView> {
    const skill = this.#require(skillId);
    const found = this.deps.skills.versions(skill.id).find((v) => v.version === version);
    if (found === undefined) throw TandemiseError.notFound('Skill version', `${skill.name} v${version}`);
    const files = await this.deps.files.read(found.hash);
    const md = files?.find((f) => f.path === SKILL_FILE);
    return {
      ...versionView(found),
      skillId: skill.id,
      name: skill.name,
      skillMd: md === undefined ? null : new TextDecoder().decode(md.bytes),
    };
  }

  // ------------------------------------------------------------------ writing

  async import(workspaceId: WorkspaceId, request: ImportSkillRequest): Promise<SkillImportView> {
    const source = await this.#source(workspaceId, request.source);
    const cached = this.#previews.get(request.hash);
    const judged = cached !== undefined && sameSource(cached.source, source) ? cached : await this.#read(source);
    if (judged.problem !== null) throw TandemiseError.validation(judged.problem, { source });
    if (judged.hash !== request.hash) {
      throw new TandemiseError('CONFLICT', 'The folder changed since you previewed it. Preview it again.', {
        details: { expected: request.hash, found: judged.hash },
      });
    }
    return this.#commit(workspaceId, judged);
  }

  /** Re-imports a skill from its recorded source. Only ever on request. */
  async update(skillId: SkillId): Promise<SkillImportView> {
    const skill = this.#require(skillId);
    const judged = await this.#read(skill.source);
    if (judged.problem !== null) throw TandemiseError.validation(`${skill.name} cannot be updated: ${judged.problem}`, { skillId });
    if (judged.name !== skill.name) {
      throw TandemiseError.validation(
        `The source now names its skill '${judged.name ?? '?'}', not '${skill.name}'. Import it as a new skill instead.`,
        { skillId },
      );
    }
    return this.#commit(skill.workspaceId, judged);
  }

  /** Deletes a skill no role pins. Tasks that pinned it refuse with a named reason when they run. */
  async remove(skillId: SkillId): Promise<void> {
    const skill = this.#require(skillId);
    const users = this.#usedBy(skill, this.deps.roles.list(skill.workspaceId));
    if (users.length > 0) {
      const names = users.map((u) => u.roleName);
      throw new TandemiseError('CONFLICT', `Used by ${names.join(', ')}. Detach it in Team → Roles first.`, {
        details: { skillId, roles: users.map((u) => u.roleId) },
      });
    }
    const hashes = [...new Set(this.deps.skills.versions(skill.id).map((v) => v.hash))];
    this.deps.skills.remove(skill.id);
    // Content is shared by every project: only what nobody names any more goes.
    for (const hash of hashes) {
      if (!this.deps.skills.hashInUse(hash)) await this.deps.files.drop(hash);
    }
    this.deps.log.info('skills.removed', { skillId, name: skill.name });
    this.deps.factoryEdits?.edited(skill.workspaceId, `remove the skill ${skill.name}`);
  }

  // ------------------------------------------------------------------ pins

  /** Refuses role pins that name a skill or version the library does not have. */
  validateRoleSkills(workspaceId: WorkspaceId, pins: readonly RoleSkill[]): void {
    const { problems } = resolveSkillPins({ role: pins, step: [] }, this.catalog(workspaceId));
    if (problems.length > 0) {
      throw TandemiseError.validation(problems.map((p) => p.replace(/^Its role asks for/, 'The role asks for')).join(' '), { skills: pins });
    }
  }

  catalog(workspaceId: WorkspaceId): SkillCatalog {
    return {
      versionsOf: (name) => {
        const skill = this.deps.skills.getByName(workspaceId, name);
        return skill === undefined ? undefined : this.deps.skills.versions(skill.id).map((v) => ({ version: v.version, hash: v.hash }));
      },
    };
  }

  /** The pins a task gets from its role and its step; `latest` is made concrete now. */
  pinsFor(workspaceId: WorkspaceId, role: RoleTemplate | undefined, step: Pick<PlannedTask, 'key' | 'skillRefs'>): { pins: readonly SkillPin[]; problems: readonly string[] } {
    return resolveSkillPins(
      { role: role?.skills ?? [], step: step.skillRefs ?? [], stepKey: step.key },
      this.catalog(workspaceId),
    );
  }

  /** Pins whose content is not in the store (or no longer hashes to its pin). */
  async missing(pins: readonly SkillPin[]): Promise<readonly SkillPin[]> {
    const out: SkillPin[] = [];
    for (const pin of pins) {
      if ((await this.deps.files.read(pin.hash)) === null) out.push(pin);
    }
    return out;
  }

  /** A pin's content, verified; null when it is missing. */
  content(hash: string): Promise<readonly SkillFile[] | null> {
    return this.deps.files.read(hash);
  }

  // ------------------------------------------------------- setup as code (P15)

  /** Every version in the project's library, oldest first per skill, with where it came from. */
  library(workspaceId: WorkspaceId): readonly { name: string; version: number; hash: string; source: SkillSource }[] {
    return this.deps.skills.list(workspaceId).flatMap((skill) =>
      this.deps.skills.versions(skill.id).map((v) => ({ name: skill.name, version: v.version, hash: v.hash, source: v.source })));
  }

  /** The library's version of `name` holding exactly these files, if any. */
  versionFor(workspaceId: WorkspaceId, name: string, hash: string): number | undefined {
    const skill = this.deps.skills.getByName(workspaceId, name);
    return skill === undefined ? undefined : this.deps.skills.versions(skill.id).find((v) => v.hash === hash)?.version;
  }

  /**
   * Adds files already in this machine's store (another project imported
   * them) to this project's library, recording the source they came from.
   * Synchronous so it can run inside an import's transaction; the files are
   * read, and verified against their hash, beforehand with `content`.
   */
  adoptStored(workspaceId: WorkspaceId, entry: { name: string; hash: string; source: SkillSource }, files: readonly SkillFile[]): number {
    if (hashSkillFiles(files) !== entry.hash) throw TandemiseError.validation(`The stored files of ${entry.name} no longer match their hash.`, { hash: entry.hash });
    const judged = this.#judge(entry.source, {
      folder: entry.hash,
      files: [...files],
      sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
      problem: null,
    });
    if (judged.problem !== null) throw TandemiseError.validation(`${entry.name} cannot be added: ${judged.problem}`, { hash: entry.hash });
    // The name the files were pinned under wins over the folder the store keeps them in.
    return this.#record(workspaceId, { ...judged, name: entry.name }).version;
  }

  // ------------------------------------------------------------------ internals

  #require(id: SkillId): Skill {
    const skill = this.deps.skills.get(asId<'SkillId'>(id));
    if (skill === undefined) throw TandemiseError.notFound('Skill', id);
    return skill;
  }

  async #source(workspaceId: WorkspaceId, request: SkillSourceRequest): Promise<SkillSource> {
    if (request.kind === 'git') {
      const subpath = request.subpath?.trim().replace(/^\/+|\/+$/g, '') ?? '';
      if (subpath.split('/').some((part) => part === '..')) throw TandemiseError.validation('The subfolder must stay inside the repository.', { subpath });
      return {
        kind: 'git', url: request.url.trim(),
        ...(subpath === '' ? {} : { subpath }),
        ...(request.ref === undefined || request.ref.trim() === '' ? {} : { ref: request.ref.trim() }),
      };
    }
    const path = request.path.trim();
    if (!path.startsWith('/')) throw TandemiseError.validation('Give the folder as a full path, starting with /.', { path });
    if (request.kind === 'path') return { kind: 'path', path };
    // A Claude skill is one discovery lists (#129): personal, a plugin's, or a repository's.
    const found = (await this.deps.files.discover(this.#repositories(workspaceId))).folders.find((f) => f.path === path);
    if (found !== undefined) return sourceOf(found);
    if (isPathInside(this.deps.files.discoverRoot(), path)) return { kind: 'claude', path };
    throw TandemiseError.validation(`That folder is not one of the Claude skills found on this computer or in this project (${this.deps.files.discoverRoot()}).`, { path });
  }

  #repositories(workspaceId: WorkspaceId): readonly { name: string; path: string }[] {
    return (this.deps.repositories?.listByWorkspace(workspaceId) ?? []).map((r) => ({ name: r.name, path: r.path }));
  }

  async #read(source: SkillSource): Promise<Judged> {
    if (source.kind !== 'git') return this.#judge(source, await this.deps.files.scan(source.path));
    let fetched: { folder: string; dispose(): Promise<void> };
    try {
      fetched = await this.deps.files.fetchGit(source);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.#judge(source, { folder: source.url, files: [], sizeBytes: 0, problem: `The repository could not be cloned: ${message}` });
    }
    try {
      return this.#judge(source, await this.deps.files.scan(fetched.folder));
    } finally {
      await fetched.dispose();
    }
  }

  /** Applies the rules that need the content: name and hash. The adapter already applied the file rules. */
  #judge(source: SkillSource, scan: ScannedSkillFolder): Judged {
    const md = scan.files.find((f) => f.path === SKILL_FILE);
    const skillMd = md === undefined ? null : new TextDecoder().decode(md.bytes);
    const front = skillMd === null ? null : parseSkillFrontMatter(skillMd);
    const folderName = (source.kind === 'git' ? (source.subpath ?? source.url.replace(/\.git$/, '')) : source.path)
      .replace(/\/+$/, '').split('/').pop() ?? '';
    // A plugin's skill is `<plugin>-<folder>` in the library, as Claude Code names it `plugin:folder` (#129).
    const name = source.kind === 'claude' && source.plugin !== undefined && folderName !== ''
      ? pluginSkillName(source.plugin, folderName)
      : front?.name ?? (folderName === '' ? null : folderName);
    const nameProblem = scan.problem === null && name !== null ? skillNameProblem(name) : null;
    const problem = scan.problem ?? nameProblem;
    return {
      source,
      scan,
      name: nameProblem === null ? name : null,
      description: front?.description ?? '',
      hash: scan.problem === null ? hashSkillFiles(scan.files) : null,
      skillMd,
      problem,
    };
  }

  #remember(judged: Judged): void {
    this.#previews.delete(judged.hash!);
    this.#previews.set(judged.hash!, judged);
    while (this.#previews.size > PREVIEW_CACHE_SIZE) this.#previews.delete(this.#previews.keys().next().value!);
  }

  #previewView(workspaceId: WorkspaceId, judged: Judged): SkillPreviewView {
    const existing = judged.name === null ? undefined : this.deps.skills.getByName(workspaceId, judged.name);
    const versions = existing === undefined ? [] : this.deps.skills.versions(existing.id);
    const same = versions.find((v) => v.hash === judged.hash);
    const outcome = judged.problem !== null
      ? 'Cannot be imported'
      : existing === undefined
        ? 'New skill'
        : same !== undefined
          ? `Already in the library as ${existing.name} v${same.version}`
          : `New version v${(versions.at(-1)?.version ?? 0) + 1} of ${existing.name}`;
    return {
      source: judged.source,
      sourceLabel: sourceLabel(judged.source),
      name: judged.name,
      description: judged.description,
      hash: judged.hash,
      shortHash: judged.hash === null ? null : shortHash(judged.hash),
      files: judged.scan.files.map((f) => ({ path: f.path, size: f.size })),
      sizeBytes: judged.scan.sizeBytes,
      sizeLabel: filesLabel(judged.scan.files.length, judged.scan.sizeBytes),
      skillMd: judged.skillMd,
      problem: judged.problem,
      outcome,
      changes: judged.problem === null && same === undefined,
    };
  }

  async #commit(workspaceId: WorkspaceId, judged: Judged): Promise<SkillImportView> {
    // Content first: a version row must never name a hash the store lacks.
    await this.deps.files.store(judged.hash!, judged.scan.files);
    const recorded = this.#record(workspaceId, judged);
    if (recorded.created !== 'unchanged') this.deps.factoryEdits?.edited(workspaceId, `add the skill ${recorded.skill.name}`);
    const skill = await this.#view(recorded.skill, this.deps.roles.list(workspaceId), false);
    if (recorded.created === 'unchanged') {
      return { skill, version: recorded.version, created: 'unchanged', message: `${recorded.skill.name} v${recorded.version} already has these files.` };
    }
    return { skill, version: recorded.version, created: recorded.created, message: `Imported ${recorded.skill.name} v${recorded.version}.` };
  }

  /** The rows for files already in the store: a new skill, a new version, or nothing new. */
  #record(workspaceId: WorkspaceId, judged: Judged): { skill: Skill; version: number; created: SkillImportView['created'] } {
    const name = judged.name!;
    const hash = judged.hash!;
    const now = this.deps.clock.now();
    let skill = this.deps.skills.getByName(workspaceId, name);
    let created: SkillImportView['created'];
    let version: number;
    if (skill === undefined) {
      skill = this.deps.skills.create({
        id: ids.skill(), workspaceId, name, description: judged.description, source: judged.source, createdAt: now, updatedAt: now,
      });
      created = 'skill';
      version = 1;
    } else {
      const versions = this.deps.skills.versions(skill.id);
      const same = versions.find((v) => v.hash === hash);
      if (same !== undefined) {
        // Nothing new, but the place it came from is now this one.
        skill = this.deps.skills.update(skill.id, { source: judged.source, updatedAt: now });
        return { skill, version: same.version, created: 'unchanged' };
      }
      version = (versions.at(-1)?.version ?? 0) + 1;
      skill = this.deps.skills.update(skill.id, { description: judged.description, source: judged.source, updatedAt: now });
      created = 'version';
    }
    this.deps.skills.addVersion({
      id: ids.skillVersion(),
      skillId: skill.id,
      version,
      hash,
      description: judged.description,
      files: judged.scan.files.map((f) => ({ path: f.path, size: f.size })),
      sizeBytes: judged.scan.sizeBytes,
      source: judged.source,
      createdAt: now,
    });
    this.deps.log.info('skills.imported', { skillId: skill.id, name, version, hash });
    return { skill, version, created };
  }

  async #view(skill: Skill, roles: readonly RoleTemplate[], checkSource: boolean): Promise<SkillView> {
    const versions = this.deps.skills.versions(skill.id);
    const views = versions.map(versionView).reverse();
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      sourceLabel: sourceLabel(skill.source),
      sourceStatus: checkSource ? await this.#sourceStatus(skill, versions) : 'unchecked',
      latest: views[0]!,
      versions: views,
      usedBy: this.#usedBy(skill, roles),
    };
  }

  /** Local sources are re-read on every look; a git source only when Update is clicked (no network on a list). */
  async #sourceStatus(skill: Skill, versions: readonly SkillVersion[]): Promise<SkillSourceStatus> {
    if (skill.source.kind === 'git') return 'unchecked';
    try {
      const judged = this.#judge(skill.source, await this.deps.files.scan(skill.source.path));
      if (judged.scan.files.length === 0 && judged.problem !== null) return 'missing';
      if (judged.hash === null) return 'missing';
      return judged.hash === versions.at(-1)?.hash ? 'current' : 'update_available';
    } catch (e) {
      this.deps.log.warn('skills.source_check_failed', { skillId: skill.id, error: e instanceof Error ? e.message : String(e) });
      return 'missing';
    }
  }

  #usedBy(skill: Skill, roles: readonly RoleTemplate[]): SkillView['usedBy'] {
    return roles.flatMap((role) => (role.skills ?? [])
      .filter((pin) => pin.name === skill.name)
      .map((pin) => ({ roleId: role.id, roleName: role.name, version: pin.version })));
  }
}

function versionView(v: SkillVersion): SkillVersionView {
  return {
    version: v.version,
    hash: v.hash,
    shortHash: shortHash(v.hash),
    description: v.description,
    files: v.files,
    sizeBytes: v.sizeBytes,
    sizeLabel: filesLabel(v.files.length, v.sizeBytes),
    importedAt: v.createdAt,
  };
}

function filesLabel(count: number, bytes: number): string {
  return `${count} file${count === 1 ? '' : 's'} · ${formatSkillSize(bytes)}`;
}

export function sourceLabel(source: SkillSource): string {
  if (source.kind === 'git') return [source.url, source.subpath, source.ref === undefined ? undefined : `@${source.ref}`].filter(Boolean).join(' · ');
  return source.kind === 'claude' && source.plugin !== undefined ? `Plugin ${source.plugin} · ${source.path}` : source.path;
}

function sourceOf(entry: DiscoveredSkillFolder): SkillSource {
  return entry.plugin === undefined ? { kind: 'claude', path: entry.path } : { kind: 'claude', path: entry.path, plugin: entry.plugin.name };
}

/** The heading a discovered skill is listed under (#129). */
function originOf(entry: DiscoveredSkillFolder): DiscoveredSkillOriginView {
  if (entry.origin === 'plugin' && entry.plugin !== undefined) {
    const { name, marketplace, version } = entry.plugin;
    return { id: `plugin:${name}@${marketplace}`, kind: 'plugin', label: `Plugin ${name} ${version}`, detail: marketplace, root: entry.root };
  }
  if (entry.origin === 'project') {
    return { id: `project:${entry.root}`, kind: 'project', label: `Repository ${entry.repository ?? ''}`.trim(), detail: null, root: entry.root };
  }
  return { id: `personal:${entry.root}`, kind: 'personal', label: 'Your skills', detail: null, root: entry.root };
}

function sameSource(a: SkillSource, b: SkillSource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
