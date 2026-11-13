import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACTORY_MAP } from '../../app/map/factory-map';
import { QUEUE_DIGEST, QUEUE_FACTORY, QUEUE_RUNS } from '../fixture/seed';
import { requireObject } from '../fixture/write';
import { openPage, type Page } from '../lib/cdp';
import { REPO_ROOT } from '../lib/cli';
import {
  click,
  fixtureWrite,
  LIMITS,
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  lapsOnCards,
  lateWrite,
  liveOutputs,
  MAP,
  MAP_VIEWPORT,
  mapCards,
  mapMismatches,
  pageWait,
  READY_WAIT_MS,
  untilShown,
  writeToScreen,
} from './shared';

const FILES = liveOutputs({
  shot: 'queue-map.png',
  checkProbe: 'factory-step-check-design-probe.json',
  configProbe: 'factory-step-config-design-probe.json',
});

/** Every view the map defines, so a view added to the map is opened and probed without editing this file. */
const MAP_VIEW_IDS = Object.keys(FACTORY_MAP.views ?? {});

/** The output name of a view: its id, except the deploy view, which the live suite has always called staging. */
const viewFileName = (id: string) => (id === 'deploy' ? 'staging' : id.replaceAll('/', '-'));

/** The views test:live screenshots and probes, by `?view=` id; --help names their files from this list. */
export const QUEUE_MAP_VIEWS = MAP_VIEW_IDS.map((id) => ({
  id,
  ...liveOutputs({
    shot: `${viewFileName(id)}-view.png`,
    probe: `${viewFileName(id)}-view-design-probe.json`,
  }),
}));

export const QUEUE_MAP_OUTPUTS: readonly LiveOutput[] = [
  ...Object.values(FILES),
  ...QUEUE_MAP_VIEWS.flatMap((v) => [v.shot, v.probe]),
];

/** Where the queue runs step: Build's implement round, and Review's policy round. */
export const BUILD_STEP = 'ship__deliver__rounds.implement__implement';
/** A running merge-queue run the phase adds: a sweep on it counts on Merge and its view's Sweep. */
export const MERGE_SWEEP_RUN = '5eed0005-0000-4000-8000-0000000000a1';
const REVIEW_STEP = 'ship__deliver__rounds.review__mode';
const REVIEW_CODE_STEP = 'ship__deliver__rounds.review__code';
const REVIEW_TESTS_STEP = 'ship__deliver__rounds.review__tests';
const WRITTEN_STEPS = [BUILD_STEP, REVIEW_STEP, REVIEW_CODE_STEP, REVIEW_TESTS_STEP];
const WAITING = `${MAP} [data-card="mgr"] [data-chip="waiting"]`;

const viewStage = (id: string) => `[data-map-stage][data-view="${id}"][data-placed]`;

/** The steps the check writes to put a running Intake run on Triage and a Split run on Break it up. */
const TRIAGE_STEP = 'triage';
const SLICE_STEP = 'slice';

const liveCountOf = (card: string) =>
  `document.querySelector('${MAP} [data-card="${card}"]')?.getAttribute('data-live-count')`;
const waitingCount = (page: Page) =>
  page.evaluate<number>(`parseInt(document.querySelector('${WAITING}')?.textContent ?? '0', 10)`);

const checkScreen = (factory: string) => `/f/${factory}/steps/factory-app-check/check`;
const CHECK_PROMPT = 'fixtures/pack/queue/factory/app-check/commands/check.md';

/**
 * Map, App check, Behind the scenes, `check`: the factory package's step opens in the factory's
 * address with its prompt, the Factory tab current and a breadcrumb back to the App check card; then
 * `finalize`, which the package gives a trigger rule, shows it.
 */
async function appCheckPromptMismatches(
  page: Page,
  base: string,
  factory: string,
): Promise<string[]> {
  const screen = checkScreen(factory);
  const opened =
    (await click(page, `${MAP} [data-card="app"]`)) &&
    (await click(page, '[data-details="app"] [data-tab="behind"]')) &&
    (await click(page, '[data-step-link="factory-app-check check"]'));
  if (opened) {
    await page.evaluate<boolean>(pageWait(`location.pathname === '${screen}'`, 2000));
  }
  const at = await page.evaluate<string>('location.pathname');
  if (at !== screen) return [`App check's Behind the scenes check opened ${at}, not ${screen}`];
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
  const failures = prompt === expected ? [] : [`${base}${screen} does not show ${CHECK_PROMPT}`];
  const current = await page.evaluate<{ name: string | null; href: string | null }>(
    `({ name: document.querySelector('nav[aria-label="Places"] a[aria-current="page"]')?.textContent?.trim() ?? null,
       href: document.querySelector('nav[aria-label="Places"] a[aria-current="page"]')?.getAttribute('href') ?? null })`,
  );
  if (current.name !== 'Factory' || current.href !== `/f/${factory}/map`) {
    failures.push(`the check step marks ${current.name} (${current.href}) current, not Factory`);
  }
  await click(page, '[data-breadcrumb-back]');
  const back = await page.evaluate<boolean>(
    pageWait(
      `location.pathname === '/f/${factory}/map' && document.querySelector('${MAP} [data-card="app"][data-selected]') !== null`,
      2000,
    ),
  );
  if (!back) failures.push('the check step breadcrumb does not return to the App check card');
  // finalize declares `trigger_rule: all_done` in fixtures/pack/queue/factory/app-check/factory-app-check.yaml.
  await page.goto(`${base}/f/${factory}/steps/factory-app-check/finalize`);
  await page.evaluate<boolean>(
    pageWait(`document.querySelector('[data-trigger-rule]') !== null`, READY_WAIT_MS),
  );
  const rule = await page.evaluate<string | null>(
    `document.querySelector('[data-trigger-rule]')?.textContent ?? null`,
  );
  if (rule !== 'all_done') failures.push(`finalize shows Trigger rule ${rule}, not all_done`);
  return failures;
}

/** The queue factory's map: queue runs count on their cards, and an attention pause raises "waiting". */
export function queueMapPhase(ctx: LiveContext): LivePhase {
  const { deps, db } = ctx;
  const name = QUEUE_FACTORY.name;
  const ms = {
    build: null as number | null,
    deliver: null as number | null,
    review: null as number | null,
    scope: null as number | null,
    code: null as number | null,
    tests: null as number | null,
    waiting: null as number | null,
    merge: null as number | null,
    sweep: null as number | null,
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
    const sweepRun = `{${MERGE_SWEEP_RUN}}`;
    await db.query(
      'DELETE FROM remote_agent_workflow_events WHERE workflow_run_id = ANY($1::uuid[])',
      [sweepRun],
    );
    await db.query('DELETE FROM mc.lap_steps WHERE run_id = ANY($1::uuid[])', [sweepRun]);
    await db.query('DELETE FROM mc.laps WHERE run_id = ANY($1::uuid[])', [sweepRun]);
    await db.query('DELETE FROM remote_agent_workflow_runs WHERE id = ANY($1::uuid[])', [sweepRun]);
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
      const drill = await openPage(deps.env);
      const split = await openPage(deps.env);
      const intake = await openPage(deps.env);
      try {
        await page.setViewport(MAP_VIEWPORT);
        await page.goto(`${base}/f/${name}/map`);
        await page.evaluate<boolean>(
          pageWait(`document.querySelector('${MAP}[data-state="ready"]') !== null`, READY_WAIT_MS),
        );
        failures.push(...mapMismatches(await mapCards(page), await lapsOnCards(db, name)));
        ctx.save(FILES.shot, await page.screenshot(MAP_VIEWPORT));
        failures.push(...(await appCheckPromptMismatches(page, base, name)));
        await page.goto(`${base}/f/${name}/map`);
        await page.evaluate<boolean>(
          pageWait(`document.querySelector('${MAP}[data-state="ready"]') !== null`, READY_WAIT_MS),
        );

        const open = async (target: Page, id: string, shoot = false) => {
          await target.setViewport(MAP_VIEWPORT);
          await target.goto(`${base}/f/${name}/map?view=${id}`);
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
          if (shoot) {
            const opened = QUEUE_MAP_VIEWS.find((v) => v.id === id);
            if (!opened)
              throw new Error(`queue-map opens ?view=${id}, which QUEUE_MAP_VIEWS does not list`);
            ctx.save(opened.shot, await target.screenshot(MAP_VIEWPORT));
          }
        };
        const pageOf: Record<string, Page> = { build: view, split, intake, review: reviewView };
        for (const id of MAP_VIEW_IDS) await open(pageOf[id] ?? drill, id, true);
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
        const [sweep] = await db.query(
          `INSERT INTO remote_agent_workflow_runs (id, workflow_name, codebase_id, status, user_message, metadata, started_at)
           SELECT $1, 'archon-merge-queue', codebase_id, 'running', $2, $3::jsonb, now()
           FROM remote_agent_workflow_runs WHERE id = $4
           RETURNING jsonb_typeof(metadata) AS stored`,
          [
            MERGE_SWEEP_RUN,
            `Run archon-merge-queue on ${QUEUE_FACTORY.repository}`,
            { workflow_source: { digest: QUEUE_DIGEST } },
            QUEUE_RUNS.merged,
          ],
        );
        requireObject('the merge sweep run metadata', sweep);
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
          [...startStep(REVIEW_TESTS_STEP), '--event', 'node_started'],
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
        await drill.close().catch(() => undefined);
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
      ...lateWrite('a build-queue run on review/tests', `${name}'s Review view Tests`, ms.tests),
      ...lateWrite('a merge-queue run on sweep', `${name}'s Merge`, ms.merge),
      ...lateWrite('a merge-queue run on sweep', `${name}'s Merge view Sweep`, ms.sweep),
      ...lateWrite('an intake run on triage', `${name}'s Intake`, ms.intake),
      ...lateWrite('an intake run on triage', `${name}'s Intake view Triage`, ms.triage),
      ...lateWrite('a split run on slice', `${name}'s Split`, ms.split),
      ...lateWrite('a split run on slice', `${name}'s Split view Break it up`, ms.slice),
      ...lateWrite('a paused attention wait', `${name}'s Manager waiting chip`, ms.waiting),
    ],

    async probe(designProbe) {
      for (const v of QUEUE_MAP_VIEWS)
        designProbe(`${ctx.base}/f/${name}/map?view=${v.id}`, v.probe);
      designProbe(`${ctx.base}${checkScreen(name)}`, FILES.checkProbe);
      designProbe(`${ctx.base}/f/${name}/steps/factory-app-check/config`, FILES.configProbe);
    },

    summary: () => [`queue map: ${JSON.stringify({ ...ms, limit: LIMITS.insertToScreenMs })}`],
  };
}
