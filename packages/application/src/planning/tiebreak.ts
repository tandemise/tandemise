import { z } from 'zod';
import { TASK_SIZES, TASK_TYPES, type ProfileInput, type TiebreakAnswer } from '@tandemise/domain';
import { errorMessage } from '@tandemise/shared';

/**
 * The cheap classifier pass (#53 §2). It runs only when the rules can't tell,
 * on the planner role's economy model, and its answer is a set of signals
 * picked from enumerated values: it fills gaps and breaks ties, and can never
 * lower risk below the sensitivity floor. If it fails, times out or answers
 * something invalid, planning goes on with the conservative default.
 */
export const TIEBREAK_TIMEOUT_MS = 30_000;

/** Runs one prompt on one model. The application binds a runtime-backed one. */
export interface TiebreakRunnerPort {
  run(request: { readonly prompt: string; readonly model: string | null; readonly signal: AbortSignal; readonly workspaceId?: string }): Promise<{
    readonly text: string;
    readonly costUsd: number | null;
    readonly model: string | null;
  }>;
}

const answerSchema = z.object({
  type: z.enum(TASK_TYPES),
  size: z.enum(TASK_SIZES),
  areas: z.array(z.string().trim().min(1)).max(20).default([]),
  why: z.string().trim().min(1).max(400),
});

/** How much of an unusable reply the plan decision keeps, so the failure can be diagnosed. */
export const RAW_REPLY_LIMIT = 500;

/** Where the balanced `{...}` opening at `start` ends, or -1. Braces in JSON strings don't count. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The JSON objects in a reply, in order, as `{ text, value }` (`value` is
 * undefined when the balanced span isn't JSON). A brace that doesn't open a
 * readable object (prose like `{areas}`, or an unclosed `{`) is skipped and
 * the scan goes on from the next one, so prose around the answer can't hide
 * it. Text in a code fence is scanned like any other.
 */
export function jsonObjectCandidates(text: string): { readonly text: string; readonly value: unknown }[] {
  const out: { text: string; value: unknown }[] = [];
  let i = text.indexOf('{');
  while (i !== -1) {
    const end = balancedEnd(text, i);
    if (end !== -1) {
      const span = text.slice(i, end + 1);
      try {
        out.push({ text: span, value: JSON.parse(span) as unknown });
        i = text.indexOf('{', end + 1);
        continue;
      } catch {
        out.push({ text: span, value: undefined });
      }
    }
    i = text.indexOf('{', i + 1);
  }
  return out;
}

/** The first object that passes `answerSchema`, or why none did. */
function pickAnswer(text: string): { answer: z.infer<typeof answerSchema>; error: null } | { answer: null; error: string } {
  const candidates = jsonObjectCandidates(text);
  if (candidates.length === 0) return { answer: null, error: 'it did not answer with JSON' };
  let invalid: string | null = null;
  for (const { value } of candidates) {
    if (value === undefined) continue;
    const parsed = answerSchema.safeParse(value);
    if (parsed.success) return { answer: parsed.data, error: null };
    // An object that fails the schema says more than a span that won't parse.
    invalid ??= `its answer was not valid (${parsed.error.issues[0]?.message ?? 'invalid'})`;
  }
  return { answer: null, error: invalid ?? 'its JSON could not be read' };
}

export function tiebreakPrompt(input: ProfileInput, areaNames: readonly string[], repoNames: readonly string[]): string {
  return [
    'Classify one software task. Answer with only a JSON object, no prose:',
    `{"type": one of ${TASK_TYPES.map((t) => `"${t}"`).join(', ')}, "size": one of ${TASK_SIZES.map((s) => `"${s}"`).join(', ')}, "areas": [names from the list below that the task will touch], "why": "one short sentence"}`,
    '',
    'Sizes: xs is a line or two, s a small change in one place, m a few files, l a large or cross-cutting change.',
    `Areas: ${areaNames.length === 0 ? '(none)' : areaNames.join(', ')}`,
    `Repositories: ${repoNames.length === 0 ? '(one)' : repoNames.join(', ')}`,
    '',
    `Title: ${input.item.title}`,
    `Description: ${input.item.description}`,
    `Done-when lines: ${input.item.criteria}`,
  ].join('\n');
}

export async function runTiebreak(
  input: ProfileInput,
  runner: TiebreakRunnerPort,
  ctx: { readonly model: string | null; readonly areaNames: readonly string[]; readonly repoNames: readonly string[]; readonly workspaceId?: string },
): Promise<{ answer: TiebreakAnswer | null; error: string | null; costUsd: number | null; model: string | null; rawReply: string | null }> {
  try {
    const reply = await runner.run({
      prompt: tiebreakPrompt(input, ctx.areaNames, ctx.repoNames), model: ctx.model, signal: AbortSignal.timeout(TIEBREAK_TIMEOUT_MS),
      ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
    });
    const picked = pickAnswer(reply.text);
    if (picked.answer === null) {
      return { answer: null, error: picked.error, costUsd: reply.costUsd, model: reply.model, rawReply: reply.text.slice(0, RAW_REPLY_LIMIT) };
    }
    const answer = picked.answer;
    const known = new Set(ctx.areaNames.map((a) => a.toLowerCase()));
    return {
      answer: { ...answer, areas: answer.areas.filter((a) => known.has(a.toLowerCase())) },
      error: null,
      costUsd: reply.costUsd,
      model: reply.model,
      rawReply: null,
    };
  } catch (e) {
    return { answer: null, error: `it failed (${errorMessage(e)})`, costUsd: null, model: ctx.model, rawReply: null };
  }
}
