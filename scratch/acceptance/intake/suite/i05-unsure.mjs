// I5 — A similar-but-unsure signal (a web form's "Checkout fails", close to ACME-1 "Checkout fails on Safari"):
// the Inbox asks "Is this the same as ACME-1?"; Same task removes the card, and Intake says "Linked to ACME-1".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { intakeStatus, openBoard, yt } from '../common.mjs';

const c = await context();
const { page, until } = c;
const ev = new Evidence('I5', 'An unsure match is asked in the Inbox, and Same task links it');

const pushed = await c.api.post(`/v1/intake/signals?workspace=${c.env.workspaceId}&source=web-form`, {
  schema: 'tandemise.intake/v1', source: { kind: 'custom', instance: 'web-form' }, key: 'form-17',
  url: 'https://forms.example.com/replies/17', title: 'Checkout fails',
  description: 'I tried to pay three times and it never went through.',
});
const fingerprint = pushed.results[0].fingerprint;
await until(async () => (await c.api.get(`/v1/workspaces/${c.env.workspaceId}/intake/signals`)).find((s) => s.fingerprint === fingerprint && s.status === 'needs_decision'), { label: 'needs a decision', timeoutMs: 30_000 });

await page.navigate('#/inbox');
const card = await until(() => page.evaluate(`document.querySelector('[data-intake-decision]')?.innerText ?? ''`), { label: 'the Inbox card', timeoutMs: 30_000 });
ev.check('the Inbox asks "Is this the same as ACME-1?"', card.includes('Is this the same as ACME-1?'), card);
ev.check('…shows the candidate and the three answers', card.includes('Checkout fails on Safari') && ['Same task', 'New task', 'Not work'].every((b) => card.includes(b)), card);
await page.screenshot(ev.shot('inbox-decision'));
await page.click('Same task', { within: '[data-intake-decision]' });
await until(() => page.evaluate(`document.querySelector('[data-intake-decision]') === null`), { label: 'the card gone', timeoutMs: 20_000 });
ev.check('Same task removes the card', true);

await openBoard(c, 'intake');
const row = await intakeStatus(c, fingerprint, (s) => s.startsWith('Linked'), 'Linked to ACME-1');
ev.check('Intake: "Linked to ACME-1"', row.status === 'Linked to ACME-1', row);
ev.check('proof (fake YouTrack): still one create', (await yt.creates()).length === 1, (await yt.creates()).length);
c.close(); ev.save();
