import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import type {
  AutonomySettings, IsolationMode, Limit, MissionPriority, RoutineKind, RoutineSchedule, SkillSource, WorkspaceKnowledge,
} from '@tandemise/domain';
import {
  ARTIFACT_TYPES, ISOLATION_MODES, MAX_LADDER, MISSION_PRIORITIES, ROUTINE_KINDS, normalizeLimits, parseWorkflowDefinition, shortHash,
} from '@tandemise/domain';
import { limitsSchema, routineScheduleSchema, skillSourceSchema, updateWorkspaceRequest } from '@tandemise/api-contract';
import { redactSecrets } from '@tandemise/shared';

/**
 * A project's setup as files (P15): `.tandemise/tandemise.yaml`,
 * `roles/<id>.md`, `workflows/*.yaml`, `routines.yaml`, `skills.lock` (the
 * skills the setup pins, by content hash - never their files) and
 * `issues.yaml` (each repository's GitHub issue settings).
 *
 * Everything here is pure, so what the export writes, what the import reads and
 * what the preview calls a change are one set of functions the offline check
 * can run twice and compare byte for byte. The rules that make it byte-stable:
 * keys sorted, lists that are sets sorted, no timestamps, no row ids, no
 * machine paths, one YAML option set, one trailing newline.
 */
export const SETUP_DIR = '.tandemise';
export const SETUP_VERSION = 1;
export const SETUP_MAIN_FILE = 'tandemise.yaml';
export const SETUP_ROUTINES_FILE = 'routines.yaml';
export const SETUP_ROLES_DIR = 'roles';
export const SETUP_WORKFLOWS_DIR = 'workflows';
export const SETUP_SKILLS_FILE = 'skills.lock';
export const SETUP_ISSUES_FILE = 'issues.yaml';
/** The primary tracker and its state mapping (#52 owns the schema); carried byte for byte. */
export const SETUP_TRACKER_FILE = 'tracker.yaml';
/** Intake sources (#52 owns the schema); carried byte for byte. */
export const SETUP_INTAKE_FILE = 'intake.yaml';
/** The MCP servers and integrations the project needs, never a credential (#51 spec §2). */
export const SETUP_MCPS_FILE = 'mcps.yaml';
/** The factory's planner, routing and merge rules (#53 owns their schemas); carried byte for byte. */
export const SETUP_FACTORY_FILES = { planner: 'planner.yaml', routing: 'routing.yaml', merge: 'merge.yaml' } as const;
/** The note an imported routine carries until the person turns it on. */
export const IMPORTED_ROUTINE_NOTE = 'Imported — review and turn on';
/** The same note on a repository's imported GitHub issue settings. */
export const IMPORTED_ISSUES_NOTE = IMPORTED_ROUTINE_NOTE;

const KNOWLEDGE_KEYS = ['architecturePrinciples', 'codingStandards', 'designSystem', 'glossary', 'productVision'] as const;

export interface ProjectSetup {
  readonly name: string;
  readonly autonomy: AutonomySettings;
  readonly maxTotalWorkers: number;
  readonly knowledge: Partial<Record<keyof WorkspaceKnowledge, string>>;
  readonly wipLimit: number | null;
  readonly monthlyLimits: readonly Limit[];
  readonly missionLimits: readonly Limit[];
}

export interface RoleSetup {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly instructions: string;
  readonly capabilities: readonly string[];
  readonly produces: readonly string[];
  readonly consumes: readonly string[];
  readonly isolation: IsolationMode;
  readonly outputContract: string;
  readonly model: string | null;
  readonly escalate: readonly string[];
  readonly economyModel: string | null;
  /** Runtime names, for the reader. Compared but never applied (spec ruling 2). */
  readonly runtime: readonly string[];
  /** The role's skill pins. The hash is what counts: version numbers are per machine. */
  readonly skills: readonly SkillPinSetup[];
}

export interface SkillPinSetup {
  readonly name: string;
  readonly version: number;
  readonly hash: string;
}

/** One line of `skills.lock`: a skill version the setup needs, and where it came from. */
export interface SkillLockEntry extends SkillPinSetup {
  readonly source: SkillSource;
}

/** A repository's GitHub issue settings, by repository name (P14). */
export interface IssueSetup {
  readonly repository: string;
  readonly githubRepo: string | null;
  readonly enabled: boolean;
  readonly label: string;
  readonly pollMinutes: number;
  readonly closeOnComplete: boolean;
  readonly postComments: boolean;
  readonly workflow: string | null;
}

export interface RoutineSetup {
  readonly name: string;
  readonly kind: RoutineKind;
  readonly goal: string;
  readonly successCriteria: readonly string[];
  readonly priority: MissionPriority;
  readonly limits: readonly Limit[] | null;
  readonly workflow: string | null;
  readonly schedule: RoutineSchedule;
}

export interface WorkflowSetup {
  /** File name, e.g. `build-feature.yaml`. The id is the name without extension. */
  readonly file: string;
  readonly content: string;
}

/**
 * An integration the project needs (#51 spec §2): by provider and name, with
 * the capabilities the factory enables and how to connect it. Never `env`,
 * `headers` or a credential reference.
 */
export interface McpSetup {
  readonly name: string;
  readonly provider: string;
  readonly capabilities: readonly string[];
  readonly connect: { readonly kind: 'cli'; readonly command: string } | { readonly kind: 'mcp'; readonly url: string } | { readonly kind: 'mcp'; readonly command: string };
}

/** A section left out is "no opinion": an import without `routines.yaml` touches no routine. */
export interface SetupSnapshot {
  readonly project: ProjectSetup | null;
  readonly roles: readonly RoleSetup[] | null;
  readonly workflows: readonly WorkflowSetup[] | null;
  readonly routines: readonly RoutineSetup[] | null;
  readonly skills: readonly SkillLockEntry[] | null;
  readonly issues: readonly IssueSetup[] | null;
  /** The MCPs the project needs (brain). Optional so a P15 snapshot is unchanged. */
  readonly mcps?: readonly McpSetup[] | null;
  /** `tracker.yaml`'s raw text, carried byte for byte (#52 owns its meaning). */
  readonly tracker?: string | null;
  /** `intake.yaml`'s raw text, carried byte for byte (#52 owns its meaning). */
  readonly intake?: string | null;
  /** The factory's rule files' raw text (#53), carried byte for byte. Structural: a person's edit or a promotion PR. */
  readonly planner?: string | null;
  readonly routing?: string | null;
  readonly merge?: string | null;
}

export interface SetupFile {
  /** Relative to the `.tandemise` folder. */
  readonly path: string;
  readonly content: string;
}

export interface SecretPlaceholder {
  readonly file: string;
  readonly name: string;
}

export interface RenderedSetup {
  readonly files: readonly SetupFile[];
  readonly hash: string;
  readonly secrets: readonly SecretPlaceholder[];
}

// ----------------------------------------------------------------- rendering

function yaml(value: unknown): string {
  return stringify(value, { sortMapEntries: true, lineWidth: 0, minContentWidth: 0, indent: 2 });
}

/**
 * Replaces what the daemon's secret patterns recognise with `${SECRET_n}`,
 * numbered per file so each file renders on its own.
 */
class Scrubber {
  #n = 0;
  readonly names: string[] = [];
  text(value: string): string {
    const redacted = redactSecrets(value);
    if (redacted === value) return value;
    return redacted.replace(/«redacted»/g, () => {
      const name = `SECRET_${++this.#n}`;
      this.names.push(name);
      return `\${${name}}`;
    });
  }
}

const sortLimits = (limits: readonly Limit[]): Limit[] =>
  [...limits].sort((a, b) => a.metric.localeCompare(b.metric)).map((l) => ({ metric: l.metric, amount: l.amount, warnPercent: l.warnPercent }));

const trimText = (value: string): string => value.replace(/\r\n/g, '\n').trim();

export function roleFileName(id: string): string {
  return `${SETUP_ROLES_DIR}/${id}.md`;
}

/** One role as its file: YAML front matter, then the instructions. */
export function renderRole(role: RoleSetup, scrub = new Scrubber()): string {
  const front: Record<string, unknown> = {
    id: role.id,
    name: role.name,
    summary: scrub.text(trimText(role.summary)),
    capabilities: [...role.capabilities].sort(),
    produces: [...role.produces].sort(),
    consumes: [...role.consumes].sort(),
    isolation: role.isolation,
    outputContract: scrub.text(trimText(role.outputContract)),
    runtime: [...role.runtime],
  };
  if (role.model !== null) front['model'] = role.model;
  if (role.escalate.length > 0) front['escalate'] = [...role.escalate];
  if (role.economyModel !== null) front['economyModel'] = role.economyModel;
  if (role.skills.length > 0) front['skills'] = sortPins(role.skills).map((p) => ({ name: p.name, version: p.version, hash: p.hash }));
  const body = scrub.text(trimText(role.instructions));
  return `---\n${yaml(front)}---\n\n${body}${body.length > 0 ? '\n' : ''}`;
}

const sortPins = <T extends SkillPinSetup>(pins: readonly T[]): T[] =>
  [...pins].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.hash.localeCompare(b.hash));

function sourceEntry(source: SkillSource): Record<string, unknown> {
  if (source.kind !== 'git') return { kind: source.kind, path: source.path, ...(source.kind === 'claude' && source.plugin !== undefined ? { plugin: source.plugin } : {}) };
  return { kind: 'git', url: source.url, ...(source.subpath === undefined ? {} : { subpath: source.subpath }), ...(source.ref === undefined ? {} : { ref: source.ref }) };
}

/** Where a skill came from, in words: a folder, or a repository with its subfolder and ref. */
export function skillSourceLabel(source: SkillSource): string {
  if (source.kind === 'git') return [source.url, source.subpath, source.ref === undefined ? undefined : `@${source.ref}`].filter(Boolean).join(' · ');
  return source.path;
}

function issueEntry(issue: IssueSetup): Record<string, unknown> {
  return {
    repository: issue.repository,
    githubRepo: issue.githubRepo,
    enabled: issue.enabled,
    label: issue.label,
    pollMinutes: issue.pollMinutes,
    closeOnComplete: issue.closeOnComplete,
    postComments: issue.postComments,
    workflow: issue.workflow,
  };
}

function routineEntry(routine: RoutineSetup, scrub: Scrubber): Record<string, unknown> {
  return {
    name: routine.name,
    kind: routine.kind,
    goal: scrub.text(trimText(routine.goal)),
    successCriteria: routine.successCriteria.map((line) => scrub.text(trimText(line))),
    priority: routine.priority,
    limits: routine.limits === null ? null : sortLimits(routine.limits),
    workflow: routine.workflow,
    schedule: routine.schedule,
  };
}

function mcpEntry(mcp: McpSetup, scrub: Scrubber): Record<string, unknown> {
  const connect = mcp.connect.kind === 'cli'
    ? { kind: 'cli', command: scrub.text(mcp.connect.command) }
    : 'url' in mcp.connect ? { kind: 'mcp', url: scrub.text(mcp.connect.url) } : { kind: 'mcp', command: scrub.text(mcp.connect.command) };
  return { name: scrub.text(mcp.name), provider: mcp.provider, capabilities: [...mcp.capabilities].sort(), connect };
}

function projectEntry(project: ProjectSetup, scrub: Scrubber): Record<string, unknown> {
  const knowledge: Record<string, string> = {};
  for (const key of KNOWLEDGE_KEYS) {
    const value = project.knowledge[key];
    if (value !== undefined && value.trim() !== '') knowledge[key] = scrub.text(trimText(value));
  }
  return {
    name: project.name,
    autonomy: { ...project.autonomy },
    maxTotalWorkers: project.maxTotalWorkers,
    knowledge,
  };
}

export function renderSetup(snapshot: SetupSnapshot): RenderedSetup {
  const files: SetupFile[] = [];
  const secrets: SecretPlaceholder[] = [];
  const declare = (file: string, scrub: Scrubber): void => {
    for (const name of scrub.names) secrets.push({ file, name });
  };

  for (const role of [...(snapshot.roles ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const scrub = new Scrubber();
    const path = roleFileName(role.id);
    files.push({ path, content: renderRole(role, scrub) });
    declare(path, scrub);
  }
  if (snapshot.routines !== null) {
    const scrub = new Scrubber();
    const routines = [...snapshot.routines].sort((a, b) => a.name.localeCompare(b.name)).map((r) => routineEntry(r, scrub));
    files.push({ path: SETUP_ROUTINES_FILE, content: yaml({ routines }) });
    declare(SETUP_ROUTINES_FILE, scrub);
  }
  for (const workflow of [...(snapshot.workflows ?? [])].sort((a, b) => a.file.localeCompare(b.file))) {
    files.push({ path: `${SETUP_WORKFLOWS_DIR}/${workflow.file}`, content: workflow.content });
  }
  // Written only when there is something to say, so a setup without skills or
  // issue settings exports exactly the bytes it did before.
  if (snapshot.skills !== null && snapshot.skills.length > 0) {
    const skills = sortPins(snapshot.skills).map((s) => ({ name: s.name, version: s.version, hash: s.hash, source: sourceEntry(s.source) }));
    files.push({ path: SETUP_SKILLS_FILE, content: yaml({ version: SETUP_VERSION, skills }) });
  }
  if (snapshot.issues !== null && snapshot.issues.length > 0) {
    const repositories = [...snapshot.issues].sort((a, b) => a.repository.localeCompare(b.repository)).map(issueEntry);
    files.push({ path: SETUP_ISSUES_FILE, content: yaml({ repositories }) });
  }
  // The brain's files (#51): written only when non-empty, so a P15 export
  // without them is byte-identical to before.
  if (snapshot.mcps !== undefined && snapshot.mcps !== null && snapshot.mcps.length > 0) {
    const scrub = new Scrubber();
    const mcps = [...snapshot.mcps].sort((a, b) => a.name.localeCompare(b.name)).map((m) => mcpEntry(m, scrub));
    files.push({ path: SETUP_MCPS_FILE, content: yaml({ mcps }) });
    declare(SETUP_MCPS_FILE, scrub);
  }
  if (snapshot.tracker !== undefined && snapshot.tracker !== null && snapshot.tracker.trim() !== '') {
    files.push({ path: SETUP_TRACKER_FILE, content: snapshot.tracker });
  }
  if (snapshot.intake !== undefined && snapshot.intake !== null && snapshot.intake.trim() !== '') {
    files.push({ path: SETUP_INTAKE_FILE, content: snapshot.intake });
  }
  for (const [key, file] of Object.entries(SETUP_FACTORY_FILES) as [keyof typeof SETUP_FACTORY_FILES, string][]) {
    const text = snapshot[key];
    if (text !== undefined && text !== null && text.trim() !== '') files.push({ path: file, content: text });
  }
  if (snapshot.project !== null) {
    const scrub = new Scrubber();
    const project = projectEntry(snapshot.project, scrub);
    declare(SETUP_MAIN_FILE, scrub);
    const declared = [...secrets]
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((s) => ({ file: s.file, name: s.name, note: 'A secret was removed from this file. Put the value back by hand after importing, or keep it out of the repository.' }));
    files.push({
      path: SETUP_MAIN_FILE,
      content: yaml({
        version: SETUP_VERSION,
        project,
        wipLimit: snapshot.project.wipLimit ?? 'off',
        limits: { monthly: sortLimits(snapshot.project.monthlyLimits) },
        defaults: { missionLimits: sortLimits(snapshot.project.missionLimits) },
        secrets: declared,
      }),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, hash: setupHash(files), secrets };
}

/** First 12 hex digits of sha256 over `path NUL content NUL`, in path order. */
export function setupHash(files: readonly SetupFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update('\0').update(file.content).update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------- reading

export interface SetupProblem {
  /** The file, relative to `.tandemise`. */
  readonly file: string;
  /** The item it belongs to, when one can be named (a role id, a routine name). */
  readonly item: string | null;
  readonly message: string;
}

export interface ReadSetup {
  readonly snapshot: SetupSnapshot;
  readonly problems: readonly SetupProblem[];
}

const modelName = z.string().trim().min(1).max(100).regex(/^\S+$/, 'a model name is one word');
const skillHash = z.string().regex(/^[0-9a-f]{64}$/, 'a skill hash is 64 hex digits');
const skillPin = z.object({
  name: z.string().min(1).max(64),
  version: z.number().int().min(1),
  hash: skillHash,
});
const roleFront = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, 'a role id is lowercase letters, digits, - and _'),
  name: z.string().min(1).max(120),
  summary: z.string().max(500).default(''),
  capabilities: z.array(z.string().min(1)).default([]),
  produces: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  consumes: z.array(z.enum(ARTIFACT_TYPES)).default([]),
  isolation: z.enum(ISOLATION_MODES).default('none'),
  outputContract: z.string().max(8000).default(''),
  runtime: z.array(z.string()).default([]),
  model: modelName.nullable().optional(),
  escalate: z.array(modelName).max(MAX_LADDER).optional(),
  economyModel: modelName.nullable().optional(),
  skills: z.array(skillPin).max(50).optional(),
});

const skillsLockFile = z.object({
  version: z.literal(SETUP_VERSION, { errorMap: () => ({ message: `This file is setup version ${SETUP_VERSION}; this one cannot be read.` }) }),
  skills: z.array(skillPin.extend({ source: skillSourceSchema })).max(500).default([]),
});

const issuesFile = z.object({
  repositories: z.array(z.object({
    repository: z.string().trim().min(1).max(200),
    githubRepo: z.string().max(200).nullable().default(null),
    enabled: z.boolean().default(false),
    label: z.string().max(100),
    pollMinutes: z.number().int(),
    closeOnComplete: z.boolean().default(false),
    postComments: z.boolean().default(true),
    workflow: z.string().min(1).max(200).nullable().default(null),
  })).default([]),
});

const mcpsFile = z.object({
  mcps: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    provider: z.string().trim().min(1).max(60),
    capabilities: z.array(z.string().min(1)).default([]),
    connect: z.union([
      z.object({ kind: z.literal('cli'), command: z.string().min(1).max(200) }),
      z.object({ kind: z.literal('mcp'), url: z.string().min(1).max(2048) }),
      z.object({ kind: z.literal('mcp'), command: z.string().min(1).max(2048) }),
    ]),
  }).strict()).default([]),
});

const routineFile = z.object({
  routines: z.array(z.object({
    name: z.string().trim().min(1, 'A routine needs a name.').max(120),
    kind: z.enum(ROUTINE_KINDS).default('mission'),
    goal: z.string().max(8000).default(''),
    successCriteria: z.array(z.string().max(2000)).max(50).default([]),
    priority: z.enum(MISSION_PRIORITIES).default('normal'),
    limits: limitsSchema.nullable().default(null),
    workflow: z.string().min(1).nullable().default(null),
    schedule: routineScheduleSchema,
  })).default([]),
});

const workspaceShape = updateWorkspaceRequest.shape;
const mainFile = z.object({
  version: z.literal(SETUP_VERSION, { errorMap: () => ({ message: `This file is setup version ${SETUP_VERSION}; this one cannot be read.` }) }),
  project: z.object({
    name: z.string().min(1).max(120),
    autonomy: workspaceShape.autonomy.unwrap(),
    maxTotalWorkers: z.number().int().min(1).max(16),
    knowledge: z.object(Object.fromEntries(KNOWLEDGE_KEYS.map((k) => [k, z.string().optional()])) as Record<typeof KNOWLEDGE_KEYS[number], z.ZodOptional<z.ZodString>>).default({}),
  }),
  wipLimit: z.union([z.literal('off'), z.number().int().min(1).max(50)]).default('off'),
  limits: z.object({ monthly: limitsSchema.default([]) }).default({}),
  defaults: z.object({ missionLimits: limitsSchema.default([]) }).default({}),
  secrets: z.array(z.object({ file: z.string(), name: z.string(), note: z.string().optional() })).default([]),
});

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; ');
}

/** Splits a role file into its front matter and body. */
function splitFrontMatter(text: string): { front: string; body: string } | null {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return null;
  const after = normalized.indexOf('\n', end + 4);
  return { front: normalized.slice(4, end + 1), body: after === -1 ? '' : normalized.slice(after + 1) };
}

export function readRole(file: string, text: string): { role: RoleSetup } | { problem: string } {
  const parts = splitFrontMatter(text);
  if (parts === null) return { problem: 'A role file starts with front matter between two --- lines.' };
  let raw: unknown;
  try {
    raw = parseYaml(parts.front);
  } catch (e) {
    return { problem: `The front matter is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  }
  const parsed = roleFront.safeParse(raw ?? {});
  if (!parsed.success) return { problem: issues(parsed.error) };
  const expected = file.replace(/^roles\//, '').replace(/\.md$/, '');
  if (parsed.data.id !== expected) return { problem: `The file is named ${expected}.md but its id is '${parsed.data.id}'. Make them match.` };
  const f = parsed.data;
  return {
    role: {
      id: f.id, name: f.name, summary: f.summary, instructions: parts.body,
      capabilities: f.capabilities, produces: f.produces, consumes: f.consumes, isolation: f.isolation,
      outputContract: f.outputContract, runtime: f.runtime,
      model: f.model ?? null, escalate: f.escalate ?? [], economyModel: f.economyModel ?? null,
      skills: f.skills ?? [],
    },
  };
}

/**
 * Reads a `.tandemise` folder's files (path → text, relative to it). Anything
 * unreadable becomes a problem naming the file, never an exception: the
 * preview shows it on its row.
 */
export function readSetup(files: Readonly<Record<string, string>>): ReadSetup {
  const problems: SetupProblem[] = [];
  const paths = Object.keys(files).sort();

  let project: ProjectSetup | null = null;
  const main = files[SETUP_MAIN_FILE];
  if (main !== undefined) {
    try {
      const parsed = mainFile.safeParse(parseYaml(main) ?? {});
      if (!parsed.success) problems.push({ file: SETUP_MAIN_FILE, item: null, message: issues(parsed.error) });
      else {
        const d = parsed.data;
        const knowledge: Partial<Record<keyof WorkspaceKnowledge, string>> = {};
        for (const key of KNOWLEDGE_KEYS) {
          const value = d.project.knowledge[key];
          if (value !== undefined && value.trim() !== '') knowledge[key] = value;
        }
        project = {
          name: d.project.name,
          autonomy: d.project.autonomy as AutonomySettings,
          maxTotalWorkers: d.project.maxTotalWorkers,
          knowledge,
          wipLimit: d.wipLimit === 'off' ? null : d.wipLimit,
          monthlyLimits: normalizeLimits(d.limits.monthly),
          missionLimits: normalizeLimits(d.defaults.missionLimits),
        };
      }
    } catch (e) {
      problems.push({ file: SETUP_MAIN_FILE, item: null, message: `Not valid YAML: ${firstLine(e)}` });
    }
  }

  const rolePaths = paths.filter((p) => p.startsWith(`${SETUP_ROLES_DIR}/`) && p.endsWith('.md'));
  const roles: RoleSetup[] | null = rolePaths.length === 0 ? null : [];
  for (const path of rolePaths) {
    const read = readRole(path, files[path] ?? '');
    if ('problem' in read) problems.push({ file: path, item: path.slice(SETUP_ROLES_DIR.length + 1, -3), message: read.problem });
    else roles?.push(read.role);
  }

  const workflowPaths = paths.filter((p) => p.startsWith(`${SETUP_WORKFLOWS_DIR}/`) && /\.(ya?ml|json)$/.test(p));
  const workflows: WorkflowSetup[] | null = workflowPaths.length === 0 ? null : workflowPaths.map((path) => ({
    file: path.slice(SETUP_WORKFLOWS_DIR.length + 1),
    content: files[path] ?? '',
  }));

  let routines: RoutineSetup[] | null = null;
  const routineText = files[SETUP_ROUTINES_FILE];
  if (routineText !== undefined) {
    try {
      const parsed = routineFile.safeParse(parseYaml(routineText) ?? {});
      if (!parsed.success) problems.push({ file: SETUP_ROUTINES_FILE, item: null, message: issues(parsed.error) });
      else {
        const seen = new Set<string>();
        routines = [];
        for (const r of parsed.data.routines) {
          if (seen.has(r.name)) {
            problems.push({ file: SETUP_ROUTINES_FILE, item: r.name, message: `Two routines are named '${r.name}'. Give each its own name.` });
            continue;
          }
          seen.add(r.name);
          routines.push({
            name: r.name, kind: r.kind, goal: r.goal, successCriteria: r.successCriteria, priority: r.priority,
            limits: r.limits === null ? null : normalizeLimits(r.limits), workflow: r.workflow, schedule: r.schedule as RoutineSchedule,
          });
        }
      }
    } catch (e) {
      problems.push({ file: SETUP_ROUTINES_FILE, item: null, message: `Not valid YAML: ${firstLine(e)}` });
    }
  }

  let skills: SkillLockEntry[] | null = null;
  const lockText = files[SETUP_SKILLS_FILE];
  if (lockText !== undefined) {
    try {
      const parsed = skillsLockFile.safeParse(parseYaml(lockText) ?? {});
      if (!parsed.success) problems.push({ file: SETUP_SKILLS_FILE, item: null, message: issues(parsed.error) });
      else skills = parsed.data.skills.map((s) => ({ name: s.name, version: s.version, hash: s.hash, source: s.source as SkillSource }));
    } catch (e) {
      problems.push({ file: SETUP_SKILLS_FILE, item: null, message: `Not valid YAML: ${firstLine(e)}` });
    }
  }

  let issueSettings: IssueSetup[] | null = null;
  const issuesText = files[SETUP_ISSUES_FILE];
  if (issuesText !== undefined) {
    try {
      const parsed = issuesFile.safeParse(parseYaml(issuesText) ?? {});
      if (!parsed.success) problems.push({ file: SETUP_ISSUES_FILE, item: null, message: issues(parsed.error) });
      else {
        const seen = new Set<string>();
        issueSettings = [];
        for (const r of parsed.data.repositories) {
          if (seen.has(r.repository)) {
            problems.push({ file: SETUP_ISSUES_FILE, item: r.repository, message: `Two entries are for '${r.repository}'. Keep one.` });
            continue;
          }
          seen.add(r.repository);
          issueSettings.push({ ...r });
        }
      }
    } catch (e) {
      problems.push({ file: SETUP_ISSUES_FILE, item: null, message: `Not valid YAML: ${firstLine(e)}` });
    }
  }

  let mcps: McpSetup[] | null = null;
  const mcpsText = files[SETUP_MCPS_FILE];
  if (mcpsText !== undefined) {
    try {
      const parsed = mcpsFile.safeParse(parseYaml(mcpsText) ?? {});
      if (!parsed.success) problems.push({ file: SETUP_MCPS_FILE, item: null, message: issues(parsed.error) });
      else mcps = parsed.data.mcps.map((m) => ({ name: m.name, provider: m.provider, capabilities: m.capabilities, connect: m.connect }));
    } catch (e) {
      problems.push({ file: SETUP_MCPS_FILE, item: null, message: `Not valid YAML: ${firstLine(e)}` });
    }
  }

  return {
    snapshot: {
      project, roles, workflows, routines, skills, issues: issueSettings,
      ...(mcps === null ? {} : { mcps }),
      ...(files[SETUP_TRACKER_FILE] === undefined ? {} : { tracker: files[SETUP_TRACKER_FILE] }),
      ...(files[SETUP_INTAKE_FILE] === undefined ? {} : { intake: files[SETUP_INTAKE_FILE] }),
      ...(files[SETUP_FACTORY_FILES.planner] === undefined ? {} : { planner: files[SETUP_FACTORY_FILES.planner] }),
      ...(files[SETUP_FACTORY_FILES.routing] === undefined ? {} : { routing: files[SETUP_FACTORY_FILES.routing] }),
      ...(files[SETUP_FACTORY_FILES.merge] === undefined ? {} : { merge: files[SETUP_FACTORY_FILES.merge] }),
    },
    problems,
  };
}

/** A workflow file's problems, from the one workflow validator (gates included). */
export function workflowProblems(content: string, file: string): readonly string[] {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    return [`${file} is not valid YAML: ${firstLine(e)}`];
  }
  const parsed = parseWorkflowDefinition(raw);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
}

// ---------------------------------------------------------------------- diff

export type SetupItemKind = 'settings' | 'wip' | 'monthly_limits' | 'mission_limits' | 'role' | 'workflow' | 'routine' | 'skill' | 'issues' | 'mcps' | 'tracker' | 'intake' | 'planner' | 'routing' | 'merge';
export type SetupAction = 'add' | 'change' | 'remove' | 'same';
export type SetupChoice = 'mine' | 'theirs';

export interface SetupItem {
  /** Stable across a preview and its apply: `<kind>:<identity>`. */
  readonly id: string;
  readonly kind: SetupItemKind;
  readonly name: string;
  readonly action: SetupAction;
  /** What differs, in words ("model: base-model → strong-model"). Empty when Same. */
  readonly detail: string;
  /** Why it cannot be taken; the row can only keep yours. */
  readonly problem: string | null;
  /** Things worth knowing that do not block it (a runtime not applied, a secret placeholder). */
  readonly notes: readonly string[];
  /** The default choice: Add and Change take theirs, Remove keeps yours. */
  readonly choice: SetupChoice | null;
  /**
   * A skill whose files are neither in the library nor in this machine's
   * skills store: it cannot be applied (a run would refuse), but it can be
   * fetched from where it came from, with the Skills screen's own preview.
   */
  readonly needsImport: SkillLockEntry | null;
}

/** What the diff needs to know about this machine, beyond the project's own setup. */
export interface SetupDiffContext {
  /** Every version in the project's skills library. */
  readonly library: readonly SkillPinSetup[];
  /** Content hashes present in this machine's skills store (shared by every project). */
  readonly stored: ReadonlySet<string>;
  /** The project's repository names. */
  readonly repositories: readonly string[];
  /** The integrations connected for the project on this machine, for `mcps.yaml` rows (#51). */
  readonly integrations?: readonly { readonly provider: string; readonly name: string }[];
}

const NO_CONTEXT: SetupDiffContext = { library: [], stored: new Set(), repositories: [] };

/** How a pinned skill can be had here: already in the library, in the store, or not at all. */
export type SkillAvailability = 'library' | 'store' | 'missing';

export function skillAvailability(pin: Pick<SkillPinSetup, 'name' | 'hash'>, context: SetupDiffContext): SkillAvailability {
  if (context.library.some((v) => v.name === pin.name && v.hash === pin.hash)) return 'library';
  return context.stored.has(pin.hash) ? 'store' : 'missing';
}

/** The item id of a skill version: its name and the start of its hash, the same on every machine. */
export function skillItemId(pin: Pick<SkillPinSetup, 'name' | 'hash'>): string {
  return `skill:${pin.name}@${shortHash(pin.hash)}`;
}

export function needsImportMessage(entry: Pick<SkillLockEntry, 'name' | 'source'>): string {
  return `Needs import: ${entry.name} from ${skillSourceLabel(entry.source)}`;
}

const stable = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v);

function short(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map((v) => (typeof v === 'object' ? stable(v) : String(v))).join(', ');
  if (typeof value === 'object') return stable(value);
  return String(value);
}

/** Field by field, the way a person reads a change: short values shown, long ones named. */
function fieldChanges(mine: Record<string, unknown>, theirs: Record<string, unknown>, labels: Record<string, string> = {}): string {
  const keys = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])];
  const out: string[] = [];
  for (const key of keys) {
    const a = mine[key];
    const b = theirs[key];
    if (stable(a) === stable(b)) continue;
    const label = labels[key] ?? key;
    const sa = short(a);
    const sb = short(b);
    out.push(sa.length + sb.length > 80 || sa.includes('\n') || sb.includes('\n') ? `${label} changed` : `${label}: ${sa} → ${sb}`);
  }
  return out.join('; ');
}

function roleFields(role: RoleSetup): Record<string, unknown> {
  const scrub = new Scrubber();
  return {
    name: role.name,
    summary: scrub.text(trimText(role.summary)),
    instructions: scrub.text(trimText(role.instructions)),
    capabilities: [...role.capabilities].sort(),
    produces: [...role.produces].sort(),
    consumes: [...role.consumes].sort(),
    isolation: role.isolation,
    outputContract: scrub.text(trimText(role.outputContract)),
    model: role.model,
    escalate: role.escalate,
    economyModel: role.economyModel,
    // By hash: the same files are the same pin, whatever number this library gave them.
    skills: sortPins(role.skills).map((p) => `${p.name} (${shortHash(p.hash)})`),
  };
}

function routineFields(routine: RoutineSetup): Record<string, unknown> {
  const { name: _name, ...rest } = routineEntry(routine, new Scrubber());
  return rest;
}

const hasPlaceholder = (text: string): boolean => /\$\{SECRET_\d+\}/.test(text);

/**
 * The preview: every item in either set, and what taking the files' version
 * would do to it. Pure; the service applies the choices.
 */
export function diffSetup(mine: SetupSnapshot, read: ReadSetup, context: SetupDiffContext = NO_CONTEXT): readonly SetupItem[] {
  const theirs = read.snapshot;
  const items: SetupItem[] = [];
  const problemFor = (file: string, item: string | null): string | null =>
    read.problems.find((p) => p.file === file && (item === null || p.item === null || p.item === item))?.message ?? null;
  const push = (item: Omit<SetupItem, 'choice' | 'needsImport'> & { choice?: SetupChoice | null; needsImport?: SkillLockEntry | null }): void => {
    const choice = item.problem !== null || item.action === 'same' ? null
      : item.choice !== undefined ? item.choice : item.action === 'remove' ? 'mine' : 'theirs';
    items.push({ ...item, choice, needsImport: item.needsImport ?? null });
  };
  // Where a pin's files came from, for "Needs import: <name> from <source>".
  const lockEntry = (pin: Pick<SkillPinSetup, 'name' | 'hash'>): SkillLockEntry | undefined =>
    theirs.skills?.find((s) => s.name === pin.name && s.hash === pin.hash);
  const compare = (a: unknown, b: unknown): SetupAction => (stable(a) === stable(b) ? 'same' : 'change');

  // tandemise.yaml: four items, so the WIP limit can be taken without the name.
  const mainProblem = problemFor(SETUP_MAIN_FILE, null);
  if (theirs.project !== null || mainProblem !== null) {
    const m = mine.project;
    const t = theirs.project;
    const settings = (p: ProjectSetup | null) => (p === null ? {} : projectEntry(p, new Scrubber()));
    const sections: { kind: SetupItemKind; name: string; mine: Record<string, unknown>; theirs: Record<string, unknown>; labels?: Record<string, string> }[] = [
      { kind: 'settings', name: 'Project settings', mine: settings(m), theirs: settings(t) },
      { kind: 'wip', name: 'Work-in-progress limit', mine: { limit: m?.wipLimit ?? 'off' }, theirs: { limit: t?.wipLimit ?? 'off' }, labels: { limit: 'limit' } },
      { kind: 'monthly_limits', name: 'Monthly limits', mine: { limits: sortLimits(m?.monthlyLimits ?? []) }, theirs: { limits: sortLimits(t?.monthlyLimits ?? []) } },
      { kind: 'mission_limits', name: 'Default mission limits', mine: { limits: sortLimits(m?.missionLimits ?? []) }, theirs: { limits: sortLimits(t?.missionLimits ?? []) } },
    ];
    for (const section of sections) {
      const action = mainProblem !== null ? 'change' : compare(section.mine, section.theirs);
      const knowledge = section.kind === 'settings' && t !== null && Object.values(t.knowledge).some((v) => v !== undefined && hasPlaceholder(v));
      push({
        id: `${section.kind}:project`, kind: section.kind, name: section.name, action,
        detail: action === 'same' || mainProblem !== null ? '' : fieldChanges(section.mine, section.theirs, section.labels),
        problem: mainProblem,
        notes: knowledge ? ['Contains a ${SECRET_n} placeholder: fill in the value after applying.'] : [],
      });
    }
  }

  // Roles: by id.
  const roleProblems = read.problems.filter((p) => p.file.startsWith(`${SETUP_ROLES_DIR}/`));
  if (theirs.roles !== null || roleProblems.length > 0) {
    const mineById = new Map((mine.roles ?? []).map((r) => [r.id, r]));
    const theirsById = new Map((theirs.roles ?? []).map((r) => [r.id, r]));
    const ids = [...new Set([...mineById.keys(), ...theirsById.keys(), ...roleProblems.map((p) => p.item ?? '')])].filter((id) => id !== '').sort();
    for (const id of ids) {
      const m = mineById.get(id);
      const t = theirsById.get(id);
      const problem = roleProblems.find((p) => p.item === id)?.message ?? null;
      const name = t?.name ?? m?.name ?? id;
      if (problem !== null) {
        push({ id: `role:${id}`, kind: 'role', name, action: m === undefined ? 'add' : 'change', detail: '', problem, notes: [] });
        continue;
      }
      const notes: string[] = [];
      if (m !== undefined && t !== undefined && stable([...m.runtime].sort()) !== stable([...t.runtime].sort())) {
        notes.push(`Runs on ${short(t.runtime)} in the files and on ${short(m.runtime)} here. Runtimes are set in Team, so this is not changed.`);
      }
      if (t !== undefined && [t.instructions, t.summary, t.outputContract].some(hasPlaceholder)) {
        notes.push('Contains a ${SECRET_n} placeholder: fill in the value after applying.');
      }
      // A role is never saved pinning a skill whose files this machine lacks: its runs would refuse.
      const missingPins = (t?.skills ?? []).filter((p) => skillAvailability(p, context) === 'missing');
      const skillProblem = missingPins.length === 0 ? null
        : `${missingPins.map((p) => { const e = lockEntry(p); return e === undefined ? `Needs import: ${p.name} v${p.version} (${shortHash(p.hash)}), which skills.lock does not list` : needsImportMessage(e); }).join('. ')}. Import it first, then preview again.`;
      for (const p of t?.skills ?? []) {
        if (skillAvailability(p, context) === 'store') notes.push(`Also adds ${p.name} to the skills library, from files already on this machine.`);
      }
      if (m === undefined && t !== undefined) {
        push({ id: `role:${id}`, kind: 'role', name, action: 'add', detail: 'A new role.', problem: skillProblem, notes });
      } else if (m !== undefined && t === undefined) {
        push({ id: `role:${id}`, kind: 'role', name, action: 'remove', detail: 'Not in the files: taking theirs deletes a role you added, or restores a built-in role as shipped.', problem: null, notes });
      } else if (m !== undefined && t !== undefined) {
        const a = roleFields(m);
        const b = roleFields(t);
        const action = compare(a, b);
        push({ id: `role:${id}`, kind: 'role', name, action, detail: action === 'same' ? '' : fieldChanges(a, b), problem: action === 'same' ? null : skillProblem, notes: action === 'same' ? [] : notes });
      }
    }
  }

  // Workflows: by file name; their problems come from the one validator.
  if (theirs.workflows !== null) {
    const norm = (text: string): string => text.replace(/\r\n/g, '\n');
    const mineByFile = new Map((mine.workflows ?? []).map((w) => [w.file, w]));
    const theirsByFile = new Map(theirs.workflows.map((w) => [w.file, w]));
    for (const file of [...new Set([...mineByFile.keys(), ...theirsByFile.keys()])].sort()) {
      const m = mineByFile.get(file);
      const t = theirsByFile.get(file);
      const name = file.replace(/\.(ya?ml|json)$/, '');
      if (t === undefined) {
        push({ id: `workflow:${file}`, kind: 'workflow', name, action: 'remove', detail: 'Not in the files: taking theirs deletes this workflow file.', problem: null, notes: [] });
        continue;
      }
      const found = workflowProblems(t.content, file);
      const action: SetupAction = m === undefined ? 'add' : norm(m.content) === norm(t.content) ? 'same' : 'change';
      push({
        id: `workflow:${file}`, kind: 'workflow', name, action,
        detail: action === 'add' ? 'A new workflow file.' : action === 'change' ? 'The file differs.' : '',
        problem: found.length > 0 && action !== 'same' ? `This workflow cannot run: ${found.join(' ')}` : null,
        notes: found.length > 0 && action === 'same' ? [`This workflow cannot run: ${found.join(' ')}`] : [],
      });
    }
  }

  // Routines: by name. Whatever is taken arrives off.
  const routinesProblem = problemFor(SETUP_ROUTINES_FILE, null);
  if (theirs.routines !== null || routinesProblem !== null) {
    const mineByName = new Map((mine.routines ?? []).map((r) => [r.name, r]));
    const theirsByName = new Map((theirs.routines ?? []).map((r) => [r.name, r]));
    const offNote = 'Arrives off: turn it on in Missions → Routines after reviewing it.';
    if (routinesProblem !== null && theirs.routines === null) {
      push({ id: 'routine:(file)', kind: 'routine', name: 'routines.yaml', action: 'change', detail: '', problem: routinesProblem, notes: [] });
    }
    for (const name of [...new Set([...mineByName.keys(), ...theirsByName.keys()])].sort()) {
      const m = mineByName.get(name);
      const t = theirsByName.get(name);
      const problem = read.problems.find((p) => p.file === SETUP_ROUTINES_FILE && p.item === name)?.message ?? null;
      if (t === undefined) {
        if (m !== undefined) push({ id: `routine:${name}`, kind: 'routine', name, action: 'remove', detail: 'Not in the files: taking theirs deletes this routine.', problem, notes: [] });
        continue;
      }
      const notes = [offNote, ...([t.goal, ...t.successCriteria].some(hasPlaceholder) ? ['Contains a ${SECRET_n} placeholder: fill in the value after applying.'] : [])];
      if (m === undefined) {
        push({ id: `routine:${name}`, kind: 'routine', name, action: 'add', detail: 'A new routine.', problem, notes });
      } else {
        const a = routineFields(m);
        const b = routineFields(t);
        const action = compare(a, b);
        push({ id: `routine:${name}`, kind: 'routine', name, action, detail: action === 'same' ? '' : fieldChanges(a, b), problem, notes: action === 'same' ? [] : notes });
      }
    }
  }
  // Skills: one row per version skills.lock lists. Never a Remove: a skill the
  // files do not mention stays in the library.
  const skillsProblem = problemFor(SETUP_SKILLS_FILE, null);
  if (skillsProblem !== null) {
    push({ id: 'skill:(file)', kind: 'skill', name: SETUP_SKILLS_FILE, action: 'change', detail: '', problem: skillsProblem, notes: [] });
  }
  const seenSkills = new Set<string>();
  for (const entry of sortPins(theirs.skills ?? [])) {
    const id = skillItemId(entry);
    if (seenSkills.has(id)) continue;
    seenSkills.add(id);
    const name = `${entry.name} v${entry.version}`;
    const where = skillAvailability(entry, context);
    if (where === 'library') {
      push({ id, kind: 'skill', name, action: 'same', detail: '', problem: null, notes: [] });
    } else if (where === 'store') {
      const next = Math.max(0, ...context.library.filter((v) => v.name === entry.name).map((v) => v.version)) + 1;
      push({
        id, kind: 'skill', name, action: 'add', problem: null, notes: [],
        detail: `Its files (${shortHash(entry.hash)}) are already on this machine: taking it adds them to the library as ${entry.name} v${next}.`,
      });
    } else {
      push({
        id, kind: 'skill', name, action: 'add', problem: needsImportMessage(entry), needsImport: entry,
        detail: `Its files (${shortHash(entry.hash)}) are not on this machine. Import them from where they came from, then preview again.`,
        notes: [],
      });
    }
  }

  // GitHub issue settings: by repository name. Whatever is taken arrives off.
  const issuesProblem = problemFor(SETUP_ISSUES_FILE, null);
  if (issuesProblem !== null && theirs.issues === null) {
    push({ id: 'issues:(file)', kind: 'issues', name: SETUP_ISSUES_FILE, action: 'change', detail: '', problem: issuesProblem, notes: [] });
  }
  if (theirs.issues !== null) {
    const mineByRepo = new Map((mine.issues ?? []).map((i) => [i.repository, i]));
    // Switched on or off is the person's call on each machine, so it is not compared.
    const fields = (i: IssueSetup): Record<string, unknown> => ({
      githubRepo: i.githubRepo, label: i.label, pollMinutes: i.pollMinutes,
      closeOnComplete: i.closeOnComplete, postComments: i.postComments, workflow: i.workflow,
    });
    for (const t of [...theirs.issues].sort((a, b) => a.repository.localeCompare(b.repository))) {
      const id = `issues:${t.repository}`;
      const name = `Issues for ${t.repository}`;
      const m = mineByRepo.get(t.repository);
      const problem = read.problems.find((p) => p.file === SETUP_ISSUES_FILE && p.item === t.repository)?.message
        ?? (context.repositories.includes(t.repository) ? null
          : `This project has no repository named '${t.repository}'. Add it on the Project screen, then preview again.`);
      const notes = ['Arrives off: turn it on under Repositories → Issues after reviewing it.'];
      if (m === undefined) {
        push({ id, kind: 'issues', name, action: 'add', detail: `Read issues labelled '${t.label}' from ${t.githubRepo ?? 'a GitHub repository not named yet'}.`, problem, notes });
      } else {
        const a = fields(m);
        const b = fields(t);
        const action = compare(a, b);
        push({ id, kind: 'issues', name, action, detail: action === 'same' ? '' : fieldChanges(a, b), problem: action === 'same' ? null : problem, notes: action === 'same' ? [] : notes });
      }
    }
  }

  // The brain's files (#51). Tracker and intake compare raw text; #52 owns
  // what they mean, so they are shown, never applied to rows.
  const raw: { kind: 'tracker' | 'intake' | 'planner' | 'routing' | 'merge'; name: string; file: string; mine: string | null | undefined; theirs: string | null | undefined }[] = [
    { kind: 'tracker', name: 'Tracker and state mapping', file: SETUP_TRACKER_FILE, mine: mine.tracker, theirs: theirs.tracker },
    { kind: 'intake', name: 'Intake sources', file: SETUP_INTAKE_FILE, mine: mine.intake, theirs: theirs.intake },
    { kind: 'planner', name: 'Planning rules', file: SETUP_FACTORY_FILES.planner, mine: mine.planner, theirs: theirs.planner },
    { kind: 'routing', name: 'Model routing', file: SETUP_FACTORY_FILES.routing, mine: mine.routing, theirs: theirs.routing },
    { kind: 'merge', name: 'Merge policy', file: SETUP_FACTORY_FILES.merge, mine: mine.merge, theirs: theirs.merge },
  ];
  for (const r of raw) {
    if (r.theirs === undefined || r.theirs === null) continue;
    const m = (r.mine ?? '').replace(/\r\n/g, '\n');
    const t = r.theirs.replace(/\r\n/g, '\n');
    const action: SetupAction = m === '' ? 'add' : m === t ? 'same' : 'change';
    push({ id: `${r.kind}:project`, kind: r.kind, name: r.name, action, detail: action === 'same' ? '' : `${r.file} ${action === 'add' ? 'is new' : 'differs'}.`, problem: null, notes: [] });
  }
  // MCPs: nothing to apply. A row says what this machine still has to connect.
  const mcpsProblem = problemFor(SETUP_MCPS_FILE, null);
  if (mcpsProblem !== null) push({ id: 'mcps:(file)', kind: 'mcps', name: SETUP_MCPS_FILE, action: 'change', detail: '', problem: mcpsProblem, notes: [] });
  for (const mcp of [...(theirs.mcps ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const connected = (context.integrations ?? []).some((i) => i.provider === mcp.provider && i.name === mcp.name);
    push({
      id: `mcps:${mcp.name}`, kind: 'mcps', name: mcp.name, action: connected ? 'same' : 'add',
      detail: connected ? '' : `This project needs ${mcp.name}. Connect it.`, problem: null, notes: [], choice: null,
    });
  }
  return items;
}

export function setupCounts(items: readonly SetupItem[]): Record<SetupAction, number> {
  const counts: Record<SetupAction, number> = { add: 0, change: 0, remove: 0, same: 0 };
  for (const item of items) counts[item.action]++;
  return counts;
}

