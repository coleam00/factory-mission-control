import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import type { PanelState } from '../live/LivePanel';

export const LABEL =
  'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
export const MONO = 'font-mono text-[12px] tabular-nums';
export const NONE = 'not recorded';

/** The browser's clock, once a second: elapsed times are computed here, never in a query. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The error and loading sentences the Runs screen's panel and a lap's share. */
export function PanelBody<Row>({
  rows,
  state,
  factory,
  what,
  children,
}: {
  rows: readonly Row[] | undefined;
  state: PanelState;
  factory: string | undefined;
  what: string;
  children: (rows: readonly Row[], factory: string) => ReactNode;
}): ReactElement {
  if (state === 'error') {
    return <p className="text-sm text-text-secondary">Live data is unavailable.</p>;
  }
  if (rows === undefined || factory === undefined) {
    return <p className="text-sm text-text-secondary">Loading {what}.</p>;
  }
  return <>{children(rows, factory)}</>;
}

/** `2026-10-24 10:00 UTC`: the same moment for every viewer. */
export const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className={LABEL}>{label}</dt>
      <dd className={`${MONO} min-w-0 truncate text-text-primary`}>{children}</dd>
    </div>
  );
}
