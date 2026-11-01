export { RUNTIME_ADAPTERS, RUNTIME_SIGNED_OUT, SESSION_NOT_FOUND, describeAdapter } from './adapter.js';
export type { AgentRuntimeAdapter, InteractiveOptions, RunRequest, RunSkillRequest, RuntimeAdapterDescriptor, SkillResolution, SlotReservation, SlotRetention } from './adapter.js';

export { RuntimeRegistry, RUNTIME_REGISTRY } from './registry.js';

export { RuntimeManager, RUNTIME_MANAGER, DEFAULT_HEALTH_TTL_MS, RESERVATION_TTL_MS, onlyBusy, onlyWaiting, describeRejections } from './manager.js';
export type {
  RuntimeManagerOptions, RuntimeRejection, RuntimeSelection, RuntimeSelectionFailure,
} from './manager.js';

export { NormalizingEventSink } from './event-sink.js';
export type { NormalizingEventSinkOptions } from './event-sink.js';

export { normalizeAgentEvent, isTerminalEvent, MAX_SUMMARY_CHARS, MAX_TEXT_CHARS } from './normalize.js';

export { LineAssembler } from './line-assembler.js';

export {
  BACKPRESSURE_HIGH_WATER, BACKPRESSURE_LOW_WATER, relieveBackPressure, superviseProcessStream,
} from './process-stream.js';
export type {
  ProcessInputStream, ProcessOutputStream, ProcessStreamOptions, SupervisedChild, SupervisedStream,
} from './process-stream.js';

export {
  DEFAULT_TERMINATION_GRACE_MS, classifyAbort, escalateTerminationOnAbort, withWallTimeBudget,
} from './termination.js';
export type { AbortOutcome, Terminable } from './termination.js';

export { runtimesCoreModule, defineRuntimeModule, RUNTIMES_CORE_MODULE_NAME } from './module.js';
/** Re-exported so a runtime plugin can name its module type without depending on the kernel. */
export type { TandemiseModule } from '@tandemise/kernel';
export { withDeclaredCapabilities } from './capabilities.js';
export { BASE_RUNTIME_ENV, buildRuntimeEnv, withheldEnvNames } from './runtime-env.js';
export type { RuntimeEnvOptions } from './runtime-env.js';
export { DISPLAY_ENV, agentDisplaySetting, agentEnvPlan, agentHome, onPath, workerEnv } from './agent-env.js';
export { FORGE_TOKEN_ENV, GIT_CREDENTIAL_ENV, applyForgeIsolation, forgeIsolation, personGhConfigDir } from './forge-isolation.js';
export type { ForgeIsolation } from './forge-isolation.js';
export type { AgentDisplay, AgentEnvPlan } from './agent-env.js';
