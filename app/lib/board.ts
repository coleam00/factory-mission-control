/**
 * The Board (PRD 4.1, 4.9): every work item in the one column that holds it right now, under the
 * work orders it belongs to. The stage columns are the map's own cards, read with the map's "here"
 * rule, so the board never disagrees with the map. Pure, no React.
 */
import { FACTORY_MAP, type Role } from '../map/factory-map';
import { type HomeMapRow, lapCard, onQueues, type WorkOrderRow } from '../map/live';
import type { HealthWorkableRow } from './health';
import { pullUrl } from './one-lap';
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
  /** The queues' work-item state, the six fields the Parked rule reads; null without a state. */
  build_status: string | null;
  build_at: string | null;
  merge_status: string | null;
  merge_at: string | null;
  triage_at: string | null;
  own_pr_at: string | null;
  /** The factory row: its repository and its work items a pull request merged. */
  repository: string | null;
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
  | 'merged'
  | 'parked';

/** The map's cards the stage columns follow, in the order work moves through them. */
const STAGES = ['intake', 'build', 'review', 'app', 'merge'] as const;
type StageId = (typeof STAGES)[number];
const isStage = (id: string): id is StageId => (STAGES as readonly string[]).includes(id);

export interface ColumnSpec {
  id: ColumnId;
  title: string;
  /** The color of the title; absent for Queued, which is nobody's yet. */
  role?: Role;
  /** Who holds the column's items, under its title. */
  holder?: string;
  /** What an empty column says; 'Nothing here' when absent. */
  empty?: string;
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
  { id: 'parked', title: 'Parked', holder: 'you', empty: 'Empty' },
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

export interface WorkItem {
  number: number;
  title: string;
  chips: BoardChip[];
  /** The work item's own page. */
  to: string;
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

interface Facts {
  attention: ReadonlySet<number>;
  needsOwner: ReadonlySet<number>;
  running: ReadonlyMap<number, StageId | null>;
  workable: ReadonlySet<number>;
}

type WorkItemState = Pick<
  BoardRow,
  'build_status' | 'build_at' | 'merge_status' | 'merge_at' | 'triage_at' | 'own_pr_at'
>;

/** Whether `at` is a later ISO instant than `than`; compared as text, as the queues compare them. */
const later = (at: string | null, than: string | null) => at !== null && than !== null && at > than;

/**
 * Whether the queues have parked a work item and nothing since has released it: its build record
 * says parked and no triage came after that decision, or its merge record says parked and neither a
 * triage nor a renewed readiness came after it. Restates `buildWaits` and `mergeWaits` of the
 * queue pack; db/queries/restated-rules.test.ts fails when they disagree.
 */
export function parked(state: WorkItemState): boolean {
  if (state.build_status === 'parked') return !later(state.triage_at, state.build_at);
  if (state.merge_status !== 'parked' || later(state.triage_at, state.merge_at)) return false;
  // An own pull request is renewed only by a new head, which the state does not hold.
  if (state.build_status === null && state.own_pr_at !== null) return true;
  const readyAt = state.build_status === 'ready' ? state.build_at : state.own_pr_at;
  return !later(readyAt, state.merge_at);
}

/** The column that holds an open work item right now; the first rule that matches wins. */
function columnOf(row: BoardRow, number: number, facts: Facts): ColumnId | null {
  if (parked(row)) return 'parked';
  const prOpen = row.pr_open === true;
  if (facts.attention.has(number) || facts.needsOwner.has(number)) return 'decision';
  const stage = facts.running.get(number);
  if (stage) return stage;
  if (facts.running.has(number)) return null;
  if (prOpen) return 'build';
  return facts.workable.has(number) ? 'queued' : null;
}

function factsOf(
  map: readonly HomeMapRow[],
  workable: readonly HealthWorkableRow[],
  owner: readonly OwnerQueueRow[],
): Facts {
  return {
    attention: new Set(
      map.flatMap((r) => (r.kind === 'waiting' && r.number !== null ? [r.number] : [])),
    ),
    // A queue factory holds an item with an attention wait, never with a needs-owner label.
    needsOwner: new Set(
      onQueues(map) ? [] : owner.filter((r) => r.kind === 'issue').map((r) => r.issue_number),
    ),
    running: runningRuns(map),
    workable: new Set(
      workable.flatMap((r) =>
        r.kind === 'issue' && r.issue_number !== null ? [r.issue_number] : [],
      ),
    ),
  };
}

/** Where a work item stands on the board, whatever the board's display window. */
export interface ItemOnBoard {
  column: ColumnSpec | null;
  pr: number | null;
  prUrl: string | null;
  workOrders: string[];
}

/** One work item as the board holds it, or null when the board's query returns no row for it. */
export function itemOnBoard(
  sources: Pick<BoardSources, 'board' | 'map' | 'workable' | 'owner'>,
  number: number,
): ItemOnBoard | null {
  const row = sources.board.find((r) => r.kind === 'item' && r.number === number);
  if (row === undefined) return null;
  const repository = sources.board.find((r) => r.kind === 'factory')?.repository ?? null;
  const id =
    row.state === 'closed'
      ? 'merged'
      : columnOf(row, number, factsOf(sources.map, sources.workable, sources.owner));
  return {
    column: COLUMNS.find((c) => c.id === id) ?? null,
    pr: row.pr,
    prUrl: row.pr === null || repository === null ? null : pullUrl(repository, row.pr),
    workOrders: row.work_orders ?? [],
  };
}

export function boardView(sources: BoardSources, now: Date, order: string | null): BoardView {
  const { factory, board, map, workable, owner, orders } = sources;
  const factoryRow = board.find((r) => r.kind === 'factory');
  const facts = factsOf(map, workable, owner);
  const { running } = facts;

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
    } else column = columnOf(row, number, facts);
    if (column === null) continue;
    const names = row.work_orders ?? [];
    if (names.length === 0) notInOrder++;
    if (order !== null && !names.includes(order)) continue;
    const item: WorkItem = {
      number,
      title: row.title ?? '',
      chips: chipsOf(row, column, row.state === 'open' && running.has(number)),
      to: `/f/${encodeURIComponent(factory)}/work/${number}`,
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
