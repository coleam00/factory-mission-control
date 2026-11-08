import type { HTMLAttributes } from 'react';
import { STATE_NAME, type State, stateColor, stateInk, stateWash } from '../../lib/states';

/** A state's dot. Running always pulses (engineering.md). */
export function StateDot({ state, small }: { state: State; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block ${small ? 'size-1.5' : 'size-2'} shrink-0 rounded-full ${state === 'running' ? 'motion-safe:animate-pulse' : ''}`}
      style={{ background: stateColor(state) }}
    />
  );
}

type PillProps = {
  /** The state it names; a pill without one is a neutral fact. */
  state?: State;
  /** Prefix a pulsing running dot. */
  live?: boolean;
  /** The box a badge had before the v3 screens arrive: Board's cards keep their layout until then. */
  compact?: boolean;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'style' | 'className'>;

/** A state badge, or a neutral one for a fact that is not a state. */
export function Pill({ state, live, compact, children, ...rest }: PillProps) {
  return (
    <span
      {...rest}
      className={`inline-flex items-center ${compact ? 'gap-1 rounded-[5px] px-1.5 py-0.5' : 'gap-1.5 rounded-md px-2 py-1'} bg-[var(--v3-raised)] font-mono text-[length:var(--v3-t-micro)] leading-tight font-medium text-[var(--v3-fg-2)] [overflow-wrap:anywhere]`}
      style={state ? { background: stateWash(state), color: stateInk(state) } : undefined}
    >
      {live ? <StateDot state="running" small={compact} /> : null}
      {children ?? (state ? STATE_NAME[state] : null)}
    </span>
  );
}
