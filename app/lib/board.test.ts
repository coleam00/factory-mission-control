import { expect, test } from 'bun:test';
import type { HomeMapRow, WorkOrderRow } from '../map/live';
import { type BoardRow, type BoardSources, boardView, KEEP_MS, nextChange } from './board';
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
  run_id: null,
  run_workflow: null,
  repository: null,
  console: null,
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
  console: 'http://localhost:3090/',
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
    { factory: 'f', board: [], map: [], workable: [], owner: [], orders: [], ...over },
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
    map: [lap(1, 'archon-split', ['slice']), lap(2, 'archon-build-queue', null)],
    workable: [workable(1), workable(2), workable(3)],
  });
  expect(v.columns.flatMap((c) => c.items.map((i) => i.number))).toEqual([3]);
  expect(column(v, 'queued')).toEqual([3]);
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
        run_id: 'r1',
        run_workflow: 'archon-build-queue',
      }),
      item(2, { app_check: 'PASS', rounds: 1, run_id: 'r2', run_workflow: 'archon-loop' }),
      factoryRow(),
    ],
    map: [lap(1, 'archon-build-queue', [BUILD])],
    workable: [workable(2)],
  });
  const [one] = v.columns.find((c) => c.id === 'build')?.items ?? [];
  expect(one?.chips).toEqual([
    { kind: 'route', text: 'deliver' },
    { kind: 'round', text: 'round 2', tone: 'running', pulse: true },
    { kind: 'app', text: 'app fail', tone: 'fail' },
    { kind: 'pr', text: 'PR #7' },
    { kind: 'order', text: 'screens' },
  ]);
  expect(one?.link).toEqual({ kind: 'external', href: 'http://localhost:3090/console/r/r1' });
  const [two] = v.columns.find((c) => c.id === 'queued')?.items ?? [];
  expect(two?.chips.map((c) => c.text)).toEqual(['round 1', 'app pass']);
  expect(two?.link).toEqual({ kind: 'lap', to: '/f/f/laps/r2' });
});
