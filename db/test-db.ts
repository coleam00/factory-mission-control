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
