// Judge for H-73 and H-74: the v2 colors (PRD 8.3 as amended 2026-11-03; docs/design/v2/README.md
// "Color roles"; docs/design/v2/tokens.css). Color says who is acting, not how worried to be.
//
// Rules judged:
// 1. NO AMBER, NO MAGENTA: no element on any recorded screen, in any recorded state, paints a visible
//    color (alpha > 0.05) with OKLCH chroma >= 0.05 and hue in the amber band [40, 105] degrees
//    (the console's --warning at 75, #f59e0b at 70, #b45309 at 55 all fall inside) or the magenta
//    band [300, 350] (the Archon magentas and plums; violet #a78bfa at about 293 does not). The
//    brand mark is not exempt.
// 2. ROLE: an element recorded with a role paints that role. Its accent (the value, in the rest
//    state, of the property named by "accent_prop") must be, for mode "exact" (default), within
//    OKLab distance 0.035 of the role color; for mode "tint" (a mixed border or a line), have
//    chroma >= 0.03 and hue within 35 degrees of the role color's hue. Role colors:
//      source #38bdf8, agent #3b82f6, test #14b8a6, person #a78bfa, running #60a5fa (Dynamous Light),
//      success #14b8a6; failed: hue in [5, 40] with chroma >= 0.10 (the console's error red).
// 3. WAITING IS VIOLET: every element recorded with "waiting": true (anything that says something
//    waits on the owner or a person) must have role "person" and pass rule 2.
// 4. RED IS FOR FAILURES: a visible color with chroma >= 0.10 and hue in [5, 40] may appear only on
//    an element whose role is "failed".
// 5. CARDS ARE TINTED, NEVER GREY: every map card (kind "card") records "bar" (its role stripe or
//    kind label color), "border" and "fill". bar is checked as "exact", border as "tint" against the
//    card's role; fill, taken against "untinted" (the background color of a neutral surface on the
//    same screen, such as the map stage's own background where no card is), must move by at least
//    0.008 in OKLab a/b toward the role's hue (within 35 degrees); cards of the same role have fills
//    within OKLab distance 0.004 of each other, and cards of different roles fills at least 0.006
//    apart.
// 6. COVERAGE: at least one card of each of the four roles, one element with "waiting": true, one
//    with role "failed", one with role "running", something at 1440 and at 390 (or 400) px, and
//    every screen in "screens_served" has at least one recorded element. Missing evidence is
//    INCONCLUSIVE, never PASS. A color the judge cannot parse is INCONCLUSIVE.
//
// Record shape (computed styles from getComputedStyle, strings as the browser returns them):
// {
//   "untinted": "rgb(15, 17, 23)",
//   "screens_served": ["factory map", "details strip", "drill: build", "board", "decisions", ...],
//   "elements": [
//     { "screen": "factory map", "width": 1440, "target": "App check card",
//       "kind": "card" | "chip" | "line" | "badge" | "text" | "control" | "brand" | "other",
//       "role": "source" | "agent" | "test" | "person" | "running" | "success" | "failed" | null,
//       "waiting": false,
//       "accent_prop": "color", "mode": "exact" | "tint",          // for elements with a role
//       "bar": "rgb(...)", "border": "rgb(...)", "fill": "rgb(...)", // for kind "card"
//       "states": { "rest": { "color": "...", "background-color": "...", "border-top-color": "...",
//                             "border-top-width": "1px", "border-top-style": "solid", (right/bottom/left),
//                             "outline-color": "...", "outline-width": "0px", "outline-style": "none",
//                             "box-shadow": "none", "fill": "...", "stroke": "...",
//                             "text-decoration-line": "none", "text-decoration-color": "..." },
//                   "hover": { ... }, "focus-visible": { ... }, "selected": { ... }, "dimmed": { ... } } }
//   ]
// }
//
// Run: bun .factory/holdout/judges/v2-colors.js <record.json>
import { readFileSync } from "node:fs";

const BAND_MIN_C = 0.05;
const BAND_H = [40, 105];
const MAGENTA_H = [300, 350];
const RED_H = [5, 40];
const RED_MIN_C = 0.1;
const VISIBLE_ALPHA = 0.05;

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

// ---------- color parsing ----------
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToLin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const num = (t, pctScale = 1) => {
  t = t.trim();
  if (t === "none") return 0;
  if (t.endsWith("%")) return (parseFloat(t) / 100) * pctScale;
  return parseFloat(t);
};
const hue = (t) => {
  t = t.trim();
  if (t.endsWith("deg")) return parseFloat(t);
  if (t.endsWith("turn")) return parseFloat(t) * 360;
  if (t.endsWith("rad")) return (parseFloat(t) * 180) / Math.PI;
  return num(t);
};
function splitArgs(inner) {
  let alpha = 1;
  let parts;
  if (inner.includes("/")) {
    const [a, b] = inner.split("/");
    alpha = num(b, 1);
    parts = a.trim().split(/[\s,]+/);
  } else {
    parts = inner.trim().split(/[\s,]+/);
    if (parts.length === 4) alpha = num(parts.pop(), 1);
  }
  return { parts, alpha };
}
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
// returns { lab:[L,a,b], alpha } | null (no paint) ; throws on an unknown format
function parseColor(str) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (s === "" || s === "none" || s === "transparent" || s === "auto" || s === "currentcolor" || s === "initial")
    return null;
  if (s === "black") return { lab: linToOklab([0, 0, 0]), alpha: 1 };
  if (s === "white") return { lab: linToOklab([1, 1, 1]), alpha: 1 };
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const v = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { lab: linToOklab([v(0), v(2), v(4)].map(toLin)), alpha: h.length === 8 ? v(6) : 1 };
  }
  m = s.match(/^([a-z-]+)\((.*)\)$/);
  if (!m) throw new Error(`unparsed color "${str}"`);
  const fn = m[1];
  const { parts, alpha } = splitArgs(m[2]);
  if (fn === "rgb" || fn === "rgba") {
    const rgb = parts.slice(0, 3).map((p) => (p.endsWith("%") ? num(p, 1) : num(p) / 255));
    return { lab: linToOklab(rgb.map(toLin)), alpha };
  }
  if (fn === "hsl" || fn === "hsla") {
    const rgb = hslToRgb(hue(parts[0]), num(parts[1], 1) / (parts[1].endsWith("%") ? 1 : 100), num(parts[2], 1) / (parts[2].endsWith("%") ? 1 : 100));
    return { lab: linToOklab(rgb.map(toLin)), alpha };
  }
  if (fn === "oklch") {
    const L = num(parts[0], 1);
    const C = num(parts[1], 0.4);
    const H = (hue(parts[2]) * Math.PI) / 180;
    return { lab: [L, C * Math.cos(H), C * Math.sin(H)], alpha };
  }
  if (fn === "oklab") return { lab: [num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)], alpha };
  if (fn === "color") {
    const space = parts[0];
    const v = parts.slice(1, 4).map((p) => num(p, 1));
    if (space === "srgb") return { lab: linToOklab(v.map(toLin)), alpha };
    if (space === "srgb-linear") return { lab: linToOklab(v), alpha };
    if (space === "display-p3") {
      const [r, g, b] = v.map(toLin);
      const lin = [
        1.2249401 * r - 0.2249404 * g,
        -0.0420569 * r + 1.0420571 * g,
        -0.0196376 * r - 0.0786361 * g + 1.0982735 * b,
      ];
      return { lab: linToOklab(lin), alpha };
    }
  }
  throw new Error(`unparsed color "${str}"`);
}
const COLOR_RE = /(?:rgba?|hsla?|oklch|oklab|color|lab|lch)\([^()]*\)|#[0-9a-f]{3,8}\b/gi;
function colorsIn(str) {
  if (str == null) return [];
  const s = String(str);
  if (/^\s*(none|auto|transparent|currentcolor)?\s*$/i.test(s)) return [];
  const found = s.match(COLOR_RE);
  if (found) return found.map(parseColor).filter(Boolean);
  const one = parseColor(s);
  return one ? [one] : [];
}
const chroma = (c) => Math.hypot(c.lab[1], c.lab[2]);
const hueDeg = (c) => ((Math.atan2(c.lab[2], c.lab[1]) * 180) / Math.PI + 360) % 360;
const inBand = (c) => c.alpha > VISIBLE_ALPHA && chroma(c) >= BAND_MIN_C && hueDeg(c) >= BAND_H[0] && hueDeg(c) <= BAND_H[1];
const dE = (x, y) => Math.hypot(x.lab[0] - y.lab[0], x.lab[1] - y.lab[1], x.lab[2] - y.lab[2]);
const lum = (c) => {
  const [r, g, b] = oklabToLin(c.lab).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (x, y) => {
  const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};
const px = (v) => (v == null ? 0 : parseFloat(v) || 0);

// properties that carry paint, with a visibility test on the state's props
const SIDES = ["top", "right", "bottom", "left"];
const PAINT = [
  ["color", () => true],
  ["background-color", () => true],
  ["background-image", () => true],
  ...SIDES.map((sd) => [`border-${sd}-color`, (p) => px(p[`border-${sd}-width`]) > 0 && p[`border-${sd}-style`] !== "none"]),
  ["outline-color", (p) => px(p["outline-width"]) > 0 && (p["outline-style"] ?? "none") !== "none"],
  ["box-shadow", () => true],
  ["text-decoration-color", (p) => (p["text-decoration-line"] ?? "none") !== "none"],
  ["fill", () => true],
  ["stroke", (p) => p["stroke-width"] == null || px(p["stroke-width"]) > 0],
  ["accent-color", () => true],
  ["caret-color", () => true],
];

const fails = [];
const gaps = [];
const els = rec.elements ?? [];
if (els.length === 0) gaps.push("no elements recorded");

const safe = (label, fn) => {
  try {
    return fn();
  } catch (e) {
    gaps.push(`${label}: ${e.message}`);
    return [];
  }
};
const one = (label, v) => {
  const r = safe(label, () => colorsIn(v));
  return r.length ? r[0] : null;
};
const visiblePaint = (label, props) => {
  const res = [];
  for (const [prop, vis] of PAINT) {
    if (!(prop in props) || !vis(props)) continue;
    for (const c of safe(`${label} ${prop}`, () => colorsIn(props[prop]))) res.push({ prop, c, raw: props[prop] });
  }
  return res;
};
const hueIn = (c, [a, b]) => hueDeg(c) >= a && hueDeg(c) <= b;
const hueDist = (x, y) => {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
};

const ROLE = {
  source: parseColor("#38bdf8"),
  agent: parseColor("#3b82f6"),
  test: parseColor("#14b8a6"),
  person: parseColor("#a78bfa"),
  running: parseColor("#60a5fa"),
  success: parseColor("#14b8a6"),
};

function checkRole(label, role, c, mode) {
  if (!c) {
    gaps.push(`${label}: role ${role} recorded but its accent color is missing or paints nothing`);
    return;
  }
  if (role === "failed") {
    if (!(hueIn(c, RED_H) && chroma(c) >= RED_MIN_C))
      fails.push(`${label}: a failure is not drawn red (hue ${hueDeg(c).toFixed(0)}, chroma ${chroma(c).toFixed(3)})`);
    return;
  }
  const want = ROLE[role];
  if (!want) {
    gaps.push(`${label}: unknown role "${role}"`);
    return;
  }
  if (mode === "tint") {
    if (chroma(c) < 0.03 || hueDist(hueDeg(c), hueDeg(want)) > 35)
      fails.push(
        `${label}: not tinted by role ${role} (hue ${hueDeg(c).toFixed(0)} vs ${hueDeg(want).toFixed(0)}, chroma ${chroma(c).toFixed(3)})`,
      );
  } else if (dE(c, want) > 0.035) {
    fails.push(`${label}: role ${role} drawn ${dE(c, want).toFixed(3)} away from its token`);
  }
}

const untinted = rec.untinted ? one("untinted", rec.untinted) : null;
const cardsByRole = {};
const seen = { waiting: 0, failed: 0, running: 0, widths: new Set(), screens: new Set() };
for (const [i, e] of els.entries()) {
  const label = `${e.screen ?? "?"} @${e.width ?? "?"} ${e.target ?? `element ${i}`}`;
  seen.screens.add(e.screen);
  seen.widths.add(Number(e.width));
  const states = e.states ?? {};
  if (!states.rest) gaps.push(`${label}: no rest state`);
  // rules 1 and 4
  for (const [st, props] of Object.entries(states)) {
    for (const { prop, c, raw } of visiblePaint(`${label} [${st}]`, props ?? {})) {
      if (c.alpha <= VISIBLE_ALPHA) continue;
      if (chroma(c) >= BAND_MIN_C && hueIn(c, BAND_H)) fails.push(`${label} [${st}] ${prop} is amber (${raw})`);
      if (chroma(c) >= BAND_MIN_C && hueIn(c, MAGENTA_H)) fails.push(`${label} [${st}] ${prop} is magenta (${raw})`);
      if (chroma(c) >= RED_MIN_C && hueIn(c, RED_H) && e.role !== "failed")
        fails.push(`${label} [${st}] ${prop} is red on something that is not a failure (${raw})`);
    }
  }
  // rule 3
  if (e.waiting) {
    seen.waiting++;
    if (e.role !== "person") fails.push(`${label}: waits on a person but its role is ${e.role ?? "none"}, not violet`);
  }
  if (e.role === "failed") seen.failed++;
  if (e.role === "running") seen.running++;
  // rule 2
  if (e.role && e.kind !== "card") {
    const prop = e.accent_prop;
    if (!prop) gaps.push(`${label}: role recorded without accent_prop`);
    else checkRole(label, e.role, one(label, states.rest?.[prop]), e.mode ?? "exact");
  }
  // rule 5
  if (e.kind === "card") {
    if (!e.role) {
      fails.push(`${label}: a map card with no role color (grey)`);
      continue;
    }
    checkRole(`${label} bar`, e.role, one(label, e.bar), "exact");
    checkRole(`${label} border`, e.role, one(label, e.border), "tint");
    const f = one(label, e.fill);
    if (!f) gaps.push(`${label}: no fill recorded`);
    else {
      if (!untinted) gaps.push(`${label}: no "untinted" surface recorded to judge the fill against`);
      else {
        const off = { lab: [0, f.lab[1] - untinted.lab[1], f.lab[2] - untinted.lab[2]], alpha: 1 };
        if (chroma(off) < 0.008 || hueDist(hueDeg(off), hueDeg(ROLE[e.role] ?? f)) > 35)
          fails.push(`${label}: fill is not tinted toward ${e.role} (moved ${chroma(off).toFixed(4)} at hue ${hueDeg(off).toFixed(0)})`);
      }
      cardsByRole[e.role] ??= [];
      cardsByRole[e.role].push({ label, f });
    }
  }
}

const roles = Object.keys(cardsByRole);
for (const r of roles) {
  const list = cardsByRole[r];
  for (let a = 0; a < list.length; a++)
    for (let b = a + 1; b < list.length; b++)
      if (dE(list[a].f, list[b].f) > 0.004) fails.push(`${list[a].label} and ${list[b].label}: same role ${r}, different fills`);
}
for (let a = 0; a < roles.length; a++)
  for (let b = a + 1; b < roles.length; b++) {
    const x = cardsByRole[roles[a]][0];
    const y = cardsByRole[roles[b]][0];
    if (x && y && dE(x.f, y.f) < 0.006) fails.push(`${x.label} (${roles[a]}) and ${y.label} (${roles[b]}): fills not told apart`);
  }

// rule 6
for (const r of ["source", "agent", "test", "person"]) if (!cardsByRole[r]) gaps.push(`no ${r} card recorded`);
if (!seen.waiting) gaps.push("nothing that waits on a person recorded");
if (!seen.failed) gaps.push("no failure recorded");
if (!seen.running) gaps.push("nothing running recorded");
if (!seen.widths.has(1440)) gaps.push("nothing recorded at 1440 px");
if (!seen.widths.has(390) && !seen.widths.has(400)) gaps.push("nothing recorded at 390 or 400 px");
const served = rec.screens_served ?? [];
if (!served.length) gaps.push("screens_served is empty");
for (const s of served) if (!seen.screens.has(s)) gaps.push(`served screen "${s}" has no recorded element`);

if (fails.length) out("FAIL", [...fails, ...gaps]);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [
  `${els.length} elements on ${seen.screens.size} screens: no amber, no magenta, roles and waiting in their colors, red only on failures, every card tinted`,
]);
