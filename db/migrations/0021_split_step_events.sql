-- A split run's steps reach the map (issue #366). 0020 let the queue workflows the map's cards
-- cover project step events; the map now draws Split, which `archon-split` runs, so a running
-- split node_started would write no step row and the card's "here" chip would stay empty.
--
-- Only mc.projects_step_events changes: `archon-split` joins the list. `factory-backlog` stays, as
-- do the old workflow names of rows already recorded. The function only compares a name, so like
-- 0020's it cannot raise inside Archon's write (0006's invariant 1). Runs finished before this
-- file get no steps from it: `reconcile:laps` replays them, and run again it changes nothing.

CREATE OR REPLACE FUNCTION mc.projects_step_events(p_workflow text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_workflow IN ('archon-loop', 'archon-intake', 'archon-split',
    'archon-build-queue', 'archon-merge-queue', 'archon-discoveries', 'factory-app-check',
    'factory-backlog', 'factory-deploy', 'factory-holdout-sweep', 'factory-holdouts',
    'factory-manager'), false)
$$;
