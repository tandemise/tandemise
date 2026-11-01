import type { CheckOutcome, CheckResult, RepositoryChecks } from '@tandemise/domain';
import type { Clock, MissionId, RunId, TaskId } from '@tandemise/shared';
import { newId, summarize, systemClock } from '@tandemise/shared';

/**
 * Deterministic checks - level 1 of the evaluation hierarchy (MVP.md §17.1).
 *
 * These are the only evidence gates are allowed to depend on, because they are
 * measurements rather than claims. "The developer says it is done" is never a
 * gate condition (MVP.md §17.3), so this module produces facts with provenance:
 * a command, an exit code, a duration.
 *
 * The runner does **not** execute anything itself. It takes a `CommandExecutor`
 * so the process-spawning lives in the execution layer where a provider module
 * belongs; `@tandemise/evaluation` is a core package and may not import
 * `child_process` (BUILD_BRIEF non-negotiable 2, MVP.md §6.1). The practical
 * benefit is that the whole of this module is testable with a fake executor.
 */
export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** Set when the command was killed by the wall-clock budget. */
  readonly timedOut?: boolean;
}

export type CommandExecutor = (
  command: string,
  options: { readonly cwd: string; readonly timeoutMs?: number },
) => Promise<CommandOutcome>;

export interface CheckSpec {
  /** Gate fact name, e.g. `checks.typecheck`. Always `checks.`-prefixed. */
  readonly name: string;
  /** `null` means the repository has no such command; the check records SKIP. */
  readonly command: string | null;
  readonly timeoutMs?: number;
}

export interface CheckContext {
  readonly missionId: MissionId;
  readonly taskId: TaskId;
  readonly runId: RunId | null;
  readonly cwd: string;
}

export interface CheckRunnerPort {
  run(spec: CheckSpec, context: CheckContext): Promise<CheckResult>;
  runAll(specs: readonly CheckSpec[], context: CheckContext): Promise<readonly CheckResult[]>;
}

export interface CommandCheckRunnerOptions {
  readonly execute: CommandExecutor;
  readonly clock?: Clock;
  /** Applies when a spec does not set its own. */
  readonly defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function createCommandCheckRunner(options: CommandCheckRunnerOptions): CheckRunnerPort {
  const clock = options.clock ?? systemClock;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (spec: CheckSpec, context: CheckContext): Promise<CheckResult> => {
    const base = {
      id: newId<'CheckResultId'>('chk'),
      missionId: context.missionId,
      taskId: context.taskId,
      runId: context.runId,
      name: spec.name,
      createdAt: clock.now(),
      outputRef: null,
    };

    if (spec.command === null) {
      return {
        ...base,
        outcome: 'SKIP' as CheckOutcome,
        detail: 'No command is configured for this check in this repository.',
        command: null,
        exitCode: null,
        durationMs: 0,
      };
    }

    const outcome = await options.execute(spec.command, {
      cwd: context.cwd,
      timeoutMs: spec.timeoutMs ?? defaultTimeoutMs,
    });

    const budgetMs = spec.timeoutMs ?? defaultTimeoutMs;
    return {
      ...base,
      // A killed run measured nothing about the work (#111): not a FAIL.
      outcome: outcome.timedOut === true ? 'TIMEOUT' : outcome.exitCode === 0 ? 'PASS' : 'FAIL',
      detail: describe(spec, outcome, budgetMs),
      command: spec.command,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    };
  };

  return {
    run,
    async runAll(specs, context) {
      // Sequential on purpose: checks share a worktree, and a typecheck racing a
      // build in the same directory produces flaky, unattributable failures.
      const results: CheckResult[] = [];
      for (const spec of specs) results.push(await run(spec, context));
      return results;
    },
  };
}

/**
 * The check names Tandemise knows how to derive from a repository. The `tests`
 * name is plural to match the gate vocabulary in MVP.md §17.2
 * (`checks.tests == PASS`), even though `RepositoryChecks` calls the field
 * `test`.
 */
export function checkSpecsFor(
  checks: RepositoryChecks,
  only?: readonly string[],
): readonly CheckSpec[] {
  const all: CheckSpec[] = [
    { name: 'checks.install', command: checks.install },
    { name: 'checks.typecheck', command: checks.typecheck },
    { name: 'checks.lint', command: checks.lint },
    { name: 'checks.tests', command: checks.test },
    { name: 'checks.build', command: checks.build },
  ];
  return only ? all.filter((s) => only.includes(s.name)) : all;
}

/**
 * Failure detail is what a human reads in the gate panel, so it leads with the
 * tail of the output - where compilers and test runners put the summary - and
 * is redacted before it can reach a log or an event body.
 */
function describe(spec: CheckSpec, outcome: CommandOutcome, budgetMs: number): string {
  if (outcome.timedOut) {
    return `\`${spec.command}\` ran out of time: it was stopped after its ${formatBudget(budgetMs)} budget. `
      + 'That says nothing about the work; the check never finished.';
  }
  if (outcome.exitCode === 0) return `\`${spec.command}\` passed in ${outcome.durationMs}ms.`;
  const tail = lastLines(outcome.stderr.trim() || outcome.stdout.trim(), 20);
  return `\`${spec.command}\` exited ${outcome.exitCode}.\n${summarize(tail, 1200)}`;
}

/** "10 min", "90 s": a budget as a person reads it. */
export function formatBudget(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round((ms / 60_000) * 10) / 10;
    return `${minutes} min`;
  }
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.length <= count ? text : lines.slice(-count).join('\n');
}
