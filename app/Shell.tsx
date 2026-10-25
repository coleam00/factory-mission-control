import type { ReactElement } from 'react';
import { Outlet } from 'react-router';
import { FactoryStrip } from './components/FactoryStrip';
import { LiveProvider } from './live/LiveProvider';

/** Every route renders under the factory strip. */
export function Shell(): ReactElement {
  return (
    <LiveProvider>
      <header className="border-b border-border bg-surface">
        <FactoryStrip />
      </header>
      <Outlet />
    </LiveProvider>
  );
}
