/**
 * The scorecard of one factory version, from `db/queries/scorecard.sql`'s rows (one per finished
 * attempt of a lap's step, so a step that ran twice counts twice), by the definitions in PRD 4.2.
 * A lap is an `archon-loop` run whatever its status (owner decision on #16, as
 * `fixtures/expected-scorecard.sql`): count measures and cost use every lap, the time measures use
 * finished laps. Pure, no React.
 */

/** A run of this factory with a digest: a lap when its workflow is `archon-loop`. */
export interface LapRow {
  run_id: string;
  digest: string;
  workflow_name: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  step_id: null;
  pin_sha: null;
}

/**
 * One finished attempt of a lap's step, carrying only the attempt's own fields. The query keeps the
 * steps 4.2 reads an output or a duration of, and every attempt with a cost.
 */
export interface AttemptRow {
  run_id: string;
  step_id: string;
  duration_ms: number | null;
  cost_usd: number | null;
  route: string | null;
  outcome: string | null;
  reason: string | null;
  /** The attempt's new holdout catches (a check-app attempt's only). */
  holdout_catches: number | null;
  pin_sha: null;
}

/** A pin, which labels the versions whose first run came after it (as the version strip does). */
export interface PinRow {
  run_id: null;
  step_id: null;
  pin_sha: string;
  committed_at: Date;
}

/** A row of `db/queries/scorecard.sql`, which returns every column on every row, null where unused. */
export type ScorecardRow = LapRow | AttemptRow | PinRow;

const isPin = (row: ScorecardRow): row is PinRow => row.pin_sha !== null;
const isAttempt = (row: ScorecardRow): row is AttemptRow => row.step_id !== null;
const isRun = (row: ScorecardRow): row is LapRow => !isPin(row) && !isAttempt(row);

/** PRD 4.2: a lap is an `archon-loop` run. */
export const LAP_WORKFLOW = 'archon-loop';

export interface Lap {
  id: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  /** Each attempt's output, in no particular order: a step may run more than once in a lap. */
  routes: readonly string[];
  reviews: readonly string[];
  lands: readonly string[];
  /** The `reason` of each `land` attempt that refused. */
  refusals: readonly string[];
  /** The summed `duration_ms` of its check-app attempts; null when none reported one. */
  checkAppMs: number | null;
  cost: number;
  catches: number;
}

interface FinishedLap extends Lap {
  startedAt: Date;
  endedAt: Date;
}

const isFinished = (lap: Lap): lap is FinishedLap => lap.startedAt !== null && lap.endedAt !== null;

/** The laps that ran `digest`, by start (a lap not yet started last), then id. */
export function versionLaps(rows: readonly ScorecardRow[], digest: string): Lap[] {
  const laps = new Map<
    string,
    Lap & { routes: string[]; reviews: string[]; lands: string[]; refusals: string[] }
  >();
  for (const row of rows) {
    if (!isRun(row) || row.digest !== digest || row.workflow_name !== LAP_WORKFLOW) continue;
    laps.set(row.run_id, {
      id: row.run_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.completed_at,
      routes: [],
      reviews: [],
      lands: [],
      refusals: [],
      checkAppMs: null,
      cost: 0,
      catches: 0,
    });
  }
  for (const row of rows) {
    if (!isAttempt(row)) continue;
    const lap = laps.get(row.run_id);
    if (lap === undefined) continue;
    lap.cost += row.cost_usd ?? 0;
    lap.catches += row.holdout_catches ?? 0;
    if (row.step_id === 'pick' && row.route !== null) lap.routes.push(row.route);
    else if (row.step_id === 'review' && row.outcome !== null) lap.reviews.push(row.outcome);
    else if (row.step_id === 'land' && row.outcome !== null) {
      lap.lands.push(row.outcome);
      if (row.outcome === 'refused' && row.reason !== null) lap.refusals.push(row.reason);
    } else if (row.step_id === 'check-app' && row.duration_ms !== null) {
      lap.checkAppMs = (lap.checkAppMs ?? 0) + row.duration_ms;
    }
  }
  const at = (lap: Lap) => lap.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...laps.values()].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
}

/** How the version strip labels `digest`: its first run of any workflow, and the pin before it. */
export function versionPin(
  rows: readonly ScorecardRow[],
  digest: string,
): { firstRunAt: Date | null; pin: string | null } {
  let first: number | null = null;
  for (const row of rows) {
    if (!isRun(row) || row.digest !== digest || row.started_at === null) continue;
    const t = row.started_at.getTime();
    if (first === null || t < first) first = t;
  }
  if (first === null) return { firstRunAt: null, pin: null };
  let pin: PinRow | null = null;
  for (const row of rows) {
    if (!isPin(row) || row.committed_at.getTime() >= first) continue;
    if (pin === null || row.committed_at.getTime() > pin.committed_at.getTime()) pin = row;
  }
  return { firstRunAt: new Date(first), pin: pin?.pin_sha ?? null };
}

export type MeasureKey =
  | 'laps'
  | 'merges'
  | 'empty_laps'
  | 'failed_laps'
  | 'send_backs'
  | 'gate_refusals'
  | 'active_hours'
  | 'merges_per_active_hour'
  | 'lap_hours_per_merge'
  | 'app_check_share'
  | 'cost_per_merge'
  | 'new_holdout_catches';

export interface Measure {
  key: MeasureKey;
  label: string;
  /** How the value reads: a whole count, a ratio, or US dollars. */
  unit: 'count' | 'ratio' | 'usd';
}

/** In the order the screen shows them; the keys are `fixtures/expected-scorecard.json`'s. */
export const MEASURES: readonly Measure[] = [
  { key: 'laps', label: 'Laps', unit: 'count' },
  { key: 'merges', label: 'Merges', unit: 'count' },
  { key: 'empty_laps', label: 'Empty laps', unit: 'count' },
  { key: 'failed_laps', label: 'Failed laps', unit: 'count' },
  { key: 'send_backs', label: 'Send-backs', unit: 'count' },
  { key: 'gate_refusals', label: 'Gate refusals', unit: 'count' },
  { key: 'active_hours', label: 'Active hours', unit: 'count' },
  { key: 'merges_per_active_hour', label: 'Merges per active hour', unit: 'ratio' },
  { key: 'lap_hours_per_merge', label: 'Lap-hours per merge', unit: 'ratio' },
  { key: 'app_check_share', label: 'App-check share', unit: 'ratio' },
  { key: 'cost_per_merge', label: 'Cost per merge', unit: 'usd' },
  { key: 'new_holdout_catches', label: 'New holdout catches', unit: 'count' },
];

export interface Measured {
  /** Rounded to 4 decimals; null where it divides by zero. */
  value: number | null;
  /** The ids of the laps it rests on. */
  laps: readonly string[];
  /** For a count of laps, the ids of the laps it counted. */
  counted?: readonly string[];
}

/** A count of laps: the value is how many of the laps it rests on it counted. */
interface Counted extends Measured {
  value: number;
  counted: readonly string[];
}

export type Scorecard = Record<MeasureKey, Measured>;

const HOUR_MS = 3_600_000;

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const ratio = (num: number, den: number): number | null => (den === 0 ? null : round4(num / den));
const sum = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0);

/** The UTC clock hours in which at least one of `laps` was running. */
function activeHours(laps: readonly FinishedLap[]): number {
  const hours = new Set<number>();
  for (const lap of laps) {
    const end = lap.endedAt.getTime();
    for (let h = Math.floor(lap.startedAt.getTime() / HOUR_MS) * HOUR_MS; h < end; h += HOUR_MS) {
      hours.add(h);
    }
  }
  return hours.size;
}

/** Every 4.2 measure over one version's laps. A count over no laps is 0; only division is n/a. */
export function scorecard(laps: readonly Lap[]): Scorecard {
  const all = laps.map((lap) => lap.id);
  const finished = laps.filter(isFinished);
  const finishedIds = finished.map((lap) => lap.id);
  const count = (counts: (lap: Lap) => boolean): Counted => {
    const counted = laps.filter(counts).map((lap) => lap.id);
    return { value: counted.length, laps: all, counted };
  };

  const merges = count((lap) => lap.lands.includes('merged'));
  const hours = activeHours(finished);
  const lapMs = sum(finished.map((lap) => lap.endedAt.getTime() - lap.startedAt.getTime()));
  const checkAppMs = finished.flatMap((lap) => (lap.checkAppMs === null ? [] : [lap.checkAppMs]));
  const caught = laps.filter((lap) => lap.catches > 0).map((lap) => lap.id);

  return {
    laps: count(() => true),
    merges,
    empty_laps: count((lap) => lap.routes.includes('none')),
    failed_laps: count((lap) => lap.status === 'failed'),
    send_backs: count((lap) => lap.reviews.includes('sent-back')),
    gate_refusals: count((lap) => lap.lands.includes('refused')),
    active_hours: { value: hours, laps: finishedIds },
    merges_per_active_hour: { value: ratio(merges.value, hours), laps: finishedIds },
    // A sum over no finished lap has no duration to divide (the oracle's sum is NULL), so n/a.
    lap_hours_per_merge: {
      value: finished.length === 0 ? null : ratio(lapMs / HOUR_MS, merges.value),
      laps: finishedIds,
    },
    // Likewise with no check-app duration on any finished lap: n/a, not 0.
    app_check_share: {
      value: checkAppMs.length === 0 ? null : ratio(sum(checkAppMs), lapMs),
      laps: finishedIds,
    },
    cost_per_merge: { value: ratio(sum(laps.map((lap) => lap.cost)), merges.value), laps: all },
    new_holdout_catches: {
      value: sum(laps.map((lap) => lap.catches)),
      laps: all,
      counted: caught,
    },
  };
}

/** A measure's value as the screen's `data-value` carries it: 4 decimals, or `n/a`. */
export function dataValue(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

/** `b` minus `a`, or null when either side divides by zero. */
export function difference(a: Measured, b: Measured): number | null {
  return a.value === null || b.value === null ? null : round4(b.value - a.value);
}

/** PRD 4.2: a difference resting on fewer laps than this on either side is not yet meaningful. */
export const MEANINGFUL_LAPS = 10;

export function meaningful(a: Measured, b: Measured): boolean {
  return a.laps.length >= MEANINGFUL_LAPS && b.laps.length >= MEANINGFUL_LAPS;
}
