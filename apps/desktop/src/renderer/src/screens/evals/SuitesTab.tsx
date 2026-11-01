import { useState } from 'react';
import { Link } from 'wouter';
import type { EvalCaseView, EvalSuiteView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Empty, ErrorState, SkeletonList } from '../../components/primitives.js';
import { useEvalCases, useRoles } from '../../lib/queries.js';
import { pluralize, relativeTime } from '../../lib/format.js';
import { Refusal, useEvalMutation } from './shared.js';
import { Button, Card, Tooltip, Truncate } from '@tandemise/design/react';

type Deleting = { readonly kind: 'suite'; readonly suite: EvalSuiteView } | { readonly kind: 'case'; readonly kase: EvalCaseView };

/** The project's suites and the cases saved into each (spec B2). */
export function SuitesTab({ suites, suiteId, onSuite }: {
  suites: readonly EvalSuiteView[];
  suiteId: string | null;
  onSuite: (suiteId: string | null) => void;
}): JSX.Element {
  if (suites.length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <Card>
            <Empty icon="target" title="No suites yet" body="Save a finished step as a case from its card to start a suite." />
          </Card>
        </div>
      </div>
    );
  }
  const selected = suites.find((s) => s.id === suiteId) ?? suites[0]!;
  return (
    <div className="reader">
      <div className="reader__list" aria-label="Suites">
        {suites.map((suite) => (
          <button
            key={suite.id}
            type="button"
            className="list__row evals__row"
            data-active={suite.id === selected.id}
            aria-label={`Suite: ${suite.name}`}
            onClick={() => onSuite(suite.id)}
          >
            <Icon name="target" size={16} className="dim" />
            <div className="list__main">
              <div className="list__title truncate">{suite.name}</div>
              <div className="list__subtitle dim">{pluralize(suite.cases, 'case')}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="reader__pane">
        <SuiteDetail key={selected.id} suite={selected} onDeleted={() => onSuite(null)} />
      </div>
    </div>
  );
}

function SuiteDetail({ suite, onDeleted }: { suite: EvalSuiteView; onDeleted: () => void }): JSX.Element {
  const cases = useEvalCases(suite.id);
  const roles = useRoles();
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const removeSuite = useEvalMutation((daemon, id: string) => daemon.deleteEvalSuite(id));
  const removeCase = useEvalMutation((daemon, id: string) => daemon.deleteEvalCase(id));
  const roleName = (roleId: string): string => roles.data?.find((r) => r.id === roleId)?.name ?? roleId;
  const list = cases.data ?? [];

  const confirm = (): void => {
    if (deleting === null) return;
    // A refusal (a run is using the suite) closes the dialog and is shown on the screen, in the daemon's words.
    const settle = { onSettled: () => setDeleting(null) };
    if (deleting.kind === 'suite') removeSuite.mutate(suite.id, { ...settle, onSuccess: onDeleted });
    else removeCase.mutate(deleting.kase.id, settle);
  };

  return (
    <div className="stack" aria-label="Suite" style={{ gap: 'var(--s5)' }}>
      <header className="reader__head">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h2 className="reader__title">{suite.name}</h2>
            <div className="reader__meta">
              <span>{pluralize(suite.cases, 'case')}</span>
              <span>· created {relativeTime(suite.createdAt)}</span>
            </div>
          </div>
          <Button variant="ghost" onClick={() => setDeleting({ kind: 'suite', suite })}>
            <Icon name="trash" size={13} />
            Delete suite
          </Button>
        </div>
      </header>

      {removeSuite.isError ? <Refusal error={removeSuite.error} /> : null}
      {removeCase.isError ? <Refusal error={removeCase.error} /> : null}

      {cases.isError ? (
        <ErrorState error={cases.error} onRetry={() => void cases.refetch()} />
      ) : cases.isPending ? (
        <SkeletonList rows={2} />
      ) : list.length === 0 ? (
        <Empty icon="target" title="No cases in this suite" body="Save a finished step as a case from its card to start a suite." />
      ) : (
        <Card flush>
          <table className="table" aria-label="Cases">
            <thead>
              <tr>
                <th>Case</th>
                <th>Step</th>
                <th>Role</th>
                <th>Base</th>
                <th>Inputs</th>
                <th>From</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((kase) => (
                <tr key={kase.id} aria-label={`Case: ${kase.name}`}>
                  <td style={{ minWidth: 120 }}>{kase.name}</td>
                  <td className="muted">{kase.stepTitle}</td>
                  <td>{roleName(kase.roleId)}</td>
                  <td className="mono">
                    <Tooltip content={kase.baseSha}>
                      <span>{kase.baseSha.slice(0, 7)}</span>
                    </Tooltip>
                  </td>
                  <td>
                    {kase.inputs.length === 0 ? (
                      <span className="dim">None</span>
                    ) : (
                      kase.inputs.map((input) => (
                        <Truncate as="div" key={`${input.type}-${input.title}`} style={{ maxWidth: 220 }}>
                          {input.title} <span className="dim">({input.type})</span>
                        </Truncate>
                      ))
                    )}
                  </td>
                  <td>
                    {kase.source.missionExists ? (
                      <Link href={`/missions/${kase.source.missionId}`}>from {kase.source.missionTitle}</Link>
                    ) : (
                      <span className="dim">from {kase.source.missionTitle}</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Tooltip content={`Delete case ${kase.name}`}>
                      <Button variant="ghost" iconOnly aria-label={`Delete case ${kase.name}`} onClick={() => setDeleting({ kind: 'case', kase })}>
                        <Icon name="trash" size={13} />
                      </Button>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {deleting ? (
        <ConfirmDialog
          title={deleting.kind === 'suite' ? `Delete the suite “${suite.name}”?` : `Delete the case “${deleting.kase.name}”?`}
          body={
            deleting.kind === 'suite'
              ? 'Its cases and the scorecards of its runs go with it. The missions they came from are not touched.'
              : 'Runs that already used it keep their scorecards. The mission it came from is not touched.'
          }
          confirmLabel={deleting.kind === 'suite' ? 'Delete suite' : 'Delete case'}
          destructive
          busy={removeSuite.isPending || removeCase.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={confirm}
        />
      ) : null}
    </div>
  );
}
