import { type ReactElement, type RefObject, useLayoutEffect, useRef } from 'react';
import { Link } from 'react-router';
import {
  type BoardColumn,
  type BoardOrder,
  type BoardView,
  orderLine,
  orderTarget,
  type PipelineStage,
  type WorkItem,
} from '../lib/board';
import { BOARD_ITEM_STATE, stateColor } from '../lib/states';
import { Card } from './ui/Card';
import { Pill } from './ui/StateDot';

const TILE =
  'block rounded-[7px] border border-[color:var(--v3-line)] bg-[var(--v3-bg)] px-2.5 py-2 hover:border-[color:var(--v3-line-2)]';

function WorkItemCard({ item }: { item: WorkItem }): ReactElement {
  return (
    <Link to={item.to} data-work-item={item.number} className={TILE}>
      <span className="font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-2)]">
        #{item.number}
      </span>
      <span className="mt-0.5 block text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
        {item.title}
      </span>
      {item.chips.length > 0 ? (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {item.chips.map((chip) => (
            <Pill
              compact
              key={`${chip.kind}-${chip.text}`}
              data-chip={chip.kind}
              state={chip.state}
              live={chip.pulse}
            >
              {chip.text}
            </Pill>
          ))}
        </span>
      ) : null}
    </Link>
  );
}

function Column({ column, older }: { column: BoardColumn; older: ReactElement | null }) {
  return (
    <Card
      role="region"
      data-board-column={column.id}
      data-count={column.items.length}
      aria-label={column.title}
      className="flex flex-col gap-2 p-3"
    >
      <h2
        className="flex items-baseline justify-between text-[13.5px] font-semibold"
        style={{ color: column.role ? `var(--role-${column.role})` : 'var(--v3-fg)' }}
      >
        {column.title}
        <span className="font-mono text-[length:var(--v3-t-meta)] font-normal text-[color:var(--v3-fg-2)]">
          {column.items.length}
        </span>
      </h2>
      <p
        data-holder
        className="font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]"
      >
        {column.holder}
      </p>
      {column.items.length === 0 ? (
        <p className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
          {column.empty ?? 'Nothing here'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-2 min-[760px]:grid-cols-2 min-[1100px]:grid-cols-3">
          {column.items.map((item) => (
            <WorkItemCard key={item.number} item={item} />
          ))}
        </div>
      )}
      {older}
    </Card>
  );
}

const MUTED_LINK =
  'text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)] underline hover:text-[color:var(--v3-fg)]';

function MiniCard({ item }: { item: PipelineStage['items'][number] }): ReactElement {
  return (
    <Link to={item.to} data-work-item={item.number} className={TILE}>
      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 whitespace-nowrap font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-2)]">
        #{item.number}
        <span className="flex max-w-full min-w-0 [&>span]:min-w-0" title={item.status}>
          <Pill compact state={BOARD_ITEM_STATE[item.status]} live={item.status === 'running'}>
            <span className="min-w-0 truncate">{item.status}</span>
          </Pill>
        </span>
      </span>
      <span className="mt-0.5 block text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
        {item.title}
      </span>
    </Link>
  );
}

function StageCard({
  stage,
  older,
  wide,
}: {
  stage: PipelineStage;
  older?: ReactElement | null;
  wide?: boolean;
}): ReactElement {
  return (
    <Card
      role="region"
      data-board-stage={stage.id}
      data-count={stage.items.length}
      aria-label={stage.title}
      className={`flex min-w-0 flex-col gap-2 p-3 ${wide ? '' : 'min-[760px]:max-h-[max(20rem,calc(100vh-var(--board-row-top,8rem)-1.5rem))]'}`}
    >
      <h2 className="text-[13.5px] font-semibold text-[color:var(--v3-fg)]">{stage.title}</h2>
      <p className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">{stage.subtitle}</p>
      <p className="text-[length:var(--v3-t-title)] leading-none font-bold tabular-nums text-[color:var(--v3-fg)]">
        {stage.items.length}
      </p>
      {stage.pills.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {stage.pills.map((pill) => (
            <span key={pill.label} className="flex min-w-0 max-w-full [&>span]:min-w-0">
              <Pill compact state={pill.state} title={`${pill.label} ${pill.count}`}>
                <span className="truncate">
                  {pill.label} {pill.count}
                </span>
              </Pill>
            </span>
          ))}
        </div>
      ) : null}
      <div
        data-stage-items
        className={`min-h-0 gap-2 ${
          wide
            ? 'grid grid-cols-1 min-[760px]:grid-cols-3'
            : 'flex flex-col overflow-y-auto min-[760px]:flex-1'
        }`}
      >
        {stage.items.map((item) => (
          <MiniCard key={item.number} item={item} />
        ))}
      </div>
      {older}
    </Card>
  );
}

function Pipeline({
  view,
  older,
  row,
}: {
  view: BoardView;
  older: ReactElement | null;
  row: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const stages = view.pipeline.filter((s) => s.id !== 'blocked');
  const blocked = view.pipeline.find((s) => s.id === 'blocked');
  const { filed, tracked, dropped } = view.found;
  return (
    <div className="space-y-2.5">
      <div ref={row} data-stage-row className="min-w-0 overflow-x-auto">
        <div className="grid grid-cols-1 items-start gap-2.5 min-[760px]:grid-cols-none min-[760px]:grid-flow-col min-[760px]:auto-cols-[minmax(200px,1fr)]">
          {stages.map((stage) => (
            <StageCard key={stage.id} stage={stage} older={stage.id === 'merged' ? older : null} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2.5 min-[760px]:grid-cols-2">
        <Card
          role="region"
          data-found
          data-filed={filed}
          data-tracked={tracked}
          data-dropped={dropped}
          aria-label="Found by the factory"
          className="flex min-w-0 flex-col gap-2 p-3"
        >
          <h2 className="text-[13.5px] font-semibold text-[color:var(--v3-fg)]">
            Found by the factory
          </h2>
          <p className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
            discoveries · filed, tracked, dropped
          </p>
          <p className="text-[length:var(--v3-t-title)] leading-none font-bold tabular-nums text-[color:var(--v3-fg)]">
            {filed + tracked + dropped}
          </p>
          <div className="flex flex-wrap gap-1">
            <Pill compact>filed {filed}</Pill>
            <Pill compact>tracked {tracked}</Pill>
            <Pill compact>dropped {dropped}</Pill>
          </div>
        </Card>
        {blocked === undefined ? null : <StageCard stage={blocked} wide />}
      </div>
    </div>
  );
}

function OrderStrip({
  order,
  selected,
  onToggle,
}: {
  order: BoardOrder;
  selected: boolean;
  onToggle: () => void;
}): ReactElement {
  const share = (n: number) => `${order.total === 0 ? 0 : (n / order.total) * 100}%`;
  return (
    <button
      type="button"
      data-work-order={order.name}
      aria-pressed={selected}
      onClick={onToggle}
      className={`min-w-0 flex-[1_1_280px] cursor-pointer rounded-[var(--v3-radius-card)] border bg-[var(--v3-panel)] px-3 py-2.5 text-left hover:border-[color:var(--v3-line-2)] ${
        selected ? 'border-[color:var(--v3-line-2)]' : 'border-[color:var(--v3-line)]'
      }`}
    >
      <span className="block text-[length:var(--v3-t-body)] font-semibold text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
        {order.name}
      </span>
      <span className="block font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">
        {orderTarget(order)}
      </span>
      <span className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-[var(--v3-raised)]">
        <span style={{ width: share(order.merged), background: stateColor('done') }} />
        <span style={{ width: share(order.building), background: stateColor('running') }} />
        <span style={{ width: share(order.needsYou), background: stateColor('needs-you') }} />
      </span>
      <span
        data-order-line
        className="mt-1.5 block font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-2)]"
      >
        {orderLine(order)}
      </span>
    </button>
  );
}

/** The board once every source has answered: the work orders above the Pipeline or the Table. */
export function BoardBody({
  view,
  mode,
  order,
  onOrder,
}: {
  view: BoardView;
  mode: 'pipeline' | 'table';
  /** The work order the address filters to, or null. */
  order: string | null;
  onOrder: (name: string | null) => void;
}): ReactElement {
  const older =
    view.older > 0 && view.olderHref !== null ? (
      <a data-older href={view.olderHref} className={MUTED_LINK}>
        {view.older} older
      </a>
    ) : null;
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  // Where the stage row starts with every scroll at the top, so a column's cap ends in the window.
  useLayoutEffect(() => {
    const board = root.current;
    if (!board) return;
    const place = () => {
      const stages = row.current;
      if (!stages) return;
      let top = stages.getBoundingClientRect().top;
      for (let a = stages.parentElement; a; a = a.parentElement) top += a.scrollTop;
      board.style.setProperty('--board-row-top', `${Math.round(top)}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(board);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} className="min-w-0 space-y-4">
      {view.orders.length > 0 ? (
        <div className="flex flex-wrap gap-2.5">
          {view.orders.map((o) => (
            <OrderStrip
              key={o.name}
              order={o}
              selected={order === o.name}
              onToggle={() => onOrder(order === o.name ? null : o.name)}
            />
          ))}
        </div>
      ) : null}
      <p
        data-not-in-order={view.notInOrder}
        className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]"
      >
        {view.notInOrder} not in a work order
      </p>
      {mode === 'pipeline' ? (
        <Pipeline view={view} older={older} row={row} />
      ) : (
        <div className="space-y-2.5">
          {view.columns.map((column) => (
            <Column key={column.id} column={column} older={column.id === 'merged' ? older : null} />
          ))}
        </div>
      )}
    </div>
  );
}
