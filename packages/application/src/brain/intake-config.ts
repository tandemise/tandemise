import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { BrainRepoPort } from '@tandemise/domain';
import type { Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { BrainService } from './brain-service.js';
import { BRAIN_FACTORY } from './layout.js';

/**
 * The brain's side of intake's configuration port (#52, `IntakeConfigSource`).
 *
 * #52 is being built in parallel and its port is not on this branch yet, so
 * the shapes below mirror its plan (Task 1) exactly, under brain-only names:
 * nothing here is declared under a name #52 owns. When #52 lands, its module
 * rebinds `INTAKE_CONFIG_SOURCE` to this class, wrapping its local source,
 * and these local shapes give way to the port's.
 */

const STATE = z.string().trim().min(1);
/** `trackerFileV1` from the intake plan. */
export const brainTrackerFile = z.object({
  tracker: z.object({
    kind: z.enum(['youtrack', 'github-issues']),
    url: z.string().optional(),
    project: z.string().optional(),
    repo: z.string().optional(),
    board: z.string().min(1),
    states: z.object({
      ready: z.array(STATE).min(1),
      in_progress: STATE,
      in_review: STATE.optional(),
      done: z.array(STATE).min(1),
      wont_do: z.array(STATE).default([]),
      draft: z.array(STATE).optional(),
    }),
    onComplete: z.enum(['in_review', 'done']).default('in_review'),
    workflows: z.record(z.string(), z.string()).optional(),
    buildTypes: z.array(z.string().trim().min(1)).optional(),
    repoTag: z.string().trim().regex(/^[^:]+:.+$/, 'give it as prefix:name, like repo:web').optional(),
  }),
});

/** `intakeFileV1` from the intake plan; sources are kept as written (#52 validates each). */
export const brainIntakeFile = z.object({
  sources: z.array(z.record(z.string(), z.unknown())).default([]),
  dailyCap: z.number().int().positive().default(20),
  similarity: z.object({ link: z.number().default(0.85), ask: z.number().default(0.55) }).default({}),
});

export type BrainTrackerConfig = z.infer<typeof brainTrackerFile>['tracker'];
export interface BrainIntakeConfig {
  readonly tracker: BrainTrackerConfig | null;
  readonly sources: readonly Readonly<Record<string, unknown>>[];
  readonly dailyCap: number;
  readonly similarity: { readonly link: number; readonly ask: number };
}

/** The port's shape, as #52's plan writes it. */
export interface IntakeConfigSourceShape {
  readonly origin: 'local' | 'brain';
  read(workspaceId: WorkspaceId): BrainIntakeConfig;
  write?(workspaceId: WorkspaceId, patch: { tracker?: BrainTrackerConfig | null; intake?: Omit<BrainIntakeConfig, 'tracker'> }): BrainIntakeConfig;
}

export const INTAKE_DEFAULTS: BrainIntakeConfig = { tracker: null, sources: [], dailyCap: 20, similarity: { link: 0.85, ask: 0.55 } };
export const SET_IN_BRAIN = "Set in this project's brain.";
const TRACKER_PATH = `${BRAIN_FACTORY}/tracker.yaml`;
const INTAKE_PATH = `${BRAIN_FACTORY}/intake.yaml`;

function words(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'it is not valid';
  const where = issue.path.join('.');
  return `${where === '' ? '' : `${where}: `}${issue.message === 'Required' ? 'is missing' : issue.message}`;
}

/**
 * Intake's configuration for a project linked to a brain: `factory/tracker.yaml`
 * and `factory/intake.yaml` at the last pull, parsed with the same schemas.
 * Reads are synchronous (the port's contract), so the parsed config is cached
 * and refreshed after a link, and after a sync that changed either file. A
 * file that fails its schema keeps the last good config and says why in the
 * Brain section; `read` never throws. Projects with no brain use the local source.
 */
export class BrainIntakeConfigSource implements IntakeConfigSourceShape {
  readonly origin = 'brain' as const;
  readonly #cache = new Map<string, BrainIntakeConfig>();

  constructor(
    private readonly brain: Pick<BrainService, 'linkOf' | 'readAt' | 'extraProblems' | 'onSync'>,
    private readonly repo: Pick<BrainRepoPort, 'diffAt'>,
    private readonly local: IntakeConfigSourceShape | null,
    private readonly log: Logger,
  ) {
    brain.onSync((ws, from, to) => this.refresh(ws, from, to));
  }

  /** `brain` when the project is linked; #52's settings form prefers this over `origin`. */
  originFor(workspaceId: WorkspaceId): 'local' | 'brain' {
    return this.brain.linkOf(workspaceId) === undefined ? 'local' : 'brain';
  }

  read(workspaceId: WorkspaceId): BrainIntakeConfig {
    if (this.brain.linkOf(workspaceId) === undefined) return this.local?.read(workspaceId) ?? INTAKE_DEFAULTS;
    return this.#cache.get(workspaceId) ?? INTAKE_DEFAULTS;
  }

  write(workspaceId: WorkspaceId, patch: { tracker?: BrainTrackerConfig | null; intake?: Omit<BrainIntakeConfig, 'tracker'> }): BrainIntakeConfig {
    if (this.brain.linkOf(workspaceId) !== undefined) throw new TandemiseError('CONFLICT', SET_IN_BRAIN);
    if (this.local?.write === undefined) throw new TandemiseError('PRECONDITION_FAILED', 'Intake settings cannot be saved in this build.');
    return this.local.write(workspaceId, patch);
  }

  /** After a link (from null), a sync that moved the head, or an unlink (to null). */
  async refresh(workspaceId: WorkspaceId, from: string | null, to: string | null): Promise<void> {
    if (to === null) { this.#cache.delete(workspaceId); return; }
    const link = this.brain.linkOf(workspaceId);
    if (link === undefined) return;
    if (from !== null && this.#cache.has(workspaceId)) {
      const changed = await this.repo.diffAt(link.clonePath, from, to).catch(() => null);
      if (changed !== null && !changed.some((c) => c.path === TRACKER_PATH || c.path === INTAKE_PATH)) return;
    }
    const problems = (this.brain.extraProblems.get(workspaceId) ?? []).filter((p) => !p.startsWith(TRACKER_PATH) && !p.startsWith(INTAKE_PATH));
    const prior = this.#cache.get(workspaceId) ?? INTAKE_DEFAULTS;
    let tracker = prior.tracker;
    let intake: Omit<BrainIntakeConfig, 'tracker'> = { sources: prior.sources, dailyCap: prior.dailyCap, similarity: prior.similarity };
    try {
      const trackerText = await this.brain.readAt(workspaceId, to, TRACKER_PATH);
      if (trackerText === null) tracker = null;
      else {
        const parsed = brainTrackerFile.safeParse(parseYaml(trackerText) ?? {});
        if (parsed.success) tracker = parsed.data.tracker;
        else problems.push(`${TRACKER_PATH}: ${words(parsed.error)}`);
      }
      const intakeText = await this.brain.readAt(workspaceId, to, INTAKE_PATH);
      if (intakeText === null) intake = { sources: INTAKE_DEFAULTS.sources, dailyCap: INTAKE_DEFAULTS.dailyCap, similarity: INTAKE_DEFAULTS.similarity };
      else {
        const parsed = brainIntakeFile.safeParse(parseYaml(intakeText) ?? {});
        if (parsed.success) intake = parsed.data;
        else problems.push(`${INTAKE_PATH}: ${words(parsed.error)}`);
      }
    } catch (e) {
      this.log.warn('brain.intake_config_failed', { workspaceId, error: errorMessage(e) });
      problems.push(`${TRACKER_PATH}: it could not be read (${errorMessage(e)})`);
    }
    this.#cache.set(workspaceId, { tracker, ...intake });
    this.brain.extraProblems.set(workspaceId, problems);
  }
}
