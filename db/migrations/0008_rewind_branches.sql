-- Rewind branches (PRD 4.7; owner decision on #24): one row per branch `bun run rewind:create`
-- made, written on the branch the dashboard serves once the rewind branch exists, so the rewind
-- branch never holds its own row. The dashboard reads this table and never writes it.
CREATE TABLE IF NOT EXISTS mc.rewind_branches (
  name text PRIMARY KEY CHECK (name ~ '^rewind-[a-z0-9-]+$'),
  parent text NOT NULL,
  at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
