/**
 * The Board (PRD 4.1, 4.9): every work item in the one column that holds it right now, under the
 * work orders it belongs to. The stage columns are the map's own cards, read with the map's "here"
 * rule, so the board never disagrees with the map. Pure, no React.
 */
import { FACTORY_MAP, type Role } from '../map/factory-map';
import { type HomeMapRow, lapCard, onQueues, type WorkOrderRow } from '../map/live';
import type { HealthWorkableRow } from './health';
import { consoleUrl } from './one-lap';
import type { OwnerQueueRow } from './owner-queue';

/** One row of `db/queries/board.sql`: a work item, or the one row for the factory. */
export interface BoardRow {
  kind: 'item' | 'factory';
  number: number | null;
  title: string | null;
  url: string | null;
  state: 'open' | 'closed' | null;
  closed_at: Date | null;
  /** Every `work-order:<name>` label, by name; null on the factory row. */
  work_orders: string[] | null;
  /** deliver, plan, investigate or split: the queue's state label, else the loop's claim. */
  route: string | null;
  rounds: number | null;
  /** The latest app check's overall verdict on its pull request. */
  app_check: string | null;
  /** The open pull request that closes it, else the merged one. */
  pr: number | null;
  pr_open: boolean | null;
  /** Its latest run. */
  run_id: string | null;
  run_workflow: string | null;
  /** The factory row: its repository, its Archon console and its work items a pull request merged. */
  repository: string | null;
  console: string | null;
  merged_total: number | null;
}

export type ColumnId =
  | 'queued'
  | 'intake'
  | 'build'
  | 'review'
  | 'app'
  | 'merge'
  | 'decision'
  | 'merged';

/** The map's cards the stage columns follow, in the order work moves through them. */
const STAGES = ['intake', 'build', 'review', 'app', 'merge'] as const;
type StageId = (typeof STAGES)[number];
const isStage = (id: string): id is StageId => (STAGES as readonly string[]).includes(id);

export interface ColumnSpec {
  id: ColumnId;
  title: string;
  /** The color of the title; absent for Queued, which is nobody's yet. */
  role?: Role;
}

function stageSpec(id: StageId): ColumnSpec {
  const card = FACTORY_MAP.cards.find((c) => c.id === id);
  if (card === undefined) throw new Error(`the factory map has no ${id} card`);
  return { id, title: card.title, role: card.role };
}

export const COLUMNS: readonly ColumnSpec[] = [
  { id: 'queued', title: 'Queued' },
  ...STAGES.map(stageSpec),
  { id: 'decision', title: 'Your decision', role: 'person' },
  { id: 'merged', title: 'Merged', role: 'test' },
];

/** How long a merged work item and a finished work order stay on the board. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface BoardChip {
  kind: 'route' | 'round' | 'app' | 'pr' | 'order' | 'waiting';
  text: string;
  tone?: 'running' | 'pass' | 'fail';
  /** A run is on the work item now. */
  pulse?: boolean;
}

/** Where a card opens: the in-app lap page, or a page outside the app. */
export type BoardLink = { kind: 'lap'; to: string } | { kind: 'external'; href: string };

export interface WorkItem {
  number: number;
  title: string;
  workOrders: string[];
  chips: BoardChip[];
  link: BoardLink;
}

export interface OrderPanel {
  name: string;
  merged: number;
  total: number;
  landsOn: string | null;
}

export interface BoardColumn extends ColumnSpec {
  items: WorkItem[];
}

export interface BoardView {
  orders: OrderPanel[];
  columns: BoardColumn[];
  /** Work items in a column that belong to no work order, whatever the filter. */
  notInOrder: number;
  /** Merged work items older than the last 7 days. */
  older: number;
  olderHref: string | null;
}

export interface BoardSources {
  factory: string;
  board: readonly BoardRow[];
  map: readonly HomeMapRow[];
  workable: readonly HealthWorkableRow[];
  owner: readonly OwnerQueueRow[];
  orders: readonly WorkOrderRow[];
}

const withinKeep = (at: Date | null, now: Date): at is Date =>
  at !== null && now.getTime() - at.getTime() < KEEP_MS;

/**
 * Every work item with a running run, and the furthest stage those runs are on. A run on a card
 * with no stage column, or between two steps, is on no stage but still holds the work item.
 */
function runningRuns(map: readonly HomeMapRow[]): Map<number, StageId | null> {
  const running = new Map<number, StageId | null>();
  for (const row of map) {
    if (row.kind !== 'lap' || row.number === null) continue;
    const placed = lapCard(FACTORY_MAP, row)?.card.id;
    const stage = placed !== undefined && isStage(placed) ? placed : null;
    const was = running.get(row.number) ?? null;
    const further = stage !== null && (was === null || STAGES.indexOf(stage) > STAGES.indexOf(was));
    running.set(row.number, further ? stage : was);
  }
  return running;
}

function chipsOf(item: BoardRow, column: ColumnId, running: boolean): BoardChip[] {
  const chips: BoardChip[] = [];
  if (item.route !== null) chips.push({ kind: 'route', text: item.route });
  const rounds = item.rounds ?? 0;
  if (running) {
    chips.push({
      kind: 'round',
      text: rounds >= 1 ? `round ${rounds}` : 'running',
      tone: 'running',
      pulse: true,
    });
  } else if (rounds >= 1) chips.push({ kind: 'round', text: `round ${rounds}` });
  if (item.app_check === 'PASS') chips.push({ kind: 'app', text: 'app pass', tone: 'pass' });
  if (item.app_check === 'FAIL') chips.push({ kind: 'app', text: 'app fail', tone: 'fail' });
  if (item.pr !== null) chips.push({ kind: 'pr', text: `PR #${item.pr}` });
  for (const name of item.work_orders ?? []) chips.push({ kind: 'order', text: name });
  if (column === 'build' && !running) chips.push({ kind: 'waiting', text: 'waiting for a run' });
  return chips;
}

/** Until the work item has its own page, its card opens its latest run, else the issue. */
function linkOf(item: BoardRow, factory: string, consoleBase: string | null): BoardLink {
  if (item.run_id !== null && item.run_workflow === 'archon-loop')
    return { kind: 'lap', to: `/f/${factory}/laps/${item.run_id}` };
  if (item.run_id !== null && consoleBase !== null)
    return { kind: 'external', href: consoleUrl(consoleBase, item.run_id) };
  return { kind: 'external', href: item.url ?? '' };
}

interface Facts {
  attention: ReadonlySet<number>;
  needsOwner: ReadonlySet<number>;
  running: ReadonlyMap<number, StageId | null>;
  workable: ReadonlySet<number>;
}

/** The column that holds an open work item right now; the first rule that matches wins. */
function columnOf(number: number, prOpen: boolean, facts: Facts): ColumnId | null {
  if (facts.attention.has(number) || facts.needsOwner.has(number)) return 'decision';
  const stage = facts.running.get(number);
  if (stage) return stage;
  if (facts.running.has(number)) return null;
  if (prOpen) return 'build';
  return facts.workable.has(number) ? 'queued' : null;
}

export function boardView(sources: BoardSources, now: Date, order: string | null): BoardView {
  const { factory, board, map, workable, owner, orders } = sources;
  const factoryRow = board.find((r) => r.kind === 'factory');
  const running = runningRuns(map);
  const facts: Facts = {
    attention: new Set(
      map.flatMap((r) => (r.kind === 'waiting' && r.number !== null ? [r.number] : [])),
    ),
    // A queue factory holds an item with an attention wait, never with a needs-owner label.
    needsOwner: new Set(
      onQueues(map) ? [] : owner.filter((r) => r.kind === 'issue').map((r) => r.issue_number),
    ),
    running,
    workable: new Set(
      workable.flatMap((r) =>
        r.kind === 'issue' && r.issue_number !== null ? [r.issue_number] : [],
      ),
    ),
  };

  const columns = new Map<ColumnId, WorkItem[]>(COLUMNS.map((c) => [c.id, []]));
  const merged: { item: WorkItem; closedAt: Date }[] = [];
  let notInOrder = 0;
  let recent = 0;
  for (const row of board) {
    if (row.kind !== 'item' || row.number === null) continue;
    const { number } = row;
    let column: ColumnId | null;
    if (row.state === 'closed') {
      if (!withinKeep(row.closed_at, now)) continue;
      recent++;
      column = 'merged';
    } else column = columnOf(number, row.pr_open === true, facts);
    if (column === null) continue;
    const names = row.work_orders ?? [];
    if (names.length === 0) notInOrder++;
    if (order !== null && !names.includes(order)) continue;
    const item: WorkItem = {
      number,
      title: row.title ?? '',
      workOrders: names,
      chips: chipsOf(row, column, row.state === 'open' && running.has(number)),
      link: linkOf(row, factory, factoryRow?.console ?? null),
    };
    if (column === 'merged' && row.closed_at !== null)
      merged.push({ item, closedAt: row.closed_at });
    else columns.get(column)?.push(item);
  }
  for (const items of columns.values()) items.sort((a, b) => a.number - b.number);
  columns.set(
    'merged',
    merged
      .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime() || a.item.number - b.item.number)
      .map((m) => m.item),
  );

  const total = factoryRow?.merged_total ?? recent;
  return {
    orders: orders
      .filter((o) => o.open_count > 0 || withinKeep(o.last_closed_at, now))
      .map((o) => ({
        name: o.name,
        merged: o.merged_count,
        total: o.total_count,
        landsOn: o.lands_on,
      })),
    columns: COLUMNS.map((c) => ({ ...c, items: columns.get(c.id) ?? [] })),
    notInOrder,
    older: Math.max(0, total - recent),
    olderHref:
      factoryRow?.repository == null
        ? null
        : `https://github.com/${factoryRow.repository}/issues?q=is%3Aissue+is%3Aclosed`,
  };
}

/** When the board next changes with no new rows: a merged work item or a finished order drops off. */
export function nextChange(
  sources: Pick<BoardSources, 'board' | 'orders'>,
  now: Date,
): Date | null {
  const drops = [
    ...sources.board.flatMap((r) =>
      r.kind === 'item' && r.state === 'closed' ? [r.closed_at] : [],
    ),
    ...sources.orders.flatMap((o) => (o.open_count === 0 ? [o.last_closed_at] : [])),
  ]
    .flatMap((at) => (at === null ? [] : [at.getTime() + KEEP_MS]))
    .filter((at) => at > now.getTime());
  return drops.length === 0 ? null : new Date(Math.min(...drops));
}
