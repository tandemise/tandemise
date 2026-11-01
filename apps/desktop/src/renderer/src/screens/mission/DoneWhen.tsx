import { useState, type ReactNode } from 'react';
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
  // A plan with no step that verifies these lines (the quick lane has no QA): said once, not as a red mark per row (#105).
  const yours = counted.length > 0 && counted.every((r) => byYou(r));

  return (
    <section className="section feed__section" aria-label="Done when">
      <div className="section__head">
        <h2 className="section__title">Done when</h2>
        <span className="section__meta">
          {yours ? 'You check these at review' : `${verified} of ${counted.length} verified`}
        </span>
      </div>
      {yours ? <p className="muted done-when__note">No step in this plan verifies these lines, so you check them when you review the pull request.</p> : null}
      <div className="list">
        {rows.map((row) => {
          const status = statusOf(row);
          const target = openTarget(row);
          const content = (
            <>
              <span className="mono muted">{row.key}</span>
              <div className="list__main">
                <Truncate as="div" className="list__title">
                  <InlineMarkdown text={row.statement} />
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
  if (byYou(row)) return { label: 'At your review', tone: 'pending' };
  return { label: 'Not verified', tone: 'pending' };
}

/** A line nothing in the plan verifies, and nothing has: the person checks it when reviewing. */
function byYou(row: MissionCriterionView): boolean {
  return row.plannedCheck === 'none' && row.result !== 'PASS' && row.result !== 'FAIL' && !row.uncovered && row.qaArtifactId === null;
}

/**
 * A Done-when line as the tracker wrote it, with its inline Markdown shown
 * rather than spelled out (#105): **bold** and `code`. Text only, never HTML.
 */
function InlineMarkdown({ text }: { text: string }): JSX.Element {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g;
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[3] !== undefined) out.push(<code key={m.index}>{m[3]}</code>);
    else out.push(<strong key={m.index}>{m[1] ?? m[2]}</strong>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** What the plan will do with a line nothing covers or verifies yet. */
const PLANNED_CHECK = {
  spec: 'The spec will cover this',
  qa: 'QA will verify this',
  none: 'No step in this plan verifies this; you check it at review',
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
