# End-to-end journeys

What a user does with Factory Mission Control today, in plain English. Each journey runs against
the app served from a check branch loaded with the seed (`bun run fixture:branch`, then
`bun run serve -- --port <8850-8864>`, opened at `http://localhost:<port>`).

1. **See the factory.** Open the Factory place (`/f/<factory>/map`). The architecture map shows the loop's steps from
   pick to release, the manager above them and the inputs and outputs around them. Open check-app:
   its prompt, its holdout verifier and how the holdout fence works are shown.
2. **Watch a lap.** With the Runs screen open (`/f/<factory>/runs`), insert a step event for a running run
   (`bun run fixture:write step`). Within 5 seconds, without a reload, the run's row shows the new
   step.
3. **Judge a change.** On the version strip, pick two versions. Their scorecards appear side by side
   with each number's lap count, and a difference on fewer than 10 laps is labelled not yet
   meaningful.
4. **Find what waits on me.** The owner queue lists every open owner question with its default
   date. Insert a `needs-owner` label (`bun run fixture:write label`): the issue appears without a
   reload.
5. **Answer and resume from the dashboard.** Serve with `MC_OPERATORS_FILE` naming an operator file
   whose entry for the factory runs `fixtures/archon-stub-cli.ts` (`MC_STUB_CLI_LOG` set in its
   `env`), for example `{"operators": {"<factory>": {"who": "owner", "login": "<github login>", "command": ["bun",
   "fixtures/archon-stub-cli.ts"], "cwd": "<absolute repo path>", "env": {"MC_STUB_CLI_LOG":
   "<log path>"}}}}`; the server will not start on any other shape. On Attention, click a recommended option tile: a toast with Undo shows, and after 5
   seconds the stub log holds the answer argv and `mc.actions` holds the row with exit status 0.
   Resume a failed run from its run page the same way. Click again and press Undo: `mc.actions`
   holds an undone row and the stub log has no new line. An Unstick card also offers Re-triage, Close and Something else (a comment): each
   records an `mc.actions` row and logs one stub line per call it sends the same way. Re-triage and Something else need
   the entry's `login`, and Close does not. Without an entry for the factory the
   buttons are console links.
