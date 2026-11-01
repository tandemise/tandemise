# What Start offers on the Board (#136)

The Board offered Start on items that cannot produce a correct pull request in
this project's repository: a container whose work lives in its subtasks, a
research Spike, and a bug tagged for another repository. This keeps those
items on the Board, says why, and turns Start off for them.

## Rules

`startRefusal(item, config)` in `@tandemise/domain` (`entities/tracker.ts`)
returns the sentence, or null when the item may start. It is checked after the
existing refusals (has a mission, already in progress), in this order:

1. **Another repository.** The tracker config's optional `repoTag` (`repo:web`)
   names this repository. An item carrying another tag with the same prefix, up
   to and including the first `:` (`repo:api`), and not `repo:web`:
   "Belongs to another repository (repo:api)." An item with no such tag may
   start.
2. **A type the project does not build.** The optional `buildTypes`
   (`[Bug, Task]`): a Spike is "Spike: this project starts Bug and Task items."
   No `buildTypes`, or an item with no type: every type may start.
3. **A container.** An item with open subtasks: "Has 4 subtasks. Start one of
   them." ("Has 1 subtask. Start it instead." for one.) Its subtasks are on the
   Board and start as usual.

Tags and types match without regard to case. `POST …/board/start` (and
`tandemise start`) reads the item fresh and refuses the same cases with the
same sentence, as a 409.

## Where the data comes from

- `TrackerItem` gains optional `subtasks` (open subtasks) and `tags`.
- YouTrack asks for `tags(name)` and `subtasks(issues(idReadable,resolved))`
  on every issue read.
- GitHub Issues: `tags` are the labels that are not mapped states. Sub-issues
  and issue types are not read: only recent `gh` versions know
  `subIssuesSummary` and `issueType`, and an older one refuses the whole read.
  On GitHub a container is not told apart and `buildTypes` has no type to
  compare.
- The board cache keeps both (migration 027, two nullable columns on
  `tracker_items`); null means the tracker did not say.

## Surfaces

- `BoardItemView.type` (optional for older daemons): the card shows the
  tracker's type as a chip. A refused item shows its reason beside a disabled
  Start, as "Already in progress" does.
- Settings → Intake, under "What Start offers": Types to build and Repository
  tag. A brain sets them in `factory/tracker.yaml` as `buildTypes` and
  `repoTag`.

## Proof

- Offline: `intake-tracker-check` (the pure rules; the YouTrack adapter against
  the fake reporting tags and open subtasks; GitHub state labels are not tags)
  and `intake-daemon-check` (the board marks the three cases, Start refuses
  them with 409, a subtask added after the refresh is seen on Start, a plain
  Task starts).
- Real window: intake acceptance I13, evidence in
  `docs/superpowers/evidence/2026-11-01-board-start-eligibility/`.
