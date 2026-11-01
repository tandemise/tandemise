# Dogfood: the factory on Tandemise v0.11.0 (2026-11-01)

The second run of the permanent factory instance described in
[docs/FACTORY-DOGFOOD.md](../../../FACTORY-DOGFOOD.md), right after it was
upgraded from 0.10.0 to 0.11.0. The [previous run](../2026-11-01-dogfood/REPORT.md)
took 38, 71 and 84 minutes from Start to a pull request and needed a person to
unblock every item. This run measures the same loop against a written bar.

## Setup

- `Tandemise-0.11.0-linux-x86_64.AppImage`, `TANDEMISE_HOME=~/.tandemise-factory`,
  driven over CDP. Claude Code is the only runtime, at concurrency 3.
- The tracker is GitHub Issues on `tandemise/tandemise` with the board query
  `is:open label:dogfood`. It comes from the private brain
  `tandemise/tandemise-brain`. Auto-merge is off.
- Every item was started with **Start** on the Board, and the lane the factory
  picked was accepted. Times are local (UTC−5) from a poller on the daemon's API
  (`timeline.log`). The machine's clock and GitHub's timestamps disagreed by an
  hour for part of the morning, so GitHub's times are not used.

## The bar

| | Target |
|---|---|
| Docs-only change, Start → PR | ≤ 5 min |
| Small code change, Start → PR | ≤ 12 min |
| Human unblocks | none: no Hold, no manual git, no API workarounds |
| Person actions | every one is in Home's Needs you or the Inbox, and the Needs you tile agrees with the list |
| After merge | the tracker item closes and the mission ends merged |
| Silent fallbacks | none: a tiebreak or parse failure, or a cancelled or expired card, is a defect |

## Timings

| | #137 tiebreak parse fix (small code) | #132 header and step card at 1100px (small UI code) |
|---|---|---|
| Lane | careful: the tiebreak failed, so careful defaults; a plan to approve | standard: the tiebreak failed again; no approval |
| Start | 03:43:21 | 04:06:04 |
| Plan ready | 03:44:01 (+0:40) | 04:06:16 (+0:12) |
| Plan approved | 03:44:41 (40 s waiting on me) | not asked |
| First commit | 03:46:22 (+3:01) | 04:26:13 (+20:09) |
| Review sent it back | no | yes; round 2 committed 04:33:15 |
| Verify done | 03:51:11 | 05:01:39 (QA ran 25 min) |
| PR opened | 03:51:16, [#156](https://github.com/tandemise/tandemise/pull/156) | 05:01:44, [#166](https://github.com/tandemise/tandemise/pull/166) |
| **Start → PR** | **7 min 55 s** (target 12: met) | **55 min 40 s** (target 12: missed) |
| CI green | ~04:04:35 (+21:14) | ~05:14:51 (+1:08:47) |
| Review and merge card | 04:05:32 (+22:11) | 05:15:30 (+1:09:26) |
| Merge, issue closed, mission ended | waiting on the person who merges | waiting on the person who merges |

GitHub CI takes 13 minutes after the PR opens (the Offline checks job alone runs about
13 minutes). The ship step files the card within a minute of CI going green.

**#95 and #96 were not run.** Both still have their 0.10.0 missions, which are
BLOCKED on "The pull request was closed without merging." The Board lists the
items under In review with `startable: Has a mission`, and the issues still
carry `status: in review`. They can't be started again until those missions are
cancelled (**Cancel mission** on Home or in the Inbox), and this session wasn't
permitted to cancel existing work. So the docs-only target (≤ 5 min) is
**unmeasured** in this run.

## Interventions

1. **Brain unlink and relink before anything could start.** After the upgrade
   the Board said "Set this project's tracker first.", although the brain's
   `factory/tracker.yaml` was valid and the Brain section said Up to date. The
   tracker read from the brain lives in a cache that only a sync that moves the
   brain's head fills, so a daemon restart empties it ([#153](https://github.com/tandemise/tandemise/issues/153)).
   Project settings → Brain → **Unlink**, then **Use an existing brain** →
   Preview → Take theirs → Link brought it back. This is a human unblock.
2. **#137: plan approval.** The careful lane asked for it, and I read the plan
   before approving. This is a legitimate person action, not an unblock. It is
   in the Inbox and on the mission.
3. **#137 and #132: the PR titles must be fixed before merging.** Both were
   opened as `chore: <issue title>` although both are bug fixes ([#157](https://github.com/tandemise/tandemise/issues/157)).
   Squashed, they would leave the changelog. I left the titles to the person
   merging and gave them in a review comment on each PR. Request changes on the
   step would re-run code and not touch the title, so the product has no tool
   for this.
4. **#132: real-app proof by the reviewer.** I ran the agent's
   `scratch/mission-header-1100-check.mjs` against the PR branch in the Electron
   window: 73 of 73 pass. This is the reviewer's job by design, not an unblock,
   and QA had also proven it on Xvfb.

There was no Hold, no manual git in a mission, and no API call to move a
mission.

## Review verdicts

- **[#156](https://github.com/tandemise/tandemise/pull/156) for #137: good,
  ready to merge after retitling** to `fix: read the first valid json object in
  the planner tiebreak reply`. Four files: the balanced-object scanner in
  `tiebreak.ts`, the optional `rawReply` on the decision type, the planner
  service and `planner-check.mjs`. It has a real summary, `Closes #137` and
  green CI. The Done-when table repeats the nested-bullet split (#155).
- **[#166](https://github.com/tandemise/tandemise/pull/166) for #132: good,
  ready to merge after retitling** to `fix: keep mission header actions on the
  title row and step card meta in full`. Three CSS files (the header becomes a
  grid, and the card byline wraps), the check and its screenshots. It has
  `Closes #132` and green CI. Proven in Electron at 1100 and 1440px, light and
  dark. The summary still says "U3 is only partly met", taken from the
  implement step before QA proved it.

## Defects

New, filed during this run (all `dogfood` and `needs triage`):

| Issue | What | Cost here |
|---|---|---|
| [#153](https://github.com/tandemise/tandemise/issues/153) | A daemon restart forgets the tracker that comes from a linked brain | blocked every Start until unlink/relink |
| [#154](https://github.com/tandemise/tandemise/issues/154) | The planner never sees the tracker item's labels, so `bug` doesn't make it a fix | "Type unclear" on both items, a tiebreak call on both, and the careful lane for #137 |
| [#155](https://github.com/tandemise/tandemise/issues/155) | Nested Done-when bullets become separate criteria | #137 had 7 criteria instead of 3 and was sized large |
| [#157](https://github.com/tandemise/tandemise/issues/157) | The PR is titled `chore: <issue title>` for a fix | both PRs need retitling before merge |
| [#162](https://github.com/tandemise/tandemise/issues/162) | An agent reached the person's window over its DevTools port | #132's agent listed the factory window's targets for ~40 s (read-only, disclosed) |
| [#163](https://github.com/tandemise/tandemise/issues/163) | Nothing says before a step starts that its Done-when needs a display it won't have | #132's implement step spent ~20 min improvising a headless Electron |
| [#167](https://github.com/tandemise/tandemise/issues/167) | Worktrees start from the clone's local `main`, which nothing updates | #137 was written against 0.10.0 (19 commits old); #132's agent rebased by hand |

Existing issues that recurred:

- [#137](https://github.com/tandemise/tandemise/issues/137): the tiebreak's
  "JSON could not be read" fallback, on **both** starts (5.4¢ and 3.9¢ thrown
  away). Each is a silent fallback by the bar's rule. #156 fixes it.
- [#151](https://github.com/tandemise/tandemise/issues/151): Home's Needs you
  tile disagreed with its own list all morning: 0 against "2 requests", 1
  against 3, 2 against 4. It counts approvals but not stalled missions.

Smaller things seen, not filed separately:

- #137's first implement attempt failed the ChangeSet contract (`handoff.headline`).
  The retry fixed only the artifact, cost 30 s, and reused the stored test result.
- The step card's Now line shows a literal `\n` inside multi-line shell commands.
- The test check ran in 6 s on #137, because it reuses the build, and the "once
  per tree" reuse worked as documented.

## What improved since 0.10.0

- **The loop no longer stalls on the gate.** No check timed out, nothing was
  retried for a timeout, and neither item needed Accept the result. #137 went
  from Start to a PR in under 8 minutes with no person in the loop beyond the
  plan approval its lane asks for.
- **PRs have a real summary and `Closes #n`** (#113 is fixed), plus a Done-when
  table and the lane's reasons.
- **The independent review earned its place.** On #132 it measured a case the
  agent's evidence missed (the actions sit above the title when PR chips widen
  the crumbs) and sent it back. Round 2's grid fixed it.
- **The ship step reports CI progress** ("6 of 8 checks done") and files the card
  within a minute of green. The tracker label moved to `status: in review` on
  time.

## Verdict against the bar

| | Result |
|---|---|
| Docs-only ≤ 5 min | **not measured**: #96 and #95 were held by their 0.10.0 missions |
| Small code ≤ 12 min | **met once, missed once**: #137 7:55; #132 55:40 (UI proof without a display, a review round, 25 min QA) |
| Zero human unblocks | **missed**: the brain had to be unlinked and relinked (#153), and both PRs need a manual retitle (#157) |
| Person actions visible, tile agrees | **partly**: every action was in the Inbox, but the tile disagreed with the list throughout (#151) |
| Item closes and mission ends merged | **not yet observed**: both PRs wait on the person who merges |
| No silent fallbacks | **missed**: the tiebreak fell back on both starts (#137) |

**Not ready yet**, but much closer than 0.10.0. A small non-UI change now
reaches a reviewable PR in about 8 minutes, against 38–84 minutes before. A UI
change still takes about an hour, because neither agent has a display to prove
it with. The run also needed a setup unblock (#153) and leaves the person to
fix the PR titles (#157). The fixes that move the bar most are #153, #157,
#154 (which would also have kept #137 out of the careful lane), #163 and #167.
After those, run #95 and #96 to measure the docs-only target.
