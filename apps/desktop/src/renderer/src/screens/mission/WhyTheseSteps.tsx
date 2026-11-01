import { useState } from 'react';
import type { PlanDecisionView } from '@tandemise/api-contract';
import { ErrorState } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import './WhyTheseSteps.css';
import { Button } from '@tandemise/design/react';

/**
 * "Why these steps" (#53 §10): what the factory believed about the task, the
 * lane it chose, what that lane skipped, the rules that added steps, and each
 * step in a line. Every sentence comes from the daemon; this only lays it out.
 */
export function WhyTheseSteps({ missionId, decision }: { missionId: string; decision: PlanDecisionView }): JSX.Element {
  const [openChip, setOpenChip] = useState<number | null>(null);
  const [asked, setAsked] = useState<'quick' | 'careful' | null>(null);
  const lane = useDaemonMutation((daemon, next: 'quick' | 'careful') => daemon.setLane(missionId, next), ['tasks', 'approvals'], missionId);
  const chip = openChip === null ? null : decision.chips[openChip] ?? null;

  const change = (next: 'quick' | 'careful'): void => {
    setAsked(next);
    lane.mutate(next);
  };

  return (
    <section className="why card" aria-label="Why these steps" data-lane={decision.lane}>
      <div className="why__head">
        <div className="why__chips" role="group" aria-label="What the factory saw">
          {decision.chips.map((c, index) => (
            <button
              key={c.label}
              type="button"
              className="why__chip"
              aria-expanded={openChip === index}
              data-open={openChip === index}
              onClick={() => setOpenChip((current) => (current === index ? null : index))}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="why__actions">
          {decision.canMakeCareful ? (
            <Button disabled={lane.isPending} onClick={() => change('careful')}>
              Make it careful
            </Button>
          ) : null}
          {decision.canMakeQuick ? (
            <Button variant="ghost" disabled={lane.isPending} onClick={() => change('quick')}>
              Make it quick
            </Button>
          ) : null}
        </div>
      </div>

      <p className="why__profile" aria-label="Profile">{decision.profileLine}</p>

      {/* Which signal set each of type, size and risk, said plainly (#103), so a keyword or a default is visible at a glance. */}
      {decision.decidedBy.length > 0 ? (
        <ul className="why__list why__decided" aria-label="What decided it">
          {decision.decidedBy.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}

      {chip !== null ? (
        <ul className="why__signals" aria-label={`Why ${chip.label}`}>
          {chip.signals.length === 0 ? <li className="why__muted">Nothing set this; it is the default.</li> : null}
          {chip.signals.map((s) => <li key={s}>{s}</li>)}
        </ul>
      ) : null}

      <p className="why__lane">
        <strong>{decision.laneLine}</strong> <span className="why__muted">{decision.laneBecause}</span>
      </p>

      {decision.tiebreak !== null ? <p className="why__muted">{decision.tiebreak}</p> : null}

      {decision.skipped.length > 0 ? (
        <ul className="why__list" aria-label="Skipped">
          {decision.skipped.map((s) => <li key={s}>{s}</li>)}
        </ul>
      ) : null}

      {decision.modules.length > 0 ? (
        <ul className="why__list" aria-label="Rules applied">
          {decision.modules.map((m) => <li key={m}>{m}</li>)}
        </ul>
      ) : null}

      {decision.dropped.length > 0 ? (
        <ul className="why__list why__muted" aria-label="Rules left out">
          {decision.dropped.map((d) => <li key={d}>{d}</li>)}
        </ul>
      ) : null}

      <ol className="why__steps" aria-label="Steps">
        {decision.steps.map((s) => <li key={s.key} className="why__step">{s.line}</li>)}
      </ol>

      {decision.approvals.length > 0 ? (
        <ul className="why__list" aria-label="Looks from you">
          {decision.approvals.map((a) => <li key={a}>{a}</li>)}
        </ul>
      ) : null}

      {lane.isSuccess && asked === 'quick' ? (
        <p className="why__muted">Making it quick takes steps out, so it waits for you: approve the card in the feed.</p>
      ) : null}
      {lane.isError ? <ErrorState error={lane.error} /> : null}
    </section>
  );
}
