import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * One surface recipe, replacing the four that shared nothing: the panel, the
 * step body, the rubric review and the sample card.
 *
 * `Card.Button` is the same surface as a real `<button>`, for the sample papers
 * and anything else where the whole card is the target.
 */

export type CardPad = 'none' | 'sm' | 'md';

interface CardBaseProps {
  pad?: CardPad;
  flat?: boolean;
  raised?: boolean;
  /** Frosted pane. Needs an ambient wash behind it to read as glass. */
  glass?: boolean;
  children?: ReactNode;
  className?: string;
}

const PAD: Record<CardPad, string | undefined> = {
  none: undefined,
  sm: 'card--pad-sm',
  md: 'card--pad',
};

function classes({ pad = 'none', flat, raised, glass, className }: CardBaseProps): string {
  return cx(
    'card',
    PAD[pad],
    flat && 'card--flat',
    raised && 'card--raised',
    glass && 'card--glass',
    className,
  );
}

export function Card({
  pad,
  flat,
  raised,
  glass,
  className,
  children,
  ...rest
}: CardBaseProps & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div className={classes({ pad, flat, raised, glass, className })} {...rest}>
      {children}
    </div>
  );
}

export function CardButton({
  pad = 'md',
  flat,
  raised,
  glass,
  className,
  children,
  ...rest
}: CardBaseProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button
      type="button"
      className={cx(classes({ pad, flat, raised, glass, className }), 'card--interactive')}
      {...rest}
    >
      {children}
    </button>
  );
}
