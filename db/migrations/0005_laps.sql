-- Laps and their steps, projected from Archon's runs and step-level events (PRD 11.2, 11.4).
-- Keyed by Archon's run id and step id, so a replayed event updates its row.

CREATE TABLE IF NOT EXISTS mc.laps (
  run_id uuid PRIMARY KEY,
  factory text NOT NULL,
  workflow_name text NOT NULL,
  status text NOT NULL,
  digest text,
  started_at timestamptz,
  completed_at timestamptz
);

-- One row per step a lap ran. output is the step's structured_output; the check-app step's
-- `lines` never enter it (they are mc.app_check_lines, without their text).
CREATE TABLE IF NOT EXISTS mc.lap_steps (
  run_id uuid NOT NULL,
  step_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint,
  provider text,
  model text,
  tokens_input bigint,
  tokens_output bigint,
  tokens_cache_read bigint,
  tokens_cache_write bigint,
  cost_usd numeric,
  error text,
  output jsonb CHECK (NOT output ? 'lines'),
  PRIMARY KEY (run_id, step_id)
);

-- One row per line of a lap's check-app report, by its 1-based position in `lines`. Never the
-- line's text: a holdout line keeps only its scenario id (PRD 6.3, 11.7).
CREATE TABLE IF NOT EXISTS mc.app_check_lines (
  run_id uuid NOT NULL,
  position integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('criterion', 'holdout', 'probe', 'defect')),
  verdict text NOT NULL CHECK (verdict ~ '^[A-Z]{2,16}$'),
  evidence_count integer NOT NULL,
  pre_existing text NOT NULL DEFAULT '',
  scenario_id text CHECK (scenario_id ~ '^(H-[0-9]{2,}|unidentified)$'),
  CHECK ((kind = 'holdout') = (scenario_id IS NOT NULL)),
  PRIMARY KEY (run_id, position)
);
