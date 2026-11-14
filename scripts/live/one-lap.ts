import { consoleUrl, pullUrl } from '../../app/lib/one-lap';
import { QUEUE_FACTORY, QUEUE_PAGE_RUNS, QUEUE_RUNS } from '../fixture/seed';
import { MARKER } from '../fixture/seed-report';
import { openPage, type Page } from '../lib/cdp';
import type { Db } from '../lib/db';
import {
  LIMITS,
  LIVE_STEP,
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
  untilShown,
  writeToScreen,
} from './shared';
import {
  emptyGroupTimings,
  type GroupTimings,
  groupPerformanceFailures,
  groupTimings,
  readyFailures,
} from './timings';

const ONE_LAP_QUERIES = ['one-lap', 'one-lap-steps', 'one-lap-checks', 'one-lap-map'] as const;
/** The row LIVE_STEP's `fixture:write` adds to the one-lap screen. */
const REVIEW_ROW = `[data-live="one-lap-steps"] [data-step-attempt][data-step="${LIVE_STEP}"]`;

interface OneLapTimings extends GroupTimings {
  branch: string | null;
  port: number | null;
  /** The running lap the screen is timed on, and the gate-refused lap checked against the seed. */
  run: string | null;
  refusedRun: string | null;
  /** The pre-hold `fixture:write step --step review --event node_started` to its review row. */
  stepToScreen: { run: string; ms: number | null } | null;
  holdSeconds: number;
  renewals: Record<(typeof ONE_LAP_QUERIES)[number], number | null>;
  /** One more review node_started after the hold, to that row's start changing. */
  afterHoldStepToScreen: { run: string; ms: number | null } | null;
  noReload: boolean | null;
  limits: typeof LIMITS;
}

interface OneLapOnScreen {
  lap: string | null;
  route: string | null;
  depth: string | null;
  issue: number | null;
  links: { console: string | null; issue: string | null; pr: string | null };
  review: string | null;
  gate: string | null;
  reason: string | null;
  steps: {
    step: string | null;
    status: string | null;
    started: string | null;
    durationMs: number | null;
    model: string | null;
    tokensInput: number | null;
    tokensOutput: number | null;
    cost: number | null;
  }[];
  cost: number | null;
  checks: {
    position: number | null;
    label: string | null;
    kind: string | null;
    verdict: string | null;
    evidence: number | null;
  }[];
  /** Every node of the step graph: its path, what happened to it, and its own attempts. */
  graph: {
    path: string | null;
    state: string | null;
    attempts: number | null;
    /** A folded block: how many steps it holds, drawn when it is opened. */
    folded: number | null;
    /** A step a folded block holds: in the page, hidden until the block is opened. */
    hidden: boolean;
  }[];
  /** How many times the seed's holdout text marker occurs in the rendered page. */
  markers: number;
}

const markersOnScreen = `document.documentElement.outerHTML.split(${JSON.stringify(MARKER)}).length - 1`;

const oneLapOnScreen = `(() => {
  const attr = (el, name) => el?.getAttribute(name) ?? null;
  const num = (el, name) => (el?.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
  const header = document.querySelector('[data-live="one-lap"] [data-lap]');
  const href = (link) =>
    attr(document.querySelector('[data-live="one-lap"] a[data-link="' + link + '"]'), 'href');
  return {
    lap: attr(header, 'data-lap'),
    route: attr(header, 'data-route'),
    depth: attr(header, 'data-depth'),
    issue: num(header, 'data-issue'),
    links: { console: href('console'), issue: href('issue'), pr: href('pr') },
    review: attr(document.querySelector('[data-live="one-lap"] [data-review]'), 'data-review-outcome'),
    gate: attr(document.querySelector('[data-live="one-lap"] [data-gate]'), 'data-gate-outcome'),
    reason: document.querySelector('[data-live="one-lap"] [data-gate-reason]')?.textContent ?? null,
    steps: [...document.querySelectorAll('[data-live="one-lap-steps"] [data-step-attempt]')].map((li) => ({
      step: attr(li, 'data-step'),
      status: attr(li, 'data-status'),
      started: attr(li, 'data-started'),
      durationMs: num(li, 'data-duration-ms'),
      model: attr(li, 'data-model'),
      tokensInput: num(li, 'data-tokens-input'),
      tokensOutput: num(li, 'data-tokens-output'),
      cost: num(li, 'data-cost'),
    })),
    cost: num(document.querySelector('[data-live="one-lap-steps"] [data-lap-cost]'), 'data-lap-cost'),
    checks: [...document.querySelectorAll('[data-live="one-lap-checks"] [data-check-line]')].map((li) => ({
      position: num(li, 'data-position'),
      label: attr(li, 'data-line-id'),
      kind: attr(li, 'data-kind'),
      verdict: attr(li, 'data-verdict'),
      evidence: num(li, 'data-evidence'),
    })),
    graph: [...document.querySelectorAll('[data-live="one-lap-steps"] [data-graph-step]')].map((b) => ({
      path: attr(b, 'data-graph-step'),
      state: attr(b, 'data-step-state'),
      attempts: num(b, 'data-attempts'),
      folded: num(b, 'data-folded'),
      hidden: b.closest('[hidden]') !== null,
    })),
    markers: ${markersOnScreen},
  };
})()`;

/**
 * Opens `runId`'s page on a tab and waits until its panels are `ready`: the Steps tab holds all
 * four, the Timeline every one but the app check's.
 */
async function openOneLap(
  page: Page,
  base: string,
  factory: string,
  runId: string,
  tab: 'steps' | 'timeline',
): Promise<void> {
  await page.goto(`${base}/f/${factory}/runs/${runId}${tab === 'steps' ? '?tab=steps' : ''}`);
  await page.evaluate('window.__mcNoReload = true');
  const panels =
    tab === 'steps' ? ONE_LAP_QUERIES : ONE_LAP_QUERIES.filter((q) => q !== 'one-lap-checks');
  const ready = await page.evaluate<boolean>(
    pageWait(
      panels
        .map((q) => `document.querySelector('[data-live="${q}"][data-state="ready"]') !== null`)
        .join(' && '),
      READY_WAIT_MS,
    ),
  );
  if (!ready) {
    throw new Error(`the lap ${runId} did not reach data-state="ready" within ${READY_WAIT_MS} ms`);
  }
}

/** The text of db/queries/one-lap.sql matching `pattern`, the page's own rule for what it names. */
function pageLapRule(sql: string, pattern: RegExp, name: string): string {
  const found = pattern.exec(sql);
  if (!found) throw new Error(`db/queries/one-lap.sql has no ${name} to read`);
  return found[0];
}

/** The pull request lateral: which PR a run shows. */
const pageLapPrJoin = (sql: string) =>
  pageLapRule(
    sql,
    /^LEFT JOIN LATERAL \(\r?\n\s*SELECT s\.pr_number[\s\S]*?^\) pr ON true/m,
    'pr lateral',
  );

/** The claim lateral through the issue join: which item a run shows (the facts step and the item lateral sit between). */
const pageLapClaimJoin = (sql: string) =>
  pageLapRule(
    sql,
    /^LEFT JOIN LATERAL \(\r?\n\s*SELECT c\.issue_number, c\.route FROM mc\.claims c[\s\S]*?^\) c ON true\r?\n[\s\S]*?^LEFT JOIN mc\.issues i .*$/m,
    'claim lateral',
  );

/** The item's number: the claim's, else the one the facts step names, else the lap's. */
const pageLapIssue = (sql: string) =>
  pageLapRule(
    sql,
    /coalesce\(c\.issue_number, \(facts\.output -> 'item' ->> 'number'\)::int, l\.issue_number\)/,
    'issue expression',
  );

/** The pick step join: the step whose route and depth a lap shows. */
const pageLapPickJoin = (sql: string) =>
  pageLapRule(sql, /^LEFT JOIN mc\.lap_steps p ON .*$/m, 'pick step join');

/** The route expression: the pick step's route, else the claim's. */
const pageLapRoute = (sql: string) =>
  pageLapRule(sql, /coalesce\(p\.output ->> 'route', c\.route\)/, 'route expression');

/**
 * A finished lap's screen against SQL over the seed's tables, not the screen's queries (except the issue, issue link,
 * route and PR columns, which run one-lap.sql's own item, route and PR rules so the page and the check share one owner): each
 * step's single attempt, the lap's cost, its review, merge gate and app-check lines, its links,
 * and no holdout line or text anywhere on the page. The seed lap has holdout lines, so equal
 * lines prove the page leaves them out.
 */
async function seedOneLapMismatches(
  page: Page,
  db: Db,
  runId: string,
  oneLapSql: string,
): Promise<{ mismatches: string[]; report: string }> {
  const shown = await page.evaluate<OneLapOnScreen>(oneLapOnScreen);
  const mismatches: string[] = [];
  const same = screenAgainstSql(mismatches);
  const nullable = (value: unknown) => (value === null ? null : Number(value));

  const [lap] = await db.query(
    `SELECT f.repository, f.console,
       ${pageLapIssue(oneLapSql)} AS issue, i.url AS issue_url,
       ${pageLapRoute(oneLapSql)} AS route, p.output ->> 'depth' AS depth,
       review.output ->> 'outcome' AS review, pr.pr_number,
       land.output ->> 'outcome' AS gate, land.output ->> 'reason' AS reason
     FROM mc.laps l
     JOIN mc.factories f ON f.name = l.factory
     ${pageLapClaimJoin(oneLapSql)}
     ${pageLapPickJoin(oneLapSql)}
     LEFT JOIN mc.lap_steps review ON review.run_id = l.run_id AND review.step_id = 'review'
     LEFT JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'
     ${pageLapPrJoin(oneLapSql)}
     WHERE l.run_id = $1`,
    [runId],
  );
  const issue = nullable(lap.issue);
  const pr = nullable(lap.pr_number);
  const headerSql = {
    lap: runId,
    route: lap.route,
    depth: lap.depth,
    issue,
    links: {
      console: consoleUrl(String(lap.console), runId),
      issue: lap.issue_url,
      pr: pr === null ? null : pullUrl(String(lap.repository), pr),
    },
    review: lap.review,
    gate: lap.gate,
    reason: lap.reason,
  };
  const { lap: shownLap, route, depth, issue: shownIssue, links, review, gate, reason } = shown;
  const header = { lap: shownLap, route, depth, issue: shownIssue, links, review, gate, reason };
  same('the lap', header, headerSql);

  // A finished seed lap runs each step once, so each attempt pairs with its step's one row.
  const steps = await db.query(
    `SELECT a.step_id AS step, a.status, nullif(a.started_at, '-infinity') AS started,
       a.duration_ms, s.model, s.tokens_input, s.tokens_output, a.cost_usd
     FROM mc.lap_step_attempts a
     JOIN mc.lap_steps s ON s.run_id = a.run_id AND s.step_id = a.step_id
     WHERE a.run_id = $1`,
    [runId],
  );
  const stepRows = await db.query('SELECT count(*)::int AS n FROM mc.lap_steps WHERE run_id = $1', [
    runId,
  ]);
  if (Number(stepRows[0].n) !== steps.length) {
    mismatches.push(`${runId} has ${stepRows[0].n} step rows and ${steps.length} attempts`);
  }
  const stepsSql = steps.map((r) => ({
    step: String(r.step),
    status: r.status,
    started: r.started instanceof Date ? r.started.toISOString() : null,
    durationMs: nullable(r.duration_ms),
    model: r.model,
    tokensInput: nullable(r.tokens_input),
    tokensOutput: nullable(r.tokens_output),
    cost: nullable(r.cost_usd),
  }));
  const byStep = <T extends { step: string | null; started: string | null }>(rows: readonly T[]) =>
    [...rows].sort((a, b) =>
      `${a.step} ${a.started ?? ''}`.localeCompare(`${b.step} ${b.started ?? ''}`),
    );
  same('the steps', byStep(shown.steps), byStep(stepsSql));

  const [total] = await db.query(
    'SELECT coalesce(sum(cost_usd), 0)::float8 AS cost FROM mc.lap_step_attempts WHERE run_id = $1',
    [runId],
  );
  if (shown.cost === null || Math.abs(shown.cost - Number(total.cost)) > 1e-9) {
    mismatches.push(`the lap's cost: screen ${shown.cost}, SQL ${total.cost}`);
  }

  const lines = await db.query(
    `SELECT position, line_id, kind, verdict, evidence_count
     FROM mc.app_check_lines WHERE run_id = $1 AND kind <> 'holdout' ORDER BY position`,
    [runId],
  );
  const checksSql = lines.map((r) => ({
    position: Number(r.position),
    label: r.line_id,
    kind: r.kind,
    verdict: r.verdict,
    evidence: Number(r.evidence_count),
  }));
  same(
    'the app-check lines',
    [...shown.checks].sort((a, b) => Number(a.position) - Number(b.position)),
    checksSql,
  );
  if (shown.markers !== 0) mismatches.push(`${MARKER} occurs ${shown.markers} times on the page`);

  // The graph: every step the lap ran is a node at its path, with its own attempts and a mark
  // from its latest run; every node of the loop at the lap's pin is drawn.
  const ran = await db.query(
    `SELECT a.step_id, count(*)::int AS attempts,
       (array_agg(a.status ORDER BY a.started_at DESC))[1] AS status
     FROM mc.lap_step_attempts a WHERE a.run_id = $1 GROUP BY a.step_id`,
    [runId],
  );
  const markOf: Record<string, string> = {
    completed: 'finished',
    running: 'running',
    failed: 'failed',
    skipped: 'skipped',
  };
  const node = new Map(shown.graph.map((g) => [g.path, g]));
  for (const r of ran) {
    const path = String(r.step_id).split('__').join('/');
    const g = node.get(path);
    if (g === undefined) {
      mismatches.push(`the step ${r.step_id} the lap ran is not in its graph`);
      continue;
    }
    if (g.attempts !== Number(r.attempts)) {
      mismatches.push(`${path}: the graph has ${g.attempts} attempts, SQL ${r.attempts}`);
    }
    // An include's own mark also reflects the steps inside it, so only a plain step is compared.
    const inner = shown.graph.some((o) => o.path?.startsWith(`${path}/`));
    if (!inner && g.state !== markOf[String(r.status)]) {
      mismatches.push(`${path}: the graph marks it ${g.state}, its latest run is ${r.status}`);
    }
  }
  const [{ nodes }] = await db.query(
    `SELECT count(*)::int AS nodes FROM mc.arch_steps s
     WHERE s.workflow = 'archon-loop' AND (s.archon_sha, s.factory_sha) = (
       SELECT a.archon_sha, a.factory_sha FROM mc.pins p
       JOIN mc.arch_versions a ON a.archon_sha = p.archon_sha
       JOIN mc.laps l ON l.run_id = $1
       WHERE p.committed_at <= l.started_at
       ORDER BY p.committed_at DESC, a.parsed_at DESC LIMIT 1)`,
    [runId],
  );
  // A folded block stands for the steps it holds until it is opened: count what is drawn.
  const drawn = shown.graph.filter((g) => !g.hidden);
  const reachable = drawn.reduce((n, g) => n + 1 + (g.folded ?? 0), 0);
  if (reachable < Number(nodes)) {
    mismatches.push(`the graph reaches ${reachable} nodes, the lap's pin maps ${nodes}`);
  }

  const report = [
    `lap ${runId}`,
    'screen:',
    `  lap ${JSON.stringify(header)}`,
    `  steps ${JSON.stringify(byStep(shown.steps))}`,
    `  cost ${shown.cost}`,
    `  checks ${JSON.stringify(shown.checks)}`,
    `  graph ${JSON.stringify(shown.graph)}`,
    `  ${MARKER} occurrences ${shown.markers}`,
    'SQL (mc.laps, mc.factories, mc.claims, mc.lap_steps, mc.lap_step_attempts, mc.app_check_lines;',
    'not the queries in db/queries/):',
    `  lap ${JSON.stringify(headerSql)}`,
    `  steps ${JSON.stringify(byStep(stepsSql))}`,
    `  cost ${total.cost}`,
    `  checks ${JSON.stringify(checksSql)}`,
    `  steps ran ${JSON.stringify(ran)}, nodes at the lap's pin ${nodes}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

interface RunOnScreen {
  title: string | null;
  cost: number | null;
  steps: {
    step: string | null;
    status: string | null;
    started: string | null;
    durationMs: number | null;
    cost: number | null;
  }[];
  rounds: { round: number | null; cost: number | null }[];
  errorPanels: number;
  skipReasons: (string | null)[];
  codeFailure: string | null;
}

/** Skipped steps are collapsed by default; the owner opens a group to read why, so the probe does too. */
const openSkippedGroups = `(() => {
  for (const group of document.querySelectorAll('[data-skipped-count][aria-expanded="false"]')) group.click();
  return ${pageWait(`document.querySelector('[data-skipped-count][aria-expanded="false"]') === null`, 2000)};
})()`;

const runOnScreen = `(() => {
  const num = (el, name) => (el?.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
  const head = document.querySelector('[data-live="one-lap"] [data-lap]');
  return {
    title: head?.getAttribute('data-title') ?? null,
    cost: num(head, 'data-run-cost'),
    steps: [...document.querySelectorAll('[data-timeline-step]')].map((li) => ({
      step: li.getAttribute('data-timeline-step'),
      status: li.getAttribute('data-status'),
      started: li.getAttribute('data-started'),
      durationMs: num(li, 'data-duration-ms'),
      cost: num(li, 'data-cost'),
    })),
    rounds: [...document.querySelectorAll('[data-round]')].map((li) => ({
      round: num(li, 'data-round'),
      cost: num(li, 'data-round-cost'),
    })),
    errorPanels: document.querySelectorAll('[data-error-panel]').length,
    skipReasons: [...document.querySelectorAll('[data-skip-reason]')].map((li) => li.getAttribute('data-skip-reason')),
    codeFailure: document.querySelector('[data-manager-read]')?.getAttribute('data-code-failure') ?? null,
  };
})()`;

/** What a seed run's page should say: its title, and for the failed build the error and the read. */
interface RunExpectation {
  run: string;
  title: string;
  failed?: boolean;
}

/**
 * A run's Timeline against SQL over its attempts: every step row's time and cost is its attempt's,
 * the folded rounds and the steps beside them add up to the run's cost, and that is the head's.
 */
async function seedRunMismatches(
  page: Page,
  db: Db,
  expected: RunExpectation,
): Promise<{ mismatches: string[]; report: string }> {
  await page.evaluate(openSkippedGroups);
  const shown = await page.evaluate<RunOnScreen>(runOnScreen);
  const mismatches: string[] = [];
  if (shown.title !== expected.title) {
    mismatches.push(`${expected.run}: the title is ${shown.title}, expected ${expected.title}`);
  }
  const attempts = await db.query(
    `SELECT step_id, status, nullif(started_at, '-infinity') AS started, duration_ms, cost_usd
     FROM mc.lap_step_attempts WHERE run_id = $1`,
    [expected.run],
  );
  const near = (a: number | null, b: number | null) =>
    a === b || (a !== null && b !== null && Math.abs(a - b) < 1e-9);
  for (const row of shown.steps) {
    const attempt = attempts.find(
      (a) =>
        a.step_id === row.step &&
        (a.started instanceof Date ? a.started.toISOString() : null) === row.started,
    );
    if (attempt === undefined) {
      mismatches.push(`${expected.run}: the timeline step ${row.step} has no attempt`);
      continue;
    }
    const cost = attempt.cost_usd === null ? null : Number(attempt.cost_usd);
    const durationMs = attempt.duration_ms === null ? null : Number(attempt.duration_ms);
    if (!near(row.cost, cost) || row.durationMs !== durationMs) {
      mismatches.push(
        `${expected.run}: ${row.step} shows ${row.durationMs} ms and ${row.cost}, SQL ${durationMs} ms and ${cost}`,
      );
    }
  }
  const [{ total }] = await db.query(
    'SELECT coalesce(sum(cost_usd), 0)::float8 AS total FROM mc.lap_step_attempts WHERE run_id = $1',
    [expected.run],
  );
  const parts =
    shown.steps.reduce((sum, s) => sum + (s.cost ?? 0), 0) +
    shown.rounds.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  if (Math.abs((shown.cost ?? 0) - Number(total)) > 1e-9) {
    mismatches.push(`${expected.run}: the head shows a cost of ${shown.cost}, SQL ${total}`);
  }
  if (Math.abs(parts - Number(total)) > 1e-9) {
    mismatches.push(`${expected.run}: the timeline rows add up to ${parts}, SQL ${total}`);
  }
  if (expected.failed) {
    if (shown.errorPanels !== 1) {
      mismatches.push(`${expected.run}: ${shown.errorPanels} error panels, expected 1`);
    }
    if (shown.skipReasons.length === 0)
      mismatches.push(`${expected.run}: no skipped step says why`);
    if (shown.codeFailure !== 'no') {
      mismatches.push(
        `${expected.run}: the read's code failure is ${shown.codeFailure}, expected no`,
      );
    }
  }
  const report = [
    `run ${expected.run} (${expected.title})`,
    `  screen ${JSON.stringify(shown)}`,
    `  SQL attempts ${JSON.stringify(attempts)}, cost ${total}`,
    ...mismatches,
    `mismatches: ${mismatches.length}`,
  ].join('\n');
  return { mismatches, report };
}

const FILES = liveOutputs({
  check: 'one-lap-check.txt',
  shot: 'one-lap.png',
  probe: 'one-lap-design-probe.json',
  runCheck: 'one-run-check.txt',
  runFailedShot: 'run-failed.png',
  runAppCheckShot: 'run-app-check.png',
  runSweepShot: 'run-merge-sweep.png',
  runClosedShot: 'run-closed-item.png',
  runFailedProbe: 'run-failed-design-probe.json',
  refusedProbe: 'one-lap-refused-design-probe.json',
  timings: 'one-lap-timings.json',
});
export const ONE_LAP_OUTPUTS: readonly LiveOutput[] = Object.values(FILES);

/** The head's primary button: its text and what it does. */
const primaryOnScreen = `(() => {
  const el = document.querySelector('[data-action="primary"]');
  return { text: el?.textContent?.trim() ?? '', act: el?.getAttribute('data-act') ?? null };
})()`;

/**
 * The failed seed runs' primary button (owner change 7, 2026-11-12): a run whose item is closed opens
 * the item, one whose item is open (or unmirrored) still resumes.
 */
const PRIMARY_EXPECTATIONS: readonly {
  factory: string;
  run: string;
  text: string;
  act?: string;
  shot?: LiveOutput;
}[] = [
  { factory: QUEUE_FACTORY.name, run: QUEUE_RUNS.failedBuild, text: 'Resume from pr__prepare' },
  {
    factory: 'mission-control',
    run: '5eed0002-0000-4000-8000-000000000008',
    text: 'Open #8',
    act: 'open-item',
    shot: FILES.runClosedShot,
  },
  {
    factory: 'mission-control',
    run: '5eed0003-0000-4000-8000-000000000002',
    text: 'Resume from build',
  },
];

/**
 * One lap's screen: a gate-refused seed lap against SQL, then the first running lap, timed live
 * on the first lap step event and on one more start of its review after the hold.
 */
export function oneLapPhase(ctx: LiveContext): LivePhase {
  const { deps, db, factory, holdSeconds, branch, measure } = ctx;
  const oneLapTimings: OneLapTimings = {
    branch,
    port: null,
    ...emptyGroupTimings(ONE_LAP_QUERIES),
    run: null,
    refusedRun: null,
    stepToScreen: null,
    holdSeconds,
    renewals: {
      'one-lap': null,
      'one-lap-steps': null,
      'one-lap-checks': null,
      'one-lap-map': null,
    },
    afterHoldStepToScreen: null,
    noReload: null,
    limits: LIMITS,
  };
  const reviewStart = `document.querySelector('${REVIEW_ROW}')?.getAttribute('data-started') ?? null`;
  let lapPage: Page | undefined;
  let refusedRun: string | undefined;
  let firstReviewStart: string | null = null;

  return {
    async open() {
      const { base } = ctx;
      const [firstLap] = ctx.laps;
      const [refused] = await db.query(
        `SELECT l.run_id::text AS run FROM mc.laps l
         JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'
         WHERE l.factory = $1 AND l.workflow_name = 'archon-loop'
           AND land.output ->> 'outcome' = 'refused'
           AND EXISTS (SELECT 1 FROM mc.app_check_lines a
                        WHERE a.run_id = l.run_id AND a.kind = 'holdout')
         ORDER BY 1 LIMIT 1`,
        [factory],
      );
      if (refused === undefined) {
        throw new Error(
          'the check branch has no gate-refused lap with an old holdout line to leave out',
        );
      }
      refusedRun = String(refused.run);
      oneLapTimings.refusedRun = refusedRun;
      const refusedPage = await openPage(deps.env);
      try {
        await openOneLap(refusedPage, base, factory, refusedRun, 'steps');
        const oneLapSeed = await seedOneLapMismatches(
          refusedPage,
          db,
          refusedRun,
          ctx.queries.get('one-lap') as string,
        );
        ctx.save(FILES.check, `${oneLapSeed.report}\n`);
        ctx.failures.push(...oneLapSeed.mismatches.map((m) => `one lap against the seed: ${m}`));
        ctx.save(FILES.shot, await refusedPage.screenshot(1440));
      } finally {
        await refusedPage.close().catch(() => undefined);
      }
      const reports: string[] = [];
      for (const [expected, shot] of [
        [
          {
            run: QUEUE_RUNS.failedBuild,
            title: `Build #${QUEUE_PAGE_RUNS.buildIssue}, round 2 of 4`,
            failed: true,
          },
          FILES.runFailedShot,
        ],
        [
          { run: QUEUE_RUNS.appCheck, title: `App check, PR #${QUEUE_PAGE_RUNS.checkPr}` },
          FILES.runAppCheckShot,
        ],
        [{ run: QUEUE_RUNS.merged, title: 'Merge sweep' }, FILES.runSweepShot],
      ] as const) {
        const runPage = await openPage(deps.env);
        try {
          await openOneLap(runPage, base, QUEUE_FACTORY.name, expected.run, 'timeline');
          const checked = await seedRunMismatches(runPage, db, expected);
          reports.push(checked.report);
          ctx.failures.push(...checked.mismatches.map((m) => `one run against the seed: ${m}`));
          ctx.save(shot, await runPage.screenshot(1440));
        } finally {
          await runPage.close().catch(() => undefined);
        }
      }
      for (const expected of PRIMARY_EXPECTATIONS) {
        const primaryPage = await openPage(deps.env);
        try {
          await openOneLap(primaryPage, base, expected.factory, expected.run, 'timeline');
          const primary = await primaryPage.evaluate<{ text: string; act: string | null }>(
            primaryOnScreen,
          );
          const shown = `${primary.text} (${primary.act})`;
          reports.push(`run ${expected.run} primary: ${shown}`);
          if (
            primary.text !== expected.text ||
            (expected.act !== undefined && primary.act !== expected.act)
          ) {
            ctx.failures.push(
              `one run against the seed: ${expected.run} shows the primary ${shown}, expected ${expected.text}`,
            );
          }
          if (expected.shot !== undefined)
            ctx.save(expected.shot, await primaryPage.screenshot(1440));
        } finally {
          await primaryPage.close().catch(() => undefined);
        }
      }
      ctx.save(FILES.runCheck, `${reports.join('\n\n')}\n`);
      oneLapTimings.run = firstLap;
      const page = await openPage(deps.env);
      lapPage = page;
      await openOneLap(page, base, factory, firstLap, 'steps');
      Object.assign(oneLapTimings, groupTimings(await measure(page, ONE_LAP_QUERIES)));
      const lapMarkers = await page.evaluate<number>(markersOnScreen);
      if (lapMarkers !== 0) {
        ctx.failures.push(`${MARKER} occurs ${lapMarkers} times on the lap ${firstLap}`);
      }
      if (await page.evaluate<boolean>(`document.querySelector('${REVIEW_ROW}') !== null`)) {
        throw new Error(`the lap ${firstLap} shows a ${LIVE_STEP} step before any write`);
      }
    },

    async write() {
      firstReviewStart = await required(lapPage, 'lap page').evaluate<string | null>(reviewStart);
    },

    /** Only the first lap step event is on this lap; the one after the hold is the other's. */
    async onLapStep(run, afterHold) {
      if (afterHold) return;
      const ms = await untilShown(
        required(lapPage, 'lap page'),
        `document.querySelector('${REVIEW_ROW}') !== null`,
      );
      oneLapTimings.stepToScreen = { run, ms };
      deps.out(`first step event reached its lap in ${ms ?? 'never'} ms`);
    },

    async writeAgain() {
      const page = required(lapPage, 'lap page');
      const [firstLap] = ctx.laps;
      for (const q of ONE_LAP_QUERIES) {
        oneLapTimings.renewals[q] = await page.evaluate<number>(renewalsOf(q));
      }
      // firstLap's review is still running: another start moves that row's start, adding no row.
      oneLapTimings.afterHoldStepToScreen = {
        run: firstLap,
        ms: await writeToScreen(
          page,
          deps,
          ['step', '--run', firstLap, '--step', LIVE_STEP, '--event', 'node_started'],
          `(${reviewStart}) !== null && (${reviewStart}) !== ${JSON.stringify(firstReviewStart)}`,
        ),
      };
      oneLapTimings.noReload = await page.evaluate<boolean>('window.__mcNoReload === true');
      await page.close();
      lapPage = undefined;
    },

    async probe(designProbe) {
      const { base } = ctx;
      const [firstLap] = ctx.laps;
      for (const [run, file] of [
        [firstLap, FILES.probe],
        [required(refusedRun, 'refused lap'), FILES.refusedProbe],
      ] as const) {
        designProbe(`${base}/f/${factory}/runs/${run}`, file, `the lap ${run}`);
      }
      designProbe(
        `${base}/f/${QUEUE_FACTORY.name}/runs/${QUEUE_RUNS.failedBuild}`,
        FILES.runFailedProbe,
        `the failed run ${QUEUE_RUNS.failedBuild}`,
      );
    },

    async close() {
      oneLapTimings.port = ctx.port;
      ctx.save(FILES.timings, `${JSON.stringify(oneLapTimings, null, 2)}\n`);
      await lapPage?.close().catch(() => undefined);
    },

    judge() {
      const failures: string[] = [];
      failures.push(...readyFailures('one-lap screen', oneLapTimings, LIMITS.readyMs));
      for (const q of ONE_LAP_QUERIES) {
        failures.push(...groupPerformanceFailures([q], oneLapTimings));
        if (holdSeconds >= 180 && (oneLapTimings.renewals[q] ?? 0) < RENEWALS_IN_180S) {
          failures.push(
            `${oneLapTimings.renewals[q]} ${q} seal renewals in ${holdSeconds}s, expected at least ${RENEWALS_IN_180S}`,
          );
        }
      }
      for (const [when, write] of [
        ['first', oneLapTimings.stepToScreen],
        [`after ${holdSeconds}s`, oneLapTimings.afterHoldStepToScreen],
      ] as const) {
        failures.push(...lateWrite(`${LIVE_STEP} ${when}`, 'its one-lap steps', write?.ms));
      }
      if (oneLapTimings.noReload !== true) failures.push('the one-lap screen reloaded');
      return failures;
    },
  };
}
