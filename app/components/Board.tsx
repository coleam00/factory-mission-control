import type { ReactElement } from 'react';
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
import { localMinute } from '../lib/format';
import { BOARD_ITEM_STATE, stateColor } from '../lib/states';
import { Card } from './ui/Card';
import { Pill, StateDot } from './ui/StateDot';

const TILE =
  'block rounded-[7px] border border-[color:var(--v3-line)] bg-[var(--v3-bg)] px-2.5 py-2 hover:border-[color:var(--v3-line-2)]';

/** The card opens the work item through its first link, stretched over the card; the run and returned links sit above it. */
const OPENS = "after:absolute after:inset-0 after:content-['']";
const INNER_LINK = 'relative z-10 underline hover:text-[color:var(--v3-fg)]';
const DETAIL = 'font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-2)]';

function Rounds({ item }: { item: WorkItem }): ReactElement | null {
  if (item.round === 0) return null;
  return (
    <span data-round={item.round} className={`flex flex-wrap items-center gap-1.5 ${DETAIL}`}>
      round {item.round}
      {item.dots.map((dot, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a round's place is its identity
          key={i}
          data-round-dot={dot.state}
          title={dot.title}
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ background: stateColor(dot.state) }}
        />
      ))}
    </span>
  );
}

function RunLine({ item }: { item: WorkItem }): ReactElement | null {
  if (item.run === null) return null;
  return (
    <span data-run className={`flex items-center gap-1.5 ${DETAIL}`}>
      <StateDot state="running" small />
      <Link to={item.run.to} className={`${INNER_LINK} [overflow-wrap:anywhere]`}>
        {item.run.text}
      </Link>
    </span>
  );
}

function Returned({ item }: { item: WorkItem }): ReactElement | null {
  if (item.returned === 0) return null;
  return (
    <span data-returned={item.returned} className={`block ${DETAIL}`}>
      <Link to={item.to} className={INNER_LINK}>
        returned ×{item.returned}
      </Link>
    </span>
  );
}

function Merged({ item }: { item: WorkItem }): ReactElement | null {
  if (item.mergedAt === null) return null;
  return (
    <span data-merged-at className={`block ${DETAIL}`}>
      merged {localMinute(item.mergedAt)}
    </span>
  );
}

function StopLine({ item }: { item: WorkItem }): ReactElement | null {
  if (item.stop === null) return null;
  return (
    <span
      data-stop-line
      className="block text-[length:var(--v3-t-meta)] [overflow-wrap:anywhere]"
      style={{ color: stateColor(item.stop.state) }}
    >
      {item.stop.text}
    </span>
  );
}

/** Round, the run that holds the item, returns, merge time and stop line: the lines below a card's title, in the design's order. */
function CardDetail({ item }: { item: WorkItem }): ReactElement {
  return (
    <span className="mt-1.5 flex flex-col gap-1">
      <Rounds item={item} />
      <RunLine item={item} />
      <Returned item={item} />
      <Merged item={item} />
      <StopLine item={item} />
    </span>
  );
}

/** The Table's rows: the same items, with round, run and step, returned and merged time as columns. */
function ItemTable({ items }: { items: WorkItem[] }): ReactElement {
  const head = 'px-2 py-1 text-left font-normal';
  return (
    <table className={`w-full border-collapse ${DETAIL}`}>
      <thead>
        <tr className="text-[color:var(--v3-fg-3)]">
          <th className={head}>Item</th>
          <th className={head}>Round</th>
          <th className={head}>Run and step</th>
          <th className={head}>Returned</th>
          <th className={head}>Merged</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.number} className="border-t border-[color:var(--v3-line)] align-top">
            <td className="px-2 py-1.5">
              <Link
                to={item.to}
                data-work-item={item.number}
                className="block text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg)]"
              >
                #{item.number} <span className="[overflow-wrap:anywhere]">{item.title}</span>
              </Link>
              <StopLine item={item} />
              {item.chips.length > 0 ? (
                <span className="mt-1 flex flex-wrap gap-1">
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
            </td>
            <td className="px-2 py-1.5">
              <Rounds item={item} />
            </td>
            <td className="px-2 py-1.5">
              <RunLine item={item} />
            </td>
            <td className="px-2 py-1.5">
              <Returned item={item} />
            </td>
            <td className="px-2 py-1.5">
              <Merged item={item} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
        <ItemTable items={column.items} />
      )}
      {older}
    </Card>
  );
}

const MUTED_LINK =
  'text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)] underline hover:text-[color:var(--v3-fg)]';

function MiniCard({ item }: { item: PipelineStage['items'][number] }): ReactElement {
  return (
    <div className={`${TILE} relative`}>
      <Link to={item.to} data-work-item={item.number} className={`block ${OPENS}`}>
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
      <CardDetail item={item} />
    </div>
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
      className={`flex min-w-0 flex-col gap-2 p-3 ${wide ? '' : 'min-[760px]:max-h-[calc(100vh-8rem)]'}`}
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

function Pipeline({ view, older }: { view: BoardView; older: ReactElement | null }): ReactElement {
  const stages = view.pipeline.filter((s) => s.id !== 'blocked');
  const blocked = view.pipeline.find((s) => s.id === 'blocked');
  const { filed, tracked, dropped } = view.found;
  return (
    <div className="space-y-2.5">
      <div data-stage-row className="min-w-0 overflow-x-auto">
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
  return (
    <div className="min-w-0 space-y-4">
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
        <Pipeline view={view} older={older} />
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
