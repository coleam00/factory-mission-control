import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { migratedDb, queries } from './test-seed';

describe('against the migrated schema', () => {
  let db: Db;

  beforeAll(async () => {
    db = await migratedDb();
  });

  afterAll(() => db.close());

  test('factory-switcher lists every factory with its own running laps, $1 as the default', async () => {
    await db.query(`INSERT INTO mc.factories (name, repository, codebase, console) VALUES
      ('switch-a', 'o/a', 'o/a', 'http://localhost:3090'),
      ('switch-b', 'o/b', 'o/b', 'http://localhost:3090'),
      ('switch-c', 'o/c', 'o/c', 'http://localhost:3090')`);
    await db.query(`INSERT INTO mc.laps (run_id, factory, workflow_name, status) VALUES
      ('00000000-0000-0000-0000-0000000000b1', 'switch-a', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000b2', 'switch-a', 'archon-loop', 'completed'),
      ('00000000-0000-0000-0000-0000000000b3', 'switch-a', 'archon-manager', 'running'),
      ('00000000-0000-0000-0000-0000000000b4', 'switch-b', 'archon-loop', 'running'),
      ('00000000-0000-0000-0000-0000000000b5', 'switch-b', 'archon-loop', 'running')`);
    const sql = queries.find(([name]) => name === 'factory-switcher')?.[1] as string;
    const rows = await db.query(`SELECT * FROM (${sql}) s ORDER BY factory`, ['switch-a']);
    expect(rows).toEqual([
      { factory: 'switch-a', running: 1, is_default: true },
      { factory: 'switch-b', running: 2, is_default: false },
      { factory: 'switch-c', running: 0, is_default: false },
    ]);
    await db.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '%0000000000b_'`);
    await db.query(`DELETE FROM mc.factories WHERE name LIKE 'switch-%'`);
  });
});
