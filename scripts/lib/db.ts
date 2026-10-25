import { SQL } from 'bun';

export type Row = Record<string, unknown>;

export interface Tx {
  query(sql: string, params?: unknown[]): Promise<Row[]>;
}

export interface Db extends Tx {
  transaction(fn: (tx: Tx) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

export type OpenDb = (url: string) => Db;

/** Bun's client connects on the first query, so opening is free until something runs. */
export const openDb: OpenDb = (url) => {
  const sql = new SQL(url);
  const queryOn =
    (client: SQL) =>
    async (text: string, params?: unknown[]): Promise<Row[]> => [
      ...(await (params ? client.unsafe(text, params) : client.unsafe(text))),
    ];
  return {
    query: queryOn(sql),
    async transaction(fn) {
      await sql.begin((tx) => fn({ query: queryOn(tx) }));
    },
    close: () => sql.close(),
  };
};
