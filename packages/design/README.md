# @tandemise/design

The Tandemise design system as a package: the brand palette, the light/dark
semantic roles, type, spacing, radius and motion tokens, the logo and the icon
set. It is what the Tandemise desktop app is built from, and what any other
Tandemise surface (the website, docs, a dashboard) can share so they all read
as one product.

- **One source.** Every token is authored once, in
  [`src/tokens.ts`](src/tokens.ts). The CSS, the Tailwind theme and the logo SVGs
  are emitted from it, committed, and checked for staleness in CI.
- **Framework-free at the root.** CSS custom properties plus plain TypeScript
  data, with no runtime dependency. React components live on their own
  subpath (`@tandemise/design/react`), with React 18 or 19 as an optional peer
  dependency, so a site that wants only the tokens never loads React.
- **WCAG 2.1 AA.** Every story passes axe-core's A and AA rules in both themes (`npm run storybook:a11y`, in CI), and the components carry the keyboard and screen reader behaviour (names, roles, focus rings of at least 3:1, focus traps, live regions) so a consumer gets it by using them.
- **Light and dark are peers.** Each colour role is written once as
  `light-dark(<light>, <dark>)`; `color-scheme` picks the theme.

```bash
npm install @tandemise/design
```

It is published to npm with provenance by the Tandemise release workflow, at
the app's version: `@tandemise/design@0.10.0` is the design of Tandemise
v0.10.0.

## What is in it

| Import | What |
|---|---|
| `@tandemise/design/tokens.css` | Every token as a CSS custom property: palette, roles (both themes), shadows, radius, spacing, type, motion, the focus ring, the z-index scale and control heights (with a `[data-density='compact']` set). No name collides with a Tailwind v4 theme variable: fonts, radii, shadows and easings are `--tds-*`. |
| `@tandemise/design/base.css` | A small reset and type defaults built on the roles (body colours and font, focus ring, selection, scrollbars, reduced motion). Import after tokens.css. |
| `@tandemise/design/components.css` | The component stylesheet: `.btn`, `.badge`, `.dot`, `.card`, `.field` and inputs, `.segmented`, `.switch`, `.chip`, `.idchip`, `.stat`, `.banner`, `.overlay`/`.modal`, `.tabs`/`.tab`, `.tooltip`, `.truncate`, `.empty`, `.logo`. BEM classes, state in `data-*`/`aria-*`, roles and scales only. Import after base.css. |
| `@tandemise/design/react` | Accessible React components over components.css: `Button`, `Badge`, `StatusPill`, `StatusDot`, `Card`, `Icon`, `Logo`, `Field`, `Segmented`, `Switch`, `Chip`, `IdChip`, `Stat`, `Banner`, `Dialog` (+ `useDialogLayer`), `Tabs`/`Tab`, `Tooltip`, `Truncate`, `EmptyState`, `SkipLink`. See [React components](#react-components). |
| `@tandemise/design/tailwind.css` | A Tailwind v4 theme (`@theme`) with the palette as utilities, and the roles and Tailwind's font, radius, shadow and easing names bridged to tokens.css. |
| `@tandemise/design` | The tokens as typed data (`palette`, `colorRoles`, `radius`, `space`, `fontSize`, ...), `resolveTheme()`, `contrast()`, the Tailwind v3 `tailwindPreset`, `LOGO` and `ICON_PATHS`. |
| `@tandemise/design/tokens`, `/icons`, `/logo`, `/resolve`, `/tailwind` | The same, one module at a time, for bundles that want only one. |
| `@tandemise/design/assets/*` | `app-icon.svg` / `app-icon.png` (the tile icon), `logo-mark.svg` (follows the viewer's scheme), `logo-mark-on-dark.svg`, `logo-mark-on-light.svg`, `logo-mark-template.svg` (black, for macOS template images). |

## The token rules

Two layers, and one rule that makes them a contract:

```
palette   hues      --brand-mint  --ink-900  --signal-red-bright ...
   │        only the roles read these
   ▼
roles     purpose   --canvas  --text  --accent  --status-failed ...
   │        apps read only these
   ▼
your CSS / components
```

1. **Colour is a role, never a hue at the call site.** Ask for `--status-failed`
   or `--accent`, never for "red" or a hex value. A theme then changes in one
   place, and light mode is not a pile of overrides.
2. **Raw colours live in `src/tokens.ts` only.** Everything else - this
   package's own CSS, and any app built on it - reads custom properties. The
   Tandemise repo enforces this with `npm run check:design`.
3. **No `var()` fallbacks.** Tokens are always defined, so a fallback only hides
   a typo.
4. **`light-dark()` takes colours only.** To vary a shadow or a percentage by
   theme, mix inside each branch (`--tds-shadow-*` shows how).
5. **No Tailwind names in tokens.css.** Tailwind v4 declares `--font-*`,
   `--radius-*`, `--shadow-*`, `--ease-*`, `--color-*` and more in its own
   theme; a stylesheet that declares the same names on `:root` silently wins
   or loses against it depending on load order. So the scales that share a
   Tailwind namespace are `--tds-font-sans`, `--tds-font-mono`,
   `--tds-radius-{xs,sm,md,lg,full}`, `--tds-shadow-{sm,md,lg}` and
   `--tds-ease`, `--tds-ease-out`, `--tds-ease-in`; `tailwind.css` maps
   Tailwind's names onto them. `npm run check:design` fails on a collision.
6. **Contrast is measured, not remembered.** `CONTRAST_PAIRS` lists what the
   system promises (body text >= 10:1 on every surface, secondary and tertiary
   text and every status colour >= 4.5:1, a badge's text on its own `-soft` wash
   >= 4.5:1 over every surface, accent text on accent >= 12:1, tooltip
   text >= 10:1, the focus ring >= 3:1 on every surface), and the check
   measures each pairing in both themes, a translucent wash as painted over the
   surface beneath it.

### Brand anchors

| Token | Hex | Role |
|---|---|---|
| `--brand-mint` | `#c4f1be` | Dark-theme accent, logo lead wheel on dark, text on indigo |
| `--brand-sage` | `#a2c3a4` | Logo trailing wheel on dark, source of the light neutrals |
| `--brand-lichen` | `#869d96` | Tertiary text on dark, logo axle, pending state |
| `--brand-slate` | `#525b76` | Secondary text on light, logo trailing wheel on light |
| `--brand-indigo` | `#201e50` | Light-theme accent and text, app icon tile, source of the dark neutrals |

The ramps (`--ink-*` for dark surfaces, `--paper-*` for light ones, anchor tints
and shades, `--signal-*-bright` / `-deep`) are derived from these in OKLCH.
[docs/DESIGN_SYSTEM.md](../../docs/DESIGN_SYSTEM.md) has every role, the
theming rules, the logo rules and the component vocabulary of the desktop app.

### Theming

| Root element | `color-scheme` | Result |
|---|---|---|
| no `data-theme` | `dark light` | follows the OS |
| `data-theme="light"` | `light` | light |
| `data-theme="dark"` | `dark` | dark |

`data-theme` works on any element, not only the root: the roles are redeclared
on every `[data-theme]` element, so a dark panel inside a light page is dark
even after a bundler lowers `light-dark()` for older browsers.

## Using it

### In the desktop app (Vite / Electron)

```ts
// main.tsx - order matters: tokens, then the reset, then the app's own CSS.
import '@tandemise/design/tokens.css';
import '@tandemise/design/base.css';
import './styles/shell.css';
```

```tsx
import { ICON_PATHS, ICON_STROKE_WIDTH, type IconName } from '@tandemise/design/icons';

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={ICON_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
```

Code that cannot read CSS (a canvas, the Electron main process before the first
paint) takes resolved values:

```ts
import { resolveTheme } from '@tandemise/design/resolve';
resolveTheme('dark').canvas; // '#0d0e1e'
resolveTheme('light')['accent-soft']; // '#201e5014' (a wash keeps its alpha)
```

### In a Next.js / Tailwind v4 site

```css
/* app/globals.css */
@import 'tailwindcss';
@import '@tandemise/design/tokens.css';
@import '@tandemise/design/tailwind.css';
```

```tsx
<body className="bg-ink-1000 text-mint-50">            {/* palette: literal hues */}
<section className="bg-canvas text-text-secondary">    {/* roles: follow the theme */}
```

A dark-only site sets `<html data-theme="dark">`. Utility names: a brand anchor
drops its `brand-` prefix (`bg-mint`, `stroke-lichen`), every other hue is its
token name (`bg-ink-950`, `text-lichen-300`, `text-signal-amber-bright`), and a
role is its role name (`bg-surface-raised`, `border-border`). `font-sans`,
`font-mono`, `rounded-{xs,sm,md,lg,full}`, `shadow-{sm,md,lg}` and
`ease-in`/`ease-out`/`ease-in-out` draw the Tandemise values: tailwind.css maps
Tailwind's names onto the `--tds-*` tokens. To keep your own type or corners,
restate those names in your own `@theme` after the import:

```css
@theme {
  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --radius-md: 0.375rem;
}
```

The logo, as an image or inline:

```tsx
import mark from '@tandemise/design/assets/logo-mark-on-dark.svg';
// or draw it from LOGO (`@tandemise/design/logo`) with the --logo-* roles.
```

### With Tailwind v3

```js
// tailwind.config.js
import { tailwindPreset } from '@tandemise/design/tailwind';
export default { presets: [tailwindPreset], content: ['./src/**/*.{ts,tsx}'] };
```

## React components

```tsx
import '@tandemise/design/tokens.css';
import '@tandemise/design/base.css';
import '@tandemise/design/components.css';
import { Button, Dialog, Field, StatusPill, Tabs, Tab } from '@tandemise/design/react';
```

They carry markup and accessibility, never product logic: each one renders the
classes in `components.css`, takes its state as props and reports it as
`data-*` or `aria-*` attributes. React 18 and 19 are both supported.

| Component | Props worth knowing | Accessibility |
|---|---|---|
| `Button` | `variant` (`secondary` default, `primary` at most once per view, `ghost`, `danger`), `size` (`sm` 28px, `md` 30px, `lg` 36px), `iconOnly`, `block`, `loading`, `loadingLabel` | `type="button"` by default; `loading` sets `aria-busy` and `data-loading` and stops presses while keeping the width; an `iconOnly` button warns in development without an `aria-label` (a `title` is not a name) and should sit in a `Tooltip` with the same words. Nothing is smaller than 24x24, compact density and icon-only included. `buttonClass()` gives a link the same look. |
| `Badge` | `tone` (a status, `accent`, `release`) | Plain text; colour is never the only signal. |
| `StatusPill` | `tone`, `label`, `icon`, `live` | Words plus a dot or icon; the dot is `aria-hidden`. |
| `StatusDot` | `tone`, `live` | Decorative, unless given an `aria-label` (then `role="img"`). |
| `Card` | `title`, `actions`, `flush` | With a title, a `<section>` labelled by its heading. |
| `Icon` | `name`, `size`, `label` | Decorative (`aria-hidden`) unless `label` makes it an image. |
| `Logo` | `size`, `muted`, `title` | Decorative unless titled. |
| `Field` | `label`, `hint`, `error`, `required`; children a node or `(control, label) => …` | Node form: a wrapping `<label>`. Render-prop form: `<label for>`, and the control gets `id`, `aria-describedby` (hint or error) and `aria-invalid`; `label.id` names a control `<label for>` cannot (a `Segmented`, through `aria-labelledby`). |
| `Segmented` | `value`, `options` (`value`, `label`, `disabled`), `onChange`, `label`, `block` | A radio group: `radiogroup` named by `label` or `aria-labelledby`, a `radio` per option with `aria-checked`; one tab stop; arrow keys move the choice and wrap, Home/End jump, disabled options are skipped. |
| `Switch` | `checked`, `onChange`, `label` | `<button role="switch">` with `aria-checked`; Space or Enter toggles. Named by `label`, `aria-labelledby` or a wrapping `<label>`. 24px-tall hit area. |
| `Chip` | `muted`, `icon` | Plain text in a box. |
| `IdChip` | `id`, `prefix`, `interactive`, `copy`, `onCopied` | A `<button>` named by the id that copies it on click, Enter or Space, with a tooltip saying so; the result is announced in a polite live region. `interactive={false}` inside a link or button (no control inside a control). |
| `Stat` | `label`, `value`, `note`, `muted` | A `<dl>`: the label a `<dt>`, the value and note `<dd>`s, read as a pair. |
| `Banner` | `tone` (`neutral`, `accent`, `warn`, `danger`), `live`, `icon`, `action`, `onDismiss`, `dismissLabel`, `as` | No role when it is there on load; `live="polite"` is `role="status"`, `live="assertive"` is `role="alert"`. The dismiss button is named. |
| `Dialog` | `title`, `description`, `footer`, `onClose`, `wide`, `initialFocus`, `closeOnScrim` | `role="dialog"`, `aria-modal`, named and described; focus moves in (to `[data-autofocus]` first), Tab is trapped, Escape closes only the topmost layer, focus returns to the opener. `useDialogLayer` gives a drawer or palette the same behaviour and the same Escape stack. |
| `Tabs` / `Tab` | `label`; `selected`, `count`, `as` (a router link) | `tablist`/`tab`, `aria-selected`, roving `tabIndex`; Left/Right/Home/End move focus. |
| `Tooltip` | `content`, `placement`, `delay`; children one element or `(trigger) => …` | `role="tooltip"`, tied with `aria-describedby` unless it repeats the trigger's name. WCAG 1.4.13: shows on hover and on focus; Escape dismisses it (and not the dialog around it); the pointer can move onto it; it stays until pointer and focus have left. Plain-text triggers are made focusable; it stays inside the window. Use it instead of a native `title`. |
| `Truncate` | `as`, `placement` | One line with an ellipsis. Only while it is cut off: its full text in a tooltip on hover and focus, and a tab stop (or, inside a link or button, shown when that control has keyboard focus). |
| `EmptyState` | `icon`, `title`, `body`, `action`, `inline` | Plain content. |
| `SkipLink` | `target` (the id of the page's `<main>`), children ("Skip to main content") | WCAG 2.4.1: the first stop on a page, drawn only while it has keyboard focus; Enter moves focus to `target` by script, so it also works under a hash router. |

The pure parts (`trapTarget`, `nextTabIndex`, `nextSegmentIndex`, `tooltipPosition`, `tooltipFit`, `isClipped`, `buttonClass`)
are exported and tested on their own.

## Storybook

The visual reference is a Storybook, published from `main` to the repository's
GitHub Pages site. It has a page per component with controls for every variant,
size and state; "In context" stories that compose them the way the desktop does
(a task card, a confirm dialog, a settings section); and foundations pages
(colour roles in both themes with every contrast pair measured, type, spacing,
radius, elevation, z-index, motion, the focus ring, a searchable icon grid, the
logo). The toolbar switches the theme (light, dark, system) and the density.

```bash
npm run build                                   # once, from the repository root
npm run -w @tandemise/design storybook          # http://localhost:6006
npm run -w @tandemise/design storybook:build    # static site in storybook-static/ (git-ignored)
npm run -w @tandemise/design storybook:a11y     # axe on every story, light and dark, in headless Chrome
```

The stories read the package's sources, so an edit to a component or to
`tokens.ts` shows up at once. `storybook:a11y` also fails when a story's play
function (the Dialog focus trap, the Tabs arrow keys, the Field wiring) fails;
set `CHROME_PATH` if Chrome is not in a standard place. `check:design` fails
when a component that `@tandemise/design/react` exports has no story. None of
it is published to npm: the package's `files` leaves Storybook out.

## Changing a token

1. Edit [`src/tokens.ts`](src/tokens.ts). A new colour goes in `palette`,
   derived from an anchor in OKLCH; give it a role in `colorRoles` in the same
   change. Name a role for its purpose (`surface-overlay`), not its look.
2. `npm run build && npm run -w @tandemise/design emit` to regenerate
   `css/tokens.css`, `css/tailwind.css` and the logo SVGs.
3. `npm run check:design` - stale files, broken contrast, stray colour
   literals and undefined tokens all fail it.

The app icon (`assets/app-icon.svg`) is hand-drawn at 1024px and may use only
palette hex values; `npm run icons` in the Tandemise repo rasterises it.

## Releasing

Nothing to do by hand. When release-please publishes a Tandemise release,
`.github/workflows/publish-design.yml` builds the package at the release tag,
runs `check:design`, and publishes it with `npm publish --provenance`. It needs
an `NPM_TOKEN` repository secret (an npm granular access token that may
publish `@tandemise/design`); without one it leaves a notice on the run and
publishes nothing. A version already on npm is skipped, so a re-run is safe;
run it by hand for a tag from the Actions tab.

## License

Apache-2.0
