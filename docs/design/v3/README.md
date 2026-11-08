# Mission Control v3 design

This is the owner's design for the dashboard's third version (2026-11-08). It converges Mission Control on
the Archon frontend redesign: **what needs me, and what should I do about it**, on every screen.

v3 replaces v2's shell, home, Decisions and Laps. It keeps v2's factory map structure and wording,
redrawn in the v3 surfaces. Where this file and `../v2/` disagree, this file wins.

It is owner-maintained: laps read it and never edit it (`docs/design/**` is a protected path). The
PRD's section 4.10 states the product decisions behind it.

## How to look at it

`mockup.html` is a working mockup: one self-contained page (Google Fonts is its only load). Open it
headless:

```
agent-browser open "file:///<absolute path to this folder>/mockup.html"
```

The places in the left nav switch views. A Runs row opens a run, ⌘J or Ctrl+J toggles the Manager,
and a primary button shows the Undo toast. The page exposes hooks:

- `window.__mcV3View('attention'|'runs'|'run'|'board'|'factory'|'manager'|'manager-toggle')`
- `window.__mcV3Toast(true|false)`

A check can use them to put the page in any state. Compare at 1440 x 900 and at 400 wide.

`refs/` holds the screenshots:

| File | View |
|---|---|
| `01-attention.png` | Attention (home), Manager open with the briefing and one answer |
| `02-attention-answered-undo.png` | After clicking a recommendation: the Undo toast |
| `03-attention-manager-closed.png` | Attention with the Manager closed |
| `10-runs.png` | Runs |
| `11-run-failed.png` | One run that failed, opened on the failed step |
| `20-board-pipeline.png` | Board as a pipeline, with a work order |
| `30-factory.png` | Factory place (the v2 map goes here) |
| `40-phone-attention.png`, `41-phone-manager.png`, `42-phone-board.png` | 400 wide |

## The places

The left nav holds four places and the Manager:

| Place | Address | Answers | Replaces |
|---|---|---|---|
| **Attention** (home) | `/f/<factory>` | What needs me, ranked, with the recommended action first | v2 Decisions, and the map as home |
| **Factory** | `/f/<factory>/map` | How the factory works, and where the work is (the v2 map and its deeper views) | v2 home |
| **Board** | `/f/<factory>/board` | Every work item by stage, as a pipeline; work orders on top | v2 Board |
| **Runs** | `/f/<factory>/runs`, one run at `/f/<factory>/runs/<run id>` | Every run, newest first, with why it stopped | v2 Laps and the one-lap page |
| **Manager** (⌘J) | a docked panel on every place | Ask anything, get answers with actions | (new) |

Old addresses redirect: `decisions` goes to Attention, `laps` to Runs, `laps/<id>` to `runs/<id>`.
The work item page (`/f/<factory>/work/<n>`) and the step screens stay, and adopt the v3 look.

**Nav.** It is 216 px wide and holds:
- the brand
- the four places, each with a right-aligned count (Attention's is a violet badge)
- a divider
- the Manager, with its ⌘J hint
- a status footer at the bottom:
  - running count and waiting-for-slot count, with a live dot
  - schedules and main health, with one dot
  - the factory switcher, with the engine version

**Phone (under 760 px).** There is no side nav and no docked panel. Instead:
- a top bar with the brand and the running count
- one column of content
- a bottom tab bar: Attention (with its badge), Factory, Board, Runs, Manager. The Manager is a full-screen tab.

## Five rules every screen follows

1. **Every state has one name and one color** (table below). The same state reads the same in a
   dot, a pill, a row's stop line, a sparkline, a progress bar, a filter chip and the chat.
2. **Every item leads with the recommended action.** The primary button is the manager's
   recommendation, named for exactly what it does ("Rename to 0029, then merge", "Resume from
   pr__prepare"). Then "Open …", then the text button "Ask manager". Never an empty text box first.
3. **Failures say why on the row.** Wherever a run appears (Attention, Runs, a run, a work item,
   the Board, the chat), a failed or asking run shows its stop line: the failed step and its error,
   or the question.
4. **One action model.** Answer and Resume behave the same everywhere they appear: on an
   Attention item, on a run, on a work item, in the Manager's chat and on the phone.
5. **Nothing happens silently.** Every action shows a toast for 5 seconds with **Undo** before it
   is sent. It is then recorded and appears in the Manager's chat and in Attention's "handled" line.

## States

| State | Name shown | Color | Used for |
|---|---|---|---|
| Running | Running | `--v3-live` blue | A run with a step in progress |
| Needs you | Needs you, or the asking question | `--v3-you` violet | A paused run waiting on the owner, an asking work item, an item the manager wants you to act on |
| Failed | Failed | `--v3-failed` red | A run or check that failed. Real failures only |
| Done | Done, Merged, Passed | `--v3-done` teal | Finished, merged, a check that passed |
| Idle | Waiting, Queued, Blocked, Parked, Cancelled, Skipped | `--v3-idle` grey | Not moving and not needing you: waiting for a slot or for CI, queued, blocked, parked, cancelled, skipped |

A state is never shown in amber. A misconfiguration that stops the factory (for example, schedules
off) is shown as **Needs you** with a recommended fix. A broken one (for example, main is red) is
shown as **Failed**.

## Look

- **Surfaces.** Page and nav are `--v3-bg`. Cards, the Manager panel and Board columns are
  `--v3-panel`. Hover and selected are `--v3-raised`. Code blocks and inputs are `--v3-sunk` or
  `--v3-bg`. Every edge is a 1 px `--v3-line` hairline. There are no shadows, except the toast.
- **Type.** Geist for everything a person reads, Geist Mono for everything a machine named: workflow
  names, step names, run ids, branches, commands, keys and counts in chips. Five sizes: title 26,
  head 16, body 14, meta 13, micro 11.5. Titles are bold with slightly tight letter spacing.
  Numbers line up (tabular).
- **Violet** appears only for:
  - you
  - the manager (the "A" avatar and the Manager's read)
  - the recommended option
  - primary buttons
  - the Attention badge
  - toggles that are on

  It never marks a state other than Needs you.

## Components

Build these once, as shared components, and use them on every place:

- **Button:**
  - *primary:* violet fill, dark text
  - *secondary:* hairline outline
  - *text:* no border, for "Ask manager"

  Labels say what will happen.
- **StateDot and Pill:** a dot or pill in the state's color. A pill is the state's wash fill with
  the state color as text, in mono.
- **Chip:** a filter with a count, rounded fully, with a state dot when it filters a state. The
  pressed chip gets a stronger outline.
- **Segmented control:** "By kind / By queue", "Pipeline / Table".
- **Card:** panel fill, hairline, 10 px radius.
- **Manager note:** a 20 px violet "A" avatar, then text with the key facts in bold. It is how the
  manager speaks anywhere outside the chat.
- **Option tile:** a bold label with a muted consequence line. The recommended tile has the violet
  wash and line, plus an inline "Recommended" tag. A confidence note sits beside the actions.
- **Sparkline:** small red bars of failures per day, on a failure group.
- **Timeline:** dots on a hairline, with name, hint, and time and cost on the right. Loop rounds are
  nested. A failed step expands in place into the error panel.
- **Error panel:** red wash, red hairline, red title, the error in a mono code block, then actions.
- **Toast:** the answer or action in words, a 5-second bar and **Undo**.

## Attention (home)

- **Head.** The title is "**N things need you**", or "Nothing needs you" at zero. Under it, the
  line "The manager swept <time> ago and put its recommendation first on each." On the right,
  By kind / By queue.
- **Groups** (By kind), each headed by a bold name, a count and a muted one-line meaning:
  - **Decide**: a question only you can answer. These are paused runs with a question, its options and the recommendation.
  - **Unstick**: work that stopped moving and one action moves it. Examples: a blocked or parked item whose blocker merged, an answered run waiting for a slot, a claim held by a finished run.
  - **Fix**: failures, grouped by cause. One card per cause: how many runs over how many days, the step, the class (transient, environment, config, code, input), a sparkline, and the batch action.
  - **Clean up**: safe to clear.
- **The card.** In order:
  1. a state dot
  2. a title written as the situation
  3. the age, top right
  4. a meta line: workflow in mono, a state pill, the PR or item
  5. the manager's note
  6. options or actions
- **The handled line.** At the end, "The manager handled N on its own today", linking to them.
- **By queue** shows the same items, under intake, build, merge, app check and discoveries.

## Runs

- **Head.** The title "Runs" and the line "Every queue and check, newest first. The counts and
  the rows come from the same query."
- **Filters:**
  - a search box (workflow, item, run id, error text)
  - chips with counts: All, Running, Needs you, Failed, Done, Cancelled
  - a toggle, "Hide idle polls (N)", on by default. An idle poll is a queue run that found nothing to do.
- **Rows:**
  - a state dot
  - the workflow, bold
  - a mono sub-line: the round or step and the PR
  - the stop line in the state's color, when it failed or is asking
  - the item
  - Took and Cost, right-aligned and tabular, with "-" when there is none

  A row opens the run. The server pages the rows; the counts add up to the rows.

## One run

- **Head.** A breadcrumb, then the title written as what it is ("Build #485, round 2 of 3"). Then:
  - the state pill
  - the workflow in mono
  - the PR
  - took, cost and tokens

  The primary action sits top right ("Resume from <step>"), next to "Open in console".
- **The manager's read comes first:** a violet-edged card saying why it stopped, what the action
  will cost, and whether it is a code failure.
- **Tabs:** Timeline (default), Steps, Log and Artifacts. Log and Artifacts may link to the console.
- **Timeline.** The failed step opens on its error panel, with "Resume from here".

## Board

- **Pipeline** (default), with a Table alternative.
- **Work orders on top:** name, "work order · lands on <target>", a progress bar in state colors,
  and "N of M merged · building · needs you".
- **Five stage cards:** Intake, Planned, Build, Merge, Merged. Each has:
  - a name and a muted subtitle
  - a big count
  - state pills with counts
  - a few mini cards (number, state pill, title)
- **Below them, two wide cards:** "Found by the factory" and "Blocked and parked".
- **Phone:** the stages stack in one column.

## Factory

The v2 map. Its structure, cards, lines, wording and interactions stay binding as `../v2/` states
them. It changes in two ways: it is drawn on the v3 surfaces and text colors, and its role colors
take the v3 values (`--v3-role-*`). It is the Factory place, one click from home.

## Manager

- **Layout.** A docked panel, 384 px wide, on every place. It collapses with × or ⌘J/Ctrl+J and
  remembers whether it was open.
- **Head.** The "A" avatar, "Manager", and "Watches every run and queue for you".
- **Context chip.** Under the head, "Looking at <place · what>". It changes with the page, and the
  manager answers with that context.
- **Briefing.** The first message is the day's briefing: what merged, what failed, what waits on
  you, and the one or two things that matter most.
- **Answers.**
  - They cite runs and items as links.
  - They can include a small list of runs with state dots.
  - They end with action buttons. These go through the same action model (rule 4): the same toast and the same Undo.
- **Input.** Above the box, suggested questions change per place. The box says "Ask about any
  run, or tell me what to do", and its primary button says Send.
- **Phone.** It is the Manager tab.

## Actions

The dashboard writes to a factory in exactly two ways, each through that factory's own Archon CLI
and each recorded:

- **Answer**: answer a paused run's question with one of its options, or with "Something else"
  plus text.
- **Resume**: resume a failed or paused run, including from a named step.

Snooze and Mark resolved change only the dashboard's own records. Everything else stays a link:
open the issue, the PR, the console, or copy a command. Examples are
re-triage, unpark, release a claim, cancel, merge, and re-run a check, until a later owner decision
adds them.

Every action:
1. shows the toast with Undo for 5 seconds before it is sent
2. names exactly what it does
3. is recorded with who, what, when and the result
4. shows its result in the Manager's chat

## What is binding and what is not

Binding (match it):
- the places, addresses, nav, status footer and phone tabs
- the five rules
- the state table
- the tokens in `tokens.css`
- the components and their look
- the order of everything on a card and a run
- the Manager's layout and behaviour
- the two actions and the Undo toast
- the copy on the mockup's fixed strings: titles, group names and meanings, button patterns, the
  Manager's head, the input placeholder, the "handled" line

Not binding:
- **The data.** The work items, runs, numbers, questions and briefing text are examples; the app
  shows real data.
- **The manager's words.** A real answer depends on the data.
- **The icons.** Their exact shapes may differ, as long as they stay simple outline icons.
- **The mockup's code.** Build it in the app's stack, not by pasting the page in.
