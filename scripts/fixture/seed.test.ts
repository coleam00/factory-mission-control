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
