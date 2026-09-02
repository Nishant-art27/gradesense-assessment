import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * One chip, replacing seven.
 *
 * The old stylesheet had `.provider-pill`, `.hero-badge`, `.chip-review`,
 * `.state-tag`, `.kind-chip`, `.slot-req`/`.slot-opt` and `.rubric-tag` — four
 * of them repeating the same uppercase micro-label recipe at three different
 * border radii.
 */

export type BadgeTone = 'neutral' | 'primary' | 'accent' | 'success' | 'danger';

const TONES: Record<BadgeTone, string | undefined> = {
  neutral: undefined,
  primary: 'badge--primary',
  accent: 'badge--accent',
  success: 'badge--success',
  danger: 'badge--danger',
};

export function Badge({
  tone = 'neutral',
  pill = false,
  dot = false,
  live = false,
  colour,
  className,
  children,
}: {
  tone?: BadgeTone;
  pill?: boolean;
  /** A leading dot in the current colour. */
  dot?: boolean;
  /** Makes the dot pulse — used only for the live-provider indicator. */
  live?: boolean;
  /** Solid fill in an explicit colour, for the annotation-kind chip. */
  colour?: string;
  className?: string;
  children?: ReactNode;
}) {
  const style = colour ? ({ '--chip': colour } as CSSProperties) : undefined;

  return (
    <span
      className={cx(
        'badge',
        pill && 'badge--pill',
        colour ? 'badge--solid' : TONES[tone],
        className,
      )}
      style={style}
    >
      {dot && <span className={cx('badge__dot', live && 'badge__dot--live')} aria-hidden="true" />}
      {children}
    </span>
  );
}
