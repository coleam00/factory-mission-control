import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeItem } from '../../app/lib/changes';
import { notVersionSentence, shortDigest } from '../../app/lib/version-strip';
import { openPage, type Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import {
  cellsOnScreen,
  compareScorecard,
  type ExpectedScorecard,
  type ShownCell,
} from './scorecard';
import { type LiveContext, type LivePhase, pageWait, READY_WAIT_MS } from './shared';

/** What the old Versions, Decisions and ledger screens showed. */
export interface OldScreens {
  /** Digest (or `pin:<sha>` for a pin not yet run), oldest first. */
  versions: string[];
  decisions: { date: string; title: string }[];
  /** A verdict by the pin it is on, or by its prefix when it names no pin. */
  verdicts: { key: string; unmatched: boolean; verdict: string }[];
}

/** One `[data-change]` item on the Changes screen, in document order. */
export interface ShownChange {
  change: ChangeItem['kind'];
  digest: string | null;
  pin: string | null;
  verdict: string | null;
  date: string | null;
  title: string | null;
  prefix: string | null;
  /** The version row a decision sits under, or null for a row of its own. */
  parent: string | null;
}

/**
 * Whether the Changes timeline carries what the old screens showed: every version once, newest
 * first, every decision and verdict, and decisions in date order within where they sit.
 */
export function compareTimeline(old: OldScreens, changes: readonly ShownChange[]): string[] {
  const mismatches: string[] = [];
  const key = (c: ShownChange) => c.digest ?? `pin:${c.pin}`;
  const versions = changes.filter((c) => c.change === 'version').map(key);
  const want = [...old.versions].reverse();
  if (versions.join(' ') !== want.join(' ')) {
    mismatches.push(
      `versions: timeline ${versions.join(' ')}, expected newest first ${want.join(' ')}`,
    );
  }
  for (const d of old.decisions) {
    const found = changes.some(
      (c) => c.change === 'decision' && c.date === d.date && c.title === d.title,
    );
    if (!found) mismatches.push(`decision ${d.date} ${d.title} is not on the timeline`);
  }
  const lastDate = new Map<string, string>();
  for (const c of changes.filter((x) => x.change === 'decision')) {
    const group = c.parent ?? 'own row';
    const before = lastDate.get(group);
    if (before !== undefined && (c.date ?? '') > before) {
      mismatches.push(`decisions under ${group}: ${c.date} comes after ${before}`);
    }
    lastDate.set(group, c.date ?? '');
  }
  for (const v of old.verdicts) {
    const found = changes.some((c) =>
      v.unmatched
        ? c.change === 'verdict' && c.prefix === v.key && c.verdict === v.verdict
        : c.change === 'version' && c.pin === v.key && c.verdict === v.verdict,
    );
    if (!found) mismatches.push(`verdict ${v.verdict} on ${v.key} is not on the timeline`);
  }
  return mismatches;
}

const changesOnScreen = `[...document.querySelectorAll('[data-change]')].map((li) => {
  const attr = (name) => li.getAttribute(name);
  const parent = li.parentElement?.closest('[data-change="version"]');
  return {
    change: attr('data-change'),
    digest: attr('data-digest'),
    pin: attr('data-pin'),
    verdict: attr('data-verdict'),
    date: attr('data-date'),
    title: attr('data-title'),
    prefix: attr('data-prefix'),
    parent: parent === null || parent === undefined ? null : parent.getAttribute('data-digest') ?? 'pin:' + parent.getAttribute('data-pin'),
  };
})`;

const oldScreensOnScreen = `({
  versions: [...document.querySelectorAll('[data-version-entry]')].map((li) =>
    li.getAttribute('data-digest') ?? 'pin:' + li.getAttribute('data-pin')),
  decisions: [...document.querySelectorAll('[data-decision-entry]')].map((li) => ({
    date: li.getAttribute('data-date'),
    title: li.getAttribute('data-title'),
  })),
  verdicts: [...document.querySelectorAll('[data-ledger-group="verdicts"] [data-ledger-entry]')].map((li) => ({
    key: li.getAttribute('data-pin') ?? li.getAttribute('data-prefix'),
    unmatched: li.getAttribute('data-pin') === null,
    verdict: li.getAttribute('data-verdict'),
  })),
})`;

/** The two version headers of the comparison, B last. */
const comparedVersions = `[...document.querySelectorAll('[data-live="scorecard"] [data-version]:not([data-measure])')].map((v) => v.getAttribute('data-digest'))`;

/** Opens `path` and waits until every live panel on it is ready. */
async function openReady(deps: Deps, base: string, path: string): Promise<Page> {
  const page = await openPage(deps.env);
  await page.goto(`${base}${path}`);
  const ready = await page.evaluate<boolean>(
    pageWait(
      `(() => { const p = [...document.querySelectorAll('[data-live]')]; return p.length > 0 && p.every((s) => s.getAttribute('data-state') === 'ready'); })()`,
      READY_WAIT_MS,
    ),
  );
  if (!ready) {
    await page.close();
    throw new Error(`${path} did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
  }
  return page;
}

/**
 * The Changes screen against the old Versions and Decisions screens and against
 * fixtures/expected-scorecard.json, read on the untouched seed; it writes nothing.
 */
export function changesPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir } = ctx;
  const failures: string[] = [];
  const lines: string[] = [];
  const screen = `/f/${factory}/changes`;

  /** Opens `path`, compares its scorecard cells with the expected ones for the digests it shows. */
  async function compareScreen(path: string, label: string) {
    const page = await openReady(deps, ctx.base, path);
    const digests = (await page.evaluate<(string | null)[]>(comparedVersions)).filter(
      (d): d is string => d !== null,
    );
    const expected: ExpectedScorecard = JSON.parse(
      readFileSync(join(deps.repoRoot, 'fixtures', 'expected-scorecard.json'), 'utf-8'),
    );
    expected.versions = expected.versions.filter((v) => digests.includes(v.digest));
    const compared = compareScorecard(await page.evaluate<ShownCell[]>(cellsOnScreen), expected);
    if (expected.versions.length !== digests.length) {
      failures.push(
        `${label} shows ${digests.join(', ')}, the expected scorecard has only ${expected.versions.length} of them`,
      );
    }
    failures.push(
      ...compared.comparisons
        .filter((c) => !c.match)
        .map(
          (c) =>
            `${label} ${c.digest} ${c.measure}: screen ${JSON.stringify(c.screen)}, expected ${JSON.stringify(c.expected)}`,
        ),
    );
    return { digests, page };
  }

  return {
    async open() {
      const { base } = ctx;
      const versionsPage = await openReady(deps, base, `/f/${factory}/versions`);
      const { versions } = await versionsPage.evaluate<OldScreens>(oldScreensOnScreen);
      await versionsPage.close();
      const decisionsPage = await openReady(deps, base, `/f/${factory}/decisions`);
      const { decisions, verdicts } = await decisionsPage.evaluate<OldScreens>(oldScreensOnScreen);
      await decisionsPage.close();

      const page = await openReady(deps, base, screen);
      const changes = await page.evaluate<ShownChange[]>(changesOnScreen);
      const mismatches = compareTimeline({ versions, decisions, verdicts }, changes);
      failures.push(...mismatches.map((m) => `changes timeline: ${m}`));
      lines.push(
        `changes: ${versions.length} versions, ${verdicts.length} verdicts and ${decisions.length} decisions recounted on the timeline, ${mismatches.length} mismatches`,
      );
      writeFileSync(join(outDir, 'changes.png'), await page.screenshot(1440));
      await page.close();

      const digests = changes.flatMap((c) =>
        c.change === 'version' && c.digest !== null ? [c.digest] : [],
      );
      const withLaps = new Set(
        (
          await db.query(
            `SELECT DISTINCT l.digest FROM mc.laps l WHERE l.factory = $1
              AND (l.workflow_name = 'archon-loop' OR l.workflow_name = 'archon-build-queue' AND EXISTS (
                SELECT 1 FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'
                  AND f.output -> 'item' ->> 'number' IS NOT NULL))`,
            [factory],
          )
        ).map((row) => String(row.digest)),
      );
      const newest = digests.find((d) => withLaps.has(d));
      const want = newest === undefined ? [] : [digests[digests.indexOf(newest) + 1], newest];
      const byDefault = await compareScreen(screen, 'changes default view');
      await byDefault.page.close();
      if (want.join() !== byDefault.digests.join()) {
        failures.push(
          `changes default view compares ${byDefault.digests.join(', ')}, expected ${want.join(', ')}`,
        );
      }

      const [v1, v2] = [...digests].reverse();
      const pair = `a=${encodeURIComponent(v1)}&b=${encodeURIComponent(v2)}`;
      const picked = await compareScreen(`${screen}?${pair}`, 'changes V1 against V2');
      const href = await picked.page.evaluate<string | null>(
        `document.querySelector('a[data-compare="diff"]')?.getAttribute('href') ?? null`,
      );
      await picked.page.close();
      if (href !== `/f/${factory}/diff?${pair}`) {
        failures.push(`the workflows link is ${href}, expected /f/${factory}/diff?${pair}`);
      }

      const ghost = `sha256:${'0'.repeat(64)}`;
      const ghostPage = await openReady(
        deps,
        base,
        `${screen}?a=${encodeURIComponent(ghost)}&b=${encodeURIComponent(v2)}`,
      );
      const notice = await ghostPage.evaluate<string | null>(
        `document.querySelector('[data-missing-version]')?.textContent ?? null`,
      );
      await ghostPage.close();
      if (notice === null || !notice.includes(notVersionSentence([ghost])[0] ?? '')) {
        failures.push(
          `an address naming an absent version shows no missing-version notice: ${notice}`,
        );
      } else if (notice.includes(shortDigest(v2))) {
        failures.push(`the missing-version notice names a real version: ${notice}`);
      }
    },

    async probe(designProbe) {
      designProbe(`${ctx.base}${screen}`, 'changes-design-probe.json', 'the changes screen');
    },

    judge: () => failures,

    summary: () => lines,
  };
}
