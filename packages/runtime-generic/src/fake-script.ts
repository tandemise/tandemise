import { Err, Ok, TandemiseError } from '@tandemise/shared';
import type { Result } from '@tandemise/shared';

/**
 * The scripted behaviours a fake run can exhibit (MVP.md §28.2).
 *
 * Deliberately small: this exists so the scheduler, gates, retries and the
 * timeline can be exercised end to end without a model, not so that it can
 * impersonate one. Every step is a direct statement about what the run should
 * look like, which is what makes a failing test readable.
 */
/**
 * A condition on the run a step belongs to. Steps without one always run.
 *
 * It exists so one script can stand in for an agent that answers a follow-up
 * differently from its first request - a tighten pass, say - without a check
 * having to swap profiles between two runs of the same task.
 */
export interface FakeStepCondition {
  /** The step runs only when the run's prompt contains this text, case-sensitively. */
  readonly promptIncludes?: string;
}

export type FakeStep = (
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly input?: string; readonly outcome?: 'ok' | 'error' }
  /**
   * Calls a tool for real, through the run's MCP config: the same broker,
   * policy gate and approval a worker's call goes through. Only the event is
   * scripted for `tool`; this one can be refused, wait on a person, or die
   * with the run.
   */
  | { readonly kind: 'call'; readonly tool: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly kind: 'write-file'; readonly path: string; readonly content: string }
  | { readonly kind: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number | null }
  | { readonly kind: 'checkpoint'; readonly sessionId?: string; readonly label?: string }
  /** Drives the fallback path in MVP.md §9.5 without waiting for a real quota. */
  | { readonly kind: 'rate-limit'; readonly detail?: string }
  | { readonly kind: 'delay'; readonly ms: number }
  | { readonly kind: 'complete'; readonly summary?: string }
  | { readonly kind: 'fail'; readonly code: string; readonly message: string; readonly retryable?: boolean }
) & { readonly when?: FakeStepCondition };

export interface FakeScript {
  readonly steps: readonly FakeStep[];
  /**
   * How the fake answers a resume.
   *
   * `'missing'` makes it behave like a runtime that has forgotten the session -
   * the one condition a caller cannot discover by inspection, only by asking.
   * It belongs here rather than in `steps` because it is a property of the
   * runtime's memory, not of the work the run performs.
   */
  readonly resume: 'ok' | 'missing';
  /**
   * Named values read out of the prompt: name to a regex source, applied with
   * flags `gm`; `{{name}}` expands to every match's first group, joined with
   * `, `. It lets a script answer with ids the engine minted during the run,
   * such as the feedback ids a round asks it to cite, which no script can know
   * when it is written.
   */
  readonly captures?: Readonly<Record<string, string>>;
}

const STEP_KINDS = new Set([
  'message', 'thinking', 'tool', 'call', 'write-file', 'usage', 'checkpoint', 'rate-limit', 'delay', 'complete', 'fail',
]);

/**
 * The behaviour a profile gets when it says nothing: talk, touch the
 * filesystem, report usage, finish. It produces one of every event a mission
 * timeline needs to render, and writes a real file so artifact collection has
 * something true to collect.
 */
export const DEFAULT_FAKE_SCRIPT: FakeScript = {
  resume: 'ok',
  steps: [
    { kind: 'checkpoint', sessionId: 'fake-session-{{runId}}', label: 'session.init' },
    { kind: 'message', text: 'Fake runtime received: {{prompt}}' },
    { kind: 'thinking', text: 'Deciding how to satisfy the request in {{cwd}}.' },
    {
      kind: 'write-file',
      path: 'tandemise-fake-artifact.md',
      content: '# Fake runtime artifact\n\nRun: {{runId}}\n\n## Request\n\n{{prompt}}\n',
    },
    { kind: 'usage', inputTokens: 1200, outputTokens: 340, costUsd: null },
    { kind: 'complete', summary: 'Fake runtime wrote tandemise-fake-artifact.md' },
  ],
};

export function parseFakeScript(value: unknown): Result<FakeScript, TandemiseError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Err(TandemiseError.validation('Fake script must be an object with a `steps` array'));
  }
  const steps = (value as Record<string, unknown>)['steps'];
  if (!Array.isArray(steps)) {
    return Err(TandemiseError.validation('Fake script must have a `steps` array'));
  }
  const resume = (value as Record<string, unknown>)['resume'] ?? 'ok';
  if (resume !== 'ok' && resume !== 'missing') {
    return Err(TandemiseError.validation("Fake script `resume` must be 'ok' or 'missing'"));
  }
  const captures = parseCaptures((value as Record<string, unknown>)['captures']);
  if (!captures.ok) return captures;
  const parsed: FakeStep[] = [];
  for (const [index, raw] of steps.entries()) {
    const step = parseStep(raw, index);
    if (!step.ok) return step;
    parsed.push(step.value);
  }
  return Ok({ steps: parsed, resume, ...(captures.value === undefined ? {} : { captures: captures.value }) });
}

function parseCaptures(raw: unknown): Result<Readonly<Record<string, string>> | undefined, TandemiseError> {
  if (raw === undefined) return Ok(undefined);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Err(TandemiseError.validation('Fake script `captures` must be an object of name to regex source'));
  }
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof source !== 'string') {
      return Err(TandemiseError.validation(`Fake script capture '${name}' must be a regex source string`));
    }
    try {
      new RegExp(source, 'gm');
    } catch (e) {
      return Err(TandemiseError.validation(`Fake script capture '${name}' is not a valid regex: ${(e as Error).message}`));
    }
    out[name] = source;
  }
  return Ok(out);
}

function parseStep(raw: unknown, index: number): Result<FakeStep, TandemiseError> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Err(TandemiseError.validation(`Fake script step ${index} must be an object`));
  }
  const when = parseCondition((raw as Record<string, unknown>)['when'], index);
  if (!when.ok) return when;
  const step = parseStepBody(raw as Record<string, unknown>, index);
  if (!step.ok || when.value === undefined) return step;
  return Ok({ ...step.value, when: when.value });
}

function parseCondition(raw: unknown, index: number): Result<FakeStepCondition | undefined, TandemiseError> {
  if (raw === undefined) return Ok(undefined);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Err(TandemiseError.validation(`Fake script step ${index} \`when\` must be an object`));
  }
  const includes = (raw as Record<string, unknown>)['promptIncludes'];
  if (includes !== undefined && typeof includes !== 'string') {
    return Err(TandemiseError.validation(`Fake script step ${index} \`when.promptIncludes\` must be a string`));
  }
  return Ok(includes === undefined ? {} : { promptIncludes: includes });
}

/** Whether a step applies to a run with this prompt. */
export function stepApplies(step: FakeStep, prompt: string): boolean {
  const includes = step.when?.promptIncludes;
  return includes === undefined || prompt.includes(includes);
}

function parseStepBody(step: Record<string, unknown>, index: number): Result<FakeStep, TandemiseError> {
  const kind = step['kind'];
  if (typeof kind !== 'string' || !STEP_KINDS.has(kind)) {
    return Err(TandemiseError.validation(`Fake script step ${index} has unknown kind '${String(kind)}'`, {
      allowed: [...STEP_KINDS],
    }));
  }

  const missing = (field: string): Result<never, TandemiseError> =>
    Err(TandemiseError.validation(`Fake script step ${index} (${kind}) needs a '${field}'`));

  switch (kind) {
    case 'message':
    case 'thinking':
      return typeof step['text'] === 'string' ? Ok({ kind, text: step['text'] }) : missing('text');
    case 'tool': {
      if (typeof step['tool'] !== 'string') return missing('tool');
      const outcome = step['outcome'];
      if (outcome !== undefined && outcome !== 'ok' && outcome !== 'error') {
        return Err(TandemiseError.validation(`Fake script step ${index} outcome must be 'ok' or 'error'`));
      }
      return Ok({
        kind,
        tool: step['tool'],
        input: typeof step['input'] === 'string' ? step['input'] : undefined,
        outcome: outcome ?? 'ok',
      });
    }
    case 'call': {
      if (typeof step['tool'] !== 'string') return missing('tool');
      const input = step['input'] ?? {};
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return Err(TandemiseError.validation(`Fake script step ${index} (call) input must be an object`));
      }
      return Ok({ kind, tool: step['tool'], input: input as Record<string, unknown> });
    }
    case 'write-file':
      if (typeof step['path'] !== 'string') return missing('path');
      if (typeof step['content'] !== 'string') return missing('content');
      return Ok({ kind, path: step['path'], content: step['content'] });
    case 'usage':
      return Ok({
        kind,
        inputTokens: optionalNumber(step['inputTokens']),
        outputTokens: optionalNumber(step['outputTokens']),
        costUsd: typeof step['costUsd'] === 'number' ? step['costUsd'] : null,
      });
    case 'checkpoint':
      return Ok({
        kind,
        sessionId: typeof step['sessionId'] === 'string' ? step['sessionId'] : undefined,
        label: typeof step['label'] === 'string' ? step['label'] : undefined,
      });
    case 'rate-limit':
      return Ok({ kind, detail: typeof step['detail'] === 'string' ? step['detail'] : undefined });
    case 'delay':
      return typeof step['ms'] === 'number' && step['ms'] >= 0
        ? Ok({ kind, ms: step['ms'] })
        : missing('ms');
    case 'complete':
      return Ok({ kind, summary: typeof step['summary'] === 'string' ? step['summary'] : undefined });
    case 'fail':
      if (typeof step['code'] !== 'string') return missing('code');
      if (typeof step['message'] !== 'string') return missing('message');
      return Ok({ kind, code: step['code'], message: step['message'], retryable: step['retryable'] === true });
    default:
      return Err(TandemiseError.validation(`Fake script step ${index} has unknown kind '${kind}'`));
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Fills every string inside a call's input, leaving its shape alone. */
function fillDeep(value: unknown, fill: (text: string) => string): unknown {
  if (typeof value === 'string') return fill(value);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, fill));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, fill)]));
  }
  return value;
}

/** Substitutes `{{prompt}}`, `{{cwd}}` and `{{runId}}` into a step's free text. */
export function substituteStep(step: FakeStep, values: Readonly<Record<string, string>>): FakeStep {
  const fill = (text: string): string => {
    let out = text;
    for (const [key, value] of Object.entries(values)) out = out.split(`{{${key}}}`).join(value);
    return out;
  };
  switch (step.kind) {
    case 'message':
    case 'thinking':
      return { ...step, text: fill(step.text) };
    case 'write-file':
      return { ...step, path: fill(step.path), content: fill(step.content) };
    case 'checkpoint':
      return step.sessionId === undefined ? step : { ...step, sessionId: fill(step.sessionId) };
    case 'complete':
      return step.summary === undefined ? step : { ...step, summary: fill(step.summary) };
    case 'fail':
      return { ...step, message: fill(step.message) };
    case 'tool':
      return step.input === undefined ? step : { ...step, input: fill(step.input) };
    case 'call':
      return { ...step, input: fillDeep(step.input, fill) as Record<string, unknown> };
    default:
      return step;
  }
}
