import { z } from 'zod';
import type { SetupItemView } from './setup.js';

/**
 * The brain (#51): one git repository per project for memory and the factory.
 * Shapes follow `setup.ts`.
 */

const ghName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, ., - and _.');

export const linkBrainRequest = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), owner: ghName, name: ghName }),
  z.object({ mode: z.literal('adopt'), remote: z.string().trim().min(1).max(2048) }),
  z.object({ mode: z.literal('local') }),
]);
export type LinkBrainRequest = z.infer<typeof linkBrainRequest>;

export const applyBrainRequest = z.object({
  /** The hash the adopt preview showed. */
  hash: z.string().min(1),
  choices: z.record(z.string(), z.enum(['mine', 'theirs'])).default({}),
});
export type ApplyBrainRequest = z.input<typeof applyBrainRequest>;

export const shareBrainRequest = z.object({ owner: ghName, name: ghName });
export type ShareBrainRequest = z.infer<typeof shareBrainRequest>;

export type BrainStatus = 'up_to_date' | 'offline' | 'protected' | 'local_only' | 'unlinked';

export interface BrainView {
  readonly linked: boolean;
  /** `github.com/<owner>/<name>`, or null for a brain on this machine only. */
  readonly remote: string | null;
  /** A link a person can open, when the remote is on GitHub. */
  readonly remoteUrl: string | null;
  readonly writerId: string | null;
  readonly lastPulledSha: string | null;
  readonly lastPushedSha: string | null;
  readonly lastSyncAt: string | null;
  readonly status: BrainStatus;
  /** One sentence, ready to show. */
  readonly statusLine: string;
  readonly problems: readonly string[];
  readonly counts: { readonly rules: number; readonly lessons: number; readonly candidates: number; readonly mcpsNeeded: number };
}

const scopeRequest = z.object({
  repo: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(60).optional(),
  step: z.string().trim().min(1).max(120).optional(),
  paths: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
}).strict();

/** "Remember this": a person's lesson, active at once. */
export const rememberRequest = z.object({
  text: z.string().trim().min(1).max(400),
  scope: scopeRequest.optional(),
  /** The task it was said on, for its mission's title. */
  taskId: z.string().min(1).optional(),
});
export type RememberRequest = z.infer<typeof rememberRequest>;

export const voteEntryRequest = z.object({
  vote: z.enum(['helpful', 'harmful']),
  taskId: z.string().min(1).optional(),
});
export type VoteEntryRequest = z.infer<typeof voteEntryRequest>;

export const retireEntryRequest = z.object({ reason: z.string().trim().max(400).default('Retired by you.') });
export type RetireEntryRequest = z.input<typeof retireEntryRequest>;

export const brainEntriesQuery = z.object({
  scope: z.string().optional(),
  state: z.enum(['active', 'candidate', 'accepted', 'rejected']).optional(),
  history: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

/** One lesson, convention or history line, as the Brain screen shows it. */
export interface BrainEntryView {
  readonly id: string;
  readonly kind: 'lesson' | 'convention' | 'history';
  readonly text: string;
  readonly scope: { readonly repo?: string; readonly role?: string; readonly step?: string; readonly paths?: readonly string[] };
  readonly state: 'active' | 'candidate' | 'accepted' | 'rejected';
  readonly helpful: number;
  readonly harmful: number;
  readonly net: number;
  readonly addedAt: string;
  readonly lastConfirmedAt: string;
  readonly missions: readonly string[];
  readonly invalidAt: string | null;
  readonly supersededBy: string | null;
  readonly retired: { readonly at: string; readonly reason: string } | null;
  readonly promoted: { readonly target: string; readonly pr: string | null } | null;
  readonly flags: { readonly harmful: boolean; readonly stale: boolean };
  /** "Developer · acme · step build", or "Whole project". */
  readonly scopeLabel: string;
  /** "your hold", "a change you asked for", "a failed check", "you", "an agent", "a mission". */
  readonly sourceLabel: string;
  readonly sourceMission: string;
  /** The run it came from, when that run is on this machine. */
  readonly runLink: { readonly missionId: string; readonly taskId: string; readonly runId: string } | null;
  /** Computed here from runs.brain and run scores; never stored in the ledger (spec §7). */
  readonly loadedIn: { readonly runs: number; readonly passedFirstTime: number };
  /** "Loaded in 14 runs, 11 passed first time", "Not confirmed since …", "Harmful more often than helpful". */
  readonly notes: readonly string[];
}

export interface RememberView {
  readonly entry: BrainEntryView;
  readonly message: string;
}

/** What adopting an existing brain would change here, before anything is linked. */
export interface BrainAdoptPreview {
  readonly hash: string;
  readonly items: readonly SetupItemView[];
  readonly brain: { readonly rules: number; readonly lessons: number; readonly mcpsNeeded: readonly string[] };
}

/** "What it knew" for one run (#51 spec §11). */
export interface RunBrainView {
  readonly sha: string;
  readonly shortSha: string;
  /** A link to the commit on GitHub, when the brain is there. */
  readonly commitUrl: string | null;
  readonly rules: readonly string[];
  readonly loaded: readonly BrainEntryView[];
  readonly fetched: readonly BrainEntryView[];
  readonly proposed: readonly BrainEntryView[];
  /** "Loaded 3 rules files and 5 lessons; read 1 more." */
  readonly summary: string;
}

export const promoteEntryRequest = z.object({
  /** `role`: into the role's instructions (factory/roles/<id>.md) instead of its rules file. */
  target: z.enum(['rules', 'role']).optional(),
});
export type PromoteEntryRequest = z.infer<typeof promoteEntryRequest>;

/** A promotion as the Proposals tab shows it. */
export interface BrainProposalView {
  readonly id: string;
  readonly lessons: readonly { readonly id: string; readonly text: string }[];
  readonly targets: readonly string[];
  readonly classification: 'small' | 'structural';
  /** "Small: only adds lines…", "Structural: …". */
  readonly classificationLine: string;
  readonly reasons: readonly string[];
  readonly state: 'evaluating' | 'open' | 'draft' | 'applied' | 'merged' | 'closed' | 'accepted' | 'declined' | 'reverted';
  readonly stateLabel: string;
  readonly verdict: 'passed' | 'failed' | 'not_evaluated' | null;
  readonly verdictLine: string;
  readonly prUrl: string | null;
  /** Only a brain on this machine accepts or declines in the app. */
  readonly canAccept: boolean;
  readonly canRevert: boolean;
  readonly updatedAt: string;
}

/** The Brain screen's Factory tab (#51 spec §11). */
export interface BrainFactoryView {
  /** The brain's factory files at the last pull. */
  readonly files: readonly string[];
  /** Integrations the project needs that this machine has not connected. */
  readonly mcpsNeeded: readonly { readonly name: string; readonly detail: string }[];
  /** Pinned skills whose files this machine doesn't have. */
  readonly skillsMissing: readonly string[];
  /** Code-repository workflows a brain workflow of the same id hides. */
  readonly shadowed: readonly { readonly id: string; readonly path: string }[];
  /** Code-repository workflows the brain doesn't have yet, which can move in. */
  readonly movable: readonly { readonly id: string; readonly path: string }[];
}

export const moveWorkflowRequest = z.object({ id: z.string().trim().min(1).max(200) });
