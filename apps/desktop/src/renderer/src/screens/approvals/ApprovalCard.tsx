import { useState } from 'react';
import { Link } from 'wouter';
import type { ApprovalView } from '@tandemise/api-contract';
import type { Approval, ApprovalEvidence, RiskClass } from '@tandemise/domain';
import { Icon, type IconName } from '../../components/Icon.js';
import { Modal } from '../../components/Modal.js';
import { IdChip } from '../../components/primitives.js';
import { useArtifact } from '../../lib/queries.js';
import { actorsLine, type Actors } from '../../lib/team.js';
import { relativeTime, titleCase } from '../../lib/format.js';
import { ArtifactReader } from '../artifacts/ArtifactReader.js';
import { DecisionForm, copyFor, riskLabel, useApprovalDecision } from '../../components/Decision.js';
import { LimitDecision } from './LimitDecision.js';
import { isLimitCard } from '../../lib/domain.js';
import { Badge, Banner } from '@tandemise/design/react';

/**
 * MVP.md §23.4 is a hard requirement, not a style note: every card must answer
 * *what*, *why*, *what evidence*, *what changes*, *what risk*, *what else could
 * I choose*. The six questions are literally the layout below, so an approval
 * that is missing one is visibly incomplete rather than quietly ambiguous.
 */
export function ApprovalCard({ view, compact = false, headingLevel = 3 }: {
  view: ApprovalView;
  compact?: boolean;
  /** The card's title level: 3 under a section heading (the Inbox), 2 straight under the page's h1 (1.3.1). */
  headingLevel?: 2 | 3;
}): JSX.Element {
  const { approval } = view;
  const Title = headingLevel === 2 ? 'h2' : 'h3';
  const decision = useApprovalDecision(view);
  const { actors, copy } = decision;
  // The full question is kept as evidence because titles are cut at one line;
  // when it was not cut, repeating it under the title says nothing new.
  // Pipeline markers are shown as one badge; as evidence rows they read as data.
  const evidence = approval.evidence.filter((item) => !(copy.question && item.value === approval.title) && !isPipelineMarker(item));
  const position = pipelinePosition(approval);

  return (
    <article className="approval" data-risk={approval.risk}>
      <div className="approval__risk" />

      <header className="approval__head">
        {/* A question carries no risk of its own; a badge saying so is noise. */}
        {copy.question || isLimitCard(approval) ? null : (
          <span className={`badge ${riskBadgeClass(approval.risk)}`}>
            <Icon name={riskIcon(approval.risk)} size={12} />
            {riskLabel(approval.risk)}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title className="approval__title">{approval.title}</Title>
          <div className="approval__context">
            <span className={copy.question ? 'chip chip--you' : 'chip chip--muted'}>{copy.kindLabel}</span>
            {position ? <Badge tone="accent">{position}</Badge> : null}
            <IdChip id={approval.id} />
            {approval.taskId ? <IdChip id={approval.taskId} prefix="task" /> : null}
            {view.missionTitle ? (
              approval.missionId ? (
                <Link href={`/missions/${approval.missionId}`}>{view.missionTitle}</Link>
              ) : (
                <span>{view.missionTitle}</span>
              )
            ) : null}
            {view.taskTitle ? (
              <>
                <span className="sep">·</span>
                <span>{view.taskTitle}</span>
              </>
            ) : null}
            {view.roleName ? (
              <>
                <span className="sep">·</span>
                <span>requested by {view.roleName}</span>
              </>
            ) : null}
            <span className="sep">·</span>
            <span>{relativeTime(approval.createdAt)}</span>
          </div>
          <AddressLine view={view} actors={actors} />
        </div>
      </header>

      <div className="approval__grid">
        <Question icon="info" question="Why is this being asked?" answer={approval.rationale} />
        <Question icon="zap" question={copy.effectQuestion} answer={approval.effect} />
      </div>

      {evidence.length > 0 && !compact ? (
        <div style={{ padding: '0 var(--s5) var(--s4)' }}>
          <div className="qa__q" style={{ marginBottom: 6 }}>
            <Icon name="eye" size={12} />
            Evidence
          </div>
          <div className="evidence">
            {evidence.map((item, index) => (
              <EvidenceRow key={`${item.label}-${index}`} evidence={item} />
            ))}
          </div>
        </div>
      ) : null}

      {approval.expiresAt ? (
        <div style={{ padding: '0 var(--s5) var(--s4)' }}>
          <Banner tone="warn" icon={<Icon name="clock" size={14} />}>
            This request expires {relativeTime(approval.expiresAt)}. If it lapses, the task stays blocked.
          </Banner>
        </div>
      ) : null}

      <div className="approval__options">
        <div className="qa__q">
          <Icon name="approvals" size={12} />
          {copy.question ? 'Your answer' : 'Your options'}
        </div>
        {/* A limit card is answered with a number: raise to it and resume, or keep paused (P8). */}
        {isLimitCard(approval) ? <LimitDecision view={view} /> : <DecisionForm decision={decision} />}
      </div>
    </article>
  );
}

/** The Home-screen form: same questions, fewer of them, and it links onward. */
export function ApprovalPreviewCard({ view }: { view: ApprovalView }): JSX.Element {
  const { approval } = view;
  return (
    <Link href="/inbox" className="approval" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }} data-risk={approval.risk}>
      <div className="approval__risk" />
      <header className="approval__head" style={{ paddingBottom: 'var(--s2)' }}>
        {isLimitCard(approval) ? null : (
          <span className={`badge ${riskBadgeClass(approval.risk)}`}>
            <Icon name={riskIcon(approval.risk)} size={12} />
            {riskLabel(approval.risk)}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="approval__title">{approval.title}</h3>
          {view.headline ? <p className="approval__headline truncate">{view.headline}</p> : null}
          <div className="approval__context">
            <span className={approval.kind === 'choice' ? 'chip chip--you' : 'chip chip--muted'}>
              {copyFor(approval, undefined).kindLabel}
            </span>
            {view.missionTitle ? <span>{view.missionTitle}</span> : null}
            <span className="sep">·</span>
            <span>{relativeTime(approval.createdAt)}</span>
          </div>
        </div>
        <span className="btn btn--primary" style={{ flex: 'none' }}>
          Review
          <Icon name="chevronRight" size={13} />
        </span>
      </header>
      <div className="approval__grid" style={{ paddingBottom: 'var(--s4)' }}>
        <Question icon="info" question="Why" answer={approval.rationale} />
        <Question icon="zap" question={approval.kind === 'choice' ? 'What happens next' : 'What changes'} answer={approval.effect} />
      </div>
    </Link>
  );
}

function Question({ icon, question, answer }: { icon: IconName; question: string; answer: string }): JSX.Element {
  return (
    <div className="qa">
      <span className="qa__q">
        <Icon name={icon} size={12} />
        {question}
      </span>
      <p className="qa__a">{answer}</p>
    </div>
  );
}

/**
 * Who the card is for and how far it has climbed, in one line. Only said when
 * it adds something: a solo workspace whose every card is for you sees nothing.
 */
function AddressLine({ view, actors }: { view: ApprovalView; actors: Actors }): JSX.Element | null {
  const onlyMe = view.addressees.length === 1 && view.addressees[0]?.id === actors.meId;
  const escalatedTo = view.escalationLevel > 0 ? view.addressees[view.addressees.length - 1] : undefined;
  // "For you" alone is the default; it earns a line only when it says something else.
  if (view.addressees.length === 0 || (onlyMe && escalatedTo === undefined)) return null;
  return (
    <div className="approval__context">
      <span>For {actorsLine(view.addressees, actors.meId)}</span>
      {escalatedTo ? (
        <>
          <span className="sep">·</span>
          <span className="inbox__escalated">Escalated to {escalatedTo.id === actors.meId ? 'you' : escalatedTo.name}</span>
        </>
      ) : null}
    </div>
  );
}

const REVIEW_LABEL = 'Review';
const SIGN_OFF_LABEL = 'Sign-off';

function isPipelineMarker(e: ApprovalEvidence): boolean {
  return e.kind === 'text' && (e.label === REVIEW_LABEL || e.label === SIGN_OFF_LABEL);
}

/** "Review 1 of 2" or "Lead sign-off", read from the markers the review pipeline writes. */
export function pipelinePosition(approval: Approval): string | null {
  if (approval.evidence.some((e) => e.kind === 'text' && e.label === SIGN_OFF_LABEL)) return 'Lead sign-off';
  const marker = approval.evidence.find((e) => e.kind === 'text' && e.label === REVIEW_LABEL);
  const match = marker ? /^(\d+)\/(\d+)$/.exec(marker.value) : null;
  if (!match) return null;
  // A single review is just "the review"; numbering it says nothing.
  return match[2] === '1' ? null : `Review ${match[1]} of ${match[2]}`;
}

function EvidenceRow({ evidence }: { evidence: ApprovalEvidence }): JSX.Element {
  const isLink = evidence.kind === 'link' && /^https?:\/\//.test(evidence.value);
  if (evidence.kind === 'artifact') return <ArtifactEvidence evidence={evidence} />;
  return (
    <div className="evidence__row">
      <span className="evidence__kind">
        <Icon name={evidenceIcon(evidence.kind)} size={13} />
      </span>
      <span className="evidence__label">{evidence.label}</span>
      <span className="evidence__value">
        {isLink ? (
          <a
            href={evidence.value}
            onClick={(event) => {
              event.preventDefault();
              void window.tandemise.openExternal(evidence.value);
            }}
          >
            {evidence.value}
            <Icon name="externalLink" size={11} />
          </a>
        ) : (
          evidence.value
        )}
      </span>
    </div>
  );
}

/** An artifact by its title, opening in place; the id only when it cannot be found. */
function ArtifactEvidence({ evidence }: { evidence: ApprovalEvidence }): JSX.Element {
  const artifact = useArtifact(evidence.value);
  const [open, setOpen] = useState(false);
  const manifest = artifact.data?.manifest;
  const headline = manifest ? evidenceHeadline(manifest) : null;
  return (
    <div className="evidence__row">
      <span className="evidence__kind">
        <Icon name="file" size={13} />
      </span>
      <span className="evidence__label">{titleCase(evidence.label)}</span>
      <span className="evidence__value">
        {manifest ? (
          <>
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault();
                setOpen(true);
              }}
            >
              {manifest.title}
            </a>
            {/* The headline says what the document concludes, so the card can be answered without opening it. */}
            {headline ? <span className="evidence__headline">{headline}</span> : null}
          </>
        ) : (
          <span className="mono dim">{evidence.value}</span>
        )}
      </span>
      {open && manifest ? (
        <Modal title={manifest.title} wide onClose={() => setOpen(false)}>
          <ArtifactReader id={manifest.id} />
        </Modal>
      ) : null}
    </div>
  );
}

/** A legacy artifact has no handoff; its summary is the headline, as in the reader. */
function evidenceHeadline(manifest: { handoff?: { headline: string } | null; summary: string | null }): string | null {
  return manifest.handoff?.headline ?? manifest.summary;
}

function evidenceIcon(kind: ApprovalEvidence['kind']): IconName {
  switch (kind) {
    case 'artifact':
      return 'file';
    case 'check':
      return 'check';
    case 'diff':
      return 'branch';
    case 'link':
      return 'link';
    default:
      return 'message';
  }
}

function riskIcon(risk: RiskClass): IconName {
  switch (risk) {
    case 'read':
      return 'eye';
    case 'write_reversible':
      return 'refresh';
    case 'external_side_effect':
      return 'externalLink';
    case 'destructive':
      return 'alert';
    case 'financial':
      return 'alert';
    default:
      return 'zap';
  }
}

function riskBadgeClass(risk: RiskClass): string {
  switch (risk) {
    case 'read':
      return 'badge';
    case 'write_reversible':
      return 'badge badge--running';
    case 'external_side_effect':
      return 'badge badge--blocked';
    case 'destructive':
    case 'financial':
      return 'badge badge--failed';
    default:
      return 'badge badge--release';
  }
}
