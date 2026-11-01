# A team's own skills: found where Claude Code keeps them, and run as factory steps

Status: design, 2026-11-01. Covers #129 (skills discovery ignores Claude Code
plugin skills) and #131 (run a repository's own Claude Code skills as workflow
steps). #129 ships first, as its own pull request; #131 builds on the words and
the runtime facts it settles.

## The problem

A team that already works in Claude Code has its process in skills, usually in
a plugin the whole team installs: one skill builds a feature, one fixes a bug,
one reviews a pull request. Those skills encode things Tandemise's generic role
prompts don't know: the team's planning agent, its test-first rhythm, its
gates, its review checklist.

Two things stop that team from using them in Tandemise:

1. **The Skills screen can't see them (#129).** Discovery reads only
   `~/.claude/skills`. Plugin skills live under
   `<config>/plugins/cache/<marketplace>/<plugin>/<version>/skills/*/SKILL.md`,
   listed in `<config>/plugins/installed_plugins.json`, and Claude Code names
   them `plugin:skill`. A repository's own `.claude/skills` isn't read either.
   And a folder that only groups skills (`synced/<skill>/SKILL.md`) is reported
   as one broken skill, "No SKILL.md in this folder".
2. **The factory can't run them (#131).** A step always runs its role's
   prompt. With "Your Claude settings: Let workers load them" the skills are
   visible to the worker, but nothing asks for them, so the factory and the
   team's skills are two workflows competing for the same change.

## What Claude Code actually does (measured, 2.1.316)

Probed with a throwaway `CLAUDE_CONFIG_DIR`, a test marketplace holding one
plugin with two skills, a personal skill, and a grouped personal skill. The
`system/init` record of `claude -p --output-format stream-json` lists what the
session loaded:

| Run | `skills` in the init record |
|---|---|
| `--setting-sources project,local` (Tandemise's default) | none of the plugin's, none personal |
| user settings loaded (the profile's "Let workers load them") | `solo`, `acme:hello`, `acme:review` |
| `--setting-sources project,local --plugin-dir <installPath>` | `acme:hello`, `acme:review` |
| user settings loaded and `--plugin-dir` for the same plugin | `acme:hello`, `acme:review`, once |

- A plugin skill is named `<plugin>:<skill folder>`; the plugin entry in the
  init record carries its version.
- A skill folder nested in a grouping folder (`skills/grp/inner/SKILL.md`) is
  **not** loaded by Claude Code. Only top-level folders are skills.
- A project skill is named after its folder, not its front matter `name`
  (`.claude/skills/acme-hello` with `name: hello` loads as `acme-hello`).
- The init record arrives before the first model call, so it is a reliable,
  cheap check of what a run can invoke, even when the run then fails (it was
  "Not logged in" in the probe, which is also why no real skill turn ran).

## Goals

- The Skills screen lists every skill a worker could be given: personal ones,
  each installed plugin's (named `plugin:skill`, with the plugin's version and
  marketplace), and each project repository's `.claude/skills`. It walks one
  level of grouping folders, and says where each came from.
- A factory definition can say "this step runs the team's skill X" for a step
  class, optionally only for some work (bugs, say), and a workflow file can say
  it for one step.
- The run invokes the skill itself, not a description of it, and still meets
  the step's gate and outputs, which Tandemise measures as for any step.
- A skill the worker doesn't have stops the step loudly, on its card, before
  anything is spent. It never falls back to the role's prompt.
- "Your Claude settings" keeps its meaning: keeping them out still keeps the
  person's hooks, other plugins and personal skills out.

## Non-goals

- **Reading a repository's own gate definitions** (#131 point 3: a profile file
  with `gates` and `fastGates`). Checks stay Tandemise's: the repository's
  commands in Project settings, narrowed by `planner.yaml` areas. A separate
  issue if teams want it.
- **Letting a skill own the pull request or the tracker** (#131 point 4, the
  other way round). Tandemise keeps shipping: one place commits, pushes, opens
  and merges the pull request and moves the item. The skill is told to stop
  before those phases (see "Ownership").
- **Other runtimes.** Codex and generic CLIs have no slash-command skills. A
  step that runs a skill routes only to Claude Code; on anything else it is
  refused with a reason.
- **Copying a whole plugin into the library.** Importing a plugin skill copies
  that skill's folder only (see #129 below).

## #129: discovery

### Approaches

1. **Read Claude Code's own files** *(chosen)*. `installed_plugins.json` says
   which plugins are installed and where (`installPath`, `version`, `scope`);
   each install's `skills/*/SKILL.md` are its skills. Personal skills stay in
   `<config>/skills`, project skills in each repository's `.claude/skills`.
   No process is run, nothing is executed, same as today.
2. **Ask Claude Code** (`claude plugin list --json`, or a no-op `-p` run and
   read its init record). Authoritative, but it starts a process per look,
   needs a signed-in CLI for the `-p` form, and lists only what one config dir
   and one set of setting sources would load, which is the question #131 asks
   at run time, not the one the Skills screen asks.
3. **Walk `plugins/cache/` blindly.** Finds old versions Claude Code no longer
   uses and can't tell a project-scoped install from a user one. Rejected.

### Decisions

- **Where it looks.** The Claude config folder is `CLAUDE_CONFIG_DIR` when the
  daemon has one, else `~/.claude`. Personal skills: `<config>/skills`
  (`TANDEMISE_SKILLS_DISCOVER_DIR` still overrides it, and then the config
  folder is its parent, so a test never reads the real home). Plugins:
  `<config>/plugins/installed_plugins.json`. Project: every repository of the
  project, `<repo>/.claude/skills`.
- **Grouping folders.** A top-level folder without a `SKILL.md` whose direct
  sub-folders have one is a group: each such sub-folder is listed as
  `group/skill`, importable. A folder with neither stays one broken row, as
  today. Only one level, as the issue asks. Because Claude Code itself doesn't
  load a nested skill, the row says so: it reaches a worker only by importing.
- **Names.** Each row shows how Claude Code invokes it: `acme:hello`,
  `tdd`, or nothing for a grouped skill. A plugin skill is imported into the
  library as `<plugin>-<skill>` (`acme-hello`): a library name becomes a
  folder name under `.claude/skills`, where a colon is not portable, and
  prefixing keeps two plugins' `review` skills apart. The plugin is recorded
  on the source, so **Update** names the same skill again.
- **Origin.** Rows are grouped under "Your skills", "Plugin acme 1.2.3
  (testmarket)" and "Repository <name>", each with the folder it read.
- **What an import of a plugin skill is.** A copy of that one skill folder,
  pinned by hash like any other. A skill that leans on the rest of its plugin
  (its agents, hooks, `${CLAUDE_PLUGIN_ROOT}` scripts) won't work from the
  library; such a skill should be run as a plugin skill (#131). The guide says
  this.
- **A plugin update moves `installPath`** (the version is in the path). The
  library's source then reads "missing" until imported again from the new
  version. Acceptable; the row in discovery says "Newer than … in the library".

## #131: run a team's skill as a step

### Where the mapping lives

1. **`planner.yaml`, by step class** *(chosen for the factory)*:

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

   The planner already chooses lanes and modules from `profile.*` and `item.*`
   facts; "which skill runs this kind of step for this kind of work" is the
   same kind of rule. It applies to every step of that class in the plan,
   including steps a module adds, so a team doesn't restate it per lane.
2. **`routing.yaml`, per class.** Routing is about which model runs a step and
   is learned from outcomes; mixing "what to run" into "who runs it" would
   make a routing proposal able to change the process. Rejected.
3. **Per role** ("Developer's instructions come from skill X"). A role is
   shared by every lane and every kind of work; a team wants `fix-bug` for bugs
   and `build-feature` for features under the same Developer. Rejected as the
   only place; a class rule with `when` covers it.
4. **A workflow step field** *(also chosen)*, for a lane a team wrote by hand
   (`.tandemise/workflows/<lane>.yaml`) or any workflow:

   ```yaml
   steps:
     - key: implement
       role: development
       objective: Build the change.
       runSkill: { name: team:build-feature, args: '{{item.key}}' }
   ```

   A step that names one keeps it; `stepSkills` fills only steps that don't.

`skill` is `plugin:skill` or a plain `name`. `args` is optional text where
`{{item.key}}`, `{{item.url}}` and `{{item.title}}` are the tracker item the
mission came from (empty when there is none) and `{{mission.title}}` the
mission's title, substituted when the step runs.

### How the run invokes it

The prompt of a Claude Code run that runs a skill starts with the slash
command, and the step's context follows as the command's arguments:

```
/team:build-feature KEY-12

<the step's usual context: objective, Done-when lines, inputs, the outputs
to write and where, the checks Tandemise runs after, what people said>
```

Claude Code expands the skill and hands it everything after its name as its
arguments, so the skill reads the step's context as its input. The role's own
instructions are replaced by a short preamble: this step runs the team's
skill; follow it; the parts listed under "Ownership" are Tandemise's. A
continued or resumed session isn't sent the command again: the skill is
already in it.

Alternatives: telling the agent in prose to "use the Skill tool for X" leaves
it to the model to comply (rejected, not deterministic); pasting the
SKILL.md into the prompt loses the plugin's agents and scripts (rejected; it
is what the library's "in prompt" fallback does for runtimes without a skills
folder, and why it isn't used here).

### Where the skill comes from, and the profile setting

Before a run starts, Claude Code's adapter resolves the skill for the profile
the step was routed to, reading the same files as #129 in that profile's
config folder (its "Config directory", else the daemon's):

| Skill | Found when | The run gets |
|---|---|---|
| `plugin:skill` | the plugin is in `installed_plugins.json` and its install has `skills/<skill>/SKILL.md` (or `commands/<skill>.md`) | `--plugin-dir <installPath>` for that one plugin |
| `name` | the working folder has `.claude/skills/<name>/SKILL.md` (the repository's own, or a library skill pinned to the step) | nothing extra: project settings always load |
| `name` | `<config>/skills/<name>/SKILL.md` exists and the profile **lets workers load** the person's settings | nothing extra |

- **"Keep them out of workers" (default).** Still true for everything the
  step didn't name: the person's hooks, other plugins, personal skills and
  instructions stay out. The one plugin the factory rule named is loaded with
  `--plugin-dir`, because naming it in a reviewed factory file is the team
  asking for it. A personal (non-plugin) skill is refused with the way out
  named: import it into the library and pin it to the step, or let workers
  load your settings.
- **"Let workers load them".** The person's plugins and skills load as they do
  today; `--plugin-dir` is still passed for the named plugin (measured: no
  duplicate), so a plugin installed but disabled in settings still runs.

### Failing loudly

Two checks, neither of which falls back to the role's prompt:

1. **Before the run (no attempt spent).** A skill that doesn't resolve, or a
   step routed to a runtime that can't run skills, blocks the step with the
   reason and raises the Inbox card "‘Implement’ needs a skill that isn't
   installed", Retry or Leave blocked, as a missing library skill does today.
   The reason names the skill, the profile and its config folder, and what was
   found instead ("team is installed but has no skill fix-bug; it has
   build-feature, review-pr").
2. **When the run starts.** The adapter reads the init record; if the skill
   isn't among the session's skills and commands, it stops the run at once and
   reports `SKILL_NOT_LOADED`, which blocks the step with the same card. This
   catches what the files can't tell: a plugin that fails to load, a CLI that
   names it differently, a project setting that disables it.

The step card and drawer show "Runs the skill team:build-feature", and the
run's log line says where it came from ("plugin team 2.4.0 at …").

### Gates and outputs

Unchanged, by construction. The step keeps its class, its outputs and its
gate. After the run Tandemise commits the worktree, harvests the outputs from
`.tandemise/out/`, runs the checks the gate names and judges the gate, as for
any step. The outputs and checks are in the skill's arguments, so a skill that
ignores them fails the gate and is retried with the gate's feedback like any
other run. `skills.loaded` and `skills.missing` keep counting library pins.

### Ownership

The step's context tells the skill what Tandemise owns: committing, pushing,
opening and merging the pull request, and moving the tracker item. Where the
skill has such a phase, it stops before it. That isn't only a prompt: a
worker's shell has no GitHub credentials (#147), so a skill's `gh pr create`
fails anyway, and only a role granted `git.push` can push. The ship step
remains the one place a pull request is opened, so nothing happens twice.

## What changes, by layer

- `domain`: `SkillSource` (claude) gains `plugin`; `PlannedTask` and
  `MissionTask` gain `runSkill: { name, args }`; `planner.yaml` gains
  `stepSkills`; workflow steps gain `runSkill`.
- `persistence`: a migration adds `mission_tasks.run_skill`.
- `application`: `SkillService.discover` reads project repositories and
  reports origins; the planner fills `runSkill` from `stepSkills`; the
  executor resolves the skill through the adapter, blocks with a card, passes
  `skill` on the run request, and swaps the role's instructions.
- `runtimes-core`: `RunRequest.skill`, and an optional
  `adapter.resolveSkill(profile, name, workingDirectory)`.
- `runtime-claude`: reads `installed_plugins.json`, adds `--plugin-dir`,
  prefixes the slash command, checks the init record.
- `daemon`: discovery of plugins, projects and groups.
- `desktop`: discovery grouped by origin; the step shows the skill it runs.

## Proof

- Offline: `p13-skills-check` gains plugin, project and grouped fixtures; a new
  check runs the daemon with a stub `claude` that records the prompt and argv
  it got and reports an init record built from the `--plugin-dir` it was
  given. It proves the slash command and arguments, `--plugin-dir`, the role
  preamble, a missing skill blocking with the card and no attempt, and an init
  record without the skill blocking the run.
- Real app over CDP: a fresh `TANDEMISE_HOME`, a throwaway Claude config folder
  with a test marketplace installed through `claude plugin install`; the
  Skills screen lists the plugin's skills; a mission whose `stepSkills` names a
  missing skill shows the card; one naming an installed skill runs it.
- Real Claude Code, where a login allows: a throwaway `CLAUDE_CONFIG_DIR` with
  the test plugin. Without a login, the init record still proves what loads.
