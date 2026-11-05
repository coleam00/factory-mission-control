SELECT count(*)::int AS running FROM mc.laps WHERE factory = $1 AND status = 'running'
