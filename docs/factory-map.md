# Viewing the factory map

The home screen (`/f/<factory>`, and `/` for the selected factory) draws the factory map of PRD
4.1, as `docs/design/v2/` designs it: one horizontal map with live counts on its cards.

## The drawing is data

`app/map/factory-map.json` holds the map: its caption, every card (id, role, kind label, title,
one-line text, position, optional width, the chips it carries, the workflows and steps it covers,
and its details text), every line (from, to, style `flow`, `ask`, `loop` or `holdout`, an optional
label and, for the routed lines, explicit points), the dashed group, the tour order and the legend.
Change what the map says there; the React components (`app/components/FactoryMap.tsx`,
`MapDetails.tsx`) only draw it.

A card's `covers` lists, per workflow, the steps it covers. Each entry covers that step and every
step under it; a step under two entries belongs to the deeper one, so Build covers `ship` and
Review the two review rounds inside it. An entry an include expanded names its own screen
(`screens`), under the workflow that declares it.

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

`bun run map:check` (part of `bun run check`) parses `fixtures/pack/` with the architecture parser,
offline, and fails, naming the step, when a step of a workflow a card covers is covered by no card
or by two, when a card names a workflow or a step the pack lacks, when an entry's screen is not
the step's own, when a role, chip, line style or legend role is outside the closed sets, or when a
covered step's pack path holds a dot (the map reads a step's path by its dots). It also fails when a
step a lap's row marks (`LANE_STEPS`) is covered by no card or by two. The loop's `handoff` step is
missing from the pack's copy of the loop, so App check may cover it without the pack having it; it
is the one step a card may name that the pack lacks, and it is held to exactly one card. When the
pack changes, update `covers` until the check passes.

## Live counts

The cards' chips come from three live queries: `home-map` (each running run of the factory with its
running steps, the open pull requests whose latest app check failed, the laps whose land step
merged with when it finished, and whether the version the address names is recorded),
`health-workable` and `owner-queue`.

- "<n> here" on any card: a run counts once, on the card covering its deepest running step (the
  newest of those as deep). A loop group's iteration of a step (`rounds.review__policy`) counts as
  that step (`rounds/review/policy`). A card with runs on it carries `data-live-count` above 0.
- "<n> queued" on Build: the workable issues, as Health counts them.
- "<n> failing" on App check: open pull requests whose latest app check came out FAIL.
- "<n> waiting" on the Manager: open owner questions and open `needs-owner` issues.
- "<n> merged" on Shipped: laps whose land step merged today, the browser's local day, counted
  from the moment that step finished, not when the run ends. The count moves on at local midnight.

A chip of 0 is not drawn. A chip appears once its query has answered. A chip whose query failed
shows as `? queued` or `? waiting`, never as a count; Right now says the count is unavailable, and
Behind the scenes says the pinned steps are unavailable when `step-detail` failed.

## Clicking a card

A card keeps itself and the cards a line joins to it lit and dims the rest; its details strip opens
under the map. Right now lists the runs and items the card's chips count, each opening its page;
a lap with a claimed issue also links that issue on GitHub, until the ticket page exists (#317).
Behind the scenes lists, per workflow, its YAML path in the pinned pack (from the parsed
architecture, and none when the version lacks it) and the steps the card covers that the version shown has, each
opening its step screen beside the model its parsed architecture gives it (`step-detail`, the
step screens' own query): only facts from the factory's pinned code, never a step or path the
version lacks (owner, #307). App check's includes `check-app`, whose screen shows its prompt, the
holdout verifier and the fence (journey 1). Esc, the close button or a click on empty canvas
deselects.

No card has a deeper view yet: none shows ⤢ or an Open button until its view is built.

## Versions

The Version control above the map opens it at an older pin (`/?at=<pin>`). The drawing is the same;
step links open their screens at that version, and the "here" counts include only the runs that
ran it. A version that is not recorded for the factory reads “No version <pin> is recorded for this
factory.” The queued, failing, waiting and merged chips count the factory as it is now.

## Motion

One dot travels Product document to Shipped and each card it reaches pulses once; dashes flow along
the forward lines. The flow button beside the screen's title, or `prefers-reduced-motion`, stops
both; the button shows once the map is drawn, and under reduced motion it reads off and is
disabled.
