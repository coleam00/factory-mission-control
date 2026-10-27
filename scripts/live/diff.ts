import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  required,
  versionDigests,
  within,
} from './shared';
import { emptyPanelTimings, type PanelTimings, performanceFailures } from './timings';

const DIFF = '[data-live="arch-diff"]';

interface ArchDiffTimings extends PanelTimings {
  branch: string | null;
  port: number | null;
  url: string | null;
  shown: string[] | null;
  stepToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldStepToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** The seed's V1 to V2 (V2_EDITS in scripts/fixture/seed-architecture.ts) as the diff lists it. */
const SEED_ARCH_CHANGE = [
  'added step archon-loop · tally',
  'removed step archon-loop · briefs',
  'changed prompt loop/commands/loop-review.md',
  'changed subagent archon-manager · manage · holdout-writer',
];

const changesOnScreen = `[...document.querySelectorAll('${DIFF} [data-change]')].map((li) => [
  li.getAttribute('data-change'),
  li.closest('[data-kind]')?.getAttribute('data-kind'),
  li.getAttribute('data-item'),
].join(' '))`;

type ArchKey = { archon_sha: string; factory_sha: string };

/** The architecture rows `db/queries/arch-diff.sql` reads for one of the factory's versions. */
async function archOf(db: Db, factory: string, digest: string): Promise<ArchKey> {
  const [version] = await db.query(
    `SELECT a.archon_sha, a.factory_sha FROM mc.arch_versions a
     WHERE a.archon_sha = (
       SELECT p.archon_sha FROM mc.pins p
       WHERE p.committed_at < (
         SELECT min(started_at) FROM mc.laps WHERE factory = $1 AND digest = $2)
       ORDER BY p.committed_at DESC LIMIT 1)
     ORDER BY a.parsed_at DESC LIMIT 1`,
    [factory, digest],
  );
  if (version === undefined) throw new Error(`no architecture is recorded for ${digest}`);
  return { archon_sha: String(version.archon_sha), factory_sha: String(version.factory_sha) };
}

/** Inserts one step into `arch` and times it from just before the insert to the diff adding it. */
async function archStepToScreen(
  page: Page,
  db: Db,
  arch: ArchKey,
  added: string[],
): Promise<number | null> {
  const path = `live-${crypto.randomUUID().slice(0, 8)}`;
  const selector = `${DIFF} [data-change="added"][data-item="archon-loop · ${path}"]`;
  const started = performance.now();
  const shown = page.evaluate<boolean>(
    pageWait(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      LIMITS.insertToScreenMs,
    ),
    LIMITS.insertToScreenMs + 5000,
  );
  added.push(path);
  await db.query(
    `INSERT INTO mc.arch_steps
       (archon_sha, factory_sha, workflow, path, position, step_id, kind, bash, defined_in, file)
     VALUES ($1, $2, 'archon-loop', $3, 10000, $3, 'bash', 'echo live', 'archon-loop',
       'loop/archon-loop.yaml')`,
    [arch.archon_sha, arch.factory_sha, path],
  );
  return (await shown) ? Math.round(performance.now() - started) : null;
}

/** The diff of V1 and V2: the seed's scripted change, and a step inserted into V2 timed to it. */
export function diffPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const diffTimings: ArchDiffTimings = {
    branch,
    port: null,
    url: null,
    shown: null,
    ...emptyPanelTimings(),
    stepToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldStepToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const addedSteps: string[] = [];
  let diffPage: Page | undefined;
  let v2: string | undefined;
  let v2Arch: ArchKey | undefined;

  return {
    async write() {
      const { base } = ctx;
      const [v1, second] = await versionDigests(db, factory);
      v2 = second;
      diffTimings.url = `/f/${factory}/diff?a=${encodeURIComponent(v1)}&b=${encodeURIComponent(v2)}`;
      const page = await openPage(deps.env);
      diffPage = page;
      await page.goto(`${base}${diffTimings.url}`);
      await page.evaluate('window.__mcNoReload = true');
      const diffReady = await page.evaluate<boolean>(
        pageWait(`document.querySelector('${DIFF}[data-state="ready"]') !== null`, READY_WAIT_MS),
      );
      if (!diffReady) {
        throw new Error(
          `the diff screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(diffTimings, (await measure(page, ['arch-diff']))['arch-diff']);
      diffTimings.shown = await page.evaluate<string[]>(changesOnScreen);
      if (JSON.stringify(diffTimings.shown) !== JSON.stringify(SEED_ARCH_CHANGE)) {
        ctx.failures.push(
          `the diff of V1 and V2 lists ${JSON.stringify(diffTimings.shown)}, the seed scripted ${JSON.stringify(SEED_ARCH_CHANGE)}`,
        );
      }
      writeFileSync(join(outDir, 'arch-diff.png'), await page.screenshot(1440));
    },

    async beforeHold() {
      v2Arch = await archOf(db, factory, required(v2, 'V2 digest'));
      diffTimings.stepToScreenMs = await archStepToScreen(
        required(diffPage, 'diff page'),
        db,
        v2Arch,
        addedSteps,
      );
      deps.out(`first step reached the diff in ${diffTimings.stepToScreenMs ?? 'never'} ms`);
    },

    async afterHold() {
      const page = required(diffPage, 'diff page');
      diffTimings.renewals = await page.evaluate<number>(
        `performance.getEntriesByName('live:arch-diff:renewed').length`,
      );
      diffTimings.afterHoldStepToScreenMs = await archStepToScreen(
        page,
        db,
        required(v2Arch, "V2's architecture"),
        addedSteps,
      );
      diffTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      diffPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(`${base}${diffTimings.url}`, 'arch-diff-design-probe.json', 'the diff screen');
    },

    async close() {
      diffTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'arch-diff-timings.json'),
        `${JSON.stringify(diffTimings, null, 2)}\n`,
      );
      await diffPage?.close().catch(() => undefined);
    },

    async cleanup() {
      try {
        if (v2Arch !== undefined && addedSteps.length > 0) {
          await db.query(
            `DELETE FROM mc.arch_steps WHERE archon_sha = $1 AND factory_sha = $2
             AND workflow = 'archon-loop' AND path = ANY($3::text[])`,
            [v2Arch.archon_sha, v2Arch.factory_sha, `{${addedSteps.join(',')}}`],
          );
        }
        return [];
      } catch (err) {
        return [`removing the inserted steps failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      if (!within(diffTimings.readyMs, LIMITS.readyMs)) {
        failures.push(`diff screen ready after ${diffTimings.readyMs} ms, limit ${LIMITS.readyMs}`);
      }
      failures.push(...performanceFailures('diff screen', diffTimings));
      failures.push(...lateWrite('first step', 'the diff screen', diffTimings.stepToScreenMs));
      failures.push(
        ...lateWrite(
          `step after ${holdSeconds}s`,
          'the diff screen',
          diffTimings.afterHoldStepToScreenMs,
        ),
      );
      if (holdSeconds >= 180 && (diffTimings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${diffTimings.renewals} diff seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (diffTimings.noReload !== true) failures.push('the diff screen reloaded');
      return failures;
    },

    summary: () => [`diff: ${JSON.stringify(diffTimings)}`],
  };
}
