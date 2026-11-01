// K2 — "Status report" on Home, twice. The reader shows the template's headings, "AC2, AC3 not verified" and the gate
// text exactly as A's Inbox card says it; the second report opens as v2 and "Compare with v1" shows no differences.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { interventionText, readState, readerText, writeReport, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('K2', 'A status report written from facts, twice, byte for byte');
const { k1 } = readState();
if (!k1) throw new Error('K2 needs K1 first');

const first = await writeReport(c);
const text = await readerText(c);
ev.check('the report opens in the artifact reader', (await page.evaluate('location.hash')) === `#/artifacts/${first}`);
for (const heading of ['At a glance', 'Missions', 'Backlog', 'How this report was made']) {
  ev.check(`heading "${heading}"`, text.split('\n').some((l) => l.trim() === heading), text.slice(0, 300));
}
ev.check('at a glance: "Needs you: 2", "Working on: 2 of 2", "Criteria verified: 4 of 6", "Stalled: 1"', ['Needs you: 2', 'Working on: 2 of 2 · 0 queued', 'Criteria verified: 4 of 6, across 2 missions in progress', 'Stalled: 1'].every((l) => text.includes(l)), text.split('Missions')[0]);
// The mission sections, below the handoff (whose points name the same missions).
const missionsPart = text.slice(text.indexOf('\nMissions\n'));
const section = (title) => { const rest = missionsPart.split(`\n${title}\n`)[1] ?? ''; return rest.split(/\n(?=K1 |Backlog\n)/)[0]; };
const aPart = section(k1.aTitle);
ev.check(`${k1.aTitle}: "Criteria: 1 of 3 verified; AC2, AC3 not verified."`, aPart.includes('Criteria: 1 of 3 verified; AC2, AC3 not verified.'), aPart.slice(0, 700));
const gateLine = 'Not met: qa.criteria_unverified is 2, needs 0';
ev.check(`${k1.aTitle}: "Last gate failure (release): ${gateLine}"`, aPart.includes(`Last gate failure (release): ${gateLine}`), aPart.slice(0, 700));
const bPart = section(k1.bTitle);
ev.check(`${k1.bTitle}: stalled with its reason and "Next: Retry release."; "3 of 3 verified"`, bPart.includes("Stalled: 'release' is blocked: A human declined to retry this task. Next: Retry release.") && bPart.includes('Criteria: 3 of 3 verified.'), bPart.slice(0, 700));
ev.check('it says how it was made: no model wrote it', text.includes('No model wrote it. The same facts always render the same report.'));
await page.screenshot(ev.shot('report-v1'));

const card = await interventionText(c, 'release');
ev.check(`the Inbox card for A's release says the same words: "${gateLine}"`, card.includes(gateLine), card.slice(0, 900));
await page.screenshot(ev.shot('inbox-card-same-gate-text'));

const second = await writeReport(c);
ev.check('a second report is a new artifact', second !== first, [first, second]);
await until(async () => (await page.evaluate(`[...document.querySelectorAll('[aria-label="Versions"] button')].map((b) => b.innerText.trim()).join(',')`)) === 'v1,v2', { label: 'v1,v2', timeoutMs: 10_000 }).catch(() => undefined);
const versions = await page.evaluate(`[...document.querySelectorAll('[aria-label="Versions"] button')].map((b) => b.innerText.trim() + (b.getAttribute('aria-pressed') === 'true' ? '*' : ''))`);
ev.check('the reader shows v1 and v2, on v2', versions.join(',') === 'v1,v2*', versions);
await page.click('Compare with v1');
await sleep(1200);
const diff = await page.evaluate(`document.querySelector('.diff__summary')?.innerText ?? ''`);
ev.check('"Compare with v1" reads "v1 → v2: 0 lines added, 0 lines removed"', diff.trim() === 'v1 → v2: 0 lines added, 0 lines removed', diff);
await page.screenshot(ev.shot('compare-no-differences'));

const a1 = await api.get(`/v1/artifacts/${first}`);
const a2 = await api.get(`/v1/artifacts/${second}`);
const body = (s) => s.replace(/^---\n[\s\S]*?\n---\n/, '');
ev.check('proof (API): v2 supersedes v1; both StatusReport, by Tandemise', a2.manifest.supersedes === first && a1.manifest.supersededBy === second && a2.manifest.type === 'StatusReport' && a2.manifest.author?.name === 'Tandemise', { supersedes: a2.manifest.supersedes, author: a2.manifest.author });
ev.check('proof (API): the two bodies are byte-identical after the front matter', body(a1.body) === body(a2.body) && body(a1.body).length > 300, [body(a1.body).length, body(a2.body).length]);
ev.check('proof (API): only asOf differs in the front matter', a1.body.replace(/asOf: ".*"/, '') === a2.body.replace(/asOf: ".*"/, ''));
const holder = c.sql('SELECT title, workflow_preset, status FROM missions WHERE id = ?', a2.manifest.missionId)[0];
ev.check('proof (SQL): the reports belong to the project\'s "Status reports" holder, which no list shows', holder?.title === 'Status reports' && holder.workflow_preset === 'status-reports' && !(await api.get(`/v1/missions?workspaceId=${c.env.workspaceId}`)).some((s) => s.mission.id === a2.manifest.missionId), holder);
writeState({ k2: { first, second } });
c.close(); ev.save();
