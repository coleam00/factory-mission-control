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
/**
 * A seal lives 60 s and is renewed 10 s before it expires, so an open page asks for one at most
 * 50 s after a switch; #118 allows 5 s more for it to follow.
 */
const FOLLOW_LIMIT_MS = 55_000;
const SWITCHED_AT = 'mc:switchedAt';
const STRIP_COUNT = `document.querySelector('[data-live="status-strip"] [data-count]')?.getAttribute('data-count') ?? null`;
const INDICATOR = `document.querySelector('[data-rewind-indicator]')?.getAttribute('data-rewind-indicator') ?? null`;
const bothReady = QUERIES.map(
  (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
).join(' && ');
/** The home map's panels: the factory's strip and its map. */
const homeReady = ['status-strip', 'home-map']
  .map((q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`)
  .join(' && ');
/** The Issues screen's panels: the factory's strip and its issue graph. */
const issuesReady = ['status-strip', 'issue-graph']
  .map((q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`)
  .join(' && ');
/** A rewind-* name no `rewind:create` lists. */
const UNLISTED = 'rewind-not-listed';
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
  /** A second page left open on `/` while the first switches, and switches back. */
  followed: {
    switchedMs: number | null;
    branch: string | null;
    count: number | null;
    backMs: number | null;
  };
  /** A switch to a rewind-* name `/rewind` does not list: its status and reason. */
  unlisted: { status: number | null; error: string | null };
  /** Switch back pressed on the rewind bar of `screen`: where it landed, and when it was live. */
  indicatorBack: {
    screen: string;
    pathname: string | null;
    indicator: string | null;
    ms: number | null;
  };
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

/**
 * Waits until `condition` holds on `page` or the clock passes `until` (epoch ms). The old
 * document never holds a condition that asks for a reload (it carries `__mcNoReload`); the
 * evaluation fails while the new one loads.
 */
async function waitAcrossReload(page: Page, condition: string, until: number): Promise<boolean> {
  while (Date.now() < until) {
    const holds = await page.evaluate<boolean>(pageWait(condition, 1000), 5000).catch(() => false);
    if (holds) return true;
  }
  return false;
}

/**
 * Keeps in the page's sessionStorage, which outlives the reload a switch makes, the browser's
 * clock when the server answered the switch.
 */
const NOTE_SWITCH = `(() => {
  sessionStorage.removeItem('${SWITCHED_AT}');
  const fetch = window.fetch;
  window.fetch = async (...args) => {
    const res = await fetch(...args);
    if (String(args[0]).endsWith('/api/rewind') && res.ok) {
      sessionStorage.setItem('${SWITCHED_AT}', String(Date.now()));
    }
    return res;
  };
})()`;

/**
 * Clicks `selector` and waits for the page `switchBranch` loads to have both panels ready.
 * Answers the browser's clock when the server switched.
 */
async function switchVia(page: Page, selector: string): Promise<number | null> {
  await page.evaluate(NOTE_SWITCH);
  await page.evaluate(`void document.querySelector('${selector}').click()`);
  const loaded = `window.__mcNoReload !== true && ${bothReady}`;
  if (await waitAcrossReload(page, loaded, Date.now() + SWITCH_WAIT_MS)) {
    const at = await page.evaluate<string | null>(`sessionStorage.getItem('${SWITCHED_AT}')`);
    return at === null ? null : Number(at);
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
    followed: { switchedMs: null, branch: null, count: null, backMs: null },
    unlisted: { status: null, error: null },
    indicatorBack: {
      screen: `/f/${encodeURIComponent(factory)}/issues`,
      pathname: null,
      indicator: null,
      ms: null,
    },
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
  /** Open on `/` through both switches, which it must follow by itself. */
  let other: Page | undefined;
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

  /** How long after `switchedAt` the page reloaded itself onto `branch` with its panels ready. */
  async function followMs(
    on: Page,
    switchedAt: number | null,
    branch: string | null,
  ): Promise<number | null> {
    if (switchedAt === null) return null;
    const followed = `window.__mcNoReload !== true && (${INDICATOR}) === ${JSON.stringify(branch)} && ${homeReady}`;
    if (!(await waitAcrossReload(on, followed, switchedAt + FOLLOW_LIMIT_MS))) return null;
    const ms = (await on.evaluate<number>('Date.now()')) - switchedAt;
    await on.evaluate('window.__mcNoReload = true');
    return ms;
  }

  /** Asks the server to switch to a rewind-* name no `rewind:create` listed. */
  async function switchToUnlisted(): Promise<void> {
    const res = await fetch(`${base}/api/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: UNLISTED }),
    });
    const answer = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
    timings.unlisted = {
      status: res.status,
      error: typeof answer?.error === 'string' ? answer.error : null,
    };
    report.push(
      `switching to ${UNLISTED} answered ${res.status}: ${timings.unlisted.error ?? 'no reason'}`,
    );
  }

  /**
   * Switches `on` to `branch`, opens the factory's Issues screen there and presses Switch back
   * on its rewind bar; records where the page landed and when it was live.
   */
  async function switchBackFromScreen(on: Page, branch: string): Promise<void> {
    const back = timings.indicatorBack;
    const res = await fetch(`${base}/api/rewind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch }),
    });
    if (!res.ok) throw new Error(`switching to ${branch} answered ${res.status}`);
    await on.goto(`${base}${back.screen}`);
    if (
      !(await on.evaluate<boolean>(
        pageWait(`(${INDICATOR}) === ${JSON.stringify(branch)}`, SWITCH_WAIT_MS),
        SWITCH_WAIT_MS + 5000,
      ))
    ) {
      throw new Error(
        `${back.screen} showed no rewind bar for ${branch} within ${SWITCH_WAIT_MS} ms`,
      );
    }
    await on.evaluate('window.__mcNoReload = true');
    const pressedAt = Date.now();
    await on.evaluate(`void document.querySelector('[data-indicator-switch-back]').click()`);
    const live = `window.__mcNoReload !== true && location.pathname === ${JSON.stringify(back.screen)} && (${INDICATOR}) === null && ${issuesReady}`;
    if (await waitAcrossReload(on, live, pressedAt + SWITCH_WAIT_MS)) {
      back.ms = Date.now() - pressedAt;
    }
    back.pathname = await on.evaluate<string>('location.pathname').catch(() => null);
    back.indicator = await on.evaluate<string | null>(INDICATOR).catch(() => null);
    report.push(
      `Switch back on ${back.screen} landed on ${back.pathname} with ${back.indicator === null ? 'no rewind bar' : `the rewind bar for ${back.indicator}`}, live after ${back.ms ?? 'never'} ms`,
    );
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
      await switchToUnlisted();

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
      other = await openPage(deps.env);
      await other.goto(`${base}/`);
      if (!(await other.evaluate<boolean>(pageWait(homeReady, READY_WAIT_MS)))) {
        throw new Error(`/ did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
      }
      await other.evaluate('window.__mcNoReload = true');
      const switchedAt = await switchVia(page, `[data-rewind-branch="${name}"] button`);
      timings.followed.switchedMs = await followMs(other, switchedAt, name);
      timings.followed.branch = await other.evaluate<string | null>(INDICATOR);
      timings.followed.count = await count(other);
      report.push(
        `the page open on / followed the switch after ${timings.followed.switchedMs ?? 'never'} ms (limit ${FOLLOW_LIMIT_MS}): it shows ${timings.followed.branch} and ${timings.followed.count} running laps`,
      );
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
      const switchedAt = await switchVia(page, '[data-switch-back]');
      timings.switchedBack = (await page.evaluate<string | null>(INDICATOR)) === null;
      report.push(
        `switched back: the indicator is ${timings.switchedBack ? 'gone' : 'still shown'}`,
      );
      if (!other) throw new Error('the rewind phase never opened its page on /');
      timings.followed.backMs = await followMs(other, switchedAt, null);
      report.push(
        `the page open on / came back live after ${timings.followed.backMs ?? 'never'} ms (limit ${FOLLOW_LIMIT_MS})`,
      );
      const second = created[1];
      if (!second) throw new Error('the rewind phase made no second rewind branch');
      await switchBackFromScreen(other, second);
    },

    /** Always runs: closes the page and server, deletes what the phase made. Never throws. */
    async cleanup(): Promise<string[]> {
      const failures: string[] = [];
      await page?.close().catch(() => undefined);
      await other?.close().catch(() => undefined);
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
      const { followed } = timings;
      if (!within(followed.switchedMs, FOLLOW_LIMIT_MS)) {
        failures.push(
          `the other open page followed the switch to ${created[0]} after ${followed.switchedMs ?? 'never'} ms, limit ${FOLLOW_LIMIT_MS}`,
        );
      }
      if (followed.branch !== created[0] || followed.count !== switched.expected) {
        failures.push(
          `the other open page showed ${followed.branch} with ${followed.count} running laps, expected ${created[0]} with ${switched.expected}`,
        );
      }
      if (!within(followed.backMs, FOLLOW_LIMIT_MS)) {
        failures.push(`the other open page did not come back live within ${FOLLOW_LIMIT_MS} ms`);
      }
      const { unlisted, indicatorBack } = timings;
      if (unlisted.status !== 404 || !unlisted.error?.includes('not in the rewind list')) {
        failures.push(
          `switching to unlisted ${UNLISTED} answered ${unlisted.status} (${unlisted.error}), expected 404 not in the rewind list`,
        );
      }
      if (
        indicatorBack.pathname !== indicatorBack.screen ||
        indicatorBack.indicator !== null ||
        indicatorBack.ms === null
      ) {
        failures.push(
          `Switch back on ${indicatorBack.screen} landed on ${indicatorBack.pathname} showing ${indicatorBack.indicator ?? 'no rewind bar'}, live after ${indicatorBack.ms ?? 'never'} ms; expected the same screen, live, with no rewind bar`,
        );
      }
      return failures;
    },
  };
}
