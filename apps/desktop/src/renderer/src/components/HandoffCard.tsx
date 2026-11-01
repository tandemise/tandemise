import { useState } from 'react';
import type { ApprovalView, FeedCard, FeedChange, PlanDecision, TaskView } from '@tandemise/api-contract';
import type { TaskStatus } from '@tandemise/domain';
import { Icon } from './Icon.js';
import { Attribution } from './ActorChip.js';
import { DecisionForm, useApprovalDecision } from './Decision.js';
import { RequestChangesButton } from './RequestChanges.js';
import { LINKABLE_OUTPUT_TYPES, PARKABLE_TASK_STATUSES, REQUEST_CHANGES_OPTION, isPlanFitCard } from '../lib/domain.js';
import { useWorkspaceId } from '../lib/workspace.js';
import { HandoffLinkButton, openableLinks } from './HandoffLinks.js';
import { ContinueElsewhereDialog, HandBackDialog } from './HandBackDialog.js';
import { StartRoundButton } from './ImpactDialog.js';
import { pluralize, relativeTime, taskTone, type Tone } from '../lib/format.js';
import { useDaemonMutation } from '../lib/queries.js';
import { describeError } from '../lib/daemon.js';
import { showFlash } from '../lib/notices.js';
import { actorLabel, type Actors } from '../lib/team.js';
import { SaveCaseDialog } from '../screens/evals/SaveCaseDialog.js';
import { HoldButton, NowLine } from './TerminalPanel.js';
import { Badge, Button, Chip, Tooltip, Truncate } from '@tandemise/design/react';

/** What changed, at most: the handoff contract caps `changed` at three, and a card shows all of them. */
const CHANGED_SHOWN = 3;

/** Lines under the headline: points, what changed and the pending notes share them, so a card stays at eight lines. */
const LINES_UNDER_HEADLINE = 4;

/**
 * One task in a mission, told in the few lines a busy person actually reads.
 *
 * The layout is a budget, not a suggestion: a header, who did it, the
 * headline (two lines at most), then four lines shared by what changed in this
 * round, the notes still waiting on one, and the points. What is new comes
 * first: a round's changes and the pending notes take their lines, and the
 * points get what is left. Everything longer lives behind "Full doc".
 * Nothing here shows an id or the YAML the handoff came from; those are for
 * machines and bug reports, and a card that shows them stops being scannable.
 */
export function HandoffCard({
  card,
  missionId,
  actors,
  onFullDoc,
  onDoIt,
  onReplan,
  replanning = false,
  objective,
  waitingFor,
  task,
  usedDownstream = false,
}: {
  card: FeedCard;
  /** Work that depends on this card's step has already run on its output, so it can no longer be taken elsewhere. */
  usedDownstream?: boolean;
  /** The card's task as the mission view has it: whether it can be continued elsewhere, or is parked there now. */
  task?: TaskView;
  missionId: string;
  /** Who an open request on this card is waiting for, when it is someone else: "Waiting for Ana Ruiz". */
  waitingFor?: string;
  /** The task's objective: what a person step asks for, when there is no handoff yet to say it. */
  objective?: string;
  actors: Actors;
  onFullDoc: (card: FeedCard) => void;
  /** Opens the task drawer for a person step that is mine to complete or claim. */
  onDoIt: (card: FeedCard) => void;
  /** Plans the mission again: the way forward from a rejected plan that is mine to answer. */
  onReplan?: () => void;
  replanning?: boolean;
}): JSX.Element {
  const handoff = card.handoff;
  const workspaceId = useWorkspaceId();
  const [elsewhere, setElsewhere] = useState<'continue' | 'hand_back' | null>(null);
  const [savingCase, setSavingCase] = useState(false);
  // Only an agent's finished step with a completion gate can be replayed and scored (spec B2): the gate is the score.
  const canSaveCase = task?.executor === 'agent' && task.status === 'SUCCEEDED' && task.completionGate !== null;
  const parked = task?.parkedExternal ?? null;
  // "Take it back": the person changed their mind, and the agent runs the step again.
  const takeBack = useDaemonMutation((daemon, taskId: string) => daemon.unparkTask(taskId), ['tasks', 'missions', 'approvals'], missionId);
  // Offered where the daemon would take it (spec A4): an agent's step making something that can come back from
  // another tool, which nothing downstream has run on yet. The daemon still decides, and says why in the dialog.
  const canContinue = task !== undefined && parked === null && task.executor === 'agent' && !usedDownstream
    && PARKABLE_TASK_STATUSES.includes(task.status) && task.expectedOutputs.some((type) => LINKABLE_OUTPUT_TYPES.includes(type));
  // Hold sits with "Continue elsewhere" on a step in progress: offered while an agent is on it, or to reopen its terminal.
  // A running step that cannot be held right now (it is checking its work) shows Hold disabled, with why.
  const canHold = task !== undefined && card.section === 'in_progress' && task.executor === 'agent'
    && (task.holdable.ok || task.hold !== null || task.status === 'RUNNING');
  const waiting = isWaiting(card);
  // A waiting card says what it is waiting on; an older headline would describe work that is not the current state.
  // A step that is mine has nothing written yet, and "Waiting for <me>" tells me nothing; what it asks for does.
  const mineToDo = card.section === 'needs_you' && card.humanAction !== null && !handoff;
  // A rejected plan that is mine leads with why it was rejected; its handoff describes the plan nobody accepted.
  const replan = card.status === 'PLAN' && card.planDecision === 'rejected' && card.section === 'needs_you';
  const reason = waitingFor ?? card.statusReason;
  // A step that is mine never leads with its raw status reason: for a person
  // step that is "Waiting for <me>." literally, naming me back is a leak, not
  // information - the objective is what it asks for, or nothing at all.
  const lead = (waiting || replan) && reason ? reason : handoff?.headline ?? (mineToDo ? objective ?? null : card.statusReason);
  // A waiting card's output is from before the wait; its changes, like its points, are not the current state.
  const changed = waiting ? [] : card.changed.slice(0, CHANGED_SHOWN);
  const pending = card.openFeedback;
  const pointsRoom = LINES_UNDER_HEADLINE - changed.length - (pending.length > 0 ? 1 : 0);
  const points = waiting ? [] : (handoff?.points ?? []).slice(0, Math.max(0, Math.min(3, pointsRoom)));
  // A check holds nothing up, so it is asked for softly rather than as a blocker.
  const check = card.pendingApproval?.approval.kind === 'check';
  // A card for me names the open request even when the author wrote no `needs`.
  // A step that said the plan no longer fits: the line says why, since the steps after it wait on this answer.
  const planFit = card.pendingApproval !== null && card.pendingApproval !== undefined && isPlanFitCard(card.pendingApproval.approval);
  const needs = (replan ? 'A new plan. Re-plan the mission, or change its goal.' : null)
    ?? (planFit ? `The plan no longer fits: ${card.pendingApproval!.approval.rationale}` : null)
    ?? handoff?.needs
    ?? (card.pendingApproval ? card.pendingApproval.approval.title : null)
    ?? (card.humanAction === 'claim' ? 'Someone to take this step. Claim it, do it, then mark it done.' : card.humanAction === 'complete' ? 'You to do this step and mark it done.' : null);
  const links = openableLinks(handoff?.links);
  const tone = cardTone(card);

  return (
    <article className="feedcard" data-section={card.section} data-tone={tone} data-feed-card={card.key}>
      <header className="feedcard__head">
        {card.roleName ? <span className="feedcard__role">{card.roleName}</span> : null}
        <Truncate as="h3" className="feedcard__title">
          {card.title}
        </Truncate>
        <span className={`badge badge--${tone}`}>
          <span className={`dot dot--${tone}${card.status === 'RUNNING' ? ' dot--pulse' : ''}`} />
          {statusLabel(card)}
        </span>
        {card.round > 1 ? <Badge className="feedcard__round">Round {card.round}</Badge> : null}
        {/* A note about length, not a failure: neutral, and it says only what was measured. */}
        {card.overBudget ? (
          <Tooltip content="Longer than the word budget for its type">
            <Badge tabIndex={0}>Over budget</Badge>
          </Tooltip>
        ) : null}
        <span className="feedcard__time">
          {/* A later task replaced this output; saying so (and who, when known) keeps the card honest without a line of its own. */}
          {card.superseded ? <span className="feedcard__updated">{card.supersededByTaskKey ? `Updated by ${card.supersededByTaskKey}` : 'Updated'}</span> : null}
          {relativeTime(card.updatedAt)}
        </span>
      </header>

      <div className="feedcard__byline">
        <Attribution by={card.doneBy} responsible={card.responsible} recordedBy={card.recordedBy} meId={actors.meId} />
        <span className="feedcard__actions">
          {links.map((link) => (
            <HandoffLinkButton key={`${link.label}-${link.url ?? link.path}`} link={link} workspaceId={workspaceId} className="btn btn--ghost feedcard__link" />
          ))}
          {card.moreArtifacts > 0 ? <span className="feedcard__more">+{pluralize(card.moreArtifacts, 'more doc', 'more docs')}</span> : null}
          {card.artifactId ? (
            <Button variant="ghost" className="feedcard__link" onClick={() => onFullDoc(card)}>
              <Icon name="file" size={12} />
              Full doc
            </Button>
          ) : null}
          {canContinue ? (
            <Button variant="ghost" className="feedcard__link" onClick={() => setElsewhere('continue')}>
              <Icon name="externalLink" size={12} />
              Continue elsewhere
            </Button>
          ) : null}
          {canHold && task !== undefined ? <HoldButton task={task} missionId={missionId} className="btn btn--ghost feedcard__link" /> : null}
          {canSaveCase ? (
            <Button variant="ghost" className="feedcard__link" onClick={() => setSavingCase(true)}>
              <Icon name="target" size={12} />
              Save as eval case
            </Button>
          ) : null}
          {/* A review card on this card already offers Request changes as one of its answers; a second button with the same words would be two ways to say one thing. */}
          {card.canRequestChanges && card.taskId !== null && !offersRequestChanges(card) ? (
            <RequestChangesButton
              taskId={card.taskId}
              taskTitle={card.title}
              missionId={missionId}
              outputs={card.artifactId ? [{ id: card.artifactId, label: card.artifactTitle ?? card.title }] : []}
              className="btn btn--ghost feedcard__link"
            />
          ) : null}
        </span>
      </div>

      {lead ? (
        <Truncate as="p" className={`feedcard__headline${waiting ? ' feedcard__headline--waiting' : ''}`}>
          {lead}
        </Truncate>
      ) : null}

      {/* What a live agent is doing this moment, under the headline. */}
      {task?.now ? <NowLine now={task.now} /> : null}

      {parked !== null && card.taskId !== null ? (
        // The step waits on the person who took it elsewhere, whichever section the card is in: say so, with the way back.
        <div className="feedcard__needs">
          <div className="feedcard__needs-line">
            <Icon name="clock" size={13} />
            <span className="feedcard__needs-text">Waiting for your work in {parked.tool}</span>
            <Button
              variant="ghost"
              disabled={takeBack.isPending}
              onClick={() => takeBack.mutate(card.taskId!, { onSuccess: () => showFlash(`Taken back from ${parked.tool}`) })}
            >
              {takeBack.isPending ? 'Taking it back…' : 'Take it back'}
            </Button>
            <Button variant="primary" onClick={() => setElsewhere('hand_back')}>
              Hand back
            </Button>
          </div>
          {takeBack.isError ? <p className="field__error" role="alert">{describeError(takeBack.error).detail}</p> : null}
        </div>
      ) : null}

      {changed.length > 0 ? <ChangedList changed={changed} actors={actors} /> : null}

      {pending.length > 0 && card.taskId !== null ? (
        <div className="feedcard__pending">
          <Icon name="message" size={12} />
          <span className="feedcard__pending-count">{pendingLabel(pending, card.round)}</span>
          {/* The latest note, on one line: enough to recognise it, and the drawer has the thread. */}
          <Truncate className="feedcard__pending-text">{pending[pending.length - 1]!.text}</Truncate>
          {/* Only a note no round has taken waits on a person: a queued one rides the running pass, and one with a round joins it. */}
          {pending.some((note) => note.status === 'open' && note.round === null) ? (
            <StartRoundButton taskId={card.taskId} missionId={missionId} className="btn btn--ghost feedcard__link" />
          ) : null}
        </div>
      ) : null}

      {points.length > 0 ? (
        <ul className="feedcard__points">
          {points.map((point, index) => (
            <li key={index}>
              <Truncate>{point}</Truncate>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Nothing asked and no decision open (a parked step says its own line above): no empty box. */}
      {card.section === 'needs_you' && (needs || card.pendingApproval) ? (
        <div className={`feedcard__needs${check ? ' feedcard__needs--soft' : ''}`}>
          {needs ? (
            <div className="feedcard__needs-line">
              <Icon name={check ? 'eye' : 'flag'} size={13} />
              <span className="feedcard__needs-text">
                <strong>{check ? 'Check when you can' : 'Needs'}</strong> {needs}
              </span>
              {replan && onReplan ? (
                <Button variant="primary" onClick={onReplan} disabled={replanning}>
                  <Icon name="sparkle" size={13} />
                  Re-plan
                </Button>
              ) : null}
              {/* On the needs line itself: the step is one button, and a row of its own would spend a line on it. */}
              {!card.pendingApproval && card.humanAction ? (
                <Button variant="primary" onClick={() => onDoIt(card)}>
                  {card.humanAction === 'claim' ? 'Claim and do it' : 'Do it'}
                  <Icon name="chevronRight" size={13} />
                </Button>
              ) : null}
            </div>
          ) : null}
          {card.pendingApproval ? <InlineDecision key={card.pendingApproval.approval.id} view={card.pendingApproval} /> : null}
        </div>
      ) : null}
      {elsewhere === 'continue' && task !== undefined ? (
        <ContinueElsewhereDialog task={task} outputs={task.expectedOutputs} missionId={missionId} onClose={() => setElsewhere(null)} />
      ) : null}
      {savingCase && task !== undefined ? <SaveCaseDialog task={task} onClose={() => setSavingCase(false)} /> : null}
      {elsewhere === 'hand_back' && task !== undefined && parked !== null ? (
        <HandBackDialog task={task} tool={parked.tool} missionId={missionId} onClose={() => setElsewhere(null)} />
      ) : null}
    </article>
  );
}

/**
 * "What changed", one line per change, each with who asked for it. A decline is
 * marked rather than hidden: a note the round chose not to act on is exactly
 * what the person who wrote it needs to see.
 */
function ChangedList({ changed, actors }: { changed: readonly FeedChange[]; actors: Actors }): JSX.Element {
  return (
    <div className="feedcard__changed">
      <span className="feedcard__label">What changed</span>
      <ul className="feedcard__changed-list">
        {changed.map((change, index) => {
          const what = change.declined ? change.what.replace(/^Declined:\s*/i, '') : change.what;
          const authors = [...new Set(change.feedback.map((note) => actorLabel(note.author, actors.meId)).filter((name) => name !== '—'))];
          return (
            <li key={index}>
              {change.declined ? <Chip muted className="feedcard__declined">Declined</Chip> : null}
              <Truncate>{what}</Truncate>
              {authors.length > 0 ? <span className="feedcard__author">· {authors.join(', ')}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Its own component so the decision hook mounts only on cards that carry a
 * decision, keyed by the approval so a new request never inherits a half-typed note.
 */
function InlineDecision({ view }: { view: ApprovalView }): JSX.Element {
  const decision = useApprovalDecision(view);
  return <DecisionForm decision={decision} variant="inline" />;
}

/**
 * "2 notes for round 2" while a round that has started but not run carries
 * them; "1 note pending" for notes still waiting on a pass or a person.
 */
function pendingLabel(pending: FeedCard['openFeedback'], round: number): string {
  const inRound = pending.some((note) => note.status === 'in_round') && pending.every((note) => note.round === round);
  return inRound ? `${pluralize(pending.length, 'note')} for round ${round}` : `${pluralize(pending.length, 'note')} pending`;
}

function offersRequestChanges(card: FeedCard): boolean {
  return card.pendingApproval?.approval.options.some((option) => option.id === REQUEST_CHANGES_OPTION) ?? false;
}

/**
 * In flight and parked on someone else or on something, rather than working or
 * finished. A card that needs me is not "waiting" in this sense: I am the one
 * it waits on, and I need its headline to decide.
 */
function isWaiting(card: FeedCard): boolean {
  if (card.section !== 'in_progress') return false;
  return card.status === 'PLAN' || WAITING.includes(card.status);
}

const WAITING: readonly TaskStatus[] = ['READY', 'AWAITING_INPUT', 'AWAITING_HUMAN', 'AWAITING_EXTERNAL', 'AWAITING_APPROVAL', 'BLOCKED'];

function cardTone(card: FeedCard): Tone {
  if (card.status === 'PLAN') {
    // A rejection still waiting for a re-plan asks for attention; one the mission moved past is history, told plainly.
    if (card.planDecision === 'rejected') return card.section === 'done' ? 'pending' : 'blocked';
    return PLAN_TONES[card.planDecision ?? 'pending'];
  }
  return taskTone(card.status);
}

/** A plan card is coloured by its decision, so only an approved plan ever reads as a success. */
const PLAN_TONES: Readonly<Record<Exclude<PlanDecision, 'rejected'>, Tone>> = {
  pending: 'blocked',
  approved: 'succeeded',
  auto_approved: 'succeeded',
  cancelled: 'pending',
};

/**
 * Words for where the work is, from the reader's side: "In review" rather than
 * AWAITING_APPROVAL, and a person step is not "Yours" when it is someone else's.
 */
function statusLabel(card: FeedCard): string {
  if (card.status === 'PLAN') return PLAN_LABELS[card.planDecision ?? 'pending'];
  return STATUS_LABELS[card.status];
}

const PLAN_LABELS: Readonly<Record<PlanDecision, string>> = {
  pending: 'Awaiting approval',
  approved: 'Approved',
  auto_approved: 'Auto-approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  PENDING: 'Planned',
  READY: 'Queued',
  RUNNING: 'Running',
  // A live run parked on a person: a question it asked, or a tool call waiting
  // on its approval (#141). Either way it is your move, not "Running".
  AWAITING_INPUT: 'Waiting on you',
  AWAITING_HUMAN: 'Person step',
  AWAITING_EXTERNAL: 'Waiting',
  AWAITING_APPROVAL: 'In review',
  HELD: 'Held',
  BLOCKED: 'Blocked',
  SUCCEEDED: 'Done',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
};
