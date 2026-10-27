import type { QueryObservation } from '../../app/live/subscribe-marks';
import { parameterCount } from '../../server/live';
import type { Page } from '../lib/cdp';
import type { Db, Row } from '../lib/db';

export const PERFORMANCE_LIMITS = { queryExecutionMs: 100, renderMs: 500 };

export interface PanelTimings {
  readyMs: number | null;
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
}

export type GroupTimings = { readyMs: number | null } & {
  [K in Exclude<keyof PanelTimings, 'readyMs'>]: Record<string, PanelTimings[K]>;
};

export const emptyPanelTimings = (): PanelTimings => ({
  readyMs: null,
  firstSnapshotMs: null,
  subscribeToFirstResultMs: null,
  renderMs: null,
  queryExecutionMs: null,
  queryExecutionSamplesMs: null,
  queryContext: null,
  measurementError: null,
});

export function groupTimings(panels: Record<string, PanelTimings>): GroupTimings {
  const entries = Object.entries(panels);
  const perQuery = <K extends keyof PanelTimings>(key: K): Record<string, PanelTimings[K]> =>
    Object.fromEntries(entries.map(([query, timing]) => [query, timing[key]]));
  const ready = entries.map(([, timing]) => timing.readyMs);
  return {
    readyMs:
      ready.length > 0 && ready.every((ms) => ms !== null) ? Math.round(Math.max(...ready)) : null,
    firstSnapshotMs: perQuery('firstSnapshotMs'),
    subscribeToFirstResultMs: perQuery('subscribeToFirstResultMs'),
    renderMs: perQuery('renderMs'),
    queryExecutionMs: perQuery('queryExecutionMs'),
    queryExecutionSamplesMs: perQuery('queryExecutionSamplesMs'),
    queryContext: perQuery('queryContext'),
    measurementError: perQuery('measurementError'),
  };
}

export function emptyGroupTimings(queries: readonly string[]): GroupTimings {
  return groupTimings(Object.fromEntries(queries.map((query) => [query, emptyPanelTimings()])));
}

interface BrowserObservation {
  readyAt: number | null;
  sentAt: number | null;
  firstAt: number | null;
  renderedAt: number | null;
  subscribedAt: number | null;
  context: unknown;
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
      return [query, { readyAt: ready?.startTime ?? null, sentAt: first(query, 'subscribe-sent')?.startTime ?? null,
        firstAt: arrived?.startTime ?? null, renderedAt: matched('rendered')?.startTime ?? null,
        subscribedAt: arrived?.detail?.subscribedAt ?? null, context: ready?.detail ?? null }];
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
