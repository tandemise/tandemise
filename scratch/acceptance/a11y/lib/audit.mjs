// The accessibility probes the a11y suite runs on every screen and state of the real window, over CDP.
//
//   axe(page)            axe-core's WCAG 2.0/2.1 A and AA rules; every violation, with its nodes
//   structure(page)      exactly one <main>, exactly one h1, no skipped heading level, nav and banner landmarks
//   iconNames(page)      every button, link and form control has an accessible name (an icon-only control is the usual miss)
//   keyboard(page)       Tab from the top: the skip link comes first, every stop shows a focus indicator, no trap
//   reflow(page)         at 320 CSS px wide (1280 at 400%), nothing scrolls in two dimensions and no text is cut off
//   textSpacing(page)    WCAG 1.4.12 spacing applied: no text is clipped by its box
//
// Each returns { ok, problems: [...] } (axe returns its violations as problems). Only Node built-ins and
// axe-core (a dev dependency of the repo) are used.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The WCAG levels the owner binds the app to (WCAG 2.1 AA, which includes 2.0 A/AA). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export async function axe(page, { context = 'document' } = {}) {
  if ((await page.evaluate('typeof window.axe')) !== 'object') await page.evaluate(`${AXE_SOURCE};0`);
  const violations = await page.evaluate(`(async () => {
    const result = await window.axe.run(${context}, {
      runOnly: { type: 'tag', values: ${JSON.stringify(WCAG_TAGS)} },
      resultTypes: ['violations'],
    });
    return result.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      criteria: v.tags.filter((t) => /^wcag\\d{3,}$/.test(t)),
      nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 240), summary: (n.failureSummary || '').slice(0, 400) })),
    }));
  })()`);
  return { ok: violations.length === 0, problems: violations };
}

/** Landmarks and headings (1.3.1, 2.4.1, 2.4.6): one main, one h1, levels that never skip, a nav. */
export async function structure(page, { nav = true } = {}) {
  const problems = await page.evaluate(`(() => {
    const out = [];
    // Rendered: not display:none, not visibility:hidden, and not inside a closed <details> (content-visibility).
    const visible = (el) => el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    // An open modal makes the rest of the page inert; its own heading is the h2 under the page's h1.
    const mains = [...document.querySelectorAll('main, [role=main]')];
    if (mains.length !== 1) out.push('expected exactly one main landmark, found ' + mains.length);
    const levelOf = (h) => Number(h.getAttribute('aria-level') || h.tagName.slice(1));
    const h1s = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter((h) => visible(h) && levelOf(h) === 1 && !h.closest('[aria-hidden=true]'));
    if (h1s.length !== 1) out.push('expected exactly one visible h1, found ' + h1s.length + (h1s.length ? ': ' + h1s.map((h) => JSON.stringify(h.innerText.slice(0, 40))).join(', ') : ''));
    if (${nav} && !document.querySelector('nav, [role=navigation]')) out.push('no navigation landmark');
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].filter(visible)
      .map((h) => ({ level: Number(h.getAttribute('aria-level') || h.tagName.slice(1)), text: h.innerText.trim().slice(0, 50) }));
    let last = 0;
    for (const h of headings) {
      if (last > 0 && h.level > last + 1) out.push('heading level skips from h' + last + ' to h' + h.level + ' at ' + JSON.stringify(h.text));
      if (!h.text) out.push('empty h' + h.level);
      last = h.level;
    }
    if (!document.title) out.push('the document has no title');
    return out;
  })()`);
  return { ok: problems.length === 0, problems };
}

/** 4.1.2 / 2.5.3: every control has a name, and an icon-only one is never named by a `title` alone. */
export async function iconNames(page) {
  const problems = await page.evaluate(`(() => {
    const out = [];
    const visible = (el) => el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    const nameOf = (el) => {
      const labelled = el.getAttribute('aria-labelledby');
      if (labelled) return labelled.split(/\\s+/).map((id) => document.getElementById(id)?.innerText ?? '').join(' ').trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      if (el.labels && el.labels.length) return [...el.labels].map((l) => l.innerText).join(' ').trim();
      const text = (el.innerText || '').trim();
      if (text) return text;
      const img = el.querySelector('img[alt]');
      return img ? img.alt.trim() : '';
    };
    const controls = document.querySelectorAll('button, a[href], [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=radio], input:not([type=hidden]), select, textarea');
    for (const el of controls) {
      if (!visible(el) || el.closest('[aria-hidden=true]') || el.closest('.xterm')) continue;
      if (el.matches('input[type=radio], input[type=checkbox]') && el.closest('label')) continue;
      if (!nameOf(el)) out.push('no accessible name: ' + el.outerHTML.slice(0, 160));
    }
    return out;
  })()`);
  return { ok: problems.length === 0, problems };
}

/** Describes the focused element: a stable key, its name, whether a focus indicator shows, and where it lives. */
const FOCUS_PROBE = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { key: 'body', body: true };
  const path = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    const i = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
    path.unshift(n.tagName.toLowerCase() + ':' + i);
  }
  const ring = (n) => {
    const s = getComputedStyle(n);
    const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1 && s.outlineColor !== 'rgba(0, 0, 0, 0)' && s.outlineColor !== 'transparent';
    return { outline, shadow: s.boxShadow !== 'none' };
  };
  const own = ring(el);
  // A visually hidden input shows focus on its label or wrapper (a radio segment, a switch).
  let indicator = own.outline || own.shadow;
  const r = el.getBoundingClientRect();
  const tiny = r.width < 2 || r.height < 2;
  for (let n = el.parentElement, depth = 0; !indicator && n && depth < 3; n = n.parentElement, depth++) {
    const s = getComputedStyle(n);
    if ((s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) || (tiny && s.boxShadow !== 'none')) indicator = true;
  }
  const target = tiny && el.parentElement ? el.parentElement.getBoundingClientRect() : r;
  const onScreen = target.bottom > 0 && target.right > 0 && target.top < innerHeight && target.left < innerWidth && target.width > 0 && target.height > 0;
  return {
    key: path.join('/'),
    tag: el.tagName.toLowerCase(),
    name: (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
    indicator, onScreen,
    terminal: !!el.closest('.xterm'),
    inDialog: !!el.closest('[role=dialog], [role=alertdialog]'),
    inMain: !!el.closest('main'),
    inNav: !!el.closest('nav, aside'),
    skip: /skip to/i.test(el.innerText || ''),
  };
})()`;

export async function press(page, key, { shift = false, ctrl = false } = {}) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, F6: 117, ' ': 32 };
  const modifiers = (shift ? 8 : 0) | (ctrl ? 2 : 0);
  const base = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode: codes[key] ?? 0, nativeVirtualKeyCode: codes[key] ?? 0, modifiers };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Tabs through the page from the top. Passes when the walk comes back to where it started (or to the
 * document) without a stop that hides its focus. In a modal the cycle stays inside it, which is intended.
 * `expectSkip` asks that the first stop be the skip link.
 */
export async function keyboard(page, { max = 160, expectSkip = true, modal = false } = {}) {
  const problems = [];
  await page.evaluate(`(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.focus(); })()`);
  if (!modal) {
    // Start from the very top of the document, as a person arriving on the screen would.
    await page.evaluate(`(() => { const a = document.createElement('span'); a.tabIndex = -1; a.id = '__a11y_start'; document.body.prepend(a); a.focus(); a.remove(); })()`);
  }
  const stops = [];
  let wrapped = false;
  for (let i = 0; i < max; i++) {
    await press(page, 'Tab');
    await sleep(25);
    const stop = await page.evaluate(FOCUS_PROBE);
    // In an aria-modal dialog Tab never reaches the document: the trap keeps it inside (or pulls it in).
    if (stop.body && modal) { problems.push(`Tab left the open dialog for the document (after ${stops.length} stop(s))`); break; }
    if (stop.body) { if (stops.length > 0) { wrapped = true; break; } continue; }
    if (stops.length > 0 && stop.key === stops[0].key) { wrapped = true; break; }
    const seen = stops.findIndex((s) => s.key === stop.key);
    if (seen >= 0) {
      // A cycle that does not start from the first stop: focus is stuck in a part of the page.
      if (!modal) problems.push(`keyboard trap: focus cycles between ${stops.slice(seen).map((s) => JSON.stringify(s.name || s.tag)).join(', ')}`);
      wrapped = true;
      break;
    }
    stops.push(stop);
    if (stop.terminal) { problems.push('Tab entered the terminal; the walk stops there (the terminal has its own exit check)'); break; }
  }
  if (!wrapped && stops.length >= max) problems.push(`no way out after ${max} Tab presses (possible trap)`);
  // Tab that never lands anywhere is as broken as a trap: a dialog whose trap points at something unfocusable.
  if (stops.length === 0) problems.push('Tab never moved focus to anything');
  if (expectSkip && !modal && !stops[0]?.skip) problems.push(`the first Tab stop is not a skip link (it is ${JSON.stringify(stops[0]?.name ?? 'nothing')})`);
  for (const s of stops) {
    if (!s.indicator) problems.push(`no visible focus indicator on ${s.tag} ${JSON.stringify(s.name)}`);
    if (!s.onScreen) problems.push(`focused element is off screen or zero-sized: ${s.tag} ${JSON.stringify(s.name)}`);
  }
  if (modal && stops.some((s) => !s.inDialog)) problems.push('focus left the open dialog');
  if (!modal && stops.length > 0 && !stops.some((s) => s.inMain) && (await page.evaluate(`!!document.querySelector('main a[href], main button:not([disabled]), main input, main select, main textarea, main [tabindex="0"]')`))) {
    problems.push('Tab never reached the main content');
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], stops: stops.length };
}

/** Elements that may scroll in two dimensions (1.4.10 exception): code, tables, diagrams, the terminal. */
const TWO_D_OK = 'pre, code, table, .xterm, [data-scroll-2d], svg, canvas';

/** 1.4.10 at `width` CSS px (and 1.4.4 at 640): no horizontal page scroll, nothing cut off at the right edge. */
export async function reflow(page, { width = 320, height = 256 } = {}) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const problems = await page.evaluate(`(() => {
    const out = [];
    const W = document.documentElement.clientWidth;
    const allowed = (el) => !!el.closest(${JSON.stringify(TWO_D_OK)});
    if (document.documentElement.scrollWidth > W + 1) out.push('the page scrolls horizontally (' + document.documentElement.scrollWidth + 'px wide in ' + W + 'px)');
    for (const el of document.querySelectorAll('body *')) {
      if (allowed(el)) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && (s.overflowY === 'auto' || s.overflowY === 'scroll' || el.closest('main, .main'))) {
        // A horizontal strip of tabs or chips that scrolls on its own is one-dimensional; a content area is not.
        if (el.matches('[role=tablist], .tabs, [data-scroll-x]')) continue;
        out.push('scrolls in two dimensions: ' + el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
      }
    }
    // Text that sticks out past the viewport and cannot be reached: anything whose box ends right of it.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const reported = new Set();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el || allowed(el) || reported.has(el)) continue;
      if (el.closest('[aria-hidden=true], .sr-only, [data-scroll-x], [role=tablist]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width === 0) continue;
      // Clipped by an ancestor that hides overflow on purpose (an ellipsis) is truncation, checked elsewhere.
      let clipped = false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') { const b = n.getBoundingClientRect(); if (b.right <= W + 1) clipped = true; break; }
        if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') break;
      }
      if (clipped) continue;
      if (r.right > W + 2) { reported.add(el); out.push('text runs past the right edge: ' + JSON.stringify(node.textContent.trim().slice(0, 40)) + ' (' + Math.round(r.right) + 'px)'); }
    }
    return out.slice(0, 25);
  })()`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);
  return { ok: problems.length === 0, problems };
}

/** 1.4.12: with the WCAG text-spacing overrides applied, no text is clipped by a box that hides overflow. */
export async function textSpacing(page) {
  await page.evaluate(`(() => {
    const s = document.createElement('style');
    s.id = '__a11y_spacing';
    s.textContent = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
    document.head.appendChild(s);
  })()`);
  await sleep(400);
  const problems = await page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || el.closest('.xterm, svg, [aria-hidden=true]')) continue;
      // Visually hidden on purpose (a screen-reader-only name, the skip link before it has focus).
      if (el.clientWidth <= 1 || el.clientHeight <= 1 || s.clipPath !== 'none' || s.clip !== 'auto') continue;
      if (!(s.overflowY === 'hidden' || s.overflowY === 'clip')) continue;
      if (s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '') continue;
      if (!el.innerText || !el.innerText.trim()) continue;
      if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) out.push('text is clipped vertically: ' + el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' ' + JSON.stringify(el.innerText.trim().slice(0, 40)));
    }
    document.getElementById('__a11y_spacing')?.remove();
    return out.slice(0, 25);
  })()`);
  return { ok: problems.length === 0, problems };
}

/** Text in live regions right now, to count announcements over a window of time (4.1.3). */
export async function watchLiveRegions(page, ms) {
  await page.evaluate(`(() => {
    window.__a11yAnnouncements = [];
    const live = (n) => n.nodeType === 1 ? n.closest('[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log]') : n.parentElement?.closest('[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log]');
    window.__a11yObserver?.disconnect();
    window.__a11yObserver = new MutationObserver((records) => {
      for (const r of records) {
        const region = live(r.target);
        if (region) window.__a11yAnnouncements.push((region.getAttribute('role') || region.getAttribute('aria-live')) + ': ' + region.innerText.slice(0, 80));
      }
    });
    window.__a11yObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  })()`);
  await sleep(ms);
  return page.evaluate(`(() => { window.__a11yObserver.disconnect(); return window.__a11yAnnouncements; })()`);
}
