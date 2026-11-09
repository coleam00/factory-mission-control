export const STOP_CLASSES = ['transient', 'environment', 'config', 'code', 'input'] as const;
export type StopClass = (typeof STOP_CLASSES)[number];

/** One row of failure-groups.sql: the failed runs sharing a signature (the Fix group's data, #516). */
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
  /** The newest day with a failure; `daily` ends here. */
  last_day: Date;
  /** Failures per UTC day for the 14 days ending at `last_day`, oldest first. */
  daily: number[];
  /** The factory's Archon console, for the latest run's link. */
  console: string;
}
