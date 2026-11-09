import { expect, test } from 'bun:test';
import { archonDb, migrationFiles } from '../db/test-db';
import { WORKFLOW } from './fixture/write';
import { runMigrations } from './migrate';
import { CASES, PROJECTION_TABLES } from './projection-locks';

async function migrated() {
  const db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
  return db;
}

test('the proof locks every mc table a projection function reads or writes, each in a narrower table-lock case than the all-tables one', async () => {
  const db = await migrated();
  const functions = await db.query(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'mc'`,
  );
  const tables = new Set(
    (
      await db.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'mc' AND c.relkind IN ('r', 'p')`,
      )
    ).map((row) => String(row.relname)),
  );
  const referenced = new Set(
    functions
      .flatMap((fn) =>
        [...String(fn.prosrc).matchAll(/\bmc\.(\w+)/gi)].map((m) => String(m[1]).toLowerCase()),
      )
      .filter((name) => tables.has(name)),
  );
  expect([...referenced].sort()).toEqual([...PROJECTION_TABLES].sort());
  for (const table of referenced) {
    const targeted = CASES.filter(
      (c) =>
        c.lock?.mode === 'table' &&
        c.lock.tables.length < PROJECTION_TABLES.length &&
        c.lock.tables.includes(table),
    );
    expect([table, targeted.length > 0]).toEqual([table, true]);
  }
  await db.close();
});

// A revoked table fails any statement that touches it, read or write, as a lock does; a row lock
// is emulated by revoking its whole table, which is enough while no case writes other rows of it. Privileges do not stop a foreign-key check or cascade (they run as the
// table owner), which a live lock would block; the live run proves those.
test('each case leaves the projection errors it declares when its held tables fail as a lock does', async () => {
  const db = await migrated();
  await db.query(`INSERT INTO remote_agent_codebases (name) VALUES ('cb')`);
  await db.query(
    `INSERT INTO mc.factories (name, repository, codebase, console) VALUES ('f', 'o/r', 'cb', 'c')`,
  );
  await db.query(`CREATE ROLE archon_writer`);
  await db.query(`GRANT USAGE ON SCHEMA mc TO archon_writer;
    GRANT ALL ON ALL TABLES IN SCHEMA public, mc TO archon_writer;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public, mc TO archon_writer`);
  const [run] = await db.query(
    `INSERT INTO remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ($1, 'running', 'lock wait check', '{}'::jsonb) RETURNING id`,
    [WORKFLOW],
  );
  const runId = String(run?.id);
  const errorCount = async () =>
    Number((await db.query('SELECT count(*)::int AS n FROM mc.projection_errors'))[0]?.n);

  const results: [string, number][] = [];
  for (const check of CASES) {
    const lock = check.lock;
    const held = lock ? `mc.${lock.mode === 'table' ? lock.tables.join(', mc.') : lock.table}` : '';
    if (lock) await db.query(`REVOKE ALL ON ${held} FROM archon_writer`);
    const before = await errorCount();
    await db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE archon_writer', []);
      await check.write(tx, runId);
    });
    const added = (await errorCount()) - before;
    if (lock) await db.query(`GRANT ALL ON ${held} TO archon_writer`);
    results.push([check.name, added]);
  }
  expect(results).toEqual(CASES.map((c) => [c.name, c.errors]));
  await db.close();
});
