import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { LivePanel } from '../live/LivePanel';
import { useFactory, useLive } from '../live/LiveProvider';
import { LiveDot } from './LiveDot';

interface StatusStripRow {
  running: number;
}

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';

/**
 * Shown on every screen while the server seals for a rewind branch. It comes from the server's
 * configuration, not a live query, so it shows while the strip loads or fails.
 */
export function RewindIndicator({ rewind }: { rewind: string | null }): ReactElement | null {
  if (rewind === null) return null;
  return (
    <div data-rewind-indicator={rewind} className="border-b border-border bg-warning/[0.08]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-warning">
          Rewind
        </span>
        <span className="min-w-0 break-all font-mono text-[12px] text-text-primary">{rewind}</span>
        <span className="text-[12px] text-text-secondary">read-only</span>
        <Link to="/rewind" className="ml-auto text-[12px] text-accent-bright">
          Switch back
        </Link>
      </div>
    </div>
  );
}

/** The app shell's live strip for one factory. */
export function FactoryStrip(): ReactElement {
  const live = useLive();
  const factory = useFactory();
  return (
    <>
      <RewindIndicator rewind={live.status === 'ready' ? live.rewind : null} />
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
    </>
  );
}
