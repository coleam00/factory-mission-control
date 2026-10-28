import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTCOME_TOKEN, OUTCOMES } from '../../app/lib/laps';
import { seedLaps } from '../fixture/seed-laps';
import { openPage, type Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  LANE,
  LIMITS,
  LIVE_STEP,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  renewalsOf,
  required,
  screenAgainstSql,
  untilShown,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

const LAPS_QUERIES = ['lanes', 'recent-laps'] as const;
const RECENT_LAP = '[data-live="recent-laps"] [data-recent-lap]';
/** The lane names the step, and its row of loop steps pulses that step's top-level mark. */
const laneOn = (runId: string, step: string) => {
  const lane = `[data-live="lanes"] [data-lane="${runId}"]`;
  const top = step.split('__')[0];
  const mark = top === 'build' || top === 'ship' ? 'build/ship' : top;
  return `document.querySelector('${lane}')?.getAttribute('data-step') === '${step}' && document.querySelector('${lane} [data-loop-mark="${mark}"]')?.getAttribute('data-step-state') === 'running'`;
};

type PerLapsQuery = Record<(typeof LAPS_QUERIES)[number], number | null>;

interface LapsTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  /** The lap `fixture:write step --step review --event node_started` ran on, and its lane's time. */
  stepToLane: { run: string; ms: number | null } | null;
  holdSeconds: number;
  renewals: PerLapsQuery;
  afterHoldStepToLane: { run: string; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface LapsOnScreen {
  lanes: {
    run: string;
    issue: number | null;
    route: string | null;
    depth: string | null;
    step: string | null;
    cost: number;
    /** The marks of the lane's row of loop steps that pulse. */
    runningMarks: string[];
  }[];
  recent: {
    run: string;
    outcome: string | null;
    cost: number;
    dot: string;
    token: string | null;
  }[];
}

const lapsOnScreen = `(() => {
  const tokens = ${JSON.stringify(OUTCOME_TOKEN)};
  const token = (name) => {
    if (name === undefined) return null;
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.backgroundColor = 'var(' + name + ')';
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  };
  const num = (el, name) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
  return {
    lanes: [...document.querySelectorAll('${LANE}')].map((li) => ({
      run: li.getAttribute('data-lane'),
      issue: num(li, 'data-issue'),
      route: li.getAttribute('data-route'),
      depth: li.getAttribute('data-depth'),
      step: li.getAttribute('data-step'),
      cost: Number(li.getAttribute('data-cost')),
      runningMarks: [...li.querySelectorAll('[data-loop-mark][data-step-state="running"]')].map(
        (m) => m.getAttribute('data-loop-mark'),
      ),
    })),
    recent: [...document.querySelectorAll('${RECENT_LAP}')].map((li) => ({
      run: li.getAttribute('data-recent-lap'),
      outcome: li.getAttribute('data-outcome'),
      cost: Number(li.getAttribute('data-cost')),
      dot: getComputedStyle(li.querySelector('[data-outcome-dot]')).backgroundColor,
      token: token(tokens[li.getAttribute('data-outcome')]),
    })),
  };
})()`;

/**
 * The laps screen against SQL over the seed's tables (not the screen's queries) and against the
 * seed's own account of each lap, read before any lap is inserted or step written.
 */
async function seedLapsMismatches(
  page: Page,
  db: Db,
  factory: string,
  seed: string,
): Promise<{ mismatches: string[]; report: string }> {
  const shown = await page.evaluate<LapsOnScreen>(lapsOnScreen);
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  const byRun = <T extends { run: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => a.run.localeCompare(b.run));

  const running = await db.query(
    `SELECT l.run_id::text AS run,
       (SELECT c.issue_number FROM mc.claims c
         WHERE c.factory = l.factory AND c.run_id = l.run_id AND c.released_at IS NULL) AS issue,
       pick.output ->> 'route' AS route,
       pick.output ->> 'depth' AS depth,
       (SELECT s.step_id FROM mc.lap_steps s WHERE s.run_id = l.run_id AND s.status = 'running') AS step,
       (SELECT coalesce(sum(s.cost_usd), 0)::float8 FROM mc.lap_steps s WHERE s.run_id = l.run_id) AS cost
     FROM mc.laps l
     LEFT JOIN mc.lap_steps pick ON pick.run_id = l.run_id AND pick.step_id = 'pick'
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND l.status = 'running'
     ORDER BY 1`,
    [factory],
  );
  const markOf = (step: string) => {
    const top = step.split('__')[0];
    return top === 'build' || top === 'ship' ? 'build/ship' : top;
  };
  const lanesSql = running.map((r) => ({
    run: String(r.run),
    issue: r.issue === null ? null : Number(r.issue),
    route: r.route,
    depth: r.depth,
    step: r.step,
    cost: Number(r.cost),
    runningMarks: r.step === null ? [] : [markOf(String(r.step))],
  }));
  if (lanesSql.length !== 2) mismatches.push(`the seed has ${lanesSql.length} running laps, not 2`);
  same('lanes', byRun(shown.lanes), lanesSql);

  const laps = seedLaps(seed);
  const seedRunning = laps
    .filter((l) => l.what === 'running')
    .map((l) => ({ run: l.runId, issue: l.issue }));
  same(
    'lanes against the seed',
    byRun(shown.lanes.map((l) => ({ run: l.run, issue: l.issue }))),
    byRun(seedRunning),
  );

  const finished = await db.query(
    `SELECT l.run_id::text AS run,
       (SELECT coalesce(sum(s.cost_usd), 0)::float8 FROM mc.lap_steps s WHERE s.run_id = l.run_id) AS cost
     FROM mc.laps l
     WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
       AND l.status IN ('completed', 'failed', 'cancelled')
     ORDER BY 1`,
    [factory],
  );
  const finishedSql = finished.map((r) => ({ run: String(r.run), cost: Number(r.cost) }));
  same(
    'finished laps and their cost',
    byRun(shown.recent.map((l) => ({ run: l.run, cost: l.cost }))),
    finishedSql,
  );
  const seedFinished = laps.filter((l) => !['running', 'paused', 'pending'].includes(l.what));
  same(
    'outcomes against the seed',
    byRun(shown.recent.map((l) => ({ run: l.run, outcome: l.outcome }))),
    byRun(seedFinished.map((l) => ({ run: l.runId, outcome: l.what }))),
  );
  for (const outcome of OUTCOMES) {
    if (!shown.recent.some((l) => l.outcome === outcome)) {
      mismatches.push(`no finished lap shows ${outcome}`);
    }
  }
  for (const lap of shown.recent) {
    if (lap.token === null || lap.dot !== lap.token) {
      mismatches.push(`${lap.run} ${lap.outcome} is colored ${lap.dot}, its token is ${lap.token}`);
    }
  }

  const tally = Object.fromEntries(
    OUTCOMES.map((o) => [o, shown.recent.filter((l) => l.outcome === o).length]),
  );
  const report = [
    'screen:',
    `  lanes ${JSON.stringify(byRun(shown.lanes))}`,
    `  recent ${JSON.stringify(byRun(shown.recent))}`,
    'SQL (mc.laps, mc.claims, mc.lap_steps; not the queries in db/queries/):',
    `  lanes ${JSON.stringify(lanesSql)}`,
    `  finished ${JSON.stringify(finishedSql)}`,
    'seed (fixtures/seed.sql, the comment above each run):',
    `  running ${JSON.stringify(byRun(seedRunning))}`,
    `  finished ${JSON.stringify(seedFinished.map((l) => ({ run: l.runId, label: l.label, outcome: l.what })))}`,
    `outcomes on screen: ${JSON.stringify(tally)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

/** The laps screen: the seed's lanes and finished laps, and the lap step events to their lanes. */
export function lapsPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const lapsTimings: LapsTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(LAPS_QUERIES),
    stepToLane: null,
    holdSeconds,
    renewals: { lanes: null, 'recent-laps': null },
    afterHoldStepToLane: null,
    noReload: null,
    limits: LIMITS,
  };
  let lapsPage: Page | undefined;

  return {
    // The laps screen opens before the strip inserts its laps, so its lanes are the seed's two.
    async open() {
      const { base } = ctx;
      const [firstLap, secondLap] = ctx.laps;
      const page = await openPage(deps.env);
      lapsPage = page;
      await page.goto(`${base}/f/${factory}/laps`);
      await page.evaluate('window.__mcNoReload = true');
      const lapsReady = await page.evaluate<boolean>(
        pageWait(
          LAPS_QUERIES.map(
            (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
          ).join(' && '),
          READY_WAIT_MS,
        ),
      );
      if (!lapsReady) {
        throw new Error(
          `the laps screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(lapsTimings, groupTimings(await measure(page, LAPS_QUERIES)));
      const lapsSeed = await seedLapsMismatches(
        page,
        db,
        factory,
        readFileSync(join(deps.repoRoot, 'fixtures', 'seed.sql'), 'utf-8'),
      );
      writeFileSync(join(outDir, 'lanes-check.txt'), `${lapsSeed.report}\n`);
      ctx.failures.push(...lapsSeed.mismatches.map((m) => `laps screen against the seed: ${m}`));
      writeFileSync(join(outDir, 'lanes-recent-laps.png'), await page.screenshot(1440));
      for (const lap of [firstLap, secondLap]) {
        if (await page.evaluate<boolean>(laneOn(lap, LIVE_STEP))) {
          throw new Error(`the lane of ${lap} is on ${LIVE_STEP} before any write`);
        }
      }
    },

    async onLapStep(run, afterHold) {
      const ms = await untilShown(required(lapsPage, 'laps page'), laneOn(run, LIVE_STEP));
      if (afterHold) {
        lapsTimings.afterHoldStepToLane = { run, ms };
        return;
      }
      lapsTimings.stepToLane = { run, ms };
      deps.out(`first step event reached its lane in ${ms ?? 'never'} ms`);
    },

    async beforeLapStep(afterHold) {
      if (!afterHold) return;
      const page = required(lapsPage, 'laps page');
      for (const q of LAPS_QUERIES) {
        lapsTimings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      }
    },

    async writeAgain() {
      const page = required(lapsPage, 'laps page');
      lapsTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      lapsPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(
        `${base}/f/${factory}/laps`,
        'lanes-recent-laps-design-probe.json',
        'the laps screen',
      );
    },

    async close() {
      lapsTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'lanes-recent-laps-timings.json'),
        `${JSON.stringify(lapsTimings, null, 2)}\n`,
      );
      await lapsPage?.close().catch(() => undefined);
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('laps screen', lapsTimings, LIMITS.readyMs));
      for (const q of LAPS_QUERIES) {
        failures.push(...groupPerformanceFailures([q], lapsTimings));
        if (holdSeconds >= 180 && (lapsTimings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
          failures.push(
            `${lapsTimings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
          );
        }
      }
      for (const [when, write] of [
        ['first', lapsTimings.stepToLane],
        [`after ${holdSeconds}s`, lapsTimings.afterHoldStepToLane],
      ] as const) {
        failures.push(...lateWrite(`${LIVE_STEP} ${when}`, 'its lane', write?.ms));
      }
      if (lapsTimings.noReload !== true) failures.push('the laps screen reloaded');
      return failures;
    },

    summary: () => [`laps: ${JSON.stringify(lapsTimings)}`],
  };
}
