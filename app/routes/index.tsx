import { type ReactElement, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { FactoryMap } from '../components/FactoryMap';
import { StepVersionPicker } from '../components/StepVersionPicker';
import type { HealthWorkableRow } from '../lib/health';
import { homeHref } from '../lib/home-map';
import type { RecentLapRow } from '../lib/laps';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useLive } from '../live/LiveProvider';
import { FACTORY_MAP } from '../map/factory-map';
import { cardLive, type HomeMapRow, type MapSources, versionRecorded } from '../map/live';

/**
 * The map once `home-map` has answered: the owner's drawing, always the same, with the chips the
 * live rows count. Each other source's chips appear as its rows arrive.
 */
export function HomeMapBody({
  sources,
  state,
  factory,
  at,
  configured,
  flow,
  now = new Date(),
}: {
  /** `map` is undefined until `home-map` has answered. */
  sources: Omit<MapSources, 'map'> & { map: readonly HomeMapRow[] | undefined };
  state: PanelState;
  factory: string;
  /** The pin the address names, or null for the current version. */
  at: string | null;
  /** False once the server has answered with no factory; undefined while it has not. */
  configured?: boolean;
  flow: boolean;
  /** The browser's clock, which decides what "today" is for the merges. */
  now?: Date;
}): ReactElement {
  const { map, workable, owner, recent } = sources;
  if (state === 'error') return <EmptyState title="Live data is unavailable." />;
  // The server is ready and shows no factory: nothing will ever load, so say why (#215).
  if (map === undefined && configured === false) {
    return <EmptyState title="No factory is configured." />;
  }
  if (map === undefined) return <EmptyState title="Loading the factory map." />;
  if (!versionRecorded(map, at)) {
    return <EmptyState title={`No version ${at} is recorded for this factory.`} />;
  }
  const live = cardLive(FACTORY_MAP, { map, workable, owner, recent }, now);
  return <FactoryMap map={FACTORY_MAP} live={live} factory={factory} at={at} flow={flow} />;
}

/**
 * The home base (PRD 4.1): the factory map at the version its address names, else the current one,
 * with live counts on its cards.
 */
export default function Home(): ReactElement {
  const [search] = useSearchParams();
  const at = search.get('at') || null;
  const factory = useFactory();
  const live = useLive();
  const [flow, setFlow] = useState(true);
  const configured = live.status === 'ready' ? live.factories.length > 0 : undefined;
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-base font-semibold text-text-primary">Factory map</h1>
        <button
          type="button"
          aria-pressed={flow}
          aria-label="Flow animation"
          title="Toggle flow animation"
          onClick={() => setFlow((was) => !was)}
          className={`ml-auto cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] hover:border-border-bright hover:text-text-primary ${
            flow ? 'text-text-primary' : 'text-text-secondary'
          }`}
        >
          ≋ flow
        </button>
      </div>
      <StepVersionPicker factory={factory} at={at} href={homeHref} />
      <LivePanel<HomeMapRow> query="home-map" factory={factory} args={[at ?? '']}>
        {(map, state) => (
          <LivePanel<HealthWorkableRow> query="health-workable" factory={factory}>
            {(workable) => (
              <LivePanel<OwnerQueueRow> query="owner-queue" factory={factory}>
                {(owner) => (
                  <LivePanel<RecentLapRow> query="recent-laps" factory={factory}>
                    {(recent) => (
                      <HomeMapBody
                        sources={{ map, workable, owner, recent }}
                        state={state}
                        factory={factory ?? ''}
                        at={at}
                        configured={configured}
                        flow={flow}
                      />
                    )}
                  </LivePanel>
                )}
              </LivePanel>
            )}
          </LivePanel>
        )}
      </LivePanel>
    </main>
  );
}
