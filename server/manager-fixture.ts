import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { SQL } from 'bun';
import { ARCHON_TABLES, migrationFiles, type TestDb, testDbOn } from '../db/test-db';
import type { Db, Row, Tx } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';

export const FACTORY = 'mission-control';
export const FAILED_RUN = '5eed0001-0000-4000-8000-0000000000a1';
export const OTHER_RUN = '5eed0001-0000-4000-8000-0000000000a2';
export const WAITING_RUN = '5eed0001-0000-4000-8000-0000000000a3';

export interface ManagerDb {
  /** Bun's client over a socket, as the server and the tool subprocess open it. */
  db: Db;
  /** The same database, in-process, for seeding and snapshots. */
  direct: TestDb;
  url: string;
  stop(): Promise<void>;
}

/**
 * Bun's client as `openDb` builds it, on one connection: PGlite is one Postgres session behind
 * every socket connection, so a pool's second connection collides on prepared statement names.
 */
function singleConnection(url: string): Db {
  const sql = new SQL(url, { max: 1 });
  const on =
    (client: SQL): Tx['query'] =>
    async (text, params) => [
      ...((await (params ? client.unsafe(text, params) : client.unsafe(text))) as Row[]),
    ];
  return {
    query: on(sql),
    async transaction(fn) {
      await sql.begin((tx) => fn({ query: on(tx) }));
    },
    close: () => sql.close(),
  };
}

/** A migrated PGlite behind a socket, holding one factory, two laps, a waiting run and an issue. */
export async function startManagerDb(): Promise<ManagerDb> {
  const lite = new PGlite();
  const direct = testDbOn(lite);
  await direct.query(ARCHON_TABLES);
  await runMigrations({ files: migrationFiles, db: direct });
  await direct.query(
    `INSERT INTO mc.factories (name, repository, codebase, console)
       VALUES ('${FACTORY}', 'o/r', 'o/r', 'http://localhost:3090');
     INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at) VALUES
       ('${FAILED_RUN}', '${FACTORY}', 'archon-loop', 'failed', '2026-11-08T08:00:00Z', '2026-11-08T09:00:00Z'),
       ('${OTHER_RUN}', '${FACTORY}', 'archon-loop', 'completed', '2026-11-08T07:00:00Z', '2026-11-08T07:30:00Z');
     INSERT INTO mc.lap_steps (run_id, step_id, status) VALUES ('${FAILED_RUN}', 'implement', 'failed');
     INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
       VALUES ('${FACTORY}', 514, 'Manager backend', 'open', 'https://example.test/514', now(), now());
     INSERT INTO mc.attention_items (run_id, factory, workflow_name, node_id, waiting_since, form, options, labels, message)
       VALUES ('${WAITING_RUN}', '${FACTORY}', 'archon-loop', 'ask', now(), 'choice',
         '[{"id":"yes"},{"id":"no"}]', '{"yes":"Ship it"}', 'Ship?');`,
  );
  const socket = new PGLiteSocketServer({
    db: lite,
    port: 0,
    host: '127.0.0.1',
    maxConnections: 8,
  });
  await socket.start();
  const url = `postgres://postgres@${socket.getServerConn()}/postgres`;
  const db = singleConnection(url);
  return {
    db,
    direct,
    url,
    async stop() {
      await db.close();
      await socket.stop();
      await lite.close();
    },
  };
}
