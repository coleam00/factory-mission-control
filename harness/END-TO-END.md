# End-to-end journeys

What a user does with Factory Mission Control today, in plain English. Each journey runs against
the app served from a check branch loaded with the seed (`bun run fixture:branch`, then
`bun run serve -- --port <8850-8864>`, opened at `http://localhost:<port>`).

1. **See the factory.** Open the home screen. The architecture map shows the loop's steps from
   pick to release, the manager above them and the inputs and outputs around them. Open check-app:
   its prompt, its holdout verifier and how the holdout fence works are shown.
2. **Watch a lap.** With the lanes panel open, insert a step event for a running lap
   (`bun run fixture:write step`). Within 5 seconds, without a reload, the lap's lane shows the new
   step.
3. **Judge a change.** On the version strip, pick two versions. Their scorecards appear side by side
   with each number's lap count, and a difference on fewer than 10 laps is labelled not yet
   meaningful.
4. **Find what waits on me.** The owner queue lists every open owner question with its default
   date. Insert a `needs-owner` label (`bun run fixture:write label`): the issue appears without a
   reload.
