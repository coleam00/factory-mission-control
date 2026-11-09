import { NEXT_TO_LABEL } from '../fixture/write';
import type { Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
import type { Db, Row } from '../lib/db';
import { screenAgainstSql, writeToScreen } from './shared';

const ITEM = 'main [data-owner-item]';

export interface ShownOwnerItem {
  id: string | null;
  title: string;
  href: string | null;
  options: { key: string | null; text: string; isDefault: boolean }[];
  recommendation: string | null;
  defaultOption: string | null;
  defaultAt: string | null;
  waitingSince: string | null;
  /** The item says its wait is approximate: an issue whose label time is not recorded. */
  approximate: boolean;
  waited: string | null;
}

export const itemsOnScreen = `[...document.querySelectorAll('${ITEM}')].map((li) => ({
  id: li.getAttribute('data-owner-item'),
  title: li.querySelector('[data-title]')?.textContent ?? '',
  href: li.querySelector('a[data-thread]')?.getAttribute('href') ?? null,
  options: [...li.querySelectorAll('[data-option]')].map((o) => ({
    key: o.getAttribute('data-option'),
    text: o.getAttribute('data-option-text') ?? '',
    isDefault: o.hasAttribute('data-default'),
  })),
  recommendation: li.querySelector('[data-recommendation]')?.textContent ?? null,
  defaultOption: li.getAttribute('data-default-option'),
  defaultAt: li.getAttribute('data-default-at'),
  waitingSince: li.getAttribute('data-waiting-since'),
  approximate: li.hasAttribute('data-approximate'),
  waited: li.querySelector('[data-waited]')?.textContent ?? null,
}))`;

/** The seed's open needs-owner issues, read apart from db/queries/owner-queue.sql. */
export const OPEN_NEEDS_OWNER_SQL = `SELECT i.number, i.title, i.url, i.updated_at, l.labeled_at
  FROM mc.issues i
  JOIN mc.issue_labels l ON l.factory = i.factory AND l.issue_number = i.number
  WHERE i.factory = $1 AND i.state = 'open' AND l.label = 'needs-owner' ORDER BY i.number`;

/** The seed's open owner questions with their issue's URL. */
export const OPEN_QUESTIONS_SQL = `SELECT q.issue_number, q.question_number, q.question, q.options,
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
    // Since it was labelled, or since its last update where that time is not recorded.
    const labelled = i.labeled_at instanceof Date ? i.labeled_at : null;
    expected.set(`issue-${i.number}`, {
      title: String(i.title),
      href: String(i.url),
      options: [],
      waitingSince: iso(labelled ?? i.updated_at),
      approximate: labelled === null,
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
      approximate: false,
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
export async function labelToScreen(
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
