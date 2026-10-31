# Hold and interact: acceptance report

Run: 2026-10-31T21:00:53.726Z · build 61686d2 · fresh install at /tmp/tdm-hold-run-mvwvo4c3
Result: **ALL PASS** (12/12 scenarios) · real Claude Code scenario skipped

| Scenario | Result | Checks |
|---|---|---|
| H1 — Hold a running step: the panel shows its resumed session and takes your typing | PASS | 10/10 |
| H2 — Iterate: what you make in the terminal lands in the step's worktree | PASS | 4/4 |
| H3 — Continue: a resumed pass on the captured session, no attempt spent, output gated as usual | PASS | 12/12 |
| H4 — Close the panel mid-hold: the terminal keeps going, and reopening repaints it | PASS | 8/8 |
| H5 — Restart the daemon mid-hold: still HELD, and reopening resumes the captured session | PASS | 9/9 |
| H6 — Hold a step waiting on ask_human: its question leaves the Inbox | PASS | 10/10 |
| H7 — Hold a ready step: a fresh session in a worktree made for it | PASS | 9/9 |
| H8 — "Now": a running step says what it is doing, and the line follows its events | PASS | 9/9 |
| H9 — Refusals: Hold says why it is not offered, in the daemon's words | PASS | 8/8 |
| H10 — Hold an output under review: a new round, a new version, reviewed again | PASS | 8/8 |
| H11 — Profile pinning: Continue resumes on the profile the hold was made on | PASS | 5/5 |
| H12 — The terminal panel works with a keyboard and a screen reader | PASS | 20/20 |

## H1 — Hold a running step: the panel shows its resumed session and takes your typing

- note: dark: terminal background rgb(9, 9, 23), text rgb(238, 249, 236)
- note: light: terminal background rgb(255, 255, 255), text rgb(32, 30, 80)
- ✅ proof (API): the step is running, and the view offers a hold — `{"ok":true}`
- ✅ its in-progress card offers Hold, next to its other actions — `{"text":"Hold","disabled":false,"title":""}`
- ✅ Hold opens the terminal panel, named for the step — `"Terminal: design"`
- ✅ the panel says who holds it: "Held by You" — `"designHeld by YouContinueReleaseScreen reader modeClose terminalClaude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task.F6 moves between the terminal and `
- ✅ it offers Continue, Release and Close terminal — `"designHeld by YouContinueReleaseScreen reader modeClose terminalClaude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task.F6 moves between the terminal and `
- ✅ proof (API): the step is HELD, its terminal open — `{"status":"HELD","hold":{"holdId":"hld_01m69vtzknn4ye6exget","heldBy":"mem_01m69vs7k6ct6m0hb0ss","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T20:53:51.861Z","terminalOpen":true}}`
- ✅ proof (DB): the run it stopped ended RESUMABLE — `{"id":"run_01m69vsfhyz3376hty9d","attempt":1,"status":"RESUMABLE","round":1,"purpose":"round","sessionId":"sess-hold-run_01m69vsfhyz3376hty9d","profileId":"rt_01m69vsabxag6tat6keh","startedAt":"2026-10-31T20:53:02.675Z",`
- ✅ proof (DB): the hold started from that run's session — `{"hold":{"id":"hld_01m69vtzknn4ye6exget","heldBy":"mem_01m69vs7k6ct6m0hb0ss","fromStatus":"RUNNING","profileId":"rt_01m69vsabxag6tat6keh","sessionBefore":"sess-hold-run_01m69vsfhyz3376hty9d","sessionAfter":null,"endedAt"`
- ✅ the terminal shows the session it resumed — `"Fake session sess-hold-run_01m69vsfhyz3376hty9d\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ what you type reaches the session (it echoes it back) — `"Fake session sess-hold-run_01m69vsfhyz3376hty9d\nhello from the panel\n> hello from the panel\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- screenshot: `H1-card-hold.png`
- screenshot: `H1-panel-dark.png`
- screenshot: `H1-panel-light.png`

## H2 — Iterate: what you make in the terminal lands in the step's worktree

- ✅ the panel is still open on the held step — `"Terminal: design"`
- ✅ the session reports the file written — `"Fake session sess-hold-run_01m69vsfhyz3376hty9d\nhello from the panel\n> hello from the panel\n\n>\n^[escprobe\n> scprobe\nwrite d.txt\n> write d.txt\nwrote d.txt\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\`
- ✅ proof (disk): d.txt is in the step's worktree — `"/tmp/tdm-hold/home/workspaces/ws_01m69vs7k5fvjyvd9x2r/missions/msn_01m69vscemfxdwwt5xs5/worktrees/onboarding-hold-slow-now-mvwvo77p-design-pec9gaq4/d.txt"`
- ✅ proof (disk): with what the session wrote
- screenshot: `H2-wrote-file.png`

## H3 — Continue: a resumed pass on the captured session, no attempt spent, output gated as usual

- ✅ the panel is open on the held step
- ✅ Continue ends the hold and the panel closes
- ✅ the step finishes — `{"status":"SUCCEEDED","reason":null}`
- ✅ proof (API): continuing spent no attempt — `{"before":1,"after":1}`
- ✅ proof (DB): the hold ended as continued, and its continuation was taken — `{"id":"hld_01m69vtzknn4ye6exget","heldBy":"mem_01m69vs7k6ct6m0hb0ss","fromStatus":"RUNNING","profileId":"rt_01m69vsabxag6tat6keh","sessionBefore":"sess-hold-run_01m69vsfhyz3376hty9d","sessionAfter":"fake-session-17934801`
- ✅ proof (DB): one new pass ran — `{"id":"run_01m69w065gm7ngqvjr1r","attempt":2,"status":"SUCCEEDED","round":1,"purpose":"retry","sessionId":"sess-hold-run_01m69w065gm7ngqvjr1r","profileId":"rt_01m69vsabxag6tat6keh","startedAt":"2026-10-31T20:56:42.435Z",`
- ✅ proof (DB): that pass resumed the session the terminal captured — `{"sessionAfter":"fake-session-1793480171332","resumedOn":[{"type":"checkpoint","externalSessionId":"fake-session-1793480171332","label":"session.resumed"}]}`
- ✅ proof (API): task.hold_ended carries the diff stat (d.txt added) — `{"files":1,"insertions":1,"deletions":0}`
- ✅ proof (API): and who held it, from where, the sessions and how long — `{"type":"task.hold_ended","holdId":"hld_01m69vtzknn4ye6exget","ending":"continued","endedBy":"mem_01m69vs7k6ct6m0hb0ss","sessionAfter":"fake-session-1793480171332","durationMs":170513,"diffStat":{"files":1,"insertions":1`
- ✅ proof (API): the continuation's DesignBrief was harvested — `[{"type":"DesignBrief","run":"run_01m69w065gm7ngqvjr1r"}]`
- ✅ proof (API): and gated as usual — `null`
- ✅ proof (API): a finished step is no longer holdable, in words — `{"ok":false,"reason":"This step is done; request changes instead."}`
- screenshot: `H3-done.png`

## H4 — Close the panel mid-hold: the terminal keeps going, and reopening repaints it

- ✅ Close terminal closes the panel
- ✅ proof (API): the step is still HELD, its terminal still open — `{"holdId":"hld_01m69vtzknn4ye6exget","heldBy":"mem_01m69vs7k6ct6m0hb0ss","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T20:53:51.861Z","terminalOpen":true}`
- ✅ proof (OS): the terminal process is still running — `{"pid":1864156,"alive":true}`
- ✅ the held step's drawer offers Open terminal, Release and Continue — `["Details","Open terminal","Continue","Release","Request changes","Close"]`
- ✅ and no Hold — `{"text":"Open terminal","disabled":false,"title":""}`
- ✅ the drawer steps aside for the panel
- ✅ the reopened panel repaints the scrollback: the greeting, your typing, the file — `"Fake session sess-hold-run_01m69vsfhyz3376hty9d\nhello from the panel\n> hello from the panel\n\n>\n^[escprobe\n> scprobe\nwrite d.txt\n> write d.txt\nwrote d.txt\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\`
- ✅ proof (DB): still the same hold
- screenshot: `H4-drawer-held.png`
- screenshot: `H4-reopened.png`

## H5 — Restart the daemon mid-hold: still HELD, and reopening resumes the captured session

- note: daemon 1861972 stopped
- ✅ the panel is open on the held step
- ✅ the window says the daemon is gone — `"The Tandemise daemon is not running"`
- ✅ proof: a new daemon is up — `{"old":1861972,"now":1870434}`
- ✅ proof (API): after the restart the step is still HELD — `{"status":"HELD","reason":"Held by Demostenes Garcia."}`
- ✅ proof (API): its terminal is not open — `{"holdId":"hld_01m69vtzknn4ye6exget","heldBy":"mem_01m69vs7k6ct6m0hb0ss","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T20:53:51.861Z","terminalOpen":false}`
- ✅ back on the mission, the panel says "The session ended." and offers "Open the terminal again" — `"designHeld by YouContinueReleaseScreen reader modeClose terminalThe session ended.This step has no open terminal. Hold it, or open its terminal again.Open the terminal againF6 moves between the terminal and the buttons `
- ✅ with the daemon's own words for why: there is no terminal open for this step — `"designHeld by YouContinueReleaseScreen reader modeClose terminalThe session ended.This step has no open terminal. Hold it, or open its terminal again.Open the terminal againF6 moves between the terminal and the buttons `
- ✅ the terminal opens again on the session the first terminal captured, not the run's — `{"resumed":"Fake session fake-session-1793480032025\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n","before":"sess-hold-run_01m69vsfhyz3376hty9d"}`
- ✅ proof (API): its terminal is open again, same hold — `{"holdId":"hld_01m69vtzknn4ye6exget","heldBy":"mem_01m69vs7k6ct6m0hb0ss","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T20:53:51.861Z","terminalOpen":true}`
- screenshot: `H5-daemon-gone.png`
- screenshot: `H5-session-ended.png`
- screenshot: `H5-reopened.png`

## H6 — Hold a step waiting on ask_human: its question leaves the Inbox

- ✅ setup: the run's MCP gateway config is on disk
- ✅ proof (API): the step waits on its question, a question card pending — `{"status":"AWAITING_INPUT","card":"Which layout should onboarding use (mvwvuwkg)?"}`
- ✅ the question waits on you in the Inbox — `"Inbox\nWhat is waiting on a person.\nWhich layout should onboarding use (mvwvuwkg)?\nFor you·Ask about onboarding mvwvurwb\nQuestion\njust now"`
- ✅ Hold from its drawer opens the terminal panel
- ✅ the session is resumed in the terminal, to answer there — `"Fake session sess-hold-run_01m69w2v302gjyc2v5e6\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (API): the step is HELD — `"HELD"`
- ✅ proof (API): the question card was withdrawn — `"CANCELLED"`
- ✅ the question no longer waits on you in the Inbox — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, work to hand back, stalled missions and quiet agents land here, one line each.\n"`
- ✅ it is listed as decided: withdrawn because the work moved on — `"uwkg)?\nWithdrawn — the work ended first · “Held by Demostenes Garcia.”\nAsk about onboarding mvwvurwb\nApprove the plan fo"`
- ✅ Release in the drawer ends the hold
- screenshot: `H6-inbox-question.png`
- screenshot: `H6-inbox-after.png`

## H7 — Hold a ready step: a fresh session in a worktree made for it

- note: setup: both steps go to one fake runtime with a single slot
- ✅ proof (API): one step runs and the other waits ready, never started — `{"status":"READY","reason":"Waiting for a runtime slot. 'Hold fake one slot': saturated: 1/1 runs in flight","holdable":{"ok":true}}`
- ✅ proof (API): it has no worktree yet
- ✅ its card offers Hold — `{"text":"Hold","disabled":false,"title":""}`
- ✅ Hold opens the terminal panel on it
- ✅ a fresh session starts (nothing to resume) — `"Fake session new\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (DB): a hold from READY, with no session before it — `{"id":"hld_01m69w4cbg19yy2vz8b7","heldBy":"mem_01m69vs7k6ct6m0hb0ss","fromStatus":"READY","profileId":"rt_01m69w41tshw0e8vywdf","sessionBefore":null,"sessionAfter":null,"endedAt":null,"ending":null,"consumedAt":null,"dif`
- ✅ proof (API): its worktree was provisioned — `"/tmp/tdm-hold/home/workspaces/ws_01m69vs7k5fvjyvd9x2r/missions/msn_01m69w43x8yk0vabykyt/worktrees/two-pages-mvwvvqlc-settings-pqmr8hsy"`
- ✅ proof (disk): the session works in that worktree
- ✅ Release ends the hold and the panel closes
- screenshot: `H7-fresh-session.png`

## H8 — "Now": a running step says what it is doing, and the line follows its events

- note: setup: the Design agent runs on a fake runtime that resumes and opens an interactive session on a PTY
- ✅ proof (API): the step runs on the fake runtime — `"Hold fake"`
- ✅ the Plan card shows a "Now" line while the step runs — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ the line changes as events arrive (at least three different lines) — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ it says what it does in words: "Running npm test" for a shell command — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ a file it edits reads relative to its worktree: "Editing .tandemise/out/DesignBrief.md" — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ no raw tool names in it — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ the feed card shows the same "Now" line — `{"feedNow":"Now Editing .tandemise/out/DesignBrief.md","last":"Now Editing .tandemise/out/DesignBrief.md"}`
- ✅ the task drawer shows it at the top — `"Now Editing .tandemise/out/DesignBrief.md"`
- ✅ proof (API): the view says the same — `"Editing .tandemise/out/DesignBrief.md"`
- screenshot: `H8-plan-card-now.png`
- screenshot: `H8-feed-card-now.png`
- screenshot: `H8-drawer-now.png`

## H9 — Refusals: Hold says why it is not offered, in the daemon's words

- note: an eval trial's step is refused with "Eval trials can't be held." — proven offline (scratch/hold-check.mjs); trial missions never appear in the window
- ✅ a finished step: Hold is disabled, and says why — `{"text":"Hold","disabled":true,"title":"This step is done; request changes instead."}`
- ✅ proof (API): holding it is refused in the same words — `{"status":409,"message":"This step is done; request changes instead."}`
- ✅ proof (API): the step is running, its agent finished, its checks going — `"SUCCEEDED"`
- ✅ while it checks its work: Hold on its card is disabled, and says why — `{"text":"Hold","disabled":true,"title":"It's checking its work. You can hold it once that's done."}`
- ✅ proof (API): holding it is refused in the same words — `{"status":409,"message":"It's checking its work. You can hold it once that's done."}`
- ✅ proof (API): the view says why — `{"ok":false,"reason":"Only Claude Code steps can be held for now."}`
- ✅ a runtime with no terminal: Hold is disabled, and says why — `{"text":"Hold","disabled":true,"title":"Only Claude Code steps can be held for now."}`
- ✅ proof (API): holding it is refused in the same words, and it keeps running — `{"status":409,"message":"Only Claude Code steps can be held for now."}`
- screenshot: `H9-done-step.png`
- screenshot: `H9-checking.png`
- screenshot: `H9-no-terminal.png`

## H10 — Hold an output under review: a new round, a new version, reviewed again

- ✅ proof (API): its output waits for your review — `{"card":"Approve the output of design?","briefs":1,"holdable":{"ok":true}}`
- ✅ Hold from its drawer opens the terminal panel
- ✅ the step's last session is resumed — `"Fake session sess-quick-run_01m69w5gfsxsmcjsc89k\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (API): HELD, in a new round — `{"status":"HELD","round":2}`
- ✅ proof (API): the review card is no longer waiting — `"REJECTED"`
- ✅ Continue produces a new version of the output, replacing the reviewed one — `[{"id":"art_01m69w5pem1612s66qaz","supersedes":"art_01m69w5gh0bsthkj7s8v"}]`
- ✅ which goes through review again: a new review card waits for you — `{"status":"AWAITING_APPROVAL","card":"Approve the output of design?"}`
- ✅ its card reads Round 2, in review — `"PRODUCT DESIGNER\ndesign\nIn review\nRound 2\njust now\nby\nDesign agent\n·\nresponsible\nYou\nFull doc\n\nOnboarding designed\n\nNeeds Approve the output of design?\nApplies immediately.\nReject without changes\nRequ"`
- screenshot: `H10-held-for-changes.png`
- screenshot: `H10-round-2-review.png`

## H11 — Profile pinning: Continue resumes on the profile the hold was made on

- note: setup: the Design agent runs on two runtime profiles, A then B
- ✅ proof (API): it runs on one of the two — `{"on":"rt_01m69w6nr721wvw8rbhp","a":"rt_01m69w6nr721wvw8rbhp","b":"rt_01m69w6nrdhfx4y4qq7m"}`
- ✅ proof (DB): the hold is pinned to that profile — `{"id":"hld_01m69w6wr8gejzjt1q1c","heldBy":"mem_01m69vs7k6ct6m0hb0ss","fromStatus":"RUNNING","profileId":"rt_01m69w6nr721wvw8rbhp","sessionBefore":"sess-hold-run_01m69w6txt8tadmzy6hq","sessionAfter":null,"endedAt":null,"e`
- ✅ setup: the Design agent now lists the other profile first
- ✅ the continuation finishes — `{"status":"SUCCEEDED","reason":null}`
- ✅ proof (DB): Continue resumed on the hold's profile, not the one routing would pick now — `{"pass":"rt_01m69w6nr721wvw8rbhp","pinned":"rt_01m69w6nr721wvw8rbhp","other":"rt_01m69w6nrdhfx4y4qq7m"}`
- screenshot: `H11-continued.png`

## H12 — The terminal panel works with a keyboard and a screen reader

- ✅ the panel is open on the held step — `"Terminal: design"`
- ✅ dark: axe (WCAG 2.0/2.1 A+AA) finds nothing in the panel — `[]`
- ✅ light: axe (WCAG 2.0/2.1 A+AA) finds nothing in the panel — `[]`
- ✅ every control has an accessible name — `[]`
- ✅ the terminal is a named region, described by how to leave it — `{"role":"group","label":"Terminal for design","keys":"F6 moves between the terminal and the buttons above it; the terminal keeps Tab and Esc for itself."}`
- ✅ Screen reader mode is a toggle that turns on xterm's accessibility tree — `{"pressed":"true","tree":true}`
- ✅ Tab in the terminal stays in the terminal (the program gets it) — `{"terminal":true,"inPanel":true,"name":"Terminal input"}`
- ✅ F6 moves focus out of the terminal to the panel's buttons — `{"terminal":false,"inPanel":true,"name":"Continue"}`
- ✅ and that button shows its focus ring
- ✅ Tab cycles inside the panel (it is a modal dialog)
- ✅ F6 again goes back into the terminal — `{"terminal":true,"inPanel":true,"name":"Terminal input"}`
- ✅ Escape in the terminal leaves the panel open — `"Terminal: design"`
- ✅ and focus in the terminal — `{"terminal":true,"inPanel":true,"name":"Terminal input"}`
- ✅ the program received the Escape (its line reads "^[escprobe") — `["^[escprobe"]`
- ✅ Continue is pending: Continue and Release are disabled — `[{"text":"Continuing…","disabled":true},{"text":"Release","disabled":true},{"text":"Screen reader mode","disabled":false},{"text":"Close terminal","disabled":false}]`
- ✅ F6 leaves the terminal for an enabled control while Continue is pending — `{"terminal":false,"disabled":false,"name":"Screen reader mode"}`
- ✅ with every control disabled, F6 moves focus to the panel itself — `{"terminal":false,"panel":true}`
- ✅ Escape on the panel's buttons closes the panel (after dismissing the button's tooltip) — `""`
- ✅ proof (API): the step is still HELD after closing — `"HELD"`
- ✅ its card offers Open terminal — `{"text":"Open terminal","disabled":false,"title":""}`
- screenshot: `H12-focus-out-of-terminal.png`
