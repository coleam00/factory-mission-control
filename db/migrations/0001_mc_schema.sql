-- The dashboard's own schema. Nothing here or in any later migration touches Archon's tables in
-- `public` (PRD invariant 2); triggers on them come with the projection.
CREATE SCHEMA IF NOT EXISTS mc;

-- factories.json (PRD 11.6), one row per factory. Every per-factory row names its factory here.
CREATE TABLE IF NOT EXISTS mc.factories (
  name text PRIMARY KEY,
  repository text NOT NULL,
  codebase text NOT NULL,
  console text NOT NULL
);

-- One row per error a projection trigger caught instead of raising (PRD 6.1, 11.4).
CREATE TABLE IF NOT EXISTS mc.projection_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  run_id uuid,
  event_id uuid,
  sqlstate text NOT NULL,
  message text NOT NULL
);
