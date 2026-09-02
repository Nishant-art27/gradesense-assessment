import type { ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * One advisory box, replacing `.review-banner`, `.rubric-warnings`,
 * `.banner.busy`, `.banner.error` and `.anchor-note` — the first two of which
 * were the same design written twice with different padding.
 */

export type CalloutTone = 'neutral' | 'info' | 'warn' | 'error' | 'busy';

const TONES: Record<CalloutTone, string | undefined> = {
  neutral: undefined,
  info: 'callout--info',
  warn: 'callout--warn',
  error: 'callout--error',
  busy: 'callout--busy',
};

export function Callout({
  tone = 'neutral',
  title,
  className,
  children,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cx('callout', TONES[tone], className)}>
      {tone === 'busy' && <span className="spinner" aria-hidden="true" />}
      <div className="callout__body">
        {title !== undefined && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}
