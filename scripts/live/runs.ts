import { RUN_CHIPS, RUNS_PAGE_SIZE, runsArgs } from '../../app/lib/runs';
import { RUN_STATE, type State, stateOf } from '../../app/lib/states';
import { openPage, type Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  LIMITS,
  LIVE_STEP,
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  lateWrite,
  liveOutputs,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  RUN_ROW,
  renewalsOf,
  required,
  screenAgainstSql,
  settleAt,
  untilShown,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

const RUNS_QUERIES = ['runs'] as const;
const RUNS_READY = RUNS_QUERIES.map(
  (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
).join(' && ');
const PANEL = '[data-live="runs"]';
const SWITCH = `${PANEL} [role="switch"]`;
// The Runs view switch also uses aria-pressed, so the state chips are scoped to their own row.
const CHIPS = `${PANEL} div:has(> [role="switch"]) > button[aria-pressed]`;

/** The run's row names the step the write started. */
const runOn = (runId: string, step: string) =>
  `document.querySelector('${PANEL} [data-run="${runId}"]')?.getAttribute('data-step') === '${step}'`;

interface RunsTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  /** The run `fixture:write step --step review --event node_started` ran on, and its row's time. */
  stepToRow: { run: string; ms: number | null } | null;
  holdSeconds: number;
  renewals: Record<(typeof RUNS_QUERIES)[number], number | null>;
  afterHoldStepToRow: { run: string; ms: number | null } | null;
  /** From inserting an idle poll to the toggle reading (1), with All unchanged. */
  idlePollToToggle: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface RunsOnScreen {
  /** Each chip's label and count, in order. */
  chips: [string, number][];
  idlePolls: number | null;
  runs: { run: string; state: string; step: string | null; stop: string | null }[];
}

const runsOnScreen = `(() => {
  const text = (el) => el?.textContent ?? '';
  return {
    chips: [...document.querySelectorAll('${CHIPS}')].map((b) => {
      const m = text(b).match(/^(.*?)([0-9,]*)$/);
      return [m[1], Number((m[2] || '').replaceAll(',', ''))];
    }),
    idlePolls: Number(text(document.querySelector('${SWITCH}')).match(/\\(([0-9,]+)\\)/)?.[1].replaceAll(',', '') ?? NaN),
    runs: [...document.querySelectorAll('${RUN_ROW}')].map((a) => ({
      run: a.getAttribute('data-run'),
      state: a.getAttribute('data-state'),
      step: a.getAttribute('data-step'),
      stop: a.getAttribute('data-stop'),
    })),
  };
})()`;

const stateCounts = (rows: readonly { status: string; n: number }[]) => {
  const counts = new Map<State, number>();
  for (const row of rows) {
    const state = stateOf(RUN_STATE, row.status) ?? 'idle';
    counts.set(state, (counts.get(state) ?? 0) + row.n);
  }
  return counts;
};

/** The screen's own query, run straight against the database: the first page of `factory`'s runs, and its idle polls. */
export async function runsQueryPage(
  db: Db,
  queries: ReadonlyMap<string, string>,
  factory: string,
  hideIdle: boolean,
) {
  const rows = await db.query(queries.get('runs') as string, [
    factory,
    ...runsArgs({ q: '', state: '', hideIdle, page: 1 }),
  ]);
  return {
    runs: rows.filter((r) => r.run_id !== null).map((r) => String(r.run_id)),
    idlePolls: Number(rows[0]?.idle_polls ?? 0),
  };
}

/**
 * The runs screen against SQL over the seed's tables (not the screen's query), read before any run
 * is inserted: the chips, their sum, the first page's runs and every failed run's step and error.
 */
async function seedRunsMismatches(
  page: Page,
  db: Db,
  queries: ReadonlyMap<string, string>,
  factory: string,
): Promise<{ mismatches: string[]; report: string }> {
  const shown = await page.evaluate<RunsOnScreen>(runsOnScreen);
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);

  const statuses = await db.query(
    'SELECT status, count(*)::int AS n FROM mc.laps WHERE factory = $1 GROUP BY status',
    [factory],
  );
  const byState = stateCounts(statuses.map((r) => ({ status: String(r.status), n: Number(r.n) })));
  const all = [...byState.values()].reduce((a, b) => a + b, 0);
  const chipsSql = RUN_CHIPS.map(
    (chip) =>
      [chip.label, chip.state === '' ? all : (byState.get(chip.state) ?? 0)] as [string, number],
  );
  const idle = (await runsQueryPage(db, queries, factory, false)).idlePolls;
  if (idle !== 0) mismatches.push(`the seed has ${idle} idle polls, not 0`);
  same('chips', shown.chips, chipsSql);
  same(
    'the chips add up to All',
    shown.chips.slice(1).reduce((sum, [, n]) => sum + n, 0),
    all,
  );
  same('idle polls', shown.idlePolls, 0);

  const newest = await db.query(
    `SELECT run_id::text AS run FROM mc.laps WHERE factory = $1
      ORDER BY started_at DESC NULLS FIRST, run_id DESC LIMIT ${RUNS_PAGE_SIZE}`,
    [factory],
  );
  same(
    'the first page',
    shown.runs.map((r) => r.run),
    newest.map((r) => String(r.run)),
  );

  const onPage = new Set(newest.map((r) => String(r.run)));
  const stops = await db.query(
    `SELECT run_id::text AS run, step_id, line FROM mc.run_stops
      WHERE factory = $1 AND status = 'failed' ORDER BY 1`,
    [factory],
  );
  const failedOnPage = shown.runs
    .filter((r) => r.state === 'failed')
    .map((r) => ({ run: r.run, step: r.step, stop: r.stop }))
    .sort((a, b) => a.run.localeCompare(b.run));
  same(
    'failed runs: step and error',
    failedOnPage,
    stops
      .filter((r) => onPage.has(String(r.run)))
      .map((r) => ({ run: String(r.run), step: r.step_id, stop: r.line })),
  );

  const report = [
    'screen:',
    `  chips ${JSON.stringify(shown.chips)}`,
    `  first page ${shown.runs.length} runs, ${failedOnPage.length} failed`,
    'SQL (mc.laps, mc.lap_steps, mc.run_stops; not the query in db/queries/):',
    `  chips ${JSON.stringify(chipsSql)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

const FILES = liveOutputs({
  check: 'runs-check.txt',
  shot: 'runs.png',
  probe: 'runs-design-probe.json',
  timings: 'runs-timings.json',
});
export const RUNS_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/** The runs screen: the seed's runs and chips, an idle poll through the toggle, and the lap step events to their rows. */
export function runsPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, holdSeconds, branch, measure } = ctx;
  const timings: RunsTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(RUNS_QUERIES),
    stepToRow: null,
    holdSeconds,
    renewals: { runs: null },
    afterHoldStepToRow: null,
    idlePollToToggle: null,
    noReload: null,
    limits: LIMITS,
  };
  let runsPage: Page | undefined;
  let idleRun: string | undefined;
  const toggleFailures: string[] = [];

  const press = (page: Page, selector: string) =>
    page.evaluate(`document.querySelector('${selector}').click()`);
  const allCount = async (page: Page) => {
    const shown = await page.evaluate<boolean>(
      pageWait(
        `/[0-9]/.test(document.querySelector('${CHIPS}')?.textContent ?? '')`,
        LIMITS.insertToScreenMs,
      ),
      LIMITS.insertToScreenMs + 5000,
    );
    if (!shown) return Number.NaN;
    return page.evaluate<number>(
      `Number(document.querySelector('${CHIPS}').textContent.replace(/[^0-9]/g, ''))`,
    );
  };
  const within = (page: Page, condition: string) =>
    page.evaluate<boolean>(
      pageWait(condition, LIMITS.insertToScreenMs),
      LIMITS.insertToScreenMs + 5000,
    );

  return {
    // The runs screen opens before the strip inserts its laps, so its rows are the seed's.
    async open() {
      const { base } = ctx;
      const [firstLap, secondLap] = ctx.laps;
      const page = await openPage(deps.env);
      runsPage = page;
      await page.goto(`${base}/f/${factory}/runs`);
      await page.evaluate('window.__mcNoReload = true');
      const ready = await page.evaluate<boolean>(pageWait(RUNS_READY, READY_WAIT_MS));
      if (!ready) {
        throw new Error(
          `the runs screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(timings, groupTimings(await measure(page, RUNS_QUERIES)));
      const seed = await seedRunsMismatches(page, db, ctx.queries, factory);
      ctx.save(FILES.check, `${seed.report}\n`);
      ctx.failures.push(...seed.mismatches.map((m) => `runs screen against the seed: ${m}`));
      ctx.failures.push(...(await settleAt(page, 1440, RUNS_READY, 'the runs screen')));
      ctx.save(FILES.shot, await page.screenshot(1440));
      for (const lap of [firstLap, secondLap]) {
        if (await page.evaluate<boolean>(runOn(lap, LIVE_STEP))) {
          throw new Error(`the row of ${lap} is on ${LIVE_STEP} before any write`);
        }
      }
    },

    // An idle poll raises the toggle's count and leaves All alone; showing idle polls adds exactly it.
    async write() {
      const page = required(runsPage, 'runs page');
      const before = await allCount(page);
      const runId = crypto.randomUUID();
      idleRun = runId;
      const started = performance.now();
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
         VALUES ($1, $2, 'archon-merge-queue', 'completed', now(), now())`,
        [runId, factory],
      );
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, completed_at, output)
         VALUES ($1, 'facts', 'completed', now(), now(), '{"path":"idle"}'::jsonb)`,
        [runId],
      );
      const counted = await within(
        page,
        `document.querySelector('${SWITCH}')?.textContent?.includes('(1)') === true`,
      );
      timings.idlePollToToggle = counted ? Math.round(performance.now() - started) : null;
      if (!counted) return;
      if ((await allCount(page)) !== before) toggleFailures.push('a hidden idle poll changed All');
      await press(page, SWITCH);
      const shown = await within(
        page,
        `document.querySelector('${PANEL} [data-run="${runId}"][data-idle-poll]') !== null`,
      );
      if (!shown) toggleFailures.push('turning the toggle off never showed the idle poll');
      else {
        const rose = (await allCount(page)) - before;
        if (rose !== 1) toggleFailures.push(`All rose by ${rose} with idle polls shown, not by 1`);
      }
      await press(page, SWITCH);
    },

    async onLapStep(run, afterHold) {
      const ms = await untilShown(required(runsPage, 'runs page'), runOn(run, LIVE_STEP));
      if (afterHold) {
        timings.afterHoldStepToRow = { run, ms };
        return;
      }
      timings.stepToRow = { run, ms };
      deps.out(`first step event reached its run row in ${ms ?? 'never'} ms`);
    },

    async beforeLapStep(afterHold) {
      if (!afterHold) return;
      const page = required(runsPage, 'runs page');
      for (const q of RUNS_QUERIES) {
        timings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      }
    },

    async writeAgain() {
      const page = required(runsPage, 'runs page');
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      runsPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(`${base}/f/${factory}/runs`, FILES.probe, 'the runs screen');
    },

    async close() {
      timings.port = ctx.port;
      ctx.save(FILES.timings, `${JSON.stringify(timings, null, 2)}\n`);
      await runsPage?.close().catch(() => undefined);
    },

    async cleanup() {
      if (idleRun === undefined) return [];
      await db.query('DELETE FROM mc.lap_steps WHERE run_id = $1', [idleRun]);
      await db.query('DELETE FROM mc.laps WHERE run_id = $1', [idleRun]);
      return [];
    },

    judge() {
      const failures: string[] = [...toggleFailures];
      failures.push(...readyFailures('runs screen', timings, LIMITS.readyMs));
      for (const q of RUNS_QUERIES) {
        failures.push(...groupPerformanceFailures([q], timings));
        if (holdSeconds >= 180 && (timings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
          failures.push(
            `${timings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
          );
        }
      }
      failures.push(...lateWrite('the idle poll', 'the toggle', timings.idlePollToToggle));
      for (const [when, write] of [
        ['first', timings.stepToRow],
        [`after ${holdSeconds}s`, timings.afterHoldStepToRow],
      ] as const) {
        failures.push(...lateWrite(`${LIVE_STEP} ${when}`, 'its row', write?.ms));
      }
      if (timings.noReload !== true) failures.push('the runs screen reloaded');
      return failures;
    },

    summary: () => [`runs: ${JSON.stringify(timings)}`],
  };
}
