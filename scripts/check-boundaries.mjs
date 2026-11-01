#!/usr/bin/env node
// Mechanically enforces MVP.md §26.1: dependency direction and the §6.1
// boundary rule (domain/application must not import provider-specific modules).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LAYERS, PACKAGES, PROVIDER_PACKAGES, UI_PACKAGES } from './packages.mjs';

const FORBIDDEN_IN_CORE = [
  /^electron$/, /^playwright/, /^better-sqlite3$/, /^@octokit/, /^ws$/,
  /^node:child_process$/, /^child_process$/,
];
const CORE = new Set(['kernel', 'domain', 'application', 'policy', 'context', 'evaluation',
  'runtimes-core', 'execution-core', 'integrations-core']);

const errors = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// Matches only statement-position import/export-from. `[^;]` stops the match
// crossing a statement boundary, which previously let a string literal inside a
// function body be mistaken for a module specifier.
const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;

for (const [name, spec] of Object.entries(PACKAGES)) {
  const root = `packages/${name}/src`;
  let files;
  try { files = walk(root); } catch { continue; }
  const allowed = new Set(spec.deps.map((d) => `@tandemise/${d}`));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const specifiers = [
      ...[...src.matchAll(IMPORT_RE)].map((m) => m[1]),
      ...[...src.matchAll(SIDE_EFFECT_IMPORT_RE)].map((m) => m[1]),
    ];
    for (const mod of specifiers) {
      if (!mod || mod.startsWith('.')) continue;
      if (mod.startsWith('@tandemise/')) {
        // A subpath export (`@tandemise/api-contract/relay`) is judged as its package.
        const dep = mod.slice('@tandemise/'.length).split('/')[0];
        if (!allowed.has(`@tandemise/${dep}`)) {
          errors.push(`${file}: imports ${mod} which is not a declared dependency of @tandemise/${name}`);
        } else if ((LAYERS[dep] ?? 99) >= (LAYERS[name] ?? 99)) {
          errors.push(`${file}: layer violation - ${name}(L${LAYERS[name]}) -> ${dep}(L${LAYERS[dep]})`);
        }
        continue;
      }
      const bare = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
      if (CORE.has(name) && FORBIDDEN_IN_CORE.some((re) => re.test(bare))) {
        errors.push(`${file}: core package '${name}' must not import provider/runtime module '${mod}' (MVP.md §6.1)`);
      }
      const declared = { ...(spec.ext ?? {}), ...(spec.dev ?? {}) };
      if (!mod.startsWith('node:') && !declared[bare] && !PROVIDER_PACKAGES.has(name)) {
        errors.push(`${file}: undeclared external dependency '${mod}' in @tandemise/${name}`);
      }
    }
  }
}

// UI packages (`@tandemise/design`) import nothing outside themselves: no
// `@tandemise/*`, no third-party module, no `node:*`. That is what lets the
// renderer value-import them below, and what lets one be split into its own
// repository and published with no dependency to bring along.
const ANY_SPECIFIER_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(/gm;
//
// The one exception is a UI package's `src/react/` subpath: it may import
// `react` (its optional peer dependency) and nothing else from outside. The
// rest of the package must not reach into `react/`, so the root entry stays
// framework-free for a site that only wants the tokens.
const walkUi = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkUi(p, out);
    else if (/\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
};
for (const name of Object.keys(UI_PACKAGES)) {
  let files;
  try { files = walkUi(`packages/${name}/src`); } catch { errors.push(`packages/${name}/src: listed in UI_PACKAGES but missing`); continue; }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const inReact = file.split(/[\\/]/).includes('react');
    for (const m of src.matchAll(ANY_SPECIFIER_RE)) {
      const mod = m[1] ?? m[2] ?? m[3];
      if (!inReact && mod && /(^|\/)react\//.test(mod) && mod.startsWith('.')) {
        errors.push(`${file}: only src/react/ may import the React components (found '${mod}'); keep the root entry framework-free`);
        continue;
      }
      if (mod?.startsWith('./') || mod?.startsWith('../')) continue;
      if (inReact && mod === 'react') continue;
      errors.push(`${file}: UI package '${name}' may import only its own modules${inReact ? " and 'react'" : ''} (found ${mod ? `'${mod}'` : 'require()'})`);
    }
  }
}
const UI_PACKAGE_NAMES = new Set(Object.keys(UI_PACKAGES).map((n) => `@tandemise/${n}`));

// The renderer is a sandboxed browser context (MVP.md §7.1). Every
// `@tandemise/*` package's runtime entry reaches `@tandemise/shared`, which
// imports `node:os` and `node:path`, so a single value import blanks the whole
// app at load - and the type checker cannot see it, because the types are
// fine. Types cost nothing and are allowed; runtime values the renderer needs
// are mirrored in `lib/domain.ts`.
{
  const renderer = 'apps/desktop/src/renderer/src';
  const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\s/;
  // Subpaths whose compiled module has no runtime imports at all, so the Team
  // screen and the daemon share one preset mapping instead of a mirrored copy.
  // Each maps to its source; the allowance holds only while that source has no
  // value imports or re-exports of any kind (type-only ones are erased).
  const PURE_SUBPATH_SOURCES = new Map([
    ['@tandemise/domain/staffing-presets', 'packages/domain/src/staffing-presets.ts'],
    // The mission header reads a tracker item's goal with the rule the intake check proves.
    ['@tandemise/domain/tracker-goal', 'packages/domain/src/tracker-goal.ts'],
    // The terminal panel reads Claude Code's start-up questions with the rule the hold check proves.
    ['@tandemise/domain/claude-prompts', 'packages/domain/src/claude-prompts.ts'],
    // The artifact reader hides YAML front matter with the same rule the daemon uses.
    ['@tandemise/artifacts/strip-front-matter', 'packages/artifacts/src/strip-front-matter.ts'],
    // The Inbox and the daemon's mission feed judge "for me" with one rule.
    ['@tandemise/api-contract/for-me', 'packages/api-contract/src/for-me.ts'],
    // Settings → About and the offline check build the copied diagnostics with one function.
    ['@tandemise/api-contract/about', 'packages/api-contract/src/about.ts'],
  ]);
  const PURE_SUBPATHS = new Set(PURE_SUBPATH_SOURCES.keys());
  const ANY_IMPORT_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(/gm;
  for (const [subpath, source] of PURE_SUBPATH_SOURCES) {
    let src;
    try {
      src = readFileSync(source, 'utf8');
    } catch {
      errors.push(`${subpath}: allowlisted as pure but ${source} does not exist`);
      continue;
    }
    for (const match of src.matchAll(ANY_IMPORT_RE)) {
      if (TYPE_ONLY_RE.test(match[0])) continue;
      errors.push(`${source}: allowlisted for the renderer as pure, but has a value import (${match[0].trim().slice(0, 80)}); keep it type-only or drop the allowance`);
    }
  }
  const STATEMENT_RE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"](@tandemise\/[^'"]+)['"]/gm;
  let files = [];
  try {
    files = readdirSync(renderer, { recursive: true })
      .map((e) => join(renderer, String(e)))
      .filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.d.ts'));
  } catch { /* no renderer in this checkout */ }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(STATEMENT_RE)) {
      if (TYPE_ONLY_RE.test(match[0]) || PURE_SUBPATHS.has(match[1])) continue;
      // A UI package has no imports of its own (checked above), so any entry of it is safe in the browser.
      if (UI_PACKAGE_NAMES.has(match[1].split('/').slice(0, 2).join('/'))) continue;
      errors.push(`${file}: renderer value-imports ${match[1]}, which pulls Node built-ins into the browser bundle; use \`import type\` or lib/domain.ts`);
    }
  }
}

// The relay (apps/relay/src) imports exactly two internal modules, and two
// external ones, so splitting it into its own repository stays mechanical
// (relay spec, §Monorepo or separate repo). The bare `@tandemise/api-contract`
// is refused too: it reaches `domain` and `shared` at runtime.
{
  const RELAY_ALLOWED = new Set(['@tandemise/api-contract/relay', '@tandemise/coordination', 'ws', 'better-sqlite3', 'zod']);
  let files = [];
  try { files = walk('apps/relay/src'); } catch { /* no relay in this checkout */ }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const specifiers = [
      ...[...src.matchAll(IMPORT_RE)].map((m) => m[1]),
      ...[...src.matchAll(SIDE_EFFECT_IMPORT_RE)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const mod of specifiers) {
      if (!mod || mod.startsWith('.') || mod.startsWith('node:')) continue;
      if (!RELAY_ALLOWED.has(mod)) errors.push(`${file}: the relay may import only @tandemise/api-contract/relay, @tandemise/coordination, ws, better-sqlite3, zod and node:* (found '${mod}')`);
    }
  }
}

// The application uses coordination's pure rules only; the store and its SQL belong to the daemon's wiring.
for (const file of walk('packages/application/src')) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[1] === '@tandemise/coordination' && !/^\s*(?:import|export)\s+type\s/.test(m[0])) {
      errors.push(`${file}: the application may import only '@tandemise/coordination/rules' (the pure rules), not the store`);
    }
  }
}

// Sources the relay server loads on their own: type-only imports plus
// `import { z } from 'zod'`, and nothing else, so the relay stays splittable
// (docs/superpowers/specs/2026-10-30-relay-design.md, §Monorepo or separate repo).
const ZOD_ONLY_SOURCES = ['packages/api-contract/src/relay.ts'];
{
  const ANY_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(/gm;
  for (const source of ZOD_ONLY_SOURCES) {
    let src;
    try { src = readFileSync(source, 'utf8'); } catch { errors.push(`${source}: listed as zod-only but does not exist`); continue; }
    for (const m of src.matchAll(ANY_RE)) {
      const stmt = m[0].trim();
      if (/^(?:import|export)\s+type\s/.test(stmt)) continue;
      if (/^import\s*\{\s*z\s*\}\s*from\s*['"]zod['"]$/.test(stmt)) continue;
      errors.push(`${source}: may import only types and \`{ z } from 'zod'\` (${stmt.slice(0, 80)})`);
    }
  }
}

if (errors.length) {
  console.error('Architecture boundary violations:\n' + errors.map((e) => '  ✗ ' + e).join('\n'));
  process.exit(1);
}
console.log('✓ architecture boundaries ok');
