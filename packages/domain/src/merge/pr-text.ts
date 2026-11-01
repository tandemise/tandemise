import type { TaskType } from '../planner/types.js';

/**
 * The pull request the ship step opens (#53 §8.1): a Conventional-Commit title
 * from the profile's type and the task's title, and a body made only of what
 * the daemon knows (the tracker link, the Done-when table, the plan's why),
 * led by the change set's own headline and points (#113).
 */
const PREFIX: Readonly<Record<TaskType, string>> = {
  fix: 'fix', feature: 'feat', docs: 'docs', deps: 'build', refactor: 'refactor', test: 'test',
  security: 'fix', chore: 'chore', unknown: 'chore',
};

const CONVENTIONAL = /^\s*(feat|fix|docs|chore|refactor|test|build|perf|ci|revert|style)(\([^)]*\))?!?:\s/i;
const COMMIT = /^\s*(feat|fix|docs|chore|refactor|test|build|perf|ci|revert|style)(\([^)]*\))?(!)?:\s+(\S.*)$/i;

/** What else is known about the change when the item's title is not a Conventional Commit (#157). */
export interface PrTitleHints {
  /** The type the tracker's labels or item type say, mapped by the planner's `labels`/`trackerTypes`. */
  readonly labelType?: TaskType | null;
  /** The subjects of the commits on the branch that ships, oldest first. Tandemise's own are left out by the caller. */
  readonly commits?: readonly string[];
}

/** A type that says nothing: the planner could not tell, or fell back to its default. */
const weak = (type: TaskType): boolean => type === 'unknown' || type === 'chore';

/**
 * Lower-cases the subject's first letter only when its first word is an
 * ordinary capitalised word ("Planner" → "planner"). A tracker key, an
 * acronym or a mixed-case name keeps its case: "KEY-77", "API", "GitHub" (#152).
 */
export function lowerFirstWord(subject: string): string {
  const first = /^\S+/.exec(subject)?.[0] ?? '';
  return /^[A-Z][a-z]*[,:;.]?$/.test(first) && first !== 'I' ? subject.charAt(0).toLowerCase() + subject.slice(1) : subject;
}

/**
 * The pull request's title: a Conventional Commit whose type is what is known
 * about the change, in order (#157). An item title that already is one is used
 * as written. Otherwise the type comes from the tracker's labels, then the
 * planner's profile, then the agent's own commit; `chore` only when nothing
 * says otherwise. The subject is the agent's commit subject (which says what
 * changed) when there is one, else the item's title. A squash-merged
 * repository makes this title the commit on its default branch.
 */
export function prTitle(profile: { readonly type: TaskType }, title: string, hints: PrTitleHints = {}): string {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (CONVENTIONAL.test(clean)) return clean;
  const commit = (hints.commits ?? [])
    .map((c) => COMMIT.exec(c.trim().replace(/\s+/g, ' ')))
    .find((m): m is RegExpExecArray => m !== null);
  const commitType = commit?.[1]?.toLowerCase() ?? null;
  const type = hints.labelType != null && !weak(hints.labelType) ? PREFIX[hints.labelType]
    : !weak(profile.type) ? PREFIX[profile.type]
      : commitType ?? PREFIX[hints.labelType ?? profile.type];
  if (commit !== undefined) {
    // The commit's scope and breaking mark belong to its own type.
    const scope = commitType === type ? (commit[2] ?? '') : '';
    const bang = commit[3] ?? '';
    return `${type}${scope}${bang}: ${lowerFirstWord(commit[4]!.trim())}`;
  }
  const subject = clean.length === 0 ? 'change' : lowerFirstWord(clean);
  return `${type}: ${subject}`;
}

export interface PrBodyInput {
  /** The change set's handoff: what changed, in the agent's own headline and points (#113). */
  readonly summary: { readonly headline: string; readonly points: readonly string[] } | null;
  /** The tracker item the mission came from, and the closing keyword when it is a GitHub issue. */
  readonly issue: { readonly label: string; readonly key: string; readonly url: string; readonly closes: string | null } | null;
  /** Each Done-when line, with an honest status: verified by QA, claimed by the agent, or not verified. */
  readonly criteria: readonly { readonly key: string; readonly statement: string; readonly verified: string }[];
  /** One sentence per hold a person made on the mission's steps. */
  readonly holds: readonly string[];
  readonly why: readonly string[];
  readonly missionId: string;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * GitHub's closing keyword for an issue URL, as seen from the pull request's
 * repository (`owner/repo`): `Closes #97` in the same repository,
 * `Closes owner/other#5` in another; null for anything not a GitHub issue.
 */
export function closingLine(issueUrl: string, prRepo: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(issueUrl.trim());
  if (m === null) return null;
  return m[1]!.toLowerCase() === prRepo.toLowerCase() ? `Closes #${m[2]!}` : `Closes ${m[1]!}#${m[2]!}`;
}

/**
 * The pull request's body (#113): what changed first (the change set's
 * headline and points), the issue it closes, the Done-when table with a
 * status that claims no more than happened, any holds, then why these steps.
 * The change set's body, where an agent may argue for its own work, never
 * goes in.
 */
export function prBody(input: PrBodyInput): string {
  const lines: string[] = [];
  if (input.summary !== null) {
    lines.push('## Summary', '', input.summary.headline.trim());
    if (input.summary.points.length > 0) lines.push('', ...input.summary.points.map((p) => `- ${p.trim()}`));
    lines.push('');
  }
  if (input.issue !== null) {
    lines.push(`From [${input.issue.label} ${input.issue.key}](${input.issue.url}).`);
    if (input.issue.closes !== null) lines.push('', input.issue.closes);
    lines.push('');
  }
  lines.push('## Done when', '');
  if (input.criteria.length === 0) lines.push('No Done-when lines were given.');
  else {
    lines.push('| Id | Done when | Status |', '|---|---|---|');
    for (const c of input.criteria) lines.push(`| ${cell(c.key)} | ${cell(c.statement)} | ${cell(c.verified)} |`);
  }
  if (input.holds.length > 0) lines.push('', '## Held by a person', '', ...input.holds.map((h) => `- ${h}`));
  if (input.why.length > 0) lines.push('', '## Why these steps', '', ...input.why.map((w) => `- ${w}`));
  lines.push('', `Opened by Tandemise for mission \`${input.missionId}\`.`);
  return lines.join('\n');
}
