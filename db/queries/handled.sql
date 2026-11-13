SELECT a.id::int AS id, a.action, a.run_id::text AS run_id, a.item_number, a.option, a.from_step,
       a.sent_at, a.exit_code, l.workflow_name
-- The dashboard's sent actions for factory $1, newest first, for Attention's handled line. The
-- browser keeps today's, because a live query may not read the clock. Undone rows were never sent.
FROM mc.actions a
LEFT JOIN mc.laps l ON l.run_id = a.run_id AND l.factory = a.factory
WHERE a.factory = $1 AND NOT a.undone
ORDER BY a.sent_at DESC, a.id DESC
LIMIT 100
