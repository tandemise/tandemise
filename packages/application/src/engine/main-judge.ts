import type { CheckRunSummary, WorkflowRunSummary } from '@tandemise/domain';

/**
 * Whether a merge broke main (#186), judged only by the repository's own CI.
 *
 * Everything GitHub reports on a merge commit is not CI for it. Dependabot's
 * update jobs and code scanning run as `event: dynamic`, scheduled runs
 * belong to the clock, and a third-party check the pull request never ran
 * says nothing about this change. Main is judged by:
 *
 * - workflow runs triggered by the push to the base branch;
 * - workflows and checks the pull request itself was gated on.
 *
 * A failure is this merge's only if the same check passed, or didn't exist,
 * on the previous main commit. One that failed there too was already failing.
 */
export interface MainItem {
  /** The workflow, or null for a check run that isn't a GitHub Actions job. */
  readonly workflow: string | null;
  readonly job: string;
  readonly counted: boolean;
  /** Why it counts, or why it doesn't, in a sentence. */
  readonly why: string;
  readonly state: 'pass' | 'fail' | 'pending';
  readonly link: string | null;
}

/** What the pull request was gated on: the workflow files and check names on its head commit. */
export interface Gate {
  readonly workflows: ReadonlySet<string>;
  readonly checks: ReadonlySet<string>;
}

const stateOf = (passed: boolean | null): MainItem['state'] => (passed === null ? 'pending' : passed ? 'pass' : 'fail');

/** The gate from the pull request's head commit: its workflows (never a dynamic one) and its check names. */
export function gateOf(runs: readonly WorkflowRunSummary[], checks: readonly CheckRunSummary[]): Gate {
  const own = runs.filter((r) => r.event !== 'dynamic');
  const dynamicJobs = new Set(runs.filter((r) => r.event === 'dynamic').flatMap((r) => r.jobs.map((j) => j.name)));
  return {
    workflows: new Set(own.map((r) => r.path)),
    checks: new Set([...checks.map((c) => c.name).filter((n) => !dynamicJobs.has(n)), ...own.flatMap((r) => r.jobs.map((j) => j.name))]),
  };
}

/** Every workflow job and check run on one main commit, each counted or not, with why. */
export function mainItems(input: {
  readonly base: string;
  readonly runs: readonly WorkflowRunSummary[];
  readonly checks: readonly CheckRunSummary[];
  readonly gate: Gate;
}): readonly MainItem[] {
  const items: MainItem[] = [];
  const jobNames = new Set<string>();
  for (const run of input.runs) {
    const pushed = run.event === 'push' && run.headBranch === input.base;
    const gated = input.gate.workflows.has(run.path);
    const counted = run.event !== 'dynamic' && (pushed || gated);
    const why = run.event === 'dynamic'
      ? 'Not counted: event "dynamic" (Dependabot or code scanning), not this repository\'s CI.'
      : pushed ? `Counted: runs on the push to ${input.base}.`
        : gated ? 'Counted: the pull request was gated on this workflow.'
          : `Not counted: event "${run.event}", not triggered by the push to ${input.base}.`;
    const jobs = run.jobs.length > 0 ? run.jobs : [{ name: run.workflow, passed: run.passed, link: run.link }];
    for (const job of jobs) {
      jobNames.add(job.name);
      items.push({ workflow: run.workflow, job: job.name, counted, why, state: stateOf(job.passed), link: job.link ?? run.link });
    }
  }
  // A check run that isn't an Actions job above: another CI app. It counts only if the pull request ran it too.
  for (const check of input.checks) {
    if (jobNames.has(check.name)) continue;
    const gated = input.gate.checks.has(check.name);
    items.push({
      workflow: null, job: check.name, counted: gated,
      why: gated ? 'Counted: the pull request was gated on this check.' : 'Not counted: the pull request never ran this check.',
      state: stateOf(check.passed), link: check.link,
    });
  }
  return items;
}

export type MainVerdict =
  /** A counted check is still running: look again later. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'green' }
  /** Failing on the merge commit, and not before it. */
  | { readonly kind: 'broken'; readonly broken: readonly MainItem[]; readonly already: readonly MainItem[] }
  /** Failing, but it failed on the previous main commit too. */
  | { readonly kind: 'already'; readonly already: readonly MainItem[] };

export const itemKey = (i: Pick<MainItem, 'workflow' | 'job'>): string => `${i.workflow ?? ''}\u0000${i.job}`;

/** The merge commit's items against the previous main commit's (null when it can't be read: then nothing is "already"). */
export function judgeMain(merge: readonly MainItem[], parent: readonly MainItem[] | null): MainVerdict {
  const counted = merge.filter((i) => i.counted);
  if (counted.some((i) => i.state === 'pending')) return { kind: 'pending' };
  const failing = counted.filter((i) => i.state === 'fail');
  if (failing.length === 0) return { kind: 'green' };
  const before = new Set((parent ?? []).filter((i) => i.counted && i.state === 'fail').map(itemKey));
  const already = failing.filter((i) => before.has(itemKey(i)));
  const broken = failing.filter((i) => !before.has(itemKey(i)));
  return broken.length > 0 ? { kind: 'broken', broken, already } : { kind: 'already', already };
}

/** One line per item for a card's evidence: the workflow and job, its result, and why it counts or doesn't. */
export function itemLine(i: MainItem, already: ReadonlySet<string> = new Set()): { readonly label: string; readonly value: string } {
  const result = i.state === 'fail' ? (already.has(itemKey(i)) ? 'failed (also before this merge)' : 'failed') : i.state === 'pass' ? 'passed' : 'running';
  return {
    label: i.workflow === null ? i.job : `${i.workflow} › ${i.job}`,
    value: `${result}. ${i.why}${i.link === null ? '' : ` ${i.link}`}`,
  };
}
