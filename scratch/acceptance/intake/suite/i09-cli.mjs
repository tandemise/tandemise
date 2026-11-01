// I9 — You make a token for the custom source "web-form" in Settings → Intake; a shell pushes a signal with it
// (`tandemise intake push`), and it appears in the Intake tab, filed. Once the item is done in YouTrack,
// `tandemise intake closures` lists its closure, and acking it shows "Closed".
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { checkSourcesNow, cli, intakeStatus, openBoard, yt } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('I9', 'A custom runner pushes with its own token, and reads its closure back');

await page.navigate('#/settings');
await until(() => page.evaluate(`Boolean(document.querySelector('[data-custom-source="web-form"]'))`), { label: 'the custom source', timeoutMs: 20_000 });
await page.evaluate(`document.querySelector('[data-custom-source="web-form"]').scrollIntoView({ block: 'center' })`);
await page.click('Make a token', { within: '[data-custom-source="web-form"]' });
const token = await until(() => page.evaluate(`document.querySelector('[data-custom-source="web-form"] [data-intake-token]')?.innerText.trim() ?? ''`), { label: 'the token, shown once', timeoutMs: 15_000 });
const copy = await page.evaluate(`[...document.querySelectorAll('[data-custom-source="web-form"] button')].some((b) => b.innerText.trim() === 'Copy')`);
ev.check('Make a token shows a tdi_ token once, with Copy', token.startsWith('tdi_') && copy, token.slice(0, 8) + '…');
await page.screenshot(ev.shot('settings-token'));

// A shell elsewhere: only the address and the token, no daemon.json.
const shell = { TANDEMISE_URL: c.env.url, TANDEMISE_INTAKE_TOKEN: token, TANDEMISE_HOME: `${c.env.scratch}/no-home` };
const TITLE = 'Export to CSV drops accents';
const pushed = await cli(['intake', 'push', '--source', 'web-form', '--title', TITLE, '--url', 'https://forms.example.com/replies/18', '--key', 'form-18', '--description', 'Ñandú becomes Nand in the export.'], shell);
ev.check('tandemise intake push exits 0 and prints the fingerprint and status', pushed.code === 0 && pushed.stdout.startsWith('custom:web-form:form-18: '), pushed);
const elsewhere = await cli(['intake', 'push', '--source', 'sentry-web', '--title', 'x', '--url', 'https://x.example.com/1', '--key', 'x1'], shell);
ev.check("the token pushes to its source only: refused in the daemon's words", elsewhere.code === 1 && elsewhere.stderr.includes("This token can only push to 'web-form'."), elsewhere);

await openBoard(c, 'intake');
const fingerprint = 'custom:web-form:form-18';
const filed = await intakeStatus(c, fingerprint, (s) => s.startsWith('Filed as'), 'Filed as …');
ev.check('the signal appears in the Intake tab, filed', /^Filed as ACME-\d+$/.test(filed.status) && filed.title === TITLE, filed);
await page.screenshot(ev.shot('intake-custom'));
const key = filed.status.slice('Filed as '.length);

await yt.edit(key, { state: 'Fixed' });
await openBoard(c);
await checkSourcesNow(c);
const listed = await until(async () => { const r = await cli(['intake', 'closures', '--source', 'web-form'], shell); return r.stdout.includes(fingerprint) && r; }, { label: 'the closure on the feed', timeoutMs: 30_000 });
const line = listed.stdout.split('\n').find((l) => l.includes(fingerprint));
ev.check('tandemise intake closures lists its closure, pending', listed.code === 0 && / custom:web-form:form-18 pending$/.test(line), listed.stdout);
const closureId = line.split(' ')[0];
const acked = await cli(['intake', 'closures', '--source', 'web-form', '--ack', closureId], shell);
ev.check('--ack closes it', acked.code === 0 && acked.stdout.trim() === `${closureId} ${fingerprint} closed`, acked);
await openBoard(c, 'intake');
const closed = await intakeStatus(c, fingerprint, (s) => s === 'Closed', 'Closed');
ev.check('Intake: "Closed"', closed.status === 'Closed', closed);
await sleep(200);
c.close(); ev.save();
