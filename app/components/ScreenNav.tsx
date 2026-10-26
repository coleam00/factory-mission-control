import type { ReactElement } from 'react';
import { NavLink, useParams } from 'react-router';
import { useFactory } from '../live/LiveProvider';
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
              className="pointer-events-none bg-text-primary absolute inset-x-0 -bottom-px h-0.5 rounded-full"
            />
          ) : null}
        </>
      )}
    </NavLink>
  );
}

/**
 * The shell's links: the home map, then each factory screen for `factory`. The current screen's
 * link is `aria-current="page"`.
 */
export function ScreenNavBody({
  screens,
  factory,
}: {
  screens: readonly FactoryScreen[];
  factory: string | undefined;
}): ReactElement {
  return (
    <nav aria-label="Screens" className="mx-auto flex max-w-6xl flex-wrap gap-x-5 px-6">
      <ScreenLink to="/" label="Map" />
      {factory === undefined
        ? null
        : screens.map((screen) => (
            <ScreenLink
              key={screen.path}
              to={`/f/${encodeURIComponent(factory)}/${screen.path}`}
              label={screen.label}
            />
          ))}
    </nav>
  );
}

/** The links for the factory in the URL or, off a factory's pages, the one every panel shows. */
export function ScreenNav({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  const shown = useFactory();
  return <ScreenNavBody screens={screens} factory={useParams().factory ?? shown} />;
}
