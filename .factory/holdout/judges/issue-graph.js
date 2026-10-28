// Judge for H-66..H-72 (owner requirement 2026-10-27, a readable issue graph on ISSUES): what the
// default view draws, what it collapses into per-phase counts, the cap and its hidden count, column
// order, edge direction, the longest open chain, and the fit at 1920 px; and that Show merged brings
// the whole history back.
//
// Record shape (one file per observation of one factory's graph):
// {
//   "view": "default|show-merged",
//   "cap": 40,                         // the node cap the app states, or 40 when it states none
//   "viewport_width": 1920,
//   "phases_grid_order": ["Skeleton", "Check branches", "..."],  // the PHASES grid, top to bottom
//   "issues": [                        // every issue of the factory, from the GitHub facts delivered
//                                      // (never from the dashboard's tables or payloads)
//     { "number": 12, "title": "Serve the app", "phase": "Skeleton" | null,
//       "state": "waiting|claimed|pr-open|needs-owner|merged|closed", "depends_on": [3, 4] } ],
//   "drawn_nodes": [                   // every issue node on screen (scroll the panel to find them all)
//     { "number": 12, "column": "Skeleton" | "No phase", "x": 0, "y": 0, "w": 160, "h": 48,
//       "number_shown": true, "title_shown": "Serve the app", "state_shown": "waiting",
//       "highlighted": false } ],
//   "drawn_edges": [ { "from": 3, "to": 12 } ],  // from = the issue depended on, to = the dependent
//   "column_order": ["Skeleton", "...", "No phase"],   // columns left to right as drawn
//   "phase_counts": [ { "phase": "Skeleton", "merged_shown": 12 } ],  // the collapsed counts shown
//   "hidden_count_shown": 5 | null,    // "N more open issues not shown", null if the view says nothing
//   "page_scroll_width": 1920, "page_client_width": 1920,     // document.scrollingElement
//   "graph_scroll_width": 1800, "graph_client_width": 1800    // the graph panel's own box
// }
// Rules judged (owner, 2026-10-27):
// - default view: every open issue (waiting, claimed, PR open, needs owner) is drawn, up to the cap; a
//   merged or closed issue is drawn only as a direct dependency of a drawn open issue, otherwise it is
//   only counted; no more than `cap` nodes; when open issues exceed what is drawn, the hidden count is
//   shown and equals the open issues not drawn; no hidden open issue is closer to merge than a drawn
//   one (PR open, then claimed, then waiting with every dependency closed, then waiting with an open
//   dependency; needs owner is not ranked).
// - each phase's merged count equals its merged issues (both views may show it; the default must).
// - columns follow the PHASES grid order, "No phase" last; each node sits in its own phase's column.
// - an edge exists for every dependency between two drawn issues, and none is invented or dangling;
//   every edge runs left to right (dependency in an earlier column) or top to bottom (same column,
//   dependency above). Edges inside a dependency cycle and edges from a later phase back to an earlier
//   one cannot obey this and are not judged for direction.
// - the highlighted nodes are exactly one longest chain of open issues (counted in issues), when that
//   chain is wholly drawn.
// - at 1920 px wide the default view has no horizontal scrolling, on the page or inside the panel.
// - show-merged: every issue is drawn, merged ones in their merged state.
import { readFileSync } from "node:fs";

const out = (verdict, reasons) => {
  console.log(verdict);
  for (const r of reasons) console.log(`- ${r}`);
  process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 2);
};

let rec;
try {
  rec = JSON.parse(readFileSync(process.argv[2], "utf8"));
} catch (e) {
  out("INCONCLUSIVE", [`cannot read record: ${e.message}`]);
}

const fails = [];
const notes = [];
const OPEN = new Set(["waiting", "claimed", "pr-open", "needs-owner"]);
const issues = new Map((rec.issues ?? []).map((i) => [i.number, { ...i, depends_on: i.depends_on ?? [] }]));
if (issues.size === 0) out("INCONCLUSIVE", ["no source issues recorded"]);
const nodes = new Map();
for (const n of rec.drawn_nodes ?? []) {
  if (nodes.has(n.number)) fails.push(`#${n.number} is drawn more than once`);
  nodes.set(n.number, n);
}
const isOpen = (k) => OPEN.has(issues.get(k)?.state);
const open = [...issues.values()].filter((i) => OPEN.has(i.state));
const colOf = (i) => i.phase ?? "No phase";

// cycles: Tarjan over every issue
const inCycle = new Set();
{
  let idx = 0; const st = []; const on = new Set(); const ix = new Map(); const low = new Map();
  const visit = (v) => {
    ix.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of issues.get(v).depends_on) {
      if (!issues.has(w)) continue;
      if (!ix.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w)));
    }
    if (low.get(v) === ix.get(v)) {
      const comp = []; let w;
      do { w = st.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || issues.get(v).depends_on.includes(v)) for (const c of comp) inCycle.add(c);
    }
  };
  for (const k of issues.keys()) if (!ix.has(k)) visit(k);
}

// node facts
for (const [k, n] of nodes) {
  const i = issues.get(k);
  if (!i) { fails.push(`#${k} is drawn but is not an issue of this factory`); continue; }
  if (n.state_shown !== i.state) fails.push(`#${k} is drawn as ${n.state_shown}, it is ${i.state}`);
  if (!n.number_shown) fails.push(`#${k} does not show its number`);
  const shown = String(n.title_shown ?? "").replace(/(…|\.\.\.)\s*$/, "").trim();
  if (!shown) fails.push(`#${k} shows no title`);
  else if (!i.title.toLowerCase().startsWith(shown.toLowerCase())) notes.push(`#${k} title shown "${n.title_shown}" is not a shortening of "${i.title}"; judge by eye`);
  if (n.column !== colOf(i)) fails.push(`#${k} sits in column ${n.column}, its phase is ${colOf(i)}`);
}

// columns
const grid = rec.phases_grid_order ?? [];
const cols = rec.column_order ?? [];
const gridCols = cols.filter((c) => c !== "No phase");
let last = -1;
for (const c of gridCols) {
  const p = grid.indexOf(c);
  if (p < 0) fails.push(`column ${c} is not a phase on the PHASES grid`);
  else if (p < last) fails.push(`column ${c} is out of the PHASES grid's order`);
  else last = p;
}
if (cols.includes("No phase") && cols[cols.length - 1] !== "No phase") fails.push(`"No phase" is not the last column`);
for (const n of nodes.values()) if (!cols.includes(n.column)) fails.push(`#${n.number}'s column ${n.column} is not in the recorded column order`);

// counts
const counts = new Map((rec.phase_counts ?? []).map((c) => [c.phase, c.merged_shown]));
const mergedBy = new Map();
for (const i of issues.values()) if (i.state === "merged") mergedBy.set(colOf(i), (mergedBy.get(colOf(i)) ?? 0) + 1);
for (const [ph, m] of mergedBy) {
  if (!counts.has(ph)) { if (rec.view === "default") fails.push(`phase ${ph} has ${m} merged issues but shows no merged count`); continue; }
  if (counts.get(ph) !== m) fails.push(`phase ${ph} shows ${counts.get(ph)} merged, it has ${m}`);
}
for (const [ph, c] of counts) if (!mergedBy.has(ph) && c !== 0) fails.push(`phase ${ph} shows ${c} merged, it has none`);

// edges
const edges = new Set((rec.drawn_edges ?? []).map((e) => `${e.from}>${e.to}`));
for (const e of rec.drawn_edges ?? []) {
  if (!nodes.has(e.from) || !nodes.has(e.to)) { fails.push(`edge #${e.from} to #${e.to} has an end that is not drawn`); continue; }
  if (!issues.get(e.to)?.depends_on.includes(e.from)) { fails.push(`edge #${e.from} to #${e.to} is no Depends on line`); continue; }
  const a = nodes.get(e.from); const b = nodes.get(e.to);
  if (inCycle.has(e.from) && inCycle.has(e.to)) continue;
  const ca = cols.indexOf(a.column); const cb = cols.indexOf(b.column);
  if (ca > cb) { notes.push(`edge #${e.from} to #${e.to} runs from a later phase back to an earlier one: direction exempt`); continue; }
  if (ca < cb) continue;
  if (!(a.y + (a.h ?? 0) / 2 < b.y + (b.h ?? 0) / 2)) fails.push(`edge #${e.from} to #${e.to} runs upward inside column ${a.column}`);
}
for (const [k, i] of issues) for (const d of i.depends_on)
  if (nodes.has(k) && nodes.has(d) && d !== k && !edges.has(`${d}>${k}`)) fails.push(`#${k} depends on #${d}, both drawn, but no edge joins them`);

if (rec.view === "default") {
  const drawnOpen = open.filter((i) => nodes.has(i.number));
  const hidden = open.filter((i) => !nodes.has(i.number));
  for (const [k] of nodes) {
    if (isOpen(k) || !issues.has(k)) continue;
    const dependents = open.filter((o) => nodes.has(o.number) && o.depends_on.includes(k));
    if (dependents.length === 0) fails.push(`#${k} (${issues.get(k).state}) is drawn in the default view though no drawn open issue depends on it`);
  }
  const cap = rec.cap ?? 40;
  if (nodes.size > cap) fails.push(`default view draws ${nodes.size} nodes, over the cap of ${cap}`);
  if (hidden.length > 0) {
    if (drawnOpen.length < Math.min(cap, open.length) && nodes.size < cap) fails.push(`${hidden.length} open issues are missing though the cap is not reached`);
    if (rec.hidden_count_shown !== hidden.length) fails.push(`the view says ${rec.hidden_count_shown ?? "nothing"} hidden, ${hidden.length} open issues are not drawn`);
    const rank = (i) => {
      if (i.state === "pr-open") return 0;
      if (i.state === "claimed") return 1;
      if (i.state === "waiting") return i.depends_on.every((d) => !isOpen(d)) ? 2 : 3;
      return null;
    };
    const worstDrawn = Math.max(...drawnOpen.map(rank).filter((r) => r != null), -1);
    for (const h of hidden) { const r = rank(h); if (r != null && r < worstDrawn) fails.push(`#${h.number} (${h.state}) is hidden while a further-from-merge issue is drawn`); }
  } else if (rec.hidden_count_shown) fails.push(`the view says ${rec.hidden_count_shown} hidden, but every open issue is drawn`);

  // longest open chain, on the open issues outside cycles
  const memo = new Map();
  const longest = (k) => {
    if (memo.has(k)) return memo.get(k);
    let best = [k];
    for (const d of issues.get(k).depends_on) if (isOpen(d) && !inCycle.has(d) && issues.has(d)) { const p = longest(d); if (p.length + 1 > best.length) best = [...p, k]; }
    memo.set(k, best); return best;
  };
  let L = 0; let chain = [];
  for (const o of open) if (!inCycle.has(o.number)) { const p = longest(o.number); if (p.length > L) { L = p.length; chain = p; } }
  const hl = [...nodes.values()].filter((n) => n.highlighted).map((n) => n.number);
  if (L > 1 && chain.every((c) => nodes.has(c))) {
    const hs = new Set(hl);
    if (hl.length !== L) fails.push(`highlighted ${hl.length} issues; the longest open chain has ${L} (e.g. ${chain.map((c) => `#${c}`).join(" > ")})`);
    else {
      const m2 = new Map();
      const lp = (k) => { if (m2.has(k)) return m2.get(k); let b = 1; for (const d of issues.get(k).depends_on) if (hs.has(d) && d !== k) b = Math.max(b, lp(d) + 1); m2.set(k, b); return b; };
      if (Math.max(...hl.map(lp)) !== L) fails.push("the highlighted issues are not one chain of dependencies");
      if (hl.some((k) => !isOpen(k))) fails.push("a highlighted issue is not open");
    }
  } else if (L > 1) notes.push("the longest open chain is not wholly drawn: highlight not judged");

  if (rec.viewport_width === 1920) {
    if (rec.page_scroll_width > rec.page_client_width + 1) fails.push(`the page scrolls sideways at 1920 px (${rec.page_scroll_width} > ${rec.page_client_width})`);
    if (rec.graph_scroll_width > rec.graph_client_width + 1) fails.push(`the graph scrolls sideways at 1920 px (${rec.graph_scroll_width} > ${rec.graph_client_width})`);
  }
} else if (rec.view === "show-merged") {
  for (const i of issues.values()) if (!nodes.has(i.number)) fails.push(`Show merged leaves out #${i.number} (${i.state})`);
} else out("INCONCLUSIVE", ["view not recorded"]);

if (fails.length) out("FAIL", [...fails, ...notes]);
if (notes.some((n) => n.includes("not judged") || n.includes("judge by eye"))) out("INCONCLUSIVE", ["nothing failed, but:", ...notes]);
out("PASS", [`${nodes.size} nodes and ${edges.size} edges judged in the ${rec.view} view`]);
