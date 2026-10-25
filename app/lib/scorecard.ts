/**
 * The scorecard of one factory version, from `db/queries/scorecard.sql`'s step-level rows, by the
 * definitions in PRD 4.2. Where 4.2 does not say how an unfinished lap counts, this follows
 * `fixtures/expected-scorecard.sql`: count measures and cost use every lap, the time measures use
 * finished laps. Pure, no React.
 */

/** One step of one lap, or (`step_id` `holdout-catch`) one new holdout catch of that lap. */
export interface ScorecardRow {
  run_id: string;
  digest: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  step_id: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  route: string | null;
  outcome: string | null;
  reason: string | null;
}

export const HOLDOUT_CATCH = 'holdout-catch';

export interface Lap {
  id: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  route: string | null;
  review: string | null;
  land: string | null;
  landReason: string | null;
  checkAppMs: number;
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
  const laps = new Map<string, Lap>();
  for (const row of rows) {
    if (row.digest !== digest) continue;
    let lap = laps.get(row.run_id);
    if (lap === undefined) {
      lap = {
        id: row.run_id,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.completed_at,
        route: null,
        review: null,
        land: null,
        landReason: null,
        checkAppMs: 0,
        cost: 0,
        catches: 0,
      };
      laps.set(row.run_id, lap);
    }
    if (row.step_id === HOLDOUT_CATCH) {
      lap.catches++;
      continue;
    }
    lap.cost += row.cost_usd ?? 0;
    if (row.step_id === 'pick') lap.route = row.route;
    else if (row.step_id === 'review') lap.review = row.outcome;
    else if (row.step_id === 'land') {
      lap.land = row.outcome;
      lap.landReason = row.reason;
    } else if (row.step_id === 'check-app') lap.checkAppMs = row.duration_ms ?? 0;
  }
  const at = (lap: Lap) => lap.startedAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return [...laps.values()].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
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

/** Every 4.2 measure over one version's laps. A sum over no laps is 0; only division is n/a. */
export function scorecard(laps: readonly Lap[]): Scorecard {
  const all = laps.map((lap) => lap.id);
  const finished = laps.filter(isFinished);
  const finishedIds = finished.map((lap) => lap.id);
  const count = (counts: (lap: Lap) => boolean): Counted => {
    const counted = laps.filter(counts).map((lap) => lap.id);
    return { value: counted.length, laps: all, counted };
  };

  const merges = count((lap) => lap.land === 'merged');
  const hours = activeHours(finished);
  const lapMs = sum(finished.map((lap) => lap.endedAt.getTime() - lap.startedAt.getTime()));
  const checkAppMs = sum(finished.map((lap) => lap.checkAppMs));
  const caught = laps.filter((lap) => lap.catches > 0).map((lap) => lap.id);

  return {
    laps: count(() => true),
    merges,
    empty_laps: count((lap) => lap.route === 'none'),
    failed_laps: count((lap) => lap.status === 'failed'),
    send_backs: count((lap) => lap.review === 'sent-back'),
    gate_refusals: count((lap) => lap.land === 'refused'),
    active_hours: { value: hours, laps: finishedIds },
    merges_per_active_hour: { value: ratio(merges.value, hours), laps: finishedIds },
    lap_hours_per_merge: { value: ratio(lapMs / HOUR_MS, merges.value), laps: finishedIds },
    app_check_share: { value: ratio(checkAppMs, lapMs), laps: finishedIds },
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
