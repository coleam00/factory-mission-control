/**
 * The Runs screen's rows, as `db/queries/runs.sql` returns them, and the text the browser writes
 * from them. Pure, no React.
 */
import type { State } from './states';

export const RUNS_PAGE_SIZE = 50;

/**
 * One run of the page, with the whole screen's counts repeated on it. A page with no run
 * returns one row whose run columns are null, so the counts still arrive.
 */
export interface RunsRow {
  all_count: number;
  running_count: number;
  needs_you_count: number;
  failed_count: number;
  done_count: number;
  idle_count: number;
  /** The idle polls matching the search, whether the toggle hides them or not. */
  idle_polls: number;
  run_id: string | null;
  /** 1-based place in the chip's list, newest first; the browser sorts by it. */
  position: number | null;
  workflow_name: string | null;
  status: string | null;
  state: State | null;
  idle_poll: boolean | null;
  started_at: Date | null;
  completed_at: Date | null;
  issue_number: number | null;
  issue_title: string | null;
  stop_step: string | null;
  stop_line: string | null;
  round: string | null;
  step_id: string | null;
  pr_number: number | null;
  cost_usd: number | string | null;
}

type CountColumn = keyof Pick<
  RunsRow,
  'all_count' | 'running_count' | 'needs_you_count' | 'failed_count' | 'done_count' | 'idle_count'
>;

/** The six chips in order. `state` is the chip's filter, '' for All; the idle state's chip is Cancelled. */
export const RUN_CHIPS: readonly { state: State | ''; label: string; count: CountColumn }[] = [
  { state: '', label: 'All', count: 'all_count' },
  { state: 'running', label: 'Running', count: 'running_count' },
  { state: 'needs-you', label: 'Needs you', count: 'needs_you_count' },
  { state: 'failed', label: 'Failed', count: 'failed_count' },
  { state: 'done', label: 'Done', count: 'done_count' },
  { state: 'idle', label: 'Cancelled', count: 'idle_count' },
];

export interface RunsFilter {
  q: string;
  /** A chip's state, '' for All. */
  state: State | '';
  /** Whether idle polls are hidden. */
  hideIdle: boolean;
  /** 1-based. */
  page: number;
}

/** The query's parameters after the factory. */
export const runsArgs = ({ q, state, hideIdle, page }: RunsFilter): string[] => [
  q,
  state,
  hideIdle ? 'hide' : 'show',
  String(page - 1),
  String(RUNS_PAGE_SIZE),
];

/** A run of the page: the row the query returns when a run is on it. */
export type RunRow = RunsRow & {
  run_id: string;
  position: number;
  workflow_name: string;
  state: State;
};

export interface RunsView {
  counts: RunsRow | undefined;
  runs: RunRow[];
}

/** The page's runs by position, and the counts any row carries. */
export function runsView(rows: readonly RunsRow[]): RunsView {
  const runs = rows
    .filter((row): row is RunRow => row.run_id !== null)
    .sort((a, b) => a.position - b.position);
  return { counts: rows[0], runs };
}

/** `39s`, `46m`, `3h 12m`, `2d 4h`: two units at most. */
export function formatTook(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** How long a run took: to its end, or to `now` (ms) while it has none. Null without a start. */
export function took(
  run: Pick<RunsRow, 'started_at' | 'completed_at'>,
  now: number,
): string | null {
  if (run.started_at === null) return null;
  const end = run.completed_at?.getTime() ?? now;
  return formatTook((end - run.started_at.getTime()) / 1000);
}

/** The part of a step's address that says where it is: `ship__deliver__rounds.review__synthesize` reads `review__synthesize`. */
const stepName = (step: string): string => step.split('.').pop() ?? step;

/** The mono line under the workflow: round, step and pull request, each when known. */
export function subLine(run: RunRow): string {
  const step =
    run.state === 'failed' || run.state === 'needs-you'
      ? (run.stop_step ?? run.step_id)
      : run.step_id;
  return [
    run.round === null ? null : `round ${run.round}`,
    step === null ? null : stepName(step),
    run.pr_number === null ? null : `PR #${run.pr_number}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Why a run stopped, written in its state's color; null when it has nothing to say. */
export function stopLine(run: RunRow): string | null {
  if (run.state === 'failed') return run.stop_line;
  if (run.state === 'needs-you') {
    return run.stop_line === null ? 'Waiting on you' : `Asking: ${run.stop_line}`;
  }
  return null;
}
