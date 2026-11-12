-- Issue #647: 20 of 21 failure groups on live data were unclassified. Seven real lines get a class:
-- GitHub and forge connectivity (failed to connect to, dial tcp, connectex, handshake failed) are transient;
-- a claim conflict ("is claimed by run") and an unresolvable issue or pull request are input; an answer that
-- is not one of the choices is code.
-- README "Owner changes of 2026-11-12" item 5 puts Postgres "out of memory" in environment, so it leaves the
-- transient arm #628 put it in, and so does a Postgres deadlock: the connection worked and the database
-- refused the transaction (compute-node connectivity stays transient). The JavaScript heap
-- lookbehind goes too: environment is not folded by a later run, so the heap line needs no exemption and
-- is no longer unclassified.
-- Stored classes are re-projected once, as 20261110T1200Z did. Like it, this never raises into Archon's write
-- and, run again, changes nothing.

CREATE OR REPLACE FUNCTION mc.stop_class(p_error text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN r ~* 'usage limit|\m(http|status|error)[ :]*(code[ :]*)?429\M|\m429 (status|too many)' THEN 'transient'
    WHEN r ~* '\m(http|status|error)[ :]*(code[ :]*)?401\M|\m401 (status|oauth|unauthor)|unauthor' THEN 'config'
    WHEN r ~* 'ECONN|ETIMEDOUT|fetch failed' THEN 'transient'
    WHEN e IS NULL THEN NULL
    WHEN e ~* 'usage or credit limit|rate.?limit|too many requests|overloaded|HTTP 5[0-9]{2}|\m5[0-9]{2} (bad gateway|gateway|service unavailable|internal server)|bad gateway|gateway time-?out|service unavailable|ENOTFOUND|connection terminated|timeout exceeded when trying to connect|provider reported transient|couldn.?t connect to compute node|failed to connect to|dial tcp|connectex|handshake failed' THEN 'transient'
    WHEN e ~* 'provider reported auth|authenticat|configuration must be fixed|bad credentials|missing binding|no binding|binding [^ ]+ (is )?(missing|not set|undefined)|no schedule|schedule [^ ]+ (is )?(missing|not found)' THEN 'config'
    WHEN e ~* 'no issue matched|no matching issue|bad argument|invalid argument|unknown (option|argument)|missing required input|is claimed by run|could not resolve to an? (issue|pull request)' THEN 'input'
    WHEN e ~* 'out of memory|deadlock detected|check must write|not a git repository|push [^ ]+ refused|refused: |non-fast-forward|fetch first|\[rejected\]|merge --no-edit' THEN 'environment'
    WHEN e ~* 'is not one of the choices' THEN 'code'
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
        PERFORM mc.record_projection_error('20261112T2001Z_every_failure_has_a_class', r.run_id, NULL, v_sqlstate, v_message);
      END IF;
    END;
  END LOOP;
END $$;
