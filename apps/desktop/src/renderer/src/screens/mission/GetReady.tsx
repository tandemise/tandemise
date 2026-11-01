import { useState } from 'react';
import type { MissionDetail, RefinementCriterionView, RefinementQuestionView, RefinementView } from '@tandemise/api-contract';
import { Drawer } from '../../components/Modal.js';
import { ErrorState, SkeletonList, StatusBadge } from '../../components/primitives.js';
import { useDaemonMutation, useMissionRefinement } from '../../lib/queries.js';
import { pluralize, type Tone } from '../../lib/format.js';
import { ArtifactReader } from '../artifacts/ArtifactReader.js';
import { Icon } from '../../components/Icon.js';
import { Banner, Button, Card, Truncate } from '@tandemise/design/react';

type Upload = NonNullable<MissionDetail['uploads']>[number];

/**
 * "Get it ready": a DRAFT mission's way to being planned (P6 spec §6).
 *
 * The product agent reads the request and proposes criteria and questions;
 * the person decides each one here. The Plan button in the header reads the
 * same readiness the daemon enforces, so what this panel says is left to do
 * is exactly what stands between the request and a plan.
 */
export function GetReady({ missionId, uploads = [] }: { missionId: string; uploads?: readonly Upload[] }): JSX.Element {
  const refinement = useMissionRefinement(missionId);
  const [reading, setReading] = useState<string | null>(null);
  const [readingUpload, setReadingUpload] = useState<Upload | null>(null);
  const refine = useDaemonMutation((daemon) => daemon.refineMission(missionId), ['refinement'], missionId);

  if (refinement.isPending) return <SkeletonList rows={3} />;
  if (refinement.isError) return <ErrorState error={refinement.error} onRetry={() => void refinement.refetch()} />;
  const view = refinement.data;
  const running = view.state === 'running' || refine.isPending;
  const accepted = view.criteria.filter((c) => c.status === 'accepted');
  const proposed = view.criteria.filter((c) => c.status === 'proposed');
  const earlier = view.criteria.filter((c) => c.status === 'rejected' || c.status === 'stale');
  const open = view.questions.filter((q) => q.status === 'open');
  const answered = view.questions.filter((q) => q.status === 'answered');
  const toDecide = view.readiness.openQuestions + view.readiness.proposedPending;

  return (
    <>
      <section className="section feed__section" aria-label="Get it ready">
        <div className="section__head">
          <h2 className="section__title">Get it ready</h2>
          <span className="section__meta">{view.readiness.ready ? 'Ready to plan' : toDecide > 0 ? `${toDecide} to decide` : 'Needs a Done-when criterion'}</span>
        </div>
        <Card>
          <div className="card__body stack" style={{ gap: 'var(--s3)' }}>
            <p className="muted">{intro(view)}</p>
            <div className="decide-inline__row">
              <Button disabled={running} onClick={() => refine.mutate(undefined)}>
                {running ? 'Refining…' : view.artifactId === null ? 'Refine' : 'Refine again'}
              </Button>
              {view.artifactId !== null ? (
                <Button variant="ghost" onClick={() => setReading(view.artifactId)}>
                  Read the refinement
                </Button>
              ) : null}
              <span className="dim">
                {running
                  ? 'The product agent is reading your request. Proposals appear here when it is done.'
                  : view.readiness.ready
                    ? 'Everything is decided. Plan it from the header.'
                    : `${view.readiness.label}.`}
              </span>
            </div>
            {view.state === 'failed' && view.failure ? (
              <Banner tone="warn">
                {view.failure}
              </Banner>
            ) : null}
            {refine.isError ? <ErrorState error={refine.error} /> : null}
          </div>
        </Card>
      </section>

      {uploads.length > 0 ? (
        // Read-only: what the request came with (spec A2). More work is added as feedback once it runs.
        <section className="section feed__section" aria-label="Your uploads">
          <div className="section__head">
            <h2 className="section__title">Your uploads</h2>
            <span className="section__meta">{pluralize(uploads.length, 'upload')}</span>
          </div>
          <div className="list">
            {uploads.map((upload) => (
              <div key={upload.evidenceId} className="list__row">
                <Icon name={upload.refs.some((r) => r.kind === 'url') ? 'link' : 'file'} size={13} className="dim" />
                <div className="list__main">
                  <Truncate as="div" className="list__title">
                    {upload.filename}
                  </Truncate>
                  <div className="list__subtitle truncate">{uploadSource(upload)}</div>
                </div>
                <div className="list__aside">
                  {upload.intakeArtifactId !== null ? (
                    <Button variant="ghost" onClick={() => setReadingUpload(upload)}>
                      Read what it became
                    </Button>
                  ) : (
                    // Intake waits for the first refinement or plan: a request can sit in the backlog for days first.
                    <span className="dim">Read when refining or planning starts</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {proposed.length > 0 ? (
        <section className="section feed__section" aria-label="Proposed criteria">
          <div className="section__head">
            <h2 className="section__title">Proposed criteria</h2>
            <span className="section__meta">{pluralize(proposed.length, 'to decide', 'to decide')}</span>
          </div>
          <div className="list">
            {proposed.map((c) => (
              <ProposedRow key={c.id} missionId={missionId} criterion={c} />
            ))}
          </div>
        </section>
      ) : null}

      {open.length + answered.length > 0 ? (
        <section className="section feed__section" aria-label="Questions">
          <div className="section__head">
            <h2 className="section__title">Questions</h2>
            <span className="section__meta">{open.length > 0 ? `${pluralize(open.length, 'to answer', 'to answer')}` : 'All answered'}</span>
          </div>
          <Card>
            <div className="card__body stack" style={{ gap: 'var(--s5)' }}>
              {open.map((q) => (
                <OpenQuestion key={q.id} missionId={missionId} question={q} />
              ))}
              {answered.map((q) => (
                <div key={q.id} className="qa">
                  <div className="qa__q">
                    <span className="mono">{q.key}</span> {q.text}
                  </div>
                  <div className="qa__a">Answered: {q.answer}</div>
                </div>
              ))}
            </div>
          </Card>
        </section>
      ) : null}

      <section className="section feed__section" aria-label="Done when">
        <div className="section__head">
          <h2 className="section__title">Done when</h2>
          <span className="section__meta">{pluralize(accepted.length, 'criterion', 'criteria')}</span>
        </div>
        {accepted.length > 0 ? (
          <div className="list">
            {accepted.map((c) => {
              const badge = acceptedBadge(c);
              return (
                <div key={c.id} className="list__row">
                  <span className="mono muted">{c.key}</span>
                  <div className="list__main">
                    <Truncate as="div" className="list__title">
                      {c.statement}
                    </Truncate>
                    <div className="list__subtitle truncate">{originLine(c)}</div>
                  </div>
                  <div className="list__aside">
                    <StatusBadge status={badge.label} tone={badge.tone} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">Nothing yet. Accept a proposal, or add a criterion of your own below.</p>
        )}
        <AddCriterion missionId={missionId} />
      </section>

      {earlier.length > 0 ? (
        <section className="section feed__section" aria-label="Earlier proposals">
          <div className="section__head">
            <h2 className="section__title">Earlier proposals</h2>
            <span className="section__meta">{earlier.length}</span>
          </div>
          <div className="list">
            {earlier.map((c) => (
              <div key={c.id} className="list__row">
                <span className="mono dim">{c.key}</span>
                <div className="list__main">
                  <Truncate as="div" className="list__title dim">
                    {c.statement}
                  </Truncate>
                </div>
                <div className="list__aside">
                  <StatusBadge status={c.status === 'rejected' ? 'Rejected' : 'Replaced by a newer proposal'} tone="pending" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {reading ? (
        <Drawer title="Refinement" wide onClose={() => setReading(null)}>
          <ArtifactReader id={reading} />
        </Drawer>
      ) : null}
      {readingUpload?.intakeArtifactId ? (
        <Drawer title={readingUpload.filename} wide onClose={() => setReadingUpload(null)}>
          <ArtifactReader id={readingUpload.intakeArtifactId} />
        </Drawer>
      ) : null}
    </>
  );
}

/** One undecided proposal: accept it, reject it, or accept it in your own words. */
function ProposedRow({ missionId, criterion }: { missionId: string; criterion: RefinementCriterionView }): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const decide = useDaemonMutation(
    (daemon, args: { verdict: 'accept' | 'reject'; statement?: string }) => daemon.decideCriterion(criterion.id, args),
    ['refinement'],
    missionId,
  );
  return (
    <div className="list__row">
      <span className="mono muted">{criterion.key}</span>
      <div className="list__main">
        {editing === null ? (
          <Truncate as="div" className="list__title">
            {criterion.statement}
          </Truncate>
        ) : (
          <textarea
            className="textarea"
            aria-label={`Edit ${criterion.key}`}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
          />
        )}
        <div className="list__subtitle">
          {decide.isError ? <ErrorState error={decide.error} /> : 'Proposed by the product agent. Accept it to make it part of what done means.'}
        </div>
      </div>
      <div className="list__aside">
        {editing === null ? (
          <>
            <Button disabled={decide.isPending} onClick={() => decide.mutate({ verdict: 'accept' })}>
              Accept
            </Button>
            <Button variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ verdict: 'reject' })}>
              Reject
            </Button>
            <Button variant="ghost" disabled={decide.isPending} onClick={() => setEditing(criterion.statement)}>
              Edit
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={decide.isPending || editing.trim().length === 0}
              onClick={() => decide.mutate({ verdict: 'accept', statement: editing.trim() })}
            >
              Accept with changes
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** A question waiting for the person: its options as one click, or their own words. */
function OpenQuestion({ missionId, question }: { missionId: string; question: RefinementQuestionView }): JSX.Element {
  const [answer, setAnswer] = useState('');
  const send = useDaemonMutation((daemon, text: string) => daemon.answerQuestion(question.id, text), ['refinement'], missionId);
  return (
    <div className="decide-inline" aria-label={`Question ${question.key}`}>
      <div className="qa">
        <div className="qa__q">
          <span className="mono">{question.key}</span>
        </div>
        <div className="qa__a">{question.text}</div>
      </div>
      {question.why ? <span className="field__hint">Why it matters: {question.why}</span> : null}
      {question.options.map((option) => (
        <button key={option} type="button" className="option" data-selected={answer === option} onClick={() => setAnswer(option)}>
          <span className="option__radio" />
          <span className="option__label">{option}</span>
        </button>
      ))}
      <div className="decide-inline__row">
        <input
          className="input decide-inline__note"
          aria-label={`Your answer to ${question.key}`}
          placeholder={question.options.length > 0 ? 'Or write your own answer' : 'Your answer'}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
        <Button disabled={send.isPending || answer.trim().length === 0} onClick={() => send.mutate(answer.trim())}>
          Answer
        </Button>
      </div>
      {send.isError ? <ErrorState error={send.error} /> : null}
    </div>
  );
}

function AddCriterion({ missionId }: { missionId: string }): JSX.Element {
  const [statement, setStatement] = useState('');
  const add = useDaemonMutation((daemon, text: string) => daemon.addCriterion(missionId, text), ['refinement'], missionId);
  return (
    <div className="decide-inline" style={{ marginTop: 'var(--s3)' }}>
      <div className="decide-inline__row">
        <input
          className="input decide-inline__note"
          aria-label="Add a Done-when criterion"
          placeholder="Add a criterion in your own words, e.g. The page works on a phone"
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
        />
        <Button
          disabled={add.isPending || statement.trim().length === 0}
          onClick={() => add.mutate(statement.trim(), { onSuccess: () => setStatement('') })}
        >
          Add
        </Button>
      </div>
      {add.isError ? <ErrorState error={add.error} /> : null}
    </div>
  );
}

function intro(view: RefinementView): string {
  if (view.headline !== null) return view.headline;
  if (view.readiness.criteria > 0) {
    return 'This request already says what done means. Refine it if you want the product agent to look for anything missing, or plan it as it is.';
  }
  return 'Before anything is planned, say what done means. Refine asks the product agent to read your request, propose criteria you can check, and ask only what would change the plan. You decide each one.';
}

function acceptedBadge(c: RefinementCriterionView): { label: string; tone: Tone } {
  if (c.decidedBy === 'autonomy') return { label: 'Accepted automatically', tone: 'succeeded' };
  return { label: 'Accepted', tone: 'succeeded' };
}

function originLine(c: RefinementCriterionView): string {
  if (c.origin === 'request') return 'From your request';
  if (c.origin === 'added') return 'Added by you';
  if (c.origin === 'issue') return 'From the GitHub issue';
  if (c.origin === 'tracker') return c.originLabel ?? 'From the tracker item';
  return c.decidedBy === 'autonomy' ? 'Proposed by the product agent; accepted because this mission runs autonomously' : 'Proposed by the product agent; accepted by you';
}

/** Where an upload came from, in a line: the link it was read from, else its kind of file. */
function uploadSource(upload: Upload): string {
  const url = upload.refs.find((r) => r.kind === 'url');
  return url !== undefined ? url.value : upload.mediaType;
}
