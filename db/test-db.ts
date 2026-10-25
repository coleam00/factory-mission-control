import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Row, Tx } from '../scripts/lib/db';

/** Without params a migration file is several statements, which only exec runs. */
function txOn(client: PGlite | Transaction): Tx {
  return {
    async query(sql, params) {
      if (params) return (await client.query<Row>(sql, params)).rows;
      return ((await client.exec(sql)).at(-1)?.rows as Row[] | undefined) ?? [];
    },
  };
}

/** An in-memory Postgres behind the scripts' `Db`, for tests that need real SQL and no network. */
export function testDb(): Db {
  const pg = new PGlite();
  return {
    ...txOn(pg),
    async transaction(fn) {
      await pg.transaction((tx) => fn(txOn(tx)));
    },
    close: () => pg.close(),
  };
}

/** Every row of every table in `mc`, so a comparison sees any change at all. */
export async function snapshot(db: Tx): Promise<Record<string, string[]>> {
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'mc' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const all: Record<string, string[]> = {};
  for (const { table_name } of tables) {
    const rows = await db.query(
      `SELECT to_jsonb(t)::text AS row FROM mc.${String(table_name)} t ORDER BY 1`,
      [],
    );
    all[String(table_name)] = rows.map((r) => String(r.row));
  }
  return all;
}
