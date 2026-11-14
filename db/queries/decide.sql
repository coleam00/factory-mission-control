SELECT a.run_id, a.workflow_name, a.node_id, a.occurrence_id, a.waiting_since, a.form,
  -- The open questions (migration 0031 on 0019): each option may carry its description, and the
  -- recommendation, its why, confidence, item number and the occurrence an answer names come
  -- projected. The recommendation and the descriptions are the wait's structured fields when it
  -- has them, else read from the message (migration 20261110T1600Z on 0031).
  -- Options and labels go as text and the browser parses the JSON, sorts and computes the ages.
  a.options::text AS options, a.labels::text AS labels, a.recommended, a.confidence,
  a.recommendation_why,
  a.item_number, coalesce(ii.title, ip.title) AS item_title, a.message, f.console, s.steps
FROM mc.attention_items a
-- The steps the run was running when it paused, newest first (the lap rule of home-map.sql): what Attention's By queue places it by.
LEFT JOIN LATERAL (
  SELECT array_agg(ls.step_id ORDER BY ls.started_at DESC NULLS LAST, ls.step_id) AS steps
  FROM mc.lap_steps ls WHERE ls.run_id = a.run_id AND ls.status = 'running'
) s ON true
JOIN mc.factories f ON f.name = a.factory
-- A build wait names an issue, a wait in the queue that lands changes a pull request.
LEFT JOIN mc.issues ii ON ii.factory = a.factory AND ii.number = a.item_number
LEFT JOIN mc.pull_requests ip ON ip.factory = a.factory AND ip.number = a.item_number
WHERE a.factory = $1
