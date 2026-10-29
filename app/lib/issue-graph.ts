/**
 * The issues screen's rows, as `db/queries/issue-graph.sql` returns them: one row per issue with
 * the state the query derived, and one per `Depends on: #n` edge. Pure, no React.
 */

export const ISSUE_STATES = [
  'waiting',
  'claimed',
  'pr-open',
  'needs-owner',
  'merged',
  'closed',
] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

/** The design token each state's color comes from (PRD 8.3); closed is the console's grey. */
export const STATE_TOKEN: Record<IssueState, `--${string}`> = {
  // Open and queued for a lap: neutral, so only needs-owner reads as waiting on the owner.
  waiting: '--text-secondary',
  claimed: '--running',
  'pr-open': '--running',
  'needs-owner': '--error',
  merged: '--success',
  closed: '--text-tertiary',
};

const CLOSED_STATES: ReadonlySet<IssueState> = new Set(['merged', 'closed']);

interface IssueRow {
  kind: 'issue';
  number: number;
  title: string;
  phase: string | null;
  url: string;
  state: IssueState;
  depends_on: null;
}

/** Issue `number` depends on issue `depends_on`. */
interface EdgeRow {
  kind: 'edge';
  number: number;
  title: null;
  phase: null;
  url: null;
  state: null;
  depends_on: number;
}

export type IssueGraphRow = IssueRow | EdgeRow;

export interface Issue {
  number: number;
  title: string;
  phase: string | null;
  url: string;
  state: IssueState;
}

export interface Dependency {
  from: number;
  on: number;
}

export interface IssueGraph {
  /** By number, ascending. */
  issues: Issue[];
  /** Only edges between two issues this factory has. */
  dependencies: Dependency[];
}

export function issueGraph(rows: readonly IssueGraphRow[]): IssueGraph {
  const issues: Issue[] = [];
  const edges: Dependency[] = [];
  for (const row of rows) {
    if (row.kind === 'issue') {
      const { number, title, phase, url, state } = row;
      issues.push({ number, title, phase, url, state });
    } else {
      edges.push({ from: row.number, on: row.depends_on });
    }
  }
  const known = new Set(issues.map((i) => i.number));
  return {
    issues: issues.sort((a, b) => a.number - b.number),
    dependencies: edges
      .filter((e) => known.has(e.from) && known.has(e.on))
      .sort((a, b) => a.from - b.from || a.on - b.on),
  };
}

export interface PhaseBar {
  phase: string;
  merged: number;
  total: number;
}

/** One bar per product-document phase, in the order of each phase's first issue. */
export function phaseBars(issues: readonly Issue[]): PhaseBar[] {
  const bars = new Map<string, PhaseBar>();
  for (const issue of issues) {
    if (issue.phase === null) continue;
    const bar = bars.get(issue.phase) ?? { phase: issue.phase, merged: 0, total: 0 };
    bar.total += 1;
    if (issue.state === 'merged') bar.merged += 1;
    bars.set(issue.phase, bar);
  }
  return [...bars.values()];
}

/**
 * The longest chain of open issues each depending on the next, from the dependent end, or empty
 * when no open issue depends on another open one. Ties go to the lower issue numbers. A cycle in
 * the `Depends on` lines is cut where it closes rather than followed.
 */
export function longestOpenChain({ issues, dependencies }: IssueGraph): number[] {
  const open = new Set(issues.filter((i) => !CLOSED_STATES.has(i.state)).map((i) => i.number));
  const dependsOn = new Map<number, number[]>();
  for (const { from, on } of dependencies) {
    if (open.has(from) && open.has(on)) dependsOn.set(from, [...(dependsOn.get(from) ?? []), on]);
  }
  // Only a chain whose walk cut no cycle is the longest from its issue whatever led there; one
  // that cut a cycle depended on which issues the walk was already inside.
  const chains = new Map<number, number[]>();
  const visiting = new Set<number>();
  const chainFrom = (number: number): { chain: number[]; cut: boolean } => {
    const known = chains.get(number);
    if (known) return { chain: known, cut: false };
    visiting.add(number);
    let longest: number[] = [];
    let cut = false;
    for (const next of dependsOn.get(number) ?? []) {
      if (visiting.has(next)) {
        cut = true;
        continue;
      }
      const found = chainFrom(next);
      cut ||= found.cut;
      if (found.chain.length > longest.length) longest = found.chain;
    }
    visiting.delete(number);
    const chain = [number, ...longest];
    if (!cut) chains.set(number, chain);
    return { chain, cut };
  };
  let longest: number[] = [];
  for (const number of [...open].sort((a, b) => a - b)) {
    const { chain } = chainFrom(number);
    if (chain.length > longest.length) longest = chain;
  }
  return longest.length >= 2 ? longest : [];
}

/** Whether an issue is still in play: not merged and not closed. */
export const isOpen = (issue: Issue) => !CLOSED_STATES.has(issue.state);

/** Open issues in the order the default view keeps them when it has to drop some. */
const CLOSEST_TO_MERGE: Record<IssueState, number> = {
  'pr-open': 0,
  claimed: 1,
  'needs-owner': 2,
  waiting: 3,
  merged: 4,
  closed: 5,
};

/** How many nodes the default view draws at most. */
export const DEFAULT_CAP = 40;

export interface PhaseColumn {
  /** Null is the final "No phase" column. */
  phase: string | null;
  /** Every issue of the phase, drawn or not. */
  open: number;
  merged: number;
  closed: number;
}

export interface ViewIssue extends Issue {
  /** Drawn only because an open issue depends on it (the default view's context). */
  context: boolean;
}

/** The phases left without a column by default because none of their issues is open. */
export interface DonePhases {
  phases: number;
  merged: number;
  closed: number;
  /** The issues with no phase, when none of them is open either; else null. */
  unphased: { merged: number; closed: number } | null;
}

export interface IssueView {
  /**
   * Phases in the PHASES grid's order, then "No phase" when any issue has none. By default only
   * the ones with open work: a phase whose issues are all merged or closed is counted in `done`.
   */
  columns: PhaseColumn[];
  /** By default, the phases with no column; with Show merged, none. */
  done: DonePhases;
  /** By number. */
  issues: ViewIssue[];
  /** Only edges whose two ends are drawn. */
  dependencies: Dependency[];
  /** Open issues the cap left out. */
  hidden: number;
}

/**
 * What the issues screen draws. By default: every open issue and the issues it directly depends
 * on, at most `cap` nodes, the open ones closest to merge first. With `showMerged`: everything.
 */
export function issueView(
  { issues, dependencies }: IssueGraph,
  { showMerged = false, cap = DEFAULT_CAP }: { showMerged?: boolean; cap?: number } = {},
): IssueView {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const dependsOn = new Map<number, number[]>();
  for (const { from, on } of dependencies)
    dependsOn.set(from, [...(dependsOn.get(from) ?? []), on]);

  const columns = new Map<string | null, PhaseColumn>();
  for (const bar of phaseBars(issues)) {
    columns.set(bar.phase, { phase: bar.phase, open: 0, merged: 0, closed: 0 });
  }
  for (const issue of issues) {
    const column = columns.get(issue.phase) ?? { phase: null, open: 0, merged: 0, closed: 0 };
    if (issue.state === 'merged') column.merged += 1;
    else if (issue.state === 'closed') column.closed += 1;
    else column.open += 1;
    columns.set(issue.phase, column);
  }

  const drawn = new Map<number, ViewIssue>();
  let hidden = 0;
  if (showMerged) {
    for (const issue of issues) drawn.set(issue.number, { ...issue, context: false });
  } else {
    const open = issues
      .filter(isOpen)
      .sort((a, b) => CLOSEST_TO_MERGE[a.state] - CLOSEST_TO_MERGE[b.state] || a.number - b.number);
    for (const issue of open) {
      const context = (dependsOn.get(issue.number) ?? [])
        .map((n) => byNumber.get(n))
        .filter((d): d is Issue => d !== undefined && !isOpen(d) && !drawn.has(d.number));
      const adds = (drawn.has(issue.number) ? 0 : 1) + context.length;
      if (drawn.size + adds > cap) {
        if (!drawn.has(issue.number)) hidden += 1;
        continue;
      }
      drawn.set(issue.number, { ...issue, context: false });
      for (const d of context) drawn.set(d.number, { ...d, context: true });
    }
  }
  const done: DonePhases = { phases: 0, merged: 0, closed: 0, unphased: null };
  const shown: PhaseColumn[] = [];
  for (const column of columns.values()) {
    if (showMerged || column.open > 0) shown.push(column);
    else if (column.phase === null)
      done.unphased = { merged: column.merged, closed: column.closed };
    else {
      done.phases += 1;
      done.merged += column.merged;
      done.closed += column.closed;
    }
  }
  return {
    // "No phase" goes last; Map order keeps the phases in the PHASES grid's order.
    columns: shown.sort((a, b) => Number(a.phase === null) - Number(b.phase === null)),
    done,
    issues: [...drawn.values()].sort((a, b) => a.number - b.number),
    dependencies: dependencies.filter((d) => drawn.has(d.from) && drawn.has(d.on)),
    hidden,
  };
}

/** One node's box, and the space between them. */
export const NODE = { width: 176, shrinkTo: 148, minWidth: 128, height: 54, gap: 14 };
const COLUMN_GAP = 20;
const EMPTY_COLUMN = 132;
const BAND_GAP = 40;
/** Between two lines of one band, when a column wraps it: room for an edge to pass. */
const LINE_GAP = 22;
const PAD = 12;

export interface PlacedIssue extends ViewIssue {
  /** Top left, in px, inside the graph area under the column headers. */
  x: number;
  y: number;
  /** A full node, or half of one for a done issue drawn for context. */
  width: number;
  depth: number;
}

export interface PlacedDependency extends Dependency {
  /** An SVG path from the bottom of the depended-on issue to the top of the dependent. */
  d: string;
}

export interface PlacedColumn extends PhaseColumn {
  x: number;
  width: number;
}

export interface PhaseLayout {
  columns: PlacedColumn[];
  issues: PlacedIssue[];
  dependencies: PlacedDependency[];
  nodeWidth: number;
  width: number;
  height: number;
  /** True when even the narrowest nodes do not fit `width`; the screen then scrolls. */
  overflows: boolean;
}

/**
 * Each issue's band: its dependency depth among the drawn issues (0 with none, else one below its
 * deepest), except that an issue joined to no other drawn issue goes in a band of its own after
 * the deepest. The chains then sit together at the top, each issue just under what it depends on,
 * instead of under a wall of unrelated issues their edges would have to cross. (`layoutPhases`
 * moves them back to the top of a column that holds no chain.)
 */
function depths(view: IssueView): Map<number, number> {
  const on = new Map<number, number[]>();
  for (const { from, on: to } of view.dependencies) on.set(from, [...(on.get(from) ?? []), to]);
  const depth = new Map<number, number>();
  const visiting = new Set<number>();
  const of = (n: number): number => {
    const known = depth.get(n);
    if (known !== undefined) return known;
    if (visiting.has(n)) return 0;
    visiting.add(n);
    const d = Math.max(-1, ...(on.get(n) ?? []).map(of)) + 1;
    visiting.delete(n);
    depth.set(n, d);
    return d;
  };
  for (const issue of view.issues) of(issue.number);
  const joined = new Set(view.dependencies.flatMap((d) => [d.from, d.on]));
  if (joined.size > 0 && joined.size < view.issues.length) {
    const after = Math.max(...[...joined].map((n) => depth.get(n) ?? 0)) + 1;
    for (const issue of view.issues) if (!joined.has(issue.number)) depth.set(issue.number, after);
  }
  return depth;
}

/**
 * Phases as columns, left to right; within them, issues in bands by dependency depth, top to
 * bottom, so every edge runs down from an issue to the ones depending on it. A column is as many
 * nodes wide as its fullest band, narrowed (wrapping that band) until the whole fits `width`.
 */
export function layoutPhases(view: IssueView, width: number): PhaseLayout {
  const depth = depths(view);
  const bands = Math.max(0, ...depth.values()) + 1;
  const keyOf = (phase: string | null) => phase ?? '';
  const known = new Set(view.columns.map((c) => keyOf(c.phase)));
  const inColumn = new Map<string, ViewIssue[][]>();
  for (const c of view.columns) {
    inColumn.set(
      keyOf(c.phase),
      Array.from({ length: bands }, () => []),
    );
  }
  // A done issue drawn for context whose phase has no column (no open work) sits in the column of
  // the open issue that depends on it.
  const columnKey = (issue: ViewIssue, seen = new Set<number>()): string => {
    const own = keyOf(issue.phase);
    if (known.has(own)) return own;
    seen.add(issue.number);
    for (const d of view.dependencies) {
      const dependent = d.on === issue.number ? view.issues.find((i) => i.number === d.from) : null;
      if (dependent && !seen.has(dependent.number)) return columnKey(dependent, seen);
    }
    return keyOf(view.columns.at(-1)?.phase ?? null);
  };
  // In a column with no chain, the unjoined issues have nothing to sit under: they go at the top.
  const joined = new Set(view.dependencies.flatMap((d) => [d.from, d.on]));
  const chained = new Set(view.issues.filter((i) => joined.has(i.number)).map((i) => columnKey(i)));
  for (const issue of view.issues) {
    const key = columnKey(issue);
    const band = !joined.has(issue.number) && !chained.has(key) ? 0 : depth.get(issue.number);
    inColumn.get(key)?.[band ?? 0].push(issue);
  }

  const spanOf = (issue: ViewIssue) => (issue.context ? 1 : 2);
  const slots = new Map(
    view.columns.map((c) => [
      keyOf(c.phase),
      // A done issue drawn for context is a chip half a node wide.
      Math.max(
        0,
        ...(inColumn.get(keyOf(c.phase)) ?? []).map((band) =>
          Math.ceil(band.reduce((n, i) => n + spanOf(i), 0) / 2),
        ),
      ),
    ]),
  );
  const total = (node: number) =>
    [...slots.values()].reduce(
      (sum, k) => sum + (k === 0 ? EMPTY_COLUMN : k * (node + NODE.gap) - NODE.gap + 2 * PAD),
      0,
    ) +
    COLUMN_GAP * Math.max(0, slots.size - 1);
  // Narrower nodes first (titles truncate sooner), then wrap the widest band, then the narrowest
  // nodes: wrapping costs the most, since an edge into a wrapped line has to route around.
  let nodeWidth = NODE.width;
  while (nodeWidth > NODE.shrinkTo && total(nodeWidth) > width) nodeWidth -= 4;
  while (total(nodeWidth) > width) {
    const [key, k] = [...slots].reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);
    if (k <= 1) break;
    slots.set(key, k - 1);
  }
  while (nodeWidth > NODE.minWidth && total(nodeWidth) > width) nodeWidth -= 4;
  // Wrapping may have freed room: give the titles back what fits.
  while (nodeWidth < NODE.width && total(nodeWidth + 4) <= width) nodeWidth += 4;
  const overflows = total(nodeWidth) > width;

  const columns: PlacedColumn[] = [];
  let x = 0;
  for (const c of view.columns) {
    const k = slots.get(keyOf(c.phase)) ?? 0;
    const w = k === 0 ? EMPTY_COLUMN : k * (nodeWidth + NODE.gap) - NODE.gap + 2 * PAD;
    columns.push({ ...c, x, width: w });
    x += w + COLUMN_GAP;
  }
  // Spread the columns over the full width when there is room to spare.
  const spare = width - (x - COLUMN_GAP);
  if (spare > 0 && columns.length > 0) {
    const grow = spare / columns.length;
    let shift = 0;
    for (const c of columns) {
      c.x += shift;
      c.width += grow;
      shift += grow;
    }
  }

  const unit = (nodeWidth + NODE.gap) / 2;
  const slot = 2 * unit;
  /**
   * A column that wraps any band puts every band on one grid, left-aligned in a centred block,
   * so the gaps between its slots run its whole height: an edge into a wrapped line goes down
   * one of them. Other columns centre each line.
   */
  const grid = new Map<string, number>();
  for (const c of columns) {
    const key = keyOf(c.phase);
    const k = Math.max(1, slots.get(key) ?? 1);
    const wraps = (inColumn.get(key) ?? []).some(
      (band) => band.reduce((n, i) => n + spanOf(i), 0) > 2 * k,
    );
    if (wraps) grid.set(key, c.x + (c.width - (k * slot - NODE.gap)) / 2);
  }
  const placed = new Map<number, PlacedIssue>();
  /** The gap under each issue's line: between two lines of a band, or after the band. */
  const gapBelow = new Map<number, number>();
  let y = PAD;
  for (let band = 0; band < bands; band++) {
    let lines = 0;
    const inBand: { number: number; line: number }[] = [];
    for (const c of columns) {
      const k = Math.max(1, slots.get(keyOf(c.phase)) ?? 1);
      const centre = (n: number) => {
        const deps = view.dependencies
          .filter((d) => d.from === n)
          .map((d) => placed.get(d.on))
          .filter((p): p is PlacedIssue => p !== undefined);
        return deps.length === 0
          ? Number.POSITIVE_INFINITY
          : deps.reduce((s, p) => s + p.x, 0) / deps.length;
      };
      const here = [...(inColumn.get(keyOf(c.phase))?.[band] ?? [])].sort(
        (a, b) => centre(a.number) - centre(b.number) || a.number - b.number,
      );
      // Fill lines of 2k half-node units; a full node starts on a whole slot.
      const gridLeft = grid.get(keyOf(c.phase));
      const rows: { issue: ViewIssue; at: number }[][] = [];
      let used = 2 * k;
      for (const issue of here) {
        let at = used;
        if (gridLeft !== undefined && spanOf(issue) === 2 && at % 2 === 1) at += 1;
        if (at + spanOf(issue) > 2 * k) {
          rows.push([]);
          at = 0;
        }
        rows[rows.length - 1].push({ issue, at });
        used = at + spanOf(issue);
      }
      rows.forEach((row, line) => {
        const units = row.reduce((n, { issue, at }) => Math.max(n, at + spanOf(issue)), 0);
        const left = gridLeft ?? c.x + (c.width - (units * unit - NODE.gap)) / 2;
        for (const { issue, at } of row) {
          placed.set(issue.number, {
            ...issue,
            depth: band,
            width: spanOf(issue) * unit - NODE.gap,
            x: left + at * unit,
            y: y + line * (NODE.height + LINE_GAP),
          });
          inBand.push({ number: issue.number, line });
        }
      });
      lines = Math.max(lines, rows.length);
    }
    for (const { number, line } of inBand) {
      gapBelow.set(number, line < lines - 1 ? LINE_GAP : BAND_GAP);
    }
    if (lines > 0) y += lines * (NODE.height + LINE_GAP) - LINE_GAP + BAND_GAP;
  }

  const boxes = [...placed.values()];
  /** Whether a curve between two issues would run over any other issue. */
  const blocked = (curve: (t: number) => [number, number], ends: Set<number>) => {
    for (let s = 1; s < 24; s++) {
      const [px, py] = curve(s / 24);
      for (const b of boxes) {
        if (ends.has(b.number)) continue;
        if (px > b.x - 3 && px < b.x + b.width + 3 && py > b.y - 3 && py < b.y + NODE.height + 3)
          return true;
      }
    }
    return false;
  };
  const columnOf = (issue: PlacedIssue) =>
    columns.find((c) => issue.x >= c.x && issue.x < c.x + c.width) ?? columns[0];
  const lineTop = (issue: PlacedIssue) => {
    // The gap above an issue's line: a line gap inside a band, the band gap above its first line.
    const above = boxes.some(
      (b) => b.depth === issue.depth && b.y < issue.y && b.y + NODE.height + LINE_GAP >= issue.y,
    );
    return issue.y - (above ? LINE_GAP : BAND_GAP) / 2;
  };

  const dependencies = view.dependencies.flatMap((dep) => {
    const from = placed.get(dep.from);
    const on = placed.get(dep.on);
    if (!from || !on) return [];
    const sx = on.x + on.width / 2;
    const sy = on.y + NODE.height;
    const tx = from.x + from.width / 2;
    const ty = from.y;
    const bend = Math.max(16, (ty - sy) / 2);
    const cubic = (t: number): [number, number] => {
      const u = 1 - t;
      return [
        u ** 3 * sx + 3 * u * u * t * sx + 3 * u * t * t * tx + t ** 3 * tx,
        u ** 3 * sy + 3 * u * u * t * (sy + bend) + 3 * u * t * t * (ty - bend) + t ** 3 * ty,
      ];
    };
    if (!blocked(cubic, new Set([dep.from, dep.on]))) {
      return [{ ...dep, d: `M${sx},${sy} C${sx},${sy + bend} ${tx},${ty - bend} ${tx},${ty}` }];
    }
    // Around: down into the gap under its source, along it to the gap beside the target's column,
    // down that gap to the gap over the target's line, along it, and down into the target. Lines
    // and bands start at the same height in every column, so those gaps hold no issue.
    const below = sy + (gapBelow.get(dep.on) ?? BAND_GAP) / 2;
    const over = lineTop(from);
    const column = columnOf(from);
    const gridLeft = grid.get(keyOf(column.phase));
    // On a grid: the slot gap right beside the target. Otherwise: the gap beside its column.
    const [leftGap, rightGap] =
      gridLeft === undefined
        ? [column.x - COLUMN_GAP / 2, column.x + column.width + COLUMN_GAP / 2]
        : (() => {
            const j = Math.floor((from.x - gridLeft + 1) / slot);
            const l = gridLeft - NODE.gap / 2 + j * slot;
            return [l, l + slot];
          })();
    const gx =
      leftGap < 0 || (rightGap <= width && Math.abs(rightGap - sx) < Math.abs(leftGap - sx))
        ? rightGap
        : leftGap;
    const r = 6;
    if (Math.abs(over - below) < 1) {
      // The same gap runs from under the source to over the target: no need for the column gap.
      const t = tx > sx ? r : -r;
      return [
        {
          ...dep,
          d: `M${sx},${sy} L${sx},${below - r} Q${sx},${below} ${sx + t},${below} L${tx - t},${below} Q${tx},${below} ${tx},${below + r} L${tx},${ty}`,
        },
      ];
    }
    const turn = (ax: number, bx: number) => (bx > ax ? r : -r);
    return [
      {
        ...dep,
        d: [
          `M${sx},${sy}`,
          `L${sx},${below - r}`,
          `Q${sx},${below} ${sx + turn(sx, gx)},${below}`,
          `L${gx - turn(sx, gx)},${below}`,
          `Q${gx},${below} ${gx},${below + r}`,
          `L${gx},${over - r}`,
          `Q${gx},${over} ${gx + turn(gx, tx)},${over}`,
          `L${tx - turn(gx, tx)},${over}`,
          `Q${tx},${over} ${tx},${over + r}`,
          `L${tx},${ty}`,
        ].join(' '),
      },
    ];
  });
  const last = columns.at(-1);
  return {
    columns,
    issues: [...placed.values()].sort((a, b) => a.number - b.number),
    dependencies,
    nodeWidth,
    width: last ? last.x + last.width : 0,
    height: Math.max(y - BAND_GAP + PAD, NODE.height + 2 * PAD),
    overflows,
  };
}
