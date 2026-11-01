/**
 * Drives the factory's window over CDP (docs/FACTORY-DOGFOOD.md).
 *
 *   node scripts/factory-cdp.mjs text                  the window's text
 *   node scripts/factory-cdp.mjs go '#/board'          navigate
 *   node scripts/factory-cdp.mjs click 'Start' [n]     the n-th button, link or tab with that label (default 0)
 *   node scripts/factory-cdp.mjs buttons               every visible button's label
 *   node scripts/factory-cdp.mjs fields                every visible field, its label and value
 *   node scripts/factory-cdp.mjs fill 'Label' 'value'  set the field whose label starts with 'Label'
 *   node scripts/factory-cdp.mjs shot [name]           a PNG under $FACTORY_HOME/shots/
 *   node scripts/factory-cdp.mjs screen                the held terminal's rows
 *   node scripts/factory-cdp.mjs type 'text'           type into the held terminal, then Enter
 *   node scripts/factory-cdp.mjs key Down|Up|Enter|Esc a key into the held terminal
 *
 * The port is $FACTORY_HOME/cdp-port, written by scripts/factory.sh start.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.FACTORY_HOME ?? join(homedir(), '.tandemise-factory');
const port = Number(readFileSync(join(home, 'cdp-port'), 'utf8').trim());
const [command, a1, a2] = process.argv.slice(2);

const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = tabs.find((t) => t.type === 'page');
if (!target) { console.error(`no window on CDP port ${port}`); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
await new Promise((resolve) => { ws.onopen = resolve; });
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? `error: ${r.result.exceptionDetails.text}` : r.result?.result?.value;
};
// A window that is not on screen may not paint; a tiny screenshot makes it.
const paint = () => send('Page.captureScreenshot', { format: 'jpeg', quality: 1, clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { Down: ['ArrowDown', 40], Up: ['ArrowUp', 38], Esc: ['Escape', 27], Enter: ['Enter', 13] };
const press = async (name) => {
  const [key, code] = KEYS[name];
  const text = name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
  await send('Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};
const focusTerminal = () => run(`(() => { const t = document.querySelector('.terminal-panel .xterm-helper-textarea'); t?.focus(); return Boolean(t); })()`);

let out;
await paint();
switch (command) {
  case 'text': out = await run('document.body.innerText'); break;
  case 'go': await run(`location.hash = ${JSON.stringify(a1)}`); await sleep(600); out = a1; break;
  case 'click':
    out = await run(`(() => {
      const els = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=menuitem]')]
        .filter((b) => (b.innerText || b.getAttribute('aria-label') || '').trim() === ${JSON.stringify(a1)});
      const b = els[${Number(a2 ?? 0)}];
      if (!b) return 'not found (' + els.length + ' with that label)';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    })()`);
    break;
  case 'buttons':
    out = await run(`[...document.querySelectorAll('button, [role=tab]')].filter((b) => b.offsetParent !== null)
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : '')).join('\\n')`);
    break;
  case 'fields':
    out = await run(`[...document.querySelectorAll('input, textarea, select')].filter((e) => e.offsetParent !== null)
      .map((e) => (e.labels?.[0]?.innerText ?? e.getAttribute('aria-label') ?? '').split('\\n')[0] + ' = ' + JSON.stringify(e.type === 'checkbox' ? e.checked : e.value)).join('\\n')`);
    break;
  case 'fill':
    // React keeps its own copy of a field's value: set it through the prototype, then tell React.
    out = await run(`(() => {
      const el = [...document.querySelectorAll('input, textarea, select')].filter((e) => e.offsetParent !== null)
        .find((e) => (e.labels?.[0]?.innerText ?? e.getAttribute('aria-label') ?? '').trim().startsWith(${JSON.stringify(a1)}));
      if (!el) return 'no field labelled ' + ${JSON.stringify(a1)};
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(a2)});
      for (const type of ['input', 'change', 'focusout']) el.dispatchEvent(new Event(type, { bubbles: true }));
      return el.value;
    })()`);
    break;
  case 'shot': {
    const dir = join(home, 'shots');
    mkdirSync(dir, { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    out = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${a1 ?? 'window'}.png`);
    writeFileSync(out, Buffer.from(r.result.data, 'base64'));
    break;
  }
  case 'screen':
    out = await run(`[...document.querySelectorAll('.terminal-panel .xterm-rows > div')]
      .map((r) => r.textContent.replace(/\\u00a0/g, ' ').trimEnd()).filter(Boolean).join('\\n')`);
    break;
  case 'type':
    if (!await focusTerminal()) { out = 'no held terminal is open'; break; }
    await send('Input.insertText', { text: a1 });
    await sleep(150);
    await press('Enter');
    out = 'typed';
    break;
  case 'key':
    if (!KEYS[a1]) { out = `keys: ${Object.keys(KEYS).join(', ')}`; break; }
    if (!await focusTerminal()) { out = 'no held terminal is open'; break; }
    await press(a1);
    out = 'pressed';
    break;
  default:
    console.error('usage: node scripts/factory-cdp.mjs text|go|click|buttons|fields|fill|shot|screen|type|key …');
    process.exit(2);
}
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
ws.close();
process.exit(0);
