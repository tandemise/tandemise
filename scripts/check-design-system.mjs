// Holds the desktop app, and the design package it is built from, to the
// design system (docs/DESIGN_SYSTEM.md).
//
// The system lives in `packages/design` (`@tandemise/design`): the palette and
// the roles are authored once in `src/tokens.ts` and emitted as
// `css/tokens.css`. The rule that makes it a contract rather than a suggestion
// is that colour enters the app only through that package. This check fails
// the build when:
//
//   0. a file emitted from tokens.ts (tokens.css, tailwind.css, the logo SVGs)
//      is stale, or a promised contrast pairing drops below its ratio
//   1. a colour literal (hex, rgb, hsl, oklch...) appears outside tokens.ts and
//      the files emitted from it
//   2. a palette primitive is read anywhere but the package's tokens.css
//   3. a `var(--token)` names a token nobody defines (a typo renders as nothing)
//   4. a `var()` carries a fallback, which is how those typos stay hidden
//   5. `light-dark()` is handed something other than colours (Chromium drops
//      the whole declaration, silently)
//   6. the app icon uses a colour that is not in the palette, or the template
//      mark uses anything but black
//   7. the main process's pre-paint window colours drift from the palette
//   8. a component that @tandemise/design/react exports has no Storybook story
//      (packages/design/stories); the stories and the Storybook config are
//      held to rules 1-5 like any other source
//   9. tokens.css declares a name Tailwind v4 keeps in its own theme
//      (`--font-*`, `--radius-*`, `--shadow-*`, `--ease-*`, `--color-*`,
//      `--text-sm`, ...): a site loading both would have one silently
//      override the other. Those scales are `--tds-*`, and tailwind.css maps
//      Tailwind's names onto them.
//  10. a native `title` attribute sits on an element (or a `Button`/`Link`,
//      which pass it to one) in the desktop renderer: a keyboard user never
//      sees it, and it is not a reliable name. Use `Tooltip`, `Truncate`, or
//      an `aria-label` on an icon-only control.
//  11. a control that shows only an icon (`<button>`, `<a>`, `Button`, `Link`,
//      or `Button iconOnly`) has no `aria-label` / `aria-labelledby`. A control
//      with a spread attribute is trusted (the name may be in it); the a11y
//      acceptance suite checks those in the running window.
//
//   node scripts/check-design-system.mjs     (after `npm run build`: it reads packages/design/dist)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const design = join(root, 'packages/design');
const TOKENS_TS = join(design, 'src/tokens.ts');
const TOKENS_CSS = join(design, 'css/tokens.css');
const TAILWIND_CSS = join(design, 'css/tailwind.css');
const DIST = join(design, 'dist/index.js');

const problems = [];
const fail = (file, line, message) => problems.push(`${relative(root, file)}${line ? `:${line}` : ''}  ${message}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(css|tsx?|mdx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Comments are prose - a hex value quoted in one is not a colour in use. */
const stripComments = (text, file) =>
  file.endsWith('.css')
    ? text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    : text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ------------------------------------------------------------------ package

if (!existsSync(DIST)) {
  console.error('design system: packages/design/dist is missing - run `npm run build` first');
  process.exit(1);
}
const tokens = await import(pathToFileURL(DIST).href);
const palette = new Map(Object.entries(tokens.palette).map(([name, hex]) => [`--${name}`, hex]));
for (const [name, hex] of palette) if (!/^#[0-9a-f]{6}$/.test(hex)) fail(TOKENS_TS, 0, `${name} must be a 6-digit lowercase hex value, not "${hex}"`);
const paletteValues = new Set(palette.values());

// 0. Emitted files are what tokens.ts says, and the promised contrast holds.
try {
  execFileSync(process.execPath, [join(design, 'scripts/emit.mjs'), '--check'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
} catch (error) {
  fail(design, 0, String(error.stderr ?? error.message).trim());
}
// 9. tokens.css stays out of Tailwind v4's theme namespaces.
{
  const declared = readFileSync(TOKENS_CSS, 'utf8');
  for (const match of declared.matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
    if (tokens.isTailwindThemeName(match[1])) {
      fail(TOKENS_CSS, lineOf(declared, match.index), `${match[1]} is a Tailwind v4 theme name - give it a --tds- name in src/css.ts and map it in src/tailwind.ts`);
    }
  }
}

// 0b. Every component the React subpath exports has a story: Storybook
// (packages/design/stories) is the visual reference, so nothing ships unseen.
// A component counts as covered when a *.stories.tsx names it as its
// `component` or lists it in `subcomponents` (Tab, on the Tabs page).
const STORIES = join(design, 'stories');
{
  const { COMPONENTS } = await import(pathToFileURL(join(design, 'dist/react/index.js')).href);
  const storyFiles = existsSync(STORIES) ? walk(STORIES).filter((file) => file.endsWith('.stories.tsx')) : [];
  const covered = new Set();
  for (const file of storyFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*component:\s*([A-Z]\w*)\s*,/gm)) covered.add(m[1]);
    for (const m of text.matchAll(/^\s*subcomponents:\s*\{([^}]*)\}/gm)) for (const name of m[1].match(/[A-Z]\w*/g) ?? []) covered.add(name);
  }
  for (const name of COMPONENTS) {
    if (!covered.has(name)) fail(STORIES, 0, `<${name}> is exported by @tandemise/design/react but has no story - add stories/${name}.stories.tsx (component: ${name})`);
  }
}
for (const theme of ['light', 'dark']) {
  const resolved = tokens.resolveTheme(theme);
  for (const pair of tokens.CONTRAST_PAIRS) {
    const [fg, bg, min, on] = pair;
    const ratio = tokens.pairContrast(resolved, pair);
    const where = on ? `--${bg} over --${on}` : `--${bg}`;
    if (ratio < min) fail(TOKENS_TS, 0, `--${fg} on ${where} is ${ratio.toFixed(2)}:1 in ${theme}, below the ${min}:1 it promises`);
  }
}

// ------------------------------------------------------------ renderer code

// Everything that reads tokens: the desktop's source and the package's own
// sources and hand-written CSS. The emitted CSS is not scanned for literals -
// it is proven equal to tokens.ts above - but its definitions count.
const files = [
  ...walk(join(desktop, 'src')),
  ...walk(join(design, 'src')),
  ...walk(join(design, 'css')),
  ...walk(join(design, 'stories')),
  ...walk(join(design, '.storybook')),
];
const EMITTED = new Set([TOKENS_CSS, TAILWIND_CSS]);
const defined = new Set();
const uses = [];

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

for (const file of files) {
  const text = stripComments(readFileSync(file, 'utf8'), file);
  const isCss = file.endsWith('.css');

  for (const m of text.matchAll(/(?:^|[\s;{'"])(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);

  // 1. Colour literals. In TS a hex is only a colour when it is a whole string
  // (`'#0d0e1e'`); `#/missions` and `#root` are routes and selectors.
  if (file !== TOKENS_TS && !EMITTED.has(file) && !file.endsWith(join('src/shared/brand.ts'))) {
    const pattern = isCss ? COLOUR_LITERAL : /['"`]#[0-9a-f]{3,8}['"`]|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
    for (const m of text.matchAll(pattern)) {
      fail(file, lineOf(text, m.index), `colour literal "${m[0]}" - use a role from @tandemise/design (tokens.css)`);
    }
  }

  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)(\$\{)?\s*(,)?/gi)) {
    uses.push({ file, line: lineOf(text, m.index), name: m[1], dynamic: Boolean(m[2]) });
    // 4. Fallbacks.
    if (m[3]) fail(file, lineOf(text, m.index), `var(${m[1]}, …) has a fallback - tokens are always defined, so it only hides typos`);
  }

  // 5. light-dark() takes two colours.
  for (const m of text.matchAll(/light-dark\(\s*([\d.]+(?:%|px|em|rem)?)\s*,/g)) {
    fail(file, lineOf(text, m.index), `light-dark(${m[1]}, …) - light-dark() accepts colours only`);
  }
}

for (const use of uses) {
  // 2. Primitives stay behind the semantic layer.
  if (palette.has(use.name) && !EMITTED.has(use.file)) {
    fail(use.file, use.line, `${use.name} is a palette primitive - read a role from @tandemise/design instead`);
  }
  // 3. Undefined tokens. `var(--status-${tone})` is checked by its prefix.
  if (use.dynamic) {
    if (![...defined].some((name) => name.startsWith(use.name))) fail(use.file, use.line, `no token starts with ${use.name}`);
  } else if (!defined.has(use.name)) {
    fail(use.file, use.line, `${use.name} is not defined by any stylesheet`);
  }
}

// --------------------------------------------------------------------- logo

const svgColours = (file) => {
  const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...text.matchAll(/(?:fill|stroke|stop-color)="([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== 'none' && !v.startsWith('url('));
};

const ICON = join(design, 'assets/app-icon.svg');
for (const colour of svgColours(ICON)) {
  if (!paletteValues.has(colour.toLowerCase())) fail(ICON, 0, `"${colour}" is not a palette colour`);
}

// A macOS template image is recoloured by the system and must be pure black.
const TRAY = join(design, 'assets/logo-mark-template.svg');
for (const colour of svgColours(TRAY)) {
  if (!/^#0{3}(0{3})?$/.test(colour)) fail(TRAY, 0, `"${colour}" - a template image must be drawn in #000 only`);
}

// ------------------------------------------------------ pre-paint colours

const BRAND = join(desktop, 'src/shared/brand.ts');
const brand = readFileSync(BRAND, 'utf8');
for (const m of brand.matchAll(/\/\*\*\s*`(--[a-z0-9-]+)`\s*\*\/\s*\n\s*\w+:\s*'(#[0-9a-f]{6})'/gi)) {
  const expected = palette.get(m[1]);
  if (!expected) fail(BRAND, lineOf(brand, m.index), `${m[1]} is not in the @tandemise/design palette`);
  else if (expected !== m[2].toLowerCase()) fail(BRAND, lineOf(brand, m.index), `${m[2]} drifted from ${m[1]} (${expected})`);
}

// ------------------------------------------------------ native tooltips

// 10. No native `title` in the renderer. Parsed as TSX, so a component's own
// `title` prop (Card, Dialog, PageHeader) is told apart from the attribute.
{
  const { default: ts } = await import('typescript');
  const PASS_THROUGH = new Set(['Button', 'Link']);
  for (const file of walk(join(desktop, 'src/renderer')).filter((f) => f.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'title') {
        const tag = node.parent.parent.tagName.getText(source);
        if (/^[a-z]/.test(tag) || PASS_THROUGH.has(tag)) {
          fail(file, lineOf(text, node.getStart(source)), `native title on <${tag}> - use Tooltip, Truncate or an aria-label (a title is invisible to keyboard users)`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

// ------------------------------------------------------ icon-only controls

// 11. A control that shows only an icon has an accessible name (WCAG 1.1.1,
// 4.1.2): a `<button>`, `<a>`, `Button` or `Link` whose only children are
// icons, or a `Button iconOnly`, carries `aria-label` or `aria-labelledby`.
// The a11y acceptance suite checks the same in the running window, where a
// name built at runtime is visible too.
{
  const { default: ts } = await import('typescript');
  const CONTROLS = new Set(['button', 'a', 'Button', 'Link']);
  const ICONS = new Set(['Icon', 'svg', 'Logo']);
  // A spread (`{...rest}`, `{...control}`) may carry the name, and this static rule cannot see into it, so a
  // control with one is trusted here; the a11y acceptance suite checks the name it renders with.
  const named = (attributes) => attributes.properties.some((p) => ts.isJsxAttribute(p) && /^aria-label(ledby)?$/.test(p.name.getText()))
    || attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
  const hasAttr = (attributes, name) => attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
  const roots = [join(desktop, 'src/renderer'), join(design, 'src/react')];
  for (const file of roots.flatMap((dir) => walk(dir)).filter((f) => f.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (node, tag) => fail(file, lineOf(text, node.getStart(source)), `<${tag}> shows only an icon and has no aria-label or aria-labelledby - name it (a Tooltip's words are not its name)`);
    const visit = (node) => {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(source);
        if (CONTROLS.has(tag) && !named(node.openingElement.attributes)) {
          const shown = node.children.filter((c) => !(ts.isJsxText(c) && c.getText(source).trim() === ''));
          const iconOnly = shown.length > 0 && shown.every((c) => (ts.isJsxSelfClosingElement(c) || ts.isJsxElement(c))
            && ICONS.has((ts.isJsxElement(c) ? c.openingElement : c).tagName.getText(source)));
          if (iconOnly || (tag === 'Button' && hasAttr(node.openingElement.attributes, 'iconOnly'))) report(node, tag);
        }
      } else if (ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (tag === 'Button' && hasAttr(node.attributes, 'iconOnly') && !named(node.attributes)) report(node, tag);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

if (problems.length) {
  console.error(`design system: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`design-system-ok (${files.length} files, ${palette.size} palette colours, ${uses.length} token reads)`);
