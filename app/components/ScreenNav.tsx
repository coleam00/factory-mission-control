import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { BoardRow } from '../lib/board';
import { useFactory, useUrlFactory } from '../live/FactoryProvider';
import { LivePanel } from '../live/LivePanel';
import { type Place, PLACES, type PlacePath, placeAddress } from '../lib/places';
import { AttentionCount } from './AttentionCount';
import type { StatusStripRow } from './FactoryStrip';

/** The places' glyphs, 16 px, from the v3 mockup. */
const ICON: Record<PlacePath, ReactElement> = {
  '': <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 2.5v4l2.5 1.5" />,
  map: <path d="M1.5 6h4v5h-4zM10.5 6h4v5h-4zM5.5 8.5h5" />,
  board: <path d="M2 3v10M6 3v6M10 3v8M14 3v4" />,
  runs: <path d="M2 4h12M2 8h12M2 12h8" />,
};

export function Glyph({ place }: { place: Place }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4 shrink-0 opacity-85"
    >
      {ICON[place.path]}
    </svg>
  );
}

/**
 * Which place `pathname` is in: the place's own address, a run's page (`.../runs/<run id>`) under
 * Runs, and a step's page (`.../steps/...`) under Factory, the map it opens from. At most one place
 * matches any address.
 */
export function currentPlace(pathname: string, factory: string, place: Place): boolean {
  const to = placeAddress(factory, place.path);
  if (pathname === to) return true;
  if (place.path === 'map') return pathname.startsWith(`/f/${encodeURIComponent(factory)}/steps/`);
  return place.path === 'runs' && pathname.startsWith(`${to}/`);
}

/** The count that follows a place's name, none where the place has no live count. */
function CountFor({ place, factory }: { place: Place; factory: string }): ReactNode {
  if (place.path === '') return <AttentionCount factory={factory} />;
  if (place.path === 'board') return <BoardCount factory={factory} />;
  if (place.path === 'runs') return <RunsCount factory={factory} />;
  return null;
}

/** A place's count: mono, `--v3-fg-2` so it keeps 4.5:1 on the current place's raised background. */
export function NavCount({ attr, children }: { attr: string; children: ReactNode }): ReactElement {
  return (
    <span
      {...{ [attr]: '' }}
      className="font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-2)] tabular-nums"
    >
      {children}
    </span>
  );
}

/** The number of open work items, from the board query the Board screen reads. */
function BoardCount({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<Pick<BoardRow, 'kind' | 'state'>>
      query="board"
      name="board-count:board"
      factory={factory}
      className="inline"
    >
      {(rows) => (
        <NavCount attr="data-board-count">
          {rows === undefined
            ? ''
            : rows.filter((row) => row.kind === 'item' && row.state === 'open').length}
        </NavCount>
      )}
    </LivePanel>
  );
}

/** The Runs count as the status strip's running count, written "<n> live", so the nav and the footer agree. */
export function RunsCountBody({
  rows,
}: {
  rows: readonly Pick<StatusStripRow, 'running'>[] | undefined;
}): ReactElement {
  return <NavCount attr="data-runs-count">{rows?.[0] ? `${rows[0].running} live` : ''}</NavCount>;
}

function RunsCount({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<StatusStripRow>
      query="status-strip"
      name="runs-count:status-strip"
      factory={factory}
      className="inline"
    >
      {(rows) => <RunsCountBody rows={rows} />}
    </LivePanel>
  );
}

/**
 * The shell's four places for `factory`, as the side nav's list or the phone's tab bar. The
 * current place is `aria-current="page"`.
 */
export function PlaceLinks({
  factory,
  layout,
  onNavigate,
  quiet = false,
  count = (place) => <CountFor place={place} factory={factory ?? ''} />,
}: {
  factory: string | undefined;
  layout: 'side' | 'tabs';
  /** Called when a place's link is followed. */
  onNavigate?: () => void;
  /** No place is marked current, because the phone's Manager holds the highlight. */
  quiet?: boolean;
  /** What follows a place's name; the live counts by default. */
  count?: (place: Place) => ReactNode;
}): ReactElement {
  const { pathname } = useLocation();
  return (
    <>
      {factory === undefined
        ? null
        : PLACES.map((place) => {
            const current = !quiet && currentPlace(pathname, factory, place);
            return (
              <Link
                key={place.path}
                to={placeAddress(factory, place.path)}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                className={
                  layout === 'side'
                    ? `flex items-center gap-2.5 rounded-[var(--v3-radius-control)] px-2.5 py-[7px] text-[14.5px] hover:bg-[var(--v3-raised)] hover:text-[color:var(--v3-fg)] ${
                        current
                          ? 'bg-[var(--v3-raised)] font-medium text-[color:var(--v3-fg)]'
                          : 'text-[color:var(--v3-fg-2)]'
                      }`
                    : `grid justify-items-center gap-[3px] text-[11px] ${
                        current ? 'text-[color:var(--v3-fg)]' : 'text-[color:var(--v3-fg-3)]'
                      }`
                }
              >
                <Glyph place={place} />
                {place.label}
                <span className={layout === 'side' ? 'ml-auto' : 'whitespace-nowrap empty:hidden'}>
                  {count(place)}
                </span>
              </Link>
            );
          })}
    </>
  );
}

/** The places for the factory every panel shows. */
export function ScreenNav({
  layout,
  onNavigate,
  quiet,
}: {
  layout: 'side' | 'tabs';
  onNavigate?: () => void;
  quiet?: boolean;
}): ReactElement {
  const factory = useFactory();
  const { view } = useUrlFactory();
  return (
    <PlaceLinks
      factory={view === 'unknown' ? undefined : factory}
      layout={layout}
      onNavigate={onNavigate}
      quiet={quiet}
    />
  );
}
