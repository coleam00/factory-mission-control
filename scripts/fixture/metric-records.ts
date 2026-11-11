/** One of Archon's SDLC metric records, as `archon-metrics-prs` writes it into `structured_output.metrics`. */
export type MetricRecord = {
  name: string;
  kind: 'count' | 'score';
  unit: string;
  subject: string;
  value: number;
  at: string;
};

const DAY_MS = 86_400_000;
const PR_URL = 'https://github.com/coleam00/factory-mission-control/pull/';
const ROUTES = ['plan', 'deliver'] as const;

/** Issues merged per span of days back from now: 14 in days 0-6, 12 in 7-13, 30 in 14-29, 50 in 30-59. */
const SPANS = [
  { first: 0, count: 14, days: 7 },
  { first: 7, count: 12, days: 7 },
  { first: 14, count: 30, days: 16 },
  { first: 30, count: 50, days: 30 },
] as const;

/** The merge day of issue and PR `n`, in days before now: spans are filled round-robin over their days. */
function dayOf(n: number): number {
  let start = 0;
  for (const span of SPANS) {
    if (n < start + span.count) return span.first + ((n - start) % span.days);
    start += span.count;
  }
  throw new Error(`no merge day for ${n}`);
}

/**
 * The records of one `archon-metrics-prs` run, deterministic and relative to `now`; each `at` is
 * `now - day - 1 minute`, so none is in the future. For each index n of 0..105, merged on dayOf(n):
 *  - issue `#<100 + n>`: sdlc.issues_merged 1, issue_lead_time 4 + 2 * (n % 5) hours, issue_build_rounds
 *    1 + n % 3, issue_asks n % 4, each again under its route: n 0 and 1 `investigate`, else `plan`
 *    for an even n and `deliver` for an odd one;
 *  - the PR `.../pull/<200 + n>`: pr_merge_rate 1 (0 when n % 9 is 8), review_rounds 1 + n % 5,
 *    review_one_round (1 when review_rounds is 1) and review_five_plus_rounds (1 when it is 5 or more);
 *  - only n 0-5 and n 14-18 carry test_lines_added 10 + n and production_lines_added 20 + 2n.
 */
export function metricRecordsFixture(now: Date): MetricRecord[] {
  const records: MetricRecord[] = [];
  const total = SPANS.reduce((sum, span) => sum + span.count, 0);
  for (let n = 0; n < total; n++) {
    const at = new Date(now.getTime() - dayOf(n) * DAY_MS - 60_000).toISOString();
    const issue = `#${100 + n}`;
    const pr = `${PR_URL}${200 + n}`;
    const route = n < 2 ? 'investigate' : ROUTES[n % 2];
    const issueRecords: [string, 'count' | 'score', string, number][] = [
      ['issues_merged', 'count', 'issues', 1],
      ['issue_lead_time', 'score', 'hours', 4 + 2 * (n % 5)],
      ['issue_build_rounds', 'score', 'rounds', 1 + (n % 3)],
      ['issue_asks', 'score', 'asks', n % 4],
    ];
    for (const [measure, kind, unit, value] of issueRecords) {
      for (const name of [`sdlc.${measure}`, `sdlc.${measure}.${route}`]) {
        records.push({ name, kind, unit, subject: issue, value, at });
      }
    }
    const rounds = 1 + (n % 5);
    const prRecords: [string, 'count' | 'score', string, number][] = [
      ['pr_merge_rate', 'score', 'ratio', n % 9 === 8 ? 0 : 1],
      ['review_rounds', 'score', 'rounds', rounds],
      ['review_one_round', 'score', 'ratio', rounds === 1 ? 1 : 0],
      ['review_five_plus_rounds', 'score', 'ratio', rounds >= 5 ? 1 : 0],
    ];
    if (n < 6 || (n >= 14 && n < 19)) {
      prRecords.push(
        ['test_lines_added', 'count', 'lines', 10 + n],
        ['production_lines_added', 'count', 'lines', 20 + 2 * n],
      );
    }
    for (const [measure, kind, unit, value] of prRecords) {
      records.push({ name: `sdlc.${measure}`, kind, unit, subject: pr, value, at });
    }
  }
  return records;
}
