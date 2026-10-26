import type { ReactElement } from 'react';
import { Outlet } from 'react-router';
import { FactoryStrip } from './components/FactoryStrip';
import { ScreenNav } from './components/ScreenNav';
import { LiveProvider } from './live/LiveProvider';
import type { FactoryScreen } from './routing';

/** Every route renders under the factory strip and the links to the other screens. */
export function Shell({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  return (
    <LiveProvider>
      <header className="border-b border-border bg-surface">
        <FactoryStrip />
        <ScreenNav screens={screens} />
      </header>
      <Outlet />
    </LiveProvider>
  );
}
