import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { EvalRunView, EvalSuiteView } from '@tandemise/api-contract';
import type { EvalCandidate } from '@tandemise/domain';
import { Icon } from '../../components/Icon.js';
import { Empty, ErrorState, SkeletonList, StatusBadge } from '../../components/primitives.js';
import { useEvalRun, useEvalRuns, useRoles } from '../../lib/queries.js';
import { dateTime, relativeTime } from '../../lib/format.js';
import { RunForm } from './RunForm.js';
import { Scorecard } from './Scorecard.js';
import { Refusal, RUN_TONES, UNMEASURED_COST, isLive, useEvalMutation, usd } from './shared.js';
import { Banner, Button } from '@tandemise/design/react';

/**
 * A suite's eval runs, newest first, beside the open run or the new-run form.
 * A run still going is polled every two seconds; nothing streams it yet.
 */
export function RunsTab({ suites, suiteId, runId, compose, candidate, onSuite, onRun, onCompose, onCloseForm }: {
  suites: readonly EvalSuiteView[];
  suiteId: string | null;
  runId: string | null;
  compose: boolean;
  candidate: EvalCandidate | null;
  onSuite: (suiteId: string) => void;
  onRun: (suiteId: string, runId: string) => void;
  onCompose: () => void;
  onCloseForm: () => void;
}): JSX.Element {
  const runs = useEvalRuns(suiteId);
  const list = [...(runs.data ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const openId = runId ?? list[0]?.id ?? null;
  const showForm = compose || suites.length === 0 || (runs.isSuccess && list.length === 0);

  return (
    <div className="reader">
      <div className="reader__list" aria-label="Runs">
        <div className="evals__listhead">
          {suites.length > 1 ? (
            <select className="select" aria-label="Suite" value={suiteId ?? ''} onChange={(event) => onSuite(event.target.value)}>
              {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
            </select>
          ) : (
            <span className="field__label truncate" style={{ flex: 1, minWidth: 0 }}>{suites[0]?.name ?? 'No suite yet'}</span>
          )}
          <Button variant="primary" onClick={onCompose} disabled={suites.length === 0}>
            <Icon name="plus" size={13} />
            New run
          </Button>
        </div>
        {runs.isError ? <div style={{ padding: 'var(--s4)' }}><ErrorState error={runs.error} onRetry={() => void runs.refetch()} /></div> : null}
        {runs.isPending && suiteId !== null ? <SkeletonList rows={3} /> : null}
        {list.map((run) => (
          <button
            key={run.id}
            type="button"
            className="list__row evals__row"
            data-active={!showForm && run.id === openId}
            aria-label={`Run ${run.id}`}
            onClick={() => onRun(run.suiteId, run.id)}
          >
            <div className="list__main">
              <div className="list__title truncate">{candidateLabel(run.candidate)}</div>
              <div className="list__subtitle dim">
                {relativeTime(run.createdAt)} · {run.repeats} {run.repeats === 1 ? 'repeat' : 'repeats'}
              </div>
            </div>
            <StatusBadge status={run.status} tone={RUN_TONES[run.status]} />
          </button>
        ))}
      </div>
      <div className="reader__pane">
        {showForm ? (
          <RunForm
            key={JSON.stringify(candidate)}
            suites={suites}
            suiteId={suiteId}
            candidate={candidate}
            onStarted={(run) => onRun(run.suiteId, run.id)}
            onCancel={onCloseForm}
          />
        ) : openId !== null ? (
          <RunDetail key={openId} id={openId} />
        ) : runs.isPending ? null : (
          <Empty icon="play" title="No runs yet" body="Start a run to try a model, a skill version or a whole setup against this suite." />
        )}
      </div>
    </div>
  );
}

function RunDetail({ id }: { id: string }): JSX.Element {
  // Polled only while it can still change; the first read decides.
  const first = useEvalRun(id);
  const live = first.data ? isLive(first.data.status) : false;
  const polled = useEvalRun(id, { poll: live });
  const run = polled.data ?? first.data;
  const cancel = useEvalMutation((daemon, runId: string) => daemon.cancelEvalRun(runId));
  // The list beside this run is not polled: when the run's status moves, refresh it so its badge agrees.
  const queryClient = useQueryClient();
  const status = run?.status;
  useEffect(() => {
    if (status !== undefined) void queryClient.invalidateQueries({ queryKey: ['evals', 'runs'] });
  }, [status, queryClient]);

  if (first.isError) return <ErrorState error={first.error} onRetry={() => void first.refetch()} />;
  if (!run) return <SkeletonList rows={3} />;

  return (
    <div className="stack" aria-label="Run" style={{ gap: 'var(--s5)' }}>
      <header className="reader__head">
        <h2 className="reader__title">{candidateLabel(run.candidate)}</h2>
        <div className="reader__meta">
          <StatusBadge status={run.status} tone={RUN_TONES[run.status]} />
          <span>Started {dateTime(run.startedAt ?? run.createdAt)}</span>
          {run.finishedAt ? <span>· finished {dateTime(run.finishedAt)}</span> : null}
        </div>
      </header>

      <CandidateLines candidate={run.candidate} />

      {/* The status line: why a run ended early, in the daemon's words. */}
      {(run.status === 'stopped_at_cap' || run.status === 'failed') && run.reason ? (
        // Appears when a watched run ends early, so it is announced, politely, as the run's status.
        <Banner tone={run.status === 'failed' ? 'warn' : 'neutral'} live="polite" aria-label="Status" icon={<Icon name={run.status === 'failed' ? 'alert' : 'info'} size={14} />}>
          {run.reason}
        </Banner>
      ) : null}
      {run.costUnmeasured ? (
        <Banner icon={<Icon name="info" size={14} className="dim" />}>
          {UNMEASURED_COST}
        </Banner>
      ) : null}

      <div className="grid grid--2">
        <div className="stat" role="group" aria-label="Progress">
          <span className="stat__label">Progress</span>
          <span className="stat__value">
            {run.progress.done} / {run.progress.total} trials{run.progress.cancelled > 0 ? ` · ${run.progress.cancelled} cancelled` : ''}
          </span>
          <div className="meter" style={{ marginTop: 'var(--s1)' }} aria-hidden="true">
            <div className="meter__fill" style={{ width: `${run.progress.total === 0 ? 0 : (run.progress.done / run.progress.total) * 100}%` }} />
          </div>
          <span className="stat__note">{run.repeats} {run.repeats === 1 ? 'repeat' : 'repeats'} of each case, with the setup you have now and with the change</span>
        </div>
        <div className="stat" role="group" aria-label="Spend">
          <span className="stat__label">Spend</span>
          <span className={`stat__value${run.spentUsd === null ? ' stat__value--muted' : ''}`}>
            {run.spentUsd === null ? 'not reported' : `Spent ${usd(run.spentUsd)} of ${usd(run.spendCapUsd)}`}
          </span>
          {run.spentUsd === null ? (
            <span className="stat__note">Cap {usd(run.spendCapUsd)}</span>
          ) : isLive(run.status) ? (
            <span className="stat__note">The run stops when it reaches the cap.</span>
          ) : null}
        </div>
      </div>

      {isLive(run.status) ? (
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate(run.id)}>
            <Icon name="stop" size={13} />
            {cancel.isPending ? 'Cancelling…' : 'Cancel run'}
          </Button>
          <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>The trials that finished still make a scorecard.</span>
        </div>
      ) : null}
      {cancel.isError ? <Refusal error={cancel.error} /> : null}

      {run.scorecard ? <Scorecard scorecard={run.scorecard} /> : null}

      <Trials run={run} />
    </div>
  );
}

function Trials({ run }: { run: EvalRunView }): JSX.Element | null {
  if (run.trials.length === 0) return null;
  return (
    <details className="reader__appendix">
      <summary>
        <Icon name="chevronRight" size={12} className="reader__appendix-chevron" />
        Trials ({run.trials.length})
      </summary>
      <table className="table" aria-label="Trials">
        <thead>
          <tr><th>Case</th><th>Side</th><th>Repeat</th><th>Status</th></tr>
        </thead>
        <tbody>
          {run.trials.map((trial) => (
            <tr key={trial.id}>
              <td>{trial.caseName || <span className="dim">Deleted case</span>}</td>
              <td>{trial.variant === 'baseline' ? 'Baseline' : 'Candidate'}</td>
              <td>{trial.repeat}</td>
              <td>
                <div>{trial.status}</div>
                {trial.reason ? <div className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{trial.reason}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** What the candidate changes, one line per role, named. */
function CandidateLines({ candidate }: { candidate: EvalCandidate }): JSX.Element {
  const roles = useRoles();
  const name = (roleId: string): string => roles.data?.find((r) => r.id === roleId)?.name ?? roleId;
  const lines =
    candidate.kind === 'brain'
      ? [`The brain's proposed change on ${candidate.ref}`]
      : candidate.kind === 'setup'
      ? [`The setup in ${candidate.folder}`]
      : candidate.kind === 'models'
        ? Object.entries(candidate.roles).map(([roleId, model]) => `${name(roleId)} on ${model}`)
        : Object.entries(candidate.roles).map(([roleId, refs]) => `${name(roleId)} with ${refs.map((r) => `${r.name} ${r.version === 'latest' ? 'latest' : `v${r.version}`}`).join(', ')}`);
  return (
    <section aria-label="Candidate" className="stack" style={{ gap: 'var(--s1)' }}>
      <h2 className="section__title">Candidate, against the setup when this run started</h2>
      {lines.map((line) => <p key={line} className="muted" style={{ margin: 0 }}>{line}</p>)}
    </section>
  );
}

function candidateLabel(candidate: EvalCandidate): string {
  if (candidate.kind === 'brain') return 'A brain promotion';
  if (candidate.kind === 'setup') return `Setup from ${candidate.folder.split('/').filter(Boolean).slice(-1)[0] ?? candidate.folder}`;
  if (candidate.kind === 'models') {
    const models = [...new Set(Object.values(candidate.roles))];
    return models.length === 1 ? `Models: ${models[0]}` : `Models: ${models.length} changes`;
  }
  const refs = Object.values(candidate.roles).flat();
  const names = [...new Set(refs.map((r) => `${r.name} ${r.version === 'latest' ? 'latest' : `v${r.version}`}`))];
  return `Skills: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
}
