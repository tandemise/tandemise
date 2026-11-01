// R3 — Quiet hours and the test button. Quiet hours set in Settings around the daemon's current time: a new
// decision gives no notification and is held. Once the (test) clock passes their end, one notification
// "After quiet hours: 1 thing needs you" opens that mission. "Send a test notification" shows
// "Notifications are on".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import {
  SECTION, cleanSlate, clearSize, debug, docSize, hhmm, missionAtPlanCard, notifyState, openNotificationSettings, pollTimes, shown, switchOn, waitShown,
} from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('R3', 'Quiet hours hold and summarise once; the test button reaches you');
try {
  await cleanSlate(c, ev);
  await debug(c, 'focus', null);
  await debug(c, 'resume');
  await pollTimes(c, 2);
  const run = Date.now().toString(36);

  // Quiet hours on, in the window, then set around "now" by the daemon's clock.
  await openNotificationSettings(c);
  if (await switchOn(c, 'Quiet hours')) throw new Error('Quiet hours should start off');
  await page.click('Quiet hours', { within: SECTION });
  await until(() => switchOn(c, 'Quiet hours'), { label: 'quiet hours on', timeoutMs: 10_000 });
  const now = Date.parse((await api.post('/v1/test/clock', { advanceMs: 0 })).now);
  const from = hhmm(now - 30 * 60_000);
  const to = hhmm(now + 60 * 60_000);
  await page.fill('From', from);
  await page.fill('To', to);
  await sleep(300);
  await page.click('Save quiet hours', { within: SECTION });
  const section = await page.waitForText('Quiet hours now', { selector: SECTION, timeoutMs: 10_000 }).catch(() => page.text(SECTION));
  ev.check(`the section reads "Quiet hours now" and "${from} to ${to}"`, section.includes('Quiet hours now') && section.includes(`${from} to ${to}`), section.slice(0, 400));
  const prefs = await api.get('/v1/notifications/preferences');
  ev.check('proof (API): quiet hours saved and in force', prefs.quietHours?.from === from && prefs.quietHours?.to === to && prefs.quietNow === true, prefs);
  await docSize(c);
  await openNotificationSettings(c);
  await page.screenshot(ev.shot('settings-quiet-hours'));
  await clearSize(c);

  const count = (await shown(c)).length;
  const m = await missionAtPlanCard(c, `R3 rotate the API keys ${run}`);
  ev.note(`mission ${m.id} "${m.title}", plan card ${m.card.id}`);
  await page.navigate('#/');
  await sleep(1500);
  await pollTimes(c, 3);
  ev.check('during quiet hours: no notification for the new card', (await shown(c)).length === count, (await shown(c)).slice(count));
  ev.check('proof (settings.json): the card is held, not announced', notifyState(c).held.includes(m.card.id) && !notifyState(c).notified.includes(m.card.id), notifyState(c));

  // Setup shortcut for time only: the daemon's test clock moves two hours, past the end of quiet hours.
  await api.post('/v1/test/clock', { advanceMs: 2 * 3_600_000 });
  const list = await waitShown(c, count);
  const notice = list[list.length - 1];
  ev.check('once quiet hours end: one notification "After quiet hours: 1 thing needs you"', list.length === count + 1 && notice.title === 'After quiet hours: 1 thing needs you', notice);
  ev.check('it names the card and the mission, and opens the mission', notice.body === `Decision needed: ${m.card.title} · ${m.title}` && notice.route === `/missions/${m.id}`, notice);
  ev.check('nothing more after it', (await pollTimes(c, 3)) === 0 && (await shown(c)).length === count + 1);
  ev.check('proof (settings.json): held is empty, the card announced', notifyState(c).held.length === 0 && notifyState(c).notified.includes(m.card.id), notifyState(c));
  await debug(c, 'click', list.length - 1);
  await until(async () => (await page.evaluate('location.hash')) === `#/missions/${m.id}`, { label: 'mission route', timeoutMs: 15_000 });
  ev.check('its click opens the mission', (await page.waitForText(m.title, { selector: 'main', timeoutMs: 15_000 })).includes(m.title));

  // The test button, in the window.
  await openNotificationSettings(c);
  const before = (await shown(c)).length;
  await page.click('Send a test notification', { within: SECTION });
  const tests = await waitShown(c, before, 10_000);
  const test = tests[tests.length - 1];
  ev.check('"Send a test notification" shows "Notifications are on"', test.test === true && test.title === 'Notifications are on' && test.body === 'This is how Tandemise will tell you something needs you.', test);
  // The row reports what the system did with it ("… took it …" or "Not delivered: …"), not just that it was sent.
  const said = await until(async () => page.evaluate(`document.querySelector('${SECTION} [data-notify-test-result]')?.textContent || ''`), { label: 'test result', timeoutMs: 10_000 }).catch(() => '');
  ev.check('the window reports whether the system took it', test.delivered ? /took it/.test(said) : /^Not delivered: /.test(said), said);
  ev.check('the test touches nothing in the daemon (no notices on the next poll)', (await pollTimes(c, 2)) === 0);

  await page.click('Quiet hours', { within: SECTION });
  await until(async () => !(await switchOn(c, 'Quiet hours')), { label: 'quiet hours off', timeoutMs: 10_000 });
  const off = await api.get('/v1/notifications/preferences');
  ev.check('quiet hours switched off in the window', off.quietHours === null && off.quietNow === false, off);
} catch (e) {
  ev.check(`scenario ran to the end (${e.message})`, false);
} finally {
  await debug(c, 'resume').catch(() => undefined);
  await api.put('/v1/notifications/preferences', { quietHours: null }).catch(() => undefined);
  ev.save();
  page.close();
}
