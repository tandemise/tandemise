# Workflows

A workflow is your process, written down. It lives in your repository, at
`.tandemise/workflows/<name>.yaml`, and it compiles to exactly the plan
Tandemise would otherwise ask a model to propose — so it inherits the dependency
graph, the gates, the approvals and the scheduler unchanged.

`docs/examples/build-feature.yaml` is a complete one: issue → plan → design →
build → review → PR → CI → merge → deploy → production check → release notes.

## Why a file

Because a process belongs next to the code it describes. It is versioned with
that code, it arrives on a new machine with a clone, a change to it shows up in
a diff, and a branch can carry a different one while you are trying something.
None of that is true of a row in a local database.

## The three kinds of step

```yaml
steps:
  # 1. An agent. The default; needs a role.
  - key: build
    role: development
    objective: Implement the plan for issue #{{ issue }}.
    isolation: worktree
    gate: checks.typecheck != FAIL && checks.tests != FAIL

  # 2. A person. Parked until you come back with something.
  - key: design
    executor: human
    dependsOn: [build]
    objective: Make the design in Figma. Paste the URL.
    outputs: [DesignBrief]

  # 3. A wait. Watches something outside this machine.
  - key: ci
    executor: wait
    dependsOn: [build]
    waitFor: gh pr checks --watch --fail-fast
    everyMs: 30000
    timeoutMs: 1800000
```

A **human** step keeps manual work inside the dependency graph, so the tasks
that need it wait rather than fail — and what you paste is written as the
artifact the step declared, which means the next task reads a design you made in
Figma exactly as it would read one a model wrote. The step's drawer starts with
what the steps before it handed over (each one's headline, points and what it
needs from you, with the full document a click away), because those steps ran
after the objective was written and may have found it no longer fits.

A person step is for work only a person can do. Questions an agent has for you
are not a step: the agent asks them in the app while it runs (`ask_human`), and
your answer goes straight back to it.

A **wait** step holds no model and no worker slot. The obvious alternative — an
agent polling in a loop — re-sends its whole context on every poll, so a
ten-minute CI wait is billed as a ten-minute conversation.

## Worktrees

You do not ask for one. A step's isolation comes from the step if it says so,
otherwise from its **role** — `development`, `review` and `qa` all declare
`worktree`, so a code step gets its own checkout and branch without the workflow
mentioning it. Only if neither says anything does a step run in place.

That order exists because forgetting `isolation: worktree` on a `development`
step would point an agent at your real working tree, which is the one thing
Tandemise exists to prevent.

Each worktree is cut per task, branched from the mission's base — except a
reviewer or tester, which is branched from the upstream task's change branch so
it sees the actual diff rather than the description of it. `node_modules` is
cloned copy-on-write where the filesystem supports it, so provisioning is fast.

## Inputs

```yaml
inputs:
  - name: issue
    description: GitHub issue number
    required: true
```

Referenced as `{{ issue }}` in any `objective` or `waitFor`. That is the whole
templating language: a workflow that needs conditionals is a program, and the
DAG is where branching belongs.

## Models

A step can choose its model, a ladder of models for retries, and a step whose
run it must differ from:

```yaml
  - key: implement
    role: development
    model: my-fast-model                        # this step's model
    escalate: [my-strong-model, my-strongest]   # attempt 2, then attempt 3 and later
  - key: review
    role: review
    dependsOn: [implement]
    independentOf: implement                    # adds review.independent to the gate
```

A step's model wins over its role's (Team → Roles) and the runtime profile's.
A model name is one word, passed to the runtime as written; a ladder has at most
five entries; `independentOf` must name a step this one depends on. See
[the models guide](guides/models.md).

## Skills

A step can pin skills from the project's skills library, on top of the ones its
role pins (Team → Roles):

```yaml
  - key: implement
    role: development
    skills: [house-style@latest, tdd@2]   # name, name@<version> or name@latest
    gate: artifact.ChangeSet.exists && skills.missing == 0
```

`latest` becomes the newest version when the mission is planned. A step's pin
wins over its role's pin of the same skill. A skill or version the library does
not have stops the workflow when it is planned, naming the step.

Two gate facts, `skills.loaded` and `skills.missing`, are measured in every
step gate (see [Gate facts](#gate-facts)). See [the skills guide](guides/skills.md).

## Skipped and parked steps

A stage the planner would otherwise run can be skipped when an uploaded file
or link already covers it — see [Hand work in and back](guides/outside-contributions.md).
The skip is a real `SKIPPED` task in the graph, not a gap: it carries the
stage's output type, so dependents still find a producer, and its reason
reads `Covered by your upload: <filename>`. **A workflow file you wrote never
skips a stage this way** — every step you declared runs; only a plan the
planner proposes can leave one out.

An agent step can also come back `AWAITING_EXTERNAL` mid-mission: someone took
its work to another tool with "Continue elsewhere" and it is waiting for them
to hand it back, the same status a `wait` step uses while it polls — but the
meaning is the other way round. For a `wait` step, `AWAITING_EXTERNAL` means
the mission is still moving on its own; for a parked agent step, it means the
mission is waiting on a person, until the hand-back lands as a new round.

## When something is wrong

Mistakes are caught when the workflow is read, naming the step and the problem —
a typo in `dependsOn`, an agent step with no role, a `{{ placeholder }}` you
never declared, a `waitFor` on a step that is not a wait. A file that will not
parse is listed with its error rather than skipped, because a workflow that
silently vanishes sends you looking anywhere except at the file you just broke.

## Precedence

Your file wins over a built-in preset of the same name. The built-ins stay
underneath as a starting position, not a ceiling.

When the project has a brain, its `factory/workflows/` come first, then your
code repositories' `.tandemise/workflows/`, then the built-in presets, by
workflow id. A code-repository workflow that a brain workflow of the same id
hides is listed on the Brain screen's Factory tab, with **Move into the brain**.

## Gate facts

A `gate` is an expression over measured facts, for example
`artifact.QAReport.exists && qa.criteria_failed == 0`. A fact that is not
measured compares false against everything, so a gate never passes because a
measurement was missing: the step fails with "Not met: … is not measured".

Every fact has a **scope**. Only *step* facts are measured when a step's gate
is read; the others belong to the whole mission or the whole project, and are
read by the daemon's own rules. Tandemise checks every gate when it is written
(a workflow file when it is loaded, a planner's plan, an import) and refuses
one that can never pass, saying why:

| The gate… | Reason shown |
|---|---|
| reads a fact that does not exist | "The gate on 'build' reads checks.test, which Tandemise never measures. Did you mean checks.tests?" |
| reads a mission or project fact | "The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step." |
| is on a step with `outputs` but never reads its own `artifact.<Type>.exists` | "The gate on 'build' never checks that the step wrote its output: add artifact.ChangeSet.exists, so a run that writes nothing cannot pass." |
| reads `review.independent` without `independentOf` | "… which is only measured on a step with independentOf." |
| reads `git.clean` on a step without its own worktree | "… which is only measured on a step that works in its own worktree." |
| reads `diff.files_changed` on a step that writes no ChangeSet | "… which is only measured from the step's own ChangeSet …" |

A workflow file with such a gate is listed under New mission with the reason,
and nothing plans from it until it is fixed.

The factory's own rules (`planner.yaml`, `routing.yaml`, `merge.yaml`) are described in
[The factory](FACTORY.md); the facts they read are in the last table below.

The table below is generated from `GATE_FACT_VOCABULARY`
(`packages/domain/src/gate-facts.ts`) by `node scripts/gate-facts-doc.mjs
--write`; the offline checks fail when it drifts.

"Counted" criteria (for the `qa.criteria_*` facts) are every live spec
criterion plus every one of your Done-when lines that nothing in the spec
covers. See [Done when](guides/done-when.md).

<!-- gate-facts:start (generated by scripts/gate-facts-doc.mjs from GATE_FACT_VOCABULARY; do not edit by hand) -->

#### Facts a step's gate can read

| Fact | Type | Scope | Meaning | Measured in |
|---|---|---|---|---|
| `checks.install` | PASS / FAIL / SKIP | step | Dependency install command exit status. SKIP when the repository configures none. Run before any other check a gate reads. | step gate |
| `checks.typecheck` | PASS / FAIL / SKIP | step | Type checker exit status. SKIP when the repository configures none. | step gate |
| `checks.lint` | PASS / FAIL / SKIP | step | Linter exit status. SKIP when the repository configures none. | step gate |
| `checks.tests` | PASS / FAIL / SKIP | step | Test command exit status. Plural, unlike the repository field it comes from. SKIP when the repository configures none. | step gate |
| `checks.build` | PASS / FAIL / SKIP | step | Build command exit status. SKIP when the repository configures none. | step gate |
| `artifact.<Type>.exists` | boolean | step | True when at least one non-superseded artifact of that type exists for the mission. A gate on a step with outputs must read this for one of them. | step gate |
| `artifact.<Type>.count` | number | step | How many artifacts of that type the mission has. | step gate |
| `review.verdict` | text | step | Independent reviewer's verdict: pass, needs_changes, or fail. | step gate, after a review |
| `review.blocking_findings` | number | step | Count of reviewer findings with severity `blocking`. | step gate, after a review |
| `review.major_findings` | number | step | Count of reviewer findings with severity `major`. | step gate, after a review |
| `review.independent` | boolean | step | Set on a step with `independentOf: <step>`: true when this step's run used a different runtime, or a different known model, than that step's run. A model left to the runtime's default cannot be shown to differ on the same runtime, so it reads false. Absent until both runs exist. | step gate, only with `independentOf` |
| `skills.loaded` | number | step | How many pinned skills this step's newest run received, as a folder or in its prompt (P13). 0 before the step has run or when it pins none. | step gate |
| `skills.missing` | number | step | How many of this step's pinned skills its newest run did not receive at the pinned version and hash (P13). A run never starts with a pinned skill's content missing, so this reads 0 after a normal run. | step gate |
| `qa.acceptance_criteria_coverage` | number | step | Percentage (0-100) of the mission's criteria QA verified as PASS. A criterion QA skipped or never reported counts as not verified. Without a Done-when ledger, the share of QA's own results that passed. | step gate, with criteria or after QA |
| `qa.criteria_verified` | number | step | Criteria on the Done-when ledger that the newest QA report marked PASS (a user criterion counts only when nothing in the spec covers it). | step gate, with criteria |
| `qa.criteria_failed` | number | step | Criteria on the Done-when ledger that the newest QA report marked FAIL. | step gate, with criteria |
| `qa.criteria_unverified` | number | step | Criteria on the Done-when ledger with no PASS or FAIL from QA: skipped, never reported, not covered, or written after QA ran. | step gate, with criteria |
| `criteria.total` | number | step | Live criteria on the Done-when ledger: the person's lines plus the current spec's acceptance criteria. | step gate |
| `criteria.user_total` | number | step | Done-when lines the person wrote (U1, U2, …). | step gate |
| `criteria.uncovered_user` | number | step | Done-when lines that no acceptance criterion of the current spec lists in `covers`. | step gate |
| `criteria.unknown_covers` | number | step | Entries in the spec's `covers` lists that name no Done-when line. | step gate |
| `qa.blocking_defects` | number | step | Count of QA defects that block release. | step gate, after QA |
| `qa.verdict` | text | step | QA role's overall verdict. | step gate, after QA |
| `approval.plan` | PENDING / APPROVED / REJECTED / EXPIRED / CANCELLED | step | Status of the mission plan approval. A pending one wins over an approved one. | step gate |
| `approval.release_candidate` | PENDING / APPROVED / REJECTED / EXPIRED / CANCELLED | step | Status of the release approval. PENDING until a human decides. | step gate |
| `approval.<kind>` | PENDING / APPROVED / REJECTED / EXPIRED / CANCELLED | step | Status of any other approval kind on the mission: choice, exception, action, intervention, check. | step gate |
| `task.attempt` | number | step | Which attempt at the task this is; 0 before it first runs. | step gate |
| `task.role` | text | step | The role the task is staffed under. | step gate |
| `task.risk` | text | step | The highest risk class among the task's capabilities: read, write_reversible, external_side_effect, destructive, financial or release. | step gate |
| `task.risk_level` | number | step | task.risk as its position in that list, 0 (read) to 5 (release), so a condition can use >=. | step gate |
| `diff.files_changed` | number | step | How many files the step's own ChangeSet says it changed. Not measured when it wrote no ChangeSet. | step gate, when the step writes a ChangeSet |
| `git.clean` | PASS / FAIL / SKIP | step | PASS when the step's worktree has nothing uncommitted after Tandemise committed the worker's changes and ran the checks (a build that rewrites a tracked file makes it FAIL, listing the files). Recorded with the checks. | step gate, only on a step with its own worktree |

#### Facts for the whole mission or project

These are measured by the daemon for its own rules (the readiness check, the backlog pull, the limit stop, the
stalled row) and for the desk. A workflow or a plan whose gate reads one is refused when it is written, with a
reason such as "The gate on 'release' reads mission.stalled, which is only known for the whole mission, not
inside a step."

| Fact | Type | Scope | Meaning | Measured in |
|---|---|---|---|---|
| `ready.criteria` | number | whole mission | Accepted Done-when criteria of a DRAFT mission: the person's lines, ones added by hand and accepted proposals. Read by the readiness gate before planning. | the readiness check before planning |
| `ready.open_questions` | number | whole mission | Questions refinement asked that the person has not answered yet. | the readiness check before planning |
| `ready.proposed_pending` | number | whole mission | Criteria refinement proposed that the person has not accepted or rejected yet. | the readiness check before planning |
| `mission.priority` | number | whole mission | The mission's priority as a number: 0 urgent, 1 high, 2 normal, 3 low. Orders the backlog and the worker slots. | published; the backlog orders by priority directly |
| `mission.agent_minutes` | number | whole mission | Agent time the mission's runs used, in minutes: what each runtime reported, or the run's own duration when it reported none. | the limit service |
| `mission.tokens` | number | whole mission | Input plus output tokens the mission's runs reported. Not measured when no runtime reported tokens. | the limit service |
| `mission.spend_usd` | number | whole mission | Cost in US dollars the mission's runs reported. Not measured when no runtime reported a cost: never read as 0. | the limit service |
| `mission.limit_percent` | number | whole mission | How much of its most-used limit the mission has used, in percent. Not measured when it has no limit. Work stops at 100. | the limit service |
| `mission.stalled` | number | whole mission | Whether the mission is stalled: 1 when nothing moves it and nothing asks the person (it has a Stalled row in the Inbox), else 0. | the liveness service |
| `run.silent_minutes` | number | whole mission | Minutes since the step's live run last wrote an event. Not measured when the step has no live run - which is always the case when a step's gate is read, after its run ended. | the liveness service |
| `workspace.active_missions` | number | whole project | Missions in progress in the project: not DRAFT, not PAUSED and not finished. Read by the backlog pull. | the backlog pull |
| `workspace.max_active_missions` | number | whole project | The project's work-in-progress limit. Not measured when the limit is off, so a gate reading it never passes and nothing is pulled. | the backlog pull |
| `workspace.month_limit_percent` | number | whole project | How much of its most-used monthly limit the project has used this calendar month, in percent. Not measured without a monthly limit. | the limit service |

#### Facts for factory rules

Read only by the factory's own rules: planning rules in `planner.yaml` and merge rules in `merge.yaml` (see
`docs/FACTORY.md`). A predicate is called with literal arguments, such as `profile.areas_any("auth")`. A merge
rule may also read `checks.tests` and the `review.*` facts of the mission's last code step.

| Fact | Type | Scope | Meaning | Measured in |
|---|---|---|---|---|
| `item.type` | text | planning rule | The tracker item's type as the tracker names it (Bug, Feature), or not measured when it has none. | planner |
| `item.prefix` | text | planning rule | The Conventional-Commit prefix of the title (fix, docs, feat), or not measured when the title has none. | planner |
| `item.criteria` | number | planning rule | Done-when lines the task was given. | planner |
| `item.keywords_any()` | predicate | planning rule | True when the title or description contains any of the words given, ignoring case. | planner |
| `item.labels_any()` | predicate | planning rule | True when the tracker item has any of the labels given. | planner |
| `item.source_any()` | predicate | planning rule | True when the task came from any of the source kinds given (sentry, posthog, dependabot, advisory). | planner |
| `profile.type` | text | planning rule | The task profile's type: fix, feature, refactor, chore, docs, deps, test, security or unknown. | planner |
| `profile.size` | text | planning rule | The task profile's size: xs, s, m or l. | planner |
| `profile.risk` | text | planning rule | The task profile's risk: low, medium or high. Never below the sensitivity floor. | planner |
| `profile.max_sensitivity` | text | planning rule | The highest sensitivity of the areas the task touches: none, sensitive or critical. | planner |
| `profile.repos` | number | planning rule | Repositories the task names or implies. | planner |
| `profile.areas_any()` | predicate | planning rule | True when the task touches any of the areas named. | planner |
| `change.files` | number | merge rule | Files the pull request changes. | ship step |
| `change.lines_added` | number | merge rule | Lines added, from the diff's numstat. | ship step |
| `change.lines_removed` | number | merge rule | Lines removed, from the diff's numstat. | ship step |
| `change.repos` | number | merge rule | Repositories this mission opened pull requests in. | ship step |
| `change.binary_files` | number | merge rule | Binary files changed. | ship step |
| `change.deleted_files` | number | merge rule | Files deleted. | ship step |
| `change.tests_touched` | number | merge rule | Changed files that match the merge policy's test globs. | ship step |
| `change.dependencies_changed` | boolean | merge rule | A dependency manifest or lockfile changed. | ship step |
| `change.lockfile_only` | boolean | merge rule | Only lockfiles changed among the dependency files. | ship step |
| `change.max_sensitivity` | text | merge rule | The highest sensitivity of the areas the change touches: none, sensitive or critical. | ship step |
| `change.areas_any()` | predicate | merge rule | True when the change touches any of the areas named. | ship step |
| `change.paths_matching()` | predicate | merge rule | How many changed paths match the glob given. | ship step |
| `coverage.changed_lines` | number | merge rule | Percent of changed lines covered, only when the checks produce a coverage report. Otherwise not measured. | ship step |
| `ci.state` | PASS / FAIL / SKIP | merge rule | PASS only when every check on the head commit succeeded and there is at least one. | ship step |
| `ci.required_present` | boolean | merge rule | The base branch has required status checks. | ship step |
| `github.review_required` | boolean | merge rule | Branch protection requires an approving review. | ship step |
| `criteria.unverified` | number | merge rule | Done-when lines the person gave that no QA report verified. | ship step |
| `criteria.implicit` | boolean | merge rule | The only Done-when line is the implicit one: the task as written. | ship step |
| `process.lane` | text | merge rule | The lane the mission ran in: quick, standard or careful. | ship step |
| `process.lightened_by_person` | boolean | merge rule | A person made the mission quick. | ship step |
| `process.steps_skipped` | number | merge rule | Ceremony the lane skipped. | ship step |
| `process.holds` | number | merge rule | Times a person held a step of this mission. | ship step |
| `process.changes_requested` | number | merge rule | Request-changes rounds in this mission. | ship step |
| `process.escalations` | number | merge rule | Times a step moved to a stronger model. | ship step |
| `process.gate_retries` | number | merge rule | Attempts after a failed gate across the mission. | ship step |
| `process.person_commits` | number | merge rule | Commits on the pull request not made by Tandemise or its agents. | ship step |
| `process.retry_out_of_scope` | boolean | merge rule | A retry changed files its step had not touched before (the scope.retry check). | ship step |
| `process.revert_of_auto` | boolean | merge rule | The pull request reverts a change Tandemise merged on its own. | ship step |
| `history.area_reverts_90d` | number | merge rule | Reverts in the areas touched over the last 90 days. | ship step |
| `history.area_recent_revert` | boolean | merge rule | An area touched had a revert or broke main in the last 14 days. | ship step |

<!-- gate-facts:end -->

The built-in presets use them like this:

```
spec:     artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1
qa:       artifact.QAReport.exists && review.blocking_findings == 0 && qa.criteria_failed == 0
release:  artifact.ReleaseCandidate.exists && qa.criteria_unverified == 0 && qa.blocking_defects == 0
```

The daemon's own rules over the mission and project facts:

```
ready to plan:  ready.criteria >= 1 && ready.open_questions == 0 && ready.proposed_pending == 0
pull the next:  workspace.active_missions < workspace.max_active_missions
```

The limit stop and the stalled and quiet rows are daemon rules over the same
numbers; no gate you write can loosen them.

**Removed in P15.** `security.required_checks` and `checks.<name>` were listed
but never measured (a repository can configure only install, typecheck, lint,
test and build), so a gate reading them could never pass. `git.clean` is now
measured, after the checks, on a step with its own worktree.
