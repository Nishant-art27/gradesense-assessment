import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx.js';

/** The reference's centred section label — a pill announcing what follows. */
export function PillLabel({ children }: { children: ReactNode }) {
  return <span className="pill-label">{children}</span>;
}

/** Small uppercase caption. One recipe; there used to be four. */
export function MicroLabel({ children }: { children: ReactNode }) {
  return <span className="microlabel">{children}</span>;
}

export type Band = 'full' | 'partial' | 'zero';

/** Mark as a fraction of its maximum, in the band colour. */
export function Meter({ value, max }: { value: number; max: number }) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <span className={cx('meter', `meter--${bandFor(value, max)}`)}>
      <span className="meter__fill" style={{ width: `${fraction * 100}%` }} />
    </span>
  );
}

/**
 * The single mark-to-tone rule, shared by the meter, the criterion rail and the
 * criterion mark. It used to be re-derived in three places.
 */
export function bandFor(value: number, max: number): Band {
  if (value >= max) return 'full';
  if (value === 0) return 'zero';
  return 'partial';
}

export function Skeleton({ height, width }: { height: number; width?: number | string }) {
  const style: CSSProperties = { height, width: width ?? '100%' };
  return <span className="skeleton" style={style} aria-hidden="true" />;
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty__title">{title}</span>
      {children !== undefined && <p className="empty__body">{children}</p>}
    </div>
  );
}

export interface SegmentOption {
  id: string;
  label: string;
  /** Optional trailing detail, e.g. the mark for that question. */
  detail?: string;
}

/** Tab row for the rubric panel. Scrolls rather than wrapping on narrow screens. */
export function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: SegmentOption[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          className={cx('segmented__item', option.id === value && 'is-selected')}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.detail !== undefined && <span className="segmented__mark">{option.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/** Progressive disclosure. The only one in the app; used three times. */
export function Disclose({
  summary,
  className,
  children,
}: {
  summary: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cx('disclose', className)}>
      <summary>{summary}</summary>
      <div className="disclose__body">{children}</div>
    </details>
  );
}
