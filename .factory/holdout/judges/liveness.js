// Judge for H-02, H-03, H-07, H-23, H-24: every write visible in every watched panel within 5 s, with
// the page open at least 180 s before one of the writes, no reload and no data polling.
//
// Record shape:
// {
//   "page_opened_at": "ISO time the tabs were opened (needed for H-02 only)",
//   "require_open_seconds": 180,            // optional; 0 to skip the 3-minute rule (H-03, H-07, ...)
//   "reloads": 0,                           // tabs whose reload marker was lost
//   "polling_requests": 0,                  // HTTP data requests after first load, other than seal renewals
//   "panels": ["lane", "map", "one-lap"],   // every panel the scenario's steps watch (required)
//   "writes": [
//     { "label": "node_started build", "committed_at": "ISO",
//       "observations": [
//         { "panel": "lane", "seen_at": "ISO or null if never seen" },
//         { "panel": "one-lap", "seen_at": null, "screen_absent": true,
//           "screen_text": "what the app showed at the panel's address, e.g. Nothing is at this address" }
//       ] }
//   ]
// }
//
// Verdicts:
// - FAIL when any served panel is slow (over 5 s) or silent (never showed the change), a tab reloaded,
//   or a panel polled. A served panel that is slow or silent always fails, whatever else is missing.
// - INCOMPLETE (exit 3) when nothing failed but a watched panel's screen is not served on this commit:
//   its address has no route and the app says so ("Nothing is at this address"). Mark such an
//   observation `screen_absent: true` with `seen_at: null` and the text the app showed in
//   `screen_text`. "Absent" means the whole screen is not served. A served screen that lacks the
//   panel, or the element the step watches, is served and silent: record `seen_at: null` without
//   `screen_absent`, and it fails.
// - INCONCLUSIVE when nothing failed, no screen is absent, but the record cannot decide (missing
//   fields, a watched panel with no observation, no write 180 s after opening).
// - PASS only when every listed panel showed every write within 5 s, nothing reloaded, nothing polled.
import { readFileSync } from "node:fs";

const LIMIT_MS = 5000;
const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2, INCOMPLETE: 3 };
const out = (verdict, reasons) => {
  console.log(verdict);
  for (const r of reasons) console.log(`- ${r}`);
  process.exit(EXIT[verdict]);
};

let rec;
try {
  rec = JSON.parse(readFileSync(process.argv[2], "utf8"));
} catch (e) {
  out("INCONCLUSIVE", [`cannot read record: ${e.message}`]);
}

const fails = [];
const absent = [];
const gaps = [];
if (!Array.isArray(rec.writes) || rec.writes.length === 0) gaps.push("no writes recorded");
if (typeof rec.reloads !== "number") gaps.push("reloads not recorded");
else if (rec.reloads > 0) fails.push(`${rec.reloads} tab(s) reloaded`);
if (typeof rec.polling_requests !== "number") gaps.push("polling_requests not recorded");
else if (rec.polling_requests > 0) fails.push(`${rec.polling_requests} data polling request(s)`);

const panels = Array.isArray(rec.panels) ? rec.panels : null;
if (!panels || panels.length === 0) gaps.push("panels (every panel the steps watch) not recorded");

const needOpen = (rec.require_open_seconds ?? 180) * 1000;
let longestOpen = -1;
for (const w of rec.writes ?? []) {
  const at = Date.parse(w.committed_at);
  if (Number.isNaN(at)) {
    gaps.push(`write "${w.label}" has no committed_at`);
    continue;
  }
  if (rec.page_opened_at) longestOpen = Math.max(longestOpen, at - Date.parse(rec.page_opened_at));
  const obs = Array.isArray(w.observations) ? w.observations : [];
  if (obs.length === 0) {
    gaps.push(`write "${w.label}" has no observations`);
    continue;
  }
  for (const p of panels ?? []) {
    if (!obs.some((o) => o.panel === p)) gaps.push(`"${w.label}" has no observation for watched panel ${p}`);
  }
  for (const o of obs) {
    if (o.screen_absent === true) {
      if (o.seen_at != null) gaps.push(`"${w.label}" in ${o.panel}: marked screen_absent but has seen_at`);
      else if (typeof o.screen_text !== "string" || o.screen_text.trim() === "")
        gaps.push(`"${w.label}" in ${o.panel}: marked screen_absent without the screen_text the app showed`);
      else absent.push(`${o.panel} is not served on this commit ("${o.screen_text.trim()}"), so "${w.label}" could not be watched there`);
      continue;
    }
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

if (fails.length) out("FAIL", [...fails, ...absent, ...gaps]);
if (absent.length) out("INCOMPLETE", [...absent, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", ["every write appeared in every watched panel within 5 s, no reload, no polling"]);
