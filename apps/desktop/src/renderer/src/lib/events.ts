import type { RunEventRecord, TandemiseEventBody } from '@tandemise/domain';
import { REQUEST_CHANGES_OPTION, isSemanticEvent } from './domain.js';
import type { IconName } from '../components/Icon.js';
import { humanizeStatus, pluralize, titleCase, type Tone } from './format.js';

export interface TimelineItem {
  readonly key: string;
  readonly icon: IconName;
  readonly tone: Tone;
  /** The one-line status-report phrasing (MVP.md §23.3). */
  readonly title: string;
  readonly detail: string | null;
  readonly role: string | null;
  /** The member who did it, when the event names one; the renderer resolves the name. */
  readonly actorId: string | null;
  readonly at: string;
  readonly sequence: number;
  /** Set when the entry links somewhere - an artifact, an approval. */
  readonly link: { readonly kind: 'artifact' | 'approval'; readonly id: string } | null;
}

/**
 * Turns the raw event log into the semantic feed (MVP.md §23.3).
 *
 * Two things happen here that are easy to get wrong. First, `raw` and tool
 * chatter are dropped: the default surface must read like a status report, not
 * a terminal. Second, runs of `file.changed` events collapse into one line -
 * "Developer changed 8 files" is the sentence the spec asks for, and emitting
 * eight lines instead would bury every other event in the mission.
 */
export function buildTimeline(
  records: readonly RunEventRecord[],
  roleNames: ReadonlyMap<string, string>,
  /** Who an actor id is, for lines that lead with the person ("You asked for changes"); without it the role stands in. */
  actorName?: (id: string) => string,
): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  let index = 0;

  while (index < records.length) {
    const record = records[index];
    if (!record) break;
    if (!isSemanticEvent(record.body)) {
      index += 1;
      continue;
    }

    if (record.body.type === 'file.changed') {
      let end = index;
      const paths: string[] = [];
      while (end < records.length) {
        const candidate = records[end];
        if (!candidate || candidate.body.type !== 'file.changed' || candidate.runId !== record.runId) break;
        paths.push(candidate.body.path);
        end += 1;
      }
      const last = records[end - 1] ?? record;
      items.push({
        key: `${record.id}-files`,
        icon: 'filePlus',
        tone: 'running',
        title: `${roleLabel(record.roleId, roleNames)} changed ${pluralize(paths.length, 'file')}`,
        detail: paths.slice(0, 6).join(', ') + (paths.length > 6 ? `, +${paths.length - 6} more` : ''),
        role: roleLabel(record.roleId, roleNames),
        actorId: record.actorId ?? null,
        at: last.createdAt,
        sequence: last.sequence,
        link: null,
      });
      index = end;
      continue;
    }

    items.push(describe(record, roleNames, actorName));
    index += 1;
  }

  return items;
}

function describe(record: RunEventRecord, roleNames: ReadonlyMap<string, string>, actorName?: (id: string) => string): TimelineItem {
  const role = roleLabel(record.roleId, roleNames);
  const actor = record.actorId && actorName ? actorName(record.actorId) : null;
  const base = { key: record.id, role, actorId: record.actorId ?? null, at: record.createdAt, sequence: record.sequence } as const;
  const body = record.body;

  switch (body.type) {
    case 'message':
      return { ...base, icon: 'message', tone: 'pending', title: `${role} reported`, detail: body.text, link: null };
    case 'thinking_summary':
      return { ...base, icon: 'sparkle', tone: 'pending', title: `${role} is thinking`, detail: body.text, link: null };
    case 'tool.started':
      return {
        ...base,
        icon: 'wrench',
        tone: 'running',
        title: `${role} used ${titleCase(body.tool)}`,
        detail: body.inputSummary || null,
        link: null,
      };
    case 'tool.completed':
      return {
        ...base,
        icon: body.outcome === 'ok' ? 'check' : 'alertCircle',
        tone: body.outcome === 'ok' ? 'succeeded' : 'failed',
        title: `${titleCase(body.tool)} ${body.outcome === 'ok' ? 'finished' : 'failed'}`,
        detail: body.outputSummary ?? null,
        link: null,
      };
    case 'file.changed':
      return { ...base, icon: 'filePlus', tone: 'running', title: `${role} ${body.change === 'delete' ? 'deleted' : 'changed'} ${body.path}`, detail: null, link: null };
    case 'artifact.created':
      return {
        ...base,
        icon: 'file',
        tone: 'succeeded',
        title: `${role} produced an artifact`,
        detail: null,
        link: { kind: 'artifact', id: body.artifactId },
      };
    case 'approval.requested':
      return {
        ...base,
        icon: 'shield',
        tone: 'blocked',
        title: 'Waiting for your approval',
        detail: 'The mission is paused until you decide.',
        link: { kind: 'approval', id: body.approvalId },
      };
    case 'usage':
      return { ...base, icon: 'gauge', tone: 'pending', title: 'Usage reported', detail: usageDetail(body), link: null };
    case 'checkpoint':
      return { ...base, icon: 'target', tone: 'pending', title: body.label ?? 'Checkpoint saved', detail: null, link: null };
    case 'completed':
      return { ...base, icon: 'check', tone: 'succeeded', title: `${role} finished`, detail: body.summary ?? null, link: null };
    case 'failed':
      // A run stopped on purpose (a park, a cancel, a redo) ends as CANCELLED; calling that a failure would be false.
      if (body.code === 'CANCELLED') return { ...base, icon: 'stop', tone: 'pending', title: `${role} stopped`, detail: body.message, link: null };
      return { ...base, icon: 'alertCircle', tone: 'failed', title: `${role} failed`, detail: `${body.code}: ${body.message}`, link: null };
    case 'raw':
      return { ...base, icon: 'terminal', tone: 'pending', title: body.channel, detail: body.text, link: null };

    case 'mission.status':
      return {
        ...base,
        icon: 'flag',
        tone: 'running',
        title: `Mission moved to ${humanizeStatus(body.to)}`,
        detail: body.reason ?? null,
        link: null,
      };
    case 'task.status':
      return {
        ...base,
        icon: 'layers',
        tone: 'pending',
        title: `${role} task is now ${humanizeStatus(body.to)}`,
        detail: body.reason ?? null,
        link: null,
      };
    case 'run.started':
      return {
        ...base,
        icon: 'play',
        tone: 'running',
        title: `${role} started${body.attempt > 1 ? ` (attempt ${body.attempt})` : ''}`,
        detail: `${body.runtime} on ${body.target}`,
        link: null,
      };
    case 'run.finished':
      return {
        ...base,
        icon: body.status === 'SUCCEEDED' ? 'check' : 'stop',
        tone: body.status === 'SUCCEEDED' ? 'succeeded' : body.status === 'FAILED' ? 'failed' : 'pending',
        title: `${role} run ${body.status.toLowerCase()}`,
        detail: `Took ${Math.round(body.durationMs / 1000)}s`,
        link: null,
      };
    case 'check.result':
      return {
        ...base,
        icon: body.outcome === 'PASS' ? 'check' : body.outcome === 'FAIL' ? 'x' : 'info',
        tone: body.outcome === 'PASS' ? 'succeeded' : body.outcome === 'FAIL' ? 'failed' : 'pending',
        title: `${titleCase(body.name.replace(/^checks\./, ''))} ${body.outcome === 'PASS' ? 'passed' : body.outcome === 'FAIL' ? 'failed' : body.outcome === 'TIMEOUT' ? 'ran out of time' : 'skipped'}`,
        detail: body.detail ?? null,
        link: null,
      };
    case 'gate.evaluated':
      return {
        ...base,
        icon: body.passed ? 'shield' : 'alert',
        tone: body.passed ? 'succeeded' : 'blocked',
        title: body.passed ? 'Quality gate passed' : 'Quality gate blocked the task',
        detail: body.detail ?? body.gate,
        link: null,
      };
    case 'approval.resolved':
      // Stored as a rejection, but the work goes back as the next round: a red "rejected" would read as the end of it.
      if (body.option === REQUEST_CHANGES_OPTION) {
        return { ...base, icon: 'message', tone: 'running', title: 'Changes requested', detail: null, link: { kind: 'approval', id: body.approvalId } };
      }
      return {
        ...base,
        icon: body.status === 'APPROVED' ? 'check' : 'x',
        tone: body.status === 'APPROVED' ? 'succeeded' : 'failed',
        title: `Approval ${body.status.toLowerCase()}`,
        // Whoever decided is named on the row; "You chose" would be wrong for a teammate's decision.
        detail: body.option ? `Chose "${humanizeStatus(body.option)}".` : null,
        link: { kind: 'approval', id: body.approvalId },
      };
    case 'policy.denied':
      return {
        ...base,
        icon: 'shield',
        tone: 'blocked',
        title: `Policy denied ${body.capability}`,
        detail: body.reason,
        link: null,
      };
    case 'approval.escalated':
      return {
        ...base,
        icon: 'alert',
        tone: 'blocked',
        title: 'An unanswered approval was escalated',
        detail: `Now also waiting on the next person up (level ${body.level}).`,
        link: { kind: 'approval', id: body.approvalId },
      };
    case 'review.skipped':
      return {
        ...base,
        icon: 'info',
        tone: 'pending',
        title: body.when === 'sign-off' ? 'The lead\'s sign-off was not needed' : 'A review was not needed',
        detail: body.reason
          ? 'The person who did the work was the only one who could review it.'
          : `Its condition did not hold: ${body.when}`,
        link: null,
      };
    case 'review.required':
      return {
        ...base,
        icon: 'shield',
        tone: 'pending',
        title: 'A review was kept',
        detail: `Its condition reads what was not measured (${body.missingFacts.join(', ')}), so it applies: ${body.when}`,
        link: null,
      };
    case 'artifact.tighten_requested':
      return {
        ...base,
        icon: 'file',
        tone: 'running',
        title: `${role} was asked to tighten ${body.types.join(', ')}`,
        detail: 'The first draft ran over its length budget. This is one editing pass, not a failure.',
        link: null,
      };
    case 'artifact.over_budget':
      return {
        ...base,
        icon: 'info',
        tone: 'pending',
        title: `${body.artifactType} was accepted over its length budget`,
        detail: `${body.words} words in the main body; the budget is ${body.budget}.`,
        link: { kind: 'artifact', id: body.artifactId },
      };
    case 'task.attention':
      // Kept on an older version is a fact to know, not a request: nobody asked this work for changes.
      if (body.kind === 'stale_input') {
        return {
          ...base,
          icon: 'info',
          tone: 'pending',
          title: `Built on an older version of ${body.upstream ?? 'its input'}`,
          detail: body.note || null,
          link: null,
        };
      }
      return {
        ...base,
        icon: 'alert',
        tone: 'blocked',
        title: `${role}'s work needs changes`,
        detail: body.note || null,
        link: null,
      };
    case 'mission.pulled':
      return {
        ...base,
        icon: 'flag',
        tone: 'running',
        title: `Pulled from the backlog (${body.active} of ${body.limit})`,
        detail: pulledDetail(body),
        link: null,
      };
    // The factory (#53): the lane it chose, the pull request it opened, and what the merge decision said.
    case 'plan.decided':
      return { ...base, icon: 'sparkle', tone: 'pending', title: `The factory chose the ${body.lane} lane`, detail: null, link: null };
    case 'ship.pr_opened':
      // A pull request a step opened, found by the mission's CI wait (#143), is found, not opened.
      return { ...base, icon: 'externalLink', tone: 'succeeded', title: `Pull request #${body.number} ${body.foundBy === 'wait' ? 'found' : 'opened'}`, detail: body.url, link: null };
    case 'task.outcome':
      return { ...base, icon: 'info', tone: 'pending', title: 'Outcome recorded', detail: null, link: null };
    case 'merge.decided':
      return { ...base, icon: 'shield', tone: 'pending', title: body.verdict === 'merge' ? 'Decided to merge on its own' : 'Decided to ask for your review', detail: null, link: null };
    case 'merge.merged':
      // #174: who had it merged. A merge on your Merge is Tandemise's; only one it didn't run is "in GitHub".
      return {
        ...base, icon: 'check', tone: 'succeeded',
        title: body.how === 'auto' ? 'Merged on its own' : body.how === 'approval' ? 'Merged on your approval' : body.how === 'github' ? `Merged in GitHub by ${body.by}` : 'Merged',
        detail: null, link: null,
      };
    case 'merge.asked':
      return { ...base, icon: 'approvals', tone: 'blocked', title: 'Asked for your review', detail: body.reasons.join(' ') || null, link: null };
    case 'merge.reverted':
      return { ...base, icon: 'refresh', tone: 'blocked', title: 'Reverted', detail: body.revertPr, link: null };
    case 'note':
      return {
        ...base,
        icon: body.level === 'error' ? 'alertCircle' : body.level === 'warn' ? 'alert' : 'info',
        tone: body.level === 'error' ? 'failed' : body.level === 'warn' ? 'blocked' : 'pending',
        title: body.text,
        detail: null,
        link: null,
      };
    case 'feedback.given':
      return {
        ...base,
        icon: 'message',
        tone: 'pending',
        // "Someone" and "—" say nothing a row's actor chip does not; the sentence then stands without a name.
        title: actor !== null && actor !== '—' && actor !== 'Someone' ? `${actor} asked for changes` : 'Changes were asked for',
        detail: body.excerpt,
        link: null,
      };
    case 'feedback.addressed':
      return {
        ...base,
        icon: body.declined ? 'x' : 'check',
        tone: body.declined ? 'blocked' : 'succeeded',
        title: body.declined ? `Round ${body.round} declined a note` : `Round ${body.round} answered a note`,
        detail: null,
        link: null,
      };
    case 'feedback.dismissed':
      return { ...base, icon: 'x', tone: 'pending', title: 'A note was dismissed', detail: null, link: null };
    case 'task.round_started':
      return {
        ...base,
        icon: 'flag',
        tone: 'running',
        title: `Round ${body.round} started`,
        // Who asked comes from the event's actor ("You"), never from the task's reason line; keys, as the plan names tasks.
        detail: [
          actor !== null && actor !== '—' && actor !== 'Someone' ? `Asked by ${actor}` : null,
          body.redone.length > 0 ? `Redone: ${body.redone.join(', ')}` : null,
        ].filter((part): part is string => part !== null).join(' · ') || null,
        link: null,
      };
    case 'task.parked_external':
      return { ...base, icon: 'externalLink', tone: 'pending', title: `Continued in ${body.tool}`, detail: null, link: null };
    case 'task.unparked':
      return { ...base, icon: 'refresh', tone: 'running', title: `Taken back from ${body.tool}`, detail: null, link: null };
    case 'task.held':
      return { ...base, icon: 'play', tone: 'blocked', title: actor ? `${actor} took the keyboard` : 'A person took the keyboard', detail: null, link: null };
    case 'task.hold_ended':
      return {
        ...base, icon: 'check', tone: 'running',
        title: body.ending === 'continued' ? 'Hold ended; the agent continues' : 'Hold released',
        // Holding stopped the agent's run, and with it any command it had left running in the background (#102).
        detail: 'Commands the agent had left running in the background were stopped by the hold.', link: null,
      };
    case 'task.handed_back':
      return {
        ...base,
        icon: 'check',
        tone: 'succeeded',
        title: `Handed back (round ${body.round})`,
        detail: body.contribution === 'file' ? 'From a file' : 'From a link',
        link: body.artifactIds[0] ? { kind: 'artifact', id: body.artifactIds[0] } : null,
      };
    case 'brain.learned':
      // #51: a person's correction had an effect. Not a notification, one line on the feed.
      return { ...base, icon: 'book', tone: 'succeeded', title: `Learned: '${body.text}' (from ${signalWords(body.signal)})`, detail: null, link: null };
    case 'mission.intake_completed':
      return {
        ...base,
        icon: 'file',
        tone: 'pending',
        title: `Read ${pluralize(body.uploads, 'upload')}`,
        detail: body.failed.length > 0 ? `${body.produced.length} converted, ${body.failed.length} could not be read` : null,
        link: null,
      };
  }
}

/** Mirrors `pulledDetail` in `@tandemise/domain`: how far down the queue it was, and why the ones ahead waited. */
function pulledDetail(body: Extract<TandemiseEventBody, { type: 'mission.pulled' }>): string {
  const place = body.position === 1 ? 'It was first in the queue' : `It was number ${body.position} in the queue`;
  const skipped = body.skipped ?? 0;
  const ahead = skipped === 0 ? '' : `; ${skipped === 1 ? '1 mission' : `${skipped} missions`} ahead of it ${skipped === 1 ? 'is' : 'are'} not ready to plan yet`;
  return `${place}${ahead}. This project works on at most ${body.limit} ${body.limit === 1 ? 'mission' : 'missions'} at a time.`;
}

function usageDetail(body: Extract<TandemiseEventBody, { type: 'usage' }>): string {
  const parts: string[] = [];
  if (body.inputTokens !== undefined) parts.push(`${body.inputTokens.toLocaleString()} in`);
  if (body.outputTokens !== undefined) parts.push(`${body.outputTokens.toLocaleString()} out`);
  return parts.length > 0 ? `${parts.join(' / ')} tokens` : 'No token counts reported';
}

function roleLabel(roleId: string | null, roleNames: ReadonlyMap<string, string>): string {
  if (!roleId) return 'Tandemise';
  return roleNames.get(roleId) ?? titleCase(roleId);
}

/** The raw log view: every event, unedited, newest last (MVP.md §23.3). */
export function rawLines(records: readonly RunEventRecord[]): readonly { seq: number; text: string }[] {
  return records.map((record) => ({ seq: record.sequence, text: rawText(record.body) }));
}

function rawText(body: TandemiseEventBody): string {
  if (body.type === 'raw') return `[${body.channel}] ${body.text}`;
  const { type, ...rest } = body as { type: string } & Record<string, unknown>;
  return `${type} ${JSON.stringify(rest)}`;
}

/** Where a lesson came from, in the feed's words. */
function signalWords(signal: 'hold' | 'rejection' | 'gate' | 'person' | 'agent'): string {
  switch (signal) {
    case 'hold': return 'your hold';
    case 'rejection': return 'the changes you asked for';
    case 'gate': return 'a failed check';
    case 'person': return 'you';
    case 'agent': return 'an agent';
  }
}
