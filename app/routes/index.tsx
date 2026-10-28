import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { HomeMap } from '../components/HomeMap';
import { StepVersionPicker } from '../components/StepVersionPicker';
import { type HomeMapRow, homeHref } from '../lib/home-map';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useLive } from '../live/LiveProvider';

export function HomeMapBody({
  rows,
  state,
  factories,
  at,
}: {
  rows: readonly HomeMapRow[] | undefined;
  state: PanelState;
  factories: readonly string[];
  /** The pin the address names, or null for the current version. */
  at: string | null;
}): ReactElement {
  if (state === 'error') return <EmptyState title="Live data is unavailable." />;
  if (rows === undefined) return <EmptyState title="Loading the factory map." />;
  if (rows.length === 0) {
    return at === null ? (
      <EmptyState title="No factory map is available yet." />
    ) : (
      <EmptyState title={`No version ${at} is recorded for this factory.`} />
    );
  }
  return <HomeMap rows={rows} factories={factories} at={at} />;
}

/**
 * The home base: the whole factory at the version its address names, else the current one, with
 * live lap counts on its steps.
 */
export default function Home(): ReactElement {
  const [search] = useSearchParams();
  const at = search.get('at') || null;
  const factory = useFactory();
  const live = useLive();
  const factories = live.status === 'ready' ? live.factories : [];
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <h1 className="mb-4 text-base font-semibold text-text-primary">Factory map</h1>
      <StepVersionPicker factory={factory} at={at} href={homeHref} />
      <LivePanel<HomeMapRow> query="home-map" factory={factory} args={[at ?? '']}>
        {(rows, state) => <HomeMapBody rows={rows} state={state} factories={factories} at={at} />}
      </LivePanel>
    </main>
  );
}
