import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type FactoryScorecardRow, scorecardMeasures } from '../../app/lib/factory-scorecard';
import { type MetricRecord, metricRecordsFixture } from '../../scripts/fixture/metric-records';
import { REPOSITORY, writeMetrics } from '../../scripts/fixture/write';
import type { Db } from '../../scripts/lib/db';
import { migratedDb, queries } from './test-seed';

const sql = queries.find(([name]) => name === 'factory-scorecard')?.[1] as string;
const NOW = new Date('2026-11-11T12:00:00Z');
const UNTIL = '2026-11-12';
const PR = 'https://github.com/coleam00/factory-mission-control/pull/200';

let db: Db;
const scorecard = async (factory = 'mission-control') =>
  (await db.query(sql, [factory, UNTIL])) as unknown as FactoryScorecardRow[];
const row = async (name: string, factory?: string) =>
  (await scorecard(factory)).find((r) => r.name === name);

type Recorded = Omit<MetricRecord, 'at'> & { at?: string };
const record = (name: string, value: number, extra: Partial<Recorded> = {}): Recorded => ({
  name,
  kind: 'score',
  unit: 'rounds',
  subject: PR,
  value,
  ...extra,
});

/**
 * A completed archon-metrics-prs run on `codebase`, its prs node carrying `records`, as Archon writes it.
 * By default it completes after the run seed() writes at NOW, so it is the later run whatever the wall clock.
 */
async function metricsRun(
  codebase: string,
  records: Recorded[],
  createdAt = '2026-11-11T13:00:00Z',
): Promise<string> {
  const [run] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message)
     SELECT 'archon-metrics-prs', c.id, 'completed', 'metrics' FROM public.remote_agent_codebases c
     WHERE c.name = $1 RETURNING id`,
    [codebase],
  );
  await db.query(
    `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, created_at)
     VALUES ($1, 'node_completed', 'prs', $2::jsonb, $3)`,
    [run?.id, { type: 'script', structured_output: { metrics: records } }, createdAt],
  );
  return String(run?.id);
}

beforeEach(async () => {
  db = await migratedDb();
  await db.query(`INSERT INTO mc.factories (name, repository, codebase, console) VALUES
    ('mission-control', '${REPOSITORY}', '${REPOSITORY}', 'http://localhost:3090'),
    ('other', 'o/other', 'o/other', 'http://localhost:3090')`);
  await db.query(
    `INSERT INTO public.remote_agent_codebases (name) VALUES ('${REPOSITORY}'), ('o/other')`,
  );
});
afterEach(() => db.close());

const seed = () => db.transaction(async (tx) => void (await writeMetrics(tx, NOW)));

type Cells = [number | null, number, number | null, number];

describe('factory-scorecard over the fixture records', () => {
  // [name, now value and n, before value and n] for the last 7 days then the last 30, worked out
  // by hand from the formulas in metricRecordsFixture.
  const EXPECTED: [string, Cells, Cells][] = [
    ['sdlc.issue_asks', [19 / 14, 14, 1.5, 12], [84 / 56, 56, 73 / 50, 50]],
    ['sdlc.issue_asks.deliver', [2, 6, 2, 6], [55 / 27, 27, 1.96, 25]],
    ['sdlc.issue_asks.investigate', [0.5, 2, null, 0], [0.5, 2, null, 0]],
    ['sdlc.issue_asks.plan', [1, 6, 1, 6], [28 / 27, 27, 0.96, 25]],
    ['sdlc.issue_build_rounds', [27 / 14, 14, 2, 12], [111 / 56, 56, 2, 50]],
    ['sdlc.issue_build_rounds.deliver', [2, 6, 2, 6], [2, 27, 1.96, 25]],
    ['sdlc.issue_build_rounds.investigate', [1.5, 2, null, 0], [1.5, 2, null, 0]],
    ['sdlc.issue_build_rounds.plan', [2, 6, 2, 6], [2, 27, 2.04, 25]],
    ['sdlc.issue_lead_time', [108 / 14, 14, 8, 12], [444 / 56, 56, 8, 50]],
    ['sdlc.issue_lead_time.deliver', [50 / 6, 6, 44 / 6, 6], [214 / 27, 27, 8, 25]],
    ['sdlc.issue_lead_time.investigate', [5, 2, null, 0], [5, 2, null, 0]],
    ['sdlc.issue_lead_time.plan', [8, 6, 52 / 6, 6], [220 / 27, 27, 8, 25]],
    ['sdlc.issues_merged', [14, 14, 12, 12], [56, 56, 50, 50]],
    ['sdlc.issues_merged.deliver', [6, 6, 6, 6], [27, 27, 25, 25]],
    ['sdlc.issues_merged.investigate', [2, 2, null, 0], [2, 2, null, 0]],
    ['sdlc.issues_merged.plan', [6, 6, 6, 6], [27, 27, 25, 25]],
    ['sdlc.pr_merge_rate', [13 / 14, 14, 11 / 12, 12], [50 / 56, 56, 0.9, 50]],
    ['sdlc.production_lines_added', [150, 6, 260, 5], [410, 11, null, 0]],
    ['sdlc.review_five_plus_rounds', [2 / 14, 14, 0.25, 12], [11 / 56, 56, 0.2, 50]],
    ['sdlc.review_one_round', [3 / 14, 14, 0.25, 12], [12 / 56, 56, 0.2, 50]],
    ['sdlc.review_rounds', [40 / 14, 14, 3, 12], [166 / 56, 56, 3, 50]],
    ['sdlc.test_lines_added', [75, 6, 130, 5], [205, 11, null, 0]],
  ];
  const near = (cells: (number | null)[]) =>
    cells.map((v, i) => (i % 2 === 0 && v !== null ? Number(v.toFixed(9)) : v));

  test('every measure has its 7- and 30-day value and sample size, and the period before each', async () => {
    await seed();
    const rows = await scorecard();
    expect(rows.map((r) => r.name)).toEqual(EXPECTED.map(([name]) => name));
    for (const [name, week, month] of EXPECTED) {
      const r = rows.find((found) => found.name === name) as FactoryScorecardRow;
      expect(near([r.value_7, r.n_7, r.value_7_before, r.n_7_before]), `${name} 7`).toEqual(
        near(week),
      );
      expect(near([r.value_30, r.n_30, r.value_30_before, r.n_30_before]), `${name} 30`).toEqual(
        near(month),
      );
    }
  });

  test('the per-route records come back as their own rows, and the screen nests them under their measure', async () => {
    await seed();
    const issues = scorecardMeasures(await scorecard(), '7').find(
      (m) => m.name === 'sdlc.issues_merged',
    );
    expect(issues?.routeRows.map((r) => [r.route, r.nNow])).toEqual([
      ['deliver', 6],
      ['investigate', 2],
      ['plan', 6],
    ]);
  });

  test('a comparison resting on fewer than 10 records is too few, for the routes and the lines but not the rest', async () => {
    await seed();
    const measures = scorecardMeasures(await scorecard(), '7');
    const by = (name: string) => measures.find((m) => m.name === name);
    expect(by('sdlc.issues_merged')?.routeRows.map((r) => [r.route, r.tooFew])).toEqual([
      ['deliver', true],
      ['investigate', true],
      ['plan', true],
    ]);
    expect(by('sdlc.test_lines_added')?.tooFew).toBe(true);
    expect(by('sdlc.production_lines_added')?.tooFew).toBe(true);
    expect(by('sdlc.review_rounds')?.tooFew).toBe(false);
    expect(by('sdlc.review_rounds')?.change).toBeCloseTo(40 / 14 - 3, 9);
  });

  test('a second run that records a subject again replaces its value and adds no record (queryMetrics rule 4)', async () => {
    await seed();
    await metricsRun(REPOSITORY, [record('sdlc.review_rounds', 5, { at: '2026-11-11T11:59:00Z' })]);
    const after = await row('sdlc.review_rounds');
    expect(after?.n_7).toBe(14);
    expect(after?.value_7).toBeCloseTo((40 - 1 + 5) / 14, 9);
  });

  test('a later failure of the node drops that run’s records, so the earlier run counts again (rule 1)', async () => {
    await seed();
    const second = await metricsRun(REPOSITORY, [
      record('sdlc.review_rounds', 5, { at: '2026-11-11T11:59:00Z' }),
    ]);
    await db.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, created_at)
       VALUES ($1, 'node_failed', 'prs', '{"type":"script"}'::jsonb, '2026-11-11T14:00:00Z')`,
      [second],
    );
    expect((await row('sdlc.review_rounds'))?.value_7).toBeCloseTo(40 / 14, 9);
  });

  test('a record whose unit disagrees with its name’s first record is not counted (rule 2)', async () => {
    await seed();
    await metricsRun(REPOSITORY, [
      record('sdlc.review_rounds', 9, {
        unit: 'days',
        subject: 'a-new-subject',
        at: '2026-11-11T11:00:00Z',
      }),
    ]);
    const after = await row('sdlc.review_rounds');
    expect(after?.n_7).toBe(14);
    expect(after?.unit).toBe('rounds');
  });

  test('a record falls in a window by its at, else by when its event completed (rule 5)', async () => {
    const count = (subject: string, at?: string) =>
      record('sdlc.issues_merged', 1, {
        kind: 'count',
        unit: 'issues',
        subject,
        ...(at && { at }),
      });
    await metricsRun(
      REPOSITORY,
      [count('#1', '2026-11-11T23:59:59Z'), count('#2', '2026-11-12T00:00:00Z'), count('#3')],
      '2026-11-05T10:00:00Z',
    );
    await metricsRun(REPOSITORY, [count('#4')], '2026-11-04T23:00:00Z');
    const merged = await row('sdlc.issues_merged');
    expect([merged?.n_7, merged?.value_7, merged?.n_7_before]).toEqual([2, 2, 1]);
  });

  test('another factory’s records never appear, and it reads only its own (Never 9)', async () => {
    await seed();
    expect(await scorecard('other')).toEqual([]);
    await metricsRun('o/other', [
      record('sdlc.review_rounds', 5, { subject: 'o/other#1', at: '2026-11-11T11:00:00Z' }),
    ]);
    const own = await scorecard('other');
    expect(own.map((r) => [r.name, r.n_7, r.value_7])).toEqual([['sdlc.review_rounds', 1, 5]]);
    expect((await row('sdlc.review_rounds'))?.n_7).toBe(14);
  });

  test('runs in under 100 ms on the fixture records (PRD 8.4)', async () => {
    await seed();
    await db.query('ANALYZE');
    const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [
      'mission-control',
      UNTIL,
    ])) as unknown as { 'QUERY PLAN': { 'Execution Time': number }[] }[];
    expect(plan[0]?.['QUERY PLAN'][0]?.['Execution Time']).toBeLessThan(100);
  });
});

test('the fixture is relative to now and never in the future', () => {
  const records = metricRecordsFixture(NOW);
  expect(records).toHaveLength(106 * 8 + 106 * 4 + 11 * 2);
  expect(records.every((r) => new Date(r.at) < NOW)).toBe(true);
});
