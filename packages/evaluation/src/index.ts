export { checkSpecsFor, createCommandCheckRunner, formatBudget } from './checks.js';
export type {
  CheckContext, CheckRunnerPort, CheckSpec, CommandCheckRunnerOptions, CommandExecutor, CommandOutcome,
} from './checks.js';

export { approvalFactName, GATE_FACT_VOCABULARY, GateFactBuilder } from './facts.js';
export type { FactDefinition } from './facts.js';

export { evaluateNamedGate, factsRequiredBy, isQualityGateName, QUALITY_GATES } from './gates.js';
export type { QualityGate, QualityGateName } from './gates.js';

export { CHECK_RUNNER, COMMAND_EXECUTOR, createEvaluationModule, evaluationModule } from './module.js';
export type { EvaluationModuleOptions } from './module.js';

export { scoreEvalRun, summarizeRunScores, trialScoreFrom } from './scorecard.js';
export type { RoleModelSummary, Scorecard, ScorecardDifference, ScoredTrial, VariantScore } from './scorecard.js';
