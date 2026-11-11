export const STOP_CLASSES = ['transient', 'environment', 'config', 'code', 'input'] as const;
export type StopClass = (typeof STOP_CLASSES)[number];

/** One row of failure-groups.sql: the unresolved failed runs sharing a signature (the Fix group's data, #516, #560). The counts and dates describe those runs only; a transient failure that a later run of its workflow retried is not counted (#628). */
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
  /** The newest UTC day any of the factory's runs stopped; `daily` ends here, and a failure on or before 14 days earlier is resolved. */
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
