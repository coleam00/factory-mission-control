import type { ReactElement } from 'react';
import { LivePanel } from '../live/LivePanel';
import { useFactory } from '../live/LiveProvider';
import { LiveDot } from './LiveDot';

interface StatusStripRow {
  running: number;
}

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';

/** The app shell's live strip for one factory. */
export function FactoryStrip(): ReactElement {
  const factory = useFactory();
  return (
    <LivePanel<StatusStripRow>
      query="status-strip"
      factory={factory}
      className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3"
    >
      {(rows, state) => {
        if (state === 'error') {
          return <p className="text-sm text-text-secondary">Live data is unavailable.</p>;
        }
        const running = rows?.[0]?.running;
        return (
          <>
            <span className="font-mono text-sm text-text-primary">{factory ?? '-'}</span>
            <span className="flex items-center gap-2">
              <span className={LABEL}>Running laps</span>
              <span
                data-count={running}
                className="font-mono text-sm tabular-nums text-text-primary"
              >
                {running ?? '-'}
              </span>
              {running !== undefined && running > 0 ? <LiveDot size={8} /> : null}
            </span>
          </>
        );
      }}
    </LivePanel>
  );
}
