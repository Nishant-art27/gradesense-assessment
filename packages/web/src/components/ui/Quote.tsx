import type { ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * A quoted span of the student's answer.
 *
 * Replaces `.evidence` and `.editor-quote`, which were the same design written
 * twice. When `onActivate` is given the quote is a real control — the previous
 * version was a `<blockquote>` with an `onClick` and no role, tabIndex or key
 * handler, so the "click a quote to find it on the paper" affordance was
 * mouse-only.
 */
export function Quote({
  flagged = false,
  onActivate,
  title,
  flag,
  className,
  children,
}: {
  flagged?: boolean;
  onActivate?: () => void;
  title?: string;
  /** Shown beneath the quote, e.g. that it could not be verified. */
  flag?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const shared = cx('quote', flagged && 'quote--flagged', className);

  if (!onActivate) {
    return (
      <blockquote className={shared}>
        {children}
        {flag !== undefined && <span className="quote__flag">{flag}</span>}
      </blockquote>
    );
  }

  return (
    <button
      type="button"
      className={cx(shared, 'quote--interactive')}
      onClick={onActivate}
      title={title}
    >
      {children}
      {flag !== undefined && <span className="quote__flag">{flag}</span>}
    </button>
  );
}
