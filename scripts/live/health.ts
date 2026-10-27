import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAUSES, type Cause } from '../../app/lib/health';
import { openPage, type Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  renewalsOf,
  required,
  screenAgainstSql,
  within,
  writeToScreen,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
} from './timings';

const HEALTH_QUERIES = ['health-runs', 'health-steps', 'health-workable'] as const;
type PerHealthQuery = Record<(typeof HEALTH_QUERIES)[number], number | null>;

/** The step `fixture:write` fails on a running lap: no lap in the seed has run it. */
const FAILED_STEP = 'deploy';
const FAILED_ERROR = 'ECONNRESET';

interface HealthTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  /** The lap `fixture:write step --event node_failed --error ECONNRESET` ran on, and how long infrastructure took to count it. */
  failureToScreen: { run: string; ms: number | null } | null;
  holdSeconds: number;
  renewals: PerHealthQuery;
  afterHoldFailureToScreen: { run: string; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** What the health screen shows, read from the page. */
export interface ShownHealth {
  pending: string[];
  paused: string[];
  /** `<run id> <step id>`, one per overdue step. */
  overdue: string[];
  causes: Record<string, number>;
  workable: number[];
  workableCount: number | null;
  running: number | null;
}

const healthOnScreen = `(() => {
  const all = (selector) => [...document.querySelectorAll(selector)];
  const count = (el) => (el === null ? null : Number(el.getAttribute('data-count')));
  const waiting = (status) =>
    all('[data-live="health-runs"] [data-waiting-run][data-status="' + status + '"]').map((li) =>
      li.getAttribute('data-waiting-run'),
    );
  return {
    pending: waiting('pending'),
    paused: waiting('paused'),
    overdue: all('[data-live="health-steps"] [data-overdue-step]').map(
      (li) => li.getAttribute('data-run') + ' ' + li.getAttribute('data-overdue-step'),
    ),
    causes: Object.fromEntries(
      all('[data-live="health-runs"] [data-cause][data-count]').map((el) => [
        el.getAttribute('data-cause'),
        count(el),
      ]),
    ),
    workable: all('[data-live="health-workable"] [data-workable-issue]').map((li) =>
      Number(li.getAttribute('data-workable-issue')),
    ),
    workableCount: count(document.querySelector('[data-live="health-workable"] [data-tally="workable"]')),
    running: count(document.querySelector('[data-live="health-workable"] [data-tally="running"]')),
  };
})()`;

const causeShown = (cause: Cause) =>
  `document.querySelector('[data-live="health-runs"] [data-cause="${cause}"][data-count]')?.getAttribute('data-count') ?? null`;

/**
 * The health screen's facts, read apart from db/queries/health-*.sql: the PRD's rules in SQL,
 * with the check's clock as $2 where the browser uses its own.
 */
const WAITING_SQL = `SELECT run_id::text AS run, status FROM mc.laps
  WHERE factory = $1 AND status IN ('pending', 'paused') ORDER BY run_id`;

const OVERDUE_SQL = `SELECT r.run_id::text || ' ' || r.step_id AS step,
    r.started_at, p.p90, p.completions
  FROM mc.lap_steps r
  JOIN mc.laps rl ON rl.run_id = r.run_id
  CROSS JOIN LATERAL (
    SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY d.duration_ms) AS p90,
      count(*)::int AS completions
    FROM (
      SELECT ls.duration_ms FROM mc.lap_steps ls JOIN mc.laps l ON l.run_id = ls.run_id
      WHERE l.factory = rl.factory AND l.workflow_name = rl.workflow_name
        AND ls.step_id = r.step_id AND ls.status = 'completed'
        AND ls.duration_ms IS NOT NULL AND ls.completed_at IS NOT NULL
      ORDER BY ls.completed_at DESC, ls.run_id LIMIT 50
    ) d
  ) p
  WHERE rl.factory = $1 AND rl.status = 'running' AND r.status = 'running'
    AND p.p90 IS NOT NULL
    AND $2::timestamptz - r.started_at > 2 * p.p90 * interval '1 millisecond'
  ORDER BY 1`;

const CAUSES_SQL = `SELECT CASE
      WHEN f.error ~* 'usage limit|429' THEN 'usage-limit'
      WHEN f.error ~* '401|unauthor' THEN 'authentication'
      WHEN f.error ~* 'ECONN|ETIMEDOUT|fetch failed' THEN 'infrastructure'
      ELSE 'other' END AS cause,
    count(*)::int AS laps
  FROM mc.laps l
  LEFT JOIN LATERAL (
    SELECT ls.error FROM mc.lap_steps ls WHERE ls.run_id = l.run_id AND ls.status = 'failed'
    ORDER BY ls.completed_at DESC NULLS LAST, ls.step_id LIMIT 1
  ) f ON true
  WHERE l.factory = $1
    AND (l.status = 'failed'
      OR EXISTS (SELECT 1 FROM mc.lap_steps s WHERE s.run_id = l.run_id AND s.status = 'failed'))
  GROUP BY 1`;

const WORKABLE_SQL = `SELECT i.number FROM mc.issues i
  WHERE i.factory = $1 AND i.state = 'open'
    AND i.number NOT IN (SELECT issue_number FROM mc.issue_labels
                          WHERE factory = $1 AND label = 'needs-owner')
    AND i.number NOT IN (SELECT issue_number FROM mc.claims
                          WHERE factory = $1 AND released_at IS NULL)
    AND i.number NOT IN (
      SELECT d.issue_number FROM mc.issue_dependencies d
      LEFT JOIN mc.issues di ON di.factory = d.factory AND di.number = d.depends_on
      WHERE d.factory = $1 AND di.state IS DISTINCT FROM 'closed')
  ORDER BY 1`;

const RUNNING_SQL = `SELECT count(*)::int AS laps FROM mc.laps
  WHERE factory = $1 AND workflow_name = 'archon-loop' AND status = 'running'`;

export interface ExpectedHealth {
  pending: string[];
  paused: string[];
  overdue: string[];
  causes: Record<Cause, number>;
  workable: number[];
  running: number;
}

/** What SQL says the screen should show, at the check's clock `now`. */
async function expectedHealth(
  db: Db,
  factory: string,
  now: Date,
): Promise<{ expected: ExpectedHealth; report: string[] }> {
  const waiting = await db.query(WAITING_SQL, [factory]);
  const overdue = await db.query(OVERDUE_SQL, [factory, now.toISOString()]);
  const causes = await db.query(CAUSES_SQL, [factory]);
  const workable = await db.query(WORKABLE_SQL, [factory]);
  const [running] = await db.query(RUNNING_SQL, [factory]);
  const runsOf = (status: string) =>
    waiting.filter((r) => r.status === status).map((r) => String(r.run));
  const counted = Object.fromEntries(causes.map((r) => [String(r.cause), Number(r.laps)]));
  return {
    expected: {
      pending: runsOf('pending'),
      paused: runsOf('paused'),
      overdue: overdue.map((r) => String(r.step)),
      causes: Object.fromEntries(CAUSES.map((c) => [c, counted[c] ?? 0])) as Record<Cause, number>,
      workable: workable.map((r) => Number(r.number)),
      running: Number(running?.laps),
    },
    report: [
      `SQL at ${now.toISOString()} (mc.laps, mc.lap_steps, mc.issues, mc.issue_labels, mc.issue_dependencies, mc.claims; not the queries in db/queries/):`,
      `  waiting ${JSON.stringify(waiting)}`,
      `  overdue ${JSON.stringify(overdue)}`,
      `  failed laps by cause ${JSON.stringify(causes)}`,
      `  workable ${JSON.stringify(workable.map((r) => r.number))}`,
      `  running laps ${running?.laps}`,
    ],
  };
}

/**
 * Where the screen differs from SQL, and where the seed lacks what the screen must show: one
 * pending and one paused run, an overdue step and a failed lap of every cause.
 */
export function healthMismatches(shown: ShownHealth, expected: ExpectedHealth): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  const sorted = <T>(values: T[]) => [...values].sort();
  same('pending', sorted(shown.pending), expected.pending);
  same('paused', sorted(shown.paused), expected.paused);
  same('overdue steps', sorted(shown.overdue), expected.overdue);
  same('failed laps by cause', shown.causes, expected.causes);
  same('workable issues', shown.workable, expected.workable);
  same('workable count', shown.workableCount, expected.workable.length);
  same('running laps', shown.running, expected.running);
  if (expected.pending.length !== 1)
    mismatches.push('the seed does not have exactly 1 pending run');
  if (expected.paused.length !== 1) mismatches.push('the seed does not have exactly 1 paused run');
  if (expected.overdue.length === 0) mismatches.push('the seed has no overdue step');
  for (const cause of CAUSES) {
    if (expected.causes[cause] === 0) mismatches.push(`the seed has no failed lap of ${cause}`);
  }
  return mismatches;
}

/**
 * Fails FAILED_STEP on `run` with FAILED_ERROR and times it from the write's exit to the
 * infrastructure count rising by one.
 */
async function failureToScreen(
  page: Page,
  run: string,
  ctx: LiveContext,
): Promise<{ run: string; ms: number | null }> {
  const before = await page.evaluate<string | null>(causeShown('infrastructure'));
  if (before === null) throw new Error('the health screen shows no infrastructure count');
  const ms = await writeToScreen(
    page,
    ctx.deps,
    [
      'step',
      '--run',
      run,
      '--step',
      FAILED_STEP,
      '--event',
      'node_failed',
      '--error',
      FAILED_ERROR,
    ],
    `(${causeShown('infrastructure')}) === '${Number(before) + 1}'`,
  );
  return { run, ms };
}

/**
 * The health screen: every number against SQL over the seed, and a failed step on each running lap
 * timed to its cause before and after the hold.
 */
export function healthPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const timings: HealthTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(HEALTH_QUERIES),
    failureToScreen: null,
    holdSeconds,
    renewals: { 'health-runs': null, 'health-steps': null, 'health-workable': null },
    afterHoldFailureToScreen: null,
    noReload: null,
    limits: LIMITS,
  };
  const failed: string[] = [];
  let healthPage: Page | undefined;
  const url = () => `${ctx.base}/f/${encodeURIComponent(factory)}/health`;

  return {
    /** On the untouched seed. */
    async open() {
      const page = await openPage(deps.env);
      healthPage = page;
      await page.goto(url());
      await page.evaluate('window.__mcNoReload = true');
      const ready = await page.evaluate<boolean>(
        pageWait(
          HEALTH_QUERIES.map(
            (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
          ).join(' && '),
          READY_WAIT_MS,
        ),
      );
      if (!ready) {
        throw new Error(
          `the health screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(timings, groupTimings(await measure(page, HEALTH_QUERIES)));
      const shown = await page.evaluate<ShownHealth>(healthOnScreen);
      const { expected, report } = await expectedHealth(db, factory, new Date());
      const mismatches = healthMismatches(shown, expected);
      writeFileSync(
        join(outDir, 'health-check.txt'),
        [
          `screen: ${JSON.stringify(shown)}`,
          ...report,
          ...mismatches,
          `mismatches: ${mismatches.length}`,
          '',
        ].join('\n'),
      );
      ctx.failures.push(...mismatches.map((m) => `health screen against the seed: ${m}`));
      writeFileSync(join(outDir, 'health.png'), await page.screenshot(1440));
    },

    async write() {
      const [, secondLap] = ctx.laps;
      failed.push(secondLap);
      timings.failureToScreen = await failureToScreen(
        required(healthPage, 'health page'),
        secondLap,
        ctx,
      );
      deps.out(`first failed step reached health in ${timings.failureToScreen.ms ?? 'never'} ms`);
    },

    async afterHold() {
      const page = required(healthPage, 'health page');
      for (const q of HEALTH_QUERIES)
        timings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      const [firstLap] = ctx.laps;
      failed.push(firstLap);
      timings.afterHoldFailureToScreen = await failureToScreen(page, firstLap, ctx);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      healthPage = undefined;
    },

    async probe(designProbe) {
      designProbe(url(), 'health-design-probe.json', 'the health screen');
    },

    async close() {
      timings.port = ctx.port;
      writeFileSync(join(outDir, 'health-timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
      await healthPage?.close().catch(() => undefined);
    },

    async cleanup() {
      if (failed.length === 0) return [];
      try {
        const runs = `{${failed.join(',')}}`;
        await db.query(
          `DELETE FROM remote_agent_workflow_events
           WHERE workflow_run_id = ANY($1::uuid[]) AND step_name = $2 AND event_type = 'node_failed'`,
          [runs, FAILED_STEP],
        );
        await db.query('DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[]) AND step_id = $2', [
          runs,
          FAILED_STEP,
        ]);
        return [];
      } catch (err) {
        return [`removing the health screen's failed steps failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      if (!within(timings.readyMs, LIMITS.readyMs)) {
        failures.push(`health screen ready after ${timings.readyMs} ms, limit ${LIMITS.readyMs}`);
      }
      failures.push(...groupPerformanceFailures(HEALTH_QUERIES, timings));
      for (const [when, write] of [
        ['first', timings.failureToScreen],
        [`after ${holdSeconds}s`, timings.afterHoldFailureToScreen],
      ] as const) {
        failures.push(...lateWrite(`${FAILED_ERROR} ${when}`, 'its cause', write?.ms));
      }
      if (holdSeconds >= 180) {
        for (const q of HEALTH_QUERIES) {
          if ((timings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
            failures.push(
              `${timings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
            );
          }
        }
      }
      if (timings.noReload !== true) failures.push('the health screen reloaded');
      return failures;
    },

    summary: () => [`health: ${JSON.stringify(timings)}`],
  };
}
