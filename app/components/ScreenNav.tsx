import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useFactory, useUrlFactory } from '../live/FactoryProvider';
import { LivePanel } from '../live/LivePanel';
import { type Place, PLACES, placeHref } from '../routing';
import { DecisionsCount } from './DecisionsCount';

/** The places' glyphs, 16 px, from the v3 mockup. */
const ICON: Record<string, ReactElement> = {
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
  const to = placeHref(factory, place);
  if (pathname === to) return true;
  if (place.path === 'map') return pathname.startsWith(`/f/${encodeURIComponent(factory)}/steps/`);
  return place.path === 'runs' && pathname.startsWith(`${to}/`);
}

/** The count that follows a place's name, none where the place has no live count. */
function CountFor({ place, factory }: { place: Place; factory: string }): ReactNode {
  if (place.path === '') return <DecisionsCount factory={factory} />;
  if (place.path === 'board') return <BoardCount factory={factory} />;
  return null;
}

/** The Board's number of open work items, from the board query the Board screen reads. */
function BoardCount({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<{ kind: string; state: string | null }>
      query="board"
      name="board-count:board"
      factory={factory}
      className="inline"
    >
      {(rows) => (
        <span
          data-board-count
          className="font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)] tabular-nums"
        >
          {rows === undefined
            ? ''
            : rows.filter((row) => row.kind === 'item' && row.state === 'open').length}
        </span>
      )}
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
  count = (place) => <CountFor place={place} factory={factory ?? ''} />,
}: {
  factory: string | undefined;
  layout: 'side' | 'tabs';
  /** Called when a place's link is followed. */
  onNavigate?: () => void;
  /** What follows a place's name; the live counts by default. */
  count?: (place: Place) => ReactNode;
}): ReactElement {
  const { pathname } = useLocation();
  return (
    <>
      {factory === undefined
        ? null
        : PLACES.map((place) => {
            const current = currentPlace(pathname, factory, place);
            return (
              <Link
                key={place.path}
                to={placeHref(factory, place)}
                onClick={onNavigate}
                aria-current={current ? 'page' : undefined}
                className={
                  layout === 'side'
                    ? `flex items-center gap-2.5 rounded-[var(--v3-radius-control)] px-2.5 py-[7px] text-[14.5px] hover:bg-[var(--v3-raised)] hover:text-[color:var(--v3-fg)] ${
                        current
                          ? 'bg-[var(--v3-raised)] font-medium text-[color:var(--v3-fg)]'
                          : 'text-[color:var(--v3-fg-2)]'
                      }`
                    : `relative grid justify-items-center gap-[3px] text-[11px] ${
                        current ? 'text-[color:var(--v3-fg)]' : 'text-[color:var(--v3-fg-3)]'
                      }`
                }
              >
                <Glyph place={place} />
                {place.label}
                <span
                  className={
                    layout === 'side' ? 'ml-auto' : 'absolute -top-0.5 left-[calc(50%+4px)]'
                  }
                >
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
}: {
  layout: 'side' | 'tabs';
  onNavigate?: () => void;
}): ReactElement {
  const factory = useFactory();
  const { view } = useUrlFactory();
  return (
    <PlaceLinks
      factory={view === 'unknown' ? undefined : factory}
      layout={layout}
      onNavigate={onNavigate}
    />
  );
}
