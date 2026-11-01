# The pivot, end to end on main: acceptance report

Run: 2026-11-01T01:29:46.030Z · build 6bccecd · fresh install at /tmp/tdm-integrated-run-mvx5hxlo · fake YouTrack and GitHub, fake runtime
Result: **PASS** (36/36 checks)

## N1 — The owner's normal day: intake → Board → quick lane → hold → pull request → tracker → claims: PASS

- note: setup: the Coding agent (development) runs on a fake runtime that resumes and opens an interactive session on a PTY
- note: mission msn_01m6abh94rff4b005g6s
- note: timing: docs-only quick lane, Start → pull request asking for review: 5023 ms
- ✅ brain: the project is linked to a brain on this machine — `{"linked":true,"status":"local_only"}`
- ✅ brain: the project's intake still reads its tracker and web-form source — `{"origin":"brain","sources":["web-form"]}`
- ✅ Settings → Intake: Make a token shows a tdi_ token — `"tdi_F9tL…"`
- ✅ Settings → Intake, with a brain: Save token saves this computer's YouTrack token — `{"button":"clicked","saves":[1,2]}`
- ✅ a shell pushes the signal (tandemise intake push exits 0) — `{"code":0,"stdout":"custom:web-form:form-7: received\n","stderr":""}`
- ✅ Intake tab: the signal is filed in the tracker — `{"fingerprint":"custom:web-form:form-7","title":"Typo in the settings title","source":"custom","status":"Filed as ACME-2","text":"Typo in the settings title\ncustom\nFiled as ACME-2\njust now"}`
- ✅ fake YouTrack: ACME-2 exists, a Bug, Open — `{"summary":"Typo in the settings title","type":"Bug","state":"Open"}`
- ✅ Board: ACME-2 is under Ready with Start — `"ACME-2\nTypo in the settings title\ncustom · web-form\nStart"`
- ✅ Start: the factory decides the workflow (auto) — `"auto"`
- ✅ Start with no Done-when line plans at once (no draft, no refinement) — `"EXECUTING"`
- ✅ …and asks for no plan approval — `[]`
- ✅ Plan → Why these steps: "Quick lane: one step, then a pull request." — `"Fix\ntiny\nlow risk\nMake it careful\n\nFix · tiny · low risk\n\nQuick lane: one step, then a pull request. The project's lane rules matched it.\n\nNo plan approval.\nNo separate review or QA: the tests carry it, and th`
- ✅ …profiled from the tracker as a fix — `["Fix","tiny","low risk"]`
- ✅ fake YouTrack: ACME-2 is In Progress — `"In Progress"`
- ✅ the implement step runs on the Coding agent's fake runtime — `"Day fake"`
- ✅ Hold opens the terminal panel, "Held by You" — `"Implement the changeHeld by YouContinueReleaseScreen reader modeClose terminalClaude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task.F"`
- ✅ what you type reaches the session (it writes notes.txt) — `"Fake session sess-day-run_01m6abh98s812qvfzs8e\nwrite notes.txt\n> write notes.txt\nwrote notes.txt\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (disk): notes.txt is in the step's worktree — `"/tmp/tdm-integrated/home/workspaces/ws_01m6abh0470srs7ezgp9/missions/msn_01m6abh94rff4b005g6s/worktrees/typo-in-the-settings-title-implement-4jpw0smj"`
- ✅ Continue: the step finishes on a resumed pass, no attempt spent — `{"status":"SUCCEEDED","reason":null,"attempts":[1,1]}`
- ✅ proof (DB): the hold ended as continued — `{"ending":"continued","diffStat":"{\"files\":2,\"insertions\":2,\"deletions\":0}"}`
- ✅ ship: one pull request opened on acme/web — `{"repo":"acme/web","number":1,"url":"https://github.com/acme/web/pull/1"}`
- ✅ ship: waiting for your review, "Auto-merge is off for this project." — `{"headline":"Waiting for your review","decision":{"id":"mrg_01m6abhgpq9yzhg9myjd","verdict":"ask","headSha":"1b55e69d082ec2975b29ab19bc905117a9ac8af6","scoreLine":"Risk score 4 of 2 allowed","reasons":["Auto-merge is off`
- ✅ fake gh: one `pr create`, and no `pr merge` — `["pr create --repo acme/web --head tandemise/typo-in-the-settings-title/typo-in-the-settings-title-implement-4jpw0smj --base main --title fix: typo in the settings title --body-file -"]`
- ✅ the pull request's branch carries the agent's change and the file made in the hold — `{"title":"fix: typo in the settings title","head":"tandemise/typo-in-the-settings-title/typo-in-the-settings-title-implement-4jpw0smj","files":[".gitignore",".tandemise/workflows/build-only.yaml",".tandemise/workflows/p0`
- ✅ Inbox: "Review and merge" — `["Review and merge fix: typo in the settings title"]`
- ✅ the ship card says "Waiting for your review" with Open in GitHub — `"Waiting for your review\n\nWaiting for your review: Auto-merge is off for this project.\n\nacme/web #1\nOpen in GitHub\nMerge\nAuto-merge is off for this project.\nThis repository has no CI checks, so Tandemise never me`
- ✅ fake YouTrack: ACME-2 moved to In Review while the pull request waits for you — `"In Review"`
- ✅ fake YouTrack: one activity comment, linking the pull request — `[{"id":"4-1","text":"<!-- tandemise:activity -->\n\nStarted in Tandemise by Demostenes Garcia: Typo in the settings title.\n\nPlan:\n- [x] Implement the change\n- [ ] Ship — waiting for a person\n\nPull request: https://`
- ✅ Board: ACME-2 shows its mission — `"ACME-2\nTypo in the settings title\ncustom · web-form\nMission: Executing\nHas a mission\nStart"`
- ✅ Home → Who's working on what: ACME-2 (Typo in the settings title), yours — `"Who's working on what\nYou\nGAR-2\nTypo in the settings title\nsince 20:28"`
- ✅ the code change above ran the test suite exactly once (the gate's run; nothing ran it twice) — `1`
- ✅ docs: the factory picks the quick lane (one step, then the pull request) — `["implement","ship"]`
- ✅ docs: Start → pull request without a person stepping in — `{"prs":1,"attempts":1}`
- ✅ docs: the test suite did not run for a docs-only change — `{"before":1,"after":1}`
- ✅ docs: the tests fact says why it was not run — `"Not run: this change touches only the docs area (1 file), which planner.yaml says needs no such check. CI runs the full suite on the pull request."`
- ✅ docs: Start → pull request in 5 s, under the 60 s budget for the fake runtime — `5023`
- screenshot: `N1-settings-tokens.png`
- screenshot: `N1-intake-filed.png`
- screenshot: `N1-board-ready.png`
- screenshot: `N1-why-these-steps.png`
- screenshot: `N1-held-terminal.png`
- screenshot: `N1-ship-card.png`
- screenshot: `N1-board-after.png`
- screenshot: `N1-home-who.png`

## On main before the fixes (de9631b)

The same scenario, run on main as merged, failed at each integration seam in turn. Each was fixed with a failing check first:

1. **Brain link dropped the project's intake.** After `POST /brain {mode:'local'}`, intake read the brain (`origin: brain`) but the brain's first commit had no `factory/tracker.yaml` or `factory/intake.yaml`: the tracker went to null and the sources to `[]`, so the Board was empty. Fixed in `fix: a new brain keeps the project's tracker and intake sources` (red/green in `scratch/brain-daemon-check.mjs`).
2. **No push token in a project with a brain.** Settings → Intake's "Make a token" sat inside the read-only fieldset a brain puts on the form, so a click did nothing (no request reached the daemon). Fixed in `fix: make a push token for a custom source in a project with a brain`.
3. **Start from the Board skipped the factory.** With no type mapping, Start used `feature-delivery` and opened the item (no Done-when line) as a `DRAFT`: no quick lane, no "Why these steps". Observed: `Start: the factory decides the workflow (auto) → feature-delivery`, `plans at once → DRAFT`. Fixed in `fix: start from the board lets the factory decide and plans at once` (red/green in `scratch/intake-check.mjs`).
4. **The tracker never reached In Review for the ship step's pull request.** The write-back read pull requests only from handoff links; the ship step records `ship.pr_opened` events. Fixed in `fix: the tracker moves to in review when the ship step's pull request waits` (red/green and revert-check in `scratch/intake-check.mjs`).
5. **No tracker token in a project with a brain.** Settings → Intake's YouTrack **Save token** sat in the same read-only fieldset, so a teammate who adopts a brain could not save their own token (observed `{"button":"disabled","saves":[1,1]}`). Fixed in `fix: save this computer's tracker token in a project with a brain`; the scenario saves it right after the brain link.
6. **Closing replies at the sources did not name the ship step's pull request** (off this scenario's path). Fixed in `fix: closing comments at the sources name the ship step's pull request` (red/green in `scratch/intake-runners-check.mjs`).
