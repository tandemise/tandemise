// N1 — Import from "Your Claude skills": the discovery root is a fixture folder with two good skills and one
// that links outside its folder. The dialog lists all three, the refused one cannot be ticked, a preview shows
// the files and the SKILL.md, and ticking two imports both as v1. A third comes in from "A folder".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, importFolder, libraryRows, library, openImport, openSkills, sectionText, waitRow, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('N1', 'Import skills from your Claude skills folder and from a folder, after a preview');

await openSkills(c);
const empty = await page.text('main');
ev.check('Skills (sidebar) starts empty and says what to do', empty.includes('No skills yet') && empty.includes('Team → Roles'), empty.slice(0, 300));

await openImport(c);
await until(() => page.evaluate(`Boolean(document.querySelector('[aria-label="Found: tdd"]'))`), { label: 'found list', timeoutMs: 15_000 });
const dialog = await c.dialogText('Import skills');
ev.check('the dialog looks in the fixture folder, not the real home', dialog.includes(`${SCRATCH}/claude-skills`), dialog.slice(0, 400));
const foundRows = await page.evaluate(`[...document.querySelectorAll('[aria-label^="Found: "]')].map((r) => r.getAttribute('aria-label')).join('|')`);
ev.check('it lists house-style, shared-notes and tdd', foundRows === 'Found: house-style|Found: shared-notes|Found: tdd', foundRows);
ev.check('shared-notes is refused: "hosts links outside the skill folder"', dialog.includes('hosts links outside the skill folder'), dialog);
const disabled = await page.evaluate(`document.querySelector('[aria-label="Found: shared-notes"] input[type=checkbox]').disabled`);
ev.check('and its box cannot be ticked', disabled === true, disabled);

// Preview tdd before importing anything.
await page.evaluate(`[...document.querySelector('[aria-label="Found: tdd"]').querySelectorAll('button')].find((b) => b.innerText.trim() === 'Preview').click()`);
await until(() => page.evaluate(`Boolean(document.querySelector('[role=dialog] [aria-label="Preview"]'))`), { label: 'preview', timeoutMs: 15_000 });
await sleep(500);
const preview = await sectionText(c, 'Preview');
ev.check('the preview says "New skill" and lists SKILL.md and reference.md', preview.includes('New skill') && preview.includes('SKILL.md') && preview.includes('reference.md'), preview);
ev.check('and shows the SKILL.md itself', preview.includes('Write a test that fails.'), preview);
await page.evaluate(`document.querySelector('[role=dialog] [aria-label="Preview"]').scrollIntoView({ block: 'center' })`);
await sleep(300);
await page.screenshot(ev.shot('preview'));

for (const name of ['tdd', 'house-style']) {
  await page.evaluate(`document.querySelector('[aria-label="Found: ${name}"] input[type=checkbox]').click()`);
  await sleep(200);
}
await page.click('Import 2 skills', { within: '[role=dialog]' });
await until(async () => (await c.dialogText('Import skills')) === '', { label: 'dialog closed', timeoutMs: 20_000 });
const status = await page.evaluate(`[...document.querySelectorAll('[role=status]')].map((s) => s.innerText).join(' ')`);
ev.check('"Imported tdd v1. Imported house-style v1."', status.includes('Imported tdd v1.') && status.includes('Imported house-style v1.'), status);

const folderPreview = await importFolder(c, `${SCRATCH}/more-skills/lint-rules`);
ev.check('A folder: the preview named lint-rules as a new skill', folderPreview.includes('lint-rules') && folderPreview.includes('New skill'), folderPreview);

await waitRow(c, 'lint-rules');
const rows = await libraryRows(c);
ev.check('the Library lists house-style, lint-rules and tdd, each v1', rows.map((r) => r.name).join(',') === 'house-style,lint-rules,tdd' && rows.every((r) => r.text.includes('v1 · ')), rows);
ev.check('with their descriptions', rows.find((r) => r.name === 'tdd')?.text.includes('Write the failing test first'), rows.find((r) => r.name === 'tdd')?.text);
await page.screenshot(ev.shot('library'));

const lib = await library(c);
ev.check('proof (API): three skills, one version each, hashes recorded', lib.length === 3 && lib.every((s) => s.versions.length === 1 && /^[0-9a-f]{64}$/.test(s.latest.hash)), lib.map((s) => [s.name, s.latest.shortHash]));
ev.check('proof (SQL): content stored once per hash under the home', c.sql('SELECT COUNT(DISTINCT hash) AS n FROM skill_versions')[0].n === 3);

writeState({ n1: { hashes: Object.fromEntries(lib.map((s) => [s.name, s.latest.hash])) } });
c.close(); ev.save();
