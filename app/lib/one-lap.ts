/**
 * The one-lap screen's rows, as `db/queries/one-lap.sql`, `one-lap-steps.sql` and
 * `one-lap-checks.sql` return them, and the ordering, sums and links the queries leave to the
 * browser. Pure, no React.
 */
import type { StopClass } from './failures';
import { type Outcome, since } from './laps';
import { placeAddress } from './places';
import type { RUN_STATE } from './states';

/** One review disposition as `mc.step_output` keeps it: the line id it answers, or null. */
export interface Disposition {
  line: string | null;
  action: unknown;
}

/** The review's dispositions without those that answer a line the screen hides. */
export const shownDispositions = (lap: Pick<OneLapRow, 'dispositions' | 'hidden_lines'>) =>
  (lap.dispositions ?? []).filter((d) => d.line === null || !lap.hidden_lines.includes(d.line));

/** The address of a run's lap page; the factory is encoded, the run id is not. */
export const lapHref = (factory: string, runId: string): string =>
  `${placeAddress(factory, 'runs')}/${runId}`;

/**
 * The pack's old loop, whose runs carry route, depth, the old review outcomes and the merge gate.
 * Deliberately not `LAP_WORKFLOWS` (which runs are laps): widening it must not change what counts
 * as an old-loop run.
 */
export const OLD_LOOP_WORKFLOW = 'archon-loop';

/** Whether a run of `workflow` is an old-loop run. */
export const isOldLoop = (workflow: string | null): boolean => workflow === OLD_LOOP_WORKFLOW;

/** What a running workflow is, in the map's words; an unknown one shows its own name. */
const WORKFLOW_LABEL: Readonly<Record<string, string>> = {
  [OLD_LOOP_WORKFLOW]: 'Lap',
  'archon-build-queue': 'Build',
  'archon-merge-queue': 'Merge',
  'archon-intake': 'Intake',
  'archon-split': 'Split',
  'archon-discoveries': 'Found by the factory',
  'factory-app-check': 'App check',
  'factory-deploy': 'Staging',
  'factory-manager': 'Manager',
  'factory-backlog': 'Split',
};
export const workflowLabel = (workflow: string): string => WORKFLOW_LABEL[workflow] ?? workflow;

/** The run itself: its workflow, item, stop record and, for an old loop, route, review and merge gate. */
export interface OneLapRow {
  run_id: string;
  workflow_name: string;
  status: keyof typeof RUN_STATE;
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
  /** Line ids of the lap's old holdout lines, which no screen shows. */
  hidden_lines: string[];
  gate_status: string | null;
  gate_outcome: string | null;
  gate_reason: string | null;
  /** The run's stop record (`mc.run_stops`); null while the run has none. */
  stop_status: string | null;
  stop_step: string | null;
  stop_line: string | null;
  stop_class: StopClass | null;
  /** When the answered run began waiting for a free slot (`mc.capacity_waits`); null when it is not. */
  capacity_since: Date | null;
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
  /** When the event that finished the attempt arrived; null for a step row with no attempt. */
  event_at?: Date | null;
}

/** One app-check line: never its text. */
export interface CheckLineRow {
  position: number;
  /** The report's line id, as a disposition names it; null for a line projected before #184. */
  line_id: string | null;
  kind: string;
  verdict: string;
  evidence_count: number;
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

/**
 * By start, an attempt with no start (Archon's skip event carries no timing) by the event that
 * finished it, so a skipped step stays in the round it was skipped in. Rows with neither go last
 * as in `attemptsInOrder`.
 */
export function attemptsInRunOrder(rows: readonly StepAttemptRow[]): StepAttemptRow[] {
  const at = (row: StepAttemptRow) => timeOf(row.started_at ?? row.event_at ?? null);
  const dated = rows.filter((row) => !Number.isNaN(at(row)));
  const undated = rows.filter((row) => Number.isNaN(at(row)));
  return [
    ...dated.sort((a, b) => at(a) - at(b) || a.step_id.localeCompare(b.step_id)),
    ...attemptsInOrder(undated),
  ];
}

export const linesInOrder = (rows: readonly CheckLineRow[]): CheckLineRow[] =>
  [...rows].sort((a, b) => a.position - b.position);

/** The one line a disposition answers; null when it names none, or no line or several match. */
export function checkLineFor(
  line: string | null,
  rows: readonly CheckLineRow[],
): CheckLineRow | null {
  if (line === null) return null;
  const matches = rows.filter((row) => row.line_id === line);
  return matches.length === 1 ? (matches[0] ?? null) : null;
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
 * request 103. Some packs write a JSON object instead; its `number` or `url` field is read the
 * same way. Any other text names none.
 */
export function prNumber(text: string | null): number | null {
  const trimmed = text?.trim() ?? '';
  const match = /^#?(\d+)$|^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/.exec(trimmed);
  if (match !== null) return Number(match[1] ?? match[2]);
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as { number?: unknown; url?: unknown };
    if (typeof value.number === 'number' && Number.isInteger(value.number) && value.number > 0) {
      return value.number;
    }
    return typeof value.url === 'string' ? prNumber(value.url) : null;
  } catch {
    return null;
  }
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

/** Whether an address names a run id at all: Archon's run ids are UUIDs. */
export const isRunId = (runId: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId);
