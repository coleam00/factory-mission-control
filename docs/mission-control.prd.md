---
title: "Factory Mission Control - PRD v1"
type: prd
status: APPROVED for the first factory run (2026-10-24; Cole delegated sign-off; decisions in plans/factory-mission-control-2026-10-24.md section 9; reviewed by a subagent against them the same evening). AMENDED 2026-11-03 for v2 (4.1 rewritten, 4.9 added, invariant 6, journey 1 and 8.3 changed; design in docs/design/v2/) AMENDED 2026-11-08 for v3 (4.10 added, invariant 2, section 5 and 8.3 changed; design in docs/design/v3/).
created: 2026-10-24
owner: Cole
product: Factory Mission Control, the live dashboard of the AI Software Factory
repository: coleam00/factory-mission-control (public)
tags: [prd, ai-software-factory, archon, neon, realtime, dashboard]
---

# Factory Mission Control - PRD v1

**What this is.** The product contract for a live dashboard of the AI Software Factory, built by
the factory itself. It shows the factory's architecture as one living map, how the factory has
evolved and why, and, for each application a factory is building, the product document, the
issues it was sliced into, every lap working through them, how each change was tested, and what
is waiting on the owner. Every panel is a live query: when an agent writes a row, the screen
changes, with no refresh.

**One deliberate judgement call, stated up front.** A PRD normally stays out of the stack. This one
does not (section 11), because the dashboard is a view onto systems that already exist (Archon's
run records, GitHub, the factory's pinned code, Neon Postgres with Realtime) and because it must
look like part of Archon. Leaving those open would let the factory reinvent them. Everything else
about how is the factory's.

---

## 1. The problem

The factory takes a product document in and ships merged pull requests out, several laps at a
time, while nobody watches. Its state is split across three places: Archon's run history, GitHub
(issues, labels, claim and review comments, pull requests) and the factory's own repository (the
pinned workflows, the decisions). To answer "what is it doing right now?", "where is it stuck?",
"is the change I made yesterday helping?" the owner flips between a terminal, a dozen GitHub tabs,
the Archon console and hand-written audit scripts. In October alone he rebuilt the same metrics by
hand at least six times (merges per hour, lap-hours per merge, app-check share of lap time, empty
laps, send-backs, cost per merge) to judge one change to the factory against the last.

The factory's architecture also changes every few days (a new step, a new gate, a new route), and
nothing shows what it is today, what each step does, or what each version cost and delivered.

## 2. Who it is for

1. **The factory owner** (Cole): runs several factories at once, changes the factory itself often,
   needs to see at a glance where each factory is, what is waiting on him, and whether a change to
   the factory helped.
2. **People learning the factory** (workshop and bootcamp members, video viewers): need to see the
   whole process, inputs to outputs, and click into any step to understand it.

## 3. The hypothesis, stated so it can be wrong

If every fact about the factory lands in one Postgres database and every panel is a live query,
the owner stops building audit scripts by hand: every factory change ships with a hypothesis and
gets judged from the dashboard within a day of laps, and an owner question waiting on him is seen
within minutes, not hours. It is wrong if, two weeks in, he is still writing throwaway metric
scripts, or still discovering stuck laps from a watchdog line.

## 4. In scope

### 4.1 The factory map: the home base (v2, owner decision 2026-11-03)

The default screen. One horizontal map of the whole factory that a newcomer understands in a
minute, drawn exactly as `docs/design/v2/` shows it (the mockup and its `refs/` screenshots are the
design; copy its cards, wording, lines and motion). It replaces v1's map, which drew every step of
`archon-loop` as a tall graph and showed plumbing (claim, subject, briefs, handoff, release) as
peers of the real stages.

**Why it is hand-authored.** The map's layout, grouping and wording are authored in one data file,
`app/map/factory-map.json`, not derived from the workflows, so the owner controls what the map
says and fixes anything that reads badly. What it may not do is drift from the code: every card
names the workflows and steps it covers, and a check (`bun run map:check`, part of `bun run check`)
fails when a step of a covered workflow at the current pin is covered by no card, or a card names
a step that does not exist. Step details still come from the pinned code (the existing step
screens, `/f/<factory>/steps/<workflow>/<step>`).

**What the map shows** (left to right; see `refs/01-home-map.png`):

- **Three ways in**, on the left: **Product document**, **New issue** (a work item the owner files)
  and **Found by the factory** (problems spotted in review, app check or staging). All three feed
  **Intake** on one line.
- **Split** directly above Intake, two arrows between them: Intake sends a product document or a
  bundle of tasks up, and Split files its pieces, which come back down through Intake like any other
  work.
- **One line:** Intake -> **Work order** -> Build -> Review -> App check -> Merge -> Staging ->
  Shipped, inside a dashed box labelled "the manager watches everything on this line".
- **The manager**, centred above the line: one card, the orchestrator the owner talks to. It keeps
  the factory healthy and work moving and brings the owner the decisions it can't make. One
  arrow comes down from it into the box.
- **One loop back:** Review, App check and Staging each drop to a dashed line along the bottom that
  runs back into Found by the factory, labelled "problems found become new work". It is the only
  line that runs right to left.

**The words (Cole and Rasmus, 2026-11-04).** **Work** is any single item the factory takes, one issue
and one `work/<n>` state document. A **work order** is a group of work that goes through the factory
together: pieces of a product document, pieces of another, a few bug fixes. It can also be one item.
Where it lands is the owner's choice: main, dev, a release branch or a staging environment. A product
document is one source of work, never the unit of work. Copy says "work item" and "work order", never
"ticket"; "lap" stays only on the old-loop screens #321 retires.

**Holdouts are gone (2026-11-04).** They doubled the time per pull request and found what the review
lenses and CI already found. The validation is Review's lenses and the App check, which tests the
running app against the work item's acceptance. No card, line, screen or number shows holdouts.

**What each card covers** on the queue pack (`fixtures/pack/queue`); a factory on the old loop keeps
its own entries in the same file:

| Card | Covers |
|---|---|
| Split | `archon-split`, `factory-backlog` (every step) |
| Intake | `archon-intake` (every step) |
| Work order | nothing yet: the primitive is being built. Live counts come from labels (below) |
| Build | `archon-build-queue` every step except the review below |
| Review | under `archon-build-queue`: `ship/deliver/rounds/review`, with every step under them |
| App check | `factory-app-check` (every step) |
| Merge | `archon-merge-queue` (every step) |
| Staging | `factory-deploy` (every step) |
| Manager | `factory-manager` (every step) |
| Found by the factory | `archon-discoveries` (every step) |

Product document, New issue and Shipped cover no steps.

**Work orders on the dashboard, until Archon has them.** An issue labelled `work-order:<name>`, open or
closed, belongs to that work order (a finished order drops off the Board after 7 days), and a label `lands-on:<target>` on any of its issues says where it lands.
The dashboard reads those labels and writes nothing. When the primitive lands in the pack, this
paragraph and that query change, nothing else.

**Live:** a card shows the laps of the selected factory on any step it covers right now (a lap
counts once, on its deepest running step's card) as "<n> here"; Build also shows work waiting to
start as "<n> queued"; Work order shows open work orders as "<n> open"; App check shows open pull requests whose latest app check failed as
"<n> failing" in red; the Manager shows what waits on a person as "<n> waiting" in violet (open Archon attention items, plus open owner questions and `needs-owner` issues on a factory still on the old loop); Shipped
shows merges today as "<n> merged". A card with laps on it carries `data-live-count` greater than 0
and pulses its chip. Every number updates live (invariant 5).

**Clicking a card** dims everything but the card and its direct neighbours and opens a details
strip under the map with tabs: When it runs, What it does, How it works, Right now (the issues and
laps on it), and Behind the scenes (the workflows and steps it covers, each linking to its step
screen, its models, and its source paths). App check's Behind the scenes links its `check` step
screen. A card shows ⤢ only once its deeper view exists (until then no ⤢, no Open button and no legend entry for it, whatever `refs/` shows); it opens it
by double-click, Enter or the Open button; the deeper views are built by their own issues, each
drawn as `docs/design/v2/refs/1x-*.png` shows.

**Motion:** one dot travels Product document, Intake, Work order and on down the line to Shipped every few seconds and each card it reaches
pulses once; dashes flow along the forward lines. Both stop under `prefers-reduced-motion` and when
the flow toggle is off.

### 4.2 How the factory evolves

- **A version strip:** one entry per factory version, with its date, its pin commit's one-line
  reason, and its `Hypothesis` and `Measure` (section 11.5). A pin with no reason or trailers shows
  "not recorded".
- **A scorecard per version, per factory**, using exactly these definitions (one factory, laps whose
  run ran that version):

| Measure | Definition |
|---|---|
| lap | an `archon-loop` run, or an `archon-build-queue` run on a work item: one whose `facts` step names an item (owner ruling 2026-11-04, #378). A build-queue run that finds nothing to build is not a lap |
| merge | a lap whose `land` step output has `outcome = merged`; on the queues, a build-queue lap credited with a pull request the merge queue merged (below) |
| empty lap | a lap whose `pick` output has `route = none` |
| failed lap | a lap whose run `status = failed` |
| send-back | a lap whose `review` output has `outcome = sent-back` |
| gate refusal | a lap whose `land` output has `outcome = refused`; its reason is the `reason` text |
| lap duration | run `completed_at` minus `started_at` |
| active hour | a UTC clock hour in which at least one lap was running |
| merges per active hour | merges / active hours |
| lap-hours per merge | sum of lap durations in hours / merges |
| app-check share | sum of `check-app` step `duration_ms` / sum of lap durations |
| cost per merge | sum of `cost_usd` of every step of every lap / merges |

  The other measures keep their definitions. A build-queue lap has no `pick`, `review`, `land` or
  `check-app` step, so it counts toward laps, failed laps, lap duration, active hours and cost, and
  toward no empty lap, send-back, gate refusal or app-check time. It merges nothing itself: the
  merge queue's later run does (owner request, #393). For each pull request an `archon-merge-queue`
  run's `record` step read back as merged (its `merged` list; a pull request counts once, at its
  first such run), the issue is the one that run's `facts` items name for it (a maintainer's own
  pull request has none and counts nowhere). Among the factory's build-queue laps on that issue that
  started no later than the merge, the pull request is credited to the lap that opened it: the last
  lap that started before the first lap whose `facts` named that pull request as its pull request;
  when no lap named it, the last lap; when every lap named it (the queue continued a pull request
  it did not open), the first lap. A pull request with no such lap is credited to no version. A
  version's merges are its laps that merged by `land` or were credited a pull request. A merge
  whose build laps span two versions therefore counts on the version that opened it, not the one
  that last pushed it.

  Every number shows how many laps it rests on. Two versions can be compared side by side; a
  difference resting on fewer than 10 laps on either side is labelled "not yet meaningful".
- **Key decisions:** the entries of `DECISIONS.md` (section 11.5) on a timeline, each linked to the
  version its `Version:` line names.
- **Improvements being tested:** versions with a `Measure` and no verdict yet, and the laps each is
  still waiting for; versions with a verdict (helped, hurt, inconclusive) and its sentence.
- **Architecture diff:** for any two versions, which workflows, steps, prompts and subagents were
  added, removed or changed.

### 4.3 One factory: from product document to merged pull requests

Per factory (section 11.6):

- **Product document phases** with merged and total issues per phase.
- **The issue graph** from `Depends on: #n` lines, colored by state: waiting (open, no claim),
  claimed (a live `Loop claim`), pull request open, needs owner (label `needs-owner`), merged,
  closed. The longest open dependency chain is highlighted.
- **Lanes:** one row per running lap: the issue it claimed, its route and depth, the step it is
  on, when it entered that step (the browser shows elapsed time), its cost so far.
- **Recent laps:** every lap with its outcome (merged, sent back, gate refused, needs owner,
  nothing to do, failed), duration and cost.

### 4.4 The owner queue

Everything waiting on a person, per factory: open issues labeled `needs-owner`, and each open
question in the manager's `Owner decisions needed` issue with its options, recommendation, default
and the date the default applies, with how long each has waited. Each links to its GitHub thread,
where it is answered. v1 never answers anything itself.

### 4.5 Testing: how each change was checked

Per factory: the mix of routes and check depths; app-check lines by kind and verdict; holdout
verdicts by scenario id on the default branch (from the manager's `holdouts at` lines) and at
pull-request time (from app-check lines); scenarios failing on the default branch with their
tracking issues. Holdouts appear only by scenario id and verdict (invariant 3, section 11.7).

### 4.6 One lap

Every step the lap ran with start, duration, model, tokens and cost; its route and depth; the
app-check lines (kind, verdict, evidence count); the review outcome and dispositions; the merge
gate's outcome and reason; links to the pull request, the issue, and the run in the Archon console
(`<console>/console/r/<runId>`, section 11.6).

### 4.7 Rewind

Open the same dashboard on a Neon branch from a past moment (up to 7 days back): same screens,
same queries, older data, read-only. Rewind branches are created by the owner
(`bun run rewind:create <ISO time>`, which names them `rewind-<time>`); the dashboard lists them
and switches to one.

### 4.8 Health

Per factory: runs with status `pending`; runs with status `paused`; steps running longer than twice
that step's 90th-percentile `duration_ms` over its last 50 completions; failed laps by cause, from
the failing step's error text (`usage limit|429` = usage limit, `401|unauthor` = authentication,
`ECONN|ETIMEDOUT|fetch failed` = infrastructure, anything else = other); and workable issues (open,
no `needs-owner`, every `Depends on` closed, no live claim) against running laps.

### 4.9 Where v2 is going: fewer screens, one story (owner decision 2026-11-03)

**Owner decision 2026-11-05, which overrides the table below:** four tabs: **Factory**, **Board**, **Decisions** (only what is waiting) and **Laps** (every run running right now). Changes, Scorecard, Versions, Diff, Ledger, Health, Testing, Owner, Issues and Rewind are gone, and each old address redirects. Health, history and whether a change helped are questions for the owner's agent, not screens; the data stays so the agent can answer them.

v1 was a proof of concept: eleven tabs, most of them tables, and the owner had to know the factory's
internals to read them. v2 answers four questions, each on one screen, in the design of
`docs/design/v2/`:

| Screen | Answers | Replaces |
|---|---|---|
| **Factory** (home, `/f/<factory>`) | How does the factory work, and where is all the work right now? The map of 4.1 and its deeper views | Map |
| **Board** (`/f/<factory>/board`) | Where is each work item? Work orders with their progress and landing target above, one column per stage of the map (Queued, Intake, Build, Review, App check, Merge, Your decision, Merged). A work item opens its own page: every run on it as a timeline of stages, its app-check results, review outcomes, pull request and console links | Issues, Laps, Testing |
| **Decisions** (`/f/<factory>/decisions`) | What is waiting on me, and is the factory healthy? Archon attention items (paused runs waiting on a person) with their question, choices and recommendation, answered in the Archon console or Slack; on a factory still on the old loop, owner questions and `needs-owner` items, answered on GitHub; then health (stuck, pending and paused runs, failed laps by cause) | Owner, Health |
| **Changes** (`/f/<factory>/changes`) | Did my last change to the factory help? Versions newest first with reason, hypothesis and verdict, two versions compared on the scorecard of 4.2, decisions from `DECISIONS.md` on the same timeline, the architecture diff one click away | Versions, Scorecard, Diff, Decisions |

Above every screen: one bar with the product name, the factory switcher, "Running now" and the
four tabs (owner decision 2026-11-05, #459). The mockup's line of live numbers under the bar is not
built: merged today, cost per merge and time to merge are questions for the owner's agent. Rewind is
retired, and every old address, `/f/<factory>/rewind` included, redirects. The one-lap page stays,
opened from a work item.

Sequencing: the Factory map ships first (4.1), then its deeper views, then the v2 colors on every
screen, then the screens above, and the screens they replace are removed last, each in its own issue.
Until a screen's replacement merges, the old one stays and keeps working.

### 4.10 Version 3: what needs me, and what should I do about it (owner decision 2026-11-08)

**This overrides 4.9's places, its home and its Decisions and Laps screens.** Mission Control converges on the
Archon frontend redesign. The design is `docs/design/v3/` (mockup, screenshots, tokens and a README that
states what is binding).

Three decisions of 2026-11-08:

1. **Attention is home.** `/f/<factory>` opens on "N things need you", grouped by the action it needs:
   - **Decide:** questions only the owner can answer, with the recommended option first.
   - **Unstick:** work that stopped moving and one action moves it, for example a blocked item whose
     blocker merged, or an answered run waiting for a slot.
   - **Fix:** failures, grouped by cause.
   - **Clean up**

   The factory map moves to `/f/<factory>/map`, one click away.
2. **A Manager on every place.** A docked chat (⌘J), aware of the page you are on, answers questions
   about the factory and proposes actions. An agent runs it on the server, over the same data the
   dashboard reads; it has read-only access to the data. Its credentials stay on the server
   (invariant 7). Health, history and "did a change help" are asked here.
3. **The dashboard may act, in two ways only.** It may **answer** a paused run's question and
   **resume** a failed or paused run. Both run through that factory's own Archon CLI, after a
   5-second Undo, and both are recorded. Everything else stays a link or a copied command.

**Owner decisions 2026-11-12.** Attention counts only what needs the owner (Decide, Unstick, Clean
up); failures move to a Failures view on Runs and never count toward "N things need you". A failure
resolves when its work item closes, a later run of the same workflow on the same item completes, or
it is more than 7 days old, and every failure carries a class. Every Attention item is a decision with
options and "Something else" plus text. The dashboard gains three writes: re-triage, close and comment
on a work item (invariant 2). A run with nothing left to do does not offer Resume. Times are local.
`docs/design/v3/README.md` "Owner changes of 2026-11-12" is binding.

**Owner decision 2026-11-11 (#630).** The Factory place shows, under the map, a scorecard from the metric
records Archon stores (`archon-metrics-prs`). It lists ten measures: issues merged, PR merge rate, review
rounds to Ready, the share Ready in one round, the share needing five rounds or more, issue lead time,
build rounds per issue, owner asks per issue, and test and production lines added, with the issue
measures also per route. Each is shown for the last 7 and the last 30 days, counted by the owner's local day (owner decision 2026-11-12, #651), beside the period before
it, with how many records each number rests on. A comparison resting on fewer than 10 records on either
side reads "Too few to compare" (4.2's threshold). The numbers are Archon's records counted by Archon's
rules (a re-run replaces earlier records), projected into `mc.metric_records` and not derived from laps.
The Manager answers "how is the factory doing" from the same query. This adds one panel to 4.9's
"whether a change helped is a question for the agent", which still holds for everything else.

The places are:
- **Attention** (home)
- **Factory** (the v2 map)
- **Board** (a pipeline of work items, work orders on top)
- **Runs** (every run, with why it stopped; one run opens on the manager's read and its timeline)
- **Manager**

Old addresses redirect: `decisions` goes to Attention, `laps` to Runs. Every state has one name and
one color. Violet means you, your manager and the recommended action. Amber is still not used.

## 5. Out of scope, forever

- Writing to GitHub, Archon or any factory from the dashboard, beyond the five writes of invariant 2
  (answer, resume, re-triage, close, comment): no approving outside a question, halting, launching or
  merging.
- Rebuilding Archon's run log viewer. One lap links to the Archon console for the full stream.
- Anything that requires changing the Archon engine or Archon's database schema.
- User accounts, sharing, or hosting the dashboard UI outside the owner's machine in v1. (The
  webhook receiver is a Neon Function, hosted by Neon, by decision.)

## 6. Hard invariants

1. **Never slows or breaks Archon.** Anything the dashboard adds to the database (tables, triggers,
   views) can never make an Archon write fail or wait. A trigger catches its own errors and counts
   them in a table; it never raises. Triggers on Archon's tables fire only for step-level events
   (section 11.4).
2. **Five writes, no more (owner decisions 2026-11-08 and 2026-11-12).** The dashboard writes to a
   factory in exactly five ways: answering a paused run's question, resuming a run, re-triaging a work
   item, closing a work item's issue, and commenting on it. Each goes through that factory's own
   Archon CLI, after a 5-second Undo, and is recorded in the dashboard's own table. Nothing else the
   dashboard runs writes to GitHub, to a factory's repository, or to Archon's tables, and a test
   proves there is no other write path.
3. **Past holdout text stays hidden.** The factory no longer uses holdouts (4.1), but Archon's old rows
   still hold scenario text. The dashboard never copies or shows it, and shows no holdout at all on
   the v2 screens.
4. **Every number can be traced.** Each metric names the laps or rows it was computed from, and how
   many.
5. **Live means live.** Every panel is a Neon Realtime live query or derived from one. No polling
   and no refresh button.
6. **The map never drifts from the code.** The map's layout, grouping and wording are authored by
   the owner in `app/map/factory-map.json` (4.1); which workflows and steps each card covers is
   checked against the pinned code by `bun run map:check`, and prompts and step details come from
   the pinned code at that version, parsed by a job, never typed in.
7. **Secrets never reach the browser.** The browser gets sealed live queries only; the Realtime
   secret, database URLs, the Neon API key and GitHub tokens stay on the server and in the Function.
8. **The `main` database branch is the owner's.** Laps and checks never migrate, seed, write to or
   delete `main`; Archon writes there. Checks run on their own branches (section 11.3).

## 7. The observable core journeys

1. **See the factory.** Open the dashboard: the factory map (4.1) with live counts on its cards;
   click App check, and from its Behind the scenes open its `check` step screen and read its
   prompt.
2. **Watch a lap.** While a lap runs, its lane moves from step to step without a reload; when it
   merges, its issue turns merged and its phase bar fills.
3. **Judge a change.** Pick two versions on the strip and compare their scorecards and the
   architecture diff between them.
4. **Find what waits on me.** The owner queue lists every open owner question with its default date;
   a newly labelled `needs-owner` issue appears without a reload.
5. **Rewind.** Switch to a rewind branch and see the older version and its laps.

## 8. What "validated" means

### 8.1 Live

A row inserted into a source table (a step event, an issue, a comment) appears in every panel that
shows it within 5 seconds, with no reload. A panel left open for 3 minutes (three seal renewals)
still updates.

### 8.2 Correct

On the seed data (section 11.3), every scorecard number equals `fixtures/expected-scorecard.json`
exactly. That file is written by the seed issue, from the definitions in 4.2, not by the panel
issue. The version strip equals the pin commits in the seed. The issue graph equals the seed
issues' `Depends on` lines.

### 8.3 Design contract

**From 2026-11-08 the design is `docs/design/v3/` (4.10).** Its README, tokens and screenshots
replace what follows wherever they disagree. The rules on comparing screenshots and on the design
probe stay, with `docs/design/v3/refs/` as the reference.

The dashboard is part of Archon to the eye: the Archon console's theme tokens, fonts (Geist, Geist
Mono) and component shapes, copied from `docs/design/archon-console/`, with the v2 role colors of
`docs/design/v2/tokens.css` on top (owner decision 2026-11-03): sky for where work comes from and
scripts, blue for agents, teal for testing and shipping, violet for the manager and the owner.
Waiting on a person is violet, never amber: a question for the owner is a normal part of the
process, not a warning. Status: running is Dynamous Light and pulses, success teal, failed red.
Amber and magenta are not used. Nothing is drawn grey where a role color applies. Dark only. On
every change that touches a v2 screen, its screenshot is compared side by side with the matching
`docs/design/v2/refs/` image (or the mockup put in the same state) and the judgement quoted. On every
change that touches the frontend, `harness/design-probe.js` (written by the skeleton issue) reports
zero failures: only token colors and fonts, no browser-default controls, text contrast at least
4.5:1, no horizontal overflow at 1440 and 390 px, every control with an accessible name. A screenshot
of each touched screen is compared with the console references in `docs/design/archon-console/`
and the judgement quoted.

### 8.4 Fast

On the seed data, a live panel's speed is judged on the app's own work: its query's `EXPLAIN ANALYZE`
execution takes under 100 ms, and its rows are on screen within 500 ms of the first snapshot arriving
(decode and render). Everything between the subscribe and that first snapshot is Neon's (connection,
first-subscribe warm-up, delivery): it is recorded but not judged, except that every live panel
shows `data-state="ready"` within 2000 ms of navigation.

### 8.5 What the checks cannot see, and who owns it

Whether the architecture map explains the factory well to a newcomer, and whether the scorecard's
measures are the right ones, are owner calls (product direction).

## 9. Success metrics

- In the two weeks after launch, the owner writes no throwaway metric script to judge a factory
  change.
- Every pin to the factory after launch carries `Hypothesis` and `Measure`, and gets a verdict.
- An owner question is seen within 10 minutes of being raised.

## 10. Owner decisions and open questions

- **Who decides:** Claude acts as owner for this factory's technical and small calls, each recorded
  with a reason. Product direction, scope, and look and feel wait for Cole, collected in one list a
  day.
- **Open:** how the scorecard should compare factories with very different apps (a GPU game and a
  web app). v1 shows each factory separately and never sums across them.

## 11. Decided stack and the runtime contract

### 11.1 Stack (decided)

- **Frontend:** React 19, Vite 6, Tailwind CSS v4 (`@theme inline` tokens), react-router 7 with one
  route file per screen registered from a directory (so screen issues never edit a shared router),
  hand-written components, lucide icons sparingly, dagre for graph layout. Copy the console tokens
  and components from `docs/design/archon-console/` rather than inventing new ones.
- **Live data:** Neon Realtime. Each panel is one `useLiveQuery` (`@neon/realtime-react`) on a
  sealed query (`createRealtime` and `seal` from `@neon/realtime/server`). Queries are read-only,
  deterministic single SELECTs: no `now()` (return timestamps; the browser does clock math). Until
  the database issue's spike proves which features Realtime accepts (CTE, LATERAL, DISTINCT ON,
  window functions), live queries are plain SELECTs with joins and aggregates, and the browser
  combines step-level rows.
- **Server:** one Bun + Hono process that serves the built app and seals queries (sealed queries
  expire every 60 seconds; the client renews through it). It holds the Realtime secret and the
  database URL.
- **Database:** Neon project `bold-mouse-41160836` ("factory-mission-control", aws us-east-1,
  Postgres 18), Realtime enabled, logical replication on, 7-day history. Every table a live query
  reads has a primary key.
- **Ingestion:** a Neon Function (Hono, TypeScript) receives GitHub webhooks (issues, issue comments,
  labels, pull requests, pushes) and upserts rows. A nightly reconcile reads the GitHub API. A
  backfill script loads history.
- **Tooling:** Bun 1.4 (`bun test`, `bun run`), TypeScript strict, Biome for lint and format.

### 11.2 Where each fact comes from

| Fact | Source | Path into the database |
|---|---|---|
| Laps, steps, timings, cost, model, route, depth, app-check lines, review outcome, merge-gate outcome | Archon's `remote_agent_workflow_runs` and `remote_agent_workflow_events` (`node_completed` rows carry the step's `structured_output`, `cost_usd`, `tokens`, `duration_ms`, `provider`, `model`; the step id is `step_name`) | Archon writes them (its `DATABASE_URL` is this project's `main`); triggers project step-level rows into the dashboard's tables |
| Which version a lap ran | the run's `metadata.workflow_source.digest` (a hash of the exact workflow pack it ran) | as above; versions are keyed by (factory, digest), dated by the first `archon-loop` or `archon-build-queue` run with that digest (any build-queue run, item or not), and labelled with the most recent pin committed before it. No other workflow's run dates a version (#160, amended by #378). A digest covers every workflow run from one source, so a version also names that source's intake and merge-queue runs |
| Issues, labels, `Depends on`, PRD phase, claims, reviews, owner decisions, `Loop metrics` and `holdouts at` lines, pull requests | GitHub | webhook into the Neon Function; nightly reconcile; backfill |
| Versions, reasons, `Hypothesis`, `Measure`, verdicts | commits on `coleam00/ai-software-factory` | push webhook (section 11.5) |
| SDLC metrics (merge rate, review rounds, lead time, owner asks, lines) | `node_completed` events whose `structured_output` carries `metrics` (Archon's metric records) | a trigger projects them into `mc.metric_records` |
| Key decisions | `DECISIONS.md` in `coleam00/ai-software-factory` | push webhook |
| Architecture | the pack at the pinned Archon commit (`.archon/workflows/sdlc/` in `coleam00/Archon`) and the factory template (`template/` in ai-software-factory) and the factory package (`.archon/workflows/factory/`) | the architecture job (11.4) |

Archon's `provider_event` rows (about 30 per step) are never read by a live query.

### 11.3 Runtime contract (what the factory drives)

- **`bun install`**, then **`bun run setup`**: installs and builds. Idempotent, non-interactive,
  works on Windows (Git Bash) and Linux.
- **`bun run serve -- --port <port>`**: serves the built app and the sealing API on
  `127.0.0.1:<port>` in the foreground until killed. The browser opens it as
  `http://localhost:<port>`: the only browser origins Realtime allows are `http://localhost:5173`
  (Vite dev) and `http://localhost:8850` through `8864`, so every app instance (each lap's, the
  holdout verifier's, CI's) uses a free port in 8850-8864.
- **Check branches.** A check never touches `main` (invariant 8). `bun run fixture:branch` creates
  a Neon branch `check-<id>` from the branch `fixture` (owner-made from `main`, holding Archon's
  schema and no app data), applies the repository's migrations, loads `fixtures/seed.sql` (rows for
  every dashboard table and a realistic set of Archon runs and events), writes the branch's
  connection string and Realtime secret to `.mc-check.env` (gitignored), which `serve` reads.
  `bun run fixture:drop` deletes that branch, and any `check-*` branch older than 3 hours. Both
  refuse to act on any branch not named `check-*`. `bun run fixture:write <kind>` inserts one
  realistic row of a kind (a step event, a label, a comment) into the check branch, to prove
  liveness. Migrations refuse a branch named `main`; only the owner runs `bun run migrate:main`.
- **Credentials** come from the environment the factory's launcher sets (worktrees carry no
  gitignored files): `NEON_API_KEY` (scoped to this project only), `NEON_PROJECT_ID`, and `gh`'s
  login for GitHub. The app itself reads `MC_DATABASE_URL` and `NEON_REALTIME_SECRET` (never
  `DATABASE_URL`, which Archon on this machine uses).
- **The Neon Function.** Laps build and test the webhook handler locally (`bun run function:dev`,
  with signed sample payloads in `fixtures/webhooks/`, verified with `GITHUB_WEBHOOK_SECRET=test`).
  A lap may deploy it (`bun run function:deploy`) to its own check branch to prove the deployed
  Function, and deletes it when the check ends (owner decision, #56). Deploying to `main` and
  registering webhooks are owner steps after merge.
- `GET /api/health` returns 200 once the app can serve; `GET /api/build-id` returns the git commit.
- **Checks:** `bun run check` (type-check, lint, unit tests, no network) and `bun run test:live`
  (the liveness checks against a check branch). CI runs `bun run check` on every pull request.

### 11.4 The architecture job and the Archon projection

- **Architecture job** (`bun run arch:parse <archon-sha> <factory-sha>`): reads the pack at that
  Archon commit, and the factory package and the template hooks at that factory commit (each factory
  part optional, not both missing), from GitHub or a local path (`--package-path` for a local
  package), and stores, per version: workflows, steps (id, kind, description, model tier, `when`,
  `depends_on`, `trigger_rule`, includes, inline subagents), edges, the workflow YAML, command and
  instruction text, and scripts. Includes are expanded the way Archon expands them. Its tests run
  on the committed pack snapshot in `fixtures/pack/` (no network).
- **Projection:** triggers on `remote_agent_workflow_events` declared
  `WHEN (NEW.event_type IN ('node_started','node_completed','node_failed','node_skipped'))` and on
  `remote_agent_workflow_runs` project into the dashboard's step and lap tables (step id from
  `step_name`; outputs from `data->'structured_output'`). Each trigger body catches every error and
  records it in a `projection_errors` table instead of raising.

### 11.5 Versions, verdicts and decisions

Every pin commit on ai-software-factory (`Pin Archon <sha>: <reason>`) carries two trailers:

```
Hypothesis: <what should change in the factory's behaviour>
Measure: <which scorecard measure, which direction, how many laps>
```

A verdict is a later commit on ai-software-factory with the trailer
`Verdict: <pin sha> helped|hurt|inconclusive: <one sentence>`. `DECISIONS.md` entries have the fixed
shape `## YYYY-MM-DD Title`, `Decision:`, `Why:`, `Replaces:`, `Version:`; `Version:` joins to a pin
by sha prefix.

### 11.6 Factories

`factories.json` (committed) lists each factory: name, GitHub repository, the Archon codebase name
its runs carry, and its Archon console URL. At launch only mission control's own runs are in this
database; North Star and DynaChat join when the owner moves their Archon data in. Every view is
keyed by factory and must work with exactly one.

### 11.7 Holdout ids

Scenario ids in `.factory/holdout/HOLDOUT.md` follow `H-<nn>` (for example `H-07`). The app check's
line `id` is a line number; the scenario id is the first `H-<nn>` in the line's text, which the
projection extracts and stores alone. A holdout line with no such id shows as `unidentified`.

## 12. Build order for the first run

Slice with `max_issues` 25. Three laps run at once: after the first items, most items depend only on
the seed, not on each other. Ingestion feeds the same tables the panels read, but no panel waits for
it: panels build against the seed.

1. **Skeleton:** the app serves per 11.3 with health and build-id; console tokens and base components
   from `docs/design/archon-console/`; one-route-file-per-screen routing; `harness/design-probe.js`;
   `bun run check`; CI.
2. **Check branches:** `fixture:branch`, `fixture:drop`, `fixture:write`, migrations runner refusing
   `main`, with an empty migration set.
3. **Schema and seed:** every dashboard table (GitHub mirror, versions, decisions, architecture, laps,
   steps, holdout verdicts, projection errors) with primary keys; `fixtures/seed.sql`;
   `fixtures/expected-scorecard.json`.
4. **Realtime spike and sealing API:** one live panel end to end on a check branch; records which SQL
   features Realtime accepted.
5. **Archon projection triggers** (deep check: invariant 1).
6. **Comment parsers:** claims, reviews, owner decisions, metrics and holdout lines, pin trailers,
   DECISIONS.md, as pure functions with unit tests on the examples in the appendix.
7. **Webhook Function handler** and **8. backfill and nightly reconcile** (both use 6).
9. **Architecture job** and **10. the home-base map with step detail** (10 uses 9).
11. **Version strip**, **12. scorecard and comparison**, **13. decisions timeline and improvements
    ledger**, **14. architecture diff** (14 uses 9).
15. **Phases and issue graph**, **16. lanes and recent laps**.
17. **Owner queue**, **18. testing panel**.
19. **One lap**, **20. rewind**.
21. **Health**.

## 13. Provenance

Written 2026-10-24 by Claude for Cole from: a read-only study of the Archon pack on
`factory/sdlc-on-dev`, the ai-software-factory repository, the vault's factory plans and run logs
since September, the 2026-10-24 holdout audit, the Archon console source (`packages/web`), Neon's
Realtime documentation, Cole's answers on 2026-10-24, and a review of the first draft against them.

## Appendix: the formats the parsers read

Literal examples (ids and numbers invented):

```
Loop claim: run 4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c
Route: simple
Area: app/routes/lanes.tsx
```

```
Loop claim released: run 4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c ended. Its `Loop review:` comment, if any, says what it did.
```

```
Loop review: merged (route: simple) at 9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c by the merge gate, after the review above.
Loop review: not merged (route: complex). The merge gate refused the reviewer's merge:

- it changes .claude/settings.json, which only the owner changes; the owner merges it by hand if it is intended

The next lap continues this pull request.
Loop review: sent back (route: continue)
```

`Loop metrics` issue body, one line per manager pass:

```
2026-10-25T14:20Z | merged since last pass: 4 (simple 2, complex 1, continue 1) | open PRs: 2 | loop send-backs since last pass: 1 | merge-gate refusals: 0 | ship correction rounds: 2 | needs-owner open: 1 | owner questions open: 2 | default branch checks: green (CI) | laps since last pass: 9 (empty 2, failed 0) | health actions: 1
2026-10-25T14:20Z | holdouts at 3e4f5a6b: H-01 PASS, H-02 FAIL #41, H-03 INCOMPLETE #42
```

`Owner decisions needed` issue, one section per question:

```
### Q3. Should the lanes panel show finished laps for an hour?
Options: A) yes, faded; B) no, only running laps.
Recommendation: A, so a merge that just happened is still visible.
If there is no answer by 2026-10-27 14:00 UTC, the loop will use A.
```

A pin commit and a verdict on ai-software-factory:

```
Pin Archon abd85896: holdouts fenced in the repository; the complex route runs dev's ship-block

Hypothesis: complex laps finish faster and are sent back less.
Measure: complex-route lap-hours per merge and send-backs per merge, over at least 10 complex laps.
```

```
Record the verdict on abd85896

Verdict: abd85896 helped: complex laps took 1.4 lap-hours per merge against 2.6, over 12 laps.
```
