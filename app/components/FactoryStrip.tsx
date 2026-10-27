import type { ReactElement } from 'react';
import { switchBranch } from '../lib/rewind';
import type { PanelState } from '../live/LivePanel';
import { LivePanel } from '../live/LivePanel';
import { useFactory } from '../live/FactoryProvider';
import { useLive } from '../live/LiveProvider';
import { LiveDot } from './LiveDot';

export interface StatusStripRow {
  running: number;
}

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';

/**
 * Switches the server back to its home branch. A refused switch opens `/rewind`, whose own way
 * back says why.
 */
const switchBack = () => {
  switchBranch(null).catch(() => window.location.assign('/rewind'));
};

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
        <button
          type="button"
          data-indicator-switch-back
          onClick={switchBack}
          className="ml-auto text-[12px] text-text-primary underline underline-offset-2"
        >
          Switch back
        </button>
      </div>
    </div>
  );
}

/**
 * The strip's contents. The factory's name stays in every state, so the user still knows which
 * factory they are looking at when its live values are unavailable; only the count is replaced.
 * A URL key that is not a factory (`unknown`) is only marked unknown, with no name and no count:
 * the key may be a removed factory's name, which the header never shows (#151). The page below
 * names the key.
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
      <span data-unknown-factory="" className={LABEL}>
        Unknown factory
      </span>
    );
  }
  return (
    <>
      <span className="font-mono text-sm text-text-primary [overflow-wrap:anywhere]">
        {factory ?? '-'}
      </span>
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
        {(rows, state) => <FactoryStripBody factory={factory} rows={rows} state={state} />}
      </LivePanel>
    </>
  );
}
