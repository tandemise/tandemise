import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type {
  AgentEvent, InteractiveInvocation, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import { NormalizingEventSink, SESSION_NOT_FOUND, classifyAbort } from '@tandemise/runtimes-core';
import type { AgentRuntimeAdapter, InteractiveOptions, RunRequest } from '@tandemise/runtimes-core';
import { TandemiseError, errorMessage, isPathInside, ownNodeEnv, systemClock } from '@tandemise/shared';
import type { Clock, RunId } from '@tandemise/shared';
import { DEFAULT_FAKE_SCRIPT, parseFakeScript, stepApplies, substituteStep } from './fake-script.js';
import type { FakeScript, FakeStep } from './fake-script.js';

export const FAKE_ADAPTER_ID = 'fake';
export const FAKE_SCRIPT_ENV = 'TANDEMISE_FAKE_SCRIPT';

/**
 * The fake advertises a broad capability set on purpose: its job is to stand in
 * for whichever runtime a test is really about, so routing must be able to pick
 * it for any of them. A profile may narrow this to exercise the "no runtime
 * satisfies these capabilities" path.
 */
export const FAKE_CAPABILITIES: readonly RuntimeCapability[] = [
  'reasoning', 'shell', 'filesystem', 'git', 'structured_output', 'session_resume', 'tool_calling', 'interactive_resume',
];

/**
 * The fake's interactive session, as a script for `node -e`. It reads stdin a
 * line at a time and writes every reply straight away, because it will run
 * under a PTY where buffered output would look like a hang.
 */
function interactiveScript(sessionFile: string, ref: string | null, promptsFile: string | null): string {
  return `
const fs = require('fs');
const path = require('path');
const readline = require('readline');
fs.writeFileSync(${JSON.stringify(sessionFile)}, 'fake-session-' + Date.now());
process.stdout.write('Fake session ' + ${JSON.stringify(ref ?? 'new')} + '\\n');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const promptsFile = ${JSON.stringify(promptsFile)};
rl.on('line', (line) => {
  process.stdout.write('> ' + line + '\\n');
  if (promptsFile !== null && line.trim() !== '/exit') {
    fs.appendFileSync(promptsFile, JSON.stringify({ at: new Date().toISOString(), prompt: line }) + '\\n');
  }
  if (line.startsWith('write ')) {
    const name = line.slice(6).trim();
    fs.writeFileSync(path.resolve(process.cwd(), name), 'written in a held session\\n');
    process.stdout.write('wrote ' + name + '\\n');
  } else if (line.trim() === '/exit') {
    rl.close();
  }
});
rl.on('close', () => process.exit(0));
`;
}

export interface FakeRuntimeAdapterOptions {
  readonly clock?: Clock;
  /** Overrides script resolution entirely. Handy for a test that owns the script. */
  readonly script?: FakeScript;
}

/**
 * A deterministic, offline runtime (MVP.md §28.2).
 *
 * Every orchestration test needs a worker whose behaviour is a fact rather than
 * a sample: same script, same events, same order, no network, no model. It is
 * also the only way to exercise the failure and rate-limit branches of the
 * scheduler on demand instead of waiting for a real runtime to misbehave.
 *
 * It does write real files, because a fake that only *claims* to have produced
 * an artifact would let artifact collection pass a test it should fail.
 */
export class FakeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = FAKE_ADAPTER_ID;
  readonly displayName = 'Fake Runtime';
  readonly baseCapabilities = FAKE_CAPABILITIES;

  readonly #cancellations = new Map<RunId, AbortController>();
  readonly #clock: Clock;
  readonly #override: FakeScript | undefined;

  constructor(options: FakeRuntimeAdapterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#override = options.script;
  }

  async discover(): Promise<RuntimeDiscovery> {
    return {
      adapterId: this.id,
      displayName: this.displayName,
      detected: true,
      executablePath: null,
      version: 'built-in',
      capabilities: FAKE_CAPABILITIES,
      detail: `Deterministic in-process runtime. Script it via profile settings or ${FAKE_SCRIPT_ENV}.`,
      suggestedSettings: {},
    };
  }

  async healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth> {
    const script = this.#resolveScript(profile);
    return {
      profileId: profile.id,
      state: script.ok ? 'healthy' : 'unavailable',
      version: 'built-in',
      detail: script.ok ? `${script.value.steps.length} scripted steps` : script.error.message,
      checkedAt: this.#clock.now(),
      quotaWarning: null,
    };
  }

  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[] {
    const declared = profile.capabilities;
    return declared.length > 0 ? declared : FAKE_CAPABILITIES;
  }

  start(request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, null);
  }

  resume(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, sessionRef);
  }

  interactive(
    sessionRef: string | null,
    request: RunRequest,
    opts: InteractiveOptions,
  ): InteractiveInvocation {
    return {
      file: process.execPath,
      args: ['-e', interactiveScript(opts.sessionFile, sessionRef, opts.promptsFile ?? null)],
      env: { ...ownNodeEnv() },
      cwd: request.workingDirectory,
      sessionFile: opts.sessionFile,
    };
  }

  /** In-process by design: there is no child to supervise. */
  pid(_runId: RunId): number | null {
    return null;
  }

  async cancel(runId: RunId): Promise<void> {
    this.#cancellations.get(runId)?.abort(new TandemiseError('CANCELLED', 'Run cancelled'));
  }

  async *#run(request: RunRequest, resumeSessionRef: string | null): AsyncIterable<AgentEvent> {
    const log = request.log.child({ runId: request.runId, runtime: this.id });
    // `onInvalid: 'throw'` on purpose: the fake is the reference implementation
    // of the event contract, so a malformed event here is a bug to surface, not
    // third-party output to tolerate.
    const sink = new NormalizingEventSink({ log, onInvalid: 'throw' });

    const controller = new AbortController();
    this.#cancellations.set(request.runId, controller);
    const signal = AbortSignal.any([request.signal, controller.signal]);

    // The script is driven alongside the consumer rather than pre-computed, so
    // a `delay` step actually delays the events that follow it - which is what
    // makes the fake usable for testing cancellation and timeouts.
    const pump = this.#drive(request, resumeSessionRef, sink, signal, log)
      .catch((e: unknown) => { sink.fail('INTERNAL', errorMessage(e), false); })
      .finally(() => {
        sink.close();
        this.#cancellations.delete(request.runId);
      });

    try {
      yield* sink;
    } finally {
      // A consumer that stopped early must not leave the script running.
      controller.abort();
      await pump;
    }
  }

  async #drive(
    request: RunRequest,
    resumeSessionRef: string | null,
    sink: NormalizingEventSink,
    signal: AbortSignal,
    log: RunRequest['log'],
  ): Promise<void> {
    const script = this.#resolveScript(request.profile);
    if (!script.ok) {
      sink.fail('VALIDATION', script.error.message, false);
      return;
    }
    if (resumeSessionRef !== null) {
      if (script.value.resume === 'missing') {
        sink.fail(SESSION_NOT_FOUND, `The fake runtime has no session ${resumeSessionRef}.`, true);
        return;
      }
      sink.push({ type: 'checkpoint', externalSessionId: resumeSessionRef, label: 'session.resumed' });
    }

    const captured = Object.fromEntries(Object.entries(script.value.captures ?? {}).map(([name, source]) =>
      [name, [...request.prompt.matchAll(new RegExp(source, 'gm'))].map((m) => m[1] ?? m[0]).join(', ')]));
    const values = { prompt: request.prompt, cwd: request.workingDirectory, runId: request.runId, ...captured };
    for (const step of script.value.steps) {
      if (signal.aborted) {
        const outcome = classifyAbort(request.signal, request.maxWallTimeMs);
        sink.fail(outcome.code, outcome.message, outcome.retryable);
        return;
      }
      if (!stepApplies(step, request.prompt)) continue;
      if (step.kind === 'delay') {
        await delay(step.ms, signal);
        continue;
      }
      this.#emit(substituteStep(step, values), request, sink, log);
      if (sink.terminated) return;
    }
    sink.complete();
  }

  #emit(step: FakeStep, request: RunRequest, sink: NormalizingEventSink, log: RunRequest['log']): void {
    switch (step.kind) {
      case 'message':
        sink.push({ type: 'message', text: step.text });
        return;
      case 'thinking':
        sink.push({ type: 'thinking_summary', text: step.text });
        return;
      case 'tool':
        sink.push({ type: 'tool.started', tool: step.tool, inputSummary: step.input ?? '' });
        sink.push({ type: 'tool.completed', tool: step.tool, outcome: step.outcome ?? 'ok' });
        return;
      case 'write-file':
        this.#writeFile(step, request, sink);
        return;
      case 'usage':
        sink.push({
          type: 'usage',
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          costUsd: step.costUsd ?? null,
        });
        return;
      case 'checkpoint':
        sink.push({ type: 'checkpoint', externalSessionId: step.sessionId, label: step.label });
        return;
      case 'rate-limit':
        // Mirrors how a real adapter surfaces quota pressure: a raw record for
        // the log, with the semantic signal carried by health, not by a new
        // member of the canonical event union.
        log.warn('fake runtime simulated a rate limit', { runId: request.runId });
        sink.raw('stderr', step.detail ?? 'Simulated rate limit: quota exhausted');
        return;
      case 'complete':
        sink.complete({ summary: step.summary });
        return;
      case 'fail':
        sink.fail(step.code, step.message, step.retryable === true);
        return;
      case 'delay':
        return;
    }
  }

  /** Writes for real, but only inside the run's own directory. */
  #writeFile(
    step: Extract<FakeStep, { kind: 'write-file' }>,
    request: RunRequest,
    sink: NormalizingEventSink,
  ): void {
    const target = isAbsolute(step.path) ? resolve(step.path) : resolve(request.workingDirectory, step.path);
    if (!isPathInside(request.workingDirectory, target)) {
      throw TandemiseError.permissionDenied('Fake runtime may only write inside its working directory', {
        path: target,
        workingDirectory: request.workingDirectory,
      });
    }
    const change = existsSync(target) ? 'edit' : 'add';
    sink.push({ type: 'tool.started', tool: 'Write', inputSummary: target });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, step.content, 'utf8');
    sink.push({ type: 'file.changed', path: target, change });
    sink.push({ type: 'tool.completed', tool: 'Write', outcome: 'ok' });
  }

  /**
   * Script resolution, most specific first: a constructor override, the
   * profile's inline `script`, a `scriptPath`, the environment variable (a path
   * or inline JSON), then the built-in default.
   */
  #resolveScript(profile: RuntimeProfile): ReturnType<typeof parseFakeScript> {
    if (this.#override !== undefined) return { ok: true, value: this.#override };

    const inline = profile.settings['script'];
    if (inline !== undefined) return parseFakeScript(inline);

    const settingsPath = profile.settings['scriptPath'];
    if (typeof settingsPath === 'string') return readScriptFile(settingsPath);

    const fromEnv = process.env[FAKE_SCRIPT_ENV];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv.trimStart().startsWith('{') ? parseJsonScript(fromEnv) : readScriptFile(fromEnv);
    }
    return { ok: true, value: DEFAULT_FAKE_SCRIPT };
  }
}

function readScriptFile(path: string): ReturnType<typeof parseFakeScript> {
  try {
    return parseJsonScript(readFileSync(path, 'utf8'));
  } catch (e) {
    return { ok: false, error: TandemiseError.validation(`Cannot read fake script '${path}': ${errorMessage(e)}`) };
  }
}

function parseJsonScript(json: string): ReturnType<typeof parseFakeScript> {
  try {
    return parseFakeScript(JSON.parse(json));
  } catch (e) {
    return { ok: false, error: TandemiseError.validation(`Fake script is not valid JSON: ${errorMessage(e)}`) };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      done();
    }, { once: true });
  });
}
