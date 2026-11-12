# Mission

Factory Mission Control makes the AI Software Factory visible: the factory's architecture as one
live map, how it has evolved and why, and for every application a factory builds, the product
document, its work and work orders, the runs working through them, how each change was tested, and what waits on
the owner. Every panel is a live query on Neon Postgres, so the screen moves the moment an agent
writes. The product document is `docs/mission-control.prd.md`; it decides.

## Never

1. Never write to GitHub, to Archon, to a factory's repository or to Archon's tables, except the
   five writes of PRD invariant 2: answer a paused run's question, resume a run, and re-triage, close or
   comment on a work item, each through the
   factory's own Archon CLI, after a 5-second Undo, and recorded.
2. Never slow or break an Archon write. Whatever this app adds to the database fails silently
   and is counted, never raised into Archon's transaction.
3. Never store or show a holdout scenario's title, text, steps or thresholds. The factory no longer
   uses holdouts, and Archon's old rows still hold them.
4. Never send a secret to the browser: the Realtime secret, database URLs and GitHub tokens stay
   on the server and in the Neon Function.
5. Never poll. A panel that is not a live query (or derived from one) is not done.
6. Never let the map drift from the code. Its layout and wording are the owner's, authored in
   `app/map/factory-map.json`; what each card covers is checked against the pinned code, and step
   details are parsed from it.
7. Never invent a look. The design is `docs/design/v3/` (the owner's mockup, screenshots, tokens and
   README); the factory map keeps the structure and wording of `docs/design/v2/`.
8. Never become a second Archon console: a run shows why it stopped, its timeline and its two actions,
   and links to the console for its full log.
9. Never sum numbers across factories; each factory's numbers stand alone.
