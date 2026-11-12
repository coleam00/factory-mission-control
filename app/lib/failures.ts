export const STOP_CLASSES = ['transient', 'environment', 'config', 'code', 'input'] as const;
export type StopClass = (typeof STOP_CLASSES)[number];

const HOUR_MS = 3_600_000;

/**
 * failure-groups.sql's `$2`: the instant 7 days ago, cut down to the whole UTC hour (owner change 4, 2026-11-12).
 * A failure stopped at or before it is resolved. The hour keeps the subscription's arguments fixed for
 * an hour, and a failure is never resolved before it is 7 days old.
 */
export const failuresSince = (now: Date): string =>
  new Date(Math.floor((now.getTime() - 7 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS).toISOString();

/** Milliseconds from `now` to the next whole UTC hour, when `failuresSince` moves on. */
export const msToNextHour = (now: Date): number => HOUR_MS - (now.getTime() % HOUR_MS);

/** One row of failure-groups.sql: the unresolved failed runs sharing a signature (the Fix group's data, #516, #560). A failure is resolved, and not counted, when its work item is closed, a later run of its workflow completed on the item (or, with no item, at all), or it stopped at or before `failuresSince`. A transient failure that a later run of its workflow retried is not counted either (#628). The counts and dates describe the unresolved runs only. */
export interface FailureGroupRow {
  signature: string;
  workflow_name: string;
  step_id: string | null;
  /** The class of the latest run, or 'mixed' when the group's runs differ (an unclassified run counts as its own class). */
  class: StopClass | 'mixed' | null;
  failures: number;
  first_at: Date | null;
  last_at: Date | null;
  latest_run_id: string;
  line: string | null;
  /** The newest UTC day any of the factory's runs stopped; `daily` ends here. */
  last_day: Date;
  /** Failures per UTC day for the 14 days ending at `last_day`, oldest first. */
  daily: number[];
  /** The factory's Archon console, for the latest run's link. */
  console: string;
}

/** One row of retried-runs.sql: a transient failure that a later completed run of its workflow followed, on the factory's latest stop day (#628). */
export interface RetriedRunRow {
  run_id: string;
  workflow_name: string;
  step_id: string | null;
  line: string | null;
  stopped_at: Date;
}
