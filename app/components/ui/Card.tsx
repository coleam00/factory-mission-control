import type { HTMLAttributes } from 'react';

/** The panel class, for a call site that is not a div, such as a `LivePanel` or a `<dl>`. */
export const CARD =
  'rounded-[var(--v3-radius-card)] border border-[color:var(--v3-line)] bg-[var(--v3-panel)]';

/** The panel every v3 card is. `className` is for layout only. */
export function Card({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={`${CARD} ${className}`} />;
}
