-- Pins by factory (#85): a pin records the factory whose versions repository it came from, and a
-- version is labelled only by its own factory's pins, so a pin appears on that factory's versions
-- alone. Every pin before this came from coleam00/ai-software-factory, which versions only
-- mission-control (PRD 11.6), so each is assigned to mission-control.
--
-- The column is filled after the functions are replaced, so the backfill's mc_label_versions run
-- relabels every version under the new rule in this transaction. 0008's lock behaviour is kept.

ALTER TABLE mc.pins ADD COLUMN IF NOT EXISTS factory text;

-- The pin a factory's version first run at this time ran under: its latest committed before it.
CREATE OR REPLACE FUNCTION mc.version_pin(p_factory text, p_first_run_at timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT p.sha FROM mc.pins p WHERE p.factory = p_factory AND p.committed_at < p_first_run_at
  ORDER BY p.committed_at DESC, p.sha DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION mc.project_version(p_factory text, p_digest text)
RETURNS boolean LANGUAGE plpgsql
SET lock_timeout = '100ms' AS $$
DECLARE
  v_first timestamptz;
  v_pin text;
  v_written integer;
BEGIN
  SELECT min(l.started_at) INTO v_first FROM mc.laps l
  WHERE l.factory = p_factory AND l.digest = p_digest AND l.workflow_name = 'archon-loop'
    AND EXISTS (SELECT 1 FROM mc.factories f WHERE f.name = l.factory);
  IF v_first IS NULL THEN
    DELETE FROM mc.versions v WHERE v.factory = p_factory AND v.digest = p_digest;
    GET DIAGNOSTICS v_written = ROW_COUNT;
    RETURN v_written > 0;
  END IF;
  v_pin := mc.version_pin(p_factory, v_first);
  IF EXISTS (SELECT 1 FROM mc.versions v WHERE v.factory = p_factory AND v.digest = p_digest
      AND v.first_run_at = v_first AND v.pin_sha IS NOT DISTINCT FROM v_pin) THEN
    RETURN false;
  END IF;
  INSERT INTO mc.versions AS v (factory, digest, first_run_at, pin_sha)
  VALUES (p_factory, p_digest, v_first, v_pin)
  ON CONFLICT (factory, digest) DO UPDATE SET
    first_run_at = EXCLUDED.first_run_at,
    pin_sha = EXCLUDED.pin_sha
  WHERE (v.first_run_at, v.pin_sha) IS DISTINCT FROM (EXCLUDED.first_run_at, EXCLUDED.pin_sha);
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written > 0;
END;
$$;

CREATE OR REPLACE FUNCTION mc.label_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mc.versions v SET pin_sha = mc.version_pin(v.factory, v.first_run_at)
  WHERE v.pin_sha IS DISTINCT FROM mc.version_pin(v.factory, v.first_run_at);
  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS mc.version_pin(timestamptz);

UPDATE mc.pins SET factory = 'mission-control' WHERE factory IS NULL;
ALTER TABLE mc.pins ALTER COLUMN factory SET NOT NULL;
