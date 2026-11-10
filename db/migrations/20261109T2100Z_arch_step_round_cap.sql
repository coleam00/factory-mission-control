-- A loop group keeps the round its own script stops it at (`const ROUND_CAP` in its body, issue #566),
-- so a run's title can say "round 2 of 4". NULL where the pin holds none: versions parsed before this
-- file, and every step that is not a loop with a cap.
ALTER TABLE mc.arch_steps ADD COLUMN IF NOT EXISTS round_cap int;
