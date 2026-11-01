# Dogfood: Tandemise v0.10.0 building Tandemise (2026-10-31/11-01)

The first run of a released Tandemise as a real software factory on its own
repository, with the real Claude Code CLI (2.1.316) as the only runtime. Every
earlier acceptance run used fakes. The bar was the owner's: raw Claude Code is
faster, simpler, more flexible and more transparent. Is this better than that?

## Setup

- The released `Tandemise-0.10.0-linux-x86_64.AppImage` (Linux, Wayland),
  `TANDEMISE_HOME=~/.tandemise-factory`, driven over CDP. The instance became
  the permanent factory described in [docs/FACTORY-DOGFOOD.md](../../../FACTORY-DOGFOOD.md).
- Project **Tandemise** on a fresh clone of `tandemise/tandemise`. The brain was
  local-only at first, then moved to the private `tandemise/tandemise-brain`.
  The tracker is GitHub Issues on `tandemise/tandemise` with board query
  `is:open label:dogfood`. Auto-merge is off.
- Three real, small items were filed as `dogfood` issues and started from the
  Board at 18:02–18:03 local time (UTC−5):
  - #97 docs: the quickstart said Claude Code is detected automatically;
  - #96 the project-name placeholder was another product's name;
  - #95 Linux showed "Finder" and "follows macOS".

`timeline.log` is the raw, timestamped log of the session. The PNGs are the
screens it refers to.

## Timings (Start → pull request)

| Item | Lane chosen | Code done | PR | Start → PR | Person stepped in |
|---|---|---|---|---|---|
| #97 docs, 1 file | quick (Docs · tiny) | ~2 min | [#110](https://github.com/tandemise/tandemise/pull/110) | **38 min** | Hold once (to stop a second full CI run) |
| #95 copy, 9 files | quick (Fix · tiny: the word "copy" in the body) | ~3 min | [#116](https://github.com/tandemise/tandemise/pull/116) | **71 min** | Hold + steer once; "Accept the result" once |
| #96 one string | standard fix: implement, review, verify, ship (Fix · *medium*: no keyword) | ~3 min | [#118](https://github.com/tandemise/tandemise/pull/118) | **84 min** | "Accept the result" once |

The same three changes in Claude Code in a terminal take about 3–5 minutes
each, including `gh pr create`, with CI running on GitHub in parallel.

The time went to the same place on every item. The agent ran `npm run ci` in
its fresh worktree (15–20 min with three running in parallel). Then the gate
ran `npm test`, the same offline suite, a second time. That run hit the
hard-coded 10-minute check budget and **failed**. The step re-ran the agent
from scratch, which ran the full CI again and timed out again. The step then
blocked until a person pressed **Accept the result and continue**. The
repository's test check was bounded at 18:38 through the API (no screen
exists), but attempts that had already started kept the old command.

## What worked

- **Intake → Board → Start** works with GitHub Issues. Start opened a mission
  with the issue's Done-when lines and moved the issue to `status: in progress`.
  It kept **one** activity comment up to date (the plan, then the PR link) and
  showed the claim on Home ("Who's working on what"). It moved the issue to
  `status: in review` when the PR was waiting.
- **The agents' work was good.** All three diffs did what the issues asked.
  Where it made sense they added a regression check (#95's
  `platform-words-check`, #96's first-run-words check). Each agent committed
  its code within 2–3 minutes of Start.
- **Hold is the real Claude Code.** The terminal is the agent's own session in
  its worktree. Typing steered it exactly as in Claude Code, and **Continue**
  handed it back. This is the part that meets the "transparent" bar.
- **The Now line** ("Running grep …", "Committed a8a6f7b. Waiting for npm run ci
  to finish.") is a good live signal.
- **Why these steps** states the lane and what was skipped in one sentence.
- **The Inbox "Review and merge" card** gives the risk score and its reasons
  ("3 of 2 allowed: Done-when lines not independently verified, no independent
  review, a person had to step in") and links the PR. Auto-merge stayed off and
  nothing merged on its own.
- Adopting a brain (**Use an existing brain** → Preview → Link) brought the
  tracker back with it.

## What did not

Ranked by how much each cost against "faster than Claude Code":

1. **Gate timeouts block the loop on this repository** ([#111](https://github.com/tandemise/tandemise/issues/111)).
   `npm test` takes longer than the fixed 10-minute budget, so the gate fails,
   the step re-runs in full, fails again, and blocks. The budget cannot be
   changed in the app.
2. **Every item runs the full suite at least twice** ([#106](https://github.com/tandemise/tandemise/issues/106)),
   including the docs-only change.
3. **A retry undoes what the person said during Hold** ([#117](https://github.com/tandemise/tandemise/issues/117)).
   #95's retry reverted the copy I had asked for, back to "System follows your
   system.". The retries for #95 and #96 also both edited an unrelated check to
   get green.
4. **The retry is not told why the gate failed** (fixed in [#114](https://github.com/tandemise/tandemise/pull/114)).
   It was told only "checks.tests is FAIL", even for a timeout, so agents went
   looking for broken tests.
5. **Work runs one at a time by default** ([#101](https://github.com/tandemise/tandemise/issues/101)).
   A discovered runtime gets concurrency 1. Two of the three started items sat
   "waiting for a runtime slot", and the Board gave no hint.
6. **Hold opens on two modal prompts, and both default to quitting** ([#102](https://github.com/tandemise/tandemise/issues/102)):
   the folder-trust prompt and the bypass-permissions warning.
7. **Task size is a keyword lottery** ([#103](https://github.com/tandemise/tandemise/issues/103)).
   The one-line change got the four-step lane and the nine-file change got the
   quick lane. Why these steps does not say which signal decided.
8. **The tracker cannot be set once a brain is linked** ([#99](https://github.com/tandemise/tandemise/issues/99)),
   and GitHub's state labels must be created by hand ([#100](https://github.com/tandemise/tandemise/issues/100)).
9. **The PR the factory opens is thin** ([#113](https://github.com/tandemise/tandemise/issues/113)).
   It has no summary and no `Closes #n`, and it says "See the QA report" when
   there was no QA. The review card on the mission page has no PR link (the
   Inbox card does).
10. **Agents cannot prove UI changes** ([#107](https://github.com/tandemise/tandemise/issues/107)).
    No display is passed through to the agent, so the real-app proof that
    AGENTS.md asks for falls to the reviewer.

Also filed:

- the daemon inherits the window's DevTools socket ([#104](https://github.com/tandemise/tandemise/issues/104));
- the mission header is the flattened issue body ([#105](https://github.com/tandemise/tandemise/issues/105));
- Share this brain cannot use an existing empty repository, and its error
  reference is in no log ([#112](https://github.com/tandemise/tandemise/issues/112), fixed in [#115](https://github.com/tandemise/tandemise/pull/115));
- papercuts from the first ten minutes: the repository field is a native
  folder picker only, Fake Runtime is offered in the release, and items already
  in progress still show Start ([#108](https://github.com/tandemise/tandemise/issues/108));
- `p3-contributions-check` failed on any machine without
  `init.defaultBranch=main`, which made every agent's CI red (fixed in [#109](https://github.com/tandemise/tandemise/pull/109)).

## Compared with raw Claude Code

| | Raw Claude Code | Tandemise v0.10.0 today |
|---|---|---|
| Time to a PR for a small change | 3–5 min | 38–84 min, plus waits on a person |
| Setup | none | ~15 min, with two dead ends (brain before tracker, labels) |
| Transparency | the conversation | Now line and Hold (good); retries silently diverge from what you said |
| Steering | type | Hold → two prompts → type → Continue; lost on retry |
| Parallel work | open three terminals | concurrency 1 until you find the setting |
| PR quality | `gh pr create` with a summary and `Closes` | a template with no summary or issue link |
| What it adds over Claude Code | — | tracker state and one activity comment, claims, a risk-scored merge card, lane choice, lessons in a brain |

## Verdict

It is not a factory yet. On this repository, a small change cannot get from
Start to a pull request without a person unblocking it. When it does get
there, it takes 10–20× longer than doing the change in Claude Code, almost all
of it spent on duplicated test runs that overrun the budget and on retries
that start over.

The pieces around the agent work and are worth keeping: intake, the Board,
claims, the activity comment, the review card, and Hold. The loop in the
middle has to change before it beats a terminal: the gate, the retry, the test
budget, and what a retry remembers. The fixes that matter most are #111, #106
and #117. #114 and #109 are small and ready.
