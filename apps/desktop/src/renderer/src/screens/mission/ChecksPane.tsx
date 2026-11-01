import type { MissionDetail } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { Empty, SectionHead } from '../../components/primitives.js';
import { criteriaCoveragePercent } from '../../lib/domain.js';
import { duration, relativeTime, titleCase } from '../../lib/format.js';
import { Card } from '@tandemise/design/react';

/**
 * Deterministic checks and gate outcomes.
 *
 * The gate engine already produces a `detail` string explaining exactly why it
 * blocked, so this pane shows that verbatim rather than paraphrasing it - a
 * paraphrase would be a second, weaker source of truth about the same decision.
 */
export function ChecksPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const gated = detail.tasks.filter((task) => task.gate !== null);

  return (
    // Focusable, so a keyboard can scroll it when nothing inside takes focus (2.1.1).
    <div className="page" tabIndex={0} role="region" aria-label="Checks and gates">
      <div className="page__inner">
        <section className="section">
          <SectionHead title="Quality gates" meta={`${gated.filter((t) => t.gate?.passed).length} of ${gated.length} passing`} />
          {gated.length === 0 ? (
            <Card>
              <Empty
                icon="shield"
                title="No gates have been evaluated"
                body="A gate is a small boolean expression over facts the orchestrator measured. It runs when a task finishes."
              />
            </Card>
          ) : (
            <div className="stack">
              {gated.map((task) => (
                <Card key={task.id}>
                  <div className="row">
                    <span className={`badge badge--${task.gate?.passed ? 'succeeded' : 'blocked'}`}>
                      <Icon name={task.gate?.passed ? 'shield' : 'alert'} size={12} />
                      {task.gate?.passed ? 'Passed' : 'Blocked'}
                    </span>
                    <span style={{ fontWeight: 550 }}>{task.title}</span>
                    <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
                      {task.roleName}
                    </span>
                  </div>

                  <p style={{ marginTop: 'var(--s2)', fontSize: 'var(--fs-base)', lineHeight: 1.6 }}>{task.gate?.detail}</p>

                  <code
                    className="mono dim"
                    style={{
                      display: 'block',
                      marginTop: 'var(--s3)',
                      padding: 'var(--s2) var(--s3)',
                      background: 'var(--surface-sunken)',
                      borderRadius: 'var(--tds-radius-sm)',
                      border: '1px solid var(--border)',
                      overflowX: 'auto',
                    }}
                  >
                    {task.gate?.expression}
                  </code>

                  {task.gate && Object.keys(task.gate.facts).length > 0 ? (
                    <div className="row row--wrap" style={{ marginTop: 'var(--s3)' }}>
                      {Object.entries(task.gate.facts).map(([fact, value]) => (
                        <span key={fact} className="chip">
                          {fact} = {String(value ?? 'unknown')}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className="section">
          <SectionHead title="Deterministic checks" meta={`${detail.checks.length} results`} />
          {detail.checks.length === 0 ? (
            <Card>
              <Empty icon="check" title="No checks have run" body="Typecheck, lint, test and build commands run against each task's worktree once the work lands." />
            </Card>
          ) : (
            <Card flush>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 92 }}>Outcome</th>
                    <th>Check</th>
                    <th>Detail</th>
                    <th style={{ width: 90 }}>Duration</th>
                    <th style={{ width: 96 }}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.checks.map((check) => (
                    <tr key={check.id}>
                      <td>
                        <span
                          className={`badge badge--${check.outcome === 'PASS' ? 'succeeded' : check.outcome === 'FAIL' ? 'failed' : 'pending'}`}
                        >
                          {check.outcome}
                        </span>
                      </td>
                      <td>
                        <span className="mono">{check.name}</span>
                        {check.command ? <div className="dim mono" style={{ fontSize: 'var(--fs-micro)' }}>{check.command}</div> : null}
                      </td>
                      <td className="muted">{check.detail}</td>
                      <td className="dim">{duration(check.durationMs)}</td>
                      <td className="dim">{relativeTime(check.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>

        {detail.evaluations.length > 0 ? (
          <section className="section">
            <SectionHead title="Evaluations" meta="Structured verdicts from evaluator roles" />
            <div className="stack">
              {detail.evaluations.map((evaluation) => (
                <Card key={evaluation.id} flush>
                  <div className="card__head">
                    <span
                      className={`badge badge--${evaluation.verdict === 'pass' ? 'succeeded' : evaluation.verdict === 'fail' ? 'failed' : 'blocked'}`}
                    >
                      {titleCase(evaluation.verdict)}
                    </span>
                    <span className="card__title">{titleCase(evaluation.evaluatorRoleId)}</span>
                    <div className="spacer" />
                    <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
                      {criteriaCoveragePercent(evaluation.criteriaCoverage)}% of criteria covered
                    </span>
                  </div>
                  <div className="card__body" style={{ paddingBottom: 0 }}>
                    <p className="muted" style={{ lineHeight: 1.6 }}>{evaluation.summary}</p>
                  </div>
                  <div style={{ marginTop: 'var(--s3)' }}>
                    {evaluation.findings.map((finding, index) => (
                      <div key={index} className="finding">
                        <span className={`finding__sev finding__sev--${finding.severity}`}>{finding.severity}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 550 }}>{finding.title}</div>
                          <div className="muted" style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.55 }}>{finding.detail}</div>
                          {finding.location ? (
                            <div className="mono dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>{finding.location}</div>
                          ) : null}
                          {finding.suggestedFix ? (
                            <div className="muted" style={{ fontSize: 'var(--fs-sm)', marginTop: 4 }}>
                              <strong>Suggested fix.</strong> {finding.suggestedFix}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
