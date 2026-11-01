import type { Brand, Timestamp, TrackerItemId, WorkspaceId } from '@tandemise/shared';
import type { TrackerConfig } from './intake.js';
import { criteriaResultTable, escapeForComment, type CompletedCriterion } from './issue.js';
import type { MissionStatus } from './mission.js';
import type { TaskStatus } from './task.js';

/**
 * The project's primary tracker, as Tandemise sees it (spec §6).
 *
 * Plan Task 2 declares the item shapes here so the store can cache the board;
 * Task 4 adds `trackerRef()` and the pure helpers both adapters share. The
 * port itself is `PrimaryTracker` in `ports/intake.ts`.
 */

/**
 * A tracker item's normalised reference, `<tracker>:<key>` (`youtrack:GAR-12`,
 * `github:acme/web#42`), the relay's normalisation. Stored as plain text.
 */
export type TrackerRef = Brand<string, 'TrackerRef'>;

/** `trackerRef('youtrack', 'GAR-12')` is `youtrack:GAR-12`; `trackerRef('github', 'acme/web#42')` is `github:acme/web#42`. */
export function trackerRef(kind: 'youtrack' | 'github', key: string): TrackerRef {
  return `${kind}:${key}` as TrackerRef;
}

/**
 * One item as the tracker reports it (spec §6), plus `createdAt`, which the
 * board needs to keep the older of two duplicates (plan Task 8).
 */
export interface TrackerItem {
  readonly ref: TrackerRef;
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly state: string;
  readonly assignee: string | null;
  /** ISO 8601, the tracker's own. */
  readonly updatedAt: string;
  /** ISO 8601, the tracker's own. */
  readonly createdAt: string;
  readonly type?: string;
  /**
   * How many of its subtasks are still open, when the tracker says (#136): an
   * item with any is a container, and Start offers its subtasks instead.
   * Absent when the tracker cannot tell (GitHub Issues through `gh`).
   */
  readonly subtasks?: number;
  /**
   * The item's tags (YouTrack) or its labels that are not mapped states
   * (GitHub), as written. `repoTag` reads them to tell another repository's
   * item. Absent when the tracker has none to give.
   */
  readonly tags?: readonly string[];
}

/** A cached board item: the tracker's item plus what Tandemise keeps about it. */
export interface TrackedItem extends TrackerItem {
  readonly id: TrackerItemId;
  readonly workspaceId: WorkspaceId;
  /**
   * The state Tandemise last wrote; null if it never wrote one. Write-back
   * moves the item only while it is still in this state, so a person's own
   * change always wins (spec §6.3, plan Review Focus 3).
   */
  readonly writtenState: string | null;
  readonly refreshedAt: Timestamp;
}

/** The two comments Tandemise keeps on an item, one each (spec §6, P14 rulings 7 and 8). */
export const TRACKER_COMMENT_MARKERS = ['tandemise:sources', 'tandemise:activity'] as const;
export type TrackerCommentMarker = (typeof TRACKER_COMMENT_MARKERS)[number];

/** The comment Tandemise wrote per `(item, marker)`, with the body last written. */
export interface TrackerCommentRow {
  readonly workspaceId: WorkspaceId;
  readonly itemRef: string;
  readonly marker: TrackerCommentMarker;
  readonly commentId: string;
  readonly body: string;
  readonly postedAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** The line a Tandemise comment starts with, so it is found again after a crash (P14 ruling 7). */
export function markerLine(marker: string): string {
  return `<!-- ${marker} -->`;
}

// ------------------------------------------------------------------ the Sources section (spec §5 step 3, §6.1)

const SOURCES_HEADING = '## Sources';
const URL_RE = /https?:\/\/\S+/g;
/** How many lines of a source's context the sources comment keeps. */
const MAX_CONTEXT_LINES = 6;

/**
 * The Sources section of a created item's description: one `- ` line per
 * source, each ending with its URL (`- Sentry · acme/web · 132 events, 41 users · <url>`).
 * The lines are already rendered (and escaped) by the caller.
 */
export function sourcesSection(lines: readonly string[]): string {
  return [SOURCES_HEADING, ...lines.map((l) => `- ${l}`)].join('\n');
}

/**
 * The source URLs a description or a sources comment lists, in order: the
 * last URL of every `- ` line under `## Sources`, up to the first line that is
 * neither an entry nor an entry's indented context. This is what exact-URL
 * dedupe matches (spec §5 step 3).
 */
export function parseSourcesSection(description: string): readonly string[] {
  return sourceBlocks(description).map((b) => b.url);
}

/** One source of an item, as `PrimaryTracker.link` receives it. */
export interface SourceEntry {
  readonly url: string;
  readonly title: string;
  /** A few lines: impact, reporter, the first lines of the description. Copied text, escaped on render. */
  readonly context: string;
}

/**
 * The body of the `tandemise:sources` comment (without its marker line, which
 * the adapter's `comment()` puts first): the Sources section with one entry per
 * URL and its context indented under it.
 */
export function sourcesCommentBody(entries: readonly SourceEntry[]): string {
  const blocks: { url: string; text: string }[] = [];
  for (const e of entries) upsertBlock(blocks, e);
  return renderBlocks(blocks);
}

/**
 * The sources comment with `source` added: a URL already listed has its entry
 * replaced in place (the latest context wins), a new one is appended (spec
 * §6.1: the comment is edited as sources are added, never re-posted).
 * `existing` is the comment's current text, marker line included, or null.
 */
export function sourcesCommentWith(existing: string | null, source: SourceEntry): string {
  const blocks = existing === null ? [] : sourceBlocks(existing).map((b) => ({ url: b.url, text: b.text }));
  upsertBlock(blocks, source);
  return renderBlocks(blocks);
}

function renderEntry(e: SourceEntry): string {
  const context = e.context.split(/\r?\n/).map((l) => escapeForComment(l)).filter((l) => l.length > 0).slice(0, MAX_CONTEXT_LINES);
  return [`- ${escapeForComment(e.title)} · ${e.url}`, ...context.map((l) => `  > ${l}`)].join('\n');
}

function upsertBlock(blocks: { url: string; text: string }[], e: SourceEntry): void {
  const text = renderEntry(e);
  const at = blocks.findIndex((b) => b.url === e.url);
  if (at >= 0) blocks[at] = { url: e.url, text };
  else blocks.push({ url: e.url, text });
}

function renderBlocks(blocks: readonly { text: string }[]): string {
  return [SOURCES_HEADING, ...blocks.map((b) => b.text)].join('\n');
}

function sourceBlocks(text: string): { url: string; text: string }[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === SOURCES_HEADING);
  if (start < 0) return [];
  const blocks: { url: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) {
      const urls = line.match(URL_RE);
      if (urls === null) break;
      blocks.push({ url: urls[urls.length - 1]!, lines: [line] });
    } else if (line.startsWith('  ') && blocks.length > 0 && line.trim().length > 0) {
      blocks[blocks.length - 1]!.lines.push(line);
    } else {
      break;
    }
  }
  return blocks.map((b) => ({ url: b.url, text: b.lines.join('\n') }));
}

// ------------------------------------------------------------------ state mapping (spec §6.2)

const TRACKER_LABELS: Readonly<Record<string, string>> = { youtrack: 'YouTrack', 'github-issues': 'GitHub' };

/** The words a tracker kind reads as: `YouTrack`, `GitHub`; an unknown kind as itself. */
export function trackerLabel(kind: string): string {
  return TRACKER_LABELS[kind] ?? kind;
}

/**
 * Why a project's state mapping cannot be used with its tracker, in the words
 * the project's settings show, or null when it can (spec §6.2). Every mapped
 * state must be one the tracker has (`describe().states`), and without an
 * `in_review` state a finished mission can only be marked done.
 */
export function stateMappingProblem(
  mapping: Pick<TrackerConfig, 'kind' | 'project' | 'repo' | 'states' | 'onComplete'>,
  described: { readonly states: readonly string[] },
): string | null {
  const s = mapping.states;
  const named = [...s.ready, s.in_progress, ...(s.in_review === undefined ? [] : [s.in_review]), ...s.done, ...s.wont_do, ...(s.draft ?? [])];
  const missing = named.find((state) => !described.states.includes(state));
  if (missing !== undefined) {
    const tracker = TRACKER_LABELS[mapping.kind] ?? mapping.kind;
    const where = mapping.project ?? mapping.repo ?? 'this project';
    return `${tracker} has no state '${missing}' in ${where}. Its states are: ${described.states.join(', ')}.`;
  }
  if (s.in_review === undefined && mapping.onComplete === 'in_review') {
    return 'Without an in-review state, a finished mission can only mark the task done.';
  }
  return null;
}

// ------------------------------------------------------------------ Start (spec §7, plan Task 8)

/**
 * Why an item must not be started in this project, as the Board says it beside
 * a disabled Start and `start` refuses it, or null when it may be (#136). Read
 * from what the tracker reported, with the project's tracker config:
 *
 *  - an item tagged for another repository: with `repoTag: repo:web`, an item
 *    carrying `repo:api` (a tag with the same prefix, up to and including its
 *    first `:`) and not `repo:web` "Belongs to another repository (repo:api)."
 *    An item with no such tag is this project's;
 *  - a type the project does not build: with `buildTypes: [Bug, Task]`, a
 *    Spike is "Spike: this project starts Bug and Task items." An item with no
 *    type, or no `buildTypes`, is buildable;
 *  - a container: an item with open subtasks "Has 4 subtasks. Start one of them."
 *
 * Checked in that order: another repository's container is still not ours.
 * Tags and types match without regard to case.
 */
export function startRefusal(
  item: Pick<TrackerItem, 'type' | 'subtasks' | 'tags'>,
  config: Pick<TrackerConfig, 'buildTypes' | 'repoTag'>,
): string | null {
  const repoTag = config.repoTag?.trim();
  if (repoTag !== undefined && repoTag.includes(':')) {
    const prefix = repoTag.slice(0, repoTag.indexOf(':') + 1).toLowerCase();
    const tags = item.tags ?? [];
    const ours = tags.some((t) => t.trim().toLowerCase() === repoTag.toLowerCase());
    const other = tags.find((t) => t.trim().toLowerCase().startsWith(prefix) && t.trim().toLowerCase() !== repoTag.toLowerCase());
    if (!ours && other !== undefined) return `Belongs to another repository (${other.trim()}).`;
  }
  const buildTypes = (config.buildTypes ?? []).map((t) => t.trim()).filter((t) => t !== '');
  const type = item.type?.trim();
  if (buildTypes.length > 0 && type !== undefined && type !== '' && !buildTypes.some((t) => t.toLowerCase() === type.toLowerCase())) {
    return `${type}: this project starts ${andList(buildTypes)} items.`;
  }
  const open = item.subtasks ?? 0;
  if (open > 0) return open === 1 ? 'Has 1 subtask. Start it instead.' : `Has ${open} subtasks. Start one of them.`;
  return null;
}

/** `Bug`, `Bug and Task`, `Bug, Task and Story`. */
function andList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** `mission_criteria.decided_by` for the Done-when lines parsed from a tracker item, as P14's `ISSUE_CRITERIA_AUTHOR`. */
export const TRACKER_CRITERIA_AUTHOR = 'tracker';
/** A mission goal's limit (the create request's). */
const MAX_TRACKER_GOAL = 8000;

/** One linked signal, as the goal lists it: `- <label> · <instance> · <context>`. */
export interface TrackerGoalSource {
  readonly label: string;
  readonly instance: string;
  readonly context: string;
}

/**
 * The goal of a mission started from a tracker item (spec §7 step 3): the item
 * attributed to who started it and quoted as data, then each source's context.
 *
 *     YouTrack GAR-12, started by Ana: <url>
 *
 *     The task as written in the tracker:
 *
 *     <title>
 *
 *     <description>
 *
 *     Sources:
 *     - Sentry · acme/web · 132 events, 41 users
 *
 * It names the starter rather than the spec's "you": teammates and agents read
 * the goal too. An empty description or no linked signal leaves its part out,
 * and the whole is cut to 8000 characters, the create request's limit.
 */
export function trackerGoal(input: {
  readonly label: string;
  readonly key: string;
  readonly starterName: string;
  readonly url: string;
  readonly title: string;
  readonly description: string;
  readonly sources: readonly TrackerGoalSource[];
}): string {
  const parts = [`${input.label} ${input.key}, started by ${input.starterName}: ${input.url}`, 'The task as written in the tracker:', oneLine(input.title)];
  const description = input.description.replace(/\r\n?/g, '\n').trim();
  if (description.length > 0) parts.push(description);
  let goal = parts.join('\n\n');
  if (input.sources.length > 0) {
    goal += `\n\nSources:\n${input.sources.map((s) => `- ${[s.label, s.instance, oneLine(s.context)].filter((x) => x !== '').join(' · ')}`).join('\n')}`;
  }
  return goal.length <= MAX_TRACKER_GOAL ? goal : `${goal.slice(0, MAX_TRACKER_GOAL - 1)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ write-back (spec §7, plan Task 9)

/** One plan step as the activity comment lists it. */
export type ActivityStepState = 'todo' | 'running' | 'held' | 'waiting' | 'done';

export interface ActivityStep {
  readonly title: string;
  readonly state: ActivityStepState;
}

/**
 * A plan step's line state from its task status (RULINGS ruling 14): finished
 * or skipped is done; a person to answer, act or approve is waiting; blocked or
 * failed is held; running, or polling something outside, is running; anything
 * not started yet (or cancelled with the plan) is still to do.
 */
export function activityStepState(status: TaskStatus): ActivityStepState {
  switch (status) {
    case 'SUCCEEDED': case 'SKIPPED': return 'done';
    case 'AWAITING_INPUT': case 'AWAITING_HUMAN': case 'AWAITING_APPROVAL': return 'waiting';
    case 'BLOCKED': case 'FAILED': return 'held';
    case 'RUNNING': case 'AWAITING_EXTERNAL': return 'running';
    default: return 'todo';
  }
}

export interface ActivityCommentInput {
  readonly starter: string;
  readonly missionTitle: string;
  /** The approved plan's steps, in order; null before a plan is approved. */
  readonly steps: readonly ActivityStep[] | null;
  readonly prUrl: string | null;
  readonly completed: { readonly rows: readonly CompletedCriterion[] } | null;
  readonly cancelled: { readonly readyState: string } | null;
  /** The "Refined in Tandemise by …" line written when the draft was made ready (#135), kept on top. */
  readonly refined?: string | null;
}

/**
 * The `tandemise:activity` comment, derived from the mission's state alone
 * (spec §7 "How the tracker shows progress"), so the latest state always lands
 * on a later pass and a restart writes nothing new. It has no marker line: the
 * adapter's `comment()` puts it first (RULINGS ruling 14).
 *
 *     Started in Tandemise by Ana: Checkout fails on Safari.
 *
 *     Plan:
 *     - [x] Reproduce
 *     - [ ] Fix — running
 *
 *     Pull request: https://github.com/acme/web/pull/7
 *
 *     Done in Tandemise — 1 of 1 criteria verified.
 *
 *     | Key | Criterion | Result |
 *     ...
 */
export function activityCommentBody(input: ActivityCommentInput): string {
  const lines = [...(input.refined === undefined || input.refined === null ? [] : [input.refined, '']), `Started in Tandemise by ${escapeForComment(oneLine(input.starter))}: ${escapeForComment(oneLine(input.missionTitle))}.`];
  if (input.steps !== null && input.steps.length > 0) {
    lines.push('', 'Plan:', ...input.steps.map(stepLine));
  }
  if (input.prUrl !== null) lines.push('', `Pull request: ${input.prUrl}`);
  if (input.completed !== null) {
    const rows = input.completed.rows;
    const verified = rows.filter((r) => r.result === 'PASS').length;
    lines.push('', `Done in Tandemise — ${verified} of ${rows.length} criteria verified.`);
    if (rows.length > 0) lines.push('', ...criteriaResultTable(rows));
  }
  if (input.cancelled !== null) lines.push('', `Stopped in Tandemise; moved back to ${escapeForComment(input.cancelled.readyState)}.`);
  return lines.join('\n');
}

function stepLine(step: ActivityStep): string {
  const title = escapeForComment(oneLine(step.title));
  switch (step.state) {
    case 'done': return `- [x] ${title}`;
    case 'running': return `- [ ] ${title} — running`;
    case 'held': return `- [ ] ${title} — held`;
    case 'waiting': return `- [ ] ${title} — waiting for a person`;
    default: return `- [ ] ${title}`;
  }
}

/**
 * The milestones a tracker that cannot edit comments gets a new comment at
 * (spec §7): started, pull request opened, completed.
 */
export type ActivityMilestone = 'started' | 'pr' | 'completed';

export function activityMilestone(input: Pick<ActivityCommentInput, 'prUrl' | 'completed'>): ActivityMilestone {
  return input.completed !== null ? 'completed' : input.prUrl !== null ? 'pr' : 'started';
}

/**
 * The milestone an activity body was written at, read back from its own
 * lines: only Tandemise starts a line with these words (copied text sits after
 * `Started in Tandemise by …:` or a step's `- [ ] `).
 */
export function activityMilestoneOf(body: string): ActivityMilestone {
  const lines = body.split('\n');
  if (lines.some((l) => l.startsWith('Done in Tandemise — '))) return 'completed';
  if (lines.some((l) => l.startsWith('Pull request: '))) return 'pr';
  return 'started';
}

export interface TrackerWriteBackInput {
  readonly mapping: TrackerConfig['states'] & { readonly onComplete: TrackerConfig['onComplete'] };
  readonly mission: { readonly status: MissionStatus };
  /** A pull request is among the mission's delivery links. */
  readonly prOpen: boolean;
  /** The mission waits on a person's decision (any PENDING approval). */
  readonly pendingApproval: boolean;
  /** The item's state in the tracker, read fresh. */
  readonly upstreamState: string;
  /** The state Tandemise last wrote; null if it never wrote one. */
  readonly writtenState: string | null;
}

/**
 * The state a started item should move to now, or null (spec §7 "State
 * write-back"). A person's change always wins: Tandemise moves the item only
 * while it is still in the state Tandemise last wrote. And it never moves an
 * item backwards (ready < in progress < in review < done) except on cancel,
 * which puts it back in the first ready state (plan Review Focus 3).
 */
export function decideTrackerWriteBack(input: TrackerWriteBackInput): { readonly transition: string | null } {
  const m = input.mapping;
  const status = input.mission.status;
  const target = status === 'COMPLETE' ? (m.onComplete === 'done' ? m.done[0] : (m.in_review ?? m.done[0]))
    : status === 'CANCELLED' ? m.ready[0]
      : (status === 'READY_TO_SHIP' || (input.prOpen && input.pendingApproval)) && m.in_review !== undefined ? m.in_review
        : m.in_progress;
  if (target === undefined || input.writtenState === null) return { transition: null };
  if (input.upstreamState !== input.writtenState || target === input.upstreamState) return { transition: null };
  if (status !== 'CANCELLED' && stateRank(m, target) < stateRank(m, input.writtenState)) return { transition: null };
  return { transition: target };
}

/** ready 0, in progress 1, in review 2, done or won't do 3; a state the mapping does not name -1. */
function stateRank(m: TrackerConfig['states'], state: string): number {
  if (m.ready.includes(state)) return 0;
  if (state === m.in_progress) return 1;
  if (state === m.in_review) return 2;
  if (m.done.includes(state) || m.wont_do.includes(state)) return 3;
  return -1;
}

// ------------------------------------------------------------------ refine a draft (#135)

const DONE_WHEN_HEADING = '## Done when';
const DECISIONS_HEADING = '## Decisions';
/** The sections a refined description replaces: any Done-when or acceptance section, and its own Decisions. */
const REPLACED_SECTION = /^(done when|acceptance criteria|decisions)$/i;
const SECTION_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * The description a refined draft is written back with (spec
 * 2026-11-01-board-refine-draft-design.md): the item's own text, with a
 * `## Done when` checklist of the accepted lines and a `## Decisions` section
 * of each answered question. A Done-when, acceptance or Decisions section
 * already there is replaced, so writing twice writes the same text; anything
 * else the person wrote is kept as it was.
 */
export function refinedDescription(
  description: string,
  criteria: readonly string[],
  answered: readonly { readonly question: string; readonly answer: string }[],
): string {
  const kept: string[] = [];
  let skipping: number | null = null;
  let fenced = false;
  for (const line of description.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : SECTION_HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (skipping !== null && level <= skipping) skipping = null;
      if (skipping === null && REPLACED_SECTION.test(heading[2]!.replace(/[:*_]+/g, '').trim())) {
        skipping = level;
        continue;
      }
    }
    if (skipping === null) kept.push(line);
  }
  const parts = [kept.join('\n').trim()];
  parts.push([DONE_WHEN_HEADING, ...criteria.map((c) => `- [ ] ${oneLine(c)}`)].join('\n'));
  if (answered.length > 0) {
    parts.push([DECISIONS_HEADING, ...answered.map((a) => `- ${oneLine(a.question)} — ${oneLine(a.answer)}`)].join('\n'));
  }
  return parts.filter((p) => p.length > 0).join('\n\n');
}

/** Only Tandemise starts an activity comment line with these words. */
const REFINED_PREFIX = 'Refined in Tandemise by ';

/**
 * The activity comment's line for a draft written back after refinement:
 * `Refined in Tandemise by Ana: 3 Done-when lines, 1 answered question. Moved from Draft to Open.`
 */
export function refinedActivityLine(input: {
  readonly by: string;
  readonly criteria: number;
  readonly answered: number;
  readonly from: string;
  readonly to: string;
}): string {
  const lines = `${input.criteria} Done-when ${input.criteria === 1 ? 'line' : 'lines'}`;
  const answers = input.answered === 0 ? '' : `, ${input.answered} answered ${input.answered === 1 ? 'question' : 'questions'}`;
  return `${REFINED_PREFIX}${escapeForComment(oneLine(input.by))}: ${lines}${answers}. Moved from ${escapeForComment(input.from)} to ${escapeForComment(input.to)}.`;
}

/** The refined line an activity comment already carries, so a later Start keeps it on top; null when none. */
export function refinedLineOf(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  return body.split('\n').find((l) => l.startsWith(REFINED_PREFIX)) ?? null;
}
