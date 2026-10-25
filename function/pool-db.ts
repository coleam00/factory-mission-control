// The scripts' `Db` over a node-postgres pool: what the deployed Function writes through.
import type pg from 'pg';
import type { Db, Row, Tx } from '../scripts/lib/db';

// node-postgres sends a JS array as a Postgres array literal; every array ingest passes is `$n::jsonb`.
const asJson = (params?: unknown[]) =>
  params?.map((value) => (Array.isArray(value) ? JSON.stringify(value) : value));

const queryOn =
  (client: pg.Pool | pg.PoolClient) =>
  async (text: string, params?: unknown[]): Promise<Row[]> =>
    (await client.query(text, asJson(params))).rows;

export function poolDb(pool: pg.Pool): Db {
  return {
    query: queryOn(pool),
    async transaction(fn) {
      const client = await pool.connect();
      // Set when ROLLBACK itself fails: the client is broken, so the pool destroys it.
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        await fn({ query: queryOn(client) } satisfies Tx);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          broken =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        // The delivery's own error, never the rollback's.
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}
