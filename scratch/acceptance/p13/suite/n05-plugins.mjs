// N5 (#129) — Import from what Claude Code keeps: besides the personal folder, the dialog lists each installed
// plugin's skills (from <config>/plugins/installed_plugins.json, the config folder being the fixture root's, never
// ~/.claude), the project's own .claude/skills, and the skills inside a folder that only groups them. Each sits
// under where it came from; a plugin's skill shows as plugin:skill and imports as plugin-skill.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { SCRATCH, library, openImport, openSkills, sectionText, waitRow } from '../common.mjs';

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const c = await context();
const { page, until, sleep, env } = c;
const ev = new Evidence('N5', 'Find plugin, project and grouped skills, each under where it came from (#129)');

// What Claude Code would have written on installing a team's plugin; the config folder is the fixture root.
const plugin = `${SCRATCH}/plugins/cache/team-market/team/2.4.0`;
put(`${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'team', version: '2.4.0' }));
put(`${plugin}/skills/build-feature/SKILL.md`, '---\nname: build-feature\ndescription: Build a feature the team way, test first.\n---\n\n# Build a feature\n\nPlan, test first, implement, review.\n');
put(`${plugin}/skills/fix-bug/SKILL.md`, '---\nname: fix-bug\ndescription: Fix a bug with a failing test first.\n---\n\n# Fix a bug\n\nReproduce, fix, revert-check.\n');
put(`${SCRATCH}/plugins/installed_plugins.json`, JSON.stringify({
  version: 2,
  plugins: { 'team@team-market': [{ scope: 'user', installPath: plugin, version: '2.4.0', installedAt: '2026-11-01T00:00:00.000Z' }] },
}, null, 2));
// A folder that only groups skills, one level down.
put(`${SCRATCH}/claude-skills/synced/release-notes/SKILL.md`, '---\nname: release-notes\ndescription: Write release notes.\n---\n\nShort, user-facing.\n');
put(`${SCRATCH}/claude-skills/synced/changelog/SKILL.md`, '---\nname: changelog\ndescription: Keep the changelog.\n---\n\nOne line per change.\n');
// The project's own skill, in its checkout (untracked).
put(join(env.project, '.claude/skills/repo-style/SKILL.md'), '---\nname: repo-style\ndescription: How this repository is written.\n---\n\nKeep it short.\n');

await openSkills(c);
await openImport(c);
await until(() => page.evaluate(`Boolean(document.querySelector('[aria-label="Found: team:build-feature"]'))`), { label: 'plugin rows', timeoutMs: 15_000 });
await sleep(400);

const sections = await page.evaluate(`[...document.querySelectorAll('[role=dialog] section[aria-label^="Found in "]')].map((s) => s.getAttribute('aria-label'))`);
ev.check('three sections: your skills, the plugin with its version, the repository', JSON.stringify(sections) === JSON.stringify(['Found in Your skills', 'Found in Plugin team 2.4.0', 'Found in Repository acceptance-project']), sections);
const pluginText = await sectionText(c, 'Found in Plugin team 2.4.0');
ev.check('the plugin section names its marketplace and the folder it read', pluginText.includes('team-market') && pluginText.includes(`${plugin}/skills`), pluginText);
ev.check('its skills read as Claude Code invokes them, and say what they import as', pluginText.includes('team:build-feature') && pluginText.includes('Imports as team-build-feature') && pluginText.includes('team:fix-bug'), pluginText);
const yours = await sectionText(c, 'Found in Your skills');
ev.check('the grouping folder is walked: synced/changelog and synced/release-notes are skills, not one broken folder', yours.includes('synced/changelog') && yours.includes('synced/release-notes') && !yours.includes('No SKILL.md in this folder'), yours);
ev.check('and it says Claude Code itself does not load a nested skill', yours.includes('doesn’t load a skill inside a folder'), yours);
const repoText = await sectionText(c, 'Found in Repository acceptance-project');
ev.check("the repository's own .claude/skills is listed", repoText.includes('repo-style') && repoText.includes(`${env.project}/.claude/skills`), repoText);
await page.evaluate(`document.querySelector('[role=dialog] section[aria-label="Found in Plugin team 2.4.0"]').scrollIntoView({ block: 'start' })`);
await sleep(300);
await page.screenshot(ev.shot('found-by-origin'));

// Preview the plugin skill, then import it with a grouped one.
await page.evaluate(`[...document.querySelector('[aria-label="Found: team:build-feature"]').querySelectorAll('button')].find((b) => b.innerText.trim() === 'Preview').click()`);
await until(() => page.evaluate(`Boolean(document.querySelector('[role=dialog] [aria-label="Preview"]'))`), { label: 'preview', timeoutMs: 15_000 });
await sleep(400);
const preview = await sectionText(c, 'Preview');
ev.check('the preview names it team-build-feature, a new skill, and shows its SKILL.md', preview.includes('team-build-feature') && preview.includes('New skill') && preview.includes('Plan, test first'), preview);
for (const name of ['team:build-feature', 'synced/changelog']) {
  await page.evaluate(`document.querySelector('[aria-label="Found: ${name}"] input[type=checkbox]').click()`);
  await sleep(200);
}
await page.click('Import 2 skills', { within: '[role=dialog]' });
await until(async () => (await c.dialogText('Import skills')) === '', { label: 'dialog closed', timeoutMs: 20_000 });
const status = await page.evaluate(`[...document.querySelectorAll('[role=status]')].map((s) => s.innerText).join(' ')`);
ev.check('"Imported team-build-feature v1. Imported changelog v1."', status.includes('Imported team-build-feature v1.') && status.includes('Imported changelog v1.'), status);
const row = await waitRow(c, 'team-build-feature');
ev.check('the Library row says where it came from: the plugin', row.text.includes('Plugin team'), row.text);
await page.screenshot(ev.shot('library'));

const lib = await library(c);
const imported = lib.find((s) => s.name === 'team-build-feature');
ev.check('proof (API): its source is the plugin folder, with the plugin named', imported?.source?.kind === 'claude' && imported.source.plugin === 'team' && imported.source.path === `${plugin}/skills/build-feature`, imported?.source);

c.close(); ev.save();
