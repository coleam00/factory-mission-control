import type { HTMLAttributes, ReactNode } from 'react';
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

type DataProps = { [K in `data-${string}`]?: string | undefined };

export function TimelineRow({
  state,
  name,
  hint,
  time,
  dateTime,
  cost,
  nested,
  prose,
  children,
  ...data
}: {
  state: State;
  name: string;
  hint?: string;
  time?: string;
  /** The machine-readable instant of `time`; renders `time` in a `<time>` element. */
  dateTime?: string;
  cost?: string;
  nested?: boolean;
  /** The name is a sentence, drawn in sans rather than as a step id in mono. */
  prose?: boolean;
  /** What opens under the row, such as an `ErrorPanel` on a failed step. */
  children?: ReactNode;
} & DataProps &
  Omit<HTMLAttributes<HTMLLIElement>, 'children'>) {
  const when = dateTime && time ? <time dateTime={dateTime}>{time}</time> : time;
  return (
    <li {...data} className={`relative py-1.5 ${nested ? 'pl-11' : 'pl-5'}`}>
      <span
        className={`absolute top-1.5 flex h-[1lh] items-center text-[length:var(--v3-t-meta)] ${nested ? 'left-[22px]' : 'left-0'}`}
      >
        <StateDot state={state} />
      </span>
      <div className="flex items-baseline gap-2.5 text-[length:var(--v3-t-meta)]">
        <span
          className={`min-w-0 [overflow-wrap:anywhere] ${prose ? '' : 'font-mono'} ${state === 'idle' ? 'text-[color:var(--v3-fg-3)]' : 'text-[color:var(--v3-fg)]'}`}
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
        <span className="ml-auto shrink-0 font-mono text-[color:var(--v3-fg-3)] tabular-nums">
          {when}
          {when && cost ? ' · ' : null}
          {cost}
        </span>
      </div>
      {children}
    </li>
  );
}
