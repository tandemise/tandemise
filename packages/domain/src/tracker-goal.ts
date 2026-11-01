/**
 * A mission started from a tracker item carries the item in its goal
 * (`trackerGoal` in entities/tracker.ts): who started it, the link, the title
 * and the whole description. The mission header shows that as one line and a
 * short summary, with the rest behind a disclosure (#105).
 *
 * Pure and import-free: the renderer imports it as a pure subpath.
 */

export interface TrackerGoalParts {
  /** "GitHub", "YouTrack". */
  readonly label: string;
  /** "#97", "APP-12". */
  readonly key: string;
  readonly starter: string;
  readonly url: string;
  /** The description's first paragraph as plain text, cut to a sentence or two; '' when there is none. */
  readonly summary: string;
}

/** How long the summary under a mission's title may be. */
export const GOAL_SUMMARY_CHARS = 180;

const LEAD = /^(\S+) (\S+), started by (.+): (\S+)$/;
const MARKER = 'The task as written in the tracker:';

/** Inline Markdown out of a line: emphasis, code, links, heading and list marks. */
export function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
    .trim();
}

/** The parts of a goal written by `trackerGoal`, or null for any other goal. */
export function parseTrackerGoal(goal: string): TrackerGoalParts | null {
  const paragraphs = goal.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const lead = LEAD.exec((paragraphs[0] ?? '').trim());
  if (lead === null || (paragraphs[1] ?? '').trim() !== MARKER) return null;
  // paragraphs[2] is the title, already the mission's title; the description follows.
  const description = paragraphs.slice(3).filter((p) => !p.startsWith('Sources:\n'));
  // The first paragraph that is prose: a heading alone ("## What happened") says nothing yet.
  const first = description
    .map((p) => p.split('\n').filter((line) => !/^\s{0,3}#{1,6}\s/.test(line)).map(plainInline).filter((line) => line !== '').join(' '))
    .find((p) => p !== '') ?? '';
  return { label: lead[1]!, key: lead[2]!, starter: lead[3]!, url: lead[4]!, summary: cutSummary(first) };
}

function cutSummary(text: string): string {
  if (text.length <= GOAL_SUMMARY_CHARS) return text;
  const head = text.slice(0, GOAL_SUMMARY_CHARS);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (stop >= 60) return head.slice(0, stop + 1);
  return `${head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : GOAL_SUMMARY_CHARS).trimEnd()}…`;
}
