import { TandemiseError, nullLogger, type Logger } from '@tandemise/shared';
import type { TandemiseDatabase } from '../database.js';
import type { Migration } from './types.js';
import { migration001 } from './001_initial.js';
import { migration002 } from './002_task_repository.js';
import { migration003 } from './003_task_executor.js';
import { migration004 } from './004_workflow_inputs.js';
import { migration005 } from './005_task_wait.js';
import { migration006 } from './006_task_park_statuses.js';
import { migration007 } from './007_task_retry_feedback.js';
import { migration008 } from './008_members_responsibility.js';
import { migration009 } from './009_artifact_handoff.js';
import { migration010 } from './010_feedback_rounds.js';
import { migration011 } from './011_mission_criteria.js';
import { migration012 } from './012_ready_before_planning.js';
import { migration013 } from './013_backlog.js';
import { migration014 } from './014_limits.js';
import { migration015 } from './015_liveness.js';
import { migration016 } from './016_routines.js';
import { migration017 } from './017_models.js';
import { migration018 } from './018_skills.js';
import { migration019 } from './019_issues.js';
import { migration020 } from './020_evals.js';
import { migration021 } from './021_plan_proposals.js';
import { migration022 } from './022_task_holds.js';
import { migration023 } from './023_brain.js';
import { migration024 } from './024_intake.js';
import { migration025 } from './025_planner_and_merge.js';
import { migration026 } from './026_check_timeouts_and_reuse.js';

export type { Migration } from './types.js';

/**
 * Every migration, in order. Appending is the only legal edit: an already
 * released migration is immutable, because some installation has run it.
 *
 * A future migration that rebuilds a table by copying it must name its
 * columns. `artifacts` has a generated column since 009 (`handoff_text`), and
 * `INSERT INTO ... SELECT *` into a rebuilt table either fails on it or, if
 * the new table declares it plainly, silently turns it into stored data that
 * the FTS index no longer agrees with.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration001, migration002, migration003, migration004, migration005, migration006, migration007,
  migration008, migration009, migration010, migration011, migration012, migration013, migration014,
  migration015, migration016, migration017, migration018, migration019, migration020,
  migration021, migration022, migration023, migration024, migration025, migration026,
];

/** The newest schema version this binary understands. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

const CREATE_LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly number[];
}

/**
 * Brings the database up to `SCHEMA_VERSION`, then reports what it did.
 *
 * Refuses to touch a database written by a newer binary. A desktop app that
 * auto-updates can be rolled back, and an older binary opening a newer schema
 * would not fail cleanly - it would half-work, writing rows that violate
 * constraints it has never heard of (MVP.md §20.4). Failing at open is the only
 * safe answer.
 *
 * Each migration runs in its own transaction together with its ledger row, so
 * an interrupted upgrade leaves the database at a version that was actually
 * reached rather than half of one.
 */
export function migrate(
  db: TandemiseDatabase,
  logger: Logger = nullLogger,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const log = logger.child({ component: 'persistence.migrate' });
  assertOrdered(migrations);

  db.handle.exec(CREATE_LEDGER);

  const applied = new Set(
    db.handle
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );
  const current = applied.size === 0 ? 0 : Math.max(...applied);
  const target = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  if (current > target) {
    throw new TandemiseError(
      'PRECONDITION_FAILED',
      `Database schema version ${current} is newer than this build supports (${target}). ` +
        'Update Tandemise, or restore a backup taken before the upgrade.',
      { details: { databaseVersion: current, supportedVersion: target } },
    );
  }

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    log.debug('schema up to date', { version: current });
    return { from: current, to: current, applied: [] };
  }

  const record = db.handle.prepare<{ version: number; name: string; appliedAt: string }>(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (:version, :name, :appliedAt)',
  );

  for (const migration of pending) {
    db.transaction(() => {
      // A migration expressed entirely as logic leaves `up` empty; `exec('')`
      // is an error rather than a no-op.
      if (migration.up.trim().length > 0) db.handle.exec(migration.up);
      migration.transform?.(db.handle);
      record.run({
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
    });
    log.info('migration applied', { version: migration.version, name: migration.name });
  }

  return { from: current, to: target, applied: pending.map((m) => m.version) };
}

/** Current schema version of an already-opened database; 0 when unmigrated. */
export function schemaVersion(db: TandemiseDatabase): number {
  const table = db.handle
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (!table) return 0;
  const row = db.handle
    .prepare<[], { version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations')
    .get();
  return row?.version ?? 0;
}

/**
 * A gap or a duplicate version means two branches numbered a migration the
 * same way. Catching it here turns a silently skipped migration on some
 * machines into a loud failure on every machine.
 */
function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const m of migrations) {
    if (m.version !== previous + 1) {
      throw new TandemiseError(
        'INTERNAL',
        `Migration list is not contiguous: expected version ${previous + 1}, found ${m.version} ('${m.name}')`,
      );
    }
    previous = m.version;
  }
}
