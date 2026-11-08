import type { HTMLAttributes } from 'react';

/** The panel every v3 card is. `className` is for layout only. */
export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-[var(--v3-radius-card)] border border-[color:var(--v3-line)] bg-[var(--v3-panel)] ${className}`}
    />
  );
}
