import { isTandemiseError, TandemiseError } from '@tandemise/shared';
import {
  markerLine, sourcesCommentWith, titleTokens, trackerRef,
  type AttachmentRef, type PrimaryTracker, type SourceEntry, type TrackerDescription, type TrackerItem, type TrackerRef,
} from '@tandemise/domain';
import { z } from 'zod';
import { YouTrackClient } from './client.js';

/**
 * What every issue read asks YouTrack for (plan Task 4), with the item's tags
 * and its subtasks' resolution, so the Board can tell a container and another
 * repository's item (#136).
 */
export const ISSUE_FIELDS =
  'idReadable,summary,description,created,updated,resolved,project(shortName),customFields(name,value(name,login)),'
  + 'tags(name),subtasks(issues(idReadable,resolved))';
const COMMENT_FIELDS = 'id,text,author(login)';
/** The title words a similarity search sends (spec §5 step 4: title words). */
const MAX_SEARCH_WORDS = 8;
/** Enough for any item Tandemise writes to; its comments are among the first. */
const MAX_COMMENTS = 500;

const issueSchema = z.object({
  idReadable: z.string(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  updated: z.number().nullish(),
  resolved: z.number().nullish(),
  customFields: z.array(z.object({ name: z.string(), value: z.unknown() }).passthrough()).nullish(),
  tags: z.array(z.object({ name: z.string().nullish() }).passthrough()).nullish(),
  // The "subtask" link: the issues it lists are this item's subtasks.
  subtasks: z.object({
    issues: z.array(z.object({ resolved: z.number().nullish() }).passthrough()).nullish(),
  }).passthrough().nullish(),
}).passthrough();
type RawIssue = z.infer<typeof issueSchema>;

const commentSchema = z.object({
  id: z.string(),
  text: z.string().nullish(),
  author: z.object({ login: z.string().nullish() }).passthrough().nullish(),
}).passthrough();
type RawComment = z.infer<typeof commentSchema>;

const idSchema = z.object({ id: z.string() }).passthrough();

export interface YouTrackTrackerOptions {
  readonly url: string;
  /** The project's short name (`GAR`). */
  readonly project: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** For tests only: the clock YouTrack's `Retry-After` waits are measured on (Ruling 26). */
  readonly now?: () => number;
}

/**
 * The YouTrack adapter of the `PrimaryTracker` port (spec §6, plan Task 4).
 *
 * Stateless apart from two lookups that never change while it lives (the
 * project's id and the signed-in login): `TrackerService` keeps the comment
 * ids and passes them back as `knownId`. State changes, types, fields,
 * duplicates and assignees all go through YouTrack's command API, which takes
 * the same words a person types.
 */
export class YouTrackTracker implements PrimaryTracker {
  readonly kind = 'youtrack';
  readonly capabilities = { editComments: true, attachments: true, duplicateLinks: true } as const;
  readonly #client: YouTrackClient;
  readonly #project: string;
  #projectId: Promise<string> | null = null;
  #viewer: Promise<string> | null = null;

  constructor(options: YouTrackTrackerOptions) {
    this.#client = new YouTrackClient({
      url: options.url,
      token: options.token,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.#project = options.project;
  }

  async describe(): Promise<TrackerDescription> {
    const id = await this.#projectIdOnce();
    const fields = await this.#client.get(
      `/api/admin/projects/${encodeURIComponent(id)}/customFields`,
      { fields: 'field(name),bundle(values(name))' },
      z.array(z.object({
        field: z.object({ name: z.string() }).passthrough(),
        bundle: z.object({ values: z.array(z.object({ name: z.string() }).passthrough()).nullish() }).passthrough().nullish(),
      }).passthrough()),
    );
    const values = (name: string): string[] =>
      (fields.find((f) => f.field.name === name)?.bundle?.values ?? []).map((v) => v.name);
    return { states: values('State'), types: values('Type'), fields: fields.map((f) => f.field.name) };
  }

  /**
   * `url`: a quoted text query scoped to the project, which YouTrack matches in
   * the summary, the description and the comments (where the sources comment
   * lists every linked URL). `text`: the title's words, at most 8.
   */
  async search(q: { url?: string; text?: string; unresolvedOnly?: boolean; limit: number }): Promise<readonly TrackerItem[]> {
    const parts = [`project: ${this.#projectTerm()}`];
    if (q.unresolvedOnly === true) parts.push('#Unresolved');
    if (q.url !== undefined) {
      // A quote would end the phrase early; a URL that needs one matches nothing exact anyway.
      parts.push(`"${q.url.replace(/"/g, '')}"`);
    } else if (q.text !== undefined) {
      const words = titleTokens(q.text).slice(0, MAX_SEARCH_WORDS);
      // No words would ask for every item: that is not a candidate list.
      if (words.length === 0) return [];
      parts.push(...words);
    }
    return this.#issues(parts.join(' '), q.limit);
  }

  async board(q: { query: string; updatedSince?: string; limit: number }): Promise<readonly TrackerItem[]> {
    const items = await this.#issues(q.query, q.limit);
    // Filtered here rather than in the query, so a team's own board query is sent as they wrote it.
    if (q.updatedSince === undefined) return items;
    const since = Date.parse(q.updatedSince);
    return Number.isNaN(since) ? items : items.filter((i) => Date.parse(i.updatedAt) >= since);
  }

  async get(ref: TrackerRef): Promise<TrackerItem> {
    const key = this.#key(ref);
    try {
      return this.#item(await this.#client.get(`/api/issues/${encodeURIComponent(key)}`, { fields: ISSUE_FIELDS }, issueSchema));
    } catch (e) {
      if (isTandemiseError(e) && e.code === 'NOT_FOUND') {
        throw new TandemiseError('NOT_FOUND', `YouTrack has no item ${key}.`, { details: { ref } });
      }
      throw e;
    }
  }

  async create(draft: {
    title: string;
    description: string;
    type?: string;
    fields?: Readonly<Record<string, string>>;
    attachments?: readonly AttachmentRef[];
  }): Promise<TrackerItem> {
    const projectId = await this.#projectIdOnce();
    const created = await this.#client.post(
      '/api/issues',
      { fields: ISSUE_FIELDS },
      { project: { id: projectId }, summary: draft.title, description: draft.description },
      issueSchema,
    );
    const key = created.idReadable;
    const words = [
      ...(draft.type !== undefined ? [`Type ${commandValue(draft.type)}`] : []),
      ...Object.entries(draft.fields ?? {}).map(([name, value]) => `${name} ${commandValue(value)}`),
    ];
    if (words.length > 0) await this.#command(key, words.join(' '));
    for (const a of draft.attachments ?? []) {
      // A URL-only attachment has nothing to upload; the description links it.
      if (a.content === undefined) continue;
      const form = new FormData();
      form.append('file', new Blob([a.content], { type: a.mediaType }), a.name);
      await this.#client.postForm(`/api/issues/${encodeURIComponent(key)}/attachments`, { fields: 'id,name' }, form, z.unknown());
    }
    // Read back, so the type and state the commands set are what the caller sees.
    return words.length > 0 ? this.get(trackerRef('youtrack', key)) : this.#item(created);
  }

  async link(ref: TrackerRef, source: SourceEntry): Promise<void> {
    const key = this.#key(ref);
    const own = await this.#ownComment(key, 'tandemise:sources');
    await this.#write(key, 'tandemise:sources', sourcesCommentWith(own?.text ?? null, source), own?.id);
  }

  async comment(ref: TrackerRef, c: { marker: string; body: string; knownId?: string }): Promise<{ commentId: string }> {
    const key = this.#key(ref);
    if (c.knownId !== undefined) {
      const kept = await this.#update(key, c.knownId, c.marker, c.body);
      if (kept) return { commentId: c.knownId };
    }
    const own = await this.#ownComment(key, c.marker);
    return { commentId: await this.#write(key, c.marker, c.body, own?.id) };
  }

  async transition(ref: TrackerRef, state: string): Promise<void> {
    await this.#command(this.#key(ref), `State ${commandValue(state)}`);
  }

  async markDuplicate(dup: TrackerRef, of: TrackerRef): Promise<void> {
    await this.#command(this.#key(dup), `duplicates ${this.#key(of)}`);
  }

  async assign(ref: TrackerRef, login: string): Promise<void> {
    await this.#command(this.#key(ref), `Assignee ${commandValue(login)}`);
  }

  viewer(): Promise<string> {
    this.#viewer ??= this.#client.get('/api/users/me', { fields: 'login' }, z.object({ login: z.string() }).passthrough())
      .then((me) => me.login);
    this.#viewer.catch(() => { this.#viewer = null; });
    return this.#viewer;
  }

  /** `https://acme.youtrack.cloud/issue/GAR-12/some-slug` is `youtrack:GAR-12` when GAR is this project. */
  refFromUrl(url: string): TrackerRef | null {
    const prefix = `${this.#client.base}/issue/`;
    if (!url.startsWith(prefix)) return null;
    const m = url.slice(prefix.length).match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)(?:[/?#]|$)/);
    if (m === null || m[1]!.toUpperCase() !== this.#project.toUpperCase()) return null;
    return trackerRef('youtrack', `${m[1]}-${m[2]}`);
  }

  // ---------------------------------------------------------------- internals

  async #issues(query: string, limit: number): Promise<readonly TrackerItem[]> {
    const rows = await this.#client.get('/api/issues', { query, fields: ISSUE_FIELDS, $top: limit }, z.array(issueSchema));
    return rows.map((r) => this.#item(r));
  }

  #item(raw: RawIssue): TrackerItem {
    const field = (name: string): unknown => raw.customFields?.find((f) => f.name === name)?.value ?? null;
    const type = valueName(field('Type'));
    return {
      ref: trackerRef('youtrack', raw.idReadable),
      key: raw.idReadable,
      url: `${this.#client.base}/issue/${raw.idReadable}`,
      title: raw.summary ?? '',
      description: raw.description ?? '',
      state: valueName(field('State')) ?? '',
      assignee: valueLogin(field('Assignee')),
      updatedAt: new Date(raw.updated ?? raw.created ?? 0).toISOString(),
      createdAt: new Date(raw.created ?? 0).toISOString(),
      ...(type !== null ? { type } : {}),
      // Only what YouTrack answered: an answer without them says nothing either way.
      ...(raw.subtasks !== undefined && raw.subtasks !== null
        ? { subtasks: (raw.subtasks.issues ?? []).filter((i) => i.resolved === null || i.resolved === undefined).length }
        : {}),
      ...(raw.tags !== undefined && raw.tags !== null
        ? { tags: raw.tags.map((t) => t.name ?? '').filter((n) => n !== '') }
        : {}),
    };
  }

  #key(ref: TrackerRef): string {
    if (!ref.startsWith('youtrack:')) throw TandemiseError.validation(`'${ref}' is not a YouTrack item.`, { ref });
    return ref.slice('youtrack:'.length);
  }

  /** A short name with a space would split the query; YouTrack takes braces for that. */
  #projectTerm(): string {
    return /\s/.test(this.#project) ? `{${this.#project}}` : this.#project;
  }

  #projectIdOnce(): Promise<string> {
    this.#projectId ??= this.#client
      .get('/api/admin/projects', { fields: 'id,shortName', query: this.#project }, z.array(z.object({ id: z.string(), shortName: z.string().nullish() }).passthrough()))
      .then((rows) => {
        const row = rows.find((p) => p.shortName === this.#project);
        if (row === undefined) {
          throw new TandemiseError('PRECONDITION_FAILED', `YouTrack has no project '${this.#project}', or this token cannot see it.`);
        }
        return row.id;
      });
    this.#projectId.catch(() => { this.#projectId = null; });
    return this.#projectId;
  }

  async #command(key: string, query: string): Promise<void> {
    await this.#client.post('/api/commands', {}, { query, issues: [{ idReadable: key }] }, z.unknown());
  }

  /**
   * The comment for `marker` that the signed-in user wrote, if any. Only
   * theirs: anyone can paste a marker, and adopting their comment would let
   * them steer what Tandemise edits (P14 ruling 8).
   */
  async #ownComment(key: string, marker: string): Promise<RawComment | undefined> {
    const [me, comments] = await Promise.all([
      this.viewer(),
      this.#client.get(`/api/issues/${encodeURIComponent(key)}/comments`, { fields: COMMENT_FIELDS, $top: MAX_COMMENTS }, z.array(commentSchema)),
    ]);
    const line = markerLine(marker);
    return comments.find((c) => c.author?.login === me && (c.text ?? '').trimStart().startsWith(line));
  }

  /** Edits `commentId` when given and still there, posts a new comment otherwise; returns the id. */
  async #write(key: string, marker: string, body: string, commentId: string | undefined): Promise<string> {
    if (commentId !== undefined && (await this.#update(key, commentId, marker, body))) return commentId;
    const posted = await this.#client.post(
      `/api/issues/${encodeURIComponent(key)}/comments`,
      { fields: 'id' },
      { text: commentText(marker, body) },
      idSchema,
    );
    return posted.id;
  }

  /** False when the comment is gone (a 404), so the caller looks again. */
  async #update(key: string, commentId: string, marker: string, body: string): Promise<boolean> {
    try {
      await this.#client.post(
        `/api/issues/${encodeURIComponent(key)}/comments/${encodeURIComponent(commentId)}`,
        { fields: 'id' },
        { text: commentText(marker, body) },
        z.unknown(),
      );
      return true;
    } catch (e) {
      if (isTandemiseError(e) && e.code === 'NOT_FOUND') return false;
      throw e;
    }
  }
}

/**
 * A value as a YouTrack command takes it: a value with a space is braced
 * (`State {In Progress}`, `Subsystem {Web App}`), or YouTrack would read its
 * second word as the start of another command (RULINGS ruling 9).
 */
function commandValue(value: string): string {
  return /\s/.test(value) ? `{${value}}` : value;
}

function commentText(marker: string, body: string): string {
  return `${markerLine(marker)}\n\n${body}`;
}

function valueName(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') return (v as { name: string }).name;
  return null;
}

function valueLogin(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v !== null && typeof v === 'object') {
    const login = (v as { login?: unknown }).login;
    if (typeof login === 'string') return login;
  }
  return valueName(v);
}
