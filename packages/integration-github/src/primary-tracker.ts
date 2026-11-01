import { z } from 'zod';
import { isTandemiseError, TandemiseError } from '@tandemise/shared';
import {
  markerLine, sourcesCommentWith, splitGithubRepo, titleTokens, trackerRef,
  type AttachmentRef, type PrimaryTracker, type PrimaryTrackerFactory, type SourceEntry, type TrackerConfig,
  type TrackerDescription, type TrackerItem, type TrackerRef, type UpstreamComment,
} from '@tandemise/domain';
import { RateGate, type CommandExecutor } from '@tandemise/integrations-core';
import { gh, ghJson, type GhContext } from './gh.js';
import { GhIssueTracker } from './issues.js';

/** What every issue read asks `gh` for. `gh search issues` knows the same names. */
const ITEM_FIELDS = 'number,title,body,url,createdAt,updatedAt,labels,state,assignees';
/** The title words a similarity search sends, as YouTrack's (spec §5 step 4). */
const MAX_SEARCH_WORDS = 8;
/** Enough labels for any repository a team keeps states in. */
const MAX_LABELS = 200;

const itemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  url: z.string(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  labels: z.array(z.object({ name: z.string() }).passthrough()).nullish(),
  // `gh issue` answers OPEN/CLOSED, `gh search issues` open/closed.
  state: z.string().nullish(),
  assignees: z.array(z.object({ login: z.string() }).passthrough()).nullish(),
}).passthrough();
type RawItem = z.infer<typeof itemSchema>;

export interface GhPrimaryTrackerConfig {
  /** `owner/name`, or `host/owner/name` for GitHub Enterprise. */
  readonly repo: string;
  /**
   * The mapped states that are labels: every mapped state but `open` and
   * `closed`, in the mapping's order. An open issue's state is the first of
   * these it carries (plan Task 5).
   */
  readonly stateLabels: readonly string[];
  /** For tests only; `Date.now` otherwise. The clock rate-limit waits are measured on (Ruling 26). */
  readonly now?: () => number;
}

/**
 * What `gh` prints when GitHub limits the caller: the secondary limit ("You
 * have exceeded a secondary rate limit"), the primary one ("API rate limit
 * exceeded"), or a plain 429. `gh` shows no `Retry-After`, so the wait is a
 * minute (Ruling 26).
 */
const GH_RATE_LIMITED = /secondary rate limit|api rate limit exceeded|rate limit exceeded|HTTP 429/i;
const GH_RATE_WAIT_MS = 60_000;
/** The one duplicate note per issue, found again by this marker so a repeated merge edits it (Ruling 26). */
const DUPLICATE_MARKER = 'tandemise:duplicate';

/**
 * GitHub Issues as a project's primary tracker (spec §6, plan Task 5), over
 * the `gh` CLI like P14.
 *
 * GitHub has two states of its own, open and closed; every other state a team
 * maps is a label (`status: in progress`), and Tandemise keeps at most one of
 * those on an issue. Comments go through `GhIssueTracker`'s helpers, composed
 * rather than extended so P14's tracker stays exactly as it is, and follow the
 * same rules as YouTrack's: one per `(item, marker)`, adopted by marker only
 * from the signed-in user (P14 rulings 7 and 8). GitHub has no upload API for
 * issue attachments, so attachments are the caller's to link.
 */
export class GhPrimaryTracker implements PrimaryTracker {
  readonly kind = 'github-issues';
  readonly capabilities = { editComments: true, attachments: false, duplicateLinks: false } as const;
  readonly #issues: GhIssueTracker;
  readonly #ctx: GhContext;
  readonly #repo: string;
  readonly #stateLabels: readonly string[];
  readonly #timeoutMs: number;
  #viewer: Promise<string> | null = null;

  constructor(exec: CommandExecutor, config: GhPrimaryTrackerConfig, timeoutMs = 60_000) {
    // Every gh call of this tracker, its comments included, goes through one rate gate (Ruling 26).
    const paced = pacedExecutor(exec, new RateGate('GitHub', config.now ?? Date.now));
    this.#issues = new GhIssueTracker(paced, timeoutMs);
    this.#ctx = { exec: paced };
    this.#repo = config.repo;
    this.#stateLabels = config.stateLabels;
    this.#timeoutMs = timeoutMs;
  }

  async describe(): Promise<TrackerDescription> {
    const labels = await ghJson(this.#ctx, [
      'label', 'list', '--repo', this.#repo, '--limit', String(MAX_LABELS), '--json', 'name',
    ], z.array(z.object({ name: z.string() }).passthrough()), this.#opts());
    // GitHub has no types or custom fields: a `create` rule's type has nowhere to go.
    return { states: ['open', 'closed', ...labels.map((l) => l.name)], types: [], fields: [] };
  }

  /**
   * `url`: GitHub's search for the URL as a phrase, which looks in titles,
   * bodies and comments (where the sources comment lists every linked URL).
   * `text`: the title's words, at most 8, in titles only.
   */
  async search(q: { url?: string; text?: string; unresolvedOnly?: boolean; limit: number }): Promise<readonly TrackerItem[]> {
    const state = q.unresolvedOnly === true ? 'open' : 'all';
    if (q.url !== undefined) {
      // A quote would end the phrase early; a URL that needs one matches nothing exact anyway.
      const rows = await this.#list([
        'search', 'issues', `"${q.url.replace(/"/g, '')}"`, '--repo', this.#repo,
        ...(q.unresolvedOnly === true ? ['--state', 'open'] : []),
        '--limit', String(q.limit), '--json', ITEM_FIELDS,
      ]);
      return rows;
    }
    if (q.text === undefined) return [];
    const words = titleTokens(q.text).slice(0, MAX_SEARCH_WORDS);
    // No words would ask for every item: that is not a candidate list.
    if (words.length === 0) return [];
    return this.#list([
      'issue', 'list', '--repo', this.#repo, '--search', `${words.join(' ')} in:title`, '--state', state,
      '--limit', String(q.limit), '--json', ITEM_FIELDS,
    ]);
  }

  async board(q: { query: string; updatedSince?: string; limit: number }): Promise<readonly TrackerItem[]> {
    // `--state all` so the team's own query (`is:open …`) decides, sent as they wrote it.
    const items = await this.#list([
      'issue', 'list', '--repo', this.#repo, '--search', q.query, '--state', 'all', '--limit', String(q.limit), '--json', ITEM_FIELDS,
    ]);
    if (q.updatedSince === undefined) return items;
    const since = Date.parse(q.updatedSince);
    return Number.isNaN(since) ? items : items.filter((i) => Date.parse(i.updatedAt) >= since);
  }

  async get(ref: TrackerRef): Promise<TrackerItem> {
    return this.#item(await this.#raw(this.#number(ref), ref));
  }

  async create(draft: {
    title: string;
    description: string;
    type?: string;
    fields?: Readonly<Record<string, string>>;
    attachments?: readonly AttachmentRef[];
  }): Promise<TrackerItem> {
    // `gh issue create` answers the new issue's URL; there is no --json.
    const made = await gh(this.#ctx, [
      'issue', 'create', '--repo', this.#repo, '--title', draft.title, '--body', draft.description,
    ], this.#opts());
    const url = made.stdout.trim().split(/\s+/).pop() ?? '';
    const number = /\/issues\/(\d+)$/.exec(url)?.[1];
    if (number === undefined) {
      throw new TandemiseError('INTEGRATION_FAILED', `gh issue create did not answer an issue URL: ${made.stdout.slice(0, 200)}`);
    }
    return this.get(this.#ref(Number(number)));
  }

  async link(ref: TrackerRef, source: SourceEntry): Promise<void> {
    const number = this.#number(ref);
    const own = await this.#ownComment(number, 'tandemise:sources');
    await this.#write(number, 'tandemise:sources', sourcesCommentWith(own?.body ?? null, source), own?.id);
  }

  async comment(ref: TrackerRef, c: { marker: string; body: string; knownId?: string }): Promise<{ commentId: string }> {
    const number = this.#number(ref);
    if (c.knownId !== undefined && (await this.#update(c.knownId, c.marker, c.body))) return { commentId: c.knownId };
    const own = await this.#ownComment(number, c.marker);
    return { commentId: await this.#write(number, c.marker, c.body, own?.id) };
  }

  /**
   * `closed` closes; `open` reopens and drops every state label; a mapped
   * label reopens if needed, adds the label and drops the other state labels,
   * so an issue carries at most one.
   */
  async transition(ref: TrackerRef, state: string): Promise<void> {
    const number = this.#number(ref);
    if (state === 'closed') {
      await gh(this.#ctx, ['issue', 'close', String(number), '--repo', this.#repo], this.#opts());
      return;
    }
    if (state !== 'open' && !this.#stateLabels.includes(state)) {
      throw TandemiseError.validation(`'${state}' is not a state this project maps for ${this.#repo}.`, { state });
    }
    const raw = await this.#raw(number, ref);
    if (isClosed(raw)) await gh(this.#ctx, ['issue', 'reopen', String(number), '--repo', this.#repo], this.#opts());
    const carried = new Set((raw.labels ?? []).map((l) => l.name));
    const add = state !== 'open' && !carried.has(state) ? [state] : [];
    const remove = this.#stateLabels.filter((l) => l !== state && carried.has(l));
    if (add.length === 0 && remove.length === 0) return;
    // `--add-label` fails on a label the repository doesn't have yet (a project
    // that just adopted its issues as the board): create it first. `--force`
    // makes this a no-op when it exists (Ruling 16).
    for (const label of add) {
      await gh(this.#ctx, ['label', 'create', label, '--repo', this.#repo, '--force'], this.#opts());
    }
    // One flag per label: `gh` would split a single comma-joined value.
    await gh(this.#ctx, [
      'issue', 'edit', String(number), '--repo', this.#repo,
      ...add.flatMap((l) => ['--add-label', l]),
      ...remove.flatMap((l) => ['--remove-label', l]),
    ], this.#opts());
  }

  /**
   * GitHub has no native duplicate link: a comment says which, then the
   * duplicate is closed. The comment carries its own marker, so a repeated
   * merge edits it instead of adding another (Ruling 26).
   */
  async markDuplicate(dup: TrackerRef, of: TrackerRef): Promise<void> {
    const number = this.#number(dup);
    const own = await this.#ownComment(number, DUPLICATE_MARKER);
    await this.#write(number, DUPLICATE_MARKER, `Duplicate of #${this.#number(of)}.`, own?.id);
    await gh(this.#ctx, ['issue', 'close', String(number), '--repo', this.#repo], this.#opts());
  }

  async assign(ref: TrackerRef, login: string): Promise<void> {
    await gh(this.#ctx, ['issue', 'edit', String(this.#number(ref)), '--repo', this.#repo, '--add-assignee', login], this.#opts());
  }

  viewer(): Promise<string> {
    this.#viewer ??= this.#issues.viewer({ repo: this.#repo });
    this.#viewer.catch(() => { this.#viewer = null; });
    return this.#viewer;
  }

  /** `https://github.com/acme/web/issues/42` is `github:acme/web#42` when acme/web is this repository. */
  refFromUrl(url: string): TrackerRef | null {
    const { host, path } = splitGithubRepo(this.#repo);
    const prefix = `https://${host ?? 'github.com'}/`;
    if (!url.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    const m = /^([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#]|$)/.exec(url.slice(prefix.length));
    if (m === null || m[1]!.toLowerCase() !== path.toLowerCase()) return null;
    return this.#ref(Number(m[2]));
  }

  // ---------------------------------------------------------------- internals

  #opts(): { timeoutMs: number } {
    return { timeoutMs: this.#timeoutMs };
  }

  async #list(args: readonly string[]): Promise<readonly TrackerItem[]> {
    const rows = await ghJson(this.#ctx, args, z.array(itemSchema), this.#opts());
    return rows.map((r) => this.#item(r));
  }

  async #raw(number: number, ref: TrackerRef): Promise<RawItem> {
    try {
      return await ghJson(this.#ctx, ['issue', 'view', String(number), '--repo', this.#repo, '--json', ITEM_FIELDS], itemSchema, this.#opts());
    } catch (e) {
      // gh says "Could not resolve to an issue or pull request with the number of N".
      if (isTandemiseError(e) && (e.code === 'NOT_FOUND' || /could not resolve to an issue/i.test(e.message))) {
        throw new TandemiseError('NOT_FOUND', `GitHub has no issue #${number} in ${this.#repo}.`, { details: { ref } });
      }
      throw e;
    }
  }

  #item(raw: RawItem): TrackerItem {
    const labels = new Set((raw.labels ?? []).map((l) => l.name));
    const state = isClosed(raw) ? 'closed' : (this.#stateLabels.find((l) => labels.has(l)) ?? 'open');
    const updatedAt = raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString();
    // #136: the labels that are not states are the item's tags, which `repoTag`
    // reads. Sub-issues and issue types are left out: only recent `gh` versions
    // know `subIssuesSummary` and `issueType`, and an older one refuses the
    // whole read for an unknown field. So on GitHub a container is not told
    // apart, and `buildTypes` has no type to compare.
    const tags = [...labels].filter((l) => !this.#stateLabels.includes(l));
    return {
      ref: this.#ref(raw.number),
      key: `#${raw.number}`,
      url: raw.url,
      title: raw.title,
      description: raw.body ?? '',
      state,
      assignee: raw.assignees?.[0]?.login ?? null,
      updatedAt,
      createdAt: raw.createdAt ?? updatedAt,
      tags,
    };
  }

  #ref(number: number): TrackerRef {
    return trackerRef('github', `${this.#repo}#${number}`);
  }

  #number(ref: TrackerRef): number {
    const prefix = `github:${this.#repo}#`;
    const n = ref.startsWith(prefix) ? Number(ref.slice(prefix.length)) : NaN;
    if (!Number.isInteger(n) || n <= 0) throw TandemiseError.validation(`'${ref}' is not an issue of ${this.#repo}.`, { ref });
    return n;
  }

  /**
   * The comment for `marker` that the signed-in user wrote, if any. Only
   * theirs: anyone can paste a marker (P14 ruling 8).
   */
  async #ownComment(number: number, marker: string): Promise<UpstreamComment | undefined> {
    const [me, comments] = await Promise.all([this.viewer(), this.#issues.comments({ repo: this.#repo, number })]);
    const line = markerLine(marker);
    return comments.find((c) => c.author === me && c.body.trimStart().startsWith(line));
  }

  async #write(number: number, marker: string, body: string, commentId: string | undefined): Promise<string> {
    if (commentId !== undefined && (await this.#update(commentId, marker, body))) return commentId;
    return this.#issues.postComment({ repo: this.#repo, number, body: commentText(marker, body) });
  }

  /** False when the comment is gone (a 404), so the caller looks again. */
  async #update(commentId: string, marker: string, body: string): Promise<boolean> {
    try {
      await this.#issues.updateComment({ repo: this.#repo, commentId, body: commentText(marker, body) });
      return true;
    } catch (e) {
      if (isTandemiseError(e) && e.code === 'NOT_FOUND') return false;
      throw e;
    }
  }
}

/**
 * `exec` behind the tracker's rate gate (Ruling 26): while GitHub's wait
 * lasts no `gh` runs, and a run that `gh` reports rate-limited starts the
 * wait and fails in the gate's plain sentence rather than as a refusal.
 */
function pacedExecutor(exec: CommandExecutor, gate: RateGate): CommandExecutor {
  return {
    run: async (req) => {
      gate.check();
      const result = await exec.run(req);
      if (result.exitCode !== 0 && GH_RATE_LIMITED.test(result.stderr)) throw gate.wait(GH_RATE_WAIT_MS);
      return result;
    },
  };
}

function isClosed(raw: RawItem): boolean {
  return (raw.state ?? '').toUpperCase() === 'CLOSED';
}

function commentText(marker: string, body: string): string {
  return `${markerLine(marker)}\n\n${body}`;
}

/** Every mapped state that is a label: all but GitHub's own `open` and `closed`, once each, in the mapping's order. */
export function githubStateLabels(states: TrackerConfig['states']): readonly string[] {
  const named = [...states.ready, states.in_progress, ...(states.in_review === undefined ? [] : [states.in_review]), ...states.done, ...states.wont_do];
  return [...new Set(named.filter((s) => s !== 'open' && s !== 'closed'))];
}

/**
 * Builds a project's GitHub Issues tracker (plan Task 5). `gh`'s own sign-in
 * is the credential, as for P14, so the secret store holds nothing for it.
 */
export function githubTrackerFactory(exec: () => CommandExecutor): PrimaryTrackerFactory {
  return {
    kind: 'github-issues',
    create(config) {
      if (config.repo === undefined || config.repo === '') {
        throw new TandemiseError('PRECONDITION_FAILED', "Set this project's GitHub repository first.");
      }
      return new GhPrimaryTracker(exec(), { repo: config.repo, stateLabels: githubStateLabels(config.states) });
    },
  };
}
