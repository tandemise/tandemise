# The planner and risk-based merge: the factory decides the steps per task, and merges by blast radius

Status: design, 2026-10-30. This is the fourth sub-project of the software-factory pivot (#56), tracked in #53. It depends on hold and interact (#50, `2026-10-30-hold-and-interact-design.md`), the brain (#51, `2026-10-30-brain-design.md`) and intake (#52, `2026-10-30-intake-design.md`). The owner's binding decisions are in `2026-10-30-tandemise-pivot-notes.md`.

## The problem

The owner went back to raw Claude Code because Tandemise "was rigid" and slow. Today, a one-line fix pressed **Start** goes through all of this before anything reaches GitHub:

1. **Readiness.** A mission plans only when `READY_TO_PLAN_GATE` passes (`packages/domain/src/entities/refinement.ts:73`, `ready.criteria >= 1 && …`). With no Done-when line, intake opens it as a draft for refinement (`2026-10-30-intake-design.md` §7).
2. **A planner run.** `PlanningServiceImpl` (`packages/application/src/services/planning-service.ts:120-140`) asks a model to write `plan.json`, retries once, and falls back to a preset. That is a whole model session before any work starts, even when the answer is obvious.
3. **Plan approval.** `DEFAULT_AUTONOMY.planApproval` is `'ask'` (`packages/domain/src/entities/workspace.ts:19`). `#requestApprovalOrAccept` (`planning-service.ts:1225`) stops the mission at AWAITING_PLAN_APPROVAL.
4. **A fixed preset.** The smallest preset, `quick-change` (`packages/application/src/planning/presets.ts:221`), is still three agent steps: implement, review, verify. `feature-delivery` is seven. Nothing about the task chooses between them except a dropdown (`mission.workflowPreset`) or the tracker-type mapping in #52.
5. **Models are static.** `resolveModel` (`packages/domain/src/entities/models.ts:91`) picks the step's, role's or profile's model, and a fixed ladder on retries. It never looks at how a model actually did. `summarizeRunScores` (`packages/evaluation/src/scorecard.ts:72`) already measures that per role and model, and nothing reads it at planning time.
6. **No merge.** A pull request is opened by an agent through the `github.pr.create` tool, as a **draft** by default (`packages/integration-github/src/tools.ts:291-305`). `github.pr.merge` is classed `release` (`packages/policy/src/risk.ts:97`) and MVP.md §18.2 says merging a protected branch needs a person. There is no merge tool and no merge decision at all. Every task ends with a person opening GitHub.

So a trivial task costs a planner run, a plan approval, three agent sessions and a manual merge. A risky task gets the same shape, because the shape doesn't depend on risk. It's slow where it should be fast, and not careful in a targeted way where it should be careful.

## Intent

The factory looks at each task and decides, in the open, how much process it deserves: which steps, which skills on each, which model on each, and where a person has to look. A quick fix goes from **Start** to a PR, and possibly to a merge, with no ceremony. A risky change gets more steps and more gates. Every choice shows its reasons, a person can override it, and outcomes teach the factory, through the brain's PR flow, to choose better next time.

## Goals

1. **A quick fix has no ceremony.** Start → one agent step → checks → PR. No refinement, no planner run, no plan approval, no separate review or QA session. Wall time is close to raw Claude Code plus CI.
2. **Risk buys process.** A change that touches sensitive areas, is large or is vague gets refinement, a tailored plan, independent review, verification and approvals, chosen by explicit rules.
3. **Models are routed by measured outcome.** Each step gets the cheapest model the project has approved that has proven itself on similar work, and escalates on failure.
4. **The merge is decided by risk.** When CI is green on the PR's head commit, Tandemise either merges it or asks for review, from the change's blast radius and the project's policy. It never uses the agent's own opinion of its work.
5. **Everything is explained, audited and reversible.** "Why these steps" and "why it merged or asked" are visible in the app, on the PR and in the brain's history. A merge can be reverted in one action.
6. **The factory learns without changing itself silently.** Outcomes (merged clean, reverted, changes requested, held) tune routing within approved bounds, and propose policy changes as brain PRs.

Success, in the owner's words from the pivot notes: "Pick a task and start it. Fully autonomously, the system takes the task from idea to a PR. Then it decides what comes next: merge it completely, or ask someone to review it."

## Non-goals (this sub-project)

- **Deploys and releases.** Merge to the default branch is the end. Deploying, tagging and publishing stay human (`productionRelease: 'ask' | 'deny'`, MVP.md §18.2).
- **Merging forks and outside contributions.** P3 (`contribution-service.ts`) keeps its own review path. The merge decision applies only to PRs Tandemise opened from its own missions.
- **Trackers other than GitHub for code hosting.** The merge port has one adapter (GitHub, through `gh`). GitLab and others plug into the same port later.
- **Learning a classifier from data.** Profiles and risk are rules plus counters. A trained model is out of scope (see "Approaches").
- **Changing the plan from inside a hold.** #50 deferred an MCP tool for this to #53. This design ships the **lane switch** in the app ("Make it careful"); a terminal-side tool is left for later.
- **Non-code work.** The pivot says work isn't only code. Profiles and lanes are written so they can apply to other kinds of work, but this design only defines the code factory's lanes and only merges git changes.

## Anti-goals (what it must never become)

- **A merge bot that trusts the agent.** No input to the merge decision comes from text an agent wrote about its own work: not the ReleaseCandidate's `unresolvedRisks`, not "I'm confident", not a model asked "is this safe?".
- **A model that writes the rules.** The planner never edits `factory/`. Gate and policy changes reach the brain only through #51's promotion PRs.
- **Self-loosening.** Nothing automatic ever removes a gate, an approval or a "never auto-merge" rule, or raises a threshold. Automation may only make the next decision *more* careful. Loosening is always a PR a person merges.
- **A second pipeline language.** Lanes are workflows in the existing format (`packages/domain/src/workflow.ts`), compiled by `compileWorkflow` and validated by `validateMissionPlan`. Rules are written in the existing gate language (`packages/domain/src/gate.ts`).
- **Ceremony by default.** A new project that sets nothing gets the fast path for small, safe work. Careful process is opted *into* by risk, not opted out of by the person.

## Research this design adopts

These come from the survey done during the pivot conversation (about 30 systems) and the notes on #53.

| Pattern | Source | Where it lands here |
|---|---|---|
| Nobody decides steps, models and gates per task; agents run one fixed loop. | pivot survey | The task profile and lanes (§2–§5). |
| Route merges on **blast radius** (paths and areas touched, size), not on the agent's self-reported confidence. A classifier merged 58% of PRs in Vercel's largest monorepo with no human review. | Vercel, cited in #53 | The merge decision's inputs (§8.2). |
| No vendor agent decides merges. | pivot survey | Auto-merge is off until the owner turns it on per project (§8.4). |
| Bind an approval to the exact commit that was reviewed; a new push voids it. | super-board | `--match-head-commit` on every merge (§8.5). |
| Cheap model first, escalate to a stronger one on failure. | model cascades (FrugalGPT-style routing); P12 ladders already | Routing table and escalation (§6). |
| Per-path ownership and sensitivity. | CODEOWNERS | `areas` in `factory/planner.yaml` (§3). |
| An observer proposes factory changes as PRs a person reviews. | Warp; adopted in #51 §8 | Every policy change the outcomes suggest (§9). |
| A self-improving system that can edit its own evaluation games it. | Darwin Gödel Machine; adopted in #51 | The planner and promoter never read or write `factory/merge.yaml` thresholds directly; backtests are computed by the daemon (§9.3). |

## Words

| Word | Meaning |
|---|---|
| **Task profile** | What the factory believes about a task: its **type**, **size** and **risk**, each with the signals that produced it. |
| **Lane** | How much process a task gets: **quick**, **standard** or **careful**. A lane names a workflow in the brain. |
| **Module** | A rule in the brain that adds to a plan when it matches: a step, a skill, a gate clause, an approval. Modules only add. |
| **Step class** | What a step is for, independent of its key: `implement`, `review`, `verify`, `spec`, `design`, `architecture`, `investigate`, `resolve_conflicts`. The routing table is keyed on it. |
| **Routing table** | For each step class and profile bucket, the models the project allows (cheapest first) and how each has done. |
| **Ship step** | The final, daemon-owned step of every code plan: open the PR, wait for CI, decide, merge or ask. No agent runs in it. |
| **Merge decision** | The ship step's verdict for one PR head commit: **merge** or **ask**, with the factors that produced it. |
| **Outcome** | What happened to a mission's change after the fact: merged clean, reverted, broke main, changes requested, edited by a person, held. |

## Approaches considered

### How the plan is decided

1. **Let the planner model decide everything.** Today's planner run, given more freedom: it picks steps, skills, models and gates. It's flexible, but it's slow (a model session before every task, which is the ceremony we're removing), not repeatable (two runs on the same task differ), and its choices are self-reported. A model choosing which gates *it* gets to pass is exactly what the anti-goals forbid. Rejected as the main path; kept for the careful lane, where tailoring is worth a run.
2. **Deterministic profile, lanes and modules from the brain, with a cheap model only as a tiebreak** *(chosen)*. The profile is a pure function of signals. Lanes and modules are rules in the brain. Most tasks are planned in milliseconds with no model. A small classifier pass runs only when signals disagree or are missing, and it can only pick from enumerated values above a deterministic floor. The planner model still tailors careful plans. Cost: rules to write and a default set to ship, and a rule set that is wrong at first for some projects, which outcomes then correct through PRs.
3. **A learned classifier, end to end.** Train on outcomes to predict steps and risk. A team has a few hundred tasks a year, not enough data for a model; it starts with no data at all; its decisions can't be explained or reviewed as a diff. Rejected.

### How the merge is decided

1. **Always ask** (today, in effect). Safe and slow. It's the reason a quick fix still needs a person at the end. Kept as the default until the owner turns auto-merge on.
2. **Ask the agent or a judge model whether it's safe.** Rejected by the research: confidence is not evidence, and it's the one signal nobody in the survey trusted.
3. **Deterministic blast-radius scoring against a per-project policy in the brain** *(chosen)*. Measured inputs (paths, areas, size, tests, CI, process signals, history), a points table and hard "never" rules in `factory/merge.yaml`, evaluated by pure code. Every decision can be replayed from its stored inputs, which also makes backtesting a policy change possible (§9.3).

## Decisions

### 1. Where it plugs in

```
Start (#52 §7) ──► profile ──► lane ──► compile workflow ──► modules ──► route models ──► validate ──► run
                    §2         §4        compileWorkflow     §5          §6              validateMissionPlan
                                                                                            │
                                         … agent steps, holds (#50), gates, retries …       ▼
                                                                                         ship step §8
                                                                              open PR ► CI ► decide ► merge | ask
                                                                                            │
                                                              outcomes ► brain ledger ► routing + proposals (§9)
```

- **Planning** keeps `PlanningServiceImpl` and its contract ("a mission must never be left unable to start", `planning-service.ts:123`). The new planner becomes the first rung of the ladder. The old rungs stay as fallbacks: an authored workflow, then the planner run, then a preset.
- **The brain** (#51) holds the rules: `factory/planner.yaml`, `factory/routing.yaml` and `factory/merge.yaml`. These are new codec item kinds and all three are **structural** under #51 §8, so they change only through a person's edit or a promotion PR. Lane workflows are ordinary `factory/workflows/*.yaml`.
- **Intake** (#52) supplies the tracker item, its type, labels, sources and criteria at Start. This design changes one of #52's calls: a task with no criteria no longer always opens as a draft (§4).
- **Holds** (#50) are an input to routing, to approvals at plan time and to the merge decision (§6, §5, §8).

### 2. The task profile

A profile is computed twice:
- **Predicted**, at Start, from what is known before any code changes. It chooses the lane, modules and models.
- **Measured**, after each code-writing step and again at the ship step, from the actual diff. It can escalate the lane (§5.4), and it is what the merge decision uses (§8).

```ts
interface TaskProfile {
  readonly type: 'fix' | 'feature' | 'refactor' | 'chore' | 'docs' | 'deps' | 'test' | 'security' | 'unknown';
  readonly size: 'xs' | 's' | 'm' | 'l';
  readonly risk: 'low' | 'medium' | 'high';
  readonly areas: readonly { name: string; sensitivity: 'none' | 'sensitive' | 'critical' }[];
  readonly repos: readonly string[];          // brain.yaml repository names
  readonly signals: readonly ProfileSignal[]; // every input, with what it contributed
  readonly source: 'rules' | 'rules+model' | 'person';
  readonly basis: 'predicted' | 'measured';
}
interface ProfileSignal { readonly name: string; readonly value: string; readonly effect: string } // "tracker type Bug", "→ type fix"
```

`profileTask(signals, rules) → TaskProfile` is a pure function in `@tandemise/domain` (`planner/profile.ts`). The daemon gathers signals; the function decides.

**Deterministic signals, in order of weight:**

| Signal | Where it comes from | Contributes |
|---|---|---|
| A person's choice at Start | **Auto** (default), **Quick** or **Careful** | Quick or Careful sets the lane directly (§4). `source: 'person'`. Risk can't be set below the sensitivity floor. |
| Tracker item type and labels | #52's tracker item, mapped by `factory/tracker.yaml` | Type (`Bug` → `fix`, `dependencies` label → `deps`). |
| Source kind | #52's linked signals | Sentry or PostHog error → `fix`; Dependabot → `deps`; a security advisory → `security`. |
| Lexical rules on the title and description | `profile.rules` in `factory/planner.yaml` | A Conventional-Commit prefix (`docs:`, `fix:`), or keywords ("typo", "rename", "migrate", "redesign"). |
| Paths named in the task | file paths in the text, stack frames from Sentry, the files of a linked PR | Areas (through `areas` globs), repos, and the sensitivity floor. |
| Done-when lines | P5 criteria (`packages/domain/src/entities/criteria.ts`) | Count, which nudges size (0–1 → xs/s, 2–4 → s/m, more → m/l). |
| Repositories | how many of `brain.yaml`'s repos are named or implied | More than one → at least `m`. |
| History | the brain's outcome fold (§9.1): earlier tasks with the same type and area | Median measured size of those tasks, and their revert and hold rates, which raise risk. |

**The sensitivity floor.** If any predicted or measured area is `critical`, risk is `high`. If any is `sensitive`, risk is at least `medium`. No other signal, model or person can lower risk below this floor. A person can still choose the Quick lane for a sensitive task (it's their call), and the merge decision still asks (§8).

**The model tiebreak.** The classifier pass runs only when:
- type is still `unknown` after every rule; or
- two rules disagree on type or differ on size by more than one step; or
- the task names no paths and the project has more than one repo.

It runs on the **economy model** of the planner's role (P12, `RoleModels.economyModel`), with the title, description, criteria, the repo list and the area names. It returns JSON validated with zod: `{ type, size, areas[], why }`, each picked from enumerated values. Its spend is measured like any run. Its output is a set of signals, not a verdict: it fills gaps and breaks ties, and it can never lower risk below the floor. If it fails, times out, or returns something invalid, the profile uses the conservative default for each missing field (`type: unknown`, `size: m`, `risk: medium`) and says so. It never blocks Start.

### 3. The factory definition: `factory/planner.yaml`

A new codec item kind (`planner`), carried byte for byte by the P15 codec (`packages/application/src/setup/codec.ts`) like #51's `tracker.yaml`. Structural under #51 §8. Shape, in YAML:

```yaml
version: 1
areas:                                  # first match wins per file; unmatched files have no area
  - name: migrations
    paths: ["**/migrations/**", "**/*.sql"]
    sensitivity: critical
  - name: auth
    paths: ["**/auth/**", "**/session*/**", "**/*oauth*"]
    sensitivity: critical
    skills: [security-review]           # added to every agent step that touches it
  - name: payments
    paths: ["**/billing/**", "**/payment*/**", "**/stripe*/**"]
    sensitivity: critical
  - name: ci-and-infra
    paths: [".github/**", "infra/**", "**/Dockerfile", "**/*.tf", "**/docker-compose*.yml"]
    sensitivity: critical
  - name: dependencies
    paths: ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/go.sum", "**/Cargo.lock"]
    sensitivity: sensitive
  - name: desktop-ui
    paths: ["apps/desktop/src/renderer/**"]
    sensitivity: none
    skills: [frontend-design]
  - name: docs
    paths: ["docs/**", "**/*.md"]
    sensitivity: none

profile:
  rules:                                # gate-language conditions over profile facts; first match per field
    - when: 'item.prefix == "docs"'
      set: { type: docs, size: xs }
    - when: 'item.keywords_any("typo", "copy", "rename")'
      set: { size: xs }
    - when: 'item.keywords_any("migrate", "migration", "schema")'
      set: { risk: high }
    - when: 'item.keywords_any("redesign", "rewrite", "new screen")'
      set: { type: feature, size: l }

lanes:                                  # first matching rule chooses the lane
  - when: 'profile.risk == "high" || profile.size == "l"'
    lane: careful
  - when: 'profile.risk == "low" && (profile.size == "xs" || profile.size == "s")'
    lane: quick
  - lane: standard                      # the default

laneWorkflows:                          # lane → workflow id in factory/workflows/
  quick: quick
  standard: standard
  careful: careful
byType:                                 # optional: a type with its own workflow per lane
  fix: { standard: fix, careful: fix-careful }

modules:                                # additive; see §5.2
  - name: security-review
    when: 'profile.areas_any("auth", "payments")'
    add:
      step: { key: security_review, class: review, role: review, after: implement, skills: [security-review],
              gate: 'artifact.ReviewReport.exists && review.blocking_findings == 0' }
  - name: build-must-pass
    when: 'profile.areas_any("migrations", "ci-and-infra")'
    add:
      gateClause: { step: implement, clause: 'checks.build == PASS' }
  - name: ui-look
    when: 'profile.areas_any("desktop-ui") && profile.type == "feature"'
    add:
      approval: { step: implement, when: after, reason: 'A person looks at new screens before they ship.' }

holdApproval:                           # plan-time tightening from holds (§5.3)
  minTasks: 5
  rate: 0.4

tiebreak: on                            # on | off: the cheap classifier pass
```

The conditions use the gate language with a new `item.*` and `profile.*` fact namespace (pure, measured from the tracker item and the profile, added to `GATE_FACT_VOCABULARY` in `packages/domain/src/gate-facts.ts` with `scope: 'plan'`). A `when` that doesn't parse is a validation error on load, shown in the Brain screen's Factory part, and that rule is skipped. One bad rule never stops planning.

**When a project has no brain** or no `planner.yaml`, the daemon uses the shipped default (the file above, minus project-specific areas), from `packages/application/src/planning/defaults/`. The Brain screen offers **Write the defaults into the brain** so the owner can edit them.

### 4. Lanes, and how much ceremony survives

Three lanes ship as workflows (they replace the three presets as what a new brain gets; the presets stay as the last-resort fallback in `presets.ts`).

| | **Quick** | **Standard** | **Careful** |
|---|---|---|---|
| Typical profile | xs/s, low risk: a typo, a small fix, a dependency bump, docs | m, or medium risk | l, high risk, `security`, or many repos |
| Refinement (P6) | Never | Only if the item has no description at all | When readiness fails (`READY_TO_PLAN_GATE`), as today |
| Done-when (P5) | Kept if the tracker gave criteria; never asked for. With none, one **implicit** criterion: "The task as written in the tracker is done." | Same as quick, plus the agent proposes criteria in its ChangeSet (`proposed`, as today) | Required, as today |
| Planner model run | No | No | Yes: today's planner run, with the `careful` workflow as its preset, tailors the plan |
| Plan approval | No | No | Yes (`planApproval: ask`) |
| Steps | `implement` (tests in the gate) → `ship` | `implement` → `review` (independent model) → `verify` (only when there are user criteria) → `ship` | `spec` → `architecture` → `implement` → `review` → `verify` → `ship`, plus modules; the planner may add or drop design |
| Merge | Decided by risk (§8) | Decided by risk | Always asks |

**What survives of today's ceremony, and when:**
- **Refinement and the readiness gate** survive only in the careful lane. In quick and standard lanes, a Start with no criteria plans at once. This changes #52 §7's call ("with no criteria, the mission opens as a draft"). The implicit criterion is recorded with `source: 'implicit'` and shows as "Not independently verified" until a reviewer or QA covers it.
- **Done-when** survives everywhere it was *given*, and is required only for careful work. A criterion that wasn't verified (no QA step ran) is never hidden. It shows "Not independently verified", and it counts in the merge decision (`criteria.unverified`, §8.2).
- **Plan approval** survives in the careful lane, and wherever the project sets `planApproval: ask` explicitly in `factory/tandemise.yaml`. The default of `DEFAULT_AUTONOMY.planApproval` changes from `'ask'` to `'auto'` for projects that link a brain with a `planner.yaml`. Existing projects keep their setting.
- **The release step** (`release_candidate`, `presets.ts:174`) is retired from lane workflows. Its job (confirm gates against evidence, state risks, write the rollback) moves to the ship step, which does it from measured facts instead of an agent's write-up. Its "shipping is always a human decision" approval becomes the merge decision.

**The principle: skipped ceremony moves risk to the merge, it never disappears.** Each step a lane skips is visible on the plan ("No QA step: quick lane") and raises the merge decision's score when it matters (unverified criteria, no independent review).

### 5. Plan synthesis

`PlannerService.plan(mission, profile, brainSha)` in `@tandemise/application`, called from `PlanningServiceImpl#planWithin` before the authored-workflow shortcut:

1. **Profile** the task (§2), with the item and signals #52 recorded at Start.
2. **Choose the lane.** A person's Quick or Careful wins; otherwise the first matching `lanes` rule.
3. **Compile the lane's workflow** from the brain (`factory/workflows/<id>.yaml`, by the precedence in #51 §2) with the existing `compileWorkflow` (`packages/domain/src/workflow.ts:189`). Workflow steps gain one optional field, `class` (the step class), defaulted from the role (`development` → `implement`, `review` → `review`, `qa` → `verify`, …).
4. **Apply modules** (§5.2).
5. **Route models** per step (§6), writing each task's `modelPolicy` (`model`, `escalate`).
6. **Pin skills**: the step's own `skills`, plus each matching area's `skills`, through the existing P13 pinner (`skillPinner`, used in `planning-service.ts:338`).
7. **Validate** with `validateMissionPlan` (`packages/domain/src/plan.ts:122`). An invalid result drops the modules that made it invalid (each named in the plan's "why"), then falls back to the lane's bare workflow, then to today's ladder. Planning never fails because of a rule.
8. **Careful lane only:** hand the compiled plan to today's planner run as its preset, so the model tailors it. The tailored plan is then put back through steps 4 to 7, so modules, routing and gates survive any tailoring. A model can't drop a module's step or gate.
9. **Record the decision** (§5.5) and either accept (quick, standard) or request approval (careful), through the existing `#requestApprovalOrAccept`.

#### 5.1 Speed budget

Quick and standard lanes do steps 1 to 7 and 9 with no model call (unless the tiebreak runs). The target is under 200 ms from Start to the first task READY, measured in the offline check. The brain read is at the attempt's pinned `brainSha` (#51 §4), so planning never waits for a pull older than five minutes.

#### 5.2 Modules only add

A module may:
- insert a step (with `after`, wired into `dependsOn`);
- add a clause to a step's gate (`&&`, never `||`);
- add an approval (`before` or `after`);
- add skills;
- raise a step's `maxAttempts` or move its model rung up.

It may never remove a step, a gate clause, an approval or a skill. The domain function `applyModules(plan, modules)` is pure, and the offline check proves the result's gates imply the input's gates for every step.

#### 5.3 Approvals: which steps need a person

A step gets a human approval when any of these holds, and the plan's "why" names which:
1. **The workflow says so** (`approval: before | after`), as today.
2. **A module adds one** (for example, a person looks at a new screen).
3. **Policy demands one**: the step's capabilities include a `destructive` or `release` risk class (`packages/policy/src/risk.ts`), as MVP.md §18.2 already requires. The planner can't remove these; they're enforced at run time anyway.
4. **People keep stepping in here.** For the step class and area, over the last `holdApproval.minTasks` (default 5) tasks, the share that were held (#50) or had changes requested is at least `holdApproval.rate` (default 40%). The plan adds an `after` approval for that step: "People stepped in on 3 of the last 5 desktop-ui implement steps, so you'll look at this one before it moves on." This is **tightening at plan time, for this task only**; it doesn't change the factory. The same evidence opens a promotion proposal to add the approval to the workflow for good (§9.2).

Nothing removes an approval at plan time. Loosening is a brain PR.

#### 5.4 Escalating the lane mid-mission

After each code-writing step, the daemon re-profiles from the step's ChangeSet and worktree diff (`diff.files_changed` exists today; this adds the paths). If the measured profile would choose a stricter lane, or match a module the plan doesn't have, the planner **adds** the missing steps and gates through the replan-the-rest machinery (`2026-10-09-replan-the-rest-design.md`) without asking, because it only adds. The feed says so: "It touched `auth/session.ts`, so I added a security review." A measured profile that would choose a *lighter* lane changes nothing.

A person can switch the lane at any time before the ship step: **Make it careful** (adds steps, as above) or **Make it quick** (asks first, through the existing replan card, because it removes steps; the merge decision then sees `lane.lightened_by_person`).

#### 5.5 The plan decision record

A new `plan_decisions` table (additive migration), one row per planning pass: `missionId`, `brainSha`, the profile (predicted), lane, workflow id, modules applied (and dropped, with why), per step the model with its routing reason and ladder, the approvals and their reasons, skipped ceremony, and the tiebreak's spend if it ran. It's the source for the "Why these steps" UI (§10) and for the brain's history entry (#51 §5). The MissionPlan artifact's front matter gains `lane` and `profile` so a plan read on its own still says how it was chosen.

### 6. Model routing and escalation

#### 6.1 The routing table: `factory/routing.yaml`

```yaml
version: 1
target: 0.8              # first-attempt gate pass rate a model must reach to be chosen
minSamples: 8            # tasks in a bucket before measured data overrides the default
probeEvery: 10           # every Nth low-risk task in a well-served bucket tries one rung cheaper; 0 = never
classes:
  implement:
    ladder: [haiku, sonnet, opus]   # the models this project allows, cheapest first
    default: sonnet                 # where a bucket with too little data starts
  review:
    ladder: [sonnet, opus]
    default: sonnet
    independentOf: implement        # becomes modelPolicy.independentOf
  verify:
    ladder: [haiku, sonnet]
    default: haiku
  spec:
    ladder: [sonnet, opus]
    default: opus
```

Model names are plain strings, passed through verbatim as P12 requires (`models.ts`: "Tandemise never ships a list of them"). The shipped default has no `classes` at all, so every step falls back to the role's model, as today, until the owner writes a ladder. **Write a ladder** in the Brain screen proposes one from the models the project's roles already use.

#### 6.2 Choosing the starting rung (automatic, within approved bounds)

A **bucket** is `(step class, lane, highest area sensitivity)`. For each model on the class's ladder, the outcome fold (§9.1) gives, over that bucket:
- `n`: tasks;
- first-attempt gate pass rate;
- hold rate;
- changes-requested rate;
- revert rate (for implement steps, from the merge outcome);
- median measured cost and wall time (null when unmeasured, never 0).

**Success** for a task is: the gate passed on the first attempt, no hold, no changes requested, and (for implement) not reverted. The starting rung is:
1. the class's `default`, if fewer than `minSamples` tasks in the bucket have data for any rung; otherwise
2. the cheapest rung whose success rate's Wilson lower bound (95%) is at least `target`; otherwise
3. the most successful rung measured.

Then, for low-risk buckets only, every `probeEvery`th task starts one rung cheaper than the choice, so cheaper models keep getting measured. A probe is labelled on the plan ("Trying haiku: it hasn't been measured on enough small fixes").

This is the only decision the factory changes on its own from outcomes, and it is bounded: it picks among models the owner put on the ladder. Changing the ladder, `target` or `default` is a structural brain change (a PR), because it changes spend and what code runs (#51 §8).

#### 6.3 Escalation

The task's `modelPolicy.escalate` is the rest of the ladder above the starting rung. `resolveModel`'s existing rule R2 (attempt ≥ 2 → next rung) does the escalation unchanged. Two additions:
- A **hold that ends with `continued`** (#50) doesn't spend an attempt and doesn't escalate. The person fixed it in the same session. It counts against the rung in the routing stats.
- A **request-changes round** (`FeedbackRounds.beginRound`) on an implement step starts its next run one rung up, unless the person pins a model. A reviewer having to send work back is a failure of that rung.

`ModelPolicy` gains an optional `reason` (for example "routed: sonnet passed 23 of 25 similar small fixes first time"). `resolveModel` returns it for source `step` instead of "step override". Economy mode (R3) still wins over a routed model when a limit is past its warning level, as P8 intends, and the run says so.

#### 6.4 Skills per step

Skills are chosen deterministically: the workflow step's `skills`, plus every matching area's `skills`, plus a module's. Missing skills are refused at start (P13). The routing table doesn't route skills. Whether a skill helps is a lesson for the brain's promotion flow (P3b evals), not a per-task decision.

### 7. Gate selection

Gates come from three places, merged by `&&`:
1. the lane workflow's step gates (the shipped lanes reuse today's clauses: `testsClause`, `SPEC_CRITERIA_GATE`, `QA_CRITERIA_GATE` from `presets.ts`);
2. module clauses (§5.2);
3. one **fixed engine clause** for every implement step in quick and standard lanes: `checks.tests == PASS` when the repository declares a test command (`testsClause` already does this). A quick lane has no QA step, so the test run carries the weight.

The ship step has no gate expression. Its rules are the merge policy (§8). It uses the same evaluator, so the vocabulary is shared.

### 8. The merge decision

#### 8.1 The ship step

Every plan whose steps write code ends with one **ship** step. The planner appends it; a workflow can't omit it, but can place it. It is a new `executor: ship` (alongside `agent`, `human`, `wait` in `workflow.ts`). It runs no agent and is held by nobody. What it does, in order, persisting each transition before its side effect (the engine's rule):
1. **Integrate**: today's `BranchIntegrationService.integrate` (`packages/application/src/engine/branch-integration.ts:54`), moved from `Scheduler#finish` (`scheduler.ts:585`) into this step, so conflicts still become `resolve_conflicts_N` tasks before a PR exists.
2. **Push and open the PR** from the daemon, not an agent: a new `PullRequestPort.open` in `integration-github`, idempotent by head branch like today's `github.pr.create` tool. The PR is **not a draft**. Its title is a Conventional Commit derived from the profile type and the tracker title (`fix: …`). Its body carries the tracker link, the Done-when table and the plan's "why". One PR per repository the mission changed.
3. **Wait for CI** on the head commit (`gh pr checks`), as a wait does today: every check finished, polled with the waiter's backoff. A failed check sends the work back: a request-changes round on the implement step with the failing check's log tail as the note, through `FeedbackRounds.beginRound` (the only reopen path), up to the step's attempts. Then the mission asks a person.
4. **Measure** the merge inputs (§8.2) at that exact head SHA.
5. **Decide** merge or ask (§8.3), and record it (§8.6).
6. **Merge** (§8.5), or **ask**: move the tracker item to `in_review` (#52 §7), request reviewers from `merge.yaml`, and file one approval in the Inbox ("Review and merge"). Either a person's merge in GitHub or **Merge** in the app finishes the step.

The mission is COMPLETE when every PR it opened is merged. A PR closed unmerged leaves the mission BLOCKED with "The pull request was closed without merging", and **Reopen** or **Cancel**. Today's `#finish` keeps only the failure, cancellation and completion bookkeeping.

#### 8.2 Inputs: measured, never self-reported

All inputs are facts measured by the daemon from git, GitHub and its own records, and exposed through the gate vocabulary under new names (`scope: 'ship'`):

| Fact | Measured from |
|---|---|
| `change.files`, `change.lines_added`, `change.lines_removed` | `git diff --numstat base...head` |
| `change.areas`, `change.max_sensitivity`, `change.paths_matching(glob)` | the diff's paths against `areas` |
| `change.repos` | PRs this mission opened |
| `change.dependencies_changed`, `change.lockfile_only` | manifest and lockfile paths in the diff |
| `change.binary_files`, `change.deleted_files` | `--numstat` and `--diff-filter=D` |
| `change.tests_touched` | changed paths matching the project's test globs (`merge.yaml` `tests`) |
| `coverage.changed_lines` | percent of changed lines covered, only when the repository's checks produce a coverage report; otherwise not measured (null), which never satisfies a rule |
| `ci.state` | `PASS` only when every check on the head SHA succeeded and there is at least one check |
| `ci.required_present` | the base branch has required status checks |
| `github.review_required` | branch protection requires an approving review |
| `checks.tests` | the daemon's own last test run on that commit (`packages/application/src/engine/checks.ts`) |
| `review.blocking_findings`, `review.major_findings`, `review.independent` | existing facts, when a review step ran; null otherwise |
| `criteria.unverified`, `criteria.implicit` | the P5 ledger: user criteria not verified by a QA report; whether the only criterion is implicit |
| `process.lane`, `process.lightened_by_person`, `process.steps_skipped` | the plan decision |
| `process.holds`, `process.changes_requested`, `process.escalations`, `process.gate_retries` | this mission's holds, rounds and attempts |
| `process.person_commits` | commits on the PR not authored by the daemon or the agent (someone edited it) |
| `history.area_reverts_90d`, `history.area_recent_revert` | the outcome fold (§9.1) for the areas touched |

**Never an input:** any text an agent wrote (ChangeSet claims, a ReleaseCandidate's risk list, PR body text), a model's rating, or the agent's confidence. The offline check asserts that the decision function's input type has no field sourced from an artifact body.

#### 8.3 The policy: `factory/merge.yaml`

A new codec item kind (`merge`), structural (#51 §8). The shipped default, written when a brain is created:

```yaml
version: 1
autoMerge: off                 # off | on. Only a person turns it on, per project.
method: squash                 # squash | merge | rebase
reviewers: []                  # GitHub handles or teams requested when it asks
tests: ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "scratch/**/*-check.mjs"]

never:                         # any match → ask, whatever the score
  - paths: ["**/migrations/**", "**/*.sql"]
  - paths: [".github/**", "infra/**", "**/*.tf", "**/Dockerfile"]
  - paths: ["**/.env*", "**/secrets*", "CODEOWNERS", "**/CODEOWNERS"]
  - areas: [auth, payments]
  - when: 'change.deleted_files > 0 && change.max_sensitivity != "none"'
  - when: 'process.lane == "careful"'
  - when: 'process.person_commits > 0'          # a person edited it: they should look at the result

requires:                      # all must hold to merge; each failure is an "ask" reason
  - 'ci.state == PASS'
  - 'checks.tests != FAIL'
  - 'review.blocking_findings == 0 || review.blocking_findings == null'

score:                         # points; the sum is the risk score
  - { when: 'change.lines_added + change.lines_removed > 400', points: 3, why: 'over 400 lines changed' }
  - { when: 'change.lines_added + change.lines_removed > 100', points: 1, why: 'over 100 lines changed' }
  - { when: 'change.files > 15',                               points: 2, why: 'more than 15 files' }
  - { when: 'change.repos > 1',                                points: 2, why: 'spans repositories' }
  - { when: 'change.max_sensitivity == "sensitive"',           points: 2, why: 'touches a sensitive area' }
  - { when: 'change.dependencies_changed && !change.lockfile_only', points: 2, why: 'changes dependencies' }
  - { when: 'change.tests_touched == 0 && change.files > 1',   points: 2, why: 'no tests changed' }
  - { when: 'coverage.changed_lines < 60',                     points: 1, why: 'changed lines are poorly covered' }
  - { when: 'criteria.unverified > 0',                         points: 1, why: 'Done-when lines not independently verified' }
  - { when: 'review.independent != PASS',                      points: 1, why: 'no independent review' }
  - { when: 'process.holds > 0 || process.changes_requested > 0', points: 1, why: 'a person had to step in' }
  - { when: 'process.escalations > 1',                         points: 1, why: 'needed a stronger model twice' }
  - { when: 'process.lightened_by_person',                     points: 2, why: 'you made it quick' }
  - { when: 'history.area_recent_revert',                      points: 3, why: 'this area had a revert in the last 14 days' }

autoMergeAtMost: 2             # merge only when the score is at most this
```

**The decision**, a pure function `decideMerge(facts, policy) → MergeDecision` in `@tandemise/domain` (`merge/decide.ts`):
1. If `autoMerge` is `off` → **ask**, reason "Auto-merge is off for this project." (The score is still computed and shown, so the owner can see what *would* have happened.)
2. If `ci.state` isn't `PASS`, or the repository has no CI checks at all → **ask**. "Required CI green" can't be configured away: the `requires` list may add rules, and the `ci.state == PASS` rule is enforced by code even if the file omits it.
3. If `github.review_required` → **ask**, "This repository requires an approving review." Tandemise never merges with admin rights or bypasses branch protection.
4. Any `never` match → **ask**, naming the rule and the matching paths.
5. Any failing `requires` → **ask**, naming it.
6. Sum `score`. A rule whose facts aren't measured contributes nothing *and* is listed as "not measured", except that an unmeasured fact in `requires` or `never` counts as failing (unmeasured never passes, the engine's rule).
7. Score ≤ `autoMergeAtMost` → **merge**; otherwise **ask**, with the contributing factors.

A malformed `merge.yaml` means **ask** for every PR, with the parse error, never merge.

#### 8.4 Conservative defaults

- `autoMerge: off` in every new brain and in the shipped default. A project with no brain can never auto-merge.
- Turning it on is a person's edit in Project settings → **Merge**, written to `factory/merge.yaml` with the person as author (`humanEdits`, #51 §8). The app first shows the **backtest** (§9.3) over the project's past decisions. Turning it on records a Decision (`memory/decisions/`, MVP.md §14.4) — "Auto-merge low-risk PRs in Garipass", by whom and when. That standing, recorded human authorization is how this design reconciles MVP.md §18.2 ("merge protected branch: human approval required") with auto-merge: the owner approves the policy once, explicitly, and every merge cites it.
- The careful lane always asks (a `never` rule in the default).

#### 8.5 Merging the reviewed commit

- Every decision is bound to the **head SHA** it measured. The merge runs `gh pr merge <n> --<method> --match-head-commit <sha>`, so GitHub refuses it if anything was pushed after the decision. A new push voids the decision; the ship step measures and decides again.
- If the base branch requires the PR to be up to date and it isn't, the daemon updates the branch (`gh pr update-branch`), which changes the head. CI runs again and the decision is made again on the new SHA.
- When the repository allows auto-merge, the daemon uses `gh pr merge --auto --match-head-commit <sha>`, so GitHub itself enforces the required checks at merge time. Otherwise it merges directly after its own CI wait.
- The squash commit message carries trailers: `Tandemise-Merge: auto; score 1/2`, `Tandemise-Policy: <brain sha>`, `Tandemise-Mission: <tracker key>`.
- The merge uses the starting member's `gh` session, like every GitHub call (`packages/integration-github/src/gh.ts`: "Tandemise stores no GitHub credential"). With a relay (#54), the daemon that holds the item's claim is the only one that ships it.

#### 8.6 Audit

- A `merge_decisions` table (append-only, additive migration): `missionId`, `repo`, `prNumber`, `headSha`, `brainSha`, `verdict` (`merge` | `ask`), `score`, `factors` (each rule, its points or verdict, and the facts it read), the full input facts as JSON, `decidedAt`, and later `mergedAt`, `mergedBy` (`tandemise` or a member), `mergeSha`.
- Events: `ship.pr_opened`, `ship.decided`, `ship.merged`, `ship.asked`, `ship.reverted`, recorded with the existing recorder.
- **One PR comment** per decision, edited in place like #52's activity comment: "Tandemise merged this on its own: risk score 1 of 2 allowed. Touched `apps/web/src/pages/settings.tsx` (no sensitive areas), 34 lines, tests changed, CI green on `a1b2c3d`. Policy: garipass/brain@`9f8e7d6`." Or: "Tandemise asks for a review: touches `db/migrations/0042_add_index.sql` (never auto-merged in this project)."
- The brain's `history` entry for the mission (#51 §5) gains the verdict, the score and the PR URLs.
- The tracker's activity comment (#52) says "Merged on its own" or "Waiting for review".

#### 8.7 Rollback

- **Revert** on the mission, the merge card and the Brain history: the daemon creates `revert/<mergeSha>` with `git revert <mergeSha>`, opens a PR "revert: <original title>", and links it to the tracker item. The revert PR goes through the ship step like any change. Its own policy line: a revert of a change Tandemise auto-merged may itself auto-merge when CI is green and it touches nothing in `never` (a migration revert still asks). That's in the default `merge.yaml` as `revertAutoMerge: on`.
- **Watching main.** For 24 hours after a merge, the daemon reads the base branch's check runs on the merge commit at each board refresh. A failure records the outcome `broke_main`, puts a card in the Inbox with **Revert** and **Leave it**, and sets `history.area_recent_revert`-style caution for the area. It never reverts on its own.
- **Reverts done by others** are detected on the same refresh: a commit on the base branch whose message is GitHub's `Revert "<title>"` for a merged PR, or whose diff reverses the merge commit's. They record the outcome `reverted`.
- **A kill switch**: Project settings → Merge → **Stop auto-merging** writes `autoMerge: off` (a human edit), and every PR waiting in a ship step is re-decided as **ask** at once.

### 9. Learning from outcomes

#### 9.1 Outcomes into the brain

This design adds one event op to #51's ledger (`memory/ledger/<yyyy>/<mm>/<writer>.jsonl`), with the same append-only, per-writer, deterministic-fold rules:

```ts
| { op: 'outcome'; id: OutcomeId; at: Iso; by: WriterId;
    mission: string; tracker?: string;            // portable references, as in #51 EntryBody.source
    lane: 'quick' | 'standard' | 'careful'; profile: { type; size; risk; areas: string[] };
    kind: 'merged_clean' | 'merged_by_person' | 'reverted' | 'broke_main' | 'changes_requested'
        | 'held' | 'closed_unmerged' | 'step_result';
    step?: { class: string; model: string | null; attempt: number; gatePassed: boolean;
             costUsd: number | null; wallTimeMs: number | null };
    merge?: { verdict: 'merge' | 'ask'; score: number; pr: string } }
```

- A `step_result` is written when a step settles, from its `RunScore` (`packages/domain/src/entities/eval.ts:25`). A `held` is written from `task.hold_ended` (#50). A `changes_requested` from a feedback round or a GitHub review in `CHANGES_REQUESTED`. The merge outcomes from §8.
- A merge Tandemise runs is `merged`, on its own or on a person's **Merge**; on a Merge, `merge.approval` keeps who approved it and the card (#174). `merged_by_person` is only a merge Tandemise didn't run: one made in GitHub, or of a head it never decided on. The feed says "Merged on its own", "Merged on your approval" or "Merged in GitHub by <login>".
- `merged_clean` is written seven days after a merge with no revert and no `broke_main`. "Clean" can't be known at merge time.
- `foldOutcomes(events) → OutcomeStats` is pure (`@tandemise/domain`, `brain/outcomes.ts`), keyed by bucket and model, and feeds §6.2, §5.3 and the `history.*` merge facts. Every teammate's daemon folds the same events into the same table, so routing is shared without a server.
- Eval trials (`isTrialMission`) write no outcomes, as #51 requires.

#### 9.2 What changes on its own, and what is a PR

| Change | How |
|---|---|
| The starting rung within an approved ladder (§6.2) | On its own, from the fold. Shown on every plan. |
| A plan-time approval on a step people keep stepping into (§5.3) | On its own, for that task only. Tightening. |
| A merge "recent revert in this area" penalty | On its own, from `history.*` facts. Tightening. |
| Adding a model to a ladder, removing one, changing `default` or `target` | A promotion PR (structural). |
| Adding an approval or a module to the factory for good | A promotion PR, opened when the §5.3 evidence holds across `promotion.minMissions` missions. |
| Raising `autoMergeAtMost`, dropping a `never` rule, lowering a score's points | A promotion PR, **never auto-applied**, with a backtest. |
| Lowering `autoMergeAtMost`, adding a `never` rule (after reverts in an area) | A promotion PR with a backtest. Tightening still goes through review, because a factory file changes (#51 §8: any change to `factory/` outside role prose is structural). |

The proposals are drafted by **code, not a model**: each is a specific edit to a YAML key, with the evidence (the outcomes and their missions) and a backtest. They use #51 §8's path exactly: branch `tandemise/promote/<id>`, classification (always structural), PR with evidence, and fate read on sync. A PR closed unmerged isn't proposed again until the evidence doubles.

#### 9.3 Backtests instead of evals for policy

P3b evals can't measure a merge policy (they replay steps, not merges). So every merge-policy proposal, and the owner's own edit in the Merge settings, carries a **backtest**: the daemon replays the candidate `merge.yaml` over the stored inputs of every `merge_decisions` row in the window (default 90 days), with `decideMerge`, and reports:
- how many PRs would have merged on their own under the current and the candidate policy;
- of the ones that change verdict, how many were later reverted or broke main;
- the PRs that change, as links.

The backtest is computed by the daemon from stored facts. The proposal's author (the code that drafted it) doesn't compute its own score, in the spirit of #51's "the proposer can't see or edit these evals". Routing-ladder proposals run P3b evals through #51's `{ kind: 'brain' }` candidate as usual.

### 10. What the person sees

UI copy follows the conventions: "you", plain verbs, no raw enums or tool names.

- **Start** (Board, #52): **Start** runs with the factory's choice. A small menu beside it offers **Start quick** and **Start careful**.
- **Plan header, "Why these steps"** (the mission's Plan view):
  - Chips: "Fix · small · low risk". Each opens its signals: "Tracker type Bug → fix", "Mentions `apps/web/src/pages/settings.tsx` → web, not sensitive", "9 similar fixes: median 2 files".
  - "Quick lane: one step, then a pull request." Skipped ceremony, in words: "No plan approval. No separate review or QA: the tests carry it, and the merge decision will take that into account."
  - Modules applied: "Added a security review because it touches `auth/`."
  - Per step: "Implement · sonnet · passed 23 of 25 similar fixes first time · if it fails, opus".
  - When the tiebreak ran: "Couldn't tell from the tracker whether this is a fix or a feature; asked haiku (0.2¢): fix."
  - **Make it careful** / **Make it quick**.
- **Ship card** (the ship step in Plan, Feed and TaskDetail): "Opening the pull request" → "Waiting for CI (3 of 5 checks done)" → one of:
  - "Merged on its own" with the score ("1 of 2 allowed"), each factor, the policy's brain commit, a link to the PR and **Revert**;
  - "Waiting for your review" with the reasons in plain words ("Touches `db/migrations/` — never merged on its own in this project", "412 lines changed"), **Open in GitHub**, **Merge** (a person's approval through `ApprovalService.decide`, the single place human decisions take effect), and "What would have happened with auto-merge on" when it's off.
- **Inbox**: one row per PR waiting for review, and one per `broke_main`.
- **Project settings → Merge**: the on/off switch with the backtest beside it ("Over the last 90 days this would have merged 14 of 31 pull requests on its own; none of those 14 were reverted"), the `never` list, the score table, **Stop auto-merging**. Edits write to the brain.
- **Brain screen → Factory**: `planner.yaml`, `routing.yaml` and `merge.yaml` at `lastPulledSha`, their problems (rules that don't parse), and **Routing**: per bucket, each model's measured stats and the current starting rung.
- **Feed lines** (not notifications): "Added a security review: it touched `auth/session.ts`", "Merged on its own (score 1 of 2)", "Asked for a review: touches a migration".

### 11. API (sketch)

Following `api-contract/src/setup.ts`:
- `GET /v1/missions/:id/plan-decision` → the "why" record.
- `POST /v1/missions/:id/lane` `{ lane: 'quick' | 'careful' }`.
- `GET /v1/missions/:id/ship` → PRs, CI state, decisions and factors.
- `POST /v1/ship/:decisionId/merge` (a person's merge), `POST /v1/ship/:decisionId/revert`.
- `GET /v1/workspaces/:id/merge-policy`, `PUT …/merge-policy` (a human edit to the brain), `POST …/merge-policy/backtest { policy }`.
- `GET /v1/workspaces/:id/routing` → buckets and stats.
- `POST /v1/tracker-items/:ref/start` (#52) gains `lane?: 'quick' | 'careful'`.

Refusals in the daemon's own words, for example: "This repository requires an approving review, so Tandemise can't merge it on its own." "The pull request changed after it was checked; checking again."

### 12. Layers

- **`@tandemise/domain`**: `planner/profile.ts` (`profileTask`), `planner/lanes.ts` (lane choice, `applyModules`), `planner/routing.ts` (bucket stats → rung), `merge/decide.ts` (`decideMerge`), `merge/policy.ts` (zod schema of `merge.yaml`), `brain/outcomes.ts` (`foldOutcomes`), the new `item.*`, `profile.*`, `change.*`, `ci.*`, `process.*`, `history.*` facts in `gate-facts.ts`, and `executor: ship` and `class` in `workflow.ts`. All pure.
- **`@tandemise/application`**: `PlannerService` (called from `PlanningServiceImpl`), the tiebreak pass, `ShipService` (the ship step's state machine, run by the scheduler like the `Waiter`), the post-merge watcher, outcome writing through `BrainService`, and the proposal drafter.
- **`integration-github`**: a `PullRequestPort` with `open`, `checks`, `merge` (with `matchHeadCommit`), `updateBranch`, `reviews`, `protection`, beside `pull-requests.ts`. All through `gh`, as `tools.ts` does today.
- **`persistence`**: additive migrations for `plan_decisions` and `merge_decisions`, and the `ship` executor in the task CHECK (widened in place on `sqlite_master`, as migration 006 does; never a table rebuild).
- **`apps/desktop`**: a control surface over the API (`npm run check:boundaries`).

### 13. Phasing

One sub-project, five PRs, each proven in the real app before the next:

1. **Profile, lanes and "why".** `planner.yaml`, `profileTask`, the three lane workflows, modules, plan decisions and the Plan header. No merge yet: the ship step only opens a non-draft PR.
2. **Routing.** `routing.yaml`, outcome events for steps and holds, the fold, rung choice, escalation on request-changes, and the Routing view.
3. **Ship and decide (asking only).** The ship step, CI wait, `merge.yaml`, `decideMerge`, the audit trail, the PR comment and the ship card. `autoMerge` can't be turned on yet; every decision is "ask", with "what would have happened" shown.
4. **Auto-merge.** The switch, the backtest, merging with `--match-head-commit`, Revert, the post-merge watch and the kill switch.
5. **Learning proposals.** Merge outcomes, `history.*` facts, the proposal drafter and its PRs.

Phase 3 alone removes the manual end of every task, and gives the owner weeks of "would have merged" evidence before phase 4 asks them to trust it.

## Constraints

- Everything runs locally (pivot decisions). No server is needed; a relay only decides which daemon ships a claimed item.
- Planning never fails because of the planner: every new rung falls back to today's ladder.
- Persist the transition before the side effect, publish events after commit (`recorder.deferred`), and change status only through `canTransition`.
- Unmeasured stays null and never satisfies a rule, a gate or a merge requirement.
- Eval trials are excluded from the ship step (they never open PRs), from outcomes and from routing.
- One additive migration per phase that needs one.
- Repo artifacts in English.

## Acceptance

**Offline**, written first and seen failing, added to `OFFLINE_CHECKS` in `scripts/run-checks.mjs`:

`scratch/planner-check.mjs`:
1. **Profiles.** A table of tracker items (type, labels, title, paths, criteria) → expected type, size and risk. The sensitivity floor holds against every other signal, including a person's Quick and a tiebreak that says "low".
2. **Tiebreak.** It runs only on the three trigger conditions. A fake runtime returning garbage yields the conservative default and no failure. Its spend is recorded.
3. **Lanes.** Each lane rule picks the expected workflow. A person's choice wins. A `when` that doesn't parse is skipped and reported.
4. **Modules only add.** For random plans and module sets, every step's gate after `applyModules` implies the gate before it, and no step, approval or skill disappears.
5. **Ceremony.** A quick-lane Start with no criteria plans at once with an implicit criterion, accepts the plan without approval, and makes no planner model call. A careful-lane Start with no criteria opens a draft for refinement and asks for plan approval.
6. **Speed.** Quick-lane planning from Start to the first READY task is under 200 ms against a fake brain.
7. **Mid-mission escalation.** An implement step whose diff touches `auth/` adds the security review step without an approval card; a measured lighter profile changes nothing.
8. **Plan-time approvals from holds.** Five fake outcomes with three holds on (implement, desktop-ui) add an `after` approval to the next such task, and not to a docs task.

`scratch/routing-check.mjs`:
1. **Fold determinism.** The same outcome events in any order give the same stats (shuffled 100 times). Two writers' events fold equally.
2. **Rung choice.** Below `minSamples` → default. With data → the cheapest rung whose Wilson lower bound clears `target`. Probing happens on every `probeEvery`th low-risk task and never on high risk.
3. **Bounds.** No outcome data ever produces a model that isn't on the ladder.
4. **Escalation.** Attempt 2 takes the next rung; a request-changes round on implement starts one rung up; a `continued` hold doesn't escalate. Economy mode still wins under limit pressure.

`scratch/merge-check.mjs` (fake `gh` on `PATH` recording its arguments, as `scratch/fake-gh.mjs` does; a bare repo as the remote):
1. **Decision table.** For each row of the default policy (every `never`, every `requires`, every score line), a diff that triggers it gives the expected verdict and reason.
2. **Hard rules.** `autoMerge: off` always asks. No CI → asks, even when `merge.yaml` omits the CI rule. Required review → asks. A malformed `merge.yaml` → asks.
3. **No self-report.** An agent's ChangeSet and ReleaseCandidate claiming "no risk" change nothing. The decision input type has no artifact-body field.
4. **Reviewed commit.** Every merge call carries `--match-head-commit` with the decided SHA. A push after the decision voids it and a new decision is made on the new SHA.
5. **Audit.** Each decision writes one `merge_decisions` row with all its inputs, one PR comment (edited, not duplicated, on a second decision), and the trailers in the squash message.
6. **Revert and watch.** Revert opens a revert PR that auto-merges under `revertAutoMerge` unless it touches a `never` path. A failing check on the merge commit within 24 hours records `broke_main` and an Inbox card, and reverts nothing.
7. **Backtest.** Replaying a looser candidate over stored decisions reports the verdicts that change and how many of those PRs were reverted.
8. **Learning never loosens.** After reverts in an area, a proposal PR adds a `never` rule (fake `gh` saw `pr create` with the evidence); no code path writes `merge.yaml`, `routing.yaml` or `planner.yaml` except a person's edit or a promotion branch.

**Real app**, in `scratch/acceptance/planner/` (fresh `TANDEMISE_HOME`, daemon from this checkout, `electron-vite dev` over CDP, scripted agent, a bare repo plus fake `gh` as GitHub, a linked brain from #51's harness):

| # | Scenario | Must observe in the window |
|---|---|---|
| PM1 | Start a tracker item "fix: typo in the settings title", no criteria | No plan approval card; the Plan header reads "Fix · tiny · low risk" and "Quick lane"; one agent step, then the ship card; a non-draft PR in fake `gh` |
| PM2 | The same, auto-merge off | The ship card says "Waiting for your review", "Auto-merge is off for this project", and what would have happened ("would have merged: score 0 of 2") |
| PM3 | Turn auto-merge on in Project settings → Merge | The backtest is shown before saving; the brain gets a commit to `factory/merge.yaml` and a decision file |
| PM4 | Start another tiny fix with CI green | "Merged on its own" with factors; fake `gh` saw `pr merge --squash --match-head-commit <sha>`; the PR comment explains it |
| PM5 | Start a task whose change touches `db/migrations/` | "Waiting for your review: touches `db/migrations/` …"; no merge call |
| PM6 | Start a task predicted quick whose implement step edits `src/auth/session.ts` | The feed says "Added a security review"; the review step runs |
| PM7 | Start careful | Refinement when there are no criteria, then a tailored plan with an approval card |
| PM8 | Push a commit to the PR branch after a "merge" decision but before the merge | The decision is voided and remade on the new SHA |
| PM9 | Press Revert on PM4's merge | A revert PR is opened and merged on its own; the mission's history shows both |
| PM10 | Hold (#50) the implement step of three desktop-ui tasks, then start a fourth | The fourth's plan has "You'll look at this before it moves on" with the reason |

PM1, PM4 and PM6 also run with real Claude Code when it is available, as the earlier phases' acceptance does. `npm run ci` is green.

## Left to the builder

- Exact numbers, as named constants with a comment saying why: the 200 ms budget, `minSamples`, `target`, the Wilson confidence, `probeEvery`, the hold-approval rate, the 7-day "clean" window, the 24-hour main watch, the 90-day backtest window, the default score table.
- The tiebreak prompt and its zod schema.
- The shipped default `areas` globs, and how they're seeded from a repository's own `CODEOWNERS` when one exists.
- How `class` defaults from role ids for custom roles.
- Whether the Plan header is a section or a panel.
- The exact PR comment and squash-message wording.

## Calls made without the owner

The owner gave autonomy within the pivot direction. These calls are open to correction:

1. **Plans are chosen by deterministic rules from the brain, not by a model.** A cheap model only breaks ties, can only pick enumerated values, and can never lower risk below the sensitivity floor. The planner model run survives only in the careful lane.
2. **Three lanes (quick, standard, careful)** replace the three presets as what a project starts with. The presets stay as the last fallback.
3. **Refinement, the readiness gate and plan approval survive only for careful work** (and wherever a project explicitly asks for plan approval). This reverses #52's "no criteria → draft" for quick and standard work, and changes the default `planApproval` to `auto` for projects with a planner policy.
4. **Skipped ceremony raises the merge score instead of disappearing**: unverified criteria, no independent review and "you made it quick" all count.
5. **The release-candidate step is retired from lanes.** Its job moves to a daemon-owned ship step that works from measured facts.
6. **PRs are opened by the daemon, not by an agent tool, and are not drafts.**
7. **The factory may change only the starting model rung on its own**, within a ladder the owner approved. Every other change from outcomes is a brain PR.
8. **Automation can only tighten, per task**: an approval after repeated holds, a revert penalty in an area. It never loosens anything, and tightening the factory files themselves is still a PR.
9. **Auto-merge is off until the owner turns it on per project**, and turning it on is recorded as a Decision in the brain. That standing, explicit approval is how auto-merge squares with MVP.md §18.2.
10. **CI green on the head commit is mandatory and can't be configured away.** A repository with no CI never auto-merges. Branch protection is never bypassed.
11. **The careful lane always asks, and so does any PR a person committed to.**
12. **Every merge is bound to the decided commit** (`--match-head-commit`), audited in a table, a PR comment, commit trailers and the brain history, and revertable in one action. Tandemise watches main after a merge but never reverts on its own.
13. **Merge-policy changes are justified by backtests over stored decisions**, not P3b evals, because evals replay steps, not merges.
14. **Outcomes are a new `outcome` op in #51's ledger**, so routing stats are shared across teammates with only git.
15. **A request-changes round escalates the model; a hold doesn't.** The person fixed the work in the same session, but the hold still counts against that model in the routing stats.
