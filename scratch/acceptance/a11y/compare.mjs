#!/usr/bin/env node
// Before/after table from two a11y runs' results:
//   node scratch/acceptance/a11y/compare.mjs <before.json> <after.json> > COMPARISON.md
import { readFileSync } from 'node:fs';

const [beforeFile, afterFile] = process.argv.slice(2);
const load = (file) => JSON.parse(readFileSync(file, 'utf8'));
const summarize = (results) => {
  const by = new Map();
  for (const r of results) {
    const row = by.get(r.state) ?? { axe: { dark: 0, light: 0 }, failing: 0, checks: 0 };
    row.checks += 1;
    if (!r.ok) row.failing += 1;
    if (r.check === 'axe') row.axe[r.scheme] = r.problems.reduce((n, v) => n + (v.nodes?.length ?? 1), 0);
    by.set(r.state, row);
  }
  return by;
};
const before = summarize(load(beforeFile));
const after = summarize(load(afterFile));
const states = [...new Set([...before.keys(), ...after.keys()])];
const cell = (row, pick) => (row ? pick(row) : 'not run');
const total = (map, pick) => [...map.values()].reduce((n, r) => n + pick(r), 0);
console.log([
  '# WCAG 2.1 AA: before and after, per screen',
  '',
  'axe nodes are the elements axe-core flagged under the WCAG 2.0/2.1 A+AA rules; failing checks count every probe',
  '(axe, structure, names, keyboard, escape, reflow at 320 and 640, text spacing) that found a problem.',
  '',
  '| Screen / state | axe nodes before (dark / light) | axe nodes after (dark / light) | failing checks before | failing checks after |',
  '|---|---|---|---|---|',
  ...states.map((s) => {
    const b = before.get(s);
    const a = after.get(s);
    return `| ${s} | ${cell(b, (r) => `${r.axe.dark} / ${r.axe.light}`)} | ${cell(a, (r) => `${r.axe.dark} / ${r.axe.light}`)} | ${cell(b, (r) => `${r.failing} of ${r.checks}`)} | ${cell(a, (r) => `${r.failing} of ${r.checks}`)} |`;
  }),
  `| **all** | **${total(before, (r) => r.axe.dark + r.axe.light)}** | **${total(after, (r) => r.axe.dark + r.axe.light)}** | **${total(before, (r) => r.failing)} of ${total(before, (r) => r.checks)}** | **${total(after, (r) => r.failing)} of ${total(after, (r) => r.checks)}** |`,
  '',
  'The "before" run attached to an already-seeded window, so it did not open the first-run and daemon-down windows',
  '(they were audited by hand: neither had a main landmark).',
].join('\n'));
