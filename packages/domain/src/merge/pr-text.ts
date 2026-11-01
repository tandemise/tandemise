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

export function prTitle(profile: { readonly type: TaskType }, title: string): string {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (CONVENTIONAL.test(clean)) return clean;
  const subject = clean.length === 0 ? 'change' : clean.charAt(0).toLowerCase() + clean.slice(1);
  return `${PREFIX[profile.type]}: ${subject}`;
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
