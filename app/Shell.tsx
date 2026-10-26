import { Fragment, type ReactElement } from 'react';
import { Outlet } from 'react-router';
import { EmptyState } from './components/EmptyState';
import { FactoryStrip, FactoryStripBody } from './components/FactoryStrip';
import { FactorySwitcher } from './components/FactorySwitcher';
import { ScreenNav } from './components/ScreenNav';
import { UnknownFactory } from './components/UnknownFactory';
import { FactoryProvider, useFactory, useUrlFactory } from './live/FactoryProvider';
import { LiveProvider, useLive } from './live/LiveProvider';
import type { FactoryScreen } from './routing';

/**
 * Keyed by the current factory, so a switch remounts the strip and the screen: no panel keeps
 * the previous factory's rows, and no screen keeps its selection.
 */
function ForFactory({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  const factory = useFactory() ?? '';
  const inUrl = useUrlFactory();
  const live = useLive();
  if (inUrl.key !== undefined && inUrl.view !== 'screen') {
    // Nothing is sealed for a key that is not a factory, so nothing reads as an outage.
    const unknown = inUrl.view === 'unknown';
    return (
      <>
        <header className="border-b border-border bg-surface">
          <FactorySwitcher screens={screens} />
          <section
            data-url-factory={inUrl.view}
            className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3"
          >
            <FactoryStripBody
              factory={inUrl.key}
              rows={undefined}
              state="loading"
              unknown={unknown}
            />
          </section>
        </header>
        {unknown ? (
          <UnknownFactory
            factory={inUrl.key}
            fallback={live.status === 'ready' ? live.factories[0] : undefined}
          />
        ) : (
          <main className="mx-auto max-w-6xl px-6">
            <EmptyState title="Loading the factories." />
          </main>
        )}
      </>
    );
  }
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
