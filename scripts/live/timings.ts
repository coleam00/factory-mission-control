import type { QueryObservation } from '../../app/live/subscribe-marks';
import { parameterCount } from '../../server/live';
import type { Page } from '../lib/cdp';
import type { Db, Row } from '../lib/db';

export const PERFORMANCE_LIMITS = { queryExecutionMs: 100, renderMs: 500 };

export interface PanelTimings {
  readyMs: number | null;
  /** The panel asked for its seal (`live:<query>:requested`), from navigation, rounded. */
  requestedMs: number | null;
  /** The server answered the panel's first seal (`live:<query>:sealed`), from navigation, rounded. */
  sealedMs: number | null;
  /** The panel sent its subscribe (`live:<query>:subscribe-sent`), from navigation, rounded. */
  subscribeSentMs: number | null;
  /** Legacy evidence: ready minus subscribe-sent, rounded, including delivery and rendering. */
  firstSnapshotMs: number | null;
  subscribeToFirstResultMs: number | null;
  renderMs: number | null;
  /** Median of the warm samples below; the one query on the panel's critical path. */
  queryExecutionMs: number | null;
  /** Every measured EXPLAIN ANALYZE execution, in order, after one unmeasured warm-up run. */
  queryExecutionSamplesMs: number[] | null;
  queryContext: QueryObservation | null;
  measurementError: string | null;
  /**
   * The page created its Realtime socket (`live:connection:start`), the socket opened
   * (`live:connection:open`) and Realtime said `ready` on it (`live:connection:ready`), from
   * navigation, rounded: the same on every panel of a page. No subscribe is sent before that
   * `ready`.
   */
  connectionStartMs: number | null;
  connectionOpenMs: number | null;
  connectionReadyMs: number | null;
}

export type GroupTimings = { readyMs: number | null } & {
  [K in Exclude<keyof PanelTimings, 'readyMs'>]: Record<string, PanelTimings[K]>;
};

export const emptyPanelTimings = (): PanelTimings => ({
  readyMs: null,
  requestedMs: null,
  sealedMs: null,
  subscribeSentMs: null,
  firstSnapshotMs: null,
  subscribeToFirstResultMs: null,
  renderMs: null,
  queryExecutionMs: null,
  queryExecutionSamplesMs: null,
  queryContext: null,
  measurementError: null,
  connectionStartMs: null,
  connectionOpenMs: null,
  connectionReadyMs: null,
});

export function groupTimings(panels: Record<string, PanelTimings>): GroupTimings {
  const entries = Object.entries(panels);
  const perQuery = <K extends keyof PanelTimings>(key: K): Record<string, PanelTimings[K]> =>
    Object.fromEntries(entries.map(([query, timing]) => [query, timing[key]]));
  const ready = entries.map(([, timing]) => timing.readyMs);
  return {
    readyMs:
      ready.length > 0 && ready.every((ms) => ms !== null) ? Math.round(Math.max(...ready)) : null,
    requestedMs: perQuery('requestedMs'),
    sealedMs: perQuery('sealedMs'),
    subscribeSentMs: perQuery('subscribeSentMs'),
    firstSnapshotMs: perQuery('firstSnapshotMs'),
    subscribeToFirstResultMs: perQuery('subscribeToFirstResultMs'),
    renderMs: perQuery('renderMs'),
    queryExecutionMs: perQuery('queryExecutionMs'),
    queryExecutionSamplesMs: perQuery('queryExecutionSamplesMs'),
    queryContext: perQuery('queryContext'),
    measurementError: perQuery('measurementError'),
    connectionStartMs: perQuery('connectionStartMs'),
    connectionOpenMs: perQuery('connectionOpenMs'),
    connectionReadyMs: perQuery('connectionReadyMs'),
  };
}

export function emptyGroupTimings(queries: readonly string[]): GroupTimings {
  return groupTimings(Object.fromEntries(queries.map((query) => [query, emptyPanelTimings()])));
}

interface BrowserObservation {
  readyAt: number | null;
  requestedAt: number | null;
  sealedAt: number | null;
  sentAt: number | null;
  firstAt: number | null;
  renderedAt: number | null;
  subscribedAt: number | null;
  context: unknown;
  connectionStartAt: number | null;
  connectionOpenAt: number | null;
  connectionReadyAt: number | null;
}

function queryContext(value: unknown, query: string): QueryObservation | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== 'string' ||
    v.id.length === 0 ||
    v.query !== query ||
    typeof v.factory !== 'string' ||
    !Array.isArray(v.args) ||
    !v.args.every((arg) => typeof arg === 'string') ||
    typeof v.home !== 'boolean' ||
    (v.branch !== null && typeof v.branch !== 'string') ||
    typeof v.queryFingerprint !== 'string' ||
    !v.queryFingerprint
  )
    return null;
  if (v.home && v.branch !== null) return null;
  return {
    id: v.id,
    query,
    factory: v.factory,
    args: v.args,
    home: v.home,
    branch: v.branch,
    queryFingerprint: v.queryFingerprint,
  };
}

const validMs = (ms: unknown): ms is number =>
  typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;

export function observedTimings(query: string, seen: BrowserObservation): PanelTimings {
  const timing = emptyPanelTimings();
  if (seen.readyAt !== null) timing.readyMs = Math.round(seen.readyAt);
  if (seen.requestedAt !== null) timing.requestedMs = Math.round(seen.requestedAt);
  if (seen.sealedAt !== null) timing.sealedMs = Math.round(seen.sealedAt);
  if (seen.connectionStartAt !== null)
    timing.connectionStartMs = Math.round(seen.connectionStartAt);
  if (seen.connectionOpenAt !== null) timing.connectionOpenMs = Math.round(seen.connectionOpenAt);
  if (seen.connectionReadyAt !== null)
    timing.connectionReadyMs = Math.round(seen.connectionReadyAt);
  if (seen.sentAt !== null) timing.subscribeSentMs = Math.round(seen.sentAt);
  if (seen.readyAt !== null && seen.sentAt !== null)
    timing.firstSnapshotMs = Math.round(seen.readyAt - seen.sentAt);
  timing.queryContext = queryContext(seen.context, query);
  if (validMs(seen.firstAt) && validMs(seen.subscribedAt))
    timing.subscribeToFirstResultMs = seen.firstAt - seen.subscribedAt;
  if (validMs(seen.firstAt) && validMs(seen.renderedAt))
    timing.renderMs = seen.renderedAt - seen.firstAt;
  if (
    !timing.queryContext ||
    !validMs(timing.renderMs) ||
    !validMs(timing.subscribeToFirstResultMs)
  ) {
    timing.measurementError = `${query}: missing or inconsistent subscription marks`;
  }
  return timing;
}

/** One page evaluation gathers the whole group before any of its SQL is explained. */
export async function collectPanelMarks(
  page: Page,
  queries: readonly string[],
  deadlineMs: number,
): Promise<Record<string, PanelTimings>> {
  const observations = await page.evaluate<Record<string, BrowserObservation>>(`(async () => {
    const queries = ${JSON.stringify(queries)};
    const first = (query, kind) => performance.getEntriesByName('live:' + query + ':' + kind)[0];
    const connectionStartAt = first('connection', 'start')?.startTime ?? null;
    const connectionOpenAt = first('connection', 'open')?.startTime ?? null;
    const connectionReadyAt = first('connection', 'ready')?.startTime ?? null;
    const complete = () => queries.every((query) => first(query, 'ready'));
    if (!complete()) await new Promise((done) => {
      const observer = new PerformanceObserver(() => { if (complete()) finish(); });
      const finish = () => { observer.disconnect(); clearTimeout(timer); done(); };
      const timer = setTimeout(finish, Math.max(0, ${deadlineMs} - performance.now()));
      observer.observe({ entryTypes: ['mark'] });
      if (complete()) finish();
    });
    return Object.fromEntries(queries.map((query) => {
      const ready = first(query, 'ready');
      const matched = (kind) => performance.getEntriesByName('live:' + query + ':' + kind)
        .find((mark) => ready?.detail?.id && mark.detail?.id === ready.detail.id);
      const arrived = matched('first-result');
      return [query, { readyAt: ready?.startTime ?? null,
        requestedAt: first(query, 'requested')?.startTime ?? null,
        sealedAt: first(query, 'sealed')?.startTime ?? null, sentAt: first(query, 'subscribe-sent')?.startTime ?? null,
        firstAt: arrived?.startTime ?? null, renderedAt: matched('rendered')?.startTime ?? null,
        subscribedAt: arrived?.detail?.subscribedAt ?? null, context: ready?.detail ?? null,
        connectionStartAt, connectionOpenAt, connectionReadyAt }];
    }));
  })()`);
  return Object.fromEntries(
    queries.map((query) => [query, observedTimings(query, observations[query])]),
  );
}

export function executionTime(rows: Row[]): number {
  const plan: unknown = rows[0]?.['QUERY PLAN'];
  const execution: unknown = Array.isArray(plan) ? plan[0]?.['Execution Time'] : undefined;
  if (!validMs(execution)) throw new Error('EXPLAIN returned no valid Execution Time');
  return execution;
}

export async function explainQuery(db: Db, sql: string, params: string[]): Promise<number> {
  return executionTime(await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params));
}

/** Measured executions per query; the verdict is their median. */
export const EXPLAIN_SAMPLES = 5;

export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('median of no samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Judges a warm query: one unmeasured run with the same parameters first (a just-created
 * check branch reads its buffers cold once, which is Neon's, not the query's), then the
 * median of `EXPLAIN_SAMPLES` EXPLAIN ANALYZE executions. A query slow every time stays slow.
 */
export async function explainWarmQuery(
  db: Db,
  sql: string,
  params: string[],
): Promise<{ medianMs: number; samplesMs: number[] }> {
  await db.query(sql, params);
  const samplesMs: number[] = [];
  for (let i = 0; i < EXPLAIN_SAMPLES; i++) samplesMs.push(await explainQuery(db, sql, params));
  return { medianMs: median(samplesMs), samplesMs };
}

export interface TimingDatabase {
  db: Db;
  /** Verified through the Neon API before opening the connection. */
  branch: string;
  /** null means the server's home branch, regardless of the panel's home flag. */
  selectedBranch: string | null;
}

export async function explainPanel(
  query: string,
  timing: PanelTimings,
  target: TimingDatabase,
  queries: ReadonlyMap<string, string>,
  factory: string,
): Promise<void> {
  if (timing.measurementError !== null) return;
  const context = timing.queryContext;
  const sql = queries.get(query);
  if (
    !context ||
    context.factory !== factory ||
    context.branch !== target.selectedBranch ||
    !sql ||
    parameterCount(sql) !== context.args.length + 1
  ) {
    timing.measurementError = `${query}: query, parameters, factory or branch attribution mismatch`;
    return;
  }
  timing.queryContext = { ...context, branch: target.branch };
  try {
    const { medianMs, samplesMs } = await explainWarmQuery(target.db, sql, [
      context.factory,
      ...context.args,
    ]);
    timing.queryExecutionMs = medianMs;
    timing.queryExecutionSamplesMs = samplesMs;
  } catch {
    // Driver errors may include connection credentials or SQL data; reports need only the panel.
    timing.measurementError = `${query}: EXPLAIN failed or returned an invalid execution time`;
  }
}

export async function measurePanels(
  page: Page,
  names: readonly string[],
  target: TimingDatabase,
  queries: ReadonlyMap<string, string>,
  factory: string,
  deadlineMs: number,
): Promise<Record<string, PanelTimings>> {
  const panels = await collectPanelMarks(page, names, deadlineMs);
  for (const query of names) await explainPanel(query, panels[query], target, queries, factory);
  return panels;
}

export function performanceFailures(
  query: string,
  timing: Pick<PanelTimings, 'queryExecutionMs' | 'renderMs' | 'measurementError'>,
): string[] {
  const failures: string[] = [];
  if (timing.measurementError) failures.push(timing.measurementError);
  if (
    !validMs(timing.queryExecutionMs) ||
    timing.queryExecutionMs >= PERFORMANCE_LIMITS.queryExecutionMs
  ) {
    failures.push(
      `${query} query execution ${timing.queryExecutionMs} ms, requires < ${PERFORMANCE_LIMITS.queryExecutionMs}`,
    );
  }
  if (!validMs(timing.renderMs) || timing.renderMs > PERFORMANCE_LIMITS.renderMs) {
    failures.push(`${query} render ${timing.renderMs} ms, limit ${PERFORMANCE_LIMITS.renderMs}`);
  }
  return failures;
}

export function groupPerformanceFailures(
  queries: readonly string[],
  timings: GroupTimings,
): string[] {
  return queries.flatMap((query) =>
    performanceFailures(query, {
      queryExecutionMs: timings.queryExecutionMs[query],
      renderMs: timings.renderMs[query],
      measurementError: timings.measurementError[query],
    }),
  );
}

type ReadyStretches = Pick<
  PanelTimings,
  'requestedMs' | 'sealedMs' | 'subscribeSentMs' | 'firstSnapshotMs'
>;

const ms = (value: number | null) => (value === null ? 'not marked' : `${value} ms`);
const between = (from: number | null, to: number | null) =>
  from !== null && to !== null ? to - from : null;

function stretches({ requestedMs, sealedMs, subscribeSentMs, firstSnapshotMs }: ReadyStretches) {
  return [
    `navigation to requested ${ms(requestedMs)}`,
    `requested to sealed ${ms(between(requestedMs, sealedMs))}`,
    `sealed to subscribe sent ${ms(between(sealedMs, subscribeSentMs))}`,
    `subscribe sent to ready ${ms(firstSnapshotMs)}`,
  ].join(', ');
}

type ConnectionMarks = Pick<
  PanelTimings,
  'connectionStartMs' | 'connectionOpenMs' | 'connectionReadyMs'
>;

/**
 * The page's one Realtime connection: a subscribe sealed before it was ready waited for it. Start
 * to open is the network and the WebSocket upgrade; open to ready is Realtime's own handshake.
 */
function connection({ connectionStartMs, connectionOpenMs, connectionReadyMs }: ConnectionMarks) {
  return (
    `Realtime connection started ${ms(connectionStartMs)}, ready ${ms(connectionReadyMs)}; ` +
    `connection start to open ${ms(between(connectionStartMs, connectionOpenMs))}, ` +
    `open to ready ${ms(between(connectionOpenMs, connectionReadyMs))}`
  );
}

const firstMarked = (values: Record<string, number | null>) =>
  Object.values(values).find((value) => value !== null) ?? null;

export const within = (value: number | null, limit: number) => value !== null && value <= limit;

/**
 * A screen's ready failure: none within `limitMs`, otherwise one line naming where the time went,
 * per panel for a group, since a group's ready is its slowest panel's.
 */
export function readyFailures(
  screen: string,
  timings: PanelTimings | GroupTimings,
  limitMs: number,
): string[] {
  if (within(timings.readyMs, limitMs)) return [];
  const head = `${screen} ready after ${timings.readyMs} ms, limit ${limitMs}`;
  if (!isGroup(timings)) {
    return [`${head} (${connection(timings)}): ${stretches(timings)}`];
  }
  const opened = connection({
    connectionStartMs: firstMarked(timings.connectionStartMs),
    connectionOpenMs: firstMarked(timings.connectionOpenMs),
    connectionReadyMs: firstMarked(timings.connectionReadyMs),
  });
  const panels = Object.keys(timings.firstSnapshotMs).map(
    (query) =>
      `${query} ${stretches({
        requestedMs: timings.requestedMs[query],
        sealedMs: timings.sealedMs[query],
        subscribeSentMs: timings.subscribeSentMs[query],
        firstSnapshotMs: timings.firstSnapshotMs[query],
      })}`,
  );
  return [`${head} (${opened}): ${panels.join('; ')}`];
}

const isGroup = (timings: PanelTimings | GroupTimings): timings is GroupTimings =>
  typeof timings.firstSnapshotMs === 'object' && timings.firstSnapshotMs !== null;
