/**
 * How each change in a factory was checked, from the testing screen's three queries: every lap's
 * route and depth, every app-check line, and the newest default-branch `holdouts at` line. The
 * queries return rows; the counts are made here, each with the laps or lines it was made from
 * (PRD invariant 4). Holdouts are scenario ids and verdicts only. Pure, no React.
 */
import { prNumber } from './one-lap';

/** A row of `db/queries/testing-routes.sql`: one per lap. */
export interface RouteRow {
  run_id: string;
  status: string;
  started_at: Date | null;
  /** Null while the lap has not been picked and its claim records no route. */
  route: string | null;
  depth: string | null;
}

/** A row of `db/queries/testing-app-check.sql`: one per app-check line of a lap. */
export interface CheckRow {
  run_id: string;
  position: number;
  kind: string;
  verdict: string;
  /** `H-<nn>` or `unidentified` on a holdout line, null on every other kind. */
  scenario_id: string | null;
  started_at: Date | null;
  /** The pull request the check ran on, as the check-app step wrote it. */
  pr: string | null;
}

/** A row of `db/queries/testing-holdouts.sql`: one verdict of the newest `holdouts at` line. */
export interface DefaultHoldoutRow {
  at: Date;
  sha: string;
  report_issue: number;
  scenario_id: string;
  verdict: string;
  /** The tracking issue the line names for this scenario, if any. */
  issue_number: number | null;
  issue_title: string | null;
  issue_state: string | null;
  issue_url: string | null;
  /** The factory's `owner/name`, for a tracking issue not mirrored yet. */
  repository: string;
}

export interface RouteGroup {
  route: string | null;
  depth: string | null;
  /** Run ids, newest lap first. */
  laps: readonly string[];
}

/** One app-check line, by the lap it is in and the pull request it was checked on. */
export interface Line {
  run: string;
  position: number;
  pr: number | null;
}

export interface CheckGroup {
  kind: string;
  verdict: string;
  /** Newest lap first, then by position. */
  lines: readonly Line[];
}

export interface ScenarioGroup {
  scenario: string;
  verdict: string;
  lines: readonly Line[];
}

export interface DefaultBranch {
  at: Date;
  sha: string;
  issue: number;
  /** Every verdict of the line, in scenario order. */
  verdicts: readonly DefaultHoldoutRow[];
  failing: readonly DefaultHoldoutRow[];
}

const KIND_ORDER = ['criterion', 'holdout', 'probe', 'defect'];

const newestFirst = (
  a: { started_at: Date | null; run_id: string },
  b: { started_at: Date | null; run_id: string },
) =>
  (b.started_at?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (a.started_at?.getTime() ?? Number.NEGATIVE_INFINITY) || a.run_id.localeCompare(b.run_id);

/** `H-<nn>` in numeric order, `unidentified` after them. */
const scenarioOrder = (a: string, b: string) => {
  const n = (id: string) => (id.startsWith('H-') ? Number(id.slice(2)) : Number.POSITIVE_INFINITY);
  return n(a) - n(b) || a.localeCompare(b);
};

const kindOrder = (kind: string) => {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
};

function groupBy<Row, Key extends string>(rows: readonly Row[], key: (row: Row) => Key) {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return [...groups.values()];
}

const lineOf = (row: CheckRow): Line => ({
  run: row.run_id,
  position: row.position,
  pr: prNumber(row.pr),
});

const linesInOrder = (rows: readonly CheckRow[]) =>
  [...rows].sort((a, b) => newestFirst(a, b) || a.position - b.position).map(lineOf);

/** Every lap by its route and depth, the largest group first. */
export function routeMix(rows: readonly RouteRow[]): RouteGroup[] {
  return groupBy(rows, (r) => JSON.stringify([r.route, r.depth]))
    .map((group) => ({
      route: group[0].route,
      depth: group[0].depth,
      laps: [...group].sort(newestFirst).map((r) => r.run_id),
    }))
    .sort(
      (a, b) =>
        b.laps.length - a.laps.length ||
        (a.route ?? '￿').localeCompare(b.route ?? '￿') ||
        (a.depth ?? '￿').localeCompare(b.depth ?? '￿'),
    );
}

/** Every app-check line by its kind and verdict: criterion, holdout, probe, then defect. */
export function checkMix(rows: readonly CheckRow[]): CheckGroup[] {
  return groupBy(rows, (r) => `${r.kind} ${r.verdict}`)
    .map((group) => ({
      kind: group[0].kind,
      verdict: group[0].verdict,
      lines: linesInOrder(group),
    }))
    .sort(
      (a, b) =>
        kindOrder(a.kind) - kindOrder(b.kind) ||
        a.kind.localeCompare(b.kind) ||
        a.verdict.localeCompare(b.verdict),
    );
}

/** The holdout lines app checks reported at pull-request time, by scenario id, then verdict. */
export function prHoldouts(rows: readonly CheckRow[]): ScenarioGroup[] {
  return groupBy(
    rows.filter(
      (r): r is CheckRow & { scenario_id: string } =>
        r.kind === 'holdout' && r.scenario_id !== null,
    ),
    (r) => `${r.scenario_id} ${r.verdict}`,
  )
    .map((group) => ({
      scenario: group[0].scenario_id,
      verdict: group[0].verdict,
      lines: linesInOrder(group),
    }))
    .sort((a, b) => scenarioOrder(a.scenario, b.scenario) || a.verdict.localeCompare(b.verdict));
}

/** The default branch's newest `holdouts at` line, or null before the manager has written one. */
export function defaultBranch(rows: readonly DefaultHoldoutRow[]): DefaultBranch | null {
  const [first] = rows;
  if (first === undefined) return null;
  const verdicts = [...rows].sort((a, b) => scenarioOrder(a.scenario_id, b.scenario_id));
  return {
    at: first.at,
    sha: first.sha,
    issue: first.report_issue,
    verdicts,
    failing: verdicts.filter((v) => v.verdict === 'FAIL'),
  };
}
