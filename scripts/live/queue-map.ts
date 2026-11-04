import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUE_FACTORY, QUEUE_RUNS } from '../fixture/seed';
import { openPage, type Page } from '../lib/cdp';
import {
  LIMITS,
  type LiveContext,
  type LivePhase,
  lapsOnCards,
  lateWrite,
  MAP,
  MAP_READABLE,
  mapCards,
  mapMismatches,
  pageWait,
  READY_WAIT_MS,
  untilShown,
  writeToScreen,
} from './shared';

/** Where the queue runs step: Build's implement round, and Review's policy round. */
const BUILD_STEP = 'ship__deliver__rounds.implement__implement';
const REVIEW_STEP = 'ship__deliver__rounds.review__policy';
const WRITTEN_STEPS = [BUILD_STEP, REVIEW_STEP];
const WAITING = `${MAP} [data-card="mgr"] [data-chip="waiting"]`;

const liveCountOf = (card: string) =>
  `document.querySelector('${MAP} [data-card="${card}"]')?.getAttribute('data-live-count')`;
const waitingCount = (page: Page) =>
  page.evaluate<number>(`parseInt(document.querySelector('${WAITING}')?.textContent ?? '0', 10)`);

/** The queue factory's map: queue runs count on their cards, and an attention pause raises "waiting". */
export function queueMapPhase(ctx: LiveContext): LivePhase {
  const { deps, db, outDir } = ctx;
  const name = QUEUE_FACTORY.name;
  const ms = {
    build: null as number | null,
    review: null as number | null,
    waiting: null as number | null,
  };

  async function restore(): Promise<void> {
    const runs = `{${QUEUE_RUNS.build},${QUEUE_RUNS.review}}`;
    await db.query(
      'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = ANY($1::uuid[]) AND step_name = ANY($2::text[])',
      [runs, `{${WRITTEN_STEPS.join(',')}}`],
    );
    await db.query(
      'DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[]) AND step_id = ANY($2::text[])',
      [runs, `{${WRITTEN_STEPS.join(',')}}`],
    );
    await db.query(
      `UPDATE remote_agent_workflow_runs SET status = 'running', metadata = metadata - 'wait'
        WHERE id = $1`,
      [QUEUE_RUNS.ask],
    );
  }

  return {
    async write() {
      const { base, failures } = ctx;
      const page = await openPage(deps.env);
      try {
        await page.setViewport(MAP_READABLE.width);
        await page.goto(`${base}/f/${name}`);
        await page.evaluate<boolean>(
          pageWait(`document.querySelector('${MAP}[data-state="ready"]') !== null`, READY_WAIT_MS),
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
        writeFileSync(join(outDir, 'queue-map.png'), await page.screenshot(1440));

        const timed = async (card: string, run: string, step: string) => {
          const target = Number(await page.evaluate<string>(liveCountOf(card))) + 1;
          return writeToScreen(
            page,
            deps,
            ['step', '--run', run, '--step', step, '--event', 'node_started'],
            `${liveCountOf(card)} === '${target}'`,
          );
        };
        ms.build = await timed('build', QUEUE_RUNS.build, BUILD_STEP);
        ms.review = await timed('review', QUEUE_RUNS.review, REVIEW_STEP);

        const waiting = (await waitingCount(page)) + 1;
        await writeToScreen(page, deps, ['attention', '--run', QUEUE_RUNS.ask], 'true');
        ms.waiting = await untilShown(
          page,
          `parseInt(document.querySelector('${WAITING}')?.textContent ?? '0', 10) === ${waiting}`,
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
      } finally {
        await page.close().catch(() => undefined);
        await restore();
      }
    },

    async cleanup() {
      try {
        await restore();
        return [];
      } catch (err) {
        return [`restoring the queue factory's runs failed: ${(err as Error).message}`];
      }
    },

    judge: () => [
      ...lateWrite('a build-queue run on implement', `${name}'s Build`, ms.build),
      ...lateWrite('a build-queue run on review', `${name}'s Review`, ms.review),
      ...lateWrite('a paused attention wait', `${name}'s Manager waiting chip`, ms.waiting),
    ],

    summary: () => [`queue map: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
