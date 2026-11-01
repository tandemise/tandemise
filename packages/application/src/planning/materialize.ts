import type { MissionId, Clock, RepositoryId } from '@tandemise/shared';
import { TandemiseError, ids } from '@tandemise/shared';
import type { ArtifactHandoff, MissionPlan, MissionTask, PlannedTask, Repository, SkillPin } from '@tandemise/domain';
import { DEFAULT_RETRY_POLICY, NO_APPROVAL, outputTypeLabel, planGateProblems } from '@tandemise/domain';
import { COVERED_PREFIX } from '../support/outside-work.js';

/**
 * Turns an accepted plan into the task rows the scheduler runs.
 *
 * A task with no dependencies starts READY and everything else starts PENDING,
 * so the DAG's entry points are a property of the data rather than something
 * the first tick has to work out. `orderHint` preserves the planner's own
 * ordering, which is the tie-break the UI and the dispatcher both use - without
 * it two independent tasks would render in a different order on every refresh.
 */
export function materializePlan(
  plan: MissionPlan,
  missionId: MissionId,
  clock: Clock,
  repositories: readonly Repository[] = [],
  options: MaterializeOptions = {},
): readonly MissionTask[] {
  // The last door before the scheduler (P15): whatever path a plan took - a
  // workflow, a planner, a preset, a person's edit - a gate that could never
  // pass is refused here rather than discovered after the step has run.
  const problems = planGateProblems(plan.tasks);
  if (problems.length > 0) {
    throw TandemiseError.validation(
      `The plan has a gate that can never pass. ${problems.map((p) => p.message).join(' ')}`,
      { issues: problems.map((p) => p.message) },
    );
  }
  const now = clock.now();
  // Matched case-insensitively: a plan author writing `Beveloce-Web` means the
  // same repository as `beveloce-web`, and failing over capitalisation would be
  // a needless way to lose a plan.
  const byName = new Map(repositories.map((r) => [r.name.toLowerCase(), r.id]));
  const inferred = options.inferInputs === true ? withInferredInputs(plan.tasks, options.upstream) : plan.tasks;
  const placeholders = skippedPlaceholders(plan, inferred, options.uploadFilename);
  const tasks = withPlaceholderDependencies(inferred, placeholders);
  // The placeholders come first: they are upstream of whatever reads their type.
  const skipped = placeholders.map(({ task, reason }, index) => ({
    ...fromPlanned(task, missionId, index, now, byName),
    status: 'SKIPPED' as const,
    statusReason: reason,
    finishedAt: now,
  }));
  return [...skipped, ...tasks.map((task, index) => {
    const made = fromPlanned(task, missionId, skipped.length + index, now, byName);
    // P13: the pins are resolved now, so `latest` means the newest version when the task was created.
    return options.skills === undefined ? made : { ...made, skills: options.skills(task) };
  })];
}

/**
 * One `SKIPPED` task per stage the planner left out because an upload covers
 * it (spec A2). There is no stored plan JSON, so this row is the skip's only
 * record: it carries the stage's output type, which makes it the producer the
 * graph needs, and says whose upload stands in for the work.
 */
function skippedPlaceholders(
  plan: MissionPlan,
  tasks: readonly PlannedTask[],
  uploadFilename: ((artifactId: string) => string | undefined) | undefined,
): readonly { readonly task: PlannedTask; readonly reason: string }[] {
  const taken = new Set(tasks.map((t) => t.key));
  return (plan.skipped ?? []).map((skip) => {
    const key = uniqueKey(skip.stage, taken);
    taken.add(key);
    const filename = uploadFilename?.(skip.artifactId) ?? skip.artifactId;
    return {
      reason: `${COVERED_PREFIX} ${filename}`,
      task: {
        key,
        // A plain human name for the stage - "Spec", not the planner's raw role
        // id and not the "(covered by your upload)" phrase the Plan tab's
        // covered row already adds once on its own (spec A2).
        title: outputTypeLabel(skip.outputType),
        objective: skip.reason.length > 0 ? skip.reason : `Covered by the upload ${filename}.`,
        roleId: skip.stage,
        dependsOn: [],
        requiredCapabilities: [],
        inputArtifacts: [],
        expectedOutputs: [skip.outputType],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60_000, capabilities: [] },
        approvalPolicy: NO_APPROVAL,
        retryPolicy: DEFAULT_RETRY_POLICY,
        completionGate: null,
      },
    };
  });
}

/**
 * Every task that reads a skipped stage's type waits on its placeholder, so
 * the graph shows where that input comes from. A task that would otherwise
 * start the plan (it depends on nothing) waits on every placeholder and may
 * read each one's type: it stands where the skipped stage stood, and a planner
 * that left `inputArtifacts` out would otherwise start it without the upload
 * that replaced the stage before it. Optional, since the planner did not ask
 * for it by name.
 */
function withPlaceholderDependencies(
  tasks: readonly PlannedTask[],
  placeholders: readonly { readonly task: PlannedTask }[],
): readonly PlannedTask[] {
  if (placeholders.length === 0) return tasks;
  return tasks.map((task) => {
    if (task.dependsOn.length === 0) {
      const types = [...new Set(placeholders.flatMap(({ task: p }) => p.expectedOutputs))]
        .filter((type) => !task.inputArtifacts.some((r) => r.type === type));
      return {
        ...task,
        dependsOn: placeholders.map(({ task: p }) => p.key),
        inputArtifacts: [...task.inputArtifacts, ...types.map((type) => ({ type, required: false }))],
      };
    }
    const extra = placeholders
      .filter(({ task: p }) => task.inputArtifacts.some((r) => p.expectedOutputs.includes(r.type)) && !task.dependsOn.includes(p.key))
      .map(({ task: p }) => p.key);
    return extra.length === 0 ? task : { ...task, dependsOn: [...task.dependsOn, ...extra] };
  });
}

/** The stage as a task key, made unique: a planner may name a stage the way a role is named, or loosely. */
function uniqueKey(stage: string, taken: ReadonlySet<string>): string {
  const base = stage.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'skipped';
  const start = /^[a-z0-9]/.test(base) ? base : `s_${base}`;
  let key = start;
  for (let n = 2; taken.has(key); n++) key = `${start}_${n}`;
  return key;
}

/**
 * A replan's new steps, with any key a kept step already holds renamed
 * (replan spec). Keys are unique per mission, and the planner is told not to
 * reuse a kept key; one that does still gets a plan, not a constraint error.
 * Inside the new plan a dependency on the colliding key means the new step,
 * so it follows the rename; a new step that meant the kept one names it under
 * a key it does not share. Uploads are never re-skipped by a replan.
 */
export function renameAgainst(plan: MissionPlan, kept: ReadonlySet<string>): MissionPlan {
  const taken = new Set([...kept, ...plan.tasks.map((t) => t.key)]);
  const renamed = new Map<string, string>();
  for (const task of plan.tasks) {
    if (!kept.has(task.key)) continue;
    const key = uniqueKey(task.key, taken);
    taken.add(key);
    renamed.set(task.key, key);
  }
  return {
    summary: plan.summary,
    tasks: plan.tasks.map((t) => ({
      ...t,
      key: renamed.get(t.key) ?? t.key,
      dependsOn: t.dependsOn.map((d) => renamed.get(d) ?? d),
    })),
  };
}

export interface MaterializeOptions {
  /**
   * Steps outside this plan that its tasks may depend on: a replan's kept
   * steps, so a new step reads what the finished one it builds on wrote.
   */
  readonly upstream?: readonly PlannedTask[];
  /**
   * For a model's plan: a task that names no inputs reads what its direct
   * dependencies produce. A planner often leaves `inputArtifacts` out, and a
   * task given none is shown none of that work and records no run inputs, so a
   * later round of the work it built on could not tell it had used it (spec §3).
   * A workflow file is left as its author wrote it.
   */
  readonly inferInputs?: boolean;
  /**
   * The skills each task gets (P13): its role's pins and its step's refs,
   * resolved to concrete versions. Absent: tasks are created unresolved, and
   * resolve their role's pins on their first run.
   */
  readonly skills?: (task: PlannedTask) => readonly SkillPin[];
  /** The filename behind an intake artifact, for a skipped stage's placeholder (spec A2). */
  readonly uploadFilename?: (artifactId: string) => string | undefined;
}

function withInferredInputs(tasks: readonly PlannedTask[], upstream: readonly PlannedTask[] = []): readonly PlannedTask[] {
  const byKey = new Map([...upstream, ...tasks].map((t) => [t.key, t]));
  return tasks.map((task) => {
    if (task.inputArtifacts.length > 0 || task.dependsOn.length === 0) return task;
    const types = [...new Set(task.dependsOn.flatMap((key) => byKey.get(key)?.expectedOutputs ?? []))];
    // Not required: the planner never asked for them, so a dependency that writes nothing is no warning.
    return types.length === 0 ? task : { ...task, inputArtifacts: types.map((type) => ({ type, required: false })) };
  });
}

/**
 * The repository a planned task names, or null to inherit the mission's.
 *
 * An unknown name resolves to null rather than throwing: plan validation is
 * where a bad name is reported, and a task that falls back to the mission's own
 * repository is a great deal better than a mission that cannot be materialized.
 */
function resolveRepository(
  task: PlannedTask,
  byName: ReadonlyMap<string, RepositoryId>,
): RepositoryId | null {
  const name = task.repository?.trim();
  if (name === undefined || name === '') return null;
  return byName.get(name.toLowerCase()) ?? null;
}

function fromPlanned(
  task: PlannedTask,
  missionId: MissionId,
  index: number,
  now: string,
  byName: ReadonlyMap<string, RepositoryId>,
): MissionTask {
  return {
    id: ids.task(),
    missionId,
    repositoryId: resolveRepository(task, byName),
    executor: task.executor ?? 'agent',
    waitPolicy: task.waitPolicy ?? null,
    key: task.key,
    title: task.title,
    objective: task.objective,
    roleId: task.roleId,
    dependsOn: task.dependsOn,
    requiredCapabilities: task.requiredCapabilities,
    inputArtifacts: task.inputArtifacts,
    expectedOutputs: task.expectedOutputs,
    executionPolicy: task.executionPolicy,
    approvalPolicy: task.approvalPolicy,
    retryPolicy: task.retryPolicy,
    completionGate: task.completionGate,
    modelPolicy: task.modelPolicy ?? null,
    runSkill: task.runSkill ?? null,
    ...(task.stepClass === undefined || task.stepClass === null ? {} : { stepClass: task.stepClass }),
    status: task.dependsOn.length === 0 ? 'READY' : 'PENDING',
    statusReason: null,
    attempts: 0,
    remediatesTaskId: null,
    orderHint: index,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * The plan as a readable document, stored as the `MissionPlan` artifact.
 *
 * Plan approval has to point at something a human can read, and "here is the
 * JSON we sent to the validator" is not that. It is also the only durable
 * record of the planner's *reasoning* - the task rows keep the decisions but
 * not the summary that explains them.
 */
/** The MissionPlan's title, within the 60 characters every artifact title is held to. */
export function planTitle(missionTitle: string): string {
  return clip(`Plan for ${missionTitle}`, 60);
}

/**
 * The Refinement's title. The daemon names the note after its mission rather
 * than trusting the title line the agent wrote, so every refinement reads the
 * same way in the Artifacts list and the reader.
 */
export function refinementTitle(missionTitle: string): string {
  return clip(`Refinement: ${missionTitle}`, 60);
}

/** Cuts text to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function renderPlanDocument(plan: MissionPlan, missionTitle: string, handoff: ArtifactHandoff, front?: { readonly lane: string; readonly profile: string }): string {
  // JSON strings are valid YAML scalars, so any title or summary is quoted safely.
  const lines: string[] = [
    '---',
    'type: MissionPlan',
    'schemaVersion: 1',
    `title: ${JSON.stringify(planTitle(missionTitle))}`,
    // How the factory chose it (#53 §5.5), so the plan read on its own says so.
    ...(front === undefined ? [] : [`lane: ${front.lane}`, `profile: ${JSON.stringify(front.profile)}`]),
    'handoff:',
    `  headline: ${JSON.stringify(handoff.headline)}`,
    ...(handoff.points.length === 0 ? ['  points: []'] : ['  points:', ...handoff.points.map((p) => `    - ${JSON.stringify(p)}`)]),
    ...(handoff.needs === null ? [] : [`  needs: ${JSON.stringify(handoff.needs)}`]),
    '---',
    '',
    `# Plan for ${missionTitle}`,
    '',
    plan.summary.trim().length > 0 ? plan.summary.trim() : `${plan.tasks.length} tasks.`,
    '',
  ];

  for (const skip of plan.skipped ?? []) {
    lines.push(`## ${skip.stage} — covered by your upload`, '', `- Produces: ${skip.outputType}, from artifact ${skip.artifactId}`, '', skip.reason, '');
  }

  for (const task of plan.tasks) {
    lines.push(
      `## ${task.key} — ${task.title}`,
      '',
      `- Role: \`${task.roleId}\``,
      `- Depends on: ${task.dependsOn.length === 0 ? '(nothing)' : task.dependsOn.map((d) => `\`${d}\``).join(', ')}`,
      `- Produces: ${task.expectedOutputs.length === 0 ? '(no artifact)' : task.expectedOutputs.join(', ')}`,
      `- Isolation: ${task.executionPolicy.isolation}`,
      `- Completion gate: ${task.completionGate === null ? '(none)' : `\`${task.completionGate}\``}`,
      ...(task.approvalPolicy.beforeStart || task.approvalPolicy.onCompletion
        ? [`- Approval: ${task.approvalPolicy.beforeStart ? 'before start' : ''}${
          task.approvalPolicy.beforeStart && task.approvalPolicy.onCompletion ? ' and ' : ''
        }${task.approvalPolicy.onCompletion ? 'on completion' : ''}`]
        : []),
      '',
      task.objective.trim(),
      '',
    );
  }
  return lines.join('\n');
}
