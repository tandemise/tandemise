import type { Mission, Repository, RoleTemplate, MissionPlan } from '@tandemise/domain';
import { ARTIFACT_TYPES, stepFacts } from '@tandemise/domain';
import type { WorkflowPreset } from './presets.js';

/**
 * The planner prompt.
 *
 * The planner is the one place where a model is asked to design organizational
 * structure, so the prompt is written to constrain that tightly: it hands over a
 * known-good preset as the starting point, enumerates the exact vocabulary that
 * will validate, and states the structural rules that `validateMissionPlan`
 * enforces. A planner that invents a role name or an artifact type produces a
 * plan that is rejected wholesale (MVP.md §9.3) - so it is worth spending words
 * here to make that outcome rare.
 */

export interface PlannerPromptInput {
  readonly mission: Mission;
  readonly repository: Repository | null;
  /** Every repository in the project; a task may name any of them. */
  readonly repositories?: readonly Repository[];
  readonly roles: readonly RoleTemplate[];
  readonly preset: WorkflowPreset;
  readonly availableCapabilities: readonly string[];
  readonly repositoryContext: string | null;
  /** Healthy integrations in the project, so a plan can route work to them. */
  readonly connectedApps?: readonly ConnectedApp[];
  /**
   * The accepted Done-when ledger (P6). When given it replaces the request's
   * own lines: it also holds what refinement proposed and the person accepted,
   * and never what they rejected.
   */
  readonly criteria?: readonly { readonly key: string; readonly statement: string }[];
  /** What the person answered while the request was refined. */
  readonly answers?: readonly { readonly key: string; readonly text: string; readonly answer: string }[];
  /**
   * What intake made of the person's uploads that may stand in for a stage
   * (spec A2): an intake ProductSpec is here only once it passed the Done-when
   * check, so the planner is never offered a skip validation would refuse.
   */
  readonly uploads?: readonly { readonly id: string; readonly type: string; readonly title: string }[];
  /**
   * A replan of the rest (replan spec): the steps that already started, kept
   * as they are, and why the person wants a new plan for what is left.
   */
  readonly alreadyDone?: AlreadyDone;
}

export interface AlreadyDone {
  /** The person's note, else the stopping step's `stop` sentence, else null. */
  readonly reason: string | null;
  readonly steps: readonly {
    readonly key: string;
    readonly title: string;
    readonly roleId: string;
    readonly status: string;
    readonly round: number;
    readonly headline: string | null;
    readonly points: readonly string[];
    readonly stop: string | null;
    readonly outputs: readonly { readonly id: string; readonly type: string }[];
  }[];
}

/**
 * What the planner of a replan must know before anything else: what is done,
 * what it found, and that only the rest is to be planned. Without it a planner
 * re-plans from the goal and repeats work the mission already has.
 */
function renderAlreadyDone(done: AlreadyDone | undefined): string {
  if (done === undefined || done.steps.length === 0) return '';
  const steps = done.steps.map((s) => [
    `- \`${s.key}\` (${s.roleId}, ${s.status.toLowerCase()}${s.round > 1 ? `, round ${s.round}` : ''}): ${s.title}`,
    ...(s.headline === null ? [] : [`  Found: ${s.headline}`]),
    ...s.points.map((p) => `    - ${p}`),
    ...(s.stop === null ? [] : [`  Said the plan no longer fits: ${s.stop}`]),
    ...(s.outputs.length === 0 ? [] : [`  Outputs: ${s.outputs.map((o) => `${o.type} (${o.id})`).join(', ')}`]),
  ].join('\n')).join('\n');
  return `# Already done: plan only the rest

This mission is under way. The steps below already ran and are kept exactly as
they are; you are planning only what is still needed after them.
${done.reason === null ? '' : `
Why the person wants a new plan for the rest:
${fence(done.reason)}
`}
${steps}

- Do not plan any of this work again, and never reuse one of these keys.
- A new task that builds on a kept step lists that step's key in \`dependsOn\`
  and the types it reads in \`inputArtifacts\`; that is how it is handed the output.
- If nothing more is needed, return a plan with one short task that says why.
- The preset below shows the usual shape of the whole mission; most of it may
  already be covered by what is done.

`;
}

/**
 * Types no plan task produces: a Refinement comes from refining the request
 * before planning, a StatusReport from the daemon. Offering them would invite
 * a task that writes one.
 */
const NOT_TASK_OUTPUTS: ReadonlySet<string> = new Set(['Refinement', 'StatusReport']);

export interface ConnectedApp {
  readonly name: string;
  /** The capabilities whose holders see this app's tools. */
  readonly capabilities: readonly string[];
  /** Health detail - for an MCP server, its version and tool names. */
  readonly detail: string;
}

export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const { mission, repository, roles, preset, availableCapabilities, repositoryContext } = input;
  // Only worth mentioning when the project has more than the mission's own:
  // otherwise it is an instruction about a choice that does not exist.
  const others = (input.repositories ?? []).filter((r) => r.id !== repository?.id);

  const roleCatalogue = roles
    .map((r) => [
      `- id: ${r.id} — ${r.name}`,
      `  responsibility: ${r.summary}`,
      `  produces: ${r.producesArtifacts.join(', ') || 'nothing'}`,
      `  consumes: ${r.consumesArtifacts.join(', ') || 'nothing'}`,
      `  default isolation: ${r.defaultIsolation}`,
    ].join('\n'))
    .join('\n');

  const hasTestCommand = (repository?.checks?.test ?? null) !== null;
  const presetPlan = preset.build({ hasTestCommand });

  return `You are the Planner for Tandemise, an orchestration system that runs software
missions across multiple AI workers. You do not implement anything. You produce
one thing: a mission plan, as JSON.

# The mission

Goal (the user's own words):
${fence(mission.goal)}

${mission.constraints.length > 0 ? `Constraints:\n${mission.constraints.map((c) => `- ${c}`).join('\n')}\n` : ''}${
    (input.criteria ?? []).length > 0
      ? `Done when (the criteria the person accepted; every one must be provable when the plan is finished):\n${(input.criteria ?? []).map((c) => `- ${c.key}: ${c.statement}`).join('\n')}\n`
      : mission.successCriteria.length > 0
        ? `Stated success criteria:\n${mission.successCriteria.map((c) => `- ${c}`).join('\n')}\n`
        : ''
  }${
    (input.answers ?? []).length > 0
      ? `\nDecided during refinement (the person's own answers; plan around them, do not re-open them):\n${(input.answers ?? []).map((a) => `- ${a.text}\n  Answer: ${a.answer}`).join('\n')}\n`
      : ''
  }
${renderUploads(input.uploads ?? [])}Repository: ${repository ? `${repository.name} at ${repository.path} (default branch ${repository.defaultBranch})` : 'none selected — plan tasks that do not require a repository'}
${others.length === 0 ? '' : `
This project has more than one repository. A task may set "repository" to any of
these names to work there instead of the mission's own; omit it or use null to
work in the mission's repository. Split work by repository only when it truly
belongs there, and make the cross-repository dependency explicit with
"dependsOn" - a task in one repository cannot see another's branch.

${[repository, ...others].filter((r): r is Repository => r !== null)
    .map((r) => `- ${r.name} (default branch ${r.defaultBranch})`).join('\n')}
`}
Autonomy level: ${mission.autonomy}

${repositoryContext ? `# What the repository looks like\n\n${repositoryContext}\n` : ''}
# Roles you may assign work to

You may ONLY use these role ids. Inventing a role causes the plan to be rejected.

${roleCatalogue}

# Artifact types

You may ONLY use these artifact type names:

${ARTIFACT_TYPES.filter((t) => !NOT_TASK_OUTPUTS.has(t)).join(', ')}

# Capabilities

A task may only require capabilities this installation can actually satisfy:

${availableCapabilities.join(', ')}

${renderConnectedApps(input.connectedApps ?? [])}${renderAlreadyDone(input.alreadyDone)}# The starting shape

The "${preset.name}" preset is a known-good plan for this kind of work. Start
from it and adapt it to THIS mission. Adaptation is expected and encouraged:

- Drop a phase that this mission genuinely does not need. A backend refactor
  with no user-visible surface does not need a design phase; say so by omitting
  it rather than creating a token task.
- Split implementation into several parallel tasks when the work is genuinely
  independent. Parallel tasks each get their own isolated worktree, so they must
  not touch the same files. If they would, keep them sequential.
- Add a task the preset lacks if this mission needs it (a data migration, a
  spike to answer an open question before committing to an approach).
- Do not add phases for the sake of looking thorough. Every task costs the user
  wall-clock time and model usage.

The preset, for reference:

${fence(JSON.stringify(presetPlan, null, 2), 'json')}

# Structural rules — a plan violating any of these is rejected outright

1. \`key\` is lowercase letters, digits and underscores, unique within the plan.
2. \`dependsOn\` references keys that exist in this plan${input.alreadyDone !== undefined && input.alreadyDone.steps.length > 0 ? ', or the keys under Already done' : ''}. The graph must be acyclic.
3. If a task lists an input artifact with \`required: true\`, some **transitive
   dependency** of that task must list that artifact in its \`expectedOutputs\`.
   Producing it elsewhere in the plan is not sufficient — it must be upstream.
4. \`roleId\` must be one of the role ids above.
5. Every artifact type must be from the list above, spelled exactly.
6. Any task that writes code must use \`executionPolicy.isolation: "worktree"\`.
7. \`completionGate\`, when present, is a boolean expression over measured facts.
   The available operators are \`&& || ! == != > >= < <=\` and parentheses.
   A gate replaces the check that the task wrote its outputs, so a gate on a
   task with outputs must include \`artifact.<Type>.exists\` for an artifact in
   its own \`expectedOutputs\` (for a release: \`artifact.ReleaseCandidate.exists
   && qa.criteria_unverified == 0\`). With no gate, every expected output must exist.
   These are the ONLY facts a gate may reference; any other name (a typo, or a
   number the daemon keeps for the whole mission) makes the plan invalid:
${plannerFacts()}
   Gate the task that writes the ProductSpec on \`criteria.uncovered_user == 0\`
   and \`criteria.unknown_covers == 0\`, QA on \`qa.criteria_failed == 0\`, and
   the release on \`qa.criteria_unverified == 0\`.
${hasTestCommand
    ? `   This repository declares a test command, so gate code-writing tasks on
   \`checks.tests == PASS\`. \`checks.tests != FAIL\` is also true when the tests
   were never run, so it would let unmeasured work through.`
    : `   This repository declares no test command, so \`checks.tests\` can only ever
   be SKIP. Use \`checks.tests != FAIL\` if you reference it at all.`}
8. \`retryPolicy.maxAttempts\` is at least 1. \`executionPolicy.maxWallTimeMs\` is
   positive; budget generously for implementation (30-45 minutes) and modestly
   for analysis (15-25 minutes).
9. Set \`approvalPolicy.onCompletion: true\` for any task whose output authorizes
   a consequential action — a release candidate always does.

# Steps that are not an agent

Most tasks are agent work. Two other kinds exist, and using an agent for either
is a mistake that costs the user time and money:

- \`"executor": "wait"\` — something outside this machine that must finish before
  the next task: CI on a pull request, a deploy. Give it \`"waitFor"\`, a shell
  command run in the repository every \`everyMs\` until it exits 0 (fails after
  \`timeoutMs\`). It holds no model and no worker slot. For CI on a pull request
  whose head branch the plan names, use
  \`gh pr checks <that-branch>\` (exit 0 only when every check on the pull
  request passed). Never add \`--required\`: a repository with no required
  checks, as on GitHub's free plan for private repositories, makes it fail for
  ever. Name that exact branch in the objective of the task that opens
  the pull request, so the two agree.
- \`"executor": "human"\` — a step only a person can do, or a decision only a
  person may make outside this system (approving a pull request on GitHub,
  making a design in a tool the workers cannot reach). The mission parks until
  they return; what they paste becomes the step's \`expectedOutputs\` artifact.

Never plan a person step to answer questions a worker will raise, or to make a
choice a worker's result will put to them. A worker that needs the person asks
with \`ask_human\` while it runs: the question reaches them in the app, with any
options, and the answer comes straight back to that worker. A person step that
says "read the questions in <file> and paste your answers" sends them looking
for something they cannot see, and still runs when there turned out to be
nothing to answer.

Neither kind needs a real \`roleId\`, capabilities, a gate, or isolation. Both
still take \`key\`, \`title\`, \`objective\` and \`dependsOn\`.

# Writing good objectives

Each task's \`objective\` is handed to a worker that has no memory of this
planning step. Write it as a direct instruction naming the concrete outcome, not
as a topic. "Implement the ImplementationPlan's steps 1-4 in the onboarding
components, add tests for the reduced-step flow, and run the repository checks"
is usable. "Work on onboarding" is not.

# Output

Return ONLY a JSON object, with no prose before or after it and no markdown
fence, matching:

{
  "summary": "one or two sentences describing the shape of this plan and why",
  "tasks": [
    {
      "key": "product_spec",
      "title": "short imperative title",
      "objective": "the direct instruction for the worker",
      "roleId": "product",
      "repository": null,
      "dependsOn": [],
      "requiredCapabilities": ["repository.read", "filesystem.read", "artifact.write"],
      "inputArtifacts": [{ "type": "ProductSpec", "required": true }],
      "expectedOutputs": ["ProductSpec"],
      "executionPolicy": { "isolation": "none", "maxWallTimeMs": 1200000, "capabilities": ["repository.read"] },
      "approvalPolicy": { "beforeStart": false, "onCompletion": false },
      "retryPolicy": { "maxAttempts": 2, "backoffMs": 5000, "onExhausted": "block" },
      "completionGate": null
    },
    {
      "key": "ci",
      "title": "Wait for CI on the pull request",
      "objective": "Wait for the required checks on feat/example to pass.",
      "executor": "wait",
      "waitFor": "gh pr checks feat/example",
      "everyMs": 30000,
      "timeoutMs": 2700000,
      "dependsOn": ["product_spec"]
    }
  ]
}`;
}

/**
 * The uploads that already cover a stage, and how to say so. Shown only when
 * there are some: a `skipped` list offered with nothing to skip for would
 * invite the planner to drop a stage on a guess.
 */
function renderUploads(uploads: readonly { readonly id: string; readonly type: string; readonly title: string }[]): string {
  if (uploads.length === 0) return '';
  return `
Uploaded by the person, already converted and checked (preexisting artifacts):
${uploads.map((u) => `- ${u.type} "${u.title}" (id ${u.id})`).join('\n')}

An upload already covers a stage when a preexisting artifact of that stage's output type exists. Omit the stage and name it under \`skipped\` with the artifact it was covered by.
Add it to the plan object as
"skipped": [{ "stage": "<the omitted stage's role id, e.g. product>", "outputType": "<its output type>", "artifactId": "<the id above>", "reason": "<one sentence>" }]
and keep the stages that read that type: they read the upload instead.

`;
}

function renderConnectedApps(apps: readonly ConnectedApp[]): string {
  if (apps.length === 0) return '';
  return `# Connected apps

These apps are connected to this project and working. A worker reaches an app's
tools only if its task lists one of that app's capabilities in both
\`requiredCapabilities\` and \`executionPolicy.capabilities\`. When the goal names
one of these apps, or the work is what an app is for (design work and a
connected design tool, say), route the task to it by capability, and say in the
objective which app to use and what to produce with it - do not ask a worker to
describe in Markdown what it could make in the real tool.

Some apps work asynchronously: a tool starts a run and another reports on it.
Say in the objective that the worker must keep polling until that run has
finished, and must record the finished result's link (a preview URL, say) in
its artifact - an artifact written while the app is still working hands the
person approving it nothing to look at.

${apps.map((app) => `- ${app.name} — capability: ${app.capabilities.join(', ') || 'none'}\n  ${app.detail}`).join('\n')}

`;
}

/**
 * The step-scoped facts, from the vocabulary itself (P15), so the planner is
 * never taught a fact the validator refuses. `review.independent` is left out:
 * it needs `independentOf`, which only a workflow file can set.
 */
function plannerFacts(): string {
  const kind: Record<string, string> = {
    outcome: 'PASS | FAIL | SKIP', boolean: 'boolean', number: 'number', verdict: 'text', approval: 'PENDING | APPROVED | REJECTED',
  };
  return stepFacts()
    .filter((fact) => fact.requires !== 'independentOf')
    .map((fact) => {
      const note = fact.requires === 'worktree' ? ' (only on a task with isolation "worktree")'
        : fact.requires === 'changeset' ? ' (only on a task that outputs a ChangeSet)' : '';
      return `   - \`${fact.name}\` — ${kind[fact.type] ?? fact.type}${note}`;
    })
    .join('\n');
}

function fence(content: string, lang = ''): string {
  // Four backticks so a body that itself contains a fenced block stays intact.
  return `\`\`\`\`${lang}\n${content}\n\`\`\`\``;
}

/**
 * Extracts the plan object from a model response.
 *
 * Models wrap JSON in prose or a fence often enough that failing the whole
 * planning step over it would be a bad trade. This recovers the outermost
 * balanced JSON object and lets schema validation reject anything genuinely
 * malformed.
 */
export function extractPlanJson(response: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(response);
  const haystack = fenced?.[1] ?? response;

  const start = haystack.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return haystack.slice(start, i + 1);
  }
  return null;
}

/** Human-readable plan summary for the approval card and the mission header. */
export function describePlan(plan: MissionPlan): string {
  const byRole = new Map<string, number>();
  for (const t of plan.tasks) byRole.set(t.roleId, (byRole.get(t.roleId) ?? 0) + 1);
  const roles = [...byRole.entries()].map(([role, n]) => (n > 1 ? `${role} ×${n}` : role)).join(' → ');
  return `${plan.tasks.length} ${plan.tasks.length === 1 ? 'task' : 'tasks'}: ${roles}`;
}
