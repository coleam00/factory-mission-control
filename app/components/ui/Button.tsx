import type { ButtonHTMLAttributes } from 'react';

const VARIANT = {
  primary:
    'border-[color:var(--v3-you)] bg-[var(--v3-you)] text-[color:var(--v3-bg)] hover:bg-[var(--v3-you-2)]',
  secondary:
    'border-[color:var(--v3-line-2)] bg-transparent text-[color:var(--v3-fg)] hover:bg-[var(--v3-raised)]',
  text: 'border-[color:transparent] bg-transparent text-[color:var(--v3-fg-2)] hover:text-[color:var(--v3-fg)]',
} as const;

const BASE =
  'cursor-pointer rounded-[var(--v3-radius-control)] border px-3 py-1.5 text-[length:var(--v3-t-meta)] font-semibold';

/** The button look for an element that is not a `<button>`, such as a console link. */
export const buttonClass = (variant: keyof typeof VARIANT) => `${BASE} ${VARIANT[variant]}`;

export function Button({
  variant,
  className = '',
  ...rest
}: { variant: keyof typeof VARIANT } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`${buttonClass(variant)} ${className}`} />;
}
