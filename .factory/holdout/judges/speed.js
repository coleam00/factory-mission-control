// Judge for H-19: a live panel's speed is judged in two parts (owner decision on #13/#14, engineering.md):
//   1. every live query's first snapshot within 500 ms of THAT query's panel subscribe being sent
//      (the app's own query and render work), and
//   2. every panel `data-state="ready"` within 2000 ms of page navigation (Realtime connection setup).
// Both must hold on every recorded run, at both widths.
//
// Record shape. Every time is in ms on ONE clock: milliseconds since navigation start of that run
// (performance.now() in the page). The judge computes the snapshot delta itself.
// {
//   "runs": [
//     { "width": 1440,
//       "panels":  [ { "name": "map", "ready_ms": 1812 } ],
//       "queries": [ { "name": "map-steps", "panel": "map",
//                      "subscribe_sent_ms": 1490,          // when this panel's subscribe left the browser
//                      "first_snapshot_ms": 1531 } ] }     // when its first snapshot was rendered
//   ]
// }
// A timing that never happened is recorded as null and FAILS (never ready, never delivered).
// A timing that is absent (field missing) was not measured: the record is INCONCLUSIVE, never PASS.
import { readFileSync } from "node:fs";

const READY_MS = 2000; // from navigation
const SNAPSHOT_MS = 500; // from the panel's own subscribe being sent
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
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const runs = rec.runs ?? [];
if (runs.length === 0) gaps.push("no runs recorded");
for (const w of [1440, 390]) if (!runs.some((r) => r.width === w)) gaps.push(`no run at ${w} px`);
runs.forEach((run, i) => {
  const tag = `run ${i + 1} (${run.width} px)`;
  if (!run.panels?.length) gaps.push(`${tag}: no panels recorded`);
  if (!run.queries?.length) gaps.push(`${tag}: no live queries recorded`);
  const panelNames = new Set((run.panels ?? []).map((p) => p.name));

  // Part 2: ready, timed from navigation.
  for (const p of run.panels ?? []) {
    if (!has(p, "ready_ms")) gaps.push(`${tag}: panel ${p.name} has no ready time recorded`);
    else if (p.ready_ms === null) fails.push(`${tag}: panel ${p.name} never reached ready`);
    else if (!isNum(p.ready_ms)) gaps.push(`${tag}: panel ${p.name} ready time is not a number`);
    else if (p.ready_ms > READY_MS)
      fails.push(`${tag}: panel ${p.name} ready at ${p.ready_ms} ms from navigation (limit ${READY_MS})`);
  }

  // Part 1: first snapshot, timed from that panel's own subscribe being sent.
  for (const q of run.queries ?? []) {
    const qt = `${tag}: query ${q.name}`;
    if (!has(q, "panel") || !panelNames.has(q.panel)) {
      gaps.push(`${qt} is not tied to a recorded panel`);
      continue;
    }
    if (!has(q, "subscribe_sent_ms")) {
      gaps.push(`${qt} has no subscribe-sent time recorded`);
      continue;
    }
    if (!has(q, "first_snapshot_ms")) {
      gaps.push(`${qt} has no first-snapshot time recorded`);
      continue;
    }
    if (q.first_snapshot_ms === null) {
      fails.push(`${qt} never delivered a snapshot`);
      continue;
    }
    if (q.subscribe_sent_ms === null) {
      fails.push(`${qt} never sent its subscribe`);
      continue;
    }
    if (!isNum(q.subscribe_sent_ms) || !isNum(q.first_snapshot_ms)) {
      gaps.push(`${qt} timings are not numbers`);
      continue;
    }
    const delta = q.first_snapshot_ms - q.subscribe_sent_ms;
    if (delta < 0) {
      gaps.push(`${qt} snapshot recorded before its subscribe was sent: timings are not on one clock`);
      continue;
    }
    if (delta > SNAPSHOT_MS)
      fails.push(`${qt} first snapshot ${delta} ms after its subscribe was sent (limit ${SNAPSHOT_MS})`);
  }
});

if (fails.length) out("FAIL", fails);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [
  `${runs.length} runs: all panels ready within ${READY_MS} ms of navigation, all first snapshots within ${SNAPSHOT_MS} ms of their panel's subscribe`,
]);
