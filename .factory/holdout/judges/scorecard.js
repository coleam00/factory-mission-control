// Judge for H-04 and H-05: recompute every scorecard measure from Archon's own rows with the PRD 4.2
// definitions, compare with what the screen shows, and check the "not yet meaningful" rule.
//
// Record shape:
// {
//   "factory_codebase": "the factory's Archon codebase name",
//   "runs":  [ { "id", "workflow_name", "codebase", "status", "started_at", "completed_at", "digest" } ],
//   "steps": [ { "run_id", "step_name", "event_type", "structured_output", "cost_usd", "duration_ms" } ],
//   "app_check_lines": [ { "run_id", "kind", "verdict", "pre_existing" } ],
//   "shown": {
//     "<digest>": { "<measure>": { "value": "as displayed, e.g. \"$4.21\" or \"12.5%\" or \"-\"", "basis": 12 } }
//   },
//   "comparisons": [ { "a": "<digest>", "b": "<digest>", "not_yet_meaningful_shown": true } ]
// }
// Measures: laps, merges, empty_laps, failed_laps, send_backs, gate_refusals, merges_per_active_hour,
// lap_hours_per_merge, app_check_share, cost_per_merge, new_holdout_catches. "basis" is the lap count
// the screen says the number rests on. Laps still running (no completed_at) are judged both ways
// (counted or not); one reading must fit every measure of a version.
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

const obj = (v) => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" ? v : {};
};
const HOUR = 3600_000;

function compute(digest, includeRunning) {
  const laps = rec.runs.filter(
    (r) =>
      r.workflow_name === "archon-loop" &&
      r.codebase === rec.factory_codebase &&
      r.digest === digest &&
      (includeRunning || r.completed_at),
  );
  const ids = new Set(laps.map((l) => l.id));
  const steps = rec.steps.filter((s) => ids.has(s.run_id));
  const done = steps.filter((s) => s.event_type === "node_completed");
  const lapsWhere = (step, key, value) =>
    new Set(done.filter((s) => s.step_name === step && obj(s.structured_output)[key] === value).map((s) => s.run_id)).size;

  const merges = lapsWhere("land", "outcome", "merged");
  const durations = laps.filter((l) => l.completed_at).map((l) => [Date.parse(l.started_at), Date.parse(l.completed_at)]);
  const lapMs = durations.reduce((a, [s, e]) => a + (e - s), 0);
  const hours = new Set();
  for (const [s, e] of durations) for (let h = Math.floor(s / HOUR); h * HOUR < e; h++) hours.add(h);
  const checkMs = done.filter((s) => s.step_name === "check-app").reduce((a, s) => a + Number(s.duration_ms ?? 0), 0);
  const cost = steps.reduce((a, s) => a + Number(s.cost_usd ?? 0), 0);
  const catches = (rec.app_check_lines ?? []).filter(
    (l) =>
      ids.has(l.run_id) &&
      l.kind === "holdout" &&
      String(l.verdict).toUpperCase() === "FAIL" &&
      (l.pre_existing == null || l.pre_existing === "" || (Array.isArray(l.pre_existing) && l.pre_existing.length === 0)),
  ).length;
  const per = (n) => (merges === 0 ? null : n / merges);
  return {
    lapCount: laps.length,
    m: {
      laps: laps.length,
      merges,
      empty_laps: lapsWhere("pick", "route", "none"),
      failed_laps: laps.filter((l) => l.status === "failed").length,
      send_backs: lapsWhere("review", "outcome", "sent-back"),
      gate_refusals: lapsWhere("land", "outcome", "refused"),
      merges_per_active_hour: hours.size === 0 ? null : merges / hours.size,
      lap_hours_per_merge: per(lapMs / HOUR),
      app_check_share: lapMs === 0 ? null : checkMs / lapMs,
      cost_per_merge: per(cost),
      new_holdout_catches: catches,
    },
  };
}

function parseShown(measure, raw) {
  const s = String(raw ?? "").trim();
  if (/nan|infinity|∞/i.test(s)) return { bad: true };
  const m = s.replace(/[,$\s]/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return { none: true };
  let value = Number(m[0]);
  const decimals = m[1] ? m[1].length - 1 : 0;
  let tol = 0.5 * 10 ** -decimals + 1e-9;
  if (measure === "app_check_share" && s.includes("%")) {
    value /= 100;
    tol /= 100;
  }
  return { value, tol };
}

function judgeDigest(digest, shown, variant) {
  const { lapCount, m } = compute(digest, variant);
  const errs = [];
  for (const [measure, expected] of Object.entries(m)) {
    const cell = shown[measure];
    if (!cell) {
      errs.push(`${measure}: not recorded`);
      continue;
    }
    if (cell.basis !== lapCount) errs.push(`${measure}: says it rests on ${cell.basis} laps, expected ${lapCount}`);
    const p = parseShown(measure, cell.value);
    if (p.bad) errs.push(`${measure}: shows "${cell.value}"`);
    else if (expected === null) {
      if (!p.none) errs.push(`${measure}: shows "${cell.value}" but has no defined value (no merges or no time)`);
    } else if (p.none) errs.push(`${measure}: shows no number, expected ${expected}`);
    else if (Math.abs(p.value - expected) > p.tol) errs.push(`${measure}: shows ${cell.value}, expected ${expected}`);
  }
  return { errs, lapCount };
}

const fails = [];
const gaps = [];
if (!rec.factory_codebase || !Array.isArray(rec.runs) || !Array.isArray(rec.steps)) out("INCONCLUSIVE", ["record lacks factory_codebase, runs or steps"]);
const digests = Object.keys(rec.shown ?? {});
if (digests.length === 0 && !(rec.comparisons ?? []).length) gaps.push("nothing shown was recorded");

for (const d of digests) {
  const a = judgeDigest(d, rec.shown[d], false);
  const b = judgeDigest(d, rec.shown[d], true);
  if (a.errs.length && b.errs.length) fails.push(...a.errs.map((e) => `${d.slice(0, 12)} ${e}`));
}

for (const c of rec.comparisons ?? []) {
  const counts = [false, true].map((v) => Math.min(compute(c.a, v).lapCount, compute(c.b, v).lapCount) < 10);
  if (counts[0] !== counts[1]) {
    gaps.push(`${c.a.slice(0, 8)} vs ${c.b.slice(0, 8)}: running laps decide the 10-lap rule; finish them first`);
    continue;
  }
  if (typeof c.not_yet_meaningful_shown !== "boolean") gaps.push(`${c.a.slice(0, 8)} vs ${c.b.slice(0, 8)}: label not recorded`);
  else if (c.not_yet_meaningful_shown !== counts[0])
    fails.push(`${c.a.slice(0, 8)} vs ${c.b.slice(0, 8)}: "not yet meaningful" ${c.not_yet_meaningful_shown ? "shown" : "missing"}, expected ${counts[0] ? "shown" : "absent"}`);
}

if (fails.length) out("FAIL", [...fails, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [`${digests.length} version(s) and ${(rec.comparisons ?? []).length} comparison(s) match PRD 4.2`]);
