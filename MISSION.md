# Mission

Factory Mission Control makes the AI Software Factory visible: the factory's architecture as one
live map, how it has evolved and why, and for every application a factory builds, the product
document, its issues, the laps working through them, how each change was tested, and what waits on
the owner. Every panel is a live query on Neon Postgres, so the screen moves the moment an agent
writes. The product document is `docs/mission-control.prd.md`; it decides.

## Never

1. Never write to GitHub, to Archon, to a factory's repository or to Archon's tables. v1 is
   read-only toward everything it shows.
2. Never slow or break an Archon write. Whatever this app adds to the database fails silently
   and is counted, never raised into Archon's transaction.
3. Never store or show a holdout scenario's title, text, steps or thresholds. Holdouts are ids
   and verdicts.
4. Never send a secret to the browser: the Realtime secret, database URLs and GitHub tokens stay
   on the server and in the Neon Function.
5. Never poll. A panel that is not a live query (or derived from one) is not done.
6. Never hand-write the factory's architecture. It is parsed from the pinned code.
7. Never invent a look. The design is the Archon console's (docs/design/archon-console/).
8. Never become a second Archon console: one lap links to the console for its full log.
9. Never sum numbers across factories; each factory's numbers stand alone.
