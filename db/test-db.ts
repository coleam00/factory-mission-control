import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Row, Tx } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles } from '../scripts/migrate';

export const migrationFiles = readMigrationFiles(migrationsDir(join(import.meta.dir, '..')));

/**
 * The columns of Archon's tables the projection reads, with their types, defaults and keys as
 * Archon's own migrations make them (Postgres 18). The `fixture` branch predates the state
 * table, so the migration that reads it guards on it.
 */
export const ARCHON_TABLES = `
  CREATE TABLE public.remote_agent_codebases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(255) NOT NULL);
  CREATE TABLE public.remote_agent_workflow_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_name varchar(255) NOT NULL,
    codebase_id uuid REFERENCES public.remote_agent_codebases(id) ON DELETE SET NULL,
    status varchar(20) NOT NULL DEFAULT 'pending',
    user_message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    started_at timestamptz DEFAULT now(),
    completed_at timestamptz,
    last_activity_at timestamptz DEFAULT now());
  CREATE INDEX idx_workflow_runs_status ON public.remote_agent_workflow_runs (status);
  CREATE TABLE public.remote_agent_workflow_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id uuid NOT NULL REFERENCES public.remote_agent_workflow_runs(id) ON DELETE CASCADE,
    event_order bigint,
    event_type varchar(50) NOT NULL,
    step_index integer,
    step_name varchar(255),
    data jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE public.remote_agent_state_revisions (
    project_key text NOT NULL,
    name text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    value text,
    operation text NOT NULL,
    writer_kind text NOT NULL CHECK (writer_kind IN ('run', 'operator')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_key, name, revision));`;

/** Without params a migration file is several statements, which only exec runs. */
function txOn(client: PGlite | Transaction): Tx {
  return {
    async query(sql, params) {
      if (params) return (await client.query<Row>(sql, params)).rows;
      return ((await client.exec(sql)).at(-1)?.rows as Row[] | undefined) ?? [];
    },
  };
}

export interface TestDb extends Db {
  /** The names of the columns `sql` returns, in order, rows or not. */
  columns(sql: string, params: unknown[]): Promise<string[]>;
}

/** An in-memory Postgres behind the scripts' `Db`, for tests that need real SQL and no network. */
export function testDb(): TestDb {
  const pg = new PGlite();
  return {
    ...txOn(pg),
    async transaction(fn) {
      await pg.transaction((tx) => fn(txOn(tx)));
    },
    columns: async (sql, params) => (await pg.query(sql, params)).fields.map((f) => f.name),
    close: () => pg.close(),
  };
}

/**
 * A `testDb` holding Archon's tables and nothing else, as every database the migrations run on
 * does: the projection's triggers are created on them.
 */
export async function archonDb(): Promise<TestDb> {
  const db = testDb();
  await db.query(ARCHON_TABLES);
  return db;
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
