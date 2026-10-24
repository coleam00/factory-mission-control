// Judge for H-02, H-03, H-07: every write visible in every watched panel within 5 s, with the page
// open at least 180 s before one of the writes, no reload and no data polling.
//
// Record shape:
// {
//   "page_opened_at": "ISO time the tabs were opened (needed for H-02 only)",
//   "require_open_seconds": 180,            // optional; 0 to skip the 3-minute rule (H-03, H-07)
//   "reloads": 0,                           // tabs whose reload marker was lost
//   "polling_requests": 0,                  // HTTP data requests after first load, other than seal renewals
//   "writes": [
//     { "label": "node_started build", "committed_at": "ISO",
//       "observations": [ { "panel": "lane", "seen_at": "ISO or null if never seen" } ] }
//   ]
// }
import { readFileSync } from "node:fs";

const LIMIT_MS = 5000;
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
if (!Array.isArray(rec.writes) || rec.writes.length === 0) gaps.push("no writes recorded");
if (typeof rec.reloads !== "number") gaps.push("reloads not recorded");
else if (rec.reloads > 0) fails.push(`${rec.reloads} tab(s) reloaded`);
if (typeof rec.polling_requests !== "number") gaps.push("polling_requests not recorded");
else if (rec.polling_requests > 0) fails.push(`${rec.polling_requests} data polling request(s)`);

const needOpen = (rec.require_open_seconds ?? 180) * 1000;
let longestOpen = -1;
for (const w of rec.writes ?? []) {
  const at = Date.parse(w.committed_at);
  if (Number.isNaN(at)) {
    gaps.push(`write "${w.label}" has no committed_at`);
    continue;
  }
  if (rec.page_opened_at) longestOpen = Math.max(longestOpen, at - Date.parse(rec.page_opened_at));
  if (!Array.isArray(w.observations) || w.observations.length === 0) {
    gaps.push(`write "${w.label}" has no observations`);
    continue;
  }
  for (const o of w.observations) {
    if (o.seen_at == null) {
      fails.push(`"${w.label}" never appeared in ${o.panel}`);
      continue;
    }
    const lag = Date.parse(o.seen_at) - at;
    if (Number.isNaN(lag)) gaps.push(`"${w.label}" in ${o.panel}: bad seen_at`);
    else if (lag > LIMIT_MS) fails.push(`"${w.label}" took ${lag} ms in ${o.panel} (limit ${LIMIT_MS})`);
  }
}
if (needOpen > 0) {
  if (!rec.page_opened_at) gaps.push("page_opened_at not recorded");
  else if (longestOpen < needOpen)
    gaps.push(`no write came ${needOpen / 1000} s after opening (longest ${Math.round(longestOpen / 1000)} s)`);
}

if (fails.length) out("FAIL", [...fails, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", ["every write appeared in every watched panel within 5 s, no reload, no polling"]);
