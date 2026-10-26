import type { ReactElement } from 'react';
import type { PanelState } from '../live/LivePanel';
import { LivePanel } from '../live/LivePanel';
import { useFactory } from '../live/FactoryProvider';
import { LiveDot } from './LiveDot';

export interface StatusStripRow {
  running: number;
}

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';

/**
 * The strip's contents. The factory's name stays in every state, so the user still knows which
 * factory they are looking at when its live values are unavailable; only the count is replaced.
 * A URL key that is not a factory (`unknown`) is shown as typed and marked, with no count.
 */
export function FactoryStripBody({
  factory,
  rows,
  state,
  unknown = false,
}: {
  factory: string | undefined;
  rows: readonly StatusStripRow[] | undefined;
  state: PanelState;
  unknown?: boolean;
}): ReactElement {
  const running = rows?.[0]?.running;
  if (unknown) {
    return (
      <>
        <span className="whitespace-pre-wrap font-mono text-sm text-text-primary [overflow-wrap:anywhere]">
          {factory}
        </span>
        <span data-unknown-factory="" className={LABEL}>
          Unknown factory
        </span>
      </>
    );
  }
  return (
    <>
      <span className="font-mono text-sm text-text-primary">{factory ?? '-'}</span>
      {state === 'error' ? (
        <p className="text-sm text-text-secondary">Live data is unavailable.</p>
      ) : (
        <span className="flex items-center gap-2">
          <span className={LABEL}>Running laps</span>
          <span data-count={running} className="font-mono text-sm tabular-nums text-text-primary">
            {running ?? '-'}
          </span>
          {running !== undefined && running > 0 ? <LiveDot size={8} /> : null}
        </span>
      )}
    </>
  );
}

/** The app shell's live strip for one factory. */
export function FactoryStrip(): ReactElement {
  const factory = useFactory();
  return (
    <LivePanel<StatusStripRow>
      query="status-strip"
      factory={factory}
      className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3"
    >
      {(rows, state) => <FactoryStripBody factory={factory} rows={rows} state={state} />}
    </LivePanel>
  );
}
