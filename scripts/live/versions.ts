import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, type Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  ENTRY,
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  required,
  VERSIONS,
  writeToScreen,
} from './shared';
import {
  emptyPanelTimings,
  type PanelTimings,
  performanceFailures,
  readyFailures,
} from './timings';

interface VersionStripTimings extends PanelTimings {
  branch: string | null;
  port: number | null;
  pinToScreenMs: number | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldPinToScreenMs: number | null;
  noReload: boolean | null;
  links: { scorecard: string | null; diff: string | null };
  limits: typeof LIMITS;
}

interface ShownEntry {
  kind: string | null;
  digest: string | null;
  pin: string | null;
  date: string | null;
  reason: string | null;
  hypothesis: string | null;
  measure: string | null;
}

const entriesOnScreen = `[...document.querySelectorAll('${ENTRY}')].map((li) => ({
  kind: li.getAttribute('data-kind'),
  digest: li.getAttribute('data-digest'),
  pin: li.getAttribute('data-pin'),
  date: li.querySelector('[data-date]')?.getAttribute('data-date') ?? null,
  reason: li.querySelector('[data-reason]')?.getAttribute('data-reason') ?? null,
  hypothesis: li.querySelector('[data-hypothesis]')?.getAttribute('data-hypothesis') ?? null,
  measure: li.querySelector('[data-measure]')?.getAttribute('data-measure') ?? null,
}))`;

/** The versions screen against the seed's own versions and pins, read before any pin is written. */
async function seedVersionMismatches(
  page: Page,
  db: Db,
  factory: string,
): Promise<{ mismatches: string[]; report: string; digests: string[] }> {
  const shown = await page.evaluate<ShownEntry[]>(entriesOnScreen);
  const versions = await db.query(
    `SELECT v.digest, v.first_run_at, p.sha, p.reason, p.hypothesis, p.measure, p.committed_at
     FROM mc.versions v LEFT JOIN mc.pins p ON p.sha = v.pin_sha
     WHERE v.factory = $1 ORDER BY v.first_run_at`,
    [factory],
  );
  const pins = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at');
  const recorded = (text: unknown) =>
    typeof text === 'string' && text.trim() !== '' ? text : 'not recorded';
  const mismatches: string[] = [];
  if (shown.length !== versions.length) {
    mismatches.push(`the screen shows ${shown.length} entries, the seed has ${versions.length}`);
  }
  versions.forEach((version, i) => {
    const entry = shown[i];
    const expected: ShownEntry = {
      kind: 'version',
      digest: String(version.digest),
      pin: String(pins[i]?.sha),
      date:
        version.committed_at === null
          ? 'not recorded'
          : new Date(version.committed_at as string).toISOString().slice(0, 10),
      reason: recorded(version.reason),
      hypothesis: recorded(version.hypothesis),
      measure: recorded(version.measure),
    };
    if (version.sha !== pins[i]?.sha) {
      mismatches.push(
        `seed version ${i + 1} is pinned by ${version.sha}, pin ${i + 1} is ${pins[i]?.sha}`,
      );
    }
    for (const key of Object.keys(expected) as (keyof ShownEntry)[]) {
      if (entry?.[key] !== expected[key]) {
        mismatches.push(`entry ${i + 1} ${key}: screen ${entry?.[key]}, seed ${expected[key]}`);
      }
    }
  });
  const report = [
    'screen:',
    ...shown.map((e) => `  ${JSON.stringify(e)}`),
    'seed (mc.versions joined to mc.pins, by first run):',
    ...versions.map((v) => `  ${JSON.stringify(v)}`),
    'seed pins by commit:',
    ...pins.map((p) => `  ${p.sha}`),
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report, digests: versions.map((v) => String(v.digest)) };
}

/** Picks the versions whose digests are given and returns the two compare links it then shows. */
async function selectAndLink(
  page: Page,
  digests: readonly string[],
): Promise<VersionStripTimings['links']> {
  for (const digest of digests) {
    await page.evaluate(
      `document.querySelector('${ENTRY}[data-digest=${JSON.stringify(digest)}] button').click()`,
    );
  }
  const shown = await page.evaluate<boolean>(
    pageWait(`document.querySelectorAll('${VERSIONS} a[data-compare]').length === 2`, 2000),
  );
  if (!shown) return { scorecard: null, diff: null };
  const href = (kind: string) =>
    page.evaluate<string | null>(
      `document.querySelector('${VERSIONS} a[data-compare="${kind}"]')?.getAttribute('href') ?? null`,
    );
  return { scorecard: await href('scorecard'), diff: await href('diff') };
}

/** The compare links must name the factory's scorecard and the diff, from V1 (`a`) to V2 (`b`). */
function checkLinks(
  links: VersionStripTimings['links'],
  base: string,
  factory: string,
  a: string,
  b: string,
): string[] {
  const failures: string[] = [];
  const expected = { scorecard: `/f/${factory}/scorecard`, diff: `/f/${factory}/diff` };
  for (const kind of ['scorecard', 'diff'] as const) {
    const href = links[kind];
    if (href === null) {
      failures.push(`picking V1 and V2 showed no ${kind} link`);
      continue;
    }
    const url = new URL(href, base);
    if (
      url.pathname !== expected[kind] ||
      url.searchParams.get('a') !== a ||
      url.searchParams.get('b') !== b
    ) {
      failures.push(`the ${kind} link is ${href}, expected ${expected[kind]}?a=<V1>&b=<V2>`);
    }
  }
  return failures;
}

const entriesAre = (target: number) => `document.querySelectorAll('${ENTRY}').length === ${target}`;

/** The versions screen: the seed's versions and pins, its compare links, and pins timed to it. */
export function versionsPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const versionTimings: VersionStripTimings = {
    branch,
    port: null,
    ...emptyPanelTimings(),
    pinToScreenMs: null,
    holdSeconds,
    renewals: null,
    afterHoldPinToScreenMs: null,
    noReload: null,
    links: { scorecard: null, diff: null },
    limits: LIMITS,
  };
  const pinned: string[] = [];
  let versionsPage: Page | undefined;
  let entries = 0;
  const latestPin = async () => {
    const [pin] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
    pinned.push(String(pin.sha));
  };

  return {
    async write() {
      const { base } = ctx;
      const page = await openPage(deps.env);
      versionsPage = page;
      await page.goto(`${base}/f/${factory}/versions`);
      await page.evaluate('window.__mcNoReload = true');
      const versionsReady = await page.evaluate<boolean>(
        pageWait(
          `document.querySelector('${VERSIONS}[data-state="ready"]') !== null`,
          READY_WAIT_MS,
        ),
      );
      if (!versionsReady) {
        throw new Error(
          `the versions screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(versionTimings, (await measure(page, ['version-strip']))['version-strip']);
      const seed = await seedVersionMismatches(page, db, factory);
      writeFileSync(join(outDir, 'version-strip-check.txt'), `${seed.report}\n`);
      ctx.failures.push(...seed.mismatches.map((m) => `versions screen against the seed: ${m}`));
      writeFileSync(join(outDir, 'version-strip.png'), await page.screenshot(1440));

      const [v1, v2] = seed.digests;
      versionTimings.links = await selectAndLink(page, [v1, v2]);
      ctx.failures.push(...checkLinks(versionTimings.links, base, factory, v1, v2));

      entries = await page.evaluate<number>(`document.querySelectorAll('${ENTRY}').length`);
      versionTimings.pinToScreenMs = await writeToScreen(
        page,
        deps,
        ['pin'],
        entriesAre(entries + 1),
      );
      await latestPin();
      deps.out(
        `first pin reached the versions screen in ${versionTimings.pinToScreenMs ?? 'never'} ms`,
      );
    },

    async writeAgain() {
      const page = required(versionsPage, 'versions page');
      versionTimings.renewals = await page.evaluate<number>(
        `performance.getEntriesByName('live:version-strip:renewed').length`,
      );
      versionTimings.afterHoldPinToScreenMs = await writeToScreen(
        page,
        deps,
        ['pin'],
        entriesAre(entries + 2),
      );
      await latestPin();
      versionTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      versionsPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(
        `${base}/f/${factory}/versions`,
        'version-strip-design-probe.json',
        'the versions screen',
      );
    },

    async close() {
      versionTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'version-strip-timings.json'),
        `${JSON.stringify(versionTimings, null, 2)}\n`,
      );
      await versionsPage?.close().catch(() => undefined);
    },

    async cleanup() {
      try {
        if (pinned.length > 0) {
          await db.query('DELETE FROM mc.pins WHERE sha = ANY($1::text[])', [
            `{${pinned.join(',')}}`,
          ]);
        }
        return [];
      } catch (err) {
        return [`removing the written pins failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('versions screen', versionTimings, LIMITS.readyMs));
      failures.push(...performanceFailures('versions screen', versionTimings));
      failures.push(
        ...lateWrite(
          'the pin before the hold (pinToScreenMs)',
          'the versions screen',
          versionTimings.pinToScreenMs,
        ),
      );
      failures.push(
        ...lateWrite(
          `the pin after the ${holdSeconds}s hold (afterHoldPinToScreenMs)`,
          'the versions screen',
          versionTimings.afterHoldPinToScreenMs,
        ),
      );
      if (holdSeconds >= 180 && (versionTimings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${versionTimings.renewals} versions seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (versionTimings.noReload !== true) failures.push('the versions screen reloaded');
      return failures;
    },

    summary: () => [`versions: ${JSON.stringify(versionTimings)}`],
  };
}
