import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * The only button in the application.
 *
 * Everything that was previously a bespoke `background: none; border: none`
 * reset — the brand, the sample cards, the history rows — now either uses this
 * or `Card` with `interactive`, so there is one hover, one disabled and one
 * focus treatment rather than nine.
 */

export type ButtonVariant = 'default' | 'primary' | 'glass' | 'ghost' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner in place of nothing — the label stays, so width is stable. */
  loading?: boolean;
  active?: boolean;
  block?: boolean;
  icon?: boolean;
  children?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: 'btn--primary',
  glass: 'btn--glass',
  ghost: 'btn--ghost',
  subtle: 'btn--subtle',
  danger: 'btn--danger',
};

export function Button({
  variant = 'default',
  size = 'md',
  loading = false,
  active = false,
  block = false,
  icon = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled ?? loading}
      className={cx(
        'btn',
        VARIANTS[variant],
        size === 'sm' && 'btn--sm',
        size === 'lg' && 'btn--lg',
        icon && 'btn--icon',
        block && 'btn--block',
        active && 'is-active',
        className,
      )}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
