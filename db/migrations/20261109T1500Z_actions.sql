-- The dashboard's own record of its two writes (PRD invariant 2): answering a paused run's
-- question and resuming a run, each sent through the factory's own Archon CLI. Only
-- server/actions.ts writes this table; no Archon table is touched. Idempotent.
--
--   who         the operator entry's `who` (no accounts exist; it never comes from the browser)
--   action      'answer' | 'resume'
--   occurrence, option, answer_text   answer: the wait answered, the declared option id sent with
--               --choose, the owner's text sent with --text
--   from_step   resume: the failed step the button named; recorded, never sent (the CLI resumes
--               what failed)
--   undone      the owner pressed Undo within 5 seconds; nothing was sent (sent_at is NULL)
--   exit_code   the CLI's exit status; NULL when undone, never started, or timed out
--   output      the CLI's output summary, at most 2000 characters

CREATE TABLE IF NOT EXISTS mc.actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  factory text NOT NULL,
  who text NOT NULL,
  action text NOT NULL CHECK (action IN ('answer', 'resume')),
  run_id uuid NOT NULL,
  occurrence text,
  option text,
  answer_text text,
  from_step text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  undone boolean NOT NULL,
  sent_at timestamptz,
  exit_code integer,
  output text,
  CHECK (undone = (sent_at IS NULL)),
  CHECK (action = 'answer' OR (occurrence IS NULL AND option IS NULL AND answer_text IS NULL)),
  CHECK (action = 'resume' OR (from_step IS NULL AND occurrence IS NOT NULL
                               AND (option IS NOT NULL OR answer_text IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS actions_factory_recorded ON mc.actions (factory, recorded_at DESC);
