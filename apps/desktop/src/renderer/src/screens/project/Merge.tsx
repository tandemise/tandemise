import { useState } from 'react';
import type { BacktestResponse } from '@tandemise/api-contract';
import { ErrorState, SectionHead, SkeletonList } from '../../components/primitives.js';
import { useDaemonMutation, useMergePolicy } from '../../lib/queries.js';
import { useDaemon } from '../../lib/connection.js';
import './Merge.css';
import { Button, Card } from '@tandemise/design/react';

interface NeverRule { readonly paths?: readonly string[]; readonly areas?: readonly string[]; readonly when?: string }
interface ScoreRule { readonly why: string; readonly points: number }

/**
 * Project settings → Merge (#53 §8.4, §10): auto-merge on or off, with the
 * backtest shown before you turn it on; what never merges on its own; the
 * score table; Stop auto-merging. Edits are written to the project's
 * repository by the daemon.
 */
export function Merge({ workspaceId }: { workspaceId: string }): JSX.Element {
  const merge = useMergePolicy();
  const daemon = useDaemon();
  const [preview, setPreview] = useState<BacktestResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const save = useDaemonMutation((d, policy: Record<string, unknown>) => d.updateMergePolicy(workspaceId, policy), ['workspaces', 'ship', 'decisions']);
  const stop = useDaemonMutation((d) => d.stopAutoMerge(workspaceId), ['workspaces', 'ship']);
  const view = merge.data;
  if (view === undefined) {
    return (
      <section className="section" aria-label="Merge">
        <SectionHead title="Merge" meta="When Tandemise merges a pull request on its own" />
        {merge.isError ? <ErrorState error={merge.error} onRetry={() => void merge.refetch()} /> : <SkeletonList rows={2} />}
      </section>
    );
  }
  const policy = view.policy;
  const on = policy.autoMerge === 'on';
  const never = (policy['never'] as readonly NeverRule[] | undefined) ?? [];
  const score = (policy['score'] as readonly ScoreRule[] | undefined) ?? [];

  const askToTurnOn = async (): Promise<void> => {
    setPreviewError(null);
    try {
      setPreview(await daemon.backtestMergePolicy(workspaceId, { ...policy, autoMerge: 'on' }));
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };

  return (
    <section className="section" aria-label="Merge">
      <SectionHead title="Merge" meta="When Tandemise merges a pull request on its own" />
      <Card className="merge" data-on={on}>
        <div className="merge__switch">
          <span className="merge__state">{on ? 'Auto-merge is on' : 'Auto-merge is off'}</span>
          {on ? (
            <Button variant="danger" disabled={stop.isPending} onClick={() => stop.mutate(undefined)}>Stop auto-merging</Button>
          ) : preview === null ? (
            <Button onClick={() => void askToTurnOn()}>Turn auto-merge on…</Button>
          ) : null}
        </div>
        <p className="merge__hint">
          {on
            ? `A pull request merges on its own when CI is green on its head commit, nothing below says never, and its risk score is at most ${policy.autoMergeAtMost}. Everything else asks you.`
            : 'Every pull request asks for your review. The ship card still says what would have happened.'}
        </p>
        {preview !== null ? (
          <div className="merge__preview">
            <p className="merge__backtest">{preview.sentence}</p>
            <div className="merge__actions">
              <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate({ ...policy, autoMerge: 'on' }, { onSuccess: () => setPreview(null) })}>
                Turn it on
              </Button>
              <Button onClick={() => setPreview(null)}>Not now</Button>
            </div>
          </div>
        ) : null}
        {previewError !== null ? <p className="merge__error">{previewError}</p> : null}
        {save.isError ? <p className="merge__error">{(save.error as Error).message}</p> : null}
        {view.error !== null ? <p className="merge__error">The merge policy can't be read ({view.error}), so every pull request asks.</p> : null}
        <h3 className="merge__heading">Never merged on its own</h3>
        <ul className="merge__list">
          {never.map((rule, i) => (
            <li key={i}>
              {rule.paths !== undefined ? `Changes to ${rule.paths.join(', ')}` : rule.areas !== undefined ? `Changes in ${rule.areas.join(', ')}` : `When ${rule.when ?? ''}`}
            </li>
          ))}
        </ul>
        <h3 className="merge__heading">Risk score</h3>
        <ul className="merge__list">
          {score.map((rule, i) => <li key={i}>{rule.why}: {rule.points} {rule.points === 1 ? 'point' : 'points'}</li>)}
        </ul>
      </Card>
    </section>
  );
}
