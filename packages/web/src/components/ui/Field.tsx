import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './cx.js';

/**
 * Form controls with one focus ring.
 *
 * There were three independent input implementations, two of which copy-pasted
 * the same focus rule with a hardcoded rgba while setting `outline: none` — so
 * keyboard users got nothing.
 */

export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('field', className)}>
      <span className="field__label">{label}</span>
      {children}
    </label>
  );
}

export function TextArea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('textarea', className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx('select', className)} {...rest} />;
}

export function NumberInput({
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input type="number" className={cx('input', 'input--marks', className)} {...rest} />;
}
