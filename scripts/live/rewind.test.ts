import { afterEach, expect, test } from 'bun:test';
import type { Page } from '../lib/cdp';
import { REPO_ROOT } from '../lib/cli';
import type { Db } from '../lib/db';
import { POOLED_URL, recordingDeps } from '../lib/test-deps';
import { afterSwitchFailures, measureRewindPanels } from './rewind';

const branch = 'rewind-owned';
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
function marks(active: string | null) {
  for (const query of ['rewind-branches', 'status-strip']) {
    const context = {
      id: query,
      query,
      factory: 'factory-a',
      args: [],
      home: query === 'rewind-branches',
      branch: query === 'rewind-branches' ? null : active,
      queryFingerprint: 'fingerprint',
    };
    performance.mark(`live:${query}:subscribe-sent`, { startTime: 100 });
    performance.mark(`live:${query}:first-result`, {
      startTime: 150,
      detail: { ...context, subscribedAt: 100 },
    });
    performance.mark(`live:${query}:ready`, { startTime: 175, detail: context });
    performance.mark(`live:${query}:rendered`, { startTime: 175, detail: context });
  }
}
const queries = new Map([
  ['rewind-branches', 'SELECT $1::text AS home'],
  ['status-strip', 'SELECT $1::text AS active'],
]);
function setup({
  resolved = branch,
  created = [branch],
  failQuery = false,
  missing = false,
}: {
  resolved?: string;
  created?: readonly string[];
  failQuery?: boolean;
  missing?: boolean;
} = {}) {
  const recorder = recordingDeps({
    repoRoot: REPO_ROOT,
    branchName: resolved,
    branches: missing ? [] : [{ id: 'br-owned', name: branch, created_at: '' }],
    rows: () => {
      if (failQuery) throw new Error('private URL');
      return [{ 'QUERY PLAN': [{ 'Execution Time': 2 }] }];
    },
  });
  let closed = 0;
  const open = recorder.deps.openDb;
  recorder.deps.openDb = (url) => ({
    ...open(url),
    async close() {
      closed++;
    },
  });
  const homeSql: string[] = [];
  const db: Db = {
    async query(sql) {
      homeSql.push(sql);
      return [{ 'QUERY PLAN': [{ 'Execution Time': 1 }] }];
    },
    async transaction(fn) {
      await fn(db);
    },
    async close() {
      throw new Error('home connection belongs to caller');
    },
  };
  return {
    recorder,
    homeSql,
    closed: () => closed,
    ctx: {
      deps: recorder.deps,
      db,
      queries,
      homeBranch: 'check-owned',
      factory: 'factory-a',
      created,
    },
  };
}
afterEach(() => performance.clearMarks());
/** One unmeasured warm-up run, then five measured EXPLAINs of the same query. */
const warm = (sql: string) => [sql, ...Array(5).fill(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`)];

test('initial panels both explain on home, with no new connection or API calls', async () => {
  marks(null);
  const { ctx, recorder, homeSql, closed } = setup();
  const timings = await measureRewindPanels(page, ctx);
  expect(homeSql).toEqual([
    ...warm('SELECT $1::text AS home'),
    ...warm('SELECT $1::text AS active'),
  ]);
  expect(recorder.opened).toEqual([]);
  expect(recorder.neonCalls).toEqual([]);
  expect(closed()).toBe(0);
  expect(timings.queryContext['status-strip']?.branch).toBe('check-owned');
  expect(timings.queryExecutionMs).toEqual({ 'rewind-branches': 1, 'status-strip': 1 });
  expect(timings.queryExecutionSamplesMs['status-strip']).toEqual([1, 1, 1, 1, 1]);
});

test.each([false, true])(
  'home list and owned rewind use separate verified connections; EXPLAIN failure=%s still closes',
  async (failQuery) => {
    marks(branch);
    const { ctx, recorder, homeSql, closed } = setup({ failQuery });
    const timings = await measureRewindPanels(page, ctx);
    expect(homeSql).toEqual(warm('SELECT $1::text AS home'));
    // A failing warm-up stops the panel's measurement before any EXPLAIN.
    const active = warm('SELECT $1::text AS active').slice(0, failQuery ? 1 : 6);
    expect(recorder.sql).toEqual(active);
    expect(recorder.params).toEqual(active.map(() => ['factory-a']));
    expect(recorder.neonCalls).toEqual([
      'listBranches',
      'pooledConnectionUri br-owned',
      'getEndpoint ep-fake-pooler-a1b2c3',
      'getBranch br-target',
    ]);
    expect(recorder.opened).toEqual([POOLED_URL]);
    expect(closed()).toBe(1);
    expect(timings.queryContext['rewind-branches']?.branch).toBe('check-owned');
    expect(timings.queryContext['status-strip']?.branch).toBe(branch);
    expect(timings.queryExecutionMs['status-strip']).toBe(failQuery ? null : 2);
    expect(JSON.stringify(timings)).not.toContain('private URL');
  },
);

test.each([
  { active: 'main', created: ['main'], resolved: 'main', missing: false },
  { active: 'rewind-other', created: [branch], resolved: branch, missing: false },
  { active: branch, created: [branch], resolved: 'main', missing: false },
  { active: branch, created: [branch], resolved: branch, missing: true },
])(
  'unowned, non-rewind, mismatched endpoint and missing branches never open a connection',
  async ({ active, ...options }) => {
    marks(active);
    const { ctx, recorder, homeSql, closed } = setup(options);
    const timings = await measureRewindPanels(page, ctx);
    expect(recorder.opened).toEqual([]);
    expect(recorder.sql).toEqual([]);
    expect(homeSql).toEqual(warm('SELECT $1::text AS home'));
    expect(closed()).toBe(0);
    expect(timings.queryExecutionMs['status-strip']).toBeNull();
    expect(timings.measurementError['status-strip']).toContain('owned rewind');
    expect(timings.renderMs['status-strip']).toBe(25);
  },
);

test('an after-switch navigation over 2000 ms to ready or 500 ms to render fails the phase', async () => {
  marks(branch);
  const timings = await measureRewindPanels(page, setup().ctx);
  expect(afterSwitchFailures(timings)).toEqual([]);

  const late = afterSwitchFailures({ ...timings, readyMs: 2001 });
  expect(late).toHaveLength(1);
  expect(late[0]).toStartWith('/rewind after the switch ready after 2001 ms, limit 2000');
  expect(
    afterSwitchFailures({ ...timings, renderMs: { ...timings.renderMs, 'status-strip': 501 } }),
  ).toEqual(['after the switch, status-strip render 501 ms, limit 500']);
  expect(afterSwitchFailures({ ...timings, readyMs: null })[0]).toStartWith(
    '/rewind after the switch ready after null ms, limit 2000',
  );
});
