# Intake acceptance report

Run: 2026-11-01T08:53:23.643Z · build 9a1f778 · fresh install at /tmp/tdm-intake-run-mvxld2vq · fake YouTrack, Sentry and Slack
Result: **ALL PASS** (2/2 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| I1 — The Board lists the tracker's items, grouped by mapped state | PASS | 11/11 |
| I13 — Start is off for a container, a type the project does not build and another repository's item | PASS | 14/14 |

## I1 — The Board lists the tracker's items, grouped by mapped state

- ✅ the sidebar has Board right after Home — `["Home","Board","Missions","Inbox","Artifacts","Repositories","Brain","Team","Skills","Evals","Runtimes","Integrations","Settings"]`
- ✅ three groups: Ready, In progress, In review — `{"ready":"Ready\n1","inProgress":"In progress\n1","inReview":"In review\n1"}`
- ✅ the header names the tracker and offers Check sources now — `"YouTrack\nRead just now\nCheck sources now"`
- ✅ Ready lists ACME-1 "Checkout fails on Safari" with Start — `{"heading":"Ready\n1","rows":[{"key":"ACME-1","title":"Checkout fails on Safari","chips":[],"text":"ACME-1\nTask\nCheckout fails on Safari\nFactory decides\nQuick\nCareful\nStart"}]}`
- ✅ In progress lists ACME-2 with its assignee — `{"heading":"In progress\n1","rows":[{"key":"ACME-2","title":"Dark mode for the settings page","chips":[],"text":"ACME-2\nTask\nDark mode for the settings page\nkim\nAlready in progress\nStart"}]}`
- ✅ In review lists ACME-3 — `{"heading":"In review\n1","rows":[{"key":"ACME-3","title":"Release notes for 2.4","chips":[],"text":"ACME-3\nTask\nRelease notes for 2.4\nFactory decides\nQuick\nCareful\nStart"}]}`
- ✅ ACME-4 (Fixed) is not on the Board
- ✅ proof (fake YouTrack): the board query was read as written — `3`
- ✅ Settings → Intake shows the tracker (YouTrack) and the three sources — `"Intake\nFor Acceptance\nTracker\n\nWork is filed in YouTrack ACME, and you start it from the Board.\n\nTracker\nYouTrack\nGitHub Issues\nYouTrack address\nhttps, or http on this computer only.\nProject\nIts short name, a`
- ✅ a state YouTrack lacks is refused, shown in the daemon's own words — `{"shown":"YouTrack has no state 'Doing' in ACME. Its states are: Open, Submitted, In Progress, In Review, Fixed, Done, Won't fix, Duplicate, Obsolete.","daemonSays":"YouTrack has no state 'Doing' in ACME. Its states are: O`
- ✅ …and nothing was saved
- screenshot: `I1-board.png`
- screenshot: `I1-settings-intake.png`
- screenshot: `I1-settings-refusal.png`

## I13 — Start is off for a container, a type the project does not build and another repository's item

- ✅ proof (API): the tracker now builds Bug and Task, for repo:web — `{"kind":"youtrack","url":"http://127.0.0.1:45397","project":"ACME","board":"project: ACME #Unresolved","states":{"ready":["Open","Submitted"],"in_progress":"In Progress","in_review":"In Review","done":["Fixed","Done"],"won`
- ✅ the container (ACME-5) stays on the Board under Ready, its type Task shown — `{"type":"Task","reason":"Has 2 subtasks. Start one of them.","start":{"disabled":true},"group":"ready"}`
- ✅ …with "Has 2 subtasks. Start one of them." beside a disabled Start — `{"type":"Task","reason":"Has 2 subtasks. Start one of them.","start":{"disabled":true},"group":"ready"}`
- ✅ the Spike (ACME-8) stays on the Board under Ready, its type Spike shown — `{"type":"Spike","reason":"Spike: this project starts Bug and Task items.","start":{"disabled":true},"group":"ready"}`
- ✅ …with "Spike: this project starts Bug and Task items." beside a disabled Start — `{"type":"Spike","reason":"Spike: this project starts Bug and Task items.","start":{"disabled":true},"group":"ready"}`
- ✅ another repository's Bug (ACME-9) stays on the Board under Ready, its type Bug shown — `{"type":"Bug","reason":"Belongs to another repository (repo:api).","start":{"disabled":true},"group":"ready"}`
- ✅ …with "Belongs to another repository (repo:api)." beside a disabled Start — `{"type":"Bug","reason":"Belongs to another repository (repo:api).","start":{"disabled":true},"group":"ready"}`
- ✅ a plain Task (ACME-10) shows its type and Start is on — `{"type":"Task","reason":null,"start":{"disabled":false},"group":"ready"}`
- ✅ proof (API): Start of ACME-5 is refused in the same words — `{"status":409,"message":"Has 2 subtasks. Start one of them."}`
- ✅ proof (API): Start of ACME-8 is refused in the same words — `{"status":409,"message":"Spike: this project starts Bug and Task items."}`
- ✅ proof (API): Start of ACME-9 is refused in the same words — `{"status":409,"message":"Belongs to another repository (repo:api)."}`
- ✅ proof (fake YouTrack): none of the three moved — `["ACME-5 Open","ACME-8 Open","ACME-9 Open"]`
- ✅ Start on ACME-10 opens its mission — `"msn_01m6b4zgr3ep2btwztqg"`
- ✅ proof (fake YouTrack): ACME-10 is In Progress — `"In Progress"`
- screenshot: `I13-settings-start-rules.png`
- screenshot: `I13-board-start-off.png`
- screenshot: `I13-plain-task-started.png`
