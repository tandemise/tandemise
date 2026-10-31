import { useState } from 'react';
import type { MissionCriterionView } from '@tandemise/api-contract';
import { Drawer } from '../../components/Modal.js';
import { StatusBadge } from '../../components/primitives.js';
import type { Tone } from '../../lib/format.js';
import { useMissionCriteria } from '../../lib/queries.js';
import { ArtifactReader } from '../artifacts/ArtifactReader.js';
import { Truncate } from '@tandemise/design/react';

/**
 * The mission's Done-when ledger, at the top of the feed (P5 spec §9).
 *
 * Each line the person wrote, each criterion the spec answered with, and what
 * QA found - traced by the daemon, not claimed by an agent. The header counts
 * what has to pass before the mission can ship; a line the spec left
 * uncovered counts too, so a spec cannot make the mission look finished by
 * leaving something out.
 */
export function DoneWhen({ missionId }: { missionId: string }): JSX.Element | null {
  const criteria = useMissionCriteria(missionId);
  const [reading, setReading] = useState<{ id: string; title: string } | null>(null);
  const rows = criteria.data ?? [];
  // Nothing to trace (a mission from before the ledger, or none written yet): the feed starts where it always did.
  if (rows.length === 0) return null;

  const counted = rows.filter((r) => r.counted);
  const verified = counted.filter((r) => r.result === 'PASS').length;

  return (
    <section className="section feed__section" aria-label="Done when">
      <div className="section__head">
        <h2 className="section__title">Done when</h2>
        <span className="section__meta">
          {verified} of {counted.length} verified
        </span>
      </div>
      <div className="list">
        {rows.map((row) => {
          const status = statusOf(row);
          const target = openTarget(row);
          const content = (
            <>
              <span className="mono muted">{row.key}</span>
              <div className="list__main">
                <Truncate as="div" className="list__title">
                  {row.statement}
                </Truncate>
                <div className="list__subtitle truncate">{traceLine(row)}</div>
              </div>
              <div className="list__aside">
                <StatusBadge status={status.label} tone={status.tone} />
              </div>
            </>
          );
          return target === null ? (
            <div key={row.id} className="list__row">
              {content}
            </div>
          ) : (
            <button
              key={row.id}
              type="button"
              className="list__row"
              onClick={() => setReading(target)}
            >
              {content}
              {/* The visible words name the row (2.5.3); what pressing it does follows them. */}
              <span className="visually-hidden">Open the {target.title}</span>
            </button>
          );
        })}
      </div>

      {reading ? (
        <Drawer title={reading.title} wide onClose={() => setReading(null)}>
          <ArtifactReader id={reading.id} />
        </Drawer>
      ) : null}
    </section>
  );
}

function statusOf(row: MissionCriterionView): { label: string; tone: Tone } {
  if (row.result === 'PASS') return { label: 'Verified', tone: 'succeeded' };
  if (row.result === 'FAIL') return { label: 'Failed', tone: 'failed' };
  if (row.uncovered) return { label: 'Not covered', tone: 'blocked' };
  return { label: 'Not verified', tone: 'pending' };
}

/** What the plan will do with a line nothing covers or verifies yet. */
const PLANNED_CHECK = {
  spec: 'The spec will cover this',
  qa: 'QA will verify this',
  none: 'Nothing in this plan verifies this',
  unplanned: 'Waiting for the plan',
} as const;

/** What traces this criterion, in words: what covers it, what it covers, what QA saw. */
function traceLine(row: MissionCriterionView): string {
  const parts: string[] = [];
  if (row.source === 'user') {
    parts.push(
      row.uncovered
        ? 'Nothing in the spec covers this yet'
        : row.coveredBy.length > 0
          ? `Covered by ${row.coveredBy.join(', ')}`
          : row.qaArtifactId !== null
            ? 'Reported by QA'
            : PLANNED_CHECK[row.plannedCheck ?? 'unplanned'],
    );
  } else {
    parts.push(row.covers.length > 0 ? `Covers ${row.covers.join(', ')}` : 'From the spec');
  }
  if (row.result === 'SKIP') parts.push('QA could not verify it');
  // A user line verified through the spec already says what covers it.
  if (row.qaArtifactId !== null && row.evidence !== '' && !row.evidence.startsWith('Through ')) parts.push(row.evidence);
  if (row.qaArtifactId === null && row.result === 'UNVERIFIED' && !row.uncovered && row.source === 'spec') parts.push('Waiting for QA');
  return parts.join(' · ');
}

/** The QA report a result came from; a spec criterion QA has not reached opens its spec. */
function openTarget(row: MissionCriterionView): { id: string; title: string } | null {
  if (row.qaArtifactId !== null) return { id: row.qaArtifactId, title: 'QA report' };
  if (row.specArtifactId !== null) return { id: row.specArtifactId, title: 'Product spec' };
  return null;
}
