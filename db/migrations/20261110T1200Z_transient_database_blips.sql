-- Issue #628: the owner saw failed scheduled ticks that a database blip caused ("Couldn't connect to compute node",
-- Postgres's "out of memory") and mc.stop_class left them unclassified, so Attention could not tell them
-- from a stuck factory. Both join the transient arm beside "deadlock detected". A JavaScript heap out of memory
-- stays out: it is a build or test failure, and a later run of the same workflow must not hide it.
-- Stored classes are re-projected once, as 0032 re-projected the stop line. Like 0031 it never raises into
-- Archon's write and, run again, changes nothing.

CREATE OR REPLACE FUNCTION mc.stop_class(p_error text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN r ~* 'usage limit|\m(http|status|error)[ :]*(code[ :]*)?429\M|\m429 (status|too many)' THEN 'transient'
    WHEN r ~* '\m(http|status|error)[ :]*(code[ :]*)?401\M|\m401 (status|oauth|unauthor)|unauthor' THEN 'config'
    WHEN r ~* 'ECONN|ETIMEDOUT|fetch failed' THEN 'transient'
    WHEN e IS NULL THEN NULL
    WHEN e ~* 'deadlock detected|usage or credit limit|rate.?limit|too many requests|overloaded|HTTP 5[0-9]{2}|\m5[0-9]{2} (bad gateway|gateway|service unavailable|internal server)|bad gateway|gateway time-?out|service unavailable|ENOTFOUND|connection terminated|timeout exceeded when trying to connect|provider reported transient|(?<!heap )out of memory|couldn.?t connect to compute node' THEN 'transient'
    WHEN e ~* 'provider reported auth|authenticat|configuration must be fixed|bad credentials|missing binding|no binding|binding [^ ]+ (is )?(missing|not set|undefined)|no schedule|schedule [^ ]+ (is )?(missing|not found)' THEN 'config'
    WHEN e ~* 'no issue matched|no matching issue|bad argument|invalid argument|unknown (option|argument)|missing required input' THEN 'input'
    WHEN e ~* 'check must write|not a git repository|push [^ ]+ refused|refused: |non-fast-forward|fetch first|\[rejected\]|merge --no-edit' THEN 'environment'
    WHEN ep ~* 'tests? failed|\m[0-9]+ (tests? )?fail|failing tests?|typecheck|type errors?|error TS[0-9]+|app check failed|app-check .*(FAIL|red)|finding|\mFAIL\M' THEN 'code'
    WHEN e ~* 'did not complete|no such file or directory|ENOSPC|no space left|worktree|checkout|stale' THEN 'environment'
  END
  FROM (SELECT e, r, mc.stop_strip(left(p_error, 8000), '<id>', ' ', ' ') AS ep
    FROM (SELECT regexp_replace(left(p_error, 8000), '(#|\m(pulls?|issues?)/|\mPRs? ?#?)[0-9]+', ' ', 'gi') AS r,
      nullif(btrim(mc.stop_strip(left(p_error, 8000), ' ', '\&', ' ')), '') AS e) y) x
$$;

DO $$
DECLARE r record; v_sqlstate text; v_message text;
BEGIN
  FOR r IN SELECT run_id FROM mc.laps WHERE status = 'failed' LOOP
    BEGIN
      PERFORM mc.project_run_stop(r.run_id);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      v_sqlstate := SQLSTATE;
      IF NOT EXISTS (SELECT 1 FROM mc.projection_errors p
        WHERE p.run_id = r.run_id AND p.sqlstate = v_sqlstate AND p.message = v_message) THEN
        PERFORM mc.record_projection_error('20261110T1200Z_transient_database_blips', r.run_id, NULL, v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END $$;
