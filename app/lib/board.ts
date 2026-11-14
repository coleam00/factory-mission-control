/**
 * The Board (PRD 4.1, 4.9): every work item in the one column that holds it right now, under the
 * work orders it belongs to. The stage columns are the map's own cards, read with the map's "here"
 * rule, so the board never disagrees with the map. Pure, no React.
 */
import { cardForStep, FACTORY_MAP, type Role } from '../map/factory-map';
import {
  deepestStep,
  type HomeMapRow,
  lapCard,
  onQueues,
  stepsCard,
  type WorkOrderRow,
} from '../map/live';
import { localMinute } from './format';
import type { HealthWorkableRow } from './health';
import { stepPath } from './lap-graph';
import { lapHref } from './one-lap';
import {
  APP_CHECK_WORKFLOW,
  BUILD_QUEUE_WORKFLOW,
  INTAKE_WORKFLOW,
  MERGE_QUEUE_WORKFLOW,
  pullUrl,
  SPLIT_WORKFLOW,
} from './one-lap';
import type { OwnerQueueRow } from './owner-queue';
import { BOARD_ITEM_STATE, CHECK_OVERALL_STATE, type State } from './states';
import { stepName } from './runs';
import { needsYouLine, workItemHref } from './work-item';

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
  /** Archon's finished rounds, as many as it keeps (the last 10); the runs that reached ship when the item has no state. */
  rounds: number | null;
  /** The latest app check's overall verdict on its pull request. */
  app_check: string | null;
  /** The open pull request that closes it, else the one Archon's last round opened if open or merged, else the merged one that closes it. */
  pr: number | null;
  /** Whether the pull request that closes it is open, as before the projected pull request: not `pr`'s own state. */
  pr_open: boolean | null;
  /** The queues' work-item state, the five fields the Parked rule reads; null without a state. */
  build_status: string | null;
  build_at: string | null;
  merge_status: string | null;
  merge_at: string | null;
  triage_at: string | null;
  /** The queue's work-item stage (new, needs_maintainer, a route, needs_contract, blocked, close); null without a state. */
  stage: string | null;
  /** Archon's finished rounds (the last 10 it keeps) as JSON text, `{ at, reason, reviews, run_id }` each, in order; null without a state. */
  round_list: string | null;
  /** How often the item was returned, by the merge queue or by an owner's answered return, within the last 20 decisions Archon keeps, so not a total and it can fall; null without a state. */
  returns: number | null;
  /** The decision of the last build decision; null without one. */
  last_decision: string | null;
  /** The head commit of `pr`, and the head the latest app check on it ran against. */
  pr_head: string | null;
  app_check_head: string | null;
  /** When it merged: the merge fact's time only while that merge still finishes the item (no later build or triage, as the pack's `finished()`), else the delivering pull request's merge time: the latest merged one that closes the item, else the latest merged one that names it with `Refs`, else Archon's projected one. Null when none merged; only a closed item's is shown. */
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
  kind: 'route' | 'app' | 'pr' | 'order' | 'waiting';
  text: string;
  state?: State;
  /** A run is on the work item now. */
  pulse?: boolean;
}

/** One round's dot: a finished round takes its reason's state, the round a build run holds is running. */
export interface RoundDot {
  state: State;
  /** The hover text: "Round K: <reason>, <R> reviews · <local time>". */
  title: string;
}

/** The run that holds a work item: the workflow and its deepest running step, linking to the run. */
export interface RunLine {
  text: string;
  to: string;
}

export interface WorkItem {
  number: number;
  title: string;
  chips: BoardChip[];
  /** N of "round N": the finished rounds, plus one while a build run holds the item; 0 before the first. */
  round: number;
  dots: RoundDot[];
  run: RunLine | null;
  /** How often the merge queue sent it back. */
  returned: number;
  mergedAt: Date | null;
  /** Why a work item waiting on you or with a failed check stopped, in its state's color. */
  stop: { text: string; state: State } | null;
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

/** The queue stages an item with no column of its own is blocked on: a contract, or another pull request. */
export const BLOCKED_STAGES: readonly string[] = ['blocked', 'needs_contract'];

/** Where a work item stands on the Pipeline, left to right: seven stage columns, then the wide Blocked and parked card. */
const HOME_IDS = [
  'intake',
  'planned',
  'build',
  'review',
  'app',
  'merge',
  'merged',
  'blocked',
] as const;

export type HomeId = (typeof HOME_IDS)[number];

export interface HomeSpec {
  id: HomeId;
  title: string;
  subtitle: string;
}

const HOME_TEXT: Record<HomeId, Omit<HomeSpec, 'id'>> = {
  intake: { title: 'Intake', subtitle: 'triage' },
  planned: { title: 'Planned', subtitle: 'waits for a build slot' },
  build: { title: 'Build', subtitle: 'build rounds' },
  review: { title: 'Review', subtitle: 'reviews' },
  app: { title: 'App check', subtitle: 'app check' },
  merge: { title: 'Merge', subtitle: 'merge queue' },
  merged: { title: 'Merged', subtitle: 'last 7 days' },
  blocked: {
    title: 'Blocked and parked',
    subtitle: 'needs a contract, a decision or another PR',
  },
};

export const PIPELINE: readonly HomeSpec[] = HOME_IDS.map((id) => ({ id, ...HOME_TEXT[id] }));

export type Status = keyof typeof BOARD_ITEM_STATE;

export interface PipelineItem extends WorkItem {
  status: Status;
}

export interface StatusPill {
  label: Status;
  state: State;
  count: number;
}

export interface PipelineStage extends HomeSpec {
  /** Every item the stage holds. */
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

/** The run that holds a work item, and the stage its deepest running step is on. */
interface Hold {
  stage: StageId | null;
  run: string;
  workflow: string;
  /** The deepest running step's name, as the Runs screen shows it; null between two steps. */
  step: string | null;
}

function stepOf(row: HomeMapRow): string | null {
  const deepest = deepestStep(row.steps);
  return deepest === undefined ? null : stepName(deepest);
}

/** The running step of each run on the map, including a run that holds no work item by number. */
function stepsByRun(map: readonly HomeMapRow[]): Map<string, string | null> {
  return new Map(
    map.flatMap((row) =>
      row.kind === 'lap' && row.run_id !== null ? [[row.run_id, stepOf(row)] as const] : [],
    ),
  );
}

/**
 * Every work item with a running run, and the furthest run on it. A run on a card with no stage
 * column, or between two steps, is on no stage but still holds the work item; a split run holds
 * none.
 */
function runningRuns(map: readonly HomeMapRow[]): Map<number, Hold> {
  const running = new Map<number, Hold>();
  for (const row of map) {
    const { run_id: run, workflow } = row;
    if (row.kind !== 'lap' || row.number === null || run === null || workflow === null) continue;
    if (workflow === SPLIT_WORKFLOW) continue;
    const placed = lapCard(FACTORY_MAP, row)?.card.id;
    const hold: Hold = {
      stage: placed !== undefined && isStage(placed) ? placed : null,
      run,
      workflow,
      step: stepOf(row),
    };
    const was = running.get(row.number);
    if (was === undefined || furthest(was.stage, hold.stage) !== was.stage) {
      running.set(row.number, hold);
    }
  }
  return running;
}

/** Why an item waits or failed: the question its waiting run asks, else that a person is waited on, else its failed check. */
function stopOf(status: Status, question: string | null): WorkItem['stop'] {
  const state = BOARD_ITEM_STATE[status];
  if (status === 'needs you') return { text: needsYouLine(question), state };
  return status === 'check failed' ? { text: 'App check failed', state } : null;
}

/** The pack's round reasons that colour a dot; app/map/restated-rules.test.ts pins them to `Ended` in the pack's round.ts. */
export const REASON_STATE = { delivered: 'done', ask: 'needs-you' } as const;

/** The rounds Archon recorded, oldest first; an entry without a known reason is a grey dot. */
function recordedRounds(text: string | null): RoundDot[] {
  return listOf(text).map((entry, i): RoundDot => {
    const { at, reason, reviews } = (entry ?? {}) as Record<string, unknown>;
    const n = typeof reviews === 'number' ? reviews : 0;
    const when = typeof at === 'string' ? ` · ${localMinute(new Date(at))}` : '';
    const why = typeof reason === 'string' ? reason : 'no reason recorded';
    return {
      state: REASON_STATE[reason as keyof typeof REASON_STATE] ?? 'idle',
      title: `Round ${i + 1}: ${why}, ${n} ${n === 1 ? 'review' : 'reviews'}${when}`,
    };
  });
}

/** The run that holds an open item: the furthest of its build-side run and its running app check. */
function holdOf(row: BoardRow, number: number, facts: Facts): Hold | undefined {
  const held = facts.running.get(number);
  if (row.app_check_run === null) return held;
  const check: Hold = {
    stage: WORKFLOW_STAGE[APP_CHECK_WORKFLOW] ?? null,
    run: row.app_check_run,
    workflow: APP_CHECK_WORKFLOW,
    step: facts.steps.get(row.app_check_run) ?? null,
  };
  return held === undefined || furthest(held.stage, check.stage) !== held.stage ? check : held;
}

/** The check's passing verdict, keyed into the check-overall states so a rename there fails the type check. */
const PASS = 'PASS' satisfies keyof typeof CHECK_OVERALL_STATE;

function chipsOf(item: BoardRow, home: HomeId, needsYou: boolean, running: boolean): BoardChip[] {
  const chips: BoardChip[] = [];
  if (item.route !== null) chips.push({ kind: 'route', text: item.route });
  if (item.app_check === PASS)
    chips.push({ kind: 'app', text: 'app pass', state: CHECK_OVERALL_STATE[PASS] });
  if (item.app_check === 'FAIL')
    chips.push({ kind: 'app', text: 'app fail', state: CHECK_OVERALL_STATE.FAIL });
  if (item.pr !== null) chips.push({ kind: 'pr', text: `PR #${item.pr}` });
  for (const name of item.work_orders ?? []) chips.push({ kind: 'order', text: name });
  if (home === 'build' && !running && !needsYou)
    chips.push({ kind: 'waiting', text: 'waiting for a run', state: 'idle' });
  return chips;
}

interface Facts {
  /** Each work item a paused run waits on a person for, by the item the run holds (its claim, else its facts step's item, else its number input): the stage of that run's `waitCard`. */
  attention: ReadonlyMap<number, StageId | null>;
  /** The question each waiting run recorded, by the number its ask names: issues and pull requests share one number space. */
  questions: ReadonlyMap<number, string>;
  needsOwner: ReadonlySet<number>;
  running: ReadonlyMap<number, Hold>;
  steps: ReadonlyMap<string, string | null>;
  workable: ReadonlySet<number>;
}

/** The stage of a paused queue run, taken before its step (restated-rules.test.ts holds each entry to the map's covers): a queue workflow's steps can sit under another card (the build queue's review round). */
export const WORKFLOW_STAGE: Readonly<Record<string, StageId>> = {
  [INTAKE_WORKFLOW]: 'intake',
  [BUILD_QUEUE_WORKFLOW]: 'build',
  [APP_CHECK_WORKFLOW]: 'app',
  [MERGE_QUEUE_WORKFLOW]: 'merge',
};

/**
 * The map card a paused run's wait belongs to: a queue workflow's own card, else the card covering
 * the deepest step it was running when it paused, else the card covering the node it waits at.
 * Undefined when none is covered; each caller keeps its own fallback.
 */
export function waitCard(
  workflow: string,
  steps: readonly string[] | null,
  node: string | null,
): string | undefined {
  return (
    WORKFLOW_STAGE[workflow] ??
    stepsCard(FACTORY_MAP, workflow, steps)?.card.id ??
    (node === null ? undefined : cardForStep(FACTORY_MAP, workflow, stepPath(node))?.id)
  );
}

/** The column of a paused run's map card (`waitCard`); the home map's waiting row names no node, so the Board places by the queue workflow and the running steps alone. */
function pausedStage(row: HomeMapRow): StageId | null {
  if (row.workflow === null) return null;
  const id = waitCard(row.workflow, row.steps, null);
  return id !== undefined && isStage(id) ? id : null;
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

/** Why a work item sits on the Blocked and parked card: a queue parked it, or a contract or another pull request holds it. */
const heldKind = (row: WorkItemState): 'parked' | 'blocked' => (parked(row) ? 'parked' : 'blocked');

/** Where an open work item stands: its home, and whether it waits on the owner. */
interface Placement {
  home: HomeId;
  needsYou: boolean;
}

const furthest = (a: StageId | null, b: StageId | null): StageId | null =>
  a === null || (b !== null && STAGES.indexOf(b) > STAGES.indexOf(a)) ? b : a;

/** Whether the item is Ready for the app check and the merge queue: not one the merge queue returned since. */
const isReady = (row: BoardRow): boolean =>
  row.merge_status === 'waiting' ||
  (row.build_status === 'ready' &&
    (row.merge_status !== 'returned' || later(row.build_at, row.merge_at)));

/** The design's seven rules, first match wins (docs/design/v3/README.md, Board). */
function placeOf(row: BoardRow, number: number, facts: Facts, holder: StageId | null): Placement {
  if (parked(row) || (row.stage !== null && BLOCKED_STAGES.includes(row.stage)))
    return { home: 'blocked', needsYou: false };
  if (holder !== null) return { home: holder, needsYou: false };
  const asked =
    row.merge_status === 'asking'
      ? 'merge'
      : row.build_status === 'asking'
        ? 'build'
        : (facts.attention.get(number) ?? null);
  const needsYou = asked !== null || facts.attention.has(number) || facts.needsOwner.has(number);
  if (asked !== null) return { home: asked, needsYou };
  if (isReady(row)) {
    const passed = row.app_check === PASS && row.app_check_head === row.pr_head;
    return { home: passed ? 'merge' : 'app', needsYou };
  }
  if ((row.rounds ?? 0) >= 1) return { home: 'build', needsYou };
  return { home: facts.workable.has(number) ? 'planned' : 'intake', needsYou };
}

/** The Table column of a placed item: Your decision holds whoever waits on the owner. */
function tableColumnOf({ home, needsYou }: Placement): ColumnId {
  if (needsYou) return 'decision';
  if (home === 'planned') return 'queued';
  return home === 'blocked' ? 'parked' : home;
}

/** The question of the run asking about this item: its merge ask when it sits in Merge, else its issue's ask, else the other. */
function questionOf(row: BoardRow, number: number, home: HomeId, facts: Facts): string | null {
  const issue = facts.questions.get(number);
  const pr = row.pr === null ? undefined : facts.questions.get(row.pr);
  return (home === 'merge' ? (pr ?? issue) : (issue ?? pr)) ?? null;
}

function factsOf(
  map: readonly HomeMapRow[],
  workable: readonly HealthWorkableRow[],
  owner: readonly OwnerQueueRow[],
): Facts {
  return {
    attention: new Map(
      map.flatMap((r) =>
        r.kind === 'waiting' && r.number !== null ? [[r.number, pausedStage(r)] as const] : [],
      ),
    ),
    questions: new Map(
      map.flatMap((r) =>
        r.kind === 'waiting' && r.asks !== null && r.stop_line !== null
          ? [[r.asks, r.stop_line] as const]
          : [],
      ),
    ),
    // A queue factory holds an item with an attention wait, never with a needs-owner label.
    needsOwner: new Set(
      onQueues(map) ? [] : owner.filter((r) => r.kind === 'issue').map((r) => r.issue_number),
    ),
    running: runningRuns(map),
    steps: stepsByRun(map),
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
  /** Held on the Blocked and parked card by a contract or another pull request, not parked by a queue. */
  blocked: boolean;
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
  const facts = factsOf(sources.map, sources.workable, sources.owner);
  const placement =
    row.state === 'closed'
      ? null
      : placeOf(row, number, facts, holdOf(row, number, facts)?.stage ?? null);
  const id = placement === null ? 'merged' : tableColumnOf(placement);
  const blocked = placement?.home === 'blocked' && heldKind(row) === 'blocked';
  return {
    // The Table folds a blocked item into its Parked column; the page names it Blocked instead.
    column: blocked ? null : (COLUMNS.find((c) => c.id === id) ?? null),
    blocked,
    pr: row.pr,
    prUrl: row.pr === null || repository === null ? null : pullUrl(repository, row.pr),
    workOrders: row.work_orders ?? [],
  };
}

/** What an item is doing, first match: a person's wait, the home it sits in, a run, a failed check. */
function statusOf(row: BoardRow, home: HomeId, needsYou: boolean, running: boolean): Status {
  if (needsYou) return 'needs you';
  if (home === 'blocked') return heldKind(row);
  if (home === 'merged') return 'merged';
  if (running) return 'running';
  if (row.app_check === 'FAIL') return 'check failed';
  return home === 'planned' ? 'queued' : 'waiting';
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

  const columns = new Map<ColumnId, WorkItem[]>(COLUMNS.map((c) => [c.id, []]));
  const merged: { item: WorkItem; closedAt: Date }[] = [];
  const homes = new Map<HomeId, PipelineItem[]>(PIPELINE.map((h) => [h.id, []]));
  const tally = new Map<string, { building: number; needsYou: number }>();
  let notInOrder = 0;
  let recent = 0;
  for (const row of board) {
    if (row.kind !== 'item' || row.number === null) continue;
    const { number } = row;
    let placement: Placement;
    const hold = row.state === 'open' ? holdOf(row, number, facts) : undefined;
    if (row.state === 'closed') {
      if (!withinKeep(row.closed_at, now)) continue;
      recent++;
      placement = { home: 'merged', needsYou: false };
    } else placement = placeOf(row, number, facts, hold?.stage ?? null);
    const { home, needsYou } = placement;
    const isRunning = hold !== undefined;
    const status = statusOf(row, home, needsYou, isRunning);
    const names = row.work_orders ?? [];
    if (names.length === 0) notInOrder++;
    for (const name of names) {
      const counts = tally.get(name) ?? { building: 0, needsYou: 0 };
      if (status === 'running') counts.building++;
      if (status === 'needs you') counts.needsYou++;
      tally.set(name, counts);
    }
    if (order !== null && !names.includes(order)) continue;
    const dots = recordedRounds(row.round_list);
    const building =
      row.state === 'open' && facts.running.get(number)?.workflow === BUILD_QUEUE_WORKFLOW;
    if (building) dots.push({ state: 'running', title: `Round ${dots.length + 1}: running` });
    const item: WorkItem = {
      number,
      title: row.title ?? '',
      chips: chipsOf(row, home, needsYou, isRunning),
      round: dots.length,
      dots,
      run:
        hold === undefined
          ? null
          : {
              text: hold.step === null ? hold.workflow : `${hold.workflow} · ${hold.step}`,
              to: lapHref(factory, hold.run),
            },
      returned: row.returns ?? 0,
      mergedAt: home === 'merged' && row.merged_at !== null ? new Date(row.merged_at) : null,
      stop: stopOf(status, questionOf(row, number, home, facts)),
      to: workItemHref(factory, number),
    };
    homes.get(home)?.push({ ...item, status });
    if (home === 'merged' && row.closed_at !== null) merged.push({ item, closedAt: row.closed_at });
    else columns.get(tableColumnOf({ home, needsYou }))?.push(item);
  }
  for (const items of columns.values()) items.sort((a, b) => a.number - b.number);
  columns.set(
    'merged',
    merged
      .sort(
        (a, b) =>
          (b.item.mergedAt?.getTime() ?? 0) - (a.item.mergedAt?.getTime() ?? 0) ||
          b.closedAt.getTime() - a.closedAt.getTime() ||
          a.item.number - b.item.number,
      )
      .map((m) => m.item),
  );

  const mergedAt = new Map(columns.get('merged')?.map((item, i) => [item.number, i]));
  const total = factoryRow?.merged_total ?? recent;
  return {
    orders: orders
      .filter((o) => o.open_count > 0 || withinKeep(o.last_closed_at, now))
      .map((o) => ({ ...orderPanel(o), building: 0, needsYou: 0, ...tally.get(o.name) })),
    columns: COLUMNS.map((c) => ({ ...c, items: columns.get(c.id) ?? [] })),
    pipeline: PIPELINE.map((spec) => {
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
