import { z } from 'zod';
import { TandemiseError, asId } from '@tandemise/shared';
import {
  addRepositoryRequest, cancelMissionRequest, replanMissionRequest, connectIntegrationRequest, createIntegrationRequest, createMissionRequest,
  createRuntimeProfileRequest, createWorkspaceRequest, decideApprovalRequest, listMissionsQuery,
  missionEventsQuery, probeRepositoryRequest, retryTaskRequest, updateIntegrationRequest,
  updateRuntimeProfileRequest, updateWorkspaceRequest, upsertRoleRequest,
  claimTaskRequest, completeTaskRequest, createPersonRequest, updatePersonRequest, addMemberRequest,
  updateMemberRequest, roleStaffingPatchRequest, taskStaffingPatchRequest, missionFeedQuery, missionArtifactsQuery, artifactSearchQuery,
  dismissFeedbackRequest, giveFeedbackRequest, startRoundRequest,
  addCriterionRequest, answerQuestionRequest, criterionVerdictRequest, updateMissionRequest, workspaceUsageQuery,
  advanceClockRequest, createRoutineRequest, updateRoutineRequest, importSkillRequest, previewSkillRequest,
  takeNotificationsRequest, updateNotificationPreferencesRequest,
  updateIssueSettingsRequest,
  applySetupRequest, exportSetupRequest, previewSetupRequest,
  parkTaskRequest, handBackRequest, resolveWorkspaceLinkRequest,
  createEvalSuiteRequest, saveEvalCaseRequest, startEvalRunRequest, runScoresQuery,
  planMissionRequest, setLaneRequest, mergePolicyRequest,
  ACCEPTED_INTAKE_SCHEMAS, intakeSignalsQuery, mintIntakeTokenRequest,
  decideIntakeSignalRequest,
  startBoardItemRequest,
  saveIntakeSourceSecretRequest, saveTrackerSecretRequest, setIntakeSourceEnabledRequest,
  ackIntakeClosureRequest,
  connectRelayRequest, coordinationEndpointRequest, coordinationPullRequest, projectKeyRequest, takeOverClaimRequest,
} from '@tandemise/api-contract';
import type { EvalSuiteView } from '@tandemise/api-contract';
import { normalizeLimits } from '@tandemise/domain';
import { ContributionError, EvalError } from '@tandemise/application';
import type { TandemiseServices } from '@tandemise/application';
import type { AdjustableClock } from '@tandemise/shared';
import { CONTRIBUTION_BODY, HANDLED, Router, formatZodIssues, type RequestContext } from './http/router.js';
import { createInviteRequest, mailboxAckRequest } from '@tandemise/api-contract/relay';
import { MAX_BODY_BYTES } from '@tandemise/coordination';
import type { SwitchableCoordination } from './coordination.js';
import { brainRoutes } from './brain-routes.js';

/**
 * The daemon's HTTP surface.
 *
 * Handlers are thin on purpose: parse, delegate, return. Any handler that grows
 * a branch is a service method that has not been written yet. Keeping it this
 * way means the API is a projection of the application layer rather than a
 * second place where mission rules live.
 */
export function buildRouter(services: TandemiseServices, options: {
  readonly testClock?: AdjustableClock | null;
  readonly coordination?: SwitchableCoordination;
  /** Test-only event recording (TANDEMISE_TEST_ROUTES=1); null in every real daemon. */
  readonly testEvents?: ((missionId: string, taskId: string | null, body: Record<string, unknown>) => unknown) | null;
} = {}): Router {
  const r = new Router();

  /**
   * Parses query parameters the same way `ctx.body()` parses bodies. A raw
   * ZodError escaping a handler is mapped to INTERNAL, which turns a mistyped
   * `?limit=9999` into a 500 with the whole issue array in the message. The
   * input side is `unknown` so a schema may transform its strings, e.g. 'true'
   * into a boolean.
   */
  const query = <T>(ctx: RequestContext, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T => {
    const parsed = schema.safeParse(Object.fromEntries(ctx.query));
    if (!parsed.success) throw TandemiseError.validation(formatZodIssues(parsed.error));
    return parsed.data;
  };

  const required = (ctx: RequestContext, name: string): string => {
    const value = ctx.query.get(name);
    if (!value) throw TandemiseError.validation(`Query parameter '${name}' is required.`);
    return value;
  };

  /**
   * Maps an `EvalError` (spec Part B) the way `ContributionError` is mapped
   * below: `already_running` is a 409, so the client can offer to cancel the
   * run in the way; every other refusal is a 400 carrying the service's own
   * message, with the code kept on `details` for a client that wants to react
   * to it (e.g. re-show the spend cap field on `cap_required`).
   */
  const mapEvalError = (e: unknown): unknown => {
    if (!(e instanceof EvalError)) return e;
    return e.code === 'already_running'
      ? new TandemiseError('CONFLICT', e.message, { details: { code: e.code } })
      : TandemiseError.validation(e.message, { code: e.code });
  };

  // ---------------------------------------------------------------- system
  r.get('/v1/system', () => services.system.info());
  r.get('/v1/settings', () => services.system.settings());
  r.patch('/v1/settings', async (ctx) =>
    services.system.updateSettings(await ctx.body(z.record(z.string(), z.unknown()))));
  r.get('/v1/diagnostics', () => services.system.diagnostics());

  // Desktop notifications (P16): preferences for Settings, and the desktop main process's poll.
  r.get('/v1/notifications/preferences', () => services.notifications.preferences());
  r.put('/v1/notifications/preferences', async (ctx) =>
    services.notifications.updatePreferences(await ctx.body(updateNotificationPreferencesRequest)));
  r.post('/v1/notifications/take', async (ctx) =>
    services.notifications.take(ctx.caller, await ctx.body(takeNotificationsRequest)));

  // ------------------------------------------------------------ workspaces
  r.get('/v1/home', (ctx) => services.projections.home(ctx.query.get('workspaceId') ?? undefined));
  r.get('/v1/inbox', (ctx) => services.projections.inbox(asId(required(ctx, 'workspaceId'))));
  r.get('/v1/workspaces', () => services.workspaces.list());
  r.post('/v1/workspaces', async (ctx) =>
    services.workspaces.create(ctx.caller, await ctx.body(createWorkspaceRequest)));
  r.get('/v1/workspaces/:id', (ctx) => services.workspaces.view(asId(ctx.params.id!)));
  r.patch('/v1/workspaces/:id', async (ctx) => {
    const patch = await ctx.body(updateWorkspaceRequest);
    const view = services.workspaces.update(asId(ctx.params.id!), patch);
    // A limit changed (P8): a stop it no longer justifies is lifted, and the view is read after.
    if (patch.defaultMissionLimits === undefined && patch.monthlyLimits === undefined) return view;
    services.limits.limitsChanged(asId(ctx.params.id!));
    return services.workspaces.view(asId(ctx.params.id!));
  });
  // A month's usage against the monthly limits (P8); the current local month by default.
  r.get('/v1/workspaces/:id/usage', (ctx) =>
    services.limits.usage(asId(ctx.params.id!), query(ctx, workspaceUsageQuery).month));

  r.get('/v1/workspaces/:id/repositories', (ctx) => services.workspaces.listRepositories(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/repositories', async (ctx) =>
    services.workspaces.addRepository(asId(ctx.params.id!), await ctx.body(addRepositoryRequest)));
  r.post('/v1/repositories/probe', async (ctx) =>
    services.workspaces.probeRepository((await ctx.body(probeRepositoryRequest)).path));
  r.patch('/v1/repositories/:id', async (ctx) =>
    services.workspaces.updateRepository(asId(ctx.params.id!), await ctx.body(addRepositoryRequest.partial())));
  r.delete('/v1/repositories/:id', (ctx) => services.workspaces.removeRepository(asId(ctx.params.id!)));

  // --------------------------------------------------------------- missions
  r.get('/v1/missions', (ctx) => {
    return services.missions.list(query(ctx, listMissionsQuery));
  });
  // Answered with the full MissionDetail, the same shape as GET: the desktop
  // navigates to `detail.mission.id`, and a bare Mission made that throw, so
  // "Plan mission" created the mission and left the user on the empty form.
  r.post('/v1/missions', async (ctx) => {
    const mission = await services.missions.create(ctx.caller, await ctx.body(createMissionRequest));
    return services.projections.missionDetail(mission.id);
  }, CONTRIBUTION_BODY);
  r.get('/v1/missions/:id', (ctx) => services.projections.missionDetail(asId(ctx.params.id!)));
  // The backlog (P7): priority, rank, queue or a move; answered with the project's backlog.
  r.patch('/v1/missions/:id', async (ctx) => {
    const { limits, ...backlog } = await ctx.body(updateMissionRequest);
    const id = asId<'MissionId'>(ctx.params.id!);
    // Limits (P8) answer with the mission; a backlog change answers with the backlog, as before.
    if (limits !== undefined) {
      services.limits.setMissionLimits(id, limits === null ? null : normalizeLimits(limits));
      if (Object.keys(backlog).length === 0) return services.projections.missionDetail(id);
    }
    return services.backlog.update(id, backlog);
  });
  r.get('/v1/workspaces/:id/backlog', (ctx) => services.backlog.view(asId(ctx.params.id!)));
  // The status report (P10): rendered from stored facts, stored as the next version of the project's line.
  r.post('/v1/workspaces/:id/status-report', (ctx) => services.desk.writeStatusReport(asId(ctx.params.id!), ctx.caller));
  r.delete('/v1/missions/:id', (ctx) => services.missions.remove(asId(ctx.params.id!)));

  // Routines (P11): standing work that adds queued missions on a schedule.
  r.get('/v1/workspaces/:id/routines', (ctx) => services.routines.list(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/routines', async (ctx) =>
    services.routines.create(ctx.caller, asId(ctx.params.id!), await ctx.body(createRoutineRequest)));
  r.get('/v1/routines/:id', (ctx) => services.routines.view(asId(ctx.params.id!)));
  r.patch('/v1/routines/:id', async (ctx) => services.routines.update(asId(ctx.params.id!), await ctx.body(updateRoutineRequest)));
  r.delete('/v1/routines/:id', (ctx) => services.routines.remove(asId(ctx.params.id!)));
  r.post('/v1/routines/:id/run-now', (ctx) => services.routines.runNow(ctx.caller, asId(ctx.params.id!)));

  // GitHub issues in and out (P14).
  r.get('/v1/workspaces/:id/issues', (ctx) => services.issues.overview(asId(ctx.params.id!)));
  r.patch('/v1/repositories/:id/issues', async (ctx) =>
    services.issues.configure(ctx.caller, asId(ctx.params.id!), await ctx.body(updateIssueSettingsRequest)));
  r.post('/v1/repositories/:id/issues/check', (ctx) => services.issues.checkNow(ctx.caller, asId(ctx.params.id!)));
  // Intake spec §10: this repository's GitHub Issues become the project's tracker (plan Task 10).
  r.post('/v1/repositories/:id/issues/use-as-tracker', (ctx) => services.issues.adoptAsTracker(ctx.caller, asId(ctx.params.id!)));

  // Intake (spec 2026-10-30-intake-design.md §2): custom runners push signals
  // with an intake token (the listener resolves it into ctx.intake) or the
  // daemon token plus ?workspace=&source=. The push answers 202 per signal.
  r.get('/v1/intake/schema', () => ({ accepted: [...ACCEPTED_INTAKE_SCHEMAS] }));
  r.post('/v1/intake/signals', async (ctx) => {
    const scope = services.intake.pushScope(ctx.intake, ctx.query.get('workspace'), ctx.query.get('source'));
    return { results: await services.intake.ingestMany(scope, await ctx.body(z.unknown())) };
  }, { status: 202 });
  r.get('/v1/workspaces/:id/intake/signals', (ctx) => {
    const q = query(ctx, intakeSignalsQuery);
    return services.intake.list(asId(ctx.params.id!), { ...(q.status === undefined ? {} : { statuses: q.status }), ...(q.limit === undefined ? {} : { limit: q.limit }) });
  });
  r.get('/v1/workspaces/:id/intake/config', (ctx) => services.intake.config(asId(ctx.params.id!)));
  r.put('/v1/workspaces/:id/intake/config', async (ctx) =>
    services.intake.configure(ctx.caller, asId(ctx.params.id!), await ctx.body(z.unknown())));
  r.post('/v1/workspaces/:id/intake/tokens', async (ctx) =>
    services.intake.mintToken(ctx.caller, asId(ctx.params.id!), (await ctx.body(mintIntakeTokenRequest)).sourceId));
  r.delete('/v1/intake/tokens/:id', (ctx) => { services.intake.revokeToken(ctx.caller, asId(ctx.params.id!)); });
  // Secrets go to the local secret store only; the answer is 204 (plan Task 11, RULINGS ruling 17).
  r.put('/v1/workspaces/:id/intake/sources/:sourceId/secret', async (ctx) => {
    await services.intake.saveSourceSecret(ctx.caller, asId(ctx.params.id!), ctx.params.sourceId!, await ctx.body(saveIntakeSourceSecretRequest));
  });
  r.put('/v1/workspaces/:id/intake/tracker/secret', async (ctx) => {
    await services.intake.saveTrackerSecret(ctx.caller, asId(ctx.params.id!), (await ctx.body(saveTrackerSecretRequest)).value);
  });
  // A source runs on this machine, or not (Ruling 22): a brain's source is off here until switched on.
  r.put('/v1/workspaces/:id/intake/sources/:sourceId/enabled', async (ctx) =>
    services.intake.setSourceEnabled(ctx.caller, asId(ctx.params.id!), ctx.params.sourceId!, (await ctx.body(setIntakeSourceEnabledRequest)).enabled));
  // "Use the new address" (Ruling 23): a saved token follows a moved address only once its person confirms it.
  r.post('/v1/workspaces/:id/intake/tracker/confirm-origin', (ctx) => services.intake.confirmTrackerOrigin(ctx.caller, asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/intake/sources/:sourceId/confirm-origin', (ctx) =>
    services.intake.confirmSourceOrigin(ctx.caller, asId(ctx.params.id!), ctx.params.sourceId!));
  // The Inbox card's answer, and "try now" for a signal the tracker could not take (plan Task 7).
  r.post('/v1/intake/signals/:id/decide', async (ctx) =>
    services.intake.decide(ctx.caller, asId(ctx.params.id!), (await ctx.body(decideIntakeSignalRequest)).decision));
  r.post('/v1/intake/signals/:id/retry', (ctx) => services.intake.retry(ctx.caller, asId(ctx.params.id!)));
  // Closures (spec §2, §8, plan Task 13): a custom source pulls its own feed and
  // acks each one, with its intake token or the daemon token plus ?workspace=.
  // Retry is the Intake tab's, with the daemon token only.
  r.get('/v1/intake/closures', (ctx) => {
    const scope = services.closures.feedScope(ctx.intake, ctx.query.get('workspace'), ctx.query.get('sourceId'));
    return services.closures.feed(scope, ctx.query.get('after'));
  });
  r.post('/v1/intake/closures/:id/ack', async (ctx) =>
    services.closures.ack(ctx.intake, () => ctx.caller, ctx.params.id!, await ctx.body(ackIntakeClosureRequest)));
  r.post('/v1/intake/closures/:id/retry', (ctx) => services.closures.retry(ctx.caller, ctx.params.id!));
  // The board from the primary tracker, and Start (plan Task 8). Start names
  // the item in the body: a GitHub ref holds `/` and `#`.
  r.get('/v1/workspaces/:id/board', (ctx) => services.tracker.board(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/board/refresh', (ctx) => services.tracker.refreshBoard(asId(ctx.params.id!)));
  // "Check sources now" (spec §2, plan Task 10): every poll at once, waited for, then the refreshed board.
  r.post('/v1/workspaces/:id/intake/check', (ctx) => services.intakeRunners.checkNow(ctx.caller, asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/board/start', async (ctx) => {
    const workspaceId = asId<'WorkspaceId'>(ctx.params.id!);
    const request = await ctx.body(startBoardItemRequest);
    const mission = await services.tracker.start(ctx.caller, workspaceId, request.key, request.lane);
    const summary = services.missions.list({ workspaceId }).find((s) => s.mission.id === mission.id);
    if (summary === undefined) throw TandemiseError.notFound('Mission', mission.id);
    return summary;
  });

  // Skills (P13): the project's library, imported by content hash and pinned per run.
  r.get('/v1/workspaces/:id/skills', (ctx) => services.skills.list(asId(ctx.params.id!)));
  r.get('/v1/workspaces/:id/skills/discover', (ctx) => services.skills.discover(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/skills/preview', async (ctx) =>
    services.skills.preview(asId(ctx.params.id!), (await ctx.body(previewSkillRequest)).source));
  r.post('/v1/workspaces/:id/skills', async (ctx) => services.skills.import(asId(ctx.params.id!), await ctx.body(importSkillRequest)));
  r.get('/v1/skills/:id/versions/:version', (ctx) => {
    const version = Number(ctx.params.version);
    if (!Number.isInteger(version) || version < 1) throw TandemiseError.validation('A version is a whole number from 1.');
    return services.skills.version(asId(ctx.params.id!), version);
  });
  r.post('/v1/skills/:id/update', (ctx) => services.skills.update(asId(ctx.params.id!)));
  r.delete('/v1/skills/:id', (ctx) => services.skills.remove(asId(ctx.params.id!)));
  // ------------------------------------------------------ setup as code (P15)
  r.get('/v1/workspaces/:id/setup', (ctx) => services.setup.status(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/setup/export', async (ctx) =>
    services.setup.export(asId(ctx.params.id!), (await ctx.body(exportSetupRequest)).repositoryId));
  r.post('/v1/workspaces/:id/setup/preview', async (ctx) =>
    services.setup.preview(asId(ctx.params.id!), (await ctx.body(previewSetupRequest)).path));
  r.post('/v1/workspaces/:id/setup/apply', async (ctx) =>
    services.setup.apply(ctx.caller, asId(ctx.params.id!), await ctx.body(applySetupRequest)));
  brainRoutes(r, services);

  // -------------------------------------------------------------- evals (P3b)
  // Suites of frozen cases, saving a finished gated step as one, and trying a
  // candidate role/skills/setup against a suite (spec Part B).
  r.get('/v1/workspaces/:id/evals/suites', (ctx) => services.evals.listSuites(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/evals/suites', async (ctx) => {
    try {
      const suite = services.evals.createSuite(asId(ctx.params.id!), ctx.caller, (await ctx.body(createEvalSuiteRequest)).name);
      // The EvalSuiteView the client reads: a suite just made has no cases.
      return { id: suite.id, name: suite.name, cases: 0, createdAt: suite.createdAt } satisfies EvalSuiteView;
    } catch (e) { throw mapEvalError(e); }
  });
  r.delete('/v1/evals/suites/:id', (ctx) => {
    try {
      return services.evals.deleteSuite(asId(ctx.params.id!), ctx.caller);
    } catch (e) { throw mapEvalError(e); }
  });
  r.get('/v1/evals/suites/:id/cases', (ctx) => services.evals.caseViews(asId(ctx.params.id!)));
  r.delete('/v1/evals/cases/:id', (ctx) => {
    try {
      return services.evals.deleteCase(asId(ctx.params.id!), ctx.caller);
    } catch (e) { throw mapEvalError(e); }
  });
  // A finished, gated step saved as a replayable case; the task the step ran as.
  r.post('/v1/tasks/:id/eval-case', async (ctx) => {
    try {
      const { suiteId, ...rest } = await ctx.body(saveEvalCaseRequest);
      const kase = await services.evals.saveCase(asId(ctx.params.id!), ctx.caller, {
        ...rest, suiteId: suiteId === undefined ? undefined : asId(suiteId),
      });
      // The EvalCaseView the client reads, not the stored case with its full snapshot.
      return services.evals.caseView(kase);
    } catch (e) { throw mapEvalError(e); }
  });
  r.get('/v1/evals/suites/:id/runs', (ctx) =>
    services.evals.listRuns(asId(ctx.params.id!)).map((run) => services.evals.runView(run.id)));
  r.post('/v1/evals/suites/:id/runs', async (ctx) => {
    try {
      const run = await services.evals.startRun(asId(ctx.params.id!), ctx.caller, await ctx.body(startEvalRunRequest));
      return services.evals.runView(run.id);
    } catch (e) { throw mapEvalError(e); }
  });
  r.get('/v1/evals/runs/:id', (ctx) => services.evals.runView(asId(ctx.params.id!)));
  r.post('/v1/evals/runs/:id/cancel', (ctx) => {
    try {
      return services.evals.cancelRun(asId(ctx.params.id!), ctx.caller);
    } catch (e) { throw mapEvalError(e); }
  });
  // "From your runs" (spec B1): real-run summaries by role and model, over the last 7/30/90 days.
  r.get('/v1/workspaces/:id/evals/run-scores', (ctx) =>
    services.evals.runScoreSummary(asId(ctx.params.id!), Number(query(ctx, runScoresQuery).days) as 7 | 30 | 90));

  // The test clock (P11): registered only under TANDEMISE_CLOCK_OFFSET_MS, so a
  // normal daemon answers 404 and nothing can move its time.
  const testClock = options.testClock ?? null;
  if (testClock !== null) {
    r.post('/v1/test/clock', async (ctx) => {
      const { advanceMs } = await ctx.body(advanceClockRequest);
      const offsetMs = testClock.advance(advanceMs);
      return { now: testClock.now(), offsetMs };
    });
  }
  const testEvents = options.testEvents ?? null;
  if (testEvents !== null) {
    // Test-only (#51 acceptance): records an event body on a mission, as another feature would.
    r.post('/v1/test/events', async (ctx) => {
      const body = (await ctx.body(z.object({ missionId: z.string().min(1), taskId: z.string().min(1).optional(), body: z.record(z.string(), z.unknown()) })));
      return testEvents(body.missionId, body.taskId ?? null, body.body);
    });
  }

  // Plan, or Plan quick / Plan careful for a mission the factory plans (#53 §10).
  r.post('/v1/missions/:id/plan', async (ctx) =>
    services.factory.plan(asId(ctx.params.id!), (await ctx.body(planMissionRequest)).lane, ctx.caller));
  r.get('/v1/missions/:id/plan-decision', (ctx) => services.factory.planDecision(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/lane', async (ctx) =>
    services.factory.setLane(asId(ctx.params.id!), (await ctx.body(setLaneRequest)).lane, ctx.caller));
  r.get('/v1/missions/:id/ship', (ctx) => services.factory.ship(asId(ctx.params.id!)));
  // Project → Factory (#53 §10, §11): where the factory files came from, the routing they give, and writing the defaults.
  r.get('/v1/workspaces/:id/factory', (ctx) => services.factory.factory(asId(ctx.params.id!)));
  r.get('/v1/workspaces/:id/routing', (ctx) => services.factory.routing(asId(ctx.params.id!)));
  r.post('/v1/workspaces/:id/factory/defaults', (ctx) => services.factory.writeDefaults(asId(ctx.params.id!), ctx.caller));
  // Project → Merge (#53 §8.4): the policy, its backtest, a person's edit and the kill switch.
  r.get('/v1/workspaces/:id/merge-policy', (ctx) => services.mergePolicy.get(asId(ctx.params.id!)));
  r.put('/v1/workspaces/:id/merge-policy', async (ctx) =>
    services.mergePolicy.update(asId(ctx.params.id!), (await ctx.body(mergePolicyRequest)).policy, ctx.caller));
  r.post('/v1/workspaces/:id/merge-policy/backtest', async (ctx) =>
    services.mergePolicy.backtest(asId(ctx.params.id!), (await ctx.body(mergePolicyRequest)).policy));
  r.post('/v1/ship/:decisionId/merge', (ctx) => services.shipActions.merge(ctx.params.decisionId!, ctx.caller));
  r.post('/v1/ship/:decisionId/revert', (ctx) => services.shipActions.revert(ctx.params.decisionId!, ctx.caller));
  r.post('/v1/workspaces/:id/merge-policy/stop', (ctx) => services.mergePolicy.stop(asId(ctx.params.id!), ctx.caller));
  r.post('/v1/missions/:id/replan', async (ctx) =>
    services.planning.replan(asId(ctx.params.id!), { note: (await ctx.body(replanMissionRequest)).note ?? null }));
  r.post('/v1/missions/:id/start', (ctx) => services.missions.start(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/pause', (ctx) => services.missions.pause(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/resume', (ctx) => services.missions.resume(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/cancel', async (ctx) =>
    services.missions.cancel(asId(ctx.params.id!), (await ctx.body(cancelMissionRequest)).reason));

  r.get('/v1/missions/:id/events', (ctx) => {
    return services.projections.missionEvents(asId(ctx.params.id!), query(ctx, missionEventsQuery));
  });
  r.get('/v1/missions/:id/artifacts', (ctx) =>
    services.artifacts.listByMission(asId(ctx.params.id!), query(ctx, missionArtifactsQuery)));
  // Judged against the caller: which cards "need you" depends on who asks.
  r.get('/v1/missions/:id/feed', (ctx) =>
    services.projections.missionFeed(asId(ctx.params.id!), ctx.caller, query(ctx, missionFeedQuery)));
  r.get('/v1/missions/:id/tasks', (ctx) => services.projections.missionTasks(asId(ctx.params.id!)));
  r.get('/v1/missions/:id/criteria', (ctx) => services.criteria.list(asId(ctx.params.id!)));

  // ------------------------------------------------ refinement (ready before planning)
  r.post('/v1/missions/:id/refine', (ctx) => services.refinement.begin(ctx.caller, asId(ctx.params.id!)));
  r.get('/v1/missions/:id/refinement', (ctx) => services.refinement.view(asId(ctx.params.id!)));
  r.post('/v1/missions/:id/criteria', async (ctx) =>
    services.refinement.addCriterion(ctx.caller, asId(ctx.params.id!), await ctx.body(addCriterionRequest)));
  r.post('/v1/criteria/:id/verdict', async (ctx) =>
    services.refinement.decide(ctx.caller, asId(ctx.params.id!), await ctx.body(criterionVerdictRequest)));
  r.post('/v1/questions/:id/answer', async (ctx) =>
    services.refinement.answer(ctx.caller, asId(ctx.params.id!), await ctx.body(answerQuestionRequest)));

  r.post('/v1/tasks/:id/retry', async (ctx) =>
    services.missions.retryTask(ctx.caller, asId(ctx.params.id!), await ctx.body(retryTaskRequest)));
  // Keep waiting on a quiet run (P9); Stop and retry is the retry above with `stopRun`.
  r.post('/v1/runs/:id/snooze', (ctx) => services.liveness.snooze(asId(ctx.params.id!)));
  r.post('/v1/tasks/:id/skip', (ctx) => services.missions.skipTask(ctx.caller, asId(ctx.params.id!)));
  r.post('/v1/tasks/:id/complete', async (ctx) =>
    services.missions.completeTask(ctx.caller, asId(ctx.params.id!), await ctx.body(completeTaskRequest)));
  r.post('/v1/tasks/:id/claim', async (ctx) =>
    services.missions.claimTask(ctx.caller, asId(ctx.params.id!), await ctx.body(claimTaskRequest)));

  // "Continue elsewhere" and "hand back" (spec A4): an agent step's output moves
  // to another tool and comes back as a person's round.
  r.post('/v1/tasks/:id/park', async (ctx) =>
    services.missions.parkTask(asId(ctx.params.id!), ctx.caller, await ctx.body(parkTaskRequest)));
  // Takes no body worth the contribution cap: the default 8 MiB applies.
  r.post('/v1/tasks/:id/unpark', async (ctx) =>
    services.missions.unparkTask(asId(ctx.params.id!), ctx.caller));
  r.post('/v1/tasks/:id/hand-back', async (ctx) =>
    services.missions.handBack(asId(ctx.params.id!), ctx.caller, await ctx.body(handBackRequest)), CONTRIBUTION_BODY);

  // Hold (hold-and-interact spec): a person takes the keyboard in the step's own
  // session. The terminal itself is the WebSocket at /v1/tasks/:id/terminal.
  r.post('/v1/tasks/:id/hold', (ctx) => services.holds.hold(asId(ctx.params.id!), ctx.caller));
  r.post('/v1/tasks/:id/continue', (ctx) => services.holds.continue(asId(ctx.params.id!), ctx.caller));
  r.post('/v1/tasks/:id/release', (ctx) => services.holds.release(asId(ctx.params.id!), ctx.caller));
  r.post('/v1/tasks/:id/terminal/reopen', (ctx) => services.holds.reopen(asId(ctx.params.id!), ctx.caller));

  // ------------------------------------------------------- feedback and rounds
  // Attachments (spec A3) are pinned before the note lands, which `give` cannot
  // do synchronously; the route always takes the async path so a note without
  // a file costs nothing extra, and one carrying files still lands correctly.
  r.post('/v1/tasks/:id/feedback', async (ctx) =>
    services.feedback.giveWithAttachments(ctx.caller, asId(ctx.params.id!), await ctx.body(giveFeedbackRequest)), CONTRIBUTION_BODY);
  r.get('/v1/tasks/:id/feedback', (ctx) => services.feedback.list(asId(ctx.params.id!)));
  r.post('/v1/tasks/:id/rounds', async (ctx) =>
    services.feedback.startRound(ctx.caller, asId(ctx.params.id!), await ctx.body(startRoundRequest)));
  r.post('/v1/feedback/:id/dismiss', async (ctx) =>
    services.feedback.dismiss(ctx.caller, asId(ctx.params.id!), await ctx.body(dismissFeedbackRequest)));

  r.patch('/v1/tasks/:id/staffing', async (ctx) =>
    services.staffing.patchTask(ctx.caller, asId(ctx.params.id!), await ctx.body(taskStaffingPatchRequest)));
  r.get('/v1/tasks/:id/staffing/preview', (ctx) => services.staffing.preview(asId(ctx.params.id!)));

  // ---------------------------------------------------------- people and team
  r.get('/v1/me', (ctx) => services.team.me(ctx.caller));
  // People are global to the installation, not to a workspace: their CRUD needs no seat anywhere.
  r.get('/v1/people', () => services.team.listPeople());
  r.post('/v1/people', async (ctx) => services.team.createPerson(ctx.caller, await ctx.body(createPersonRequest)));
  // Global, like every person route: a rename shows in each workspace the person has a seat in.
  r.patch('/v1/people/:id', async (ctx) =>
    services.team.updatePerson(ctx.caller, asId(ctx.params.id!), await ctx.body(updatePersonRequest)));
  r.delete('/v1/people/:id', (ctx) => services.team.removePerson(ctx.caller, asId(ctx.params.id!)));

  r.get('/v1/workspaces/:id/team', (ctx) => services.team.team(asId(ctx.params.id!)));
  r.get('/v1/workspaces/:id/members', (ctx) => services.team.team(asId(ctx.params.id!)).members);
  r.post('/v1/workspaces/:id/members', async (ctx) =>
    services.team.addMember(ctx.caller, asId(ctx.params.id!), await ctx.body(addMemberRequest)));
  r.patch('/v1/members/:id', async (ctx) =>
    services.team.updateMember(ctx.caller, asId(ctx.params.id!), await ctx.body(updateMemberRequest)));
  r.delete('/v1/members/:id', (ctx) => services.team.removeMember(ctx.caller, asId(ctx.params.id!)));

  // --------------------------------------------------------------- staffing
  // Merged per role: a client that edits one role cannot erase the others.
  r.get('/v1/workspaces/:id/staffing', (ctx) => services.staffing.workspace(asId(ctx.params.id!)));
  r.patch('/v1/workspaces/:id/staffing', async (ctx) =>
    services.staffing.patchWorkspace(ctx.caller, asId(ctx.params.id!), await ctx.body(roleStaffingPatchRequest)));
  r.patch('/v1/missions/:id/staffing', async (ctx) =>
    services.staffing.patchMission(ctx.caller, asId(ctx.params.id!), await ctx.body(roleStaffingPatchRequest)));

  // -------------------------------------------------------------- artifacts
  r.get('/v1/artifacts', (ctx) => {
    const { workspaceId, q, includeSuperseded } = query(ctx, artifactSearchQuery);
    return services.artifacts.search(workspaceId === undefined ? undefined : asId(workspaceId), q ?? '', { includeSuperseded });
  });
  r.get('/v1/artifacts/:id', (ctx) => services.artifacts.read(asId(ctx.params.id!)));
  // The blob's absolute path (spec A4/A5): "reveal in Finder" and attaching an
  // Evidence file to the runtime a hand-back was continued in.
  r.get('/v1/artifacts/:id/path', (ctx) => ({ path: services.artifacts.path(asId(ctx.params.id!)) }));

  // A workspace link inside a note or a hand-back (spec A4): resolved against
  // the workspace's repositories and artifact root, never against the daemon's
  // own filesystem. ContributionError('outside_workspace') is the only way
  // this throws, mapped the same way mission-service and feedback-service
  // already map every other contribution refusal.
  r.post('/v1/workspace-links/resolve', async (ctx) => {
    const { workspaceId, path } = await ctx.body(resolveWorkspaceLinkRequest);
    try {
      return { path: await services.contributions.resolveWorkspacePath(asId(workspaceId), path) };
    } catch (e) {
      if (e instanceof ContributionError) throw TandemiseError.validation(e.message, { code: e.code });
      throw e;
    }
  });

  // -------------------------------------------------------------- approvals
  r.get('/v1/approvals', (ctx) => services.approvals.list({
    workspaceId: ctx.query.get('workspaceId') ?? undefined,
    missionId: ctx.query.get('missionId') ?? undefined,
    status: ctx.query.get('status') ?? undefined,
  }));
  r.get('/v1/approvals/:id', (ctx) => services.approvals.get(asId(ctx.params.id!)));
  r.post('/v1/approvals/:id/decide', async (ctx) =>
    services.approvals.decide(ctx.caller, asId(ctx.params.id!), await ctx.body(decideApprovalRequest)));

  // --------------------------------------------------------------- runtimes
  r.get('/v1/runtimes', (ctx) => services.runtimes.list(ctx.query.get('workspaceId') ?? undefined));
  r.post('/v1/runtimes/discover', () => services.runtimes.discover());
  r.post('/v1/runtimes', async (ctx) => services.runtimes.create(await ctx.body(createRuntimeProfileRequest)));
  r.patch('/v1/runtimes/:id', async (ctx) =>
    services.runtimes.update(asId(ctx.params.id!), await ctx.body(updateRuntimeProfileRequest)));
  r.delete('/v1/runtimes/:id', (ctx) => services.runtimes.remove(asId(ctx.params.id!)));
  r.post('/v1/runtimes/:id/health', (ctx) => services.runtimes.checkHealth(asId(ctx.params.id!)));

  // ------------------------------------------------------------------ roles
  r.get('/v1/roles', (ctx) => services.roles.list(ctx.query.get('workspaceId') ?? undefined));
  r.put('/v1/roles/:id', async (ctx) => {
    const body = await ctx.body(upsertRoleRequest);
    // The path names the resource; a body disagreeing with it is a client bug,
    // not a silent rename of a different role.
    if (body.id !== ctx.params.id) {
      throw TandemiseError.validation(`Role id in the path ('${ctx.params.id}') does not match the body ('${body.id}').`);
    }
    return services.roles.upsert(body);
  });
  r.delete('/v1/roles/:id', (ctx) =>
    services.roles.remove(ctx.params.id!, asId(required(ctx, 'workspaceId'))));

  // ------------------------------------------------------------- workflows
  // A project's own workflow files, then the built-in presets it has not
  // overridden. The path is returned so the UI can open a broken one.
  r.get('/v1/workflows', (ctx) => services.workflows.list(asId(required(ctx, 'workspaceId'))));

  // ----------------------------------------------------------- integrations
  r.get('/v1/integrations', (ctx) => {
    const workspaceId = ctx.query.get('workspaceId');
    return services.integrations.list(workspaceId === null ? undefined : asId(workspaceId));
  });
  r.get('/v1/integrations/providers', () => services.integrations.listProviders());
  r.get('/v1/integrations/connectors', () => services.integrations.listConnectors());
  r.post('/v1/integrations/connect', async (ctx) =>
    services.integrations.connect(await ctx.body(connectIntegrationRequest)));
  r.get('/v1/integrations/connect/:attemptId', (ctx) => services.integrations.connection(ctx.params.attemptId!));
  r.delete('/v1/integrations/connect/:attemptId', (ctx) =>
    services.integrations.cancelConnection(ctx.params.attemptId!));
  r.post('/v1/integrations', async (ctx) => services.integrations.create(await ctx.body(createIntegrationRequest)));
  r.patch('/v1/integrations/:id', async (ctx) =>
    services.integrations.update(asId(ctx.params.id!), await ctx.body(updateIntegrationRequest)));
  r.delete('/v1/integrations/:id', (ctx) => services.integrations.remove(asId(ctx.params.id!)));
  r.post('/v1/integrations/:id/health', (ctx) => services.integrations.checkHealth(asId(ctx.params.id!)));

  // --------------------------------------------------------------- machines
  r.get('/v1/targets', (ctx) => services.projections.targets(ctx.query.get('missionId') ?? undefined));

  // ----------------------------------------------------------- coordination
  // Who works on which tracker item, alone or with a team relay (relay spec).
  // The desktop never talks to a relay: every relay interaction is the daemon's.
  const c = services.coordination;
  const projectOf = (input: { workspaceId?: string | undefined; projectKey?: string | undefined }): string => {
    if (input.projectKey) return input.projectKey;
    if (input.workspaceId) return c.projectKey(input.workspaceId);
    throw TandemiseError.validation('Say which workspace or project.');
  };
  r.get('/v1/coordination/status', () => c.status());
  r.get('/v1/coordination/project-key', (ctx) => ({ projectKey: c.projectKey(required(ctx, 'workspaceId')) }));
  r.put('/v1/coordination/project-key', async (ctx) => {
    const body = await ctx.body(projectKeyRequest);
    if (!body.workspaceId) throw TandemiseError.validation('Say which workspace.');
    return { projectKey: c.setProjectKey(body.workspaceId, body.projectKey ?? null) };
  });
  r.get('/v1/coordination/claims', (ctx) => c.rows(required(ctx, 'workspaceId')));
  r.get('/v1/coordination/members', () => ({ members: c.members(), devices: c.devices() }));
  r.get('/v1/coordination/presence', () => c.presence());
  r.get('/v1/coordination/failures', () => c.failures());
  r.post('/v1/coordination/claims/:id/take-over', async (ctx) =>
    c.takeOver(ctx.params.id!, (await ctx.body(takeOverClaimRequest)).missionId ?? null));
  r.post('/v1/missions/:id/claim/take-back', (ctx) => c.takeBack(ctx.params.id!));
  r.post('/v1/missions/:id/claim/keep-going', (ctx) => { c.keepGoing(ctx.params.id!); });
  r.post('/v1/missions/:id/claim/stop', (ctx) => c.stopWorking(ctx.params.id!));
  r.post('/v1/coordination/connect', async (ctx) => {
    const body = await ctx.body(connectRelayRequest);
    await c.connect({ ...body, allowInsecure: body.allowInsecure ?? false });
    return c.status();
  });
  r.post('/v1/coordination/import', () => c.importLocal());
  r.post('/v1/coordination/disconnect', async () => {
    await c.disconnect();
    return c.status();
  });
  r.post('/v1/coordination/invites', async (ctx) => c.createInvite(await ctx.body(createInviteRequest)));
  r.delete('/v1/coordination/devices/:id', (ctx) => c.revokeDevice(ctx.params.id!));
  r.delete('/v1/coordination/members/:id', (ctx) => c.removeMember(ctx.params.id!));
  r.get('/v1/coordination/endpoints', () => c.endpoints());
  r.post('/v1/coordination/endpoints', async (ctx) => {
    const { workspaceId, projectKey, ...rest } = await ctx.body(coordinationEndpointRequest);
    return c.createEndpoint({ ...rest, projectKey: projectOf({ workspaceId, projectKey }) });
  });
  r.post('/v1/coordination/endpoints/:id/disable', (ctx) => c.disableEndpoint(ctx.params.id!));
  r.get('/v1/coordination/messages/parked', () => c.parked());
  r.post('/v1/coordination/messages/:id/retry', (ctx) => c.retryParked(ctx.params.id!));
  r.post('/v1/coordination/messages/:id/drop', (ctx) => c.dropParked(ctx.params.id!));
  r.post('/v1/coordination/mailbox/pull', async (ctx) => {
    const body = await ctx.body(coordinationPullRequest);
    return c.pull(projectOf(body), body.max ?? 10, body.leaseSeconds ?? 60);
  });
  r.post('/v1/coordination/mailbox/ack', async (ctx) => c.ack((await ctx.body(mailboxAckRequest)).ids));
  r.get('/v1/coordination/export', (ctx) => {
    const text = `${c.exportLines().join('\n')}\n`;
    ctx.res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-content-type-options': 'nosniff' });
    ctx.res.end(text);
    return HANDLED;
  });
  // The local mailbox's ingress, behind the daemon's bearer token unless the
  // person explicitly allowed unauthenticated loopback hooks (server.ts).
  r.post('/v1/hooks/:slug', async (ctx) => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of ctx.raw) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) throw TandemiseError.validation('That webhook body is larger than 1 MB.');
      chunks.push(chunk as Buffer);
    }
    const answer = options.coordination?.ingestLocal(ctx.params.slug!, {
      method: ctx.raw.method ?? 'POST', query: ctx.query, headers: ctx.raw.headers, body: Buffer.concat(chunks),
    }) ?? { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' };
    ctx.res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': Buffer.byteLength(answer.body) });
    ctx.res.end(answer.body);
    return HANDLED;
  }, { maxBodyBytes: MAX_BODY_BYTES });

  return r;
}
