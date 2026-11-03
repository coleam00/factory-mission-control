# Build policy

Add project-specific implementation prose above this managed block.

The factory's app check proves what needs the running app: `bun run test:live`, screenshots, the design probe, and any acceptance item a build round cannot reach (a round has no Neon check branch). A round finishes when the code is reviewed Ready and CI is green. Do not stop to ask a person to run those: choose `done` and hand the pull request to the merge queue, whose gate will not pass without the app check's green status. A failure the app check reports comes back as work for a later round.

<!-- FACTORY AUTONOMY: START (managed by factory-setup) -->
Preset: standard
- Proceed on clear in-scope implementation; ask on protected paths, new dependencies, product choices, or scope changes.
<!-- FACTORY AUTONOMY: END -->
