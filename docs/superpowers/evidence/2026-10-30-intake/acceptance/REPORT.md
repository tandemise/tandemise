# Intake acceptance report

Run: 2026-10-31T06:05:08.330Z · build 807b911 · fresh install at /tmp/tdm-intake-run-mvvzq9kr · fake YouTrack, Sentry and Slack
Result: **ALL PASS** (10/10 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| I1 — The Board lists the tracker's items, grouped by mapped state | PASS | 11/11 |
| I2 — A busy Sentry error becomes one tracker item, with its chip | PASS | 6/6 |
| I3 — The same error from Slack links to the item instead of filing another | PASS | 5/5 |
| I4 — A quiet error is held back, with the reason in words | PASS | 3/3 |
| I5 — An unsure match is asked in the Inbox, and Same task links it | PASS | 5/5 |
| I6 — Start opens a mission with the item's criteria and the tracker follows | PASS | 8/8 |
| I7 — The mission completes: the item moves to In Review and the comment shows the criteria | PASS | 5/5 |
| I8 — The item is done: the loop closes at Sentry and in Slack | PASS | 5/5 |
| I9 — A custom runner pushes with its own token, and reads its closure back | PASS | 7/7 |
| I10 — A brain's source runs here only when switched on; a moved tracker gets no token until confirmed | PASS | 22/22 |

## I1 — The Board lists the tracker's items, grouped by mapped state

- ✅ the sidebar has Board right after Home — `["Home","Board","Missions","Inbox","Artifacts","Repositories","Brain","Team","Skills","Evals","Runtimes","Integrations","Settings"]`
- ✅ three groups: Ready, In progress, In review — `{"ready":"Ready\n1","inProgress":"In progress\n1","inReview":"In review\n1"}`
- ✅ the header names the tracker and offers Check sources now — `"YouTrack\nRead just now\nCheck sources now"`
- ✅ Ready lists ACME-1 "Checkout fails on Safari" with Start — `{"heading":"Ready\n1","rows":[{"key":"ACME-1","title":"Checkout fails on Safari","chips":[],"text":"ACME-1\nCheckout fails on Safari\nStart"}]}`
- ✅ In progress lists ACME-2 with its assignee — `{"heading":"In progress\n1","rows":[{"key":"ACME-2","title":"Dark mode for the settings page","chips":[],"text":"ACME-2\nDark mode for the settings page\nkim\nStart"}]}`
- ✅ In review lists ACME-3 — `{"heading":"In review\n1","rows":[{"key":"ACME-3","title":"Release notes for 2.4","chips":[],"text":"ACME-3\nRelease notes for 2.4\nStart"}]}`
- ✅ ACME-4 (Fixed) is not on the Board
- ✅ proof (fake YouTrack): the board query was read as written — `3`
- ✅ Settings → Intake shows the tracker (YouTrack) and the three sources — `"Intake\nFor Acceptance\nTracker\n\nWork is filed in YouTrack ACME, and you start it from the Board.\n\nTracker\nYouTrack\nGitHub Issues\nYouTrack address\nhttps, or http on this computer only.\nProject\nIts short name, a`
- ✅ a state YouTrack lacks is refused, shown in the daemon's own words — `{"shown":"YouTrack has no state 'Doing' in ACME. Its states are: Open, Submitted, In Progress, In Review, Fixed, Done, Won't fix, Duplicate, Obsolete.","daemonSays":"YouTrack has no state 'Doing' in ACME. Its states are: O`
- ✅ …and nothing was saved
- screenshot: `I1-board.png`
- screenshot: `I1-settings-intake.png`
- screenshot: `I1-settings-refusal.png`

## I2 — A busy Sentry error becomes one tracker item, with its chip

- ✅ the button said "Checking…" while it waited
- ✅ one new row on the Board — `{"before":["ACME-1","ACME-2","ACME-3"],"after":["ACME-1","ACME-5","ACME-2","ACME-3"]}`
- ✅ its chip reads "Sentry · 132 events" — `["Sentry · 132 events"]`
- ✅ it is Ready — `"ACME-5"`
- ✅ proof (fake YouTrack): exactly one create — `1`
- ✅ proof (fake YouTrack): its description has a "## Sources" section with the Sentry link — `"checkout/basket.ts\n\n## Sources\n- Sentry · acme/web · 132 events, 41 users · https://acme.sentry.io/issues/501/\n\nRecorded by Tandemise from Sentry, reported by someone."`
- screenshot: `I2-board-sentry.png`

## I3 — The same error from Slack links to the item instead of filing another

- ✅ no new row — `{"before":4,"after":4}`
- ✅ ACME-5's chips now include Slack — `["Sentry · 132 events","Slack · thread"]`
- ✅ the Intake tab says "Linked to ACME-5" — `{"fingerprint":"slack:acme.slack.com#support:C0SUPPORT:1730000001.000100","title":"TypeError: basket is null","source":"Slack","status":"Linked to ACME-5","text":"TypeError: basket is null\nSlack\nLinked to ACME-5\njust no`
- ✅ proof (fake YouTrack): still one create — `1`
- ✅ proof (fake Slack): the thread was acknowledged with :eyes: — `["eyes"]`
- screenshot: `I3-board-two-sources.png`
- screenshot: `I3-intake-linked.png`

## I4 — A quiet error is held back, with the reason in words

- ✅ not on the Board
- ✅ Intake: "Held back: 3 events in 24 h; this source needs 20" — `{"fingerprint":"sentry:acme/web:502","title":"RangeError: avatar upload too large","source":"Sentry","status":"Held back: 3 events in 24 h; this source needs 20","text":"RangeError: avatar upload too large\nSentry\nHeld `
- ✅ proof (fake YouTrack): still one create — `1`
- screenshot: `I4-intake-held-back.png`

## I5 — An unsure match is asked in the Inbox, and Same task links it

- ✅ the Inbox asks "Is this the same as ACME-1?" — `"Is this the same as ACME-1?\nCheckout fails·From custom\nGAR-1 Checkout fails on Safari\njust now\nSame task\nNew task\nNot work"`
- ✅ …shows the candidate and the three answers — `"Is this the same as ACME-1?\nCheckout fails·From custom\nGAR-1 Checkout fails on Safari\njust now\nSame task\nNew task\nNot work"`
- ✅ Same task removes the card
- ✅ Intake: "Linked to ACME-1" — `{"fingerprint":"custom:web-form:form-17","title":"Checkout fails","source":"custom","status":"Linked to ACME-1","text":"Checkout fails\ncustom\nLinked to ACME-1\njust now"}`
- ✅ proof (fake YouTrack): still one create — `1`
- screenshot: `I5-inbox-decision.png`

## I6 — Start opens a mission with the item's criteria and the tracker follows

- ✅ ACME-5 is Ready with Start enabled — `"ACME-5\nTypeError: basket is null\nSentry · 132 events\nSlack · thread\nStart"`
- ✅ Start opens the mission — `"msn_01m688s5dkasw2vremm0"`
- ✅ the mission's Done when is the item's criterion — `"Done when\n0 of 1 verified\nU1\nCheckout no longer throws when the basket is empty\nThe spec will cover this\nNot verified"`
- ✅ the mission was planned, never queued — `{"status":"AWAITING_PLAN_APPROVAL"}`
- ✅ proof (fake YouTrack): ACME-5 is In Progress — `"In Progress"`
- ✅ proof (fake YouTrack): one comment starting <!-- tandemise:activity --> — `["<!-- tandemise:activity -->\n\nStarted in Tandemise by Demostenes Garcia: TypeError: basket is null."]`
- ✅ ACME-5 moved under In progress, with its mission's status in words — `"ACME-5\nTypeError: basket is null\nSentry · 132 events\nSlack · thread\nMission: Awaiting plan approval\nStart"`
- ✅ …and Start is off, with the reason as its title — `{"disabled":true,"title":"Has a mission"}`
- screenshot: `I6-mission.png`
- screenshot: `I6-board-started.png`

## I7 — The mission completes: the item moves to In Review and the comment shows the criteria

- ✅ the mission completes — `"COMPLETE"`
- ✅ proof (fake YouTrack): ACME-5 is In Review (onComplete) — `"In Review"`
- ✅ proof (fake YouTrack): still one activity comment, now "Done in Tandemise — N of N criteria verified." — `"<!-- tandemise:activity -->\n\nStarted in Tandemise by Demostenes Garcia: TypeError: basket is null.\n\nPlan:\n- [x] spec\n- [x] build\n- [x] qa\n- [x] release\n\nDone in Tandemise — 2 of 2 criteria verified.\n\n| Key |`
- ✅ …with the criteria table: the item's own criterion is U1, Verified — `"<!-- tandemise:activity -->\n\nStarted in Tandemise by Demostenes Garcia: TypeError: basket is null.\n\nPlan:\n- [x] spec\n- [x] build\n- [x] qa\n- [x] release\n\nDone in Tandemise — 2 of 2 criteria verified.\n\n| Key |`
- ✅ the Board lists ACME-5 under In review, its mission Complete — `"ACME-5\nTypeError: basket is null\nSentry · 132 events\nSlack · thread\nMission: Complete\nStart"`
- screenshot: `I7-board-in-review.png`

## I8 — The item is done: the loop closes at Sentry and in Slack

- ✅ proof (fake Sentry): issue 501 resolved inCommit, in acme/web — `{"status":"resolved","statusDetails":{"inCommit":{"commit":"cd3dd80711031c8b0aadc3b7aac9310fa6d7afc9","repository":"acme/web"}}}`
- ✅ proof (fake Slack): one thread reply naming ACME-5 — `["Done: TypeError: basket is null · ACME-5"]`
- ✅ Intake: the Sentry signal reads "Closed" — `{"fingerprint":"sentry:acme/web:501","title":"TypeError: basket is null","source":"Sentry · 3 times","status":"Closed","text":"TypeError: basket is null\nSentry · 3 times\nClosed\njust now"}`
- ✅ Intake: the Slack signal reads "Closed" — `{"fingerprint":"slack:acme.slack.com#support:C0SUPPORT:1730000001.000100","title":"TypeError: basket is null","source":"Slack","status":"Closed","text":"TypeError: basket is null\nSlack\nClosed\n3m ago"}`
- ✅ nothing is written twice on later passes — `{"puts":1,"replies":1}`
- screenshot: `I8-intake-closed.png`

## I9 — A custom runner pushes with its own token, and reads its closure back

- ✅ Make a token shows a tdi_ token once, with Copy — `"tdi_ej2x…"`
- ✅ tandemise intake push exits 0 and prints the fingerprint and status — `{"code":0,"stdout":"custom:web-form:form-18: received\n","stderr":""}`
- ✅ the token pushes to its source only: refused in the daemon's words — `{"code":1,"stdout":"","stderr":"This token can only push to 'web-form'.\n"}`
- ✅ the signal appears in the Intake tab, filed — `{"fingerprint":"custom:web-form:form-18","title":"Export to CSV drops accents","source":"custom","status":"Filed as ACME-6","text":"Export to CSV drops accents\ncustom\nFiled as ACME-6\njust now"}`
- ✅ tandemise intake closures lists its closure, pending — `"clo_01m688x4zsay69frmxc7 custom:web-form:form-18 pending\n"`
- ✅ --ack closes it — `{"code":0,"stdout":"clo_01m688x4zsay69frmxc7 custom:web-form:form-18 closed\n","stderr":""}`
- ✅ Intake: "Closed" — `{"fingerprint":"custom:web-form:form-18","title":"Export to CSV drops accents","source":"custom","status":"Closed","text":"Export to CSV drops accents\ncustom\nClosed\njust now"}`
- screenshot: `I9-settings-token.png`
- screenshot: `I9-intake-custom.png`

## I10 — A brain's source runs here only when switched on; a moved tracker gets no token until confirmed

- note: brain clone: /tmp/tdm-intake/home/brains/ws_01m688m1k80pzxtqhy65 (no remote; a commit there and Sync is how a teammate's change arrives)
- ✅ before: the configuration is local, with the tracker at fake YouTrack A — `{"origin":"local","url":"http://127.0.0.1:38619"}`
- ✅ the project is linked to a brain on this machine (local_only) — `{"status":"local_only","clone":"/tmp/tdm-intake/home/brains/ws_01m688m1k80pzxtqhy65"}`
- ✅ after Sync (210d273): origin brain, one source sentry-team, the tracker at A — `{"origin":"brain","sources":["sentry-team"],"tracker":"http://127.0.0.1:38619"}`
- ✅ API: the brain source is off on this computer (enabled false) — `{"sentry-team":false}`
- ✅ Settings → Intake says it is set in the project's brain — `"Intake\nFor Acceptance\nSet in this project's brain.\nTracker\n\nWork is filed in YouTrack ACME, and you start it from the Board.\n\nTracker\nYouTrack\nGitHub Issues\nYouTrack address\nhttps, or http on this computer onl`
- ✅ the window shows "Run sentry-team on this computer" OFF — `"false"`
- ✅ saving its token here leaves it off (API enabled false)
- ✅ OFF: Check sources now → the fake Sentry records no poll — `{"before":5,"after":5}`
- ✅ click ON in the window → API enabled true — `{"sentry-team":true}`
- ✅ ON: the runner reads the source → the fake Sentry records a poll with this computer's token — `{"before":5,"after":7}`
- ✅ click OFF in the window → API enabled false — `{"sentry-team":false}`
- ✅ OFF again: Check sources now (and the ticks since) → no further polls — `{"before":7,"after":7}`
- ✅ after Sync (cc5505f): API originMismatch.tracker names B now and A as saved, with the daemon's sentence — `{"tracker":{"current":"http://127.0.0.1:39029","saved":"http://127.0.0.1:38619","message":"This project's tracker now points at http://127.0.0.1:39029. Confirm the new address in Settings → Intake before Tandemise sends `
- ✅ the Board shows the daemon's sentence, word for word — `{"shown":"This project's tracker now points at http://127.0.0.1:39029. Confirm the new address in Settings → Intake before Tandemise sends your token there.","daemonProblem":"This project's tracker now points at http://1`
- ✅ Check sources now: the Board still answers with the same sentence (no read of B) — `{"afterCheck":"This project's tracker now points at http://127.0.0.1:39029. Confirm the new address in Settings → Intake before Tandemise sends your token there.","checkError":""}`
- ✅ proof (fake YouTrack B): no request carrying the token reached B — `{"tokenCalls":0,"anyCalls":0}`
- ✅ nothing from B is on the Board yet
- ✅ Settings → Intake shows the prompt: the sentence, "Saved for http://127.0.0.1:38619." and Use the new address — `"This project's tracker now points at http://127.0.0.1:39029. Confirm the new address in Settings → Intake before Tandemise sends your token there.\n\nSaved for http://127.0.0.1:38619.\n\nUse the new address"`
- ✅ click Use the new address → the prompt disappears and API originMismatch.tracker is null — `{"tracker":null,"sources":{}}`
- ✅ the Board refreshes against B: ACME-101 Ready, ACME-102 In progress, and every row is B's item — `{"keys":{"ready":["ACME-101"],"inProgress":["ACME-102"],"inReview":[]},"notB":[]}`
- ✅ …with no problem line — `""`
- ✅ proof (fake YouTrack B): B now receives requests carrying the token (the board read) — `{"count":4,"paths":["GET /api/issues","GET /api/issues/ACME-1"]}`
- screenshot: `I10-on-this-computer-off.png`
- screenshot: `I10-on-this-computer-on.png`
- screenshot: `I10-board-tracker-moved.png`
- screenshot: `I10-settings-confirm-new-address.png`
- screenshot: `I10-board-new-address.png`
