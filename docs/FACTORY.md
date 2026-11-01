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
ci:                          # CI on the pull request
  checks: { "deploy-*": code }   # what a failing check is about: metadata | code | unknown
  maxRounds: 3               # rounds a mission takes on its own before a card asks you
```

- **Profile**: type, size and risk, each with the signals that set it. Any
  `critical` area makes risk high and any `sensitive` one at least medium: no
  rule, model or person can put risk below that floor.
- **Type from the tracker**: the tracker item's own type (`trackerTypes`: a
  YouTrack `Bug` is a fix, a `User Story` a feature) and its labels or tags
  (`labels`: a GitHub `bug` label is a fix) set the type before any quick model
  is asked. Case, spaces and hyphens don't matter (`user-story` matches
  `User Story`). The pull request's title maps the tracker type the same way.
- **Keyword rules** (`item.keywords_any(...)`) read the item's title and its
  prose. Code spans, fenced blocks and a "Steps to reproduce" (or "Repro")
  section are left out: `npm run db:migrate` in a bug's reproduction steps is
  not a migration. Once the change is measured, a keyword rule no longer sets
  risk: the areas the change touches do. A lane the item's text chose can step
  down then, and the plan decision says so; a lane you chose never does.
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

### Your team's own skills as steps

A team that already has its process in Claude Code skills (usually a plugin
everyone installs: one skill builds a feature, one fixes a bug, one reviews a
pull request) can have the factory's steps run them instead of the role's
prompt (#131):

```yaml
stepSkills:                 # first match per step class
  - class: implement
    when: 'profile.type == "fix"'
    skill: team:fix-bug
    args: '{{item.key}}'
  - class: implement
    skill: team:build-feature
    args: '{{item.key}}'
  - class: review
    skill: team:review-pr
```

A workflow step can say it for itself, and wins over `stepSkills`:
`runSkill: { name: team:build-feature, args: '{{item.key}}' }`.

- **The name** is how Claude Code invokes it: `plugin:skill`, or a plain name
  for a skill in the repository's `.claude/skills` (or pinned to the step from
  the skills library). In `args`, `{{item.key}}`, `{{item.url}}` and
  `{{item.title}}` are the tracker item the mission came from (empty without
  one) and `{{mission.title}}` the mission's title.
- **The run** starts with the slash command, `/team:build-feature KEY-12`,
  and the step's usual context follows as the skill's input: its objective,
  Done-when lines, the outputs to write and where, the checks Tandemise runs
  after. The role's instructions are replaced by a short note saying the
  skill drives and what Tandemise owns.
- **Gates and outputs are unchanged.** The step keeps its class, outputs and
  gate; Tandemise commits, harvests, runs the checks and judges the gate as
  for any step. A skill that skips the outputs fails the gate and is retried.
- **Tandemise ships.** The skill is told to stop before committing, pushing,
  opening the pull request or moving the tracker item. A worker's shell can't
  open a pull request anyway (see below), so nothing happens twice.
- **Where the skill comes from.** Only Claude Code runs a skill as a step.
  A plugin's skill must be installed in the profile's config folder (its
  Config directory, else the daemon's `CLAUDE_CONFIG_DIR` or `~/.claude`);
  the run loads that one plugin with `--plugin-dir`. With **Your Claude
  settings: Keep them out of workers** (the default) nothing else of yours
  comes with it, and a personal skill (`~/.claude/skills`) is refused: import
  it into the library and pin it to the step, or choose **Let workers load
  them**.
- **A skill the worker doesn't have stops the step**, with the reason on its
  card and an Inbox card "‘Implement’ needs a skill that isn’t installed"
  (Retry, Leave blocked). It never falls back to the role's prompt. It is
  checked before the run (no attempt spent), and again when the session
  starts: if Claude Code's own list of loaded skills doesn't have it, the run
  is stopped at once and the attempt given back.

The step's card shows "Runs /team:build-feature" and its log says where the
skill came from. A hold opens the step's session as it is; a skill the session
didn't start with isn't added by the hold. A repository's own gate
definitions are not read: checks stay the repository's commands narrowed by
`areas`. Design: `docs/superpowers/specs/2026-11-01-repo-skills-as-steps-design.md`.

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

The pull request's title is a Conventional Commit, because a squash merge makes
it the commit on your default branch. An item already titled as one
(`fix: …`) is used as written. Otherwise the type comes from, in order: the
item's tracker type (`Bug` → `fix`), the planner's profile (which reads the
item's labels when it has them), and the agent's own commits on the branch. It is `chore` only when none of them says
anything. The subject is the agent's commit subject when it wrote a
Conventional Commit, because that says what changed. Otherwise it is the
item's title. A tracker key, an acronym or a name keeps its case (`KEY-77`,
`API`, `GitHub`). The Review and merge card shows the pull request as GitHub
has it: `Review and merge #45: fix(settings): …`.
**When CI fails**, each failing check is classified before anything is redone.
A check on the pull request itself (its title, labels, description, a linked
issue, a Conventional Commit or DCO rule) never sends the code back: a title
check is fixed in the ship step by retitling the pull request as above, which
runs the check again, and anything else is a card naming the check. A check on
the code (build, test, lint, typecheck) sends the code step back for a round
with the check's log. A check Tandemise can't place is a card with its name and
log, and a round starts only once you say it is about code. The name decides
first, then what the check printed; `ci.checks` in `planner.yaml` maps a name
or a glob to `metadata`, `code` or `unknown` and wins over both. Until GitHub
has registered a check, the step reads "Waiting for checks to start".

**Rounds from CI are bounded.** A step whose branch has no commit beyond the
remote base opens no pull request: the ship step ends with "Nothing to ship:
the change is already on `<base>`", and the mission says so. A red check sends
the code step back for another round only while the mission has taken fewer
rounds (review findings and CI alike) than `ci.maxRounds` (3 unless
`planner.yaml` says otherwise); past it, the step stops on a card with the last
failure: **Try again** allows one more round, **Hold** leaves it stopped, and
**Cancel the mission** ends it. A round whose pass leaves the code as it was
(the same commit, or the same tree, as the one CI failed on) stops at once on
the same card, before any later step runs again.

**A round is checked against CI as it is now.** Before a CI round's code step
starts (after a pause, a restart, or a retry), and before the steps after it
start again, CI is read on the pull request: if the check that started the
round passes now on the same commit, the round is dropped, the feed says so,
and the mission goes on to ship. A step in such a round that says the plan no
longer fits offers **Re-check and continue to ship**, recommended once the
check passes; while the pull request is open and green, the card never
recommends skipping the steps after it.

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

## What an agent's environment holds

Each agent run (and each held session) gets an empty `TANDEMISE_HOME` of its
own under the system temp directory, so an agent that starts a dev daemon or
desktop, for example while working on Tandemise itself, never touches your
`~/.tandemise`. Other homes agents inherit are unchanged: a Claude Code run
uses the config directory its profile names, or the one the daemon inherited.

Agents get no display by default. To let a code step prove a UI change in the
real app, set **Display for agents** on the Claude Code runtime profile:

- **A virtual display**: the agent runs under `xvfb-run -a` (Linux, with
  `xvfb-run` installed; without it the run goes on with no display and its log
  says so). Nobody sees its windows.
- **This computer's display**: `DISPLAY`, `WAYLAND_DISPLAY` and
  `XDG_RUNTIME_DIR` pass through, so agents can open windows on your screen.

The run's log line `agent environment` names its `TANDEMISE_HOME` and display.

### What a worker's shell can and cannot reach on GitHub

A worker's shell never holds your GitHub credentials. Every external write a
worker makes on GitHub goes through the tool broker (`github.pr.create`,
`github.pr.comment`, `github.issue.create`), so the policy engine decides it,
an approval card asks when the autonomy setting says so, and it is recorded.
The daemon runs those tools, and the ship step's own pushes and pull
requests, with its own environment, so they keep working.

In every worker (Claude Code, Codex, a generic CLI):

- `GH_TOKEN`, `GITHUB_TOKEN` and the enterprise token variables are removed.
- `gh` gets an empty config directory of the run's own (`GH_CONFIG_DIR`), so
  `gh pr create`, `gh api` and anything else that needs a sign-in fail with
  "gh auth login". With no token in the environment, `curl` has nothing to
  send either.
- git cannot authenticate: its credential helpers are cleared, its prompts and
  askpass programs are off, and ssh runs without your agent or any key. It can
  still commit, and fetch from a public remote.

The exception is a step granted `git.push` (the development and release
roles): it pushes its branch so the broker can open the pull request. Such a
step keeps git's credentials, meaning your ssh agent and a git credential
helper that reads your `gh` sign-in, while `gh` itself stays signed out. A
process in that shell could still read that git credential (`git credential
fill`). Grant `git.push` only to roles you would trust with it.

This is defence in depth, not a sandbox. A worker runs as you, so a process
set on reading your files can still read them. The boundary for an untrusted
agent is the execution target's isolation. The Claude Code tool rules from
#146 (no `Bash(gh pr create:*)` and similar where the broker has the tool)
stay as a second layer.

The run's log line `agent environment` says which of the two cases a run had
(`codeHost`).

### Your own window is not the agent's to drive

A Tandemise window started with `--remote-debugging-port` listens for DevTools
connections, which have no authentication (#162). Nothing a worker inherits
points at it. Every worker's environment loses Electron's and an AppImage's
launch variables (`ELECTRON_RUN_AS_NODE`, `APPIMAGE`, ...), `TANDEMISE_PORT`,
any variable naming a CDP, DevTools or remote-debugging port, and inspector
flags in `NODE_OPTIONS`. An agent that proves a UI change starts its own
window, with its own `TANDEMISE_HOME` and a port of its own choosing.

This is not a block either. An agent runs as you and can list this computer's
listening ports, so a window with its DevTools port open can still be found.
The packaged app opens none, and `scripts/factory.sh` opens one only with
`start --cdp`, on a random port. See
[Known limitations](KNOWN_LIMITATIONS.md#an-agent-can-reach-a-windows-devtools-port-if-one-is-open).
