# The factory: how much process a task gets, and when its pull request merges

A mission whose workflow is **Let the factory decide** (`auto`, the default in
New mission) is planned by rules, not by a model. The factory profiles the
task, picks a lane, adds steps where the change is risky, routes each step to
a model, and ends every code plan in a **ship** step that opens the pull
request, waits for CI, and either merges it or asks you. Every choice shows its
reasons on the Plan tab ("Why these steps") and on the ship card. Design:
`docs/superpowers/specs/2026-10-30-planner-and-merge-design.md` (#53).

## Three files

| File | Says |
|---|---|
| `planner.yaml` | the areas of your code and how sensitive each is, profile rules, which lane a profile gets, and modules that add steps, gate clauses or approvals |
| `routing.yaml` | for each step class, the models you allow (cheapest first) and where a step starts |
| `merge.yaml` | whether Tandemise may merge on its own, what never merges on its own, what must hold, and the risk score allowed |

They are read from, in order:

1. the project's brain, `factory/<name>.yaml` at its last pull, when the project has one;
2. each repository's `.tandemise/factory/<name>.yaml` (the project's default repository first);
3. this computer's `$TANDEMISE_HOME/factory/<name>.yaml`;
4. the built-in defaults.

**Project settings → Factory** shows where each came from and any rule that
can't be read (that rule is skipped; one bad rule never stops planning), and
**Write the defaults into the repository** gives you the built-in files to
edit. A `merge.yaml` that can't be read is never replaced by the default: every
pull request asks until it is fixed. In a project with a brain, your edits
(the Merge switch, Write the defaults) are commits to the brain's `factory/`
that take effect on this computer at once, pushed or not (a failed push shows
in the Brain section); when `brain.yaml` says `humanEdits: pr` they open a pull
request in the brain instead, except turning auto-merge off, which is always
direct;
the files show in the Brain screen's Factory tab, outcomes are written to the
brain's ledger so every teammate routes from the same history, and the
factory's proposals are pull requests in the brain repository.

## `planner.yaml`

```yaml
version: 1
areas:                       # first match wins per file
  - name: migrations
    paths: ["**/migrations/**", "**/*.sql"]
    sensitivity: critical    # none | sensitive | critical
  - name: auth
    paths: ["**/auth/**", "**/session*/**", "**/*oauth*"]
    sensitivity: critical
    skills: [security-review] # added to code and review steps that touch it
trackerTypes: { Bug: fix, Feature: feature }
labels: { dependencies: deps }
profile:
  rules:                     # first match per field
    - when: 'item.prefix == "docs"'
      set: { type: docs, size: xs }
lanes:                       # first match wins
  - when: 'profile.risk == "high" || profile.size == "l"'
    lane: careful
  - when: 'profile.risk == "low" && (profile.size == "xs" || profile.size == "s")'
    lane: quick
  - lane: standard
laneWorkflows: { quick: quick, standard: standard, careful: careful }
byType: { fix: { standard: fix, careful: fix-careful } }
modules:                     # only ever add
  - name: security-review
    when: 'profile.areas_any("auth", "payments")'
    add:
      step: { key: security_review, class: review, role: review, after: implement,
              gate: 'artifact.ReviewReport.exists && review.blocking_findings == 0' }
holdApproval: { minTasks: 5, rate: 0.4 }
tiebreak: on                 # a cheap model breaks ties only when the rules can't tell
```

- **Profile**: type, size and risk, each with the signals that set it. Any
  `critical` area makes risk high and any `sensitive` one at least medium: no
  rule, model or person can put risk below that floor.
- **Lanes**: *quick* is one step then the pull request (no refinement, no
  planner run, no plan approval); *standard* adds an independent review and,
  when you gave Done-when lines, verification; *careful* is spec, architecture,
  implement, review, verify, a plan you approve, and a pull request that always
  asks. Start quick or careful from the mission's header to choose yourself.
  A task with no Done-when line in a quick or standard lane gets one implicit
  line, "The task as written in the tracker is done.", shown as not
  independently verified.
- **Modules** add a step, a gate clause, an approval, skills or attempts. They
  never remove anything. When the ship step starts, the factory re-profiles
  from what actually changed and adds what a riskier change needs ("It touched
  `src/auth/session.ts`, so I added a security review.").
- **holdApproval**: when people stepped in on most of the last few tasks of a
  step class in an area, the next one gets a look from you after it, for that
  task only.

### Checks: what runs, how long it may take

A step's gate names the checks it needs (`checks.tests == PASS`); only those
run, in the step's worktree, after the agent finishes. The agent's prompt names
them and tells it not to run the full suite itself.

- **What changed decides what runs.** An area may say what a check runs when
  every changed file is in it:

  ```yaml
  areas:
    - name: docs
      paths: ["docs/**", "**/*.md"]
      checks: { tests: none, typecheck: none, lint: none, build: none }
    - name: design
      paths: ["packages/design/**"]
      checks: { tests: "npm run -w @tandemise/design test" }
  ```

  A docs-only change runs no test suite (the shipped `docs` area says so); a
  change inside `design` runs that command; a change with any file elsewhere
  runs the repository's own command. The pull request's CI still runs
  everything.
- **Once per tree.** A result is stored with the git tree it measured; a later
  step on the same tree reuses it instead of running the command again.
- **Time budgets.** Each check has a budget in minutes: the repository's own
  (Project settings → Repositories → Checks), else `checks.budgets` here
  (`checks: { budgets: { tests: 20 } }`), else 10. A check that runs out of
  time is `TIMEOUT`, not `FAIL`: it runs once more with twice the budget, and
  if it still does not finish the step asks you (raise the budget, change the
  command, retry or accept). It never costs the agent an attempt.
- **Retries keep what you said.** What you type during a Hold is quoted to
  every later attempt as binding. A retry is told to keep its change scoped;
  files it adds to the change are recorded as the `scope.retry` check, and the
  merge score adds points for it (`process.retry_out_of_scope`).

A project file `.tandemise/workflows/<id>.yaml` with a lane's id
(`quick`, `standard`, `careful`, `fix`, `fix-careful`) replaces that lane.

## `routing.yaml`

```yaml
version: 1
target: 0.8        # first-attempt success a model must confidently reach
minSamples: 8      # below this, a step starts at the class's default
probeEvery: 10     # every 10th low-risk task tries one rung cheaper; 0 = never
classes:
  implement: { ladder: [haiku, sonnet, opus], default: sonnet }
  review:    { ladder: [sonnet, opus], default: sonnet, independentOf: implement }
```

The built-in file has no ladders, so every step uses its role's model. With a
ladder, each step starts at the cheapest model whose success rate's 95% Wilson
lower bound reaches `target` for similar work (same class, lane and
sensitivity), and retries climb the ladder. A request-changes round moves the
next run up a rung. Routing only ever chooses among the models you listed.
**Project settings → Factory → Routing** shows each model's record.

## `merge.yaml`

```yaml
version: 1
autoMerge: off           # only a person turns it on, in Project settings → Merge
method: squash
reviewers: []
tests: ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**"]
never:                   # any match asks
  - paths: ["**/migrations/**", "**/*.sql"]
  - areas: [auth, payments]
  - when: 'process.lane == "careful"'
  - when: 'process.person_commits > 0'
requires:                # all must hold
  - 'ci.state == PASS'
  - 'checks.tests != FAIL'
score:                   # points; the sum must be at most autoMergeAtMost
  - { when: 'change.lines_added + change.lines_removed > 400', points: 3, why: 'over 400 lines changed' }
  - { when: 'review.independent != PASS', points: 1, why: 'no independent review' }
autoMergeAtMost: 2
revertAutoMerge: on      # a revert of an auto-merge may merge on its own
```

**Auto-merge needs a brain.** `autoMerge: on` counts only when `merge.yaml`
comes from the project's brain and a person turned it on in the app (an
accepted "Auto-merge low-risk pull requests in …" Decision); a repository's or
this computer's `merge.yaml` saying `on` is read as `off`. A change that touches
`.tandemise/**` or `factory/**` (Tandemise's own rules) always asks.

The decision reads only facts the daemon measured from git, GitHub and its own
records at the pull request's head commit, never anything an agent wrote. CI
green on that commit is required even if the file leaves it out: CI is read
from check runs (every page), check suites and commit statuses, and a pull
request with none yet waits a few minutes for CI to start before it is treated
as having none. A repository with no CI, or one whose branch protection (classic
protection or rulesets) requires a review, always asks, and protection that
can't be read counts as unknown, so it asks. A change whose diff can't be
measured asks, saying so. A person's commit is any non-merge commit on the
branch that Tandemise didn't push and didn't author (edits in GitHub's web UI
included); a branch rewritten after Tandemise pushed asks. An unmeasured fact fails `never` and `requires` and adds no points.
Every merge is bound to the decided commit (`gh pr merge --match-head-commit`),
so a push after the decision makes Tandemise decide again; `--auto` is used only
when the branch requires checks, and a queued auto-merge is cancelled
(`--disable-auto`) when the decision is voided or auto-merge is stopped. Your
Merge on a Review and merge card answers at once; if GitHub refuses it,
Tandemise keeps watching and tries again rather than marking the step blocked.
While GitHub keeps failing, it backs off (up to 10 minutes between looks) and
says so on the step. Turning auto-merge off in the brain (by any edit) ends the
in-app decision: turning it on again needs a person in the app.

Turning auto-merge on shows a **backtest** (your past decisions replayed under
the new policy) and records a Decision. **Stop auto-merging** turns it off and
re-decides every waiting pull request. Each decision is kept in full, written
as one comment on the pull request, and cited in the squash commit's
`Tandemise-Merge`, `Tandemise-Policy` and `Tandemise-Mission` trailers.
**Revert** on the ship card undoes a merge through its own pull request. For a
day after a merge, a failing check on main puts a card in the Inbox; Tandemise
never reverts on its own.

The factory proposes tighter rules (a `never` area after reverts, a look after
a step class people keep stepping in on, a model off a ladder) as pull requests
on `tandemise/promote/<id>`. It never loosens a rule: that is your edit.

## Facts for rules

The `item.*` and `profile.*` facts (planning rules) and the `change.*`,
`ci.*`, `criteria.*`, `process.*` and `history.*` facts (merge rules) are listed
in [Workflows](WORKFLOWS.md) under "Facts for factory rules".
