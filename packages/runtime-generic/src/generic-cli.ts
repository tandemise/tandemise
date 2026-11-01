import { execFile, spawn } from 'node:child_process';
import { workerEnv } from '@tandemise/runtimes-core';
import { promisify } from 'node:util';
import type {
  AgentEvent, AgentEventType, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile,
} from '@tandemise/domain';
import { SKILLS_FOLDER } from '@tandemise/domain';
import {
  DEFAULT_TERMINATION_GRACE_MS, NormalizingEventSink, relieveBackPressure, superviseProcessStream, withDeclaredCapabilities,
} from '@tandemise/runtimes-core';
import type { AgentRuntimeAdapter, RunRequest, SupervisedChild } from '@tandemise/runtimes-core';
import { systemClock } from '@tandemise/shared';
import type { Clock, RunId } from '@tandemise/shared';
import { PROMPT_PLACEHOLDER, parseGenericCliSettings, substitute } from './generic-settings.js';
import type { GenericCliSettings, GenericEventMap } from './generic-settings.js';

const run = promisify(execFile);

export const GENERIC_CLI_ADAPTER_ID = 'generic-cli';
export const GENERIC_COMMAND_ENV = 'TANDEMISE_GENERIC_COMMAND';
const VERSION_PROBE_TIMEOUT_MS = 10_000;

export interface GenericCliAdapterOptions {
  readonly clock?: Clock;
  readonly terminationGraceMs?: number;
}

/**
 * Runs any CLI that takes a task and prints its progress (MVP.md §10.2).
 *
 * This is the answer to "Tandemise only supports two runtimes". Codex CLI,
 * Gemini CLI, opencode, cursor-agent and whatever ships next month are wired by
 * filling in a profile's settings - command, argv template, how the prompt is
 * delivered, and how to read the output - with no new code and no release. The
 * price is honesty about capability: a configured runtime advertises only what
 * its profile claims, because nothing here can verify more than that.
 */
export class GenericCliAdapter implements AgentRuntimeAdapter {
  readonly id = GENERIC_CLI_ADAPTER_ID;
  readonly displayName = 'Generic CLI';
  readonly baseCapabilities: readonly RuntimeCapability[] = ['reasoning', 'tool_calling'];

  readonly #children = new Map<RunId, SupervisedChild>();
  readonly #clock: Clock;
  readonly #graceMs: number;

  constructor(options: GenericCliAdapterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#graceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  /**
   * There is nothing to auto-detect: this adapter *is* whatever it is pointed
   * at. It reports `detected: false` with an explanation rather than an error,
   * so onboarding can list it as "available, needs configuration" alongside the
   * runtimes it did find.
   */
  async discover(): Promise<RuntimeDiscovery> {
    const configured = process.env[GENERIC_COMMAND_ENV];
    const base = { adapterId: this.id, displayName: this.displayName, capabilities: this.baseCapabilities };
    if (configured === undefined || configured.length === 0) {
      return {
        ...base,
        detected: false,
        executablePath: null,
        version: null,
        capabilities: [],
        detail: `No command configured. Set a profile's \`command\` setting (or ${GENERIC_COMMAND_ENV}) to wire any agent CLI.`,
        suggestedSettings: { promptVia: 'arg', outputFormat: 'text', args: [PROMPT_PLACEHOLDER] },
      };
    }
    const version = await this.#probeVersion(configured, ['--version']);
    return {
      ...base,
      detected: true,
      executablePath: configured,
      version,
      detail: `Configured via ${GENERIC_COMMAND_ENV}: ${configured}`,
      suggestedSettings: { command: configured, promptVia: 'arg', outputFormat: 'text', args: [PROMPT_PLACEHOLDER] },
    };
  }

  async healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth> {
    const parsed = parseGenericCliSettings(profile.settings);
    if (!parsed.ok) return this.#health(profile, 'unavailable', null, parsed.error.message);

    const { command, versionArgs } = parsed.value;
    if (versionArgs.length === 0) {
      // Not every CLI has a cheap liveness probe; saying "unknown" is more
      // honest than claiming health from a configuration file.
      return this.#health(profile, 'unknown', null, `No versionArgs configured for '${command}'`);
    }
    const version = await this.#probeVersion(command, versionArgs);
    return version === null
      ? this.#health(profile, 'unavailable', null, `'${command} ${versionArgs.join(' ')}' did not respond`)
      : this.#health(profile, 'healthy', version, `${command} (${version})`);
  }

  /** Only a profile that names its CLI's model flag can be given a model (P12). */
  acceptsModel(profile: RuntimeProfile): boolean {
    const parsed = parseGenericCliSettings(profile.settings);
    return parsed.ok && parsed.value.modelFlag !== null;
  }

  /** Only a profile whose settings say its CLI reads `.claude/skills` gets skills as a folder (P13). */
  skillsFolder(profile: RuntimeProfile): string | null {
    return profile.settings['skillsFolder'] === true ? SKILLS_FOLDER : null;
  }

  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[] {
    const parsed = parseGenericCliSettings(profile.settings);
    return withDeclaredCapabilities(profile, parsed.ok ? parsed.value.capabilities : [], this.baseCapabilities);
  }

  start(request: RunRequest): AsyncIterable<AgentEvent> {
    return this.#run(request);
  }

  pid(runId: RunId): number | null {
    return this.#children.get(runId)?.pid ?? null;
  }

  async cancel(runId: RunId): Promise<void> {
    const child = this.#children.get(runId);
    if (child === undefined || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, this.#graceMs);
    force.unref();
  }

  async *#run(request: RunRequest): AsyncIterable<AgentEvent> {
    const log = request.log.child({ runId: request.runId, runtime: this.id });
    const sink = new NormalizingEventSink({ log, onInvalid: 'raw' });
    const parsed = parseGenericCliSettings(request.profile.settings);
    if (!parsed.ok) {
      sink.fail('VALIDATION', parsed.error.message, false);
      sink.close();
      yield* sink;
      return;
    }
    const settings = parsed.value;
    const { args, stdin } = buildArgv(settings, request);

    const stream = superviseProcessStream({
      spawn: () => spawn(settings.command, args, {
        cwd: request.workingDirectory,
        // Inherited on purpose: a configured CLI authenticates through the
        // user's own environment, exactly as Claude Code does (MVP.md §10.3).
        env: workerEnv(request),
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      describe: settings.command,
      stdin,
      signal: request.signal,
      maxWallTimeMs: request.maxWallTimeMs,
      graceMs: this.#graceMs,
      sink,
      log,
      onStdoutLine: (line) => this.#handleLine(line, settings, sink),
      onExit: (exitCode) => {
        // Reached only when the runtime produced no verdict of its own. A
        // configured CLI usually has none - the process exit *is* the result,
        // which is what makes the plain-text case usable at all - but one whose
        // output maps onto `completed`/`failed` has already spoken, and
        // `spawnStream` skips this callback in that case.
        if (exitCode === 0) sink.complete();
        else sink.fail('RUNTIME_FAILED', `'${settings.command}' exited with code ${exitCode}`, false);
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

  #handleLine(line: string, settings: GenericCliSettings, sink: NormalizingEventSink): void {
    if (settings.outputFormat === 'text') {
      // A text-mode CLI's stdout *is* its message; routing it through `raw`
      // would leave the semantic timeline empty for every such runtime.
      sink.push({ type: 'message', text: line });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sink.raw('stdout', line);
      return;
    }
    const translated = translate(parsed, settings.eventMap);
    if (translated === 'ignore') return;
    if (translated === null) {
      sink.raw('stdout', line);
      return;
    }
    sink.push(translated);
  }

  async #probeVersion(command: string, args: readonly string[]): Promise<string | null> {
    try {
      const { stdout, stderr } = await run(command, [...args], {
        timeout: VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      const text = `${stdout}${stderr}`.trim();
      return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text)?.[1] ?? (text.length > 0 ? text.split('\n')[0] ?? null : null);
    } catch {
      return null;
    }
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

/**
 * Expands the argv template. When `promptVia` is `arg` and the template does
 * not mention `{{prompt}}`, the prompt is appended - the common shape for a CLI
 * whose task is its final positional argument.
 */
export function buildArgv(
  settings: GenericCliSettings,
  request: RunRequest,
): { args: string[]; stdin: string | null } {
  const viaStdin = settings.promptVia === 'stdin';
  const values: Record<string, string> = { cwd: request.workingDirectory };
  if (!viaStdin) values['prompt'] = request.prompt;

  const args = settings.args.map((a) => substitute(a, values));
  // P12: the run's model, only when the profile says how to pass one. The
  // profile's own `model` is the fallback for a caller from before P12.
  const model = request.model !== undefined
    ? request.model
    : typeof request.profile.settings['model'] === 'string' ? request.profile.settings['model'] : null;
  if (settings.modelFlag !== null && model !== null && model.length > 0) args.push(settings.modelFlag, model);
  const mentionsPrompt = settings.args.some((a) => a.includes(PROMPT_PLACEHOLDER));
  if (!viaStdin && !mentionsPrompt) args.push(request.prompt);
  return { args, stdin: viaStdin ? request.prompt : null };
}

/**
 * Reads one NDJSON record as a candidate `AgentEvent`.
 *
 * Returns `'ignore'` for a record the configuration says to drop and `null` for
 * one it does not describe; the caller keeps the latter in the raw log rather
 * than guessing. Validation is left to `NormalizingEventSink`, so a mistaken
 * field name degrades a line to raw output instead of failing the run.
 */
export function translate(
  record: unknown,
  map: GenericEventMap,
): Record<string, unknown> | 'ignore' | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  const rawType = r[map.typeField];
  if (typeof rawType !== 'string') return null;

  const configured = map.types[rawType];
  const target: AgentEventType | 'ignore' | undefined = configured ?? asCanonicalType(rawType);
  if (target === 'ignore') return 'ignore';
  if (target === undefined) return null;

  const text = r[map.textField];
  const session = r[map.sessionField];

  switch (target) {
    case 'message':
    case 'thinking_summary':
      return { type: target, text };
    case 'tool.started':
      return { type: target, tool: r[map.toolField], inputSummary: r['input'] ?? r['inputSummary'] ?? '' };
    case 'tool.completed':
      return {
        type: target,
        tool: r[map.toolField],
        outcome: r[map.outcomeField] ?? 'ok',
        outputSummary: r['output'] ?? r['outputSummary'],
      };
    case 'file.changed':
      return { type: target, path: r[map.pathField], change: r['change'] ?? 'edit' };
    case 'artifact.created':
      return { type: target, artifactId: r['artifactId'] ?? r['artifact_id'] };
    case 'approval.requested':
      return { type: target, approvalId: r['approvalId'] ?? r['approval_id'] };
    case 'usage':
      return {
        type: target,
        inputTokens: r['inputTokens'] ?? r['input_tokens'],
        outputTokens: r['outputTokens'] ?? r['output_tokens'],
        cacheReadTokens: r['cacheReadTokens'] ?? r['cache_read_input_tokens'],
        cacheWriteTokens: r['cacheWriteTokens'] ?? r['cache_creation_input_tokens'],
        costUsd: r['costUsd'] ?? r['cost_usd'] ?? null,
        wallTimeMs: r['wallTimeMs'] ?? r['duration_ms'],
      };
    // The canonical field name is tried first on these two: a CLI that already
    // speaks the vocabulary needs no mapping entry, and reading only the
    // configured alias would silently drop what it did say.
    case 'checkpoint':
      return { type: target, externalSessionId: r['externalSessionId'] ?? session, label: r['label'] };
    case 'completed':
      return { type: target, resultRef: r['resultRef'] ?? session, summary: r['summary'] ?? text ?? r['result'] };
    case 'failed':
      return {
        type: target,
        code: r['code'] ?? 'RUNTIME_FAILED',
        message: r['message'] ?? text ?? 'Runtime reported a failure',
        retryable: r['retryable'] === true,
      };
    default:
      return null;
  }
}

const PASS_THROUGH_TYPES: ReadonlySet<string> = new Set<AgentEventType>([
  'message', 'thinking_summary', 'tool.started', 'tool.completed', 'file.changed',
  'artifact.created', 'approval.requested', 'usage', 'checkpoint', 'completed', 'failed',
]);

/** A CLI already speaking the canonical vocabulary needs no mapping entry. */
function asCanonicalType(rawType: string): AgentEventType | undefined {
  return PASS_THROUGH_TYPES.has(rawType) ? (rawType as AgentEventType) : undefined;
}
