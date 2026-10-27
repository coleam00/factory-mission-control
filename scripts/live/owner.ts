import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEXT_TO_LABEL } from '../fixture/write';
import { openPage, type Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import type { Db, Row } from '../lib/db';
import {
  LIMITS,
  type LiveContext,
  type LivePhase,
  lateWrite,
  pageWait,
  READY_WAIT_MS,
  RENEWALS_IN_180S,
  renewalsOf,
  required,
  screenAgainstSql,
  within,
  writeToScreen,
} from './shared';
import { emptyPanelTimings, type PanelTimings, performanceFailures } from './timings';

const OWNER = '[data-live="owner-queue"]';
const ITEM = `${OWNER} [data-owner-item]`;

interface OwnerQueueTimings extends PanelTimings {
  branch: string | null;
  port: number | null;
  /** The issue `fixture:write label` labelled, and how long the queue took to list it. */
  labelToScreen: { issue: number; ms: number | null } | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldLabelToScreen: { issue: number; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

/** One item as the screen shows it, read from the page. */
export interface ShownOwnerItem {
  id: string | null;
  title: string;
  href: string | null;
  options: { key: string | null; text: string; isDefault: boolean }[];
  recommendation: string | null;
  defaultOption: string | null;
  defaultAt: string | null;
  waitingSince: string | null;
  waited: string | null;
}

const itemsOnScreen = `[...document.querySelectorAll('${ITEM}')].map((li) => ({
  id: li.getAttribute('data-owner-item'),
  title: li.querySelector('[data-title]')?.textContent ?? '',
  href: li.querySelector('a[data-thread]')?.getAttribute('href') ?? null,
  options: [...li.querySelectorAll('[data-option]')].map((o) => ({
    key: o.getAttribute('data-option'),
    text: o.children[1]?.textContent ?? '',
    isDefault: o.hasAttribute('data-default'),
  })),
  recommendation: li.querySelector('[data-recommendation]')?.textContent ?? null,
  defaultOption: li.querySelector('[data-default-option]')?.textContent ?? null,
  defaultAt: li.querySelector('[data-default-at]')?.getAttribute('data-default-at') ?? null,
  waitingSince: li.getAttribute('data-waiting-since'),
  waited: li.querySelector('[data-waited]')?.textContent ?? null,
}))`;

/** Controls that could send something: the owner screen has none, only links to GitHub. */
const controlsOnScreen = `[...document.querySelectorAll('main form, main button, main input, main select, main textarea')].map((el) => el.outerHTML.slice(0, 120))`;

/** The seed's open needs-owner issues, read apart from db/queries/owner-queue.sql. */
const OPEN_NEEDS_OWNER_SQL = `SELECT i.number, i.title, i.url, i.updated_at FROM mc.issues i
  JOIN mc.issue_labels l ON l.factory = i.factory AND l.issue_number = i.number
  WHERE i.factory = $1 AND i.state = 'open' AND l.label = 'needs-owner' ORDER BY i.number`;

/** The seed's open owner questions with their issue's URL. */
const OPEN_QUESTIONS_SQL = `SELECT q.issue_number, q.question_number, q.question, q.options,
    q.recommendation, q.default_option, q.default_at, q.raised_at, i.url
  FROM mc.owner_questions q
  LEFT JOIN mc.issues i ON i.factory = q.factory AND i.number = q.issue_number
  WHERE q.factory = $1 AND q.closed_at IS NULL ORDER BY q.issue_number, q.question_number`;

const iso = (at: unknown) => (at instanceof Date ? at.toISOString() : null);

/** What the screen should show for each seed row, keyed by its item id. */
export function expectedItems(
  issues: Row[],
  questions: Row[],
): Map<string, Partial<ShownOwnerItem>> {
  const expected = new Map<string, Partial<ShownOwnerItem>>();
  for (const i of issues) {
    expected.set(`issue-${i.number}`, {
      title: String(i.title),
      href: String(i.url),
      options: [],
      waitingSince: iso(i.updated_at),
    });
  }
  for (const q of questions) {
    const options = (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) as {
      key: string;
      text: string;
    }[];
    expected.set(`question-${q.issue_number}-${q.question_number}`, {
      title: String(q.question),
      href: q.url === null ? null : String(q.url),
      options: options.map((o) => ({
        key: o.key,
        text: o.text,
        isDefault: o.key === q.default_option,
      })),
      recommendation: q.recommendation === null ? null : String(q.recommendation),
      defaultOption: q.default_option === null ? null : String(q.default_option),
      defaultAt: iso(q.default_at),
      waitingSince: iso(q.raised_at),
    });
  }
  return expected;
}

/** Where the screen differs from SQL over the seed: one line each. */
export function ownerMismatches(
  shown: ShownOwnerItem[],
  expected: Map<string, Partial<ShownOwnerItem>>,
): string[] {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  same('items', shown.map((s) => s.id).sort(), [...expected.keys()].sort());
  for (const item of shown) {
    const want = expected.get(item.id ?? '');
    if (want === undefined) continue;
    for (const key of Object.keys(want) as (keyof ShownOwnerItem)[]) {
      same(`${item.id} ${key}`, item[key], want[key]);
    }
    if (!item.href?.startsWith('https://github.com/')) {
      mismatches.push(`${item.id} links to ${item.href}, not a GitHub issue`);
    }
    if (item.waited === null || item.waited === 'not recorded') {
      mismatches.push(`${item.id} shows no wait`);
    }
  }
  const questions = [...expected.keys()].filter((id) => id.startsWith('question-'));
  if (questions.length === 0) mismatches.push('the seed has no open owner question');
  for (const id of questions) {
    const want = expected.get(id);
    if (!want?.options?.length || !want.recommendation || !want.defaultOption || !want.defaultAt) {
      mismatches.push(`seed question ${id} lacks options, recommendation, default or default date`);
    }
  }
  if (![...expected.keys()].some((id) => id.startsWith('issue-'))) {
    mismatches.push('the seed has no open needs-owner issue');
  }
  return mismatches;
}

/**
 * Runs `fixture:write label`, which labels the highest-numbered open issue without `needs-owner`,
 * and times it from the write's exit to that issue appearing in the queue.
 */
async function labelToScreen(
  page: Page,
  db: Db,
  deps: Deps,
  factory: string,
  labelled: number[],
): Promise<{ issue: number; ms: number | null }> {
  const [target] = await db.query(NEXT_TO_LABEL, [factory]);
  if (!target) throw new Error(`no open ${factory} issue for fixture:write label to label`);
  const issue = Number(target.number);
  const item = `${ITEM}[data-owner-item="issue-${issue}"]`;
  if (await page.evaluate<boolean>(`document.querySelector('${item}') !== null`)) {
    throw new Error(`#${issue} is in the owner queue before fixture:write label labels it`);
  }
  labelled.push(issue);
  const ms = await writeToScreen(
    page,
    deps,
    ['label'],
    `document.querySelector('${item}') !== null`,
  );
  return { issue, ms };
}

/** The owner queue: the seed's items against SQL, and `fixture:write label` timed to it. */
export function ownerPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const timings: OwnerQueueTimings = {
    branch,
    port: null,
    ...emptyPanelTimings(),
    labelToScreen: null,
    holdSeconds,
    renewals: null,
    afterHoldLabelToScreen: null,
    noReload: null,
    limits: LIMITS,
  };
  const labelled: number[] = [];
  let ownerPage: Page | undefined;
  const url = () => `${ctx.base}/f/${encodeURIComponent(factory)}/owner`;

  return {
    /** On the untouched seed: the queue is every open needs-owner issue and open question. */
    async open() {
      const page = await openPage(deps.env);
      ownerPage = page;
      await page.goto(url());
      await page.evaluate('window.__mcNoReload = true');
      const ready = await page.evaluate<boolean>(
        pageWait(`document.querySelector('${OWNER}[data-state="ready"]') !== null`, READY_WAIT_MS),
      );
      if (!ready) {
        throw new Error(
          `the owner queue did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(timings, (await measure(page, ['owner-queue']))['owner-queue']);
      const shown = await page.evaluate<ShownOwnerItem[]>(itemsOnScreen);
      const controls = await page.evaluate<string[]>(controlsOnScreen);
      const issues = await db.query(OPEN_NEEDS_OWNER_SQL, [factory]);
      const questions = await db.query(OPEN_QUESTIONS_SQL, [factory]);
      const mismatches = ownerMismatches(shown, expectedItems(issues, questions));
      for (const control of controls) mismatches.push(`the screen has a control: ${control}`);
      writeFileSync(
        join(outDir, 'owner-queue-check.txt'),
        [
          'screen:',
          ...shown.map((s) => `  ${JSON.stringify(s)}`),
          `controls (form, button, input, select, textarea in main): ${controls.length}`,
          'SQL (open needs-owner issues in mc.issues and mc.issue_labels):',
          ...issues.map((i) => `  ${JSON.stringify(i)}`),
          'SQL (open questions in mc.owner_questions):',
          ...questions.map((q) => `  ${JSON.stringify(q)}`),
          ...mismatches,
          `mismatches: ${mismatches.length}`,
          '',
        ].join('\n'),
      );
      ctx.failures.push(...mismatches.map((m) => `owner queue against the seed: ${m}`));
      writeFileSync(join(outDir, 'owner-queue.png'), await page.screenshot(1440));
    },

    async write() {
      const page = required(ownerPage, 'owner queue page');
      timings.labelToScreen = await labelToScreen(page, db, deps, factory, labelled);
      deps.out(`first label reached the owner queue in ${timings.labelToScreen.ms ?? 'never'} ms`);
    },

    async afterHold() {
      const page = required(ownerPage, 'owner queue page');
      timings.renewals = await page.evaluate<number>(renewalsOf('owner-queue'));
      timings.afterHoldLabelToScreen = await labelToScreen(page, db, deps, factory, labelled);
      timings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      ownerPage = undefined;
    },

    async probe(designProbe) {
      designProbe(url(), 'owner-queue-design-probe.json', 'the owner queue');
    },

    async close() {
      timings.port = ctx.port;
      writeFileSync(
        join(outDir, 'owner-queue-timings.json'),
        `${JSON.stringify(timings, null, 2)}\n`,
      );
      await ownerPage?.close().catch(() => undefined);
    },

    async cleanup() {
      try {
        if (labelled.length > 0) {
          await db.query(
            `DELETE FROM mc.issue_labels
             WHERE factory = $1 AND label = 'needs-owner' AND issue_number = ANY($2::int[])`,
            [factory, `{${labelled.join(',')}}`],
          );
        }
        return [];
      } catch (err) {
        return [`removing the owner queue's labels failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      if (!within(timings.readyMs, LIMITS.readyMs)) {
        failures.push(`owner queue ready after ${timings.readyMs} ms, limit ${LIMITS.readyMs}`);
      }
      failures.push(...performanceFailures('owner queue', timings));
      for (const [when, write] of [
        ['first', timings.labelToScreen],
        [`after ${holdSeconds}s`, timings.afterHoldLabelToScreen],
      ] as const) {
        failures.push(...lateWrite(`label ${when}`, 'the owner queue', write?.ms));
      }
      if (holdSeconds >= 180 && (timings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${timings.renewals} owner queue seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (timings.noReload !== true) failures.push('the owner queue reloaded');
      return failures;
    },

    summary: () => [`owner: ${JSON.stringify(timings)}`],
  };
}
