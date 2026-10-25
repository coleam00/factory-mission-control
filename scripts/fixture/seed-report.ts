import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tx } from '../lib/db';

// What the seed must hold (issue #7's outcome list) and the scorecard it must produce, as read-only
// queries, so the offline test on PGlite and `fixture:verify` on a check branch ask the same thing.

const MARKER = 'HOLDOUT-TEXT-MARKER';

export type Minimum = { name: string; value: number; min: number };

export async function tableCounts(tx: Tx): Promise<{ table: string; rows: number }[]> {
  const tables = await tx.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'mc' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const counts: { table: string; rows: number }[] = [];
  for (const { table_name } of tables) {
    const [row] = await tx.query(`SELECT count(*)::int AS n FROM mc."${table_name}"`);
    counts.push({ table: `mc.${table_name}`, rows: Number(row?.n) });
  }
  return counts;
}

/** A lap's outcome, by the first rule that matches (the recent-laps outcomes, PRD 4.3). */
const LAP_OUTCOMES = `
  SELECT l.run_id, CASE
    WHEN l.status = 'failed' THEN 'failed'
    WHEN land.output->>'outcome' = 'merged' THEN 'merged'
    WHEN land.output->>'outcome' = 'refused' THEN 'gate-refused'
    WHEN review.output->>'outcome' = 'sent-back' THEN 'sent-back'
    WHEN review.output->>'outcome' = 'needs-owner' THEN 'needs-owner'
    WHEN pick.output->>'route' = 'none' THEN 'nothing-to-do'
  END AS outcome
  FROM mc.laps l
  LEFT JOIN mc.lap_steps pick ON pick.run_id = l.run_id AND pick.step_id = 'pick'
  LEFT JOIN mc.lap_steps review ON review.run_id = l.run_id AND review.step_id = 'review'
  LEFT JOIN mc.lap_steps land ON land.run_id = l.run_id AND land.step_id = 'land'`;

/** A failed lap's cause, from its failing step's error (PRD 4.8). */
const FAILURE_CAUSES = `
  SELECT CASE
    WHEN s.error ~* 'usage limit|429' THEN 'usage-limit'
    WHEN s.error ~* '401|unauthor' THEN 'authentication'
    WHEN s.error ~* 'ECONN|ETIMEDOUT|fetch failed' THEN 'infrastructure'
    ELSE 'other'
  END AS cause
  FROM mc.laps l JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.status = 'failed'
  WHERE l.status = 'failed'`;

/** The longest path, in issues, through `Depends on` edges between open issues. */
const OPEN_CHAIN = `
  WITH RECURSIVE open_edge AS (
    SELECT d.issue_number, d.depends_on FROM mc.issue_dependencies d
    JOIN mc.issues a ON a.factory = d.factory AND a.number = d.issue_number AND a.state = 'open'
    JOIN mc.issues b ON b.factory = d.factory AND b.number = d.depends_on AND b.state = 'open'
  ), chain(head, length) AS (
    SELECT depends_on, 2 FROM open_edge
    UNION ALL
    SELECT e.depends_on, c.length + 1 FROM chain c JOIN open_edge e ON e.issue_number = c.head
  )
  SELECT coalesce(max(length), 0) AS n FROM chain`;

const MINIMUMS: { name: string; min: number; sql: string }[] = [
  { name: 'versions', min: 3, sql: 'SELECT count(*) AS n FROM mc.versions' },
  ...['merged', 'sent-back', 'gate-refused', 'needs-owner', 'nothing-to-do', 'failed'].map(
    (outcome) => ({
      name: `laps.${outcome}`,
      min: 2,
      sql: `SELECT count(*) AS n FROM (${LAP_OUTCOMES}) o WHERE o.outcome = '${outcome}'`,
    }),
  ),
  ...['usage-limit', 'authentication', 'infrastructure', 'other'].map((cause) => ({
    name: `failed-laps.${cause}`,
    min: 1,
    sql: `SELECT count(*) AS n FROM (${FAILURE_CAUSES}) f WHERE f.cause = '${cause}'`,
  })),
  {
    name: 'running-laps',
    min: 2,
    sql: `SELECT count(*) AS n FROM mc.laps WHERE status = 'running'`,
  },
  {
    name: 'running-laps.distinct-steps',
    min: 2,
    sql: `SELECT count(DISTINCT s.step_id) AS n FROM mc.laps l
      JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.status = 'running' WHERE l.status = 'running'`,
  },
  { name: 'pending', min: 1, sql: `SELECT count(*) AS n FROM mc.laps WHERE status = 'pending'` },
  { name: 'paused', min: 1, sql: `SELECT count(*) AS n FROM mc.laps WHERE status = 'paused'` },
  { name: 'issues', min: 12, sql: 'SELECT count(*) AS n FROM mc.issues' },
  { name: 'phases', min: 3, sql: 'SELECT count(DISTINCT phase) AS n FROM mc.issues' },
  {
    name: 'issues.with-depends-on',
    min: 1,
    sql: 'SELECT count(DISTINCT issue_number) AS n FROM mc.issue_dependencies',
  },
  { name: 'open-chain', min: 3, sql: OPEN_CHAIN },
  {
    name: 'owner-questions.open',
    min: 2,
    sql: 'SELECT count(*) AS n FROM mc.owner_questions WHERE closed_at IS NULL',
  },
  {
    name: 'holdout-verdicts.pass',
    min: 1,
    sql: `SELECT count(*) AS n FROM mc.holdout_verdicts WHERE verdict = 'PASS'`,
  },
  {
    name: 'holdout-verdicts.fail-with-issue',
    min: 1,
    sql: `SELECT count(*) AS n FROM mc.holdout_verdicts WHERE verdict = 'FAIL' AND issue_number IS NOT NULL`,
  },
  { name: 'decisions', min: 3, sql: 'SELECT count(*) AS n FROM mc.decisions' },
  {
    name: 'decisions.joined-to-a-pin',
    min: 2,
    sql: `SELECT count(*) AS n FROM mc.decisions d
      WHERE EXISTS (SELECT 1 FROM mc.pins p WHERE p.sha LIKE d.version || '%')`,
  },
  ...['criterion', 'holdout', 'probe', 'defect'].map((kind) => ({
    name: `app-check-lines.${kind}`,
    min: 1,
    sql: `SELECT count(*) AS n FROM mc.app_check_lines WHERE kind = '${kind}'`,
  })),
  {
    name: 'app-check-lines.holdout-fail-empty-pre-existing',
    min: 1,
    sql: `SELECT count(*) AS n FROM mc.app_check_lines
      WHERE kind = 'holdout' AND verdict = 'FAIL' AND pre_existing = ''`,
  },
  {
    name: 'app-check-lines.holdout-unidentified',
    min: 1,
    sql: `SELECT count(*) AS n FROM mc.app_check_lines WHERE scenario_id = 'unidentified'`,
  },
  { name: 'arch-versions', min: 2, sql: 'SELECT count(*) AS n FROM mc.arch_versions' },
];

export async function minimums(tx: Tx): Promise<Minimum[]> {
  const found: Minimum[] = [];
  for (const { name, min, sql } of MINIMUMS) {
    const [row] = await tx.query(sql);
    found.push({ name, value: Number(row?.n), min });
  }
  return found;
}

/** Rows holding the marker: in every text-like column of `mc`, and in Archon's events. */
export async function markerHits(tx: Tx): Promise<{ dashboard: number; archonEvents: number }> {
  const columns = await tx.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'mc'
       AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'ARRAY')
     ORDER BY table_name, column_name`,
  );
  let dashboard = 0;
  for (const { table_name, column_name } of columns) {
    const [row] = await tx.query(
      `SELECT count(*)::int AS n FROM mc."${table_name}" WHERE "${column_name}"::text LIKE $1`,
      [`%${MARKER}%`],
    );
    dashboard += Number(row?.n);
  }
  const [archon] = await tx.query(
    'SELECT count(*)::int AS n FROM remote_agent_workflow_events WHERE data::text LIKE $1',
    [`%${MARKER}%`],
  );
  return { dashboard, archonEvents: Number(archon?.n) };
}

/** The result of fixtures/expected-scorecard.sql, read as JSON text so every driver agrees. */
export async function scorecard(tx: Tx, repoRoot: string): Promise<unknown> {
  const sql = readFileSync(join(repoRoot, 'fixtures', 'expected-scorecard.sql'), 'utf8')
    .trimEnd()
    .replace(/;$/, '');
  const [row] = await tx.query(`SELECT scorecard::text AS text FROM (${sql}\n) AS expected`);
  return JSON.parse(String(row?.text));
}

export type Counts = {
  tables: { table: string; rows: number }[];
  minimums: Minimum[];
  markers: { dashboard: number; archonEvents: number };
};

export async function counts(tx: Tx): Promise<Counts> {
  return {
    tables: await tableCounts(tx),
    minimums: await minimums(tx),
    markers: await markerHits(tx),
  };
}

/** One fact per line, each ending in `ok` or `SHORT`; `ok` is false when any line is SHORT. */
export function formatCounts({ tables, minimums: found, markers }: Counts): {
  text: string;
  ok: boolean;
} {
  const verdict = (pass: boolean) => (pass ? 'ok' : 'SHORT');
  const lines = [
    ...tables.map((t) => `table ${t.table} ${t.rows} >= 1 ${verdict(t.rows >= 1)}`),
    ...found.map((m) => `minimum ${m.name} ${m.value} >= ${m.min} ${verdict(m.value >= m.min)}`),
    `marker dashboard ${markers.dashboard} == 0 ${verdict(markers.dashboard === 0)}`,
    `marker archon-events ${markers.archonEvents} >= 1 ${verdict(markers.archonEvents >= 1)}`,
  ];
  return { text: lines.join('\n'), ok: lines.every((line) => line.endsWith(' ok')) };
}

export function formatScorecard(actual: unknown, expected: unknown): { text: string; ok: boolean } {
  const ok = Bun.deepEquals(actual, expected);
  return {
    text: `${JSON.stringify(actual, null, 2)}\nmatches fixtures/expected-scorecard.json: ${ok ? 'yes' : 'no'}`,
    ok,
  };
}
