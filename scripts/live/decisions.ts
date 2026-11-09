import { openPage, type Page } from '../lib/cdp';
import type { Row } from '../lib/db';
import {
  controlsOnScreen,
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

const QUERIES = ['attention-items', 'owner-queue'] as const;
type PerQuery = Record<(typeof QUERIES)[number], number | null>;

interface DecisionsTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  labelToScreen: { issue: number; ms: number | null } | null;
  holdSeconds: number;
  renewals: PerQuery;
  afterHoldLabelToScreen: { issue: number; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** One attention panel as the screen shows it. */
export interface ShownAttention {
  id: string | null;
  href: string | null;
  /** The choices that carry the "recommended" chip. */
  recommended: string[];
  waited: string | null;
}

const ATTENTION = '[data-live="attention-items"] [data-attention-item]';

const attentionOnScreen = `[...document.querySelectorAll('${ATTENTION}')].map((li) => ({
  id: li.getAttribute('data-attention-item'),
  href: li.querySelector('a[data-console]')?.getAttribute('href') ?? null,
  recommended: [...li.querySelectorAll('[data-choice]')]
    .filter((choice) => choice.querySelector('[data-recommended]') !== null)
    .map((choice) => choice.getAttribute('data-choice')),
  waited: li.querySelector('[data-waited]')?.textContent ?? null,
}))`;

/** The tab badge's own panels, named apart from the screen's panels of the same queries. */
const BADGE_PANELS = [
  'nav [data-live="decisions-count:attention-items"]',
  'nav [data-live="decisions-count:owner-queue"]',
];

/** The Decisions tab's count, or null when no count is drawn. */
const tabCount = `(() => {
  const el = document.querySelector('nav [data-decisions-count]');
  return el === null ? null : Number(el.getAttribute('data-decisions-count'));
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

/** The projected items, with the console and the choice their message recommends, read apart from the query. */
const PROJECTED_ATTENTION_SQL = `SELECT a.run_id::text AS run, f.console,
    substring(a.message from 'Recommendation: \`([^\`]+)\`') AS recommended
  FROM mc.attention_items a JOIN mc.factories f ON f.name = a.factory
  WHERE a.factory = $1 ORDER BY 1`;

const consoleOf = (console: unknown, run: string) =>
  `${String(console).replace(/\/+$/, '')}/console/r/${run}`;

/**
 * Where the attention panels differ from SQL: the same runs as Archon's own rows say are open and
 * as mc.attention_items holds, each linking to its run in the console, each marking the choice its
 * message recommends.
 */
export function attentionMismatches(
  shown: ShownAttention[],
  archon: Row[],
  projected: Row[],
): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  const ids = <T>(values: T[]) => [...values].sort();
  same('attention items', ids(shown.map((s) => s.id)), ids(projected.map((p) => String(p.run))));
  same(
    "attention items against Archon's open attention waits",
    ids(projected.map((p) => String(p.run))),
    ids(archon.map((a) => String(a.run))),
  );
  for (const item of shown) {
    const want = projected.find((p) => String(p.run) === item.id);
    if (want === undefined) continue;
    same(`${item.id} console link`, item.href, consoleOf(want.console, String(item.id)));
    same(`${item.id} recommended`, item.recommended, want.recommended ? [want.recommended] : []);
    if (item.waited === null || item.waited === 'not recorded') {
      mismatches.push(`${item.id} shows no wait`);
    }
  }
  if (projected.length === 0) mismatches.push('the seed has no open attention item');
  if (!projected.some((p) => p.recommended)) {
    mismatches.push('no seeded attention item recommends a choice');
  }
  return mismatches;
}

const FILES = liveOutputs({
  check: 'decisions-check.txt',
  shot: 'decisions.png',
  probe: 'decisions-design-probe.json',
  timings: 'decisions-timings.json',
});
export const DECISIONS_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/**
 * The Decisions screen: the seed's attention items and owner items against SQL, the tab's
 * count against the items shown, and `fixture:write label` timed to it before and after the hold.
 */
export function decisionsPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, holdSeconds, branch, measure } = ctx;
  const timings: DecisionsTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(QUERIES),
    labelToScreen: null,
    holdSeconds,
    renewals: {
      'attention-items': null,
      'owner-queue': null,
    },
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
      return [`removing the decisions screen's labels failed: ${(err as Error).message}`];
    }
  };
  let decisionsPage: Page | undefined;
  const url = () => `${ctx.base}/f/${encodeURIComponent(factory)}`;

  return {
    /** On the untouched seed: every item waiting on the owner. */
    async open() {
      const page = await openPage(deps.env);
      decisionsPage = page;
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
          `the decisions screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(timings, groupTimings(await measure(page, QUERIES)));
      const attention = await page.evaluate<ShownAttention[]>(attentionOnScreen);
      const owner = await page.evaluate<ShownOwnerItem[]>(itemsOnScreen);
      const count = await page.evaluate<number | null>(tabCount);
      const controls = await page.evaluate<string[]>(controlsOnScreen);
      const amber = await page.evaluate<string[]>(amberOnScreen);

      const archon = await db.query(ARCHON_ATTENTION_SQL, [factory]);
      const projected = await db.query(PROJECTED_ATTENTION_SQL, [factory]);
      const issues = await db.query(OPEN_NEEDS_OWNER_SQL, [factory]);
      const questions = await db.query(OPEN_QUESTIONS_SQL, [factory]);

      const mismatches = [
        ...attentionMismatches(attention, archon, projected),
        ...ownerMismatches(owner, expectedItems(issues, questions)),
      ];
      screenAgainstSql(mismatches)('tab count', count, attention.length + owner.length);
      for (const control of controls) mismatches.push(`the screen has a control: ${control}`);
      for (const element of amber) mismatches.push(`the screen renders amber: ${element}`);
      ctx.save(
        FILES.check,
        [
          'recount, screen against SQL:',
          `attention items: screen ${attention.length}, mc.attention_items ${projected.length}, Archon's open attention waits ${archon.length}`,
          ...attention.map((a) => `  ${JSON.stringify(a)}`),
          `owner items: screen ${owner.length}, open needs-owner issues ${issues.length} plus open questions ${questions.length}`,
          ...owner.map((o) => `  ${o.id}`),
          `tab count: ${count}`,
          `controls in main: ${controls.length}`,
          `amber elements in main: ${amber.length}`,
          ...mismatches,
          `mismatches: ${mismatches.length}`,
          '',
        ].join('\n'),
      );
      ctx.failures.push(...mismatches.map((m) => `decisions screen against the seed: ${m}`));
      ctx.save(FILES.shot, await page.screenshot(1440));
    },

    async write() {
      timings.labelToScreen = await labelToScreen(
        required(decisionsPage, 'decisions page'),
        db,
        deps,
        factory,
        labelled,
      );
      deps.out(
        `first label reached the decisions screen in ${timings.labelToScreen.ms ?? 'never'} ms`,
      );
      ctx.failures.push(...(await removeLabels()));
    },

    async afterHold() {
      const page = required(decisionsPage, 'decisions page');
      for (const q of QUERIES) timings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      timings.afterHoldLabelToScreen = await labelToScreen(page, db, deps, factory, labelled);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      decisionsPage = undefined;
      // The issues phase labels the highest-numbered issue without needs-owner: leave it waiting.
      ctx.failures.push(...(await removeLabels()));
    },

    async probe(designProbe) {
      designProbe(url(), FILES.probe, 'the decisions screen');
    },

    async close() {
      timings.port = ctx.port;
      ctx.save(FILES.timings, `${JSON.stringify(timings, null, 2)}\n`);
      await decisionsPage?.close().catch(() => undefined);
    },

    cleanup: removeLabels,

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('decisions screen', timings, LIMITS.readyMs));
      failures.push(...groupPerformanceFailures(QUERIES, timings));
      for (const [when, write] of [
        ['first', timings.labelToScreen],
        [`after ${holdSeconds}s`, timings.afterHoldLabelToScreen],
      ] as const) {
        failures.push(...lateWrite(`label ${when}`, 'the decisions screen', write?.ms));
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
      if (timings.noReload !== true) failures.push('the decisions screen reloaded');
      return failures;
    },

    summary: () => [`decisions: ${JSON.stringify(timings)}`],
  };
}
