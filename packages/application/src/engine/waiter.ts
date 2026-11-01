import type { MissionTask, PullRequestRef, Repository, WaitPolicy } from '@tandemise/domain';
import { WAIT_BROKEN_PREFIX } from '@tandemise/domain';
import type { CommandExecutor } from '@tandemise/integrations-core';
import type { Clock, Logger } from '@tandemise/shared';
import { errorMessage } from '@tandemise/shared';
import type { CiFailure, PrWaitLook } from './pr-wait.js';

/**
 * Watches something outside this machine until it is done.
 *
 * An end-to-end process does not stop at "push the code": it waits for CI, then
 * merges, waits for the deploy, then checks the deployed thing. Every one of
 * those waits on a system Tandemise does not control.
 *
 * The obvious way to do this is an agent that polls in a loop, and it is the
 * wrong way. An agent re-sends its whole context on every turn, so a ten-minute
 * CI wait is billed as a ten-minute conversation - a cost the beveloce tooling
 * measured at 249k tokens re-sent per turn and wrote a rule against. A wait step
 * holds no model at all: it runs one command on an interval and looks at the
 * exit code.
 *
 * It also holds no worker slot. A mission waiting twenty minutes on a deploy
 * should not be occupying one of three concurrency slots while agent work that
 * could proceed sits behind it.
 */
export type WaitOutcome =
  | { readonly kind: 'passed' | 'timedOut' | 'cancelled'; readonly detail: string; readonly polls: number; readonly pr?: PullRequestRef }
  /** A CI wait decided by its pull request (pr-wait.ts): merged or closed on GitHub, or CI failed on it. */
  | { readonly kind: 'merged' | 'closed'; readonly detail: string; readonly polls: number; readonly pr: PullRequestRef }
  | { readonly kind: 'ciFailed'; readonly detail: string; readonly polls: number; readonly pr: PullRequestRef; readonly failing: CiFailure; readonly others?: readonly CiFailure[] };

/** What a wait can be told besides its command: its pull request, and who to tell how each look went. */
export interface WaitOptions {
  /** Looks at the wait's pull request; `unknown` leaves the decision to the command. */
  readonly look?: (waitedMs: number) => Promise<PrWaitLook>;
  /** Each look that didn't end the wait, in words, and the pull request it read if any. */
  readonly progress?: (detail: string, pr: PullRequestRef | null) => void;
}

/** Looks in a row that couldn't run the command at all before the wait says it is broken. */
export const WAIT_BROKEN_AFTER = 3;

export interface WaiterDeps {
  readonly exec: () => CommandExecutor;
  readonly clock: Clock;
  readonly log: Logger;
}

export class Waiter {
  constructor(private readonly deps: WaiterDeps) {}

  async wait(
    task: MissionTask,
    policy: WaitPolicy,
    repository: Repository | null,
    signal: AbortSignal,
    options: WaitOptions = {},
  ): Promise<WaitOutcome> {
    const log = this.deps.log.child({ taskId: task.id, component: 'waiter' });
    const started = this.deps.clock.epochMs();
    const deadline = started + policy.timeoutMs;
    let polls = 0;
    let broken = 0;
    const say = (detail: string, pr: PullRequestRef | null = null): void => {
      try { options.progress?.(detail, pr); } catch (e) { log.warn('wait.progress_failed', { error: errorMessage(e) }); }
    };

    while (!signal.aborted) {
      polls += 1;
      const remaining = deadline - this.deps.clock.epochMs();
      if (remaining <= 0) break;

      if (options.look !== undefined) {
        let look: PrWaitLook = { kind: 'unknown' };
        try {
          look = await options.look(this.deps.clock.epochMs() - started);
        } catch (error) {
          // GitHub didn't answer: the command still can, so it decides this look.
          log.warn('wait.look_failed', { error: errorMessage(error) });
        }
        if (signal.aborted) break;
        if (look.kind === 'passed') return { kind: 'passed', detail: look.detail, polls, pr: look.pr };
        if (look.kind === 'merged' || look.kind === 'closed') return { kind: look.kind, detail: look.detail, polls, pr: look.pr };
        if (look.kind === 'failed') return { kind: 'ciFailed', detail: look.detail, polls, pr: look.pr, failing: look.failing, others: look.others };
        if (look.kind === 'pending') {
          say(look.detail, look.pr);
          if (!(await this.#sleep(Math.min(policy.everyMs, deadline - this.deps.clock.epochMs()), signal))) break;
          continue;
        }
      }

      let result;
      try {
        const [command = policy.command, ...args] = commandWords(policy.command);
        result = await this.deps.exec().run({
          // Split into its words and run without a shell: a wait is one command, and
          // the whole line handed over as the program's name never starts (#143).
          command,
          args,
          ...(repository === null ? {} : { cwd: repository.path }),
          // Never longer than what is left: a command that hangs must not
          // outlive the wait it belongs to.
          timeoutMs: Math.min(policy.everyMs * 2, remaining),
          signal,
        });
      } catch (error) {
        // A poll that could not run at all is not a failed condition - the
        // deploy may be fine and the network may not be. Keep waiting; the
        // timeout is what ends this.
        log.warn('wait.poll_failed', { error: errorMessage(error) });
        broken += 1;
        if (broken >= WAIT_BROKEN_AFTER) say(`${WAIT_BROKEN_PREFIX}${firstLine(errorMessage(error))}`);
        if (!(await this.#sleep(Math.min(policy.everyMs, deadline - this.deps.clock.epochMs()), signal))) break;
        continue;
      }

      if (result.exitCode === 0) {
        return {
          kind: 'passed',
          detail: firstLine(result.stdout) || `\`${policy.command}\` succeeded.`,
          polls,
        };
      }

      log.debug('wait.still_waiting', { polls, exitCode: result.exitCode });
      // 126 and 127: the shell couldn't run the command at all, which no amount of waiting fixes.
      broken = result.exitCode === 126 || result.exitCode === 127 ? broken + 1 : 0;
      const said = firstLine(result.stderr) || firstLine(result.stdout);
      say(broken >= WAIT_BROKEN_AFTER
        ? `${WAIT_BROKEN_PREFIX}\`${policy.command}\` exited ${result.exitCode}${said.length > 0 ? `: ${said}` : ''}`
        : `Waiting: \`${policy.command}\` exited ${result.exitCode}${said.length > 0 ? ` (${said})` : ''}.`);
      if (!(await this.#sleep(Math.min(policy.everyMs, deadline - this.deps.clock.epochMs()), signal))) break;
    }

    if (signal.aborted) {
      return { kind: 'cancelled', detail: 'The mission was stopped while waiting.', polls };
    }
    return {
      kind: 'timedOut',
      detail: `\`${policy.command}\` did not succeed within ${Math.round(policy.timeoutMs / 60_000)} minutes.`,
      polls,
    };
  }

  /** Resolves false when the wait was cancelled rather than slept through. */
  async #sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0 || signal.aborted) return false;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * A command line's words, as a shell would split a simple command: on
 * whitespace, with single and double quotes keeping a word whole. Nothing
 * else of a shell (no pipes, variables or globs) applies.
 */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || word.length > 0) words.push(word);
      word = '';
      has = false;
    } else {
      word += ch;
    }
  }
  if (has || word.length > 0) words.push(word);
  return words;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 300) ?? '';
}
