import { useEffect, useRef, type RefObject } from 'react';

/**
 * Overlay layers: the open dialogs, drawers and palettes, oldest first, shared
 * by every component that uses `useDialogLayer`. Escape closes only the
 * topmost, so a confirm opened from a drawer closes on its own and the drawer
 * the person was reading stays.
 */
const layers: object[] = [];

/** How many layers are open. */
export function openLayerCount(): number {
  return layers.length;
}

/** What can take focus inside a dialog, in tab order. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  // A disclosure's own toggle: it takes focus natively, so the trap must count it to know where the ends are.
  'details > summary:first-of-type',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/**
 * Whether Tab can land on an element right now: in the tab order (tabIndex >= 0;
 * a `<summary>` is 0 natively), rendered, and not inside a
 * closed `<details>`. Chromium keeps boxes for a closed disclosure's content
 * (`content-visibility: hidden`), so a client rect alone counted a button
 * nobody can focus, and Tab into a dialog that held one went nowhere.
 */
export function isTabbable(element: HTMLElement): boolean {
  // Out of the tab order on purpose (a listbox option the palette reaches with arrow keys, a roving tab).
  if (element.tabIndex < 0) return false;
  if (typeof element.checkVisibility === 'function') {
    if (!element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false;
  } else if (element.getClientRects().length === 0) {
    return false;
  }
  const closed = element.closest('details:not([open])');
  return closed === null || (element.tagName === 'SUMMARY' && element.parentElement === closed);
}

/**
 * Where focus must go for Tab (or Shift+Tab) to stay inside a dialog, or
 * `null` to let the browser move it. Pure, so it is tested without a DOM:
 * wrap from the last to the first and back, and pull focus in when it is
 * somewhere outside the list (on the dialog itself, or escaped).
 */
export function trapTarget<T>(focusables: readonly T[], active: T | null, backwards: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0] as T;
  const last = focusables[focusables.length - 1] as T;
  const index = active === null ? -1 : focusables.indexOf(active);
  if (index === -1) return backwards ? last : first;
  if (backwards && index === 0) return last;
  if (!backwards && index === focusables.length - 1) return first;
  return null;
}

/**
 * Where focus goes when a layer opens. A selector list is one CSS selector, so
 * its first match in document order wins; to rank choices, pass them as an
 * array: the first selector with a match inside the panel wins.
 */
export type InitialFocus = string | readonly string[];

/** The element initial focus lands on: the first selector, in order, with a match inside `panel`. */
export function initialFocusTarget(
  panel: ParentNode,
  initialFocus: InitialFocus,
  /** Whether a match can take focus; injectable so the ranking is tested without a DOM. */
  tabbable: (element: HTMLElement) => boolean = isTabbable,
): HTMLElement | null {
  for (const selector of typeof initialFocus === 'string' ? [initialFocus] : initialFocus) {
    const match = [...panel.querySelectorAll<HTMLElement>(selector)].find(tabbable);
    if (match) return match;
  }
  return null;
}

export interface DialogLayerOptions {
  /** Where focus goes when the layer opens (see `InitialFocus`). */
  initialFocus?: InitialFocus;
  /** Keep Tab inside the panel. On for a modal layer. */
  trapFocus?: boolean;
  /** Return focus to whatever had it before the layer opened, when it closes. */
  restoreFocus?: boolean;
}

/**
 * Registers a modal layer for its lifetime: Escape (when it is the topmost
 * layer) calls `onDismiss`, focus moves into `panel`, Tab stays inside it, and
 * focus goes back to the opener on close. `onDismiss` is read through a ref,
 * so a parent re-rendering with a new callback neither reorders the stack nor
 * steals focus again.
 */
export function useDialogLayer(
  panel: RefObject<HTMLElement>,
  onDismiss: () => void,
  { initialFocus = '[data-autofocus]', trapFocus = true, restoreFocus = true }: DialogLayerOptions = {},
): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  // An array written inline is a new object on every render; key the effect on
  // its contents so a re-render neither reorders the stack nor steals focus.
  const focusKey = typeof initialFocus === 'string' ? initialFocus : initialFocus.join('\u0000');
  useEffect(() => {
    const token = {};
    layers.push(token);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (layers[layers.length - 1] !== token) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss.current();
        return;
      }
      if (event.key !== 'Tab' || !trapFocus || !panel.current) return;
      const focusables = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isTabbable);
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = trapTarget(focusables, active, event.shiftKey);
      if (focusables.length === 0) event.preventDefault();
      else if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    // Nothing matching: focus stays where it was, and the first Tab pulls it in.
    if (panel.current) initialFocusTarget(panel.current, focusKey.split('\u0000'))?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      layers.splice(layers.indexOf(token), 1);
      if (restoreFocus && opener?.isConnected) opener.focus();
    };
  }, [panel, focusKey, trapFocus, restoreFocus]);
}
