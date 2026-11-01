# Refine a tracker Draft from the Board

Date: 2026-11-01 · Issue: #135 · Builds on: intake spec (2026-10-30-intake-design.md §6–§7), P6 refine

## Problem

The Board offers Start only on items in a mapped ready state. A team that keeps
most of its backlog as **Draft** in its tracker has no way from Tandemise to get
a Draft refined, made ready and started. Today a person refines it elsewhere and
edits the tracker by hand, or creates a mission by hand and loses the link to
the item (no state write-back, no activity comment).

Tandemise already refines a mission (P6): a product agent proposes Done-when
lines and asks questions, and the person decides each one. This spec offers
that flow for a tracker Draft and writes the result back to the item.

## The mapping: an optional draft state

`tracker.states.draft` is a new, optional list of the tracker's own states
(`[Draft]` in YouTrack, a label such as `draft` on GitHub Issues). It is checked
against the tracker's real states like every other mapped state. Without it
there is no Draft group and nothing in this spec happens: existing projects
see no change. Settings → Intake has a **Draft** field next to Ready.

## The flow

1. **Board, Draft group.** Items in a draft state are listed in a **Draft**
   group before Ready. A draft item's Start is refused ("Refine it first.");
   its action is **Refine**.
2. **Refine (a click).** `POST /v1/workspaces/:id/board/refine {key}`:
   - reads the item fresh and refuses it unless it is still in a draft state;
   - makes a DRAFT mission through `MissionService.create`, linked to the item
     (`trackerItemId`), with the item's goal and any Done-when lines it already
     has. The mission is not planned and not queued;
   - begins P6 refinement on it: the product agent proposes Done-when lines and
     asks questions;
   - opens the mission, where the person accepts, rewords or rejects each
     proposal and answers each question, as for any draft.
   **No tracker write happens here.** A second Refine on the same item opens
   the same mission.
3. **The Board card while refining** shows the refinement's readiness in the
   daemon's own words (for example "Answer 1 question and decide 3 criteria on its
   mission, then write it to YouTrack.")
   and a **Write to YouTrack and mark ready** button (**Write to GitHub…** on
   GitHub). The button is disabled, with its reason beside it, until the P6
   readiness gate says the mission is ready (at least one accepted Done-when
   line, nothing left open).
4. **Write to the tracker (a click).** `POST /v1/workspaces/:id/board/ready {key}`
   is the only route that writes, and it writes only when the person clicks it.
   It reads the item fresh and refuses if it is no longer a draft, if the
   refinement is not ready, or if no refinement mission exists. Then it writes,
   in order:
   1. the **description**: the item's own text, with a `## Done when` checklist
      of the accepted lines (replacing any Done-when section already there) and
      a `## Decisions` section listing each answered question with its answer
      (replacing one already there). Anything else the person wrote is kept
      as it was;
   2. the **state**: the first mapped ready state;
   3. the **activity comment** (`tandemise:activity`, the one Tandemise
      comment per item), saying who refined it and what was written:
      `Refined in Tandemise by Ana: 3 Done-when lines, 1 answered question. Moved from Draft to Open.`
   Each write is safe to repeat, so a click after a failed write can simply be
   made again. The mission gets a note naming the item and what was written.
5. **Start is offered.** The item is now ready and its mission is a refined
   draft. Start adopts that mission instead of making a second one: it plans it
   (the readiness gate passes), moves the item to in progress, assigns it, and
   rewrites the activity comment as for any Start. The comment keeps its
   "Refined in Tandemise by …" line on top, so the item's history reads in
   order.

## Tracker writes, and when

| When | YouTrack | GitHub Issues |
|---|---|---|
| Refine clicked | nothing | nothing |
| While the person decides | nothing | nothing |
| Write … and mark ready clicked | `POST /api/issues/<id>` with the description; command `State <first ready>`; the activity comment, posted or edited | `gh issue edit --body`; the ready state (`open`, which drops the draft label, or the ready label); the activity comment, posted or edited |
| Start clicked | as Start today: in progress, assignee, activity comment | same |

A mission is *unstarted* while it is still a draft and its item has no state
Tandemise wrote. Only Refine makes one (a Start always writes the in-progress
state, unless that write failed, and then Start is simply offered again). The
write-back pass and the Start retry never write for an unstarted mission, so the
refinement mission, which exists before the item is ready, never moves the item
or comments on it by itself. Start's activity comment lands at once, even when
the refined comment was written less than a minute before.

## Permissions

- Every route takes a seat in the project, as Start does.
- Tandemise writes to the tracker only on the **Write … and mark ready** click,
  which is the person's explicit decision in the app. Refine, accepting a
  criterion or answering a question write nothing to the tracker.
- The writes use the project's tracker credential, as Start does (YouTrack: the
  saved permanent token; GitHub: the `gh` sign-in). Nothing new is stored.
- A mission in autonomous autonomy may accept proposals on its own (P6 ruling 9),
  but it can never press the write: that stays a person's click.

## Accessibility (WCAG 2.1 AA)

- The Draft group is a labelled region with its own heading, like the others.
- Refine and Write are real buttons from `@tandemise/design` with visible text
  and the item key in their accessible name. A disabled button's reason is shown
  as text beside it, never only in a tooltip, since a disabled button takes no
  focus.
- The readiness line and a refusal are announced politely (`aria-live`).
- No new colour: status uses the existing tokens and the status dot, with text.

## Out of scope

- Linking a mission created by hand to a tracker item (the issue's second
  option).
- Refining an item that is already ready.
- A lane choice for an adopted mission: Start on a refined draft lets the
  factory decide.

## Acceptance

Offline (`intake-tracker-check`, `intake-daemon-check`, fake YouTrack and fake
`gh`): the adapters update a description; the draft mapping is validated; Refine
writes nothing; Write refuses before ready and writes description, state and
comment after; Start adopts the refined mission; GitHub drops the draft label.

Real app (intake acceptance I15): a Draft item in the fake YouTrack is shown in
the Draft group, refined with the scripted product agent, decided on the mission
page, written back from the Board (description, state, activity comment checked
in the fake), then started.
