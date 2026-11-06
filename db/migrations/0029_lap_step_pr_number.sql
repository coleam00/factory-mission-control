-- The pull request a step's `pr` output names, projected as mc.lap_steps.pr_number (issue #363).
-- home-map.sql, board.sql and app-check.sql each parsed `pr` with their own trailing-digits regex,
-- which misses a JSON object's number and reads digits out of an issue URL or free text. The rule
-- is app/lib/one-lap.ts prNumber's: `#N`, `N`, a /pull/N URL, or a JSON object's number or url.
-- mc.pr_number is that rule, held to it by db/queries/restated-rules.test.ts. The live queries may
-- not call an mc function (db/queries/REALTIME.md), so a BEFORE trigger writes its result into a
-- column they read. Like 0006's functions it never raises: it runs inside the projection's
-- transaction, so a number too large for integer reads as NULL, as no pull request has it.
-- Run again, it changes nothing.

CREATE OR REPLACE FUNCTION mc.pr_number(p_text text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN m IS NOT NULL THEN
      CASE WHEN length(coalesce(m[1], m[2])) <= 10 THEN
        CASE WHEN coalesce(m[1], m[2])::bigint <= 2147483647 THEN coalesce(m[1], m[2])::integer END
      END
    WHEN starts_with(t, '{') THEN
      CASE WHEN pg_input_is_valid(t, 'jsonb') THEN
        CASE WHEN jsonb_typeof(t::jsonb) <> 'object' THEN NULL
          WHEN jsonb_typeof(t::jsonb -> 'number') = 'number' THEN
            CASE WHEN (t::jsonb ->> 'number')::numeric > 0
                AND (t::jsonb ->> 'number')::numeric = trunc((t::jsonb ->> 'number')::numeric) THEN
              CASE WHEN (t::jsonb ->> 'number')::numeric <= 2147483647
                THEN (t::jsonb ->> 'number')::numeric::integer END
              WHEN jsonb_typeof(t::jsonb -> 'url') = 'string' THEN mc.pr_number(t::jsonb ->> 'url')
            END
          WHEN jsonb_typeof(t::jsonb -> 'url') = 'string' THEN mc.pr_number(t::jsonb ->> 'url')
        END
      END
  END
  FROM (SELECT regexp_replace(coalesce(p_text, ''),
      '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
      '', 'g') AS t) x
  CROSS JOIN LATERAL (SELECT regexp_match(x.t,
      '^#?([0-9]+)$|^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/([0-9]+)/?$') AS m) y
$$;
ALTER TABLE mc.lap_steps ADD COLUMN IF NOT EXISTS pr_number integer;
CREATE OR REPLACE FUNCTION mc.set_lap_step_pr_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.pr_number := mc.pr_number(NEW.output ->> 'pr');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lap_steps_pr_number ON mc.lap_steps;
CREATE TRIGGER lap_steps_pr_number BEFORE INSERT OR UPDATE ON mc.lap_steps
  FOR EACH ROW EXECUTE FUNCTION mc.set_lap_step_pr_number();
UPDATE mc.lap_steps SET pr_number = mc.pr_number(output ->> 'pr')
WHERE pr_number IS DISTINCT FROM mc.pr_number(output ->> 'pr');
