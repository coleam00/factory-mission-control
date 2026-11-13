-- When the CLI returned for a sent write, stamped with its exit_code. A sent close posts its note
-- before it closes the issue, so the note moves the mirrored issue after sent_at; only a move after
-- the CLI returned is not the close's own. NULL until the result is recorded, and for older rows.
-- Idempotent.

ALTER TABLE mc.actions ADD COLUMN IF NOT EXISTS finished_at timestamptz;
