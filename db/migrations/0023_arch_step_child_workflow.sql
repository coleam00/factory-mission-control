-- A `workflow:` node keeps the name of the child workflow it runs (issue #380). Archon resolves
-- the name at execution, so it is stored as written and never checked against mc.arch_workflows.
-- Additive: versions parsed before this file read NULL, as every non-workflow step does.
ALTER TABLE mc.arch_steps ADD COLUMN IF NOT EXISTS child_workflow text;
