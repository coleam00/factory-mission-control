import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../scripts/lib/db';
import { runMigrations } from '../../scripts/migrate';
import { archonDb, migrationFiles } from '../test-db';

const sql = readFileSync(join(import.meta.dir, 'rewind-branches.sql'), 'utf-8');
let db: Db;

beforeAll(async () => {
  db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  await db.query(
    `INSERT INTO mc.factories (name, repository, codebase, console)
     VALUES ('mission-control', 'coleam00/factory-mission-control', 'mc', 'http://localhost')`,
  );
  await db.query(`INSERT INTO mc.rewind_branches (name, parent, at) VALUES
    ('rewind-2026-10-24t11-00-00z', 'main', '2026-10-24T11:00:00Z'),
    ('rewind-2026-10-25t09-30-00z', 'check-abc', '2026-10-25T09:30:00Z')`);
});

afterAll(() => db.close());

test('lists every rewind branch, newest moment first, with its parent and time', async () => {
  const rows = await db.query(sql, ['mission-control']);
  expect(rows.map((row) => [row.name, row.parent])).toEqual([
    ['rewind-2026-10-25t09-30-00z', 'check-abc'],
    ['rewind-2026-10-24t11-00-00z', 'main'],
  ]);
  expect(Object.keys(rows[0] ?? {})).toEqual(['name', 'parent', 'at', 'created_at']);
});

test('a factory the dashboard does not show sees none', async () => {
  expect(await db.query(sql, ['other'])).toEqual([]);
});

test('only rewind-* names can be registered', async () => {
  await expect(
    db.query(`INSERT INTO mc.rewind_branches (name, parent, at) VALUES ('main', 'main', now())`),
  ).rejects.toThrow('rewind_branches_name_check');
});
