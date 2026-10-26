import type { ReactElement } from 'react';
import { EmptyState } from '../components/EmptyState';
import { HomeMap } from '../components/HomeMap';
import type { HomeMapRow } from '../lib/home-map';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useLive } from '../live/LiveProvider';

export function HomeMapBody({
  rows,
  state,
  factories,
}: {
  rows: readonly HomeMapRow[] | undefined;
  state: PanelState;
  factories: readonly string[];
}): ReactElement {
  if (state === 'error') return <EmptyState title="Live data is unavailable." />;
  if (rows === undefined) return <EmptyState title="Loading the factory map." />;
  if (rows.length === 0) {
    return <EmptyState title="No architecture is stored for the pinned version yet." />;
  }
  return <HomeMap rows={rows} factories={factories} />;
}

/** The home base: the whole factory at the pinned version, with live lap counts on its steps. */
export default function Home(): ReactElement {
  const factory = useFactory();
  const live = useLive();
  const factories = live.status === 'ready' ? live.factories : [];
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <h1 className="mb-4 text-base font-semibold text-text-primary">Factory map</h1>
      <LivePanel<HomeMapRow> query="home-map" factory={factory}>
        {(rows, state) => <HomeMapBody rows={rows} state={state} factories={factories} />}
      </LivePanel>
    </main>
  );
}
