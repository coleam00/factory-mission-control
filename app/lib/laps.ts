/**
 * The laps screen's rows, as `db/queries/lanes.sql` and `db/queries/recent-laps.sql` return them,
 * and the clock math the queries leave to the browser. Realtime, like node-postgres, parses
 * `timestamptz` into a `Date`. Pure, no React.
 */
import { formatElapsed } from './format';

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

/** Newest first; a lap with no start goes last, ties by run id so the order never jumps. */
function newestFirst<Row extends { run_id: string; started_at: Date | null }>(
  rows: readonly Row[],
): Row[] {
  return [...rows].sort((a, b) => {
    const ta = timeOf(a.started_at);
    const tb = timeOf(b.started_at);
    if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
    return (Number.isNaN(ta) ? 0 : tb - ta) || a.run_id.localeCompare(b.run_id);
  });
}

export const lanes = (rows: readonly LaneRow[]): LaneRow[] => newestFirst(rows);
export const recentLaps = (rows: readonly RecentLapRow[]): RecentLapRow[] => newestFirst(rows);

/** A cost as a number; numeric columns can arrive as strings. Null when no step has a cost. */
export function costOf(value: number | string | null): number | null {
  if (value === null) return null;
  const cost = Number(value);
  return Number.isFinite(cost) ? cost : null;
}

/** Archon names a nested step by its path joined with `__`: `ship__intel` reads `ship / intel`. */
export const stepLabel = (step: string) => step.split('__').join(' / ');

/** A span of seconds: `MM:SS`, `HH:MM:SS`, and `Nd HH:MM:SS` past a day. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86_400);
  const rest = formatElapsed(s % 86_400);
  if (days === 0) return rest;
  return `${days}d ${rest.length === 5 ? `00:${rest}` : rest}`;
}

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
