# WCAG 2.1 AA: before and after, per screen

axe nodes are the elements axe-core flagged under the WCAG 2.0/2.1 A+AA rules; failing checks count every probe
(axe, structure, names, keyboard, escape, reflow at 320 and 640, text spacing) that found a problem.

| Screen / state | axe nodes before (dark / light) | axe nodes after (dark / light) | failing checks before | failing checks after |
|---|---|---|---|---|
| home | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| board | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| board-intake | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| missions | 6 / 6 | 0 / 0 | 8 of 11 | 0 of 11 |
| missions-backlog | 6 / 6 | 0 / 0 | 8 of 11 | 0 of 11 |
| missions-routines | 6 / 6 | 0 / 0 | 8 of 11 | 0 of 11 |
| routine-dialog | 6 / 6 | 0 / 0 | 8 of 8 | 0 of 8 |
| new-mission | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| new-mission-errors | 0 / 0 | not run | 3 of 11 | not run |
| mission-feed | 12 / 7 | 0 / 0 | 6 of 11 | 0 of 11 |
| mission-plan | 6 / 6 | 0 / 0 | 6 of 11 | 0 of 11 |
| mission-timeline | 6 / 6 | 0 / 0 | 6 of 11 | 0 of 11 |
| mission-artifacts | 6 / 6 | 0 / 0 | 8 of 11 | 0 of 11 |
| mission-checks | 7 / 7 | 0 / 0 | 6 of 11 | 0 of 11 |
| mission-metrics | 6 / 6 | 0 / 0 | 6 of 11 | 0 of 11 |
| task-drawer | 6 / 31 | 0 / 0 | 4 of 8 | 0 of 8 |
| mission-cancel-confirm | 12 / 11 | 0 / 0 | 2 of 8 | 0 of 8 |
| mission-limit | 7 / 7 | 0 / 0 | 8 of 11 | 0 of 11 |
| mission-limit-metrics | 7 / 7 | 0 / 0 | 8 of 11 | 0 of 11 |
| mission-get-ready | 6 / 6 | 0 / 0 | 6 of 11 | 0 of 11 |
| mission-stalled | 11 / 10 | 0 / 0 | 6 of 11 | 0 of 11 |
| inbox | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| inbox-stalled | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| artifacts | 0 / 0 | 0 / 0 | 8 of 11 | 0 of 11 |
| artifact-reader | 0 / 0 | 0 / 0 | 4 of 8 | 0 of 11 |
| repositories | 1 / 1 | 0 / 0 | 8 of 11 | 0 of 11 |
| team | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| team-staffing | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| team-roles | 0 / 1 | 0 / 0 | 7 of 11 | 0 of 11 |
| skills | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| evals | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| evals-runs | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| evals-yours | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| runtimes | 1 / 1 | 0 / 0 | 7 of 11 | 0 of 11 |
| integrations | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| brain | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| brain-lessons | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| brain-proposals | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| brain-factory | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| settings | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| settings-intake | 0 / 0 | 0 / 0 | 3 of 11 | 0 of 11 |
| command-palette | 0 / 0 | 0 / 0 | 4 of 8 | 0 of 8 |
| live-regions | 0 / 0 | 0 / 0 | 0 of 1 | 0 of 1 |
| command-palette-filtered | not run | 0 / 0 | not run | 0 of 8 |
| first-run | not run | 0 / 0 | not run | 0 of 11 |
| daemon-down | not run | 0 / 0 | not run | 0 of 11 |
| **all** | **255** | **0** | **202 of 448** | **0 of 470** |

The "before" run attached to an already-seeded window, so it did not open the first-run and daemon-down windows
(they were audited by hand: neither had a main landmark).
