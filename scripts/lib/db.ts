import { SQL } from 'bun';

export type Row = Record<string, unknown>;

export interface Tx {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}

export interface Db extends Tx {
  transaction(fn: (tx: Tx) => Promise<void>): Promise<void>;
  /** Pools only: the next transaction dials a new connection; one already running finishes. */
  dropIdleConnections?(): Promise<void>;
  close(): Promise<void>;
}

export type OpenDb = (url: string) => Db;

/** Bun's client connects on the first query, so opening is free until something runs. */
export const openDb: OpenDb = (url) => {
  let sql = new SQL(url);
  const queryOn =
    (client: SQL) =>
    async (text: string, params?: unknown[]): Promise<Row[]> => [
      ...(await (params ? client.unsafe(text, params) : client.unsafe(text))),
    ];
  return {
    query: (text, params) => queryOn(sql)(text, params),
    async transaction(fn) {
      await sql.begin((tx) => fn({ query: queryOn(tx) }));
    },
    async dropIdleConnections() {
      const ended = sql;
      sql = new SQL(url);
      // close() with no timeout lets a transaction already running on the old pool finish.
      ended.close().catch(() => {});
    },
    close: () => sql.close(),
  };
};
