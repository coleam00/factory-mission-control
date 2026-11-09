-- A build-queue round names its pull request as `pr_url`, never `pr` (issue #565), so 0029's
-- projection left those runs without a PR on the Runs page. A step's pr_number is now the number
-- of its `pr` output, or of its `pr_url` when it has no `pr`: one rule, read from the column by
-- every reader. A step with a `pr` resolves as before. Like 0029 it never raises, and run again it
-- changes nothing.

CREATE OR REPLACE FUNCTION mc.set_lap_step_pr_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.pr_number := mc.pr_number(coalesce(nullif(NEW.output ->> 'pr', ''), NEW.output ->> 'pr_url'));
  RETURN NEW;
END $$;
UPDATE mc.lap_steps SET pr_number = mc.pr_number(coalesce(nullif(output ->> 'pr', ''), output ->> 'pr_url'))
WHERE pr_number IS DISTINCT FROM mc.pr_number(coalesce(nullif(output ->> 'pr', ''), output ->> 'pr_url'));
