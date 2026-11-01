# Tandemise pivot: notes

> Draft opened on 2026-10-30. The owner's notes, translated from Spanish.

## The idea in one sentence

Tandemise lets teams, individuals and whole organisations get work done faster
and more efficiently.

That work isn't only code, but the first target use is a software factory.

## Why now: what doesn't work about Tandemise today

Not even the owner uses it. They keep going back to Claude Code directly, mostly
because it's faster and simpler. The goal is to have everything in Tandemise.

Say we create a new project, Acme, and add all its repositories:
- /acme/acme
- /acme/claude
- /acme/ops

Then we connect the MCPs and services we use:
- GitHub
- 1Password
- Docker
- YouTrack
- Buzz / Slack / Discord
- Figma
- Claude Design
- Open Design
- Supabase
- anything else that's possible

From there, the system works out on its own the flows it can use.

## A normal day with the new Tandemise

1. Open Tandemise.
2. Look at the board for what can be worked on. If there's nothing, ask it to
   sync with YouTrack, Sentry, PostHog, GitHub, or whatever is connected, to find
   something to do.
3. Pick a task and start it.
4. Fully autonomously, the system takes the task from idea to a PR. Then it
   decides what comes next: merge it completely, or ask someone to review it at
   that point.

It also matters to see who is working on other things, what has been done
before, and whether anything needs my attention. The board is always connected
across every line.

The board is the single source of truth. It lives somewhere we can all consume
and access, but through Tandemise. That may need a Tandemise server or relay
that everyone connects to and pulls everything from.

Processes can always be tweaked, but the system should be as smart as possible
at deciding:
- the steps that are required
- the skills each step requires
- the models to use in each step
- which steps need human validation or approval

Among many other things.

## What to take from the references
- **Paperclip:**
- **super-board:**
- **Warp, the "software factory":**

## What it must NOT be
- A messaging system, or anything like one. This is so that even a product
  manager can build features.

## UI: migrating to mola-ui
- Ignore this for now.

## Open questions

## Decisions from the conversation (2026-10-30)

Gathered during the brainstorming session. Not an approved design yet.

**Why it isn't used today.**
- The process is rigid.
- You can't tell what it's doing.
- It doesn't learn from corrections.
- You can't iterate the way you can in Claude Code.

**Distribution.**
- Open source.
- Each team self-hosts its own instance. It is not multi-tenant SaaS.

**Execution.**
- Everything runs on each person's machine, with their own subscriptions and environment.
- The server is optional and very thin. It only stores "dumb" data:
  - who is working on what
  - access
  - a mailbox for webhooks
- Without a server, the same data lives in a local DB with the same shape, so it can be moved later.

**Brain.**
- It lives in its own git repo, one per project. A project can span several repos.
- It holds memory: lessons, conventions, decisions, history.
- It also holds the factory definition: steps, skills, models, gates and MCPs.
- Improvements the factory proposes to itself arrive as PRs to that repo.
- Personal data and secrets stay out.

**Board.**
- There is one board per project: the primary tracker, for example YouTrack.
- Other sources (GitHub, Sentry, PostHog, Slack, Discord, WhatsApp…) come in through an agnostic contract and runners. Tandemise ships some runners; anything else, people connect themselves.
- Tandemise creates or links the task in the primary tracker without duplicating it.
- When the task is done, it closes the loop at the source.

**Starting work.**
- Everything that comes in is recorded, but nothing starts until someone starts it.
- No methodology is imposed: scrum, XP, kanban or none.

**Iterating.**
- "Hold and interact" at any point in the process, using the real Claude Code terminal inside Tandemise.
- When you tell it to continue, the autonomous flow resumes.
- What you correct during the hold feeds the brain.

**Where it can stand out.** Research across about 30 systems found nobody doing these well:
- inferring steps, models and gates
- deciding merges by risk
- a single brain for people and agents
- intake from several sources
- a board a PM can use

**Proposed order (to be confirmed).**
1. Engine with live sessions
2. Brain repo
3. Intake and primary tracker
4. Smart planner and risk-based merge
5. Optional server
6. mola-ui (parked)
