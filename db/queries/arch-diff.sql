WITH version AS (
  SELECT DISTINCT ON (v.digest) v.digest, a.archon_sha, a.factory_sha
  FROM mc.versions v
  JOIN mc.pins p ON p.sha = v.pin_sha
  JOIN mc.arch_versions a ON a.archon_sha = p.archon_sha
  WHERE v.factory = $1
  ORDER BY v.digest, a.parsed_at DESC
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
