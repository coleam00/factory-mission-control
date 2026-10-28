// Judge for H-26 (and the coverage parts of H-28 and H-29): every step of the parsed architecture,
// at every include depth, is on the map, the map leads to it, and its detail is a real page.
//
// Record shape:
// {
//   "expected_steps": [            // built independently from the pinned files, expanded the way Archon
//                                  // expands includes (never copied from the app's tables or payloads)
//     { "key": "archon-loop>ship>archon-ship-block>implement", // the include path, outermost first
//       "step_id": "implement", "depth": 2,                  // depth 0 = a top-level workflow step
//       "yaml": "<the step's YAML, exactly as in the file>",
//       "prompt": "<its command file text, or null if it has none>" }
//   ],
//   "map_steps": [                 // every step the map shows, with where clicking it leads
//     { "key": "<the expected key it stands for, as the verifier matched it>", "href": "/..." }
//   ],
//   "details": [                   // one per distinct href opened (fresh tab, typed address, after 3 s)
//     { "href": "/...", "state": "ready",          // ready | not-found | error | loading | empty
//       "step_id_shown": "implement",
//       "sections": { "description": true, "inputs_outputs": true, "when": true, "model_tier": true,
//                     "yaml": true, "prompt": true, "subagents": true, "scripts": true, "hooks": true },
//       "yaml_text": "<the YAML shown>", "prompt_text": "<the prompt shown, or null>" }
//   ]
// }
// A section counts as present when the page shows it, including an explicit "none" for a step that has
// no subagents, scripts, hooks or `when`. Text comparisons ignore only trailing whitespace per line.
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

const expected = rec.expected_steps ?? [];
const mapSteps = rec.map_steps ?? [];
const details = rec.details ?? [];
const SECTIONS = ["description", "inputs_outputs", "when", "model_tier", "yaml", "prompt", "subagents", "scripts", "hooks"];
const norm = (s) => (s == null ? null : String(s).replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim());

const fails = [];
const notes = [];

if (expected.length === 0) out("INCONCLUSIVE", ["no expected steps recorded"]);
if (!expected.some((s) => s.depth >= 2)) notes.push("no step at include depth 2 or more in the record");
const ids = new Map();
for (const s of expected) ids.set(s.step_id, (ids.get(s.step_id) ?? 0) + 1);
if (![...ids.values()].some((n) => n > 1)) notes.push("no step id shared by two blocks in the record");

const keys = new Set(expected.map((s) => s.key));
const byKey = new Map();
for (const m of mapSteps) {
  if (!keys.has(m.key)) fails.push(`map shows a step that is not in the parsed architecture: ${m.key}`);
  byKey.set(m.key, m);
}
const hrefOwner = new Map();
for (const s of expected) {
  const m = byKey.get(s.key);
  if (!m) { fails.push(`step not on the map: ${s.key}`); continue; }
  if (!m.href) { fails.push(`map step leads nowhere: ${s.key}`); continue; }
  if (hrefOwner.has(m.href) && hrefOwner.get(m.href) !== s.key)
    fails.push(`two different steps lead to the same page ${m.href}: ${hrefOwner.get(m.href)} and ${s.key}`);
  hrefOwner.set(m.href, s.key);
  const d = details.find((x) => x.href === m.href);
  if (!d) { fails.push(`detail not opened for ${s.key} (${m.href})`); continue; }
  if (d.state !== "ready") { fails.push(`${s.key}: detail is ${d.state}, not ready`); continue; }
  if (d.step_id_shown !== s.step_id) fails.push(`${s.key}: detail names ${d.step_id_shown}, not ${s.step_id}`);
  for (const sec of SECTIONS) if (!d.sections?.[sec]) fails.push(`${s.key}: detail lacks ${sec}`);
  if (norm(d.yaml_text) !== norm(s.yaml)) fails.push(`${s.key}: YAML shown is not this step's YAML at this version`);
  if (s.prompt != null && norm(d.prompt_text) !== norm(s.prompt)) fails.push(`${s.key}: prompt shown is not its command file`);
  if (s.prompt == null && d.prompt_text) fails.push(`${s.key}: shows a prompt though the step has no command file`);
}

if (fails.length) out("FAIL", [...fails, ...notes]);
if (notes.length) out("INCONCLUSIVE", ["every recorded step passed, but the record does not cover:", ...notes]);
out("PASS", [`${expected.length} steps, all on the map, all leading to a ready detail with every section and the pinned text`]);
