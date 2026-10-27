WITH version AS (
  -- The version the address names by its pin, $4, or for '' the current version: the
  -- architecture of the newest pin that has any.
  SELECT a.archon_sha, a.factory_sha
  FROM mc.arch_versions a
  JOIN mc.pins p ON p.archon_sha = a.archon_sha
  JOIN mc.factories f ON f.name = $1
  WHERE $4 = '' OR p.sha = $4
  ORDER BY p.committed_at DESC, a.parsed_at DESC
  LIMIT 1
),
steps AS (
  SELECT s.workflow, s.path, s.parent_path, s.position, s.step_id, s.kind, s.include, s.defined_in
  FROM mc.arch_steps s
  JOIN version v ON v.archon_sha = s.archon_sha AND v.factory_sha = s.factory_sha
),
-- Where each node's own screen is: under the workflow that declares it, at its path there. A node
-- an include expanded sits beneath exactly one include of that workflow (the parser refuses an
-- include cycle), and its own path is what follows that include's path.
own AS (
  SELECT s.workflow, s.path, s.parent_path, s.position, s.step_id, s.kind, s.defined_in,
    CASE WHEN i.path IS NULL THEN s.path ELSE substr(s.path, length(i.path) + 2) END AS own_path
  FROM steps s
  LEFT JOIN steps i
    ON s.defined_in <> s.workflow AND i.workflow = s.workflow AND i.include = s.defined_in
    AND starts_with(s.path, i.path || '/')
)
-- The nodes beneath the step in its workflow, each opening its own screen, and each place an
-- include puts the step, opening the screen of the node it sits in.
SELECT 'inside' AS relation, o.workflow, o.path, o.position, o.step_id, o.kind,
  o.defined_in AS open_workflow, o.own_path AS open_path
FROM own o
WHERE o.workflow = $2 AND starts_with(o.path, $3 || '/')
UNION ALL
SELECT 'included_at', o.workflow, o.path, o.position, o.step_id, o.kind,
  p.defined_in, p.own_path
FROM own o
JOIN own p ON p.workflow = o.workflow AND p.path = o.parent_path
WHERE o.defined_in = $2 AND o.own_path = $3 AND o.workflow <> $2
