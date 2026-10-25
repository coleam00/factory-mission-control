import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/cli';
import type { Db } from '../lib/db';
import { buildSeed, seededDb } from './seed';
import { markerHits, minimums, scorecard, tableCounts } from './seed-report';
import { writeRow } from './write';

const fixture = (name: string) => readFileSync(join(REPO_ROOT, 'fixtures', name), 'utf8');

let seed = '';
let db: Db;

beforeAll(async () => {
  seed = buildSeed(REPO_ROOT);
  db = await seededDb(REPO_ROOT, fixture('seed.sql'));
}, 60_000);
afterAll(() => db.close());

test('fixtures/seed.sql is what `bun run fixture:seed` writes', () => {
  // A mismatch means the generator, the pack or a parser changed: run `bun run fixture:seed`.
  expect(seed === fixture('seed.sql')).toBe(true);
});

test('the scorecard SQL on the seed is exactly fixtures/expected-scorecard.json', async () => {
  expect(await scorecard(db, REPO_ROOT)).toEqual(JSON.parse(fixture('expected-scorecard.json')));
});

test('the seed meets every minimum of the outcome list', async () => {
  const short = (await minimums(db)).filter((m) => m.value < m.min);
  expect(short).toEqual([]);
});

test('every dashboard table has a row', async () => {
  const empty = (await tableCounts(db)).filter((t) => t.rows < 1);
  expect(empty).toEqual([]);
});

test("holdout text is in Archon's events and in no dashboard row", async () => {
  const hits = await markerHits(db);
  expect(hits.dashboard).toBe(0);
  expect(hits.archonEvents).toBeGreaterThan(0);
});

const ROLLED_BACK = new Error('rolled back');

test.each(['label', 'comment', 'issue', 'pin', 'verdict', 'decision'] as const)(
  'fixture:write %s adds one row to a seeded branch',
  async (kind) => {
    // writeRow throws unless its table gained exactly one row; the rollback keeps the seed as loaded.
    const written = db.transaction(async (tx) => {
      await writeRow(tx, kind, new Date('2026-10-25T08:00:00Z'));
      throw ROLLED_BACK;
    });
    await expect(written).rejects.toBe(ROLLED_BACK);
  },
);

// The shapes the timeline, architecture-diff and stuck-step panels need, which no count implies.

test('V1 pins every trailer, V2 only a measure, V3 none', async () => {
  const pins = await db.query(
    `SELECT p.hypothesis IS NOT NULL AS hypothesis, p.measure IS NOT NULL AS measure,
       EXISTS (SELECT 1 FROM mc.verdicts v WHERE v.pin = left(p.sha, 8)) AS verdict
     FROM mc.pins p ORDER BY p.committed_at`,
  );
  expect(pins).toEqual([
    { hypothesis: true, measure: true, verdict: true },
    { hypothesis: false, measure: true, verdict: false },
    { hypothesis: false, measure: false, verdict: false },
  ]);
});

test("V2's architecture is V1's with one step added, one removed, one prompt and one subagent changed", async () => {
  const diff = await db.query(
    `WITH v AS (
       SELECT archon_sha, factory_sha, row_number() OVER (ORDER BY parsed_at) AS n FROM mc.arch_versions
     ), v1 AS (SELECT * FROM v WHERE n = 1), v2 AS (SELECT * FROM v WHERE n = 2),
     steps AS (
       SELECT s.workflow, s.step_id, s.path, v1.n IS NOT NULL AS in_v1 FROM mc.arch_steps s
       LEFT JOIN v1 USING (archon_sha, factory_sha) LEFT JOIN v2 USING (archon_sha, factory_sha)
       WHERE v1.n IS NOT NULL OR v2.n IS NOT NULL
     )
     SELECT 'removed' AS change, step_id AS name FROM steps a WHERE in_v1
       AND NOT EXISTS (SELECT 1 FROM steps b WHERE NOT b.in_v1 AND b.workflow = a.workflow AND b.path = a.path)
     UNION ALL
     SELECT 'added', step_id FROM steps a WHERE NOT in_v1
       AND NOT EXISTS (SELECT 1 FROM steps b WHERE b.in_v1 AND b.workflow = a.workflow AND b.path = a.path)
     UNION ALL
     SELECT 'prompt', t1.path FROM mc.arch_texts t1 JOIN v1 USING (archon_sha, factory_sha)
       JOIN mc.arch_texts t2 ON t2.path = t1.path AND t2.text <> t1.text
       JOIN v2 ON v2.archon_sha = t2.archon_sha AND v2.factory_sha = t2.factory_sha
     UNION ALL
     SELECT 'subagent', a1.name FROM mc.arch_subagents a1 JOIN v1 USING (archon_sha, factory_sha)
       JOIN mc.arch_subagents a2 ON a2.workflow = a1.workflow AND a2.step_path = a1.step_path
         AND a2.name = a1.name AND a2.description IS DISTINCT FROM a1.description
       JOIN v2 ON v2.archon_sha = a2.archon_sha AND v2.factory_sha = a2.factory_sha
     ORDER BY 1, 2`,
  );
  expect(diff).toEqual([
    { change: 'added', name: 'tally' },
    { change: 'prompt', name: 'loop/commands/loop-review.md' },
    { change: 'removed', name: 'briefs' },
    { change: 'subagent', name: 'holdout-writer' },
  ]);
});

test('one running lap has been on its step for over a day', async () => {
  const [row] = await db.query(
    `SELECT count(*)::int AS n FROM mc.laps l
     JOIN mc.lap_steps s ON s.run_id = l.run_id AND s.status = 'running'
     WHERE l.status = 'running'
       AND s.started_at < (SELECT max(started_at) FROM mc.laps) - interval '1 day'`,
  );
  expect(row?.n).toBe(1);
});
