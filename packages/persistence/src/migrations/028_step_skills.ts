import type { Migration } from './types.js';

/**
 * A step that runs one of the team's own Claude Code skills (#131). Additive:
 * `mission_tasks.run_skill` holds `{ name, args }` as JSON, null for a step
 * that runs its role's prompt (every step before it).
 */
export const migration028: Migration = {
  version: 28,
  name: 'step_skills',
  up: `
ALTER TABLE mission_tasks ADD COLUMN run_skill TEXT;
`,
};
