/**
 * The laps screen's rows, as `db/queries/lanes.sql` and `db/queries/recent-laps.sql` return them,
 * and the clock math the queries leave to the browser. Realtime, like node-postgres, parses
 * `timestamptz` into a `Date`. Pure, no React.
 */

/** A lap's outcome, by the scorecard's definitions (PRD 4.2), as recent-laps.sql derives it. */
export const OUTCOMES = [
  'merged',
  'sent-back',
  'gate-refused',
  'needs-owner',
  'nothing',
  'failed',
] as const;

export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  merged: 'Merged',
  'sent-back': 'Sent back',
  'gate-refused': 'Gate refused',
  'needs-owner': 'Needs owner',
  nothing: 'Nothing to do',
  failed: 'Failed',
};

/**
 * The design token each outcome's color comes from (PRD 8.3): teal success, amber waiting on
 * someone, red failed, and the console's grey for a lap that found nothing to do.
 */
export const OUTCOME_TOKEN: Record<Outcome, `--${string}`> = {
  merged: '--success',
  'sent-back': '--warning',
  'gate-refused': '--error',
  'needs-owner': '--warning',
  nothing: '--text-tertiary',
  failed: '--error',
};

/** One running lap. Timestamps are the database's; the browser computes elapsed times. */
export interface LaneRow {
  run_id: string;
  started_at: Date | null;
  issue_number: number | null;
  issue_title: string | null;
  issue_url: string | null;
  route: string | null;
  depth: string | null;
  step_id: string | null;
  step_started_at: Date | null;
  cost_usd: number | string | null;
  /** Every step the lap has run, `<step id> <status>`, oldest first; null before the first. */
  steps: string[] | null;
}

/** One finished lap: completed, failed or cancelled. `outcome` is null when none applies. */
export interface RecentLapRow {
  run_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  issue_number: number | null;
  outcome: Outcome | null;
  cost_usd: number | string | null;
}

const timeOf = (at: Date | null) => (at === null ? Number.NaN : at.getTime());

/** Newer `at` first, a missing one last; 0 when both are equal or both missing. */
export function newerFirst(a: Date | null, b: Date | null): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
  return Number.isNaN(ta) ? 0 : tb - ta;
}

/** Running laps, newest start first; a lap with no start goes last, ties by run id. */
export const lanes = (rows: readonly LaneRow[]): LaneRow[] =>
  [...rows].sort(
    (a, b) => newerFirst(a.started_at, b.started_at) || a.run_id.localeCompare(b.run_id),
  );

/**
 * Finished laps, the one that finished last first (#116), so a lap that just merged tops the list
 * whenever it started. A lap with no finish goes last; ties by start, then run id, so the order
 * never jumps.
 */
export const recentLaps = (rows: readonly RecentLapRow[]): RecentLapRow[] =>
  [...rows].sort(
    (a, b) =>
      newerFirst(a.completed_at, b.completed_at) ||
      newerFirst(a.started_at, b.started_at) ||
      a.run_id.localeCompare(b.run_id),
  );

/** A cost as a number; numeric columns can arrive as strings. Null when no step has a cost. */
export function costOf(value: number | string | null): number | null {
  if (value === null) return null;
  const cost = Number(value);
  return Number.isFinite(cost) ? cost : null;
}

/** Archon names a nested step by its path joined with `__`: `ship__intel` reads `ship / intel`. */
export const stepLabel = (step: string) => step.split('__').join(' / ');

/** Seconds from `at` to `now` (ms since the epoch); null without a timestamp. */
export function since(at: Date | null, now: number): number | null {
  const seconds = (now - timeOf(at)) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}

/** A finished lap's duration in seconds; null when either end is missing. */
export function durationOf(lap: Pick<RecentLapRow, 'started_at' | 'completed_at'>): number | null {
  const seconds = (timeOf(lap.completed_at) - timeOf(lap.started_at)) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}
