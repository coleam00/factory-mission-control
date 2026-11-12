-- The dashboard's three more writes (PRD invariant 2): re-triage, close and comment on a work item,
-- recorded beside answer and resume in mc.actions. Only server/actions.ts writes this table.
-- Idempotent. The old column meanings are unchanged; the new ones:
--
--   action        'answer' | 'resume' | 'retriage' | 'close' | 'comment'
--   run_id        answer and resume only; NULL for the three item actions
--   item_number   retriage, close and comment: the issue acted on; NULL for answer and resume
--   comment_text  comment: the owner's text, posted on the issue as their comment, never sent
--                 as a flag; answer_text stays answer-only

ALTER TABLE mc.actions ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE mc.actions ADD COLUMN IF NOT EXISTS item_number integer;
ALTER TABLE mc.actions ADD COLUMN IF NOT EXISTS comment_text text;

-- The old checks were auto-named, so find them instead of naming them.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'mc.actions'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE mc.actions DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE mc.actions
  ADD CONSTRAINT actions_action
    CHECK (action IN ('answer', 'resume', 'retriage', 'close', 'comment')),
  ADD CONSTRAINT actions_sent CHECK (undone = (sent_at IS NULL)),
  ADD CONSTRAINT actions_target
    CHECK ((action IN ('answer', 'resume')) = (run_id IS NOT NULL)
       AND (action IN ('answer', 'resume')) = (item_number IS NULL)),
  ADD CONSTRAINT actions_answer_only
    CHECK (action = 'answer' OR (occurrence IS NULL AND option IS NULL AND answer_text IS NULL)),
  ADD CONSTRAINT actions_answer_fields
    CHECK (action <> 'answer' OR (occurrence IS NOT NULL AND (option IS NOT NULL OR answer_text IS NOT NULL))),
  ADD CONSTRAINT actions_resume_only CHECK (action = 'resume' OR from_step IS NULL),
  ADD CONSTRAINT actions_comment CHECK ((action = 'comment') = (comment_text IS NOT NULL));
