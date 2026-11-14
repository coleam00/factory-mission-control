import { expect, test } from 'bun:test';
import type { HomeMapRow, WorkOrderRow } from '../map/live';
import {
  type BoardRow,
  type BoardSources,
  boardView,
  COLUMNS,
  found,
  itemOnBoard,
  KEEP_MS,
  nextChange,
  orderLine,
  orderTarget,
  PIPELINE,
  parked,
} from './board';
import type { OwnerQueueRow } from './owner-queue';

const NOW = new Date('2026-11-04T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const item = (number: number, over: Partial<BoardRow> = {}): BoardRow => ({
  kind: 'item',
  number,
  title: `Item ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  state: 'open',
  closed_at: null,
  work_orders: null,
  route: null,
  rounds: 0,
  app_check: null,
  pr: null,
  pr_open: null,
  build_status: null,
  build_at: null,
  merge_status: null,
  merge_at: null,
  triage_at: null,
  stage: null,
  round_list: null,
  returns: null,
  last_decision: null,
  pr_head: null,
  app_check_head: null,
  merged_at: null,
  app_check_run: null,
  repository: null,
  merged_total: null,
  ...over,
});
const factoryRow = (over: Partial<BoardRow> = {}): BoardRow => ({
  ...item(0),
  kind: 'factory',
  number: null,
  title: null,
  url: null,
  state: null,
  repository: 'o/r',
  merged_total: 0,
  ...over,
});
const lap = (number: number, workflow: string, steps: string[] | null): HomeMapRow => ({
  kind: 'lap',
  run_id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  workflow,
  steps,
  number,
  title: null,
  url: null,
  at: null,
  prs: null,
});
const row = (kind: HomeMapRow['kind'], number: number | null = null): HomeMapRow => ({
  ...lap(number ?? 0, 'archon-build-queue', null),
  kind,
  run_id: kind === 'queues' ? null : '00000000-0000-4000-8000-0000000000aa',
  workflow: null,
  number,
});
const BUILD = 'ship__deliver__rounds.implement__implement';
const REVIEW = 'ship__deliver__rounds.review__policy';
const ORDER = (over: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  name: 'screens',
  total_count: 4,
  open_count: 3,
  merged_count: 1,
  lands_on: null,
  last_closed_at: null,
  ...over,
});

const view = (over: Partial<BoardSources>, order: string | null = null) =>
  boardView(
    {
      factory: 'f',
      board: [],
      map: [],
      workable: [],
      owner: [],
      orders: [],
      discoveries: [],
      ...over,
    },
    NOW,
    order,
  );
const column = (v: ReturnType<typeof view>, id: string) =>
  v.columns.find((c) => c.id === id)?.items.map((i) => i.number);
const workable = (number: number) => ({
  kind: 'issue' as const,
  issue_number: number,
  title: null,
  url: null,
  run_id: null,
});

test('an attention item beats a running run, and a stage beats nothing', () => {
  const v = view({
    board: [item(1), item(2)],
    map: [
      lap(1, 'archon-build-queue', [BUILD]),
      row('waiting', 1),
      lap(2, 'archon-build-queue', [BUILD]),
    ],
  });
  expect(column(v, 'decision')).toEqual([1]);
  expect(column(v, 'build')).toEqual([2]);
});

test('the furthest stage a work item runs on wins', () => {
  const v = view({
    board: [item(1)],
    map: [lap(1, 'archon-intake', ['triage']), lap(1, 'archon-build-queue', [REVIEW])],
  });
  expect(column(v, 'review')).toEqual([1]);
  expect(column(v, 'intake')).toEqual([]);
});

test('a run on a card with no column, or between steps, holds the work item out of Queued', () => {
  const v = view({
    board: [item(1), item(2), item(3)],
    map: [lap(1, 'archon-intake', ['slice']), lap(2, 'archon-build-queue', null)],
    workable: [workable(1), workable(2), workable(3)],
  });
  expect(v.columns.flatMap((c) => c.items.map((i) => i.number))).toEqual([3]);
  expect(column(v, 'queued')).toEqual([3]);
});

test('a running split run holds no work item: it stays in Queued', () => {
  const v = view({
    board: [item(1)],
    map: [lap(1, 'archon-split', ['slice'])],
    workable: [workable(1)],
  });
  expect(column(v, 'queued')).toEqual([1]);
});

test('an open pull request with no run waits in Build; Queued is workable items only', () => {
  const v = view({
    board: [item(1, { pr: 9, pr_open: true }), item(2), item(3)],
    workable: [workable(2)],
  });
  expect(v.columns.find((c) => c.id === 'build')?.items[0]?.chips.map((c) => c.text)).toEqual([
    'PR #9',
    'waiting for a run',
  ]);
  expect(column(v, 'queued')).toEqual([2]);
});

test('needs-owner counts on the old loop, not on the queues, and a question never does', () => {
  const owner = [
    { kind: 'issue', issue_number: 1 },
    { kind: 'question', issue_number: 2, question_number: 1 },
  ] as OwnerQueueRow[];
  const board = [item(1), item(2)];
  const old = view({ board, owner });
  expect(column(old, 'decision')).toEqual([1]);
  expect(column(view({ board, owner, map: [row('queues')] }), 'decision')).toEqual([]);
});

test('Merged keeps the last 7 days, newest first, and counts the rest as older', () => {
  const v = view({
    board: [
      item(1, { state: 'closed', closed_at: daysAgo(3) }),
      item(2, { state: 'closed', closed_at: daysAgo(1) }),
      item(3, { state: 'closed', closed_at: daysAgo(8) }),
      factoryRow({ merged_total: 5 }),
    ],
  });
  expect(column(v, 'merged')).toEqual([2, 1]);
  expect(v.older).toBe(3);
  expect(v.olderHref).toBe('https://github.com/o/r/issues?q=is%3Aissue+is%3Aclosed');
});

test('the order filter narrows the columns, not the panels or the count outside orders', () => {
  const board = [
    item(1, { work_orders: ['screens'] }),
    item(2),
    item(3, { work_orders: ['other'] }),
  ];
  const v = view(
    {
      board,
      workable: [workable(1), workable(2), workable(3)],
      orders: [ORDER(), ORDER({ name: 'other' })],
    },
    'screens',
  );
  expect(column(v, 'queued')).toEqual([1]);
  expect(v.orders.map((o) => o.name)).toEqual(['screens', 'other']);
  expect(v.notInOrder).toBe(1);
});

test('an item in two work orders shows under each, with a chip for each', () => {
  const v = view(
    {
      board: [item(1, { work_orders: ['screens', 'other'] })],
      workable: [workable(1)],
      orders: [ORDER(), ORDER({ name: 'other' })],
    },
    'other',
  );
  const [one] = column(v, 'queued') ? (v.columns.find((c) => c.id === 'queued')?.items ?? []) : [];
  expect(one?.number).toBe(1);
  expect(one?.chips.filter((c) => c.kind === 'order').map((c) => c.text)).toEqual([
    'screens',
    'other',
  ]);
  expect(v.notInOrder).toBe(0);
});

test('a work order drops off 7 days after its last issue closes', () => {
  const finished = (days: number) =>
    ORDER({ open_count: 0, merged_count: 4, last_closed_at: daysAgo(days) });
  expect(view({ orders: [finished(6)] }).orders).toHaveLength(1);
  expect(view({ orders: [finished(8)] }).orders).toHaveLength(0);
  expect(nextChange({ board: [], orders: [finished(6)] }, NOW)).toEqual(
    new Date(daysAgo(6).getTime() + KEEP_MS),
  );
  expect(nextChange({ board: [], orders: [finished(8)] }, NOW)).toBeNull();
});

test('chips: the route, the pulse of a run on it, the app verdict and where the card opens', () => {
  const v = view({
    board: [
      item(1, {
        route: 'deliver',
        rounds: 2,
        app_check: 'FAIL',
        pr: 7,
        pr_open: true,
        work_orders: ['screens'],
      }),
      item(2, { app_check: 'PASS', rounds: 1 }),
      factoryRow(),
    ],
    map: [lap(1, 'archon-build-queue', [BUILD])],
    workable: [workable(2)],
  });
  const [one] = v.columns.find((c) => c.id === 'build')?.items ?? [];
  expect(one?.chips).toEqual([
    { kind: 'route', text: 'deliver' },
    { kind: 'round', text: 'round 2', state: 'running', pulse: true },
    { kind: 'app', text: 'app fail', state: 'failed' },
    { kind: 'pr', text: 'PR #7' },
    { kind: 'order', text: 'screens' },
  ]);
  expect(one?.to).toBe('/f/f/work/1');
  const [two] = v.columns.find((c) => c.id === 'queued')?.items ?? [];
  expect(two?.chips.map((c) => c.text)).toEqual(['round 1', 'app pass']);
  expect(two?.to).toBe('/f/f/work/2');
});

test('itemOnBoard: a closed item is Merged however old, an open one is in the column the board puts it in', () => {
  const sources = {
    board: [
      item(1, { state: 'closed', closed_at: new Date(NOW.getTime() - 30 * 86_400_000), pr: 7 }),
      item(2, { pr: 8, pr_open: true, work_orders: ['screens'] }),
      factoryRow(),
    ],
    map: [],
    workable: [],
    owner: [],
  };
  expect(itemOnBoard(sources, 1)?.column?.id).toBe('merged');
  const open = itemOnBoard(sources, 2);
  expect(open?.column?.id).toBe(
    view({ ...sources, orders: [] }).columns.find((c) => c.items.some((i) => i.number === 2))?.id,
  );
  expect(open).toMatchObject({ pr: 8, workOrders: ['screens'] });
  expect(itemOnBoard(sources, 3)).toBeNull();
});

const T = (h: number) => `2026-11-05T${String(h).padStart(2, '0')}:00:00.000Z`;
const buildParked = { build_status: 'parked', build_at: T(2), triage_at: T(1) };

test('Parked is the last column, held by you, and a parked item is in it and nowhere else', () => {
  const v = view({
    board: [
      item(1, buildParked),
      item(2, { ...buildParked, pr: 9, pr_open: true, app_check: 'PASS' }),
      item(3, buildParked),
      item(4, buildParked),
      item(5),
    ],
    map: [lap(2, 'archon-build-queue', [BUILD]), row('waiting', 3)],
    workable: [workable(1), workable(4), workable(5)],
  });
  expect(v.columns.at(-1)).toMatchObject({ id: 'parked', title: 'Parked', holder: 'you' });
  expect(column(v, 'parked')).toEqual([1, 2, 3, 4]);
  expect(column(v, 'queued')).toEqual([5]);
  expect(column(v, 'build')).toEqual([]);
  expect(column(v, 'decision')).toEqual([]);
  expect(v.columns.find((c) => c.id === 'parked')?.items[1]?.chips.map((c) => c.text)).toEqual([
    'running',
    'app pass',
    'PR #9',
  ]);
  expect(view({}).columns.at(-1)).toMatchObject({ id: 'parked', empty: 'Empty' });
});

test('a re-triage takes an item out of Parked, and a closed parked item is Merged', () => {
  const retriaged = { ...buildParked, triage_at: T(3) };
  const v = view({
    board: [
      item(1, retriaged),
      item(2, { ...buildParked, state: 'closed', closed_at: daysAgo(1) }),
    ],
    workable: [workable(1)],
  });
  expect(column(v, 'parked')).toEqual([]);
  expect(column(v, 'queued')).toEqual([1]);
  expect(column(v, 'merged')).toEqual([2]);
});

test('itemOnBoard names Parked for a parked item', () => {
  const sources = { board: [item(1, buildParked), factoryRow()], map: [], workable: [], owner: [] };
  expect(itemOnBoard(sources, 1)?.column?.id).toBe('parked');
});

test('parked: a merge park holds until a triage or renewed build readiness', () => {
  const none = { ...item(1) };
  const merge = {
    ...none,
    build_status: 'ready',
    build_at: T(2),
    merge_status: 'parked',
    merge_at: T(3),
  };
  expect(parked(none)).toBe(false);
  expect(parked(merge)).toBe(true);
  expect(parked({ ...merge, triage_at: T(5) })).toBe(false);
  expect(parked({ ...merge, build_at: T(4) })).toBe(false);
  expect(parked({ ...merge, merge_status: 'waiting' })).toBe(false);
});

test('parked: an old own_pr_at renews nothing; only a ready build status does', () => {
  const merge = { ...item(1), merge_status: 'parked', merge_at: T(2) };
  // A row the removed own-PR lane wrote still holds own_pr_at, after the park.
  const noBuild = { ...merge, own_pr_at: T(3) };
  const asking = { ...noBuild, build_status: 'asking', build_at: T(1) };
  expect(parked(noBuild)).toBe(true);
  expect(parked(asking)).toBe(true);
  expect(parked({ ...asking, build_status: 'ready' })).toBe(true);
  expect(parked({ ...asking, build_status: 'ready', build_at: T(4) })).toBe(false);
});

// Captions are the reference's (mockup `COLS`); Review and App check name the workflow that runs them.
test('every column carries the caption the reference draws', () => {
  expect(COLUMNS.map((c) => [c.id, c.holder])).toEqual([
    ['queued', 'build queue'],
    ['intake', 'triage'],
    ['build', 'build queue'],
    ['review', 'build queue'],
    ['app', 'app check'],
    ['merge', 'merge queue'],
    ['decision', 'manager'],
    ['merged', 'done'],
    ['parked', 'you'],
  ]);
});

const home = (v: ReturnType<typeof view>, id: string) =>
  v.pipeline.find((s) => s.id === id)?.items.map((i) => i.number);

test('every work item has exactly one home, and each stage holds its items', () => {
  const v = view({
    board: [
      item(1), // queued
      item(2), // intake
      item(3), // build
      item(4), // review
      item(5), // app
      item(6), // merge
      item(7), // decision
      item(8, { state: 'closed', closed_at: daysAgo(1) }), // merged
      item(9, { build_status: 'parked' }), // parked
      item(10, { stage: 'blocked' }), // blocked
      item(11, { stage: 'needs_contract' }), // needs a contract
      item(12, { stage: 'blocked' }), // blocked but workable: stays Planned
      item(13), // no home
    ],
    map: [
      lap(2, 'archon-intake', ['triage']),
      lap(3, 'archon-build-queue', [BUILD]),
      lap(4, 'archon-build-queue', [REVIEW]),
      lap(5, 'factory-app-check', ['check-app']),
      lap(6, 'archon-merge-queue', ['merge']),
      row('waiting', 7),
    ],
    workable: [workable(1), workable(12)],
  });
  expect(v.pipeline.map((s) => s.id)).toEqual(PIPELINE.map((s) => s.id));
  expect(home(v, 'planned')).toEqual([1, 12]);
  expect(home(v, 'intake')).toEqual([2]);
  expect(home(v, 'build')?.sort((a, b) => a - b)).toEqual([3, 4]);
  expect(home(v, 'merged')).toEqual([8]);
  expect(home(v, 'blocked')?.sort((a, b) => a - b)).toEqual([7, 9, 10, 11]);
  const placed = v.pipeline.flatMap((s) => s.items.map((i) => i.number));
  expect(new Set(placed).size).toBe(placed.length);
  expect(placed).not.toContain(13);
  // The Table's nine columns are untouched by a blocked item.
  expect(
    v.columns.flatMap((c) => c.items.map((i) => i.number)).sort((a, b) => a - b),
  ).not.toContain(10);
});

test('the fold maps every Table column to exactly one home', () => {
  for (const { id } of COLUMNS) {
    expect([id, PIPELINE.filter((h) => h.columns.includes(id)).length]).toEqual([id, 1]);
  }
});

test('Merged and Parked numbers are the Table columns', () => {
  const v = view({
    board: [
      item(1, { state: 'closed', closed_at: daysAgo(1) }),
      item(2, { state: 'closed', closed_at: daysAgo(9) }),
      item(3, { build_status: 'parked' }),
      item(4, { stage: 'blocked' }),
      factoryRow({ merged_total: 4 }),
    ],
  });
  expect(home(v, 'merged')).toEqual(column(v, 'merged'));
  expect(v.older).toBe(3);
  expect(v.pipeline.find((s) => s.id === 'blocked')?.pills).toEqual([
    { label: 'parked', state: 'idle', count: 1 },
    { label: 'blocked', state: 'idle', count: 1 },
  ]);
  expect(column(v, 'parked')).toEqual([3]);
});

test('an item reads its status, pills come in state order, and cards list needs-you first', () => {
  const v = view({
    board: [
      item(1, { pr: 9, pr_open: true }),
      item(2, { pr: 8, pr_open: true, app_check: 'FAIL' }),
      item(3),
      item(4),
    ],
    map: [lap(3, 'archon-build-queue', [BUILD]), row('waiting', 4)],
  });
  const build = v.pipeline.find((s) => s.id === 'build');
  expect(build?.items.map((i) => [i.number, i.status])).toEqual([
    [2, 'check failed'],
    [3, 'running'],
    [1, 'waiting'],
  ]);
  expect(build?.pills.map((p) => [p.label, p.state, p.count])).toEqual([
    ['check failed', 'failed', 1],
    ['running', 'running', 1],
    ['waiting', 'idle', 1],
  ]);
  expect(v.pipeline.find((s) => s.id === 'blocked')?.items.map((i) => i.status)).toEqual([
    'needs you',
  ]);
});

test('a work order line counts building and needs you over every item, whatever the filter', () => {
  const board = [
    item(1, { work_orders: ['screens'] }),
    item(2, { work_orders: ['screens'] }),
    item(3, { work_orders: ['other'] }),
  ];
  const v = view(
    {
      board,
      map: [lap(1, 'archon-build-queue', [BUILD]), row('waiting', 2)],
      orders: [ORDER(), ORDER({ name: 'other' })],
    },
    'other',
  );
  const screens = v.orders.find((o) => o.name === 'screens');
  expect(screens && orderLine(screens)).toBe('1 of 4 merged · 1 building · 1 needs you');
  const other = v.orders.find((o) => o.name === 'other');
  expect(other && orderLine(other)).toBe('1 of 4 merged');
  expect(orderTarget({ name: 'x', merged: 0, total: 1, landsOn: null })).toBe('work order');
  expect(orderTarget({ name: 'x', merged: 0, total: 1, landsOn: 'staging' })).toBe(
    'work order · lands on staging',
  );
});

test('found counts filed, tracked and dropped, and ignores what is not a list', () => {
  const written = JSON.stringify([{ outcome: 'file' }, { outcome: 'track' }, { outcome: 'file' }]);
  expect(
    found([
      { run_id: 'a', written, dropped: JSON.stringify([{}, {}]) },
      { run_id: 'b', written: null, dropped: null },
      { run_id: 'c', written: '"text"', dropped: '{"a":1}' },
    ]),
  ).toEqual({ filed: 2, tracked: 1, dropped: 2 });
});
