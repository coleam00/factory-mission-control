import { type ReactElement, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { FactoryMap, useReducedMotion } from '../components/FactoryMap';
import { StepVersionPicker } from '../components/StepVersionPicker';
import type { HealthWorkableRow } from '../lib/health';
import { homeHref } from '../lib/home-map';
import type { OwnerQueueRow } from '../lib/owner-queue';
import type { StepRow } from '../lib/step-detail';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useLive } from '../live/LiveProvider';
import { FACTORY_MAP } from '../map/factory-map';
import { cardLive, type HomeMapRow, type MapSources, versionRecorded } from '../map/live';

/**
 * The map once `home-map` has answered: the owner's drawing, always the same, with the chips the
 * live rows count. Each other source's chips appear as its rows arrive.
 */
/** The app's column, which the title row, the version control and the empty states keep. */
const COLUMN = 'mx-auto w-full max-w-6xl px-6';

export function HomeMapBody({
  sources,
  state,
  factory,
  at,
  configured,
  flow,
  onDrawn,
  steps,
  states = {},
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
  onDrawn?: (drawn: boolean) => void;
  /** The pinned version's steps, for Behind the scenes; undefined until `step-detail` answers. */
  steps?: readonly StepRow[];
  /** The secondary sources' states: a failed one is unavailable, not empty. */
  states?: NonNullable<MapSources['states']> & { steps?: PanelState };
  /** The browser's clock, which decides what "today" is for the merges. */
  now?: Date;
}): ReactElement {
  const { map, workable, owner } = sources;
  const empty = (title: string) => (
    <div className={COLUMN}>
      <EmptyState title={title} />
    </div>
  );
  if (state === 'error') return empty('Live data is unavailable.');
  // The server is ready and shows no factory: nothing will ever load, so say why (#215).
  if (map === undefined && configured === false) return empty('No factory is configured.');
  if (map === undefined) return empty('Loading the factory map.');
  if (!versionRecorded(map, at)) return empty(`No version ${at} is recorded for this factory.`);
  const live = cardLive(FACTORY_MAP, { map, workable, owner, states }, now);
  return (
    <FactoryMap
      map={FACTORY_MAP}
      live={live}
      factory={factory}
      at={at}
      flow={flow}
      onDrawn={onDrawn}
      steps={steps}
      stepsFailed={states.steps === 'error'}
    />
  );
}

interface Source<Row> {
  rows: readonly Row[] | undefined;
  state: PanelState;
}

const AWAITED = { rows: undefined, state: 'loading' } as const;

/** Hands a panel's rows and state up, so the panel never wraps the map and remounts it. */
function Report<Row>({
  rows,
  state,
  into,
}: Source<Row> & { into: (source: Source<Row>) => void }): null {
  useEffect(() => into({ rows, state }), [rows, state, into]);
  return null;
}

function Feed<Row>({
  query,
  factory,
  args,
  into,
}: {
  query: string;
  factory: string | undefined;
  args?: readonly string[];
  into: (source: Source<Row>) => void;
}): ReactElement {
  return (
    <LivePanel<Row> query={query} factory={factory} args={args}>
      {(rows, state) => <Report rows={rows} state={state} into={into} />}
    </LivePanel>
  );
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
  // The toggle shows with the map it moves, and reads off while the system asks for no motion.
  const [drawn, setDrawn] = useState(false);
  const reduced = useReducedMotion();
  const [workable, setWorkable] = useState<Source<HealthWorkableRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const [steps, setSteps] = useState<Source<StepRow>>(AWAITED);
  const configured = live.status === 'ready' ? live.factories.length > 0 : undefined;
  return (
    <main className="py-6">
      <div className={`${COLUMN} mb-4 flex min-h-8 items-center gap-3`}>
        <h1 className="text-base font-semibold text-text-primary">Factory map</h1>
        {drawn ? (
          <button
            type="button"
            aria-pressed={flow && !reduced}
            aria-label="Flow animation"
            title={
              reduced
                ? 'Flow animation is off: your system asks for reduced motion'
                : 'Toggle flow animation'
            }
            disabled={reduced}
            onClick={() => setFlow((was) => !was)}
            className={`ml-auto cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] hover:border-border-bright hover:text-text-primary disabled:cursor-default ${
              flow && !reduced ? 'text-text-primary' : 'text-text-secondary'
            }`}
          >
            ≋ flow
          </button>
        ) : null}
      </div>
      <div className={COLUMN}>
        <StepVersionPicker factory={factory} at={at} href={homeHref} />
      </div>
      <Feed<HealthWorkableRow> query="health-workable" factory={factory} into={setWorkable} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      <Feed<StepRow> query="step-detail" factory={factory} args={[at ?? '']} into={setSteps} />
      <LivePanel<HomeMapRow> query="home-map" factory={factory} args={[at ?? '']}>
        {(map, state) => (
          <HomeMapBody
            sources={{ map, workable: workable.rows, owner: owner.rows }}
            steps={steps.rows}
            states={{ workable: workable.state, owner: owner.state, steps: steps.state }}
            state={state}
            factory={factory ?? ''}
            at={at}
            configured={configured}
            flow={flow}
            onDrawn={setDrawn}
          />
        )}
      </LivePanel>
    </main>
  );
}
