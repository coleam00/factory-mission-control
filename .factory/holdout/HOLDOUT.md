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
5. Measure trigger firings in a way the check branch's own role can read (Neon refuses `SET track_functions`, so `pg_stat_user_functions` is not used): (a) as a positive control, `EXPLAIN (ANALYZE) INSERT` one `node_started` event and note the `Trigger <name>: ... calls=` lines the dashboard's triggers print; (b) in one transaction, `EXPLAIN (ANALYZE) INSERT` 1,000 `provider_event` rows, then 10 rows each of two other event types that are not one of the four step-level events, then read `pg_stat_xact_user_tables` for every dashboard table and for `remote_agent_workflow_events` before `COMMIT`; (c) list every trigger on `remote_agent_workflow_events` from `pg_trigger` (with `pg_get_triggerdef`), noting whether each is row-level and its `WHEN` condition. Note `projection_errors` again.
6. Insert a normal `node_started` and watch the lanes.
Expect:
- Every Archon statement in steps 1 to 5 commits; none waits on the lock (step 3 finishes inside the 2-second timeout) or raises.
- Every committed Archon statement reads back exactly as written: after step 3 the run's status in Archon is the new status, not the old one (tightened 2026-10-26: H-32 covers every write kind under every lock).
- `projection_errors` grows for the rows that could not be projected (at least steps 3 and 4) and the trigger never raised.
- No dashboard trigger function runs for `provider_event` rows, nor for any event type outside the four step-level ones: the positive control in step 5(a) shows the dashboard's trigger with `calls=1`, and step 5(b)'s plans show no dashboard trigger with any call (no `Trigger` line, or `calls=0`); `pg_stat_xact_user_tables` shows the events table's 1,020 inserts and zero inserted, updated or deleted rows on every dashboard table; `projection_errors` is unchanged by step 5; and step 5(c) finds no statement-level trigger on the events table and every row-level one has a `WHEN` that admits only the four step-level event types (11.4). If the positive control shows no trigger line, step 5 is INCONCLUSIVE, never PASS.
- After step 6, the lanes update within 5 seconds: the projection still works after its own failures.
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)
Revised: writer, 2026-10-27, #225 (Neon refuses `SET track_functions` on a check branch, so step 5 always read INCOMPLETE): the function-count measurement is replaced by trigger call counts from `EXPLAIN ANALYZE` with a positive control, transaction-level tuple counts on every dashboard table, and the trigger catalog; it now also covers non-step event types.

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
Setup: the check app. A rewind is cut from the branch it is made from (at the pinned code, `main`), so the after-T data it is judged on must be data that branch holds after T. Reading `main` only (never writing to it, invariant 8), pick T inside the last 7 days on `main`'s own history such that `main` holds, before T, at least one finished lap, and after T, at least one lap Archon started or finished (prefer one with a step event, a merged lap, a version first run after T, and a GitHub fact such as a label, claim or comment recorded after T, where `main` has them). Note, read-only, exactly which of `main`'s laps, versions, step events, labels, claims and comments fall before and after T. If `main` has no lap after T within the last 7 days, the "nothing after T" part is INCONCLUSIVE, never PASS. Separately, on the check branch the dashboard runs on live, after noting T insert a merged lap for a new digest, label an issue `needs-owner`, and add a claim (these judge the return to live, not the rewind).
Steps:
1. `bun run rewind:create <T>` and switch the dashboard to the new `rewind-<time>` branch. Note, read-only, any row Archon writes to `main` from here to the end of the run.
2. Visit every screen: home map, version strip and scorecard, factory page, owner queue, testing, a lap of `main`'s from before T, a lap of `main`'s from after T (by its address), health.
3. While on the rewind, write a new step event to the live branch, and snapshot the rewind branch's row counts before and after visiting every screen.
4. Switch back to live and write one more step event.
5. Try `bun run rewind:create` with a time 8 days ago.
Expect:
- On the rewind, every screen shows the data as of T: no lap, version, label or claim from after T; every panel reaches `data-state="ready"`; the screen makes plain it is a rewind and of which moment.
- Judged against what `main` held, as noted in the setup: every lap, version, step event, label, claim and comment `main` recorded after T is absent from every screen on the rewind (counts, scorecard, version strip, recent laps, owner queue, health), and the after-T lap's address reads as not found at that moment, never its detail; `main`'s before-T lap is there with its detail. No row Archon wrote to `main` after the rewind was made appears on it (if Archon wrote none during the run, that part is INCONCLUSIVE).
- The live write in step 3 does not appear on the rewind; the rewind branch's row counts do not change.
- The rewind list shows `rewind-*` branches only (no `check-*`, `fixture` or `main`).
- Back on live, the after-T data is all there and the step 4 write appears within 5 seconds, without a reload.
- Step 5 is refused or clearly reports that 7 days is the limit; no branch is made.
(Tightened 2026-10-27: after-T data is now taken from the branch the rewind is cut from, so a rewind that leaks later data fails.)
Author: writer, 2026-10-24, first set for the whole release (docs/mission-control.prd.md)

## H-15 The map and every step detail are exactly the pinned code, and change when the code does
Protects: 4.1; invariant 6; 11.4; journey 1; 4.2 architecture diff; invariant 3 (scenarios in the template)
Touches: architecture job, home map, step detail, architecture diff
Setup: the check app. Make a local copy of the pack and template in `fixtures/pack/`, and in the copy: change one sentence of `check-app`'s command file; add a step with a `when` condition to `archon-loop`; remove one inline subagent from another step; and write a scenario containing the canary `CANARY-PELICAN-2210` into the template's holdout scenario file. Run `bun run arch:parse` on the original and on the copy (local paths), so two versions exist. Label each version the way the factory does, with a pin commit delivered as a push event on ai-software-factory in the appendix form (`Pin Archon <sha>: <reason>` naming the Archon commit by its first 8 characters, with `Hypothesis` and `Measure` trailers), and with laps of that version's digest inserted after its pin; never only the seed's form, where pin and architecture carry the identical full sha.
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
- No screen at either version says there is no architecture, nothing available, or not recorded: a pin naming the commit by a short sha finds the architecture the job stored (tightened 2026-10-26, escaped defect #157).
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
3. Push a pin P4 to ai-software-factory, with no run of any new digest after it. Record A's and B's version strips again.
Expect:
- A's X is labelled P2 (the latest pin before A's first X run at t4); B's X is labelled P3 (the latest pin before B's first X run at t7). They are two versions, each with only its own factory's laps: A's X scorecard counts no B lap and B's none of A's.
- Y and Z are two separate entries, both labelled P2; neither is merged into the other or into X.
- W, whose first run precedes every pin, is listed on A's strip with its laps, and its pin, reason, Hypothesis and Measure read "not recorded"; it is never labelled P1.
- The lap with no digest is counted in no version's scorecard and is never shown as part of any pinned version.
- Pins are shared (changed 2026-10-27, owner decision on #85, restated on #27 question 7): P1 and P4, which no lap in any factory has run, each show on both A's and B's strips, since both factories have laps, marked NOT YET RUN, with their reason, Hypothesis and Measure. Neither is a version with laps: neither has a scorecard or a lap count, neither takes any lap or digest from either factory, and neither changes any other entry's label or count. P4 shows on both strips after step 3, and so does P1 from step 1.
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

## H-26 Every step on the map, at any include depth, opens its own full detail
Protects: 4.1 (ship expanded into the stages parsed from `archon-ship-block` and its includes; clicking a step opens its detail); 11.4 (includes expanded the way Archon expands them); invariant 6; journey 1
Touches: architecture job include expansion, home map, step detail, every workflow on the map (inputs, manager, loop, ship stages)
Setup: the check app at the pinned version. Independently of the app (reading the pinned pack and template files, never the app's tables or payloads), list every step a lap could run under `archon-loop`, `archon-manager`, `archon-holdouts` and `archon-backlog`, expanding every include the way Archon does, to whatever depth it goes; note for each its include path, YAML and command file.
Steps:
1. Open the home map. For every step it shows, including every stage under ship and every step that sits inside an included block, click it and record where it leads.
2. Open each of those addresses in a fresh tab by typing it, and record the page after 3 seconds.
3. Record everything in the shape `judges/step-coverage.js` documents and run it.
Expect:
- Every step in the independent list is on the map, and every step on the map is in the list: no included block is shown as one opaque box with no way into its steps, and nothing is invented.
- Every one of them, at every depth, leads to a ready detail page for that step: its description, inputs and outputs, `when`, model tier, its own workflow YAML, its prompt, its inline subagents and their instruction files, its scripts and its hooks (a section the step does not have says so). None reads as not found, empty, an error or a spinner, and none shows the step that included it instead.
- An included step's YAML and prompt are that step's own, from the included block's file at that version, byte for byte.
- `judges/step-coverage.js` prints PASS.
Author: writer, 2026-10-26, escaped defect #105 (steps inside an included block had no detail page)

## H-27 A step address works on its own, survives reload, and follows the version
Protects: 4.1 step detail; 4.2 (versions and the architecture diff); invariant 6
Touches: step detail addressing, version strip or pin selector, architecture diff, browser history
Setup: the check app with two versions parsed (as H-15: the committed pack, and a local copy). In the copy, change one sentence of the command file of a step that lives inside an included block (not a top-level loop step), and remove a different step from inside an included block.
Steps:
1. From the map at the newer version, open the changed included step's detail; copy its address. Open it in a fresh tab, reload it, then use Back and Forward.
2. On that detail, switch to the older version by the app's own controls.
3. Open the removed included step's detail at the version that has it, then switch to the version that does not.
4. Open the architecture diff between the two versions and follow whatever it offers toward the changed and removed steps.
Expect:
- The copied address opens the same step's full detail in a fresh tab and after a reload, never the map's home state, a parent step, or a not-found; Back and Forward return to the same pages.
- Switching versions on the changed step shows that version's text for the same step; nothing from the other version lingers.
- On the version without the removed step, its detail reads as not found at that version (one sentence, at most one button), never the other version's content.
- The diff names the changed prompt and the removed step by the included step's own name, as steps, not as a change to the step that includes them; where the diff links to a step, the link opens that step's detail at the right version.
Author: writer, 2026-10-26, escaped defect #105 (steps inside an included block had no detail page)

## H-28 Two blocks with a step of the same name each keep their own detail
Protects: 4.1 step detail; 11.4 (steps stored per workflow; includes expanded the way Archon expands them); invariant 6
Touches: architecture job step identity, home map, step detail addressing, architecture diff
Setup: the check app. If the pinned pack has no step id used in two different workflows or blocks, make a local copy of the pack where an included block of ship has a step with the same id as a top-level `archon-loop` step (for example `review`), and a second included block also has a step with that id, each with a different description, YAML and command file; parse it as a version.
Steps:
1. On the map, click each of the same-named steps in turn; record the address and the detail.
2. Open each address in a fresh tab; reload each.
3. Open the architecture diff between this version and the committed one.
Expect:
- Each same-named step leads to its own address and its own detail: its own description, YAML, prompt, `when` and subagents, from its own file. No two of them share an address, and none shows another's content or a merge of both.
- Each address reopens the same step after a reload.
- The map shows each in its own place (top-level loop step, and inside each block under ship) and counts none of them twice.
- The diff lists each added step once, told apart by where it lives.
- `judges/step-coverage.js` PASS on a record covering these steps.
Author: writer, 2026-10-26, escaped defect #105 (steps inside an included block had no detail page)

## H-29 An include of an include is expanded all the way down, in Archon's order
Protects: 4.1 (ship expanded into the stages parsed from `archon-ship-block` and its includes); 11.4 (includes expanded the way Archon expands them)
Touches: architecture job include expansion, home map ordering, step detail
Setup: a local copy of the pack nested to the deepest include level Archon at the pinned sha actually loads, and no deeper: `archon-loop` includes ship (level 1), an included block of ship includes a second block (level 2), and that block includes a third (level 3), each block with at least two steps (Archon's include limit at the pinned sha is 3 levels from the workflow it is loaded as; if the pinned Archon's own limit reads differently, nest to exactly that limit). Also one block included from two different places, both within the limit, one of them at the deepest level. Before parsing, confirm with Archon's own loader at the pinned sha that it loads the copy without refusing it; if Archon refuses the copy, or no nesting deeper than one block below ship is possible within the limit, the scenario is INCONCLUSIVE, never PASS. Parse it as a version alongside the committed pack. Work out by hand, from Archon's own include behaviour, the expanded order and occurrences. (Tightened 2026-10-27: the earlier setup nested one level past what Archon loads.)
Steps:
1. Open the map at that version; record the stages under ship in order.
2. Click every step at every level, including both places the shared block appears.
3. Change one sentence in the deepest block's command file, parse again, and open the deepest step's detail at the new version and at the previous one.
Expect:
- The map shows every step of every level under ship, in the order and with the occurrences Archon's expansion gives; the deepest block's steps (at Archon's limit) are not missing, collapsed or flattened out of order, and no included block at any level is shown as one box with no way into its steps.
- Every step at every level opens its own ready, full detail; the shared block's steps open from both places and show that block's file.
- After step 3, the deepest step's prompt shows the new sentence at the new version and the old one at the previous version.
- `judges/step-coverage.js` PASS on a record covering this version.
Author: writer, 2026-10-26, escaped defect #105 (steps inside an included block had no detail page)

## H-30 A step that does not exist still reads as not found, and only those do
Protects: 4.1 step detail; engineering.md (an empty state is one sentence and at most one button); 8.4 (panels settle)
Touches: step detail addressing, shared header, home map
Setup: the check app at the pinned version. Take a real included step's address (from H-26) and a real top-level step's address.
Steps: open, each in a fresh tab, step addresses with: an id no workflow has (`nope`); a real included step's id placed under the wrong parent workflow or block, if the address carries one; a real step id in a different letter case; a real id with a trailing `%20`; an empty id; a 300-character id; `..%2F`; and the id of a step that exists only at another version, under this version. Record each page after 3 seconds and every panel's `data-state`.
Expect:
- Every one reads as this step not found (or words to that effect) in one sentence with at most one button that leads somewhere working (for example the map); none shows another step's detail, a parent step, an outage message or a spinner, and every panel has settled within 2 seconds.
- The real included and top-level addresses, opened the same way, show their full detail: the not-found rule catches only steps that are truly not in the parsed architecture at that version.
- A differently cased or padded id is treated as the real step everywhere on the page or as not found everywhere, never a real step's name over an empty detail.
Author: writer, 2026-10-26, escaped defect #105 (steps inside an included block had no detail page)

## H-31 Laps on an included step light that step on the map, and the map leads into it
Protects: 4.1 Live (each step shows per factory how many laps are on it now; `data-live-count` greater than 0 and a running style); invariant 5
Touches: Archon projection, home map live counts, step detail
Setup: the check app, home map open with the reload marker set. Pick a step whose id is unique in the pinned architecture and that lives inside a block included by ship (two levels down if the pack has one).
Steps:
1. Insert, as Archon would, a running `archon-loop` lap and a `node_started` whose `step_name` is that included step.
2. Click the step that now carries the count.
3. Insert `node_completed` for it and `node_started` for the next step in Archon's order.
Expect:
- Within 5 seconds and without a reload, that included step on the map carries `data-live-count` of 1 and the running style, as a top-level step would; the count is on the step itself, not only on ship or the block that includes it, and no other step's count changes.
- Clicking it opens that step's full detail, not ship's.
- After step 3, its count returns to 0 and the next step's rises to 1 within 5 seconds (`judges/liveness.js` PASS).
Author: writer, 2026-10-26, escaped defect #105 (steps inside an included block had no detail page)

## H-32 No lock on any dashboard table ever makes any Archon write fail or wait
Protects: invariant 1 (never make an Archon write fail or wait; a trigger never raises); 11.4 (every trigger body catches every error into `projection_errors`); engineering.md ("Nothing writes to Archon's tables. Triggers on them catch every error into projection_errors")
Touches: every dashboard trigger on Archon's tables (runs and events, and any added later: versions, pins, laps, steps, verdicts), every dashboard table they write
Setup: a check branch with the migrations applied. List every table the repository's migrations created (in every schema they use, not only the one the trigger names suggest) as `dashboard_tables`, and every trigger on Archon's tables (`pg_trigger` on `remote_agent_workflow_runs` and `remote_agent_workflow_events`, with the operations each fires on) as `archon_triggers`. Insert two running `archon-loop` laps for the factory to act on.
Steps: for each dashboard table T in turn, a second session takes `LOCK TABLE T IN ACCESS EXCLUSIVE MODE` and keeps it (confirm in `pg_locks` that it is granted). Then, in a session that behaves as Archon would (its own default settings, plus `statement_timeout = 2s`), make each of these writes, one statement each, timing each and noting any error:
1. Insert an `archon-loop` run with a digest no version has yet, and one with a digest an existing version has.
2. Update a running lap to `completed` with `completed_at`; update another to `failed`; update a run without changing its status (metadata or `updated_at` only).
3. Insert `node_started`, `node_completed` (with `structured_output`, `cost_usd`, `duration_ms`), `node_failed` and `node_skipped` events.
4. Insert a `provider_event` row.
5. Make one write of every other kind any recorded trigger fires on (every operation of every trigger in `archon_triggers`).
6. Read each written Archon row back. Release the lock, reset the laps, and move to the next table.
Then, for a run status update and a `node_completed`, repeat under two more kinds of contention on the dashboard row the write would change (for example that lap's row in the laps table): a second session holding `SELECT ... FOR UPDATE` on it, and a second session that updated it and has not committed. Repeat those two writes also inside one Archon transaction (`BEGIN`, the event insert, the run update, `COMMIT`).
Record the run in the shape `judges/archon-writes.js` documents.
Expect:
- Every Archon write, under every lock, commits within 2 seconds and Archon's session receives no error of any kind: not a lock timeout, a statement timeout, a deadlock, a serialization failure or an error re-raised from a trigger. Its row then reads back exactly as written (a status update leaves the new status in Archon).
- An Archon write that fails or is cancelled is a FAIL on its own, whatever the dashboard shows afterwards and even if `projection_errors` records it.
- `bun .factory/holdout/judges/archon-writes.js <record.json> archon` prints PASS. A missing combination of table, write kind and lock is INCONCLUSIVE, never PASS.
Author: writer, 2026-10-26, escaped defect #114 (Archon's run-status update was cancelled while a dashboard table was locked)

## H-33 After a lock, a lap Archon finished never stays running, and nothing is lost silently
Protects: invariant 1; 11.4 (`projection_errors`); 4.3 lanes and recent laps; invariant 4 (every number can be traced); 8.1
Touches: projection triggers, `projection_errors`, the lap repair (`bun run reconcile:laps`), lanes, recent laps, health, scorecard
Setup: the check app on a check branch, with the factory page, health and the scorecard for the laps' version open (reload marker set). Note the `projection_errors` count. Insert, as Archon would, four running `archon-loop` laps L1..L4 with a step each.
Steps:
1. In a second session take an access exclusive lock on the dashboard's laps table (repeat the whole scenario once for each other dashboard table the projection writes, as listed in H-32, starting from fresh laps).
2. While the lock is held, as Archon would: mark L1 `completed` with `completed_at` after a `land` `node_completed` with `outcome = merged`; mark L2 `failed`; insert `node_completed` and the next `node_started` for L3; leave L4 alone. Record each statement's outcome as in H-32.
3. Release the lock. With no further Archon write, record what the lanes, recent laps and health show, and the `projection_errors` count.
4. Run `bun run reconcile:laps`. Record the screens again, without a reload.
5. Run it a second time; then restart serve and reload. Record the screens each time.
6. Insert a `node_started` for L4 and watch the lanes.
Expect:
- Every Archon write in step 2 commits within its bound (as H-32); if any did not, this scenario FAILs on that alone.
- After step 3, any lap the screens show wrong is matched by new `projection_errors` rows: the dashboard never misses an update without recording it.
- After step 4, within 5 seconds and without a reload: L1 and L2 are gone from the lanes and listed on recent laps (merged, and failed), with durations and costs from Archon's rows; L3's lane shows its new step and cost; L4 is unchanged; health and the scorecard agree with the lanes (L1 a merge, L2 a failed lap, each counted once).
- Step 5 changes nothing: a second repair and a restart show the same, with no lap counted twice.
- After step 6, L4's lane moves within 5 seconds: the projection works again by itself.
- `bun .factory/holdout/judges/archon-writes.js <record.json> repair` prints PASS, and the `archon` part on the step 2 attempts also prints PASS.
Author: writer, 2026-10-26, escaped defect #114 (a finished run stayed Running on the lanes after a lock, with no projection error recorded)

## H-34 A lock held across a whole lap, longer than Archon would ever wait, still costs Archon nothing
Protects: invariant 1 (never fail or wait); 11.4; 11.2 version keying (a new digest during the lock); 4.3 lanes and recent laps
Touches: every projection trigger including versions and pins, the lap repair, version strip, lanes, recent laps, one lap
Setup: the check app; note the version strip and the `projection_errors` count.
Steps:
1. A second session opens a transaction, takes access exclusive locks on every dashboard table the projection writes at once, and holds them for 60 seconds.
2. During those 60 seconds, as Archon would, run a whole lap from nothing with a digest no version has: the run insert, `node_started` and `node_completed` for every loop step (pick, claim, build, ship, subject, briefs, check-app, evidence, review, land with `outcome = merged`), and the run's update to `completed`. Also, while the lock is held, deliver a pin push as GitHub would. Time every Archon statement.
3. Let the locks go by rolling the second session back (not committing). Run `bun run reconcile:laps`, and any repair or reconcile the app offers for versions.
Expect:
- Every Archon statement in step 2 commits within 2 seconds of being sent and none receives an error; the whole lap's writes finish long before the locks are released.
- After the repair, without a reload: the lap is on recent laps as merged (never on the lanes), with every step on its one-lap page and a cost equal to the sum of its steps' `cost_usd`; its digest is one new entry on the version strip labelled by the latest pin before its first run, counting this lap once.
- `judges/archon-writes.js` (both parts) prints PASS on the recorded run.
Author: writer, 2026-10-26, escaped defect #114 (class: every Archon write any trigger reacts to, under a lock on every projected table)

## H-35 The repair never makes Archon wait and never writes to Archon
Protects: invariant 1; invariant 2 (nothing writes to Archon's tables); engineering.md; 11.4
Touches: the lap repair (`bun run reconcile:laps`), any other reconcile or backfill that writes the projected tables, projection triggers
Setup: a check branch with the seed and at least 200 laps (insert more as Archon would if needed). Snapshot Archon's tables: row counts, latest timestamps, and a checksum of every row.
Steps:
1. Start `bun run reconcile:laps`. While it runs, as Archon would, insert step events and update run statuses continuously (at least one write every 100 ms, covering each kind in H-32), timing each.
2. Run it again while a second session holds an access exclusive lock on the dashboard's laps table, and again with the database becoming unreachable partway (a wrong password on a fresh start).
3. Snapshot Archon's tables again, accounting for the step 1 writes.
Expect:
- Every Archon write in steps 1 and 2 commits within 2 seconds with no error; the repair's own locks never make Archon wait.
- Archon's tables differ from the snapshot only by the writes made in step 1: the repair changed no Archon row.
- In step 2 the repair either waits or exits non-zero with a plain message naming the cause; it never leaves the lanes showing a lap that is not running once a later clean run finishes, and that clean run puts everything right (as H-33).
- `judges/archon-writes.js` (both parts) prints PASS on the recorded run.
Author: writer, 2026-10-26, escaped defect #114 (class: the repair path must hold invariants 1 and 2 too)

## H-36 Every open window tells the truth about which moment it is showing
Protects: 4.7; journey 5; invariants 4 and 5; 11.6
Touches: rewind switching, shared header, every panel, live-query renewal, browser history, factory navigation
Setup: the check app with two factories and two valid rewind branches from different moments T1 and T2. Arrange distinguishable laps, labels, owner questions, and default-branch verdicts before T1, between T1 and T2, and after T2. Use only check-derived branches; record their identities privately. Open three tabs on different screens and set reload markers.
Steps:
1. Select T1 in one tab and T2 in another, leaving the third on live. Navigate within each tab through the factory page, owner queue, testing, health, versions and a lap that existed at its displayed moment.
2. Leave the tabs through three seal renewals, then write a new step event and owner label to the live check branch. Record the selected moment, factory, and received facts in every tab.
3. Throttle one tab's responses, start a switch to T1, then switch to T2 before the first switch completes. Change factory while that request is outstanding. Release the delayed responses.
4. Use Back and Forward, close and reopen a tab using its visible address, and switch each surviving tab back to live. Write another step event after the restored live subscriptions are ready.
Expect:
- Every visible fact and link belongs to the factory and moment the tab actually names. A late response, another tab's selection, a renewal or history navigation never puts live facts under a rewind label, past facts under a live label, or one factory's facts under another's name.
- Whether the app shares a selection between tabs or keeps it per tab, any selection change is visible in every affected tab and all affected panels follow it; no tab silently changes its data source while retaining its former context label.
- Every tab still displaying T1 or T2 excludes facts first created after that moment. The live tab receives the live writes, and restored live tabs receive the final write within 5 seconds with their reload markers intact; record these writes for `judges/liveness.js` with `require_open_seconds: 0`.
- Navigation and retries change no row on either rewind branch. No database credential or Realtime secret appears in any captured browser response.
Author: writer, 2026-10-26, escaped defect class #118 and PRD 4.7 cross-tab and cross-factory journey

## H-37 A missing past moment never masquerades as a different moment
Protects: 4.7; invariant 7; 11.3; engineering.md empty states
Touches: rewind list, branch selection, failed transitions, shared header, every screen
Setup: the check app first with no rewind branches, then with two check-derived rewind branches having different facts. Keep one rewind selected in a second tab while operating the first. Never delete or alter a branch belonging to another run.
Steps:
1. With no rewinds, open the rewind controls on every screen that offers them and navigate away and back.
2. With both rewinds present, start a switch and interrupt that switch's network request. Repeat with branch discovery unavailable, and with the selected rewind deleted through the owner's branch-management path after its tab is already open.
3. Restore connectivity, use the app's controls to select the remaining rewind and return to live, and then reopen the stale address or selection for the deleted branch.
4. From the remaining rewind, use every visible navigation control and inspect the selected factory, moment, page data and external links.
Expect:
- An empty list is an empty state, with no blank branch option, phantom destination or action that silently selects nothing. The real live context remains usable.
- A failed or stale selection never displays live data, another rewind's data, or another factory's data as though it came from the requested moment. It either preserves the previous context honestly or explains that the requested past moment is unavailable; it does not remain an unexplained spinner.
- A subsequent valid selection works. Every screen and external link is consistent with the selected factory and displayed moment, and no action writes to the rewind branch.
- Errors reveal no connection string, secret, branch credential or token. No browser action creates a rewind branch; creation remains an owner command.
Author: writer, 2026-10-26, escaped defect classes #121 and #122, PRD 4.7 state boundaries

## H-38 A lost renewal does not strand the dashboard after the connection returns
Protects: 8.1; invariant 5; invariant 7; 11.1 seal lifetime; 4.7
Touches: live-query lifecycle, renewal, navigation, all live panels and rewind context
Setup: the check app with a running lap; open home, factory and one-lap screens in separate tabs, with reload markers and network recording. Also open a rewind tab with visibly different facts. Use browser request interception or network controls without changing application code or server clocks.
Steps:
1. Keep the tabs open past three normal seal renewals and record a live step transition.
2. Make the sealing service unreachable until the current seals expire. During the interruption, navigate between two screens, open and close a step detail, and change the selected factory in one tab. Record what the pages and request log do.
3. Restore the sealing service. After subscriptions are ready, insert a new step event and then a GitHub label affecting the open panels. Do not reload or press a refresh control.
4. Repeat with a rejected renewal response instead of a disconnected request. Close a tab and navigate away from a subscribed screen while its renewal is pending; release the delayed response afterward.
Expect:
- Unavailable data is never presented as a live, ready subscription, and navigation remains usable during the interruption. A rejected or expired seal does not trap the page in a visible error/reconnect cycle after the service is healthy.
- Recovery obtains usable sealed queries automatically, without polling panel data or accepting an expired seal. Each post-recovery write appears in every relevant live panel within 5 seconds; `judges/liveness.js` passes with the recorded post-recovery writes and `require_open_seconds: 0`.
- A completed late renewal cannot resurrect a closed screen's data, undo the chosen factory or rewind, or replace a newer subscription with the expired one. The rewind tab continues to show only its past facts.
- The request record contains no secret and no browser-originated SQL; errors are safe to display. The original tabs retain their reload markers.
Author: writer, 2026-10-26, escaped defect class #120 and PRD 8.1 recovery across seal boundaries

## H-39 A lap that revisits a step keeps all of its work in its story and totals
Protects: 4.6 every step the lap ran; 4.2 measure definitions; 4.3 lanes and recent laps; invariant 4
Touches: one-lap history, live lanes, recent laps, scorecard, testing, health
Setup: the check app with a running loop lap of a known factory and digest. In Archon's source rows, give separate attempts of the same step visibly different start times, models, tokens, costs and durations. Use distinct source events for distinct attempts; retain their source identities for the evidence.
Steps:
1. Let a build attempt fail, then run a second build attempt to completion. Run check-app twice, with one failed attempt and one completed attempt, each carrying its own duration and cost. Record the lap page and lane after every transition.
2. Send the lap through a sent-back review, more work, a refused land attempt with a reason, and finally a merged land attempt; finish the run. Open its recent-lap row, one-lap page, scorecard and testing screen.
3. Reconcile or backfill the same source history through the documented command, then reload the screens. Insert a second loop lap with the same step names but different values, and a non-loop run with those names, in the same factory.
Expect:
- The one-lap page retains every actual attempt with its own recorded start, duration, model, tokens and cost; later attempts do not erase earlier work or borrow another run's details. The running lane names the current attempt and its cost so far includes the earlier attempts.
- After completion, the final lap outcome agrees across recent laps and the lap page, while its history still explains the send-back and refusal with the recorded reason. Scorecard send-backs, refusals and merges count laps as defined, without counting the repeated attempts as extra laps.
- Costs and app-check share include every applicable attempt, including failed check-app work. `judges/scorecard.js` passes on an export of the source events and observed values; the export contains attempt events, not the dashboard's already-aggregated rows.
- Testing preserves the applicable check evidence for the lap without leaking holdout text. Reconciliation adds no duplicate attempt, lap, cost or verdict; the second lap remains separate, and the non-loop run does not inflate loop scorecards.
Author: writer, 2026-10-26, escaped defect class #116, PRD 4.2 and 4.6 repeated-work journey

## H-40 Resolving and reopening an owner thread changes the whole queue
Protects: 4.4 open issues and open questions; journey 4; invariant 2; 11.6
Touches: owner queue, question ingestion, issue lifecycle, health workable count, graph, factory navigation
Setup: the check app with two factories whose repositories both have an Owner decisions needed issue and overlapping issue numbers. Each contains multiple questions with options, recommendation, default and date; each factory also has a separate needs-owner issue. Open both queues and one factory's graph and health screens.
Steps:
1. Edit one owner's question while keeping another unchanged; remove a resolved question; then close that entire Owner decisions needed issue while its former body still contains a question.
2. Close a needs-owner issue without removing its label. Reopen that issue, then remove its label. Reopen the decisions issue with only its still-open questions in the body.
3. Redeliver each event with the same delivery identity and run the documented reconcile. Switch between factories and follow each surviving queue entry's GitHub link.
4. On a rewind preceding the resolutions, inspect the same queue and its links, then return to live.
Expect:
- Only currently open questions and open labelled issues appear in the live queue. Closing a thread removes its entries even if its old body or labels remain; reopening restores only questions currently in its body and issues still bearing the label.
- Every surviving entry retains its complete options, recommendation, default and date, with a waiting age and a link to the correct repository's thread. Redelivery and reconcile create no duplicate entry or reset an unchanged question's waiting age.
- Changes in one repository leave the other factory's queue unchanged despite equal issue numbers. Health and graph reflect the changed open/labelled state using the same issues.
- The rewind shows the earlier queue, with an explicit past context, and returning live restores the resolved state. The dashboard offers no action that answers, dismisses or edits a question itself.
- Record each affected live panel after each source write; `judges/liveness.js` passes with `require_open_seconds: 0`.
Author: writer, 2026-10-26, PRD 4.4 coverage of lifecycle, repository identity and rewind interactions

## H-41 Health judges the factory and step whose history it is showing
Protects: 4.8; 11.6; invariant 4; invariant 5
Touches: health history window, failed-lap causes, pending and paused transitions, lanes, factory switching
Setup: the check app with two factories that both run a step S. Give A's latest 50 completions of S identical short durations and B's latest 50 identical much longer durations; also give A a different step with long durations. Record source identities and timing. Add pending and paused loop runs in each factory.
Steps:
1. Start S in both factories at the same time; watch both health screens before and after A's threshold, and later beyond B's threshold, recording elapsed times and flags.
2. Add newer completions of S in A that move its latest-50 window; keep a running A step visible while the new history arrives. Record the window and observed flag at each observation.
3. Move A's pending run to running and its paused run back to running, then finish one and fail the other with an infrastructure error on its failing step. Include an earlier successfully completed step with a different error-like phrase in its ordinary output.
4. Switch factories and revisit the affected laps through their health links.
Expect:
- A's threshold uses only A's last 50 completions of S, and B's uses only B's; another step, another factory and completions outside the window cannot affect it. New completions update the relevant history without a reload.
- `judges/health.js` passes for each factory and each fixed observation window separately, using source-derived history and observations on both sides of that window's threshold. Do not combine observations from different windows in one judge case.
- Pending and paused lists track the runs' current state and stop listing them when they leave it. The final failed lap is classified from its failing step's error, not an unrelated earlier output; completed runs do not remain active lanes.
- Every count and linked lap belongs to the selected factory. Record state transitions for `judges/liveness.js` with `require_open_seconds: 0`; all affected panels update within 5 seconds.
Author: writer, 2026-10-26, PRD 4.8 coverage of changing populations and per-factory history

## H-42 A displayed pin leads to that exact version's evidence
Protects: 4.2 version strip, decisions and architecture diff; 11.2 digest keying; 11.5 SHA-prefix joins; 11.6
Touches: version links, decisions, improvements, comparison, architecture detail, browser history
Setup: the check app with two pin commits with different full SHAs, distinct parsed architecture and different lap populations. Their labels use shortened SHAs. Add decisions whose Version lines name unique prefixes of the pins, and a verdict for one pin. Use a second factory with an independently recorded version to detect cross-factory resolution.
Steps:
1. Starting from each version-strip entry, follow the links into its scorecard, decisions, improvements and architecture detail, then into a comparison and architecture diff with the other version. Record the full source pin, digest and factory behind each destination.
2. Open each app-generated link directly in a new tab and use Back and Forward through the journey. Repeat after a late-arriving pin legitimately changes a version's label while its digest and laps stay the same.
3. Deliver a decision with a SHA prefix shared by two available pin commits and then a corrected unambiguous Version line. Also open an app address with a version identity that is absent from that factory.
Expect:
- Each app-generated link resolves to the exact version, factory and pinned code that its label represents, even when display labels shorten a SHA or a version's label changes. A full SHA, digest and display prefix are not silently interchanged as different identities.
- The comparison's lap populations and architecture diff remain the selected pair throughout navigation and relabelling. No destination shows another version's data or reports a real, linked version missing merely because the display shortened its label.
- A decision with a unique prefix links to the matching pin. An ambiguous prefix does not silently link to one arbitrary pin; after correction, the decision links to its unambiguous version without a reload.
- An identity that is absent from the selected factory yields an honest missing state rather than another factory's version or an outage. No holdout scenario text appears while navigating architecture evidence.
Author: writer, 2026-10-26, escaped defect class #115 and PRD 4.2/11.5 evidence-identity journey

## H-43 Long and changing facts remain readable in every important state
Protects: 8.3 design contract; engineering.md design and empty states; journeys 2, 4 and 5
Touches: owner queue, one lap, health, testing, factory and rewind controls, shared layout
Setup: the check app with realistic but lengthy owner options and recommendations, a long repository name, a long failed-step reason, many attempts on a lap, and a long evidence link. These facts arrive through the documented source surfaces. Start at both 1440 and 390 px widths; use the existing design probe without exceptions or threshold changes.
Steps:
1. Open the owner queue with all question details, the lap with repeated attempts, failed-lap health details, testing evidence, and each factory or rewind menu. Run the design probe and capture screenshots in every open state.
2. Deliver an edit that lengthens the currently visible question and an error that lengthens the current lap's history while the panel remains open. Repeat the probe and screenshots without reloading.
3. Move through no-data, one-factory, unknown-factory, failed-live-connection and unavailable-rewind states using the app's controls or a stale bookmark. In each, inspect and use every visible control, including the control that leaves the state.
Expect:
- The design probe reports zero failures for every recorded state at both widths: token colors and fonts, text contrast at least 4.5:1, no horizontal overflow, and an accessible name on every control. No browser-default control or light-mode island appears during a transition or open menu.
- Questions, error reasons and evidence remain readable and reachable; a panel or menu does not cover the only way to continue the journey. Empty states remain one sentence with at most one button and do not offer an empty factory or branch destination.
- Newly arrived content satisfies the same design contract as first-load content. Screenshots are compared against the committed console references, with the judgement recorded; a subjective disagreement goes to the owner rather than changing the probe.
Author: writer, 2026-10-26, PRD 8.3 coverage of live content, narrow screens and recovery states

## H-44 An unrecognized address does not inherit a factory it never selected
Protects: 11.6 every view keyed by factory; invariant 4; engineering.md empty states
Touches: shared header, unmatched routes, browser history, factory identity, recovery navigation
Setup: the check app with two factories having distinguishable names, repositories and running-lap counts. Derive valid addresses from the app's links, and prepare unknown addresses outside any factory route as well as addresses with a valid factory segment but an unknown remaining path.
Steps:
1. From A's lap and B's owner queue, navigate to each unknown address. Repeat in fresh tabs and after switching factory. Record the page, shared header, links and numbers.
2. On each unknown page, use its offered recovery link if any, then Back and Forward. Open a removed factory's formerly valid address after serve has restarted with that factory absent.
Expect:
- An address outside every factory route presents an honest missing-page state and carries no selected factory's name, repository, console link or running-lap count left over from a prior screen or chosen by default.
- An unknown path that explicitly names a real factory may keep that factory's context, but never shows another factory's facts or claims that unrelated content belongs to the requested path.
- A removed factory's address shows it missing without inheriting another factory. Recovery reaches a real screen with matching identity; Back and Forward restore the same truthful missing states.
- The missing state is one sentence with at most one button, with no indefinite spinner and no false live-service outage message.
Author: writer, 2026-10-26, escaped defect class #119, unknown-address identity across the full navigation journey

## H-45 Switching context meets the same timing bar as opening it
Protects: 8.4; engineering.md approved subscription and readiness timing; 4.7 same queries; 11.6
Touches: every live query, route navigation, rewind and factory switching, architecture comparison
Setup: the check app on the seed, with a second factory and a check-derived rewind. Use unthrottled browser sessions at 1440 and 390 px. Observe subscription sends, delivered first snapshots and actual Realtime ready states; never count cached rows as a delivered subscription.
Steps:
1. Measure the home screen from a cold opening. Navigate through every reachable live screen, including a version comparison, architecture diff, factory page, owner queue, testing, health and one lap; measure each new panel subscription and readiness.
2. On the home screen and every screen that offers the controls, switch live to rewind and back, and switch factories and back. Measure each resulting panel and subscription afresh; keep the initial-load and post-switch records separate.
3. Repeat after the app has remained open through three seal renewals. Collect records for the existing `judges/speed.js`: ready_ms is time since navigation or the explicit context-switch action, first_snapshot_ms is time since that panel's subscribe was sent. Run the judge separately for each screen/transition class, with both widths represented.
Expect:
- Every panel becomes genuinely ready within 2000 ms and every newly subscribed live query delivers its first snapshot within 500 ms. The same limits apply after a rewind/factory switch, route navigation and return to a previously visited screen; no transition is exempt because initial load passed.
- Every recorded speed-judge invocation prints PASS. A missing observation or missing transition remains incomplete evidence, not a passing timing; a slow observation is a failure even if other observations or a mean are fast.
- The delivered rows match the selected factory, moment and version, and readiness never comes from cached or fabricated initial rows. Timing evidence distinguishes the subscription clock from the connection/readiness clock without loosening either bar.
Author: writer, 2026-10-26, escaped defect class #129 and PRD 8.4 performance across the full navigation journey

## H-46 Comparing versions only asks for choices the factory actually offers
Protects: 4.2 side-by-side comparison; 11.6 factory-specific views; engineering.md empty states; 8.3
Touches: version strip, comparison controls and guidance, live version availability, factory navigation
Setup: the check app with the owner's shared-pin behavior: factory A has laps, but its displayed pins are unused there and cannot be selected for comparison; factory B has selectable versions. Include unused pins among the selectable entries. Record actual selectable version identities separately from the factory's total lap count.
Steps:
1. Open A's versions screen directly, then arrive there from B's comparison using the app's factory controls. Read the guidance, try every visible comparison control, and inspect which entries a keyboard user can choose.
2. Through the normal source surfaces, make a first version selectable in A and then a second. Keep the screen open through both updates; choose the first when possible, then complete the comparison when the second becomes available. Record the guidance and selected identities after each change.
3. From that comparison, move to a factory with fewer selectable versions and return. Use Back and Forward, reopen the comparison address directly, and attempt to choose an unused pin alongside a selectable version.
Expect:
- Guidance describes a reachable next step in the current factory. When no comparison can be formed, the screen explains the missing comparison data rather than instructing the user to make an impossible selection; the presence of unrelated laps or visible unused pins cannot make that guidance claim a comparison is available.
- As usable versions arrive, guidance and controls agree with what can actually be selected. Once a valid pair is available, the user can reach its comparison without reloading; the comparison names that pair and uses only its factory's laps.
- An unused pin is never silently substituted for a selectable version or treated as a lap-bearing version. Switching factories or following stale history never leaves an actionable comparison assembled from a previous factory's choices.
- If a saved comparison is unavailable in its current context, the page explains that state and offers a usable way onward instead of a misleading selection prompt, a fabricated comparison, or a loading loop. Empty states follow the existing one-sentence, at-most-one-button rule; no new visual style or comparison policy is prescribed.
Author: writer, 2026-10-26, escaped defect class #134, PRD 4.2 comparison journey with unused pins and changing availability

## Shared setup for H-47..H-55: real pins and their commits in every form

"Real pins" means pin commits delivered as push events on ai-software-factory exactly as the appendix writes them: subject `Pin Archon <sha>: <reason>` (the reason may itself contain a colon or a semicolon), a blank line, `Hypothesis:` and `Measure:` trailers, and after them a `Co-Authored-By:` trailer, the way commits on that repository end. The pin commit's own id in the push event is its full 40-character sha. "An architecture for commit C" means `bun run arch:parse <archon-sha> <factory-sha>` run for C, with whichever sha form the scenario says it is given. Unless a scenario says otherwise the Archon commits are commits of a local git repository holding a copy of `fixtures/pack/` (pack and template), each changing something visible: C1 as copied; C2 with one sentence of `check-app`'s command file changed and a step with a `when` condition added to `archon-loop`; C3 with one inline subagent removed from another step. If the job cannot read a commit of a local repository, use real `coleam00/Archon` commits whose packs differ; if neither works, the scenario is INCONCLUSIVE, not PASS. A version exists when laps of its digest are inserted, as Archon would, after its pin and before the next one. "Every surface" means: the home map as it first opens (no version picked), the map at that version picked from the version strip, the detail of `check-app` and of one ship stage opened by clicking, the same step detail addresses opened directly in a fresh tab and reloaded, and the architecture diff against each other version. Record each screen's text and every panel's `data-state`.

## H-47 Pins written the factory's way show their architecture on every screen, whichever form each side used
Protects: 4.1 (the home map is the pinned version; every step detail comes from the pinned code); 4.2 architecture diff; invariant 6; 11.2 Architecture row; 11.4 architecture job; 11.5 pin format; appendix pin commit
Touches: push ingestion and the pin parser, the architecture job, the join from a version to its architecture, home map, step detail, architecture diff, version strip
Setup: the check app on the seed, plus three versions from real pins: V1 pinned on C1 by its first 8 characters, its architecture parsed with C1's full 40-character sha; V2 pinned on C2 by its full 40 characters, its architecture parsed with C2's first 8 characters; V3 pinned on C3 by its first 12 characters, its architecture parsed with C3's full sha. V3 is the latest version.
Steps:
1. Open every surface for V1, V2 and V3, and for every seed version.
2. Open the architecture diff for V1 against V2, V2 against V3, and V1 against V3, in both orders where the screen lets you choose the order.
Expect:
- The home map as it first opens shows V3's architecture: C3's steps, without the removed subagent.
- At each version, the map and every step detail show that commit's pack and template, byte for byte as the files are at that commit: V2's `check-app` prompt carries the changed sentence and V1's does not; the step added in C2 is on V2's and V3's maps and not on V1's.
- A step detail opened directly and reloaded shows the same text as the one reached by clicking.
- The diffs list exactly what changed between the commits (the changed prompt and the added step between V1 and V2, the removed subagent between V2 and V3, all three between V1 and V3), never "no changes", and never every workflow added or removed.
- No surface for any of these versions, and none for a seed version, says there is no architecture, nothing available, not recorded, or not found, and every panel reaches `data-state="ready"`.
Author: writer, 2026-10-26, escaped defect #157 (one writer recorded the Archon commit as a short sha and another as the full sha, so the map, step details and diff said nothing was available)

## H-48 A prefix shared by two commits never shows either one's architecture as if it were the pinned one
Protects: 4.1 and invariant 6 (the map is the code at that version, never typed in or guessed); 4.2 architecture diff; 11.2 Architecture row
Touches: the join from a version to its architecture, home map, step detail, architecture diff
Setup: the check app. In the local pack repository, make commits (scripted, for example with `git commit-tree`, changing a file each time) until two commits CA and CB share their first 5 or more characters and differ before the 8th; give CA and CB visibly different packs (CB has one extra step). Parse an architecture for each, with its full sha. Deliver real pins: VA pinned on CA by its first 8 characters; VB pinned on CB by its first 8 characters; VX pinned by only the prefix CA and CB share. Make VX the latest version.
Steps:
1. Open every surface for VA, VB and VX.
2. Take a step detail address of CB's extra step from VB and change only the version part to VX's; open it.
3. Open the diff of VA against VB, of VX against VA, and of VX against VB.
Expect:
- VA shows exactly CA's architecture and VB exactly CB's, on every surface: VA never shows CB's extra step, VB always does. Swapping which of the two was parsed first, or parsed last, does not change this.
- VX shows neither commit's architecture on any surface, including the home map as it first opens: it says, in one sentence with at most one button, that this version's architecture cannot be told apart or is not recorded. It never shows CA's or CB's steps, prompts or subagents, and never chooses one of them silently by age, order or anything else.
- The diff of VA against VB lists the extra step and nothing else. A diff involving VX never lists changes and never says "no changes": it says VX's architecture is not available.
- The step 2 address does not show CB's step.
Author: writer, 2026-10-26, escaped defect #157 (class: a short form of a commit must resolve to exactly one architecture or to none)

## H-49 A pin naming a commit the job never parsed says so, and never borrows a neighbour's architecture
Protects: 4.1 and invariant 6; 4.2 architecture diff; 11.2 Architecture row; engineering.md (an empty state is one sentence and at most one button)
Touches: the join from a version to its architecture, home map, step detail, architecture diff, empty states
Setup: the check app with V1 and V2 as in H-47 (architectures parsed). Deliver real pins for three more versions, each newer than the last: VU8 naming by 8 characters an Archon commit that exists but was never parsed; VU40 naming one by its full 40 characters, also never parsed; VN naming 8 characters that are no commit at all. Make VN the latest version.
Steps:
1. Open every surface for VU8, VU40 and VN, including the home map as it first opens.
2. Take step detail addresses from V2 and change only the version part to each of these versions; open them.
3. Open the diff of each against V1 and against V2.
Expect:
- Each of the three versions says, in one sentence with at most one button, that its architecture is not recorded (or words to that effect), on the map, on every step detail and in every diff. It is never an outage message and never a spinner left running: every panel has settled within 2 seconds.
- None of them ever shows V1's, V2's, the seed's or any other version's steps, prompts or subagents: not the latest parsed architecture, not the nearest older one, not the one parsed last.
- No diff involving them says "no changes" or lists anything as added, removed or changed.
- V1 and V2 still show their own architectures on every surface.
Author: writer, 2026-10-26, escaped defect #157 (class: a missing architecture must look missing, not like another version's)

## H-50 The architecture appears live, whichever of the pin and the job came first
Protects: invariant 5 (every panel live, no refresh button); 4.1; 4.2 architecture diff; 11.2 (pins by push webhook, nightly reconcile and backfill)
Touches: push ingestion, the architecture job, home map, step detail, architecture diff, live queries
Setup: the check app with V1 as in H-47. Open the home map, a `check-app` step detail and the architecture diff, and set the reload marker in each.
Steps:
1. Deliver a real pin for V4 naming C2 by its first 8 characters, and insert V4's laps. Record what the open screens show.
2. Run the architecture job for C2 given its full sha. Record when each open screen changes.
3. Parse an architecture for C3 given its first 8 characters, first; then deliver a real pin for V5 naming C3 by its full 40 characters and insert V5's laps. Record when each open screen changes.
4. Deliver V4's push event again (a webhook redelivery), run the nightly reconcile or backfill once, and restart serve.
Expect:
- After step 1, V4 reads as architecture not recorded on every surface (as H-49), never V1's.
- Within 5 seconds of step 2, without a reload, the home map, the open step detail and the diff show C2's architecture for V4; after step 3 they do the same for V5 with C3's.
- After step 4 nothing changes: no version loses its architecture, none gains a second entry, and every surface still shows the same text after the restart.
- `judges/liveness.js` PASS on the step 2 and step 3 timings.
Author: writer, 2026-10-26, escaped defect #157 (class: the join must hold whichever writer wrote first and after every re-delivery)

## H-51 Two pins on one commit, named two ways, are the same commit
Protects: 4.2 architecture diff and version strip; 11.2 (versions keyed by digest, labelled by the most recent pin; Architecture row); 11.4
Touches: the join from a version to its architecture, architecture diff, version strip
Setup: the check app. Deliver a real pin for VP naming C2 by its first 8 characters; then, after VP's laps, a second real pin VQ naming the same C2 by its full 40 characters, whose only change on ai-software-factory is one sentence of the template's holdout-verifier instruction file (so VQ's laps have their own digest). Parse each version's architecture with C2's sha given in the opposite form from its pin, and the factory commit given as its pin commit's full sha.
Steps:
1. Open every surface for VP and VQ.
2. Open the diff of VP against VQ.
Expect:
- Both versions show C2's architecture; `check-app`'s detail shows the holdout-verifier instruction file as it is at each version's factory commit.
- The diff lists exactly the changed instruction file and nothing else: not "no changes", not "architecture not available" on either side, and not every Archon workflow as added on one side and removed on the other.
- The version strip shows VP and VQ as two entries, each with its own reason, Hypothesis and Measure.
Author: writer, 2026-10-26, escaped defect #157 (class: the same commit written in two forms must join as one commit)

## H-52 The factory template is found whatever form its commit was given in
Protects: 4.1 (the holdout steps' detail explains the fence from the template); 11.2 Architecture row (the factory template at the pinned factory commit); 11.4 (`arch:parse <archon-sha> <factory-sha>`)
Touches: the architecture job's factory side, push ingestion, step detail for the holdout steps, architecture diff
Setup: the check app with two real pins VF1 and VF2 on two different factory commits whose templates differ in the fence explanation's instruction file. Parse VF1's architecture with its factory commit given as the first 8 characters of the pin commit's sha (the push event carries the full sha), and VF2's with the full 40 characters while its Archon commit is given as 8 characters.
Steps:
1. Open the `check-app` detail and the detail of every other step whose detail explains the fence, at VF1 and at VF2, by clicking and by direct address.
2. Open the diff of VF1 against VF2.
Expect:
- At each version the detail shows the hook file `.factory/hooks/holdout_fence.py`, which agents may read the scenarios and how a verdict comes back, with the instruction file text exactly as it is at that version's factory commit; never the other version's text, and never an empty or "not recorded" template section.
- The diff names the changed instruction file.
Author: writer, 2026-10-26, escaped defect #157 (class: every commit the job records, Archon's or the factory's, joins in any form)

## H-53 Verdicts and decisions find their pin by any unambiguous form, and never the wrong one
Protects: 11.5 (a verdict names its pin by sha; `Version:` joins to a pin by sha prefix); 4.2 improvements being tested, key decisions, version strip; appendix verdict commit
Touches: push ingestion, verdict and `DECISIONS.md` parsers, the join to pins, improvements panel, decisions timeline, version strip
Setup: the check app. Deliver real pins with `Measure` trailers: PS naming its Archon commit by 8 characters; PF naming its commit by the full 40; PA and PB naming two commits that share their first 5 characters (as in H-48) by 8 characters each. Insert laps for a version of each.
Steps:
1. Deliver verdict commits written as the appendix writes them: one for PS naming its commit by the full 40 characters; one for PF naming its commit by its first 8; one naming only the 5-character prefix PA and PB share; one naming 8 characters no pin names.
2. Deliver a `DECISIONS.md` change adding entries in the fixed shape whose `Version:` lines are: PS's commit in full; PF's commit by its first 7; PF's commit by its first 12; the prefix PA and PB share; 8 characters no pin names.
3. Restart serve, then deliver the same push events again.
Expect:
- PS and PF show their verdicts (helped, hurt or inconclusive) and sentences, and leave the being-tested list, without a reload.
- The full, 7-character and 12-character decisions appear on the timeline linked to PS's or PF's version as named.
- The verdict and the decision naming the shared prefix attach to neither PA nor PB; PA and PB remain listed as being tested. The unknown verdict and decision attach to no version. None of them is shown under another version, and none of them changes any version's label.
- After step 3 nothing is duplicated or relinked.
Author: writer, 2026-10-26, escaped defect #157 (class: every join between a short and a full sha, on every surface that joins one)

## H-54 A version shows its architecture in every context: two factories and a rewind
Protects: 11.6 (every view keyed by factory); 4.7 rewind (every screen as of the moment); 4.1; invariant 6
Touches: home map per factory, step detail, architecture diff, rewind branches
Setup: the check app with two factories A and B (as in H-17). For A, versions V1 and V2 as in H-47. For B, a version VB2 whose laps have their own digest but whose real pin names C2 by its first 8 characters, while C2's architecture was parsed once, with its full sha.
Steps:
1. Open every surface for A's V1 and V2 and for B's VB2, moving between the factories with the app's own controls.
2. Note a moment T. Then deliver a real pin V3 for A naming C3 by 8 characters, insert its laps, and parse C3 with its full sha. Create a rewind at T and open every surface on it; then go back to live.
Expect:
- B's VB2 shows C2's architecture on every surface; A's V2 shows the same; neither factory's map shows the other's live counts.
- On the rewind, A's versions as of T (V1 and V2) show their architectures on every surface, and V3 is absent; no rewind screen says no architecture is recorded for a version that had one at T.
- Back on live, V3 shows C3's architecture.
Author: writer, 2026-10-26, escaped defect #157 (class: the join holds in every keyed view)

## H-55 A step-by-step story of a repin: what a user sees at each moment is true
Protects: 4.1 (the home base is the map at the pinned version); 4.2 version strip and architecture diff; 11.2 (labelled by the most recent pin before the first run); invariant 5
Touches: push ingestion, version labelling, the architecture job, home map, step detail, architecture diff
Setup: the check app with V1 as in H-47 shown on the home map; reload marker set.
Steps:
1. Deliver a real pin naming C2 by its first 8 characters. Before any lap of a new digest runs, record the home map and `check-app` detail.
2. Insert the first lap of a new digest D2, and record them again.
3. Run the architecture job for C2 given its full sha, and record them again; open the diff of V1 against the new version.
4. Deliver, late, a real pin whose commit time is before D2's first run and after step 1's pin, naming C3 by its full 40 characters, with C3 not yet parsed. Record every surface.
5. Parse C3 with its first 8 characters. Record every surface.
Expect:
- After steps 1 and 2 nothing claims C2's architecture for V1, and V1's map still shows C1's. Whatever the home map shows for the new version, it is never V1's architecture labelled as the new version.
- After step 3, without a reload, the new version shows C2's architecture and the diff lists exactly C1 to C2's changes.
- After step 4 the version is relabelled by the late pin (as H-23) and its map, step details and diff follow it: they say C3's architecture is not recorded; they never keep showing C2's under the C3 label.
- After step 5, within 5 seconds and without a reload, they show C3's architecture.
Author: writer, 2026-10-26, escaped defect #157 (class: label and architecture are one fact seen twice, so they must always agree)

## H-56 Magenta marks only who we are: nothing you can click, select or focus is ever drawn in it
Protects: 8.3 design contract (magenta only for identity) and engineering.md Design rule ("magenta is identity only"), as decided by the owner on #27 question 4 (2026-10-27): links, selection, focus and highlighted versions on the Versions screen, and anywhere else, use neutral tokens; magenta only on identity
Touches: every screen and the shared layout, version strip and comparison, home map (nodes, edges, highlighted steps), factory switcher, rewind controls, links, focus, hover and pressed styles, text selection, live-arriving rows
Setup: the check app on the seed, with two factories (as in H-17) and at least three versions on the strip. Identity means the product's brand mark and wordmark only; anything else the verifier records as identity needs a line of the product document that makes it so, quoted in the record.
Steps:
1. On every screen `judges/identity-color.js` names (`REQUIRED_SCREENS`), at 1440 and 390 px, record the computed styles of every link, button, tab, menu item, map node and edge, version entry, and the brand mark: at rest, hovered, keyboard-focused (reached with Tab, not a click, so `:focus-visible` applies), pressed, and, for anything that can be chosen, selected, selected and hovered, and selected and focused. Open every menu and popover first so their items are recorded open.
2. On the Versions screen, select one version, then pick two for a comparison; then, without a reload, deliver a pin and a lap of a new digest so a new entry arrives while one is selected, and record the arriving entry and the still-selected one. Select the new one by keyboard only and record it.
3. Select a run of text in a panel and in a step's prompt text, and record the `::selection` colors.
4. Hover and focus the brand mark (if it is a link) and record those states.
5. Repeat steps 1 to 4 with the operating system set to light mode.
Expect:
- `bun .factory/holdout/judges/identity-color.js <record.json>` prints PASS: no element other than the brand mark and wordmark shows a color in the identity band in any state, including a translucent magenta focus ring or selection wash; the brand mark's own hover and focus cues are not magenta either.
- The app stays dark in light mode and the same holds there; no state, open menu or newly arrived entry is an exception.
Author: writer, 2026-10-27, owner decision on #27 question 4 (tracking #229): the class, a non-identity element drawn in the identity color

## H-57 With magenta gone, you can still tell what is selected, hovered and focused, on every screen
Protects: 8.3 design contract (identity-only magenta, token colors, every control usable) and engineering.md Design rule, as decided by the owner on #27 question 4 (neutral tokens for selection, focus, links and highlighted versions); 4.2 version strip and comparison
Touches: version strip and comparison picker, factory switcher, rewind picker, home map step selection, tabs and filters, every link and focus style
Setup: the record from H-56, or a fresh one taken the same way.
Steps:
1. On the Versions screen, with no mouse, Tab to a version entry and select it, Tab on to the next, then hover a third with the mouse: record the selected, focused-unselected, hovered-unselected and selected-and-hovered entries and take a screenshot. Repeat with the two versions picked for a comparison, and with the version currently pinned.
2. Do the same for the selected factory in the switcher, the selected step on the home map, the chosen rewind moment, and the open tab or filter on any screen that has one.
3. Turn the step 1 screenshot to grayscale and say which entry is selected, which is focused and which is hovered.
Expect:
- `judges/identity-color.js` prints PASS on the record: every color that changes for hover, focus, press or selection is a neutral token (no hue: not magenta, and not a status color borrowed for selection); a link's own color is neutral; a selected entry differs visibly from an unselected one at rest and while hovered, and from a merely hovered one, by a neutral cue (surface, border, weight, underline or a marker); every keyboard focus shows a ring with at least 3:1 contrast against what it sits on.
- In grayscale the selected version, the comparison pair and the focused entry can each be named without guessing; a selected entry never looks like a hovered one.
- The design probe still reports zero failures on every screen at both widths.
Author: writer, 2026-10-27, owner decision on #27 question 4 (tracking #229): edges of the identity-color class (selected against unselected, hover and focus, light-mode OS)

## H-58 Cleaning up old check branches never deletes one a running lap still uses
Protects: 11.3 runtime contract (`fixture:drop` deletes its own branch and any `check-*` branch older than 3 hours, and refuses anything not `check-*`), as amended by the owner decision on #27 question 6 (2026-10-27): the age cleanup skips any `check-*` branch owned by a run that is still running, and orphans of ended runs are still deleted after 3 hours; invariant 8
Touches: fixture:branch (how it records a branch's owning run), fixture:drop (`--dry-run --at <time>`), Neon branches
Setup: Neon credentials for the project, and two checkouts K1 and K2. Using `bun run fixture:branch` the way a lap uses it (so it records the owner the way the product records it; name an owner only by what its documentation or `--help` offers), create: K1's own branch, owned by a run that is running now (the verifier's own run); K2's own branch, owned by another running run; a branch owned by a running run with no checkout of its own; and a branch owned by a run that has ended in Archon (for example a completed `archon-loop` run, read from Archon's runs, never written). Make one more `check-<id>` branch from `fixture` with Neon's own tools, so no owner is recorded. Add the decoys of H-13. Note every branch in the project with its creation time and its owner's state. If `fixture:branch` records no owner at all, this scenario is FAIL: running and ended owners cannot be told apart.
Steps:
1. From K1, `bun run fixture:drop -- --dry-run --at <T>` for T = the newest of these branches' creation plus 3 hours 1 minute, T = the oldest's creation plus 2 hours 59 minutes, and T = 100 hours from now.
2. The same three from K2.
3. From K1, a real `bun run fixture:drop`, then list the project's branches; then, from K2, a dry run at 100 hours from now again.
4. Let the run that owns the branch with no checkout end (or create a fresh branch owned by a run that then ends), and repeat a dry run at that branch's creation plus 3 hours 1 minute.
Record every drop in the shape `judges/drop-cleanup.js` documents.
Expect:
- `bun .factory/holdout/judges/drop-cleanup.js <record.json>` prints PASS: each drop names exactly its own checkout's branch plus every other `check-*` branch more than 3 hours old at T whose owner has ended or is not recorded; it never names a branch whose owning run is still running (another checkout's branch included), at any T; just under 3 hours it names nothing but its own branch; it never names anything that is not `check-*`, nor `main`.
- A dry run deletes nothing. The real run deletes only K1's own branch (and any genuinely old orphan); K2's branch and the other running-owned branch are still there, and K2's serve still works on its branch.
- After step 4 the newly ended run's branch is named: an ended owner does not protect its orphan.
Author: writer, 2026-10-27, owner decision on #27 question 6 (tracking #230): edges owner running, owner ended, no owner recorded, this checkout's own branch
