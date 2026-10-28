import { afterEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import type { Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  collectPanelMarks,
  emptyPanelTimings,
  executionTime,
  explainPanel,
  explainQuery,
  explainWarmQuery,
  groupPerformanceFailures,
  groupTimings,
  measurePanels,
  observedTimings,
  performanceFailures,
  readyFailures,
} from './timings';

const context = {
  id: 'one',
  query: 'step-detail',
  factory: 'factory-a',
  args: ['workflow', 'step'],
  home: false,
  branch: null,
  queryFingerprint: 'fingerprint',
};
const seen = {
  readyAt: 1200.4,
  requestedAt: 40.3,
  sealedAt: 70.2,
  sentAt: 100.1,
  firstAt: 1100.2,
  renderedAt: 1200.4,
  subscribedAt: 100.1,
  context,
  connectionStartAt: 3.4,
  connectionOpenAt: 50.2,
  connectionReadyAt: 95.6,
};
const sql = 'SELECT $1::text AS factory, $2::text AS workflow, $3::text AS step';
const queries = new Map([[context.query, sql]]);
const page: Page = {
  async evaluate(expression) {
    return new Function(`return ${expression}`)();
  },
  async goto() {},
  async setViewport() {},
  async screenshot() {
    return Buffer.alloc(0);
  },
  async close() {},
};
function mark(query = context.query, detail = context) {
  performance.mark('live:connection:start', { startTime: 3.4 });
  performance.mark('live:connection:open', { startTime: 50.2 });
  performance.mark('live:connection:ready', { startTime: 95.6 });
  performance.mark(`live:${query}:requested`, { startTime: 40.3 });
  performance.mark(`live:${query}:sealed`, { startTime: 70.2 });
  performance.mark(`live:${query}:subscribe-sent`, { startTime: 100.1 });
  performance.mark(`live:${query}:first-result`, {
    startTime: 1100.2,
    detail: { ...detail, subscribedAt: 100.1 },
  });
  performance.mark(`live:${query}:ready`, { startTime: 1200.4, detail });
  performance.mark(`live:${query}:rendered`, { startTime: 1200.4, detail });
}
function database(query: Db['query']): Db {
  const db: Db = {
    query,
    async transaction(fn) {
      await fn(db);
    },
    async close() {},
  };
  return db;
}
afterEach(() => performance.clearMarks());

test('delivery stays evidence, rendering stays fractional, legacy and readiness retain rounding', () => {
  const timing = observedTimings(context.query, seen);
  expect(timing.readyMs).toBe(1200);
  expect(timing.requestedMs).toBe(40);
  expect(timing.sealedMs).toBe(70);
  expect(timing.subscribeSentMs).toBe(100);
  expect(timing.firstSnapshotMs).toBe(1100);
  expect(timing.connectionStartMs).toBe(3);
  expect(timing.connectionOpenMs).toBe(50);
  expect(timing.connectionReadyMs).toBe(96);
  expect(timing.subscribeToFirstResultMs).toBeCloseTo(1000.1);
  expect(timing.renderMs).toBeCloseTo(100.2);
  expect(performanceFailures(context.query, { ...timing, queryExecutionMs: 99.999 })).toEqual([]);
});

test.each([
  [99.999, 500, 0],
  [100, 500, 1],
  [0, 500.001, 1],
  [0, 0, 0],
  [null, 0, 1],
  [0, null, 1],
  [Number.NaN, Number.POSITIVE_INFINITY, 2],
  [-1, -1, 2],
])('query %s ms, render %s ms produces %s failures', (queryExecutionMs, renderMs, failures) => {
  expect(
    performanceFailures('panel', { queryExecutionMs, renderMs, measurementError: null }),
  ).toHaveLength(failures);
});

test('missing, negative or unattributed marks cannot turn into a passing measurement', () => {
  for (const patch of [
    { context: null },
    { context: { ...context, query: 'other' } },
    { firstAt: null },
    { renderedAt: null },
    { subscribedAt: null },
    { firstAt: -1 },
    { renderedAt: 100 },
    { context: { ...context, args: [3] } },
    { context: { ...context, home: true, branch: 'rewind-other' } },
  ]) {
    const timing = observedTimings(context.query, { ...seen, ...patch });
    expect(timing.measurementError).not.toBeNull();
    expect(performanceFailures('panel', timing).length).toBeGreaterThan(0);
  }
  expect(
    groupPerformanceFailures(['missing'], groupTimings({ missing: emptyPanelTimings() })),
  ).toHaveLength(2);
});

test('collector joins the first ready observation by ID, including when another instance arrived earlier', async () => {
  const earlier = { ...context, id: 'earlier', factory: 'factory-b', args: ['workflow', 'other'] };
  performance.mark('live:step-detail:first-result', {
    startTime: 1,
    detail: { ...earlier, subscribedAt: 0 },
  });
  performance.mark('live:step-detail:rendered', { startTime: 2, detail: earlier });
  mark();
  const timing = (await collectPanelMarks(page, ['step-detail'], 0))['step-detail'];
  expect(timing.queryContext).toEqual(context);
  expect(timing.renderMs).toBeCloseTo(100.2);
  expect(timing.requestedMs).toBe(40);
  expect(timing.sealedMs).toBe(70);
  expect(timing.subscribeSentMs).toBe(100);
  expect(timing.firstSnapshotMs).toBe(1100);
  expect(timing.connectionStartMs).toBe(3);
  expect(timing.connectionOpenMs).toBe(50);
  expect(timing.connectionReadyMs).toBe(96);
});

test('collector awaits effect marks without resetting their timestamps and missing marks time out', async () => {
  const collecting = collectPanelMarks(page, ['step-detail'], performance.now() + 1000);
  queueMicrotask(() => mark());
  expect((await collecting)['step-detail'].readyMs).toBe(1200);
  const absent = await collectPanelMarks(page, ['absent'], 0);
  expect(absent.absent.readyMs).toBeNull();
  expect(absent.absent.requestedMs).toBeNull();
  expect(absent.absent.sealedMs).toBeNull();
  expect(absent.absent.subscribeSentMs).toBeNull();
  expect(absent.absent.measurementError).toContain('absent');
});

test('a whole group is observed before sequential EXPLAIN, with exact arguments and no I/O time in the duration', async () => {
  mark();
  const second = { ...context, id: 'two', query: 'other', args: ['workflow', 'other-step'] };
  const events: string[] = [];
  const db = database(async (text, params) => {
    const explained = text.startsWith('EXPLAIN');
    events.push(explained ? 'explain' : 'warm-up');
    expect(events[0]).toBe('observed');
    expect(text).toBe(explained ? `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}` : sql);
    expect(params).toEqual(
      events.length <= 7
        ? ['factory-a', 'workflow', 'step']
        : ['factory-a', 'workflow', 'other-step'],
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    return [
      {
        'QUERY PLAN': [
          { 'Planning Time': 900, 'Execution Time': 0.125, Plan: { 'Actual Total Time': 800 } },
        ],
      },
    ];
  });
  const measured = measurePanels(
    {
      ...page,
      async evaluate<T>(expression: string): Promise<T> {
        const result = await page.evaluate<T>(expression);
        events.push('observed');
        return result;
      },
    },
    ['step-detail', 'other'],
    { db, branch: 'check-owned', selectedBranch: null },
    new Map([
      ['step-detail', sql],
      ['other', sql],
    ]),
    context.factory,
    performance.now() + 1000,
  );
  expect(events).toEqual([]);
  mark('other', second);
  const result = await measured;
  const panel = ['warm-up', ...Array(5).fill('explain')];
  expect(events).toEqual(['observed', ...panel, ...panel]);
  expect(result['step-detail'].queryExecutionMs).toBe(0.125);
  expect(result['step-detail'].queryExecutionSamplesMs).toEqual(Array(5).fill(0.125));
  expect(result.other.queryContext).toEqual({ ...second, branch: 'check-owned' });
});

test('mismatched query, arguments, factory, branch and missing delivery refuse EXPLAIN', async () => {
  let calls = 0;
  const db = database(async () => {
    calls++;
    return [];
  });
  for (const patch of [
    { query: 'missing' },
    { args: [] },
    { factory: 'wrong' },
    { branch: 'rewind-other' },
  ]) {
    const timing = observedTimings(context.query, { ...seen, context: { ...context, ...patch } });
    await explainPanel(
      context.query,
      timing,
      { db, branch: 'check-owned', selectedBranch: null },
      queries,
      context.factory,
    );
    expect(timing.queryExecutionMs).toBeNull();
    expect(timing.measurementError).not.toBeNull();
  }
  await explainPanel(
    context.query,
    observedTimings(context.query, { ...seen, firstAt: null }),
    { db, branch: 'check-owned', selectedBranch: null },
    queries,
    context.factory,
  );
  expect(calls).toBe(0);
});

test('invalid EXPLAIN and driver failures preserve browser evidence and do not leak driver data', async () => {
  for (const result of [
    [],
    [{ 'QUERY PLAN': [] }],
    [{ 'QUERY PLAN': [{ 'Execution Time': '1' }] }],
    [{ 'QUERY PLAN': [{ 'Execution Time': -1 }] }],
  ])
    expect(() => executionTime(result)).toThrow();
  const timing = observedTimings(context.query, seen);
  await explainPanel(
    context.query,
    timing,
    {
      db: database(async () => {
        throw new Error('secret URL');
      }),
      branch: 'check-owned',
      selectedBranch: null,
    },
    queries,
    context.factory,
  );
  expect(timing.readyMs).toBe(1200);
  expect(timing.queryExecutionMs).toBeNull();
  expect(timing.measurementError).toContain('EXPLAIN failed');
  expect(JSON.stringify(timing)).not.toContain('secret URL');
});

function plans(executionMs: readonly number[]) {
  const seenSql: string[] = [];
  const db = database(async (text) => {
    seenSql.push(text);
    const ms = executionMs[seenSql.length - 1];
    return [{ 'QUERY PLAN': [{ 'Execution Time': ms }] }];
  });
  return { db, seenSql };
}

test('a cold first execution does not decide the verdict: the warm median of five does', async () => {
  // The issue's measured cold Neon branch: one cold read, then ~1 ms every time.
  const { db, seenSql } = plans([213.875, 42.0, 1.16, 1.23, 1.2, 1.18]);
  const { medianMs, samplesMs } = await explainWarmQuery(db, sql, ['factory-a', 'w', 's']);
  expect(seenSql[0]).toBe(sql);
  expect(seenSql.slice(1)).toEqual(Array(5).fill(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`));
  expect(samplesMs).toEqual([42.0, 1.16, 1.23, 1.2, 1.18]);
  expect(medianMs).toBe(1.2);
  expect(
    performanceFailures('home-map', {
      queryExecutionMs: medianMs,
      renderMs: 0,
      measurementError: null,
    }),
  ).toEqual([]);
});

test('a query slow on every sample still fails the unchanged < 100 ms limit', async () => {
  const { db } = plans([400, 100, 250, 180, 120, 100.5]);
  const timing = observedTimings(context.query, seen);
  await explainPanel(
    context.query,
    timing,
    { db, branch: 'check-owned', selectedBranch: null },
    queries,
    context.factory,
  );
  expect(timing.queryExecutionSamplesMs).toEqual([100, 250, 180, 120, 100.5]);
  expect(timing.queryExecutionMs).toBe(120);
  expect(performanceFailures(context.query, timing)).toEqual([
    `${context.query} query execution 120 ms, requires < 100`,
  ]);
});

test('real JSON EXPLAIN binds parameters and a delayed empty query fails the query gate', async () => {
  const pg = new PGlite();
  const db = database(
    async (text, params) => (await pg.query<Record<string, unknown>>(text, params)).rows,
  );
  try {
    const copied = 'SELECT $1::text AS factory WHERE false';
    const delayed = `WITH delay AS MATERIALIZED (SELECT pg_sleep(0.2) AS slept) SELECT panel.*, delay.slept FROM delay LEFT JOIN (${copied}) AS panel ON true`;
    const execution = await explainQuery(db, delayed, ['factory-a']);
    // Warm runs do not hide a query that is slow every time.
    expect((await explainWarmQuery(db, delayed, ['factory-a'])).medianMs).toBeGreaterThan(100);
    expect(
      performanceFailures('slow-copy', {
        queryExecutionMs: execution,
        renderMs: 0,
        measurementError: null,
      }),
    ).toEqual([`slow-copy query execution ${execution} ms, requires < 100`]);
  } finally {
    await pg.close();
  }
});

test('a ready over its limit names the Realtime connection and each stretch from navigation to ready', () => {
  const timing = observedTimings(context.query, seen);
  expect(readyFailures('diff screen', timing, 2000)).toEqual([]);
  expect(readyFailures('diff screen', timing, 1199)).toEqual([
    'diff screen ready after 1200 ms, limit 1199 (Realtime connection started 3 ms, ready 96 ms; connection start to open 47 ms, open to ready 46 ms): navigation to requested 40 ms, requested to sealed 30 ms, sealed to subscribe sent 30 ms, subscribe sent to ready 1100 ms',
  ]);
  expect(readyFailures('diff screen', emptyPanelTimings(), 2000)).toEqual([
    'diff screen ready after null ms, limit 2000 (Realtime connection started not marked, ready not marked; connection start to open not marked, open to ready not marked): navigation to requested not marked, requested to sealed not marked, sealed to subscribe sent not marked, subscribe sent to ready not marked',
  ]);
});

test('a group carries both marks per panel and its ready failure names every panel', () => {
  const slow = observedTimings('other', {
    ...seen,
    readyAt: 3451.2,
    requestedAt: 900.4,
    sealedAt: 960.3,
    sentAt: 1000.1,
  });
  const group = groupTimings({
    [context.query]: observedTimings(context.query, seen),
    other: slow,
  });
  expect(group.requestedMs).toEqual({ [context.query]: 40, other: 900 });
  expect(group.sealedMs).toEqual({ [context.query]: 70, other: 960 });
  expect(group.subscribeSentMs).toEqual({ [context.query]: 100, other: 1000 });
  expect(group.connectionOpenMs).toEqual({ [context.query]: 50, other: 50 });
  expect(group.connectionReadyMs).toEqual({ [context.query]: 96, other: 96 });
  expect(JSON.parse(JSON.stringify(group)).requestedMs).toEqual(group.requestedMs);
  expect(readyFailures('laps screen', group, 2000)).toEqual([
    'laps screen ready after 3451 ms, limit 2000 (Realtime connection started 3 ms, ready 96 ms; connection start to open 47 ms, open to ready 46 ms): ' +
      `${context.query} navigation to requested 40 ms, requested to sealed 30 ms, sealed to subscribe sent 30 ms, subscribe sent to ready 1100 ms; ` +
      'other navigation to requested 900 ms, requested to sealed 60 ms, sealed to subscribe sent 40 ms, subscribe sent to ready 2451 ms',
  ]);
  expect(
    readyFailures('laps screen', groupTimings({ missing: emptyPanelTimings() }), 2000),
  ).toEqual([
    'laps screen ready after null ms, limit 2000 (Realtime connection started not marked, ready not marked; connection start to open not marked, open to ready not marked): ' +
      'missing navigation to requested not marked, requested to sealed not marked, sealed to subscribe sent not marked, subscribe sent to ready not marked',
  ]);
});

test('a ready failure splits the connection at the open mark and never invents a missing one', () => {
  const slow = { ...seen, readyAt: 2601.4, connectionReadyAt: 2387.3 };
  const split = (patch: Partial<Parameters<typeof observedTimings>[1]>) =>
    readyFailures('decisions screen', observedTimings(context.query, { ...slow, ...patch }), 2000)
      .join('')
      .split(': ')[0];
  expect(split({})).toBe(
    'decisions screen ready after 2601 ms, limit 2000 (Realtime connection started 3 ms, ready 2387 ms; connection start to open 47 ms, open to ready 2337 ms)',
  );
  expect(split({ connectionOpenAt: null })).toBe(
    'decisions screen ready after 2601 ms, limit 2000 (Realtime connection started 3 ms, ready 2387 ms; connection start to open not marked, open to ready not marked)',
  );
  expect(split({ connectionReadyAt: null })).toBe(
    'decisions screen ready after 2601 ms, limit 2000 (Realtime connection started 3 ms, ready not marked; connection start to open 47 ms, open to ready not marked)',
  );
  expect(split({ connectionOpenAt: null, connectionReadyAt: null })).toBe(
    'decisions screen ready after 2601 ms, limit 2000 (Realtime connection started 3 ms, ready not marked; connection start to open not marked, open to ready not marked)',
  );
});

test('a socket that opened before the panel asked for its seal still splits from its own start', async () => {
  performance.mark('live:connection:start', { startTime: 2.6 });
  performance.mark('live:connection:open', { startTime: 21.8 });
  performance.mark('live:connection:ready', { startTime: 2200.1 });
  performance.mark('live:step-detail:requested', { startTime: 140.3 });
  performance.mark('live:step-detail:sealed', { startTime: 160.2 });
  performance.mark('live:step-detail:subscribe-sent', { startTime: 2201.1 });
  performance.mark('live:step-detail:ready', { startTime: 2400.4, detail: context });
  const timing = (await collectPanelMarks(page, ['step-detail'], 0))['step-detail'];
  expect(timing.connectionOpenMs).toBe(22);
  expect(readyFailures('the step screen', timing, 2000)).toEqual([
    'the step screen ready after 2400 ms, limit 2000 (Realtime connection started 3 ms, ready 2200 ms; connection start to open 19 ms, open to ready 2178 ms): navigation to requested 140 ms, requested to sealed 20 ms, sealed to subscribe sent 2041 ms, subscribe sent to ready 199 ms',
  ]);
});
