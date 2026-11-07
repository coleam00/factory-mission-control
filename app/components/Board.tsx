import type { ReactElement } from 'react';
import { Link } from 'react-router';
import {
  type BoardChip,
  type BoardColumn,
  type BoardView,
  orderProgress,
  type WorkItem,
} from '../lib/board';

const CHIP_TONE: Record<NonNullable<BoardChip['tone']> | 'plain', string> = {
  plain: 'bg-surface-hover text-text-secondary',
  running: 'bg-[color:var(--running-soft)] text-[color:var(--running)]',
  pass: 'bg-[color:var(--role-test-soft)] text-[color:var(--role-test)]',
  fail: 'bg-[color:var(--error-soft)] text-[color:var(--error)]',
};

function Chip({ chip }: { chip: BoardChip }): ReactElement {
  return (
    <span
      data-chip={chip.kind}
      className={`inline-flex items-center gap-1 rounded-[5px] [overflow-wrap:anywhere] px-1.5 py-0.5 font-mono text-[11px] ${CHIP_TONE[chip.tone ?? 'plain']}`}
    >
      {chip.pulse ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-[color:var(--running)] motion-safe:animate-pulse"
        />
      ) : null}
      {chip.text}
    </span>
  );
}

const CARD =
  'block rounded-[7px] border border-border bg-surface px-2.5 py-2 hover:border-border-bright';

function Card({ item }: { item: WorkItem }): ReactElement {
  const body = (
    <>
      <span className="font-mono text-[11px] text-text-secondary">#{item.number}</span>
      <span className="mt-0.5 block text-[13px] text-text-primary [overflow-wrap:anywhere]">
        {item.title}
      </span>
      {item.chips.length > 0 ? (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {item.chips.map((chip) => (
            <Chip key={`${chip.kind}-${chip.text}`} chip={chip} />
          ))}
        </span>
      ) : null}
    </>
  );
  return (
    <Link to={item.to} data-work-item={item.number} className={CARD}>
      {body}
    </Link>
  );
}

function Column({ column, older }: { column: BoardColumn; older: ReactElement | null }) {
  return (
    <section
      data-board-column={column.id}
      data-count={column.items.length}
      aria-label={column.title}
      className="flex min-h-[300px] flex-col gap-2 rounded-[10px] border border-border bg-surface/40 p-2"
    >
      <h2
        className="flex items-baseline justify-between px-1 text-[13px] font-semibold"
        style={{ color: column.role ? `var(--role-${column.role})` : 'var(--text-primary)' }}
      >
        {column.title}
        <span className="font-mono text-[12px] font-normal text-text-secondary">
          {column.items.length}
        </span>
      </h2>
      {column.holder ? (
        <p data-holder className="px-1 font-mono text-[11px] text-text-secondary">
          {column.holder}
        </p>
      ) : null}
      {column.items.length === 0 ? (
        <p className="px-1 text-[12px] text-text-secondary">{column.empty ?? 'Nothing here'}</p>
      ) : (
        column.items.map((item) => <Card key={item.number} item={item} />)
      )}
      {older}
    </section>
  );
}

function OrderPanel({
  order,
  selected,
  onToggle,
}: {
  order: BoardView['orders'][number];
  selected: boolean;
  onToggle: () => void;
}): ReactElement {
  const percent = order.total === 0 ? 0 : Math.round((order.merged / order.total) * 100);
  return (
    <button
      type="button"
      data-work-order={order.name}
      aria-pressed={selected}
      onClick={onToggle}
      className={`min-w-0 flex-[1_1_280px] cursor-pointer rounded-[10px] border bg-surface px-3 py-2.5 text-left hover:border-border-bright ${
        selected ? 'border-border-bright' : 'border-border'
      }`}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 text-[13px] font-semibold text-text-primary">{order.name}</span>
        <span className="font-mono text-[11px] text-text-secondary">{orderProgress(order)}</span>
      </span>
      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-hover">
        <span
          className="block h-full rounded-full bg-[color:var(--role-test)]"
          style={{ width: `${percent}%` }}
        />
      </span>
    </button>
  );
}

/** The board once every source has answered: the work orders above the columns. */
export function BoardBody({
  view,
  order,
  onOrder,
}: {
  view: BoardView;
  /** The work order the address filters to, or null. */
  order: string | null;
  onOrder: (name: string | null) => void;
}): ReactElement {
  return (
    <div className="min-w-0 space-y-4">
      <p className="max-w-3xl text-[13px] text-text-secondary">
        Every work item, by who holds it right now, under the work order it belongs to. The columns
        are the work item's state in Archon, so this board never disagrees with the factory. Click
        one to see its rounds.
      </p>
      {view.orders.length > 0 ? (
        <div className="flex flex-wrap gap-2.5">
          {view.orders.map((o) => (
            <OrderPanel
              key={o.name}
              order={o}
              selected={order === o.name}
              onToggle={() => onOrder(order === o.name ? null : o.name)}
            />
          ))}
        </div>
      ) : null}
      <p data-not-in-order={view.notInOrder} className="text-[12px] text-text-secondary">
        {view.notInOrder} not in a work order
      </p>
      <div className="overflow-x-auto">
        <div className="grid min-w-[1320px] grid-cols-[repeat(9,minmax(140px,1fr))] gap-2">
          {view.columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              older={
                column.id === 'merged' && view.older > 0 && view.olderHref !== null ? (
                  <a
                    data-older
                    href={view.olderHref}
                    className="px-1 text-[12px] text-text-secondary underline hover:text-text-primary"
                  >
                    {view.older} older
                  </a>
                ) : null
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
