import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { Db, Row, Tx } from './db';

/** Without params a query is a file of several statements, which only exec runs. */
function txOn(client: PGlite | Transaction): Tx {
  return {
    async query(sql, params) {
      if (params) return (await client.query<Row>(sql, params)).rows;
      return ((await client.exec(sql)).at(-1)?.rows as Row[] | undefined) ?? [];
    },
  };
}

/** An in-memory Postgres behind the scripts' `Db`, for tests that run with no network. */
export function pgliteDb(pg: PGlite): Db {
  return {
    ...txOn(pg),
    async transaction(fn) {
      await pg.transaction((tx) => fn(txOn(tx)));
    },
    close: () => pg.close(),
  };
}
