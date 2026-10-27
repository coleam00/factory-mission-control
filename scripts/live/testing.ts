import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER } from '../fixture/seed-report';
import { structuredOutputFor } from '../fixture/write';
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
  writeToScreen,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

const TESTING_QUERIES = ['testing-routes', 'testing-app-check', 'testing-holdouts'] as const;
const CHECK_MIX = '[data-live="testing-app-check"] [data-check-mix]';

interface TestingTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  /** The pre-hold `fixture:write step --step check-app --event node_completed` to its counts. */
  checkToScreen: { run: string; ms: number | null } | null;
  holdSeconds: number;
  renewals: Record<(typeof TESTING_QUERIES)[number], number | null>;
  /** The same write on a second lap after the hold. */
  afterHoldCheckToScreen: { run: string; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface Counted {
  count: number | null;
  listed: number;
}

interface TestingOnScreen {
  routes: ({ route: string | null; depth: string | null } & Counted)[];
  checks: ({ kind: string | null; verdict: string | null } & Counted)[];
  prHoldouts: ({ scenario: string | null; verdict: string | null } & Counted)[];
  defaultHoldouts: { scenario: string | null; verdict: string | null; issue: number | null }[];
  failing: { scenario: string | null; issue: number | null }[];
  /** Every `data-scenario` on the page. */
  scenarios: (string | null)[];
  /** How many times the seed's holdout text marker occurs in the rendered page. */
  markers: number;
}

const testingOnScreen = `(() => {
  const attr = (el, name) => el.getAttribute(name);
  const num = (el, name) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
  const all = (q, sel) => [...document.querySelectorAll('[data-live="' + q + '"] ' + sel)];
  const counted = (li) => ({ count: num(li, 'data-count'), listed: li.querySelectorAll('[data-lap]').length });
  return {
    routes: all('testing-routes', '[data-route-mix]').map((li) => ({
      route: attr(li, 'data-route'), depth: attr(li, 'data-depth'), ...counted(li),
    })),
    checks: all('testing-app-check', '[data-check-mix]').map((li) => ({
      kind: attr(li, 'data-kind'), verdict: attr(li, 'data-verdict'), ...counted(li),
    })),
    prHoldouts: all('testing-app-check', '[data-pr-holdout]').map((li) => ({
      scenario: attr(li, 'data-scenario'), verdict: attr(li, 'data-verdict'), ...counted(li),
    })),
    defaultHoldouts: all('testing-holdouts', '[data-default-holdout]').map((li) => ({
      scenario: attr(li, 'data-scenario'), verdict: attr(li, 'data-verdict'), issue: num(li, 'data-issue'),
    })),
    failing: all('testing-holdouts', '[data-failing]').map((li) => ({
      scenario: attr(li, 'data-scenario'), issue: num(li, 'data-issue'),
    })),
    scenarios: [...document.querySelectorAll('[data-scenario]')].map((el) => attr(el, 'data-scenario')),
    markers: document.documentElement.outerHTML.split(${JSON.stringify(MARKER)}).length - 1,
  };
})()`;

/** Rows in one order whatever order the screen or SQL gave them. */
const sorted = <T>(rows: readonly T[]) =>
  [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * The testing screen against SQL over the seed's tables, not the screen's queries: each count by
 * route and depth, kind and verdict, and holdout scenario and verdict; the newest holdouts line's
 * verdicts and its failing scenarios with their issues; and no holdout text anywhere on the page.
 */
export async function seedTestingMismatches(
  page: Page,
  db: Db,
  factory: string,
): Promise<{ mismatches: string[]; report: string }> {
  const shown = await page.evaluate<TestingOnScreen>(testingOnScreen);
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  const n = (value: unknown) => (value === null ? null : Number(value));

  const routes = await db.query(
    `SELECT coalesce(coalesce(pick.output ->> 'route', (
         SELECT c.route FROM mc.claims c WHERE c.factory = l.factory AND c.run_id = l.run_id
         ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1)), '') AS route,
       coalesce(pick.output ->> 'depth', '') AS depth, count(*)::int AS count
     FROM mc.laps l
     LEFT JOIN mc.lap_steps pick ON pick.run_id = l.run_id AND pick.step_id = 'pick'
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
     GROUP BY 1, 2`,
    [factory],
  );
  const checks = await db.query(
    `SELECT a.kind, a.verdict, count(*)::int AS count
     FROM mc.app_check_lines a JOIN mc.laps l ON l.run_id = a.run_id
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
     GROUP BY 1, 2`,
    [factory],
  );
  const prHoldouts = await db.query(
    `SELECT a.scenario_id, a.verdict, count(*)::int AS count
     FROM mc.app_check_lines a JOIN mc.laps l ON l.run_id = a.run_id
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND a.kind = 'holdout'
     GROUP BY 1, 2`,
    [factory],
  );
  const verdicts = await db.query(
    `SELECT v.scenario_id, v.verdict, v.issue_number FROM mc.holdout_verdicts v
     WHERE v.report_id = (SELECT r.id FROM mc.holdout_reports r WHERE r.factory = $1
                           ORDER BY r.at DESC LIMIT 1)`,
    [factory],
  );

  const sql = {
    routes: sorted(routes.map((r) => ({ route: r.route, depth: r.depth, count: n(r.count) }))),
    checks: sorted(checks.map((r) => ({ kind: r.kind, verdict: r.verdict, count: n(r.count) }))),
    prHoldouts: sorted(
      prHoldouts.map((r) => ({ scenario: r.scenario_id, verdict: r.verdict, count: n(r.count) })),
    ),
    defaultHoldouts: sorted(
      verdicts.map((r) => ({
        scenario: r.scenario_id,
        verdict: r.verdict,
        issue: n(r.issue_number),
      })),
    ),
    failing: sorted(
      verdicts
        .filter((r) => r.verdict === 'FAIL')
        .map((r) => ({ scenario: r.scenario_id, issue: n(r.issue_number) })),
    ),
  };
  const counts = <T extends Counted>(rows: readonly T[]) =>
    sorted(rows.map(({ listed: _, ...row }) => row));
  const screen = {
    routes: counts(shown.routes),
    checks: counts(shown.checks),
    prHoldouts: counts(shown.prHoldouts),
    defaultHoldouts: sorted(shown.defaultHoldouts),
    failing: sorted(shown.failing),
  };
  for (const key of Object.keys(sql) as (keyof typeof sql)[]) {
    same(`the ${key}`, screen[key], sql[key]);
  }
  for (const row of [...shown.routes, ...shown.checks, ...shown.prHoldouts]) {
    if (row.count !== row.listed) {
      mismatches.push(`${JSON.stringify(row)}: data-count ${row.count}, lists ${row.listed}`);
    }
  }
  for (const id of shown.scenarios) {
    if (!/^(H-\d{2,}|unidentified)$/.test(id ?? '')) {
      mismatches.push(`a data-scenario reads ${JSON.stringify(id)}, not H-<nn> or unidentified`);
    }
  }
  if (shown.markers !== 0) mismatches.push(`${MARKER} occurs ${shown.markers} times on the page`);
  if (!shown.failing.some((f) => f.issue !== null)) {
    mismatches.push('no scenario failing on the default branch shows its tracking issue');
  }

  const report = [
    `factory ${factory}`,
    'screen:',
    ...Object.entries(screen).map(([key, rows]) => `  ${key} ${JSON.stringify(rows)}`),
    `  ${MARKER} occurrences ${shown.markers}`,
    'SQL (mc.laps, mc.lap_steps, mc.claims, mc.app_check_lines, mc.holdout_reports,',
    'mc.holdout_verdicts; not the queries in db/queries/):',
    ...Object.entries(sql).map(([key, rows]) => `  ${key} ${JSON.stringify(rows)}`),
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

/** The lines one `fixture:write step --step check-app` adds, by kind and verdict. */
export function checkAppRise(): Map<string, number> {
  const output = structuredOutputFor('check-app') as { lines: { kind: string; verdict: string }[] };
  const rise = new Map<string, number>();
  for (const { kind, verdict } of output.lines) {
    const key = JSON.stringify([kind, verdict.toUpperCase()]);
    rise.set(key, (rise.get(key) ?? 0) + 1);
  }
  return rise;
}

const checkCountsOnScreen = `Object.fromEntries([...document.querySelectorAll('${CHECK_MIX}')].map((li) => [
  JSON.stringify([li.getAttribute('data-kind'), li.getAttribute('data-verdict')]),
  Number(li.getAttribute('data-count')),
]))`;

/** Each kind and verdict the write adds to reads its count before the write plus its lines. */
function risen(before: Record<string, number>): string {
  return [...checkAppRise()]
    .map(([key, by]) => {
      const [kind, verdict] = JSON.parse(key) as [string, string];
      const target = (before[key] ?? 0) + by;
      return `document.querySelector('${CHECK_MIX}[data-kind="${kind}"][data-verdict="${verdict}"]')?.getAttribute('data-count') === '${target}'`;
    })
    .join(' && ');
}

/**
 * The testing screen: against SQL over the seed, with no holdout text, then one check-app report
 * written on a lap with none, timed to its kind and verdict counts before the hold and on a
 * second such lap after it. A second report on the same lap would replace the first's lines.
 */
export function testingPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const timings: TestingTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(TESTING_QUERIES),
    checkToScreen: null,
    holdSeconds,
    renewals: { 'testing-routes': null, 'testing-app-check': null, 'testing-holdouts': null },
    afterHoldCheckToScreen: null,
    noReload: null,
    limits: LIMITS,
  };
  let testingPage: Page | undefined;
  let targets: string[] = [];
  const written: string[] = [];

  const checkToScreen = async (page: Page, run: string) => {
    const before = await page.evaluate<Record<string, number>>(checkCountsOnScreen);
    written.push(run);
    const args = ['step', '--run', run, '--step', 'check-app', '--event', 'node_completed'];
    return { run, ms: await writeToScreen(page, deps, args, risen(before)) };
  };

  return {
    async open() {
      const { base } = ctx;
      targets = (
        await db.query(
          `SELECT l.run_id::text AS run FROM mc.laps l
           WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status <> 'running'
             AND NOT EXISTS (SELECT 1 FROM mc.lap_steps s
                              WHERE s.run_id = l.run_id AND s.step_id = 'check-app')
           ORDER BY l.run_id LIMIT 2`,
          [factory],
        )
      ).map((r) => String(r.run));
      if (targets.length < 2) {
        throw new Error(`the check branch has ${targets.length} laps with no app check, not 2`);
      }
      const page = await openPage(deps.env);
      testingPage = page;
      await page.goto(`${base}/f/${factory}/testing`);
      await page.evaluate('window.__mcNoReload = true');
      const ready = await page.evaluate<boolean>(
        pageWait(
          TESTING_QUERIES.map(
            (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
          ).join(' && '),
          READY_WAIT_MS,
        ),
      );
      if (!ready) {
        throw new Error(
          `the testing screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(timings, groupTimings(await measure(page, TESTING_QUERIES)));
      const seed = await seedTestingMismatches(page, db, factory);
      writeFileSync(join(outDir, 'testing-check.txt'), `${seed.report}\n`);
      ctx.failures.push(...seed.mismatches.map((m) => `testing against the seed: ${m}`));
      writeFileSync(join(outDir, 'testing-panel.png'), await page.screenshot(1440));
    },

    async write() {
      timings.checkToScreen = await checkToScreen(
        required(testingPage, 'testing page'),
        targets[0],
      );
      deps.out(
        `first app check reached the testing screen in ${timings.checkToScreen.ms ?? 'never'} ms`,
      );
    },

    async writeAgain() {
      const page = required(testingPage, 'testing page');
      for (const q of TESTING_QUERIES)
        timings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      timings.afterHoldCheckToScreen = await checkToScreen(page, targets[1]);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      testingPage = undefined;
    },

    async probe(designProbe) {
      designProbe(
        `${ctx.base}/f/${factory}/testing`,
        'testing-panel-design-probe.json',
        'the testing screen',
      );
    },

    async close() {
      timings.port = ctx.port;
      writeFileSync(
        join(outDir, 'testing-panel-timings.json'),
        `${JSON.stringify(timings, null, 2)}\n`,
      );
      await testingPage?.close().catch(() => undefined);
    },

    async cleanup() {
      if (written.length === 0) return [];
      const runs = `{${written.join(',')}}`;
      try {
        // The laps had no check-app step before the writes, so every check-app row on them is theirs.
        await db.transaction(async (tx) => {
          await tx.query(
            `DELETE FROM remote_agent_workflow_events
             WHERE workflow_run_id = ANY($1::uuid[]) AND step_name = 'check-app'`,
            [runs],
          );
          await tx.query('DELETE FROM mc.app_check_lines WHERE run_id = ANY($1::uuid[])', [runs]);
          await tx.query(
            `DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[]) AND step_id = 'check-app'`,
            [runs],
          );
        });
        return [];
      } catch (err) {
        return [`restoring the app-checked laps failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('testing screen', timings, LIMITS.readyMs));
      for (const q of TESTING_QUERIES) {
        failures.push(...groupPerformanceFailures([q], timings));
        if (holdSeconds >= 180 && (timings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
          failures.push(
            `${timings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
          );
        }
      }
      for (const [when, write] of [
        ['first', timings.checkToScreen],
        [`after ${holdSeconds}s`, timings.afterHoldCheckToScreen],
      ] as const) {
        failures.push(...lateWrite(`check-app ${when}`, 'the testing screen', write?.ms));
      }
      if (timings.noReload !== true) failures.push('the testing screen reloaded');
      return failures;
    },

    summary: () => [`testing: ${JSON.stringify(timings)}`],
  };
}
