import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { factoryHref, homeHref } from '../lib/home-map';
import { useFactory } from '../live/FactoryProvider';
import type { FactoryScreen } from '../routing';
import { DecisionsCount } from './DecisionsCount';

const LINK =
  'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors';

/**
 * Which link is the current screen at `pathname`: the screen's own address, a lap's page
 * (`.../laps/<run id>`) under Laps, and a step's page (`.../steps/...`) under the Factory tab, the map it opens from.
 * At most one link matches any address.
 */
export function currentLink(pathname: string, to: string, kind: 'map' | 'screen'): boolean {
  if (pathname === to) return true;
  if (kind === 'map') return pathname.startsWith(`${to}/steps/`);
  return to.endsWith('/laps') && pathname.startsWith(`${to}/`);
}

function ScreenLink({
  to,
  label,
  kind = 'screen',
  children,
}: {
  to: string;
  label: string;
  kind?: 'map' | 'screen';
  children?: ReactNode;
}): ReactElement {
  const isActive = currentLink(useLocation().pathname, to, kind);
  return (
    <Link
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={`${LINK} ${
        isActive
          ? 'border-border bg-surface-elevated text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
      {children}
    </Link>
  );
}

/**
 * The shell's links: the home map, then each factory screen for `factory`. On a factory's pages
 * the home map is that factory's own (`/f/:factory`). The current screen's link is
 * `aria-current="page"`.
 */
export function ScreenNavBody({
  screens,
  factory,
  badge,
}: {
  screens: readonly FactoryScreen[];
  factory: string | undefined;
  /** What follows a screen's label, such as the Decisions tab's count. */
  badge?: (path: string) => ReactNode;
}): ReactElement {
  const inUrl = useParams().factory;
  const home = inUrl === undefined ? homeHref() : factoryHref(inUrl);
  return (
    <nav aria-label="Screens" className="flex flex-wrap items-center gap-1">
      <ScreenLink to={home} label="Factory" kind="map" />
      {factory === undefined
        ? null
        : screens.map((screen) => (
            <ScreenLink
              key={screen.path}
              to={`/f/${encodeURIComponent(factory)}/${screen.path}`}
              label={screen.label}
            >
              {badge?.(screen.path)}
            </ScreenLink>
          ))}
    </nav>
  );
}

/** The links for the factory every panel shows. */
export function ScreenNav({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  const factory = useFactory();
  return (
    <ScreenNavBody
      screens={screens}
      factory={factory}
      badge={(path) =>
        path === 'decisions' && factory !== undefined ? <DecisionsCount factory={factory} /> : null
      }
    />
  );
}
