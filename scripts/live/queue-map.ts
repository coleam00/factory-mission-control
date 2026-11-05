import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_MAP } from '../../app/map/factory-map';
import { QUEUE_FACTORY, QUEUE_RUNS } from '../fixture/seed';
import { openPage, type Page } from '../lib/cdp';
import { REPO_ROOT } from '../lib/cli';
import {
  click,
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
const WRITTEN_STEPS = [BUILD_STEP, REVIEW_STEP];
const WAITING = `${MAP} [data-card="mgr"] [data-chip="waiting"]`;

const viewStage = (id: string) => `[data-map-stage][data-view="${id}"][data-placed]`;

/** The steps the check writes to put a running Intake run on Triage and a Split run on Break it up. */
const TRIAGE_STEP = 'triage';
const SLICE_STEP = 'slice';

const liveCountOf = (card: string) =>
  `document.querySelector('${MAP} [data-card="${card}"]')?.getAttribute('data-live-count')`;
const waitingCount = (page: Page) =>
  page.evaluate<number>(`parseInt(document.querySelector('${WAITING}')?.textContent ?? '0', 10)`);

const CHECK_SCREEN = '/steps/factory-app-check/check';
const CHECK_PROMPT = 'fixtures/pack/queue/factory/app-check/commands/check.md';

/** Map, App check, Behind the scenes, `check`: the factory package's step opens with its prompt. */
async function appCheckPromptMismatches(page: Page, base: string): Promise<string[]> {
  const opened =
    (await click(page, `${MAP} [data-card="app"]`)) &&
    (await click(page, '[data-details="app"] [data-tab="behind"]')) &&
    (await click(page, '[data-step-link="factory-app-check check"]'));
  if (opened) {
    await page.evaluate<boolean>(pageWait(`location.pathname === '${CHECK_SCREEN}'`, 2000));
  }
  const at = await page.evaluate<string>('location.pathname');
  if (at !== CHECK_SCREEN)
    return [`App check's Behind the scenes check opened ${at}, not ${CHECK_SCREEN}`];
  await page.evaluate<boolean>(
    pageWait(
      `document.querySelector('[data-live="step-prompt"]')?.getAttribute('data-state') === 'ready'`,
      READY_WAIT_MS,
    ),
  );
  const prompt = await page.evaluate<string | null>(
    `document.querySelector('[data-live="step-prompt"] [data-prompt]')?.textContent ?? null`,
  );
  const expected = readFileSync(join(REPO_ROOT, CHECK_PROMPT), 'utf8').replaceAll('\r\n', '\n');
  return prompt === expected ? [] : [`${base}${CHECK_SCREEN} does not show ${CHECK_PROMPT}`];
}

/** The queue factory's map: queue runs count on their cards, and an attention pause raises "waiting". */
export function queueMapPhase(ctx: LiveContext): LivePhase {
  const { deps, db, outDir } = ctx;
  const name = QUEUE_FACTORY.name;
  const ms = {
    build: null as number | null,
    deliver: null as number | null,
    review: null as number | null,
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
        failures.push(...(await appCheckPromptMismatches(page, base)));
        await page.goto(`${base}/f/${name}`);
        await page.evaluate<boolean>(
          pageWait(`document.querySelector('${MAP}[data-state="ready"]') !== null`, READY_WAIT_MS),
        );

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
      ...lateWrite('an intake run on triage', `${name}'s Intake`, ms.intake),
      ...lateWrite('an intake run on triage', `${name}'s Intake view Triage`, ms.triage),
      ...lateWrite('a split run on slice', `${name}'s Split`, ms.split),
      ...lateWrite('a split run on slice', `${name}'s Split view Break it up`, ms.slice),
      ...lateWrite('a paused attention wait', `${name}'s Manager waiting chip`, ms.waiting),
    ],

    async probe(designProbe) {
      for (const id of ['build', 'split', 'intake']) {
        designProbe(`${ctx.base}/f/${name}?view=${id}`, `${id}-view-design-probe.json`);
      }
      designProbe(
        `${ctx.base}/steps/factory-app-check/check`,
        'factory-step-check-design-probe.json',
      );
      designProbe(
        `${ctx.base}/steps/factory-app-check/config`,
        'factory-step-config-design-probe.json',
      );
    },

    summary: () => [`queue map: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
