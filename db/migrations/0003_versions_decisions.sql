-- Pins, verdicts and decisions from coleam00/ai-software-factory (PRD 11.5), and the versions laps
-- ran, keyed by (factory, digest) (PRD 11.2).

-- One row per `Pin Archon <sha>: <reason>` commit.
CREATE TABLE IF NOT EXISTS mc.pins (
  sha text PRIMARY KEY,
  archon_sha text NOT NULL,
  reason text NOT NULL,
  hypothesis text,
  measure text,
  committed_at timestamptz NOT NULL
);

-- One row per commit carrying `Verdict: <pin sha> helped|hurt|inconclusive: <sentence>`.
CREATE TABLE IF NOT EXISTS mc.verdicts (
  sha text PRIMARY KEY,
  pin text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('helped', 'hurt', 'inconclusive')),
  sentence text NOT NULL,
  committed_at timestamptz NOT NULL
);

-- A workflow pack digest a factory's laps ran, labelled with the most recent pin committed before
-- its first run (pin_sha, null until known).
CREATE TABLE IF NOT EXISTS mc.versions (
  factory text NOT NULL,
  digest text NOT NULL,
  first_run_at timestamptz NOT NULL,
  pin_sha text,
  PRIMARY KEY (factory, digest)
);

-- One row per `DECISIONS.md` entry; `version` joins to mc.pins.sha by prefix.
CREATE TABLE IF NOT EXISTS mc.decisions (
  date date NOT NULL,
  title text NOT NULL,
  decision text NOT NULL,
  why text NOT NULL,
  replaces text NOT NULL,
  version text NOT NULL,
  PRIMARY KEY (date, title)
);
