SELECT count(*)::int AS running FROM mc.laps WHERE factory = $1 AND workflow_name = 'archon-loop' AND status = 'running'
