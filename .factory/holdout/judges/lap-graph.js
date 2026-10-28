// Judge for H-59..H-65 (owner requirement 2026-10-27, a lap's progress as a graph): every step a lap
// ran is in its graph with the mark its last attempt earns, every step of the map at the lap's pin is
// drawn, nothing is invented, the side panel tells each attempt's own facts, and each running lap's
// lane row shows the loop's top-level steps in order with the right marks.
//
// Record shape (one file per observation; an observation is one moment of one lap's page and/or lane):
// {
//   "run_status": "running|completed|failed",          // the run's status in Archon at the moment
//   "source_steps": [                                  // from Archon's own event rows for this run, read
//                                                      // independently (never from the dashboard's tables)
//     { "key": "archon-loop>ship>archon-ship-block>implement",  // include path, outermost first
//       "attempts": [                                  // in the order Archon recorded them
//         { "event": "completed|failed|skipped|started",   // the attempt's last step-level event
//           "started_at": "ISO or null", "duration_ms": 1234, "model": "sonnet",
//           "tokens": 5123, "cost_usd": 0.42 } ] } ],
//   "pinned_map_keys": ["archon-loop>pick", "..."],    // every step the MAP shows at the lap's pin, read
//                                                      // from the map screen at that version; null when
//                                                      // the lap's pin has no parsed architecture
//   "graph": {                                         // null when the lap page has no graph
//     "state": "ready",                                // the graph panel's data-state
//     "nodes": [
//       { "key": "<the include path it stands for, as the verifier matched it>",
//         "mark": "finished|running|failed|skipped|not-reached|other",
//         "elapsed_shown": true,                       // a running step shows its elapsed time
//         "clickable": true,
//         "panel": null | {                            // what the side panel showed after clicking it
//           "attempts": [ { "started_at": "ISO as shown, to the minute at least", "duration_ms": 1200,
//                           "model": "sonnet", "tokens": 5100, "cost_usd": 0.42 } ],
//           "attempt_count_shown": 2 } } ] },
//   "sections": { "review": true, "merge_gate": true, "app_check": true },  // still on the lap page
//   "lane": null | {                                   // the lap's card on LAPS > LANES, if recorded
//     "marks": [ { "step": "pick", "mark": "check|pulsing|dim|failed" } ] }
// }
// Numbers shown rounded are recorded as the number the screen means: durations within 1 s or 2%,
// tokens within 1% (a "5.1k" display), cost within 0.01 USD, start times within 60 s.
// Mark rules (owner, 2026-10-27): last attempt completed = finished; failed = failed; skipped (route or
// depth did not need it) = skipped; started with no end while the run is running = running; no
// step-level event at all = not-reached. A finished run with a step started but never ended is
// recorded as event "started": any mark but finished and running is accepted for it.
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

const TOP = ["pick", "claim", "build/ship", "subject", "briefs", "check-app", "evidence", "handoff", "review", "land", "deploy", "release"];
const fails = [];
const notes = [];
const src = rec.source_steps ?? [];
const running = rec.run_status === "running";

const expectedMark = (s) => {
  const ran = (s.attempts ?? []).filter((a) => a.event);
  if (ran.length === 0) return "not-reached";
  const last = ran[ran.length - 1].event;
  if (last === "completed") return "finished";
  if (last === "failed") return "failed";
  if (last === "skipped") return "skipped";
  if (last === "started") return running ? "running" : "stale";
  return "unknown";
};
const near = (a, b, abs, rel) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= Math.max(abs, Math.abs(Number(b)) * rel);
const t = (x) => (x ? Date.parse(x) : NaN);

if (!rec.run_status) out("INCONCLUSIVE", ["run_status not recorded"]);
if (rec.graph == null && rec.lane == null) out("INCONCLUSIVE", ["neither a graph nor a lane recorded"]);

if (rec.graph != null) {
  const g = rec.graph;
  if (g.state !== "ready") fails.push(`graph panel is ${g.state}, not ready`);
  const nodes = new Map();
  for (const n of g.nodes ?? []) {
    if (nodes.has(n.key)) fails.push(`step drawn twice in one place: ${n.key}`);
    nodes.set(n.key, n);
  }
  const srcKeys = new Set(src.map((s) => s.key));
  const mapKeys = rec.pinned_map_keys == null ? null : new Set(rec.pinned_map_keys);
  if (mapKeys == null) notes.push("no map at the lap's pin recorded: layout parity not judged");
  for (const k of mapKeys ?? []) if (!nodes.has(k)) fails.push(`step on the map at the lap's pin is missing from the lap graph: ${k}`);
  for (const k of nodes.keys())
    if (!srcKeys.has(k) && !(mapKeys?.has(k))) fails.push(`graph shows a step that is neither on the pinned map nor in the lap's events: ${k}`);
  for (const s of src) {
    const exp = expectedMark(s);
    const n = nodes.get(s.key);
    const ran = (s.attempts ?? []).some((a) => a.event);
    if (!n) {
      if (ran) fails.push(`step the lap ran is not reachable in the graph: ${s.key}`);
      else if (mapKeys == null) fails.push(`step not drawn: ${s.key}`);
      continue;
    }
    if (exp === "stale") {
      if (n.mark === "finished" || n.mark === "running") fails.push(`${s.key}: run ended with this step never finished, but it is drawn ${n.mark}`);
    } else if (n.mark !== exp) fails.push(`${s.key}: drawn ${n.mark}, its last attempt makes it ${exp}`);
    if (exp === "running" && !n.elapsed_shown) fails.push(`${s.key}: running but shows no elapsed time`);
    if (!ran) continue;
    if (!n.clickable) { fails.push(`${s.key}: ran but cannot be clicked for its details`); continue; }
    if (!n.panel) { fails.push(`${s.key}: no side panel recorded after clicking it`); continue; }
    const real = s.attempts.filter((a) => a.event && a.event !== "skipped");
    const shown = n.panel.attempts ?? [];
    if (real.length && n.panel.attempt_count_shown !== real.length) fails.push(`${s.key}: panel says ${n.panel.attempt_count_shown} attempts, Archon recorded ${real.length}`);
    const used = new Set();
    for (const a of real) {
      const i = shown.findIndex((b, j) => !used.has(j)
        && (a.started_at == null || Math.abs(t(b.started_at) - t(a.started_at)) <= 60000)
        && (a.duration_ms == null || near(b.duration_ms, a.duration_ms, 1000, 0.02))
        && (a.model == null || b.model === a.model)
        && (a.tokens == null || near(b.tokens, a.tokens, 0, 0.01))
        && (a.cost_usd == null || near(b.cost_usd, a.cost_usd, 0.01, 0)));
      if (i < 0) fails.push(`${s.key}: an attempt started ${a.started_at} (${a.model}, ${a.tokens} tokens, $${a.cost_usd}) is not shown with its own facts`);
      else used.add(i);
    }
  }
  for (const [k, n] of nodes) if (!srcKeys.has(k) && n.mark !== "not-reached") fails.push(`${k}: no event in this lap, but drawn ${n.mark}`);
  for (const sec of ["review", "merge_gate", "app_check"]) if (!rec.sections?.[sec]) fails.push(`lap page lost its ${sec} section`);
}

if (rec.lane != null) {
  const marks = rec.lane.marks ?? [];
  const names = marks.map((m) => m.step);
  if (JSON.stringify(names) !== JSON.stringify(TOP)) fails.push(`lane row is [${names.join(", ")}], not the loop's top-level steps in order`);
  const laterStarted = (idx) => TOP.slice(idx + 1).some((id) =>
    src.some((s) => s.key === `archon-loop>${id}` && (s.attempts ?? []).some((a) => a.event && a.event !== "skipped")));
  const state = (id) => {
    if (id === "build/ship") {
      const group = src.filter((s) => /^archon-loop>(build|ship)(>|$)/.test(s.key));
      const ms = group.map(expectedMark);
      if (ms.includes("running")) return "running";
      if (!ms.some((m) => m !== "not-reached" && m !== "skipped")) return "not-reached";
      if (ms.includes("finished") && laterStarted(TOP.indexOf("build/ship"))) return "finished";
      if (ms[ms.length - 1] === "failed") return "failed";
      return "partial";
    }
    const s = src.find((x) => x.key === `archon-loop>${id}`);
    return s ? expectedMark(s) : "not-reached";
  };
  for (const m of marks) {
    if (!TOP.includes(m.step)) continue;
    const st = state(m.step);
    const ok = st === "finished" ? m.mark === "check"
      : st === "running" ? m.mark === "pulsing"
      : st === "partial" ? m.mark === "check" || m.mark === "dim"
      : st === "failed" || st === "stale" ? m.mark === "dim" || m.mark === "failed"
      : m.mark === "dim";
    if (!ok) fails.push(`lane mark for ${m.step} is ${m.mark}, the step is ${st}`);
  }
}

if (fails.length) out("FAIL", [...fails, ...notes]);
if (notes.length) out("INCONCLUSIVE", ["nothing failed, but:", ...notes]);
out("PASS", [`${src.length} source steps judged${rec.lane ? " and the lane row" : ""}`]);
