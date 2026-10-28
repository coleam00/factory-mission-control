import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECOND_FACTORY } from '../fixture/seed';
import { openPage, type Page } from '../lib/cdp';
import type { Db, Row } from '../lib/db';
import {
  ENTRY,
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  PANEL,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  required,
  VERSIONS,
  writeToScreen,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

const DECISION_QUERIES = ['decisions-timeline', 'improvements-ledger'] as const;
const DECISION = '[data-live="decisions-timeline"] [data-decision-entry]';
const LEDGER = '[data-live="improvements-ledger"]';
const inLedger = (group: 'testing' | 'verdicts', pin: string) =>
  `document.querySelector('${LEDGER} [data-ledger-group="${group}"] [data-ledger-entry][data-pin="${pin}"]') !== null`;

type PerQuery = Record<(typeof DECISION_QUERIES)[number], number | null>;

interface DecisionsTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  verdictToScreenMs: number | null;
  decisionToScreenMs: number | null;
  holdSeconds: number;
  renewals: PerQuery;
  afterHoldVerdictToScreenMs: number | null;
  afterHoldDecisionToScreenMs: number | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface ShownDecision {
  date: string | null;
  title: string | null;
  link: string | null;
  href: string | null;
  text: string;
}

interface ShownLedgerEntry {
  group: string | null;
  pin: string | null;
  laps: string | null;
  waiting: string | null;
  verdict: string | null;
  sentence: string | null;
}

const decisionsOnScreen = `[...document.querySelectorAll('${DECISION}')].map((li) => ({
  date: li.getAttribute('data-date'),
  title: li.getAttribute('data-title'),
  link: li.querySelector('[data-version-link]')?.getAttribute('data-version-link') ?? null,
  href: li.querySelector('[data-version-link]')?.getAttribute('href') ?? null,
  text: li.textContent ?? '',
}))`;

// Read the seed's materialized version joins independently of the live timeline query: a version
// names the one pin whose sha or Archon sha it prefixes, and a prefix of several is ambiguous.
const DECISION_DESTINATIONS_SQL = `SELECT d.date::text AS date, d.title, d.version,
  p.sha AS pin_sha, p.ambiguous, v.digest
FROM mc.decisions d
CROSS JOIN LATERAL (
  SELECT CASE WHEN count(*) = 1 THEN min(sha) END AS sha, count(*) > 1 AS ambiguous
  FROM mc.pins
  WHERE d.version <> '' AND (starts_with(sha, d.version) OR starts_with(archon_sha, d.version))
) p
LEFT JOIN LATERAL (
  SELECT digest FROM mc.versions WHERE factory = $1 AND pin_sha = p.sha
  ORDER BY first_run_at LIMIT 1
) v ON true
ORDER BY d.date, d.title`;

export function decisionHref(seed: Row, factory: string): string | null {
  if (seed.pin_sha === null) return null;
  const query = `pin=${encodeURIComponent(String(seed.pin_sha))}`;
  const digest = seed.digest === null ? '' : `&digest=${encodeURIComponent(String(seed.digest))}`;
  return `/f/${encodeURIComponent(factory)}/versions?${query}${digest}`;
}

export function compareDecision(
  shown: ShownDecision | undefined,
  seed: Row,
  factory: string,
): string[] {
  const expected = {
    date: String(seed.date),
    title: String(seed.title),
    link: seed.pin_sha === null ? null : String(seed.pin_sha),
    href: decisionHref(seed, factory),
  };
  const mismatches: string[] = [];
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (shown?.[key] !== expected[key]) {
      mismatches.push(`${key}: screen ${shown?.[key]}, seed ${expected[key]}`);
    }
  }
  const unlinked = seed.ambiguous
    ? 'ambiguous: several pins by that prefix'
    : 'no pin by that prefix';
  if (seed.pin_sha === null && !shown?.text.includes(`${seed.version}, ${unlinked}`)) {
    mismatches.push('unmatched decision is missing its non-link explanation');
  }
  return mismatches;
}

interface ShownDestination {
  href: string;
  factory: string | null;
  targets: {
    pin: string | null;
    digest: string | null;
    kind: string | null;
    text: string;
    visible: boolean;
    highlighted: boolean;
  }[];
  selected: number;
}

export function compareDecisionDestination(
  shown: ShownDestination,
  seed: Row,
  factory: string,
): string[] {
  const mismatches: string[] = [];
  if (shown.href !== decisionHref(seed, factory))
    mismatches.push('destination URL differs from the seed');
  if (shown.factory !== factory) mismatches.push('destination header names a different factory');
  const [target] = shown.targets;
  if (
    shown.targets.length !== 1 ||
    target?.pin !== seed.pin_sha ||
    target?.digest !== seed.digest
  ) {
    mismatches.push('destination does not identify exactly the named pin and digest');
  }
  if (!target?.visible || !target.highlighted)
    mismatches.push('named destination is not visible and highlighted');
  if (!target?.text.includes(String(seed.pin_sha).slice(0, 8)))
    mismatches.push('named pin is not displayed');
  if (seed.digest === null) {
    if (target?.kind !== 'pending' || !target.text.includes('Not yet run'))
      mismatches.push('unused pin is not shown as NOT YET RUN');
  } else if (!target?.text.includes(String(seed.digest).slice(0, 19))) {
    mismatches.push('named digest is not displayed');
  }
  if (shown.selected !== 0) mismatches.push('decision navigation changed comparison selection');
  return mismatches;
}

async function observeDecisionDestination(page: Page): Promise<ShownDestination> {
  if (
    !(await page.evaluate<boolean>(
      pageWait(
        `document.querySelector('${VERSIONS}[data-state="ready"]') !== null && document.querySelector('header ${PANEL}[data-state="ready"]') !== null`,
        READY_WAIT_MS,
      ),
    ))
  ) {
    throw new Error('versions destination did not become ready');
  }
  // Let the destination's scroll effect paint before measuring its viewport position.
  await page.evaluate(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  return page.evaluate<ShownDestination>(`({
    href: location.pathname + location.search,
    factory: document.querySelector('header ${PANEL} span')?.textContent ?? null,
    selected: document.querySelectorAll('${ENTRY} button[aria-pressed="true"]').length,
    targets: [...document.querySelectorAll('${ENTRY}[aria-current="true"]')].map(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { pin: el.getAttribute('data-pin'), digest: el.getAttribute('data-digest'),
        kind: el.getAttribute('data-kind'), text: el.textContent,
        visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && style.visibility === 'visible' && style.display !== 'none',
        highlighted: style.boxShadow !== 'none' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' };
    })
  })`);
}

export async function decisionDestinations(
  page: Page,
  db: Db,
  factory: string,
  base: string,
  outDir: string,
): Promise<string[]> {
  const failures: string[] = [];
  const report: string[] = [];
  const seeds = await db.query(DECISION_DESTINATIONS_SQL, [factory]);
  if (new Set(seeds.filter((s) => s.digest !== null).map((s) => s.pin_sha)).size < 2)
    failures.push('fewer than two distinct joined pins exercised');
  if (!seeds.some((s) => s.pin_sha !== null && s.digest === null))
    failures.push('no unused pin decision exercised');
  if (!seeds.some((s) => s.pin_sha === null)) failures.push('no unmatched decision exercised');
  for (const width of [1440, 390]) {
    for (const [i, seed] of seeds.entries()) {
      for (const mode of seed.pin_sha === null ? ['click'] : ['click', 'direct']) {
        const label = `${factory} ${width}px ${mode} decision ${i + 1} (${seed.title})`;
        try {
          await page.setViewport(width);
          await page.goto(`${base}/f/${encodeURIComponent(factory)}/decisions`);
          if (
            !(await page.evaluate<boolean>(
              pageWait(
                `document.querySelector('[data-live="decisions-timeline"][data-state="ready"]') !== null`,
                READY_WAIT_MS,
              ),
            ))
          ) {
            throw new Error('timeline did not become ready');
          }
          const decisions = await page.evaluate<ShownDecision[]>(decisionsOnScreen);
          const index = decisions.findIndex((d) => d.date === seed.date && d.title === seed.title);
          failures.push(
            ...compareDecision(decisions[index], seed, factory).map((m) => `${label}: ${m}`),
          );
          if (seed.pin_sha === null) {
            report.push(`${label}: ${JSON.stringify(decisions[index])}`);
            continue;
          }
          const copiedHref = decisions[index]?.href ?? null;
          if (mode === 'direct') {
            if (copiedHref === null) throw new Error('no destination URL to copy');
            await page.goto(`${base}${copiedHref}`);
          } else {
            await page.evaluate(
              `document.querySelectorAll('${DECISION}')[${index}].querySelector('[data-version-link]').click()`,
            );
          }
          const shown = await observeDecisionDestination(page);
          failures.push(
            ...compareDecisionDestination(shown, seed, factory).map((m) => `${label}: ${m}`),
          );
          report.push(
            `${label}: expected ${decisionHref(seed, factory)}\n  ${JSON.stringify(shown)}`,
          );
          const screenshot = await page.screenshot(width);
          writeFileSync(
            join(outDir, `decision-destination-${i + 1}-${width}-${mode}.png`),
            screenshot,
          );
          if (width === 1440 && mode === 'click') {
            writeFileSync(join(outDir, `decision-destination-${i + 1}.png`), screenshot);
          }
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`);
        }
      }
    }
  }
  try {
    writeFileSync(
      join(outDir, 'decision-destinations-check.txt'),
      [...report, ...failures, `mismatches: ${failures.length}`].join('\n'),
    );
  } catch (error) {
    failures.push(`${factory} destination report: ${(error as Error).message}`);
  }
  return failures;
}

/** Runs after timing: the second factory's matching laps must not change earlier seed counts. */
export async function decisionDestinationPhase(
  open: () => Promise<Page>,
  db: Db,
  factory: string,
  base: string,
  outDir: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const name of [factory, SECOND_FACTORY.name]) {
    let page: Page | undefined;
    const added: { run: string; digest: string }[] = [];
    try {
      if (name === SECOND_FACTORY.name) {
        const versions = await db.query(
          'SELECT digest, first_run_at FROM mc.versions WHERE factory = $1 ORDER BY first_run_at',
          [factory],
        );
        await db.transaction(async (tx) => {
          for (const version of versions) {
            const run = crypto.randomUUID();
            added.push({ run, digest: String(version.digest) });
            await tx.query(
              `INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
               VALUES ($1, $2, 'archon-loop', 'completed', $3, $4)`,
              [run, name, version.digest, version.first_run_at],
            );
            await tx.query('SELECT mc.project_version($1, $2)', [name, version.digest]);
          }
        });
      }
      const dir = name === factory ? outDir : join(outDir, encodeURIComponent(name));
      mkdirSync(dir, { recursive: true });
      page = await open();
      failures.push(...(await decisionDestinations(page, db, name, base, dir)));
    } catch (error) {
      failures.push(`${name} destination phase: ${(error as Error).message}`);
    } finally {
      try {
        await page?.close();
      } catch (error) {
        failures.push(`${name} destination close: ${(error as Error).message}`);
      }
      try {
        await db.transaction(async (tx) => {
          for (const { run, digest } of added) {
            await tx.query('DELETE FROM mc.laps WHERE run_id = $1', [run]);
            await tx.query('SELECT mc.project_version($1, $2)', [name, digest]);
          }
        });
      } catch (error) {
        failures.push(`${name} destination fixture cleanup: ${(error as Error).message}`);
      }
    }
  }
  return failures;
}

const ledgerOnScreen = `[...document.querySelectorAll('${LEDGER} [data-ledger-entry]')].map((li) => ({
  group: li.closest('[data-ledger-group]')?.getAttribute('data-ledger-group') ?? null,
  pin: li.getAttribute('data-pin'),
  laps: li.getAttribute('data-laps'),
  waiting: li.getAttribute('data-waiting'),
  verdict: li.getAttribute('data-verdict'),
  sentence: li.getAttribute('data-sentence'),
}))`;

/** V2's laps still waiting, computed apart from the live query: its laps come from mc.versions. */
const V2_WAITING_SQL = `SELECT p.sha, substring(p.measure from 'at least ([0-9]+)')::int AS wanted, n.laps,
  greatest(0, substring(p.measure from 'at least ([0-9]+)')::int - n.laps) AS waiting
FROM mc.pins p, (
  SELECT count(*)::int AS laps FROM mc.laps l
  JOIN mc.versions v ON v.factory = l.factory AND v.digest = l.digest
  WHERE l.factory = $1 AND l.workflow_name = 'archon-loop' AND v.pin_sha = $2
) n
WHERE p.sha = $2`;

/**
 * The decisions screen against the seed, read before anything is written: the timeline is the
 * seed's decisions in date order with the joined ones linked to the versions screen, V2 waits for
 * the laps V2_WAITING_SQL computes, and V1 shows `helped` with its sentence.
 */
async function seedDecisionMismatches(
  page: Page,
  db: Db,
  factory: string,
): Promise<{ mismatches: string[]; report: string; v2: string }> {
  const decisions = await page.evaluate<ShownDecision[]>(decisionsOnScreen);
  const ledgerShown = await page.evaluate<ShownLedgerEntry[]>(ledgerOnScreen);
  const seedDecisions = await db.query(DECISION_DESTINATIONS_SQL, [factory]);
  const pins = await db.query('SELECT sha, archon_sha FROM mc.pins ORDER BY committed_at');
  const [v1, v2, v3] = pins.map((p) => String(p.sha));
  const v3Archon = String(pins[2]?.archon_sha);
  const [v2Sql] = await db.query(V2_WAITING_SQL, [factory, v2]);
  const [v1Verdict] = await db.query(
    `SELECT verdict, sentence FROM mc.verdicts WHERE $1 LIKE pin || '%' ORDER BY committed_at DESC LIMIT 1`,
    [v1],
  );

  const mismatches: string[] = [];
  if (decisions.length !== seedDecisions.length) {
    mismatches.push(
      `the timeline shows ${decisions.length} entries, the seed has ${seedDecisions.length}`,
    );
  }
  seedDecisions.forEach((seed, i) => {
    mismatches.push(
      ...compareDecision(decisions[i], seed, factory).map((m) => `decision ${i + 1} ${m}`),
    );
  });
  const joined = decisions.flatMap((d) => (d.link === null ? [] : [d.link]));
  if (joined.length !== 3 || ![v1, v2, v3].every((pin) => joined.includes(pin))) {
    mismatches.push(`the joined decisions link to ${joined.join(', ')}, expected V1, V2 and V3`);
  }
  // V3's decision names it by its Archon sha, as `DECISIONS.md` does (#178).
  const byArchon = seedDecisions.find(
    (d) => d.version !== 'none' && v3Archon.startsWith(String(d.version)),
  );
  const byArchonShown = decisions.find((d) => d.title === byArchon?.title);
  if (byArchon === undefined || byArchonShown?.link !== v3) {
    mismatches.push(
      `the decision naming V3's Archon sha ${v3Archon.slice(0, 8)} links to ${byArchonShown?.link ?? 'nothing'}, expected V3`,
    );
  }
  const v2Shown = ledgerShown.find((e) => e.pin === v2);
  if (v2Shown?.group !== 'testing') {
    mismatches.push(`V2 is under ${v2Shown?.group ?? 'nothing'}, expected testing`);
  }
  if (v2Sql?.waiting === null || v2Shown?.waiting !== String(v2Sql?.waiting)) {
    mismatches.push(`V2 waits for ${v2Shown?.waiting} laps on screen, ${v2Sql?.waiting} by SQL`);
  }
  const v1Shown = ledgerShown.find((e) => e.pin === v1);
  if (
    v1Shown?.group !== 'verdicts' ||
    v1Shown.verdict !== 'helped' ||
    v1Verdict?.verdict !== 'helped' ||
    v1Shown.sentence !== v1Verdict?.sentence
  ) {
    mismatches.push(
      `V1 shows ${JSON.stringify(v1Shown)}, expected verdicts, helped, ${JSON.stringify(v1Verdict)}`,
    );
  }
  const report = [
    'timeline on screen:',
    ...decisions.map((d) => `  ${JSON.stringify(d)}`),
    'seed decisions by date (mc.decisions, version joined to mc.pins by prefix):',
    ...seedDecisions.map((d) => `  ${JSON.stringify(d)}`),
    'ledger on screen:',
    ...ledgerShown.map((e) => `  ${JSON.stringify(e)}`),
    `V1 = ${v1}, V2 = ${v2}, V3 = ${v3} (Archon ${v3Archon}) (seed pins by commit)`,
    `V2 laps waiting by SQL ($1 = ${factory}, $2 = V2):`,
    ...V2_WAITING_SQL.split('\n').map((line) => `  ${line}`),
    `  -> ${JSON.stringify(v2Sql)}`,
    `V2 laps waiting on screen: ${v2Shown?.waiting ?? 'absent'}`,
    `V1 verdict in mc.verdicts: ${JSON.stringify(v1Verdict)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report, v2 };
}

/**
 * The decisions screen: the seed's timeline and ledger, a verdict and a decision timed to it
 * before and after the hold, and, once every write is timed, each decision's destination.
 */
export function decisionsPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const decisionTimings: DecisionsTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(DECISION_QUERIES),
    verdictToScreenMs: null,
    decisionToScreenMs: null,
    holdSeconds,
    renewals: { 'decisions-timeline': null, 'improvements-ledger': null },
    afterHoldVerdictToScreenMs: null,
    afterHoldDecisionToScreenMs: null,
    noReload: null,
    limits: LIMITS,
  };
  const judgedBy: string[] = [];
  const decided: string[] = [];
  let decisionsPage: Page | undefined;
  let timelineLength = 0;
  const latestVerdict = async () => {
    const [row] = await db.query('SELECT sha FROM mc.verdicts ORDER BY committed_at DESC LIMIT 1');
    judgedBy.push(String(row.sha));
  };
  const fixtureDecisions = async () =>
    (await db.query(`SELECT title FROM mc.decisions WHERE title LIKE 'Fixture decision %'`)).map(
      (row) => String(row.title),
    );
  const newDecisions = async (before: readonly string[]) => {
    for (const title of await fixtureDecisions()) {
      if (!before.includes(title) && !decided.includes(title)) decided.push(title);
    }
  };

  return {
    async write() {
      const { base } = ctx;
      const page = await openPage(deps.env);
      decisionsPage = page;
      await page.goto(`${base}/f/${factory}/decisions`);
      await page.evaluate('window.__mcNoReload = true');
      const decisionsReady = await page.evaluate<boolean>(
        pageWait(
          DECISION_QUERIES.map(
            (q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`,
          ).join(' && '),
          READY_WAIT_MS,
        ),
      );
      if (!decisionsReady) {
        throw new Error(
          `the decisions screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(decisionTimings, groupTimings(await measure(page, DECISION_QUERIES)));
      const decisionSeed = await seedDecisionMismatches(page, db, factory);
      writeFileSync(join(outDir, 'ledger-check.txt'), `${decisionSeed.report}\n`);
      ctx.failures.push(
        ...decisionSeed.mismatches.map((m) => `decisions screen against the seed: ${m}`),
      );
      writeFileSync(join(outDir, 'decisions-ledger.png'), await page.screenshot(1440));

      const v2Pin = decisionSeed.v2;
      decisionTimings.verdictToScreenMs = await writeToScreen(
        page,
        deps,
        ['verdict', '--pin', v2Pin.slice(0, 8)],
        `${inLedger('verdicts', v2Pin)} && !(${inLedger('testing', v2Pin)})`,
      );
      await latestVerdict();
      timelineLength = await page.evaluate<number>(
        `document.querySelectorAll('${DECISION}').length`,
      );
      const decisionsBefore = await fixtureDecisions();
      decisionTimings.decisionToScreenMs = await writeToScreen(
        page,
        deps,
        ['decision'],
        `document.querySelectorAll('${DECISION}').length === ${timelineLength + 1}`,
      );
      await newDecisions(decisionsBefore);
      deps.out(
        `V2's verdict reached the ledger in ${decisionTimings.verdictToScreenMs ?? 'never'} ms, a decision the timeline in ${decisionTimings.decisionToScreenMs ?? 'never'} ms`,
      );
    },

    async afterHold() {
      const page = required(decisionsPage, 'decisions page');
      for (const q of DECISION_QUERIES) {
        decisionTimings.renewals[q] = await page.evaluate<number>(
          `performance.getEntriesByName('live:${q}:renewed').length`,
        );
      }
      // The second verdict judges the newest pin: the versions screen wrote it, so it is being tested.
      const [newest] = await db.query('SELECT sha FROM mc.pins ORDER BY committed_at DESC LIMIT 1');
      const judged = String(newest.sha);
      decisionTimings.afterHoldVerdictToScreenMs = await writeToScreen(
        page,
        deps,
        ['verdict', '--pin', judged],
        `${inLedger('verdicts', judged)} && !(${inLedger('testing', judged)})`,
      );
      await latestVerdict();
      const decisionsBeforeHold = await fixtureDecisions();
      decisionTimings.afterHoldDecisionToScreenMs = await writeToScreen(
        page,
        deps,
        ['decision'],
        `document.querySelectorAll('${DECISION}').length === ${timelineLength + 2}`,
      );
      await newDecisions(decisionsBeforeHold);
      decisionTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      decisionsPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      ctx.failures.push(
        ...(await decisionDestinationPhase(() => openPage(deps.env), db, factory, base, outDir)),
      );
      designProbe(
        `${base}/f/${factory}/decisions`,
        'decisions-ledger-design-probe.json',
        'the decisions screen',
      );
    },

    async close() {
      decisionTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'decisions-ledger-timings.json'),
        `${JSON.stringify(decisionTimings, null, 2)}\n`,
      );
      await decisionsPage?.close().catch(() => undefined);
    },

    async cleanup() {
      try {
        if (judgedBy.length > 0) {
          await db.query('DELETE FROM mc.verdicts WHERE sha = ANY($1::text[])', [
            `{${judgedBy.join(',')}}`,
          ]);
        }
        for (const title of decided) {
          await db.query('DELETE FROM mc.decisions WHERE title = $1', [title]);
        }
        return [];
      } catch (err) {
        return [`removing the written verdicts and decisions failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('decisions screen', decisionTimings, LIMITS.readyMs));
      for (const q of DECISION_QUERIES) {
        failures.push(...groupPerformanceFailures([q], decisionTimings));
        if (holdSeconds >= 180 && (decisionTimings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
          failures.push(
            `${decisionTimings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
          );
        }
      }
      for (const [reading, screen, ms] of [
        ["V2's verdict", 'the ledger', decisionTimings.verdictToScreenMs],
        ['a decision', 'the timeline', decisionTimings.decisionToScreenMs],
        [
          `a verdict after ${holdSeconds}s`,
          'the ledger',
          decisionTimings.afterHoldVerdictToScreenMs,
        ],
        [
          `a decision after ${holdSeconds}s`,
          'the timeline',
          decisionTimings.afterHoldDecisionToScreenMs,
        ],
      ] as const) {
        failures.push(...lateWrite(reading, screen, ms));
      }
      if (decisionTimings.noReload !== true) failures.push('the decisions screen reloaded');
      return failures;
    },

    summary: () => [`decisions: ${JSON.stringify(decisionTimings)}`],
  };
}
