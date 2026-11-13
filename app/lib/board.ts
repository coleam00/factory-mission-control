/**
 * The Board (PRD 4.1, 4.9): every work item in the one column that holds it right now, under the
 * work orders it belongs to. The stage columns are the map's own cards, read with the map's "here"
 * rule, so the board never disagrees with the map. Pure, no React.
 */
import { FACTORY_MAP, type Role } from '../map/factory-map';
import { type HomeMapRow, lapCard, onQueues, type WorkOrderRow } from '../map/live';
import type { HealthWorkableRow } from './health';
import { pullUrl, SPLIT_WORKFLOW } from './one-lap';
import type { OwnerQueueRow } from './owner-queue';
import { BOARD_ITEM_STATE, CHECK_OVERALL_STATE, type State } from './states';
import { workItemHref } from './work-item';

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
  /** Archon's finished rounds; the runs that reached ship when the item has no state. */
  rounds: number | null;
  /** The latest app check's overall verdict on its pull request. */
  app_check: string | null;
  /** The open pull request that closes it, else the one Archon's last round opened if open or merged, else the merged one that closes it. */
  pr: number | null;
  pr_open: boolean | null;
  /** The queues' work-item state, the five fields the Parked rule reads; null without a state. */
  build_status: string | null;
  build_at: string | null;
  merge_status: string | null;
  merge_at: string | null;
  triage_at: string | null;
  /** The queue's work-item stage (new, needs_maintainer, a route, needs_contract, blocked, close); null without a state. */
  stage: string | null;
  /** Archon's finished rounds as JSON text, `{ at, reason, reviews, run_id }` each, in order; null without a state. */
  round_list: string | null;
  /** How often the merge queue returned the item; null without a state. */
  returns: number | null;
  /** The decision of the last build decision; null without one. */
  last_decision: string | null;
  /** The head commit of `pr`, and the head the latest app check on it ran against. */
  pr_head: string | null;
  app_check_head: string | null;
  /** When it merged: the merge fact's time, else its merged pull request's. */
  merged_at: string | null;
  /** The running app check run on `pr`. */
  app_check_run: string | null;
  /** The factory row: its repository and its work items a pull request merged. */
  repository: string | null;
  merged_total: number | null;
}

/** One row of `db/queries/discoveries.sql`: a finished discoveries run's decisions, as JSON text. */
export interface DiscoveryRow {
  run_id: string;
  /** The `written` list of the run's outcome: `{ key, outcome: 'file' | 'track', url }` entries. */
  written: string | null;
  /** The `dropped` list of the run's outcome. */
  dropped: string | null;
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
  /** Who holds the column's items, shown under its title, as the reference (`docs/design/v2/mockup.html` `COLS`) names it. */
  holder: string;
  /** What an empty column says; 'Nothing here' when absent. */
  empty?: string;
}

/** Who holds a stage column's items: the reference's captions, and for Review and App check the workflow that runs them. */
const STAGE_HOLDER: Record<StageId, string> = {
  intake: 'triage',
  build: 'build queue',
  review: 'build queue',
  app: 'app check',
  merge: 'merge queue',
};

function stageSpec(id: StageId): ColumnSpec {
  const card = FACTORY_MAP.cards.find((c) => c.id === id);
  if (card === undefined) throw new Error(`the factory map has no ${id} card`);
  return { id, title: card.title, role: card.role, holder: STAGE_HOLDER[id] };
}

export const COLUMNS: readonly ColumnSpec[] = [
  { id: 'queued', title: 'Queued', holder: 'build queue' },
  ...STAGES.map(stageSpec),
  { id: 'decision', title: 'Your decision', role: 'person', holder: 'manager' },
  { id: 'merged', title: 'Merged', role: 'test', holder: 'done' },
  { id: 'parked', title: 'Parked', holder: 'you', empty: 'Empty' },
];

/** How long a merged work item and a finished work order stay on the board. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface BoardChip {
  kind: 'route' | 'round' | 'app' | 'pr' | 'order' | 'waiting';
  text: string;
  state?: State;
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

/** The query parameter the Board filters to one work order by. */
export const ORDER_PARAM = 'order';

/** The Board filtered to one work order: the one address every link to it is built from. */
export function boardHref(factory: string, order: string): string {
  return `/f/${encodeURIComponent(factory)}/board?${ORDER_PARAM}=${encodeURIComponent(order)}`;
}

/** The Board's panel for a work order row; the map reads orders through it too. */
export function orderPanel(row: WorkOrderRow): OrderPanel {
  return {
    name: row.name,
    merged: row.merged_count,
    total: row.total_count,
    landsOn: row.lands_on,
  };
}

/** How far a work order has got, in the words the Board and the map both show. */
export function orderProgress({ merged, total, landsOn }: OrderPanel): string {
  return `${merged} of ${total} merged${landsOn === null ? '' : ` · lands on ${landsOn}`}`;
}

export interface BoardColumn extends ColumnSpec {
  items: WorkItem[];
}

/** The query parameter that picks the Table; the Pipeline is the default. */
export const VIEW_PARAM = 'view';

/** The `VIEW_PARAM` value that picks the Table. */
export const TABLE_VIEW = 'table';

/** How many mini cards a Pipeline card shows before it points at the Table. */
export const MINI_CARDS = 3;

/** The queue stages an item with no column of its own is blocked on: a contract, or another pull request. */
export const BLOCKED_STAGES: readonly string[] = ['blocked', 'needs_contract'];

export type HomeId = 'intake' | 'planned' | 'build' | 'merge' | 'merged' | 'blocked';

export interface HomeSpec {
  id: HomeId;
  title: string;
  subtitle: string;
  /** The Table columns whose items this home holds; every column is in exactly one home. */
  columns: readonly ColumnId[];
}

/** The Pipeline's five stages, then the wide "Blocked and parked" card, each a fold of Table columns. */
export const PIPELINE: readonly HomeSpec[] = [
  { id: 'intake', title: 'Intake', subtitle: 'triage', columns: ['intake'] },
  { id: 'planned', title: 'Planned', subtitle: 'waits for build', columns: ['queued'] },
  { id: 'build', title: 'Build', subtitle: 'rounds', columns: ['build', 'review'] },
  { id: 'merge', title: 'Merge', subtitle: 'check, gate, merge', columns: ['app', 'merge'] },
  { id: 'merged', title: 'Merged', subtitle: 'last 7 days', columns: ['merged'] },
  {
    id: 'blocked',
    title: 'Blocked and parked',
    subtitle: 'needs a contract, a decision or another PR',
    columns: ['decision', 'parked'],
  },
];

export type Status = keyof typeof BOARD_ITEM_STATE;

export interface PipelineItem extends WorkItem {
  status: Status;
}

export interface StatusPill {
  label: Status;
  state: State;
  count: number;
}

export interface PipelineStage extends Omit<HomeSpec, 'columns'> {
  /** Every item the stage holds; its card shows the first `MINI_CARDS`. */
  items: PipelineItem[];
  pills: StatusPill[];
}

/** Filed, tracked and dropped by the discoveries runs. */
export interface Found {
  filed: number;
  tracked: number;
  dropped: number;
}

export interface BoardOrder extends OrderPanel {
  /** Open items of the order a run holds, and those waiting on a person, whatever the filter. */
  building: number;
  needsYou: number;
}

/** A work order's target, as the strip names it. */
export function orderTarget({ landsOn }: OrderPanel): string {
  return landsOn === null ? 'work order' : `work order · lands on ${landsOn}`;
}

/** How far a work order has got, as the strip counts it; a part of zero is left out. */
export function orderLine({ merged, total, building, needsYou }: BoardOrder): string {
  return [
    `${merged} of ${total} merged`,
    ...(building > 0 ? [`${building} building`] : []),
    ...(needsYou > 0 ? [`${needsYou} needs you`] : []),
  ].join(' · ');
}

export interface BoardView {
  orders: BoardOrder[];
  columns: BoardColumn[];
  pipeline: PipelineStage[];
  found: Found;
  /** Work items with a home on the Pipeline that belong to no work order, whatever the filter. */
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
  discoveries: readonly DiscoveryRow[];
}

const withinKeep = (at: Date | null, now: Date): at is Date =>
  at !== null && now.getTime() - at.getTime() < KEEP_MS;

/**
 * Every work item with a running run, and the furthest stage those runs are on. A run on a card
 * with no stage column, or between two steps, is on no stage but still holds the work item; a
 * split run holds none.
 */
function runningRuns(map: readonly HomeMapRow[]): Map<number, StageId | null> {
  const running = new Map<number, StageId | null>();
  for (const row of map) {
    if (row.kind !== 'lap' || row.number === null || row.workflow === SPLIT_WORKFLOW) continue;
    const placed = lapCard(FACTORY_MAP, row)?.card.id;
    const stage = placed !== undefined && isStage(placed) ? placed : null;
    const was = running.get(row.number) ?? null;
    const further = stage !== null && (was === null || STAGES.indexOf(stage) > STAGES.indexOf(was));
    running.set(row.number, further ? stage : was);
  }
  return running;
}

function chipsOf(item: BoardRow, column: ColumnId | null, running: boolean): BoardChip[] {
  const chips: BoardChip[] = [];
  if (item.route !== null) chips.push({ kind: 'route', text: item.route });
  const rounds = item.rounds ?? 0;
  if (running) {
    chips.push({
      kind: 'round',
      text: rounds >= 1 ? `round ${rounds}` : 'running',
      state: 'running',
      pulse: true,
    });
  } else if (rounds >= 1) chips.push({ kind: 'round', text: `round ${rounds}` });
  if (item.app_check === 'PASS')
    chips.push({ kind: 'app', text: 'app pass', state: CHECK_OVERALL_STATE.PASS });
  if (item.app_check === 'FAIL')
    chips.push({ kind: 'app', text: 'app fail', state: CHECK_OVERALL_STATE.FAIL });
  if (item.pr !== null) chips.push({ kind: 'pr', text: `PR #${item.pr}` });
  for (const name of item.work_orders ?? []) chips.push({ kind: 'order', text: name });
  if (column === 'build' && !running)
    chips.push({ kind: 'waiting', text: 'waiting for a run', state: 'idle' });
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
  'build_status' | 'build_at' | 'merge_status' | 'merge_at' | 'triage_at'
>;

/** Whether `at` is a later ISO instant than `than`; compared as text, as the queues compare them. */
const later = (at: string | null, than: string | null) => at !== null && than !== null && at > than;

/** The status both queues record for an item they stopped working; the pack's BuildStatus and MergeStatus name it (restated-rules.test.ts). */
export const PARKED = 'parked';

/**
 * Whether the queues have parked a work item and nothing since has released it: its build record
 * says parked and no triage came after that decision, or its merge record says parked and neither a
 * triage nor a renewed readiness came after it. Restates `buildWaits` and `mergeWaits` of the
 * queue pack, as does db/queries/health-workable.sql; db/queries/restated-rules.test.ts fails when
 * any of them disagree.
 */
export function parked(state: WorkItemState): boolean {
  if (state.build_status === PARKED) return !later(state.triage_at, state.build_at);
  if (state.merge_status !== PARKED || later(state.triage_at, state.merge_at)) return false;
  return !(state.build_status === 'ready' && later(state.build_at, state.merge_at));
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

/** What an item is doing, first match: a person's wait, the home it sits in, a run, a failed check. */
function statusOf(row: BoardRow, home: ColumnId | 'blocked', running: boolean): Status {
  if (home === 'decision') return 'needs you';
  if (home === 'parked' || home === 'blocked' || home === 'merged') return home;
  if (running) return 'running';
  if (row.app_check === 'FAIL') return 'check failed';
  return home === 'queued' ? 'queued' : 'waiting';
}

const STATE_RANK: Record<State, number> = {
  'needs-you': 0,
  failed: 1,
  running: 2,
  idle: 3,
  done: 4,
};
const stateRank = (status: Status) => STATE_RANK[BOARD_ITEM_STATE[status]];

function pillsOf(items: readonly PipelineItem[]): StatusPill[] {
  const counts = new Map<Status, number>();
  for (const { status } of items) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => ({ label, state: BOARD_ITEM_STATE[label], count }))
    .sort((a, b) => stateRank(a.label) - stateRank(b.label));
}

/** The `written[].outcome` values of the pack's discoveries `outcome` node: filed, then tracked. */
export const FOUND_OUTCOMES = ['file', 'track'] as const;

/** A JSON list held as text; anything else is an empty list. */
function listOf(text: string | null): unknown[] {
  const list = text === null ? null : (JSON.parse(text) as unknown);
  return Array.isArray(list) ? list : [];
}

/** The discoveries runs' decisions, counted; a value that is not a list counts nothing. */
export function found(rows: readonly DiscoveryRow[]): Found {
  const result: Found = { filed: 0, tracked: 0, dropped: 0 };
  for (const row of rows) {
    for (const entry of listOf(row.written)) {
      const outcome = (entry as { outcome?: unknown } | null)?.outcome;
      if (outcome === FOUND_OUTCOMES[0]) result.filed++;
      if (outcome === FOUND_OUTCOMES[1]) result.tracked++;
    }
    result.dropped += listOf(row.dropped).length;
  }
  return result;
}

export function boardView(sources: BoardSources, now: Date, order: string | null): BoardView {
  const { factory, board, map, workable, owner, orders, discoveries } = sources;
  const factoryRow = board.find((r) => r.kind === 'factory');
  const facts = factsOf(map, workable, owner);
  const { running } = facts;

  const columns = new Map<ColumnId, WorkItem[]>(COLUMNS.map((c) => [c.id, []]));
  const merged: { item: WorkItem; closedAt: Date }[] = [];
  const homes = new Map<HomeId, PipelineItem[]>(PIPELINE.map((h) => [h.id, []]));
  const tally = new Map<string, { building: number; needsYou: number }>();
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
    const blocked = column === null && row.stage !== null && BLOCKED_STAGES.includes(row.stage);
    const placed = blocked ? 'blocked' : column;
    if (placed === null) continue;
    const isRunning = row.state === 'open' && running.has(number);
    const status = statusOf(row, placed, isRunning);
    const names = row.work_orders ?? [];
    if (names.length === 0) notInOrder++;
    for (const name of names) {
      const counts = tally.get(name) ?? { building: 0, needsYou: 0 };
      if (status === 'running') counts.building++;
      if (status === 'needs you') counts.needsYou++;
      tally.set(name, counts);
    }
    if (order !== null && !names.includes(order)) continue;
    const item: WorkItem = {
      number,
      title: row.title ?? '',
      chips: chipsOf(row, column, isRunning),
      to: workItemHref(factory, number),
    };
    const home = PIPELINE.find((h) =>
      placed === 'blocked' ? h.id === 'blocked' : h.columns.includes(placed),
    );
    homes.get(home?.id ?? 'blocked')?.push({ ...item, status });
    if (column === null) continue;
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

  const mergedAt = new Map(columns.get('merged')?.map((item, i) => [item.number, i]));
  const total = factoryRow?.merged_total ?? recent;
  return {
    orders: orders
      .filter((o) => o.open_count > 0 || withinKeep(o.last_closed_at, now))
      .map((o) => ({ ...orderPanel(o), building: 0, needsYou: 0, ...tally.get(o.name) })),
    columns: COLUMNS.map((c) => ({ ...c, items: columns.get(c.id) ?? [] })),
    pipeline: PIPELINE.map(({ columns: _, ...spec }) => {
      const items = (homes.get(spec.id) ?? []).sort(
        (a, b) =>
          stateRank(a.status) - stateRank(b.status) ||
          (spec.id === 'merged'
            ? (mergedAt.get(a.number) ?? 0) - (mergedAt.get(b.number) ?? 0)
            : a.number - b.number),
      );
      return { ...spec, items, pills: pillsOf(items) };
    }),
    found: found(discoveries),
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
