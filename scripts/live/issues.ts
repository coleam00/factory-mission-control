import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUE_STATES, STATE_TOKEN } from '../../app/lib/issue-graph';
import { NEXT_TO_LABEL } from '../fixture/write';
import { openPage, type Page } from '../lib/cdp';
import type { Deps } from '../lib/cli';
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
  screenAgainstSql,
  writeToScreen,
} from './shared';
import {
  emptyPanelTimings,
  type PanelTimings,
  performanceFailures,
  readyFailures,
} from './timings';

const ISSUES = '[data-live="issue-graph"]';

interface IssueGraphTimings extends PanelTimings {
  branch: string | null;
  port: number | null;
  /** The issue `fixture:write label` labelled, and how long its node took to show it. */
  labelToScreen: { issue: number; ms: number | null } | null;
  holdSeconds: number;
  renewals: number | null;
  afterHoldLabelToScreen: { issue: number; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface IssuesOnScreen {
  issues: {
    number: number;
    state: string;
    chain: boolean;
    context: boolean;
    dot: string;
    token: string | null;
  }[];
  dependencies: string[];
  phases: { phase: string; merged: number; total: number }[];
  columns: { phase: string; open: number; merged: number; closed: number }[];
  /** `data-hidden-open`: open issues the default view's cap left out, 0 when none. */
  hidden: number;
  /** Whether the "Show merged" toggle is on. */
  showMerged: boolean;
}

const issuesOnScreen = `(() => {
  const tokens = ${JSON.stringify(STATE_TOKEN)};
  const token = (name) => {
    if (name === undefined) return null;
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.backgroundColor = 'var(' + name + ')';
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  };
  return {
    issues: [...document.querySelectorAll('${ISSUES} [data-issue]')].map((a) => ({
      number: Number(a.getAttribute('data-issue')),
      state: a.getAttribute('data-issue-state'),
      chain: a.getAttribute('data-longest-chain') === 'true',
      context: a.getAttribute('data-context') === 'true',
      dot: getComputedStyle(a.querySelector('[data-state-dot]')).backgroundColor,
      token: token(tokens[a.getAttribute('data-issue-state')]),
    })),
    dependencies: [...document.querySelectorAll('${ISSUES} [data-dependency]')].map((p) =>
      p.getAttribute('data-dependency'),
    ),
    phases: [...document.querySelectorAll('${ISSUES} [data-phase]')].map((li) => ({
      phase: li.getAttribute('data-phase'),
      merged: Number(li.getAttribute('data-merged')),
      total: Number(li.getAttribute('data-total')),
    })),
    columns: [...document.querySelectorAll('${ISSUES} [data-phase-column]')].map((c) => ({
      phase: c.getAttribute('data-phase-column'),
      open: Number(c.getAttribute('data-open')),
      merged: Number(c.getAttribute('data-merged')),
      closed: Number(c.getAttribute('data-closed')),
    })),
    hidden: Number(document.querySelector('${ISSUES} [data-hidden-open]')?.getAttribute('data-hidden-open') ?? 0),
    showMerged: document.querySelector('${ISSUES} [data-show-merged]')?.getAttribute('aria-pressed') === 'true',
  };
})()`;

/** Clicks the "Show merged" toggle into `on` and waits for the graph to redraw that way. */
const showMerged = (on: boolean) =>
  pageWait(
    `(() => {
      const toggle = document.querySelector('${ISSUES} [data-show-merged]');
      if (toggle && (toggle.getAttribute('aria-pressed') === 'true') !== ${on}) toggle.click();
      return toggle?.getAttribute('aria-pressed') === '${on}';
    })()`,
    READY_WAIT_MS,
  );

/** Open issues by default, with the issues they directly depend on and every phase's counts. */
const defaultViewSql = (liveSql: string) => `WITH states AS (${liveSql.trim()}), open AS (
    SELECT number FROM states WHERE kind = 'issue' AND state NOT IN ('merged', 'closed')
  ), drawn AS (
    SELECT number FROM open
    UNION
    SELECT d.depends_on FROM mc.issue_dependencies d JOIN open o ON o.number = d.issue_number
    WHERE d.factory = $1 AND EXISTS (SELECT 1 FROM mc.issues i WHERE i.factory = $1 AND i.number = d.depends_on)
  )
  SELECT number FROM drawn ORDER BY number`;

/** Every open chain of `Depends on` edges through open issues, longest first. */
const OPEN_CHAINS_SQL = `WITH RECURSIVE open AS (
    SELECT number FROM mc.issues WHERE factory = $1 AND state = 'open'
  ), chain(tail, path) AS (
    SELECT number, ARRAY[number] FROM open
    UNION ALL
    SELECT d.depends_on, c.path || d.depends_on FROM chain c
    JOIN mc.issue_dependencies d ON d.factory = $1 AND d.issue_number = c.tail
    JOIN open o ON o.number = d.depends_on
    WHERE NOT d.depends_on = ANY(c.path)
  )
  SELECT path FROM chain ORDER BY cardinality(path) DESC`;

/** The issues screen against SQL on the seed, read before any label is written. */
async function seedIssueGraphMismatches(
  page: Page,
  db: Db,
  factory: string,
  liveSql: string,
): Promise<{ mismatches: string[]; report: string }> {
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);

  // The default view: open issues and what they directly depend on, merged work counted per phase.
  const byDefault = await page.evaluate<IssuesOnScreen>(issuesOnScreen);
  if (byDefault.showMerged) mismatches.push('the issues screen opened with Show merged on');
  const drawn = (await db.query(defaultViewSql(liveSql), [factory])).map((r) => Number(r.number));
  if (drawn.length > 40) {
    mismatches.push(`the seed has ${drawn.length} default nodes, past the cap this check reads`);
  }
  same(
    'default nodes',
    byDefault.issues.map((i) => i.number).sort((a, b) => a - b),
    drawn,
  );
  same('default hidden', byDefault.hidden, 0);
  const defaultEdges = await db.query(
    `SELECT issue_number, depends_on FROM mc.issue_dependencies
     WHERE factory = $1 AND issue_number = ANY($2::int[]) AND depends_on = ANY($2::int[])
     ORDER BY 1, 2`,
    [factory, `{${drawn.join(',')}}`],
  );
  const byNumbersDefault = (a: string, b: string) => {
    const [a1, a2] = a.split('-').map(Number);
    const [b1, b2] = b.split('-').map(Number);
    return a1 - b1 || a2 - b2;
  };
  same(
    'default edges',
    [...byDefault.dependencies].sort(byNumbersDefault),
    defaultEdges.map((e) => `${e.issue_number}-${e.depends_on}`),
  );
  for (const i of byDefault.issues) {
    const closedState = i.state === 'merged' || i.state === 'closed';
    if (i.context !== closedState) {
      mismatches.push(`#${i.number} ${i.state} is drawn as ${i.context ? 'context' : 'open work'}`);
    }
  }
  const columns = await db.query(
    `WITH states AS (${liveSql.trim()})
     SELECT coalesce(phase, '') AS phase,
       count(*) FILTER (WHERE state NOT IN ('merged', 'closed'))::int AS open,
       count(*) FILTER (WHERE state = 'merged')::int AS merged,
       count(*) FILTER (WHERE state = 'closed')::int AS closed
     FROM states WHERE kind = 'issue'
     GROUP BY phase ORDER BY phase IS NULL, min(number)`,
    [factory],
  );
  same(
    'phase columns',
    byDefault.columns,
    columns.map((c) => ({ phase: c.phase, open: c.open, merged: c.merged, closed: c.closed })),
  );

  // Show merged: the full history, checked as the graph was before it collapsed merged work.
  if (!(await page.evaluate<boolean>(showMerged(true)))) {
    mismatches.push('the Show merged toggle did not turn on');
  }
  const shown = await page.evaluate<IssuesOnScreen>(issuesOnScreen);

  const issues = await db.query('SELECT number FROM mc.issues WHERE factory = $1 ORDER BY number', [
    factory,
  ]);
  same(
    'nodes',
    shown.issues.map((i) => i.number).sort((a, b) => a - b),
    issues.map((i) => Number(i.number)),
  );
  const edges = await db.query(
    'SELECT issue_number, depends_on FROM mc.issue_dependencies WHERE factory = $1 ORDER BY 1, 2',
    [factory],
  );
  const byNumbers = (a: string, b: string) => {
    const [a1, a2] = a.split('-').map(Number);
    const [b1, b2] = b.split('-').map(Number);
    return a1 - b1 || a2 - b2;
  };
  same(
    'edges',
    [...shown.dependencies].sort(byNumbers),
    edges.map((e) => `${e.issue_number}-${e.depends_on}`),
  );

  const states = (await db.query(liveSql, [factory]))
    .filter((r) => r.kind === 'issue')
    .map((r) => `#${r.number} ${r.state}`)
    .sort();
  same('states', shown.issues.map((i) => `#${i.number} ${i.state}`).sort(), states);
  for (const state of ISSUE_STATES) {
    if (!shown.issues.some((i) => i.state === state)) mismatches.push(`no node is ${state}`);
  }
  for (const i of shown.issues) {
    if (i.token === null || i.dot !== i.token) {
      mismatches.push(`#${i.number} ${i.state} is colored ${i.dot}, its token is ${i.token}`);
    }
  }

  const phases = await db.query(
    `SELECT i.phase, count(*)::int AS total,
       count(*) FILTER (WHERE i.state = 'closed' AND EXISTS (
         SELECT 1 FROM mc.pull_request_issues pi
         JOIN mc.pull_requests p ON p.factory = pi.factory AND p.number = pi.pr_number
         WHERE pi.factory = i.factory AND pi.issue_number = i.number AND p.merged_at IS NOT NULL
       ))::int AS merged
     FROM mc.issues i WHERE i.factory = $1 AND i.phase IS NOT NULL
     GROUP BY i.phase ORDER BY min(i.number)`,
    [factory],
  );
  same(
    'phase bars',
    shown.phases,
    phases.map((p) => ({ phase: p.phase, merged: p.merged, total: p.total })),
  );

  // An int[] arrives as an Int32Array, which JSON would print as an object.
  const chains = (await db.query(OPEN_CHAINS_SQL, [factory])).map((r) =>
    Array.from(r.path as ArrayLike<number>, Number),
  );
  const longest = chains.filter((c) => c.length === chains[0]?.length);
  if (longest.length !== 1 || longest[0].length < 3) {
    mismatches.push(
      `the seed must have one longest open chain of at least 3, it has ${JSON.stringify(longest)}`,
    );
  }
  same(
    'longest open chain',
    shown.issues
      .filter((i) => i.chain)
      .map((i) => i.number)
      .sort((a, b) => a - b),
    [...(longest[0] ?? [])].sort((a, b) => a - b),
  );

  if (!(await page.evaluate<boolean>(showMerged(false)))) {
    mismatches.push('the Show merged toggle did not turn back off');
  }

  const report = [
    'screen by default:',
    `  ${JSON.stringify(byDefault)}`,
    `  SQL default nodes ${JSON.stringify(drawn)}`,
    `  SQL phase columns ${JSON.stringify(columns)}`,
    'screen with Show merged:',
    `  ${JSON.stringify(shown)}`,
    'SQL (mc.issues, mc.issue_dependencies, db/queries/issue-graph.sql, phase counts, open chains):',
    `  nodes ${JSON.stringify(issues.map((i) => i.number))}`,
    `  edges ${JSON.stringify(edges.map((e) => `${e.issue_number}-${e.depends_on}`))}`,
    `  states ${JSON.stringify(states)}`,
    `  phases ${JSON.stringify(phases)}`,
    `  longest open chains ${JSON.stringify(longest)}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

/**
 * Runs `fixture:write label`, which labels the highest-numbered open issue without `needs-owner`,
 * and times it from the write's exit to that issue's node reading `needs-owner`.
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
  const node = `${ISSUES} [data-issue="${issue}"]`;
  const before = await page.evaluate<string | null>(
    `document.querySelector('${node}')?.getAttribute('data-issue-state') ?? null`,
  );
  if (before !== 'waiting') {
    throw new Error(`fixture:write label will label #${issue}, which is ${before}, not waiting`);
  }
  labelled.push(issue);
  const ms = await writeToScreen(
    page,
    deps,
    ['label'],
    `document.querySelector('${node}')?.getAttribute('data-issue-state') === 'needs-owner'`,
  );
  return { issue, ms };
}

/** The issues screen: the seed's graph against SQL, and `fixture:write label` timed to it. */
export function issuesPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, outDir, holdSeconds, branch, measure } = ctx;
  const issueTimings: IssueGraphTimings = {
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
  let issuesPage: Page | undefined;

  return {
    async write() {
      const { base } = ctx;
      const page = await openPage(deps.env);
      issuesPage = page;
      await page.goto(`${base}/f/${factory}/issues`);
      await page.evaluate('window.__mcNoReload = true');
      const issuesReady = await page.evaluate<boolean>(
        pageWait(`document.querySelector('${ISSUES}[data-state="ready"]') !== null`, READY_WAIT_MS),
      );
      if (!issuesReady) {
        throw new Error(
          `the issues screen did not reach data-state="ready" within ${READY_WAIT_MS} ms`,
        );
      }
      Object.assign(issueTimings, (await measure(page, ['issue-graph']))['issue-graph']);
      const issueSeed = await seedIssueGraphMismatches(
        page,
        db,
        factory,
        readFileSync(join(deps.repoRoot, 'db', 'queries', 'issue-graph.sql'), 'utf-8'),
      );
      writeFileSync(join(outDir, 'issue-graph-check.txt'), `${issueSeed.report}\n`);
      ctx.failures.push(...issueSeed.mismatches.map((m) => `issues screen against the seed: ${m}`));
      writeFileSync(join(outDir, 'phases-issue-graph.png'), await page.screenshot(1440));
      issueTimings.labelToScreen = await labelToScreen(page, db, deps, factory, labelled);
      deps.out(
        `first label reached the issues screen in ${issueTimings.labelToScreen.ms ?? 'never'} ms`,
      );
    },

    async afterHold() {
      const page = required(issuesPage, 'issues page');
      issueTimings.renewals = await page.evaluate<number>(
        `performance.getEntriesByName('live:issue-graph:renewed').length`,
      );
      issueTimings.afterHoldLabelToScreen = await labelToScreen(page, db, deps, factory, labelled);
      issueTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      issuesPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      designProbe(
        `${base}/f/${factory}/issues`,
        'phases-issue-graph-design-probe.json',
        'the issues screen',
      );
    },

    async close() {
      issueTimings.port = ctx.port;
      writeFileSync(
        join(outDir, 'phases-issue-graph-timings.json'),
        `${JSON.stringify(issueTimings, null, 2)}\n`,
      );
      await issuesPage?.close().catch(() => undefined);
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
        return [`removing the written labels failed: ${(err as Error).message}`];
      }
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('issues screen', issueTimings, LIMITS.readyMs));
      failures.push(...performanceFailures('issues screen', issueTimings));
      for (const [when, write] of [
        ['first', issueTimings.labelToScreen],
        [`after ${holdSeconds}s`, issueTimings.afterHoldLabelToScreen],
      ] as const) {
        failures.push(...lateWrite(`label ${when}`, 'the issues screen', write?.ms));
      }
      if (holdSeconds >= 180 && (issueTimings.renewals ?? 0) < RENEWALS_IN_180S) {
        failures.push(
          `${issueTimings.renewals} issues seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
        );
      }
      if (issueTimings.noReload !== true) failures.push('the issues screen reloaded');
      return failures;
    },

    summary: () => [`issues: ${JSON.stringify(issueTimings)}`],
  };
}
