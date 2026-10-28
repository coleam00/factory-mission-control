// Judge for H-58: what `bun run fixture:drop` deletes (PRD 11.3 as amended by the owner decision on
// #27 question 6, 2026-10-27; invariant 8).
//
// For a drop run from checkout K at time T (T = the `--at` time for a dry run, the wall clock for a
// real run), the set it deletes (or, dry, says it would delete) must be exactly:
//   - the branch K's `.mc-check.env` names (K's own check branch), whatever its age or owner; plus
//   - every other branch named `check-*` that is older than 3 hours at T (T - created_at > 3 h) and
//     whose owning run is NOT still running: the owner ended, or no owner is recorded.
// It never includes a branch not named `check-*`, nor another checkout's branch whose owner is
// still running, however old. A dry run deletes nothing: every branch is still there afterwards.
//
// Record shape (times ISO 8601 UTC):
// {
//   "branches": [
//     { "name": "check-a1", "created_at": "2026-10-27T10:00:00Z",
//       "owner": "running" | "ended" | "none",   // the owning run's state in Archon when the drops ran;
//                                                 // "none" = no owner recorded for the branch
//       "checkout": "K1" | null }                 // the checkout whose .mc-check.env names it, if any
//   ],                                            // list every branch in the project, decoys and main too
//   "drops": [
//     { "checkout": "K1", "dry_run": true, "at": "2026-10-27T14:01:00Z",   // for a real run, "at" = when it ran
//       "exit_code": 0,
//       "listed": ["check-..."],                  // every branch it says it deletes / would delete
//       "branches_after": ["every branch name in the project after it finished"] }
//   ]
// }
// An owner state the verifier could not establish is recorded as null and makes that branch's
// judgement INCONCLUSIVE.
//
// Run: bun .factory/holdout/judges/drop-cleanup.js <record.json>
import { readFileSync } from "node:fs";

const AGE_MS = 3 * 3600 * 1000;
const NEAR_MS = 10 * 60 * 1000; // boundary runs: within 10 minutes either side of 3 hours

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
const branches = rec.branches ?? [];
const drops = rec.drops ?? [];
if (!branches.length) gaps.push("no branches recorded");
if (!drops.length) gaps.push("no drop runs recorded");
const t = (s) => Date.parse(s);
const isCheck = (n) => n.startsWith("check-");
const seen = new Set(); // coverage keys

for (const [i, d] of drops.entries()) {
  const tag = `drop ${i + 1} (${d.dry_run ? "dry" : "real"}, from ${d.checkout}, at ${d.at})`;
  const at = t(d.at);
  if (!Number.isFinite(at)) {
    gaps.push(`${tag}: no readable time`);
    continue;
  }
  if (!Array.isArray(d.listed)) {
    gaps.push(`${tag}: what it deletes was not recorded`);
    continue;
  }
  const listed = new Set(d.listed);
  const expected = new Set();
  for (const b of branches) {
    const age = at - t(b.created_at);
    const own = b.checkout != null && b.checkout === d.checkout;
    if (!Number.isFinite(age)) {
      gaps.push(`${tag}: branch ${b.name} has no readable creation time`);
      continue;
    }
    if (own) {
      seen.add("own");
      expected.add(b.name);
      continue;
    }
    if (!isCheck(b.name)) {
      seen.add("decoy");
      if (listed.has(b.name)) fails.push(`${tag}: lists ${b.name}, which is not a check-* branch`);
      continue;
    }
    if (b.owner == null) {
      gaps.push(`${tag}: owner state of ${b.name} not established`);
      continue;
    }
    if (age > AGE_MS) seen.add(`${b.owner}:old${b.checkout ? ":other-checkout" : ""}`);
    if (age > AGE_MS && age <= AGE_MS + NEAR_MS) seen.add(`${b.owner}:just-over`);
    if (age < AGE_MS && age >= AGE_MS - NEAR_MS) seen.add(`${b.owner}:just-under`);
    if (age > AGE_MS && b.owner !== "running") expected.add(b.name);
  }
  for (const n of expected)
    if (!listed.has(n)) {
      const b = branches.find((x) => x.name === n);
      fails.push(`${tag}: does not delete ${n} (owner ${b.checkout === d.checkout ? "this checkout" : b.owner}, ${((at - t(b.created_at)) / 3600000).toFixed(2)} h old)`);
    }
  for (const n of listed)
    if (!expected.has(n) && isCheck(n)) {
      const b = branches.find((x) => x.name === n);
      if (!b) fails.push(`${tag}: lists ${n}, which is not among the recorded branches`);
      else fails.push(`${tag}: deletes ${n} (owner ${b.owner}, ${((at - t(b.created_at)) / 3600000).toFixed(2)} h old), which it must keep`);
    }
  if (!Array.isArray(d.branches_after)) {
    gaps.push(`${tag}: branch list afterwards not recorded`);
    continue;
  }
  const after = new Set(d.branches_after);
  if (d.dry_run) {
    seen.add("dry");
    for (const b of branches) if (!after.has(b.name)) fails.push(`${tag}: a dry run deleted ${b.name}`);
  } else {
    seen.add("real");
    for (const b of branches) {
      if (expected.has(b.name) && after.has(b.name)) fails.push(`${tag}: ${b.name} should be deleted but still exists`);
      if (!expected.has(b.name) && !after.has(b.name)) fails.push(`${tag}: ${b.name} disappeared, and it must be kept`);
    }
  }
  if (!after.has("main")) fails.push(`${tag}: main is not in the branch list afterwards`);
}

for (const k of [
  "own",
  "decoy",
  "running:old",
  "running:old:other-checkout",
  "ended:old",
  "none:old",
  "ended:just-over",
  "ended:just-under",
  "none:just-over",
  "none:just-under",
  "running:just-over",
  "dry",
  "real",
])
  if (!seen.has(k)) gaps.push(`coverage: no drop run covers ${k}`);

if (fails.length) out("FAIL", fails);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [`${drops.length} drop runs delete exactly the own branch and old check-* branches whose owner is not running`]);
