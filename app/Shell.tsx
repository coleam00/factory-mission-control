import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Outlet } from 'react-router';
import { FactoryStrip, FactoryStripBody, RewindIndicator } from './components/FactoryStrip';
import { FactorySwitcher } from './components/FactorySwitcher';
import { FlowProvider, FlowToggle } from './components/FlowToggle';
import { ScreenNav } from './components/ScreenNav';
import { UnknownFactory } from './components/UnknownFactory';
import { FactoryProvider, useFactory, useUrlFactory } from './live/FactoryProvider';
import { LiveProvider, useLive } from './live/LiveProvider';
import type { FactoryScreen } from './routing';

/**
 * The one bar every screen sits under: the product name and the factory switcher on the left,
 * what `children` hold (Running now, the tabs) on the right.
 */
function Bar({
  screens,
  rewind,
  children,
}: {
  screens: readonly FactoryScreen[];
  rewind: string | null;
  children: ReactNode;
}): ReactElement {
  return (
    <header className="border-t-2 border-b border-t-[color:var(--dynamous-blue)] border-b-[color:var(--accent-muted)] bg-surface">
      <RewindIndicator rewind={rewind} />
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
        <span className="flex items-center gap-2 font-semibold text-text-primary">
          <span aria-hidden className="size-2.5 rounded-full bg-[color:var(--dynamous-blue)]" />
          Factory Mission Control
        </span>
        <FactorySwitcher screens={screens} />
        <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">{children}</div>
      </div>
    </header>
  );
}

/**
 * Keyed by the current factory, so a switch remounts the strip and the screen: no panel keeps
 * the previous factory's rows, and no screen keeps its selection.
 */
export function ForFactory({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  const factory = useFactory() ?? '';
  const inUrl = useUrlFactory();
  const live = useLive();
  if (inUrl.key !== undefined && inUrl.view === 'unknown') {
    // Nothing is sealed for a key that is not a factory, so nothing reads as an outage, and no
    // other factory's name or count shows above it, whatever the address under the key.
    return (
      <>
        <Bar screens={screens} rewind={null}>
          <section data-url-factory={inUrl.view}>
            <FactoryStripBody factory={inUrl.key} rows={undefined} state="loading" unknown />
          </section>
        </Bar>
        <UnknownFactory
          factory={inUrl.key}
          fallback={live.status === 'ready' ? live.factories[0] : undefined}
        />
      </>
    );
  }
  return (
    <>
      <Bar screens={screens} rewind={live.status === 'ready' ? live.rewind : null}>
        <FactoryStrip key={factory} />
        <ScreenNav screens={screens} />
        <FlowToggle />
      </Bar>
      <Fragment key={factory}>
        <Outlet />
      </Fragment>
    </>
  );
}

/** Every route renders under the one header bar. */
export function Shell({ screens }: { screens: readonly FactoryScreen[] }): ReactElement {
  return (
    <LiveProvider>
      <FactoryProvider>
        <FlowProvider>
          <ForFactory screens={screens} />
        </FlowProvider>
      </FactoryProvider>
    </LiveProvider>
  );
}
