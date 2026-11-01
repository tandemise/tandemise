import { useState } from 'react';
import { Link } from 'wouter';
import type { InboxSilentRunView, InboxStalledView } from '@tandemise/api-contract';
import { ConfirmDialog } from '../../components/Modal.js';
import { ErrorState } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { showFlash } from '../../lib/notices.js';
import { quietFor } from '../../lib/domain.js';
import { relativeTime } from '../../lib/format.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { Button, Chip, Tooltip, Truncate } from '@tandemise/design/react';

/**
 * A mission nothing moves and nothing asks about (P9): what is stuck, and the
 * one thing that moves it. The action goes through the route that already does
 * it - retry the step, re-plan, refine, or (last) cancel - and the row is gone
 * as soon as the daemon derives the mission as moving again. A stuck CI wait
 * or ship step (#145) also links its pull request and offers to cancel.
 */
export function StalledRow({ stalled, bordered = false }: { stalled: InboxStalledView; bordered?: boolean }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const workspaceId = useWorkspaceId();
  const act = useDaemonMutation(
    async (daemon, kind: InboxStalledView['action']['kind']): Promise<unknown> => {
      const action = stalled.action;
      if (kind === 'retry' && action.kind === 'retry') return daemon.retryTask(action.taskId);
      if (kind === 'replan') return daemon.missionAction(stalled.missionId, 'plan');
      if (kind === 'refine') return daemon.refineMission(stalled.missionId);
      if (kind === 'tracker-move' && action.kind === 'tracker-move') return daemon.retryMove(workspaceId ?? '', action.itemKey);
      return daemon.missionAction(stalled.missionId, 'cancel', { reason: 'Cancelled from the Inbox: nothing could move it.' });
    },
    ['tasks', 'missions', 'approvals', 'refinement', 'intake'],
    stalled.missionId,
  );
  const done = (kind: InboxStalledView['action']['kind']): void => {
    setConfirming(false);
    showFlash(
      kind === 'retry' && stalled.action.kind === 'retry' ? `Retrying ${stalled.action.taskKey}.`
        : kind === 'replan' ? `Planning “${stalled.missionTitle}” again.`
          : kind === 'refine' ? `Refining “${stalled.missionTitle}”.`
            : kind === 'tracker-move' ? `Asked the tracker to move it again.`
            : `Cancelled “${stalled.missionTitle}”.`,
    );
  };
  const run = (kind: InboxStalledView['action']['kind']): void => act.mutate(kind, { onSuccess: () => done(kind) });
  const press = (): void => {
    if (stalled.action.kind === 'cancel') setConfirming(true);
    else run(stalled.action.kind);
  };
  const pullRequestUrl = stalled.pullRequestUrl ?? null;
  const alsoCancel = stalled.cancellable === true && stalled.action.kind !== 'cancel';

  return (
    <div className={`list__row inbox__row${bordered ? ' list__row--bordered' : ''}`} aria-label={`Stalled: ${stalled.missionTitle}`}>
      <span className="dot dot--failed" />
      <div className="list__main">
        <div className="list__title truncate">
          <Link href={`/missions/${stalled.missionId}`}>Stalled: {stalled.missionTitle}</Link>
        </div>
        <Truncate as="div" className="list__subtitle">{stalled.reason}</Truncate>
        {act.isError ? <ErrorState error={act.error} /> : null}
      </div>
      <div className="list__aside">
        <Chip muted>Stalled</Chip>
        <span className="dim" style={{ fontSize: 'var(--fs-xs)', minWidth: 56, textAlign: 'right' }}>{relativeTime(stalled.since)}</span>
        {pullRequestUrl === null ? null : (
          <Button variant="ghost" onClick={() => void window.tandemise.openExternal(pullRequestUrl)}>Open the pull request</Button>
        )}
        <Button disabled={act.isPending} onClick={press}>
          {act.isPending ? 'Working…' : stalled.action.label}
        </Button>
        {alsoCancel ? <Button variant="ghost" disabled={act.isPending} onClick={() => setConfirming(true)}>Cancel mission</Button> : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          title={`Cancel “${stalled.missionTitle}”?`}
          body={`${stalled.reason} Nothing else can move it, so cancelling ends it. Its work so far stays on record.`}
          confirmLabel="Cancel mission"
          destructive
          busy={act.isPending}
          onConfirm={() => run('cancel')}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * An agent quiet past its threshold (P9): said before its wall-time budget is
 * gone. Tandemise never stops it on its own; the person stops and retries it,
 * or keeps waiting and is asked again if it stays quiet.
 */
export function QuietRow({ run, bordered = false }: { run: InboxSilentRunView; bordered?: boolean }): JSX.Element {
  const stop = useDaemonMutation((daemon) => daemon.retryTask(run.taskId, { stopRun: true }), ['tasks', 'missions', 'approvals'], run.missionId);
  const wait = useDaemonMutation((daemon) => daemon.snoozeRun(run.runId), ['tasks'], run.missionId);
  const busy = stop.isPending || wait.isPending;

  return (
    <div className={`list__row inbox__row${bordered ? ' list__row--bordered' : ''}`} aria-label={`Quiet: ${run.taskKey}`}>
      <span className="dot dot--blocked" />
      <div className="list__main">
        <div className="list__title truncate">
          <Link href={`/missions/${run.missionId}`}>Quiet for {quietFor(run.quietForMs)}: {run.taskKey}</Link>
        </div>
        <div className="list__subtitle truncate">
          Its agent has written nothing; it is still running, and stops on its own only at its {quietFor(run.budgetMs)} budget
          <span className="sep">·</span>
          {run.missionTitle}
        </div>
        {stop.isError ? <ErrorState error={stop.error} /> : null}
        {wait.isError ? <ErrorState error={wait.error} /> : null}
      </div>
      <div className="list__aside">
        <Tooltip content={`Tandemise stops it on its own only at its ${quietFor(run.budgetMs)} wall-time budget.`}>
          <Chip muted tabIndex={0}>Quiet</Chip>
        </Tooltip>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => wait.mutate(undefined, { onSuccess: () => showFlash(`Keeping ${run.taskKey} running. You will be asked again if it stays quiet another ${quietFor(run.silentAfterMs)}.`) })}
        >
          {wait.isPending ? 'Saving…' : 'Keep waiting'}
        </Button>
        <Button
          disabled={busy}
          onClick={() => stop.mutate(undefined, { onSuccess: () => showFlash(`Stopped ${run.taskKey}; it starts again as attempt ${run.attempt + 1}.`) })}
        >
          {stop.isPending ? 'Stopping…' : 'Stop and retry'}
        </Button>
      </div>
    </div>
  );
}
