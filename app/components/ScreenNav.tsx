import type { ReactElement } from 'react';
import { NavLink, useParams } from 'react-router';
import { useFactory } from '../live/FactoryProvider';
import type { FactoryScreen } from '../routing';

const LINK =
  'relative inline-flex items-center px-1 pb-2.5 pt-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors';

function ScreenLink({ to, label }: { to: string; label: string }): ReactElement {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `${LINK} ${isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`
      }
    >
      {({ isActive }) => (
        <>
          {label}
          {isActive ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-selected"
            />
          ) : null}
        </>
      )}
    </NavLink>
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
      <ScreenLink to={home} label="Map" />
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
