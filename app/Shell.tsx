import { Fragment, type ReactElement } from 'react';
import { Outlet } from 'react-router';
import { FactoryStrip } from './components/FactoryStrip';
import { FactorySwitcher } from './components/FactorySwitcher';
import { ScreenNav } from './components/ScreenNav';
import { FactoryProvider, useFactory } from './live/FactoryProvider';
import { LiveProvider } from './live/LiveProvider';
import type { FactoryScreen } from './routing';

/**
 * Keyed by the current factory, so a switch remounts the strip and the screen: no panel keeps
 * the previous factory's rows, and no screen keeps its selection.
 */
function ForFactory({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  const factory = useFactory() ?? '';
  return (
    <>
      <header className="border-b border-border bg-surface">
        <FactorySwitcher screens={screens} />
        <FactoryStrip key={factory} />
        <ScreenNav screens={screens} />
      </header>
      <Fragment key={factory}>
        <Outlet />
      </Fragment>
    </>
  );
}

/** Every route renders under the factory switcher, the factory strip and the links to the other screens. */
export function Shell({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  return (
    <LiveProvider>
      <FactoryProvider>
        <ForFactory screens={screens} />
      </FactoryProvider>
    </LiveProvider>
  );
}
