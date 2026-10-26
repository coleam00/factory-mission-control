WITH firsts AS (
  SELECT DISTINCT ON (l.digest) l.digest, l.started_at AS first_run_at
  FROM mc.laps l
  WHERE l.factory = $1 AND l.digest IS NOT NULL AND l.started_at IS NOT NULL
  ORDER BY l.digest, l.started_at
),
version AS (
  SELECT f.digest, a.archon_sha, a.factory_sha
  FROM firsts f
  JOIN LATERAL (
    SELECT archon_sha FROM mc.pins
    WHERE committed_at < f.first_run_at ORDER BY committed_at DESC LIMIT 1
  ) p ON true
  JOIN LATERAL (
    SELECT archon_sha, factory_sha FROM mc.arch_versions
    WHERE archon_sha = p.archon_sha ORDER BY parsed_at DESC LIMIT 1
  ) a ON true
)
SELECT v.digest, 'workflow' AS kind, NULL AS workflow,
  array_agg(w.name || E'\t' || left(md5(coalesce(w.description, '') || E'\n'
    || coalesce(w.model, '') || E'\n' || w.file), 12)) AS entries
FROM version v
JOIN mc.arch_workflows w ON w.archon_sha = v.archon_sha AND w.factory_sha = v.factory_sha
GROUP BY v.digest
UNION ALL
SELECT v.digest, 'step', s.workflow,
  array_agg(s.path || E'\t' || left(md5(s.kind || E'\n' || coalesce(s.description, '') || E'\n'
    || coalesce(s.model, '') || E'\n' || coalesce(s.when_condition, '') || E'\n'
    || coalesce(s.trigger_rule, '') || E'\n' || coalesce(s.include, '') || E'\n'
    || coalesce(s.command, '') || E'\n' || coalesce(s.command_file, '') || E'\n'
    || coalesce(s.script, '') || E'\n' || coalesce(s.script_file, '') || E'\n'
    || coalesce(s.runtime, '') || E'\n' || coalesce(s.bash, '') || E'\n'
    || coalesce(s.prompt, '') || E'\n' || s.defined_in || E'\n' || s.file), 12))
FROM version v
JOIN mc.arch_steps s ON s.archon_sha = v.archon_sha AND s.factory_sha = v.factory_sha
GROUP BY v.digest, s.workflow
UNION ALL
SELECT v.digest, 'edge', e.workflow, array_agg(e.from_path || E'\t' || e.to_path)
FROM version v
JOIN mc.arch_edges e ON e.archon_sha = v.archon_sha AND e.factory_sha = v.factory_sha
GROUP BY v.digest, e.workflow
UNION ALL
SELECT v.digest, 'prompt', NULL, array_agg(t.path || E'\t' || left(md5(t.text), 12))
FROM version v
JOIN mc.arch_texts t ON t.archon_sha = v.archon_sha AND t.factory_sha = v.factory_sha
GROUP BY v.digest
UNION ALL
SELECT v.digest, 'subagent', g.workflow,
  array_agg(g.step_path || E'\t' || g.name || E'\t' || left(md5(coalesce(g.description, '') || E'\n'
    || coalesce(g.prompt, '') || E'\n' || coalesce(g.instruction_file, '')), 12))
FROM version v
JOIN mc.arch_subagents g ON g.archon_sha = v.archon_sha AND g.factory_sha = v.factory_sha
GROUP BY v.digest, g.workflow
