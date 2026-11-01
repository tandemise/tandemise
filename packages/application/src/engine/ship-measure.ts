import type {
  EvaluationRepositoryPort, MergeFacts, MergePolicyOrError, Mission, MissionCriteriaRepositoryPort, MissionTask,
  OutcomeStats, PlanDecisionRepositoryPort, PlannerConfig, PullRequestChecks, PullRequestRef, Repository,
  RunScoreRepositoryPort, TaskRepositoryPort,
} from '@tandemise/domain';
import { matchAnyGlob, matchGlob, stepClassFor } from '@tandemise/domain';

/**
 * The merge decision's inputs (#53 §8.2), measured at one head commit from git,
 * GitHub and the daemon's own records. Nothing here reads an artifact's body,
 * a pull request's text or anything an agent wrote about its work.
 */
export const DEPENDENCY_MANIFESTS = ['**/package.json', '**/go.mod', '**/Cargo.toml', '**/pyproject.toml', '**/requirements*.txt', '**/Gemfile'];
export const LOCKFILES = ['**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/go.sum', '**/Cargo.lock', '**/poetry.lock', '**/Gemfile.lock'];
/** A revert or broken main in an area this recently adds caution (#53 §8.3). */
export const RECENT_REVERT_DAYS = 14;

export type GitRunner = (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface MeasureInput {
  readonly mission: Mission;
  readonly repository: Repository;
  readonly pr: PullRequestRef;
  /** The base to diff against: a ref that exists locally. */
  readonly baseRef: string;
  readonly checks: PullRequestChecks;
  readonly protection: { readonly requiredChecks: boolean | null; readonly reviewRequired: boolean | null };
  readonly policy: MergePolicyOrError;
  readonly planner: PlannerConfig;
  /** The head Tandemise pushed; commits after it are someone else's. */
  readonly pushedSha: string | null;
  readonly repos: number;
  readonly stats: Pick<OutcomeStats, 'areas'>;
  /** Holds on this mission's steps (#50): 0 when there were none; null only when the hold store isn't bound. */
  readonly holds: number | null;
  readonly now: number;
}

export interface MeasureDeps {
  readonly git: GitRunner;
  readonly tasks: Pick<TaskRepositoryPort, 'listByMission'>;
  readonly evaluations: Pick<EvaluationRepositoryPort, 'latestChecksForTask'>;
  readonly runScores: Pick<RunScoreRepositoryPort, 'listByTask'>;
  readonly criteria: Pick<MissionCriteriaRepositoryPort, 'listActive'>;
  readonly planDecisions: Pick<PlanDecisionRepositoryPort, 'latest'>;
}

/** A measurement that failed: the decision asks rather than read an empty change. */
export class MeasureError extends Error {}

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

function latestScore(deps: MeasureDeps, task: MissionTask | undefined) {
  if (task === undefined) return undefined;
  return [...deps.runScores.listByTask(task.id)].sort((a, b) => (a.scoredAt < b.scoredAt ? -1 : 1)).at(-1);
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export async function measureMergeFacts(deps: MeasureDeps, input: MeasureInput): Promise<MergeFacts> {
  const range = `${input.baseRef}...${input.pr.headSha}`;
  const numstat = await deps.git(['diff', '--numstat', range]);
  if (numstat.exitCode !== 0) throw new MeasureError(firstLine(numstat.stderr) ?? 'git diff failed');
  const deleted = await deps.git(['diff', '--diff-filter=D', '--name-only', range]);
  if (deleted.exitCode !== 0) throw new MeasureError(firstLine(deleted.stderr) ?? 'git diff failed');
  const rows = lines(numstat.stdout).map((l) => l.split('\t')).filter((p) => p.length >= 3);
  const deletedPaths = lines(deleted.stdout);
  const changedPaths = rows.map((r) => r[2]!).filter((p) => !deletedPaths.includes(p));
  const all = rows.map((r) => r[2]!);
  let added = 0; let removed = 0; let binary = 0;
  for (const [a, r] of rows) {
    if (a === '-' || r === '-') { binary++; continue; }
    added += Number(a); removed += Number(r);
  }

  const areas: { name: string; sensitivity: MergeFacts['areas'][number]['sensitivity']; paths: string[] }[] = [];
  for (const path of all) {
    const area = input.planner.areas.find((a) => a.paths.some((g) => matchGlob(g, path)));
    if (area === undefined) continue;
    const found = areas.find((a) => a.name === area.name);
    if (found === undefined) areas.push({ name: area.name, sensitivity: area.sensitivity, paths: [path] });
    else found.paths.push(path);
  }
  const testGlobs = 'error' in input.policy ? [] : input.policy.tests;
  const deps_ = all.filter((p) => matchAnyGlob([...DEPENDENCY_MANIFESTS, ...LOCKFILES], p));

  const tasks = deps.tasks.listByMission(input.mission.id);
  const code = [...tasks].reverse().find((t) => t.status === 'SUCCEEDED' && (stepClassFor(t) === 'implement' || stepClassFor(t) === 'resolve_conflicts'));
  const tests = code === undefined ? undefined : deps.evaluations.latestChecksForTask(code.id).find((c) => c.name === 'checks.tests');
  const review = [...tasks].reverse().find((t) => t.status === 'SUCCEEDED' && stepClassFor(t) === 'review');
  const reviewFacts = latestScore(deps, review)?.facts ?? {};
  const verify = [...tasks].reverse().find((t) => t.status === 'SUCCEEDED' && stepClassFor(t) === 'verify');
  const verifyScore = latestScore(deps, verify);

  const criteria = deps.criteria.listActive(input.mission.id).filter((c) => c.status === 'accepted');
  const userCount = criteria.filter((c) => c.source === 'user').length;
  const unverified = verifyScore?.criteria?.unverified ?? userCount;

  const decision = deps.planDecisions.latest(input.mission.id);
  const agentTasks = tasks.filter((t) => t.executor === 'agent');
  let personCommits = 0;
  if (input.pushedSha !== null && input.pushedSha !== input.pr.headSha) {
    // A branch rewritten after Tandemise pushed (a force-push, a rebase in GitHub) can't be told apart: it asks.
    const kept = await deps.git(['merge-base', '--is-ancestor', input.pushedSha, input.pr.headSha]);
    if (kept.exitCode !== 0) throw new MeasureError('its branch no longer contains the commit Tandemise pushed');
    // Non-merge commits on the branch that Tandemise didn't push, by author: a person's edit in GitHub's web UI is
    // committed by noreply@github.com but authored by them, so the committer says nothing. Merges (Update branch) are left out.
    const log = await deps.git(['log', '--no-merges', '--format=%ae', `${input.baseRef}..${input.pr.headSha}`, `^${input.pushedSha}`]);
    if (log.exitCode !== 0) throw new MeasureError(firstLine(log.stderr) ?? 'git log failed');
    personCommits = lines(log.stdout).filter((email) => !email.toLowerCase().endsWith(TANDEMISE_DOMAIN)).length;
  }

  const touched = areas.map((a) => input.stats.areas[a.name]).filter((a) => a !== undefined);
  const recent = input.now - RECENT_REVERT_DAYS * 86_400_000;
  const independent = reviewFacts['review.independent'];

  return {
    changedPaths, deletedPaths, files: all.length, linesAdded: added, linesRemoved: removed, binaryFiles: binary,
    repos: input.repos, areas, testsTouched: all.filter((p) => matchAnyGlob(testGlobs, p)).length,
    dependenciesChanged: deps_.length > 0, lockfileOnly: deps_.length > 0 && deps_.every((p) => matchAnyGlob(LOCKFILES, p)),
    coverageChangedLines: null,
    ci: { state: input.checks.state, requiredPresent: input.protection.requiredChecks },
    reviewRequired: input.protection.reviewRequired,
    checksTests: tests === undefined ? null : tests.outcome,
    review: {
      blocking: review === undefined ? null : num(reviewFacts['review.blocking_findings']),
      major: review === undefined ? null : num(reviewFacts['review.major_findings']),
      independent: independent === undefined || independent === null ? null : independent === true || independent === 'PASS',
    },
    criteria: { unverified, implicit: criteria.length > 0 && criteria.every((c) => c.source === 'implicit') },
    process: {
      lane: decision?.lane ?? 'standard',
      lightenedByPerson: decision?.lightenedByPerson ?? false,
      stepsSkipped: decision?.skipped.length ?? 0,
      holds: input.holds,
      changesRequested: agentTasks.reduce((n, t) => n + Math.max(0, (t.round ?? 1) - 1), 0),
      escalations: agentTasks.filter((t) => t.attempts >= 2 && (t.modelPolicy?.escalate?.length ?? 0) > 0).length
        + agentTasks.filter((t) => t.modelPolicy?.reason === 'moved up after changes were requested').length,
      gateRetries: agentTasks.reduce((n, t) => n + Math.max(0, t.attempts - 1), 0),
      personCommits,
      // Set by the daemon when it opens a revert of its own merge (#53 §8.7), never by a person's text.
      revertOfAuto: input.mission.workflowInputs['revertOfAuto'] === 'true',
      retryOutOfScope: agentTasks.some((t) => deps.evaluations.latestChecksForTask(t.id).some((c) => c.name === SCOPE_RETRY_CHECK && c.outcome === 'FAIL')),
    },
    history: touched.length === 0 ? { areaReverts90d: 0, areaRecentRevert: false } : {
      areaReverts90d: touched.reduce((n, a) => n + a.reverts90d, 0),
      areaRecentRevert: touched.some((a) => a.lastRevertAt !== null && Date.parse(a.lastRevertAt) >= recent),
    },
  };
}

/** The check a retry records about the files it added to its step's change (#117). */
export const SCOPE_RETRY_CHECK = 'scope.retry';

/** Every identity Tandemise commits as (agents' roles, ship, factory) is at this domain. */
const TANDEMISE_DOMAIN = '@tandemise.local';

function firstLine(text: string): string | null {
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? null;
}
