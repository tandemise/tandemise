import type { CheckName } from '../entities/workspace.js';
import type { PlannerArea } from './config.js';
import { matchGlob } from './glob.js';

/**
 * Which command a check runs for a change (#106), decided from the files the
 * change touched and the areas in `planner.yaml`.
 *
 * Doing the change in a terminal, a person runs the test suite once, and not
 * at all for a doc edit, because they can see what changed. The factory ran
 * the whole suite for a one-paragraph Markdown change. This reads the same
 * thing a person would:
 *
 * - every changed file sits in an area that says what this check runs there
 *   (`areas[].checks.tests`): those commands run, each once;
 * - every such area says `none`: the change needs no such check;
 * - any file sits outside such an area, or nothing changed: the repository's
 *   own command, the whole of it. Not knowing never narrows a check.
 */
export type CheckSelection =
  | { readonly kind: 'repository' }
  | { readonly kind: 'commands'; readonly commands: readonly string[]; readonly areas: readonly string[] }
  | { readonly kind: 'not_needed'; readonly areas: readonly string[]; readonly files: number };

export function selectCheck(name: CheckName, changedPaths: readonly string[], areas: readonly PlannerArea[]): CheckSelection {
  if (changedPaths.length === 0) return { kind: 'repository' };
  const commands: string[] = [];
  const named: string[] = [];
  for (const path of changedPaths) {
    // First matching area per file, as everywhere else areas are read.
    const area = areas.find((a) => a.paths.some((g) => matchGlob(g, path)));
    const checks = area?.checks;
    if (area === undefined || checks === undefined || !(name in checks)) return { kind: 'repository' };
    const command = checks[name] ?? null;
    if (!named.includes(area.name)) named.push(area.name);
    if (command !== null && !commands.includes(command)) commands.push(command);
  }
  return commands.length === 0
    ? { kind: 'not_needed', areas: named, files: changedPaths.length }
    : { kind: 'commands', commands, areas: named };
}

/** The sentence a check that was not needed records, in a person's words. */
export function notNeededDetail(selection: Extract<CheckSelection, { kind: 'not_needed' }>): string {
  const files = selection.files === 1 ? '1 file' : `${selection.files} files`;
  const where = selection.areas.length === 1 ? `the ${selection.areas[0]} area` : `the ${selection.areas.join(', ')} areas`;
  return `Not run: this change touches only ${where} (${files}), which planner.yaml says needs no such check. CI runs the full suite on the pull request.`;
}
