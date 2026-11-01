import { globToRegExp } from '../planner/glob.js';

/**
 * What a failing CI check is about (#194), decided before Tandemise acts on it:
 *
 * - `metadata`: the pull request itself (its title, labels, body, linked
 *   issue, a Conventional Commit or DCO rule). No change to the code can fix
 *   it, so it never starts an implement round.
 * - `code`: a build, test, lint or typecheck. The code step goes again.
 * - `unknown`: neither can be told. A person is asked.
 */
export const CI_CHECK_KINDS = ['metadata', 'code', 'unknown'] as const;
export type CiCheckKind = (typeof CI_CHECK_KINDS)[number];

export interface FailingCheck {
  readonly name: string;
  readonly logTail: string | null;
}

/** Names that say the check reads the pull request, not the code. Read before CODE_NAME: `PR lint` is about the pull request. */
const METADATA_NAME = /(?:\b|_)(?:pr|pull[ _-]?request)[ _-]?(?:title|body|description|labels?|lint|metadata)s?(?:\b|_)|\btitles?\b|\blabel(?:s|ed|ler)?\b|semantic[ _-]?(?:pr|pull|title|commit)|conventional[ _-]?(?:pr|commits?|title)|commitlint|\bdco\b|signed[ _-]?off|linked[ _-]?issue|\bdanger\b/i;
/** Names of the checks that build and test code. */
const CODE_NAME = /build|test|lint|typecheck|type[ _-]?check|\btsc\b|compile|\bunit\b|\be2e\b|integration|format|prettier|eslint|coverage|storybook|a11y|jest|vitest|mypy|pytest|cargo|clippy|gradle|maven|\bgo\b|licen[cs]e|boundar|bundle|smoke/i;
/** A log tail that talks about the pull request's own text. */
const METADATA_LOG = /pull request(?:'s)? (?:title|body|description)|\bPR (?:title|body|description)|\btitle (?:must|should|does ?n[o']t|is not|doesn't)|conventional commit|missing (?:a )?label|signed-off-by|subject must/i;
/** A log tail that reads as a build or a test. */
const CODE_LOG = /error TS\d+|\bFAIL\b|AssertionError|expected .{1,80} (?:to |got )|npm ERR!|Traceback \(most recent call last\)|panicked at|SyntaxError|TypeError|ReferenceError|\d+ (?:tests? )?failed|✗|not ok \d+/;

/**
 * Its kind. `overrides` is `ci.checks` in planner.yaml: a check's name (or a
 * glob over it, case-insensitive) mapped to a kind, which wins over the
 * defaults. Then the name, then what the check printed.
 */
export function classifyCheck(check: FailingCheck, overrides: Readonly<Record<string, CiCheckKind>> = {}): CiCheckKind {
  const name = check.name.trim();
  for (const [pattern, kind] of Object.entries(overrides)) {
    if (pattern.trim().toLowerCase() === name.toLowerCase()) return kind;
  }
  for (const [pattern, kind] of Object.entries(overrides)) {
    if (/[*?{]/.test(pattern) && new RegExp(globToRegExp(pattern.trim()).source, 'i').test(name)) return kind;
  }
  if (METADATA_NAME.test(name)) return 'metadata';
  if (CODE_NAME.test(name)) return 'code';
  const log = check.logTail ?? '';
  if (METADATA_LOG.test(log)) return 'metadata';
  if (CODE_LOG.test(log)) return 'code';
  return 'unknown';
}

/** A metadata check about the pull request's title: the one kind Tandemise can fix by editing the pull request. */
export function isTitleCheck(check: FailingCheck): boolean {
  return /title|semantic|conventional|commitlint/i.test(check.name) || /\btitle\b/i.test(check.logTail ?? '');
}
