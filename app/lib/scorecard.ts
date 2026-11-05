/**
 * The scorecard of one factory version, from `db/queries/scorecard.sql`'s rows (one per finished
 * attempt of a lap's step, so a step that ran twice counts twice), by the definitions in PRD 4.2.
 * A lap is an `archon-loop` run, or an `archon-build-queue` run on a work item (`scorecard.sql`
 * decides which), whatever its status (owner decisions on #16 and #378, as
 * `fixtures/expected-scorecard.sql`): count measures and cost use every lap, the time measures use
 * finished laps. A build-queue lap merges nothing itself: the merge queue's later run does, so each
 * pull request that run merged is credited to the build-queue lap that opened it (#393, PRD 4.2).
 * Pure, no React.
 */

import { formatNumber } from './format';
import { mergedPulls, mergeItems } from './merge-queue';

/** A lap of this factory with a digest. */
export interface LapRow {
  run_id: string;
  digest: string;
  workflow_name: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  step_id: null;
  pin_sha: null;
  /** A build-queue lap's work item (its facts step's issue number), as text; null for a loop lap. */
  issue: string | null;
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
  pin_sha: null;
}

/** A version of this factory (mc.versions): its first lap's start, and the pin that labels it. */
export interface VersionRow {
  run_id: null;
  step_id: null;
  digest: string;
  first_run_at: Date;
  pin_sha: string | null;
}

/**
 * A merge-queue run whose record step read pull requests back as merged: `merged` is that list and
 * `items` the run's facts items (each pull request's issue), both JSON text; `completed_at` is the
 * record step's finish. Its `digest` column is null, left off the type so no reader takes it for a
 * lap's or a version's.
 */
export interface MergeRow {
  run_id: string;
  step_id: null;
  pin_sha: null;
  workflow_name: string;
  completed_at: Date | null;
  merged: string;
  items: string | null;
}

/** A row of `db/queries/scorecard.sql`, which returns every column on every row, null where unused. */
export type ScorecardRow = LapRow | AttemptRow | VersionRow | MergeRow;

const isVersion = (row: ScorecardRow): row is VersionRow => row.run_id === null;
const isMerge = (row: ScorecardRow): row is MergeRow =>
  typeof (row as MergeRow).merged === 'string';
const isAttempt = (row: ScorecardRow): row is AttemptRow => row.step_id !== null;
const isRun = (row: ScorecardRow): row is LapRow =>
  !isVersion(row) && !isMerge(row) && !isAttempt(row);

/** PRD 4.2: the workflows whose runs can be laps. `scorecard.sql` keeps only the build-queue runs on a work item. */
const BUILD_QUEUE = 'archon-build-queue';
export const LAP_WORKFLOWS: readonly string[] = ['archon-loop', BUILD_QUEUE];

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
  /** The pull requests the merge queue merged that this build-queue lap is credited with; empty for a loop lap. */
  queueMerges: readonly number[];
}

interface FinishedLap extends Lap {
  startedAt: Date;
  endedAt: Date;
}

const isFinished = (lap: Lap): lap is FinishedLap => lap.startedAt !== null && lap.endedAt !== null;

const positive = (text: string | null): number | null => {
  const n = Number(text);
  return text !== null && Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Each pull request the merge queue merged, credited to the last build-queue lap on its issue that
 * started no later than the merge (lap run id to pull request numbers). A pull request counts once,
 * at its first merge; its issue is the one its merge run's facts item names. No such lap, no credit.
 */
function queueMergeCredits(rows: readonly ScorecardRow[]): Map<string, number[]> {
  const merges = new Map<number, { issue: number; at: Date | null }>();
  for (const row of rows) {
    if (!isMerge(row)) continue;
    const issues = new Map(mergeItems(row.items).map(({ pr, issue }) => [pr, issue]));
    for (const pr of mergedPulls(row.merged)) {
      const issue = issues.get(pr);
      const seen = merges.get(pr);
      if (issue === undefined) continue;
      const earlier =
        seen === undefined ||
        (row.completed_at !== null && (seen.at === null || row.completed_at < seen.at));
      if (earlier) merges.set(pr, { issue, at: row.completed_at });
    }
  }
  const builds = rows
    .filter(isRun)
    .filter((row) => row.workflow_name === BUILD_QUEUE && row.started_at !== null)
    .flatMap((row) => {
      const issue = positive(row.issue);
      return issue === null || row.started_at === null
        ? []
        : [{ id: row.run_id, issue, startedAt: row.started_at }];
    })
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));

  const credits = new Map<string, number[]>();
  for (const [pr, { issue, at }] of merges) {
    const last = builds.findLast(
      (lap) => lap.issue === issue && (at === null || lap.startedAt <= at),
    );
    if (last !== undefined) credits.set(last.id, [...(credits.get(last.id) ?? []), pr]);
  }
  return credits;
}

/** The laps that ran `digest`, by start (a lap not yet started last), then id. */
export function versionLaps(rows: readonly ScorecardRow[], digest: string): Lap[] {
  const laps = new Map<
    string,
    Lap & { routes: string[]; reviews: string[]; lands: string[]; refusals: string[] }
  >();
  const credits = queueMergeCredits(rows);
  for (const row of rows) {
    if (!isRun(row) || row.digest !== digest || !LAP_WORKFLOWS.includes(row.workflow_name))
      continue;
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
      queueMerges: credits.get(row.run_id) ?? [],
    });
  }
  for (const row of rows) {
    if (!isAttempt(row)) continue;
    const lap = laps.get(row.run_id);
    if (lap === undefined) continue;
    lap.cost += row.cost_usd ?? 0;
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

/** Whether `digest` is one of this factory's versions: mc.versions names it, or a lap of it ran. */
export function isVersionOf(rows: readonly ScorecardRow[], digest: string): boolean {
  return (
    rows.some((row) => isVersion(row) && row.digest === digest) ||
    versionLaps(rows, digest).length > 0
  );
}

/**
 * The versions a scorecard opened from another factory's (by the factory switcher) keeps: each of
 * `a` and `b` this factory has (`isVersionOf`), in order, so a kept `b` becomes `a` when `a` is
 * dropped. A version this factory never ran is dropped, never shown as this factory's.
 */
export function keptVersions(
  rows: readonly ScorecardRow[],
  a: string | undefined,
  b: string | undefined,
): { a: string | undefined; b: string | undefined } {
  const [first, second] = [a, b].filter(
    (digest): digest is string => !!digest && isVersionOf(rows, digest),
  );
  return { a: first, b: second === first ? undefined : second };
}

/**
 * The newest version a lap ran, by its first run (mc.versions' `first_run_at`, else its earliest
 * lap's start), for the scorecard to open on when no version is named; null when no lap ran.
 */
export function newestVersionWithLaps(rows: readonly ScorecardRow[]): string | null {
  const firstRun = new Map<string, number>();
  const versioned = new Set<string>();
  for (const row of rows) {
    if (isVersion(row)) {
      versioned.add(row.digest);
      firstRun.set(row.digest, row.first_run_at.getTime());
    }
  }
  const ran = new Set<string>();
  for (const row of rows) {
    if (!isRun(row) || !LAP_WORKFLOWS.includes(row.workflow_name)) continue;
    ran.add(row.digest);
    if (versioned.has(row.digest)) continue;
    const at = row.started_at?.getTime() ?? Number.NEGATIVE_INFINITY;
    firstRun.set(row.digest, Math.min(at, firstRun.get(row.digest) ?? Number.POSITIVE_INFINITY));
  }
  let newest: string | null = null;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const digest of ran) {
    const at = firstRun.get(digest) ?? Number.NEGATIVE_INFINITY;
    if (newest === null || at > newestAt || (at === newestAt && digest > newest)) {
      newest = digest;
      newestAt = at;
    }
  }
  return newest;
}

/** How the version strip labels `digest`: its version's first run and pin, if it is a version. */
export function versionPin(
  rows: readonly ScorecardRow[],
  digest: string,
): { firstRunAt: Date | null; pin: string | null } {
  const version = rows.find((row): row is VersionRow => isVersion(row) && row.digest === digest);
  return { firstRunAt: version?.first_run_at ?? null, pin: version?.pin_sha ?? null };
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
  | 'cost_per_merge';

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

  const merges = count((lap) => lap.lands.includes('merged') || lap.queueMerges.length > 0);
  const hours = activeHours(finished);
  const lapMs = sum(finished.map((lap) => lap.endedAt.getTime() - lap.startedAt.getTime()));
  const checkAppMs = sum(finished.map((lap) => lap.checkAppMs ?? 0));

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
    // No check-app on a finished lap adds 0 to the sum; only no finished lap time is n/a.
    app_check_share: { value: ratio(checkAppMs, lapMs), laps: finishedIds },
    cost_per_merge: { value: ratio(sum(laps.map((lap) => lap.cost)), merges.value), laps: all },
  };
}

/** A measure's value as the screen's `data-value` carries it: the plain number, or `n/a`. */
export function dataValue(value: number | null): string {
  return value === null ? 'n/a' : formatNumber(value);
}

/** `b` minus `a`, or null when either side divides by zero. */
export function difference(a: Measured, b: Measured): number | null {
  return a.value === null || b.value === null ? null : round4(b.value - a.value);
}

/**
 * PRD 4.2: a difference resting on fewer laps than this on either side is not yet meaningful. The
 * rule counts each side's laps, so a time measure that rests on fewer finished laps is labelled
 * like every other measure of the same comparison.
 */
export const MEANINGFUL_LAPS = 10;

/** The label a difference carries until it is meaningful. */
export const NOT_YET_MEANINGFUL = 'not yet meaningful';

export function meaningful(aLaps: number, bLaps: number): boolean {
  return aLaps >= MEANINGFUL_LAPS && bLaps >= MEANINGFUL_LAPS;
}
