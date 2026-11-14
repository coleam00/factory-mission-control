/**
 * Archon's state table as its own migrations make it (Postgres 18): the one definition the test
 * database and the fixture writer's `revision` both create from. Idempotent, because the
 * `fixture` branch predates the table and `revision` creates it where it is missing.
 */
export const STATE_REVISIONS_TABLE = `CREATE TABLE IF NOT EXISTS public.remote_agent_state_revisions (
    project_key text NOT NULL,
    name text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    value text,
    operation text NOT NULL,
    writer_kind text NOT NULL CHECK (writer_kind IN ('run', 'operator')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_key, name, revision))`;
