# Factory operations

This application runs on the AI Software Factory v1: Archon's native queues (intake, build queue,
merge queue, attention) plus the factory package in `.archon/`. `.archon/factory.yaml` is the one
place for its settings, models and app instructions.

Validation is Review's lenses and the app check, which tests the running app against the work item's
acceptance. Ordinary checks: `bun run check`. Project runtime scenarios:
`harness/END-TO-END.md`.
