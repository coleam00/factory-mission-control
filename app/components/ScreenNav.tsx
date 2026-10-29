import type { ReactElement } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useFactory } from '../live/FactoryProvider';
import type { FactoryScreen } from '../routing';

const LINK =
  'relative inline-flex items-center px-1 pb-2.5 pt-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors';

/**
 * Which link is the current screen at `pathname`: the screen's own address, a lap's page
 * (`.../laps/<run id>`) under Laps, and a step's page (`/steps/...`) under the Map it opens from.
 * At most one link matches any address.
 */
export function currentLink(pathname: string, to: string, kind: 'map' | 'screen'): boolean {
  if (pathname === to) return true;
  if (kind === 'map') return pathname.startsWith('/steps/');
  return to.endsWith('/laps') && pathname.startsWith(`${to}/`);
}

function ScreenLink({
  to,
  label,
  kind = 'screen',
}: {
  to: string;
  label: string;
  kind?: 'map' | 'screen';
}): ReactElement {
  const isActive = currentLink(useLocation().pathname, to, kind);
  return (
    <Link
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={`${LINK} ${isActive ? 'text-accent-bright' : 'text-text-secondary hover:text-text-primary'}`}
    >
      {label}
      {isActive ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-selected"
        />
      ) : null}
    </Link>
  );
}

/**
 * The shell's links: the home map, then each factory screen for `factory`, then the rewind
 * screen. On a factory's pages
 * the home map is that factory's own (`/f/:factory`). The current screen's link is
 * `aria-current="page"`.
 */
export function ScreenNavBody({
  screens,
  factory,
}: {
  screens: readonly FactoryScreen[];
  factory: string | undefined;
}): ReactElement {
  const inUrl = useParams().factory;
  const home = inUrl === undefined ? '/' : `/f/${encodeURIComponent(inUrl)}`;
  return (
    <nav aria-label="Screens" className="mx-auto flex max-w-6xl flex-wrap gap-x-5 px-6">
      <ScreenLink to={home} label="Map" kind="map" />
      {factory === undefined ? null : (
        <>
          {screens.map((screen) => (
            <ScreenLink
              key={screen.path}
              to={`/f/${encodeURIComponent(factory)}/${screen.path}`}
              label={screen.label}
            />
          ))}
          <ScreenLink to="/rewind" label="Rewind" />
        </>
      )}
    </nav>
  );
}

/** The links for the factory every panel shows. */
export function ScreenNav({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  return <ScreenNavBody screens={screens} factory={useFactory()} />;
}
