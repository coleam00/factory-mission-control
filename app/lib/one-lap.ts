/**
 * The one-lap screen's rows, as `db/queries/one-lap.sql`, `one-lap-steps.sql` and
 * `one-lap-checks.sql` return them, and the ordering, sums and links the queries leave to the
 * browser. Pure, no React.
 */
import { costOf, type Outcome, since } from './laps';

/** One review disposition as `mc.step_output` keeps it: the line id it answers, or null. */
export interface Disposition {
  line: string | null;
  action: unknown;
}

/** The lap itself: its claim, route and depth, its review and its merge gate. */
export interface OneLapRow {
  run_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  repository: string;
  console: string;
  issue_number: number | null;
  issue_title: string | null;
  issue_url: string | null;
  route: string | null;
  depth: string | null;
  pr: string | null;
  review_status: string | null;
  review_outcome: string | null;
  review_delivers: string | null;
  dispositions: Disposition[] | null;
  gate_status: string | null;
  gate_outcome: string | null;
  gate_reason: string | null;
}

/**
 * One attempt of one step. An earlier attempt of a repeated step has no model or tokens. The
 * bigint columns arrive as numbers from a direct query and as strings from Realtime.
 */
export interface StepAttemptRow {
  step_id: string;
  status: string;
  started_at: Date | null;
  duration_ms: number | string | null;
  model: string | null;
  tokens_input: number | string | null;
  tokens_output: number | string | null;
  tokens_cache_read: number | string | null;
  tokens_cache_write: number | string | null;
  cost_usd: number | string | null;
  outcome: string | null;
  error: string | null;
  /** The step's place in the loop at the lap's pin; null for a step that version lacks. */
  position: number | null;
}

/** One app-check line: never its text, and a holdout only by its scenario id. */
export interface CheckLineRow {
  position: number;
  kind: string;
  verdict: string;
  evidence_count: number;
  scenario_id: string | null;
}

const timeOf = (at: Date | null) => (at === null ? Number.NaN : at.getTime());

const placeOf = (row: StepAttemptRow) =>
  row.position === null ? Number.POSITIVE_INFINITY : Number(row.position);

/**
 * By start; an attempt with no start goes last, in the loop's order (#191), a step the lap's
 * version lacks after those. Ties by step so the order never jumps.
 */
export function attemptsInOrder(rows: readonly StepAttemptRow[]): StepAttemptRow[] {
  return [...rows].sort((a, b) => {
    const ta = timeOf(a.started_at);
    const tb = timeOf(b.started_at);
    if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1;
    if (!Number.isNaN(ta)) return ta - tb || a.step_id.localeCompare(b.step_id);
    const pa = placeOf(a);
    const pb = placeOf(b);
    return (pa === pb ? 0 : pa < pb ? -1 : 1) || a.step_id.localeCompare(b.step_id);
  });
}

export const linesInOrder = (rows: readonly CheckLineRow[]): CheckLineRow[] =>
  [...rows].sort((a, b) => a.position - b.position);

/** The lap's cost: every attempt's, a repeated step's earlier runs included. Null when none has one. */
export function lapCost(rows: readonly StepAttemptRow[]): number | null {
  const costs = rows.map((row) => costOf(row.cost_usd)).filter((cost) => cost !== null);
  return costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0);
}

/** Seconds an attempt took, or has taken so far while it runs; null when not recorded. */
export function attemptSeconds(attempt: StepAttemptRow, now: number): number | null {
  if (attempt.duration_ms !== null) {
    const ms = Number(attempt.duration_ms);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return attempt.status === 'running' ? since(attempt.started_at, now) : null;
}

/** The lap's run in the Archon console (PRD 11.6). */
export const consoleUrl = (console: string, runId: string) =>
  `${console.replace(/\/+$/, '')}/console/r/${runId}`;

/**
 * `#103`, `103` or a pull request URL ending `/pull/103` (what the loop's steps write) is pull
 * request 103; any other text names none.
 */
export function prNumber(text: string | null): number | null {
  const match = /^#?(\d+)$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/.exec(
    text?.trim() ?? '',
  );
  return match === null ? null : Number(match[1] ?? match[2]);
}

export const pullUrl = (repository: string, n: number) =>
  `https://github.com/${repository}/pull/${n}`;

export const issueUrl = (repository: string, n: number) =>
  `https://github.com/${repository}/issues/${n}`;

/** A finished lap's outcome, read as recent-laps.sql reads it; null while it runs or when none applies. */
export function lapOutcome(lap: OneLapRow): Outcome | null {
  if (!['completed', 'failed', 'cancelled'].includes(lap.status)) return null;
  if (lap.status === 'failed') return 'failed';
  if (lap.gate_outcome === 'merged') return 'merged';
  if (lap.gate_outcome === 'refused') return 'gate-refused';
  if (lap.review_outcome === 'sent-back') return 'sent-back';
  if (lap.review_outcome === 'needs-owner') return 'needs-owner';
  if (lap.route === 'none') return 'nothing';
  return null;
}

/** A disposition's action as text: Archon writes a string, but the column keeps any JSON. */
export function actionText(action: unknown): string | null {
  if (action === null || action === undefined) return null;
  return typeof action === 'string' ? action : JSON.stringify(action);
}

/** The design token of a step's status (engineering.md: blue running, teal success, red failed). */
export const STEP_STATUS_TOKEN: Record<string, `--${string}`> = {
  running: '--running',
  completed: '--success',
  failed: '--error',
  skipped: '--text-tertiary',
};

/** The review's outcomes: a merge is a success, a send-back or a question waits on someone. */
export const REVIEW_TOKEN: Record<string, `--${string}`> = {
  merge: '--success',
  'sent-back': '--warning',
  'needs-owner': '--warning',
};

export const GATE_TOKEN: Record<string, `--${string}`> = {
  merged: '--success',
  refused: '--error',
};

/** The color an app-check verdict reads in: a pass teal, a failure red, anything else plain. */
export const VERDICT_TOKEN: Record<string, `--${string}`> = {
  PASS: '--success',
  OK: '--success',
  FAIL: '--error',
};
