/**
 * The shipped `planner.yaml` (#53 §3): what a project that writes nothing
 * gets. The spec's file minus its project-specific `desktop-ui` area and
 * `ui-look` module, plus the tracker maps that stand in for #52's
 * `tracker.yaml` until it lands.
 */
export const SHIPPED_PLANNER = {
  version: 1,
  areas: [
    { name: 'migrations', paths: ['**/migrations/**', '**/*.sql'], sensitivity: 'critical' },
    { name: 'auth', paths: ['**/auth/**', '**/session*/**', '**/*oauth*'], sensitivity: 'critical', skills: ['security-review'] },
    { name: 'payments', paths: ['**/billing/**', '**/payment*/**', '**/stripe*/**'], sensitivity: 'critical' },
    { name: 'ci-and-infra', paths: ['.github/**', 'infra/**', '**/Dockerfile', '**/*.tf', '**/docker-compose*.yml'], sensitivity: 'critical' },
    { name: 'dependencies', paths: ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/go.sum', '**/Cargo.lock'], sensitivity: 'sensitive' },
    // A change that touches only these files needs no test run, type check,
    // lint or build (#106): CI still runs everything on the pull request.
    {
      name: 'docs', paths: ['docs/**', '**/*.md', '**/*.mdx'], sensitivity: 'none',
      checks: { tests: 'none', typecheck: 'none', lint: 'none', build: 'none' },
    },
  ],
  trackerTypes: { Bug: 'fix', Feature: 'feature', Task: 'chore', Chore: 'chore', Docs: 'docs', Security: 'security' },
  labels: { bug: 'fix', enhancement: 'feature', dependencies: 'deps', documentation: 'docs', security: 'security' },
  profile: {
    rules: [
      { when: 'item.prefix == "docs"', set: { type: 'docs', size: 'xs' } },
      { when: 'item.keywords_any("typo", "copy", "rename")', set: { size: 'xs' } },
      { when: 'item.keywords_any("migrate", "migration", "schema")', set: { risk: 'high' } },
      { when: 'item.keywords_any("redesign", "rewrite", "new screen")', set: { type: 'feature', size: 'l' } },
    ],
  },
  lanes: [
    { when: 'profile.risk == "high" || profile.size == "l"', lane: 'careful' },
    { when: 'profile.risk == "low" && (profile.size == "xs" || profile.size == "s")', lane: 'quick' },
    { lane: 'standard' },
  ],
  laneWorkflows: { quick: 'quick', standard: 'standard', careful: 'careful' },
  byType: { fix: { standard: 'fix', careful: 'fix-careful' } },
  modules: [
    {
      name: 'security-review',
      when: 'profile.areas_any("auth", "payments")',
      add: {
        step: {
          key: 'security_review', class: 'review', role: 'review', after: 'implement', title: 'Security review',
          skills: ['security-review'], gate: 'artifact.ReviewReport.exists && review.blocking_findings == 0',
        },
      },
    },
    {
      name: 'build-must-pass',
      when: 'profile.areas_any("migrations", "ci-and-infra")',
      add: { gateClause: { step: 'implement', clause: 'checks.build == PASS' } },
    },
  ],
  holdApproval: { minTasks: 5, rate: 0.4 },
  tiebreak: 'on',
  // Each check's time budget in minutes (#111). A repository's own budget, set
  // in Project settings → Repositories, wins over these.
  checks: { budgets: {} },
} as const;
