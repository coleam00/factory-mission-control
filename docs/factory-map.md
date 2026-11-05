# Viewing the factory map

The home screen (`/f/<factory>`, and `/` for the selected factory) draws the factory map of PRD
4.1, as `docs/design/v2/` designs it: one horizontal map with live counts on its cards.

## The drawing is data

`app/map/factory-map.json` holds the map: its caption, every card (id, role, kind label, title,
one-line text, position, optional width, the chips it carries, the workflows and steps it covers,
and its details text), every line (from, to, style `flow`, `ask` or `loop`, an optional
label and, for the routed lines, explicit points), the dashed group, the tour order and the legend.
Change what the map says there; the React components (`app/components/FactoryMap.tsx`,
`MapDetails.tsx`) only draw it.

A card's `covers` lists, per workflow, the steps it covers. Each entry covers that step and every
step under it; a step under two entries belongs to the deeper one, so Build covers `ship` and
Review the two review rounds inside it. An entry an include expanded names its own screen
(`screens`), under the workflow that declares it. Each entry names its `pack`: `loop` for the old
`archon-loop` pack (`fixtures/pack/sdlc`), `queue` for Archon's queue workflows and the factory
package (`fixtures/pack/queue`). A live row carries only a workflow name, so counting ignores
`pack`; the map check is what keeps the two sets apart.

A card that opens a deeper view names it in `opens`; the view sits under `views.<id>` and has the
root's shape (caption, `cardSize`, cards, lines, tour) without the legend, `views` or a required
group. Card ids are unique across every level. A view's `next` card may name `upTo`, a card of
the level above: clicking it goes up and selects that card. The view's crumb and Open button use
the title of the card that opens it. One component draws every level, so selection, the details
strip, chips, flow and the tour work the same in a view.

## Size and readability (owner deviation from the mockup)

The map is the home screen's hero. Its frame spans the window between the page gutters; the
caption, legend and details strip stay in the app's column. The frame's height is the map's height
at the scale that fits its width, plus its padding (at least 420px), so a fit leaves no empty band;
the page scrolls below it.

The owner chose readability over the mockup's proportions (PR #326 review, 2026-11-03): at 1440x900,
fitted, a card's title renders at least 14px, its text 11px, and its kind label and the line labels
10px. So the type inside the map is larger than the mockup's (in map units: title 25, text 20, kind
18, line labels 18, chips 15; `MAP_TYPE` in `FactoryMap.tsx`), cards are 208 wide and 212 tall so
texts wrap to two or three lines, and columns sit closer: 52 between cards, 84 between App check and
Merge, where the "passed" label needs the room (the mockup has about 84 everywhere). Which card sits
where, and every line, are the mockup's. `bun run test:live` measures the rendered sizes at 1440
fitted and fails below these numbers.

Below 701px wide the map opens as `refs/40-home-phone.png` draws it: the line at a readable scale
in a 460px frame, centred on the line's box with the Manager above, the rest a pan away. Fit always
fits the whole map, at any width.

## The map check

`bun run map:check` (part of `bun run check`) parses both packs with the architecture parser,
offline, and fails, naming the step, when a step of a workflow a card covers is covered by no card
or by two, when a card names a workflow or a step its pack lacks, when an entry's screen is not
the step's own, when a role, chip, list, line style, legend role or pack is outside the closed sets, or
when a covered step's pack path holds a dot (the map reads a step's path by its dots). A failure
that names a pack's step starts `loop pack: ` or `queue pack: `. A step of one pack that counts on a
card only through the other pack's entry (the packs share workflow names such as
`archon-merge-queue`) also fails, since a live row cannot tell them apart. It also fails when a
step a lap's row marks (`LANE_STEPS`) is covered by no card or by two. The loop's `handoff` step is
missing from the pack's copy of the loop, so App check may cover it without the pack having it; it
is the one step a card may name that the pack lacks, and it is held to exactly one card. When a
pack changes, update `covers` until the check passes.

Every view is held to its opening card: each step the card covers is covered by exactly one card
of the view, and no card of the view covers a step, or a workflow, the opening card does not. A
view covers only the steps its opening card has (Deliver's view never sees the review rounds,
which Review has at the root), so an entry such as `ship/deliver` still counts the steps under
it that belong to the opener. The check also fails on an `opens` naming no view, a view opened by
no card or by two, a card id used twice, and an `upTo` naming no card of the level above.

The queue pack is the snapshot `fixtures/pack/queue/`: `sdlc/` is `.archon/workflows/sdlc` of
coleam00/Archon and `factory/` is `.archon/workflows/factory` of coleam00/ai-software-factory, at
the commits this factory runs, with `ARCHON_COMMIT` and `FACTORY_COMMIT` beside them.

## Live counts

The cards' chips come from four live queries (a fifth, `map-right-now`, feeds the Merge and Staging views' lists, below): `home-map` (each running run of the factory with its
running steps and issue, the runs waiting on attention, whether the factory is on the queues, the
open pull requests whose latest app check failed, the merges with when they finished, and whether
the version the address names is recorded),
`health-workable`, `owner-queue` and `work-orders` (the distinct `work-order:<name>` labels on the
factory's issues with their counts, from the mirrored label data; it writes nothing). The chip counts only the orders with an open issue.

- A run's issue is its claim comment's issue on the old loop, and on the queues its `number` input
  (a pull request's number, when the run's `kind` input says so, is no issue).
- "<n> here" on any card: a run counts once, on the card covering its deepest running step (the
  newest of those as deep). A loop group's iteration of a step (`rounds.review__policy`) counts as
  that step (`rounds/review/policy`). A card with runs on it carries `data-live-count` above 0.
- "<n> queued" on Build: the workable issues, as Health counts them.
- "<n> open" on Work order: the work orders with an open issue, nothing when there are none. Right now
  lists each with its open and merged issue counts and its `lands-on:<target>` label when one exists.
- "<n> failing" on App check: open pull requests whose latest app check came out FAIL.
- "<n> waiting" on the Manager: open Archon attention items (paused runs waiting on a person).
  A factory not on the queues, one that has run neither `archon-intake` nor `archon-build-queue`,
  also counts open owner questions and open `needs-owner` issues; on the queues those are not
  counted.
- "<n> merged" on Shipped: laps whose land step merged today, the browser's local day, counted
  from the moment that step finished, not when the run ends, and each pull request an
  `archon-merge-queue` run's `record` step read back as merged. The count moves on at local midnight.

A chip of 0 is not drawn. A chip appears once its query has answered. A chip whose query failed
shows as `? queued`, `? orders` or `? waiting`, never as a count; Right now says the count is unavailable, and
Behind the scenes says the pinned steps are unavailable when `step-detail` failed.

## Live counts in a view

A lap counts once per level: on the card that covers its deepest running step at the root, and
then on the card of that card's view that covers it, so one run on `ship/deliver/rounds/implement`
is on Build at the home map and on Deliver in the Build view. A step that Review covers at the
root counts on no card of the Build view.

## Right now in the Merge and Staging views

A card's `lists` (a closed set, held by the map check) name what its Right now shows beside its
chips' items: `outcomes` (Merge gate), `deploys` and `lands` (each Staging card). They come from
`map-right-now` (the newest 10 `archon-merge-queue` runs that swept and then recorded, and the
factory's latest finished deploy, from `factory-deploy` or from the old loop's `deploy` include)
and from `work-orders`; nothing is written and nothing polls. Like the chips, they describe the
factory as it is now, at whatever version the address names.

- Gate outcomes, newest run first: a pull request the run's `record` step read back as merged is
  merged, whatever the sweep said; else a `return` decision is listed as sent back; an `ask` is
  listed only when the record step raised it. Sent back and asked are the sweep's decision, which
  the record step may still park, wait on or skip. Only a number's first decision counts, and a number the run did not claim is not listed. A `wait`
  decision, or an ask not raised, is not listed. Each shows the decision's reason and links the
  pull request.
- The latest deploy shows the revision (seven characters) and whether the deploy verified, or its
  failure and the health it reported. A factory with no finished deploy says it has never deployed.
- Where each work order lands lists the orders with an open issue and the `lands-on:<target>`
  label their issues carry, or that they name no target yet.
- A list whose source failed says it is unavailable and the other lists stay.

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
of cards in the view. A card shows ⤢ only once its view exists; today Build's (`?view=build`), Merge's (`?view=merge`) and Staging's (`?view=deploy`) do.
Double-click, Enter on the selected card or the Open button zooms into the view. Breadcrumbs above
the caption (the factory, then each opened view), the up control, a crumb, Esc (with nothing
selected) and Backspace go up, and the card that opened the view flashes. The address is
`/f/<factory>?view=<id>`: opening and going up each push a history entry, so the browser's back
button goes up, and a link or reload opens straight into the view. An unknown `view` shows the
home map.

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
fits the new one; under reduced motion the swap is instant.
