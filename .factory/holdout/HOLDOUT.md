# Holdout scenarios

Acceptance checks the agents building the code never see. They are written from the product document,
not from the issues or the code, and they test the space between issues: one rule on every surface,
sequences, what must never happen by any route, and old behaviour that has to keep working.

This file is committed so the team shares it. People read and edit it freely. Agents cannot: the hook
in `.factory/hooks/holdout_fence.py` refuses every agent except the `holdout-writer` and
`holdout-verifier` subagents, and `.ignore` keeps the folder out of searches. The app check and the
manager run these through the verifier, which reports only a verdict and what a user sees.

The first set (H-01..H-20) was written from the whole product document before the backlog was built.
Add more by dispatching the holdout-writer, or by hand in this form:

```
## H-01 A short title in the user's words
Protects: the product rule it guards (PRD section or rule number)
Touches: the product areas it exercises, so a change is checked only against scenarios it can affect
Setup: the state to start from
Steps: what a user does, through the app's public surface
Expect: what a user sees, exactly where the product document fixes it
Author: owner
```

Scenarios are added and tightened, never loosened, except by the owner with a reason recorded here.

---

## Shared setup and judges

Unless a scenario says otherwise, "the check app" means: `bun install`, `bun run setup`,
`bun run fixture:branch` (a fresh `check-*` branch with the seed), then `bun run serve -- --port <p>`
with a free port in 8850-8864, opened in a browser at `http://localhost:<p>`. Rows "inserted as Archon
would" are plain SQL inserts into Archon's own tables (`remote_agent_workflow_runs`,
`remote_agent_workflow_events`) on that check branch, never on `main`. GitHub facts are delivered by
running the webhook handler locally (`bun run function:dev`) and posting signed payloads built like the
ones in `fixtures/webhooks/` (secret `test`), or by `bun run fixture:write <kind>` where it covers the
case. "Without a reload" means a marker set on `window` before the step is still there after it.

Judge scripts sit in `.factory/holdout/judges/`. Each reads one JSON file the verifier records during
the run (its shape is documented at the top of the script), prints PASS, FAIL or INCONCLUSIVE with
reasons, and exits 0, 1 or 2. `judges/liveness.js` can also print INCOMPLETE (exit 3): nothing it
watched failed, but a watched panel's whole screen is not served on the commit (no route; the app says
"Nothing is at this address"), so the scenario's verdict is INCOMPLETE. A served screen that is slow,
or never shows the change (including one that lacks the panel), is still FAIL. Its record must list
every panel the scenario's steps watch, so leaving a panel out of the record can never yield PASS.
Run them with `bun .factory/holdout/judges/<name>.js <record.json>`.

---

## H-01 No holdout's words ever show up anywhere in the dashboard
Protects: invariant 3; section 5 (no scenario text copied); 4.5; 4.6; 11.7
Touches: Archon projection, app-check lines, testing panel, one lap, scorecard (new holdout catch), health, sealing API, every dashboard table
Setup: the check app. Pick a canary string that is nowhere in the seed or the code, e.g. `CANARY-ZEBRA-7741`.
Steps:
1. Insert, as Archon would, a completed `archon-loop` lap whose `check-app` step output carries four app-check lines of kind `holdout`: (a) text "H-07 the user sees CANARY-ZEBRA-7741 on the lanes", verdict FAIL, empty `pre_existing`; (b) text "CANARY-ZEBRA-7741 with no scenario id", verdict PASS; (c) text "H-12 then H-03 CANARY-ZEBRA-7741", verdict FAIL, non-empty `pre_existing`; (d) text "h-9 and H-7 are not ids CANARY-ZEBRA-7741", verdict PASS.
2. Without a reload, visit every screen: the home map and the `check-app` step detail, the factory page (graph, lanes, recent laps), the scorecard for that lap's version, the testing panel, the one-lap page of that lap, health, the owner queue, and the rewind list. Hover every badge that has a tooltip.
3. Record the full text and attributes of every page's DOM and every network payload the browser received (HTTP responses and Realtime frames).
4. On the check branch, search every column of every table and view the repository's migrations created (not Archon's own tables) for the canary, including `projection_errors`.
Expect:
- The canary is found in none of: any screen's text, attribute or tooltip; any payload the browser received; any dashboard table, view or `projection_errors` row.
- The testing panel and the one-lap page show line (a) as `H-07` FAIL, line (c) as `H-12` (the first id, never `H-03`), and lines (b) and (d) as `unidentified`.
- The scorecard's new holdout catches for that version rise by exactly one (line (a) only: (c) has `pre_existing`).
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-02 A step event reaches every panel within 5 seconds, even after the page has been open 3 minutes
Protects: 8.1; invariant 5
Touches: realtime sealing and renewal, lanes, home map live counts, one lap, recent laps, health
Setup: the check app with at least one running lap in the seed (or insert one: a run with status `running` and a `node_started` for `build`). Open three tabs: the home map, the factory page, and that lap's one-lap page. Set the reload marker in each.
Steps:
1. Leave all three tabs open and untouched for at least 190 seconds (past three seal renewals).
2. Insert, as Archon would, `node_completed` for the lap's current step (with `cost_usd` and `duration_ms`) and `node_started` for its next step. Record the commit time.
3. Record when each of these is first visible: the lane shows the new step and its elapsed time restarts; the lane's cost so far includes the new cost; on the map the old step's `data-live-count` drops by one and the new step's rises by one (running style on, or off at zero); the one-lap page lists the new step and the completed step's duration and cost.
4. Repeat step 2 once more 60 seconds later.
5. Throughout, log every HTTP request the pages make after their first load.
Expect:
- Every change is visible within 5 seconds of its commit, on every tab, both times; no tab reloaded.
- After the first load, the only HTTP requests are seal renewals: no panel polls for data and no screen has a refresh button.
- `judges/liveness.js` on the recorded run prints PASS.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-03 When a lap merges, every screen agrees on the next update
Protects: journey 2; 4.3; the `merge` definition in 4.2; invariant 4
Touches: lanes, recent laps, issue graph, phase bars, home map live counts, scorecard, health workable count
Setup: the check app; a running lap (seed or inserted) that has claimed open issue #N in phase P, with a pull request open for #N. Open the factory page, the home map and the scorecard for the lap's version in separate tabs; note phase P's merged/total, the scorecard's laps and merges and the lap counts they show, and the map's live counts.
Steps:
1. Insert, as Archon would, `node_started` and `node_completed` for `land` with output `outcome = merged`, then mark the run completed with `completed_at`.
2. Deliver, as GitHub would, the pull request's merge, the issue's close, a `Loop review: merged (route: simple) at <sha> by the merge gate, after the review above.` comment, and the matching `Loop claim released: run <id> ended.` comment.
3. Watch all tabs without a reload, recording when each change appears.
Expect:
- The lap's lane is gone from the running lanes; recent laps lists it with outcome merged, a duration equal to its `completed_at` minus `started_at`, and a cost equal to the sum of its steps' `cost_usd`.
- Issue #N shows as merged in the graph; phase P's merged count rises by one and its total does not change; if #N was on the highlighted longest open chain, the highlight moves to the new longest open chain.
- No step on the map counts the lap any more.
- The scorecard's merges rise by exactly one and its laps do not change: the lap already counted as a lap while it was running (4.2: a lap is an `archon-loop` run, whatever its status). The lap count the count measures say they rest on does not change; only the time measures (those built on lap durations) newly take in this lap, now that it has finished.
- Every change is visible within 5 seconds of the last write it depends on (`judges/liveness.js` PASS).
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-04 The scorecard computes every measure exactly as defined, including the awkward laps
Protects: 4.2 measure table; 8.2; invariant 4; 10 (never summed across factories)
Touches: scorecard, Archon projection, version keying
Setup: the check app. For one version (digest D) add, as Archon would, laps that sit on the edges of the definitions:
- an empty lap (`pick` output `route = none`) that still cost money;
- a failed lap (run `status = failed`) with costed steps;
- a lap that was sent back in `review` and later merged in `land` in the same run;
- a lap whose `review` output says merged but whose `land` output is `outcome = refused` with a `reason`;
- a lap running 13:50 to 14:20 UTC (two active hours) and one running 14:05 to 14:15 UTC (no new active hour);
- a lap whose `check-app` step ran twice;
- an `archon-manager` run and an `archon-holdouts` run with the same codebase and digest D, with costs;
- an `archon-loop` run with digest D whose codebase belongs to no factory, with costs.
For a second digest E add three laps none of which merges.
Steps:
1. Open the scorecard for D and for E; record each measure's displayed value and the lap count it says it rests on.
2. Export from the check branch the Archon runs and step events for the factory, and the app-check lines, in the shape `judges/scorecard.js` documents, and run it.
3. Also compare the seed's own versions against `fixtures/expected-scorecard.json`.
Expect:
- `judges/scorecard.js` prints PASS: every measure equals the definition computed independently from Archon's rows (within the displayed rounding), and every number shows the lap count it rests on.
- In particular: cost per merge includes the empty and failed laps' costs and excludes the manager, holdouts and foreign-codebase runs; the refused lap is a gate refusal showing its reason, not a merge; the sent-back-then-merged lap counts in both send-backs and merges; active hours count 13:00 and 14:00 once each.
- For E, merges per active hour shows 0 and lap-hours per merge and cost per merge show no number at all (not 0, `NaN`, `Infinity` or a blank that looks like zero).
- Seed versions match `fixtures/expected-scorecard.json` exactly.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-05 A comparison stops saying "not yet meaningful" at exactly 10 laps, live
Protects: 4.2 comparison rule; invariant 5; journey 3
Touches: version strip, scorecard comparison
Setup: the check app with two versions A and B of the factory: A has 12 completed laps, B has 9.
Steps:
1. Pick A and B on the strip and compare them; record which differences carry "not yet meaningful".
2. Without a reload, insert, as Archon would, one more completed lap for B (10 laps).
3. Record the labels again; then compare B against a version C that has 0 laps.
Expect:
- With 9 laps on B, every difference is labelled "not yet meaningful"; with 10 on each side, none is; any comparison against C is labelled.
- The change happens without a reload, within 5 seconds of the lap's completion.
- Each side shows the lap count it rests on.
- `judges/scorecard.js` PASS on the recorded comparisons.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-06 Each version wears the right pin, and a missing reason says "not recorded"
Protects: 4.2 version strip, key decisions, improvements being tested; 11.2 version keying; 11.5
Touches: push ingestion, pin trailer parser, version strip, decisions timeline, improvements ledger
Setup: the check app. Deliver, as GitHub push events on ai-software-factory: pin P1 (`Pin Archon <sha>: <reason>` with `Hypothesis` and `Measure`) at t1; pin P2 at t2 with a reason line but no trailers; a non-pin commit at t3; pin P3 at t5. Insert, as Archon would, laps with digest D1 first started between t1 and t2, digest D2 first started at t4 between t3 and t5, and more D2 laps after t5.
Steps:
1. Open the version strip and the improvements panel.
2. Push a verdict commit `Verdict: <first 8 chars of P1> helped: <sentence>`.
3. Push a `DECISIONS.md` change adding an entry in the fixed shape whose `Version:` is a 7-character prefix of P2's sha.
Expect:
- D1 is labelled with P1, its date, reason, Hypothesis and Measure; D2 is labelled with P2 (the latest pin before D2's first run, never P3 and never the non-pin commit), and its Hypothesis and Measure read "not recorded".
- Before step 2, P1 is listed as being tested with the laps it is still waiting for; after it, P1 shows "helped" and the sentence, without a reload. P2, which has no Measure, never appears as being tested.
- The new decision appears on the timeline linked to D2's version, without a reload.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-07 Labelling an issue needs-owner shows on every surface, and unlabelling undoes it
Protects: 4.4; journey 4; 4.3 graph state; 4.8 workable issues; 9 (seen within minutes)
Touches: label ingestion, owner queue, issue graph, health
Setup: the check app; an open issue #W with no claim, no `needs-owner`, and every `Depends on` closed (so it is workable); and a closed issue #C. Open the owner queue, the factory graph and health.
Steps:
1. Deliver the `labeled` event adding `needs-owner` to #W; record when each tab changes.
2. Deliver `needs-owner` added to the closed issue #C.
3. Deliver the `unlabeled` event removing `needs-owner` from #W.
Expect:
- After step 1, within 5 seconds and without a reload: #W is in the owner queue with a link to its GitHub thread and how long it has waited; the graph colors #W as needs owner; health's workable count drops by one.
- #C never appears in the owner queue.
- After step 3, everything returns: #W leaves the queue, the graph shows it as waiting, the workable count rises by one.
- `judges/liveness.js` PASS on the recorded timings.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-08 A claim and its release move an issue in and out of play everywhere
Protects: 4.3 claimed state and lanes; 4.8 workable issues
Touches: claim comment parser, issue graph, lanes, health
Setup: the check app; open issue #K, workable (no claim, no `needs-owner`, every dependency closed); open issue #L, unclaimed but with one `Depends on` still open.
Steps:
1. Insert, as Archon would, a running `archon-loop` run R, and deliver on #K the comment `Loop claim: run <R>` / `Route: simple` / `Area: app/x.tsx` exactly in the appendix format.
2. Deliver `Loop claim released: run <R> ended. ...` on #K and mark R completed.
3. Deliver a new claim on #K from another running run R2.
Expect:
- After step 1: #K is claimed in the graph, R's lane names #K with route `simple`, health's workable count falls by one.
- After step 2: #K is waiting again and workable again; R has no lane.
- After step 3: #K is claimed again, by R2's lane.
- #L is never counted as workable.
- Each change within 5 seconds and without a reload.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-09 Owner questions show in full and are only ever answered on GitHub
Protects: 4.4; section 5 (no answering in v1); invariant 2
Touches: owner decisions parser, owner queue
Setup: the check app; the factory's `Owner decisions needed` issue holds Q3 in the appendix format.
Steps:
1. Deliver an edit of that issue's body adding Q4 with options, a recommendation, and "If there is no answer by <date> UTC, the loop will use B."
2. Deliver an edit removing Q3.
3. Inspect every control on the owner queue and log every request the page makes while each one is used.
Expect:
- Q3 and then Q4 show their options, recommendation, default, the date the default applies, and how long each has waited, each linking to its GitHub thread; Q4 appears and Q3 disappears without a reload.
- No control on the queue answers, approves, dismisses or edits anything: every one is a link that opens GitHub, and the page sends nothing but seal renewals.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-10 Nothing in the dashboard writes to Archon, GitHub or a factory, by any route
Protects: invariant 2; section 5 (no writing, answering, approving, halting, launching or merging)
Touches: every screen, the server, the sealing API
Setup: the check app, with the serve process's outbound network logged. Snapshot row counts and the latest timestamps of Archon's tables on the check branch.
Steps:
1. Visit every screen and click every control, including every step detail, version pick, comparison, diff, rewind switch and back, and every link (without following it off the app).
2. Send the server, directly, POST, PUT, PATCH and DELETE requests to every path the app uses, plus `/api/health` and `/api/build-id`, with arbitrary JSON bodies.
3. Snapshot Archon's tables again.
Expect:
- Archon's tables are unchanged.
- The serve process makes no request to GitHub at all, and no request writes anything anywhere.
- No screen offers a control that answers, approves, halts, launches, retries or merges.
- `GET /api/health` returns 200 and `GET /api/build-id` returns the checked-out git commit.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-11 The browser gets sealed queries and nothing else: no secrets, no queries of its own
Protects: invariant 7; invariants 2 and 3 through the sealing API; 11.1 (seals expire every 60 seconds)
Touches: server, sealing API, built bundle
Setup: the check app.
Steps:
1. Collect everything the browser can reach: the HTML, every script and source map, every HTTP response, every Realtime frame, cookies, local and session storage.
2. Search it for the value of `NEON_REALTIME_SECRET`, the full `MC_DATABASE_URL` and its password alone, `NEON_API_KEY`, and the `gh` token.
3. Restart serve with a deliberately wrong database password and a wrong Realtime secret, load every screen, and repeat the search on the error responses and pages.
4. Call the sealing API directly asking it to seal: an INSERT, an UPDATE, a DELETE, a SELECT over Archon's event rows returning `structured_output` or `provider_event` data, and a SELECT the app never uses.
5. Replay a sealed query captured more than 70 seconds earlier, while the original page keeps running.
Expect:
- None of the secrets appears anywhere in steps 2 or 3, including in error messages.
- None of the step 4 requests gets a query sealed or rows back.
- The expired seal no longer delivers data, while the open page keeps updating through its renewals.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-12 Archon's writes never fail or wait because of the dashboard
Protects: invariant 1; 11.4 (trigger condition, errors recorded in `projection_errors`); 11.2 (provider events never read)
Touches: projection triggers, `projection_errors`, every live panel
Setup: a check branch with the migrations applied; note the `projection_errors` count.
Steps, each as Archon would, checking that each statement commits:
1. `node_completed` events whose `structured_output` is a JSON string, an array, `null`, and a 1 MB object; one with no `step_name`; one for a run id that does not exist.
2. A run row with `metadata` null, and one with no `workflow_source`; a run updated to `completed` twice.
3. In a second session, take an exclusive lock on every dashboard table the triggers write; then, with `statement_timeout = 2s`, insert a `node_completed` and update a run's status. Release the lock.
4. Rename one dashboard table the triggers write, insert a `node_started`, and rename it back.
5. Insert 1,000 `provider_event` rows and check whether any dashboard trigger function ran (for example through `pg_stat_user_functions` with function tracking on).
6. Insert a normal `node_started` and watch the lanes.
Expect:
- Every Archon statement in steps 1 to 5 commits; none waits on the lock (step 3 finishes inside the 2-second timeout) or raises.
- `projection_errors` grows for the rows that could not be projected (at least steps 3 and 4) and the trigger never raised.
- No dashboard trigger function runs for `provider_event` rows.
- After step 6, the lanes update within 5 seconds: the projection still works after its own failures.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-13 The check commands only ever touch `check-*` branches and never `main`
Protects: invariant 8; 11.3 check branches and migrations
Touches: fixture:branch, fixture:drop, fixture:write, the migrations runner
Setup: Neon credentials for the project. Create decoy branches `checkpoint-decoy`, `fixture-decoy`, `rewind-decoy` and `xcheck-decoy`, and a fresh `check-decoy`. Note every branch in the project with its creation time, and the table list and row counts of `main` (read-only).
Steps:
1. Run `bun run fixture:drop`.
2. Run the migrations runner and `bun run fixture:write label` with `MC_DATABASE_URL` set to `main`'s connection string with a deliberately wrong password, then the same with a `.mc-check.env` that names `main`.
3. Try `fixture:drop` and `fixture:write` aimed explicitly at `fixture-decoy` and `rewind-decoy`, if the commands take a branch.
Expect:
- Step 1 deletes only `check-*` branches older than 3 hours (and the current check branch if that is what it drops); every decoy, `fixture`, every `rewind-*`, and `main` remain. If no `check-*` branch older than 3 hours existed, that part is INCONCLUSIVE, not PASS.
- Step 2 is refused by name before any connection is tried: the output says it refuses `main`, not an authentication error.
- Step 3 is refused.
- `main`'s table list and row counts are as noted, apart from Archon's own writes.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-14 Rewind shows the past on every screen, writes nothing, and live comes back
Protects: 4.7; journey 5; invariant 5
Touches: rewind list and switch, every screen
Setup: the check app. Note a moment T. After T, insert a merged lap for a new digest, label an issue `needs-owner`, and add a claim.
Steps:
1. `bun run rewind:create <T>` and switch the dashboard to the new `rewind-<time>` branch.
2. Visit every screen: home map, version strip and scorecard, factory page, owner queue, testing, a lap from before T, health.
3. While on the rewind, write a new step event to the live branch, and snapshot the rewind branch's row counts before and after visiting every screen.
4. Switch back to live and write one more step event.
5. Try `bun run rewind:create` with a time 8 days ago.
Expect:
- On the rewind, every screen shows the data as of T: no lap, version, label or claim from after T; every panel reaches `data-state="ready"`; the screen makes plain it is a rewind and of which moment.
- The live write in step 3 does not appear on the rewind; the rewind branch's row counts do not change.
- The rewind list shows `rewind-*` branches only (no `check-*`, `fixture` or `main`).
- Back on live, the after-T data is all there and the step 4 write appears within 5 seconds, without a reload.
- Step 5 is refused or clearly reports that 7 days is the limit; no branch is made.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-15 The map and every step detail are exactly the pinned code, and change when the code does
Protects: 4.1; invariant 6; 11.4; journey 1; 4.2 architecture diff; invariant 3 (scenarios in the template)
Touches: architecture job, home map, step detail, architecture diff
Setup: the check app. Make a local copy of the pack and template in `fixtures/pack/`, and in the copy: change one sentence of `check-app`'s command file; add a step with a `when` condition to `archon-loop`; remove one inline subagent from another step; and write a scenario containing the canary `CANARY-PELICAN-2210` into the template's holdout scenario file. Run `bun run arch:parse` on the original and on the copy (local paths), so two versions exist.
Steps:
1. Open the home map at each version. Click `check-app` and read its detail; click a ship stage that comes from an include of an include, if the pack has one.
2. Compare the prompt, subagent instruction files, workflow YAML and `when` text on screen with the files at that version, byte for byte.
3. Open the architecture diff between the two versions.
4. Search every screen, every payload and every dashboard table for `CANARY-PELICAN-2210`.
Expect:
- The map shows inputs (product document, `archon-holdouts`, `archon-backlog`, owner decisions), the manager above the loop, the loop's steps in the order of 4.1 with ship expanded into its stages including nested includes, and the outputs.
- `check-app`'s detail shows its description, inputs and outputs, `when`, model tier, YAML, its prompt, the holdout verifier subagent and its instruction file, its scripts and hooks, and explains the fence: the hook file named in 4.1, that only the holdout-writer and holdout-verifier read the scenarios, and how a verdict comes back.
- Every text equals the file at that version exactly; switching versions switches the text.
- The diff lists exactly the changed prompt, the added step and the removed subagent, and nothing else.
- The canary appears nowhere.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-16 Health names each failed lap's cause and flags a stuck step at the right moment
Protects: 4.8
Touches: health, failed-lap cause classifier, stuck-step detection, workable vs running
Setup: the check app. Insert, as Archon would, failed laps whose failing step's error text is: "API Error: 429 Too Many Requests"; "You have hit your usage limit"; "HTTP 401 from provider"; "request unauthorized"; "connect ECONNREFUSED 127.0.0.1:5432"; "socket ETIMEDOUT"; "TypeError: fetch failed"; "Cannot read properties of undefined". For one step S, insert 60 completions: the oldest 10 at 10 hours each and the latest 50 at known short durations. Also a run with status `pending` and one with status `paused`.
Steps:
1. Open health; record each failed lap's cause and the pending and paused runs.
2. Insert `node_started` for S on a running lap and watch health over time; record the elapsed time at which S is flagged.
3. Record workable issues against running laps.
Expect:
- Causes: the first two usage limit, the next two authentication, the next three infrastructure, the last other.
- The pending and paused runs are listed.
- S is flagged only once it has run longer than twice the 90th percentile of its latest 50 durations (the 10-hour ones do not count), without a reload.
- `judges/health.js` PASS on the recorded causes and flag times.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-17 Everything is per factory: one works on its own, two never mix
Protects: 11.6; 10 (never summed across factories); 4.3 to 4.8 "per factory"
Touches: factories.json, every per-factory screen, home map live counts
Setup: the check app with `factories.json` as committed (mission control only).
Steps:
1. Visit every screen with exactly one factory; note any error or empty-state message.
2. Add a second factory to `factories.json` (another repository and Archon codebase name and console URL). Insert, as Archon would, running and finished laps for its codebase, and deliver GitHub issues, labels, claims and an owner question for its repository. Restart serve.
3. Visit every screen for each factory, and the home map's live counts.
4. Insert laps for a codebase that is in no factory.
Expect:
- With one factory every screen works and reaches ready, with no factory-picker error.
- With two, each factory's lanes, recent laps, graph, phases, owner queue, testing, health, scorecard and versions show only its own facts; no number anywhere sums both; the map's live counts are shown per factory; one-lap console links use that factory's console URL.
- Laps from a codebase in no factory appear nowhere.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-18 One lap tells the same story as every other screen
Protects: 4.6; 4.3 recent laps outcomes; 4.2 definitions; invariant 4
Touches: one lap, recent laps, lanes, scorecard
Setup: the check app, with a lap of each outcome in the seed or inserted: merged, sent back, gate refused, needs owner, nothing to do (empty), failed.
Steps: for each lap, open recent laps, its one-lap page, and the scorecard for its version.
Expect:
- Recent laps and the one-lap page give the same outcome, from the six named in 4.3.
- The one-lap page lists every step it ran with start, duration, model, tokens and cost, plus its route and depth, its app-check lines (kind, verdict, evidence count), the review outcome and dispositions, and the merge gate's outcome and the refusal reason text.
- The lap's cost on recent laps and on its page equals the sum of its steps' `cost_usd`; its duration equals `completed_at` minus `started_at`.
- The Archon link is exactly `<console URL from factories.json>/console/r/<runId>`; the issue and pull-request links point at the factory's repository.
- The gate-refused lap counts as a gate refusal on the scorecard, not a merge; the empty lap as an empty lap; the failed lap as a failed lap.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-19 The home screen is ready in 2 seconds, and every screen passes the design probe
Protects: 8.4; 8.3
Touches: every screen, live query performance, design tokens
Setup: the check app on the seed, with a cold browser profile.
Steps:
1. Open the home screen at 1440 and at 390 px wide, five times each; record for every panel, measured from navigation, the time to `data-state="ready"`, the time its first snapshot arrived, and the time its rows were on screen.
2. On the seed, run `EXPLAIN ANALYZE` on every live query the home screen subscribes to, and record each one's execution time.
3. Run `harness/design-probe.js` on every screen at both widths: home map, a step detail open, version strip with a comparison, architecture diff, factory page, owner queue, testing, one lap, rewind, health, and a factory with no laps.
4. Open the app with the operating system set to light mode.
Expect:
- `judges/speed.js` PASS: every live query's `EXPLAIN ANALYZE` execution under 100 ms; on every run, every panel ready within 2000 ms of navigation and its rows on screen within 500 ms of its first snapshot arriving. The time from the subscribe to the first snapshot is Neon's and is judged only through the 2000 ms ready bound.
- The design probe reports zero failures on every screen at both widths.
- The app stays dark in light mode.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)
Revised: writer, 2026-10-27, owner decision on #137/#141 (engineering.md live-panel speed rule): the 500 ms bound runs from the first snapshot arriving, not from navigation; the query's own work is judged by `EXPLAIN ANALYZE` under 100 ms.

## H-20 Default-branch holdout verdicts follow the latest manager pass
Protects: 4.5; 11.7; invariant 3
Touches: metrics line parser, testing panel, live updates
Setup: the check app. Deliver a `Loop metrics` body edit adding `<time1> | holdouts at <sha1>: H-01 PASS, H-02 FAIL #41, H-03 INCOMPLETE #42`.
Steps:
1. Open the testing panel; record its default-branch verdicts and the scenarios failing on the default branch.
2. Deliver a later line `<time2> | holdouts at <sha2>: H-01 FAIL #43, H-02 PASS, H-03 INCOMPLETE #42`.
3. Insert a lap whose app-check carries a holdout line for H-02 with verdict FAIL, so it has a pull-request-time verdict.
Expect:
- After step 1: H-02 shows as failing on the default branch with a link to #41; H-03 shows as incomplete with #42; the commit is named.
- After step 2, without a reload: H-01 is failing with #43; H-02 no longer is; the verdicts are those of `<sha2>`, never a mix of the two passes.
- The pull-request-time FAIL for H-02 from step 3 shows separately from its default-branch PASS.
- The mix of routes and check depths, and app-check lines by kind and verdict, include the new lap.
- Only ids and verdicts show: no scenario text.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-21 A factory that does not exist says so on every screen, and never wears another factory's name
Protects: 11.6 (every view is keyed by factory and must work with exactly one); engineering.md (an empty state is one sentence and at most one button); 8.4 (panels settle); invariant 7 (error screens)
Touches: every screen whose address carries a factory key (whichever exist at the time of the check: factory page, versions, scorecard and comparison, decisions, improvements, owner queue, testing, one lap, health, rewind), the shared header and factory strip, the server's factory list
Setup: the check app. Run it twice: once with `factories.json` as committed (one factory, A), and once with a second factory B added (as in H-17) with laps and issues of its own, serve restarted. List every factory-keyed address the app's own links lead to (follow the links from each screen; do not guess routes from the code).
Steps:
1. With one factory, open each factory-keyed address directly (typed, fresh tab) with each of these keys in place of A's: `nope`; A's key in a different letter case; A's key with a trailing encoded space (`%20`); an empty key; a 300-character key; `..%2F`. Record each screen's text, the header, and every panel's `data-state` after 3 seconds.
2. With two factories: open B's versions screen and one of B's laps; then remove B from `factories.json`, restart serve, and reload both tabs (a stale bookmark). Then, with B restored, open under A's key the one-lap address of a lap that belongs to B, and A's version or scorecard address for a digest only B ran.
3. From an unknown-key screen, use the one button it offers (if any), then the browser's Back and Forward.
4. Restart serve with a deliberately wrong Realtime secret (and, separately, a wrong database password). Open A's factory page and versions screen with A's real key, and the same screens with the key `nope`. Restore the settings.
Expect:
- Every unknown, stale or malformed key, on every factory-keyed screen, reads as "this factory does not exist" (or words to that effect: the key is not in the factory list), in one sentence with at most one button, which leads somewhere that works (for example the home map or a real factory). No such screen says live data is unavailable, offline, an error occurred, or retry; no panel is left loading or spinning: within 2 seconds every panel has settled.
- While the key is unknown, the header, factory strip and page title show no factory's name, repository, running-lap count, console link or any other number belonging to A or B; they do not silently fall back to the first factory in the list.
- A differently cased or padded key is either treated as A everywhere (header and every panel agree, and A's facts show) or as unknown everywhere; never A's name in the header over an error or empty panel.
- B's lap under A's key and B's digest under A's key never show B's facts under A's name; they read as not found in A (one sentence, at most one button), not as an outage.
- After B is removed, its old addresses read as a factory that does not exist, with no B facts and no B name left in the header.
- Back and Forward land on the same states again: the unknown screen still says it does not exist with an identity-free header, and the real factory's screen shows its own name and facts, with no flash of the other.
- During the real outage in step 4, A's screens with A's real key read as live data unavailable (an outage, not "does not exist", and not an empty "no versions yet"), with A named in the header; the `nope` key still reads as a factory that does not exist (the factory list is committed and does not depend on the database). No secret appears on any of these screens (as H-11).
- The design probe reports zero failures on an unknown-key screen at 1440 and 390 px.
Author: writer, 2026-10-25, escaped defect #79 (an unknown factory key read as an outage, with a real factory's identity in the header)

## H-22 A version is one factory's digest, named by the pin before that factory first ran it
Protects: 11.2 row "Which version a lap ran" (keyed by (factory, digest), labelled by the most recent pin committed before the first run with that digest); 4.2 version strip ("not recorded"); 11.5; 11.6 and 10 (never mix or sum factories)
Touches: version keying in the projection, push ingestion, version strip, scorecard, comparison, improvements ledger
Setup: the check app with two factories A and B (as in H-17). On ai-software-factory, deliver as push events pins P1 at t1, P2 at t3 and P3 at t6 (each with a reason, Hypothesis and Measure). Insert, as Archon would: for A, laps with digest X first started at t4 and more at t7; for B, laps with the same digest X first started at t7. For A, also laps with digest Y first started at t5 and digest Z first started one minute later (two digests between the same pins), and laps with digest W first started at t0, before every pin. Insert one `archon-loop` lap for A whose run has no `workflow_source` digest.
Steps:
1. Open A's version strip and B's version strip; record every entry with its label, date, reason, Hypothesis and Measure, and the lap count of each version's scorecard.
2. Compare A's X with B's X, if the comparison allows versions from two factories; otherwise compare A's X with A's Y.
3. Push a pin P4 to ai-software-factory, with no run of any new digest after it.
Expect:
- A's X is labelled P2 (the latest pin before A's first X run at t4); B's X is labelled P3 (the latest pin before B's first X run at t7). They are two versions, each with only its own factory's laps: A's X scorecard counts no B lap and B's none of A's.
- Y and Z are two separate entries, both labelled P2; neither is merged into the other or into X.
- W, whose first run precedes every pin, is listed on A's strip with its laps, and its pin, reason, Hypothesis and Measure read "not recorded"; it is never labelled P1.
- The lap with no digest is counted in no version's scorecard and is never shown as part of any pinned version.
- P4, which no run has used, adds no version to either strip and appears on no scorecard.
- A comparison across factories, if offered, never shows one combined number for both; each side names its factory and the laps it rests on.
Author: writer, 2026-10-25, coverage of PRD 11.2 version row and 4.2 version strip before the loop builds them

## H-23 A pin that arrives late relabels its version live, and only the latest pin before the first run counts
Protects: 11.2 (labelled by the most recent pin committed before the first run with that digest; push webhook, reconcile and backfill); 4.2 version strip, comparison and improvements; invariant 5
Touches: push ingestion and its ordering, reconcile, version strip, scorecard comparison, improvements ledger
Setup: the check app with one factory. Deliver pin P1 at t1. Insert, as Archon would, laps with digest D first started at t5 (so D is labelled P1). Open the version strip, a comparison of D with another version, and the improvements panel; set the reload marker.
Steps:
1. Deliver, late, a push event for pin P2 whose commit time is t4 (before D's first run) but which arrives now, after D's laps. Record when the strip changes.
2. Deliver a push for pin P3 whose commit time is t6 (after D's first run).
3. Deliver a push for pin P0 whose commit time is t0 (before P1).
4. Deliver the P2 push event a second time (a webhook redelivery), then run the nightly reconcile or backfill once.
5. Insert one more lap with digest D at t8.
Expect:
- After step 1, without a reload and within 5 seconds: D is labelled P2 with P2's date, reason, Hypothesis and Measure; the open comparison still compares the same two versions and now names D by P2; D's scorecard numbers and the laps they rest on do not change; P2 (which has a Measure) is listed as being tested, waiting on D's laps.
- Steps 2 and 3 do not change D's label (P3 is after D's first run; P0 is not the most recent before it).
- Step 4 creates no duplicate entry and no change of label; step 5 counts the new lap in D without changing its label.
- The strip keeps exactly one entry per (factory, digest): no relabel splits D into two entries or leaves a stale P1 entry behind.
- `judges/liveness.js` PASS on the step 1 timing.
Author: writer, 2026-10-25, coverage of PRD 11.2 version row and 4.2 version strip before the loop builds them

## H-24 Moving between factories is a click, and no screen ever shows the factory you just left
Protects: 11.6 (every view keyed by factory; never mix factories); 10 (never summed); invariant 5; 8.4
Touches: factory strip or picker, shared header, every factory-keyed screen, home map live counts and step detail, live query lifecycle
Setup: the check app with two factories A and B, each with running laps, recent laps, versions, issues and an owner question of its own; A has many more laps than B. Open A's factory page and set the reload marker.
Steps:
1. Without typing a URL, move from A to B using only the app's own controls, from each of: the home map, A's factory page, A's version strip, A's owner queue, A's testing and health screens, and one of A's laps. Record where each move lands and what the header says.
2. With the network throttled so panels take several seconds to load, open A's factory page and move to B before any panel is ready; then switch A, B, A, B quickly and stop on B.
3. While on B, insert, as Archon would, a `node_started` for one of A's running laps, and then one for one of B's.
4. Use Back to return to A, then Forward.
Expect:
- From every screen there is a visible control to reach the other factory, and the move lands on that factory's matching screen where one exists (from a lap or a version that has no counterpart, on that factory's nearest sensible screen, not an error and not "does not exist").
- After every move, the header and every panel show only the chosen factory's facts: its name, running-lap count, lanes, laps, versions, owner questions and numbers. No panel briefly or permanently shows the factory left behind, including after the throttled race in step 2: a late snapshot from A never lands on B's screen.
- In step 3, A's write changes nothing on B's screen; B's write appears within 5 seconds, without a reload (`judges/liveness.js` PASS).
- Back and Forward restore each factory's screen with its own facts and header.
- On the home map, the live counts of A and of B are told apart on each step, and step 3 changes only the count of the factory whose lap moved; a step's detail shows the same pinned content whichever factory you came from.
- Every panel reaches `data-state="ready"` within 2 seconds of each unthrottled move.
Author: writer, 2026-10-25, coverage of PRD 11.6 factories before the loop builds it

## H-25 With exactly one factory nothing offers a phantom second
Protects: 11.6 (must work with exactly one); engineering.md (empty states are one sentence and at most one button); 4.1 per-factory live counts
Touches: factory strip or picker, shared header, home map, every factory-keyed screen, the root address
Setup: the check app with `factories.json` as committed (one factory). Separately, a copy with one factory whose codebase has no laps, no issues and no versions yet (serve restarted).
Steps:
1. Open the app's root address and every screen reachable from it; open every menu, picker and dropdown.
2. Insert, as Archon would, a running lap for a codebase in no factory, and one for the factory.
3. Repeat step 1 on the factory with no data yet.
Expect:
- The root opens straight onto working screens: no "choose a factory" prompt, no "all factories" or combined view, no empty, blank, placeholder or second entry in any factory list, and no control that switches to nothing.
- The home map's live counts show the one factory's laps only; the lap of the codebase in no factory appears nowhere and changes no count.
- With a factory that has no data, every screen reaches ready and shows a one-sentence empty state with at most one button: never an outage message, and never "does not exist" for a factory that is in the list.
Author: writer, 2026-10-25, coverage of PRD 11.6 factories before the loop builds it
