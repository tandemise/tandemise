import { spawn } from 'node:child_process';
import { workerEnv } from '@tandemise/runtimes-core';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentEvent, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import {
  DEFAULT_TERMINATION_GRACE_MS, NormalizingEventSink, relieveBackPressure, superviseProcessStream, withDeclaredCapabilities,
} from '@tandemise/runtimes-core';
import type { AgentRuntimeAdapter, RunRequest, SupervisedChild } from '@tandemise/runtimes-core';
import { TandemiseError, systemClock } from '@tandemise/shared';
import type { Clock, RunId } from '@tandemise/shared';
import { CodexEventMapper } from './event-mapper.js';
import {
  CODEX_CAPABILITIES, CODEX_INSTALL_HINT, parseCodexSettings, sandboxModeFor,
} from './settings.js';
import type { CodexSettings } from './settings.js';
import { findExecutable, isSignedIn, notInstalledDetail, probeVersion } from './discovery.js';

export const CODEX_ADAPTER_ID = 'codex';

export interface CodexAdapterOptions {
  readonly clock?: Clock;
  readonly terminationGraceMs?: number;
}

/**
 * Runs the OpenAI Codex CLI headlessly and normalizes its output
 * (MVP.md §10.2).
 *
 * Written against the documented `codex exec` surface rather than a live
 * binary, so every part of the command line and the event table is a
 * *configurable default* (see `settings.ts`). The structure is identical to the
 * Claude adapter - same supervisor, same sink, same terminal-event guard -
 * because the point of the runtime abstraction is that a second vendor is a
 * different table of flags, not a different architecture.
 */
export class CodexAdapter implements AgentRuntimeAdapter {
  readonly id = CODEX_ADAPTER_ID;
  readonly displayName = 'Codex CLI';
  readonly baseCapabilities = CODEX_CAPABILITIES;

  readonly #children = new Map<RunId, SupervisedChild>();
  readonly #clock: Clock;
  readonly #graceMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  /** Never throws: a missing Codex is a normal state, reported as `detected:false`. */
  async discover(): Promise<RuntimeDiscovery> {
    const executablePath = findExecutable(null);
    if (executablePath === null) {
      return {
        adapterId: this.id,
        displayName: this.displayName,
        detected: false,
        executablePath: null,
        version: null,
        capabilities: [],
        detail: notInstalledDetail(),
        suggestedSettings: {},
      };
    }
    const { version, detail } = await probeVersion(executablePath, ['--version']);
    return {
      adapterId: this.id,
      displayName: this.displayName,
      detected: version !== null,
      executablePath,
      version,
      capabilities: version === null ? [] : CODEX_CAPABILITIES,
      detail: version === null ? detail : `${detail}${isSignedIn() ? '' : ' — no Codex sign-in found; run `codex login`.'}`,
      suggestedSettings: { subcommand: 'exec', jsonFlag: '--json' },
    };
  }

  /**
   * Distinguishes the three states the Runtimes screen has to tell apart:
   * not installed, installed but not signed in, and ready.
   */
  async healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth> {
    const settings = parseCodexSettings(profile.settings);
    const executablePath = findExecutable(profile.executablePath);
    if (executablePath === null) {
      return this.#health(profile, 'unavailable', null, notInstalledDetail());
    }

    const { version, detail } = await probeVersion(executablePath, settings.versionArgs);
    if (version === null) {
      return this.#health(profile, 'unavailable', null, `${detail}. ${CODEX_INSTALL_HINT}`);
    }
    if (!isSignedIn()) {
      // Installed and runnable, but every run would fail at the first request.
      // `degraded` keeps it as a routing fallback rather than a first choice.
      return this.#health(profile, 'degraded', version,
        `${detail} — installed but no sign-in found at ~/.codex/auth.json; run \`codex login\`.`);
    }
    return this.#health(profile, 'healthy', version, `${detail} — signed in`);
  }

  /** Codex takes its model flag (`-m` unless the profile says otherwise) on every run (P12). */
  acceptsModel(_profile: RuntimeProfile): boolean {
    return true;
  }

  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[] {
    return withDeclaredCapabilities(profile, parseCodexSettings(profile.settings).capabilities ?? CODEX_CAPABILITIES, this.baseCapabilities);
  }

  start(request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, null);
  }

  /**
   * Present but not advertised: `CODEX_CAPABILITIES` omits `session_resume`
   * until a profile opts in, because this path has never run against a real
   * binary and routing must not choose Codex *for* its resume support.
   */
  resume(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, sessionRef);
  }

  pid(runId: RunId): number | null {
    return this.#children.get(runId)?.pid ?? null;
  }

  async cancel(runId: RunId): Promise<void> {
    const child = this.#children.get(runId);
    if (child === undefined || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await waitForExit(child, this.#graceMs);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  async *#run(request: RunRequest, resumeSessionRef: string | null): AsyncIterable<AgentEvent> {
    const log = request.log.child({ runId: request.runId, runtime: this.id });
    const settings = parseCodexSettings(request.profile.settings);
    const cwd = absoluteWorkingDirectory(request.workingDirectory);

    const executablePath = findExecutable(request.profile.executablePath);
    if (executablePath === null) {
      throw new TandemiseError('RUNTIME_UNAVAILABLE', notInstalledDetail(), {
        details: { adapterId: this.id, preferred: request.profile.executablePath },
      });
    }

    const { args, stdin } = buildInvocation(settings, request, resumeSessionRef);
    const sink = new NormalizingEventSink({ log, onInvalid: 'raw' });
    const mapper = new CodexEventMapper({ eventTypes: settings.eventTypes });

    log.debug('spawning codex', { executablePath, argc: args.length, promptViaStdin: stdin !== null });
    const stream = superviseProcessStream({
      spawn: () => spawn(executablePath, args, {
        cwd,
        // Codex authenticates through ~/.codex under the user's own account;
        // Tandemise never holds that credential (MVP.md §10.3, §P8).
        env: workerEnv(request),
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      describe: executablePath,
      stdin,
      signal: request.signal,
      maxWallTimeMs: request.maxWallTimeMs,
      graceMs: this.#graceMs,
      sink,
      log,
      onStdoutLine: (line) => this.#handleLine(line, settings, sink, mapper),
      onExit: (code, killedBy) => {
        // Reached only when Codex produced no verdict of its own - always the
        // case in text mode, where the exit status is the only verdict there is.
        if (code === 0) {
          sink.complete({ resultRef: mapper.sessionId ?? undefined });
        } else {
          const how = killedBy === null ? `exit code ${code}` : `signal ${killedBy}`;
          sink.fail('RUNTIME_FAILED', `Codex ended without a result (${how})`, false);
        }
      },
    });
    this.#children.set(request.runId, stream.child);

    try {
      for await (const event of sink) {
        relieveBackPressure(stream.child, sink.pending);
        yield event;
      }
    } finally {
      this.#children.delete(request.runId);
      stream.dispose();
    }
  }

  #handleLine(
    line: string,
    settings: CodexSettings,
    sink: NormalizingEventSink,
    mapper: CodexEventMapper,
  ): void {
    if (settings.outputFormat === 'text') {
      // Plain-text Codex interleaves banners, spinners and prose, so unlike the
      // generic adapter this does *not* promote each line to a `message` - that
      // would fill the semantic timeline with progress noise. The raw log keeps
      // everything and the synthesized terminal event carries the verdict.
      sink.raw('stdout', line);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sink.raw('stdout', line);
      return;
    }
    const events = mapper.map(parsed);
    if (events === null) {
      sink.raw('stdout', line);
      return;
    }
    for (const event of events) sink.push(event);
  }

  #health(
    profile: RuntimeProfile,
    state: RuntimeHealth['state'],
    version: string | null,
    detail: string,
  ): RuntimeHealth {
    return { profileId: profile.id, state, version, detail, checkedAt: this.#clock.now(), quotaWarning: null };
  }
}

export interface CodexInvocation {
  readonly args: readonly string[];
  readonly stdin: string | null;
}

/**
 * Builds the Codex command line. Pure, so the flag mapping can be asserted
 * without the binary being installed - which is the only way it *can* be
 * tested on a machine that does not have Codex.
 *
 * The prompt goes immediately after the subcommand rather than at the end. A
 * trailing positional is fragile next to variadic flags: the Claude adapter
 * shipped exactly that bug, where `--disallowed-tools` silently swallowed the
 * prompt and the CLI then reported that no prompt had been given.
 */
export function buildInvocation(
  settings: CodexSettings,
  request: RunRequest,
  resumeSessionRef: string | null,
): CodexInvocation {
  const viaStdin = settings.promptVia === 'stdin';
  const args: string[] = resumeSessionRef === null
    ? [settings.subcommand]
    : [...settings.resumeSubcommand, resumeSessionRef];

  if (!viaStdin) args.push(request.prompt);
  if (settings.jsonFlag !== null) args.push(settings.jsonFlag);
  // The engine resolves the model per run (P12); an older caller leaves it to the profile.
  const model = request.model !== undefined ? request.model : settings.model;
  if (model !== null && model.length > 0) args.push(settings.modelFlag, model);
  if (settings.workingDirectoryFlag !== null) {
    args.push(settings.workingDirectoryFlag, request.workingDirectory);
  }
  args.push(settings.sandboxFlag, settings.sandboxMode ?? sandboxModeFor(request.grants));
  args.push(...settings.extraArgs);

  return { args, stdin: viaStdin ? request.prompt : null };
}

function waitForExit(child: SupervisedChild, timeoutMs: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    child.once('close', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function absoluteWorkingDirectory(dir: string): string {
  if (!isAbsolute(dir)) {
    throw TandemiseError.validation('RunRequest.workingDirectory must be absolute', { workingDirectory: dir });
  }
  return resolve(dir);
}
