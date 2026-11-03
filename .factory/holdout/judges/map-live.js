// Judge for H-60, H-61, H-62, H-63, H-71 and H-76: the live chips on the v2 factory map mean exactly what
// PRD 4.1 "Live" says, computed independently from the source rows the verifier recorded.
//
// Definitions judged (PRD 4.1, as amended 2026-11-03; lap and merge as in 4.2):
// - "<n> here" on a card: the selected factory's running laps (runs of `archon-loop` with status
//   `running`) whose deepest running step is covered by that card. A lap counts once, on the card of
//   its deepest running step (the running step with the most path segments). Coverage, from the 4.1
//   table, by the step's path inside `archon-loop`:
//     pick, claim -> intake; build, subject -> build; ship and every step under it -> build, except
//     ship/deliver/rounds/review and ship/deliver/rounds/rereview and every step under them -> review;
//     briefs, check-app, evidence, handoff -> app; review, land, release -> merge; deploy and every
//     step under it -> staging.
//   The card's `data-live-count` equals that number, and the card's chip pulses exactly when it is
//   greater than 0. Product document, New issue, Found by the factory and Shipped never show laps here.
// - "<n> failing" on App check: the selected factory's open pull requests whose latest app check (by
//   time) failed. The chip is red (judged by v2-colors.js; here only its number).
// - "<n> waiting" on the Manager: the selected factory's open owner questions.
// - "<n> merged" on Shipped: the selected factory's merges (laps whose `land` output has
//   `outcome = merged`) whose time falls inside "today_window". If the record has
//   "header_merged_today", it must equal the same number.
// A number the card does not show (no chip) counts as 0.
//
// INCONCLUSIVE, never PASS, when: an observation is missing a field it needs; a running lap of the
// selected factory has no running step; its deepest running steps tie across two cards; a step path
// is not in the table above; the latest app check of an open pull request is pending (or two share
// the latest time); a merge falls within 2 hours of either edge of "today_window" (time zones could
// disagree); fewer than 2 observations are recorded.
//
// Record shape:
// {
//   "factory": "A",                                   // the factory selected on the map
//   "today_window": { "start": "ISO", "end": "ISO" }, // the browser's calendar day (browser zone UTC)
//   "observations": [
//     { "label": "after the second node_started",
//       "runs": [ { "run_id": "...", "factory": "A", "workflow": "archon-loop", "status": "running",
//                   "running_steps": ["ship", "ship/deliver", "ship/deliver/rounds/review"] } ],
//                   // every step of the run with a node_started and no node_completed, node_failed
//                   // or node_skipped yet, as its path inside the workflow, segments joined by "/"
//       "prs": [ { "factory": "A", "number": 41, "state": "open" | "closed" | "merged",
//                  "app_checks": [ { "at": "ISO", "verdict": "pass" | "fail" | "pending" } ] } ],
//       "owner_questions": [ { "factory": "A", "id": "Q3", "open": true } ],
//       "merges": [ { "factory": "A", "run_id": "...", "merged_at": "ISO" } ],
//       "cards": { "intake": { "here": 1, "data_live_count": 1, "pulsing": true },
//                  "build": { "here": 0, "data_live_count": 0, "pulsing": false, "queued": 2 },
//                  "review": {...}, "app": { ..., "failing": 1 }, "merge": {...}, "staging": {...},
//                  "manager": { "waiting": 2 }, "shipped": { "merged": 4 },
//                  "prd": {...}, "issue": {...}, "found": {...} },
//       "header_merged_today": 4 }
//   ]
// }
//
// Run: bun .factory/holdout/judges/map-live.js <record.json>
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

const LINE = ["intake", "build", "review", "app", "merge", "staging"];
const NEVER_HERE = ["prd", "issue", "found", "shipped"];
const MARGIN_MS = 2 * 3600 * 1000;

function cardFor(path) {
  const seg = path.split("/").filter(Boolean);
  const top = seg[0];
  if (top === "pick" || top === "claim") return "intake";
  if (top === "build" || top === "subject") return "build";
  if (top === "ship") {
    if (seg[1] === "deliver" && seg[2] === "rounds" && (seg[3] === "review" || seg[3] === "rereview")) return "review";
    return "build";
  }
  if (["briefs", "check-app", "evidence", "handoff"].includes(top)) return "app";
  if (["review", "land", "release"].includes(top)) return "merge";
  if (top === "deploy") return "staging";
  return null;
}

const fails = [];
const gaps = [];
const f = rec.factory;
if (!f) gaps.push("no selected factory recorded");
const obs = rec.observations ?? [];
if (obs.length < 2) gaps.push(`only ${obs.length} observation(s); at least 2 are needed`);
const ws = Date.parse(rec.today_window?.start);
const we = Date.parse(rec.today_window?.end);
if (Number.isNaN(ws) || Number.isNaN(we)) gaps.push("today_window missing or unparsable");

const shown = (cards, card, key) => {
  const c = cards?.[card];
  if (c == null || c[key] == null) return 0;
  return Number(c[key]);
};

for (const [i, o] of obs.entries()) {
  const L = o.label ?? `observation ${i + 1}`;
  if (!o.cards) {
    gaps.push(`${L}: no cards recorded`);
    continue;
  }
  // here
  const want = Object.fromEntries(LINE.map((c) => [c, 0]));
  for (const r of o.runs ?? []) {
    if (r.factory !== f || r.workflow !== "archon-loop" || r.status !== "running") continue;
    const steps = r.running_steps ?? [];
    if (!steps.length) {
      gaps.push(`${L}: running lap ${r.run_id} has no running step`);
      continue;
    }
    const depth = (p) => p.split("/").filter(Boolean).length;
    const max = Math.max(...steps.map(depth));
    const deepest = steps.filter((p) => depth(p) === max);
    const cards = [...new Set(deepest.map(cardFor))];
    if (cards.includes(null)) {
      gaps.push(`${L}: lap ${r.run_id} runs a step outside the 4.1 table (${deepest.join(", ")})`);
      continue;
    }
    if (cards.length > 1) {
      gaps.push(`${L}: lap ${r.run_id}'s deepest running steps tie across cards ${cards.join(", ")}`);
      continue;
    }
    want[cards[0]]++;
  }
  for (const c of LINE) {
    const here = shown(o.cards, c, "here");
    if (here !== want[c]) fails.push(`${L}: ${c} shows ${here} here, expected ${want[c]}`);
    const dl = o.cards[c]?.data_live_count;
    if (dl == null) gaps.push(`${L}: ${c} data-live-count not recorded`);
    else if (Number(dl) !== want[c]) fails.push(`${L}: ${c} data-live-count ${dl}, expected ${want[c]}`);
    const pulse = o.cards[c]?.pulsing;
    if (pulse == null) gaps.push(`${L}: ${c} pulsing not recorded`);
    else if (Boolean(pulse) !== want[c] > 0) fails.push(`${L}: ${c} pulsing is ${pulse} with ${want[c]} laps on it`);
  }
  for (const c of NEVER_HERE) {
    if (shown(o.cards, c, "here") !== 0) fails.push(`${L}: ${c} shows laps here; it covers no steps`);
    const dl = o.cards[c]?.data_live_count;
    if (dl != null && Number(dl) > 0) fails.push(`${L}: ${c} carries data-live-count ${dl}; it covers no steps`);
  }
  // failing
  if (o.prs == null) gaps.push(`${L}: prs not recorded`);
  else {
    let failing = 0;
    for (const p of o.prs) {
      if (p.factory !== f || p.state !== "open") continue;
      const checks = [...(p.app_checks ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      if (!checks.length) continue;
      if (checks.length > 1 && Date.parse(checks[0].at) === Date.parse(checks[1].at)) {
        gaps.push(`${L}: PR #${p.number} has two latest app checks at the same time`);
        continue;
      }
      if (checks[0].verdict === "pending") {
        gaps.push(`${L}: PR #${p.number}'s latest app check is pending`);
        continue;
      }
      if (checks[0].verdict === "fail") failing++;
    }
    const s = shown(o.cards, "app", "failing");
    if (s !== failing) fails.push(`${L}: App check shows ${s} failing, expected ${failing}`);
  }
  // waiting
  if (o.owner_questions == null) gaps.push(`${L}: owner_questions not recorded`);
  else {
    const waiting = o.owner_questions.filter((q) => q.factory === f && q.open).length;
    const s = shown(o.cards, "manager", "waiting");
    if (s !== waiting) fails.push(`${L}: Manager shows ${s} waiting, expected ${waiting}`);
  }
  // merged today
  if (o.merges == null) gaps.push(`${L}: merges not recorded`);
  else if (!Number.isNaN(ws) && !Number.isNaN(we)) {
    let merged = 0;
    for (const m of o.merges) {
      if (m.factory !== f) continue;
      const t = Date.parse(m.merged_at);
      if (Number.isNaN(t)) {
        gaps.push(`${L}: merge ${m.run_id} has no time`);
        continue;
      }
      if (Math.abs(t - ws) < MARGIN_MS || Math.abs(t - we) < MARGIN_MS) {
        gaps.push(`${L}: merge ${m.run_id} is within 2 hours of a day boundary`);
        continue;
      }
      if (t >= ws && t < we) merged++;
    }
    const s = shown(o.cards, "shipped", "merged");
    if (s !== merged) fails.push(`${L}: Shipped shows ${s} merged, expected ${merged}`);
    if (o.header_merged_today != null && Number(o.header_merged_today) !== merged)
      fails.push(`${L}: the header says ${o.header_merged_today} merged today, expected ${merged}`);
  }
}

if (fails.length) out("FAIL", [...fails, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [`${obs.length} observations: every chip equals its 4.1 definition for factory ${f}`]);
