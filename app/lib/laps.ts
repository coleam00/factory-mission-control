/** The clock math and labels the lap screens share. Pure, no React. */

/** A lap's outcome, by the scorecard's definitions (PRD 4.2). */
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

const timeOf = (at: Date | null) => (at === null ? Number.NaN : at.getTime());

/** Newer `at` first, a missing one last; 0 when both are equal or both missing. */
export function newerFirst(a: Date | null, b: Date | null): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
  return Number.isNaN(ta) ? 0 : tb - ta;
}

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
export function durationOf(lap: {
  started_at: Date | null;
  completed_at: Date | null;
}): number | null {
  const seconds = (timeOf(lap.completed_at) - timeOf(lap.started_at)) / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}
