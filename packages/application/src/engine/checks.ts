import type {
  CheckName, CheckResult, EvaluationRepositoryPort, MissionTask, PlannerConfig, Repository,
} from '@tandemise/domain';
import {
  CHECK_NAMES, checkBudgetMinutes, checkCommandField, gateDependencies, MAX_CHECK_BUDGET_MINUTES,
  notNeededDetail, parsePlannerConfig, selectCheck,
} from '@tandemise/domain';
import { createCommandCheckRunner, formatBudget, type CheckSpec } from '@tandemise/evaluation';
import type { ExecutionTarget } from '@tandemise/execution-core';
import type { Clock, RunId } from '@tandemise/shared';
import { errorMessage, newId, summarize } from '@tandemise/shared';
import type { FactoryConfigSourcePort } from '../ports.js';
import { SHIPPED_PLANNER_CONFIG } from '../planning/factory-config.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { SCOPE_RETRY_CHECK } from './ship-measure.js';

const CHECK_PREFIX = 'checks.';
const INSTALL_CHECK = 'checks.install';
/** Measured here with the checks, and stored as one, so "newest wins" applies to it too (P15). */
export const GIT_CLEAN_FACT = 'git.clean';
/** How many dirty paths the detail lists before "and N more". */
const DIRTY_LISTED = 20;
/** A check that ran out of time gets one more run with this many times the budget (#111). */
const TIMEOUT_RETRY_FACTOR = 2;

export interface CheckRequest {
  readonly task: MissionTask;
  readonly repository: Repository | null;
  readonly target: ExecutionTarget;
  readonly runId: RunId | null;
  readonly scope: EventScope;
  readonly signal: AbortSignal;
}

/** What a step's prompt says Tandemise will run after it, so the agent need not run it too (#106). */
export interface PlannedCheck {
  readonly name: string;
  readonly command: string;
  readonly budgetMinutes: number;
}

/**
 * Runs a repository's configured checks inside the target the task ran in
 * (MVP.md §17.1).
 *
 * **Only the checks a gate reads are run.** A gate is the only consumer of a
 * check result, so running a build for a task whose gate never mentions it
 * spends the user's wall-clock time to produce a fact nobody reads. The one
 * exception is `install`: a typecheck in a fresh worktree fails for want of
 * dependencies rather than for want of correctness, which would be a lie told
 * by a gate. It runs only when some other check is actually going to run.
 *
 * **Each check runs once per tree, and only as much of it as the change needs
 * (#106).** The factory used to run the whole suite for a one-paragraph doc
 * change, and again in every later step that read the same code. Now:
 *
 * - the files the step changed decide what a check runs (`planner.yaml`
 *   `areas[].checks`, see {@link selectCheck}): only documentation changed,
 *   no test run; only one package changed, that package's command;
 * - a command already measured on the same git tree, by any step, is reused
 *   rather than run again. The tree is content-addressed, so the result holds.
 *
 * **A check that runs out of time is not a failure (#111).** It is recorded as
 * TIMEOUT, run once more with twice the budget, and if it still does not
 * finish the engine asks a person rather than re-running the agent.
 *
 * **The commands run in the target, not on the host.** A worktree task's checks
 * must see the worktree's tree, and a future container target must run them
 * inside the container.
 */
export class CheckService {
  constructor(
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
    private readonly factory?: FactoryConfigSourcePort,
  ) {}

  /** The checks this step's gate will run and their budgets, for the step's prompt. */
  async planned(task: MissionTask, repository: Repository | null): Promise<readonly PlannedCheck[]> {
    if (repository === null) return [];
    const planner = await this.#planner(repository);
    return this.#wanted(task, repository)
      .flatMap((name) => {
        const command = repository.checks[checkCommandField(name)];
        return command === null ? [] : [{ name: `${CHECK_PREFIX}${name}`, command, budgetMinutes: this.#budget(name, repository, planner) }];
      });
  }

  async run(request: CheckRequest): Promise<readonly CheckResult[]> {
    const { task, repository, target } = request;
    if (repository === null) return [];

    const wanted = this.#wanted(task, repository);
    const wantsClean = gateDependencies(task.completionGate ?? '').includes(GIT_CLEAN_FACT);
    if (wanted.length === 0 && !wantsClean) return [];

    const planner = await this.#planner(repository);
    const tree = await this.#tree(target, request.signal);
    const changed = await this.#changedPaths(target, request.signal);
    const context = { missionId: task.missionId, taskId: task.id, runId: request.runId, cwd: target.workingDirectory };
    const runner = this.#runner(target, request.signal);
    const results: CheckResult[] = [];

    // Decide every check before running any, so install runs only when a check
    // will actually execute something in this worktree.
    const plans = wanted.map((name) => this.#plan(name, repository, planner, changed));
    const toRun = plans.filter((p): p is Extract<CheckPlan, { kind: 'run' }> => p.kind === 'run');
    const reused = new Map<string, CheckResult>();
    if (tree !== null) {
      for (const plan of toRun) {
        const prior = this.evaluations.reusableCheck(tree, plan.spec.name, plan.spec.command!);
        if (prior !== undefined) reused.set(plan.spec.name, prior);
      }
    }
    const executes = toRun.some((p) => !reused.has(p.spec.name));
    if (executes && repository.checks.install !== null) {
      const install = { name: INSTALL_CHECK, command: repository.checks.install, timeoutMs: this.#budget('install', repository, planner) * 60_000 };
      results.push(await this.#measure(runner, install, context, request.scope));
    }

    for (const plan of plans) {
      if (plan.kind === 'not_needed') {
        results.push(this.#notNeeded(plan.name, plan.detail, request.runId, task));
        continue;
      }
      const prior = reused.get(plan.spec.name);
      results.push(prior !== undefined
        ? this.#reuse(prior, request.runId, task)
        : await this.#measure(runner, plan.spec, context, request.scope));
    }

    // Last, so it sees what the checks themselves left behind: a build that
    // rewrites a tracked file is exactly what `git.clean` exists to catch.
    if (wantsClean) results.push(await this.#gitClean(request));

    const stamped = results.map((r) => (r.name === GIT_CLEAN_FACT || r.treeSha !== undefined ? r : { ...r, treeSha: r.command === null ? null : tree }));
    for (const result of stamped) {
      this.evaluations.recordCheck(result);
      this.recorder.record(request.scope, {
        type: 'check.result',
        name: result.name,
        outcome: result.outcome,
        detail: result.detail,
      });
    }
    this.recorder.invalidate('checks', task.missionId);
    return stamped;
  }

  /**
   * `scope.retry` (#117): the files a retry changed that the step's earlier
   * attempts had not. On the dogfood run two retries, told only that a check
   * failed, edited an unrelated check to get green, and nobody saw it until
   * the pull request. It is a measurement, so it is recorded with the checks:
   * the step's Checks & Gates shows it, and the merge decision reads it
   * (`process.retry_out_of_scope`). It never fails the step by itself.
   */
  async measureRetryScope(
    request: Pick<CheckRequest, 'task' | 'target' | 'runId' | 'scope' | 'signal'>, from: string,
  ): Promise<CheckResult | null> {
    const { task, target, signal } = request;
    const base = target.describe().baseBranch;
    if (base === null) return null;
    const names = async (args: readonly string[]): Promise<string[] | null> => {
      try {
        const r = await target.exec({ command: 'git', args: [...args], signal });
        return r.exitCode === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0) : null;
      } catch {
        return null;
      }
    };
    const before = await names(['diff', '--name-only', `${base}...${from}`]);
    const now = await names(['diff', '--name-only', from, 'HEAD']);
    // Nothing to compare against: earlier attempts that changed nothing left no scope to stay in.
    if (before === null || now === null || before.length === 0) return null;
    const added = now.filter((p) => !before.includes(p));
    const result: CheckResult = {
      id: newId<'CheckResultId'>('chk'),
      missionId: task.missionId, taskId: task.id, runId: request.runId, name: SCOPE_RETRY_CHECK,
      outcome: added.length === 0 ? 'PASS' : 'FAIL',
      detail: added.length === 0
        ? 'The retry changed only files the step had already changed.'
        : `The retry changed ${added.length === 1 ? 'a file' : `${added.length} files`} the step had not touched before:\n${added.slice(0, DIRTY_LISTED).join('\n')}`,
      command: 'git diff --name-only', exitCode: 0, durationMs: 0, outputRef: null, createdAt: this.clock.now(),
    };
    this.evaluations.recordCheck(result);
    this.recorder.record(request.scope, { type: 'check.result', name: result.name, outcome: result.outcome, detail: result.detail });
    if (added.length > 0) {
      const listed = `${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''}`;
      this.recorder.note(request.scope, `The retry of '${task.key}' changed files outside its earlier change: ${listed}.`, 'warn');
    }
    this.recorder.invalidate('checks', task.missionId);
    return result;
  }

  /**
   * Runs one check; a run that ran out of time is recorded, then run once more
   * with twice the budget (#111). A slow suite on a busy machine finishes then;
   * one that never finishes is handed to a person, never to the agent.
   */
  async #measure(
    runner: ReturnType<typeof createCommandCheckRunner>, spec: CheckSpec, context: Parameters<ReturnType<typeof createCommandCheckRunner>['run']>[1], scope: EventScope,
  ): Promise<CheckResult> {
    const first = await runner.run(spec, context);
    if (first.outcome !== 'TIMEOUT' || spec.timeoutMs === undefined) return first;
    const longer = Math.min(spec.timeoutMs * TIMEOUT_RETRY_FACTOR, MAX_CHECK_BUDGET_MINUTES * 60_000);
    if (longer <= spec.timeoutMs) return first;
    this.evaluations.recordCheck(first);
    this.recorder.record(scope, { type: 'check.result', name: first.name, outcome: first.outcome, detail: first.detail });
    this.recorder.note(
      scope,
      `${spec.name.slice(CHECK_PREFIX.length)} ran out of time after ${formatBudget(spec.timeoutMs)}; running it once more with ${formatBudget(longer)}.`,
      'warn',
    );
    const second = await runner.run({ ...spec, timeoutMs: longer }, context);
    if (second.outcome !== 'TIMEOUT') return second;
    return {
      ...second,
      detail: `\`${spec.command}\` ran out of time twice: after ${formatBudget(spec.timeoutMs)}, then after ${formatBudget(longer)}. `
        + 'That says nothing about the work; the check never finished.',
    };
  }

  #notNeeded(name: string, detail: string, runId: RunId | null, task: MissionTask): CheckResult {
    return {
      id: newId<'CheckResultId'>('chk'), missionId: task.missionId, taskId: task.id, runId, name,
      // The person's policy says this change needs no such check (planner.yaml
      // areas[].checks); the detail says so, and it carries no command, so it
      // is never mistaken for a measurement or reused as one.
      outcome: 'PASS', detail, command: null, exitCode: null, durationMs: 0, outputRef: null, createdAt: this.clock.now(),
    };
  }

  #reuse(prior: CheckResult, runId: RunId | null, task: MissionTask): CheckResult {
    return {
      ...prior,
      id: newId<'CheckResultId'>('chk'), missionId: task.missionId, taskId: task.id, runId, createdAt: this.clock.now(),
      detail: `Not run again: the same code was already measured at ${prior.createdAt}. ${prior.detail}`,
    };
  }

  #plan(name: CheckName, repository: Repository, planner: PlannerConfig, changed: readonly string[] | null): CheckPlan {
    const gateName = `${CHECK_PREFIX}${name}`;
    const timeoutMs = this.#budget(name, repository, planner) * 60_000;
    const own = repository.checks[checkCommandField(name)];
    // A repository with no command for a check records SKIP, as it always has.
    if (own === null) return { kind: 'run', spec: { name: gateName, command: null, timeoutMs } };
    const selection = changed === null ? { kind: 'repository' as const } : selectCheck(name, changed, planner.areas);
    if (selection.kind === 'not_needed') return { kind: 'not_needed', name: gateName, detail: notNeededDetail(selection) };
    const command = selection.kind === 'commands' ? selection.commands.join(' && ') : own;
    return { kind: 'run', spec: { name: gateName, command, timeoutMs } };
  }

  #budget(name: CheckName, repository: Repository, planner: PlannerConfig): number {
    return checkBudgetMinutes(name, repository.checks.budgets, planner.checks.budgets);
  }

  /** The checks the gate reads, minus install (which runs only ahead of others). */
  #wanted(task: MissionTask, repository: Repository): readonly CheckName[] {
    void repository;
    const deps = new Set(gateDependencies(task.completionGate ?? '').filter((f) => f.startsWith(CHECK_PREFIX)));
    return CHECK_NAMES.filter((n) => n !== 'install' && deps.has(`${CHECK_PREFIX}${n}`));
  }

  async #planner(repository: Repository): Promise<PlannerConfig> {
    if (this.factory === undefined) return SHIPPED_PLANNER_CONFIG;
    try {
      const file = await this.factory.read('planner', [repository.path], repository.workspaceId);
      return file.error !== null ? SHIPPED_PLANNER_CONFIG : parsePlannerConfig(file.raw, SHIPPED_PLANNER_CONFIG).config;
    } catch {
      return SHIPPED_PLANNER_CONFIG;
    }
  }

  /** The tree the step's commit holds; null when the target is not a git tree. */
  /**
   * The tree a result may be reused by: only a worktree (the executor commits
   * everything there before the checks) whose files all match HEAD. A step
   * working in place, or with anything uncommitted, measures files the tree
   * does not hold, so its result is never stamped for reuse.
   */
  async #tree(target: ExecutionTarget, signal: AbortSignal): Promise<string | null> {
    if (target.kind !== 'worktree') return null;
    try {
      const status = await target.exec({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all'], signal });
      if (status.exitCode !== 0 || status.stdout.trim().length > 0) return null;
      const r = await target.exec({ command: 'git', args: ['rev-parse', 'HEAD^{tree}'], signal });
      const sha = r.stdout.trim();
      return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * What this step's branch changed against the branch it was cut from. Null
   * when that can't be told (not a worktree, no base), which runs every check
   * in full: not knowing never narrows a check.
   */
  async #changedPaths(target: ExecutionTarget, signal: AbortSignal): Promise<readonly string[] | null> {
    if (target.kind !== 'worktree') return null;
    try {
      const record = target.describe();
      if (record.baseBranch === null) return null;
      const r = await target.exec({ command: 'git', args: ['diff', '--name-only', `${record.baseBranch}...HEAD`], signal });
      if (r.exitCode !== 0) return null;
      return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    } catch {
      return null;
    }
  }

  #runner(target: ExecutionTarget, signal: AbortSignal): ReturnType<typeof createCommandCheckRunner> {
    return createCommandCheckRunner({
      execute: async (command, options) => {
        try {
          const result = await target.exec({
            // A configured check is a shell line ("npm test && npm run lint"),
            // so it needs a shell. It comes from the repository's own
            // configuration or the project's planner.yaml, never from an agent.
            command: '/bin/sh',
            args: ['-lc', command],
            cwd: options.cwd,
            timeoutMs: options.timeoutMs,
            signal,
          });
          return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
          };
        } catch (e) {
          // A target that cannot run the command at all is a failed check with
          // an explanation, not an exception that loses every other result.
          return { exitCode: 1, stdout: '', stderr: errorMessage(e), durationMs: 0 };
        }
      },
      clock: this.clock,
    });
  }

  /**
   * `git.clean`: nothing uncommitted in the step's worktree after the executor
   * committed the worker's changes and the checks ran.
   *
   * Only a worktree can be measured: a step working in place shares your
   * checkout, whose state says nothing about the step. The validator refuses
   * the fact on such a step; one that gets here anyway reads SKIP, which never
   * passes.
   */
  async #gitClean(request: CheckRequest): Promise<CheckResult> {
    const { task, target } = request;
    const started = this.clock.epochMs();
    const base = {
      id: newId<'CheckResultId'>('chk'),
      missionId: task.missionId,
      taskId: task.id,
      runId: request.runId,
      name: GIT_CLEAN_FACT,
      command: 'git status --porcelain',
      outputRef: null,
    };
    if (target.kind !== 'worktree') {
      return {
        ...base, outcome: 'SKIP', exitCode: null, durationMs: 0, createdAt: this.clock.now(),
        detail: 'Only measured on a step that works in its own worktree; this step works in place.',
      };
    }
    try {
      const status = await target.exec({
        command: 'git', args: ['status', '--porcelain', '--untracked-files=all'], signal: request.signal,
      });
      const durationMs = this.clock.epochMs() - started;
      if (status.exitCode !== 0) {
        return {
          ...base, outcome: 'FAIL', exitCode: status.exitCode, durationMs, createdAt: this.clock.now(),
          detail: `\`git status\` exited ${status.exitCode}: ${summarize(status.stderr.trim(), 400)}`,
        };
      }
      const dirty = status.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
      if (dirty.length === 0) {
        return { ...base, outcome: 'PASS', exitCode: 0, durationMs, createdAt: this.clock.now(), detail: 'Nothing uncommitted in the worktree.' };
      }
      const listed = dirty.slice(0, DIRTY_LISTED).join('\n');
      const more = dirty.length > DIRTY_LISTED ? `\nand ${dirty.length - DIRTY_LISTED} more` : '';
      return {
        ...base, outcome: 'FAIL', exitCode: 0, durationMs, createdAt: this.clock.now(),
        detail: `${dirty.length} ${dirty.length === 1 ? 'path is' : 'paths are'} not committed:\n${listed}${more}`,
      };
    } catch (e) {
      return {
        ...base, outcome: 'FAIL', exitCode: null, durationMs: this.clock.epochMs() - started, createdAt: this.clock.now(),
        detail: `Could not run \`git status\`: ${errorMessage(e)}`,
      };
    }
  }
}

type CheckPlan =
  | { readonly kind: 'run'; readonly spec: CheckSpec }
  | { readonly kind: 'not_needed'; readonly name: string; readonly detail: string };
