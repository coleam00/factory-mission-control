# Factory operations

This application runs on the AI Software Factory v1: Archon's native queues (intake, build queue,
merge queue, attention) plus the factory package in `.archon/`. `.archon/factory.yaml` is the one
place for its settings, models and app instructions.

Holdout scenarios are private and live outside this repository (`holdouts.path` in
`.archon/factory.yaml`). Ordinary checks: `bun run check`. Project runtime scenarios:
`harness/END-TO-END.md`.
