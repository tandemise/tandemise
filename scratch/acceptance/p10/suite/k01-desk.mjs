// K1 — The desk. WIP limit 2. Mission B's QA verifies 3 of 3, its release exhausts its retries and is left blocked
// (stalled); mission A's QA verifies 1 of 3 and its release exhausts its retries (a card asks the person).
// Home reads "Needs you 2", "Working on 2 of 2", "Criteria verified 4 of 6", "Stalled 1"; the Stalled card opens the
// Inbox showing only B's Stalled row; the Criteria card opens the missions in progress with "1 of 3 verified" and "3 of 3 verified".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { clickCard, cleanSlate, createMission, deskCard, openBacklog, openHome, resetStaffing, setLimit, waitCard, writeState } from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('K1', 'The desk: five numbers, each opening the view behind it');
await cleanSlate(c, ev);
await resetStaffing(c);
await openBacklog(c);
await setLimit(c, '2');
ev.check('proof (API): the work-in-progress limit is 2, set in the window', (await api.get(`/v1/workspaces/${c.env.workspaceId}`)).workspace.maxActiveMissions === 2);

const run = Date.now().toString(36);
const titleOf = async (id) => (await api.get(`/v1/missions/${id}`)).mission.title;

// B first, so its release card is decided before A's (same title) appears.
const b = await createMission(c, `K1 offline mode ${run} SCRIPTED_SPEC_THREE_ACS SCRIPTED_FAIL_RELEASE`, ['The page works offline', 'The page loads in a second']);
const bTitle = await titleOf(b);
await c.approvePlan(b, bTitle);
const bCard = await until(async () => (await c.approvals(b, 'PENDING')).find((x) => x.kind === 'intervention'), { label: 'B release card', timeoutMs: 180_000 });
ev.check('proof (API): B\'s release exhausted its retries', bCard.title.includes('exhausted its retries'), bCard.title);
await c.decideInInbox(bCard.title, { option: 'Leave blocked' });
await until(async () => (await c.approvals(b)).find((x) => x.id === bCard.id)?.status === 'REJECTED', { label: 'left blocked', timeoutMs: 15_000 });

const a = await createMission(c, `K1 greeting page ${run} SCRIPTED_QA_PARTIAL`, ['The page greets the visitor by name', 'The page works offline']);
const aTitle = await titleOf(a);
await c.approvePlan(a, aTitle);
const aCard = await until(async () => (await c.approvals(a, 'PENDING')).find((x) => x.kind === 'intervention'), { label: 'A release card', timeoutMs: 180_000 });
ev.check('proof (API): A\'s release exhausted its retries (a card asks)', aCard.title.includes('exhausted its retries'), aCard.title);
ev.note(`A ${a} "${aTitle}"; B ${b} "${bTitle}"`);
writeState({ k1: { a, aTitle, b, bTitle, aCard: aCard.title } });

await openHome(c);
const needs = await waitCard(c, 'Needs you', 'Needs you 2');
const working = await waitCard(c, 'Working on', 'Working on 2 of 2');
const criteria = await waitCard(c, 'Criteria verified', 'Criteria verified 4 of 6');
const stalled = await waitCard(c, 'Stalled', 'Stalled 1');
const month = await deskCard(c, 'This month');
ev.check('card "Needs you 2"', needs.startsWith('Needs you 2 '), needs);
ev.check('card "Working on 2 of 2"', working.startsWith('Working on 2 of 2 '), working);
ev.check('card "Criteria verified 4 of 6", across 2 missions', criteria.startsWith('Criteria verified 4 of 6 ') && criteria.includes('Across 2 missions in progress'), criteria);
ev.check('card "Stalled 1"', stalled.startsWith('Stalled 1 '), stalled);
ev.check('card "This month" says no monthly limit is set yet', month.startsWith('This month ') && month.includes('No monthly limit set'), month);
await page.screenshot(ev.shot('desk'));
const home = await api.get(`/v1/home?workspaceId=${c.env.workspaceId}`);
ev.check('proof (API): metrics needsYou 2, active 2 of 2, criteria 4 of 6, stalled 1', home.metrics.needsYou === 2 && home.metrics.active === 2 && home.metrics.wipLimit === 2 && home.metrics.criteriaVerified === 4 && home.metrics.criteriaTotal === 6 && home.metrics.stalled === 1, home.metrics);
const inbox = await api.get(`/v1/inbox?workspaceId=${c.env.workspaceId}`);
ev.check('proof (API): B is the one stalled mission, A has the one card', inbox.stalled.length === 1 && inbox.stalled[0].missionId === b && inbox.approvals.filter((x) => x.approval.kind !== 'check').map((x) => x.approval.missionId).join() === a, { stalled: inbox.stalled.map((s) => s.missionTitle), cards: inbox.approvals.map((x) => x.approval.title) });

await clickCard(c, 'Stalled');
const hash = await page.evaluate('location.hash');
await until(async () => (await page.text('main')).includes(`Stalled: ${bTitle}`), { label: 'stalled row', timeoutMs: 15_000 }).catch(() => undefined);
const onlyStalled = await page.text('main');
ev.check('the Stalled card opens the Inbox filtered to stalled missions', hash === '#/inbox/stalled' && onlyStalled.includes('Showing stalled missions only'), hash);
ev.check(`it shows "Stalled: ${bTitle}" with "Retry release"`, onlyStalled.includes(`Stalled: ${bTitle}`) && onlyStalled.includes('Retry release'), onlyStalled.slice(0, 600));
ev.check('and not A\'s card', !onlyStalled.includes('exhausted its retries') && !onlyStalled.includes(aTitle), onlyStalled.slice(0, 600));
await page.screenshot(ev.shot('inbox-stalled-only'));
await page.click('Show everything');
await sleep(1200);
const everything = await page.text('main');
ev.check('"Show everything" brings A\'s card back', everything.includes(aCard.title) && everything.includes(`Stalled: ${bTitle}`), everything.slice(0, 600));

await openHome(c);
await clickCard(c, 'Criteria verified');
const missions = await until(async () => { const t = await page.text('main'); return t.includes('3 of 3 verified') && t; }, { label: 'missions list', timeoutMs: 15_000 }).catch(() => page.text('main'));
const rowOf = (title) => page.evaluate(`[...document.querySelectorAll('.list__row')].find((r) => r.innerText.includes(${JSON.stringify(title)}))?.innerText.replace(/\\s+/g, ' ') ?? ''`);
ev.check('the Criteria card opens Missions filtered to the missions in progress (blocked ones included)', (await page.evaluate('location.hash')) === '#/missions/in-progress' && missions.includes('Showing the 2 missions in progress') && missions.includes(aTitle) && missions.includes(bTitle), missions.slice(0, 500));
ev.check('A\'s row reads "1 of 3 verified", B\'s "3 of 3 verified"', (await rowOf(aTitle)).includes('1 of 3 verified') && (await rowOf(bTitle)).includes('3 of 3 verified'), [await rowOf(aTitle), await rowOf(bTitle)]);
await page.screenshot(ev.shot('missions-criteria'));

await openHome(c);
await clickCard(c, 'Needs you');
ev.check('the Needs you card opens the Inbox', (await page.evaluate('location.hash')) === '#/inbox');
await openHome(c);
await clickCard(c, 'This month');
ev.check('the This month card opens Repositories (its Limits)', (await page.evaluate('location.hash')) === '#/project' && (await page.text('main')).includes('Limits'));
c.close(); ev.save();
