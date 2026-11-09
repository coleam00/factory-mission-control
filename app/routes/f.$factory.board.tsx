import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { BoardBody } from '../components/Board';
import { EmptyState } from '../components/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import {
  type BoardRow,
  type BoardSources,
  boardView,
  type DiscoveryRow,
  nextChange,
  ORDER_PARAM,
  VIEW_PARAM,
} from '../lib/board';
import type { HealthWorkableRow } from '../lib/health';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { useFactory } from '../live/FactoryProvider';
import { AWAITED, Feed, overall, type Source } from '../live/Feed';
import type { HomeMapRow, WorkOrderRow } from '../map/live';

/** The browser's clock, moved on to each moment a merged work item or a finished order drops off. */
function useClock(next: Date | null): Date {
  const [now, setNow] = useState(() => new Date());
  const at = next?.getTime() ?? null;
  useEffect(() => {
    if (at === null) return;
    const timer = setTimeout(() => setNow(new Date()), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

/** All the work, by the map's stages, under its work orders (PRD 4.1, 4.9). */
export default function Board(): ReactElement {
  const factory = useFactory();
  const [search, setSearch] = useSearchParams();
  const order = search.get(ORDER_PARAM) || null;
  const mode = search.get(VIEW_PARAM) === 'table' ? 'table' : 'pipeline';
  const [board, setBoard] = useState<Source<BoardRow>>(AWAITED);
  const [map, setMap] = useState<Source<HomeMapRow>>(AWAITED);
  const [workable, setWorkable] = useState<Source<HealthWorkableRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const [orders, setOrders] = useState<Source<WorkOrderRow>>(AWAITED);
  const [discoveries, setDiscoveries] = useState<Source<DiscoveryRow>>(AWAITED);
  const now = useClock(
    nextChange({ board: board.rows ?? [], orders: orders.rows ?? [] }, new Date()),
  );
  const setOrder = useCallback(
    (name: string | null) =>
      setSearch((was) => {
        const next = new URLSearchParams(was);
        if (name === null) next.delete(ORDER_PARAM);
        else next.set(ORDER_PARAM, name);
        return next;
      }),
    [setSearch],
  );
  const setView = useCallback(
    (next: 'pipeline' | 'table') =>
      setSearch((was) => {
        const params = new URLSearchParams(was);
        if (next === 'table') params.set(VIEW_PARAM, 'table');
        else params.delete(VIEW_PARAM);
        return params;
      }),
    [setSearch],
  );
  const tableParams = new URLSearchParams(search);
  tableParams.set(VIEW_PARAM, 'table');
  const state = overall([
    board.state,
    map.state,
    workable.state,
    owner.state,
    orders.state,
    discoveries.state,
  ]);
  const sources =
    board.rows && map.rows && workable.rows && owner.rows && orders.rows && discoveries.rows
      ? ({
          factory: factory ?? '',
          board: board.rows,
          map: map.rows,
          workable: workable.rows,
          owner: owner.rows,
          orders: orders.rows,
          discoveries: discoveries.rows,
        } satisfies BoardSources)
      : undefined;
  return (
    <main
      data-board
      data-state={state}
      className="mx-auto min-w-0 max-w-[1100px] px-4 py-6 min-[760px]:px-6"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <h1 className="text-[length:var(--v3-t-title)] leading-tight font-bold text-[color:var(--v3-fg)]">
            Board
          </h1>
          <p className="mt-1 text-[length:var(--v3-t-body)] text-[color:var(--v3-fg-2)]">
            Every work item by stage. Work flows left to right; a work order groups the items that
            ship together.
          </p>
        </div>
        <Segmented
          label="Board view"
          options={[
            { value: 'pipeline', label: 'Pipeline' },
            { value: 'table', label: 'Table' },
          ]}
          value={mode}
          onChange={setView}
        />
      </header>
      <Feed<BoardRow> query="board" factory={factory} into={setBoard} />
      <Feed<HomeMapRow> query="home-map" factory={factory} args={['']} into={setMap} />
      <Feed<HealthWorkableRow> query="health-workable" factory={factory} into={setWorkable} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      <Feed<WorkOrderRow> query="work-orders" factory={factory} into={setOrders} />
      <Feed<DiscoveryRow> query="discoveries" factory={factory} into={setDiscoveries} />
      {state === 'error' ? (
        <EmptyState title="Live data is unavailable." />
      ) : sources === undefined ? (
        <EmptyState title="Loading the board." />
      ) : (
        <BoardBody
          view={boardView(sources, now, order)}
          mode={mode}
          order={order}
          onOrder={setOrder}
          tableHref={`?${tableParams}`}
        />
      )}
    </main>
  );
}
