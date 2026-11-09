import type { UnstickRow } from '../../app/lib/attention';
import {
  ATTENTION_SOURCES,
  retriageCommand,
  unstickCards,
  unstickKey,
} from '../../app/lib/attention-page';
import { openPage, type Page } from '../lib/cdp';
import type { Row } from '../lib/db';
import {
  expectedItems,
  itemsOnScreen,
  labelToScreen,
  OPEN_NEEDS_OWNER_SQL,
  OPEN_QUESTIONS_SQL,
  ownerMismatches,
  type ShownOwnerItem,
} from './owner';
import {
  LIMITS,
  type LiveContext,
  type LiveOutput,
  type LivePhase,
  lateWrite,
  liveOutputs,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  renewalsOf,
  required,
  screenAgainstSql,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

const QUERIES = Object.values(ATTENTION_SOURCES).map((s) => s.query);
type PerQuery = Record<string, number | null>;

interface AttentionTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  labelToScreen: { issue: number; ms: number | null } | null;
  holdSeconds: number;
  renewals: PerQuery;
  afterHoldLabelToScreen: { issue: number; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** One card of the page as the screen shows it. */
export interface ShownCard {
  id: string | null;
  kind: string | null;
  console: string | null;
  /** The choices that carry the "recommended" mark. */
  recommended: string[];
  /** The command a copy button holds. */
  command: string | null;
  waited: string | null;
}

/** The cards that carry `data-attention-item`; the old loop's owner items are read apart, by owner.ts. */
const cardsOnScreen = `[...document.querySelectorAll('main [data-attention-item]')].map((card) => ({
  id: card.getAttribute('data-attention-item'),
  kind: card.getAttribute('data-attention-kind'),
  console: card.getAttribute('data-console'),
  recommended: [...card.querySelectorAll('[data-choice][data-recommended]')]
    .map((choice) => choice.getAttribute('data-choice')),
  command: card.querySelector('[data-command]')?.getAttribute('data-command') ?? null,
  waited: card.querySelector('[data-waited]')?.textContent ?? null,
}))`;

/** Every card on the page, owner items included, and the number the head says. */
const cardCount = `document.querySelectorAll('main [data-attention-kind]').length`;
const headCount = `(() => {
  const el = document.querySelector('main [data-attention-count]');
  return el === null ? null : Number(el.getAttribute('data-attention-count'));
})()`;

/** The tab badge's own panels, named apart from the page's panels of the same queries. */
const BADGE_PANELS = QUERIES.map((q) => `nav [data-live="attention-count:${q}"]`);

/** The Attention tab's count, or null when no count is drawn. */
const tabCount = `(() => {
  const el = document.querySelector('nav [data-attention-count]');
  return el === null ? null : Number(el.getAttribute('data-attention-count'));
})()`;

/**
 * Elements under `main` whose computed color, background or border is one of the amber tokens, by
 * resolving each token through a probe element so the comparison is between computed colors.
 */
const amberOnScreen = `(() => {
  const resolve = (token) => {
    if (getComputedStyle(document.documentElement).getPropertyValue(token).trim() === '') return null;
    const probe = document.createElement('span');
    probe.style.color = 'var(' + token + ')';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  };
  const amber = ['--warning', '--warning-strong'].map(resolve).filter((c) => c !== null);
  const found = [];
  for (const el of document.querySelectorAll('main *')) {
    const style = getComputedStyle(el);
    for (const property of ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor']) {
      if (amber.includes(style[property])) found.push(el.tagName.toLowerCase() + ' ' + property + ' ' + (el.className?.toString?.() ?? ''));
    }
  }
  return found;
})()`;

/** The seed's attention items read from Archon's rows, apart from mc.attention_items. */
const ARCHON_ATTENTION_SQL = `SELECT r.id::text AS run
  FROM public.remote_agent_workflow_runs r
  JOIN public.remote_agent_codebases c ON c.id = r.codebase_id
  JOIN mc.factories f ON f.codebase = c.name
  WHERE f.name = $1 AND r.status = 'paused' AND r.metadata->'wait'->>'kind' = 'attention'
    AND NOT (r.metadata->'wait' ? 'answer') AND NOT (r.metadata ? 'source_release')
  ORDER BY 1`;

/** The projected items, with the console and the recommendation when it is one of the options, read apart from the query. */
const PROJECTED_ATTENTION_SQL = `SELECT a.run_id::text AS run, f.console,
    CASE WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(a.options::jsonb) o WHERE o->>'id' = a.recommended
    ) THEN a.recommended END AS recommended
  FROM mc.attention_items a JOIN mc.factories f ON f.name = a.factory
  WHERE a.factory = $1 ORDER BY 1`;

/** The failure signatures, read apart from failure-groups.sql. */
const FAILED_SIGNATURES_SQL = `SELECT DISTINCT signature FROM mc.run_stops
  WHERE factory = $1 AND status = 'failed' ORDER BY 1`;

const consoleOf = (console: unknown, run: string) =>
  `${String(console).replace(/\/+$/, '')}/console/r/${run}`;

const idsOf = (shown: readonly ShownCard[], kind: string) =>
  shown
    .filter((s) => s.kind === kind)
    .map((s) => String(s.id))
    .sort();

/**
 * Where the Decide cards differ from SQL: the same runs, each exactly once, as Archon's own rows
 * say are open and as mc.attention_items holds, each linking to its run in the console, each
 * marking the choice the projection recommends.
 */
export function decideMismatches(shown: ShownCard[], archon: Row[], projected: Row[]): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  const ids = (values: Row[]) => values.map((v) => String(v.run)).sort();
  same('Decide cards', idsOf(shown, 'decide'), ids(projected));
  same("Decide cards against Archon's open attention waits", ids(projected), ids(archon));
  for (const card of shown.filter((s) => s.kind === 'decide')) {
    const want = projected.find((p) => String(p.run) === card.id);
    if (want === undefined) continue;
    same(`${card.id} console link`, card.console, consoleOf(want.console, String(card.id)));
    same(`${card.id} recommended`, card.recommended, want.recommended ? [want.recommended] : []);
    if (card.waited === null || card.waited === 'not recorded') {
      mismatches.push(`${card.id} shows no wait`);
    }
  }
  if (projected.length === 0) mismatches.push('the seed has no open attention item');
  if (!projected.some((p) => p.recommended)) {
    mismatches.push('no seeded attention item recommends a choice');
  }
  return mismatches;
}

/** Where the Fix cards differ from the failed runs' signatures: one card each, exactly once. */
export function fixMismatches(shown: ShownCard[], signatures: Row[]): string[] {
  const mismatches: string[] = [];
  screenAgainstSql(mismatches)(
    'Fix cards',
    idsOf(shown, 'fix'),
    signatures.map((r) => String(r.signature)).sort(),
  );
  return mismatches;
}

/**
 * Where the Unstick cards differ from the unstick query's rows, keyed as the page keys them, and
 * each re-triage card's copied command from the exact one for its item.
 */
export function unstickMismatches(
  shown: ShownCard[],
  rows: UnstickRow[],
  factory: string,
): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  same(
    'Unstick cards',
    idsOf(shown, 'unstick'),
    unstickCards(rows, factory)
      .map((c) => c.key)
      .sort(),
  );
  for (const row of rows) {
    if (row.action !== 'retriage' || row.number === null) continue;
    const card = shown.find((s) => s.kind === 'unstick' && s.id === unstickKey(row));
    if (card === undefined) continue;
    same(
      `#${row.number} re-triage command`,
      card.command,
      retriageCommand(row.repository, row.number),
    );
  }
  return mismatches;
}

/** The head, the cards on screen and the tab badge must say one number. */
export function countMismatches(
  head: number | null,
  cards: number,
  badge: number | null,
): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  same('head count', head, cards);
  same('tab count', badge, cards === 0 ? null : cards);
  return mismatches;
}

const FILES = liveOutputs({
  check: 'attention-check.txt',
  shot: 'attention.png',
  phone: 'attention-390.png',
  probe: 'attention-design-probe.json',
  timings: 'attention-timings.json',
});
export const ATTENTION_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/**
 * The Attention page: the seed's questions, owner items, stuck work and failure signatures against
 * SQL, the head and the tab's count against the cards shown, and `fixture:write label` timed to it
 * before and after the hold.
 */
export function attentionPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, holdSeconds, branch, measure, queries } = ctx;
  const timings: AttentionTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(QUERIES),
    labelToScreen: null,
    holdSeconds,
    renewals: Object.fromEntries(QUERIES.map((q) => [q, null])),
    afterHoldLabelToScreen: null,
    noReload: null,
    limits: LIMITS,
  };
  const labelled: number[] = [];
  const removeLabels = async (): Promise<string[]> => {
    try {
      if (labelled.length > 0) {
        await db.query(
          `DELETE FROM mc.issue_labels
           WHERE factory = $1 AND label = 'needs-owner' AND issue_number = ANY($2::int[])`,
          [factory, `{${labelled.join(',')}}`],
        );
        labelled.length = 0;
      }
      return [];
    } catch (err) {
      return [`removing the attention page's labels failed: ${(err as Error).message}`];
    }
  };
  let attentionPage: Page | undefined;
  const url = () => `${ctx.base}/f/${encodeURIComponent(factory)}`;

  return {
    /** On the untouched seed: every item waiting on the owner. */
    async open() {
      const page = await openPage(deps.env);
      attentionPage = page;
      await page.goto(url());
      await page.evaluate('window.__mcNoReload = true');
      const ready = await page.evaluate<boolean>(
        pageWait(
          [...QUERIES.map((q) => `[data-live="${q}"]`), ...BADGE_PANELS]
            .map((p) => `document.querySelector('${p}[data-state="ready"]') !== null`)
            .join(' && '),
          READY_WAIT_MS,
        ),
      );
      if (!ready) {
        throw new Error(
          `the attention page did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(timings, groupTimings(await measure(page, QUERIES)));
      const cards = await page.evaluate<ShownCard[]>(cardsOnScreen);
      const owner = await page.evaluate<ShownOwnerItem[]>(itemsOnScreen);
      const onScreen = await page.evaluate<number>(cardCount);
      const head = await page.evaluate<number | null>(headCount);
      const badge = await page.evaluate<number | null>(tabCount);
      const amber = await page.evaluate<string[]>(amberOnScreen);

      const archon = await db.query(ARCHON_ATTENTION_SQL, [factory]);
      const projected = await db.query(PROJECTED_ATTENTION_SQL, [factory]);
      const signatures = await db.query(FAILED_SIGNATURES_SQL, [factory]);
      const stuck = (await db.query(queries.get('unstick') as string, [
        factory,
      ])) as unknown as UnstickRow[];
      const issues = await db.query(OPEN_NEEDS_OWNER_SQL, [factory]);
      const questions = await db.query(OPEN_QUESTIONS_SQL, [factory]);

      const mismatches = [
        ...decideMismatches(cards, archon, projected),
        ...fixMismatches(cards, signatures),
        ...unstickMismatches(cards, stuck, factory),
        ...ownerMismatches(owner, expectedItems(issues, questions)),
        ...countMismatches(head, onScreen, badge),
      ];
      for (const element of amber) mismatches.push(`the page renders amber: ${element}`);
      ctx.save(
        FILES.check,
        [
          'recount, page against SQL:',
          `cards: ${cards.length}, Decide ${idsOf(cards, 'decide').length} against mc.attention_items ${projected.length} and Archon's open attention waits ${archon.length}`,
          ...cards.map((c) => `  ${JSON.stringify(c)}`),
          `Fix: ${idsOf(cards, 'fix').length} against ${signatures.length} failure signatures`,
          `Unstick: ${idsOf(cards, 'unstick').length} against ${stuck.length} rows`,
          `owner items: ${owner.length}, open needs-owner issues ${issues.length} plus open questions ${questions.length}`,
          ...owner.map((o) => `  ${o.id}`),
          `head count: ${head}, cards on screen: ${onScreen}, tab count: ${badge}`,
          `amber elements in main: ${amber.length}`,
          ...mismatches,
          `mismatches: ${mismatches.length}`,
          '',
        ].join('\n'),
      );
      ctx.failures.push(...mismatches.map((m) => `attention page against the seed: ${m}`));
      ctx.save(FILES.phone, await page.screenshot(390));
      ctx.save(FILES.shot, await page.screenshot(1440));
    },

    async write() {
      timings.labelToScreen = await labelToScreen(
        required(attentionPage, 'attention page'),
        db,
        deps,
        factory,
        labelled,
      );
      deps.out(
        `first label reached the attention page in ${timings.labelToScreen.ms ?? 'never'} ms`,
      );
      ctx.failures.push(...(await removeLabels()));
    },

    async afterHold() {
      const page = required(attentionPage, 'attention page');
      for (const q of QUERIES) timings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      timings.afterHoldLabelToScreen = await labelToScreen(page, db, deps, factory, labelled);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      attentionPage = undefined;
      // The issues phase labels the highest-numbered issue without needs-owner: leave it waiting.
      ctx.failures.push(...(await removeLabels()));
    },

    async probe(designProbe) {
      designProbe(url(), FILES.probe, 'the attention page');
    },

    async close() {
      timings.port = ctx.port;
      ctx.save(FILES.timings, `${JSON.stringify(timings, null, 2)}\n`);
      await attentionPage?.close().catch(() => undefined);
    },

    cleanup: removeLabels,

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('attention page', timings, LIMITS.readyMs));
      failures.push(...groupPerformanceFailures(QUERIES, timings));
      for (const [when, write] of [
        ['first', timings.labelToScreen],
        [`after ${holdSeconds}s`, timings.afterHoldLabelToScreen],
      ] as const) {
        failures.push(...lateWrite(`label ${when}`, 'the attention page', write?.ms));
      }
      if (holdSeconds >= 180) {
        for (const q of QUERIES) {
          if ((timings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
            failures.push(
              `${timings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
            );
          }
        }
      }
      if (timings.noReload !== true) failures.push('the attention page reloaded');
      return failures;
    },

    summary: () => [`attention: ${JSON.stringify(timings)}`],
  };
}
