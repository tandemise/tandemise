import type { Migration } from './types.js';

/**
 * What the Board needs to tell an item that must not be started (#136).
 * Additive only, two nullable columns on the board cache:
 *
 *  - `tracker_items.subtasks`: how many of the item's subtasks are still open;
 *  - `tracker_items.tags`: the item's tags (YouTrack) or its labels that are
 *    not mapped states (GitHub), as a JSON array.
 *
 * Null is "the tracker did not say": rows cached before this migration, and
 * trackers that cannot tell. The next board refresh fills them in.
 */
export const migration027: Migration = {
  version: 27,
  name: 'tracker_item_shape',
  up: `
ALTER TABLE tracker_items ADD COLUMN subtasks INTEGER;
ALTER TABLE tracker_items ADD COLUMN tags TEXT;
`,
};
