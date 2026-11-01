import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  AgentEvent, InteractiveInvocation, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import { SKILLS_FOLDER } from '@tandemise/domain';
import {
  DEFAULT_TERMINATION_GRACE_MS, NormalizingEventSink, RUNTIME_SIGNED_OUT, SESSION_NOT_FOUND,
  relieveBackPressure, superviseProcessStream,
} from '@tandemise/runtimes-core';
import { buildRuntimeEnv, withDeclaredCapabilities, withheldEnvNames } from '@tandemise/runtimes-core';
import { CLAUDE_SETTINGS_SCHEMA, PARENT_SESSION_ENV, resolveConfigDir } from './settings.js';
import type { AgentRuntimeAdapter, InteractiveOptions, RunRequest, SupervisedChild } from '@tandemise/runtimes-core';
import { TandemiseError, systemClock } from '@tandemise/shared';
import type { Clock, RunId } from '@tandemise/shared';
import { buildInteractiveInvocation, buildInvocation } from './cli-args.js';
import { ClaudeEventMapper } from './event-mapper.js';
import { findExecutable, probeVersion, requireExecutable } from './discovery.js';

export const CLAUDE_ADAPTER_ID = 'claude-code';

/**
 * How Claude Code says it has forgotten the session we asked it to continue.
 *
 * It reports this on stderr and then exits with the generic
 * `error_during_execution` result, so the code alone is indistinguishable from
 * a model that crashed halfway through real work. Matching the sentence is the
 * only way to tell the two apart, and getting it wrong is expensive: an
 * unrecognised stale handle failed the task rather than restarting it.
 */
const SESSION_MISSING = /no conversation found with session id/i;

/**
 * How Claude Code says it cannot authenticate. Seen in the wild as a `result`
 * whose subtype is, unhelpfully, `success` with `is_error: true` and the text
 * "Failed to authenticate: OAuth session expired and could not be refreshed";
 * the other phrasings are the CLI's prompts to log in.
 */
const SIGNED_OUT = /failed to authenticate|oauth (session|token).{0,20}expired|not logged in|invalid api key|please run \/login|authentication_error/i;

/**
 * How long a sign-in failure keeps a profile unavailable. Short, because the
 * health probe cannot see a login - only a run can - so this is also how often
 * a waiting task tries again, and the fix is usually one command away.
 */
const SIGNED_OUT_TTL_MS = 2 * 60_000;

/**
 * What Claude Code can do, before any policy is applied (MVP.md §10.5). These
 * are descriptive: routing reads them, enforcement reads the assignment's
 * grants. `browser` and `computer_use` are absent because Claude Code drives
 * neither natively - those come from an execution target or an MCP server.
 */
export const CLAUDE_CAPABILITIES: readonly RuntimeCapability[] = [
  'reasoning', 'vision', 'shell', 'filesystem', 'git', 'web',
  'mcp', 'structured_output', 'session_resume', 'tool_calling', 'interactive_resume',
];

/** A quota observation older than this no longer describes the current state. */
const QUOTA_WARNING_TTL_MS = 15 * 60_000;

interface QuotaObservation {
  readonly detail: string;
  readonly blocking: boolean;
  readonly observedAtMs: number;
}

export interface ClaudeCodeAdapterOptions {
  readonly clock?: Clock;
  readonly terminationGraceMs?: number;
}

/**
 * Runs the locally installed Claude Code CLI in headless streaming mode and
 * normalizes its output (MVP.md §10.2).
 *
 * Authentication is deliberately not this adapter's business: the CLI is
 * launched under the user's own environment and uses whatever subscription or
 * key it is already configured with, so Tandemise never holds a credential it
 * would then have to protect (MVP.md §10.3).
 */
export class ClaudeCodeAdapter implements AgentRuntimeAdapter {
  readonly id = CLAUDE_ADAPTER_ID;
  readonly displayName = 'Claude Code';
  readonly baseCapabilities = CLAUDE_CAPABILITIES;

  readonly #children = new Map<RunId, SupervisedChild>();
  readonly #clock: Clock;
  readonly #graceMs: number;
  #quota: QuotaObservation | null = null;
  /** Per profile: two profiles can run under two config directories, two logins. */
  readonly #signedOut = new Map<string, { readonly detail: string; readonly observedAtMs: number }>();

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  readonly settingsSchema = CLAUDE_SETTINGS_SCHEMA;

  validateSettings(settings: Readonly<Record<string, unknown>>): void {
    // Throws a validation error the desktop renders inline on the field.
    resolveConfigDir(settings);
  }

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
        detail: 'No `claude` executable on PATH, in ~/.local/bin, ~/.claude/local, or an nvm bin directory.',
        suggestedSettings: {},
        settingsSchema: CLAUDE_SETTINGS_SCHEMA,
      };
    }
    const { version, detail } = await probeVersion(executablePath);
    return {
      adapterId: this.id,
      displayName: this.displayName,
      detected: version !== null,
      executablePath,
      version,
      capabilities: version === null ? [] : CLAUDE_CAPABILITIES,
      detail,
      // Nothing pinned: an explicit `permissionMode` overrides the mode derived
      // from each run's grants, and `default` headless means a developer's
      // first edit waits on a prompt nobody can answer until the budget kills it.
      suggestedSettings: {},
      settingsSchema: CLAUDE_SETTINGS_SCHEMA,
    };
  }

  async healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth> {
    const executablePath = findExecutable(profile.executablePath);
    if (executablePath === null) {
      return this.#health(profile, 'unavailable', null, 'Claude Code executable not found');
    }
    const { version, detail } = await probeVersion(executablePath);
    if (version === null) return this.#health(profile, 'unavailable', null, detail);
    const signedOut = this.#currentSignOut(profile);
    if (signedOut !== null) {
      return { ...this.#health(profile, 'unavailable', version, signedOut), actionRequired: signedOut };
    }
    const quota = this.#currentQuota();
    return this.#health(profile, quota?.blocking === true ? 'degraded' : 'healthy', version, detail);
  }

  /** Claude Code takes `--model` on every run (P12). */
  acceptsModel(_profile: RuntimeProfile): boolean {
    return true;
  }

  /**
   * Claude Code loads project skills from `.claude/skills` in its working
   * folder (P13). Workers keep `--setting-sources project,local`, so the
   * person's own global skills stay out; only the pinned ones are there.
   */
  skillsFolder(_profile: RuntimeProfile): string | null {
    return SKILLS_FOLDER;
  }

  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[] {
    return withDeclaredCapabilities(profile, CLAUDE_CAPABILITIES, this.baseCapabilities);
  }

  start(request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, null);
  }

  resume(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request, sessionRef);
  }

  /** The interactive CLI for a hold, resumed in the agent's session (or fresh with an initial prompt). */
  interactive(
    sessionRef: string | null,
    request: RunRequest,
    opts: InteractiveOptions,
  ): InteractiveInvocation {
    const file = requireExecutable(request.profile.executablePath);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.#env(request, resolveConfigDir(request.profile.settings)))) {
      if (value !== undefined) env[name] = value;
    }
    env['TERM'] = 'xterm-256color';
    return {
      file,
      ...buildInteractiveInvocation(request, sessionRef, opts),
      env,
      cwd: absoluteWorkingDirectory(request.workingDirectory),
    };
  }

  pid(runId: RunId): number | null {
    return this.#children.get(runId)?.pid ?? null;
  }

  /**
   * Out-of-band cancellation (MVP.md §21.1). `start`'s AbortSignal is the
   * primary path; this exists for the supervisor cancelling a run it is not
   * currently iterating.
   */
  async cancel(runId: RunId): Promise<void> {
    const child = this.#children.get(runId);
    if (child === undefined || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await this.#waitForExit(child, this.#graceMs);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  async *#run(request: RunRequest, resumeSessionRef: string | null): AsyncIterable<AgentEvent> {
    const log = request.log.child({ runId: request.runId, runtime: this.id });
    const executablePath = requireExecutable(request.profile.executablePath);
    const { args, stdin } = buildInvocation(request, resumeSessionRef);
    const cwd = absoluteWorkingDirectory(request.workingDirectory);

    let sessionMissing = false;
    let signedOutLine: string | null = null;
    const sink = new NormalizingEventSink({ log, onInvalid: 'raw' });
    const mapper = new ClaudeEventMapper({
      // Probed against the run's working directory: a relative `file_path`
      // resolved against the daemon's cwd would answer about the wrong file,
      // flipping add/edit and emitting a path the UI cannot open.
      fileExists: (path: string) => existsSync(isAbsolute(path) ? path : resolve(cwd, path)),
      onQuotaWarning: (detail) => this.#recordQuota(detail),
    });

    // A profile may select the config directory it runs under, which is what
    // makes two Claude profiles two independent workers rather than one account
    // wearing two names. It is an override, so it wins over anything inherited.
    const configDir = resolveConfigDir(request.profile.settings);
    const childEnv = this.#env(request, configDir);
    log.debug('spawning claude code', {
      executablePath,
      argc: args.length,
      promptViaStdin: stdin !== null,
      envWithheld: withheldEnvNames(childEnv).length,
      configDir: configDir ?? '(inherited)',
    });
    const stream = superviseProcessStream({
      spawn: () => spawn(executablePath, args, {
        cwd,
        // The CLI authenticates from the user's own environment and keychain
        // (MVP.md §10.3), so it needs more than an empty environment - but it
        // needs its OWN credentials, not every credential the daemon happens to
        // have inherited from a developer shell. Profile settings deliberately
        // cannot inject arbitrary env vars, which would invite secrets into the
        // database (MVP.md §P8) - `configDir` is the one typed exception, and a
        // path is not a credential.
        env: childEnv,
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
      onStdoutLine: (line) => this.#handleLine(line, sink, mapper),
      // Guarded on `resumeSessionRef`: a fresh start has no session to lose, so
      // the same sentence arriving there means something else entirely.
      onStderrLine: (line) => {
        if (resumeSessionRef !== null && SESSION_MISSING.test(line)) sessionMissing = true;
        if (SIGNED_OUT.test(line)) signedOutLine ??= line;
      },
      onExit: (code, killedBy) => {
        // Reached only when the CLI produced no `result` record of its own,
        // which for Claude Code means it died before finishing.
        const how = killedBy === null ? `exit code ${code}` : `signal ${killedBy}`;
        sink.fail('RUNTIME_FAILED', `Claude Code ended without a result (${how})`, false);
      },
    });
    this.#children.set(request.runId, stream.child);

    try {
      // A failure is held back until the process has closed. The CLI explains
      // itself on stderr and gives its verdict on stdout; those are separate
      // pipes, so the verdict can arrive first. The sink ends only on `close`,
      // after both pipes have ended, so by then the explanation is in. Nothing
      // but raw lines can follow a failure, so holding it reorders nothing.
      let heldFailure: Extract<AgentEvent, { type: 'failed' }> | null = null;
      let didWork = false;
      for await (const event of sink) {
        relieveBackPressure(stream.child, sink.pending);
        if (event.type === 'failed') {
          heldFailure = event;
          continue;
        }
        if (event.type === 'message' || event.type === 'tool.started' || event.type === 'file.changed') didWork = true;
        if (event.type === 'completed') this.#signedOut.delete(request.profile.id);
        yield event;
      }
      if (heldFailure !== null) yield this.#classifyFailure(heldFailure, request, {
        resumeSessionRef, sessionMissing, signedOutLine, didWork, configDir: childEnv['CLAUDE_CONFIG_DIR'] ?? null,
      });
    } finally {
      this.#children.delete(request.runId);
      stream.dispose();
    }
  }

  /** The environment a Claude Code child runs under, headless or interactive. */
  #env(request: RunRequest, configDir: string | null): NodeJS.ProcessEnv {
    return buildRuntimeEnv({
      allowedPrefixes: ['ANTHROPIC_', 'CLAUDE_'],
      allowedNames: ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'COLORTERM'],
      deniedNames: PARENT_SESSION_ENV,
      overrides: {
        ...(configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir }),
        // A tool call may legitimately block for as long as the run may live:
        // `ask_human` waits on a person. Claude Code's own MCP tool timeout is
        // an undocumented default we should not bet a worker's question on, so
        // it is pinned to the run's wall-time backstop. Verified that Claude
        // Code honours a blocking call across minutes, not only seconds.
        ...(request.maxWallTimeMs > 0 ? { MCP_TOOL_TIMEOUT: String(request.maxWallTimeMs) } : {}),
      },
    });
  }

  #handleLine(line: string, sink: NormalizingEventSink, mapper: ClaudeEventMapper): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not every stdout line is protocol: a wrapper script's banner, or an
      // npm warning, arrives here. Keep it for the raw log rather than failing.
      sink.raw('stdout', line);
      return;
    }
    for (const event of mapper.map(parsed)) sink.push(event);
  }

  /**
   * Replaces the CLI's own failure code with a canonical one when the cause is
   * something the caller should act on rather than count against the work.
   * Never over a cancellation or timeout: that verdict is about this run, and
   * the raw lines stay in the log either way.
   */
  #classifyFailure(
    failure: Extract<AgentEvent, { type: 'failed' }>,
    request: RunRequest,
    seen: {
      readonly resumeSessionRef: string | null;
      readonly sessionMissing: boolean;
      readonly signedOutLine: string | null;
      readonly didWork: boolean;
      readonly configDir: string | null;
    },
  ): AgentEvent {
    if (request.signal.aborted) return failure;

    // Only a run that failed before doing anything can have failed for want of
    // a login - Claude Code authenticates before its first turn. A run that
    // talked or used a tool got in; if sign-in words turn up afterwards they
    // came from the work (a login page under test, an MCP server's own error),
    // and treating them as a sign-out would refund a real failure forever.
    const signedOut = seen.didWork ? null : SIGNED_OUT.test(failure.message) ? failure.message : seen.signedOutLine;
    if (signedOut !== null) {
      const where = seen.configDir === null ? 'its default config directory' : seen.configDir;
      const detail = `Claude Code is signed out (${signedOut.trim()}). `
        + `Sign in again for ${where}; waiting work resumes on its own once it can run.`;
      this.#signedOut.set(request.profile.id, { detail, observedAtMs: this.#clock.epochMs() });
      return { type: 'failed', code: RUNTIME_SIGNED_OUT, message: detail, retryable: true };
    }
    if (seen.sessionMissing && seen.resumeSessionRef !== null) {
      return {
        type: 'failed',
        code: SESSION_NOT_FOUND,
        message: `Claude Code no longer has session ${seen.resumeSessionRef}.`,
        retryable: true,
      };
    }
    return failure;
  }

  #currentSignOut(profile: RuntimeProfile): string | null {
    const observed = this.#signedOut.get(profile.id);
    if (observed === undefined) return null;
    if (this.#clock.epochMs() - observed.observedAtMs > SIGNED_OUT_TTL_MS) {
      this.#signedOut.delete(profile.id);
      return null;
    }
    return observed.detail;
  }

  #recordQuota(detail: string): void {
    this.#quota = {
      detail,
      blocking: /rejected|exceeded/i.test(detail),
      observedAtMs: this.#clock.epochMs(),
    };
  }

  #currentQuota(): QuotaObservation | null {
    if (this.#quota === null) return null;
    if (this.#clock.epochMs() - this.#quota.observedAtMs > QUOTA_WARNING_TTL_MS) {
      this.#quota = null;
    }
    return this.#quota;
  }

  #health(
    profile: RuntimeProfile,
    state: RuntimeHealth['state'],
    version: string | null,
    detail: string,
  ): RuntimeHealth {
    return {
      profileId: profile.id,
      state,
      version,
      detail,
      checkedAt: this.#clock.now(),
      quotaWarning: this.#currentQuota()?.detail ?? null,
    };
  }

  #waitForExit(child: SupervisedChild, timeoutMs: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      child.once('close', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

function absoluteWorkingDirectory(dir: string): string {
  if (!isAbsolute(dir)) {
    throw TandemiseError.validation('RunRequest.workingDirectory must be absolute', { workingDirectory: dir });
  }
  return resolve(dir);
}
