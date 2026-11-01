# Design System

The contract for how the Tandemise desktop app looks and behaves. If the code
disagrees with this document, one of them is wrong. `npm run check:design`
enforces the parts a machine can check, and CI runs it on every pull request.

The tokens, the theme, the logo and the icon set live in their own package,
[`@tandemise/design`](../packages/design/README.md) (`packages/design`), so the
website and any other Tandemise surface can share them. The desktop app is its
first consumer.

The [Storybook](https://tandemise.github.io/tandemise/), published from
`main`, shows every component and its states in light and dark.

## Principles

- **WCAG 2.1 AA is the minimum.** Text contrast of 4.5:1 (3:1 for focus rings
  and other non-text UI), keyboard reachability, visible focus, names for every
  control, and hints a keyboard user can reach. `check:design` holds the token
  contrast pairs; `storybook:a11y` runs axe (its default rules, which include
  WCAG 2.0 and 2.1 A and AA) on every story in both themes and fails on any
  violation, with no known exceptions listed today.

- **Colour is a role, never a hue at the call site.** A screen asks for
  `--status-failed` or `--accent`, never for "red" or `#f47c6b`. That is what
  lets a theme change in one file and keeps light mode from turning into a pile
  of overrides.
- **Dark and light are peers.** Every role is defined for both schemes in the
  same declaration, so neither can fall behind the other.
- **Quiet chrome, loud decisions.** Surfaces are near-neutral. Saturated colour
  is reserved for what needs a human: status, risk, and the one primary action
  on a screen.
- **The brand shows up in miniature.** The five palette anchors run through the
  neutrals, the accent, the logo and the identity tints. None of them takes over
  a screen.

## Layers

```
packages/design/src/tokens.ts      the source: palette + roles + scales, authored once
     │  emitted (npm run -w @tandemise/design emit) as
     ▼
@tandemise/design/tokens.css
   palette   hues     --brand-mint, --ink-900, --signal-red-bright …
     │         only the roles read these
     ▼
   roles     roles    --canvas, --text, --accent, --status-failed …
     │         everything else reads only these
     ▼
@tandemise/design/base.css         reset and type defaults, roles only
     ▼
components   apps/desktop/src/renderer/src/styles/{base,shell,controls,surfaces,features}.css, *.tsx
```

`main.tsx` imports them in that order: the two package stylesheets, then the
desktop's own. The desktop's `styles/base.css` keeps only what is app policy
(full-height root, no window scroll, the user-select rules).

## Palette

### Brand anchors

| Token | Hex | Name | Role in the system |
|---|---|---|---|
| `--brand-mint` | `#C4F1BE` | Mint | Dark-theme accent, logo lead wheel on dark, text on indigo |
| `--brand-sage` | `#A2C3A4` | Sage | Logo trailing wheel on dark, source of the light neutrals |
| `--brand-lichen` | `#869D96` | Lichen | Tertiary text on dark, logo axle, pending state |
| `--brand-slate` | `#525B76` | Slate | Secondary text on light, logo trailing wheel on light |
| `--brand-indigo` | `#201E50` | Indigo | Light-theme accent and text, app icon tile, source of the dark neutrals |

### Derived ramps

Every ramp is derived from the anchors in OKLCH, so the steps look even and the
neutrals keep the brand's hue instead of turning flat grey.

- **`--ink-*`** (1000 → 700): indigo, desaturated and darkened. These are the
  dark-theme surfaces and borders.
- **`--paper-*`** (0 → 300): sage, almost white. These are the light-theme
  surfaces and borders.
- **Anchor tints and shades** (`--mint-50/100/700`, `--sage-700`,
  `--lichen-300/700/750`, `--slate-300`, `--indigo-300/500/600/900`) cover the
  spots where an anchor fails contrast, such as mint text on white.
- **`--signal-*-bright` / `--signal-*-deep`**: status hues (blue, green, amber,
  red, violet), pulled toward the brand. `-bright` is for ink surfaces and
  `-deep` is for paper surfaces.

Palette values are 6-digit hex only. Add a colour here only when no existing
step can do the job, and give it a role in `colorRoles` (`tokens.ts`) in the
same change.

## Semantic roles

Each colour role is written once as `light-dark(<light>, <dark>)`.

| Group | Roles | Light | Dark |
|---|---|---|---|
| Surfaces | `--canvas` `--surface` `--surface-raised` `--surface-sunken` `--surface-hover` `--surface-active` | paper | ink |
| Borders | `--border` `--border-strong` `--border-focus` | paper 150/300, indigo-500 focus | ink 800/700, mint focus |
| Focus | `--focus-ring` (alias of `--border-focus`) | indigo-500 | mint |
| Scrims | `--scrim` (modal, 72%) `--scrim-light` (drawer, 40%) | washes of `--surface-sunken` | |
| Text | `--text` `--text-secondary` `--text-tertiary` `--text-inverse` | indigo / slate / lichen-750 | mint-50 / lichen-300 / lichen |
| Accent | `--accent` `--accent-hover` `--accent-text` `--accent-soft` `--accent-line` | **indigo** fill, mint text | **mint** fill, indigo text |
| Status | `--status-{running,blocked,failed,succeeded,pending}`, `-soft` (fill, 12–13%) and `-line` (edge, 40%) | signal deep | signal bright |
| Risk | `--risk-{read,write,external,destructive,release}`, `--risk-release-soft` | aliases of status, plus violet for release | |
| Tooltip | `--tooltip-background` `--tooltip-text` | indigo / white | mint-50 / ink-950 |
| Brand | `--logo-lead` `--logo-trail` `--logo-axle` | indigo / slate / lichen | mint / sage / lichen |
| Identity | `--tint-1` … `--tint-5` | shades of the anchors | the anchors |
| Elevation | `--tds-shadow-sm` `--tds-shadow-md` `--tds-shadow-lg` | indigo at 8–18% | ink-1000 at 45–62% |

**Contrast.** Body text is above 10:1 in both themes. `--text-tertiary` is at
least 4.5:1 on every surface it sits on, from `--canvas` to `--surface-hover`
(5.4:1 or better in dark, 5.5:1 or better in light). Every `--status-*` colour
is at least 4.5:1 on `--surface`, so it can be used as text as well as a dot,
and on its own `-soft` wash over every surface, so a badge, a status pill or a
danger button reads at `--fs-xs` (the wash is measured as painted over the
surface). `--text-tertiary` also holds 4.5:1 on `--surface-active` (a tab's
count). `--accent-text` on `--accent` is 12:1. `--tooltip-text` on
`--tooltip-background` is at least 10:1, and `--focus-ring` is at least 3:1 on
every surface (WCAG 1.4.11).

**Status versus accent.** In dark mode the accent (mint) and success (green)
are both green. Green is the brand. They stay apart because success is more
saturated and always comes with a dot, an icon or a label. Never show success
with the accent colour, and never style a primary action in the success colour.

### Non-colour tokens

| Group | Tokens |
|---|---|
| Spacing (4pt) | `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 20 · `--s6` 24 · `--s7` 28 · `--s8` 32 · `--s10` 40 · `--s12` 48 · `--s16` 64 |
| Radius | `--tds-radius-xs` 4 · `--tds-radius-sm` 6 · `--tds-radius-md` 9 · `--tds-radius-lg` 13 · `--tds-radius-full` |
| Type | `--tds-font-sans` (system UI) · `--tds-font-mono` · `--fs-micro` 10.5 · `--fs-xs` 11.5 · `--fs-sm` 12.5 · `--fs-base` 13.5 · `--fs-md` 15 · `--fs-lg` 18 · `--fs-xl` 23 · `--fs-2xl` 30 · `--lh-base` 1.5 |
| Motion | `--duration-fast` 120ms · `--duration` 160ms · `--duration-slow` 240ms · `--duration-shimmer` 1.3s · `--duration-pulse` 1.9s · `--tds-ease` (standard) · `--tds-ease-out` (enter) · `--tds-ease-in` (exit). `prefers-reduced-motion` turns all motion off. |
| Focus | `--focus-ring-width` 2 · `--focus-ring-offset` 2, drawn in `--focus-ring` |
| Stacking | `--z-raised` 2 · `--z-dropdown` 40 · `--z-overlay` 50 · `--z-overlay-raised` 55 · `--z-toast` 60 · `--z-tooltip` 70. No literal z-index outside this scale. |
| Density | `--control-h-xs` 20 · `--control-h-sm` 28 · `--control-h` 30 · `--control-h-lg` 36; under `[data-density='compact']` 18 · 24 · 26 · 32. Nothing a person presses is under 24px (`xs` is a badge, not a target). |
| Layout | `--sidebar-width` 232 (desktop-only, in the desktop's `styles/base.css`, not the package) |

**Why `--tds-`.** Tailwind v4 declares its theme as custom properties
(`--font-sans`, `--radius-md`, `--shadow-lg`, `--ease-out`, `--color-*` …). A
token with the same name on `:root` fights it: whichever loads last wins, so
loading tokens.css changed a Tailwind site's `rounded-sm`, and a site's own
font silently replaced the app's. The scales that share a Tailwind namespace
therefore carry the `--tds-` prefix, `@tandemise/design/tailwind.css` maps
Tailwind's names onto them, and `check:design` fails on a collision. The
`--text*` colour roles are not Tailwind names (Tailwind's are sizes, `--text-sm`)
and keep theirs.

## Theming

The theme is chosen by `color-scheme` on `:root` and nothing else:

| Preference (`lib/theme.ts`) | Root element | `color-scheme` |
|---|---|---|
| System (default) | no `data-theme` | `dark light` (follows macOS) |
| Light | `data-theme="light"` | `light` |
| Dark | `data-theme="dark"` | `dark` |

`light-dark()` accepts only colours. To vary a percentage, a length or a shadow
by theme, mix inside each branch:
`light-dark(color-mix(… 8% …), color-mix(… 12% …))`. Chromium silently drops a
declaration that breaks this rule, and the check catches it.

`data-theme` works on any element: the roles are declared on `:root` and on
every `[data-theme]` element, so a subtree can take the other theme even when a
bundler has lowered `light-dark()`.

The main process paints the window before any CSS loads, so
`src/shared/brand.ts` repeats the two `--canvas` values. The check fails if they
drift from the palette.

## Logo

The mark is two wheels on one axle: a tandem. It also reads as two nodes on an
edge, which is what the app does, handing one piece of work from one worker to
the next. The lead wheel is larger, so the mark has a direction of travel.

There is one mark, drawn at three optical sizes:

| Drawing | File | Used for | Colour |
|---|---|---|---|
| App icon | `packages/design/assets/app-icon.svg` → `apps/desktop/build/icon.icns`, `icon.png` | Dock, About panel, installers | Indigo tile; mint→sage lead wheel, sage→lichen trailing wheel, lichen axle |
| Small mark | `LOGO` in `packages/design/src/logo.ts`, drawn by `components/Logo.tsx` and emitted as `assets/logo-mark*.svg` | Sidebar, onboarding, daemon-down, the website | `--logo-lead` / `--logo-trail` / `--logo-axle` |
| Menu bar | `packages/design/assets/logo-mark-template.svg` (emitted from `LOGO`) → `resources/trayTemplate*.png` | macOS menu bar | Pure black. macOS recolours template images, so the palette does not apply here. |

Rules:

- **Change the geometry in both drawings or in neither.** The in-app mark and
  the menu-bar mark are one geometry (`LOGO`), because both are drawn at about
  20px; the app icon is the same mark redrawn for 1024px.
- **Colour comes from the palette only.** `app-icon.svg` may contain only palette
  hex values, and the check rejects anything else. `Logo.tsx` uses the
  `--logo-*` roles, never `currentColor`.
- **Muted state.** `<Logo muted />` draws every part in `--text-tertiary`. It
  means "nothing to connect to" (the daemon-down screen). Do not use it for
  decoration.
- **Don'ts.** Do not make the wheels touch, because that reads as an infinity
  sign. Do not make them the same size, because that reads as spectacles. Do
  not run the axle through the wheels. Do not add a hub, which turns into a blob
  at 16px. Do not recolour the wheels outside the palette.
- **Minimum size** is 16px. **Clear space** around the mark is at least half its
  height.
- **Regenerate** the raster icons after editing either SVG with
  `npm run icons`.

## Component vocabulary

Build screens from these before inventing new ones. Where a component exists
in `@tandemise/design/react`, use it rather than typing the classes: it carries
the accessibility (`Button`, `Badge`, `StatusPill`, `StatusDot`, `Card`,
`Icon`, `Logo`, `Field`, `Segmented`, `Switch`, `Chip`, `IdChip`, `Stat`,
`Banner`, `Dialog`, `Tabs`/`Tab`, `Tooltip`, `Truncate`, `EmptyState`,
`SkipLink`). The
desktop's `components/primitives.tsx` and `components/Modal.tsx` wrap them with
the app's own vocabulary (`StatusBadge` takes a status string, `ConfirmDialog`
its copy). A router link that must look like a button takes `buttonClass()`.
Each class uses roles only; the component classes live in
`@tandemise/design/components.css`, the rest in the desktop's `styles/`.

| Need | Use |
|---|---|
| Actions | `Button` / `.btn`, plus `--primary` (at most one per view), `--ghost`, `--danger`, `size` `sm` (28px, a row of actions on a list item) or `lg`, `--icon` (always with an `aria-label`, and a `Tooltip` showing it), `--block`; `loading` for work in flight |
| Navigation | `Tabs` + `Tab` (`.tabs`, `.tab`, `.tab__count`), rendered as router links or buttons, never a bare `.tab` with `aria-selected`; `SkipLink` first in every shell |
| State | `.badge--{pending,running,blocked,failed,succeeded,release,accent}`, `.dot--{tone}`, `.dot--pulse` for live |
| Inputs | `Field` (`.field`), `.input`, `.textarea`, `.select`, `Segmented` (a radio group), `Switch`, `.search` |
| Containers | `Card`, `.list` / `.list__row`, `.table`, `Banner` (`neutral`, `accent`, `warn`, `danger`; `live` when it appears while the person is there), `Dialog`, `.overlay`, `.palette` |
| Values | `Chip`, `IdChip` (copyable id; `interactive={false}` inside a link or button), `.mono`, `Stat`, `.meter` |
| Identity | `.monogram[data-tint=1..5]` for things with no icon of their own |
| Empty and error | `.empty`, `.errorstate`, `.skeleton` |
| Icons | `Icon` (`@tandemise/design/react`, re-exported by `components/Icon.tsx`), drawing `ICON_PATHS`: stroke icons in `currentColor` at 1.7 weight on a 24px grid |
| Hints | `Tooltip` for a hint (it is reachable by keyboard, dismissable with Escape, hoverable and persistent: WCAG 1.4.13); `Truncate` for text an ellipsis cuts off. Never a native `title`: a keyboard user never sees it, and `check:design` rejects one in the renderer. |

## Accessibility

WCAG 2.1 AA is the minimum for every screen, in both themes. What that means in
this app, and what keeps it there:

- **Structure.** One `<main id="main">` and one `h1` (the `PageHeader` title) per
  screen; headings never skip a level (a document's own headings are shifted
  under the reader's with `aria-level`); the sidebar is a labelled `nav`; the
  `SkipLink` is the first Tab stop.
- **Keyboard.** Everything works with the keyboard, focus is always drawn
  (`--focus-ring`, 2px, at least 3:1; inputs double their border in the ring's
  colour), dialogs and drawers trap Tab and close on Escape. The held step's
  terminal keeps Tab and Escape for the program: F6 moves focus out of it and
  back, Escape outside it closes the panel, and a Screen reader mode button
  turns on xterm's accessibility tree.
- **Reflow.** Below 760 CSS px (the window zoomed to 200% and beyond) the shell
  is one column that scrolls vertically: the sidebar folds behind Menu, page
  headers wrap, grids stack (`styles/reflow.css`). Only diagrams (the plan),
  tables and code may scroll both ways (`data-scroll-2d`).
- **Names and status.** Every control is named (`check:design` rejects an
  icon-only control without `aria-label`); a visual alternative is in words
  (the plan's edges are "After …" on each card, a meter repeats a number shown
  beside it). The daemon's connection and the one-line flash are announced
  through live regions that are always mounted; the "Now" line is not a live
  region, so live agent work does not chatter.
- **Motion.** `prefers-reduced-motion` turns animation off (`base.css`).

The gates: `npm run check:design` (static), `npm run -w @tandemise/design
storybook:a11y` (every story, axe, both themes) and
`node scratch/acceptance/a11y/run-all.mjs` (every screen and state of the real
window, axe plus structure, names, a keyboard pass, reflow and text spacing; the
CI job "Accessibility (desktop)"). The hold suite's H12 covers the terminal.
The audit behind this section is `docs/accessibility/AUDIT-2026-10-31.md`.

Status always maps through `Tone` (`lib/format.ts`):
`running | blocked | failed | succeeded | pending`. Add a tone there and in
`tokens.ts` together.

## Renderer audit

An inventory of the presentational patterns in `apps/desktop/src/renderer/src`,
taken on 2026-10-31 (after #75), to decide what belongs in `@tandemise/design`
and what stays app code. Counts are occurrences in `.tsx` files. "Package"
means the pattern becomes a component in `@tandemise/design/react` with its CSS
in `@tandemise/design/components.css`; "app" means it stays in the desktop
because it carries product logic or is used in one place.

### What is duplicated or generic

| Pattern | Today | Count | Finding | Decision |
|---|---|---|---|---|
| Button | raw `<button className="btn …">` (also on 13 `<Link>`s and 4 `<span>`s), CSS in `styles/controls.css` | ~275 | Same markup typed by hand everywhere; variant classes composed with template strings in 7 places; the busy state is a label swap (`Working…`, `Holding…`, `Continuing…`) with no `aria-busy`; icon-only buttons rely on each caller remembering `aria-label` | Package `Button` (variants, sizes, `loading`, icon-only requires a label) |
| `btn--sm` | 15 call sites | 15 | **No rule defined `.btn--sm`**, so those buttons rendered at the default 30px. | Done (#80): `size="sm"` is 28px (24px compact); the call sites use it |
| Status badge / pill | `StatusBadge` + raw `badge badge--{tone}` | 17 + 35 | Two ways to draw the same pill; `badge--pending` is used once but not defined (falls back to the base, which is the pending look); the release badge mixes its own 14% wash | Package `Badge` + `StatusPill`; a `--risk-release-soft` role |
| Status dot | `StatusDot` + raw `dot dot--{tone}` | 15 + 8 | Pulse animation has a literal 1.9s | Package `StatusDot`; `--duration-pulse` |
| Card | raw `className="card"`, `card--flush`, `card__head/__title/__body` | ~100 | Structure (head/title/body) is re-typed; no shared component | Package `Card` (`flush`, `title`, `actions`) |
| Dialog | `Modal` / `ConfirmDialog` (`components/Modal.tsx`), `Drawer`, `CommandPalette`, `TerminalPanel` | 18 + 12 + 8 + 1 + 1 | The Escape stack lives in `Modal.tsx` and only Modal/Drawer use it; the palette and terminal have their own key handling. Focus moves in, but Tab can leave the dialog and focus is not returned to the opener on close. The scrim colour, the z-index (50, 55 for the terminal, 60 for the flash) and the enter animations are literals | Package `Dialog` (focus trap, Escape via a shared layer stack, focus return, `aria-labelledby`); the stack hook (`useLayer`) is exported so `Drawer` keeps one stack with it. The terminal keeps its own chrome (it must let Escape through to the agent) |
| Form field | `Field` in `primitives.tsx` (label wrapper), plus 3 hand-written `<label className="field">` | 108 + 3 | Hint/error are not tied to the control (`aria-describedby`), and an error is not `aria-invalid` | Package `Field`: wrapping mode (unchanged markup) and a render-prop mode that wires `id`, `aria-describedby`, `aria-invalid` |
| Empty state | `Empty` in `primitives.tsx`, 2 hand-written `.empty` blocks | 36 + 2 | Generic | Package `EmptyState` |
| Tabs | `.tabs` / `.tab` on route `<Link>`s in Board, Brain, Evals, Team | 4 screens | `role="tablist"` / `role="tab"` set by hand; no arrow-key movement between tabs | Package `Tabs` + `Tab` (renders any element, e.g. a router link; Left/Right/Home/End move focus) |
| Tooltip | native `title=` | ~150 | No styled tooltip anywhere; `title` is invisible to keyboard users and slow to appear | Done (#80): `Tooltip` where the text adds information, `Truncate` where an ellipsis cuts text off, an `aria-label` on every icon-only control, and the title dropped where it repeated visible text. None are left |
| Icon | `components/Icon.tsx` over `ICON_PATHS` | ~200 | Sizes in use: 10, 11, 12, 13 (75×), 14, 15, 16, 18, 22. Decorative only (`aria-hidden`) | Package `Icon` (decorative by default, `label` makes it an image) |
| Logo | `components/Logo.tsx` over `LOGO` | 3 | Generic | Package `Logo` (`muted`, optional `title`) |
| Segmented, Switch | `primitives.tsx` | 16, 15 | Generic; the segmented control was a group of `aria-pressed` buttons with no name | Done (#80): package `Segmented` (a named radio group, arrow keys) and `Switch` |
| Chip, IdChip, monogram, kbd, meter, stat | `controls.css`, `primitives.tsx` | 56, 8, 19, 6, –, 19 | Generic values display; the id chip was a `role="button"` span, nested inside links, that hid its focus ring and announced nothing | Done (#80) for `Chip`, `IdChip` (a real button, a live-region result) and `Stat` (a `<dl>`); monogram, kbd and meter stay app |
| Banner / error state / skeleton | `.banner--{accent,warn}`, `ErrorState`, `Skeleton*` | 35, 132, 55 | `ErrorState` reads the daemon's error shape; the shimmer has a literal 1.3s | `Banner` in the package (#80); `ErrorState` and the skeletons stay app; `--duration-shimmer` token |
| "Now" line | `NowLine` in `TerminalPanel.tsx`, on HandoffCard, PlanPane, TaskDetail | 3 | Product-specific (a live agent's current action) | App |
| Terminal panel chrome | `TerminalPanel` + `TerminalPanel.css` | 1 | Its own overlay at z-index 55, a dialog with no focus handling; colours already go through `--terminal-*` | App; z-index from the new scale |
| Focus ring | `base.css` `:focus-visible` (2px, offset 2px), inputs swap it for a border colour | – | Width and offset are literals | `--focus-ring-width`, `--focus-ring-offset`, `--focus-ring` |
| Control heights | `.btn` 30/36px, `.badge` 20px, `.chip` 22px, `.idchip` 18px | – | Literals; no density switch | `--control-h-*` tokens, and `data-density="compact"` |
| Inline styles | `style={{…}}` | ~450 | Mostly one-off layout (`gap`, `flex`); all colours already go through roles (`check:design`) | Not addressed here |

### Gaps the tokens close

- **Focus:** `--focus-ring-width`, `--focus-ring-offset`, `--focus-ring` (an
  alias of `--border-focus`).
- **Stacking:** `--z-raised` 2, `--z-dropdown` 40, `--z-overlay` 50,
  `--z-overlay-raised` 55, `--z-toast` 60, `--z-tooltip` 70: every literal
  z-index in the renderer, named.
- **Density:** `--control-h-xs` 20, `--control-h-sm` 26, `--control-h` 30,
  `--control-h-lg` 36, scaled down under `[data-density='compact']`.
- **Motion:** `--duration-slow` 240ms, `--duration-shimmer` 1.3s,
  `--duration-pulse` 1.9s, `--ease-out` (enter), `--ease-in` (exit), next to
  the existing `--duration-fast`, `--duration` and `--ease`.
- **Colour roles:** `--scrim` and `--scrim-light` (the overlay washes),
  `--status-*-line` (a status border), `--risk-release-soft`,
  `--tooltip-background` / `--tooltip-text`, each with its contrast pair where
  it carries text.

## Enforced rules

`npm run check:design` (`scripts/check-design-system.mjs`) fails the build when:

0. A file emitted from `tokens.ts` (`tokens.css`, `tailwind.css`, the logo
   SVGs) is stale, or a pairing in `CONTRAST_PAIRS` drops below its ratio in
   either theme.
1. A colour literal (hex, `rgb()`, `hsl()`, `oklch()` …) appears in the desktop
   source or the design package outside `packages/design/src/tokens.ts` (and
   the files emitted from it) and `src/shared/brand.ts`. Inline
   `style={{ color: … }}` counts.
2. A palette primitive is read outside the package's `tokens.css`.
3. `var(--token)` names a token that nothing defines.
4. A `var()` has a fallback. Tokens are always defined, so a fallback only
   hides a typo.
5. `light-dark()` is given something other than colours.
6. `app-icon.svg` uses a colour outside the palette, or
   `logo-mark-template.svg` uses anything but black.
7. `src/shared/brand.ts` drifts from the palette.
8. A component that `@tandemise/design/react` exports (`COMPONENTS`) has no
   Storybook story in `packages/design/stories/` (a `*.stories.tsx` naming it
   as `component` or in `subcomponents`). The stories and
   `packages/design/.storybook/` are held to rules 1-5 like any other source.
9. `tokens.css` declares a name in a Tailwind v4 theme namespace (`--font-*`,
   `--radius-*`, `--shadow-*`, `--ease-*`, `--color-*`, `--text-sm` …).
10. A native `title` attribute appears on an element (or a `Button` or `Link`)
    in the desktop renderer. Use `Tooltip`, `Truncate` or an `aria-label`.

## Changing the system

- **New role:** add it to `colorRoles` in `packages/design/src/tokens.ts` with
  both schemes, run `npm run build && npm run -w @tandemise/design emit`, then
  use it. Name it for its purpose (`--surface-overlay`), not its look
  (`--dark-grey`).
- **New colour:** add the hue to `palette` in `tokens.ts`, derived from an
  anchor in OKLCH, and add any pairing it must hold to `CONTRAST_PAIRS`.
- **New brand anchor:** update this document, `tokens.ts`, the logo roles and
  the identity tints in one change.
- **New component:** add it under `packages/design/src/react/`, its classes to
  `css/components.css`, its name to `COMPONENTS`, a
  `stories/<Name>.stories.tsx` with a story per variant, size and state (and a
  play function for its keyboard behaviour), and assertions to
  `scratch/design-react-check.mjs`.
- **Storybook** is the visual reference: every component, its states, the
  components in context and the foundations, in both themes and densities.
  `npm run -w @tandemise/design storybook` runs it locally; `main` publishes it
  to GitHub Pages at https://tandemise.github.io/tandemise/.
  `npm run -w @tandemise/design storybook:a11y` (after `storybook:build`) runs
  axe on every story and docs page in both themes and fails on a violation not
  listed in its `KNOWN` array (empty today) or on a failing play function; CI
  runs it.
- **Verify in the real app.** Walk every screen in both themes with a real
  mission, not only the mock, and regenerate `apps/desktop/screenshots/` from
  the real app with the scripts in `scratch/docs-screenshots/` (its README has
  the steps).
