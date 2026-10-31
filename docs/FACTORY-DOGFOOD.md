# Building Tandemise with Tandemise

Tandemise is built with a released Tandemise: a permanent local instance (the
"factory") whose project is this repository, whose tracker is this
repository's GitHub Issues, and whose agents are the Claude Code CLI on the
machine. Every friction found while using it is an issue in this repository.
This page says how that instance is run, how work goes through it, and how to
operate it from a script.

## The instance

| | |
|---|---|
| `TANDEMISE_HOME` | `~/.tandemise-factory` (never `~/.tandemise`, which stays the person's own) |
| The app | the newest `Tandemise-*-linux-x86_64.AppImage` in `~/.tandemise-factory/app/` |
| The project | **Tandemise**, one repository: the clone at `~/.tandemise-factory/repos/tandemise` |
| The brain | linked with **Keep it on this machine**: `~/.tandemise-factory/brains/<project>/`, no remote yet |
| Tracker | GitHub Issues on `tandemise/tandemise`, board query `is:open label:dogfood` |
| Runtime | Claude Code (Runtimes → **Discover runtimes** → **Add**), concurrency 3 |
| Auto-merge | off. Every pull request waits for a person. |

[`scripts/factory.sh`](../scripts/factory.sh) runs it:

```bash
scripts/factory.sh start      # the newest AppImage in app/; its daemon starts with it
scripts/factory.sh status     # window, daemon, release, API address, CDP port
scripts/factory.sh stop       # quits the window; the daemon and any held session keep running
scripts/factory.sh stop --daemon
scripts/factory.sh upgrade    # downloads the latest release into app/ and restarts
scripts/factory.sh api GET /v1/health
```

`FACTORY_HOME` overrides the home. An upgrade keeps the old AppImage next to the
new one (delete it once the new one runs); the app replaces an older daemon on
start and says so on screen.

## Setting it up from nothing

The order matters (see the issues labelled `dogfood` for why):

1. `mkdir -p ~/.tandemise-factory/app ~/.tandemise-factory/repos`, then
   `scripts/factory.sh upgrade` (it downloads the AppImage and starts it), and
   `git clone https://github.com/tandemise/tandemise.git ~/.tandemise-factory/repos/tandemise`.
2. **Create your first project**: name it Tandemise and add the clone.
3. **Runtimes → Discover runtimes → Add** on Claude Code; set its concurrency to 3.
4. Create the state labels once: `dogfood`, `status: in progress`,
   `status: in review` (`gh label create …`). GitHub Issues has only open and
   closed; every other state is a label, and it must exist.
5. **Settings → Intake → Tracker: GitHub Issues**, repository
   `tandemise/tandemise`, board query `is:open label:dogfood`, Ready `open`,
   In progress `status: in progress`, In review `status: in review`, Done
   `closed`, and "When a mission completes: move it to in review".
6. Only then link the brain (**Project settings → Brain → Keep it on this
   machine**). The brain copies the tracker it finds; once a brain is linked the
   tracker form is read-only, so a tracker set afterwards means unlinking and
   linking again.

## How a change goes through it

1. **An issue.** Anything worth doing becomes an issue in `tandemise/tandemise`
   with the `dogfood` label, a Conventional Commit title (the title becomes the
   pull request's and, squashed, the commit's), and a `## Done when` list. Keep
   it to one concern.
2. **Start.** The Board lists every open `dogfood` issue under Ready. **Start**
   opens a mission with the issue's Done-when lines, moves the issue to
   `status: in progress`, and keeps one activity comment on it up to date.
   The factory picks the lane; the Plan tab's **Why these steps** says why.
3. **Watch.** The step card's **Now** line is what the agent is doing.
4. **Hold and steer** when it goes the wrong way: **Hold** on the step turns the
   card into Claude Code's own terminal, in the step's worktree. Answer the
   folder-trust and permission-mode prompts (both default to "No, exit"), type
   what you want, and **Continue**: the pipeline takes the work as it stands.
5. **Pull request.** The ship step pushes the branch and opens the pull request
   on `tandemise/tandemise`, waits for CI, and files **Review and merge** in the
   Inbox; the issue moves to `status: in review`.
6. **A person reviews and merges.** Auto-merge stays off. Merging closes the issue.

## What the person reviews

- The pull request title is a Conventional Commit (`feat:`, `fix:`, `docs:`, …
  with a lowercase subject); the CI "Conventional PR title" check enforces it.
- The diff does what the issue's Done-when lines say, and nothing else.
- `npm run ci` is green in CI, and a UI change was looked at in the real app
  (the agent has no display; that proof is yours, or a `scratch/*-check.mjs`).
- No reference to anything outside this repository's product, and copy in the
  app's voice ([docs/DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) for UI).

Write the verdict as a review comment on the pull request, then merge or ask
for changes (Request changes on the step re-runs it with your words).

## Filing what you find

Every friction is an issue labelled `dogfood` plus `bug` or `enhancement`:
what you did, what happened, what you expected, the evidence (timestamps,
screenshots), and a proposed fix. Add it to the org board:

```bash
gh issue create -R tandemise/tandemise --label dogfood --label bug --title "fix: …" --body-file finding.md
gh project item-add 1 --owner tandemise --url <issue url>
```

Ask of each one: would raw Claude Code have been faster or clearer here? That
is the bar.

## Operating it from a script

### Over the daemon's HTTP API

`~/.tandemise-factory/daemon.json` (0600) has the daemon's `url` and `token`.
Every request carries `authorization: Bearer <token>` and
`x-tandemise-api-version: v1`; `scripts/factory.sh api` adds both:

```bash
scripts/factory.sh api GET /v1/workspaces
scripts/factory.sh api GET "/v1/missions?workspaceId=<ws>"
scripts/factory.sh api GET /v1/missions/<mission>            # its tasks, runs and status
scripts/factory.sh api GET /v1/workspaces/<ws>/board
scripts/factory.sh api POST /v1/workspaces/<ws>/board/refresh
scripts/factory.sh api GET /v1/workspaces/<ws>/intake/config
scripts/factory.sh api PATCH /v1/runtimes/<id> '{"maxConcurrent":3}'
```

The held terminal is a WebSocket at `/v1/tasks/<task>/terminal?token=<token>`:
binary frames are the PTY, and what you send is typed into it.

### Over CDP

`scripts/factory.sh start` gives the window `--remote-debugging-port` (9371,
or the next free port, written to `~/.tandemise-factory/cdp-port`).
[`scripts/factory-cdp.mjs`](../scripts/factory-cdp.mjs) drives it:

```bash
node scripts/factory-cdp.mjs text                 # the window's text
node scripts/factory-cdp.mjs go '#/board'         # navigate
node scripts/factory-cdp.mjs click 'Start' 0      # the first button with that label
node scripts/factory-cdp.mjs shot board           # a PNG under ~/.tandemise-factory/shots/
node scripts/factory-cdp.mjs screen               # the held terminal's rows
node scripts/factory-cdp.mjs type 'Fix the copy'  # types into the held terminal, then Enter
```

A window that is not on screen may stop painting; every command first asks for
a tiny screenshot, which makes it paint. The window's native folder picker
cannot be driven over CDP: add a repository over the API
(`POST /v1/workspaces` with `repositoryPath`) and reload the window.
