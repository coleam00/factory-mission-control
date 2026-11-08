import type { ReactNode } from 'react';
import type { State } from '../../lib/states';
import { StateDot } from './StateDot';

/** A filter with a count, rounded fully. A state adds its dot. */
export function Chip({
  pressed,
  onClick,
  count,
  state,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  count?: number;
  state?: State;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-transparent px-[11px] py-1 text-[length:var(--v3-t-meta)] ${
        pressed
          ? 'border-[color:var(--v3-fg-3)] text-[color:var(--v3-fg)]'
          : 'border-[color:var(--v3-line)] text-[color:var(--v3-fg-2)]'
      }`}
    >
      {state ? <StateDot state={state} /> : null}
      {children}
      {count === undefined ? null : (
        <span className="font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)] tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}
