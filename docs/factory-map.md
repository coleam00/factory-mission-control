# Viewing the factory map

The selected factory needs at least one recorded lap before its map shows steps, even when
shared pinned architecture is already stored. A completed lap counts; no lap needs to be running.
This matches the versions screen's empty-factory rule and does not make pins factory-specific.

To follow the “See the factory” journey, select a factory with recorded laps and stored pinned
architecture, then open check-app from its map to read the prompt, holdout verifier and fence.
A factory with no laps instead shows “No factory map is available yet.” with no step links.
The same sentence covers missing architecture; it does not diagnose which prerequisite is absent.

The map updates live when the first lap arrives or the last lap is removed. Populated factories
keep their existing step details and per-factory counts.

The map draws the loop and ship's stages, not the steps their includes expand. An include's box,
such as deliver, opens its screen, which lists every step beneath it by its path there
(`rounds/implement/implement`, `rounds/reshape/implement`). Each entry opens that step's own
screen, under the workflow that declares it (`/steps/archon-implement/implement`), which lists
every place an include puts it and links back to each.
