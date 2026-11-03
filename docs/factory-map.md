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

## The map check

`bun run map:check` (part of `bun run check`) parses `fixtures/pack/` with the architecture parser,
offline, and fails, naming the step, when a step of a workflow a card covers is covered by no card
or by two, when a card names a workflow or a step the pack lacks, or when an entry's screen is not
the step's own. When the pack changes, update `covers` until the check passes.

## Live counts

The cards' chips come from four live queries: `home-map` (each running run of the factory with its
running steps, the open pull requests whose latest app check failed, and whether the version the
address names is recorded), `health-workable`, `owner-queue` and `recent-laps`.

- "<n> here" on any card: a run counts once, on the card covering its deepest running step (the
  newest of those as deep). A card with runs on it carries `data-live-count` above 0.
- "<n> queued" on Build: the workable issues, as Health counts them.
- "<n> failing" on App check: open pull requests whose latest app check came out FAIL.
- "<n> waiting" on the Manager: open owner questions and open `needs-owner` issues.
- "<n> merged" on Shipped: laps that merged today, the browser's local day.

A chip of 0 is not drawn. A chip appears once its query has answered.

## Clicking a card

A card keeps itself and the cards a line joins to it lit and dims the rest; its details strip opens
under the map. Right now lists the runs and items the card's chips count, each opening its page.
Behind the scenes lists the workflows and steps the card covers, each opening its step screen:
App check's includes `check-app`, whose screen shows its prompt, the holdout verifier and the fence
(journey 1). Esc, the close button or a click on empty canvas deselects.

No card has a deeper view yet: none shows ⤢ or an Open button until its view is built.

## Versions

The Version control above the map opens it at an older pin (`/?at=<pin>`). The drawing is the same;
step links open their screens at that version, and the "here" counts include only the runs that
ran it. A version that is not recorded for the factory reads “No version <pin> is recorded for this
factory.” The queued, failing, waiting and merged chips count the factory as it is now.

## Motion

One dot travels Product document to Shipped and each card it reaches pulses once; dashes flow along
the forward lines. The flow button beside the screen's title, or `prefers-reduced-motion`, stops
both.
