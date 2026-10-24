// Judge for H-16: failed-lap causes follow the error-text rules of PRD 4.8, and a running step is
// flagged once it runs longer than twice its 90th-percentile duration over its last 50 completions.
//
// Record shape:
// {
//   "failed_laps": [ { "run_id": "...", "error_text": "...", "shown_cause": "usage limit" } ],
//   "stuck_checks": [
//     { "step": "check-app",
//       "history_ms": [ ...every completion's duration_ms, oldest first... ],
//       "observations": [ { "elapsed_ms": 120000, "flagged": false } ] }   // what health showed, sampled over time
//   ]
// }
// Causes: "usage limit", "authentication", "infrastructure", "other".
// Because the PRD gives neither the percentile method nor the regex case rule, the judge accepts any
// of the readings; a sample inside the band where the readings disagree is not judged. A sample is
// also not judged within 5 s after the threshold (the liveness allowance).
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

const RULES = [
  ["usage limit", "usage limit|429"],
  ["authentication", "401|unauthor"],
  ["infrastructure", "ECONN|ETIMEDOUT|fetch failed"],
];
const norm = (s) => String(s ?? "").trim().toLowerCase();
const classify = (text, flags) => {
  for (const [cause, re] of RULES) if (new RegExp(re, flags).test(text)) return cause;
  return "other";
};

const fails = [];
const gaps = [];

const laps = rec.failed_laps ?? [];
if (laps.length === 0) gaps.push("no failed laps recorded");
for (const l of laps) {
  const ok = new Set([classify(l.error_text, ""), classify(l.error_text, "i")]);
  if (!l.shown_cause) gaps.push(`${l.run_id}: no cause recorded`);
  else if (!ok.has(norm(l.shown_cause)))
    fails.push(`${l.run_id}: "${l.error_text}" shown as "${l.shown_cause}", expected ${[...ok].join(" or ")}`);
}

const nearestRank = (xs) => xs[Math.max(0, Math.ceil(0.9 * xs.length) - 1)];
const interpolated = (xs) => {
  const pos = 0.9 * (xs.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
};
const checks = rec.stuck_checks ?? [];
if (checks.length === 0) gaps.push("no stuck-step checks recorded");
for (const c of checks) {
  const hist = (c.history_ms ?? []).slice(-50);
  if (hist.length < 50) {
    gaps.push(`${c.step}: only ${hist.length} completions, the rule needs 50`);
    continue;
  }
  const sorted = [...hist].sort((a, b) => a - b);
  const p90s = [nearestRank(sorted), interpolated(sorted)];
  const low = 2 * Math.min(...p90s);
  const high = 2 * Math.max(...p90s);
  const obs = c.observations ?? [];
  if (!obs.some((o) => o.elapsed_ms > high + 5000)) gaps.push(`${c.step}: no sample past the threshold ${high} ms`);
  if (!obs.some((o) => o.elapsed_ms <= low)) gaps.push(`${c.step}: no sample below the threshold ${low} ms`);
  for (const o of obs) {
    if (o.elapsed_ms <= low && o.flagged) fails.push(`${c.step}: flagged at ${o.elapsed_ms} ms, threshold ${low}-${high} ms`);
    if (o.elapsed_ms > high + 5000 && !o.flagged)
      fails.push(`${c.step}: not flagged at ${o.elapsed_ms} ms, threshold ${low}-${high} ms`);
  }
}

if (fails.length) out("FAIL", [...fails, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", ["causes and stuck-step flags follow PRD 4.8"]);
