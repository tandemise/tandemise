/**
 * What a first real run puts in front of a person, in words a person reads.
 *
 * Found on a fresh install driving a real Claude Code mission: the plan card
 * showed `artifact.ChangeSet.exists && checks.tests == PASS && …`, and the
 * mission title was the goal cut at 80 characters ("…the N most frequent w…").
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { describeGate } = await import(join(root, 'packages/domain/dist/index.js'));
const { titleFromGoal, QA_CRITERIA_GATE } = await import(join(root, 'packages/application/dist/index.js'));

let bad = 0;
const ok = (n, c, d = '') => { if (c) console.log(`  ok   ${n}${d ? '  ' + d : ''}`); else { bad++; console.log(`  FAIL ${n}${d ? '  ' + d : ''}`); } };

console.log('── a gate in words\n');
{
  const g = describeGate('artifact.ChangeSet.exists && checks.tests == PASS && diff.files_changed > 0');
  ok('the implement gate reads as a sentence', g === 'it writes a change set, the tests pass and it changes at least one file', g);
  ok('a single clause', describeGate('artifact.ReviewReport.exists') === 'it writes a review report');
  ok('an acronym type keeps its capitals', describeGate('artifact.QAReport.exists') === 'it writes a QA report');
  const qa = describeGate(QA_CRITERIA_GATE);
  ok('the QA criteria gate', qa === 'it writes a QA report, review finds nothing blocking and QA fails no criterion', qa);
  ok('typecheck != FAIL', describeGate('checks.typecheck != FAIL') === 'typecheck does not fail');
  for (const raw of ['checks.tests == PASS || checks.build == PASS', '!git.clean', '(checks.tests == PASS)', 'task.attempt >= 2', 'review.verdict == fail']) {
    ok(`left as written when it cannot be said plainly: ${raw}`, describeGate(raw) === raw);
  }
}

console.log('\n── a title from the goal\n');
{
  const t = titleFromGoal('Add a --top N option to the tally CLI so it prints only the N most frequent words.');
  ok('the first clause, not a cut mid-word', t === 'Add a --top N option to the tally CLI', t);
  ok('a short goal is its own title', titleFromGoal('Fix the login page.') === 'Fix the login page');
  ok('only the first sentence', titleFromGoal('Ship dark mode. Then tell the team.') === 'Ship dark mode');
  const long = titleFromGoal('Rework the onboarding checklist into a guided multi-step flow with progress saved per account');
  ok('no clause: cut on a word boundary within 60', long === 'Rework the onboarding checklist into a guided multi-step…' && long.length <= 60, long);
  const clauseTooShort = titleFromGoal('Fix it, then make every other page of the application load in under a second');
  ok('a clause too short to name anything falls back to words', clauseTooShort.startsWith('Fix it, then') && clauseTooShort.length <= 60, clauseTooShort);
  ok('never longer than 60', titleFromGoal('x'.repeat(200)).length <= 60);
}

console.log('\n── the first project form\n');
{
  // Found dogfooding v0.10.0: the Project name field suggested "Beveloce", the
  // name of an unrelated product, which a new user reads as a leftover.
  const renderer = join(root, 'apps/desktop/src/renderer/src');
  const files = readdirSync(renderer, { recursive: true }).filter((f) => /\.(tsx?|css|html)$/.test(f));
  const named = files.filter((f) => /beveloce/i.test(readFileSync(join(renderer, f), 'utf8')));
  ok('no Beveloce reference in the desktop renderer', named.length === 0, named.join(', '));
  const form = readFileSync(join(renderer, 'screens/FirstProject.tsx'), 'utf8');
  const placeholder = /<Field label="Project name">[\s\S]*?placeholder="([^"]*)"/.exec(form)?.[1];
  ok('the project name placeholder is a neutral example', placeholder === 'Acme web', String(placeholder));
}

console.log(`\n${bad === 0 ? 'FIRST-RUN WORDS: ALL PASSED' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
