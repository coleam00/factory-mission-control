// Judge for H-32, H-33, H-34 and H-35: Archon's own writes always commit within their bound whatever
// the dashboard's tables are doing, and the dashboard repairs itself afterwards without touching Archon.
//
// Run: bun .factory/holdout/judges/archon-writes.js <record.json> [archon|repair]
// With no part, both parts are judged. The two parts report separately: an "ARCHON WRITE FAILED" line
// is a failure of invariant 1 in its own right, whatever the dashboard shows afterwards.
//
// Record shape:
// {
//   "bound_ms": 2000,                                  // optional; the statement_timeout used (default 2000)
//   "dashboard_tables": ["mc.laps", ...],              // every table the repository's migrations created
//   "archon_triggers": [ { "table": "remote_agent_workflow_runs", "ops": ["INSERT","UPDATE"] } ],
//                                                      // every dashboard trigger found on Archon's tables
//   "attempts": [
//     { "kind": "run_status_update",                  // see REQUIRED_KINDS below, or any other label
//       "archon_table": "remote_agent_workflow_runs", "op": "UPDATE",
//       "lock": { "mode": "access_exclusive" | "row" | "open_tx_row_update", "table": "mc.laps",
//                 "held_confirmed": true },           // pg_locks showed the lock granted to the other session
//       "tx": "autocommit" | "transaction",           // transaction = several Archon statements in one BEGIN..COMMIT
//       "committed": true, "error": null | "text of any error Archon's session received",
//       "elapsed_ms": 35,
//       "reads_back": true }                           // after commit, Archon's row reads exactly as written
//   ],
//   "repair": {                                        // H-33 / H-34 / H-35
//     "tracked_runs": [ { "id": "...", "workflow_name": "archon-loop", "archon_status": "completed" } ],
//     "projection_errors_before": 3, "projection_errors_after_lock": 9,
//     "lanes_after_release": ["run ids on the lanes after the lock was released, before repair"],
//     "repair_ran": true, "repair_exit_code": 0,
//     "lanes_after_repair": ["run ids on the lanes after repair"],
//     "recent_laps_after_repair": ["run ids listed on recent laps after repair"],
//     "lanes_after_second_repair": ["run ids after running the repair a second time"],
//     "lanes_after_restart": ["run ids after serve was restarted"],
//     "archon_unchanged_by_repair": true               // Archon's rows, counts and latest timestamps identical
//   }
// }
import { readFileSync } from "node:fs";

const REQUIRED_KINDS = [
  "run_insert_new_digest", // a new archon-loop run whose digest no version has yet
  "run_insert_known_digest",
  "run_status_update", // running -> completed, with completed_at
  "run_status_failed", // running -> failed
  "run_other_update", // an update that does not change status (metadata or updated_at only)
  "node_started",
  "node_completed",
  "node_failed",
  "node_skipped",
  "provider_event",
];
// Kinds that must also be tried under a row lock and inside a multi-statement transaction.
const DEEP_KINDS = ["run_status_update", "node_completed"];

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
const part = process.argv[3] ?? "both";
const fails = [];
const gaps = [];

if (part === "archon" || part === "both") {
  const bound = rec.bound_ms ?? 2000;
  const tables = rec.dashboard_tables ?? [];
  const attempts = rec.attempts ?? [];
  if (tables.length === 0) gaps.push("no dashboard tables recorded");
  if (attempts.length === 0) gaps.push("no Archon write attempts recorded");

  for (const a of attempts) {
    const tag = `${a.kind} (${a.archon_table} ${a.op}, ${a.tx ?? "?"}) with ${a.lock?.mode ?? "?"} lock on ${a.lock?.table ?? "?"}`;
    if (a.lock && a.lock.held_confirmed !== true) {
      gaps.push(`${tag}: lock not confirmed held, attempt not judged`);
      continue;
    }
    if (a.committed !== true) fails.push(`ARCHON WRITE FAILED: ${tag} did not commit${a.error ? `: ${a.error}` : ""}`);
    else if (a.error) fails.push(`ARCHON WRITE FAILED: ${tag} committed but Archon's session received: ${a.error}`);
    if (typeof a.elapsed_ms !== "number") gaps.push(`${tag}: elapsed_ms not recorded`);
    else if (a.elapsed_ms > bound) fails.push(`ARCHON WRITE FAILED: ${tag} took ${a.elapsed_ms} ms (bound ${bound})`);
    if (a.committed === true && a.reads_back !== true)
      fails.push(`ARCHON WRITE FAILED: ${tag} committed but Archon's row does not read back as written`);
  }

  const judged = attempts.filter((a) => a.lock?.held_confirmed === true);
  const has = (pred) => judged.some(pred);
  for (const t of tables)
    for (const k of REQUIRED_KINDS)
      if (!has((a) => a.kind === k && a.lock.table === t && a.lock.mode === "access_exclusive"))
        gaps.push(`not covered: ${k} under an access exclusive lock on ${t}`);
  for (const k of DEEP_KINDS) {
    if (!has((a) => a.kind === k && a.lock.mode === "row")) gaps.push(`not covered: ${k} under a row lock on its dashboard row`);
    if (!has((a) => a.kind === k && a.lock.mode === "open_tx_row_update"))
      gaps.push(`not covered: ${k} while another transaction holds an uncommitted update of its dashboard row`);
    if (!has((a) => a.kind === k && a.tx === "transaction")) gaps.push(`not covered: ${k} inside a multi-statement transaction`);
  }
  const triggers = rec.archon_triggers;
  if (!Array.isArray(triggers)) gaps.push("dashboard triggers on Archon's tables not recorded");
  else
    for (const tr of triggers)
      for (const op of tr.ops ?? [])
        for (const t of tables)
          if (!has((a) => a.archon_table === tr.table && String(a.op).toUpperCase() === String(op).toUpperCase() && a.lock.table === t))
            gaps.push(`not covered: a ${op} on ${tr.table} (a dashboard trigger reacts to it) under a lock on ${t}`);
}

if (part === "repair" || part === "both") {
  const r = rec.repair;
  if (!r) gaps.push("repair not recorded");
  else {
    const loop = (r.tracked_runs ?? []).filter((x) => x.workflow_name === "archon-loop");
    if (loop.length === 0) gaps.push("no tracked archon-loop runs");
    const running = new Set(loop.filter((x) => x.archon_status === "running").map((x) => x.id));
    const finished = loop.filter((x) => x.archon_status !== "running" && x.archon_status !== "pending" && x.archon_status !== "paused");
    const tracked = new Set(loop.map((x) => x.id));
    const lanesMatch = (label, ids) => {
      if (!Array.isArray(ids)) {
        gaps.push(`${label}: lanes not recorded`);
        return;
      }
      const shown = new Set(ids.filter((id) => tracked.has(id)));
      for (const id of shown) if (!running.has(id)) fails.push(`DASHBOARD: ${label}: run ${id} is on the lanes but Archon says it is not running`);
      for (const id of running) if (!shown.has(id)) fails.push(`DASHBOARD: ${label}: run ${id} is running in Archon but has no lane`);
    };

    const stale = Array.isArray(r.lanes_after_release)
      ? loop.filter((x) => r.lanes_after_release.includes(x.id) !== running.has(x.id))
      : [];
    if (!Array.isArray(r.lanes_after_release)) gaps.push("lanes after release not recorded");
    const added = Number(r.projection_errors_after_lock ?? NaN) - Number(r.projection_errors_before ?? NaN);
    if (Number.isNaN(added)) gaps.push("projection_errors counts not recorded");
    else if (stale.length > 0 && added <= 0)
      fails.push(`DASHBOARD: ${stale.length} lap(s) left wrong on the lanes after the lock and no projection error recorded (silent loss)`);

    if (r.repair_ran !== true) gaps.push("repair was not run");
    else {
      if (r.repair_exit_code !== 0) fails.push(`DASHBOARD: repair exited ${r.repair_exit_code}`);
      lanesMatch("after repair", r.lanes_after_repair);
      lanesMatch("after a second repair", r.lanes_after_second_repair);
      lanesMatch("after a serve restart", r.lanes_after_restart);
      if (!Array.isArray(r.recent_laps_after_repair)) gaps.push("recent laps after repair not recorded");
      else for (const x of finished) if (!r.recent_laps_after_repair.includes(x.id)) fails.push(`DASHBOARD: finished run ${x.id} missing from recent laps after repair`);
      if (r.archon_unchanged_by_repair === false) fails.push("ARCHON WRITE FAILED: the repair changed Archon's tables");
      else if (r.archon_unchanged_by_repair !== true) gaps.push("archon_unchanged_by_repair not recorded");
    }
  }
}

if (fails.length) out("FAIL", [...fails, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", ["every Archon write committed within its bound under every lock, and the dashboard repaired itself"]);
