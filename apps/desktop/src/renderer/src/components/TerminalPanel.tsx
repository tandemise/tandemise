import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';
import type { MissionDetail, TaskView } from '@tandemise/api-contract';
import { claudePromptOnScreen, type ClaudePrompt } from '@tandemise/domain/claude-prompts';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './TerminalPanel.css';
import { Icon } from './Icon.js';
import { ApprovalCard } from '../screens/approvals/ApprovalCard.js';
import { useDaemon } from '../lib/connection.js';
import { describeError } from '../lib/daemon.js';
import { useDaemonMutation } from '../lib/queries.js';
import { closeTerminal, openTerminal } from '../lib/terminal.js';
import { useActors } from '../lib/team.js';
import { Button, Tooltip, Truncate } from '@tandemise/design/react';

/** What a hold changes on the mission: the step's status, the run it stopped, the requests it withdrew. */
const HOLD_TOPICS = ['tasks', 'missions', 'approvals'] as const;

/** How long a panel waits for the mission view to show a hold it was opened for, before closing as stale. */
const STALE_VIEW_GRACE_MS = 5000;

/**
 * How long a session counts as just started: the time in which Claude Code
 * asks, on a first visit to a folder, whether to trust it. Every hold opens in
 * a checkout Tandemise made for the step, so a first hold meets that question.
 */
const YOUNG_SESSION_MS = 30_000;

/** Claude Code's folder-trust question, as its screen words it. */
const TRUST_PROMPT = /trust this folder|Quick safety check/i;

/** Said above the terminal while that question may be on screen, and again if the session ended at it. */
const TRUST_HINT = 'Claude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task.';

/** What a session's end tells the panel: the daemon's words ('' for none), and whether it ended young or at the trust question. */
interface SessionEnd {
  readonly message: string;
  readonly atTrustPrompt: boolean;
}

/**
 * A held step's terminal, over the whole mission screen.
 *
 * It is a window onto the daemon's terminal, nothing more: keystrokes go out
 * on the task's terminal socket and its output comes back on it. Closing the
 * panel leaves the hold and its session running; Continue and Release are the
 * two ways to end it, and both are the daemon's to decide.
 */
export function TerminalPanel({ task, detail }: { task: TaskView; detail: MissionDetail }): JSX.Element {
  const missionId = detail.mission.id;
  const actors = useActors();
  const { cont, release } = useHoldActions(task.id, missionId);
  const reopen = useDaemonMutation((daemon) => daemon.reopenTerminal(task.id), HOLD_TOPICS, missionId);
  // Bumped to attach a fresh socket after the terminal was opened again.
  const [attachment, setAttachment] = useState(0);
  const [ended, setEnded] = useState<SessionEnd | null>(null);
  // While a session is young, or its screen shows the trust question, the panel says how to answer it.
  const [trustHint, setTrustHint] = useState(false);
  // A start-up question Claude Code is showing right now, answered "yes" in one click (#102).
  const [prompt, setPrompt] = useState<ClaudePrompt | null>(null);
  const answer = useRef<((keys: string) => void) | null>(null);
  const hold = task.hold;

  // The hold ended (here, in another window, or by someone else): there is no terminal left to show.
  // Right after Hold the mission view on screen may not have caught up yet, so a hold never seen gets a few seconds.
  const seenHold = useRef(false);
  useEffect(() => {
    if (hold !== null) {
      seenHold.current = true;
      return undefined;
    }
    const timer = setTimeout(closeTerminal, seenHold.current ? 0 : STALE_VIEW_GRACE_MS);
    return () => clearTimeout(timer);
  }, [hold]);

  // While a hold is open, a tool whose policy is "ask" still asks; the question is shown here so it is not missed.
  const asking = detail.approvals.filter((a) => a.taskId === task.id && a.status === 'PENDING' && a.kind !== 'check');
  const heldBy = hold === null ? null : hold.heldBy === actors.meId ? 'You' : hold.heldByName;
  const failure = cont.error ?? release.error ?? reopen.error;
  const panel = useRef<HTMLElement>(null);
  const [screenReader, setScreenReader] = useScreenReaderMode();

  // A terminal takes Tab and Escape for itself, so the panel's own keys apply only outside it (2.1.2):
  // F6 leaves the terminal for the panel's buttons, Tab stays inside the panel, Escape there closes it.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const root = panel.current;
    if (root === null) return;
    const inTerminal = (event.target as HTMLElement).closest('.xterm') !== null;
    if (event.key === 'F6') {
      event.preventDefault();
      if (inTerminal) {
        // Out to the actions; while they are disabled (Continue or Release in flight), to any other control
        // outside the terminal, and failing that to the panel itself, so F6 never leaves focus in the terminal.
        const outside = [...root.querySelectorAll<HTMLElement>(PANEL_STOPS)].filter((el) => el.closest('.xterm') === null && el.getClientRects().length > 0);
        const target = outside.find((el) => el.closest('.terminal-panel__actions') !== null) ?? outside[0] ?? root;
        target.focus();
      } else {
        root.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus();
      }
      return;
    }
    if (inTerminal) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTerminal();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...root.querySelectorAll<HTMLElement>(PANEL_STOPS)]
      .filter((el) => el.getClientRects().length > 0 && el.closest('.xterm') === null);
    const terminalInput = root.querySelector<HTMLElement>('.xterm-helper-textarea');
    if (terminalInput) stops.push(terminalInput);
    const at = stops.indexOf(event.target as HTMLElement);
    const next = stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <div className="overlay terminal-overlay">
      <section ref={panel} tabIndex={-1} className="terminal-panel" role="dialog" aria-modal="true" aria-label={`Terminal: ${task.title}`} onKeyDown={onKeyDown}>
        <header className="terminal-panel__head">
          <Icon name="terminal" size={15} className="terminal-panel__icon" />
          <div className="terminal-panel__titles">
            <Truncate as="h2" className="terminal-panel__title">{task.title}</Truncate>
            {heldBy !== null ? <span className="terminal-panel__holder">Held by {heldBy}</span> : null}
          </div>
          <div className="terminal-panel__actions">
            <Tooltip content="End your hold and let the agent finish the step from where you left it">
              <Button
                variant="primary"
                disabled={cont.isPending || release.isPending || hold === null}
                onClick={() => cont.mutate(undefined)}
              >
                <Icon name="play" size={13} />
                {cont.isPending ? 'Continuing…' : 'Continue'}
              </Button>
            </Tooltip>
            <Tooltip content="End your hold without asking the agent to continue; the step goes back to the queue">
              <Button
                disabled={cont.isPending || release.isPending || hold === null}
                onClick={() => release.mutate(undefined)}
              >
                {release.isPending ? 'Releasing…' : 'Release'}
              </Button>
            </Tooltip>
            <Tooltip content="Lets a screen reader read the terminal's output as it arrives, and its lines with the arrow keys">
              <Button variant="ghost" aria-pressed={screenReader} onClick={() => setScreenReader(!screenReader)}>
                Screen reader mode
              </Button>
            </Tooltip>
            <Tooltip content="The session keeps running; open it again from the step">
              <Button variant="ghost" onClick={closeTerminal}>
                <Icon name="x" size={13} />
                Close terminal
              </Button>
            </Tooltip>
          </div>
        </header>

        {failure ? <p className="terminal-panel__error field__error" role="alert">{describeError(failure).detail}</p> : null}

        {asking.length > 0 ? (
          <div className="terminal-panel__asking" aria-label="Waiting for your decision">
            {asking.map((approval) => (
              <ApprovalCard
                key={approval.id}
                compact
                view={{
                  approval, missionTitle: null, taskTitle: null, roleName: task.roleName, revisable: false,
                  addressees: [], decidedByRef: null, recordedByRef: null, escalationLevel: approval.escalationLevel ?? 0, headline: null,
                }}
              />
            ))}
          </div>
        ) : null}

        {/* Claude Code's start-up questions default to "No, exit": the panel reads the screen and answers "yes" in one click. */}
        <div className="terminal-panel__prompt-region" role="status">
          {prompt !== null && ended === null ? (
            <div className="terminal-panel__hint terminal-panel__hint--question">
              <Icon name="info" size={13} />
              <span>{prompt.question}</span>
              <Button
                variant="primary"
                size="sm"
                className="terminal-panel__answer"
                onClick={() => {
                  answer.current?.(prompt.keys);
                  panel.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus();
                }}
              >
                Answer: {prompt.answer}
              </Button>
            </div>
          ) : trustHint && ended === null ? (
            <p className="terminal-panel__hint">
              <Icon name="info" size={13} />
              <span>{TRUST_HINT}</span>
            </p>
          ) : null}
        </div>

        <div className="terminal-panel__body" data-ended={ended !== null}>
          <TerminalView key={attachment} taskId={task.id} label={`Terminal for ${task.title}`} screenReader={screenReader} onEnded={setEnded} onTrustHint={setTrustHint} onPrompt={setPrompt} answer={answer} />
          {ended !== null ? (
            <div className="terminal-panel__ended" role="status">
              <div className="terminal-panel__ended-words">
                <p className="terminal-panel__ended-text">The session ended.</p>
                {/* The daemon's own words, when it said more than that (no terminal after a restart, say). */}
                {ended.message !== '' ? <p className="terminal-panel__ended-detail">{ended.message}</p> : null}
                {/* "No, exit" is the question's default, so a session that ended right at it most likely took that. */}
                {ended.atTrustPrompt ? <p className="terminal-panel__ended-detail">{TRUST_HINT}</p> : null}
              </div>
              <Button
                variant="primary"
                disabled={reopen.isPending || hold === null}
                onClick={() => reopen.mutate(undefined, {
                  onSuccess: () => {
                    setEnded(null);
                    setAttachment((n) => n + 1);
                  },
                })}
              >
                <Icon name="refresh" size={13} />
                {reopen.isPending ? 'Opening…' : 'Open the terminal again'}
              </Button>
            </div>
          ) : null}
        </div>
        <p className="terminal-panel__keys" id="terminal-keys">
          <kbd>F6</kbd> moves between the terminal and the buttons above it; the terminal keeps <kbd>Tab</kbd> and <kbd>Esc</kbd> for itself.
        </p>
      </section>
    </div>
  );
}

/** What Tab and F6 may land on in the panel, outside the terminal. */
const PANEL_STOPS = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

const SCREEN_READER_KEY = 'tandemise.terminal.screenReader';

/** The terminal's screen reader mode, remembered on this computer. Off by default: it costs a little speed. */
function useScreenReaderMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(SCREEN_READER_KEY) === 'on';
    } catch {
      return false;
    }
  });
  const set = (next: boolean): void => {
    setOn(next);
    try {
      localStorage.setItem(SCREEN_READER_KEY, next ? 'on' : 'off');
    } catch {
      /* not remembered; still applies */
    }
  };
  return [on, set];
}

/**
 * The xterm.js surface and its socket, for one attachment. The daemon repaints
 * the scrollback on attach, so a new attachment starts from a blank screen.
 * `onEnded` hears how the session ended; `onTrustHint` whether the folder-trust
 * question may be on screen (the session is young, or its output asks it).
 */
function TerminalView({ taskId, label, screenReader, onEnded, onTrustHint, onPrompt, answer }: {
  taskId: string;
  /** The terminal region's name for a screen reader. */
  label: string;
  /** xterm's screen reader mode: output is read as it arrives, and its rows are in the accessibility tree. */
  screenReader: boolean;
  onEnded: (end: SessionEnd) => void;
  onTrustHint: (show: boolean) => void;
  /** The start-up question on screen now, or null; read from the visible screen after each write. */
  onPrompt: (prompt: ClaudePrompt | null) => void;
  /** Set to a function that types keys into the session while the socket is open. */
  answer: MutableRefObject<((keys: string) => void) | null>;
}): JSX.Element {
  // Keyed by the address, not the client object: the client is rebuilt on unrelated status changes.
  const url = useDaemon().terminalUrl(taskId);
  const host = useRef<HTMLDivElement>(null);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const hint = useRef(onTrustHint);
  hint.current = onTrustHint;
  const asked = useRef(onPrompt);
  asked.current = onPrompt;
  const terminal = useRef<Terminal | null>(null);
  const reader = useRef(screenReader);
  reader.current = screenReader;

  useEffect(() => {
    if (terminal.current) terminal.current.options.screenReaderMode = screenReader;
  }, [screenReader]);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const term = new Terminal({
      fontFamily: getComputedStyle(element).fontFamily,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(element),
      screenReaderMode: reader.current,
    });
    terminal.current = term;
    // F6 is the panel's, not the program's: it is how focus leaves the terminal (2.1.2).
    term.attachCustomKeyEventHandler((event) => event.key !== 'F6');
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const encoder = new TextEncoder();
    let over = false;
    // The last few screens of output as plain text, to tell when the trust question is showing.
    const decoder = new TextDecoder();
    let tail = '';
    let young = true;
    let ran = false;
    // When the question was last on screen: leaving it redraws the screen, so the words are gone by the time the session ends.
    let trustSeenAt: number | null = null;
    const trustShowing = (): boolean => {
      if (!TRUST_PROMPT.test(tail)) return false;
      trustSeenAt = Date.now();
      return true;
    };
    const trustRecent = (): boolean => trustSeenAt !== null && Date.now() - trustSeenAt < TRUST_RECENT_MS;
    const updateHint = (): void => hint.current(young || trustShowing());
    // The visible screen as plain text: what a person sees, so a question answered and redrawn away is gone.
    const screen = (): string => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
      return rows.join('\n');
    };
    let lastPrompt = '';
    const updatePrompt = (): void => {
      if (over) return;
      const now = claudePromptOnScreen(screen());
      const key = now === null ? '' : `${now.kind}:${now.keys}`;
      if (key === lastPrompt) return;
      lastPrompt = key;
      asked.current(now);
    };
    const youth = setTimeout(() => { young = false; updateHint(); }, YOUNG_SESSION_MS);
    updateHint();
    const finish = (message: string): void => {
      if (over) return;
      over = true;
      // A session that ran and ended young, or just after the question was showing, most likely ended at it.
      // One that never ran here (no terminal, the daemon's words say why) did not.
      ended.current({ message, atTrustPrompt: ran && message === '' && (young || trustShowing() || trustRecent()) });
      hint.current(false);
      asked.current(null);
    };
    const sendSize = (): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    const refit = (): void => {
      // A panel still laying out measures as zero, and xterm would shrink to one column.
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
    };

    socket.onopen = () => {
      refit();
      sendSize();
      term.focus();
    };
    socket.onmessage = (frame) => {
      if (frame.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(frame.data);
        ran = true;
        term.write(bytes, updatePrompt);
        // Escape sequences out, so a redraw that moves the cursor between words still reads as the words.
        tail = (tail + decoder.decode(bytes, { stream: true }).replace(ESCAPES, '')).slice(-TAIL_CHARS);
        updateHint();
        return;
      }
      const control = parseControl(frame.data);
      if (control?.type === 'exit') finish('');
      else if (control?.type === 'error') finish(control.message);
    };
    // A socket that drops without saying why: the daemon restarted, or went away. Either way the session is gone.
    socket.onclose = () => finish('');

    const typed = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    answer.current = (keys) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(keys));
    };
    const resized = term.onResize(sendSize);
    const observer = new ResizeObserver(refit);
    observer.observe(element);

    // The theme follows the app's: an explicit choice stamps data-theme, "system" follows the OS.
    const retheme = (): void => { term.options.theme = terminalTheme(element); };
    const stamps = new MutationObserver(retheme);
    stamps.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', retheme);

    return () => {
      over = true;
      answer.current = null;
      clearTimeout(youth);
      scheme.removeEventListener('change', retheme);
      stamps.disconnect();
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      socket.onclose = null;
      socket.close();
      terminal.current = null;
      term.dispose();
    };
  }, [url, answer]);

  return <div ref={host} className="terminal-panel__xterm" role="group" aria-label={label} aria-describedby="terminal-keys" />;
}

/**
 * "Hold" for a step that can be held, "Open terminal" for one that is held,
 * and a disabled Hold with the daemon's reason for one that cannot. The view's
 * answer is a forecast: the daemon may still refuse, and then its words show.
 */
export function HoldButton({ task, missionId, className = 'btn', onOpen }: {
  task: TaskView;
  missionId: string;
  className?: string;
  /** Called once the terminal is to be shown, so a drawer can step out of its way. */
  onOpen?: () => void;
}): JSX.Element {
  const show = (): void => {
    openTerminal(task.id);
    onOpen?.();
  };
  // Opened from the hook's own success, not the click's: a card or drawer that unmounts while the hold settles still opens it.
  const hold = useDaemonMutation((daemon) => daemon.holdTask(task.id), HOLD_TOPICS, missionId, () => openTerminal(task.id));
  if (task.hold !== null) {
    return (
      <button type="button" className={className} onClick={show}>
        <Icon name="terminal" size={13} />
        Open terminal
      </button>
    );
  }
  const button = (
    <button
      type="button"
      className={className}
      disabled={!task.holdable.ok || hold.isPending}
      onClick={() => hold.mutate(undefined, { onSuccess: () => onOpen?.() })}
    >
      <Icon name="pause" size={13} />
      {hold.isPending ? 'Holding…' : 'Hold'}
    </button>
  );
  return (
    <>
      {task.holdable.ok ? (
        <Tooltip content="Stop the agent and work with it in its own terminal">{button}</Tooltip>
      ) : (
        <>
          {button}
          {/* A disabled button takes no focus, so a tooltip could not say why: it is said beside it. */}
          <span className="dim hold-reason">{task.holdable.reason}</span>
        </>
      )}
      {hold.isError ? <span className="field__error hold-refusal" role="alert">{describeError(hold.error).detail}</span> : null}
    </>
  );
}

/** Continue and Release, wherever a held step offers them. */
export function useHoldActions(taskId: string, missionId: string) {
  const cont = useDaemonMutation((daemon) => daemon.continueTask(taskId), HOLD_TOPICS, missionId);
  const release = useDaemonMutation((daemon) => daemon.releaseTask(taskId), HOLD_TOPICS, missionId);
  return { cont, release };
}

/** "Now: Editing src/app/page.tsx" for a live agent step; nothing otherwise. */
export function NowLine({ now, className = '' }: { now: string | null; className?: string }): JSX.Element | null {
  if (now === null) return null;
  return (
    <p className={`now-line ${className}`.trim()}>
      <span className="now-line__label">Now</span>
      <Truncate className="now-line__text">{now}</Truncate>
    </p>
  );
}

/** Enough plain output to hold a full-screen question, and little enough that it scrolls out once answered. */
const TAIL_CHARS = 2000;
/** How recently the trust question must have been on screen for an ending to count as at it. */
const TRUST_RECENT_MS = 15_000;
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

type Control = { type: 'exit'; code: number | null } | { type: 'error'; message: string };

function parseControl(data: unknown): Control | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as Control;
    return value.type === 'exit' || value.type === 'error' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The terminal roles from @tandemise/design (tokens.css), resolved to the colours the current theme
 * gives them. A custom property reads back as the `light-dark()` text it was
 * written with, so each role is set on a probe's `color` and read from there.
 */
function terminalTheme(element: HTMLElement): ITheme {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  element.appendChild(probe);
  const resolve = (role: string): string => {
    probe.style.color = `var(${role})`;
    return getComputedStyle(probe).color;
  };
  const red = resolve('--status-failed');
  const green = resolve('--status-succeeded');
  const yellow = resolve('--status-blocked');
  const blue = resolve('--status-running');
  const magenta = resolve('--risk-release');
  const theme: ITheme = {
    background: resolve('--terminal-background'),
    foreground: resolve('--terminal-foreground'),
    cursor: resolve('--terminal-cursor'),
    cursorAccent: resolve('--terminal-background'),
    selectionBackground: resolve('--terminal-selection'),
    red, green, yellow, blue, magenta,
    brightRed: red, brightGreen: green, brightYellow: yellow, brightBlue: blue, brightMagenta: magenta,
  };
  probe.remove();
  return theme;
}
