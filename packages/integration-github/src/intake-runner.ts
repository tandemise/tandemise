import type {
  Closure, ClosureResult, IntakeRunner, RunnerContext, RunnerHandle, RunnerSignal, UpstreamIssue,
} from '@tandemise/domain';
import { DEFAULT_ISSUE_LABEL, markerLine, splitGithubRepo } from '@tandemise/domain';
import { TandemiseError, errorMessage } from '@tandemise/shared';
import type { GhIssueTracker } from './issues.js';

/** Plan Task 10: one poll reads at most this many labelled issues. */
const LIST_LIMIT = 100;
/** The contract's limits (`INTAKE_MAX_TEXT`, `INTAKE_MAX_DESCRIPTION`): a longer GitHub title or body is cut, never rejected. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;
/** The one closing comment per issue, found again by this marker so a retry edits it instead of posting twice. */
const CLOSURE_MARKER = 'tandemise:closure';

/**
 * GitHub issues as an intake runner (spec §2, §10; plan Task 10): P14's poll,
 * moved onto the pipeline. Each poll lists the source repository's open
 * issues carrying the trigger label (`tandemise` by default) through `gh`, and
 * pushes one signal per issue, fingerprinted `github:<owner/name>:<number>`
 * as P14's links migrate to. What happens next (dedupe, create or link) is
 * the pipeline's; a repeat is the same signal read again.
 *
 * `gh`'s own sign-in is the only credential (P14 ruling 11): nothing is
 * stored. Issue text is data, carried into the signal and nothing else.
 */
export class GitHubIssuesRunner implements IntakeRunner {
  readonly kind = 'github';
  readonly mode = 'poll' as const;

  /** A thunk, so the command executor is resolved when a runner runs, not when the module composes. */
  constructor(private readonly issues: () => GhIssueTracker) {}

  start(ctx: RunnerContext): RunnerHandle {
    return {
      poll: async () => {
        const repo = ctx.source.instance;
        const open = await this.issues().listOpen({ repo, label: ctx.source.trigger?.label ?? DEFAULT_ISSUE_LABEL, limit: LIST_LIMIT });
        for (const issue of open) {
          if (ctx.signal.aborted) return;
          await ctx.push(issueSignal(repo, issue));
        }
      },
      stop: async () => {},
    };
  }

  /**
   * Spec §8: a comment ("Fixed in <PR>; tracked as ACME-12."), then a close
   * only with the source's `closeOnDone` (P14's guard). A won't-do item writes
   * nothing unless `closeWontDo` is set, and then closes as "not planned".
   */
  async close(closure: Closure, ctx: RunnerContext): Promise<ClosureResult> {
    const repo = ctx.source.instance;
    const number = Number(closure.signal.key);
    if (!Number.isInteger(number) || number <= 0) {
      return { ok: false, error: `'${closure.signal.key}' is not a GitHub issue number.`, retryable: false };
    }
    const doneKind = closure.kind === 'done';
    if (!doneKind && !ctx.source.closeWontDo) return { ok: true, externalId: null };
    const words = doneKind
      ? closure.prUrl === null ? `Done; tracked as ${closure.item.key}.` : `Fixed in ${closure.prUrl}; tracked as ${closure.item.key}.`
      : `Not planned; tracked as ${closure.item.key}.`;
    try {
      const externalId = await this.#comment(repo, number, words);
      if (!doneKind) await this.issues().close({ repo, number, reason: 'not planned' });
      else if (ctx.source.closeOnDone) await this.issues().close({ repo, number, reason: 'completed' });
      return { ok: true, externalId };
    } catch (e) {
      const code = e instanceof TandemiseError ? e.code : null;
      return { ok: false, error: errorMessage(e), retryable: code !== 'NOT_FOUND' && code !== 'VALIDATION' && code !== 'PERMISSION_DENIED' };
    }
  }

  /** Edits the signed-in user's closing comment when one is there (a retry after a crash), else posts it. */
  async #comment(repo: string, number: number, words: string): Promise<string> {
    const body = `${markerLine(CLOSURE_MARKER)}\n${words}`;
    const issues = this.issues();
    const me = await issues.viewer({ repo });
    const mine = (await issues.comments({ repo, number })).find((c) => c.author === me && c.body.startsWith(markerLine(CLOSURE_MARKER)));
    if (mine !== undefined) {
      if (mine.body !== body) await issues.updateComment({ repo, commentId: mine.id, body });
      return mine.id;
    }
    return issues.postComment({ repo, number, body });
  }
}

/** One open issue as a `tandemise.intake/v1` signal. */
export function issueSignal(repo: string, issue: UpstreamIssue): RunnerSignal {
  const host = splitGithubRepo(repo).host ?? 'github.com';
  const description = issue.body.length > MAX_DESCRIPTION ? `${issue.body.slice(0, MAX_DESCRIPTION - 1)}…` : issue.body;
  return {
    schema: 'tandemise.intake/v1',
    source: { kind: 'github', instance: repo },
    key: String(issue.number),
    url: issue.url,
    title: issue.title.length > MAX_TITLE ? `${issue.title.slice(0, MAX_TITLE - 1)}…` : issue.title,
    ...(description === '' ? {} : { description }),
    ...(issue.author === null ? {} : { reporter: { handle: issue.author, url: `https://${host}/${issue.author}` } }),
    ...(issue.labels.includes('bug') ? { kindHint: 'bug' as const } : {}),
  };
}
