-- Issues a merged pull request delivers by naming them with `Refs #n` (issue #391). The merge queue
-- keeps a contract issue open at merge, so its pull requests say `Refs`, and intake closes the
-- issue afterwards; the Board and a work order's bar counted only a closing keyword. A `Refs`
-- names an issue without closing it, so it goes in its own table and mc.pull_request_issues keeps
-- meaning exactly "the issues a pull request closes". The merged rule reads both.
-- The close reason makes sure an issue closed as not planned or as a duplicate never counts.
-- 0002 is applied on main and never re-runs, so both are added here. Run again, it changes nothing.

-- GitHub's state_reason while the issue is closed (completed, not_planned, duplicate, ...); null
-- while it is open or unknown. A reconcile fills the rows already mirrored.
ALTER TABLE mc.issues ADD COLUMN IF NOT EXISTS close_reason text;

-- The issues a pull request names with `Refs #n`. A reference never closes an issue, so it is not
-- in mc.pull_request_issues.
CREATE TABLE IF NOT EXISTS mc.pull_request_references (
  factory text NOT NULL,
  pr_number integer NOT NULL,
  issue_number integer NOT NULL,
  PRIMARY KEY (factory, pr_number, issue_number)
);
