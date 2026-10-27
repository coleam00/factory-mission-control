// Judge for H-19, per the live-panel speed rule in engineering.md (owner decision on #137/#141):
// - every live query's EXPLAIN ANALYZE execution on the seed under 100 ms;
// - on every recorded run, every panel ready within 2000 ms of navigation (this bound alone covers
//   everything between the subscribe and the first snapshot, which is Neon's);
// - on every recorded run, every panel's rows on screen within 500 ms of its first snapshot arriving.
//
// Record shape (all panel times in ms from navigation):
// {
//   "queries": [ { "name": "live-counts", "explain_execution_ms": 3.2 } ],   // EXPLAIN ANALYZE "Execution Time" on the seed
//   "runs": [
//     { "width": 1440,
//       "panels": [ { "name": "map", "ready_ms": 812,                       // null if it never became ready
//                     "first_snapshot_ms": 640,                             // null if no snapshot arrived
//                     "rows_ms": 700 } ] }                                  // null if rows never showed
//   ]
// }
import { readFileSync } from "node:fs";

const EXPLAIN_MS = 100; // strictly under
const READY_MS = 2000; // within, from navigation
const RENDER_MS = 500; // within, from the first snapshot arriving
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
const gaps = [];
const num = (v) => typeof v === "number" && Number.isFinite(v);

const queries = rec.queries ?? [];
if (queries.length === 0) gaps.push("no live query EXPLAIN ANALYZE timings recorded");
for (const q of queries) {
  if (!num(q.explain_execution_ms)) gaps.push(`query ${q.name}: no EXPLAIN ANALYZE execution time`);
  else if (q.explain_execution_ms >= EXPLAIN_MS)
    fails.push(`query ${q.name}: EXPLAIN ANALYZE execution ${q.explain_execution_ms} ms (must be under ${EXPLAIN_MS} ms)`);
}

const runs = rec.runs ?? [];
if (runs.length === 0) gaps.push("no runs recorded");
for (const w of [1440, 390]) if (!runs.some((r) => r.width === w)) gaps.push(`no run at ${w} px`);
runs.forEach((run, i) => {
  const tag = `run ${i + 1} (${run.width} px)`;
  if (!run.panels?.length) gaps.push(`${tag}: no panels recorded`);
  for (const p of run.panels ?? []) {
    if (p.ready_ms == null) fails.push(`${tag}: panel ${p.name} never reached ready`);
    else if (!num(p.ready_ms)) gaps.push(`${tag}: panel ${p.name} ready time unreadable`);
    else if (p.ready_ms > READY_MS)
      fails.push(`${tag}: panel ${p.name} ready ${p.ready_ms} ms after navigation (limit ${READY_MS} ms)`);

    if (p.first_snapshot_ms == null) {
      fails.push(`${tag}: panel ${p.name} never received a first snapshot`);
      continue;
    }
    if (!num(p.first_snapshot_ms)) {
      gaps.push(`${tag}: panel ${p.name} first snapshot time unreadable`);
      continue;
    }
    if (p.rows_ms == null) {
      fails.push(`${tag}: panel ${p.name} never put its rows on screen`);
      continue;
    }
    if (!num(p.rows_ms)) {
      gaps.push(`${tag}: panel ${p.name} rows time unreadable`);
      continue;
    }
    const render = p.rows_ms - p.first_snapshot_ms;
    if (render < 0) gaps.push(`${tag}: panel ${p.name} rows recorded before its first snapshot arrived`);
    else if (render > RENDER_MS)
      fails.push(`${tag}: panel ${p.name} rows on screen ${render} ms after its first snapshot (limit ${RENDER_MS} ms)`);
  }
});

if (fails.length) out("FAIL", fails);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [
  `${queries.length} queries: EXPLAIN ANALYZE execution under ${EXPLAIN_MS} ms`,
  `${runs.length} runs: all panels ready within ${READY_MS} ms of navigation, rows on screen within ${RENDER_MS} ms of the first snapshot`,
]);
