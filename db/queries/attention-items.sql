SELECT a.run_id, a.workflow_name, a.node_id, a.waiting_since, a.form,
  -- Options and labels go as text and the browser parses the JSON. The console is the factory's,
  -- for the run link. `recommended` is the projected one, the same the Decide cards show. The rows are runs paused on a `wait: attention` node (migration 0019).
  a.options::text AS options, a.labels::text AS labels, a.recommended, a.message, f.console
FROM mc.attention_items a
JOIN mc.factories f ON f.name = a.factory
WHERE a.factory = $1
