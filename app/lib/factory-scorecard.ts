/** A row of the `factory-scorecard` live query: one metric name, its value and sample size in each window. */
export type FactoryScorecardRow = {
  name: string;
  kind: 'count' | 'score';
  unit: string;
  value_7: number | null;
  n_7: number;
  value_7_before: number | null;
  n_7_before: number;
  value_30: number | null;
  n_30: number;
  value_30_before: number | null;
  n_30_before: number;
};

export type ScorecardWindow = '7' | '30';

/**
 * A comparison resting on fewer records than this on either side is not made: PRD 4.2's threshold for
 * laps, applied to metric records. One number for every measure.
 */
export const TOO_FEW_BELOW = 10;

const DAY_MS = 86_400_000;

/**
 * The UTC date after `now`'s UTC day, as `YYYY-MM-DD`: the `$2` of `factory-scorecard`, which ends its
 * windows at that midnight. The panel and the Manager both pass it, so their numbers agree.
 */
export const scorecardUntil = (now: Date): string =>
  new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS).toISOString().slice(0, 10);

/** Milliseconds from `now` to the next UTC midnight, when `scorecardUntil` moves on. */
export const msToUtcMidnight = (now: Date): number => DAY_MS - (now.getTime() % DAY_MS);

export type MeasureFormat = 'count' | 'percent' | 'whole-percent' | 'decimal' | 'hours';

export type Measure = {
  name: string;
  label: string;
  kind: 'count' | 'score';
  format: MeasureFormat;
  /** Whether Archon also records it per route, as `<name>.<route>`. */
  routes: boolean;
};

export const MEASURES: readonly Measure[] = [
  {
    name: 'sdlc.issues_merged',
    label: 'Issues merged',
    kind: 'count',
    format: 'count',
    routes: true,
  },
  {
    name: 'sdlc.pr_merge_rate',
    label: 'PR merge rate',
    kind: 'score',
    format: 'percent',
    routes: false,
  },
  {
    name: 'sdlc.review_rounds',
    label: 'Review rounds to Ready',
    kind: 'score',
    format: 'decimal',
    routes: false,
  },
  {
    name: 'sdlc.review_one_round',
    label: 'Ready in one round',
    kind: 'score',
    format: 'whole-percent',
    routes: false,
  },
  {
    name: 'sdlc.review_five_plus_rounds',
    label: 'Needing five rounds or more',
    kind: 'score',
    format: 'whole-percent',
    routes: false,
  },
  {
    name: 'sdlc.issue_lead_time',
    label: 'Issue lead time',
    kind: 'score',
    format: 'hours',
    routes: true,
  },
  {
    name: 'sdlc.issue_build_rounds',
    label: 'Build rounds per issue',
    kind: 'score',
    format: 'decimal',
    routes: true,
  },
  {
    name: 'sdlc.issue_asks',
    label: 'Owner asks per issue',
    kind: 'score',
    format: 'decimal',
    routes: true,
  },
  {
    name: 'sdlc.test_lines_added',
    label: 'Test lines added',
    kind: 'count',
    format: 'count',
    routes: false,
  },
  {
    name: 'sdlc.production_lines_added',
    label: 'Production lines added',
    kind: 'count',
    format: 'count',
    routes: false,
  },
];

/** One measure, or one route of it, in one window: both periods, their sample sizes and the change. */
export type Comparison = {
  now: number | null;
  before: number | null;
  nNow: number;
  nBefore: number;
  /** True when either period rests on fewer than TOO_FEW_BELOW records; then there is no change. */
  tooFew: boolean;
  /** `now - before`, null when `tooFew` or when a period has no value. */
  change: number | null;
};

export type ScorecardMeasure = Measure &
  Comparison & { routeRows: (Comparison & { route: string })[] };

function compare(
  row: FactoryScorecardRow | undefined,
  kind: Measure['kind'],
  window: ScorecardWindow,
): Comparison {
  const pick = (value: number | null) => value ?? (kind === 'count' ? 0 : null);
  const now = pick(row ? (window === '7' ? row.value_7 : row.value_30) : null);
  const before = pick(row ? (window === '7' ? row.value_7_before : row.value_30_before) : null);
  const nNow = row ? (window === '7' ? row.n_7 : row.n_30) : 0;
  const nBefore = row ? (window === '7' ? row.n_7_before : row.n_30_before) : 0;
  const tooFew = nNow < TOO_FEW_BELOW || nBefore < TOO_FEW_BELOW;
  return {
    now,
    before,
    nNow,
    nBefore,
    tooFew,
    change: tooFew || now === null || before === null ? null : now - before,
  };
}

/** Each measure in MEASURES order, with the routes Archon recorded for it in either period, by name. */
export function scorecardMeasures(
  rows: readonly FactoryScorecardRow[],
  window: ScorecardWindow,
): ScorecardMeasure[] {
  return MEASURES.map((measure) => {
    const own = rows.find((row) => row.name === measure.name);
    const routeRows = measure.routes
      ? rows
          .filter((row) => row.name.startsWith(`${measure.name}.`))
          .map((row) => ({
            route: row.name.slice(measure.name.length + 1),
            ...compare(row, measure.kind, window),
          }))
          .filter((route) => route.nNow + route.nBefore > 0)
          .sort((a, b) => a.route.localeCompare(b.route))
      : [];
    return { ...measure, ...compare(own, measure.kind, window), routeRows };
  });
}

const fixed = (value: number, digits: number): string => value.toFixed(digits);

/** A period's value in the measure's unit; a score with no records is `-`. */
export function formatValue(format: MeasureFormat, value: number | null): string {
  if (value === null) return '-';
  switch (format) {
    case 'count':
      return String(Math.round(value));
    case 'percent':
      return `${fixed(value * 100, 1)}%`;
    case 'whole-percent':
      return `${fixed(value * 100, 0)}%`;
    case 'decimal':
      return fixed(value, 1);
    case 'hours':
      return `${fixed(value, value < 10 ? 1 : 0)} h`;
  }
}

/** The change, always signed, in the measure's unit: points for a ratio, hours, else a plain number. */
export function formatChange(format: MeasureFormat, change: number): string {
  const [scaled, digits, unit] =
    format === 'percent'
      ? [change * 100, 1, ' pts']
      : format === 'whole-percent'
        ? [change * 100, 0, ' pts']
        : format === 'hours'
          ? [change, 1, ' h']
          : format === 'count'
            ? [change, 0, '']
            : [change, 1, ''];
  const text = fixed(Math.abs(scaled), digits);
  const sign = Number(text) === 0 ? '' : scaled < 0 ? '-' : '+';
  return `${sign}${text}${unit}`;
}
