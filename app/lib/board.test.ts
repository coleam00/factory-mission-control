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
  parked,
  waitCard,
} from './board';
import type { DecideRow } from './attention';
import { decideCards, queueOf } from './attention-page';
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
  stop_line: null,
  asks: null,
});
const row = (
  kind: HomeMapRow['kind'],
  number: number | null = null,
  workflow: string | null = null,
): HomeMapRow => ({
  ...lap(number ?? 0, 'archon-build-queue', null),
  kind,
  run_id: kind === 'queues' ? null : '00000000-0000-4000-8000-0000000000aa',
  workflow,
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
const home = (v: ReturnType<typeof view>, id: string) =>
  v.pipeline.find((s) => s.id === id)?.items.map((i) => i.number);
const workable = (number: number) => ({
  kind: 'issue' as const,
  issue_number: number,
  title: null,
  url: null,
  run_id: null,
});

test('a running run holds its item before a wait on the owner; a wait with no card of its own leaves it where the state puts it', () => {
  const v = view({
    board: [item(1), item(2), item(3)],
    map: [
      lap(1, 'archon-build-queue', [BUILD]),
      row('waiting', 1),
      lap(2, 'archon-build-queue', [BUILD]),
      row('waiting', 3),
    ],
  });
  expect(column(v, 'build')).toEqual([1, 2]);
  expect(home(v, 'intake')).toEqual([3]);
  expect(column(v, 'decision')).toEqual([3]);
  expect(v.pipeline.find((s) => s.id === 'intake')?.items[0]?.status).toBe('needs you');
});

test('the furthest stage a work item runs on wins', () => {
  const v = view({
    board: [item(1)],
    map: [lap(1, 'archon-intake', ['triage']), lap(1, 'archon-build-queue', [REVIEW])],
  });
  expect(column(v, 'review')).toEqual([1]);
  expect(column(v, 'intake')).toEqual([]);
});

test('a run on a card with no column, or between steps, does not move the work item off its state', () => {
  const v = view({
    board: [item(1), item(2), item(3)],
    map: [lap(1, 'archon-intake', ['slice']), lap(2, 'archon-build-queue', null)],
    workable: [workable(1), workable(2), workable(3)],
  });
  expect(column(v, 'queued')).toEqual([1, 2, 3]);
});

test('a running split run holds no work item: it stays in Queued', () => {
  const v = view({
    board: [item(1)],
    map: [lap(1, 'archon-split', ['slice'])],
    workable: [workable(1)],
  });
  expect(column(v, 'queued')).toEqual([1]);
});

test('a work item with a round and no run waits in Build; Queued is workable items only', () => {
  const v = view({
    board: [item(1, { pr: 9, pr_open: true, rounds: 1 }), item(2), item(3)],
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

test('chips: the route, the app verdict and where the card opens', () => {
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
    { kind: 'app', text: 'app fail', state: 'failed' },
    { kind: 'pr', text: 'PR #7' },
    { kind: 'order', text: 'screens' },
  ]);
  expect(one?.to).toBe('/f/f/work/1');
  const two = v.columns.find((c) => c.id === 'build')?.items[1];
  expect(two?.chips.map((c) => c.text)).toEqual(['app pass', 'waiting for a run']);
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
  expect(itemOnBoard(sources, 1)).toMatchObject({ blocked: false, column: { id: 'parked' } });
});

test('itemOnBoard says Blocked, not parked, for a needs_contract item', () => {
  const sources = {
    board: [item(1, { stage: 'needs_contract' }), factoryRow()],
    map: [],
    workable: [],
    owner: [],
  };
  expect(itemOnBoard(sources, 1)).toMatchObject({ blocked: true, column: null });
});

test('an item waiting on the owner in Build carries no waiting-for-a-run chip', () => {
  const v = view({ board: [item(1, { build_status: 'asking', rounds: 1 }), factoryRow()] });
  const chips = v.pipeline.find((s) => s.id === 'build')?.items[0]?.chips.map((c) => c.text);
  expect(chips).not.toContain('waiting for a run');
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

const APP_CHECK = 'factory-app-check';
const placements: [string, string, BoardRow, HomeMapRow[]][] = [
  ['intake', 'nothing known of it', item(1), []],
  ['planned', 'workable', item(2), []],
  ['intake', 'a run on triage', item(3), [lap(3, 'archon-intake', ['triage'])]],
  ['build', 'a run on build', item(4), [lap(4, 'archon-build-queue', [BUILD])]],
  ['review', 'a run on review', item(5), [lap(5, 'archon-build-queue', [REVIEW])]],
  ['app', 'a running app check', item(6), [lap(6, APP_CHECK, ['check'])]],
  ['app', 'its app check run, by pull request', item(7, { app_check_run: 'r' }), []],
  ['merge', 'a run on merge', item(8), [lap(8, 'archon-merge-queue', ['sweep'])]],
  ['merge', 'asking at merge', item(9, { merge_status: 'asking', build_status: 'ready' }), []],
  ['build', 'asking at build', item(10, { build_status: 'asking', rounds: 2 }), []],
  ['build', 'waiting, its run on build', item(11), [row('waiting', 11, 'archon-build-queue')]],
  ['app', 'Ready, no check yet', item(12, { build_status: 'ready' }), []],
  [
    'app',
    'Ready, its check passed at an older head',
    item(13, { build_status: 'ready', app_check: 'PASS', pr_head: 'b', app_check_head: 'a' }),
    [],
  ],
  [
    'merge',
    'Ready, its check passed at the head',
    item(14, { build_status: 'ready', app_check: 'PASS', pr_head: 'a', app_check_head: 'a' }),
    [],
  ],
  [
    'merge',
    'waiting at the merge queue, checked at the head',
    item(15, { merge_status: 'waiting', app_check: 'PASS', pr_head: 'a', app_check_head: 'a' }),
    [],
  ],
  ['build', 'a round, not Ready', item(16, { rounds: 1 }), []],
  ['build', 'returned by the merge queue', item(17, { merge_status: 'returned', rounds: 2 }), []],
  [
    'build',
    'returned, though build was Ready before',
    item(18, {
      build_status: 'ready',
      build_at: T(1),
      merge_status: 'returned',
      merge_at: T(2),
      rounds: 2,
    }),
    [],
  ],
  ['blocked', 'its stage is blocked', item(19, { stage: 'blocked' }), []],
  ['blocked', 'needs a contract', item(20, { stage: 'needs_contract' }), []],
  [
    'blocked',
    'parked, though a run holds it',
    item(21, buildParked),
    [lap(21, 'archon-build-queue', [BUILD])],
  ],
];

test.each(placements)('%s: %s', (stage, _why, one, map) => {
  const v = view({ board: [one], map, workable: one.number === 2 ? [workable(2)] : [] });
  expect(home(v, stage)).toEqual([one.number as number]);
});

test('a paused run holds its item in its map card column with Needs you; a paused queue run in its own', () => {
  const paused = (number: number, workflow: string, steps: string[] | null): HomeMapRow => ({
    ...lap(number, workflow, steps),
    kind: 'waiting',
  });
  const v = view({
    board: [item(1), item(2), item(3), item(4)],
    map: [
      paused(1, 'archon-loop', [BUILD]),
      paused(2, 'archon-loop', [REVIEW]),
      paused(3, 'archon-build-queue', [REVIEW]),
      paused(4, 'archon-loop', null),
    ],
  });
  const at = (id: string) =>
    v.pipeline.find((s) => s.id === id)?.items.map((i) => [i.number, i.status]);
  expect(at('build')).toEqual([
    [1, 'needs you'],
    [3, 'needs you'],
  ]);
  expect(at('review')).toEqual([[2, 'needs you']]);
  expect(at('intake')).toEqual([[4, 'needs you']]);
});

test("a paused loop run's wait sits in one card on the Board and on Attention", () => {
  expect(waitCard('archon-loop', ['build'], 'ask')).toBe('build');
  const v = view({
    board: [item(1)],
    map: [{ ...lap(1, 'archon-loop', ['build']), kind: 'waiting' }],
  });
  expect(v.pipeline.find((s) => s.id === 'build')?.items.map((i) => [i.number, i.status])).toEqual([
    [1, 'needs you'],
  ]);
  const row: DecideRow = {
    run_id: '00000000-0000-4000-8000-000000000001',
    workflow_name: 'archon-loop',
    node_id: 'ask',
    occurrence_id: 'p1',
    waiting_since: NOW,
    form: 'select',
    options: '[]',
    labels: '{}',
    recommended: null,
    confidence: null,
    recommendation_why: null,
    item_number: 1,
    item_title: null,
    message: 'Which?',
    console: 'http://localhost:3090/',
    steps: ['build'],
  };
  expect(decideCards([row], 'f')[0]?.queue).toBe('build');
  expect(queueOf('archon-loop', 'ask', null)).toBe('intake');
  expect(queueOf('archon-loop', 'review', ['build'])).toBe('build');
});

test('asking at merge is Merge with the Needs you status, and Ready or waiting is never Build', () => {
  const board = [
    item(1, { merge_status: 'asking' }),
    item(2, { build_status: 'ready', rounds: 3 }),
    item(3, { merge_status: 'waiting', rounds: 3 }),
  ];
  const v = view({ board });
  expect(v.pipeline.find((s) => s.id === 'merge')?.items[0]).toMatchObject({
    number: 1,
    status: 'needs you',
  });
  expect(home(v, 'build')).toEqual([]);
});

test('every open item in the board query is on the Pipeline exactly once, in seven stages', () => {
  const board = [
    ...placements.map(([, , one]) => one),
    item(30, { state: 'closed', closed_at: daysAgo(1) }),
    item(31, { state: 'closed', closed_at: daysAgo(20) }),
    factoryRow(),
  ];
  const map = placements.flatMap(([, , , rows]) => rows);
  const v = view({ board, map, workable: [workable(2)] });
  const placed = v.pipeline.flatMap((s) => s.items.map((i) => i.number)).sort((a, b) => a - b);
  const open = placements.map(([, , one]) => one.number as number).sort((a, b) => a - b);
  expect(placed).toEqual([...open, 30]);
  expect(v.pipeline.map((s) => s.id)).toEqual([
    'intake',
    'planned',
    'build',
    'review',
    'app',
    'merge',
    'merged',
    'blocked',
  ]);
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
  expect(column(v, 'parked')).toEqual([3, 4]);
});

test('an item reads its status, pills come in state order, and cards list needs-you first', () => {
  const v = view({
    board: [
      item(1, { pr: 9, pr_open: true, rounds: 1 }),
      item(2, { pr: 8, pr_open: true, app_check: 'FAIL', rounds: 1 }),
      item(3),
      item(4),
    ],
    map: [lap(3, 'archon-build-queue', [BUILD]), row('waiting', 4, 'archon-build-queue')],
  });
  const build = v.pipeline.find((s) => s.id === 'build');
  expect(build?.items.map((i) => [i.number, i.status])).toEqual([
    [4, 'needs you'],
    [2, 'check failed'],
    [3, 'running'],
    [1, 'waiting'],
  ]);
  expect(build?.pills.map((p) => [p.label, p.state, p.count])).toEqual([
    ['needs you', 'needs-you', 1],
    ['check failed', 'failed', 1],
    ['running', 'running', 1],
    ['waiting', 'idle', 1],
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

test('a running build card reads round N+1 with the live dot, and the run line names the step as the Runs screen does', () => {
  const rounds = JSON.stringify([
    { at: '2026-11-03T10:00:00Z', reason: 'delivered', reviews: 2 },
    { at: '2026-11-03T11:00:00Z', reason: 'ask', reviews: 1 },
    { at: '2026-11-03T11:30:00Z', reason: null, reviews: 0 },
  ]);
  const v = view({
    board: [item(1, { rounds: 3, round_list: rounds })],
    map: [lap(1, 'archon-build-queue', [REVIEW])],
  });
  const card = v.pipeline.find((s) => s.id === 'review')?.items[0];
  expect(card?.round).toBe(4);
  expect(card?.dots.map((d) => d.state)).toEqual(['done', 'needs-you', 'idle', 'running']);
  expect(card?.dots[0]?.title).toMatch(/^Round 1: delivered, 2 reviews · /);
  expect(card?.run).toEqual({
    text: 'archon-build-queue · review__policy',
    to: '/f/f/runs/00000000-0000-4000-8000-000000000001',
  });
});

test('a build round keeps its live dot while an app check runs on its pull request', () => {
  const run = '00000000-0000-4000-8000-0000000000bb';
  const v = view({
    board: [item(1, { rounds: 1, pr: 9, app_check_run: run })],
    map: [
      lap(1, 'archon-build-queue', [REVIEW]),
      { ...lap(0, 'factory-app-check', ['check__browser']), run_id: run, number: null },
    ],
  });
  const card = v.pipeline.flatMap((s) => s.items).find((i) => i.number === 1);
  expect(card?.round).toBe(1);
  expect(card?.dots.map((d) => d.state)).toEqual(['running']);
});

test('a merged item with a still-running build round shows no live round', () => {
  const v = view({
    board: [item(1, { state: 'closed', closed_at: daysAgo(1), rounds: 1 })],
    map: [lap(1, 'archon-build-queue', [REVIEW])],
  });
  const card = v.pipeline.flatMap((s) => s.items).find((i) => i.number === 1);
  expect(card).toMatchObject({ round: 0, dots: [] });
});

test('an item held only by a running app check shows that run, with its step from the map', () => {
  const run = '00000000-0000-4000-8000-0000000000bb';
  const check: HomeMapRow = {
    ...lap(0, 'factory-app-check', ['check__browser']),
    run_id: run,
    number: null,
  };
  const v = view({
    board: [item(2, { pr: 9, app_check_run: run })],
    map: [check],
  });
  const card = v.pipeline.find((s) => s.id === 'app')?.items[0];
  expect(card?.run).toEqual({ text: 'factory-app-check · check__browser', to: `/f/f/runs/${run}` });
});

test('a merged card carries its returns and merge time; a waiting one its question; a failed check says so', () => {
  const v = view({
    board: [
      item(1, {
        state: 'closed',
        closed_at: daysAgo(1),
        merged_at: '2026-11-03T08:00:00Z',
        returns: 2,
      }),
      item(2, { rounds: 1 }),
      item(3, { app_check: 'FAIL', rounds: 1, pr: 5 }),
      item(4, { build_status: 'asking', rounds: 1 }),
    ],
    map: [{ ...row('waiting', 2, 'archon-build-queue'), stop_line: 'Merge it?', asks: 2 }],
  });
  const merged = v.pipeline.find((s) => s.id === 'merged')?.items[0];
  expect(merged?.returned).toBe(2);
  expect(merged?.mergedAt).toEqual(new Date('2026-11-03T08:00:00Z'));
  const items = v.pipeline.flatMap((s) => s.items);
  expect(items.find((i) => i.number === 2)?.stop).toEqual({
    text: 'Asking: Merge it?',
    state: 'needs-you',
  });
  expect(items.find((i) => i.number === 4)?.stop).toEqual({
    text: 'Waiting on you',
    state: 'needs-you',
  });
  expect(items.find((i) => i.number === 3)?.stop).toEqual({
    text: 'App check failed',
    state: 'failed',
  });
});

test('an asking card shows the question of the run that asks about it, however the run found the item', () => {
  // Production shapes: a build-queue run that claimed its item has no number input, a merge-queue ask names a pull request.
  const waiting = (workflow: string, asks: number, stop_line: string): HomeMapRow => ({
    ...row('waiting', null, workflow),
    stop_line,
    asks,
  });
  const v = view({
    board: [
      item(42, { build_status: 'asking', rounds: 1 }),
      item(43, { build_status: 'ready', merge_status: 'asking', pr: 16, pr_open: true }),
      item(44, { build_status: 'asking', rounds: 1 }),
    ],
    map: [
      waiting('archon-build-queue', 42, 'Split it?'),
      waiting('archon-merge-queue', 16, 'Merge it?'),
    ],
  });
  const stop = (n: number) => v.pipeline.flatMap((s) => s.items).find((i) => i.number === n)?.stop;
  expect(stop(42)?.text).toBe('Asking: Split it?');
  expect(stop(43)?.text).toBe('Asking: Merge it?');
  expect(stop(44)?.text).toBe('Waiting on you');
  expect(home(v, 'build')).toEqual([42, 44]);
  expect(home(v, 'merge')).toEqual([43]);
});
