import { join } from 'node:path';
import { Container, LifecycleHost, compose, token, type Token } from '@tandemise/kernel';
import { adjustableClock, createLogger, systemClock, type AdjustableClock, type Clock, type Logger } from '@tandemise/shared';
import type { EventBusPort, ProjectionBusPort } from '@tandemise/domain';

// The composition root is the single place in Tandemise that is allowed to name
// a concrete provider. Everything below this line is an implementation detail
// the rest of the system never learns (MVP.md §6.1, §26.1).
import { persistenceModule } from '@tandemise/persistence';
import * as persistenceTokens from '@tandemise/persistence';
import {
  createArtifactsModule, ARTIFACT_STORE as ARTIFACTS_STORE_TOKEN,
  renderArtifactTemplate, parseArtifact, measureArtifact, deriveHandoff, splitAppendix,
  FileEvalBlobs,
} from '@tandemise/artifacts';
import { policyModule } from '@tandemise/policy';
import { contextModule } from '@tandemise/context';
import { createEvaluationModule } from '@tandemise/evaluation';
import { runtimesCoreModule } from '@tandemise/runtimes-core';
import { claudeRuntimeModule } from '@tandemise/runtime-claude';
import { codexRuntimeModule } from '@tandemise/runtime-codex';
import { genericRuntimeModule } from '@tandemise/runtime-generic';
import {
  executionCoreModule, PROCESS_SUPERVISOR,
  CLOCK as EXECUTION_CLOCK, LOGGER as EXECUTION_LOGGER, PATHS as EXECUTION_PATHS,
} from '@tandemise/execution-core';
import { GitBrainRepo, executionLocalModule } from '@tandemise/execution-local';
import {
  integrationsCoreModule,
  BACKGROUND_PROCESS_LAUNCHER, COMMAND_EXECUTOR as TOOL_COMMAND_EXECUTOR,
} from '@tandemise/integrations-core';
import { GhBrainHost, GhIssueTracker, GhPullRequestFlow, GhPullRequestSnapshots, githubIntegrationModule } from '@tandemise/integration-github';
import { mcpIntegrationModule } from '@tandemise/integration-mcp';
import { youtrackIntegrationModule } from '@tandemise/integration-youtrack';
import { intakeRunnersModule } from '@tandemise/intake-runners';
import { browserIntegrationModule } from '@tandemise/browser';
import { terminalModule, TERMINAL_HOST } from '@tandemise/terminal';
import { createApplicationModule, createServices, EVAL_RUNNER, SCHEDULER, type TandemiseServices,
  WORKFLOW_SOURCE,
  LOCAL_FACTORY_CONFIG_SOURCE,
  SKILL_FILES,
  ISSUE_TRACKER,
  PULL_REQUEST_SNAPSHOTS, PULL_REQUEST_FLOW, GIT_CREDENTIAL_ENV, pickGitCredentialEnv,
  SETUP_FOLDER,
  EVAL_BLOBS,
  INTAKE_BLOBS,
} from '@tandemise/application';
import * as applicationTokens from '@tandemise/application';

import { SCHEMA_VERSION } from '@tandemise/persistence';
import type { DaemonConfig } from './config.js';
import { InMemoryEventBus, InMemoryProjectionBus } from './buses.js';
import { createSecretStore } from './secrets.js';
import { createSettingsStore, createSystemEnvironment, processLiveness } from './platform.js';
import { createBackgroundProcessLauncher, createToolCommandExecutor } from './tool-exec.js';
import { oauthCallbacks } from './oauth-callback.js';
import { FileSetupFolder } from './setup-folder.js';
import { FileWorkflowSource } from './workflow-source.js';
import { FileFactoryConfigSource } from './factory-config-source.js';
import { DaemonSkillFiles } from './skill-files.js';
import { startWebhookListener, type WebhookListener } from './http/webhook-listener.js';
import { SwitchableCoordination, type RelayFactory } from './coordination.js';
import type { SqlHandle } from '@tandemise/coordination';
import { relayFactory } from '@tandemise/coordination-relay';

export const CLOCK = token<Clock>('Clock');
export const LOGGER = token<Logger>('Logger');
export const EVENT_BUS = token<EventBusPort>('EventBusPort');
export const PROJECTION_BUS = token<ProjectionBusPort>('ProjectionBusPort');
export const CONFIG = token<DaemonConfig>('DaemonConfig');
/** The daemon's coordination switch (relay spec): local, or a team relay, swapped in place. */
export const COORDINATION_SWITCH = token<SwitchableCoordination>('daemon.Coordination');

export interface Bootstrapped {
  readonly container: Container;
  readonly services: TandemiseServices;
  readonly lifecycle: LifecycleHost;
  readonly events: EventBusPort;
  readonly projections: ProjectionBusPort;
  /** The test clock, only when TANDEMISE_CLOCK_OFFSET_MS is set; null otherwise. */
  readonly testClock: AdjustableClock | null;
  readonly log: Logger;
}

/**
 * Wires the application.
 *
 * Module order is the dependency order: infrastructure, then contracts, then
 * providers, then the mission engine. `compose` honours each module's declared
 * `requires`, so this list is a readable manifest rather than a fragile
 * sequence - and adding a capability really is one more entry here.
 */
export function bootstrap(config: DaemonConfig, options: { readonly localPersonName?: string; readonly relayFactory?: RelayFactory | null } = {}): Bootstrapped {
  const log = createLogger({ level: config.logLevel, base: { component: 'daemon' } });
  const container = new Container();
  const events = new InMemoryEventBus();
  const projections = new InMemoryProjectionBus();

  container.bindValue(CONFIG, config, { source: 'bootstrap' });
  container.bindValue(LOGGER, log, { source: 'bootstrap' });
  // One clock for everything that reads time; shifted only under the test knob.
  const testClock = config.clockOffsetMs === null ? null : adjustableClock(config.clockOffsetMs);
  const clock: Clock = testClock ?? systemClock;
  container.bindValue(CLOCK, clock, { source: 'bootstrap' });
  container.bindValue(EVENT_BUS, events, { source: 'bootstrap' });
  container.bindValue(PROJECTION_BUS, projections, { source: 'bootstrap' });

  compose(
    container,
    persistenceModule({ path: config.paths.db, logger: log.child({ component: 'persistence' }), clock }),
    createArtifactsModule({ paths: config.paths }),
    policyModule,
    contextModule,
    createEvaluationModule(),
    runtimesCoreModule,
    claudeRuntimeModule,
    codexRuntimeModule,
    genericRuntimeModule,
    executionCoreModule,
    executionLocalModule,
    integrationsCoreModule,
    githubIntegrationModule,
    youtrackIntegrationModule,
    intakeRunnersModule,
    mcpIntegrationModule,
    browserIntegrationModule,
    terminalModule,
    // The name reaches a fresh database's first person; this layer may run git, the application may not.
    createApplicationModule({
      ...(options.localPersonName === undefined ? {} : { localPersonName: options.localPersonName }),
      quietAfterMs: config.quietMs,
      ...(process.env['TANDEMISE_SHIP_POLL_MS'] === undefined ? {} : { shipPollMs: Number(process.env['TANDEMISE_SHIP_POLL_MS']) }),
      ...(process.env['TANDEMISE_SHIP_CI_GRACE_MS'] === undefined ? {} : { shipCiGraceMs: Number(process.env['TANDEMISE_SHIP_CI_GRACE_MS']) }),
    }),
  );

  aliasPorts(container, log);

  // `execution-core` declares its own Clock/Logger/Paths tokens because no
  // lower-layer package owns them. They are distinct token objects from the
  // ones bound above - identity, not description, is what a container keys on -
  // so without these three lines git and the execution targets log into
  // `nullLogger` and resolve paths from `~/.tandemise` instead of this
  // daemon's configured home. Those agree by default and diverge the moment a
  // test or a second instance overrides the home.
  container.bind(EXECUTION_LOGGER, (r) => r.resolve(LOGGER), { source: 'bootstrap' });
  container.bind(EXECUTION_CLOCK, (r) => r.resolve(CLOCK), { source: 'bootstrap' });
  container.bind(EXECUTION_PATHS, (r) => r.resolve(CONFIG).paths, { source: 'bootstrap' });

  // `integrations-core` is a core package and cannot spawn a process itself, so
  // it declares these ports and gets them here. Routing tool execution through
  // the same supervisor a worker run uses is what gives every tool call an
  // allowlisted environment, a tracked pid, and no orphan on shutdown - and it
  // is what lets an integration report real health instead of `unknown`.
  container.bind(TOOL_COMMAND_EXECUTOR, (r) =>
    createToolCommandExecutor(r.resolve(PROCESS_SUPERVISOR), r.resolve(LOGGER).child({ component: 'tool-exec' })),
    { source: 'bootstrap' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, (r) =>
    createBackgroundProcessLauncher(r.resolve(PROCESS_SUPERVISOR)), { source: 'bootstrap' });

  // Workflows are files in the user's own repositories, so reading them is an
  // adapter concern and belongs here rather than in the engine.
  // Rebound rather than bound: the application module ships a source that finds
  // nothing, so a container without a filesystem still resolves.
  container.rebind(WORKFLOW_SOURCE, (r) =>
    new FileWorkflowSource(r.resolve(LOGGER).child({ component: 'workflows' })), { source: 'bootstrap' });
  // The factory's planner, routing and merge files (#53): the same reasoning.
  container.rebind(LOCAL_FACTORY_CONFIG_SOURCE, (r) =>
    new FileFactoryConfigSource(join(r.resolve(CONFIG).home, 'factory')), { source: 'bootstrap' });
  // The project's setup as files (P15): the same reasoning, for `.tandemise/`.
  container.rebind(SETUP_FOLDER, (r) =>
    new FileSetupFolder(r.resolve(LOGGER).child({ component: 'setup' })), { source: 'bootstrap' });

  // Skills (P13) are the person's folders and git repositories, read by the
  // daemon; the application only ever sees bytes and hashes.
  container.rebind(SKILL_FILES, (r) =>
    new DaemonSkillFiles(config.paths.skills, config.skillsDiscoverRoot, r.resolve(LOGGER).child({ component: 'skills' }), config.claudeConfigDir), { source: 'bootstrap' });

  // Eval case inputs (P3b) are content-addressed bytes on disk, the same shape as the skills store.
  // The application module binds an in-memory default; this replaces it with the real one.
  container.rebind(EVAL_BLOBS, () => new FileEvalBlobs(config.paths.evalBlobs), { source: 'bootstrap' });
  // Inline attachments of intake signals (spec 2026-10-30-intake-design.md §1), the same content-addressed shape on disk.
  container.rebind(INTAKE_BLOBS, () => new FileEvalBlobs(config.paths.intakeBlobs), { source: 'bootstrap' });

  // GitHub issues (P14) go through the same `gh` and command executor as the
  // GitHub tools, so `gh` is found on the daemon's own PATH.
  container.rebind(ISSUE_TRACKER, (r) => new GhIssueTracker(r.resolve(TOOL_COMMAND_EXECUTOR)), { source: 'bootstrap' });
  // A handed-back pull request (P3) is read the same way.
  container.rebind(PULL_REQUEST_SNAPSHOTS, (r) => new GhPullRequestSnapshots(r.resolve(TOOL_COMMAND_EXECUTOR)), { source: 'bootstrap' });
  // The ship step's pull requests (#53 §8), through the person's own `gh` session.
  container.rebind(PULL_REQUEST_FLOW, (r) => new GhPullRequestFlow(r.resolve(TOOL_COMMAND_EXECUTOR)), { source: 'bootstrap' });
  // Fetching that pull request's head is the person's own git reaching their
  // remote, so it may use their ssh-agent or askpass helper. Given to that
  // fetch alone, read when it runs; the tool runner's allowlist stays as it is.
  container.bind(GIT_CREDENTIAL_ENV, () => () => pickGitCredentialEnv(process.env), { source: 'bootstrap' });
  // The brain (#51): git with the person's credential variables (and their own
  // git config location, when they moved it), and gh for repositories and PRs.
  container.rebind(applicationTokens.BRAIN_REPO, (r) => new GitBrainRepo(r.resolve(PROCESS_SUPERVISOR), log.child({ component: 'brain-git' }), () => ({
    ...pickGitCredentialEnv(process.env),
    ...(process.env['GIT_CONFIG_GLOBAL'] === undefined ? {} : { GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'] }),
  })), { source: 'bootstrap' });
  // The reflector's evidence: a task's changes since its last commit, untracked files included when added.
  container.bind(applicationTokens.BRAIN_WORKTREE_DIFF, (r) => async (directory: string) => {
    const supervisor = r.resolve(PROCESS_SUPERVISOR);
    const run = (args: string[]) => supervisor.run({ command: 'git', args: ['--no-pager', ...args], cwd: directory, env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 30_000, label: 'brain diff' });
    const head = await run(['diff', 'HEAD']);
    return head.exitCode === 0 ? head.stdout : (await run(['diff'])).stdout;
  }, { source: 'bootstrap' });
  container.rebind(applicationTokens.BRAIN_HOST, (r) => new GhBrainHost(r.resolve(TOOL_COMMAND_EXECUTOR)), { source: 'bootstrap' });

  // Who works on what with the team (relay spec): one switch, bound to both
  // coordination ports, over the persistence database's own handle.
  container.bind(COORDINATION_SWITCH, (r) => new SwitchableCoordination({
    db: r.resolve(persistenceTokens.DATABASE).handle as unknown as SqlHandle,
    settings: r.resolve(applicationTokens.SETTINGS_STORE),
    secrets: r.resolve(applicationTokens.SECRET_STORE),
    clock,
    log,
    localName: options.localPersonName ?? 'You',
    // The relay client is a provider: bootstrap is the one place that names it.
    relayFactory: options.relayFactory === undefined ? relayFactory : options.relayFactory,
    setRelayHandle: (handle) => {
      const me = r.resolve(applicationTokens.IDENTITY).localPerson();
      const handles: Record<string, string> = { ...me.handles };
      if (handle === null) delete handles['relay'];
      else handles['relay'] = handle;
      r.resolve(applicationTokens.PERSON_REPOSITORY).update(me.id, { handles });
    },
  }), { source: 'bootstrap' });
  container.bind(applicationTokens.COORDINATION, (r) => r.resolve(COORDINATION_SWITCH), { source: 'bootstrap' });
  container.bind(applicationTokens.COORDINATION_CONTROL, (r) => r.resolve(COORDINATION_SWITCH), { source: 'bootstrap' });

  const services = createServices(container);

  const lifecycle = new LifecycleHost(log);
  // Without this the tick loop never runs: the scheduler would only advance
  // when an API call happened to wake it, so a mission would climb about one
  // DAG level per request and then sit still. Registering it here is also what
  // gives shutdown its ordering - `stop()` aborts in-flight runs before the
  // database and process supervisor are disposed.
  lifecycle.add(container.resolve(SCHEDULER));
  // Added after the scheduler, so shutdown stops the runner first; its live trial is left for boot recovery (P3b).
  lifecycle.add(container.resolve(EVAL_RUNNER));
  // The intake runners (plan Task 10): shutdown stops every poll and socket runner.
  lifecycle.add(container.resolve(applicationTokens.INTAKE_RUNNER_HOST));
  // The opt-in webhook listener (intake plan Task 11): only when the local
  // settings name its port. Added last, so shutdown closes it first.
  const webhookPort = intakeWebhookPort(container.resolve(applicationTokens.SETTINGS_STORE).read());
  if (webhookPort !== null) {
    let listener: WebhookListener | null = null;
    lifecycle.add({
      name: 'webhook-listener',
      start: async () => {
        listener = await startWebhookListener({
          port: webhookPort,
          mailbox: container.resolve(applicationTokens.WEBHOOK_MAILBOX),
          log: log.child({ component: 'webhook-listener' }),
          // Ruling 24: only a project on this computer that configures the source; anything else is a 404, stored nowhere.
          accepts: (workspaceId, sourceId) => container.resolve(applicationTokens.WORKSPACE_REPOSITORY).get(workspaceId) !== undefined
            && container.resolve(applicationTokens.INTAKE_CONFIG_SOURCE).read(workspaceId).sources.some((s) => s.id === sourceId),
          clock,
        });
      },
      stop: async () => { await listener?.close(); },
    });
  }
  lifecycle.add(container.resolve(applicationTokens.BRAIN_SYNC_LOOP));
  lifecycle.add(container.resolve(applicationTokens.BRAIN_SIGNALS));
  // Holds ending (#50) become outcomes for routing (#53).
  lifecycle.add(container.resolve(applicationTokens.OUTCOME_RECORDER));

  return { container, services, lifecycle, events, projections, log, testClock };
}

/**
 * Binds the application's port tokens to the concrete providers.
 *
 * `@tandemise/application` cannot import `@tandemise/persistence` - that would
 * point a dependency arrow outward - so it declares its own tokens for the ports
 * it needs. Here, where naming providers is allowed, the two are joined. Doing
 * it by name keeps the alias honest: a token added on either side without a
 * counterpart shows up immediately in the diagnostics table rather than as a
 * missing-binding error at the first request.
 */
function aliasPorts(container: Container, log: Logger): void {
  const aliased: string[] = [];
  const missing: string[] = [];

  // Both sides are erased to `Token<unknown>` deliberately. The alias is
  // type-safe by construction rather than by declaration: the two tokens carry
  // the same exported name, and the port interface they are parameterised with
  // is literally the same type imported from `@tandemise/domain`. Enumerating
  // fifty pairs explicitly to satisfy the compiler would add fifty places to
  // forget one.
  const appTokens = applicationTokens as Record<string, unknown>;
  const providerTokens = persistenceTokens as Record<string, unknown>;

  for (const name of Object.keys(appTokens)) {
    const appToken = appTokens[name];
    const provider = providerTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
    aliased.push(name);
  }

  // The remaining ports have no persistence counterpart to match by name, so
  // they are bound explicitly. Each one is a provider the application layer is
  // forbidden to import directly.
  const appArtifactStore = appTokens['ARTIFACT_STORE'];
  if (isToken(appArtifactStore) && !container.has(appArtifactStore)) {
    container.bind(appArtifactStore, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias:ARTIFACT_STORE' });
    aliased.push('ARTIFACT_STORE');
  }
  const bindDirect = (name: string, factory: (r: import('@tandemise/kernel').Resolver) => unknown): void => {
    const t = appTokens[name];
    if (!isToken(t)) { missing.push(name); return; }
    if (container.has(t)) return;
    container.bind(t as Token<unknown>, factory, { source: `bind:${name}` });
    aliased.push(name);
  };

  bindDirect('ARTIFACT_TEMPLATES', () => ({ render: renderArtifactTemplate }));
  bindDirect('ARTIFACT_PARSER', () => ({ parse: parseArtifact }));
  bindDirect('ARTIFACT_MEASURE', () => ({ measure: measureArtifact, deriveHandoff, splitAppendix }));
  bindDirect('EVENT_BUS', (r) => r.resolve(EVENT_BUS));
  bindDirect('PROJECTION_BUS', (r) => r.resolve(PROJECTION_BUS));
  bindDirect('SECRET_STORE', (r) => createSecretStore({ home: r.resolve(CONFIG).home, log }));
  bindDirect('SETTINGS_STORE', (r) => createSettingsStore(r.resolve(CONFIG).home, log));
  bindDirect('SYSTEM_ENVIRONMENT', (r) => createSystemEnvironment(r.resolve(CONFIG), SCHEMA_VERSION));
  bindDirect('PROCESS_LIVENESS', () => processLiveness);
  bindDirect('OAUTH_CALLBACK', () => oauthCallbacks);
  // The hold service and the terminal socket must share one PTY host: the
  // service opens the sessions the socket's windows attach to.
  bindDirect('INTERACTIVE_SESSIONS', (r) => r.resolve(TERMINAL_HOST));

  log.debug('bootstrap.ports_bound', { aliased, missing });
}

/** `intakeWebhookPort` from the local settings: a port number, or null (no listener). */
function intakeWebhookPort(settings: Record<string, unknown>): number | null {
  const port = settings['intakeWebhookPort'];
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : null;
}

function isToken(value: unknown): value is Token<unknown> {
  return typeof value === 'object' && value !== null && 'description' in value
    && typeof (value as { description: unknown }).description === 'string';
}
