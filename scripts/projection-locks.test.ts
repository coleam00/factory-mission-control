import { expect, test } from 'bun:test';
import { archonDb, migrationFiles } from '../db/test-db';
import { runMigrations } from './migrate';
import { CASES, PROJECTION_TABLES } from './projection-locks';

const WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+mc\.(\w+)/gi;

async function migrated() {
  const db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  return db;
}

test('the proof locks every mc table a projection function writes, each in a narrower case than the all-tables one', async () => {
  const db = await migrated();
  const functions = await db.query(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'mc'`,
  );
  const written = new Set(
    functions.flatMap((fn) => [...String(fn.prosrc).matchAll(WRITE)].map((m) => String(m[1]))),
  );
  expect(written.size).toBeGreaterThan(0);
  for (const table of written) {
    expect(PROJECTION_TABLES).toContain(table);
    const targeted = CASES.filter((c) => {
      const held: string[] = c.hold?.match(/mc\.\w+/g) ?? [];
      return held.length < PROJECTION_TABLES.length && held.includes(`mc.${table}`);
    });
    expect([table, targeted.length > 0]).toEqual([table, true]);
  }
  await db.close();
});

test('the writes of the work item and attention cases reach the table their lock holds', async () => {
  const db = await migrated();
  const reaches: [string, string][] = [
    ['mc.run_stops', 'run_stops'],
    ['mc.capacity_waits', 'capacity_waits'],
    ['mc.work_item_states', 'work_item_states'],
    ['mc.work_item_blockers', 'work_item_blockers'],
  ];
  for (const [lock, table] of reaches) {
    const check = CASES.find((c) => c.hold === `LOCK TABLE ${lock} IN ACCESS EXCLUSIVE MODE`);
    await db.transaction(async (tx) => {
      await check?.write(tx, '');
    });
    const [row] = await db.query(`SELECT count(*)::int AS n FROM mc.${table}`);
    expect([table, (row?.n as number) > 0]).toEqual([table, true]);
  }
  expect(await db.query('SELECT * FROM mc.projection_errors')).toEqual([]);
  await db.close();
});
