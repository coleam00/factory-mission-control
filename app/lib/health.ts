/**
 * The health screen (PRD 4.8): the rows of `db/queries/health-*.sql` as the runs waiting to start
 * or resume, the steps running far past their usual time, failed laps by cause, and the workable
 * issues against the running laps. Pure, no React; the browser's clock decides what is overdue.
 */

import { newerFirst } from './laps';

/** One row of health-runs.sql: a pending, paused or failed run. */
export interface HealthRunRow {
  run_id: string;
  workflow_name: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  /** The run's latest failed step, when one failed. */
  failed_step: string | null;
  error: string | null;
  failed_at: Date | null;
}

/**
 * One row of health-steps.sql: a step running on a running lap, or one of the latest completions
 * of a step that is running. `at` is when a running step started or when a completion ended.
 */
export interface HealthStepRow {
  kind: 'running' | 'completion';
  run_id: string;
  workflow_name: string;
  step_id: string;
  at: Date | null;
  duration_ms: number | null;
}

/** One row of health-workable.sql: a workable issue, or a running lap. */
export interface HealthWorkableRow {
  kind: 'issue' | 'lap';
  issue_number: number | null;
  title: string | null;
  url: string | null;
  run_id: string | null;
}

export const CAUSES = ['usage-limit', 'authentication', 'infrastructure', 'other'] as const;
export type Cause = (typeof CAUSES)[number];

export const CAUSE_LABEL: Record<Cause, string> = {
  'usage-limit': 'Usage limit',
  authentication: 'Authentication',
  infrastructure: 'Infrastructure',
  other: 'Other',
};

/** The PRD's patterns, tried in order: the first that matches the error text names its cause. */
const CAUSE_PATTERNS: [Exclude<Cause, 'other'>, RegExp][] = [
  ['usage-limit', /usage limit|429/i],
  ['authentication', /401|unauthor/i],
  ['infrastructure', /ECONN|ETIMEDOUT|fetch failed/i],
];

export function causeOf(error: string | null): Cause {
  if (error === null) return 'other';
  return CAUSE_PATTERNS.find(([, pattern]) => pattern.test(error))?.[0] ?? 'other';
}

export interface WaitingRun extends HealthRunRow {
  status: 'pending' | 'paused';
}

/** Pending runs, then paused ones, each oldest first. */
export function waitingRuns(rows: readonly HealthRunRow[]): WaitingRun[] {
  const waiting = rows.filter(
    (row): row is WaitingRun => row.status === 'pending' || row.status === 'paused',
  );
  return waiting.sort(
    (a, b) =>
      Number(a.status === 'paused') - Number(b.status === 'paused') ||
      newerFirst(b.started_at, a.started_at) ||
      a.run_id.localeCompare(b.run_id),
  );
}

export interface FailedLap extends HealthRunRow {
  cause: Cause;
}

/**
 * Failed laps: a run whose status is failed, or one with a failed step, whose run status may not
 * have caught up yet. Each takes its cause from its latest failed step's error; newest first.
 */
export function failedLaps(rows: readonly HealthRunRow[]): FailedLap[] {
  return rows
    .filter((row) => row.status === 'failed' || row.failed_step !== null)
    .map((row) => ({ ...row, cause: causeOf(row.error) }))
    .sort(
      (a, b) =>
        newerFirst(a.failed_at ?? a.completed_at, b.failed_at ?? b.completed_at) ||
        a.run_id.localeCompare(b.run_id),
    );
}

export function countByCause(laps: readonly FailedLap[]): Record<Cause, number> {
  const counts = Object.fromEntries(CAUSES.map((cause) => [cause, 0])) as Record<Cause, number>;
  for (const lap of laps) counts[lap.cause]++;
  return counts;
}

/** How many of a step's completions its usual time is taken over: the latest 50. */
export const COMPLETIONS = 50;
/** A running step is overdue past this many times its 90th-percentile duration. */
export const OVERDUE_FACTOR = 2;

/** The 90th percentile by nearest rank: the smallest duration at least 90% of them do not exceed. */
export function p90(durations: readonly number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] ?? null;
}

/** The p90 duration in ms of each step over its latest COMPLETIONS completions, by step key. */
export function usualDurations(
  rows: readonly HealthStepRow[],
): Map<string, { p90: number; completions: number }> {
  const byStep = new Map<string, HealthStepRow[]>();
  for (const row of rows) {
    if (row.kind !== 'completion' || row.duration_ms === null) continue;
    const key = stepKey(row);
    byStep.set(key, [...(byStep.get(key) ?? []), row]);
  }
  const usual = new Map<string, { p90: number; completions: number }>();
  for (const [key, completions] of byStep) {
    const latest = completions.sort((a, b) => newerFirst(a.at, b.at)).slice(0, COMPLETIONS);
    const value = p90(latest.map((row) => Number(row.duration_ms)));
    if (value !== null) usual.set(key, { p90: value, completions: latest.length });
  }
  return usual;
}

const stepKey = (row: Pick<HealthStepRow, 'workflow_name' | 'step_id'>) =>
  `${row.workflow_name} ${row.step_id}`;

export interface OverdueStep {
  run_id: string;
  workflow_name: string;
  step_id: string;
  started_at: Date;
  /** How long it has run, in ms by the browser's clock. */
  running_ms: number;
  p90_ms: number;
  completions: number;
}

/**
 * Running steps that have run longer than OVERDUE_FACTOR times their step's p90, longest-running
 * first. A step with no completion yet has no usual time and is never overdue.
 */
export function overdueSteps(rows: readonly HealthStepRow[], now: number): OverdueStep[] {
  const usual = usualDurations(rows);
  const overdue: OverdueStep[] = [];
  for (const row of rows) {
    if (row.kind !== 'running' || row.at === null) continue;
    const step = usual.get(stepKey(row));
    const running_ms = now - row.at.getTime();
    if (step === undefined || running_ms <= OVERDUE_FACTOR * step.p90) continue;
    overdue.push({
      run_id: row.run_id,
      workflow_name: row.workflow_name,
      step_id: row.step_id,
      started_at: row.at,
      running_ms,
      p90_ms: step.p90,
      completions: step.completions,
    });
  }
  return overdue.sort(
    (a, b) =>
      b.running_ms - a.running_ms ||
      a.run_id.localeCompare(b.run_id) ||
      a.step_id.localeCompare(b.step_id),
  );
}

export interface WorkableIssue {
  issue_number: number;
  title: string;
  url: string;
}

/** The workable issues, oldest number first, and how many laps are running. */
export function workable(rows: readonly HealthWorkableRow[]): {
  issues: WorkableIssue[];
  running: number;
} {
  const issues = rows
    .filter((row) => row.kind === 'issue' && row.issue_number !== null)
    .map((row) => ({
      issue_number: Number(row.issue_number),
      title: row.title ?? '',
      url: row.url ?? '',
    }))
    .sort((a, b) => a.issue_number - b.issue_number);
  return { issues, running: rows.filter((row) => row.kind === 'lap').length };
}
