// P1 handoff contract and mission feed. Pure rules first (schemas, budgets,
// templates); later tasks append persistence, engine and HTTP sections.
//
//   npm run build && node scratch/handoff-check.mjs
import {
  ARTIFACT_SCHEMAS, artifactSkeleton, HANDOFF_LIMITS, WORD_BUDGETS, budgetFor, deriveHandoff, handoffSchema, hasSchema,
  measureBody, overBudget, parseArtifact, renderArtifactTemplate, splitAppendix, stripFrontMatter,
} from '@tandemise/artifacts';
import { stripFrontMatter as stripFromSubpath } from '@tandemise/artifacts/strip-front-matter';
import { ARTIFACT_TYPES } from '@tandemise/domain';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The smallest front matter each type's schema accepts, before the handoff.
const FRONT = {
  ProblemBrief: { successMetric: 'Activation improves', evidence: [] },
  ProductSpec: { acceptanceCriteria: [{ id: 'AC1', statement: 'The page greets the visitor.' }], nonGoals: [] },
  DesignBrief: { flows: ['Main flow'], accessibility: [], openQuestions: [] },
  ArchitecturePlan: { components: ['app'], risks: [], migration: 'none' },
  ImplementationPlan: { steps: [{ id: 'S1', summary: 'Make the change', files: ['README.md'], dependsOn: [] }] },
  ChangeSet: { branch: 'feat/hello', commits: [], filesChanged: 1, testsRun: [], knownLimitations: [] },
  ReviewReport: { verdict: 'pass', reviewedRef: 'HEAD', findings: [] },
  QAPlan: { cases: [{ id: 'TC1', criterion: 'AC1', method: 'manual' }] },
  QAReport: { results: [{ criterion: 'AC1', outcome: 'PASS', evidence: 'seen' }], blockingDefects: 0 },
  ReleaseCandidate: { ref: 'v1.0.0', checks: [], unresolvedRisks: [], rollback: 'Revert the tag.' },
  DecisionRecord: { status: 'accepted', decision: 'Ship it', owner: 'demo', supersedes: '' },
  FinanceReport: {},
  Evidence: {},
  MissionPlan: {},
  Refinement: { proposedCriteria: [{ key: 'P1', statement: 'The page greets the visitor.' }], questions: [] },
  StatusReport: { asOf: '2026-09-26T08:00:00.000Z' },
};

const HANDOFF = {
  headline: 'The hello page greets visitors by name',
  points: ['Built on the design system', 'Covered by one browser test'],
  needs: 'Approve to start the build',
  changed: [{ what: 'The button uses brand-600' }],
  links: [{ label: 'Open preview', url: 'https://example.com/preview', kind: 'preview' }],
};

// A tiny YAML emitter for the shapes the front-matter reader accepts.
const yaml = (value, indent = '') => Object.entries(value).map(([key, v]) => {
  if (Array.isArray(v)) {
    if (v.length === 0) return `${indent}${key}: []`;
    return `${indent}${key}:\n${v.map((item) => (typeof item === 'object'
      ? `${indent}  - ${yaml(item, `${indent}    `).trimStart()}`
      : `${indent}  - ${JSON.stringify(item)}`)).join('\n')}`;
  }
  if (typeof v === 'object' && v !== null) return `${indent}${key}:\n${yaml(v, `${indent}  `)}`;
  return `${indent}${key}: ${JSON.stringify(v)}`;
}).join('\n');

const OMIT = Symbol('omit');
const doc = (type, { title = `${type} for hello`, handoff = HANDOFF, body = '# Hello\n\nThe body.' } = {}) => {
  const front = { type, schemaVersion: 1, title, ...FRONT[type], ...(handoff === OMIT ? {} : { handoff }) };
  return `---\n${yaml(front)}\n---\n\n${body}\n`;
};
const issuesOf = (result) => (result.ok ? [] : result.error);
const hasIssueAt = (result, path) => issuesOf(result).some((i) => i.path === path);

section('pure: handoff schema');
{
  check('FRONT covers all 16 types', ARTIFACT_TYPES.length === 16 && ARTIFACT_TYPES.every((t) => t in FRONT));
  for (const type of ARTIFACT_TYPES) {
    const parsed = parseArtifact(type, doc(type));
    check(`${type} accepts a valid handoff`, parsed.ok && parsed.value.frontMatter.handoff?.headline === HANDOFF.headline, issuesOf(parsed));
  }
  check('hasSchema is true for every type', ARTIFACT_TYPES.every((t) => hasSchema(t)) && Object.keys(ARTIFACT_SCHEMAS).length === 16);
  check('HANDOFF_LIMITS match the contract', eq(HANDOFF_LIMITS, { title: 60, headline: 90, point: 140, points: 3, needs: 140, changedWhat: 140, changed: 3, linkLabel: 40, links: 5, stop: 200 }));

  const missingHandoff = parseArtifact('Evidence', doc('Evidence', { handoff: OMIT }));
  check('a missing handoff is refused, even for Evidence', !missingHandoff.ok, issuesOf(missingHandoff));
  check('a missing handoff is reported at handoff.headline, the field to write', hasIssueAt(missingHandoff, 'handoff.headline') && !hasIssueAt(missingHandoff, 'handoff'), issuesOf(missingHandoff));
  const { headline: _dropped, ...noHeadline } = HANDOFF;
  const missingHeadline = parseArtifact('DesignBrief', doc('DesignBrief', { handoff: noHeadline }));
  check('a missing headline is reported at handoff.headline', hasIssueAt(missingHeadline, 'handoff.headline'), issuesOf(missingHeadline));
  const longHeadline = parseArtifact('DesignBrief', doc('DesignBrief', { handoff: { ...HANDOFF, headline: 'h'.repeat(91) } }));
  check('a 91-character headline is refused', hasIssueAt(longHeadline, 'handoff.headline'), issuesOf(longHeadline));
  check('a 90-character headline is accepted', parseArtifact('DesignBrief', doc('DesignBrief', { handoff: { ...HANDOFF, headline: 'h'.repeat(90) } })).ok);
  const fourPoints = parseArtifact('ChangeSet', doc('ChangeSet', { handoff: { ...HANDOFF, points: ['a', 'b', 'c', 'd'] } }));
  check('four points are refused', hasIssueAt(fourPoints, 'handoff.points'), issuesOf(fourPoints));
  const longPoint = parseArtifact('ChangeSet', doc('ChangeSet', { handoff: { ...HANDOFF, points: ['p'.repeat(141)] } }));
  check('a 141-character point is refused', hasIssueAt(longPoint, 'handoff.points.0'), issuesOf(longPoint));
  const ftp = parseArtifact('QAReport', doc('QAReport', { handoff: { ...HANDOFF, links: [{ label: 'Files', url: 'ftp://example.com/x', kind: 'other' }] } }));
  check('an ftp:// link is refused', hasIssueAt(ftp, 'handoff.links.0.url'), issuesOf(ftp));
  const sixLinks = Array.from({ length: 6 }, (_, i) => ({ label: `Link ${i}`, url: `https://example.com/${i}`, kind: 'doc' }));
  const tooManyLinks = parseArtifact('QAReport', doc('QAReport', { handoff: { ...HANDOFF, links: sixLinks } }));
  check('six links are refused', hasIssueAt(tooManyLinks, 'handoff.links'), issuesOf(tooManyLinks));
  const longTitle = parseArtifact('ProductSpec', doc('ProductSpec', { title: 't'.repeat(61) }));
  check('a 61-character title is refused', hasIssueAt(longTitle, 'title'), issuesOf(longTitle));
  check('a 60-character title is accepted', parseArtifact('ProductSpec', doc('ProductSpec', { title: 't'.repeat(60) })).ok);

  const minimal = parseArtifact('ReviewReport', doc('ReviewReport', { handoff: { headline: 'Looks good' } }));
  const normalised = minimal.ok ? minimal.value.frontMatter.handoff : null;
  check('absent optionals normalise: needs null, arrays empty', eq(normalised, { headline: 'Looks good', points: [], needs: null, changed: [], links: [] }), normalised);
  // `needs:` written empty, as the template invites, reads as YAML null and still normalises.
  const emptyNeeds = parseArtifact('ReviewReport', doc('ReviewReport', { handoff: { headline: 'Looks good', needs: null } }));
  check('an empty needs line normalises to null', emptyNeeds.ok && emptyNeeds.value.frontMatter.handoff.needs === null, issuesOf(emptyNeeds));
  // `needs: ""` is how an agent says "nothing"; refusing it would spend an attempt on a blank line.
  const blankNeeds = parseArtifact('ReviewReport', doc('ReviewReport', { handoff: { headline: 'Looks good', needs: '' } }));
  check('needs: "" is accepted as no needs', blankNeeds.ok && blankNeeds.value.frontMatter.handoff.needs === null, issuesOf(blankNeeds));
  const blankOptionals = handoffSchema.safeParse({ headline: 'x', needs: '   ', changed: [{ what: 'y', feedback: '' }, { what: 'z', feedback: '  ' }] });
  check('whitespace-only needs and blank changed feedback read as absent',
    blankOptionals.success && blankOptionals.data.needs === null && blankOptionals.data.changed.every((c) => c.feedback === null),
    blankOptionals.success ? blankOptionals.data : blankOptionals.error.issues);
  const defaults = handoffSchema.safeParse({ headline: 'x', changed: [{ what: 'y' }], links: [{ label: 'l', url: 'http://a.b/c' }] });
  check('link kind defaults to other and changed feedback to null',
    defaults.success && defaults.data.links[0].kind === 'other' && defaults.data.changed[0].feedback === null, defaults.success ? defaults.data : defaults.error.issues);
}

section('pure: deriveHandoff');
{
  const multi = deriveHandoff('The page works now. Next we add the footer. Then ship.');
  check('a multi-sentence input returns the first sentence', multi.headline === 'The page works now.', multi);
  check('a derived handoff has no points, needs, changes or links', eq(multi.points, []) && multi.needs === null && eq(multi.changed, []) && eq(multi.links, []));
  const long = `${'word '.repeat(40)}end`.slice(0, 200);
  const cut = deriveHandoff(long);
  check('a 200-character sentence is cut on a word boundary with an ellipsis',
    cut.headline.length <= 90 && cut.headline.endsWith('…') && /^(word )*word…$/.test(cut.headline), cut.headline);
  check('an empty input gives "(no text)"', deriveHandoff('').headline === '(no text)');
  check('a whitespace input gives "(no text)"', deriveHandoff('  \n\t ').headline === '(no text)');
  check('a derived handoff satisfies the schema', handoffSchema.safeParse(cut).success);
  const initial = deriveHandoff('Approved by Demostenes Garcia G. after the review. More.');
  check('an initial does not end the sentence', initial.headline === 'Approved by Demostenes Garcia G. after the review.', initial.headline);
  const eg = deriveHandoff('Use a framework, e.g. React, for the page. Then ship.');
  check('"e.g." does not end the sentence', eg.headline === 'Use a framework, e.g. React, for the page.', eg.headline);
  const vs = deriveHandoff('Compare it vs. Old Page for speed. It is faster.');
  check('a real sentence end after an abbreviation still ends the sentence', vs.headline === 'Compare it vs. Old Page for speed.', vs.headline);
  const lower = deriveHandoff('Version 2.0 is live. then more text follows here.');
  check('a terminator followed by a lowercase word does not end the sentence', lower.headline === 'Version 2.0 is live. then more text follows here.', lower.headline);
  const heading = deriveHandoff('# Results\n\nAll tests pass. The build is green.');
  check('a heading is dropped rather than glued to the first sentence', heading.headline === 'All tests pass.', heading.headline);
  const paragraphs = deriveHandoff('No terminator in this line\n\nA second paragraph.');
  check('a paragraph break ends the sentence', paragraphs.headline === 'No terminator in this line', paragraphs.headline);
  check('a document of only headings falls back to the heading text', deriveHandoff('# Results\n').headline === 'Results');
}

section('pure: measureBody and budgets');
{
  const body = [
    '# Title here',
    'Intro has five words here.',
    '- bullet one',
    '1. numbered item',
    '```ts',
    'const a = 1;',
    'const b = 2;',
    '```',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    'Closing line — done.',
    '## Appendix',
    'Extra detail words.',
    '~~~',
    'x',
    '~~~',
  ].join('\n');
  const m = measureBody(body);
  check('measureBody counts words, appendix and code lines exactly', eq(m, { mainWords: 14, appendixWords: 3, codeLines: 6, hasAppendix: true }), m);
  const plain = measureBody('One two three.');
  check('a body without an appendix has no appendix words', eq(plain, { mainWords: 3, appendixWords: 0, codeLines: 0, hasAppendix: false }), plain);
  const fenced = measureBody('Before.\n```\n## Appendix\n```\nAfter.');
  check('an Appendix heading inside a code fence does not open the appendix', !fenced.hasAppendix && fenced.mainWords === 2, fenced);
  const gfm = measureBody('Name | Size\n--- | ---\na | 1\nb | 2\nAfter table.');
  check('a GFM table without leading pipes is counted as table lines', gfm.codeLines === 4 && gfm.mainWords === 2, gfm);
  const nested = measureBody('Intro.\n````md\n```js\nx\n```\n````\nOutro.');
  check('a shorter fence inside a longer one does not close it', nested.codeLines === 3 && nested.mainWords === 2, nested);
  const info = measureBody('```\na\n```js\nb\n```\nOutro here.');
  check('a fence line with an info string never closes a fence', info.codeLines === 3 && info.mainWords === 2, info);
  const tilde = measureBody('~~~~\n~~~\nin code\n~~~~\nDone.');
  check('a fence closes only on the same character at least as long', tilde.codeLines === 2 && tilde.mainWords === 1, tilde);
  check('the appendix heading is matched case-insensitively', measureBody('a\n## APPENDIX: sources\nb c').appendixWords === 2);

  const split = splitAppendix('Main part.\n\n## Appendix\n\nDetail.\n');
  check('splitAppendix separates the main body from the appendix', split.main === 'Main part.' && split.appendix === 'Detail.', split);
  check('splitAppendix without an appendix returns null', splitAppendix('Only main.').appendix === null);

  const measure = (mainWords, appendixWords = 0) => ({ mainWords, appendixWords, codeLines: 0, hasAppendix: appendixWords > 0 });
  const b = budgetFor('ReleaseCandidate');
  check('overBudget is false at the budget', b === 300 && overBudget('ReleaseCandidate', measure(300)) === false);
  check('overBudget is true one word over', overBudget('ReleaseCandidate', measure(301)) === true);
  check('overBudget is false with an appendix at twice the budget', overBudget('ReleaseCandidate', measure(10, 600)) === false);
  check('overBudget is true with an appendix one word over twice the budget', overBudget('ReleaseCandidate', measure(10, 601)) === true);

  const expected = {
    ReleaseCandidate: 300, DecisionRecord: 300, MissionPlan: 300,
    ProblemBrief: 400, QAPlan: 400, Evidence: 400,
    DesignBrief: 500, ReviewReport: 500, QAReport: 500, ChangeSet: 500,
    ProductSpec: 600, FinanceReport: 600,
    ArchitecturePlan: 800, ImplementationPlan: 800,
    Refinement: 300, StatusReport: 600,
  };
  check('WORD_BUDGETS match the table for all 16 types', Object.keys(WORD_BUDGETS).length === 16 && eq(Object.fromEntries(ARTIFACT_TYPES.map((t) => [t, WORD_BUDGETS[t]])), Object.fromEntries(ARTIFACT_TYPES.map((t) => [t, expected[t]]))), WORD_BUDGETS);
}

section('pure: templates');
{
  for (const type of ARTIFACT_TYPES) {
    const template = renderArtifactTemplate(type);
    const lines = typeof template === 'string' ? template.split('\n') : [];
    const titleAt = lines.findIndex((l) => l.startsWith('title:'));
    const b = WORD_BUDGETS[type];
    const budgetLine = `  - Main body: at most ${b} words for ${type}. Put supporting detail under "## Appendix" (up to ${b * 2} words).`;
    const openingAt = lines.indexOf('---');
    const budgetAt = lines.indexOf(budgetLine);
    // Agents copy the skeleton into their documents, so the budget belongs in the rules above it and nowhere inside or after it.
    check(`${type} template has the handoff right after the title and its budget only in the rules`,
      typeof template === 'string' && template.includes('handoff:') && template.includes('headline:')
        && lines[titleAt + 1] === 'handoff:'
        && budgetAt !== -1 && openingAt !== -1 && budgetAt < openingAt
        && lines.slice(openingAt).every((l) => !l.includes('Main body: at most'))
        && !artifactSkeleton(type).includes('Main body'),
      template);
  }
  const rules = renderArtifactTemplate('DesignBrief');
  check('the filling rules carry the three handoff lines',
    rules.includes('The handoff is what a busy owner reads first, often the only thing they read. Write the headline as the outcome, not the activity.')
      && rules.includes('Put `needs` only when a person must act, and say what they must do.')
      && rules.includes('Put a link for every real thing that lives elsewhere (preview, pull request, design file).'));
  check('the headline placeholder states its limit', rules.includes('headline: <the outcome in one sentence, at most 90 characters>'));
}

section('pure: stripFrontMatter');
{
  const md = '---\ntype: DesignBrief\ntitle: x\n---\n\n# Body\n\nText.\n\n---\n\nAfter a rule.\n';
  check('removes the leading front-matter block', stripFrontMatter(md) === '# Body\n\nText.\n\n---\n\nAfter a rule.\n', stripFrontMatter(md));
  check('handles CRLF line endings', stripFrontMatter('---\r\ntype: X\r\n---\r\n# Body\r\n') === '# Body\r\n', stripFrontMatter('---\r\ntype: X\r\n---\r\n# Body\r\n'));
  check('leaves a document without front matter unchanged', stripFrontMatter('# Body\n\n---\n\nMore\n') === '# Body\n\n---\n\nMore\n');
  check('leaves an unclosed fence unchanged', stripFrontMatter('---\ntype: X\n# Body\n') === '---\ntype: X\n# Body\n');
  check('the renderer subpath exports the same function', stripFromSubpath === stripFrontMatter || stripFromSubpath(md) === stripFrontMatter(md));
}

section('persistence: migration 009');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const P = await import('@tandemise/persistence');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-handoff-'));
  const db = P.openDatabase({ path: join(dir, 't.db') });
  const v8 = P.MIGRATIONS.filter((m) => m.version <= 8);
  P.migrate(db, undefined, v8);
  const h = db.handle;
  const now = '2026-09-14T00:00:00.000Z';
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES ('ws_h','H',NULL,'{}','{}','{}','supervised','{}',?,?)`).run(now, now);
  h.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
             VALUES ('m_h','ws_h','T','G','[]','[]','EXECUTING','balanced','standard',?,?)`).run(now, now);
  // A row exactly as P0 wrote it: no handoff, word count or budget flag.
  h.prepare(`INSERT INTO artifacts (id,workspace_id,mission_id,task_id,created_by_run_id,type,title,content_ref,media_type,sha256,byte_size,schema_version,summary,created_at)
             VALUES ('ar_legacy','ws_h','m_h',NULL,NULL,'DesignBrief','Legacy onboarding brief','c','text/markdown','x',1,1,'An older summary',?)`).run(now);

  // Pinned to 9 on purpose: this section proves what migration 9 alone did,
  // so it stops before whatever migrations 10+ have since added.
  const result = P.migrate(db, undefined, P.MIGRATIONS.filter((m) => m.version <= 9));
  check('a version 8 database migrates to 9', eq(result.applied, [9]) && P.schemaVersion(db) === 9, result);
  const legacy = h.prepare("SELECT handoff, word_count, over_budget FROM artifacts WHERE id = 'ar_legacy'").get();
  check('the legacy row has no handoff, no word count and is not over budget',
    legacy.handoff === null && legacy.word_count === null && legacy.over_budget === 0, legacy);

  // The assertion above is done with migration 9 isolated; the rest of this
  // section exercises the repository, whose column list tracks the current
  // schema, so the database now catches up to it. Later migrations only add
  // columns and tables, never touch `handoff`/`word_count`/`over_budget`, so
  // this cannot change what was just checked.
  P.migrate(db);

  const repo = new P.SqliteArtifactRepository(db);
  const found = repo.search('ws_h', 'onboarding');
  check('the legacy row is still searchable by title', found.length === 1 && found[0].id === 'ar_legacy', found.map((a) => a.id));
  check('a legacy manifest reads back with a null handoff and overBudget false',
    found[0]?.handoff === null && found[0]?.wordCount === null && found[0]?.overBudget === false, found[0]);
  check('the legacy row is still searchable by summary', repo.search('ws_h', 'older').length === 1);

  const handoff = {
    headline: 'Checkout flow ready for review',
    points: ['Three screens instead of five', 'Guest checkout keeps its zanzibar shortcut'],
    needs: 'Pick a colour for the pay button',
    changed: [{ what: 'Dropped the address step', feedback: null }],
    links: [{ label: 'Preview', url: 'https://example.com/p', kind: 'preview' }],
  };
  const manifest = {
    id: 'ar_new', workspaceId: 'ws_h', missionId: 'm_h', taskId: null, createdByRunId: null,
    type: 'DesignBrief', title: 'Checkout brief', contentRef: 'c2', mediaType: 'text/markdown',
    sha256: 'y', byteSize: 2, schemaVersion: 1, sourceRefs: [], supersedes: null, summary: null,
    createdAt: '2026-09-14T00:00:01.000Z', authorId: null, responsibleId: null, recordedBy: null,
    handoff, wordCount: 412, overBudget: true,
  };
  repo.create(manifest);
  const back = repo.get('ar_new');
  check('an artifact with a handoff, word count and over-budget flag round-trips',
    eq(back?.handoff, handoff) && back?.wordCount === 412 && back?.overBudget === true, back);
  const quiet = { ...manifest, id: 'ar_quiet', title: 'Quiet brief', handoff: null, wordCount: 90, overBudget: false, createdAt: '2026-09-14T00:00:02.000Z' };
  repo.create(quiet);
  const quietBack = repo.get('ar_quiet');
  check('a null handoff and a false flag round-trip too',
    quietBack?.handoff === null && quietBack?.wordCount === 90 && quietBack?.overBudget === false, quietBack);

  const byPoint = repo.search('ws_h', 'zanzibar');
  check('search finds an artifact by a word only in its handoff points', byPoint.length === 1 && byPoint[0].id === 'ar_new', byPoint.map((a) => a.id));
  check('search finds an artifact by its headline and its needs',
    repo.search('ws_h', 'review')[0]?.id === 'ar_new' && repo.search('ws_h', 'colour')[0]?.id === 'ar_new');
  // Link kinds and JSON keys are structure, not prose; indexing them would make "preview" match every artifact with a preview link.
  check('search does not match JSON keys or link kinds', repo.search('ws_h', 'headline').length === 0 && repo.search('ws_h', 'preview').length === 0);

  h.prepare("UPDATE artifacts SET handoff = json_set(handoff, '$.points[1]', 'Guest checkout keeps its shortcut') WHERE id = 'ar_new'").run();
  check('an update reindexes the handoff text', repo.search('ws_h', 'zanzibar').length === 0 && repo.search('ws_h', 'shortcut').length === 1);
  h.prepare("UPDATE artifacts SET handoff = 'not json' WHERE id = 'ar_quiet'").run();
  check('a corrupt handoff column neither breaks writes nor reads', repo.get('ar_quiet')?.handoff === null && repo.search('ws_h', 'quiet').length === 1);
  h.prepare("DELETE FROM artifacts WHERE id = 'ar_quiet'").run();
  check('a delete removes the row from the index', repo.search('ws_h', 'quiet').length === 0);

  const integrity = h.pragma('integrity_check', { simple: true });
  check('integrity_check returns ok', integrity === 'ok', integrity);
  let ftsOk = true;
  try { h.prepare("INSERT INTO artifacts_fts (artifacts_fts) VALUES ('integrity-check')").run(); } catch (e) { ftsOk = String(e); }
  check('the FTS index agrees with the artifacts table', ftsOk === true, ftsOk);
  db.close();
}

section('runtime: fake steps conditioned on the prompt');
{
  const { parseFakeScript } = await import('@tandemise/runtime-generic');
  const parsed = parseFakeScript({ steps: [{ kind: 'message', text: 'x', when: { promptIncludes: 'Tighten' } }] });
  check('a step may carry when.promptIncludes', parsed.ok && parsed.value.steps[0].when?.promptIncludes === 'Tighten', parsed);
  const bad = parseFakeScript({ steps: [{ kind: 'message', text: 'x', when: { promptIncludes: 3 } }] });
  check('a non-string promptIncludes is refused', !bad.ok);
}

/**
 * A real engine over a real SQLite file with the fake runtime, composed as the
 * daemon composes it. Modelled on staffing-check's harness.
 */
async function engineHarness(HOME, component) {
  const { mkdirSync } = await import('node:fs');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { persistenceModule } = persistenceTokens;
  const A = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const {
    integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER,
  } = await import('@tandemise/integrations-core');
  const app = await import('@tandemise/application');

  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component } });
  const container = new Container();
  compose(
    container,
    persistenceModule({ path: paths.db, logger: log }),
    A.createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(A.ARTIFACT_STORE), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: A.renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: A.parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: A.measureArtifact, deriveHandoff: A.deriveHandoff, splitAppendix: A.splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    store: container.resolve(app.ARTIFACT_STORE),
  };
  const recorder = container.resolve(app.EVENT_RECORDER);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 8000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  return { app, container, services, scheduler, repo, recorder, paths, until };
}

section('engine');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');

  // Timeouts in the engine are unref'd; nothing else keeps the script alive between ticks.
  const keepAlive = setInterval(() => {}, 1000);
  // Short: a run's tool socket lives under HOME, and a Unix socket path is capped near 104 bytes.
  const HOME = mkdtempSync(join(tmpdir(), 'the-'));
  const h = await engineHarness(HOME, 'handoff-engine-check');
  const now = () => systemClock.now();

  const brief = (words, { headline = 'Onboarding flow designed', marker = 'onboarding', handoff = true } = {}) => [
    '---', 'type: DesignBrief', 'title: Onboarding design',
    ...(handoff ? ['handoff:', `  headline: ${headline}`] : ['handoff:', '  points: []']),
    'flows:', '  - onboarding', '---', '',
    '# Onboarding', '', `${marker} `.repeat(words).trim(), '',
  ].join('\n');
  const OUT = '.tandemise/out/DesignBrief.md';
  const write = (content, when) => ({ kind: 'write-file', path: OUT, content, ...(when ? { when } : {}) });
  const session = { kind: 'checkpoint', sessionId: 'fake-session-{{runId}}', label: 'session.init' };
  const echo = { kind: 'message', text: 'PROMPT {{prompt}}' };
  const done = { kind: 'complete', summary: 'done' };
  const profile = (name, steps, maxConcurrent = 4) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent,
    createdAt: now(), updatedAt: now(),
  }).id;
  const TIGHTEN = { promptIncludes: 'Tighten' };
  const within = profile('within', [session, echo, write(brief(120)), done]);
  const tightens = profile('tightens', [session, echo, write(brief(700)), write(brief(90, { headline: 'Onboarding flow, tightened' }), TIGHTEN), done]);
  const wordy = profile('wordy', [session, echo, write(brief(700)), done]);
  // No checkpoint: the run has no session, so the tighten pass must run fresh with the draft in its prompt.
  // The prompt is also written to a file: a message event is capped, and the draft cut sits at the end of a long prompt.
  const sessionless = profile('sessionless', [echo, { kind: 'write-file', path: 'prompts/{{runId}}.txt', content: '{{prompt}}' },
    write(brief(4000, { marker: 'zanzibar\n' })), write(brief(80), TIGHTEN), done]);
  const headless = profile('headless', [write(brief(50, { handoff: false })), done]);

  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Handoffs' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const agentOn = (name, profileId) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds: ['design'], runtimeProfileIds: [profileId] }).id;
  const agents = {
    within: agentOn('Within', within), tightens: agentOn('Tightens', tightens), wordy: agentOn('Wordy', wordy),
    sessionless: agentOn('Sessionless', sessionless), headless: agentOn('Headless', headless),
  };

  let seq = 0;
  const addMission = async (t) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Design the onboarding', title: `H${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const row = {
      id: ids.task(), missionId: mission.id, key: t.key, title: t.key, objective: 'o', roleId: t.roleId ?? 'design',
      dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
      approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: t.maxAttempts ?? 2, backoffMs: 0, onExhausted: 'fail' },
      completionGate: t.completionGate ?? null, status: t.status ?? 'READY', statusReason: null,
      attempts: 0, remediatesTaskId: null, repositoryId: t.repositoryId ?? null, executor: t.executor ?? 'agent', waitPolicy: null, orderHint: 0,
      staffingOverride: t.staffingOverride ?? null,
      createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
    };
    h.repo.tasks.add(row);
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, id: row.id };
  };
  const task = (id) => h.repo.tasks.get(id);
  const settled = (id) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status));
  const eventsOf = (missionId, type) => h.repo.events.listByMission(missionId).filter((e) => e.body.type === type);
  const live = (taskId) => {
    const all = h.repo.artifacts.listByTask(taskId);
    const superseded = new Set(all.map((a) => a.supersedes).filter(Boolean));
    return all.filter((a) => !superseded.has(a.id));
  };
  const promptsOf = (taskId) => [...h.repo.runs.listByTask(taskId)]
    .sort((a, b) => a.attempt - b.attempt)
    .map((run) => h.repo.events.listByRun(run.id).find((e) => e.body.type === 'message' && e.body.text.startsWith('PROMPT'))?.body.text ?? '');
  const staffed = (agent, extra = {}) => ({ staffingOverride: { assignees: [agent], ...extra } });

  // ---- (a) a first draft within budget
  const a = await addMission({ key: 'within', ...staffed(agents.within) });
  await settled(a.id);
  {
    const [art] = live(a.id);
    check('(a) a draft within budget succeeds', task(a.id).status === 'SUCCEEDED', `${task(a.id).status}: ${task(a.id).statusReason}`);
    check('(a) no tighten pass is requested', eventsOf(a.mission.id, 'artifact.tighten_requested').length === 0 && h.repo.runs.listByTask(a.id).length === 1);
    check('(a) the summary is the handoff headline', art?.summary === 'Onboarding flow designed' && art?.handoff?.headline === 'Onboarding flow designed', art);
    check('(a) the word count is stored and the artifact is within budget', typeof art?.wordCount === 'number' && art.wordCount >= 120 && art.overBudget === false, art && { w: art.wordCount, o: art.overBudget });
    check('(a) the prompt states the budget for the output', promptsOf(a.id)[0].includes('Main body: at most 500 words for DesignBrief; detail goes under "## Appendix".'));
  }

  // ---- (b) over budget, then a short second draft
  const b = await addMission({ key: 'tightens', ...staffed(agents.tightens) });
  await settled(b.id);
  {
    const all = h.repo.artifacts.listByTask(b.id);
    const [final] = live(b.id);
    const first = all.find((x) => x.id !== final?.id);
    const runs = [...h.repo.runs.listByTask(b.id)].sort((x, y) => x.attempt - y.attempt);
    const requested = eventsOf(b.mission.id, 'artifact.tighten_requested');
    check('(b) the task succeeds', task(b.id).status === 'SUCCEEDED', `${task(b.id).status}: ${task(b.id).statusReason}`);
    check('(b) exactly one tighten pass is requested, naming the type', requested.length === 1 && eq(requested[0].body.types, ['DesignBrief']), requested.map((e) => e.body));
    check('(b) task.attempts is unchanged versus a draft within budget', task(b.id).attempts === 1 && task(b.id).attempts === task(a.id).attempts, task(b.id).attempts);
    check('(b) the final artifact is within budget and carries the new headline', final?.overBudget === false && final?.summary === 'Onboarding flow, tightened', final);
    check('(b) the first artifact is superseded by the tightened one', all.length === 2 && final?.supersedes === first?.id && first?.overBudget === true, all.map((x) => ({ id: x.id, s: x.supersedes, o: x.overBudget })));
    check('(b) no artifact.over_budget is recorded', eventsOf(b.mission.id, 'artifact.over_budget').length === 0);
    const resumed = runs[1] === undefined ? [] : h.repo.events.listByRun(runs[1].id).filter((e) => e.body.type === 'checkpoint' && e.body.label === 'session.resumed');
    check('(b) the tighten run continues the first run\'s session', runs.length === 2 && resumed.length === 1, runs.map((r) => r.status));
    const tightenPrompt = promptsOf(b.id)[1] ?? '';
    check('(b) the tighten feedback is quoted per type',
      tightenPrompt.includes('Tighten DesignBrief: the main body is ') && tightenPrompt.includes('words; the budget is 500. Keep the handoff, move detail under "## Appendix", and cut repetition.'), tightenPrompt.slice(0, 400));
    check('(b) it is framed as an editorial request, not a failed gate',
      !tightenPrompt.includes('did not satisfy') && /not a failure/i.test(tightenPrompt), tightenPrompt.slice(0, 400));
  }

  // ---- (c) always over budget
  const c = await addMission({ key: 'wordy', ...staffed(agents.wordy) });
  await settled(c.id);
  {
    const [final] = live(c.id);
    const over = eventsOf(c.mission.id, 'artifact.over_budget');
    check('(c) one tighten pass, and the task still succeeds', eventsOf(c.mission.id, 'artifact.tighten_requested').length === 1 && task(c.id).status === 'SUCCEEDED' && task(c.id).attempts === 1,
      `${task(c.id).status}: ${task(c.id).statusReason}`);
    check('(c) the artifact is accepted with overBudget true', final?.overBudget === true && final.wordCount > 500, final && { w: final.wordCount, o: final.overBudget });
    check('(c) artifact.over_budget records type, words and budget',
      over.length === 1 && over[0].body.artifactType === 'DesignBrief' && over[0].body.artifactId === final?.id && over[0].body.words === final?.wordCount && over[0].body.budget === 500, over.map((e) => e.body));
    check('(c) an unchanged draft\'s over_budget carries the first run, which wrote it', over[0]?.runId === final?.createdByRunId && over[0]?.runId !== null, { e: over[0]?.runId, a: final?.createdByRunId });
  }

  // ---- (d) a missing headline
  const d = await addMission({ key: 'headless', maxAttempts: 1, ...staffed(agents.headless) });
  await settled(d.id);
  check('(d) a missing handoff headline fails the attempt and the retry feedback names handoff.headline',
    task(d.id).status === 'FAILED' && (task(d.id).retryFeedback ?? '').includes('handoff.headline') && live(d.id).length === 0,
    { s: task(d.id).status, f: task(d.id).retryFeedback });

  // ---- (e) a person completes a step
  const e = await addMission({ key: 'person', executor: 'human', roleId: 'docs' });
  await h.until(() => task(e.id).status === 'AWAITING_HUMAN');
  await h.services.missions.completeTask(caller, e.id, { result: 'The onboarding copy is final and approved by legal. It covers all three steps in detail.' });
  {
    const [art] = live(e.id);
    check('(e) a person\'s artifact gets a derived headline as handoff and summary',
      art?.handoff?.headline === 'The onboarding copy is final and approved by legal.' && art.summary === art.handoff.headline && eq(art.handoff.points, []), art);
    check('(e) it is measured but never over budget', typeof art?.wordCount === 'number' && art.wordCount > 0 && art.overBudget === false, art && { w: art.wordCount, o: art.overBudget });
  }

  // ---- (f) the MissionPlan artifact
  {
    const planned = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Plan the onboarding', title: 'Planned', successCriteria: ['The onboarding has a plan'] });
    await h.services.planning.plan(planned.id);
    const plan = h.repo.artifacts.listByMission(planned.id).find((x) => x.type === 'MissionPlan');
    const body = plan === undefined ? '' : (await h.repo.store.read(plan.id)).body;
    const { parseArtifact: parse } = await import('@tandemise/artifacts');
    check('(f) the mission is awaiting plan approval', h.repo.missions.get(planned.id).status === 'AWAITING_PLAN_APPROVAL', h.repo.missions.get(planned.id).status);
    check('(f) the MissionPlan has a handoff with a needs line while awaiting approval',
      plan?.handoff?.needs === 'Approve the plan to start' && plan.handoff.headline.length > 0 && plan.handoff.headline.length <= 90 && plan.summary === plan.handoff.headline, plan?.handoff);
    // The approval is said once, in needs, which is hidden after the decision; a point would outlive it.
    check('(f) its points state the shape and never repeat the approval', (plan?.handoff?.points ?? []).some((p) => /^\d+ tasks?: /.test(p))
      && !plan.handoff.points.some((p) => /approval/i.test(p)) && plan.handoff.points.length <= 3, plan?.handoff?.points);
    check('(f) the stored plan document satisfies the MissionPlan contract', parse('MissionPlan', body).ok, parse('MissionPlan', body));
    check('(f) the plan is measured but never over budget', typeof plan?.wordCount === 'number' && plan.wordCount > 0 && plan.overBudget === false, plan && { w: plan.wordCount, o: plan.overBudget });

    // Reject, then re-plan, through the services the desktop calls.
    const planOfFeed = (feed) => [...feed.needsYou, ...feed.inProgress, ...feed.done].find((c) => c.key === 'plan');
    const firstRequest = h.repo.approvals.list({ missionId: planned.id, statuses: ['PENDING'] }).find((a) => a.kind === 'plan');
    await h.services.approvals.decide(caller, firstRequest.id, { optionId: 'reject', note: 'Smaller, please.' });
    const afterReject = planOfFeed(h.services.projections.missionFeed(planned.id, caller));
    check('(f) rejecting the plan blocks the mission and the plan card waits on a re-plan',
      h.repo.missions.get(planned.id).status === 'BLOCKED' && afterReject?.planDecision === 'rejected' && afterReject.section === 'needs_you',
      { status: h.repo.missions.get(planned.id).status, afterReject });
    // A note that ends its own sentence must not gain a second period (P0 F1, again seen in the real app).
    check('(f) the blocked reason reads as sentences, with no double period',
      h.repo.missions.get(planned.id).statusReason === 'The plan was rejected: Smaller, please. Re-plan or change the mission goal.',
      h.repo.missions.get(planned.id).statusReason);
    await h.services.planning.begin(planned.id);
    await h.until(() => h.repo.missions.get(planned.id).status === 'AWAITING_PLAN_APPROVAL');
    const requests = h.repo.approvals.list({ missionId: planned.id }).filter((a) => a.kind === 'plan');
    const secondRequest = requests.find((a) => a.status === 'PENDING');
    const afterReplan = planOfFeed(h.services.projections.missionFeed(planned.id, caller));
    check('(f) re-planning after a rejection raises a new plan approval and waits on it again',
      h.repo.missions.get(planned.id).status === 'AWAITING_PLAN_APPROVAL' && secondRequest !== undefined && secondRequest.id !== firstRequest.id
        && requests.find((a) => a.id === firstRequest.id)?.status === 'REJECTED'
        && afterReplan?.planDecision === 'pending' && afterReplan.pendingApproval?.approval.id === secondRequest?.id,
      { status: h.repo.missions.get(planned.id).status, requests: requests.map((a) => a.status), afterReplan: afterReplan?.planDecision });  }

  // ---- (g) the tighten pass runs before reviews
  const g = await addMission({ key: 'reviewed', ...staffed(agents.tightens, { reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] }) });
  await settled(g.id);
  {
    const [final] = live(g.id);
    const card = h.repo.approvals.pendingForTask(g.id)[0];
    const referenced = (card?.evidence ?? []).filter((x) => x.kind === 'artifact').map((x) => x.value);
    check('(g) with a blocking review the task awaits approval after one tighten pass',
      task(g.id).status === 'AWAITING_APPROVAL' && eventsOf(g.mission.id, 'artifact.tighten_requested').length === 1, `${task(g.id).status}: ${task(g.id).statusReason}`);
    check('(g) the approval evidence references the tightened artifact, not the first draft', final !== undefined && eq(referenced, [final.id]), { referenced, final: final?.id });
  }

  // ---- a run without a session tightens fresh, editing the draft it is shown
  const f = await addMission({ key: 'sessionless', ...staffed(agents.sessionless) });
  await settled(f.id);
  {
    const [final] = live(f.id);
    const { readFileSync } = await import('node:fs');
    const second = [...h.repo.runs.listByTask(f.id)].sort((x, y) => x.attempt - y.attempt)[1];
    let prompt = '';
    try { prompt = readFileSync(join(h.paths.mission(ws, f.mission.id), 'prompts', `${second?.id}.txt`), 'utf8'); } catch { /* checked below */ }
    check('fresh tighten: the task succeeds within budget with attempts unchanged',
      task(f.id).status === 'SUCCEEDED' && final?.overBudget === false && task(f.id).attempts === 1, `${task(f.id).status}: ${task(f.id).statusReason}`);
    check('fresh tighten: the prompt carries the previous draft and the tighten feedback',
      (prompt.match(/zanzibar/g) ?? []).length > 100 && prompt.includes('Tighten DesignBrief: the main body is '), prompt.length);
    check('fresh tighten: a long draft is cut for the prompt on a line, with a note', prompt.includes('(draft truncated for length; edit the file in place)')
      && (prompt.match(/zanzibar/g) ?? []).length < 4000, (prompt.match(/zanzibar/g) ?? []).length);
  }

  // ---- a tighten pass that fails keeps the first draft, over budget, and the round still passes
  for (const [name, broken] of [
    ['crashes', { kind: 'fail', code: 'RUNTIME_FAILED', message: 'the model went away', when: TIGHTEN }],
    ['mangles', write(brief(60, { handoff: false }), TIGHTEN)],
  ]) {
    const agent = agentOn(name, profile(name, [session, write(brief(700)), broken, done]));
    const m = await addMission({ key: name, ...staffed(agent) });
    await settled(m.id);
    const arts = h.repo.artifacts.listByTask(m.id);
    const notes = eventsOf(m.mission.id, 'note').filter((x) => /tighten pass/.test(x.body.text));
    check(`failed tighten (${name}): the task succeeds on its first draft, marked over budget`,
      task(m.id).status === 'SUCCEEDED' && task(m.id).attempts === 1 && arts.length === 1 && arts[0].overBudget === true,
      { s: task(m.id).status, r: task(m.id).statusReason, arts: arts.map((x) => x.overBudget) });
    check(`failed tighten (${name}): a timeline note and artifact.over_budget are recorded`,
      notes.length === 1 && eventsOf(m.mission.id, 'artifact.over_budget').length === 1, notes.map((x) => x.body.text));
  }

  // ---- a rewrite still over budget: its over_budget carries the tighten run
  {
    const agent = agentOn('stilllong', profile('stilllong', [session, write(brief(700)), write(brief(650, { marker: 'shorter' }), TIGHTEN), done]));
    const m = await addMission({ key: 'stilllong', ...staffed(agent) });
    await settled(m.id);
    const [final] = live(m.id);
    const runs = [...h.repo.runs.listByTask(m.id)].sort((x, y) => x.attempt - y.attempt);
    const over = eventsOf(m.mission.id, 'artifact.over_budget');
    check('still long: the rewrite is accepted over budget and its event carries the tighten run',
      task(m.id).status === 'SUCCEEDED' && final?.overBudget === true && final.createdByRunId === runs[1]?.id
        && over.length === 1 && over[0].runId === runs[1]?.id && over[0].body.artifactId === final.id,
      { s: task(m.id).status, over: over.map((e) => [e.runId, e.body.artifactId]), runs: runs.map((r) => r.id), final: final?.id });
  }

  // ---- a maxConcurrent: 1 profile never runs two at once, tighten passes included
  {
    // Each run takes 2s and each round's check 1.5s. While the first task checks, the second is offered the
    // profile (a busy task is retried after 1s); unless the first run's slot is kept through the checks, the
    // second task's run is still going when the first task's tighten pass starts. Verified red without the fix.
    const repoDir = join(HOME, 'single-repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const { NO_CHECKS } = await import('@tandemise/domain');
    const repository = h.container.resolve(h.app.REPO_REPOSITORY).create({
      id: ids.repository(), workspaceId: ws, name: 'single', path: repoDir, defaultBranch: 'main', remoteUrl: null,
      checks: { ...NO_CHECKS, test: 'sleep 1.5' },
    });
    // Two workers, so only the profile's own limit stands between the two tasks.
    const workspaces = h.container.resolve(h.app.WORKSPACE_REPOSITORY);
    workspaces.update(ws, { concurrency: { ...workspaces.get(ws).concurrency, maxTotalWorkers: 2 } });
    const single = profile('single', [session, { kind: 'delay', ms: 2000 }, write(brief(700)), write(brief(90), TIGHTEN), done], 1);
    const agent = agentOn('Single', single);
    const gated = { completionGate: 'checks.tests == PASS', repositoryId: repository.id };
    const one = await addMission({ key: 'single_a', ...gated, ...staffed(agent) });
    const two = await addMission({ key: 'single_b', ...gated, ...staffed(agent) });
    await h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(task(one.id).status) && ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(task(two.id).status), 20000);
    const runs = [...h.repo.runs.listByTask(one.id), ...h.repo.runs.listByTask(two.id)].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
    const overlaps = runs.slice(1).filter((r, i) => runs[i].finishedAt === null || r.startedAt < runs[i].finishedAt);
    check('maxConcurrent 1: both tasks tighten and succeed', task(one.id).status === 'SUCCEEDED' && task(two.id).status === 'SUCCEEDED' && runs.length === 4,
      { a: task(one.id).statusReason, b: task(two.id).statusReason, runs: runs.length });
    check('maxConcurrent 1: no two runs of the profile overlap', overlaps.length === 0, runs.map((r) => [r.taskId.slice(-4), r.startedAt.slice(17), r.finishedAt?.slice(17)]));
  }

  // ---- a failed check's own words reach the retry: the gate says only "checks.tests is FAIL", and an agent
  //      told just that re-ran a 15-minute suite hunting a broken test when the check had merely timed out
  {
    const repoDir = join(HOME, 'failing-check-repo');
    mkdirSync(repoDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
    execFileSync('git', ['-C', repoDir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const { NO_CHECKS } = await import('@tandemise/domain');
    const repository = h.container.resolve(h.app.REPO_REPOSITORY).create({
      id: ids.repository(), workspaceId: ws, name: 'failing-check', path: repoDir, defaultBranch: 'main', remoteUrl: null,
      checks: { ...NO_CHECKS, test: 'echo "sum.test: expected 2, got 3" >&2; exit 1' },
    });
    const m = await addMission({ key: 'failing_check', maxAttempts: 1, completionGate: 'checks.tests == PASS', repositoryId: repository.id, ...staffed(agents.within) });
    await settled(m.id);
    const feedback = task(m.id).retryFeedback ?? '';
    check('a failed check: the retry feedback keeps the gate\'s words and adds the check\'s command and output',
      task(m.id).status === 'FAILED' && feedback.includes('checks.tests is FAIL') && feedback.includes('exited 1') && feedback.includes('sum.test: expected 2, got 3'),
      { s: task(m.id).status, f: feedback });
    check('a failed check: the row a person reads stays the gate\'s one line', !(task(m.id).statusReason ?? '').includes('sum.test'), task(m.id).statusReason);
  }

  // ---- a tighten pass already on record for this round is never run again (a restart mid-round)
  const r = await addMission({ key: 'restarted', status: 'PENDING', ...staffed(agents.wordy) });
  h.recorder.record({ workspaceId: ws, missionId: r.mission.id, taskId: r.id, roleId: 'design' },
    { type: 'artifact.tighten_requested', types: ['DesignBrief'], attempt: 1 });
  h.repo.tasks.update(r.id, { status: 'READY' });
  await settled(r.id);
  check('restart: a recorded tighten request for the round prevents a second pass',
    task(r.id).status === 'SUCCEEDED' && eventsOf(r.mission.id, 'artifact.tighten_requested').length === 1
      && h.repo.runs.listByTask(r.id).length === 1 && eventsOf(r.mission.id, 'artifact.over_budget').length === 1,
    { s: task(r.id).status, runs: h.repo.runs.listByTask(r.id).length });

  // ---- a daemon killed during a tighten pass: after recovery the round is settled from its draft
  {
    const { DATABASE } = await import('@tandemise/persistence');
    h.container.resolve(DATABASE).handle.pragma('foreign_keys = OFF');
    const m = await addMission({ key: 'killed', status: 'RUNNING', ...staffed(agents.wordy) });
    h.repo.tasks.update(m.id, { attempts: 1, startedAt: now() });
    const scope = { workspaceId: ws, missionId: m.mission.id, taskId: m.id, roleId: 'design' };
    h.recorder.record(scope, { type: 'task.status', from: 'READY', to: 'RUNNING' });
    const firstRun = ids.run();
    const manifest = await h.repo.store.write({
      workspaceId: ws, missionId: m.mission.id, taskId: m.id, createdByRunId: firstRun, type: 'DesignBrief',
      title: 'Onboarding design', body: brief(700), sourceRefs: [], supersedes: null, summary: 'Onboarding flow designed',
    });
    const draft = h.repo.artifacts.create({ ...manifest, handoff: { headline: 'Onboarding flow designed', points: [], needs: null, changed: [], links: [] }, wordCount: 700, overBudget: true });
    h.recorder.record({ ...scope, runId: firstRun }, { type: 'artifact.tighten_requested', types: ['DesignBrief'], attempt: 1 });
    const base = {
      missionId: m.mission.id, taskId: m.id, assignmentId: ids.workerAssignment(), roleId: 'design', runtimeProfileId: wordy,
      executionTargetId: ids.executionTarget(), pid: null, exitCode: null, errorCode: null, errorMessage: null, usage: null,
      startedAt: now(), finishedAt: now(), heartbeatAt: now(), agentMemberId: agents.wordy,
    };
    h.repo.runs.create({ ...base, id: firstRun, attempt: 1, status: 'SUCCEEDED', externalSessionId: 'fake-session-first' });
    const tightenRun = ids.run();
    h.repo.runs.create({ ...base, id: tightenRun, attempt: 2, status: 'RUNNING', externalSessionId: 'fake-session-first', finishedAt: null });
    await h.container.resolve(h.app.RECOVERY_SERVICE).run();
    await settled(m.id);
    check('restart during tighten: the round settles from its draft with no attempt consumed and no new run',
      task(m.id).status === 'SUCCEEDED' && task(m.id).attempts === 1 && h.repo.runs.listByTask(m.id).length === 2
        && eventsOf(m.mission.id, 'artifact.tighten_requested').length === 1 && live(m.id)[0]?.id === draft.id,
      { s: task(m.id).status, r: task(m.id).statusReason, a: task(m.id).attempts, runs: h.repo.runs.listByTask(m.id).map((r) => r.status) });
    check('restart during tighten: the draft is recorded over budget and the pass\'s session is not left resumable',
      eventsOf(m.mission.id, 'artifact.over_budget').length === 1 && h.repo.runs.get(tightenRun)?.status === 'INTERRUPTED',
      { over: eventsOf(m.mission.id, 'artifact.over_budget').length, run: h.repo.runs.get(tightenRun)?.status });
  }

  // ---- the daemon stops during a tighten pass: the passed round settles instead of going back to the queue
  {
    const agent = agentOn('stalls', profile('stalls', [session, write(brief(700)), { kind: 'delay', ms: 10000, when: TIGHTEN }, done]));
    const m = await addMission({ key: 'stalls', ...staffed(agent) });
    await h.until(() => h.repo.runs.listByTask(m.id).some((r) => r.attempt > 1 && r.status === 'RUNNING'));
    await h.scheduler.stop();
    const runs = [...h.repo.runs.listByTask(m.id)].sort((x, y) => x.attempt - y.attempt);
    check('stop during tighten: the task settles as a passed round with no attempt consumed',
      task(m.id).status === 'SUCCEEDED' && task(m.id).attempts === 1 && live(m.id)[0]?.overBudget === true,
      { s: task(m.id).status, r: task(m.id).statusReason, a: task(m.id).attempts });
    check('stop during tighten: over_budget is recorded and the pass is not left resumable',
      eventsOf(m.mission.id, 'artifact.over_budget').length === 1 && runs.length === 2 && runs[1].status === 'INTERRUPTED',
      { runs: runs.map((r) => r.status) });
  }

  clearInterval(keepAlive);
  await h.container.dispose();
}

section('feed: mission feed and superseded-aware artifact lists (http)');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readFileSync } = await import('node:fs');
  const { ids } = await import('@tandemise/shared');

  // Short on purpose: the daemon's sockets live under HOME, and macOS caps unix socket paths at 104 bytes.
  const HOME = mkdtempSync(join(tmpdir(), 'thf-'));

  // ---- seed in-process, then serve the same home from a real daemon
  const h = await engineHarness(HOME, 'handoff-feed-seed');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Feed' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const anaPerson = h.services.team.createPerson(caller, { displayName: 'Ana' });
  const ana = h.services.team.addMember(caller, ws, { kind: 'person', personId: anaPerson.id, reportsTo: owner }).id;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors by name', title: 'Greeting' });
  h.repo.missions.update(mission.id, { status: 'AWAITING_PLAN_APPROVAL' });

  const at = (minute) => `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const handoff = (headline, extra = {}) => ({ headline, points: [], needs: null, changed: [], links: [], ...extra });
  const addTask = (key, status, extra = {}) => h.repo.tasks.add({
    id: ids.task(), missionId: extra.missionId ?? mission.id, key, title: `Task ${key}`, objective: 'o', roleId: extra.roleId ?? 'design',
    dependsOn: extra.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: extra.expectedOutputs ?? ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status, statusReason: extra.statusReason ?? null, attempts: 1, remediatesTaskId: null, repositoryId: null,
    executor: extra.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null,
    assigneeId: extra.assigneeId ?? null, responsibleId: extra.responsibleId ?? owner,
    staffing: extra.staffing ?? null,
    createdAt: at(0), updatedAt: extra.finishedAt ?? at(30), startedAt: 'startedAt' in extra ? extra.startedAt : at(1), finishedAt: extra.finishedAt ?? null,
  });
  const addArtifact = (taskId, type, extra = {}) => h.repo.artifacts.create({
    id: ids.artifact(), workspaceId: ws, missionId: extra.missionId ?? mission.id, taskId, createdByRunId: null, type,
    title: extra.title ?? `${type} doc`, contentRef: `x/${type}.md`, mediaType: 'text/markdown', sha256: 'a'.repeat(64), byteSize: 10,
    schemaVersion: 1, sourceRefs: [], supersedes: extra.supersedes ?? null, summary: extra.summary ?? null, createdAt: extra.createdAt ?? at(5),
    authorId: extra.authorId ?? owner, responsibleId: owner, recordedBy: extra.recordedBy ?? extra.authorId ?? owner,
    handoff: extra.handoff === undefined ? null : extra.handoff, wordCount: 10, overBudget: extra.overBudget ?? false,
  });
  const addApproval = (kind, taskId, addressees, missionId = mission.id) => h.repo.approvals.create({
    id: ids.approval(), workspaceId: ws, missionId, taskId, runId: null, kind, status: 'PENDING', risk: 'read',
    title: `Approve ${kind}?`, rationale: 'r', effect: 'e', evidence: [], options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: at(20), decidedAt: null, expiresAt: null,
    addressees, escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });

  // The plan: its artifact keeps "Approve the plan to start" forever; the card shows it only while the approval is open.
  addArtifact(null, 'MissionPlan', { handoff: handoff('Four steps to a greeting', { needs: 'Approve the plan to start' }), authorId: 'system' });
  const planApproval = addApproval('plan', null, [owner]);

  // Done: finished at 10, 12 and 14, plus a check that waits on nobody.
  const spec = addTask('spec', 'SUCCEEDED', { finishedAt: at(10), roleId: 'product', expectedOutputs: ['ProductSpec'] });
  const specV1 = addArtifact(spec.id, 'ProductSpec', { handoff: handoff('Spec, first cut'), createdAt: at(6) });
  const specV2 = addArtifact(spec.id, 'ProductSpec', { handoff: handoff('Spec greets by first name', { needs: 'Approve the spec' }), supersedes: specV1.id, createdAt: at(9) });
  const specV3 = addArtifact(spec.id, 'ProductSpec', { handoff: handoff('Spec greets by preferred name'), supersedes: specV2.id, createdAt: at(10) });
  const legacy = addTask('legacy', 'SUCCEEDED', { finishedAt: at(12) });
  addArtifact(legacy.id, 'DesignBrief', { summary: 'An old brief with only a summary' });
  const design = addTask('design', 'SUCCEEDED', { finishedAt: at(14), expectedOutputs: ['DesignBrief', 'Evidence'] });
  addArtifact(design.id, 'Evidence', { handoff: handoff('Screenshots of the flow'), createdAt: at(13) });
  const brief = addArtifact(design.id, 'DesignBrief', { handoff: handoff('Greeting uses the brand type', { points: ['One screen'] }), createdAt: at(12), authorId: ana, recordedBy: owner, overBudget: true });
  // A check addressed to me: non-blocking, but spec §4.1 puts it under "Needs you".
  const checked = addTask('checked', 'SUCCEEDED', { finishedAt: at(16) });
  const checkApproval = addApproval('check', checked.id, [owner]);

  // Needs me: a review addressed to me, and a person task assigned to me.
  const review = addTask('review', 'AWAITING_APPROVAL', { roleId: 'review', expectedOutputs: ['ChangeSet'] });
  addArtifact(review.id, 'ChangeSet', { handoff: handoff('Greeting shipped behind a flag', { needs: 'Approve the change' }) });
  const reviewApproval = addApproval('action', review.id, [owner]);
  const mine = addTask('mine', 'AWAITING_HUMAN', { executor: 'human', assigneeId: owner, statusReason: 'Waiting for you to write the copy' });

  // Waiting on Ana: in progress for me.
  const anas = addTask('anas', 'AWAITING_HUMAN', { executor: 'human', assigneeId: ana, responsibleId: ana, statusReason: 'Waiting for Ana' });
  // Not started, and held behind Ana's task so approving the plan cannot make it ready: no card.
  const later = addTask('later', 'PENDING', { dependsOn: ['anas'] });

  // A second mission, paused so the daemon's scheduler leaves its READY tasks alone.
  const other = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Edge cases', title: 'Edges' });
  h.repo.missions.update(other.id, { status: 'PAUSED' });
  const inOther = { missionId: other.id };
  const retry = addTask('retry', 'READY', { ...inOther, statusReason: null });
  addArtifact(retry.id, 'DesignBrief', { ...inOther, handoff: handoff('Earlier attempt of the brief') });
  addTask('deferred', 'READY', { ...inOther, startedAt: null, statusReason: 'Waiting for a free runtime slot' });
  addTask('fresh', 'READY', { ...inOther, startedAt: null });
  const blockedMine = addTask('blockedMine', 'BLOCKED', { ...inOther, statusReason: 'Out of retries' });
  const intervention = addApproval('intervention', blockedMine.id, [owner], other.id);
  addTask('blockedOther', 'BLOCKED', { ...inOther, roleId: 'ghost', statusReason: 'Gate not met' });
  addTask('escalated', 'AWAITING_HUMAN', {
    ...inOther, executor: 'human', assigneeId: ana, responsibleId: ana, statusReason: 'Waiting for Ana',
    staffing: { staffing: { mode: 'first_available', assignees: [ana] }, executor: 'human', claimable: [], agentCandidateIds: [], humanStep: true, escalatedTo: [owner] },
  });
  const upstream = addTask('upstream', 'SUCCEEDED', { ...inOther, finishedAt: at(20), roleId: 'engineer', expectedOutputs: ['ChangeSet'] });
  const firstChange = addArtifact(upstream.id, 'ChangeSet', { ...inOther, handoff: handoff('Greeting added to the header'), createdAt: at(19) });
  const fix = addTask('fix', 'SUCCEEDED', { ...inOther, finishedAt: at(25), roleId: 'engineer', expectedOutputs: ['ChangeSet'] });
  const fixedChange = addArtifact(fix.id, 'ChangeSet', { ...inOther, handoff: handoff('Greeting escapes the name'), supersedes: firstChange.id, createdAt: at(24) });
  // Two outputs, and a fix replaced the expected primary one: the card keeps that one, marked updated, not the live secondary.
  const multi = addTask('multi', 'SUCCEEDED', { ...inOther, finishedAt: at(18), roleId: 'engineer', expectedOutputs: ['ChangeSet', 'Evidence'] });
  const multiChange = addArtifact(multi.id, 'ChangeSet', { ...inOther, handoff: handoff('Header greeting shipped'), createdAt: at(16) });
  addArtifact(multi.id, 'Evidence', { ...inOther, handoff: handoff('Screenshot of the header'), createdAt: at(17) });
  const multiFix = addTask('multiFix', 'SUCCEEDED', { ...inOther, finishedAt: at(22), roleId: 'engineer', expectedOutputs: ['ChangeSet'] });
  addArtifact(multiFix.id, 'ChangeSet', { ...inOther, handoff: handoff('Header greeting trimmed'), supersedes: multiChange.id, createdAt: at(21) });

  // A third mission, cancelled over HTTP below: what started stays as history, what never started leaves no card.
  const cancelled = await h.services.missions.create(caller, { workspaceId: ws, goal: 'To be cancelled', title: 'Cancelled' });
  h.repo.missions.update(cancelled.id, { status: 'PAUSED' });
  addTask('begun', 'AWAITING_HUMAN', { missionId: cancelled.id, executor: 'human', assigneeId: ana, responsibleId: ana });
  addTask('finished', 'SUCCEEDED', { missionId: cancelled.id, finishedAt: at(10) });
  addTask('neverRan', 'PENDING', { missionId: cancelled.id, startedAt: null, dependsOn: ['begun'] });

  // One pass: every repository read happens at most once, however many cards the feed has.
  {
    const calls = new Map();
    const counted = (name, repo) => new Proxy(repo, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args) => { calls.set(`${name}.${String(prop)}`, (calls.get(`${name}.${String(prop)}`) ?? 0) + 1); return value.apply(target, args); };
      },
    });
    const t = h.app;
    const r = (token) => h.container.resolve(token);
    const deps = {
      workspaces: r(t.WORKSPACE_REPOSITORY), repositories: r(t.REPO_REPOSITORY), missions: r(t.MISSION_REPOSITORY), tasks: r(t.TASK_REPOSITORY),
      runs: r(t.RUN_REPOSITORY), events: r(t.EVENT_REPOSITORY), artifacts: r(t.ARTIFACT_REPOSITORY), approvals: r(t.APPROVAL_REPOSITORY),
      decisions: r(t.DECISION_REPOSITORY), evaluations: r(t.EVALUATION_REPOSITORY), targets: r(t.EXECUTION_TARGET_REPOSITORY), roles: r(t.ROLE_REPOSITORY),
      runtimeProfiles: r(t.RUNTIME_PROFILE_REPOSITORY), members: r(t.MEMBER_REPOSITORY), feedback: r(t.FEEDBACK_REPOSITORY),
    };
    const projections = new t.ProjectionServiceImpl({
      ...Object.fromEntries(Object.entries(deps).map(([name, repo]) => [name, counted(name, repo)])),
      runtimes: r(t.RUNTIME_SERVICE), gates: r(t.GATE_SERVICE), metrics: r(t.METRICS_SERVICE), staffing: r(t.STAFFING_RESOLVER),
    });
    const feed = projections.missionFeed(mission.id, caller);
    const repeated = [...calls].filter(([, n]) => n > 1);
    check('feed: the projection is one pass, with no repository read repeated per card',
      feed.needsYou.length === 4 && repeated.length === 0 && calls.size > 0, { repeated, calls: [...calls], needsYou: feed.needsYou.map((c) => c.key) });
  }
  await h.container.dispose();

  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  const daemon = await startDaemon({ home: HOME, logLevel: 'error', tickIntervalMs: 200 });
  const token = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const keys = (cards) => (cards ?? []).map((c) => c.key);
  const card = (feed, key) => [...(feed?.needsYou ?? []), ...(feed?.inProgress ?? []), ...(feed?.done ?? [])].find((c) => c.key === key);

  try {
    const before = await api('GET', `/v1/missions/${mission.id}/feed`);
    const f0 = before.body;
    check('feed: GET /v1/missions/:id/feed answers a MissionFeedView', before.status === 200 && f0?.missionId === mission.id
      && Array.isArray(f0?.needsYou) && Array.isArray(f0?.inProgress) && Array.isArray(f0?.done) && typeof f0?.doneTotal === 'number', before);
    check('feed: the pending plan approval is in needs_you, with its needs shown',
      f0?.needsYou?.[0]?.key === 'plan' && f0.needsYou[0].taskId === null && f0.needsYou[0].status === 'PLAN' && f0.needsYou[0].section === 'needs_you'
        && f0.needsYou[0].pendingApproval?.approval?.id === planApproval.id && f0.needsYou[0].handoff?.needs === 'Approve the plan to start'
        && f0.needsYou[0].statusReason === planApproval.title && f0.needsYou[0].roleName === null && f0.needsYou[0].planDecision === 'pending',
      f0?.needsYou?.[0]);
    check('feed: a task not yet started has no card', card(f0, 'later') === undefined && !JSON.stringify(f0 ?? {}).includes(later.id));

    const decided = await api('POST', `/v1/approvals/${planApproval.id}/decide`, { optionId: 'approve' });
    check('feed: the plan approval is decided', decided.status === 200, decided.body);

    const after = await api('GET', `/v1/missions/${mission.id}/feed`);
    const f = after.body;
    check('feed: needs_you holds the check and the review for me and my person task, not the decided plan',
      eq(keys(f?.needsYou).sort(), ['checked', 'mine', 'review']), keys(f?.needsYou));
    const r = card(f, 'review');
    check('feed: the review card carries its pending approval, its headline and its open needs',
      r?.pendingApproval?.approval?.id === reviewApproval.id && r.handoff?.headline === 'Greeting shipped behind a flag' && r.handoff?.needs === 'Approve the change'
        && r.status === 'AWAITING_APPROVAL' && r.roleName !== null && r.humanAction === null, r);
    const m = card(f, 'mine');
    check('feed: a person task assigned to me offers complete, with its status reason', m?.humanAction === 'complete' && m.pendingApproval === null
      && m.statusReason === 'Waiting for you to write the copy' && m.taskId === mine.id, m);
    const a = card(f, 'anas');
    check('feed: a task waiting on Ana is in progress, with no action for me',
      eq(keys(f?.inProgress), ['anas']) && card(f, 'later') === undefined && a?.section === 'in_progress' && a.humanAction === null && a.pendingApproval === null && a.doneBy?.name === 'Ana' && a.taskId === anas.id, { inProgress: keys(f?.inProgress), a });
    check('feed: done is newest first with the plan last, and doneTotal counts them all',
      eq(keys(f?.done), ['design', 'legacy', 'spec', 'plan']) && f?.doneTotal === 4, { done: keys(f?.done), total: f?.doneTotal });
    const d = card(f, 'design');
    check('feed: a done card shows the first expected output\'s headline, points and +N more',
      d?.artifactId === brief.id && d.handoff?.headline === 'Greeting uses the brand type' && eq(d.handoff?.points, ['One screen']) && d.moreArtifacts === 1 && d.overBudget === true,
      d);
    check('feed: by and recorded by are named, recorded by only when it differs', d?.doneBy?.name === 'Ana' && d?.recordedBy?.id === owner && d?.responsible?.id === owner
      && card(f, 'review')?.recordedBy === null, { doneBy: d?.doneBy, recordedBy: d?.recordedBy, reviewRecordedBy: card(f, 'review')?.recordedBy });
    check('feed: a legacy artifact without a handoff shows its summary as the headline',
      card(f, 'legacy')?.handoff?.headline === 'An old brief with only a summary' && eq(card(f, 'legacy')?.handoff?.points, []), card(f, 'legacy')?.handoff);
    const s = card(f, 'spec');
    check('feed: a card reads the live version, never a superseded one', s?.artifactId === specV3.id && s.handoff?.headline === 'Spec greets by preferred name' && s.moreArtifacts === 0, s);
    check('feed: a decided plan keeps its handoff but no longer shows needs',
      card(f, 'plan')?.section === 'done' && card(f, 'plan')?.handoff?.headline === 'Four steps to a greeting' && card(f, 'plan')?.handoff?.needs === null && card(f, 'plan')?.pendingApproval === null
        && card(f, 'plan')?.planDecision === 'approved',
      card(f, 'plan'));
    check('feed: a check addressed to me on a finished task is in needs_you, carrying the check',
      card(f, 'checked')?.section === 'needs_you' && card(f, 'checked')?.pendingApproval?.approval?.id === checkApproval.id && card(f, 'checked')?.planDecision === null, card(f, 'checked'));

    const limited = await api('GET', `/v1/missions/${mission.id}/feed?doneLimit=2`);
    check('feed: doneLimit cuts done but not doneTotal', limited.status === 200 && eq(keys(limited.body?.done), ['design', 'legacy']) && limited.body?.doneTotal === 4,
      { done: keys(limited.body?.done), total: limited.body?.doneTotal });
    const bad = await api('GET', `/v1/missions/${mission.id}/feed?doneLimit=-1`);
    check('feed: a negative doneLimit is 400 VALIDATION', bad.status === 400 && bad.body?.error?.code === 'VALIDATION', bad.body);
    const missing = await api('GET', '/v1/missions/mis_nope/feed');
    check('feed: an unknown mission is 404', missing.status === 404, missing.body);

    // ---- edge cases (fix round 1)
    const e = (await api('GET', `/v1/missions/${other.id}/feed`)).body;
    check('feed: a READY retry that already ran is in progress with its last handoff',
      card(e, 'retry')?.section === 'in_progress' && card(e, 'retry')?.handoff?.headline === 'Earlier attempt of the brief', card(e, 'retry'));
    check('feed: a READY task deferred for a runtime is in progress with its reason',
      card(e, 'deferred')?.section === 'in_progress' && card(e, 'deferred')?.statusReason === 'Waiting for a free runtime slot', card(e, 'deferred'));
    check('feed: a fresh READY task with no reason has no card', card(e, 'fresh') === undefined, keys(e?.inProgress));
    check('feed: a BLOCKED task with an intervention for me needs me, with the intervention',
      card(e, 'blockedMine')?.section === 'needs_you' && card(e, 'blockedMine')?.pendingApproval?.approval?.id === intervention.id, card(e, 'blockedMine'));
    check('feed: a BLOCKED task with nothing asked of me is in progress with its reason, and an unknown role has no name',
      card(e, 'blockedOther')?.section === 'in_progress' && card(e, 'blockedOther')?.statusReason === 'Gate not met' && card(e, 'blockedOther')?.roleName === null, card(e, 'blockedOther'));
    check('feed: a person task escalated to me offers claim', card(e, 'escalated')?.section === 'needs_you' && card(e, 'escalated')?.humanAction === 'claim', card(e, 'escalated'));
    const up = card(e, 'upstream');
    check('feed: a done card whose output a fix replaced keeps its headline, marked superseded by the fix',
      up?.section === 'done' && up.artifactId === firstChange.id && up.handoff?.headline === 'Greeting added to the header' && up.superseded === true && up.supersededByTaskKey === 'fix', up);
    const mc = card(e, 'multi');
    check('feed: a multi-output card whose primary was replaced keeps that primary, updated by the fix, and counts the live one as more',
      mc?.artifactId === multiChange.id && mc.handoff?.headline === 'Header greeting shipped' && mc.superseded === true && mc.supersededByTaskKey === 'multiFix' && mc.moreArtifacts === 1, mc);
    check('feed: the fix card leads with its own live output', card(e, 'fix')?.artifactId === fixedChange.id && card(e, 'fix')?.superseded === false && card(e, 'fix')?.supersededByTaskKey === null, card(e, 'fix'));

    const cancelledRes = await api('POST', `/v1/missions/${cancelled.id}/cancel`, { reason: 'check' });
    const c = (await api('GET', `/v1/missions/${cancelled.id}/feed`)).body;
    check('feed: a cancelled mission shows only what started, all in done',
      cancelledRes.status === 200 && eq(keys(c?.done).sort(), ['begun', 'finished']) && c?.needsYou?.length === 0 && c?.inProgress?.length === 0 && c?.doneTotal === 2,
      { status: cancelledRes.status, c });

    // ---- artifacts list
    const listed = await api('GET', `/v1/missions/${mission.id}/artifacts`);
    const listedIds = (listed.body ?? []).map((x) => x.id);
    check('artifacts: the mission list hides superseded versions by default',
      listed.status === 200 && listedIds.includes(specV3.id) && !listedIds.includes(specV1.id) && !listedIds.includes(specV2.id) && listedIds.length === 6, { status: listed.status, n: listedIds.length });
    check('artifacts: list rows carry handoff, wordCount and overBudget',
      (listed.body ?? []).find((x) => x.id === brief.id)?.handoff?.headline === 'Greeting uses the brand type' && (listed.body ?? []).every((x) => 'wordCount' in x && 'overBudget' in x));
    const all = await api('GET', `/v1/missions/${mission.id}/artifacts?includeSuperseded=true`);
    const byId = new Map((all.body ?? []).map((x) => [x.id, x]));
    check('artifacts: includeSuperseded=true returns every version with its number and successor',
      all.status === 200 && byId.size === 8 && byId.get(specV1.id)?.version === 1 && byId.get(specV2.id)?.version === 2 && byId.get(specV3.id)?.version === 3
        && byId.get(specV1.id)?.supersededBy === specV2.id && byId.get(specV2.id)?.supersededBy === specV3.id && byId.get(specV3.id)?.supersededBy === null
        && byId.get(brief.id)?.version === 1,
      [...byId.values()].map((x) => [x.type, x.version, x.supersededBy]));
    const explicitFalse = await api('GET', `/v1/missions/${mission.id}/artifacts?includeSuperseded=false`);
    check('artifacts: includeSuperseded=false hides them too', (explicitFalse.body ?? []).length === 6, explicitFalse.body?.length);

    // The inbox reads through the same "for me" rule the feed uses.
    const inbox = await api('GET', `/v1/inbox?workspaceId=${ws}`);
    check('feed: the inbox still lists the review and both person tasks of the mission', inbox.status === 200
      && (inbox.body?.approvals ?? []).some((v) => v.approval.id === reviewApproval.id) && eq((inbox.body?.tasks ?? []).filter((t) => t.missionId === mission.id).map((t) => t.key).sort(), ['anas', 'mine']), inbox.body);
  } finally {
    await daemon.stop();
  }
}

section('feed: plan card decisions and checks for me');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ids } = await import('@tandemise/shared');
  const HOME = mkdtempSync(join(tmpdir(), 'thp-'));
  const h = await engineHarness(HOME, 'handoff-plan-card');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Plans' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const anaPerson = h.services.team.createPerson(caller, { displayName: 'Ana' });
  const ana = h.services.team.addMember(caller, ws, { kind: 'person', personId: anaPerson.id, reportsTo: owner }).id;
  const asAna = { personId: anaPerson.id };

  const at = (minute) => `2026-09-02T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const newMission = async (title, status) => {
    const m = await h.services.missions.create(caller, { workspaceId: ws, goal: title, title });
    h.repo.missions.update(m.id, { status });
    return m;
  };
  const addPlan = (missionId, createdAt = at(5)) => h.repo.artifacts.create({
    id: ids.artifact(), workspaceId: ws, missionId, taskId: null, createdByRunId: null, type: 'MissionPlan',
    title: 'The plan', contentRef: 'x/plan.md', mediaType: 'text/markdown', sha256: 'a'.repeat(64), byteSize: 10,
    schemaVersion: 1, sourceRefs: [], supersedes: null, summary: null, createdAt, authorId: 'system', responsibleId: owner, recordedBy: 'system',
    handoff: { headline: 'Two steps to a greeting', points: [], needs: 'Approve the plan to start', changed: [], links: [] }, wordCount: 10, overBudget: false,
  });
  const addApproval = (missionId, kind, taskId, addressees, extra = {}) => h.repo.approvals.create({
    id: ids.approval(), workspaceId: ws, missionId, taskId, runId: null, kind, status: extra.status ?? 'PENDING', risk: 'read',
    title: `Approve ${kind}?`, rationale: 'r', effect: 'e', evidence: [], options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: extra.createdAt ?? at(10), decidedAt: null, expiresAt: null,
    addressees, escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });
  const addTask = (missionId, key, status, extra = {}) => h.repo.tasks.add({
    id: ids.task(), missionId, key, title: `Task ${key}`, objective: 'o', roleId: 'design',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status, statusReason: null, attempts: 1, remediatesTaskId: null, repositoryId: null,
    executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null, assigneeId: null, responsibleId: owner, staffing: null,
    createdAt: at(0), updatedAt: extra.updatedAt ?? at(30), startedAt: at(1), finishedAt: status === 'SUCCEEDED' ? at(20) : null,
  });
  const feedOf = (missionId, who = caller) => h.services.projections.missionFeed(missionId, who);
  const planOf = (feed) => [...feed.needsYou, ...feed.inProgress, ...feed.done].find((c) => c.key === 'plan');

  // ---- a rejected plan: "Rejected", and the way forward waits on the person who was asked
  const rejected = await newMission('Rejected plan', 'AWAITING_PLAN_APPROVAL');
  addPlan(rejected.id);
  const rejectedApproval = addApproval(rejected.id, 'plan', null, [owner]);
  await h.services.approvals.decide(caller, rejectedApproval.id, { optionId: 'reject', note: 'Too big' });
  const mineRejected = planOf(feedOf(rejected.id));
  check('plan card: a rejected plan on a BLOCKED mission reads Rejected under needs_you for its owner, with no Approve',
    h.repo.missions.get(rejected.id).status === 'BLOCKED' && mineRejected?.planDecision === 'rejected' && mineRejected.section === 'needs_you'
      && mineRejected.pendingApproval === null && /Re-plan/.test(mineRejected.statusReason ?? '') && mineRejected.handoff?.needs === null,
    mineRejected);
  const anasRejected = planOf(feedOf(rejected.id, asAna));
  check('plan card: the same rejected plan is in progress, not needs_you, for someone it was not addressed to',
    anasRejected?.planDecision === 'rejected' && anasRejected.section === 'in_progress' && anasRejected.pendingApproval === null, anasRejected);
  // Resumed past the rejection: the plan's tasks ran, and a later block is about that work, not the plan.
  const resumedAfter = await newMission('Resumed after rejection', 'AWAITING_PLAN_APPROVAL');
  addPlan(resumedAfter.id);
  const resumedTask = addTask(resumedAfter.id, 'build', 'PENDING');
  h.repo.tasks.update(resumedTask.id, { startedAt: null });
  const resumedApproval = addApproval(resumedAfter.id, 'plan', null, [owner]);
  await h.services.approvals.decide(caller, resumedApproval.id, { optionId: 'reject' });
  const whileBlocked = planOf(feedOf(resumedAfter.id));
  check('plan card: rejected with none of the plan started is open, Re-plan for its owner',
    h.repo.missions.get(resumedAfter.id).status === 'BLOCKED' && whileBlocked?.planDecision === 'rejected' && whileBlocked.section === 'needs_you', whileBlocked);
  await h.services.missions.resume(resumedAfter.id);
  h.repo.missions.update(resumedAfter.id, { status: 'PAUSED' });
  h.repo.tasks.update(resumedTask.id, { status: 'FAILED', startedAt: at(40), finishedAt: at(41), statusReason: 'Out of retries' });
  h.repo.missions.update(resumedAfter.id, { status: 'BLOCKED', statusReason: 'build failed' });
  const laterBlocked = planOf(feedOf(resumedAfter.id));
  check('plan card: rejected, resumed, tasks ran, then BLOCKED for another reason: Done "Rejected", not open, no reason borrowed',
    laterBlocked?.planDecision === 'rejected' && laterBlocked.section === 'done' && laterBlocked.pendingApproval === null && laterBlocked.statusReason === null, laterBlocked);

  h.repo.missions.update(rejected.id, { status: 'CANCELLED' });
  const closedRejected = planOf(feedOf(rejected.id));
  check('plan card: once the mission moved on, a rejected plan is history, still Rejected', closedRejected?.planDecision === 'rejected' && closedRejected.section === 'done', closedRejected);

  // ---- a PENDING plan approval the mission no longer asks about never offers Approve
  const stale = await newMission('Stale plan approval', 'EXECUTING');
  addPlan(stale.id);
  addApproval(stale.id, 'plan', null, [owner]);
  const staleCard = planOf(feedOf(stale.id));
  check('plan card: a leftover PENDING plan approval after the mission moved on is not for me and carries no decision',
    staleCard !== undefined && staleCard.section !== 'needs_you' && staleCard.pendingApproval === null && staleCard.planDecision === 'cancelled' && staleCard.handoff?.needs === null,
    staleCard);

  // ---- cancelled while waiting
  const cancelledWaiting = await newMission('Cancelled while waiting', 'AWAITING_PLAN_APPROVAL');
  addPlan(cancelledWaiting.id);
  addApproval(cancelledWaiting.id, 'plan', null, [owner]);
  await h.services.missions.cancel(cancelledWaiting.id, 'Not now');
  const cancelledCard = planOf(feedOf(cancelledWaiting.id));
  check('plan card: a mission cancelled while its plan waited reads Cancelled, in done, not Approved',
    cancelledCard?.planDecision === 'cancelled' && cancelledCard.section === 'done' && cancelledCard.pendingApproval === null, cancelledCard);

  // ---- accepted without asking, including after a re-plan withdrew an older request
  const auto = await newMission('Auto plan', 'EXECUTING');
  addApproval(auto.id, 'plan', null, [owner], { status: 'CANCELLED', createdAt: at(2) });
  addPlan(auto.id, at(5));
  const autoCard = planOf(feedOf(auto.id));
  check('plan card: a plan with no request of its own reads Auto-approved; an older request from before a re-plan does not count',
    autoCard?.planDecision === 'auto_approved' && autoCard.section === 'done', autoCard);

  // ---- a pending plan still asked: for me it offers Approve, for Ana it waits
  const asking = await newMission('Asking plan', 'AWAITING_PLAN_APPROVAL');
  addPlan(asking.id);
  const askingApproval = addApproval(asking.id, 'plan', null, [owner]);
  const askingMine = planOf(feedOf(asking.id));
  const askingAnas = planOf(feedOf(asking.id, asAna));
  check('plan card: a plan still asked is pending, with Approve only for its addressee',
    askingMine?.planDecision === 'pending' && askingMine.section === 'needs_you' && askingMine.pendingApproval?.approval.id === askingApproval.id
      && askingAnas?.planDecision === 'pending' && askingAnas.section === 'in_progress' && askingAnas.pendingApproval === null,
    { askingMine, askingAnas });

  // ---- checks addressed to me reach needs_you; one for someone else does not; a blocking request outranks a check
  const checks = await newMission('Checks', 'EXECUTING');
  const forMeTask = addTask(checks.id, 'checkMine', 'SUCCEEDED');
  const myCheck = addApproval(checks.id, 'check', forMeTask.id, [owner]);
  const forAnaTask = addTask(checks.id, 'checkAnas', 'SUCCEEDED');
  addApproval(checks.id, 'check', forAnaTask.id, [ana]);
  const bothTask = addTask(checks.id, 'both', 'AWAITING_APPROVAL');
  addApproval(checks.id, 'check', bothTask.id, [owner], { createdAt: at(9) });
  const review = addApproval(checks.id, 'action', bothTask.id, [owner], { createdAt: at(11) });
  const cf = feedOf(checks.id);
  const cardIn = (key) => [...cf.needsYou, ...cf.inProgress, ...cf.done].find((c) => c.key === key);
  check('checks: a check addressed to me appears in needs_you with the check to answer',
    cardIn('checkMine')?.section === 'needs_you' && cardIn('checkMine')?.pendingApproval?.approval.id === myCheck.id && cardIn('checkMine')?.pendingApproval?.approval.kind === 'check',
    cardIn('checkMine'));
  check('checks: a check addressed to someone else stays in done', cardIn('checkAnas')?.section === 'done' && cardIn('checkAnas')?.pendingApproval === null, cardIn('checkAnas'));
  check('checks: when a review and a check both wait on me, the card carries the review', cardIn('both')?.pendingApproval?.approval.id === review.id, cardIn('both')?.pendingApproval?.approval);
  const inboxForMe = h.services.projections.inbox(ws).approvals.some((v) => v.approval.id === myCheck.id);
  check('checks: the same check is in the inbox, so needs_you and for me agree', inboxForMe);

  // The Feed tab counts with planStanding, the rule the section uses; every mission above must agree with its feed.
  {
    const { planStanding } = await import('@tandemise/api-contract/for-me');
    const disagreements = [];
    for (const m of [rejected, resumedAfter, stale, cancelledWaiting, auto, asking]) {
      for (const [who, member] of [[caller, owner], [asAna, ana]]) {
        const mission = h.repo.missions.get(m.id);
        const plan = h.repo.artifacts.listByMission(m.id).find((a) => a.type === 'MissionPlan');
        const standing = planStanding({
          missionStatus: mission.status, planCreatedAt: plan?.createdAt ?? null,
          approvals: h.repo.approvals.list({ missionId: m.id }).map((a) => ({ id: a.id, kind: a.kind, status: a.status, createdAt: a.createdAt, addresseeIds: a.addressees ?? [] })),
          tasks: h.repo.tasks.listByMission(m.id),
        }, member);
        const card = planOf(feedOf(m.id, who));
        if (standing.forMe !== (card?.section === 'needs_you') || standing.decision !== card?.planDecision) disagreements.push({ m: m.title, member, standing, section: card?.section });
      }
    }
    check('feed tab count: planStanding agrees with the plan card section for every case, for me and for Ana', disagreements.length === 0, disagreements);
  }

  await h.container.dispose();
}

section('reader: read view and approval headline');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ids } = await import('@tandemise/shared');
  const HOME = mkdtempSync(join(tmpdir(), 'thr-'));
  const h = await engineHarness(HOME, 'handoff-reader');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Reader' })).workspace.id;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Read things', title: 'Reader' });
  const handoff = { headline: 'The brief in one line', points: ['One'], needs: null, changed: [], links: [] };
  const record = async (body, extra = {}) => {
    const manifest = await h.repo.store.write({
      workspaceId: ws, missionId: mission.id, taskId: null, type: 'DesignBrief', title: 'Brief', body, mediaType: extra.mediaType ?? 'text/markdown',
      supersedes: extra.supersedes ?? null, summary: extra.summary ?? null,
    });
    return h.repo.artifacts.create({ ...manifest, handoff: extra.handoff ?? null, wordCount: 3, overBudget: false });
  };
  const front = '---\ntype: DesignBrief\ntitle: Brief\n---\n';
  const v1 = await record(`${front}# Brief\n\nFirst cut.`, { summary: 'Legacy summary' });
  const v2 = await record(`${front}# Brief\n\nMain words here.\n\n\`\`\`\n## Appendix inside a fence\n\`\`\`\n\n## Appendix\n\nOne two three four.\n`, { supersedes: v1.id, handoff });
  const json = await record('{"a":1}', { mediaType: 'application/json' });

  const read1 = await h.services.artifacts.read(v1.id);
  check('reader: an artifact with no appendix has no split and no appendix words', read1.split === null && read1.appendixWords === null, read1);
  check('reader: the read view is numbered along its versions', read1.manifest.version === 1 && read1.manifest.supersededBy === v2.id, read1.manifest);
  const read2 = await h.services.artifacts.read(v2.id);
  check('reader: the appendix is split at the real heading, not the one in a fence',
    read2.split !== null && read2.split.main.includes('## Appendix inside a fence') && read2.split.appendix === 'One two three four.' && !read2.split.main.includes('type: DesignBrief'), read2.split);
  check('reader: appendix words are counted the way the budget counts them', read2.appendixWords === 4, read2.appendixWords);
  check('reader: the live version reads as v2 with no successor', read2.manifest.version === 2 && read2.manifest.supersededBy === null, read2.manifest);
  const readJson = await h.services.artifacts.read(json.id);
  check('reader: a non-Markdown body is never split', readJson.split === null && readJson.appendixWords === null, readJson);

  const approvalFor = (evidence) => h.repo.approvals.create({
    id: ids.approval(), workspaceId: ws, missionId: mission.id, taskId: null, runId: null, kind: 'action', status: 'PENDING', risk: 'read',
    title: 'Approve?', rationale: 'r', effect: 'e', evidence, options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: new Date().toISOString(), decidedAt: null, expiresAt: null,
    addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });
  const legacy = await record(`${front}# Old\n\nOld text.`, { summary: 'Legacy summary' });
  const withHandoff = approvalFor([{ kind: 'text', label: 'note', value: 'x' }, { kind: 'artifact', label: 'DesignBrief', value: v2.id }]);
  const citesOlder = approvalFor([{ kind: 'artifact', label: 'DesignBrief', value: v1.id }]);
  const legacyCited = approvalFor([{ kind: 'artifact', label: 'DesignBrief', value: legacy.id }]);
  const noArtifact = approvalFor([{ kind: 'text', label: 'note', value: 'x' }]);
  check('approval view: the headline of the first cited artifact', h.services.approvals.get(withHandoff.id).headline === 'The brief in one line');
  check('approval view: a cited older version speaks through its live successor', h.services.approvals.get(citesOlder.id).headline === 'The brief in one line', h.services.approvals.get(citesOlder.id).headline);
  check('approval view: a legacy artifact lends its summary', h.services.approvals.get(legacyCited.id).headline === 'Legacy summary');
  check('approval view: no cited artifact and no task, no headline', h.services.approvals.get(noArtifact.id).headline === null);
  const inbox = h.services.projections.inbox(ws);
  check('approval view: the inbox carries the headline too', inbox.approvals.find((v) => v.approval.id === withHandoff.id)?.headline === 'The brief in one line');

  // ---- needs: shown only while its request is open, by the rule the feed uses
  const now = new Date().toISOString();
  const task = h.repo.tasks.add({
    id: ids.task(), missionId: mission.id, key: 'build', title: 'Build', objective: 'o', roleId: 'development',
    dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['ChangeSet'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: true }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status: 'AWAITING_APPROVAL', statusReason: null, attempts: 1, remediatesTaskId: null, repositoryId: null,
    executor: 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null, assigneeId: null, responsibleId: null, staffing: null,
    createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
  });
  const asked = { headline: 'Greeting behind a flag', points: [], needs: 'Approve the change', changed: [{ what: 'Escapes the name', feedback: 'fb_1' }], links: [] };
  const changeManifest = await h.repo.store.write({ workspaceId: ws, missionId: mission.id, taskId: task.id, type: 'ChangeSet', title: 'Change', body: '# Change\n\nDone.', mediaType: 'text/markdown' });
  const change = h.repo.artifacts.create({ ...changeManifest, handoff: asked, wordCount: 1, overBudget: false });
  const review = h.repo.approvals.create({
    id: ids.approval(), workspaceId: ws, missionId: mission.id, taskId: task.id, runId: null, kind: 'action', status: 'PENDING', risk: 'write_reversible',
    title: 'Accept the change?', rationale: 'r', effect: 'e', evidence: [], options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: now, decidedAt: null, expiresAt: null,
    addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });
  const pendingRead = await h.services.artifacts.read(change.id);
  check('reader: needs is shown while the review is pending', pendingRead.manifest.handoff?.needs === 'Approve the change', pendingRead.manifest.handoff);
  check('reader: an open review names who it waits on (nobody in particular here)', eq(pendingRead.openRequest, { kind: 'approval', addresseeIds: [] }), pendingRead.openRequest);
  check('reader: changed is passed through with its feedback id', eq(pendingRead.manifest.handoff?.changed, asked.changed), pendingRead.manifest.handoff?.changed);
  check('approval view: a task card with no cited artifact quotes the task primary output', h.services.approvals.get(review.id).headline === 'Greeting behind a flag', h.services.approvals.get(review.id).headline);
  h.repo.approvals.update(review.id, { status: 'APPROVED', selectedOptionId: 'approve', decidedAt: now });
  h.repo.tasks.update(task.id, { status: 'SUCCEEDED', finishedAt: now });
  const approvedRead = await h.services.artifacts.read(change.id);
  check('reader: needs is null once the review is approved', approvedRead.manifest.handoff?.needs === null && approvedRead.manifest.handoff?.headline === 'Greeting behind a flag', approvedRead.manifest.handoff);
  check('reader: a closed request has no openRequest', approvedRead.openRequest === null, approvedRead.openRequest);

  // ---- needs for someone else reads as "Waiting for", by the for-me rules the feed uses
  {
    const { isApprovalForMember, isHumanTaskForMember } = await import('@tandemise/api-contract/for-me');
    const me = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
    const addNeedsTask = async (key, status, extra) => {
      const t = h.repo.tasks.add({
        id: ids.task(), missionId: mission.id, key, title: key, objective: 'o', roleId: 'development',
        dependsOn: [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: ['ChangeSet'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
        approvalPolicy: { beforeStart: false, onCompletion: true }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
        completionGate: null, status, statusReason: null, attempts: 1, remediatesTaskId: null, repositoryId: null,
        executor: extra.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null, assigneeId: extra.assigneeId ?? null, responsibleId: null, staffing: null,
        createdAt: now, updatedAt: now, startedAt: now, finishedAt: null,
      });
      const m = await h.repo.store.write({ workspaceId: ws, missionId: mission.id, taskId: t.id, type: 'ChangeSet', title: key, body: '# Change\n\nDone.', mediaType: 'text/markdown' });
      return { task: t, artifact: h.repo.artifacts.create({ ...m, handoff: { ...asked, changed: [] }, wordCount: 1, overBudget: false }) };
    };
    const anaReview = await addNeedsTask('anaReview', 'AWAITING_APPROVAL', {});
    h.repo.approvals.create({
      id: ids.approval(), workspaceId: ws, missionId: mission.id, taskId: anaReview.task.id, runId: null, kind: 'action', status: 'PENDING', risk: 'read',
      title: 'Accept?', rationale: 'r', effect: 'e', evidence: [], options: [{ id: 'approve', label: 'Approve' }],
      recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: now, decidedAt: null, expiresAt: null,
      addressees: ['mem_ana'], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
    });
    const anaRead = await h.services.artifacts.read(anaReview.artifact.id);
    check('reader: a review addressed to someone else carries its addressees and is not for me, so the reader says Waiting for',
      anaRead.openRequest?.kind === 'approval' && eq(anaRead.openRequest.addresseeIds, ['mem_ana']) && !isApprovalForMember(anaRead.openRequest.addresseeIds, me)
        && isApprovalForMember(anaRead.openRequest.addresseeIds, 'mem_ana'), anaRead.openRequest);
    const anaStep = await addNeedsTask('anaStep', 'AWAITING_HUMAN', { executor: 'human', assigneeId: 'mem_ana' });
    const stepRead = await h.services.artifacts.read(anaStep.artifact.id);
    check('reader: a person step assigned to someone else is a person_step that is not for me',
      stepRead.openRequest?.kind === 'person_step' && stepRead.openRequest.assigneeId === 'mem_ana' && !isHumanTaskForMember(stepRead.openRequest, me)
        && stepRead.manifest.handoff?.needs === 'Approve the change', stepRead.openRequest);
  }

  const planManifest = await h.repo.store.write({ workspaceId: ws, missionId: mission.id, taskId: null, type: 'MissionPlan', title: 'Plan', body: '# Plan', mediaType: 'text/markdown' });
  const plan = h.repo.artifacts.create({ ...planManifest, handoff: { ...asked, headline: 'Two steps', needs: 'Approve the plan to start', changed: [] }, wordCount: 1, overBudget: false });
  const planApproval = h.repo.approvals.create({
    id: ids.approval(), workspaceId: ws, missionId: mission.id, taskId: null, runId: null, kind: 'plan', status: 'PENDING', risk: 'read',
    title: 'Approve the plan?', rationale: 'r', effect: 'e', evidence: [{ kind: 'artifact', label: 'MissionPlan', value: plan.id }], options: [{ id: 'approve', label: 'Approve' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: now, decidedAt: null, expiresAt: null,
    addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });
  h.repo.missions.update(mission.id, { status: 'AWAITING_PLAN_APPROVAL' });
  check('reader: a plan asks while the mission awaits plan approval', (await h.services.artifacts.read(plan.id)).manifest.handoff?.needs === 'Approve the plan to start');
  h.repo.approvals.update(planApproval.id, { status: 'APPROVED', selectedOptionId: 'approve', decidedAt: now });
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  check('reader: a plan stops asking once the mission moved on', (await h.services.artifacts.read(plan.id)).manifest.handoff?.needs === null);

  // ---- approval headlines read a mission's artifacts once per call, not once per card
  {
    const artifactsRepo = h.repo.artifacts;
    const counts = { listByMission: 0, get: 0 };
    const original = { listByMission: artifactsRepo.listByMission, get: artifactsRepo.get };
    artifactsRepo.listByMission = function (...args) { counts.listByMission++; return original.listByMission.apply(this, args); };
    artifactsRepo.get = function (...args) { counts.get++; return original.get.apply(this, args); };
    const measure = async (fn) => { counts.listByMission = 0; counts.get = 0; const out = await fn(); return { out, ...counts }; };
    try {
      const listed = await measure(() => h.services.approvals.list({ workspaceId: ws }));
      check('approval cache: the approvals list reads the mission artifacts once for all its cards',
        listed.out.length >= 6 && listed.listByMission === 1 && listed.get <= 1, { n: listed.out.length, listByMission: listed.listByMission, get: listed.get });
      check('approval cache: the list still carries each card its own headline',
        listed.out.find((v) => v.approval.id === citesOlder.id)?.headline === 'The brief in one line'
          && listed.out.find((v) => v.approval.id === legacyCited.id)?.headline === 'Legacy summary'
          && listed.out.find((v) => v.approval.id === noArtifact.id)?.headline === null,
        listed.out.map((v) => [v.approval.id, v.headline]));
      const inboxed = await measure(() => h.services.projections.inbox(ws));
      check('approval cache: the inbox reads the mission artifacts once', inboxed.out.approvals.length >= 4 && inboxed.listByMission === 1, { n: inboxed.out.approvals.length, listByMission: inboxed.listByMission });
      const homed = await measure(() => h.services.projections.home(ws));
      check('approval cache: home reads the mission artifacts once', homed.out.pendingApprovals.length >= 4 && homed.listByMission === 1, { n: homed.out.pendingApprovals.length, listByMission: homed.listByMission });
    } finally {
      artifactsRepo.listByMission = original.listByMission;
      artifactsRepo.get = original.get;
    }
  }

  // ---- search hides superseded versions
  // Both versions are titled "Brief", so the word is in both.
  const hitsV = h.services.artifacts.search(ws, 'brief');
  check('search: a word in both versions finds only the live one', !hitsV.some((a) => a.id === v1.id) && hitsV.some((a) => a.id === v2.id), hitsV.map((a) => a.id));
  check('search: includeSuperseded returns every version', h.services.artifacts.search(ws, 'brief', { includeSuperseded: true }).some((a) => a.id === v1.id));
  check('search: the empty listing hides superseded versions too', !h.services.artifacts.search(ws, '').some((a) => a.id === v1.id));
}

section('person step: what came in, and questions go through ask_human');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ids } = await import('@tandemise/shared');
  const app = await import('@tandemise/application');

  // The planner is told that a worker's questions are asked in the app, never planned as a paste step.
  const mission0 = { id: 'msn_x', title: 'Job post', goal: 'Apply to a job', constraints: [], successCriteria: [], autonomy: 'balanced', workflowPreset: 'feature-delivery' };
  const prompt = app.buildPlannerPrompt({
    mission: mission0, repository: null, roles: [], preset: app.findPreset('feature-delivery'), availableCapabilities: ['reasoning'], repositoryContext: null,
  });
  check('planner: questions for the person go through ask_human, not a person step', /ask_human/.test(prompt) && /never plan a person step to answer/i.test(prompt), prompt.split('# Writing good objectives')[0].slice(-1200));

  // Found on a real mission: intake stopped (the role was US-only) and said so in its handoff, but the
  // person step after it showed only its planned objective, which pointed at a file that was never written.
  const HOME = mkdtempSync(join(tmpdir(), 'thp-'));
  const h = await engineHarness(HOME, 'handoff-person-inputs');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Inputs' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Apply to the Ashby role', title: 'Ashby' });
  h.repo.missions.update(mission.id, { status: 'PAUSED' });
  const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const handoff = (headline, extra = {}) => ({ headline, points: [], needs: null, changed: [], links: [], ...extra });
  const addTask = (key, status, extra = {}) => h.repo.tasks.add({
    id: ids.task(), missionId: mission.id, key, title: `Task ${key}`, objective: extra.objective ?? 'o', roleId: 'research',
    dependsOn: extra.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: extra.inputArtifacts ?? [], expectedOutputs: extra.expectedOutputs ?? ['Evidence'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status, statusReason: null, attempts: 1, remediatesTaskId: null, repositoryId: null,
    executor: extra.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null,
    assigneeId: extra.executor === 'human' ? owner : null, responsibleId: owner, staffing: null,
    createdAt: at(0), updatedAt: at(30), startedAt: at(1), finishedAt: status === 'SUCCEEDED' ? at(10) : null,
  });
  const addArtifact = (taskId, type, extra = {}) => h.repo.artifacts.create({
    id: ids.artifact(), workspaceId: ws, missionId: mission.id, taskId, createdByRunId: null, type,
    title: extra.title ?? `${type} doc`, contentRef: `x/${type}.md`, mediaType: 'text/markdown', sha256: 'a'.repeat(64), byteSize: 10,
    schemaVersion: 1, sourceRefs: [], supersedes: extra.supersedes ?? null, summary: null, createdAt: extra.createdAt ?? at(5),
    authorId: owner, responsibleId: owner, recordedBy: owner, handoff: extra.handoff ?? null, wordCount: 10, overBudget: false,
  });

  const intake = addTask('intake', 'SUCCEEDED');
  const draft = addArtifact(intake.id, 'Evidence', { handoff: handoff('First pass'), createdAt: at(4) });
  const evidence = addArtifact(intake.id, 'Evidence', {
    supersedes: draft.id, createdAt: at(6),
    handoff: handoff('The role is US-only, so I stopped before the CV', { needs: 'Decide: skip it, or ask Ashby whether Panama counts' }),
  });
  // A sibling that is not upstream of the person step: its Evidence is not what the person was handed.
  const sibling = addTask('sibling', 'SUCCEEDED');
  addArtifact(sibling.id, 'Evidence', { handoff: handoff('Unrelated research'), createdAt: at(7) });
  const answer = addTask('answer', 'AWAITING_HUMAN', {
    executor: 'human', dependsOn: ['intake'], inputArtifacts: [{ type: 'Evidence', required: false }], expectedOutputs: ['DecisionRecord'],
  });
  // A person step that declares no inputs still sees what the step before it handed over.
  const noDecl = addTask('nodecl', 'AWAITING_HUMAN', { executor: 'human', dependsOn: ['intake'], expectedOutputs: ['DecisionRecord'] });
  const agentStep = addTask('agentstep', 'PENDING', { dependsOn: ['intake'], inputArtifacts: [{ type: 'Evidence', required: true }] });

  const view = h.services.projections.taskView(answer.id);
  check('a person step lists what came in: the live upstream artifact, with its handoff',
    Array.isArray(view.inputs) && view.inputs.length === 1 && view.inputs[0].id === evidence.id && view.inputs[0].handoff?.needs?.startsWith('Decide: skip it'),
    view.inputs?.map((a) => ({ id: a.id, h: a.handoff?.headline })));
  check('it leaves out a superseded version and a sibling\'s artifact', !view.inputs?.some((a) => a.id === draft.id) && view.inputs?.every((a) => a.taskId === intake.id));
  const nd = h.services.projections.taskView(noDecl.id);
  check('a person step with no declared inputs still sees its dependency\'s live output', nd.inputs?.length === 1 && nd.inputs[0].id === evidence.id, nd.inputs?.map((a) => a.id));
  check('an agent step carries no inputs list (its prompt already has them)', eq(h.services.projections.taskView(agentStep.id).inputs, []));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
