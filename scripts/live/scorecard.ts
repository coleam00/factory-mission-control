import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, type Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import type { Row } from '../lib/db';
import {
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  required,
  versionDigests,
  writeToScreen,
} from './shared';
import {
  emptyPanelTimings,
  type PanelTimings,
  performanceFailures,
  readyFailures,
} from './timings';

const SCORECARD = '[data-live="scorecard"]';

interface ScorecardTimings extends PanelTimings {
  branch: string | null;
  port: number | null;
  mergeToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldMergeToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** One number on the scorecard: its attributes, the laps it lists, and its summary's text. */
export interface ShownCell {
  digest: string | null;
  measure: string | null;
  value: string | null;
  laps: string | null;
  listed: number;
  summary: string | null;
}

const cellsOnScreen = `[...document.querySelectorAll('${SCORECARD} [data-version][data-measure]')].map((cell) => ({
  digest: cell.getAttribute('data-digest'),
  measure: cell.getAttribute('data-measure'),
  value: cell.getAttribute('data-value'),
  laps: cell.getAttribute('data-laps'),
  listed: cell.querySelectorAll('[data-lap]').length,
  summary: cell.querySelector('summary')?.textContent ?? null,
}))`;

interface ExpectedScorecard {
  versions: { digest: string; measures: Record<string, { value: number | null; laps: number }> }[];
}

interface ScorecardComparison {
  digest: string;
  measure: string;
  screen: { value: number | null; laps: number } | null;
  expected: { value: number | null; laps: number };
  match: boolean;
}

/**
 * Every measure of every version in `fixtures/expected-scorecard.json` against the cell the
 * screen shows for it; a number the screen does not show is a mismatch. Also each cell whose lap
 * list or summary disagrees with its `data-laps`.
 */
export function compareScorecard(
  shown: readonly ShownCell[],
  expected: ExpectedScorecard,
): { comparisons: ScorecardComparison[]; mismatches: number; lapListFailures: string[] } {
  const comparisons = expected.versions.flatMap(({ digest, measures }) =>
    Object.entries(measures).map(([measure, want]): ScorecardComparison => {
      const cell = shown.find((c) => c.digest === digest && c.measure === measure);
      const screen =
        cell === undefined
          ? null
          : { value: cell.value === 'n/a' ? null : Number(cell.value), laps: Number(cell.laps) };
      const match = screen !== null && screen.value === want.value && screen.laps === want.laps;
      return { digest, measure, screen, expected: want, match };
    }),
  );
  const lapListFailures = shown.flatMap((cell) => {
    const laps = Number(cell.laps);
    const summary = Number(/^\d+/.exec(cell.summary ?? '')?.[0]);
    return cell.listed === laps && summary === laps
      ? []
      : [
          `${cell.digest} ${cell.measure}: data-laps ${cell.laps}, lists ${cell.listed}, summary "${cell.summary}"`,
        ];
  });
  return {
    comparisons,
    mismatches: comparisons.filter((c) => !c.match).length,
    lapListFailures,
  };
}

/** Opens the scorecard of `a` against `b` and waits for it to be ready. */
async function openScorecard(deps: Deps, base: string, factory: string, a: string, b: string) {
  const page = await openPage(deps.env);
  await page.goto(
    `${base}/f/${factory}/scorecard?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
  );
  await page.evaluate('window.__mcNoReload = true');
  const ready = await page.evaluate<boolean>(
    pageWait(`document.querySelector('${SCORECARD}[data-state="ready"]') !== null`, READY_WAIT_MS),
  );
  if (!ready) {
    await page.close();
    throw new Error(`the scorecard did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
  }
  return page;
}

/** Each difference's `data-meaningful` and whether it carries the `not yet meaningful` label. */
const differencesOnScreen = `[...document.querySelectorAll('${SCORECARD} [data-difference]')].map((d) => ({
  meaningful: d.getAttribute('data-meaningful'),
  labelled: d.textContent.includes('not yet meaningful'),
}))`;

async function labelFailures(page: Page, pair: string, meaningful: boolean): Promise<string[]> {
  const shown =
    await page.evaluate<{ meaningful: string | null; labelled: boolean }[]>(differencesOnScreen);
  if (shown.length === 0) return [`${pair} shows no differences`];
  return shown
    .filter((d) => d.meaningful !== String(meaningful) || d.labelled === meaningful)
    .map(
      (d) =>
        `${pair}: a difference has data-meaningful=${d.meaningful}${d.labelled ? ' and is' : ' and is not'} labelled not yet meaningful`,
    );
}

/** V2's merges on the open scorecard (version b) equal `target`. */
const mergesAre = (target: number) =>
  `document.querySelector('${SCORECARD} [data-version="b"][data-measure="merges"]')?.getAttribute('data-value') === '${target}'`;

/**
 * The scorecard of V1 against V2 and of V1 against V3 against fixtures/expected-scorecard.json,
 * and a V2 lap's land timed to V2's merges before and after the hold.
 */
export function scorecardPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const scorecardTimings: ScorecardTimings = {
    branch,
    port: null,
    ...emptyPanelTimings(),
    mergeToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldMergeToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  /** The `land` rows of the V2 laps the scorecard's writes land, as they were before them. */
  const landed: { runId: string; row: string | null }[] = [];
  let scorePage: Page | undefined;
  let pair: [string, string] | undefined;
  let unlanded: Row[] = [];
  let merges = 0;
  const landToScreen = async (page: Page, target: number): Promise<number | null> => {
    const lap = unlanded[landed.length];
    landed.push({ runId: String(lap.run_id), row: lap.row === null ? null : String(lap.row) });
    const args = [
      'step',
      '--run',
      String(lap.run_id),
      '--step',
      'land',
      '--event',
      'node_completed',
    ];
    return writeToScreen(page, deps, args, mergesAre(target));
  };

  return {
    async write() {
      const { base } = ctx;
      const [v1, v2, v3] = await versionDigests(db, factory);
      pair = [v1, v2];
      const page = await openScorecard(deps, base, factory, v1, v2);
      scorePage = page;
      Object.assign(scorecardTimings, (await measure(page, ['scorecard'])).scorecard);
      const shown = await page.evaluate<ShownCell[]>(cellsOnScreen);
      ctx.failures.push(...(await labelFailures(page, 'V1 against V2', true)));
      const thinPage = await openScorecard(deps, base, factory, v1, v3);
      try {
        shown.push(...(await thinPage.evaluate<ShownCell[]>(cellsOnScreen)));
        ctx.failures.push(...(await labelFailures(thinPage, 'V1 against V3', false)));
      } finally {
        await thinPage.close();
      }
      const expected: ExpectedScorecard = JSON.parse(
        readFileSync(join(deps.repoRoot, 'fixtures', 'expected-scorecard.json'), 'utf-8'),
      );
      const compared = compareScorecard(shown, expected);
      writeFileSync(
        join(outDir, 'scorecard-vs-expected.json'),
        `${JSON.stringify({ branch, ...compared }, null, 2)}\n`,
      );
      ctx.failures.push(
        ...compared.comparisons
          .filter((c) => !c.match)
          .map(
            (c) =>
              `scorecard ${c.digest} ${c.measure}: screen ${JSON.stringify(c.screen)}, expected ${JSON.stringify(c.expected)}`,
          ),
        ...compared.lapListFailures.map((f) => `scorecard lap list: ${f}`),
      );
      writeFileSync(join(outDir, 'scorecard.png'), await page.screenshot(1440));

      unlanded = await db.query(
        `SELECT l.run_id, (SELECT to_jsonb(s)::text FROM mc.lap_steps s
           WHERE s.run_id = l.run_id AND s.step_id = 'land') AS row
         FROM mc.laps l
         WHERE l.factory = $1 AND l.digest = $2 AND NOT EXISTS (
           SELECT 1 FROM mc.lap_steps s WHERE s.run_id = l.run_id AND s.step_id = 'land'
             AND s.output ->> 'outcome' IN ('merged', 'refused'))
         ORDER BY l.started_at LIMIT 2`,
        [factory, v2],
      );
      if (unlanded.length < 2) {
        throw new Error(`the check branch has ${unlanded.length} V2 laps that did not land, not 2`);
      }
      merges = Number(
        await page.evaluate<string>(
          `document.querySelector('${SCORECARD} [data-version="b"][data-measure="merges"]').getAttribute('data-value')`,
        ),
      );
      scorecardTimings.mergeToScreenMs = await landToScreen(page, merges + 1);
      deps.out(
        `first merge reached the scorecard in ${scorecardTimings.mergeToScreenMs ?? 'never'} ms`,
      );
    },

    async writeAgain() {
      const page = required(scorePage, 'scorecard page');
      scorecardTimings.renewals = await page.evaluate<number>(
        `performance.getEntriesByName('live:scorecard:renewed').length`,
      );
      scorecardTimings.afterHoldMergeToScreenMs = await landToScreen(page, merges + 2);
      scorecardTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      scorePage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      const [v1, v2] = required(pair, 'scorecard versions');
      designProbe(
        `${base}/f/${factory}/scorecard?a=${encodeURIComponent(v1)}&b=${encodeURIComponent(v2)}`,
        'scorecard-design-probe.json',
        'the scorecard',
      );
    },

    async close() {
      scorecardTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'scorecard-timings.json'),
        `${JSON.stringify(scorecardTimings, null, 2)}\n`,
      );
      await scorePage?.close().catch(() => undefined);
    },

    async cleanup() {
      try {
        // Archon's event rows the writes added stay: only `fixture:*` writes them on a check branch.
        for (const { runId, row } of landed) {
          await db.transaction(async (tx) => {
            await tx.query(`DELETE FROM mc.lap_steps WHERE run_id = $1 AND step_id = 'land'`, [
              runId,
            ]);
            if (row !== null) {
              await tx.query(
                'INSERT INTO mc.lap_steps SELECT * FROM jsonb_populate_record(NULL::mc.lap_steps, $1::text::jsonb)',
                [row],
              );
            }
          });
        }
        return [];
      } catch (err) {
        return [`restoring the landed laps' land steps failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('scorecard', scorecardTimings, LIMITS.readyMs));
      failures.push(...performanceFailures('scorecard', scorecardTimings));
      failures.push(...lateWrite('first merge', 'the scorecard', scorecardTimings.mergeToScreenMs));
      failures.push(
        ...lateWrite(
          `merge after ${holdSeconds}s`,
          'the scorecard',
          scorecardTimings.afterHoldMergeToScreenMs,
        ),
      );
      if (holdSeconds >= 180 && (scorecardTimings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${scorecardTimings.renewals} scorecard seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (scorecardTimings.noReload !== true) failures.push('the scorecard reloaded');
      return failures;
    },

    summary: () => [`scorecard: ${JSON.stringify(scorecardTimings)}`],
  };
}
