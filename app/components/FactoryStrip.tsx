import { type ReactElement, useEffect } from 'react';
import { switchBranch } from '../lib/rewind';
import type { PanelState } from '../live/LivePanel';
import { LivePanel } from '../live/LivePanel';
import { useFactory } from '../live/FactoryProvider';
import { LiveDot } from './LiveDot';
import { StateDot } from './ui/StateDot';

export interface StatusStripRow {
  running: number;
  waiting: number;
  /** The Archon commit of the factory's current version, by the step screen's rule; null before any is parsed. */
  engine: string | null;
}

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
    <div data-rewind-indicator={rewind} className="border-b border-border bg-accent/[0.08]">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-accent-bright">
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
 * The nav footer's status line. The factory's name stays in every state, so the user still knows
 * which factory they are looking at when its live values are unavailable; only the counts are
 * replaced. A URL key that is not a factory (`unknown`) is only marked unknown, with no name and no
 * count: the key may be a removed factory's name, which the nav never shows (#151). The page names
 * the key.
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
  const waiting = rows?.[0]?.waiting;
  if (unknown) {
    return (
      <span
        data-unknown-factory=""
        className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]"
      >
        Unknown factory
      </span>
    );
  }
  return (
    <>
      {/* The switcher below already names the factory on screen; this copy is for assistive
          tech and for checks that read the strip's text, so the name shows once. */}
      <span className="sr-only">{factory ?? '-'}</span>
      {state === 'error' ? (
        <p className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
          Live data is unavailable.
        </p>
      ) : (
        <span className="flex items-center gap-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
          {running !== undefined && running > 0 ? <LiveDot size={8} /> : <StateDot state="idle" />}
          <span>
            <span data-count={running} className="tabular-nums">
              {running ?? '-'}
            </span>{' '}
            running · <span className="tabular-nums">{waiting ?? '-'}</span> waiting for a slot
          </span>
        </span>
      )}
    </>
  );
}

/** Hands the engine version up to the one switcher that shows it, and takes it back when the strip goes. */
function ReportEngine({
  engine,
  onEngine,
}: {
  engine: string | null | undefined;
  onEngine: (engine: string | null | undefined) => void;
}): null {
  useEffect(() => {
    onEngine(engine);
    return () => onEngine(undefined);
  }, [engine, onEngine]);
  return null;
}

/**
 * The nav footer's status for one factory. The engine version goes to `onEngine`, not into a child:
 * the switcher that shows it must live outside this panel, whose root remounts when the factory or
 * the seal changes.
 */
export function FactoryStrip({
  onEngine,
}: {
  onEngine: (engine: string | null | undefined) => void;
}): ReactElement {
  const factory = useFactory();
  return (
    <LivePanel<StatusStripRow>
      query="status-strip"
      factory={factory}
      className="flex flex-col gap-1.5"
    >
      {(rows, state) => (
        <>
          <FactoryStripBody factory={factory} rows={rows} state={state} />
          <ReportEngine engine={rows?.[0]?.engine} onEngine={onEngine} />
        </>
      )}
    </LivePanel>
  );
}
