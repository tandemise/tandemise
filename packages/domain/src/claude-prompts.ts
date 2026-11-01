/**
 * Claude Code's start-up questions, as a held session's screen shows them, and
 * the keys that answer each with "yes" (#102).
 *
 * A hold opens interactive Claude Code in a checkout Tandemise made for the
 * step, so Claude Code first asks whether to trust that folder. Its default
 * answer is "No, exit": a person pressing Enter to get past it ends the session
 * they meant to steer. Claude Code offers no flag or session setting that
 * trusts a folder (only its own config, which Tandemise never writes), so the
 * terminal panel reads the screen and offers the answer as one click.
 *
 * Pure and import-free: the renderer imports it as a pure subpath.
 */

export type ClaudePromptKind = 'trust' | 'bypass';

export interface ClaudePrompt {
  readonly kind: ClaudePromptKind;
  /** What the panel says the question is. */
  readonly question: string;
  /** The answer the button gives, worded as Claude Code words it. */
  readonly answer: string;
  /** The keystrokes that pick that answer from where the selection is now and confirm it. */
  readonly keys: string;
}

interface PromptShape {
  readonly kind: ClaudePromptKind;
  readonly asks: RegExp;
  readonly question: string;
  readonly yes: string;
  readonly no: string;
}

const SHAPES: readonly PromptShape[] = [
  {
    kind: 'trust',
    asks: /Quick safety check|trust this folder/i,
    question: 'Claude Code asks whether to trust this folder. Tandemise created it for this step.',
    yes: 'Yes, I trust this folder',
    no: 'No, exit',
  },
  {
    kind: 'bypass',
    asks: /Bypass Permissions mode/i,
    question: 'Claude Code asks you to accept Bypass Permissions mode, which this step\'s profile chose.',
    yes: 'Yes, I accept',
    no: 'No, exit',
  },
];

/** Claude Code's selection marker, before the highlighted option. */
const MARKER = '❯';
const DOWN = '\u001b[B';
const ENTER = '\r';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The question on screen and how to answer it "yes", or null when none is
 * showing or the selection cannot be read. `screen` is the visible screen as
 * plain text (escape sequences already gone). The keys depend on where the
 * selection is: Enter when "yes" is already highlighted, Down then Enter when
 * the default "No, exit" is. Never a guess: a key sent with the selection
 * somewhere unknown could pick "No, exit".
 */
export function claudePromptOnScreen(screen: string): ClaudePrompt | null {
  for (const shape of SHAPES) {
    if (!shape.asks.test(screen) || !screen.includes(shape.yes)) continue;
    const on = (option: string): boolean => new RegExp(`${MARKER}\\s*(?:\\d+\\.\\s*)?${escapeRegExp(option)}`).test(screen);
    const keys = on(shape.yes) ? ENTER : on(shape.no) ? DOWN + ENTER : null;
    if (keys === null) return null;
    return { kind: shape.kind, question: shape.question, answer: shape.yes, keys };
  }
  return null;
}
