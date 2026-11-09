# Viewing the factory map

The Factory place (`/f/<factory>/map`; `/` and `/f/<factory>` forward an old map link's
`at`, `view` and `from` to it) draws the factory map of PRD
4.1, as `docs/design/v2/` designs it: one horizontal map with live counts on its cards.

## The drawing is data

`app/map/factory-map.json` holds the map: its caption, every card (id, role, kind label, title,
one-line text, position, optional width, the chips it carries, the `lists` Right now shows for it
(`documents`, the open product documents), the workflows and steps it covers,
and its details text), every line (from, to, style `flow`, `ask` or `loop`, an optional
label and, for the routed lines, explicit points), the dashed group, the tour order, the legend and `referenceViews`, the views whose fit caps deeper ones.
Change what the map says there; the React components (`app/components/FactoryMap.tsx`,
`MapDetails.tsx`) only draw it.

A card's `covers` lists, per workflow, the steps it covers. Each entry covers that step and every
step under it; a step under two entries belongs to the deeper one, so Build covers `ship` and
Review the two review rounds inside it. Each entry's step link opens that step's place in the
covered workflow. Each entry names its `pack`: `loop` for the old `archon-loop` pack
(`fixtures/pack/sdlc`), `queue` for Archon's queue workflows and the factory package
(`fixtures/pack/queue`). A live row carries only a workflow name, so counting ignores `pack`; the
map check is what keeps the two sets apart.

A card that opens a deeper view names it in `opens`; the view sits under `views.<id>` and has the
root's shape (caption, `cardSize`, cards, lines, tour) without the legend, `views` or a required
group. Card ids are unique across every level. A view's `next` card may name `upTo`, a card of
the level above: clicking it goes up and selects that card. A card may name `countsAs`, a card whose laps it shows as its own, as the Deliver view's Review card does for Review. The view's crumb and Open button use
the title of the card that opens it. One component draws every level, so selection, the details
strip, chips, flow and the tour work the same in a view.

## Size and readability (owner deviation from the mockup)

The map is the home screen's hero. Its frame spans the window between the page gutters; the
caption, legend and details strip stay in the app's column. The frame's height is the map's height
at the scale that fits its width, plus its padding (at least 420px), so a fit leaves no empty band;
the page scrolls below it. A deeper view is fitted no larger than the largest scale the matching views
(the ones listed in the root's `referenceViews` key: Intake, Review, App check, Build, Deliver) fit at in the same frame (about 0.73 at 1440x900), centred in
the frame; below 701px wide Fit fits as before. A card whose kind label would wrap is widened
through `width` (Staging's Deploy, Work order's middle column).

The owner chose readability over the mockup's proportions (PR #326 review, 2026-11-03): at 1440x900,
fitted, a card's title renders at least 14px, its text 11px, and its kind label and the line labels
10px. So the type inside the map is larger than the mockup's (in map units: title 25, text 20, kind
18, line labels 18, chips 15; `MAP_TYPE` in `FactoryMap.tsx`), cards are 208 wide and 212 tall so
texts wrap to two or three lines, and columns sit closer: 52 between cards, 84 between App check and
Merge, where the "passed" label needs the room (the mockup has about 84 everywhere). Which card sits
where, and every line, are the mockup's. `bun run test:live` measures the rendered sizes at 1440
fitted and fails below these numbers.
A card whose kind label would not fit on one line at that size is widened through its `width` and the
cards after it move right to keep their spacing (App check's Use the app, Build's Investigate and Plan,
Deliver's Implement); `factory-map.test.ts` fails any new kind label that would wrap.

Below 701px wide the map opens as `refs/40-home-phone.png` draws it: the line at a readable scale
in a 460px frame, centred on the line's box with the Manager above, the rest a pan away. Fit always
fits the whole map, at any width.

## The map check

`bun run map:check` (part of `bun run check`) parses both packs with the architecture parser,
offline, and fails, naming the step, when a step of a workflow a card covers is covered by no card
or by two, when a card names a workflow or a step its pack lacks, when a role, chip, list, line style, legend role or pack is outside the closed sets, or
when a covered step's pack path holds a dot (the map reads a step's path by its dots). A failure
that names a pack's step starts `loop pack: ` or `queue pack: `. A step of one pack that counts on a
card only through the other pack's entry (the packs share workflow names such as
`archon-merge-queue`) also fails, since a live row cannot tell them apart. It also fails when a
step a lap's row marks (`LANE_STEPS`) is one the pack's loop lacks. The loop
pack's steps on the Split and Intake cards sit on the view card of their role (`read-prd` on Take
the item, `authorize` with `publish` on File the issues, `pick` and `claim` on Triage). When a
pack changes, update `covers` until the check passes.

Every view is held to its opening card: each step the card covers is covered by exactly one card
of the view, and no card of the view covers a step, or a workflow, the opening card does not. A
view covers only the steps its opening card has (Deliver's view never sees the review rounds,
which Review has at the root), so an entry such as `ship/deliver` still counts the steps under
it that belong to the opener. The check also fails on an `opens` naming no view, a view opened by
no card or by two, a card id used twice, and an `upTo` naming no card of the level above. A
`countsAs` fails when it names no card, the card itself, or a card that itself counts as another,
and when its card covers steps of its own, so a lap counts once on each card that shows it.

`map:check` also fails on any key of `factory-map.json` that the map's types do not declare (a
misspelled `countsAs` would otherwise be dropped); the key lists in `scripts/map-check.ts` follow
the interfaces of `factory-map.ts`, and the compiler fails when they drift. A routed line's first
point must lie on an edge of its `from` card and its last on an edge of its `to` card, on the dashed
group's edge when that card sits inside the group, or, for a line with `"arrow": false`, on another
line into the same card. Moving a card or changing `cardSize` without moving the routes fails.

A question card's `asks` is checked against the queue pack: it is `{"rest": true}` (on one card
per level at most) or a `label` that some wait of the pack declares, with an optional `value` that
the pack sets for that label. The check fails on an `asks` with an unknown key, no label, a
label no wait declares, a value that is not a string, or, for a label the pack sets values for, a value it never sets.
Labels fed from workflow output, such as `build` and `merge`, take any value unchecked.

The queue pack is the snapshot `fixtures/pack/queue/`: `sdlc/` is `.archon/workflows/sdlc` of
coleam00/Archon and `factory/` is `.archon/workflows/factory` of coleam00/ai-software-factory, at
the commits this factory runs, with `ARCHON_COMMIT` and `FACTORY_COMMIT` beside them. The
architecture job and the seed store `factory/` too, under `.archon/workflows/factory/` paths, so
its steps have screens beside the pack's.

## Live counts

The cards' chips come from these live queries (`map-right-now` also feeds the Merge and Staging views' lists, and the Manager view adds three, below): `home-map` (each running run of the factory with its
running steps and issue, the runs waiting on attention, whether the factory is on the queues, the
open pull requests whose latest app check failed, the merges with when they finished, and whether
the version the address names is recorded),
`health-workable`, `owner-queue`, `product-documents` (below) and `work-orders` (the distinct `work-order:<name>` labels on the
factory's issues with their counts, from the mirrored label data; it writes nothing). The chip counts only the orders with an open issue.

- A run's issue is its claim comment's issue on the old loop, and on the queues its `number` input
  (a pull request's number, when the run's `kind` input says so, is no issue).
- "<n> here" on any card: a run counts once, on the card covering its deepest running step (the
  newest of those as deep). A loop group's iteration of a step (`rounds.review__policy`) counts as
  that step (`rounds/review/policy`). A card with runs on it carries `data-live-count` above 0.
- "<n> queued" on Build: the workable issues, as Health counts them.
- "<n> open" on Work order: the work orders with an open issue, nothing when there are none. Right now
  lists each as the Board counts it, "<merged> of <total> merged", with its `lands-on:<target>` label when
  one exists, linking to the Board filtered to it (`?order=<name>`).
- "<n> failing" on App check: open pull requests whose latest app check came out FAIL.
- "<n> waiting" on the Manager: open Archon attention items (paused runs waiting on a person).
  A factory not on the queues, one that has run neither `archon-intake` nor `archon-build-queue`,
  also counts open owner questions and open `needs-owner` issues; on the queues those are not
  counted.
- "<n> merged" on Shipped: laps whose land step merged today, the browser's local day, counted
  from the moment that step finished, not when the run ends, and each pull request an
  `archon-merge-queue` run's `record` step read back as merged. The count moves on at local midnight.

- Product documents on Split and Keep the document: Right now lists each open issue labelled
  `archon-prd` as a bar of its work items merged over total, from `product-documents`. A document's
  work items are the issues and adopted issues in the record of the newest completed `archon-split`
  `publish` step for it (`mc.lap_steps` keeps that output whole), not `Depends on` links, which only
  join the filed issues to each other. Merged means closed with a merged pull request. A document
  with no recorded split is 0 of 0. A failed query says the product documents are unavailable.

A chip of 0 is not drawn. A chip appears once its query has answered. A chip whose query failed
shows as `? queued`, `? orders` or `? waiting`, never as a count; Right now says the count is unavailable, and
Behind the scenes says the pinned steps are unavailable when `step-detail` failed.

## Live counts in a view

A lap counts once per level: on the card that covers its deepest running step at the root, and
then on the card of that card's view that covers it, so one run on `ship/deliver/rounds/implement`
is on Build at the home map, on Deliver in the Build view, and on Implement in the Deliver view. A step that Review covers at the
root counts on no card of the Build view, and also shows on the Deliver view's Review card.

In the Review view a lens the router skipped for the round a run is in has no count for it, and the
lens card's Right now says that run's change did not earn the reviewer. It reads the skipped lens
steps of a round whose `route` step completed with `false` for that lens (the `home-map` query's
`picks` rows, which keep only steps that finished since the round's `policy` step last started) and
says nothing for a lens that ran, a round not yet at its lenses, or a round the router never ran (a
light round, a rereview, a refused round).

## Right now in the Merge and Staging views

A card's `lists` (a closed set, held by the map check) name what its Right now shows beside its
chips' items: `outcomes` (Merge gate), `deploys` and `lands` (each Staging card), `choices` (Choose what goes next in the Work order view, the same rows as the Work order chip) and `checks` (Use the app, the App
check panel, which subscribes its own `app-check` query, below). The rest come from
`map-right-now` (the newest 10 `archon-merge-queue` runs that swept and then recorded, and the
factory's latest finished deploy, from `factory-deploy` or from the old loop's `deploy` include)
and from `work-orders`; nothing is written and nothing polls. Like the chips, they describe the
factory as it is now, at whatever version the address names.

- Gate outcomes, newest run first: a pull request the run's `record` step read back as merged is
  merged, whatever the sweep said; else a `return` decision is listed as sent back; an `ask` is
  listed only when the record step raised it. Sent back and asked are the sweep's decision, which
  the record step may still park, wait on or skip. Only a number's first decision counts, and a
  number the run's `facts` step did not list is not shown. A `wait` decision, or an ask not raised, is not listed. Each shows the decision's reason and links the
  pull request.
- The latest deploy shows the revision (seven characters) and whether the deploy verified, or its
  failure and the health it reported. A factory with no finished deploy says it has never deployed.
- Where each work order lands lists the orders with an open issue and the `lands-on:<target>`
  label their issues carry, or that they name no target yet.
- A list whose source failed says it is unavailable and the other lists stay.

## The Work order view

The Work order card opens `?view=order`, drawn from the mockup's `order` view: three source cards
(pieces of a document, bug fixes, anything else ready) join Choose what goes next, which leads to
Build queue and, dashed, to Where it lands. Its cards cover no steps, since work orders are
`work-order:<name>` labels and not a workflow, so `map:check` has nothing to bind: the card
covers `[]` and the view covers none of its opening card's steps. Right now on Choose what goes
next lists the open work orders from the same `work-orders` rows the Board reads, so a label
change moves them as it moves the Board.

## The App check view

`?view=app` is drawn from the mockup's `V.app`. On a factory on the queues, Pick a PR covers
`config`, `select` and `pending`, How deep? `scope`, Protected paths `policy`, PR + main, started
`prepare`, Use the app `check`, Seal the evidence `evidence` and `factory/app-check` `publish`,
`finalize` and `cleanup`; the old loop's `briefs`, `check-app` and `evidence` sit on the
same cards in the same order. Use the app's Right now also lists, through its `checks` list, the open
pull requests the app check has looked at (the `app-check` query): each one's latest verdict and its lines by kind.

The home map's failing chip and the Board's verdict chip read the old `check-app` step or, on the
queues, the `check` step of `factory-app-check` (migrations 0024, 0025 and 0027). On the queues that
step keeps a verdict only once the run's `publish` step posted it: PASS when it posted success, FAIL
when it posted failure (a result it found stale included), with the pull request and head the
`select` step kept. Lines are the ones `evidence` sealed that match the factory's `LINE` in full,
stored by id, kind and verdict without their text. A run whose `publish` did not complete shows no
verdict, a run whose `evidence` did not complete shows no lines, and a run whose report names a
holdout keeps no output and no lines.
A check names its pull request by the step's projected `pr_number` (owned by `mc.pr_number`), read as the lap
page's `prNumber` reads `pr`: `#N`, `N`, a `/pull/N` URL, or a JSON object's `number` or `url`.
Showing those lines on the work item page's timeline waits on that page (#317).

## Clicking a card

A card keeps itself and the cards a line joins to it lit and dims the rest; its details strip opens
under the map. Right now lists the runs and items the card's chips count, each opening its page;
an open attention item is listed there too, and a lap with an issue also links that issue on GitHub, until the ticket page exists (#317).
Behind the scenes lists, per workflow, its YAML path in the pinned pack (from the parsed
architecture, and none when the version lacks it) and the steps the card covers that the version shown has, each
opening its step screen beside the model its parsed architecture gives it (`step-detail`, the
step screens' own query): only facts from the factory's pinned code, never a step or path the
version lacks (owner, #307); when a covered step is left out for that, one line says those steps
are not in this version. App check's includes `check-app`, whose screen shows its prompt, the
holdout verifier and the fence (journey 1). Esc, the close button or a click on empty canvas
deselects.

A card with a view shows ⤢ and a stacked edge, and its strip has an Open button naming the number
of cards in the view. A card shows ⤢ only once its view exists; today Build's, Review's, Split's, Intake's, the Manager's, App check's, Merge's, Staging's and Work order's do (`?view=build`, `?view=review`, `?view=split`, `?view=intake`, `?view=manager`, `?view=app`, `?view=merge`, `?view=deploy`, `?view=order`), and so does Deliver inside Build (`?view=build/deliver`). Deliver's Review card opens the same Review view (`?view=review`); opened from there the address also carries `from=build/deliver`, so the breadcrumbs keep the Build and Deliver path and going up returns to Deliver (a link to `?view=review` alone opens it from the home map).
Double-click, Enter on the selected card or the Open button zooms into the view. Breadcrumbs above
the caption (the factory, then each opened view), the up control, a crumb, Esc (with nothing
selected) and Backspace go up, and the card that opened the view flashes. The address is
`/f/<factory>/map?view=<id>`: opening and going up each push a history entry, so the browser's back
button goes up, and a link or reload opens straight into the view. An unknown `view` shows the
home map.

## The Manager view

`?view=manager` draws `refs/18-drill-manager.png`: four violet question cards (Work item is unclear,
Build is stuck on a choice, Risky merge, Is this a real problem?), the Manager and the Written rules
under them. Its cards are 250 high, taller than the other views' cards, because a question card's kind,
two-line title, three-line text and chip need that to keep the chip inside the border at the map's
type scale. It adds three live queries to the home map's: `attention-items`, and the Health screen's
`health-runs` and `health-steps`; each is a live query, none polls. Its two ask lines share one
trunk up from the Manager, as the reference draws them.

- A question card counts the open Archon attention items its `asks` names, by their labels:
  `stage: archon-triage` (a stopped triage) to Work item is unclear, `build:` to
  Build is stuck, `merge:` to Risky merge, `discoveries:` to Is this a real problem?. An item no
  card names counts on the Manager card. A failed query shows `? waiting`, never a count.
- The Manager's Right now lists every open question with its recommended choice, then the
  factory's health by the Health screen's own definitions (`app/lib/health.ts`): runs pending or
  paused, steps running past twice their usual time, failed runs by cause. Each links to its run in
  the factory's Archon console. A failed health query says the health is unavailable.

## Versions

The Version control above the map opens it at an older pin (`/?at=<pin>`). The drawing is the same;
step links open their screens at that version, and the "here" counts include only the runs that
ran it. A version that is not recorded for the factory reads “No version <pin> is recorded for this
factory.” The queued, failing, waiting, merged and open chips count the factory as it is now.

## Motion

One dot travels Product document to Shipped and each card it reaches pulses once; dashes flow along
the forward lines. The flow button beside the screen's title, or `prefers-reduced-motion`, stops
both; the button shows once the map is drawn, and under reduced motion it reads off and is
disabled. Opening a view zooms the camera onto the card while the map fades, swaps the level, and
fits the new one; under reduced motion the swap is instant. A view with no tour (the Manager's)
draws no dot.
