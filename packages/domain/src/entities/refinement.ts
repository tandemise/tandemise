import type { ArtifactId, MissionId, QuestionId, Timestamp } from '@tandemise/shared';
import { evaluateGate, type GateFacts, type GateOutcome } from '../gate.js';

/**
 * Ready before planning (P6).
 *
 * A rough request is refined into criteria the person accepted and questions
 * the person answered, and a DRAFT mission is not planned until that is done.
 * Whether it is done is a gate over three counts the daemon measures - never
 * something the refining agent says.
 */

/** What one refinement pass may put in front of a person: few enough to decide in one sitting. */
export const REFINEMENT_LIMITS = {
  criteria: 8,
  questions: 5,
  options: 4,
  /** A criterion is a sentence someone can check, not a paragraph. */
  statement: 400,
  question: 300,
  why: 300,
  option: 120,
  answer: 2000,
} as const;

export const QUESTION_STATUSES = ['open', 'answered', 'stale'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** A question a refinement pass asked, and the person's answer. */
export interface MissionQuestion {
  readonly id: QuestionId;
  readonly missionId: MissionId;
  /** `Q1…`, numbered across the mission and never reused. */
  readonly key: string;
  readonly text: string;
  /** What changes depending on the answer; empty when the agent did not say. */
  readonly why: string;
  /** One-click answers; the person may still write their own. */
  readonly options: readonly string[];
  readonly status: QuestionStatus;
  readonly answer: string | null;
  readonly answeredBy: string | null;
  readonly refinementArtifactId: ArtifactId | null;
  readonly position: number;
  readonly createdAt: Timestamp;
  readonly answeredAt: Timestamp | null;
}

/** A question as a refinement pass wrote it, before it is on record. */
export interface QuestionInput {
  readonly text: string;
  readonly why: string;
  readonly options: readonly string[];
}

/** `P1` for the first proposal a mission ever received. */
export function proposalKey(index: number): string {
  return `P${index + 1}`;
}

/** `Q1` for the first question a mission was ever asked. */
export function questionKey(index: number): string {
  return `Q${index + 1}`;
}

// ------------------------------------------------------------------ readiness

/**
 * The Definition of Ready, as a gate expression over measured counts. It is
 * data for the same reason every gate is: a refused plan can say exactly
 * which condition failed, in the gate language's own words.
 */
export const READY_TO_PLAN_GATE = 'ready.criteria >= 1 && ready.open_questions == 0 && ready.proposed_pending == 0';

export interface ReadinessCounts {
  /** Accepted Done-when criteria: the person's lines, hand-added ones and accepted proposals. */
  readonly criteria: number;
  /** Questions not yet answered. */
  readonly openQuestions: number;
  /** Proposed criteria not yet accepted or rejected. */
  readonly proposedPending: number;
}

export interface Readiness extends ReadinessCounts {
  readonly ready: boolean;
  /** What the Plan button says: "Plan", or what is left to do before it can. */
  readonly label: string;
  /** The gate's own explanation when it fails; "All gate conditions met." when it passes. */
  readonly detail: string;
  readonly outcome: GateOutcome;
}

export function readinessFacts(counts: ReadinessCounts): GateFacts {
  return {
    'ready.criteria': counts.criteria,
    'ready.open_questions': counts.openQuestions,
    'ready.proposed_pending': counts.proposedPending,
  };
}

export function evaluateReadiness(counts: ReadinessCounts): Readiness {
  const outcome = evaluateGate(READY_TO_PLAN_GATE, readinessFacts(counts));
  return { ...counts, ready: outcome.passed, label: outcome.passed ? 'Plan' : `${todo(counts)} to plan`, detail: outcome.detail, outcome };
}

/**
 * The sentence a refused plan answers with: what to do, then the gate's words.
 * "Not ready to plan: answer 1 question and decide 3 criteria first. (Not met: …)"
 */
export function notReadyMessage(readiness: Readiness): string {
  const what = todo(readiness);
  return `Not ready to plan: ${what.charAt(0).toLowerCase()}${what.slice(1)} first. (${readiness.detail})`;
}

/** What is left before a refined draft can be marked ready (#135): "Answer 1 question and decide 3 criteria". */
export function readinessTodo(counts: ReadinessCounts): string {
  return todo(counts);
}

/** What is left, in the order a person would do it: answer, decide, then add. */
function todo(counts: ReadinessCounts): string {
  const parts: string[] = [];
  if (counts.openQuestions > 0) parts.push(`answer ${counts.openQuestions} ${counts.openQuestions === 1 ? 'question' : 'questions'}`);
  if (counts.proposedPending > 0) parts.push(`decide ${counts.proposedPending} ${counts.proposedPending === 1 ? 'criterion' : 'criteria'}`);
  // Deciding pending proposals may well produce the first criterion, so this is asked only when nothing else is left.
  if (parts.length === 0 && counts.criteria < 1) parts.push('add at least one Done-when criterion');
  const sentence = parts.join(' and ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
