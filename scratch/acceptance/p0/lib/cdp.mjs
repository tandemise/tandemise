// Drives the real desktop window over the Chrome DevTools Protocol.
//
// The desktop under test is launched with --remote-debugging-port and its own
// --user-data-dir, so this never touches a window the user has open. Only
// Node 22 built-ins are used (global WebSocket, fetch).
import { writeFileSync } from 'node:fs';
import { sleep } from './api.mjs';

export async function connect(port = 9333, { timeoutMs = 60_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let target;
  while (Date.now() < end) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (target) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!target) throw new Error(`no page target on port ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  let listener = null;
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
    } else if (data.method && listener !== null) {
      // A protocol event (Fetch.requestPaused, ...), for a scenario that set `page.onEvent`.
      listener(data);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };

  const page = {
    /** Receives every protocol event (`{ method, params }`) while set; null to stop. */
    set onEvent(fn) { listener = fn; },
    send, evaluate,
    close: () => ws.close(),
    async navigate(hash) {
      await evaluate(`location.hash = ${JSON.stringify(hash)}`);
      await sleep(600);
    },
    /** Visible text of the main content area (or a selector). */
    text: (selector = 'body') => evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`),
    async waitForText(needle, { selector = 'body', timeoutMs = 30_000 } = {}) {
      const end = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < end) {
        last = await page.text(selector);
        if (typeof needle === 'string' ? last.includes(needle) : needle.test(last)) return last;
        await sleep(400);
      }
      throw new Error(`text ${needle} not found in ${selector}; last text:\n${last.slice(0, 1500)}`);
    },
    /** Clicks the smallest visible element whose own text matches exactly (buttons, links, tabs). */
    async click(label, { within = 'body', nth = 0 } = {}) {
      const ok = await evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(within)}) ?? document.body;
        const want = ${JSON.stringify(label)};
        const els = [...root.querySelectorAll('button, a, [role=button], [role=tab], [role=menuitem], [role=option], label, summary')]
          .filter((el) => el.offsetParent !== null && ((t) => t === want || (want.endsWith('…') && t.startsWith(want.slice(0, -1))))((el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, " ")));
        const el = els[${nth}];
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`);
      if (!ok) throw new Error(`no clickable element labelled "${label}" in ${within}`);
      await sleep(400);
    },
    /** Sets a React-controlled input/textarea/select found by its label text, placeholder or aria-label. */
    async fill(label, value) {
      const ok = await evaluate(`(() => {
        const want = ${JSON.stringify(label)};
        const byLabel = [...document.querySelectorAll('label')].find((l) => l.innerText.trim().startsWith(want));
        let el = byLabel?.control ?? byLabel?.querySelector('input,textarea,select');
        el ??= [...document.querySelectorAll('input,textarea,select')].find((e) => (e.placeholder ?? "").startsWith(want) || e.getAttribute("aria-label") === want);
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error(`no field labelled "${label}"`);
      await sleep(250);
    },
    /** Picks an <option> by its visible text in the select whose label starts with `label`. */
    async select(label, optionText, { nth = 0 } = {}) {
      const ok = await evaluate(`(() => {
        const want = ${JSON.stringify(label)};
        const sels = [...document.querySelectorAll('select')].filter((s) => s.offsetParent !== null && (
          (s.labels?.[0]?.innerText ?? '').trim().startsWith(want) || s.getAttribute('aria-label') === want));
        const el = sels[${nth}];
        if (!el) return 'no select';
        const opt = [...el.options].find((o) => o.text.trim() === ${JSON.stringify(optionText)} || o.text.trim().startsWith(${JSON.stringify(optionText)}));
        if (!opt) return 'no option: ' + [...el.options].map((o) => o.text).join(' | ');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (ok !== true) throw new Error(`select "${label}" → "${optionText}": ${ok}`);
      await sleep(300);
    },
    /** Clicks a button whose text starts with `prefix` inside the element whose text contains `rowText`. */
    async clickIn(rowText, prefix, { rowSelector = 'li,article,section,[class*=row],[class*=card],div' } = {}) {
      const ok = await evaluate(`(() => {
        const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})]
          .filter((r) => r.offsetParent !== null && r.innerText.includes(${JSON.stringify(rowText)}));
        rows.sort((a, b) => a.innerText.length - b.innerText.length);
        for (const row of rows) {
          const b = [...row.querySelectorAll('button,a,[role=button],[role=tab]')].find((x) => x.offsetParent !== null && (x.innerText || x.getAttribute('aria-label') || '').trim().startsWith(${JSON.stringify(prefix)}));
          if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; }
        }
        return false;
      })()`);
      if (!ok) throw new Error(`no "${prefix}" button in a row containing "${rowText}"`);
      await sleep(500);
    },
    /**
     * Puts a file into the `<input type=file>` matched by `selector`, as picking it in the native dialog
     * would: the File is built in the page and set through a DataTransfer, then `change` fires, so the
     * app's own handler reads it (P3). `text` or `bytes` (a Buffer or Uint8Array) is its content.
     */
    async attachFile(selector, { name, type = 'application/octet-stream', text, bytes }) {
      const data = Buffer.from(text !== undefined ? Buffer.from(text, 'utf8') : bytes).toString('base64');
      const ok = await evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input || input.type !== 'file') return false;
        const raw = atob(${JSON.stringify(data)});
        const content = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) content[i] = raw.charCodeAt(i);
        const transfer = new DataTransfer();
        transfer.items.add(new File([content], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error(`no file input matches ${selector}`);
      await sleep(700);
    },
    async screenshot(path) {
      // An occluded or hidden window never answers; fail loudly instead of hanging the scenario.
      const { data } = await Promise.race([
        send('Page.captureScreenshot', { format: 'png' }),
        sleep(30_000).then(async () => { throw new Error(`screenshot timed out (visibility: ${await evaluate('document.visibilityState').catch(() => '?')})`); }),
      ]);
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return page;
}
