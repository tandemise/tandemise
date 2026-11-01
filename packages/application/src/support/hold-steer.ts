import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskHold } from '@tandemise/domain';

/** The file in a hold's directory where its session appends what the person typed (#117). */
export const HOLD_PROMPTS_FILE = 'person-said.jsonl';

export interface PersonSaid {
  readonly at: string;
  readonly text: string;
}

/** Longest single message quoted back; a pasted log is cut, not dropped. */
const MESSAGE_LIMIT = 1500;
/** At most this many messages per hold, newest kept. */
const MESSAGES_PER_HOLD = 12;

/**
 * What the person typed during a hold, oldest first. A missing or unreadable
 * file is "nothing recorded": a hold from before this existed, or a runtime
 * that cannot report it, quotes nothing rather than failing the attempt.
 */
export function readPersonSaid(hold: Pick<TaskHold, 'dir'>): readonly PersonSaid[] {
  let raw: string;
  try {
    raw = readFileSync(join(hold.dir, HOLD_PROMPTS_FILE), 'utf8');
  } catch {
    return [];
  }
  const said: PersonSaid[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { at?: unknown; prompt?: unknown };
      if (typeof parsed.prompt !== 'string' || parsed.prompt.trim().length === 0) continue;
      const text = parsed.prompt.trim();
      said.push({
        at: typeof parsed.at === 'string' ? parsed.at : '',
        text: text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text,
      });
    } catch {
      // A torn last line (the session was killed mid-write) is skipped.
    }
  }
  return said.slice(-MESSAGES_PER_HOLD);
}

/**
 * The prompt section that carries what people said during holds into every
 * later attempt (#117). A retry starts from the task prompt, not the held
 * session; without this it re-read the tracker's wording, decided the person's
 * correction contradicted it, and reverted it. What a person said directly is
 * newer and more specific than the tracker text, so it is stated as binding.
 */
export function personSaidSection(holds: readonly { readonly hold: Pick<TaskHold, 'startedAt'>; readonly said: readonly PersonSaid[] }[]): string | null {
  const withWords = holds.filter((h) => h.said.length > 0);
  if (withWords.length === 0) return null;
  const quoted = withWords.flatMap(({ hold, said }) => [
    `During a hold that started at ${hold.startedAt}, a person worked with this step directly and said:`,
    ...said.map((s) => `> ${s.text.replaceAll('\n', '\n> ')}`),
  ]);
  return [
    'What a person told this step directly (binding):',
    ...quoted,
    'These are instructions from the person who owns this work. Where they differ from the task, the issue or the '
      + 'Done-when lines, what the person said wins: keep every change they asked for, and never undo or "correct" it '
      + 'back to the original wording. Their changes are already committed on this branch.',
  ].join('\n');
}
