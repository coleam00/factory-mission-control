import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, type Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import type { Db } from '../lib/db';
import { requireRewindBranch } from '../lib/guard';
import { waitForOperations } from '../lib/neon';
import { resolveBranchName } from '../lib/target';
import { rewindBranchName } from '../rewind-create';
// test-live.ts imports this module too: its helpers are used only inside functions, never while
// the modules load.
import {
  freePort,
  insertToScreen,
  LIMITS,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  renewalsOf,
  waitForHealth,
} from '../test-live';
import {
  collectPanelMarks,
  emptyGroupTimings,
  explainPanel,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
} from './timings';

const QUERIES = ['rewind-branches', 'status-strip'] as const;
const RENEWALS_IN_180S = 3;
/** Making a Neon branch and its Realtime takes tens of seconds before its row is written. */
const CREATE_WAIT_MS = 180_000;
/** A switch asks the Neon API for the branch before the page reloads. */
const SWITCH_WAIT_MS = 30_000;
const STRIP_COUNT = `document.querySelector('[data-live="status-strip"] [data-count]')?.getAttribute('data-count') ?? null`;
const INDICATOR = `document.querySelector('[data-rewind-indicator]')?.getAttribute('data-rewind-indicator') ?? null`;
const bothReady = QUERIES.map(
  (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
).join(' && ');
const listed = (name: string) =>
  `document.querySelector('[data-live="rewind-branches"] [data-rewind-branch="${name}"]') !== null`;

/**
 * The rewind screen's timings. The first navigation to `/rewind` (home state) is judged against
 * the limits; `afterSwitch`, the navigation a switch makes, also waits on the rewind branch's
 * compute, so it is recorded only. A new rewind's way to the list is timed from the line
 * `rewind:create` prints just before its INSERT, since making the Neon branch comes first.
 */
interface RewindTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  createToListMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldCreateToListMs: number | null;
  noReload: boolean | null;
  switched: {
    branch: string | null;
    homeCount: number | null;
    rewindCount: number | null;
    expected: number | null;
  };
  afterSwitch: GroupTimings;
  switchedBack: boolean | null;
  limits: typeof LIMITS;
}

interface RewindMeasurementContext {
  deps: Deps;
  db: Db;
  homeBranch: string;
  queries: ReadonlyMap<string, string>;
  factory: string;
  created: readonly string[];
}

export async function measureRewindPanels(
  page: Page,
  ctx: RewindMeasurementContext,
): Promise<GroupTimings> {
  const panels = await collectPanelMarks(page, QUERIES, READY_WAIT_MS);
  for (const query of QUERIES) {
    const timing = panels[query];
    if (timing.measurementError) continue;
    const branch = timing.queryContext?.branch;
    if (branch === null) {
      await explainPanel(
        query,
        timing,
        { db: ctx.db, branch: ctx.homeBranch, selectedBranch: null },
        ctx.queries,
        ctx.factory,
      );
      continue;
    }
    let rewindDb: Db | undefined;
    try {
      if (!branch || !ctx.created.includes(branch)) throw new Error('unowned rewind branch');
      requireRewindBranch(branch);
      const api = ctx.deps.neon();
      const owned = (await api.listBranches()).find((candidate) => candidate.name === branch);
      if (!owned) throw new Error('owned rewind branch missing');
      const url = await api.pooledConnectionUri(owned.id);
      if ((await resolveBranchName(url, api)) !== branch)
        throw new Error('rewind endpoint mismatch');
      rewindDb = ctx.deps.openDb(url);
      await explainPanel(
        query,
        timing,
        { db: rewindDb, branch, selectedBranch: branch },
        ctx.queries,
        ctx.factory,
      );
    } catch {
      timing.measurementError = `${query}: could not measure the owned rewind branch`;
    } finally {
      await rewindDb?.close();
    }
  }
  return groupTimings(panels);
}

/** Clicks `selector` and waits for the page `switchBranch` loads to have both panels ready. */
async function switchVia(page: Page, selector: string): Promise<void> {
  await page.evaluate(`void document.querySelector('${selector}').click()`);
  const deadline = performance.now() + SWITCH_WAIT_MS;
  while (performance.now() < deadline) {
    // The old document never holds this (it carries the flag); the evaluation fails while the
    // new one loads.
    const loaded = await page
      .evaluate<boolean>(pageWait(`window.__mcNoReload !== true && ${bothReady}`, 1000), 5000)
      .catch(() => false);
    if (loaded) return;
  }
  const failure = await page
    .evaluate<string | null>(`document.querySelector('[data-switch-failure]')?.textContent ?? null`)
    .catch(() => null);
  throw new Error(
    `clicking ${selector} did not load /rewind with both panels ready within ${SWITCH_WAIT_MS} ms${failure ? `: ${failure}` : ''}`,
  );
}

/** One test:live phase for `/rewind`, on its own server so switching it leaves every other page be. */
export function rewindPhase(ctx: {
  deps: Deps;
  db: Db;
  homeBranch: string;
  queries: ReadonlyMap<string, string>;
  outDir: string;
  factory: string;
  holdSeconds: number;
}) {
  const { deps, db, outDir, factory, holdSeconds } = ctx;
  const parent = deps.env.MC_CHECK_BRANCH;
  const timings: RewindTimings = {
    branch: parent ?? null,
    port: null,
    ...emptyGroupTimings(QUERIES),
    createToListMs: null,
    holdSeconds,
    renewals: null,
    afterHoldCreateToListMs: null,
    noReload: null,
    switched: { branch: null, homeCount: null, rewindCount: null, expected: null },
    afterSwitch: emptyGroupTimings(QUERIES),
    switchedBack: null,
    limits: LIMITS,
  };
  const report: string[] = [];
  /** What went wrong without stopping the phase, judged with the timings. */
  const failed: string[] = [];
  /** Every rewind branch this phase asked for, so cleanup deletes whichever exist. */
  const created: string[] = [];
  const inserted: string[] = [];
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let page: Page | undefined;
  let base = '';

  /** Runs `rewind:create` and times its row from the `registering` line to the list. */
  async function createToList(on: Page, at: Date): Promise<number | null> {
    if (!parent) throw new Error('MC_CHECK_BRANCH is not set: run `bun run fixture:branch`');
    const name = rewindBranchName(at);
    created.push(name);
    const shownAt = on
      .evaluate<boolean>(pageWait(listed(name), CREATE_WAIT_MS), CREATE_WAIT_MS + 5000)
      .then(
        (shown) => (shown ? performance.now() : null),
        () => null,
      );
    const args = ['rewind:create', at.toISOString(), '--parent', parent];
    const child = Bun.spawn(['bun', 'run', ...args], {
      cwd: deps.repoRoot,
      env: deps.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    let stdout = '';
    let registeredAt: number | null = null;
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true });
      if (registeredAt === null && /^registering /m.test(stdout)) registeredAt = performance.now();
    }
    const code = await child.exited;
    report.push(`$ bun run ${args.join(' ')}`, stdout.trimEnd(), (await stderr).trimEnd());
    report.push(`exit ${code}`);
    if (code !== 0) throw new Error(`bun run ${args.join(' ')} exited ${code}`);
    const shown = await shownAt;
    return registeredAt === null || shown === null ? null : Math.round(shown - registeredAt);
  }

  async function count(on: Page): Promise<number | null> {
    const value = await on.evaluate<string | null>(STRIP_COUNT);
    return value === null ? null : Number(value);
  }

  return {
    timings,

    /** Opens `/rewind`, makes a rewind from before a lap it inserts, and switches to it. */
    async beforeHold(): Promise<void> {
      const port = await freePort(deps);
      timings.port = port;
      base = `http://localhost:${port}`;
      const proc = Bun.spawn(['bun', 'server/main.ts', '--port', String(port)], {
        cwd: deps.repoRoot,
        env: deps.env,
        stdout: 'ignore',
        stderr: 'inherit',
      });
      server = proc;
      await waitForHealth(base, () => proc.exitCode !== null);

      page = await openPage(deps.env);
      await page.goto(`${base}/rewind`);
      await page.evaluate('window.__mcNoReload = true');
      if (!(await page.evaluate<boolean>(pageWait(bothReady, READY_WAIT_MS)))) {
        throw new Error(`/rewind did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
      }
      Object.assign(timings, await measureRewindPanels(page, { ...ctx, created }));

      const before = await count(page);
      if (before === null) throw new Error('the strip on /rewind shows no count');
      const at = new Date(Math.floor(deps.now().getTime() / 1000) * 1000);
      // The lap must commit after the moment the rewind branch starts from.
      await deps.sleep(Math.max(0, at.getTime() + 2000 - deps.now().getTime()));
      const shownMs = await insertToScreen(page, db, inserted, factory, before + 1);
      timings.switched.homeCount = await count(page);
      report.push(
        `rewind of ${parent} at ${at.toISOString()}: the strip showed ${before} running laps; lap ${inserted[0]} inserted after it reached the strip in ${shownMs ?? 'never'} ms, which then showed ${timings.switched.homeCount}`,
      );
      if (shownMs === null) throw new Error('the inserted lap never reached the strip on /rewind');

      timings.createToListMs = await createToList(page, at);
      const name = rewindBranchName(at);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await switchVia(page, `[data-rewind-branch="${name}"] button`);
      timings.afterSwitch = await measureRewindPanels(page, { ...ctx, created });
      timings.switched.branch = await page.evaluate<string | null>(INDICATOR);
      timings.switched.rewindCount = await count(page);
      timings.switched.expected = before;
      const pass =
        timings.switched.branch === name && timings.switched.rewindCount === before
          ? 'PASS'
          : 'FAIL';
      report.push(
        `switched to ${timings.switched.branch}: the strip shows ${timings.switched.rewindCount} running laps, expected ${before} (the count before the insert): ${pass}`,
      );

      await db.query('DELETE FROM mc.laps WHERE run_id = ANY($1::uuid[])', [
        `{${inserted.join(',')}}`,
      ]);
      inserted.length = 0;
      await page.evaluate('window.__mcNoReload = true');
    },

    /** After the hold: a second rewind to the still-open list, the screenshot, the probe, back. */
    async afterHold(): Promise<void> {
      if (!page) throw new Error('the rewind phase never opened its page');
      timings.renewals = await page.evaluate<number>(renewalsOf('rewind-branches'));
      const at = new Date(Math.floor(deps.now().getTime() / 1000) * 1000 - 60_000);
      timings.afterHoldCreateToListMs = await createToList(page, at);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      writeFileSync(join(outDir, 'rewind.png'), await page.screenshot(1440));
      const probe = Bun.spawnSync(
        [
          'bun',
          'harness/design-probe.js',
          `${base}/rewind`,
          '--out',
          join(outDir, 'rewind-design-probe.json'),
        ],
        { cwd: deps.repoRoot, env: deps.env, stdout: 'ignore', stderr: 'inherit' },
      );
      if (probe.exitCode !== 0) failed.push(`the design probe on /rewind exited ${probe.exitCode}`);
      await switchVia(page, '[data-switch-back]');
      timings.switchedBack = (await page.evaluate<string | null>(INDICATOR)) === null;
      report.push(
        `switched back: the indicator is ${timings.switchedBack ? 'gone' : 'still shown'}`,
      );
    },

    /** Always runs: closes the page and server, deletes what the phase made. Never throws. */
    async cleanup(): Promise<string[]> {
      const failures: string[] = [];
      await page?.close().catch(() => undefined);
      if (server) {
        server.kill();
        await server.exited;
      }
      try {
        if (inserted.length > 0) {
          await db.query('DELETE FROM mc.laps WHERE run_id = ANY($1::uuid[])', [
            `{${inserted.join(',')}}`,
          ]);
        }
      } catch (err) {
        failures.push(`removing the rewind phase's lap failed: ${(err as Error).message}`);
      }
      if (created.length > 0) {
        try {
          const api = deps.neon();
          for (const branch of (await api.listBranches()).filter((b) => created.includes(b.name))) {
            await waitForOperations(api, await api.deleteRewindBranch(branch), deps.sleep);
            report.push(`deleted ${branch.name}`);
          }
        } catch (err) {
          failures.push(`deleting the rewind branches failed: ${(err as Error).message}`);
        }
        try {
          await db.query('DELETE FROM mc.rewind_branches WHERE name = ANY($1::text[])', [
            `{${created.join(',')}}`,
          ]);
        } catch (err) {
          failures.push(`removing the rewind registry rows failed: ${(err as Error).message}`);
        }
      }
      writeFileSync(join(outDir, 'rewind-run.txt'), `${report.join('\n')}\n`);
      writeFileSync(join(outDir, 'rewind-timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
      return failures;
    },

    judge(): string[] {
      const failures = [...failed];
      const within = (value: number | null, limit: number) => value !== null && value <= limit;
      if (!within(timings.readyMs, LIMITS.readyMs)) {
        failures.push(`/rewind was ready after ${timings.readyMs} ms, limit ${LIMITS.readyMs}`);
      }
      failures.push(...groupPerformanceFailures(QUERIES, timings));
      for (const [when, ms] of [
        ['first', timings.createToListMs],
        [`after ${holdSeconds}s`, timings.afterHoldCreateToListMs],
      ] as const) {
        failures.push(...lateWrite(`the ${when} rewind`, 'the list', ms));
      }
      if (holdSeconds >= 180 && (timings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${timings.renewals} rewind-branches seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (timings.noReload !== true) failures.push('/rewind reloaded without a switch');
      const { switched } = timings;
      if (switched.branch !== created[0] || switched.rewindCount !== switched.expected) {
        failures.push(
          `switched to ${switched.branch}, the strip showed ${switched.rewindCount}, expected ${switched.expected}`,
        );
      }
      if (timings.switchedBack !== true) failures.push('switching back left the rewind indicator');
      return failures;
    },
  };
}
