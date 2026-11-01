# Quickstart

## Run it

The simplest way is an installer from the
[latest release](https://github.com/tandemise/tandemise/releases/latest); the
[README](../README.md#install) lists the files and the per-platform notes
(FUSE or `NO_CLEANUP=1` for the AppImage, unsigned-build warnings). An
installed app carries its own daemon and its own Node.

From a source checkout:

```bash
git clone https://github.com/tandemise/tandemise.git && cd tandemise
nvm use                 # Node 22.23.1, per .nvmrc
npm install
npm run build
npm run dev             # builds, starts tandemd, then opens the desktop app
```

`npm run dev` leaves the daemon running when you close the window — that is
deliberate (MVP.md §7.3). Stop it with `npm run dev -- --stop-daemon`, or
`kill <pid>` using the pid printed on exit.

Run the two processes separately if you prefer:

```bash
npm run daemon          # tandemd on 127.0.0.1, ephemeral port
npm run desktop         # Electron, reads ~/.tandemise/daemon.json
```

### When the window says the daemon is not running

If no daemon is answering, the window starts one itself, on launch and again
each time you press **Retry**. An installed app always runs its own bundled
daemon on Electron's built-in Node and needs nothing else. A checkout
(`npm run desktop`) runs `apps/daemon/dist/main.js` on a Node 22 or newer,
looking, in order:

1. at `TANDEMISE_NODE`, if you set it (a full path to a `node` binary);
2. for `node` on your login shell's `PATH` (so nvm, Homebrew and volta work
   even when the app is opened from the Dock), then on its own `PATH`, then in
   the usual install directories (`/opt/homebrew/bin` and `/usr/local/bin` on
   macOS);
3. at Electron's own Node, as a last resort, when it is 22 or newer (Electron
   44 ships Node 24). The database driver and `node-pty` are N-API modules, so
   one build loads under either.

If none is usable, the screen says so and what to do: install Node 22+ or set
`TANDEMISE_NODE`, then press **Retry**. Which Node was used, and anything the
daemon printed while starting, is in `~/.tandemise/logs/daemon-launch.log`.

## First mission

1. **Repositories** (under your project in the sidebar): the daemon creates a workspace on first start,
   so all you do here is point it at a Git repository. For a first run, aim it
   at a throwaway clone: every code-writing task gets its own worktree, but
   product, design, architecture and release steps write `.tandemise/out/` in
   the checkout itself (see [Known limitations](KNOWN_LIMITATIONS.md)).
2. **Runtimes**: a fresh install has no runtimes configured, and nothing runs
   until you add one. Press **Discover runtimes** to list the agent CLIs
   installed on this machine, then press **Add** on Claude Code's row; it is
   used only once it shows **Configured**. Any other
   agent CLI can be added here as a `generic-cli` runtime — give it a command,
   an argument template with `{{prompt}}`, and whether the prompt goes as an
   argument or on stdin. No code change is needed to add a worker.
3. **Missions → New Mission**: describe the outcome in one sentence and write
   at least one line under **Done when (one per line)**, then press ⌘↵.
   Inspect the proposed plan, approve it, and watch the DAG execute. The
   mission's feed shows each Done-when line and whether QA verified it.
   Leave **Done when** empty and the button reads **Create and refine**
   instead: a product agent proposes criteria for you to decide first.

**How much process a task gets.** New mission's workflow defaults to **Let
the factory decide**. A small, low-risk task skips refinement and plan approval
and runs as one step and a pull request; a risky one gets the careful lane.
The Plan tab's **Why these steps** says why, and **Plan quick** / **Plan
careful** let you choose instead.

**Merging.** The ship step opens a non-draft pull request, waits for CI, and
files **Review and merge** in the Inbox. Turn auto-merge on in **Project
settings → Merge** (after reading its backtest) and low-risk changes merge on
their own, bound to the commit that was checked. See [The factory](FACTORY.md).

## Next

The guides in [`docs/guides/`](guides/) each answer one "how do I…":
[Done when](guides/done-when.md), [Refine](guides/refine.md),
[Backlog and work in progress](guides/backlog.md), [Limits](guides/limits.md),
[The Inbox](guides/inbox.md),
[The desk and the status report](guides/desk-and-status-report.md),
[Routines](guides/routines.md) and
[About and diagnostics](guides/about-and-diagnostics.md) (what to check, and
copy, when something goes wrong). [WORKFLOWS.md](WORKFLOWS.md) covers workflow
files and every gate fact.

## Intake: work from your tracker

Give the project a primary tracker in **Settings → Intake**: YouTrack (its
address, project and a permanent token, kept only in this computer's secret
store) or a repository's GitHub Issues, the board query, and which of its
states mean ready, in progress, in review, done and won't do. Add sources
there too (Sentry, PostHog, Slack, Discord, GitHub issues), each with its
secrets and noise filter. Then open **Board** in the sidebar:

- **Check sources now** reads every source; what passes the filter is filed in
  the tracker once, or linked to the item that already tracks it.
- **Start** on a ready item opens a mission with the item's "Done when"; the
  tracker moves it to in progress and keeps one activity comment up to date.
- The **Intake** tab lists every signal and what happened to it, in words.
  An unsure match waits in the Inbox as "Is this the same as ACME-7?".

A runner of your own pushes with a token from **Custom sources → Make a
token**, through the `tandemise` CLI (`npx tandemise` from a checkout):

```bash
TANDEMISE_URL=http://127.0.0.1:<port> TANDEMISE_INTAKE_TOKEN=tdi_… \
  npx tandemise intake push --source web-form --title "Export drops accents" \
  --url https://forms.example.com/replies/18 --key form-18
npx tandemise intake closures --source web-form   # what to close at your source
npx tandemise start ACME-12                        # Start from a shell (daemon token)
```

[Writing an intake runner](intake/README.md) has the contract, auth, the
closures feed and the JSON Schema.

## The brain
A project can link to a brain: one git repository with its roles, workflows,
rules and the lessons it has learned. In **Project → Brain**, choose **Create a
brain** (a private GitHub repository made with your `gh`), **Use an existing
brain** (a teammate's, with a preview of every change before you link), or
**Keep it on this machine** (share it later). Corrections you make become
lessons, the next run loads the relevant ones, and **Brain** in the sidebar shows
them, the rules they are becoming, and how the brain syncs. Sharing is
`git pull` and `git push`: no server, and no secret ever enters the brain.

## Hold and interact

Open a running or waiting agent step and choose **Hold**. The run stops, and
the task panel becomes a terminal inside the agent's own session and checkout:
type to steer it, edit files, run commands. **Continue** hands the step back and
the pipeline picks up from the work as it stands; **Release** ends the hold and
keeps your changes without resuming the session. Each step works in a fresh
checkout, so Claude Code first asks whether to trust that folder, defaulting to
"No, exit": press **Answer: Yes, I trust this folder** above the terminal (or
pick it with the arrow keys). Tandemise never writes your Claude Code config to
skip that question. A held session runs in accept-edits mode with the step's
shell tools allowed, so Claude Code's bypass-mode warning does not appear.
Holding stops the agent's run, including commands it left running in the
background; they are not restarted on **Continue**. The terminal needs
`node-pty`, which compiles on install (see CONTRIBUTING.md for Linux).

## Working as a team (optional relay)

Nothing here needs a server. When a team wants to see who is working on
which tracker item, one person runs the relay (`docker compose -f
apps/relay/compose.yaml up -d`, see [apps/relay/README.md](../apps/relay/README.md))
and everyone connects from **Settings → Team relay** with an invite code.
Webhooks from sources that only push (Sentry, WhatsApp) can land on the relay
and be picked up by one daemon.

## Where things are

| | |
|---|---|
| Database, artifacts, worktrees, logs | `~/.tandemise/` |
| Daemon connection info | `~/.tandemise/daemon.json` (0600) |
| Per-mission worktrees | `~/.tandemise/workspaces/<ws>/missions/<mission>/worktrees/` |
| Artifacts an agent produced | `.tandemise/out/` inside each worktree |
| Logs | `~/.tandemise/logs/` |
| The daemon's copy of each brain | `~/.tandemise/brains/<project>/` |

Your own checkout is never modified: every code-writing task runs in its own
Git worktree on its own branch, and the branch survives after the worktree is
released so the change stays reviewable. A step with no earlier step to build
on fetches `origin` first and starts from the remote's current default branch
(your local `main` is neither used nor moved, unless it already holds the
remote's tip plus work of your own). Offline, it starts from the local branch
and the step's target says it could not fetch.

## Checks

```bash
npm run check:boundaries          # enforces the dependency direction
npx tsc -b tsconfig.build.json    # whole monorepo

node scratch/gt.mjs                    # gate language + DAG validation
node scratch/persistence-check.mjs     # durability, leases, event ordering
node scratch/policy-eval-check.mjs     # permissions, risk, gate facts
node scratch/fs-security-check.mjs     # filesystem containment
node scratch/execution-check.mjs       # worktrees, process supervision, git
node scratch/runtime-check.mjs         # the real Claude Code CLI
node scratch/integrations-check.mjs    # tool broker, MCP gateway, gh, browser
node scratch/qa-e2e-check.mjs          # QA path against the running demo app
node scratch/e2e-daemon.mjs            # the daemon over its real HTTP + WS API
```

`docs/ACCEPTANCE.md` maps each MVP acceptance criterion to the script that
demonstrates it, and records what is not yet demonstrated.

## Adding a worker without writing code

The Runtimes screen can wire any CLI that takes a prompt and prints output:

```
command:      /usr/local/bin/some-agent
args:         ["--headless", "{{prompt}}"]
promptVia:    arg            (or "stdin")
outputFormat: ndjson         (or "text")
eventMap:     { "types": { "assistant": "message", "done": "completed" } }
```

That is the whole extension point for a new worker. Writing an adapter is only
necessary when a CLI needs bespoke argument handling or richer event mapping —
see `packages/runtime-claude` for the shape.
