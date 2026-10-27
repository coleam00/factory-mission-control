SELECT
  -- The lap's app-check lines: kind, verdict and evidence count, and a holdout's scenario id.
  -- Never a line's text (PRD 4.6, invariant 3).
  a.position, a.kind, a.verdict, a.evidence_count, a.scenario_id
FROM mc.laps l
JOIN mc.app_check_lines a ON a.run_id = l.run_id
WHERE l.factory = $1 AND l.run_id::text = $2 AND l.workflow_name = 'archon-loop'
