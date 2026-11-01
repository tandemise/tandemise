# The brain: one git repo per project for memory and the factory definition

Status: design, 2026-10-30. This is the second sub-project of the software-factory pivot (#56). It is tracked in #51 and depends on #50 (hold and interact), whose "Record (for #51)" section defines the main learning signal. Background and binding decisions are in `2026-10-30-tandemise-pivot-notes.md`.

## The problem

One of the four reasons the owner stopped using Tandemise is that **it doesn't learn from corrections**. Today:

- What a project "knows" is five free-text fields on the workspace (`WorkspaceKnowledge` in `packages/domain/src/entities/workspace.ts`) plus accepted `Decision` rows. Both live in `~/.tandemise/tandemise.db` on one machine. Nothing ever writes to them except a person typing in Project settings.
- A person's correction disappears once it has been applied. A hold (#50) records who stepped in and the diff, a request-changes round records the notes, a failed gate records its facts in `run_scores`. None of that reaches the next mission's prompt.
- The factory definition (roles, models, workflows, routines, skills pins, issue settings) can be exported to `.tandemise/` in one code repository (P15, `packages/application/src/setup/codec.ts`). That is a snapshot you export and import by hand. It is not a shared, living source of truth, and it lives inside one code repo even though a project spans several.
- Two people on the same project have two databases that drift apart.

Claude Code users solve this with `CLAUDE.md`, `AGENTS.md` and memory files that they edit by hand or let the model rewrite. That works for one person. It doesn't work for a team or for a factory that should improve itself, and letting a model rewrite the whole file loses detail over time (see "Research this design adopts").

## Goal

Each project has a **brain**: one git repository (for example `acme/brain`) that holds what the project has learned and how its factory works.

- **Memory:** lessons, conventions, decisions, and a history of what was done and what went wrong.
- **The factory definition:** steps (workflows), roles with their skills and models, gates, the primary tracker and its state mapping, and the MCPs the project needs.

Success looks like this:

1. I link Acme to `acme/brain` (new or existing). A teammate links the same repo on their machine and gets the same factory.
2. When I hold a task and fix what the agent got wrong, the brain gains a short lesson about it, with a link to the run it came from.
3. The next mission's agents load that lesson (and only the lessons relevant to their step), and the task view shows me exactly which ones they loaded.
4. When a lesson keeps proving useful, Tandemise proposes turning it into a rule. I get a PR to `acme/brain`, with the evidence and an eval scorecard, and I merge it or not.
5. Personal settings and secrets never enter the brain. Everything works with no server; sharing is `git pull` and `git push`.

## Non-goals (this sub-project)

- **A server.** The optional thin server is #54. The brain must work with only git.
- **Intake and the tracker's state mapping logic.** #52 owns intake and what the mapping means. This design reserves the file (`factory/tracker.yaml`) and its place in the brain, nothing more.
- **Inferring steps, models and gates.** That is the smart planner (#53). The brain stores the factory definition and carries proposed changes to it; it doesn't decide what the factory should be.
- **Vector or semantic memory.** MVP.md §14.3 says exact references beat fuzzy recall until retrieval quality shows a need. Retrieval here is deterministic (scope match, counters, recency).
- **Learning from every run.** Only the signals listed under "Lesson candidates" produce lessons. A run nobody corrected teaches nothing new.
- **Personal memory.** A person's own preferences stay in their own tools (their `~/.claude`, their Claude Code memory). The brain is the project's.
- **Rewriting or compacting the ledger.** No process, human or model, rewrites the ledger. A compaction format can come later if fold time ever matters.
- **Codex or generic runtimes reading the brain through tools.** They get the brain section in their prompt like every runtime. The `brain.*` MCP tools reach any runtime that has the gateway, which today is the same set that gets tools.

## Research this design adopts

These patterns come from a survey of about 30 agent and memory systems done during the pivot conversation. Each is cited where it shapes a decision.

| Pattern | Source | Where it lands here |
|---|---|---|
| Memory as an append-only ledger of atomic entries ("bullets") with helpful/harmful counters, merged by deterministic code. An LLM only proposes deltas; it never rewrites the whole context, because iterative rewriting collapses detail ("context collapse"). | ACE (Agentic Context Engineering) | The ledger format, the fold, and the rule that no model writes anything but a delta. |
| The agent suggests a memory; a person approves before it becomes knowledge. | Devin (Knowledge suggestions) | Agent-proposed lessons start as candidates. Promotions are PRs. |
| An observer proposes improvements to the factory as PRs that a person reviews. | Warp (observer PRs in its "software factory") | Promotions and every structural factory change arrive as a PR to the brain. |
| A self-improving agent that can see or edit its own evaluation learns to game it ("objective hacking"). | Darwin Gödel Machine | Promotion evals live where the proposer can't read or write them, and a PR that touches them is always reviewed. |
| Blind A/B: compare a candidate against the baseline on the same cases, scored by something other than the candidate's author. | Anthropic skill-creator (blind comparison) | Promotions run P3b evals, baseline vs candidate, scored by the daemon. |
| Facts are bi-temporal: a superseded fact is marked invalid from a point in time, not deleted, so history stays queryable. | Zep / Graphiti | `supersede` events; nothing is ever deleted. |
| Every memory carries its provenance and when it was last confirmed. | Zep, Mem0, Devin | `source` and `lastConfirmedAt` on every entry. |
| Retrieval in layers: a cheap index first, details on demand, to keep context small. | Claude Code skills (description first, body on demand); Letta (core vs archival memory) | The prompt gets rules plus a few lessons plus an index; `brain.read` fetches detail. |
| Show which memories and rules a step loaded. | Cursor rules ("rules applied"), Devin (knowledge used) | `runs.brain` and the "What it knew" section in the task view. |

## Approaches considered

### Where the brain lives

1. **A dedicated git repo per project** *(chosen; binding)*. One place for a project that spans repos, reviewed with the tools the team already uses, shared with no server, and its history is itself the audit log.
2. **`.tandemise/` inside the primary code repo** (P15 today). No new repo, but a project spans repos, the factory's PRs would mix with product PRs, and access to the code is not access to the factory. Kept as a read path for existing projects (see "Relation to `.tandemise/`").
3. **SQLite, synced through a server.** Fast and queryable, but there may be no server, the data can't be reviewed as a PR, and two offline daemons need a sync protocol we would have to invent. Rejected.

### How lessons are stored

1. **One Markdown file per lesson with counters in front matter.** Readable, but every counter bump edits a shared file, so two daemons conflict constantly. Rejected.
2. **One `MEMORY.md` that a model keeps rewritten.** This is how many assistants do it. It conflicts on every concurrent write and suffers context collapse (ACE). Rejected.
3. **An append-only event log, one file per writer, folded deterministically** *(chosen)*. Writers never touch the same file, so git never conflicts. Counters are sums of events, so merging is a union. The current state is a pure function of the events.
4. **A vector store** (Mem0, Letta archival). Opaque in a PR, not mergeable with git, and MVP.md §14.3 defers it. Rejected for now.

### How the factory changes itself

1. **Everything through a PR.** The safest option, but a team drowns in one-line PRs and stops reading them.
2. **Everything auto-applies if evals pass.** Evals don't cover structure (P3b explicitly can't compare candidates that change workflows or gates), so removing an approval would pass trivially. Rejected.
3. **Classified** *(chosen)*: a small, additive, text-only change that passes evals may apply on its own when the project allows it; anything structural is always a PR the owner reviews.

## Decisions

### 1. The brain repo layout

```
brain.yaml                     # the brain's own manifest (see below)
README.md                      # written once at creation, for humans browsing the repo
.gitattributes                 # memory/ledger/** merge=union
factory/                       # the P15 setup tree, same codec, same bytes
  tandemise.yaml               #   project settings, limits, WIP, autonomy, secrets placeholders
  roles/<id>.md                #   role instructions, model, escalation, skills pins
  workflows/<id>.yaml          #   steps and their gates
  routines.yaml
  skills.lock
  issues.yaml
  tracker.yaml                 #   new, reserved for #52: primary tracker and state mapping
  mcps.yaml                    #   new: the MCP servers and integrations the project needs, no secrets
skills/<name>/<hash12>/…       # vendored copies of every skill version skills.lock pins
memory/
  rules/                       # curated conventions, changed only by commit or PR, never by the ledger
    project.md
    repo-<repo-name>.md
    role-<role-id>.md
  decisions/<slug>-<hash8>.md  # accepted DecisionRecords, with supersedes links
  ledger/<yyyy>/<mm>/<writer>.jsonl   # append-only events: lessons, counters, history
evals/                         # promotion evals; never readable by an agent
  gates.yaml                   # which suites gate promotions, thresholds, spend cap
  cases/<case-id>/case.json    # P3b EvalCase snapshots
  blobs/<sha256>               # their input artifacts, content-addressed
```

`brain.yaml`:

```yaml
version: 1
project: Acme
repositories:                  # the code repos this project spans, by remote, never by local path
  - name: acme
    remote: github.com/acme/acme
  - name: claude
    remote: github.com/acme/claude
  - name: ops
    remote: github.com/acme/ops
promotion:
  autoApply: off               # off | small; see §7
  minHelpful: 3                # net helpful votes before a lesson is proposed for promotion
  minMissions: 2               # across at least this many missions
humanEdits: direct             # direct | pr: how a person's own edits in the app reach the brain
```

**What is never in the brain.** These are this machine's or this person's, and stay in the local database or `settings.json`:
- secrets (they stay in the local secret store, `apps/daemon/src/secrets.ts`, referenced by `Integration.credentialRef`);
- runtime profiles, `CLAUDE_CONFIG_DIR`, staffing (who does each role), per-runtime concurrency ceilings (P15 already excludes these);
- whether a routine or an issue sync is switched on (P15 already writes no `enabled`; on a shared brain this also stops every teammate's daemon from running the same routine);
- notification preferences, the desktop's own settings;
- absolute paths, machine names, home directories.

Every text the daemon writes into the brain passes through the P15 `Scrubber` (secret patterns become `${SECRET_n}` in factory files, and `[redacted secret]` in ledger entries). Absolute paths under a repository's checkout are rewritten repo-relative (`acme:src/app/page.tsx`); any other absolute path is refused in a ledger entry. The offline check proves this on every write path.

### 2. Relation to `.tandemise/` (reuse, not a parallel format)

- `factory/` **is** the P15 tree. `renderSetup` / `readSetup` (`packages/application/src/setup/codec.ts`) read and write it unchanged; `SETUP_VERSION` stays 1. The only codec change is that the setup root becomes a parameter (`.tandemise` in a code repo, `factory` in a brain). `SetupService.readFolder` (`packages/application/src/services/setup-service.ts`) accepts a brain root and reads its `factory/`.
- Two new files join the codec as new item kinds in the P15 diff: `tracker.yaml` (kind `tracker`, schema owned by #52; until then the codec carries it through byte for byte) and `mcps.yaml` (kind `mcps`).
- `mcps.yaml` lists each integration by provider and name, the capabilities the factory enables for it, and how to connect it ("gh auth login", an MCP URL or command), never a credential:
  ```yaml
  mcps:
    - capabilities: [issues.read, issues.write]
      connect: { kind: mcp, url: https://youtrack.example.com/mcp }
      name: YouTrack
      provider: mcp
    - capabilities: [github.read, github.write]
      connect: { kind: cli, command: gh }
      name: GitHub
      provider: github
  ```
  On a machine where one isn't connected, the Brain screen says "This project needs YouTrack. Connect it." and links to the existing connect flow (`packages/application/src/services/connect-flow.ts`).
- `skills/` vendors the files of each pinned skill version, by hash. This closes the gap P15 Ruling 14 left: today a teammate sees "Needs import: tdd from ~/.claude/skills/tdd". With a brain, the skills store is filled from `skills/<name>/<hash12>/` (hash verified with `hashSkillFiles`) and that row goes away. P13's safety rules (size, file count, links) apply to vendored folders too.
- **Code repos' `.tandemise/workflows/`** still load, as they do today through `WorkflowSourcePort.list(repositoryPaths)` (`packages/application/src/ports.ts:136`). Precedence by workflow id: brain, then code repos, then shipped presets. A code-repo workflow that a brain workflow shadows is listed in the Brain screen with **Move into the brain**, which opens a brain change. Nothing else in a code repo's `.tandemise/` is read once a brain is linked; P15's Export/Import keep working for projects without a brain.

### 3. Linking a project to a brain

A new **Brain** section in Project settings (`/project`). A project has at most one brain. Three ways in:

| Action | What happens |
|---|---|
| **Create a brain** | Asks for the GitHub owner and name (default `<owner>/brain`, private). The daemon runs `gh repo create --private`, initialises the layout, writes `factory/` with the P15 export of the current setup, the current knowledge fields as `memory/rules/project.md`, and accepted decisions as `memory/decisions/`, then pushes the first commit. |
| **Use an existing brain** | Asks for the remote. The daemon clones it and shows the P15 import preview (item by item: Add, Change, Remove, Same; Keep mine / Take theirs), plus the brain's own items (rules, lessons count, MCPs needed). **Link** applies the chosen items and links. Routines and issue syncs arrive off, as in P15. |
| **Keep it on this machine** | `git init` with no remote. Everything works; "PRs" become local proposal branches reviewed in the app (§8). Adding a remote later is **Share this brain**. |

The link is stored in a new `workspace_brains` table (additive migration): `workspaceId` (PK), `remote` (nullable), `defaultBranch`, `clonePath`, `writerId`, `lastPulledSha`, `lastPushedSha`, `lastSyncAt`, `lastSyncError`. It is per machine on purpose: two people can link the same brain to their own project rows.

`writerId` is `<member-handle>-<6 hex of a random install id>`, generated once per machine and project. It names this daemon's ledger files. It identifies a writer the way a git author does; nothing else about the person is stored.

**Unlinking** keeps the local clone and copies the brain's factory into the database (so the project keeps working), and stops loading memory. It never deletes the remote.

Once linked, **the brain is the source of truth for the factory**. The database's role, workflow, routine and setting rows become a cache of `factory/` at `lastPulledSha`, refreshed by applying the P15 import with every item "theirs" after each pull that changed `factory/`. Personal fields (above) are never touched by that apply.

### 4. The daemon's clone, pull and push

- **Where.** `<TANDEMISE_HOME>/brains/<workspaceId>/`, a normal clone the daemon owns. It is never the person's own checkout (a `Repository.path` is "never modified directly", `packages/domain/src/entities/workspace.ts`). A person who wants to edit by hand clones the brain themselves and pushes; the daemon pulls it in.
- **Credentials.** No new credential. For GitHub remotes, git runs with gh's credential helper (`-c credential.helper= -c 'credential.helper=!gh auth git-credential'`), reusing the session the GitHub integration already relies on (`packages/integration-github/src/gh.ts`: "Tandemise stores no GitHub credential"). Other remotes use the person's own git credential setup. Always `GIT_TERMINAL_PROMPT=0`, hooks off (`core.hooksPath=/dev/null`), no submodules, and LFS smudge off, as P13 clones skills.
- **A `BrainRepoPort`** (application layer) hides git; an implementation in `execution-local` runs it through the existing `CommandExecutor`. Sketch:
  ```ts
  interface BrainRepoPort {
    clone(remote: string, into: string): Promise<void>;
    init(into: string): Promise<void>;
    fetchAndRebase(clone: string): Promise<{ head: string; conflicted: readonly string[] }>;
    commit(clone: string, files: readonly BrainWrite[], message: string): Promise<string>; // returns sha
    push(clone: string, branch: string): Promise<'pushed' | 'rejected' | 'offline'>;
    readAt(clone: string, sha: string, path: string): Promise<string | null>;
    listAt(clone: string, sha: string, dir: string): Promise<readonly string[]>;
  }
  ```
  Reads go through `readAt(sha, …)` (`git show`), not the working tree, so a run reads one fixed commit even while a pull is moving `HEAD`.
- **When it pulls.** At daemon start; before planning a mission or starting a task, when the last pull is older than five minutes; and every ten minutes in the background. A pull that fails (offline, auth) never blocks work: the daemon uses its local clone, records `lastSyncError`, and the Brain section shows "Working from your copy of the brain (last synced 10:42). Couldn't reach github.com." 
- **Pinning.** Every task attempt reads the brain at one commit, `brainSha`, taken when the attempt starts and recorded on the run. Retries of the same round reuse it, like skill pins (P13), so a retry isn't changed by a lesson that arrived in between.
- **When it pushes.** Ledger writes are batched: a commit at most every two minutes and at mission end, then `push`. A rejected push (someone else pushed) is followed by `fetchAndRebase` and one more push. Ledger files never conflict (§9), so this converges.
- **Protected default branch.** If the push is refused by branch protection, the daemon pushes its ledger commits to `tandemise/ledger/<writerId>` instead and keeps one open PR from that branch, titled "Lessons from <writerId>", updating it as it goes. The Brain section says so. Factory changes are unaffected: they already use PR branches.

### 5. The ledger

Every line of `memory/ledger/<yyyy>/<mm>/<writerId>.jsonl` is one event. A writer only ever appends to its own current file. Shape (sketch):

```ts
type LedgerEvent =
  | { op: 'add';       id: EntryId; at: Iso; by: WriterId; entry: EntryBody }
  | { op: 'vote';      id: EntryId; at: Iso; by: WriterId; vote: 'helpful' | 'harmful'; why: VoteSource; run?: RunRef }
  | { op: 'confirm';   id: EntryId; at: Iso; by: WriterId; run?: RunRef }      // seen again, independently
  | { op: 'accept' | 'reject'; id: EntryId; at: Iso; by: WriterId }            // a person on a candidate
  | { op: 'supersede'; id: EntryId; at: Iso; by: WriterId; successor: EntryId; invalidAt: Iso }
  | { op: 'promote';   id: EntryId; at: Iso; by: WriterId; target: string; pr: string | null }
  | { op: 'retire';    id: EntryId; at: Iso; by: WriterId; reason: string };  // invalid from now; kept

interface EntryBody {
  kind: 'lesson' | 'convention' | 'history';
  text: string;                 // one atomic statement, at most 400 characters
  scope: {                      // every field optional; an empty scope is project-wide
    repo?: string;              // brain.yaml repository name
    role?: string;              // role id
    step?: string;              // workflow step key
    paths?: readonly string[];  // repo-relative globs
  };
  source: {                     // provenance (Zep, Mem0, Devin)
    signal: 'hold' | 'rejection' | 'gate' | 'person' | 'agent' | 'mission';
    mission: string;            // title; the local id below is meaningless on another machine
    tracker?: string;           // tracker key or PR URL when there is one (portable)
    run?: RunRef;               // { daemon: writerId, runId } - resolvable only on the writer's machine
  };
  state: 'active' | 'candidate';
}
```

`EntryId` is a ULID prefixed with the writer (`<writerId>:<ulid>`), unique without coordination.

**The fold** is a pure function in `@tandemise/domain` (`brain/ledger.ts`), `foldLedger(events) → BrainMemory`. It:
- sorts events by `(at, by, id)` so the result never depends on file or line order;
- builds each entry from its `add`, sums `helpful` and `harmful` votes, takes the latest `confirm` (or the `add`) as `lastConfirmedAt`, and applies `accept`, `reject`, `supersede`, `retire`, `promote`;
- **deduplicates deterministically**: two `add`s whose normalised text (lowercased, whitespace and punctuation collapsed) and scope are identical are one entry. The earliest id wins, the later `add` counts as a `confirm`, and votes on either id count for the winner. There is no fuzzy matching and no model in the fold (ACE: deterministic merge);
- never drops an entry. A superseded entry is invalid from `invalidAt` and points to its successor (Zep bi-temporal); a retired one is invalid from its `at`. Both stay visible in history.

Invalid lines (bad JSON, unknown op, an event for an unknown id) are skipped and listed as problems in the Brain screen. One bad line never hides the rest.

**What writes the ledger.** Only the daemon's `BrainService`, through `append(events)`. No model writes a file. The reflector and agents return structured proposals (deltas), which `BrainService` validates, scrubs and appends. No code path rewrites or deletes a ledger line; the offline check asserts every ledger write is an append.

**History.** When a mission completes, fails or is cancelled, `BrainService` appends one `history` entry built from the mission record with no model: title, tracker key, outcome, PR URLs, the steps that were held or rejected, gates that failed and later passed. History entries load only through `brain.search`, never into a prompt by default.

**Decisions** stay first-class (MVP.md §14.4). An accepted `Decision` is written to `memory/decisions/<slug>-<hash8>.md` with its context, alternatives, rationale and consequences; `supersedes` becomes a link to the older file, whose front matter gains `supersededBy`. The file name is derived from content, not the local id, so two machines writing the same decision produce one file.

### 6. Lesson candidates: where lessons come from

A **lesson candidate** is a short, atomic, scoped statement that something should be done differently, with the evidence it came from. Candidates come only from these signals:

| Signal | Trigger | Who drafts the text | State on arrival |
|---|---|---|---|
| **Hold** (#50) | `task.hold_ended` with `ending: continued` and a non-empty `diffStat`, or any hold longer than two minutes | the reflector | `active` |
| **Review rejection** | a request-changes round (`task.round_started` from `FeedbackRounds.beginRound`) with the person's notes | the reflector | `active` |
| **Gate fail, then pass** | a run's gate failed (`gate.evaluated`, `run_scores.gate_passed = false`) and a later attempt of the same task passed | the reflector | `candidate` |
| **A person says so** | **Remember this** on a task, a hold panel or the Brain screen, with free text | the person | `active` |
| **An agent proposes** | an agent calls `brain.propose` during or at the end of its run | the agent | `candidate` |

"Active" means a person was the source of the correction, so the lesson loads into prompts at once. A `candidate` loads only after a person accepts it in the Brain screen, or after a second, independent signal confirms it (a `confirm` from another mission). This is Devin's suggest-then-approve, applied where no person was involved.

**The reflector** is a short model pass, run by `BrainService` after the signal settles, on the role's economy model (P12) and counted as measured spend like any run. Its input:
- the task's objective and role;
- the signal's evidence: the hold's diff (`git diff` of the worktree between hold start and end), the session transcript tail when Claude's store has it, the rejection notes, or the failed gate's facts and the fix diff;
- the brain entries the run loaded (`runs.brain.loaded`).

Its output is JSON, validated with zod. It returns at most three new entries (`text`, `scope`) and a `helpful` / `harmful` / `unused` tag for each loaded entry (ACE's reflector tagging). It never sees the rest of the ledger, the rules files or `evals/`, and it can't edit anything; `BrainService` turns its output into `add` and `vote` events. A reflector failure is logged and skipped. It never blocks the task.

Trial missions (`isTrialMission`) never produce candidates, votes or history: an eval must not teach the brain.

### 7. Counters

- **`helpful` / `harmful` votes** come from two places:
  - the reflector's tags on entries the run loaded (`why: 'reflector'`);
  - a person's thumbs up or down on an entry in "What it knew" or the Brain screen (`why: 'person'`). A person's vote counts as three.
- Plain correlation (a step that loaded entry X passed) is **not** a vote. It is too noisy to steer memory. The Brain screen shows it beside the counters as "Loaded in 14 runs, 11 passed first time", computed locally from `run_scores` and `runs.brain`; it never enters the ledger.
- Every vote is its own event, so two daemons voting at once just add up.
- **Ranking and retirement are derived, not stored.** `net = helpful − harmful`. An entry with `harmful ≥ 3` and `net ≤ −2` stops loading and shows "Harmful more often than helpful" with **Retire** and **Keep**. Only a person retires an entry. An entry not confirmed for 90 days ranks lower and shows "Not confirmed since …"; it is never removed for age.

### 8. Promotion: from lesson to rule, as a PR

A lesson is a note in the ledger. A **rule** is curated text in `memory/rules/*.md`, or a change to the factory (a role's instructions, a workflow step, a gate). Rules always load for their scope; lessons compete for a budget. A lesson becomes a rule only through a **promotion**.

**When a promotion is proposed.** After a fold, an active, valid lesson with `net ≥ promotion.minHelpful`, confirmed across at least `promotion.minMissions` missions, and not already promoted or proposed becomes eligible. A person can also press **Make this a rule** on any lesson. A promotion bundles related eligible lessons with the same scope into one proposal, so a rules file isn't changed one line at a time.

**Drafting.** A model pass (the promoter) receives the eligible lessons, their evidence summaries, and the current target file (for example `memory/rules/role-development.md` or `factory/roles/development.md`). It returns the new text of that file. `BrainService` then:
- checks the diff is confined to the target files;
- classifies it (below);
- creates the branch `tandemise/promote/<short-id>`, commits, and appends `promote` events for the lessons once the PR is open.

The promoter never sees `evals/`.

**Classification.** Decided by code, from the diff, never by the model:

| Small: may apply on its own | Structural: always a PR the owner reviews |
|---|---|
| Lines **added** to `memory/rules/*.md` | Any line removed or reworded in a rules file or role instructions |
| Lines **added** to a role's instructions body (`factory/roles/<id>.md`, below the front matter) | Any front-matter change in a role: model, escalation, capabilities, isolation, skills pins |
| | Any change to `factory/workflows/*`: adding or removing a step, changing a gate, `dependsOn`, approvals, executor |
| | `factory/tandemise.yaml` (autonomy, limits, WIP), `tracker.yaml`, `mcps.yaml`, `routines.yaml`, `issues.yaml`, `skills.lock`, `skills/` |
| | Anything under `evals/` or `brain.yaml` |
| | Any change that adds a capability or integration, or **removes or relaxes an approval or a gate** |

**Evals gate every promotion.** Every promotion runs the project's promotion suites before it is offered or applied:
- `evals/gates.yaml` names the P3b suites, the repeats, the spend cap, and the pass rule. The default pass rule: candidate gate pass rate ≥ baseline, criteria failed ≤ baseline, and mean cost ≤ baseline × 1.25. (The P3b scorecard reports a mean cost and no median, so the rule compares means.)
- The run is a P3b eval run (`packages/application/src/engine/eval-runner.ts`) with a new candidate kind, `{ kind: 'brain', ref }`. It is the existing `{ kind: 'setup', folder }` (`packages/domain/src/entities/eval.ts`), read from the promotion branch's `factory/`, plus that branch's `memory/rules` as the trial's rules. The baseline is the default branch.
- The proposer can't see or edit these evals (Darwin Gödel Machine; skill-creator's blind A/B):
  - the cases live in `evals/`, which no prompt, no `brain.*` tool and no worktree ever exposes;
  - the scorecard is computed by the daemon (`scoreEvalRun`), not by the model that drafted the change;
  - a promotion whose diff touches `evals/` is refused outright. Changes to `evals/` only come from a person ("Save as eval case" exports into `evals/cases/` as a human edit).
- With no promotion suite, nothing auto-applies. Proposals still go out as PRs, and the PR says "Not evaluated: this project has no promotion evals yet."

**What happens next:**
- **Small, `promotion.autoApply: small`, evals passed:** the commit is fast-forwarded onto the default branch and pushed, with trailers `Tandemise-Promotion: <id>` and `Tandemise-Eval: <scorecard summary>`. The Brain screen lists it under "Applied on its own", with **Revert** (a revert commit, through the same path as a person's edit).
- **Everything else** (structural, auto-apply off, or evals failed or not run): the branch is pushed and a PR is opened with `gh pr create` in the brain clone. The PR body has:
  - what changes and why;
  - each lesson with its text, counters, the missions it came from, and its tracker keys;
  - the classification and the reason for it;
  - the eval scorecard (or why there is none).

  A failed eval doesn't suppress the PR. It is opened as a draft titled "Did not pass evals: …", so the evidence isn't lost.
- **The PR's fate** is read with `gh pr view` on each sync. Merged: the pull brings the change in, and the lessons show as promoted. Closed unmerged: a `reject` is recorded on the proposal, and those lessons aren't proposed again until they gain three more net helpful votes.
- **Without a remote** (local-only brain), the "PR" is the local branch. The Brain screen shows its diff, scorecard and evidence with **Accept** (merge locally) and **Decline**.

**The factory proposing changes outside lessons** (later, #53's planner suggesting a new gate, say) uses exactly this path: a branch, classification, evals, a PR. This design is the only door through which the factory changes itself.

**A person's own edits** in the app (Team → Roles, workflows, settings) on a linked project are written to `factory/` and committed with the person as author. They are pushed straight to the default branch when `humanEdits: direct` (the default; it's the same as editing the file by hand), or opened as a PR when `humanEdits: pr`. They aren't classified or evaluated: classification governs the factory changing *itself*.

### 9. Two people's daemons writing at once

- **Ledger.** Each daemon appends only to files named after its own `writerId`, so no two daemons ever edit the same file. A pull is a rebase of local commits that only add new files or lines to the writer's own files, which can't conflict. `.gitattributes` sets `memory/ledger/** merge=union` as a second guard (for example when a person rebases by hand). Because the fold sorts events and treats votes as sums and duplicates as one entry, every daemon that has the same set of events computes the same memory, whatever order they arrived in. The offline check proves it: two clones write concurrently, sync through a bare repo, and their folds are equal.
- **Rules, decisions, factory files.** These change through commits by people or through PRs. A daemon whose rebase conflicts on one of these files aborts the rebase, moves its local commit to `tandemise/local/<writerId>/<short-id>`, opens a PR from it, and says so: "Your change to Developer conflicts with one from ana. Opened PR #12 to sort it out." The local cache keeps following the default branch.
- **Two promotions of the same lesson** from two daemons: each promotion's id is derived from the sorted ids of its lessons, and the branch name from that id. The second daemon finds the branch or PR already exists and adopts it instead of opening another.
- **Decisions written on two machines** produce the same file name (content-derived), so they deduplicate.

### 10. How prompts load the brain (layered and budgeted)

The context compiler (`packages/context/src/compiler.ts`) stays pure. The executor resolves what is relevant at the attempt's `brainSha` and passes it in. `ContextRequest` (`packages/context/src/types.ts`) gains:

```ts
readonly brain?: {
  readonly sha: string;
  readonly rules: readonly { path: string; text: string }[];         // layer 1, always
  readonly lessons: readonly { id: string; text: string; net: number }[]; // layer 2, budgeted
  readonly index: readonly { id: string; title: string }[];           // layer 3, one line each
};
```

`BrainService.contextFor(task, sha)` selects them:

1. **Rules (always loaded).** These replace the five knowledge fields, which become `memory/rules/project.md` at link time; projects without a brain keep the fields. They load from:
   - `memory/rules/project.md`;
   - `repo-<name>.md` for every repository the task touches;
   - `role-<id>.md` for the task's role.

   Rules are a `required` section. They are short by design, and a rules file over 8,000 characters shows a warning in the Brain screen.
2. **Lessons (budgeted, default 4,000 characters).** These are valid, active (or accepted) lessons whose scope matches the task: same repo, role or step key, or a `paths` glob matching a file named in the task's inputs or the dependency ChangeSet. Project-wide lessons match every task. They are ranked by:
   - scope specificity (step > role > paths > repo > project);
   - then `net`;
   - then `lastConfirmedAt`.

   Lessons are taken in rank order until the budget is reached. The section has `priority: 'background'` and a summary equal to its index lines, so under budget pressure the compiler drops bodies first (the existing `fitToBudget` behaviour).
3. **Index (the rest).** Every other matching lesson as one line (`id`, first 80 characters), under "More lessons you can read with brain.read". Capped at 40 lines.

The agent pulls detail on demand through three new MCP gateway tools (`packages/application/src/engine/mcp-gateway.ts`), granted with `repository.read`:

| Tool | Does |
|---|---|
| `brain.read(id)` | One entry, with its evidence and history. |
| `brain.search(query, scope?)` | Substring and scope search over valid entries and history, at most 20 results. |
| `brain.propose(text, scope)` | A candidate lesson (§6). At most five per run. |

None of these tools can reach `evals/`, factory files or the clone's path. Agents never get file access to the brain: the clone isn't in `--add-dir` and isn't under any worktree.

The contract notes (`#contractNotes`) gain one line: "If you learned something the next person doing this step should know, call brain.propose with one short sentence." This is the "propose additions after" half of the binding decision; the signals in §6 are the half that doesn't depend on the agent remembering.

Eval trials read the brain as frozen in their case (the trial's `knowledge` already comes from the snapshot, `task-executor.ts:1678-1685`), or, for a `brain` candidate, the candidate's rules. Trials don't call `brain.propose`.

### 11. Visibility

- **Every run records what it knew.** `runs.brain` (JSON, additive migration, like `runs.skills`) holds:
  - `sha`;
  - `rules` (paths);
  - `loaded` (entry ids, with their `net` at load time);
  - `indexed` (count);
  - `fetched` (ids the agent read through `brain.read`, recorded by the gateway);
  - `proposed` (ids it proposed).
- **Task view, "What it knew"** (`apps/desktop/src/renderer/src/screens/mission/TaskDetail.tsx`). A section listing:
  - the brain commit (short SHA, linked to the remote when there is one);
  - the rules files loaded;
  - each lesson loaded or fetched, with its text, counters and source, and thumbs up/down;
  - "Proposed by this run" for its candidates.

  Plain language: "Loaded 3 rules files and 5 lessons; read 1 more."
- **Brain screen** (a new project-level screen):
  - **Sync**: the remote, last pulled and pushed, the writer id, problems, and "Working from your copy" when offline.
  - **Lessons**: filter by scope and state. Each row shows text, scope, counters, "Loaded in N runs", last confirmed, and source (the mission title and a link to the run when it's local). Actions: accept/reject (candidates), **Make this a rule**, **Retire**. Superseded and retired entries appear under "History".
  - **Proposals**: open and recent promotions, with the classification, scorecard, PR link and state; "Applied on its own" with **Revert**.
  - **Factory**: the brain's factory files at `lastPulledSha`, what the project needs that this machine lacks (MCPs, skills), and code-repo workflows that can move in.
- **Feed.** A lesson created from your hold or rejection appears as one line on the mission feed: "Learned: 'Run npm run ci before opening a PR' (from your hold)". So the person sees their correction had an effect. It isn't a notification and isn't a message.

### 12. API (sketch)

Following `api-contract/src/setup.ts`:

- `GET /v1/workspaces/:id/brain` → link, sync status, counts.
- `POST /v1/workspaces/:id/brain` `{ mode: 'create' | 'adopt' | 'local', remote?, owner?, name? }`. For `adopt`, it first returns the P15 preview; `POST …/brain/link { hash, choices }` applies it.
- `DELETE /v1/workspaces/:id/brain` → unlink (keeps the clone and copies the factory into the database).
- `POST /v1/workspaces/:id/brain/sync`
- `GET /v1/workspaces/:id/brain/entries?scope=&state=`, `POST /v1/brain/entries/:id/{vote|accept|reject|retire|promote}`, `POST /v1/workspaces/:id/brain/entries` (Remember this).
- `GET /v1/workspaces/:id/brain/proposals`, `POST /v1/brain/proposals/:id/{accept|decline|revert}` (local-only accept/decline; revert for auto-applied).
- `GET /v1/runs/:id/brain` → the "What it knew" view.

Refusals come back in the daemon's own words. For example:
- "This project already has a brain: acme/brain."
- "A lesson can't contain a secret; it was left out."
- "The evals folder can only be changed by a person."

### 13. Layers

- **`@tandemise/domain`:** the pure parts: `brain/ledger.ts` (event schema, `foldLedger`, dedupe), `brain/classify.ts` (`classifyBrainChange(diff) → 'small' | 'structural'` with reasons), `brain/select.ts` (scope match and ranking).
- **`@tandemise/application`:** `BrainService`, the reflector and promoter, `BrainRepoPort`, the `brain.*` tools, and the executor hook that resolves the brain context and records `runs.brain`.
- **`execution-local`:** git through `CommandExecutor`.
- **`integration-github`:** `gh repo create` and `gh pr create` / `gh pr view`, beside the existing `pull-requests.ts`.
- **`persistence`:** one additive migration (`workspace_brains`, `runs.brain`).
- **`apps/desktop`:** stays a control surface over the REST API (`npm run check:boundaries`).

### 14. Phasing

The brain is one sub-project but four PRs. Each is proven in the real app before the next:

1. **Link and factory.** Layout, create/adopt/local, clone/pull/push, `factory/` as the source of truth, `mcps.yaml`, vendored skills, the Brain screen's Sync and Factory parts.
2. **Ledger and loading.** The ledger, the fold, rules and lessons in prompts, `brain.*` tools, `runs.brain`, "What it knew", Remember this, the Lessons list.
3. **Learning signals.** Candidates from holds, rejections and gates; the reflector; votes; the feed line.
4. **Promotion.** Classification, promotion evals, PRs, auto-apply and revert, Proposals.

## Constraints

- Everything executes locally (pivot decision). No step requires a server or network. Without a remote, every feature works except sharing.
- Respect the layer rules (`npm run check:boundaries`) as listed in §13.
- One additive migration per phase that needs one. Never rebuild a table (see migration 006's warning in the hold spec).
- The ledger is append-only by construction and by check.
- No model output is written to the brain without validation and scrubbing by `BrainService`.
- Repo artifacts are in English. UI copy follows the conventions: "you", plain verbs, no raw enums or tool names.

## Acceptance

**Offline**, in `scratch/brain-check.mjs`, added to `OFFLINE_CHECKS` (`scripts/run-checks.mjs`), written first and seen failing. All git runs against a local bare repository as the remote; `gh` is a fake script on `PATH` that records its arguments.

1. **Fold determinism.** The same events in any order (shuffled 100 times) fold to the same memory. Duplicate `add`s merge with summed votes. A superseded entry is invalid from `invalidAt` and still listed in history. A bad line is skipped and reported.
2. **Concurrent writers.** Two clones (two writer ids) append lessons and votes, both push (one is rejected, rebases and pushes again), and both folds are equal. No rebase conflict ever occurs on `memory/ledger/`.
3. **Append-only.** Every `BrainService` write path is exercised, and a byte-prefix check shows every existing ledger file is a prefix of its next version.
4. **Scrubbing.** A secret in a hold note, a reflector output and a Remember this text never reaches a committed file. An absolute path becomes repo-relative or is refused.
5. **Layout and codec.** Create writes `factory/` byte-identical to a P15 export of the same setup. Adopt previews with P15 items plus `tracker` and `mcps`. Personal fields are never written or applied.
6. **Classification.** A table of diffs covers every row of §8, including "removes an approval" and "touches evals/" (refused).
7. **Promotion gating.** With no promotion suite, nothing auto-applies. A small promotion with passing evals auto-applies with the trailers. A structural one opens a PR (the fake `gh` saw `pr create` with the evidence in the body). A failing one opens a draft.
8. **Selection and budget.** Scope ranking, the 4,000-character lesson budget, the index cap, rules always present. The compiler drops lesson bodies before rules under pressure.
9. **Isolation of evals.** No `brain.*` tool result, prompt or worktree contains anything from `evals/`. The reflector and promoter inputs don't either.
10. **Trials.** An eval trial produces no ledger events.

**Real app**, in `scratch/acceptance/brain/` (fresh `TANDEMISE_HOME`, daemon from this checkout, `electron-vite dev` over CDP, scripted agent, a bare repo as the remote, fake `gh`):

| # | Scenario | Must observe in the window |
|---|---|---|
| B1 | Project settings → Brain → **Create a brain** | Sync shows the remote and "Up to date"; the bare repo has `brain.yaml`, `factory/roles/development.md`, `memory/rules/project.md` |
| B2 | A second home links the same remote with **Use an existing brain** | The preview lists the items; after Link, Team → Roles shows the same Developer model as home 1 |
| B3 | Edit `factory/roles/development.md` in a separate clone and push; press Sync | Team → Roles shows the new model; no prompt to choose |
| B4 | Hold a task (#50), change a file, Continue | The feed shows "Learned: …"; Brain → Lessons shows it as active, source "your hold" |
| B5 | Start a new mission on the same step | Task view → "What it knew" lists that lesson and `project.md`; `runs.brain.loaded` has its id |
| B6 | Thumbs up three times across two missions | Brain → Proposals shows a promotion; with no promotion suite, a PR (fake `gh`) whose body names the lesson and says "Not evaluated" |
| B7 | Both homes write lessons, then both sync | Both Brain screens list the same lessons and counters |
| B8 | Disconnect the remote (rename the bare repo), start a task | The task runs; Sync shows "Working from your copy of the brain" |
| B9 | **Remember this** with a fake token in the text | The lesson is saved with "[redacted secret]"; the bare repo never contains the token |

One scenario (B4) also runs real Claude Code when it is available, as A15 does. `npm run ci` is green.

## Left to the builder

- Exact thresholds (the 4,000-character budget, the 40-line index, the 400-character entry, the 90-day staleness, `harmful ≥ 3`, a person's vote counting as three), as named constants with a comment saying why.
- The reflector and promoter prompts, and the zod schemas of their output.
- Batching and timing of ledger commits; the pull interval.
- The exact `.gitattributes` and `README.md` written at creation.
- Size caps for `evals/blobs/` and vendored `skills/`, and what the Brain screen says when one is exceeded.
- Whether "What it knew" is a section or a tab in TaskDetail.

## Calls made without the owner

The owner gave autonomy within the pivot direction. These calls are open to correction:

1. **`factory/` is the P15 tree, not a new format.** The brain extends the setup codec with a root parameter and two files (`tracker.yaml`, `mcps.yaml`) instead of inventing a parallel format.
2. **Once linked, the brain is the source of truth for the factory**, and the database is a cache of it. A person's edits in the app write through to the brain, directly by default (`humanEdits: direct`).
3. **Code repos' `.tandemise/workflows` keep loading**, but brain workflows shadow them, and the app offers to move them in.
4. **Lesson events go straight to the default branch, not through PRs.** Memory isn't the factory changing itself, and a PR per lesson would bury the team. Only promotions and factory changes are PRs. A protected default branch falls back to one standing PR per writer.
5. **One ledger file per writer per month** means git never conflicts on memory; the fold, not git, reconciles.
6. **Corrections made by a person become active lessons at once. Agent-proposed and gate-derived ones wait** for a person's accept or a second independent confirmation.
7. **Votes come from the reflector's tags and from people, not from outcome correlation.** Correlation is shown, never stored.
8. **Only lines added to rules or role instructions can ever auto-apply**, and only when the project opts in (`autoApply: small`, off by default) and has a promotion eval suite. Everything else is a PR, including model and skill changes, because they change spend or what code runs.
9. **Promotion evals live in the brain's `evals/`**, so every teammate's daemon can run the same gate. Only a person can change them. A promotion that touches them is refused.
10. **The workspace knowledge fields become `memory/rules/project.md`** for linked projects; the five fields remain for projects without a brain.
11. **History is written by code from the mission record, with no model**, and is searchable but not loaded by default.
12. **The daemon owns its own clone** under `TANDEMISE_HOME`, separate from any checkout the person has of the brain.
13. **The reflector runs on the role's economy model** and its spend is measured like any run. It runs only on the signals in §6, not after every run.
