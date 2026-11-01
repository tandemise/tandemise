# Brain (#51) acceptance report

Run: 2026-10-31T02:14:06.953Z · build e83915c · two fresh installs at /tmp/tdm-brain and /tmp/tdm-brain2
Result: **ALL PASS** (9/9 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| B1 — Create a brain from Project settings | PASS | 7/7 |
| B2 — A second home uses the existing brain and gets the same factory | PASS | 4/4 |
| B3 — An edit pushed to the brain reaches the app on Sync, with no prompt to choose | PASS | 2/2 |
| B4 — A hold that changed a file teaches a lesson, shown on the feed and in Lessons | PASS | 5/5 |
| B5 — The next run on the step loads the lesson, and the task shows what it knew | PASS | 5/5 |
| B6 — A lesson that keeps helping is proposed as a rule, as a PR | PASS | 4/4 |
| B7 — Two homes write lessons, sync, and see the same memory | PASS | 2/2 |
| B8 — Offline, work goes on from your copy of the brain | PASS | 4/4 |
| B9 — A secret typed into Remember this never reaches the brain | PASS | 4/4 |

## B1 — Create a brain from Project settings

- note: home 1 Developer model set to brain-model through the API, so B2 has something to carry
- PASS the Brain section offers the three ways in — `"Brain\nNot linked\n\nA brain is one git repository that holds what this project has learned and how its factory works: roles, workflows, rules and lessons. A teammate who links the same brain gets the same factory. Shar`
- PASS the window says Up to date — `"Brain\ngithub.com/acme/brain\n\nUp to date (last synced 21:08).\n\n1 rules file · 0 lessons\n\nSync now\nOpen the brain\nUnlink"`
- PASS and names the remote
- PASS the fake gh created a private repository
- PASS the bare repo has brain.yaml, factory/roles/development.md and memory/rules/project.md — `[".gitattributes","README.md","brain.yaml","factory/roles/architecture.md","factory/roles/design.md","factory/roles/development.md","factory/roles/finance.md","factory/roles/product.md","factory/roles/qa.md","factory/rol`
- PASS the Developer in the brain says brain-model
- PASS proof (API): linked, up to date — `"Up to date (last synced 21:08)."`
- screenshot: `B1-unlinked.png`
- screenshot: `B1-linked.png`

## B2 — A second home uses the existing brain and gets the same factory

- PASS the preview lists the items, item by item — `["Developer: Change","Project settings: Same","Work-in-progress limit: Same","Monthly limits: Same","Default mission limits: Same","Architect: Same","Product Designer: Same","Finance Analyst: Same","Product Manager: Same`
- PASS the Developer is a Change (brain-model is new here) — `["Developer: Change"]`
- PASS home 2 is linked to the same remote — `"Brain\ngithub.com/acme/brain\n\nUp to date (last synced 21:08).\n\n0 rules files · 0 lessons\n\nSync now\nOpen the brain\nUnlink"`
- PASS Team → Roles → Developer shows home 1's model (brain-model) — `"brain-model"`
- screenshot: `B2-preview.png`
- screenshot: `B2-linked.png`
- screenshot: `B2-team-roles.png`

## B3 — An edit pushed to the brain reaches the app on Sync, with no prompt to choose

- note: pushed by hand: factory/roles/development.md model brain-model → edited-model
- PASS no preview dialog is shown
- PASS Team → Roles → Developer shows edited-model — `"edited-model"`
- screenshot: `B3-synced.png`
- screenshot: `B3-team-roles.png`

## B4 — A hold that changed a file teaches a lesson, shown on the feed and in Lessons

- note: substitution: #50 is not merged, so the hold record is published through POST /v1/test/events (task.hold_ended, ending continued, 1 file changed)
- note: real Claude Code was not run for B4: the hold itself (#50) is what drives a real session, and it is not on this branch
- PASS the mission ran — `"COMPLETE"`
- PASS proof (API): an active lesson, from your hold — `{"id":"acceptance-69237f:01m67vh5wn8yr8txg3jt","kind":"lesson","text":"Keep the header sticky on mobile.","scope":{"role":"development"},"state":"active","helpful":0,"harmful":0,"net":0,"addedAt":"2026-10-31T02:10:01.749`
- PASS the mission timeline shows "Learned: … (from your hold)" — `"Learned: 'Keep the header sticky on mobile.' (from your hold)\n09:10:02 PM\n·\nTandemise"`
- PASS Brain → Lessons lists it as active — `[{"text":"Keep the header sticky on mobile.","counters":"+0 / −0","state":"active"}]`
- PASS with its source "your hold"
- screenshot: `B4-timeline-learned.png`
- screenshot: `B4-lessons.png`

## B5 — The next run on the step loads the lesson, and the task shows what it knew

- PASS the mission ran — `"COMPLETE"`
- PASS "What it knew" lists the lesson — `"What it knew\n\nLoaded 1 rules file and 1 lesson. Brain commit 264ccdb.\n\nmemory/rules/project.md\n\nKeep the header sticky on mobile.\nDeveloper\nFrom your hold · B4 hello page mvvrjxlp\n+0 / −0\nLoaded in 1 run, 1 pa`
- PASS and memory/rules/project.md
- PASS in plain words — `"What it knew\n\nLoaded 1 rules file and 1 lesson. Brain commit 264ccdb.\n\nmemory/rules/project.md\n\nKeep the header sticky o"`
- PASS proof (API): runs.brain.loaded has the lesson id — `["acceptance-69237f:01m67vh5wn8yr8txg3jt"]`
- screenshot: `B5-what-it-knew.png`

## B6 — A lesson that keeps helping is proposed as a rule, as a PR

- note: two thumbs-up on the lesson from the B5 mission's task
- note: one thumbs-up from a second mission's task
- PASS the fake gh saw pr create with the lesson in the body — `"## What changes and why\n\nA lesson keeps proving useful, so this turns it into a rule in `memory/rules/role-development.md`.\n\n## Lessons\n\n- Keep the header sticky on mobile. (helpful 6, harmful 0; from B4 hello pag`
- PASS and "Not evaluated" (no promotion suite)
- PASS from a tandemise/promote/ branch — `["pr","create","--head","tandemise/promote/124acee3c2","--base","main","--title","Promote: Keep the header sticky on mobile.","--body-file","-"]`
- PASS Brain → Proposals shows the promotion with its PR — `"Keep the header sticky on mobile.\nPull request open\nSmall: Only adds lines to rules or role instructions.\nNot evaluated: this project has no promotion evals yet.\nmemory/rules/role-development.md\nOpen the pull reque`
- screenshot: `B6-thumbs-up.png`
- screenshot: `B6-proposals.png`

## B7 — Two homes write lessons, sync, and see the same memory

- PASS both lists have both lessons — `[3,3]`
- PASS both Lessons lists show the same texts and counters — `{"a":[{"text":"Home two: write the changelog line with the change.","counters":"+0 / −0","state":"active"},{"text":"Home one: name branches after the issue.","counters":"+0 / −0","state":"active"},{"text":"Keep the heade`
- screenshot: `B7-home1-lessons.png`
- screenshot: `B7-home2-lessons.png`

## B8 — Offline, work goes on from your copy of the brain

- note: renamed the bare repository behind github.com/acme/brain
- PASS Brain → Sync says it is working from your copy — `"Working from your copy of the brain (last synced 21:12). Couldn't reach github.com."`
- PASS the task still runs to the end — `["COMPLETE","SUCCEEDED"]`
- PASS and the Sync tab still says so — `"Working from your copy of the brain (last synced 21:13). Couldn't reach github.com."`
- PASS back online, it is up to date again — `"Up to date (last synced 21:13)."`
- screenshot: `B8-offline.png`

## B9 — A secret typed into Remember this never reaches the brain

- PASS the row shows [redacted secret] — `"Deploy with [redacted secret] on Fridays."`
- PASS the window never shows the token
- PASS the bare repository has the lesson
- PASS and never the token: no ghp_ anywhere in git log -p --all
- screenshot: `B9-redacted.png`
