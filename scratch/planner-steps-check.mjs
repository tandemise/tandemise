/**
 * A planned mission can wait on CI and on a person without an agent doing it.
 *
 * Found running "open a reviewed PR with green CI" through the real app: the
 * planner wrote a sensible pipeline but had no way to say "wait for CI" except
 * asking an agent to check once, because the plan parser dropped `executor`
 * and `waitFor` - the step kinds a workflow file can already declare.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { parsePlanResponse } = await import(join(root, 'packages/application/dist/planning/parse.js'));
const { validateMissionPlan } = await import(join(root, 'packages/domain/dist/index.js'));

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}${d ? '  ' + d : ''}`); else { bad++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };

const plan = {
  summary: 's',
  tasks: [
    { key: 'open_pr', title: 'Open PR', objective: 'Push feat/x and open a PR', roleId: 'development',
      executionPolicy: { isolation: 'worktree', maxWallTimeMs: 600000, capabilities: [] } },
    { key: 'ci', title: 'CI', objective: 'Wait for CI', executor: 'wait', waitFor: 'gh pr checks feat/x',
      everyMs: 30000, timeoutMs: 2700000, dependsOn: ['open_pr'], executionPolicy: { isolation: 'worktree' } },
    { key: 'approve', title: 'Approve', objective: 'Approve the PR on GitHub', executor: 'human', dependsOn: ['ci'] },
    { key: 'figma', title: 'Design', objective: 'Make the design in Figma', executor: 'human', roleId: 'design', dependsOn: ['ci'] },
  ],
};

const parsed = parsePlanResponse(JSON.stringify(plan));
ok('parses', parsed.ok, parsed.ok ? '' : parsed.error.join('; '));
if (parsed.ok) {
  const [pr, ci, approve] = parsed.value.tasks;
  ok('agent task is unchanged', pr.executor === 'agent' && pr.roleId === 'development' && pr.waitPolicy === null);
  ok('wait step keeps its command', ci.executor === 'wait' && ci.waitPolicy?.command === 'gh pr checks feat/x');
  ok('wait step keeps its cadence', ci.waitPolicy?.everyMs === 30000 && ci.waitPolicy?.timeoutMs === 2700000);
  ok('wait step is not sandboxed', ci.executionPolicy.isolation === 'none');
  ok('human step needs no role', approve.executor === 'human' && approve.roleId === 'human');
  // Staffing is per role, so a person's step that names one keeps it.
  const figma = parsed.value.tasks[3];
  ok('a human step keeps the role it names', figma.executor === 'human' && figma.roleId === 'design', figma.roleId);
  const validated = validateMissionPlan(parsed.value, {
    knownRoleIds: new Set(['development']), satisfiableCapabilities: new Set(), knownRepositoryNames: undefined,
  });
  ok('validates', validated.ok, validated.ok ? '' : JSON.stringify(validated.error));
}

const noCommand = parsePlanResponse(JSON.stringify({ tasks: [{ key: 'ci', title: 't', objective: 'o', executor: 'wait' }] }));
ok('a wait step without waitFor is rejected with a reason', !noCommand.ok && /waitFor/.test(noCommand.error.join(' ')));

console.log(`\n${bad === 0 ? 'ALL PLANNER STEP CHECKS PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
