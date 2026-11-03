# Mission Control v2 design

The owner's design for the dashboard's next version (2026-11-03). It is the design source of truth
for every v2 issue, together with the console tokens in `../archon-console/`. Owner-maintained:
laps read it, never edit it (`docs/design/**` is a protected path).

## How to look at it

`mockup.html` is a working mockup: one self-contained page (Google Fonts is its only load). Open it
the same way you open the app, headless:

```
agent-browser open "file:///<absolute path to this folder>/mockup.html"
```

Drag the map, scroll to zoom, click a card for its details strip, double-click a card with ⤢ to open
its deeper view, Esc to go back up. The Board and Decisions tabs are live too. The page exposes
`window.__mcView(['build','deliver'])`, `window.__mcSelect('<card id>')`, `window.__mcTab('map'|'board'|'you')`
and `window.__mcTicket(<n>)` so a check can put it in any state and screenshot it. Compare your
screen with it side by side, at 1440 x 900 and at 400 wide.

`refs/` holds screenshots of every view at 1440 x 900 (and one at 400 wide), taken from the mockup:

| File | View |
|---|---|
| `01-home-map.png` | Home: the factory map, nothing selected |
| `02-home-build-selected.png` | Home with Build clicked: neighbours lit, details strip open |
| `03-home-appcheck-selected.png` | Home with App check clicked |
| `10-drill-plan.png` ... `18-drill-manager.png` | Each card's deeper view |
| `13-drill-build-deliver.png` | Two levels down: Build, then Deliver |
| `20-board-ticket.png` | Board with one ticket's timeline open |
| `30-decisions.png` | Decisions |
| `40-home-phone.png` | Home at 400 wide |

## What is binding and what is not

Binding (match it):

- The home map's cards, their order, their positions relative to each other, every line and what it
  connects, the two groups (inputs on the left, the dashed box the manager watches), and the one
  dashed loop back along the bottom.
- Every card's wording: kind label, title, one-line description, and the caption above each view.
  Copy it exactly. If a sentence seems wrong, say so on the issue; do not rewrite it.
- The color roles in `tokens.css`, and that a card's border and fill are tinted by its role.
- The interactions: drag to pan, wheel to zoom around the cursor, fit, click to select (the card
  and its direct neighbours stay lit, everything else dims to 30%, its lines stay lit), the details
  strip with its tabs, double-click or Enter or the Open button to go one level down with a zoom
  through the card, breadcrumbs and Esc to go up, the returning card flashing once.
- The motion: one dot travels the line Product document to Shipped and each card pulses as the dot
  reaches it; dashes flow along the forward lines; both stop for `prefers-reduced-motion` and when
  the flow toggle is off.

Not binding:

- The numbers, tickets and KPI values: they are example data. The app shows real data.
- The light theme: the dashboard stays dark only.
- The mockup's code. Build it in the app's stack (React, Tailwind tokens, the existing live queries),
  not by pasting the page in.

## Color roles

Color says who is acting, not how worried to be.

| Role | Token | Used for |
|---|---|---|
| Source | `--role-source` sky | Where work comes from (product document, plan, new issue, found by the factory) and script steps |
| Agent | `--role-agent` blue | Agents building: intake, build, review, merge |
| Test | `--role-test` teal | Testing and shipping: holdouts, app check, staging, shipped |
| Person | `--role-person` violet | The manager and the owner: decisions, waiting on a person |

Red stays for real failures only. Amber is not used anywhere: a question for the owner is a normal
part of the process, never a warning. Nothing is grey: every card is tinted by its role.
