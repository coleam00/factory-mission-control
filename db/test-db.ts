import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db, Row, Tx } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles } from '../scripts/migrate';

export const migrationFiles = readMigrationFiles(migrationsDir(join(import.meta.dir, '..')));

/**
 * The columns of Archon's tables the projection reads, with their types, defaults and keys as
 * the `fixture` branch has them (Postgres 18, Archon's own migrations).
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
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP);`;

/** Without params a migration file is several statements, which only exec runs. */
function txOn(client: PGlite | Transaction): Tx {
  return {
    async query(sql, params) {
      if (params) return (await client.query<Row>(sql, params)).rows;
      return ((await client.exec(sql)).at(-1)?.rows as Row[] | undefined) ?? [];
    },
  };
}

/** An in-memory Postgres behind the scripts' `Db`, holding Archon's tables and nothing else. */
export async function archonDb(): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    ...txOn(pg),
    async transaction(fn) {
      await pg.transaction((tx) => fn(txOn(tx)));
    },
    close: () => pg.close(),
  };
  await db.query(ARCHON_TABLES);
  return db;
}
