import type { AnchorHTMLAttributes, MouseEvent, ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export interface SkipLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The id of the element to land on: the page's `<main>`, which needs `tabIndex={-1}` to take focus. */
  target: string;
  /** "Skip to main content" by default. */
  children?: ReactNode;
}

/**
 * The first stop on every page (WCAG 2.4.1): a link that is invisible until it
 * has keyboard focus, then moves focus past the navigation to the content.
 *
 * Focus is moved by script rather than by following the `#target` fragment, so
 * it works under a hash router too, where following the fragment would change
 * the route.
 */
export function SkipLink({ target, children = 'Skip to main content', className, onClick, ...rest }: SkipLinkProps): ReactElement {
  const skip = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const element = document.getElementById(target);
    if (element === null) return;
    event.preventDefault();
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
    element.focus();
    element.scrollIntoView?.({ block: 'start' });
  };
  return (
    <a {...rest} href={`#${target}`} className={cx('skip-link', className)} onClick={skip}>
      {children}
    </a>
  );
}
