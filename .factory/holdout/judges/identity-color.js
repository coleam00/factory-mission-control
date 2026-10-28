// Judge for H-56 and H-57: magenta is identity only (PRD 8.3, engineering.md Design rule, owner
// decision on #27 question 4, 2026-10-27). Links, selection, focus, hover and highlighted versions
// use neutral tokens; magenta appears only on identity (the product's brand mark and wordmark).
//
// Rules judged:
// 1. MAGENTA: no element that is not identity paints any visible color in the identity band, in any
//    state. An identity element's hover, focus-visible or selected changes are not identity either:
//    a property that changes for a state must not land in the band.
//    Band: OKLCH chroma >= 0.05 and hue in [300, 350] degrees (brand magenta 330, magenta-2 335,
//    violet 305, plum 325 all fall inside; the node-prompt step color at 290 and the reds at 10-25 do not).
//    A color counts as visible when its alpha is above 0.05 (the console's 30% magenta ring counts).
// 2. NEUTRAL: for interactive roles (link, selectable, control), every color property whose value
//    differs between rest and a state (hover, focus-visible, active, selected, selected-*) has
//    OKLCH chroma <= 0.04 (a neutral token). A link's rest color and underline color are neutral too.
// 3. DISTINGUISHABLE: for a selectable element, selected differs visibly from rest, from hover, and
//    selected-hover from hover, selected-focus-visible from focus-visible (each pair that is recorded).
//    Visibly: a visible color property differs by OKLab distance >= 0.04, or font-weight by >= 200,
//    or a visible border/outline width by >= 1px, or text-decoration-line differs, or box-shadow
//    differs (presence or a color by >= 0.04), or the recorded marker differs (an icon or text cue).
// 4. FOCUS: every recorded focus-visible state (and selected-focus-visible) shows an outline
//    (style not none, width >= 1px) or a box-shadow, whose color has contrast >= 3:1 against the
//    element's recorded background.
// 5. COVERAGE: the record must include, in the dark scheme and with the OS set to light: at least one
//    link (rest, hover, focus-visible), the Versions screen's version entries (rest, hover,
//    focus-visible, selected, selected-hover), one text-selection highlight, and the screens named in
//    REQUIRED_SCREENS. Anything missing is INCONCLUSIVE, never PASS. A color the judge cannot parse is
//    INCONCLUSIVE.
//
// Record shape (computed styles from getComputedStyle, strings as the browser returns them):
// {
//   "elements": [
//     { "screen": "versions", "width": 1440, "scheme": "dark" | "light",  // scheme = OS preference set
//       "target": "version V2 entry on the strip",
//       "role": "link" | "selectable" | "control" | "text-selection" | "identity" | "other",
//       "identity": false,               // true only for the brand mark / wordmark; give "identity_reason"
//       "background": "rgb(30, 31, 36)", // the opaque color the element sits on (for focus contrast)
//       "states": {
//         "rest":  { "color": "...", "background-color": "...", "background-image": "...",
//                    "border-top-color": "...", "border-top-width": "1px", (and right/bottom/left),
//                    "outline-style": "none", "outline-width": "0px", "outline-color": "...",
//                    "box-shadow": "none", "text-decoration-line": "none", "text-decoration-color": "...",
//                    "fill": "...", "stroke": "...", "font-weight": "400", "marker": "" },
//         "hover": { ... }, "focus-visible": { ... }, "active": { ... },
//         "selected": { ... }, "selected-hover": { ... }, "selected-focus-visible": { ... }
//       } }
//   ]
// }
// For role "text-selection", record the ::selection pseudo-element's "background-color" and "color"
// under states.rest.
//
// Run: bun .factory/holdout/judges/identity-color.js <record.json>
import { readFileSync } from "node:fs";

const BAND_MIN_C = 0.05;
const BAND_H = [300, 350];
const NEUTRAL_MAX_C = 0.04;
const VISIBLE_ALPHA = 0.05;
const DIFF_DE = 0.04;
const FOCUS_CONTRAST = 3;
const REQUIRED_SCREENS = [
  "home map",
  "step detail",
  "versions",
  "architecture diff",
  "factory",
  "owner queue",
  "testing",
  "one lap",
  "rewind",
  "health",
];

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
const visiblePaint = (label, props) => {
  const res = [];
  for (const [prop, vis] of PAINT) {
    if (!(prop in props) || !vis(props)) continue;
    for (const c of safe(`${label} ${prop}`, () => colorsIn(props[prop]))) res.push({ prop, c, raw: props[prop] });
  }
  return res;
};
const sameColors = (a, b) => {
  if (a.length !== b.length) return false;
  return a.every((x, i) => dE(x, b[i]) < 1e-3 && Math.abs(x.alpha - b[i].alpha) < 1e-3);
};

function visiblyDiffer(label, A, B) {
  if (!A || !B) return true;
  if ((A.marker ?? "") !== (B.marker ?? "")) return true;
  if (Math.abs(px(A["font-weight"]) - px(B["font-weight"])) >= 200) return true;
  if ((A["text-decoration-line"] ?? "none") !== (B["text-decoration-line"] ?? "none")) return true;
  for (const sd of SIDES) {
    const wa = A[`border-${sd}-style`] === "none" ? 0 : px(A[`border-${sd}-width`]);
    const wb = B[`border-${sd}-style`] === "none" ? 0 : px(B[`border-${sd}-width`]);
    if (Math.abs(wa - wb) >= 1) return true;
  }
  const ow = (p) => ((p["outline-style"] ?? "none") === "none" ? 0 : px(p["outline-width"]));
  if (Math.abs(ow(A) - ow(B)) >= 1) return true;
  for (const [prop, vis] of PAINT) {
    const ca = vis(A) ? safe(`${label} ${prop}`, () => colorsIn(A[prop])).filter((c) => c.alpha > VISIBLE_ALPHA) : [];
    const cb = vis(B) ? safe(`${label} ${prop}`, () => colorsIn(B[prop])).filter((c) => c.alpha > VISIBLE_ALPHA) : [];
    if (ca.length !== cb.length) return true;
    for (let i = 0; i < ca.length; i++) if (dE(ca[i], cb[i]) >= DIFF_DE) return true;
  }
  return false;
}

const INTERACTIVE = new Set(["link", "selectable", "control"]);
const coverage = new Map(); // key -> true
const mark = (k) => coverage.set(k, true);
const identityList = [];

for (const el of els) {
  const tag = `${el.screen ?? "?"} / ${el.target ?? "?"} (${el.width ?? "?"} px, OS ${el.scheme ?? "?"})`;
  const states = el.states ?? {};
  const rest = states.rest;
  if (!rest) {
    gaps.push(`${tag}: no rest state recorded`);
    continue;
  }
  if (el.screen) mark(`screen:${el.screen}:${el.scheme}`);
  for (const st of Object.keys(states)) mark(`${el.role}:${st}:${el.scheme}`);
  if (el.screen === "versions" && el.role === "selectable") for (const st of Object.keys(states)) mark(`versions:${st}:${el.scheme}`);
  if (el.identity) identityList.push(`${tag}: ${el.identity_reason ?? "no reason given"}`);
  if (el.identity && !el.identity_reason) gaps.push(`${tag}: marked identity with no identity_reason`);

  // 1. MAGENTA
  for (const [st, props] of Object.entries(states)) {
    const paint = visiblePaint(`${tag} ${st}`, props);
    for (const { prop, c, raw } of paint) {
      if (!inBand(c)) continue;
      if (!el.identity) {
        fails.push(`${tag}: ${st} ${prop} is identity magenta (${raw}) on a non-identity element`);
      } else if (st !== "rest") {
        const restVal = rest[prop];
        const restC = safe(`${tag} rest ${prop}`, () => colorsIn(restVal));
        if (!sameColors(restC, safe(`${tag} ${st} ${prop}`, () => colorsIn(raw))))
          fails.push(`${tag}: identity element's ${st} state changes ${prop} to magenta (${raw}); state cues are not identity`);
      }
    }
  }

  // 2. NEUTRAL
  if (INTERACTIVE.has(el.role)) {
    if (el.role === "link") {
      for (const prop of ["color", "text-decoration-color"]) {
        if (prop === "text-decoration-color" && (rest["text-decoration-line"] ?? "none") === "none") continue;
        for (const c of safe(`${tag} rest ${prop}`, () => colorsIn(rest[prop])))
          if (c.alpha > VISIBLE_ALPHA && chroma(c) > NEUTRAL_MAX_C)
            fails.push(`${tag}: link ${prop} at rest is not neutral (${rest[prop]}, chroma ${chroma(c).toFixed(3)})`);
      }
    }
    for (const [st, props] of Object.entries(states)) {
      if (st === "rest") continue;
      for (const [prop, vis] of PAINT) {
        if (!(prop in props) || !vis(props)) continue;
        const now = safe(`${tag} ${st} ${prop}`, () => colorsIn(props[prop]));
        const was = vis(rest) ? safe(`${tag} rest ${prop}`, () => colorsIn(rest[prop])) : [];
        if (sameColors(now, was)) continue;
        for (const c of now)
          if (c.alpha > VISIBLE_ALPHA && chroma(c) > NEUTRAL_MAX_C)
            fails.push(`${tag}: ${st} changes ${prop} to a non-neutral color (${props[prop]}, chroma ${chroma(c).toFixed(3)})`);
      }
    }
  }

  // 3. DISTINGUISHABLE
  if (el.role === "selectable") {
    const pairs = [
      ["selected", "rest"],
      ["selected", "hover"],
      ["selected-hover", "hover"],
      ["selected-focus-visible", "focus-visible"],
    ];
    for (const [a, b] of pairs) {
      if (!states[a] || !states[b]) continue;
      if (!visiblyDiffer(tag, states[a], states[b]))
        fails.push(`${tag}: ${a} cannot be told from ${b} without color it does not have (no visible difference)`);
    }
    if (!states.selected) gaps.push(`${tag}: selectable element with no selected state recorded`);
  }

  // 4. FOCUS
  for (const st of ["focus-visible", "selected-focus-visible"]) {
    const p = states[st];
    if (!p) continue;
    let bg;
    try {
      bg = parseColor(el.background);
    } catch (e) {
      gaps.push(`${tag}: background ${e.message}`);
      continue;
    }
    if (!bg) {
      gaps.push(`${tag}: no opaque background recorded for focus contrast`);
      continue;
    }
    const ring = [];
    if ((p["outline-style"] ?? "none") !== "none" && px(p["outline-width"]) >= 1)
      ring.push(...safe(`${tag} ${st} outline-color`, () => colorsIn(p["outline-color"])));
    ring.push(...safe(`${tag} ${st} box-shadow`, () => colorsIn(p["box-shadow"])));
    const best = ring.filter((c) => c.alpha > VISIBLE_ALPHA).map((c) => contrast(c, bg));
    if (best.length === 0) fails.push(`${tag}: ${st} shows no focus outline or ring`);
    else if (Math.max(...best) < FOCUS_CONTRAST)
      fails.push(`${tag}: ${st} ring contrast ${Math.max(...best).toFixed(2)}:1 against its background (needs ${FOCUS_CONTRAST}:1)`);
  }
}

// 5. COVERAGE
for (const scheme of ["dark", "light"]) {
  for (const s of REQUIRED_SCREENS) if (!coverage.has(`screen:${s}:${scheme}`)) gaps.push(`no element recorded on screen "${s}" with OS ${scheme}`);
  for (const st of ["rest", "hover", "focus-visible"]) if (!coverage.has(`link:${st}:${scheme}`)) gaps.push(`no link ${st} state recorded with OS ${scheme}`);
  for (const st of ["rest", "hover", "focus-visible", "selected", "selected-hover"])
    if (!coverage.has(`versions:${st}:${scheme}`)) gaps.push(`no Versions-screen version entry ${st} state recorded with OS ${scheme}`);
  if (!coverage.has(`text-selection:rest:${scheme}`)) gaps.push(`no text-selection highlight recorded with OS ${scheme}`);
}

if (identityList.length) console.log(`identity elements (exempt from rule 1 at rest only):\n  ${identityList.join("\n  ")}`);
if (fails.length) out("FAIL", fails);
if (gaps.length) out("INCONCLUSIVE", gaps);
out("PASS", [`${els.length} elements: no non-identity magenta, state cues neutral and distinguishable, focus visible`]);
