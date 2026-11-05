import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_MAP } from '../../app/map/factory-map';
import { QUEUE_FACTORY, QUEUE_RUNS } from '../fixture/seed';
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
const REVIEW_STEP = 'ship__deliver__rounds.review__policy';
const REVIEW_CODE_STEP = 'ship__deliver__rounds.review__code';
const REREVIEW_TESTS_STEP = 'ship__deliver__rounds.rereview__tests';
const WRITTEN_STEPS = [BUILD_STEP, REVIEW_STEP, REVIEW_CODE_STEP, REREVIEW_TESTS_STEP];
const WAITING = `${MAP} [data-card="mgr"] [data-chip="waiting"]`;

const viewStage = (id: string) => `[data-map-stage][data-view="${id}"][data-placed]`;

/** The steps the check writes to put a running Intake run on Triage and a Split run on Break it up. */
const TRIAGE_STEP = 'triage';
const SLICE_STEP = 'slice';

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
    scope: null as number | null,
    code: null as number | null,
    tests: null as number | null,
    waiting: null as number | null,
    intake: null as number | null,
    triage: null as number | null,
    split: null as number | null,
    slice: null as number | null,
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
    const started = `{${QUEUE_RUNS.triaging},${QUEUE_RUNS.splitting}}`;
    const steps = `{${TRIAGE_STEP},${SLICE_STEP}}`;
    await db.query(
      'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = ANY($1::uuid[]) AND step_name = ANY($2::text[])',
      [started, steps],
    );
    await db.query(
      'DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[]) AND step_id = ANY($2::text[])',
      [started, steps],
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
      const view = await openPage(deps.env);
      const reviewView = await openPage(deps.env);
      const split = await openPage(deps.env);
      const intake = await openPage(deps.env);
      try {
        await page.setViewport(MAP_READABLE.width);
        await page.goto(`${base}/f/${name}`);
        await page.evaluate<boolean>(
          pageWait(`document.querySelector('${MAP}[data-state="ready"]') !== null`, READY_WAIT_MS),
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
        writeFileSync(join(outDir, 'queue-map.png'), await page.screenshot(1440));

        const open = async (target: Page, id: string, file: string) => {
          await target.setViewport(MAP_READABLE.width);
          await target.goto(`${base}/f/${name}?view=${id}`);
          await target.evaluate<boolean>(
            pageWait(
              `document.querySelector('${MAP}[data-state="ready"] ${viewStage(id)}') !== null`,
              READY_WAIT_MS,
            ),
          );
          failures.push(
            ...mapMismatches(
              await mapCards(target),
              await lapsOnCards(db, name),
              FACTORY_MAP.views?.[id]?.cards,
            ),
          );
          writeFileSync(join(outDir, file), await target.screenshot(1440));
        };
        await open(view, 'build', 'build-view.png');
        await open(split, 'split', 'split-view.png');
        await open(intake, 'intake', 'intake-view.png');

        await open(reviewView, 'review', 'review-view.png');

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
        ms.review = await timed('review', QUEUE_RUNS.review, REVIEW_STEP);

        ms.scope = await untilShown(reviewView, `${liveCountOf('r-scope')} === '1'`);
        const startStep = (step: string) => ['step', '--run', QUEUE_RUNS.review, '--step', step];
        ms.code = await writeToScreen(
          reviewView,
          deps,
          [...startStep(REVIEW_CODE_STEP), '--event', 'node_started'],
          `${liveCountOf('r-l2')} === '1'`,
        );
        ms.tests = await writeToScreen(
          reviewView,
          deps,
          [...startStep(REREVIEW_TESTS_STEP), '--event', 'node_started'],
          `${liveCountOf('r-l3')} === '1'`,
        );

        const onBoth = async (
          run: string,
          step: string,
          home: [Page, string],
          deeper: [Page, string],
        ) => {
          const targets = await Promise.all(
            [home, deeper].map(async ([target, card]) => ({
              target,
              card,
              count: Number(await target.evaluate<string>(liveCountOf(card))) + 1,
            })),
          );
          await fixtureWrite(deps, [
            'step',
            '--run',
            run,
            '--step',
            step,
            '--event',
            'node_started',
          ]);
          return Promise.all(
            targets.map(({ target, card, count }) =>
              untilShown(target, `${liveCountOf(card)} === '${count}'`),
            ),
          );
        };
        [ms.intake, ms.triage] = await onBoth(
          QUEUE_RUNS.triaging,
          TRIAGE_STEP,
          [page, 'intake'],
          [intake, 'i-tri'],
        );
        [ms.split, ms.slice] = await onBoth(
          QUEUE_RUNS.splitting,
          SLICE_STEP,
          [page, 'split'],
          [split, 's-slice'],
        );

        const waiting = (await waitingCount(page)) + 1;
        await writeToScreen(page, deps, ['attention', '--run', QUEUE_RUNS.ask], 'true');
        ms.waiting = await untilShown(
          page,
          `parseInt(document.querySelector('${WAITING}')?.textContent ?? '0', 10) === ${waiting}`,
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
      } finally {
        await intake.close().catch(() => undefined);
        await split.close().catch(() => undefined);
        await view.close().catch(() => undefined);
        await reviewView.close().catch(() => undefined);
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
      ...lateWrite(
        'a build-queue run on review',
        `${name}'s Review view Scope the change`,
        ms.scope,
      ),
      ...lateWrite('a build-queue run on review/code', `${name}'s Review view Code`, ms.code),
      ...lateWrite('a build-queue run on rereview/tests', `${name}'s Review view Tests`, ms.tests),
      ...lateWrite('an intake run on triage', `${name}'s Intake`, ms.intake),
      ...lateWrite('an intake run on triage', `${name}'s Intake view Triage`, ms.triage),
      ...lateWrite('a split run on slice', `${name}'s Split`, ms.split),
      ...lateWrite('a split run on slice', `${name}'s Split view Break it up`, ms.slice),
      ...lateWrite('a paused attention wait', `${name}'s Manager waiting chip`, ms.waiting),
    ],

    async probe(designProbe) {
      for (const id of ['build', 'review', 'split', 'intake']) {
        designProbe(`${ctx.base}/f/${name}?view=${id}`, `${id}-view-design-probe.json`);
      }
    },

    summary: () => [`queue map: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
