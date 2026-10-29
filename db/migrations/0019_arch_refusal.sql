-- Whether Archon would refuse to load a version's pack, and why (issue #244, owner decision on #27
-- question 9): one sentence written by the architecture job, or null when Archon would load every
-- workflow. The versions and map screens show it. A version parsed before this column existed reads
-- as loadable until `arch:parse` runs for it again. 0004 is applied on main and never re-runs, so
-- the column is added here. Run again, it changes nothing.

ALTER TABLE mc.arch_versions ADD COLUMN IF NOT EXISTS refusal text;
