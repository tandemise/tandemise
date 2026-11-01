// PM13 — a careful-lane mission with both reviews (#191). The goal says "migrate", so the factory plans the careful
// lane; its implement step touches src/auth/session.ts, so the ship step adds a security review. The scripted agent
// gives the two reviews different verdicts (SCRIPTED_REVIEW_SPLIT): the security review passes, "Review the change"
// asks for changes with one major finding. Each review step's gate facts must be its own report's, never the other's.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { headerAction, openMission, repositoryId, ship, shot, waitStatus, whyText } from '../common.mjs';

const c = await context();
const { until } = c;
const ev = new Evidence('PM13', 'A careful-lane mission with two reviews keeps each review\'s verdict its own');

try {
  const created = await c.api.post('/v1/missions', {
    workspaceId: c.env.workspaceId, repositoryId: await repositoryId(c), workflowPreset: 'auto',
    goal: 'fix: migrate the session cookie name SCRIPTED_TOUCH=src/auth/session.ts SCRIPTED_REVIEW_SPLIT',
    successCriteria: ['The session cookie keeps working after the rename.'],
  });
  const id = created.id ?? created.mission?.id;
  ev.note(`mission ${id}`);
  await openMission(c, id);
  await headerAction(c, 'Plan');
  await waitStatus(c, id, ['AWAITING_PLAN_APPROVAL', 'EXECUTING'], 150_000);
  const planned = (await c.api.get(`/v1/missions/${id}`)).mission;
  if (planned.status === 'AWAITING_PLAN_APPROVAL') await c.approvePlan(id, planned.title);

  const why = await whyText(c, id, (t) => t.includes('lane'));
  ev.check('the factory planned the careful lane', why.includes('Careful lane'), why.split('\n').slice(0, 4));

  const both = await until(async () => {
    const t = await c.tasks(id);
    return t.review?.status === 'SUCCEEDED' && t.security_review?.status === 'SUCCEEDED' && t;
  }, { label: 'both reviews done', timeoutMs: 300_000 });
  ev.check('both the security review and "Review the change" ran and succeeded', both.security_review.title === 'Security review' && both.review.title === 'Review the change',
    { security: both.security_review.title, review: both.review.title });
  // The full facts the step's gate was judged on, as the run's score recorded them.
  const facts = (t) => JSON.parse(c.sql('SELECT facts FROM run_scores WHERE task_id = ? ORDER BY scored_at DESC LIMIT 1', t.id)[0]?.facts ?? '{}');
  ev.check('the security review\'s gate reads its own verdict: pass, no major findings',
    facts(both.security_review)['review.verdict'] === 'pass' && facts(both.security_review)['review.major_findings'] === 0, facts(both.security_review));
  ev.check('"Review the change" reads its own verdict: needs_changes, one major finding',
    facts(both.review)['review.verdict'] === 'needs_changes' && facts(both.review)['review.major_findings'] === 1, facts(both.review));
  ev.check('each review\'s gate counts one ReviewReport, its own',
    facts(both.security_review)['artifact.ReviewReport.count'] === 1 && facts(both.review)['artifact.ReviewReport.count'] === 1,
    [facts(both.security_review)['artifact.ReviewReport.count'], facts(both.review)['artifact.ReviewReport.count']]);
  await openMission(c, id, 'plan');
  await shot(c, ev, 'two-reviews');

  const shipped = await until(async () => { const v = await ship(c, id); return v.prs.length > 0 && v; }, { label: 'ship opened', timeoutMs: 180_000 }).catch(() => null);
  ev.check('the pull request opens after both reviews', shipped !== null && shipped.prs.length === 1, shipped?.headline);
} catch (e) {
  ev.check(`scenario ran to the end (${e.message.split('\n')[0]})`, false);
}
c.close(); ev.save();
