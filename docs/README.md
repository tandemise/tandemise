# Tandemise documentation

A map of the docs. The [README](../README.md) says what Tandemise is, how to
install it, and what a normal day looks like.

## Start here

| Document | What it covers |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Run it (installer or source), the first task, intake, the brain, hold, the relay, where files live |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | What is not done, or works in a way you should know before relying on it |

## The software factory

| Document | What it covers |
|---|---|
| [FACTORY.md](FACTORY.md) | Lanes, steps, model routing and merge by risk: `planner.yaml`, `routing.yaml`, `merge.yaml` |
| [intake/README.md](intake/README.md) | Writing an intake runner: the `tandemise.intake/v1` contract, tokens, the `tandemise` CLI, closures |
| [intake/signal.v1.schema.json](intake/signal.v1.schema.json) | The JSON Schema of an intake signal |
| [../apps/relay/README.md](../apps/relay/README.md) | Running the optional team relay: Docker Compose, invites, TLS, backup and upgrade |
| [WORKFLOWS.md](WORKFLOWS.md) | Workflow files (`.tandemise/workflows/*.yaml`) and every gate and factory fact |
| [examples/build-feature.yaml](examples/build-feature.yaml) | A complete workflow file |
| [INTEGRATIONS.md](INTEGRATIONS.md) | Connecting MCP servers, CLIs and apps as brokered tools |

## Guides

One per feature, each answering "how do I…":

| Guide | How do I… |
|---|---|
| [Done when](guides/done-when.md) | say what finished means and see each criterion verified |
| [Refine a rough request](guides/refine.md) | turn a one-liner into something ready to plan |
| [Backlog and work in progress](guides/backlog.md) | rank requests and limit how many run at once |
| [Limits](guides/limits.md) | cap agent minutes, tokens or dollars per mission and per month |
| [The Inbox](guides/inbox.md) | find stalled missions and quiet agents, and unstick them |
| [Plan the rest again](guides/replan.md) | change course partway through without losing what is done |
| [The desk and the status report](guides/desk-and-status-report.md) | read Home at a glance and write a report from facts |
| [Routines](guides/routines.md) | put standing work on a schedule |
| [Choosing models](guides/models.md) | pick a model per role and step, retry on a stronger one, drop to a cheaper one near a limit |
| [Notifications](guides/notifications.md) | hear about new Inbox items while the window is in the background |
| [About and diagnostics](guides/about-and-diagnostics.md) | see which app and daemon build is running, and copy diagnostics |
| [Giving your agents your skills](guides/skills.md) | import the skills I already use and pin them to roles and steps |
| [Score a change before it goes live](guides/evals.md) | save a finished step as a case and try a different model, skill or setup against it |
| [GitHub issues in and out](guides/github-issues.md) | turn labelled issues into missions and report back on them |
| [Hand work in and back](guides/outside-contributions.md) | start from a file or link, and take a step to another tool and back |
| [Your setup as code](guides/setup-as-code.md) | keep roles, workflows, routines, limits, skill pins and issue settings in the repository |

## Design system

| Document | What it covers |
|---|---|
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Palette, roles, contrast, components, the rules `check:design` enforces, WCAG 2.1 AA as the minimum |
| [../packages/design/README.md](../packages/design/README.md) | Using `@tandemise/design`: tokens, Tailwind theme, React components |
| [Storybook](https://tandemise.github.io/tandemise/) | Every component and its states, in light and dark |

## Architecture and engineering

| Document | What it covers |
|---|---|
| [BUILD_BRIEF.md](BUILD_BRIEF.md) | The engineering contract: dependency direction, ports and adapters, type safety, secrets |
| [APPLICATION_DESIGN.md](APPLICATION_DESIGN.md) | The mission engine: artifact hand-off, scheduling, gates, recovery |
| [adr/](adr/) | Architecture decisions: [0001](adr/0001-tandemise-owns-organizational-state.md) organizational state, [0002](adr/0002-capability-routing-over-vendor-identity.md) capability routing, [0003](adr/0003-artifacts-over-chat.md) artifacts over chat, [0004](adr/0004-gates-are-measured-facts.md) gates as measured facts, [0005](adr/0005-daemon-separate-from-desktop.md) a separate daemon |
| [../MVP.md](../MVP.md) | The original MVP product and architecture specification |
| [ACCEPTANCE.md](ACCEPTANCE.md) | The MVP acceptance criteria and the scripts that prove them |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, `npm run ci` and each check, real-app acceptance suites, releases, packaging and signing |
| [../AGENTS.md](../AGENTS.md) | The short list of rules for AI agents working in the repository |

## Specs, plans and evidence

Each feature is designed, then planned, then proven in the real app:

- [superpowers/specs/](superpowers/specs/): designs. The software-factory pivot
  starts at [2026-10-30-tandemise-pivot-notes.md](superpowers/specs/2026-10-30-tandemise-pivot-notes.md),
  followed by
  [hold and interact](superpowers/specs/2026-10-30-hold-and-interact-design.md),
  [the brain](superpowers/specs/2026-10-30-brain-design.md),
  [intake](superpowers/specs/2026-10-30-intake-design.md),
  [the planner and merge](superpowers/specs/2026-10-30-planner-and-merge-design.md) and
  [the relay](superpowers/specs/2026-10-30-relay-design.md).
- [superpowers/plans/](superpowers/plans/): the implementation plan for each spec.
- [superpowers/evidence/](superpowers/evidence/): acceptance reports and
  screenshots from the real app. The pivot end to end is
  [2026-10-31-integrated/REPORT.md](superpowers/evidence/2026-10-31-integrated/REPORT.md).
- [accessibility/](accessibility/): the WCAG 2.1 AA audit of the desktop app
  ([AUDIT-2026-10-31.md](accessibility/AUDIT-2026-10-31.md)), with its evidence in
  [2026-10-31-wcag/](superpowers/evidence/2026-10-31-wcag/).
