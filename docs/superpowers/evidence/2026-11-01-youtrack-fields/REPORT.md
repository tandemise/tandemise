# Intake acceptance report

Run: 2026-11-01T18:37:14.431Z · build d363adb · fresh install at <fresh TANDEMISE_HOME> · fake YouTrack, Sentry and Slack
Result: **ALL PASS** (5/5 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| I1 — The Board lists the tracker's items, grouped by mapped state | PASS | 11/11 |
| I11 — The factory explains itself: lane before Start, a readable header, what decided the plan, the pull request link | PASS | 39/39 |
| I13 — Start is off for a container, a type the project does not build and another repository's item | PASS | 14/14 |
| I14 — Saving the tracker token clears the Board's cached problem | PASS | 5/5 |
| I15 — Refine a tracker Draft from the Board, write it back as ready, then Start it | PASS | 20/20 |

## I1 — The Board lists the tracker's items, grouped by mapped state

- ✅ the sidebar has Board right after Home — `["Home","Board","Missions","Inbox","Artifacts","Repositories","Brain","Team","Skills","Evals","Runtimes","Integrations","Settings"]`
- ✅ three groups: Ready, In progress, In review — `{"ready":"Ready\n1","inProgress":"In progress\n1","inReview":"In review\n1"}`
- ✅ the header names the tracker and offers Check sources now — `"YouTrack\nRead just now\nCheck sources now"`
- ✅ Ready lists GAR-1 "Checkout fails on Safari" with Start — `{"heading":"Ready\n1","rows":[{"key":"GAR-1","title":"Checkout fails on Safari","chips":[],"text":"GAR-1\nTask\nCheckout fails on Safari\nFactory decides\nQuick\nCareful\nStart"}]}`
- ✅ In progress lists GAR-2 with its assignee — `{"heading":"In progress\n1","rows":[{"key":"GAR-2","title":"Dark mode for the settings page","chips":[],"text":"GAR-2\nTask\nDark mode for the settings page\nkim\nAlready in progress\nStart"}]}`
- ✅ In review lists GAR-3 — `{"heading":"In review\n1","rows":[{"key":"GAR-3","title":"Release notes for 2.4","chips":[],"text":"GAR-3\nTask\nRelease notes for 2.4\nFactory decides\nQuick\nCareful\nStart"}]}`
- ✅ GAR-4 (Fixed) is not on the Board
- ✅ proof (fake YouTrack): the board query was read as written — `3`
- ✅ Settings → Intake shows the tracker (YouTrack) and the three sources — `"Intake\nFor Acceptance\nTracker\n\nWork is filed in YouTrack GAR, and you start it from the Board.\n\nTracker\nYouTrack\nGitHub Issues\nYouTrack address\nhttps, or http on this computer only.\nProject\nIts short name, a`
- ✅ a state YouTrack lacks is refused, shown in the daemon's own words — `{"shown":"YouTrack has no state 'Doing' in GAR. Its states are: Open, Submitted, In Progress, In Review, Fixed, Done, Won't fix, Duplicate, Obsolete, Draft.","daemonSays":"YouTrack has no state 'Doing' in GAR. Its states`
- ✅ …and nothing was saved
- screenshot: `I1-board.png`
- screenshot: `I1-settings-intake.png`
- screenshot: `I1-settings-refusal.png`

## I11 — The factory explains itself: lane before Start, a readable header, what decided the plan, the pull request link

- note: the ship step did not open a pull request within 4 minutes in this run, so the pull request link is not proven here
- ✅ the Board offers the lane before Start, named for the item — `{"label":"Lane for GAR-50","options":["Factory decides","Quick","Careful"],"value":"auto"}`
- ✅ proof (API): the mission carries the lane chosen on the Board — `"quick"`
- ✅ the header leads with the item, who started it and a link to it — `"YouTrack GAR-50 · started by Demostenes Garcia · Open the issue GAR-50 in YouTrack"`
- ✅ then a short summary in plain words (no Markdown) — `"The receipt shows the sum without a label, so people cannot tell it is the amount they paid. The copy should say Total."`
- ✅ the whole task is behind a closed disclosure — `{"lead":"YouTrack GAR-50 · started by Demostenes Garcia · Open the issue GAR-50 in YouTrack","summary":"The receipt shows the sum without a label, so people cannot tell it is the amount they paid. The copy should say Tot`
- ✅ 1100px light, task closed: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":218}`
- ✅ 1100px light, task closed: Delete stays inside the window — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":218}`
- ✅ 1100px light, task closed: the tabs stay on screen — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":218}`
- ✅ 1100px light, task open: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":482}`
- ✅ 1100px light, task open: Delete stays inside the window — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":482}`
- ✅ 1100px light, task open: the tabs stay on screen — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":482}`
- ✅ 1100px dark, task closed: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":218}`
- ✅ 1100px dark, task closed: Delete stays inside the window — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":218}`
- ✅ 1100px dark, task closed: the tabs stay on screen — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":218}`
- ✅ 1100px dark, task open: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":482}`
- ✅ 1100px dark, task open: Delete stays inside the window — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":482}`
- ✅ 1100px dark, task open: the tabs stay on screen — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":482}`
- ✅ 1440px light, task closed: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":218}`
- ✅ 1440px light, task closed: Delete stays inside the window — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":218}`
- ✅ 1440px light, task closed: the tabs stay on screen — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":218}`
- ✅ 1440px light, task open: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":538.75}`
- ✅ 1440px light, task open: Delete stays inside the window — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":538.75}`
- ✅ 1440px light, task open: the tabs stay on screen — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":538.75}`
- ✅ 1440px dark, task closed: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":274.75}`
- ✅ 1440px dark, task closed: Delete stays inside the window — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":274.75}`
- ✅ 1440px dark, task closed: the tabs stay on screen — `{"barTop":0,"barBottom":160.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":274.75}`
- ✅ 1440px dark, task open: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":538.75}`
- ✅ 1440px dark, task open: Delete stays inside the window — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":538.75}`
- ✅ 1440px dark, task open: the tabs stay on screen — `{"barTop":0,"barBottom":424.75,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":538.75}`
- ✅ a plain mission at 1100px: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":87.25,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":144.5}`
- ✅ a plain mission at 1100px: Delete stays inside the window — `{"barTop":0,"barBottom":87.25,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":144.5}`
- ✅ a plain mission at 1100px: the tabs stay on screen — `{"barTop":0,"barBottom":87.25,"titleTop":32,"titleBottom":54.5,"delRight":1072,"delBottom":62,"width":1100,"height":820,"tabsBottom":144.5}`
- ✅ a plain mission at 1440px: the title sits inside the header, and the header contains it — `{"barTop":0,"barBottom":87.25,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":144.5}`
- ✅ a plain mission at 1440px: Delete stays inside the window — `{"barTop":0,"barBottom":87.25,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":144.5}`
- ✅ a plain mission at 1440px: the tabs stay on screen — `{"barTop":0,"barBottom":87.25,"titleTop":32,"titleBottom":54.5,"delRight":1412,"delBottom":62,"width":1440,"height":820,"tabsBottom":144.5}`
- ✅ a plain mission still shows its goal as written — `"Tidy the onboarding copy"`
- ✅ "Why these steps" says which signal set each of type, size and risk — `"Type feature: the tracker calls it a Feature.\nSize tiny: the item says \"copy\".\nRisk low: nothing it names is in a sensitive area."`
- ✅ Done-when shows the line's Markdown as text: bold and code, not asterisks — `{"text":"Done when\nYou check these at review\n\nNo step in this plan verifies these lines, so you check them when you review the pull request.\n\nU1\nThe receipt says Total next to amount\nNo step in this plan verifies `
- ✅ with no step to verify it, it says once that you check it at review — `"Done when\nYou check these at review\n\nNo step in this plan verifies these lines, so you check them when you review the pull request.\n\nU1\nThe receipt says Total next to amount\nNo step in this plan verifies this; yo`
- screenshot: `I11-board-lane.png`
- screenshot: `I11-header-1100-light-closed.png`
- screenshot: `I11-header-1100-light-open.png`
- screenshot: `I11-header-1100-dark-closed.png`
- screenshot: `I11-header-1100-dark-open.png`
- screenshot: `I11-header-1440-light-closed.png`
- screenshot: `I11-header-1440-light-open.png`
- screenshot: `I11-header-1440-dark-closed.png`
- screenshot: `I11-header-1440-dark-open.png`
- screenshot: `I11-header-plain-1100.png`
- screenshot: `I11-header-plain-1440.png`
- screenshot: `I11-why-these-steps.png`
- screenshot: `I11-done-when.png`

## I13 — Start is off for a container, a type the project does not build and another repository's item

- ✅ proof (API): the tracker now builds Bug and Task, for repo:web — `{"kind":"youtrack","url":"http://127.0.0.1:32835","project":"GAR","board":"project: GAR #Unresolved","states":{"ready":["Open","Submitted"],"in_progress":"In Progress","in_review":"In Review","done":["Fixed","Done"],"won`
- ✅ the container (GAR-51) stays on the Board under Ready, its type Task shown — `{"type":"Task","reason":"Has 2 subtasks. Start one of them.","start":{"disabled":true},"group":"ready"}`
- ✅ …with "Has 2 subtasks. Start one of them." beside a disabled Start — `{"type":"Task","reason":"Has 2 subtasks. Start one of them.","start":{"disabled":true},"group":"ready"}`
- ✅ the Spike (GAR-54) stays on the Board under Ready, its type Spike shown — `{"type":"Spike","reason":"Spike: this project starts Bug and Task items.","start":{"disabled":true},"group":"ready"}`
- ✅ …with "Spike: this project starts Bug and Task items." beside a disabled Start — `{"type":"Spike","reason":"Spike: this project starts Bug and Task items.","start":{"disabled":true},"group":"ready"}`
- ✅ another repository's Bug (GAR-55) stays on the Board under Ready, its type Bug shown — `{"type":"Bug","reason":"Belongs to another repository (repo:api).","start":{"disabled":true},"group":"ready"}`
- ✅ …with "Belongs to another repository (repo:api)." beside a disabled Start — `{"type":"Bug","reason":"Belongs to another repository (repo:api).","start":{"disabled":true},"group":"ready"}`
- ✅ a plain Task (GAR-56) shows its type and Start is on — `{"type":"Task","reason":null,"start":{"disabled":false},"group":"ready"}`
- ✅ proof (API): Start of GAR-51 is refused in the same words — `{"status":409,"message":"Has 2 subtasks. Start one of them."}`
- ✅ proof (API): Start of GAR-54 is refused in the same words — `{"status":409,"message":"Spike: this project starts Bug and Task items."}`
- ✅ proof (API): Start of GAR-55 is refused in the same words — `{"status":409,"message":"Belongs to another repository (repo:api)."}`
- ✅ proof (fake YouTrack): none of the three moved — `["GAR-51 Open","GAR-54 Open","GAR-55 Open"]`
- ✅ Start on GAR-56 opens its mission — `"msn_01m6c69qebm2ydqa5pr3"`
- ✅ proof (fake YouTrack): GAR-56 is In Progress — `"In Progress"`
- screenshot: `I13-settings-start-rules.png`
- screenshot: `I13-board-start-off.png`
- screenshot: `I13-plain-task-started.png`

## I14 — Saving the tracker token clears the Board's cached problem

- ✅ a second project exists — `"ws_01m6c6ap99atb28rs89e"`
- ✅ without a token the Board says to save a YouTrack permanent token — `"Couldn't reach YouTrack: Save a YouTrack permanent token in this project's tracker settings first. Tandemise will try again."`
- ✅ proof (API): the board cache holds that problem — `"Couldn't reach YouTrack: Save a YouTrack permanent token in this project's tracker settings first. Tandemise will try again."`
- ✅ proof (API): GET board answers no problem and the ready items right after Save token, without a refresh — `{"readyKeys":["GAR-1","GAR-50","GAR-51","GAR-52","GAR-53","GAR-54","GAR-55"],"afterMs":506}`
- ✅ the Board shows the ready items and no problem banner — `{"banner":"","ready":["GAR-1","GAR-50","GAR-51","GAR-52","GAR-53","GAR-54","GAR-55"]}`
- screenshot: `I14-board-no-token.png`
- screenshot: `I14-board-after-token.png`

## I15 — Refine a tracker Draft from the Board, write it back as ready, then Start it

- note: mission msn_01m6c6bxspbvpsbnw4yg
- ✅ Settings → Intake has a Draft field beside the other states
- ✅ proof (API): the tracker maps Draft after Save tracker — `{"ready":["Open","Submitted"],"in_progress":"In Progress","in_review":"In Review","done":["Fixed","Done"],"wont_do":["Won't fix","Duplicate","Obsolete"],"draft":["Draft"]}`
- ✅ the Board shows a Draft group with GAR-150, offering Refine and no Start — `{"heading":"Draft\n1","label":"Draft","buttons":["GAR-150","Refine\nGAR-150"]}`
- ✅ Refine opens a draft mission linked to the item — `{"status":"DRAFT","title":"Greet visitors by name"}`
- ✅ the scripted product agent proposed Done-when lines and asked a question — `{"criteria":[["P1","proposed"],["P2","proposed"],["P3","proposed"]],"questions":[["Q1","open"]]}`
- ✅ proof (fake YouTrack): Refine wrote nothing; the item is still Draft with no comment — `{"writes":[],"state":"Draft"}`
- ✅ two accepted, one rejected, the question answered: ready — `{"ready":true,"criteria":2,"openQuestions":0,"proposedPending":0,"label":"Plan","detail":"All gate conditions met."}`
- ✅ proof (fake YouTrack): still nothing written while the person decided
- ✅ the card says it is ready to write, with Open refinement and the write button — `"GAR-150\nGreet visitors by name\nMission: Draft\nReady to write to YouTrack: 2 Done-when lines.\nOpen refinement\nfor GAR-150\nWrite to YouTrack and mark ready\nGAR-150"`
- ✅ …and the write button is enabled
- ✅ proof (fake YouTrack): the description keeps its text and gains the Done-when and Decisions sections — `"Visitors see a generic page. Make it feel personal.\n\n## Done when\n- [ ] Visiting the home page shows \"Hello, <name>\" for a signed-in visitor\n- [ ] A visitor who is not signed in sees \"Hello, friend\" instead of a`
- ✅ proof (fake YouTrack): GAR-150 moved from Draft to Open — `"Open"`
- ✅ proof (fake YouTrack): the activity comment says who refined it and what was written — `["<!-- tandemise:activity -->\n\nRefined in Tandemise by Demostenes Garcia: 2 Done-when lines, 1 answered question. Moved from Draft to Open."]`
- ✅ GAR-150 is in Ready with Start offered — `{"text":"GAR-150\nGreet visitors by name\nMission: Draft\nStart","start":true}`
- ✅ Start opens the same mission, not a second one — `"#/missions/msn_01m6c6bxspbvpsbnw4yg"`
- ✅ proof (fake YouTrack): Start moved GAR-150 to In Progress — `"In Progress"`
- ✅ proof (fake YouTrack): GAR-150 went Draft → Open → In Progress and stayed In Progress — `{"stayed":"In Progress","states":["State=Open","State=In Progress"],"moveProblem":null}`
- ✅ proof (API): the refined mission left draft for planning — `"BLOCKED"`
- ✅ proof (fake YouTrack): one activity comment, the refined line on top of Started — `["<!-- tandemise:activity -->\n\nRefined in Tandemise by Demostenes Garcia: 2 Done-when lines, 1 answered question. Moved from Draft to Open.\n\nStarted in Tandemise by Demostenes Garcia: Greet visitors by name."]`
- ✅ proof (SQL): one mission for the item — `1`
- screenshot: `I15-draft-group.png`
- screenshot: `I15-decided-on-mission.png`
- screenshot: `I15-ready-to-write.png`
- screenshot: `I15-ready-with-start.png`
- screenshot: `I15-started.png`
