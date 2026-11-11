SELECT a.run_id, a.workflow_name, a.node_id, a.occurrence_id, a.waiting_since, a.form,
  -- The open questions (migration 0031 on 0019): each option may carry its description, and the
  -- recommendation, its why, confidence, item number and the occurrence an answer names come
  -- projected. The recommendation and the descriptions are the wait's structured fields when it
  -- has them, else read from the message (migration 20261110T1600Z on 0031).
  -- Options and labels go as text and the browser parses the JSON, sorts and computes the ages.
  a.options::text AS options, a.labels::text AS labels, a.recommended, a.confidence,
  a.recommendation_why,
  a.item_number, a.message, f.console
FROM mc.attention_items a
JOIN mc.factories f ON f.name = a.factory
WHERE a.factory = $1
