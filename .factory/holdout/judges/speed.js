// Judge for H-19: every home-screen panel ready within 2000 ms, every live query's first snapshot
// within 500 ms, on every recorded run.
//
// Record shape:
// {
//   "runs": [
//     { "width": 1440,
//       "panels":  [ { "name": "map", "ready_ms": 812 } ],          // null if it never became ready
//       "queries": [ { "name": "live-counts", "first_snapshot_ms": 140 } ] }
//   ]
// }
import { readFileSync } from "node:fs";

const READY_MS = 2000;
const SNAPSHOT_MS = 500;
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
const runs = rec.runs ?? [];
if (runs.length === 0) gaps.push("no runs recorded");
for (const w of [1440, 390]) if (!runs.some((r) => r.width === w)) gaps.push(`no run at ${w} px`);
runs.forEach((run, i) => {
  const tag = `run ${i + 1} (${run.width} px)`;
  if (!run.panels?.length) gaps.push(`${tag}: no panels recorded`);
  if (!run.queries?.length) gaps.push(`${tag}: no live queries recorded`);
  for (const p of run.panels ?? []) {
    if (p.ready_ms == null) fails.push(`${tag}: panel ${p.name} never reached ready`);
    else if (p.ready_ms > READY_MS) fails.push(`${tag}: panel ${p.name} ready at ${p.ready_ms} ms`);
  }
  for (const q of run.queries ?? []) {
    if (q.first_snapshot_ms == null) fails.push(`${tag}: query ${q.name} never delivered a snapshot`);
    else if (q.first_snapshot_ms > SNAPSHOT_MS)
      fails.push(`${tag}: query ${q.name} first snapshot at ${q.first_snapshot_ms} ms`);
  }
});

if (fails.length) out("FAIL", fails);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [`${runs.length} runs: all panels ready within ${READY_MS} ms, all snapshots within ${SNAPSHOT_MS} ms`]);
