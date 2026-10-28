-- A pin needs no reason (issue #178). Many pin commits on coleam00/ai-software-factory are a bare
-- `Pin Archon <sha>`, and PRD 4.2 lists such a pin with "not recorded" for its reason, as it does
-- for a missing Hypothesis or Measure. 0003 made the reason NOT NULL, so the parser refused those
-- commits and their versions never appeared. A pin without one stores a null reason. Run again, it
-- changes nothing.

ALTER TABLE mc.pins ALTER COLUMN reason DROP NOT NULL;
