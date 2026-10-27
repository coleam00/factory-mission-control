import { type ReactElement, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { shownRows, switcherEntries } from '../lib/factory-choice';
import { useFactory, usePublishFactories } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useLive } from '../live/LiveProvider';
import { type FactoryScreen, factoryPath } from '../routing';
import { LiveDot } from './LiveDot';

export interface FactorySwitcherRow {
  factory: string;
  running: number;
  is_default: boolean;
}

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const NOTE = 'px-3 py-2 text-sm text-text-secondary';

export function FactorySetupNotice({
  factories,
  rows,
  state,
  rewind,
}: {
  factories: readonly string[] | undefined;
  rows: readonly FactorySwitcherRow[] | undefined;
  state: PanelState;
  rewind: string | null;
}): ReactElement | null {
  if (state !== 'ready' || factories === undefined || rows === undefined) return null;
  const missing = factories.filter((name) => !rows.some((row) => row.factory === name));
  if (missing.length === 0) return null;
  const names = missing.map((name) => `“${name}”`).join(', ');
  return (
    <p className="w-full text-sm text-text-secondary [overflow-wrap:anywhere]">
      {rewind === null
        ? `To load configured factories ${names}, run `
        : `Configured factories ${names} are absent from this read-only rewind; switch back and, if setup is still needed, run `}
      <code className="font-mono">bun run migrate -- --configured-factories</code> on check-* or
      have the owner run{' '}
      <code className="font-mono">bun run migrate:main -- --configured-factories</code> on main,
      using the server's environment.
    </p>
  );
}

function Entries({
  rows,
  state,
  current,
  hrefFor,
  onChoose,
}: {
  rows: readonly FactorySwitcherRow[] | undefined;
  state: PanelState;
  current: string | undefined;
  hrefFor: (factory: string) => string;
  onChoose: () => void;
}): ReactElement {
  if (state === 'error') return <p className={NOTE}>Live data is unavailable.</p>;
  if (rows === undefined) return <p className={NOTE}>Loading the factories.</p>;
  if (rows.length === 0) return <p className={NOTE}>No factory has recorded laps yet.</p>;
  return (
    <ul className="flex flex-col py-1">
      {switcherEntries(rows).map(({ factory, running }) => (
        <li key={factory} data-factory-entry={factory} data-running={running}>
          <Link
            to={hrefFor(factory)}
            onClick={onChoose}
            aria-current={factory === current ? 'true' : undefined}
            className={`flex items-center justify-between gap-6 px-3 py-1.5 font-mono text-sm hover:bg-surface-inset ${
              factory === current ? 'text-text-primary' : 'text-text-secondary'
            }`}
          >
            <span>{factory}</span>
            <span className="flex items-center gap-2">
              {running > 0 ? <LiveDot size={8} /> : null}
              <span className="tabular-nums">{running}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The switcher's contents: the current factory, and when open every factory with its running
 * laps, each linking to `hrefFor` it. The list is in the page only while open.
 */
export function FactorySwitcherBody({
  rows,
  state,
  current,
  hrefFor,
  open,
  onToggle,
}: {
  rows: readonly FactorySwitcherRow[] | undefined;
  state: PanelState;
  current: string | undefined;
  hrefFor: (factory: string) => string;
  open: boolean;
  onToggle: (open: boolean) => void;
}): ReactElement {
  return (
    <details
      data-factory-switcher=""
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="relative"
    >
      <summary className="flex cursor-pointer items-center gap-3">
        <span className={LABEL}>Factory</span>
        <span className="font-mono text-sm text-text-primary [overflow-wrap:anywhere]">
          {current ?? '-'}
        </span>
      </summary>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-2 min-w-64 rounded-md border border-border bg-surface">
          <Entries
            rows={rows}
            state={state}
            current={current}
            hrefFor={hrefFor}
            onChoose={() => onToggle(false)}
          />
        </div>
      ) : null}
    </details>
  );
}

/** Hands the factories the switcher lists to the provider deciding the current factory. */
function PublishFactories({
  rows,
  state,
}: {
  rows: readonly FactorySwitcherRow[] | undefined;
  state: PanelState;
}): null {
  const publish = usePublishFactories();
  const names = rows?.map((row) => row.factory).join('\n');
  useEffect(() => {
    if (state === 'error') publish({ status: 'error' });
    else if (state === 'ready' && names !== undefined) {
      publish({ status: 'ready', names: names === '' ? [] : names.split('\n') });
    }
  }, [state, names, publish]);
  return null;
}

/**
 * The shell's factory switcher: every row of `mc.factories` the server shows, live, opening the
 * same screen.
 */
export function FactorySwitcher({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  const live = useLive();
  const current = useFactory();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const factories = live.status === 'ready' ? live.factories : undefined;
  // Sealed for the default factory, so a switch does not re-seal the list.
  const fallback = factories?.[0];
  return (
    <LivePanel<FactorySwitcherRow>
      query="factory-switcher"
      factory={fallback}
      className="mx-auto flex max-w-6xl flex-wrap gap-y-2 px-6 pt-3"
    >
      {(all, state) => {
        const rows = shownRows(all, factories);
        return (
          <>
            <PublishFactories rows={rows} state={state} />
            <FactorySwitcherBody
              rows={rows}
              state={state}
              current={current}
              hrefFor={(factory) => factoryPath(pathname, factory, screens)}
              open={open}
              onToggle={setOpen}
            />
            <FactorySetupNotice
              factories={factories}
              rows={rows}
              state={state}
              rewind={live.status === 'ready' ? live.rewind : null}
            />
          </>
        );
      }}
    </LivePanel>
  );
}
