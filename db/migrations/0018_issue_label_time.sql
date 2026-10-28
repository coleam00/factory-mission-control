-- When an issue received each of its labels (issue #205). The owner queue counted a needs-owner
-- issue's wait from mc.issues.updated_at, which every comment, edit or other label moves, so the
-- wait restarted on each pass of the loop. The webhook's `labeled` delivery and the backfill's read
-- of the issue's events set it; a row whose label time is unknown keeps a null and the owner queue
-- falls back to updated_at. A label removed and added again is a new row, so its time restarts.
-- 0002 is applied on main and never re-runs, so the column is added here. Run again, it changes
-- nothing.

ALTER TABLE mc.issue_labels ADD COLUMN IF NOT EXISTS labeled_at timestamptz;
