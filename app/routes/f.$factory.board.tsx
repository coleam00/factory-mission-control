import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { BoardBody } from '../components/Board';
import { EmptyState } from '../components/EmptyState';
import { type BoardRow, type BoardSources, boardView, nextChange } from '../lib/board';
import type { HealthWorkableRow } from '../lib/health';
import type { OwnerQueueRow } from '../lib/owner-queue';
import { useFactory } from '../live/FactoryProvider';
import { AWAITED, Feed, type Source } from '../live/Feed';
import type { PanelState } from '../live/LivePanel';
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

function overall(states: readonly PanelState[]): PanelState {
  if (states.includes('error')) return 'error';
  return states.every((s) => s === 'ready') ? 'ready' : 'loading';
}

/** All the work, by the map's stages, under its work orders (PRD 4.1, 4.9). */
export default function Board(): ReactElement {
  const factory = useFactory();
  const [search, setSearch] = useSearchParams();
  const order = search.get('order') || null;
  const [board, setBoard] = useState<Source<BoardRow>>(AWAITED);
  const [map, setMap] = useState<Source<HomeMapRow>>(AWAITED);
  const [workable, setWorkable] = useState<Source<HealthWorkableRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const [orders, setOrders] = useState<Source<WorkOrderRow>>(AWAITED);
  const now = useClock(
    nextChange({ board: board.rows ?? [], orders: orders.rows ?? [] }, new Date()),
  );
  const setOrder = useCallback(
    (name: string | null) =>
      setSearch((was) => {
        const next = new URLSearchParams(was);
        if (name === null) next.delete('order');
        else next.set('order', name);
        return next;
      }),
    [setSearch],
  );
  const state = overall([board.state, map.state, workable.state, owner.state, orders.state]);
  const sources =
    board.rows && map.rows && workable.rows && owner.rows && orders.rows
      ? ({
          factory: factory ?? '',
          board: board.rows,
          map: map.rows,
          workable: workable.rows,
          owner: owner.rows,
          orders: orders.rows,
        } satisfies BoardSources)
      : undefined;
  return (
    <main data-board data-state={state} className="min-w-0 px-6 py-6">
      <h1 className="mb-4 text-base font-semibold text-text-primary">Board</h1>
      <Feed<BoardRow> query="board" factory={factory} into={setBoard} />
      <Feed<HomeMapRow> query="home-map" factory={factory} args={['']} into={setMap} />
      <Feed<HealthWorkableRow> query="health-workable" factory={factory} into={setWorkable} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      <Feed<WorkOrderRow> query="work-orders" factory={factory} into={setOrders} />
      {state === 'error' ? (
        <EmptyState title="Live data is unavailable." />
      ) : sources === undefined ? (
        <EmptyState title="Loading the board." />
      ) : (
        <BoardBody view={boardView(sources, now, order)} order={order} onOrder={setOrder} />
      )}
    </main>
  );
}
