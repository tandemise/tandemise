import { TandemiseError } from '@tandemise/shared';
import type { SqliteHandle } from '../database.js';
import type { Migration } from './types.js';

/**
 * Fast, self-unblocking checks (#111, #106). Additive only:
 *
 *  - `check_results.outcome` widened in place to accept `TIMEOUT`, exactly as
 *    migrations 006 and 025 widened their CHECKs: a rebuild would cascade under
 *    foreign keys, and the in-place edit leaves the on-disk format identical;
 *  - `check_results.tree_sha`: the git tree the check measured, so a later
 *    step that measures the same tree reuses the result instead of running the
 *    suite again. Null for results from before it and for checks that ran
 *    outside a git tree; those are never reused.
 */
const OLD_OUTCOMES = `CHECK (outcome IN ('PASS','FAIL','SKIP'))`;
const NEW_OUTCOMES = `CHECK (outcome IN ('PASS','FAIL','SKIP','TIMEOUT'))`;

export const migration026: Migration = {
  version: 26,
  name: 'check_timeouts_and_reuse',
  up: `
ALTER TABLE check_results ADD COLUMN tree_sha TEXT;
CREATE INDEX ix_check_results_tree ON check_results (tree_sha, name, created_at);
`,
  transform: (db: SqliteHandle): void => {
    db.unsafeMode(true);
    try {
      db.pragma('writable_schema = ON');
      try {
        db.prepare(
          `UPDATE sqlite_master SET sql = replace(sql, :old, :new) WHERE type = 'table' AND name = 'check_results'`,
        ).run({ old: OLD_OUTCOMES, new: NEW_OUTCOMES });
      } finally {
        db.pragma('writable_schema = OFF');
      }
      const row = db.prepare<[], { sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'check_results'`).get();
      if (!(row?.sql ?? '').includes(NEW_OUTCOMES)) {
        throw new TandemiseError('INTERNAL', 'Migration 026 did not widen the check_results outcome constraint; a timed-out check would be rejected.', {
          details: { schema: row?.sql ?? null },
        });
      }
      const version = db.pragma('schema_version', { simple: true }) as number;
      db.pragma(`schema_version = ${version + 1}`);
    } finally {
      db.unsafeMode(false);
    }
  },
};
