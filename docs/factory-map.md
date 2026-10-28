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

The map draws every step a lap can run. Each include or loop group is a dashed box with the
including step at its top and the steps it expands inside, at every depth: ship holds deliver,
deliver holds rounds, and rounds holds implement, whose box holds its own implement step. A nested
step opens its own screen under the workflow that declares it: `ship/deliver/rounds/implement/implement`
opens `/steps/archon-implement/implement`. A lap on a nested step counts on that step and on every
box around it. The inputs archon-backlog and archon-holdouts and the manager archon-manager show
their own steps the same way, each counting that workflow's running runs. On a phone the loop's
spine stays in the first column, and a box wider than the screen scrolls sideways inside the map.

An include's own screen, such as deliver's, lists every step beneath it by its path there
(`rounds/implement/implement`, `rounds/reshape/implement`). Each entry opens that step's own
screen, which lists every place an include puts it and links back to each.
