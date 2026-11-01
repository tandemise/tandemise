/**
 * The React components of @tandemise/design (`@tandemise/design/react`), offline.
 *
 * Renders each component to static markup with react-dom/server and asserts
 * what a screen reader and the stylesheet depend on: roles, aria-* wiring,
 * data-* state and the BEM classes components.css styles. The keyboard parts
 * (the dialog's focus trap, the tabs' arrow keys, where a tooltip goes) are
 * pure functions, tested directly, so no DOM library is needed.
 *
 *   npm run build && node scratch/design-react-check.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'packages/design/package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ui = await import(pathToFileURL(join(root, 'packages/design/dist/react/index.js')).href);
const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) passed++;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`);
};
const has = (markup, ...needles) => needles.every((n) => markup.includes(n));

// ------------------------------------------------------------------ Button
{
  const plain = html(h(ui.Button, null, 'Save'));
  ok('Button: a type="button" with the .btn class and no modifier by default', plain === '<button type="button" class="btn">Save</button>', plain);
  const primary = html(h(ui.Button, { variant: 'primary', size: 'lg', block: true }, 'Go'));
  ok('Button: variant, size and block become BEM modifiers', has(primary, 'class="btn btn--primary btn--lg btn--block"'), primary);
  const icon = html(h(ui.Button, { iconOnly: true, variant: 'ghost', 'aria-label': 'Close' }, 'x'));
  ok('Button: iconOnly is .btn--icon and keeps its aria-label', has(icon, 'btn--ghost btn--icon', 'aria-label="Close"'), icon);
  const busy = html(h(ui.Button, { loading: true }, 'Save'));
  ok('Button: loading is disabled, aria-busy and data-loading, and keeps its label with a spinner', has(busy, 'disabled=""', 'aria-busy="true"', 'data-loading="true"', 'btn__spinner', '>Save<'), busy);
  const label = html(h(ui.Button, { loading: true, loadingLabel: 'Working…' }, 'Confirm'));
  ok('Button: loadingLabel replaces the label and draws no spinner', has(label, 'Working…') && !label.includes('Confirm') && !label.includes('btn__spinner'), label);
  ok('Button: a submit type is kept', html(h(ui.Button, { type: 'submit' }, 'Send')).includes('type="submit"'));
  ok('buttonClass: a link can look like a button', ui.buttonClass({ variant: 'danger', className: 'x' }) === 'btn btn--danger x');
  ok('Button: size sm is .btn--sm (no more no-op btn--sm class)', html(h(ui.Button, { size: 'sm' }, 'Accept')) === '<button type="button" class="btn btn--sm">Accept</button>');
  ok('buttonClass: a small icon-only link', ui.buttonClass({ size: 'sm', iconOnly: true }) === 'btn btn--sm btn--icon');
}

// ------------------------------------------------------- Badge, pill, dot
{
  ok('Badge: pending is the plain .badge', html(h(ui.Badge, null, 'n')) === '<span class="badge">n</span>');
  ok('Badge: a tone is a modifier', html(h(ui.Badge, { tone: 'release' }, 'r')).includes('class="badge badge--release"'));
  const pill = html(h(ui.StatusPill, { tone: 'running', label: 'Running', live: true }));
  ok('StatusPill: words plus a pulsing dot that is hidden from screen readers', has(pill, 'badge badge--running', 'data-tone="running"', 'class="dot dot--running dot--pulse" aria-hidden="true"', 'Running'), pill);
  const dot = html(h(ui.StatusDot, { tone: 'failed' }));
  ok('StatusDot: decorative by default', has(dot, 'aria-hidden="true"', 'dot dot--failed') && !dot.includes('role='), dot);
  const named = html(h(ui.StatusDot, { tone: 'failed', 'aria-label': 'Failed' }));
  ok('StatusDot: with a label it is an image', has(named, 'role="img"', 'aria-label="Failed"') && !named.includes('aria-hidden'), named);
}

// -------------------------------------------------------------------- Card
{
  ok('Card: without a title, a div.card', html(h(ui.Card, null, 'x')) === '<div class="card">x</div>');
  ok('Card: flush', html(h(ui.Card, { flush: true, className: 'stack' }, 'x')) === '<div class="card card--flush stack">x</div>');
  const titled = html(h(ui.Card, { title: 'Checks', actions: h('button', null, 'Re-run') }, 'body'));
  const id = titled.match(/aria-labelledby="([^"]+)"/)?.[1];
  ok('Card: a title makes it a section labelled by its heading', titled.startsWith('<section') && id && titled.includes(`<h3 class="card__title" id="${id}">Checks</h3>`), titled);
  ok('Card: actions and body slots', has(titled, 'class="card__actions"', '<div class="card__body">body</div>'), titled);
}

// ------------------------------------------------------------- Icon, Logo
{
  const icon = html(h(ui.Icon, { name: 'check' }));
  ok('Icon: decorative, not focusable, in currentColor', has(icon, 'aria-hidden="true"', 'focusable="false"', 'stroke="currentColor"') && !icon.includes('role='), icon);
  ok('Icon: a label makes it an image', has(html(h(ui.Icon, { name: 'check', label: 'Done' })), 'role="img"', 'aria-label="Done"'));
  const logo = html(h(ui.Logo, { muted: true }));
  ok('Logo: the three parts, muted modifier, decorative', has(logo, 'class="logo logo--muted"', 'logo__axle', 'logo__trail', 'logo__lead', 'aria-hidden="true"'), logo);
  ok('Logo: a title names it', has(html(h(ui.Logo, { title: 'Tandemise' })), 'role="img"', 'aria-label="Tandemise"'));
}

// ------------------------------------------------------------------- Field
{
  const wrap = html(h(ui.Field, { label: 'Name', hint: 'Shown on cards' }, h('input', { className: 'input' })));
  ok('Field (node): a wrapping label with the hint after the control', /^<label class="field"><span class="field__label">Name<\/span><input class="input"\/><span class="field__hint" id="[^"]+">Shown on cards<\/span><\/label>$/.test(wrap), wrap);
  const err = html(h(ui.Field, { label: 'Name', hint: 'h', error: 'Required' }, h('input')));
  ok('Field (node): an error replaces the hint and marks the field', has(err, 'data-invalid="true"', 'field__error', 'Required') && !err.includes('field__hint'), err);
  let control;
  const wired = html(h(ui.Field, { label: 'Done when', required: true, error: 'Say what done means.' }, (c) => { control = c; return h('input', { className: 'input', ...c }); }));
  ok('Field (render prop): the label points at the control', has(wired, `for="${control.id}"`, `id="${control.id}"`), wired);
  ok('Field (render prop): the control is described by the error and invalid', control['aria-invalid'] === true && has(wired, `aria-describedby="${control['aria-describedby']}"`, `id="${control['aria-describedby']}"`, 'aria-invalid="true"'), wired);
  ok('Field (render prop): required reaches the control, the mark is hidden', control.required === true && has(wired, 'required=""', 'class="field__required" aria-hidden="true"'), wired);
  let calm;
  html(h(ui.Field, { label: 'x', hint: 'help' }, (c) => { calm = c; return h('input', c); }));
  let labelArg;
  const grouped = html(h(ui.Field, { label: 'Theme' }, (c, l) => { labelArg = l; return h('div', { role: 'radiogroup', 'aria-labelledby': l.id }); }));
  ok('Field (render prop): the label id is handed over for a control <label for> cannot name', labelArg && has(grouped, `id="${labelArg.id}"`, `aria-labelledby="${labelArg.id}"`), grouped);
  ok('Field (render prop): without an error it is described by the hint and valid', calm['aria-invalid'] === undefined && calm['aria-describedby']?.endsWith('-hint'), JSON.stringify(calm));
}

// ------------------------------------------------------------------ Dialog
{
  const d = html(h(ui.Dialog, { title: 'Cancel this mission?', description: 'Steps stop.', onClose: () => {}, footer: h('button', null, 'OK') }, 'body'));
  ok('Dialog: role="dialog", aria-modal, named by its title', has(d, 'role="dialog"', 'aria-modal="true"', 'aria-label="Cancel this mission?"'), d);
  const desc = d.match(/aria-describedby="([^"]+)"/)?.[1];
  ok('Dialog: described by its description', desc && d.includes(`id="${desc}"`) && d.includes('Steps stop.'), d);
  ok('Dialog: the overlay, panel, head, body and foot classes', has(d, 'class="overlay overlay--center"', 'class="modal"', 'modal__head', 'modal__title', 'modal__body', 'modal__foot'), d);
  const node = html(h(ui.Dialog, { title: h('span', null, 'Rich'), onClose: () => {}, wide: true }, 'b'));
  ok('Dialog: a non-string title labels it by the heading id; wide is a modifier; no foot without a footer', has(node, 'aria-labelledby=', 'modal modal--wide') && !node.includes('modal__foot'), node);

  // The focus trap, as the keydown handler applies it.
  const [a, b, c] = ['a', 'b', 'c'];
  ok('trap: Tab on the last wraps to the first', ui.trapTarget([a, b, c], c, false) === a);
  ok('trap: Shift+Tab on the first wraps to the last', ui.trapTarget([a, b, c], a, true) === c);
  ok('trap: Tab in the middle is left to the browser', ui.trapTarget([a, b, c], b, false) === null && ui.trapTarget([a, b, c], b, true) === null);
  ok('trap: focus outside the dialog is pulled in (first, or last going back)', ui.trapTarget([a, b, c], 'outside', false) === a && ui.trapTarget([a, b, c], null, true) === c);
  ok('trap: a dialog with one control keeps focus on it', ui.trapTarget([a], a, false) === a && ui.trapTarget([a], a, true) === a);
  ok('trap: nothing focusable gives nothing to move to', ui.trapTarget([], null, false) === null);
  // Initial focus ranks its selectors: a [data-autofocus] after other buttons
  // still wins (a selector list would have taken the first button).
  // `tabbable` is injected: there is no DOM here to ask whether a match can take focus.
  const always = () => true;
  const panel = { querySelectorAll: (sel) => ({ '[data-autofocus]': ['confirm'], [ui.FOCUSABLE_SELECTOR]: ['cancel'] })[sel] ?? [] };
  ok('initial focus: [data-autofocus] wins over an earlier control', ui.initialFocusTarget(panel, ['[data-autofocus]', ui.FOCUSABLE_SELECTOR], always) === 'confirm');
  ok('initial focus: no [data-autofocus] falls back to the first control', ui.initialFocusTarget({ querySelectorAll: (sel) => (sel === ui.FOCUSABLE_SELECTOR ? ['cancel'] : []) }, ['[data-autofocus]', ui.FOCUSABLE_SELECTOR], always) === 'cancel');
  ok('initial focus: nothing matching gives nothing', ui.initialFocusTarget({ querySelectorAll: () => [] }, '[data-autofocus]', always) === null);
  ok('initial focus: a match that cannot take focus is skipped for the next one', ui.initialFocusTarget({ querySelectorAll: () => ['hidden', 'shown'] }, '[data-autofocus]', (el) => el === 'shown') === 'shown');
  ok('isTabbable: out of the tab order (tabIndex -1) is never a Tab stop', ui.isTabbable({ tabIndex: -1, checkVisibility: () => true, closest: () => null }) === false);
  ok('isTabbable: a rendered control outside a closed disclosure is', ui.isTabbable({ tabIndex: 0, checkVisibility: () => true, closest: () => null }) === true);
  ok('FOCUSABLE_SELECTOR skips disabled controls and tabindex=-1', ui.FOCUSABLE_SELECTOR.includes('button:not([disabled])') && ui.FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
  ok('no layer is open after a server render (effects do not run)', ui.openLayerCount() === 0);
}

// -------------------------------------------------------------------- Tabs
{
  const t = html(h(ui.Tabs, { label: 'Team sections' }, h(ui.Tab, { selected: true, count: 3 }, 'People'), h(ui.Tab, { selected: false }, 'Roles')));
  ok('Tabs: a labelled tablist', has(t, 'class="tabs" role="tablist" aria-label="Team sections"'), t);
  ok('Tab: the selected tab is in the tab order with aria-selected, the others are not', has(t, 'type="button" class="tab" role="tab" aria-selected="true" tabindex="0"', 'aria-selected="false" tabindex="-1"'), t);
  ok('Tab: a count pill', has(t, '<span class="tab__count">3</span>'), t);
  const link = html(h(ui.Tabs, null, h(ui.Tab, { as: 'a', href: '/board', selected: true }, 'Board')));
  ok('Tab: renders as a link when asked, without a button type', has(link, '<a class="tab" role="tab"', 'href="/board"') && !link.includes('type="button"'), link);
  ok('tabs: Right wraps, Left wraps', ui.nextTabIndex('ArrowRight', 2, 3) === 0 && ui.nextTabIndex('ArrowLeft', 0, 3) === 2);
  ok('tabs: Home and End', ui.nextTabIndex('Home', 2, 3) === 0 && ui.nextTabIndex('End', 0, 3) === 2);
  ok('tabs: other keys are not handled', ui.nextTabIndex('Enter', 0, 3) === null && ui.nextTabIndex('ArrowRight', 0, 0) === null);
}

// ----------------------------------------------------------------- Tooltip
{
  let trigger;
  const t = html(h(ui.Tooltip, { content: 'Copy' }, (p) => { trigger = p; return h('button', { 'aria-describedby': p['aria-describedby'] }, 'id'); }));
  ok('Tooltip: closed, nothing is drawn and the trigger is not described', !t.includes('role="tooltip"') && trigger['aria-describedby'] === undefined, t);
  ok('Tooltip: the trigger gets hover and focus handlers', ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur'].every((k) => typeof trigger[k] === 'function'));
  const el = html(h(ui.Tooltip, { content: 'sha256 abc' }, h('span', { className: 'mono' }, 'abc')));
  ok('Tooltip (element child): plain text is made focusable, so a keyboard can reach the hint', el === '<span class="mono" tabindex="0">abc</span>', el);
  const btn = html(h(ui.Tooltip, { content: 'Copy' }, h('button', { type: 'button' }, 'id')));
  ok('Tooltip (element child): a button keeps its own tab order', btn === '<button type="button">id</button>', btn);
  const fit = ui.tooltipFit({ left: -10, right: 90, top: -2, bottom: 20 }, { width: 800, height: 600 }, 'top');
  ok('tooltipFit: pushed back inside the window and flipped below when there is no room above', fit.shift === 14 && fit.flip === true, JSON.stringify(fit));
  const roomy = ui.tooltipFit({ left: 100, right: 200, top: 40, bottom: 60 }, { width: 800, height: 600 }, 'top');
  ok('tooltipFit: left alone when it fits', roomy.shift === 0 && roomy.flip === false, JSON.stringify(roomy));
  const top = ui.tooltipPosition({ left: 100, top: 50, width: 40, height: 20 }, 'top');
  ok('tooltipPosition: centred above, 6px off', top.left === 120 && top.top === 44 && top.transform === 'translate(-50%, -100%)', JSON.stringify(top));
  const bottom = ui.tooltipPosition({ left: 100, top: 50, width: 40, height: 20 }, 'bottom');
  ok('tooltipPosition: centred below, 6px off', bottom.left === 120 && bottom.top === 76, JSON.stringify(bottom));
}

// ---------------------------------------------------------------- Truncate
{
  const t = html(h(ui.Truncate, { as: 'div', className: 'list__subtitle' }, 'A long goal'));
  ok('Truncate: an ellipsised element, not focusable until it is measured as cut off', t === '<div class="truncate list__subtitle">A long goal</div>', t);
  ok('isClipped: wider or taller than its box', ui.isClipped({ scrollWidth: 300, clientWidth: 200, scrollHeight: 20, clientHeight: 20 }) && ui.isClipped({ scrollWidth: 200, clientWidth: 200, scrollHeight: 40, clientHeight: 20 }) && !ui.isClipped({ scrollWidth: 200, clientWidth: 200, scrollHeight: 20, clientHeight: 20 }));
}

// --------------------------------------------------------------- Segmented
{
  const s = html(h(ui.Segmented, { label: 'Theme', value: 'light', onChange: () => {}, options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark', disabled: true }] }));
  ok('Segmented: a named radiogroup of radios', has(s, 'role="radiogroup"', 'aria-label="Theme"', 'class="segmented"') && (s.match(/role="radio"/g) ?? []).length === 3, s);
  ok('Segmented: the chosen option is checked and the only tab stop', has(s, 'aria-checked="true" tabindex="0">Light<', 'aria-checked="false" tabindex="-1">System<'), s);
  ok('Segmented: a disabled option is disabled', has(s, 'disabled="">Dark<'), s);
  ok('nextSegmentIndex: arrows wrap and skip disabled options', ui.nextSegmentIndex('ArrowRight', 1, [false, false, true]) === 0 && ui.nextSegmentIndex('ArrowLeft', 0, [false, false, true]) === 1 && ui.nextSegmentIndex('ArrowDown', 0, [false, true, false]) === 2);
  ok('nextSegmentIndex: Home and End go to the enabled ends; other keys are not handled', ui.nextSegmentIndex('Home', 2, [true, false, false]) === 1 && ui.nextSegmentIndex('End', 0, [false, false, true]) === 1 && ui.nextSegmentIndex('Enter', 0, [false]) === null);
}

// ------------------------------------------------------------------ Switch
{
  const s = html(h(ui.Switch, { checked: true, onChange: () => {}, label: 'Notify me' }));
  ok('Switch: a button with role switch, aria-checked and a name', s === '<button type="button" role="switch" aria-checked="true" aria-label="Notify me" class="switch"></button>', s);
}

// ------------------------------------------------------------- Chip, IdChip
{
  ok('Chip: muted modifier and an icon first', html(h(ui.Chip, { muted: true, icon: h('i') }, 'v3')) === '<span class="chip chip--muted"><i></i>v3</span>');
  const id = html(h(ui.IdChip, { id: 'msn_1', prefix: 'mission' }));
  ok('IdChip: a button named by the id, with an empty polite status beside it', has(id, '<button type="button" class="idchip">', '<span class="idchip__prefix">mission</span>msn_1</button>', '<span class="visually-hidden" role="status"></span>'), id);
  const plain = html(h(ui.IdChip, { id: 'msn_1', interactive: false }));
  ok('IdChip: interactive=false is plain text (no nested control inside a link)', plain.startsWith('<span class="idchip">msn_1</span>') && !plain.includes('<button'), plain);
}

// -------------------------------------------------------------------- Stat
{
  const s = html(h(ui.Stat, { label: 'Agents', value: '4', note: 'of 6' }));
  ok('Stat: a description list, label as term and value as definition', s === '<dl class="stat"><dt class="stat__label">Agents</dt><dd class="stat__value">4</dd><dd class="stat__note">of 6</dd></dl>', s);
  ok('Stat: muted value modifier, no empty note', html(h(ui.Stat, { label: 'Cost', value: 'not reported', muted: true })) === '<dl class="stat"><dt class="stat__label">Cost</dt><dd class="stat__value stat__value--muted">not reported</dd></dl>');
}

// ------------------------------------------------------------------ Banner
{
  const b = html(h(ui.Banner, { tone: 'warn', icon: h('i'), action: h('button', null, 'See') }, 'Limit near'));
  ok('Banner: tone modifier, icon, body and action, and no live role when static', b === '<div class="banner banner--warn"><i></i><div class="banner__body">Limit near</div><button>See</button></div>', b);
  ok('Banner: live polite is a status, assertive an alert', html(h(ui.Banner, { live: 'polite' }, 'x')).includes('role="status"') && html(h(ui.Banner, { live: 'assertive' }, 'x')).includes('role="alert"'));
  const d = html(h(ui.Banner, { onDismiss: () => {}, dismissLabel: 'Dismiss the notice' }, 'x'));
  ok('Banner: a dismiss button with a name and a 24px+ target (btn--sm btn--icon)', has(d, 'aria-label="Dismiss the notice"', 'btn--sm btn--icon banner__dismiss'), d);
  ok('Banner: as a link', html(h(ui.Banner, { as: 'a', href: '#x' }, 'x')).startsWith('<a class="banner" href="#x">'));
}

// -------------------------------------------------------------- EmptyState
{
  const e = html(h(ui.EmptyState, { icon: h('i'), title: 'No missions', body: 'Start one.', action: h('button', null, 'New') }));
  ok('EmptyState: icon tile, title, body and action', e === '<div class="empty"><div class="empty__icon"><i></i></div><div class="empty__title">No missions</div><p class="empty__body">Start one.</p><button>New</button></div>', e);
  ok('EmptyState: inline modifier', html(h(ui.EmptyState, { title: 't', inline: true })).startsWith('<div class="empty empty--inline">'));
}

// ------------------------------------------------------------ the catalogue
ok('COMPONENTS lists every exported component', ui.COMPONENTS.every((name) => ui[name] != null && ['function', 'object'].includes(typeof ui[name])), ui.COMPONENTS.filter((n) => ui[n] == null).join(', '));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('design-react-check-ok');
