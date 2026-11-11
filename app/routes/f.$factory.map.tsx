import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { FactoryMap } from '../components/FactoryMap';
import { FactoryScorecard } from '../components/FactoryScorecard';
import { FlowToggle, useFlow } from '../components/FlowToggle';
import { StepVersionPickerBody } from '../components/StepVersionPicker';
import { useMapPath } from '../components/useMapPath';
import type { AttentionRow } from '../lib/attention';
import type { HealthRunRow, HealthStepRow, HealthWorkableRow } from '../lib/health';
import { homeHref } from '../lib/home-map';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { AT_PARAM, type StepRow, type StepVersionRow } from '../lib/step-detail';
import { useFactory } from '../live/FactoryProvider';
import { AWAITED, Feed, type Source } from '../live/Feed';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useLive } from '../live/LiveProvider';
import { FACTORY_MAP, selectOnArrival } from '../map/factory-map';
import {
  cardLive,
  type HomeMapRow,
  type MapRightNowRow,
  type MapSources,
  type ProductDocumentRow,
  versionRecorded,
  type WorkOrderRow,
} from '../map/live';

/**
 * The map once `home-map` has answered: the owner's drawing, always the same, with the chips the
 * live rows count. Each other source's chips appear as its rows arrive.
 */
/** The app's column, which the title row, the version control and the empty states keep. */
const COLUMN = 'mx-auto w-full max-w-6xl px-6';

/** Milliseconds from `now` to the next local midnight, when "today" changes. */
export const msToLocalMidnight = (now: Date): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();

/** The browser's clock, moved on at each local midnight so "merged today" never keeps yesterday. */
function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msToLocalMidnight(now));
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}

export function HomeMapBody({
  sources,
  state,
  factory,
  at,
  configured,
  flow,
  onDrawn,
  aside,
  steps,
  states = {},
  now = new Date(),
  path = [],
  onPath = () => {},
  select,
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
  /** The version line, beside the map's breadcrumb. */
  aside?: ReactNode;
  /** The pinned version's steps, for Behind the scenes; undefined until `step-detail` answers. */
  steps?: readonly StepRow[];
  /** The secondary sources' states: a failed one is unavailable, not empty. */
  states?: NonNullable<MapSources['states']> & { steps?: PanelState };
  /** The browser's clock, which decides what "today" is for the merges. */
  now?: Date;
  /** The view ids the address names, root first; none is the home map. */
  path?: readonly string[];
  onPath?: (path: readonly string[]) => void;
  /** The card to have selected on arrival. */
  select?: string;
}): ReactElement {
  const { map } = sources;
  const empty = (title: string) => (
    <div className={COLUMN}>
      {aside ? <div className="mb-4">{aside}</div> : null}
      <EmptyState title={title} />
    </div>
  );
  if (state === 'error') return empty('Live data is unavailable.');
  // The server is ready and shows no factory: nothing will ever load, so say why (#215).
  if (map === undefined && configured === false) return empty('No factory is configured.');
  if (map === undefined) return empty('Loading the factory map.');
  if (!versionRecorded(map, at)) return empty(`No version ${at} is recorded for this factory.`);
  const live = cardLive(FACTORY_MAP, { ...sources, map, states }, now);
  return (
    <FactoryMap
      map={FACTORY_MAP}
      live={live}
      factory={factory}
      at={at}
      select={select}
      flow={flow}
      path={path}
      onPath={onPath}
      onDrawn={onDrawn}
      aside={aside}
      steps={steps}
      stepsFailed={states.steps === 'error'}
    />
  );
}

/**
 * The home base (PRD 4.1): the factory map at the version its address names, else the current one,
 * with live counts on its cards.
 */
export default function Home(): ReactElement {
  const [search] = useSearchParams();
  const select = selectOnArrival(useLocation().state);
  const at = search.get(AT_PARAM) || null;
  const [path, onPath] = useMapPath(FACTORY_MAP);
  const factory = useFactory();
  const live = useLive();
  const { flow, setDrawn } = useFlow();
  const now = useToday();
  const [workable, setWorkable] = useState<Source<HealthWorkableRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const [orders, setOrders] = useState<Source<WorkOrderRow>>(AWAITED);
  const [attention, setAttention] = useState<Source<AttentionRow>>(AWAITED);
  const [healthRuns, setHealthRuns] = useState<Source<HealthRunRow>>(AWAITED);
  const [healthSteps, setHealthSteps] = useState<Source<HealthStepRow>>(AWAITED);
  const [rightNow, setRightNow] = useState<Source<MapRightNowRow>>(AWAITED);
  const [documents, setDocuments] = useState<Source<ProductDocumentRow>>(AWAITED);
  const [steps, setSteps] = useState<Source<StepRow>>(AWAITED);
  // The picker's feed and open state live here, above the panel: it renders at a different place
  // in each of the panel's exits, so anything it held itself would reset at every load.
  const [versions, setVersions] = useState<Source<StepVersionRow>>(AWAITED);
  const [pickerOpen, setPickerOpen] = useState(false);
  const configured = live.status === 'ready' ? live.factories.length > 0 : undefined;
  return (
    <main className="py-4">
      <Feed<HealthWorkableRow> query="health-workable" factory={factory} into={setWorkable} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      <Feed<WorkOrderRow> query="work-orders" factory={factory} into={setOrders} />
      <Feed<AttentionRow> query="attention-items" factory={factory} into={setAttention} />
      <Feed<HealthRunRow> query="health-runs" factory={factory} into={setHealthRuns} />
      <Feed<HealthStepRow> query="health-steps" factory={factory} into={setHealthSteps} />
      <Feed<MapRightNowRow> query="map-right-now" factory={factory} into={setRightNow} />
      <Feed<ProductDocumentRow> query="product-documents" factory={factory} into={setDocuments} />
      <Feed<StepRow> query="step-detail" factory={factory} args={[at ?? '']} into={setSteps} />
      <Feed<StepVersionRow> query="step-versions" factory={factory} into={setVersions} />
      <LivePanel<HomeMapRow> query="home-map" factory={factory} args={[at ?? '']}>
        {(map, state) => (
          <HomeMapBody
            sources={{
              map,
              workable: workable.rows,
              owner: owner.rows,
              orders: orders.rows,
              attention: attention.rows,
              healthRuns: healthRuns.rows,
              healthSteps: healthSteps.rows,
              rightNow: rightNow.rows,
              documents: documents.rows,
            }}
            steps={steps.rows}
            states={{
              workable: workable.state,
              owner: owner.state,
              orders: orders.state,
              attention: attention.state,
              healthRuns: healthRuns.state,
              healthSteps: healthSteps.state,
              rightNow: rightNow.state,
              documents: documents.state,
              steps: steps.state,
            }}
            state={state}
            factory={factory ?? ''}
            select={select}
            at={at}
            configured={configured}
            flow={flow}
            onDrawn={setDrawn}
            aside={
              <div className="flex flex-wrap items-center gap-3">
                <StepVersionPickerBody
                  rows={versions.rows}
                  state={versions.state}
                  at={at}
                  href={(pin) => homeHref(factory ?? '', pin, search)}
                  open={pickerOpen}
                  onToggle={setPickerOpen}
                  compact
                />
                <FlowToggle />
              </div>
            }
            now={now}
            path={path}
            onPath={onPath}
          />
        )}
      </LivePanel>
      {path.length === 0 && at === null ? (
        <div className={`${COLUMN} mt-6`}>
          <FactoryScorecard factory={factory} />
        </div>
      ) : null}
    </main>
  );
}
