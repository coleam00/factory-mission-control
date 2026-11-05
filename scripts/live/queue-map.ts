import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_MAP } from '../../app/map/factory-map';
import { QUEUE_DIGEST, QUEUE_FACTORY, QUEUE_RUNS } from '../fixture/seed';
import { openPage, type Page } from '../lib/cdp';
import {
  fixtureWrite,
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
export const BUILD_STEP = 'ship__deliver__rounds.implement__implement';
/** A running merge-queue run the phase adds: a sweep on it counts on Merge and its view's Sweep. */
export const MERGE_SWEEP_RUN = '5eed0005-0000-4000-8000-0000000000a1';
const REVIEW_STEP = 'ship__deliver__rounds.review__policy';
const WRITTEN_STEPS = [BUILD_STEP, REVIEW_STEP];
const WAITING = `${MAP} [data-card="mgr"] [data-chip="waiting"]`;

const viewOf = (id: string) => `[data-map-stage][data-view="${id}"][data-placed]`;

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
    deliver: null as number | null,
    review: null as number | null,
    waiting: null as number | null,
    merge: null as number | null,
    sweep: null as number | null,
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
    const sweepRun = [MERGE_SWEEP_RUN];
    await db.query(
      'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = ANY($1::uuid[])',
      [sweepRun],
    );
    await db.query('DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[])', [sweepRun]);
    await db.query('DELETE FROM mc.laps WHERE run_id = ANY($1::uuid[])', [sweepRun]);
    await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = ANY($1::uuid[])', [sweepRun]);
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
      const view = await openPage(deps.env);
      const drill = await openPage(deps.env);
      try {
        await page.setViewport(MAP_READABLE.width);
        await page.goto(`${base}/f/${name}`);
        await page.evaluate<boolean>(
          pageWait(`document.querySelector('${MAP}[data-state="ready"]') !== null`, READY_WAIT_MS),
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
        writeFileSync(join(outDir, 'queue-map.png'), await page.screenshot(1440));

        await view.setViewport(MAP_READABLE.width);
        const open = async (target: Page, id: string) => {
          await target.goto(`${base}/f/${name}?view=${id}`);
          await target.evaluate<boolean>(
            pageWait(
              `document.querySelector('${MAP}[data-state="ready"] ${viewOf(id)}') !== null`,
              READY_WAIT_MS,
            ),
          );
        };
        const shoot = async (target: Page, id: string, file: string) => {
          await open(target, id);
          failures.push(
            ...mapMismatches(
              await mapCards(target),
              await lapsOnCards(db, name),
              FACTORY_MAP.views?.[id]?.cards,
            ),
          );
          writeFileSync(join(outDir, file), await target.screenshot(1440));
        };
        await shoot(view, 'build', 'build-view.png');
        await drill.setViewport(MAP_READABLE.width);
        await shoot(drill, 'merge', 'merge-view.png');
        await shoot(drill, 'deploy', 'staging-view.png');
        await open(drill, 'merge');

        const timed = async (card: string, run: string, step: string) => {
          const target = Number(await page.evaluate<string>(liveCountOf(card))) + 1;
          return writeToScreen(
            page,
            deps,
            ['step', '--run', run, '--step', step, '--event', 'node_started'],
            `${liveCountOf(card)} === '${target}'`,
          );
        };
        const buildTarget = Number(await page.evaluate<string>(liveCountOf('build'))) + 1;
        const deliverTarget = Number(await view.evaluate<string>(liveCountOf('b-del'))) + 1;
        await fixtureWrite(deps, [
          'step',
          '--run',
          QUEUE_RUNS.build,
          '--step',
          BUILD_STEP,
          '--event',
          'node_started',
        ]);
        [ms.build, ms.deliver] = await Promise.all([
          untilShown(page, `${liveCountOf('build')} === '${buildTarget}'`),
          untilShown(view, `${liveCountOf('b-del')} === '${deliverTarget}'`),
        ]);
        await db.query(
          `INSERT INTO remote_agent_workflow_runs (id, workflow_name, codebase_id, status, user_message, metadata, started_at)
           SELECT $1, 'archon-merge-queue', codebase_id, 'running', $2, $3::jsonb, now()
           FROM remote_agent_workflow_runs WHERE id = $4`,
          [
            MERGE_SWEEP_RUN,
            `Run archon-merge-queue on ${QUEUE_FACTORY.repository}`,
            JSON.stringify({ workflow_source: { digest: QUEUE_DIGEST } }),
            QUEUE_RUNS.merged,
          ],
        );
        const mergeTarget = Number(await page.evaluate<string>(liveCountOf('merge'))) + 1;
        const sweepTarget = Number(await drill.evaluate<string>(liveCountOf('m-sweep'))) + 1;
        await fixtureWrite(deps, [
          'step',
          '--run',
          MERGE_SWEEP_RUN,
          '--step',
          'sweep',
          '--event',
          'node_started',
        ]);
        [ms.merge, ms.sweep] = await Promise.all([
          untilShown(page, `${liveCountOf('merge')} === '${mergeTarget}'`),
          untilShown(drill, `${liveCountOf('m-sweep')} === '${sweepTarget}'`),
        ]);
        ms.review = await timed('review', QUEUE_RUNS.review, REVIEW_STEP);

        const waiting = (await waitingCount(page)) + 1;
        await writeToScreen(page, deps, ['attention', '--run', QUEUE_RUNS.ask], 'true');
        ms.waiting = await untilShown(
          page,
          `parseInt(document.querySelector('${WAITING}')?.textContent ?? '0', 10) === ${waiting}`,
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
      } finally {
        await drill.close().catch(() => undefined);
        await view.close().catch(() => undefined);
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
      ...lateWrite('a build-queue run on implement', `${name}'s Build view Deliver`, ms.deliver),
      ...lateWrite('a build-queue run on review', `${name}'s Review`, ms.review),
      ...lateWrite('a merge-queue run on sweep', `${name}'s Merge`, ms.merge),
      ...lateWrite('a merge-queue run on sweep', `${name}'s Merge view Sweep`, ms.sweep),
      ...lateWrite('a paused attention wait', `${name}'s Manager waiting chip`, ms.waiting),
    ],

    async probe(designProbe) {
      designProbe(`${ctx.base}/f/${name}?view=build`, 'build-view-design-probe.json');
      designProbe(`${ctx.base}/f/${name}?view=merge`, 'merge-view-design-probe.json');
      designProbe(`${ctx.base}/f/${name}?view=deploy`, 'staging-view-design-probe.json');
    },

    summary: () => [`queue map: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
