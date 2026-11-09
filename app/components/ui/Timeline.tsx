import type { ReactNode } from 'react';
import type { State } from '../../lib/states';
import { StateDot } from './StateDot';

/** A run's steps down a hairline. */
export function Timeline({ children }: { children: ReactNode }) {
  return (
    <ol className="relative m-0 list-none p-0 before:absolute before:top-2 before:bottom-2 before:left-[3px] before:w-px before:bg-[var(--v3-line-2)]">
      {children}
    </ol>
  );
}

export function TimelineRow({
  state,
  name,
  hint,
  time,
  cost,
  nested,
  attrs,
  children,
}: {
  state: State;
  name: string;
  hint?: string;
  time?: string;
  cost?: string;
  nested?: boolean;
  /** Hooks for the live phase and tests to read the row's facts by. */
  attrs?: Readonly<Record<`data-${string}`, string | number | undefined>>;
  /** What opens under the row, such as an `ErrorPanel` on a failed step. */
  children?: ReactNode;
}) {
  const facts = [time, cost].filter(Boolean).join(' · ');
  return (
    <li {...attrs} className={`relative py-1.5 ${nested ? 'pl-11' : 'pl-5'}`}>
      <span className={`absolute top-3 ${nested ? 'left-[39px]' : 'left-0'}`}>
        <StateDot state={state} />
      </span>
      <div className="flex items-baseline gap-2.5 text-[length:var(--v3-t-meta)]">
        <span
          className={`font-mono ${state === 'idle' ? 'text-[color:var(--v3-fg-3)]' : 'text-[color:var(--v3-fg)]'}`}
        >
          {name}
        </span>
        {hint ? (
          <span
            className={`text-[color:var(--v3-fg-3)] ${nested ? 'hidden min-[760px]:inline' : ''}`}
          >
            {hint}
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[color:var(--v3-fg-3)] tabular-nums">{facts}</span>
      </div>
      {children}
    </li>
  );
}
