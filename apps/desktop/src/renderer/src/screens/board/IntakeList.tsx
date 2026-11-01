import type { UseQueryResult } from '@tanstack/react-query';
import type { IntakeSignalView } from '@tandemise/api-contract';
import type { SignalStatus } from '@tandemise/domain';
import { Empty, ErrorState, SkeletonList } from '../../components/primitives.js';
import { useDaemon } from '../../lib/connection.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { relativeTime } from '../../lib/format.js';
import { Button, Card } from '@tandemise/design/react';

/** `youtrack:ACME-12` → `ACME-12`, `github:acme/web#42` → `acme/web#42`: the key as the tracker shows it. */
function itemKey(ref: string | null): string {
  if (ref === null) return 'its task';
  const at = ref.indexOf(':');
  return at < 0 ? ref : ref.slice(at + 1);
}

/** What a status means for you, in words (plan Task 14); never the raw status. */
function statusWords(s: IntakeSignalView): string {
  const words: Readonly<Record<SignalStatus, string>> = {
    received: 'Waiting for the tracker',
    held_back: `Held back: ${s.reason ?? 'below this source\'s filter'}`,
    needs_decision: 'Needs your decision',
    linked: `Linked to ${itemKey(s.itemRef)}`,
    created: `Filed as ${itemKey(s.itemRef)}`,
    rejected: `Rejected: ${s.reason ?? 'it did not read as a signal'}`,
    dismissed: 'Not work',
    closure_pending: `Done in ${itemKey(s.itemRef)}; closing at ${s.sourceLabel}`,
    closed: 'Closed',
    // The daemon's reason already says where ("Couldn't close at Sentry: …"); it is shown as it is.
    closure_failed: s.reason?.startsWith("Couldn't close") ? s.reason : `Couldn't close: ${s.reason ?? 'the source did not answer'}`,
  };
  return words[s.status];
}

/** The reason under the status, when the status words do not already carry it. */
function detail(s: IntakeSignalView): string | null {
  if (s.reason === null) return null;
  if (s.status === 'held_back' || s.status === 'rejected' || s.status === 'closure_failed') return null;
  return s.reason;
}

const TONE: Readonly<Record<SignalStatus, string>> = {
  received: 'pending',
  held_back: 'pending',
  needs_decision: 'blocked',
  linked: 'running',
  created: 'running',
  rejected: 'failed',
  dismissed: 'pending',
  closure_pending: 'running',
  closed: 'succeeded',
  closure_failed: 'failed',
};

/**
 * The Intake tab (intake spec §7, plan Task 14): every signal the project
 * recorded, one row each, with its status and reason in words, so
 * "everything entered is recorded" is visible.
 */
export function IntakeList({ signals }: { signals: UseQueryResult<readonly IntakeSignalView[]> }): JSX.Element {
  if (signals.isPending) return <SkeletonList rows={4} />;
  const list = signals.data ?? [];
  return (
    <section className="intake-list" aria-label="Intake signals">
      {signals.isError ? <ErrorState error={signals.error} onRetry={() => void signals.refetch()} /> : null}
      {list.length === 0 ? (
        <Card>
          <Empty icon="flag" title="Nothing has come in yet" body="Signals from your sources land here, filed, linked, held back or waiting for you, each with the reason." />
        </Card>
      ) : (
        <Card flush>
          {list.map((s) => <SignalRow key={s.id} signal={s} />)}
        </Card>
      )}
    </section>
  );
}

function SignalRow({ signal }: { signal: IntakeSignalView }): JSX.Element {
  const extra = detail(signal);
  const retrySignal = useDaemonMutation((d, _: void) => d.retrySignal(signal.id), ['intake']);
  return (
    <div className="list__row intake-list__row" data-intake-signal={signal.fingerprint} data-status={signal.status}>
      <span className={`dot dot--${TONE[signal.status]}`} />
      <div className="list__main">
        <div className="intake-list__line">
          <span className="list__title intake-list__title">{signal.title}</span>
          <span className="chip chip--muted intake-list__source">
            {signal.sourceLabel}
            {signal.occurrences > 1 ? ` · ${signal.occurrences} times` : ''}
          </span>
        </div>
        <div className="list__subtitle intake-list__status" data-tone={TONE[signal.status]}>{statusWords(signal)}</div>
        {extra ? <div className="list__subtitle intake-list__reason">{extra}</div> : null}
        {retrySignal.isError ? <ErrorState error={retrySignal.error} /> : null}
      </div>
      <div className="list__aside">
        <span className="dim intake-list__when">{relativeTime(signal.lastSeenAt)}</span>
        {signal.status === 'received' ? (
          <Button disabled={retrySignal.isPending} onClick={() => retrySignal.mutate()}>Try now</Button>
        ) : null}
        {signal.status === 'closure_failed' ? <RetryClosure signal={signal} /> : null}
      </div>
    </div>
  );
}

/**
 * Retry for a closure that failed. The signal view carries no closure id, so
 * the closure is found on its source's feed (read with the daemon's own
 * token) by the signal's fingerprint.
 */
function RetryClosure({ signal }: { signal: IntakeSignalView }): JSX.Element {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  const retry = useDaemonMutation(async (d, _: void) => {
    const feed = await daemon.intakeClosures(workspaceId ?? '', signal.sourceId);
    const failed = feed.closures.filter((c) => c.fingerprint === signal.fingerprint && c.state !== 'closed');
    if (failed.length === 0) throw new Error('This closure is no longer waiting to be retried.');
    for (const c of failed) await d.retryClosure(c.id);
  }, ['intake']);
  return (
    <>
      <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
        {retry.isPending ? 'Retrying…' : 'Retry'}
      </Button>
      {retry.isError ? <ErrorState error={retry.error} /> : null}
    </>
  );
}
