SELECT r.name, r.parent, r.at, r.created_at
FROM mc.rewind_branches r
-- Rewind branches belong to no factory: the join keys the query on $1, as every live query is.
JOIN mc.factories f ON f.name = $1
ORDER BY r.at DESC, r.name
