/**
 * The shipped `merge.yaml` (#53 §8.3), verbatim, plus `revertAutoMerge`.
 * Auto-merge is off: only a person turns it on, per project. The score table
 * and `autoMergeAtMost: 2` mean a merge happens only for a small, tested,
 * reviewed change outside every sensitive area.
 */
export const SHIPPED_MERGE = {
  version: 1,
  autoMerge: 'off',
  method: 'squash',
  reviewers: [],
  tests: ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', 'scratch/**/*-check.mjs'],
  never: [
    { paths: ['**/migrations/**', '**/*.sql'] },
    { paths: ['.github/**', 'infra/**', '**/*.tf', '**/Dockerfile'] },
    { paths: ['**/.env*', '**/secrets*', 'CODEOWNERS', '**/CODEOWNERS'] },
    { areas: ['auth', 'payments'] },
    { when: 'change.deleted_files > 0 && change.max_sensitivity != "none"' },
    { when: 'process.lane == "careful"' },
    { when: 'process.person_commits > 0' },
  ],
  requires: [
    'ci.state == PASS',
    'checks.tests != FAIL',
    'review.blocking_findings == 0 || review.blocking_findings == null',
  ],
  score: [
    { when: 'change.lines_added + change.lines_removed > 400', points: 3, why: 'over 400 lines changed' },
    { when: 'change.lines_added + change.lines_removed > 100', points: 1, why: 'over 100 lines changed' },
    { when: 'change.files > 15', points: 2, why: 'more than 15 files' },
    { when: 'change.repos > 1', points: 2, why: 'spans repositories' },
    { when: 'change.max_sensitivity == "sensitive"', points: 2, why: 'touches a sensitive area' },
    { when: 'change.dependencies_changed && !change.lockfile_only', points: 2, why: 'changes dependencies' },
    { when: 'change.tests_touched == 0 && change.files > 1', points: 2, why: 'no tests changed' },
    { when: 'coverage.changed_lines < 60', points: 1, why: 'changed lines are poorly covered' },
    { when: 'criteria.unverified > 0', points: 1, why: 'Done-when lines not independently verified' },
    { when: 'review.independent != PASS', points: 1, why: 'no independent review' },
    { when: 'process.holds > 0 || process.changes_requested > 0', points: 1, why: 'a person had to step in' },
    { when: 'process.escalations > 1', points: 1, why: 'needed a stronger model twice' },
    { when: 'process.retry_out_of_scope', points: 2, why: 'a retry changed files outside the change' },
    { when: 'process.lightened_by_person', points: 2, why: 'you made it quick' },
    { when: 'history.area_recent_revert', points: 3, why: 'this area had a revert in the last 14 days' },
  ],
  autoMergeAtMost: 2,
  revertAutoMerge: 'on',
} as const;
