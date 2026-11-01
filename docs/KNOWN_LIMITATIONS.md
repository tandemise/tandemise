# Known Limitations

What is not done, or is done in a way you should know about before relying on
it. Written plainly — a surprise here costs more than an omission.

## Not yet implemented

**Codex has never driven a real run.** The adapter is written and degrades
correctly, but the CLI is not installed on this machine. Its argv defaults are
configuration, editable from the Runtimes screen, precisely because they could
not be verified.

**No mission archive.** Worktrees and branches are deliberately never cleaned
up — the branch *is* the reviewable artifact — but nothing removes them either.
After a dozen missions expect a dozen stale `tandemise/*` branches and their
worktrees. Remove them with `git worktree remove` and `git branch -D`.

**No OS credential store on Linux or Windows.** On macOS a token you hand
Tandemise (a YouTrack token, a source's secret) goes in the Keychain. On Linux
and Windows it is written to `~/.tandemise/secrets.json` in plain text, with
mode `0600`, and the daemon logs a `secrets.file_backend` warning on start
(`apps/daemon/src/secrets.ts`). Tokens for `gh` and `claude` are never stored:
those CLIs keep their own sessions.

**The installers are not signed.** macOS builds are ad-hoc signed and Windows
builds are unsigned, so Gatekeeper and SmartScreen warn on first open. Signing
is wired in `.github/workflows/desktop-packages.yml` and turns on when the
certificates are added as secrets (see CONTRIBUTING.md). v0.9.0 was released
before the packaging workflow and has no installers.

**Only the Linux installers have been driven end to end.** The AppImage and
the .deb were run with no Node on `PATH` and driven over CDP through
connecting, creating a project and typing into a hold terminal
(`scratch/packaged-live-check.mjs`, evidence in
`docs/superpowers/evidence/2026-10-31-packaging/`). The macOS and Windows
installers are built by CI, where arm64 macOS and Windows x64 load the native
modules as a build-time check; neither has been opened as an app on a real
machine yet.

**Hold needs Claude Code.** Only a runtime that can resume a session
interactively can be held: today, Claude Code (and the scripted fake runtime
used by the checks). Codex and generic CLI runtimes cannot.

## Behaviour worth knowing

**Non-isolated tasks run in your actual checkout.** Product, design,
architecture and release use `isolation: 'none'`, so they write
`.tandemise/out/` into the repository you selected. That directory is added to
`.git/info/exclude` and cleared before each task, so your diff stays clean — but
an agent that writes elsewhere in that tree is writing to your working copy,
and there is no undo. Only code-writing tasks get a worktree.

**A mission with no repository fails late.** `repositoryId: null` produces tasks
that fail at target provisioning rather than being refused at creation. Adding
a repository sets it as the workspace default, which covers the normal path.

**Commit signing will break the fallback commit.** Commits Tandemise makes on a
worker's behalf are authored as `<roleId>@tandemise.local`. On a repository with
signing or a hooks policy that commit fails; it is caught and recorded as a
timeline note, so no work is lost, but the ChangeSet's `commits` will be empty
and nothing shouts about it.

**Planning has no run history.** `Run.taskId` is non-nullable, so the planner's
own execution has no `Run` row — its events are recorded against the mission
with `runId: null` and the UI cannot show a planning transcript.

**Limits do not count planning or refinement.** Only step runs write usage
records, so the planner's and the refinement agent's time and tokens are not
measured against a mission or monthly limit (see `docs/guides/limits.md`).

**Limits do not count intake either.** Turning an upload into the typed
document a mission works from has no `Run` row, like planning and refinement
above, so it costs nothing against a mission or monthly limit. The timeline says it
ran ("Read N uploads"), but it has no transcript, time or token count of its
own to show.

**Code handed back as a file is not built on.** A change handed back as a
file or an export becomes the step's output, and review reads it, but it has
no branch: integration merges nothing for it, work after it starts from the
mission's base branch, and a later agent round of the step starts from the
agent's own earlier branch. To have the code built on, hand back a pull request.

**Only a GitHub pull request link is read back on its own.** Handing in or
handing back a link, Tandemise can fetch a pull request's diff and commit
through `gh`; anything else — a Figma file, a doc, any other URL — needs an
export attached, or it is refused: "Nothing here can read that link. Attach an
export of it."

**A file you hand in is capped at 24 MB, and so is everything in one
request.** One file over that is refused before it is read ("That file is
larger than 24 MB."); several files that individually fit but add up to more
are refused together ("These files add up to more than 24 MB. Add the rest
later as feedback.").

**`git.clean` is only measured on a step with its own worktree.** A step that
works in place shares your checkout, whose state says nothing about the step,
so a gate reading `git.clean` there is refused when the workflow or plan is
written. (`security.required_checks` and `checks.<name>`, which were never
measured, were removed from the vocabulary in P15.)

**Screen Recording is not granted on this machine**, so macOS screenshot capture
reports `degraded`. Grant it in System Settings → Privacy & Security → Screen
Recording.

## Verified, so you do not have to wonder

Lease acquisition and event sequencing were tested under real multi-process
contention: four processes on one lease key at a 40ms TTL produced 63 handoffs
with zero overlapping holding windows, and four processes × 150 appends produced
600 unique gapless sequences. Filesystem containment, the prompt-injection
boundary, environment isolation, and the permission engine's default-deny
posture each have their own regression suite. See `docs/ACCEPTANCE.md`.

## An agent can reach a window's DevTools port if one is open

An agent runs as you, with your network, so it can connect to anything on
loopback, including a Tandemise window started with `--remote-debugging-port`.
The DevTools protocol has no authentication, so a connection there can read
the window and act in it (#162). Tandemise narrows this but cannot close it
without a sandbox:

- Every worker's environment loses what points at the app: Electron's and an
  AppImage's launch variables, `TANDEMISE_PORT`, any variable naming a CDP,
  DevTools or remote-debugging port, and inspector flags in `NODE_OPTIONS`
  (`packages/runtimes-core/src/agent-env.ts`, `scratch/app-port-env-check.mjs`).
- The packaged app opens no DevTools port. `scripts/factory.sh` opens one only
  with `start --cdp`, on a random port written to a 0600 file.

What is left: an agent that lists listening sockets (`ss -ltn`) or other
processes' command lines can still find a port you opened. Keep the port
closed unless you are driving the window, and close the window afterwards.

## The daemon's CORS grant is loopback-wide

Any process that can serve a page on `http://localhost` can have that page read
the daemon's unauthenticated `/v1/health` route, and attempt authenticated ones.
The grant cannot be narrowed to the desktop's exact origin because the Vite dev
server picks its own port, and the packaged renderer has no origin at all
(`file://` sends `null`). Every route except health still requires the bearer
token, which never leaves the connection file, so the exposure is liveness only.
Narrowing this means having the daemon learn the renderer's origin at handshake
time rather than inferring it - worth doing before any non-loopback transport.

## A profile selects a config directory, not a credential

`configDir` is the only environment variable a profile may set, and it is typed
as a path rather than exposed as a free-form env map - a map is where an
`ANTHROPIC_API_KEY` would end up, and credentials do not belong in the database
(MVP.md §P8). Two profiles can therefore be two logins, because the credential
lives in the config directory the profile names, but a profile still cannot
carry a token, a base URL override, or a proxy setting of its own. Doing that
properly means referencing the existing secret store by id rather than storing
a value, which is worth building before any runtime needs per-profile auth.

## A task's repository is chosen at plan time, not re-chosen on retry

A task names its repository when the plan is materialized, and a retry reruns it
in the same one. That is right for a retry of the same work, but a plan that put
a task in the wrong repository has to be re-planned rather than corrected in
place - there is no way to move a single task to another repository from the
mission view. A step that has not started can be moved by **Plan the rest
again**, which keeps what is done; one that already ran cannot.

## A wait step polls; it is not woken

A `wait` step runs a command on an interval until it exits 0. That covers CI, a
deploy and a post-deploy check without holding a model, but it is still polling:
a webhook arriving the instant a build finishes would be both faster and
cheaper. Inbound webhooks need a listener the daemon does not have, and a
tunnel or a hosted endpoint to reach it — worth doing when a workflow is waiting
on something that pushes rather than something that can be asked.

## Some vendors cannot be connected with one click

Connect relies on the vendor's authorization server accepting dynamic client
registration. GitHub's hosted MCP server and Stripe's do not (checked against
the live servers), so they are not connectors: GitHub goes through `gh`, and a
server like Stripe's needs a client registered with the vendor, which there is
no place to enter yet.

## A connect attempt does not survive a daemon restart

The attempt, its PKCE verifier and its loopback listener live in memory. If the
daemon restarts while you are on the consent page, the browser's redirect finds
nothing listening. Press Connect again.

## An integration's permissions are its capability, not a per-tool list

Earlier builds showed a switch per capability on each integration. Nothing ever
enforced those switches — they were stored and ignored — so they were removed
rather than left looking like a permission. What a worker can do with an app is
decided by which roles hold its capability and by the project's autonomy
setting. Choosing individual tools per project is not possible today.

## A local MCP server's `env` is config, not a secret

The stdio `mcp` transport passes `config.env` straight to the server process,
and config lives in the database. That is correct for a project ref or a
`--read-only` flag and wrong for an access token. Hosted servers do not have
this problem — their credentials are in the Keychain — so prefer the connector
when a vendor has one.

## A replan in progress forgets its note on a daemon restart

What a replan was asked with (your note, and which status to go back to if
it does not happen) is held in memory until its plan card is filed. If the
daemon restarts while the planner is still writing, the mission is planned
again without the note, and a replan that then fails goes back to Executing,
where the scheduler finds the mission's real state. A paused mission that was
being replanned is not paused again in that case. Once the card is filed,
everything it needs is stored with it.

## A worker's question does not survive a daemon restart

A worker blocked in `ask_human` is a live process waiting on the answer. A daemon
restart ends the run; the question is withdrawn, and the task retries and may
ask again. A question is also answered or expired within 24 hours, after which
the worker decides on its own and records the assumption.


## Planning and refinement runs get no skills

Pinned skills reach the steps of a mission, not the planner or the refinement
run that happen before it: those have no run record to pin a version on. A
skill that should shape the plan itself has to be said in the mission's request
for now.

## GitHub issues are polled, and only the newest 100 are read

Issue sync asks GitHub through `gh` on a timer (every 5 to 60 minutes, or
**Check now**); there is no webhook, so a labelled issue can take up to one
interval to appear. Each check reads the newest 100 open issues with the label;
an older one beyond that is picked up only once newer ones are closed or
unlabelled. An issue whose label is removed is no longer watched, so a later
close of it is not noticed.

## Evals

**Only one eval run per project at a time, and its trials run one at a
time.** Trials share the project's runtimes and one run's spend would
otherwise blur into another's, so starting a second run while one is going is
refused: "Another eval run is still going in this project." Within a run,
trials are driven case by case, repeat by repeat, baseline then candidate —
one at a time, never in parallel.

**Scores start at the update that shipped them; nothing is backfilled.**
Every gated step's run has been scored since this release, but a step that
ran before you upgraded left nothing behind to score — [From your
runs](guides/evals.md#from-your-runs) has no history before that point to
draw from.

**Planning, refinement and intake can never become eval cases.** Saving a
case needs a finished, gated agent step's scored run; none of those three
write one (see "Limits do not count planning or refinement" and "Limits do
not count intake either", above), so none of them can ever be saved.

**A trial's `ask_human` is answered "nobody", and every tool approval it asks
for is denied.** A worker mid-trial gets "Nobody can answer during an eval
trial. Continue with your best judgement and say what you assumed." and
continues on its own judgement; a tool that would otherwise wait for a
person is refused at once instead of held. A trial that would need a person
to unblock it fails rather than waiting for one who was never going to
answer.

**A trial replays the case's knowledge, decisions, answers and criteria
exactly, but reads today's workflow engine and gate vocabulary.** Only the
mission-specific content a case pins is frozen; the role each variant runs
as, and the code that evaluates its gate, are always today's — that is what
lets a candidate be compared against a baseline on identical ground. One
consequence: a trial's gate reads the same facts a real mission's would, so
a gate that only checks that an artifact of some type exists can't tell a
step's own new output from a case input of that same type already present
before the step ran — if a case's gate is a bare existence check and its
input already provides that type, the gate can pass without the step doing
anything.

**"Try on evals" on the Skills screen only helps once the update is
imported.** Updating a skill imports its new version, but a role keeps
pinning whatever it already had until someone moves it (see "My skill
changed. How do I take the new version?" in [Giving your agents your
skills](guides/skills.md)) — so trying the newer version needs it already
sitting in the library before there is anything to compare against the
roles still on the old one.
