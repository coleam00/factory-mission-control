import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { TOKEN_SOURCES } from '../harness/design-probe';

const repoRoot = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf-8');

interface Declaration {
  scope: string;
  property: string;
  value: string;
}

/** Every declaration in a stylesheet, with the chain of block preludes it sits in. */
function declarations(css: string): Declaration[] {
  const found: Declaration[] = [];
  const scopes: string[] = [];
  let pending = '';
  for (const char of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (char === '{') {
      scopes.push(pending.trim().replace(/\s+/g, ' '));
      pending = '';
    } else if (char === ';' || char === '}') {
      const colon = pending.indexOf(':');
      if (scopes.length > 0 && colon > 0 && !pending.trim().startsWith('@')) {
        found.push({
          scope: scopes.join(' > '),
          property: pending.slice(0, colon).trim(),
          value: pending
            .slice(colon + 1)
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/\(\s/g, '(')
            .replace(/\s\)/g, ')'),
        });
      }
      pending = '';
      if (char === '}') scopes.pop();
    } else {
      pending += char;
    }
  }
  return found;
}

const app = declarations(read('app/styles.css'));

describe('console and v2 role tokens', () => {
  for (const source of TOKEN_SOURCES.map((path) => relative(repoRoot, path))) {
    test(`every custom property in ${source} is declared identically in app/styles.css`, () => {
      const tokens = declarations(read(source)).filter((d) => d.property.startsWith('--'));
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        const copy = app.find((d) => d.scope === token.scope && d.property === token.property);
        expect({ ...token, value: copy?.value }).toEqual(token);
      }
    });
  }
});

type Rgb = [number, number, number];

function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (x: number, y: number) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);

function resolveColor(value: string, scope: string): Rgb {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) {
    const next = app.find((d) => d.scope === scope && d.property === ref[1]);
    if (!next) throw new Error(`unresolved ${value}`);
    return resolveColor(next.value, scope);
  }
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [0, 2, 4].map((i) => {
      const v = Number.parseInt(hex[1]?.slice(i, i + 2) ?? '0', 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
  }
  const ok = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (!ok) throw new Error(`unsupported color ${value}`);
  const lin = oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  return lin.map((v) => Math.min(1, Math.max(0, v))) as Rgb;
}

describe('focus ring', () => {
  const scope = '.console-root';
  const focus = app.find(
    (d) => d.scope === '.console-root :focus-visible' && d.property === 'outline',
  );
  const token = focus?.value.match(/^2px solid var\((--[\w-]+)\)$/)?.[1];
  const surface = app.find((d) => d.scope === scope && d.property === '--surface');
  const ring = app.find((d) => d.scope === scope && d.property === token);

  test('draws from the opaque accent token, which is blue, not amber', () => {
    expect(token).toBe('--accent');
    expect(ring?.value).not.toMatch(/rgba/);
  });

  test('reaches 3:1 against the menu surface, in color and in grayscale', () => {
    const bg = resolveColor(surface?.value ?? '', scope);
    const fg = resolveColor(ring?.value ?? '', scope);
    // Grayscale is luminance, which is also what WCAG contrast measures.
    expect(contrast(luminance(fg), luminance(bg))).toBeGreaterThanOrEqual(3);
  });
});

describe('recommended option tile', () => {
  const token = (name: string) => {
    const d = app.find((x) => x.property === name && x.value.startsWith('#'));
    if (!d) throw new Error(`missing ${name}`);
    return resolveColor(d.value, d.scope);
  };

  test('its consequence line reaches 4.5:1 on the violet wash', () => {
    const wash = luminance(token('--v3-you-wash'));
    expect(contrast(luminance(token('--v3-fg-2')), wash)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('fonts', () => {
  const families = app
    .filter((d) => d.property === 'font-family')
    .map((d) => d.value.split(',')[0]?.trim().replace(/['"]/g, ''));

  test('every font-family the app declares is Geist or Geist Mono', () => {
    expect(families.length).toBeGreaterThan(0);
    expect(new Set(families)).toEqual(new Set(['Geist', 'Geist Mono']));
  });

  test('the only fonts the app loads are Geist and Geist Mono', () => {
    const fontImports = [...read('app/styles.css').matchAll(/@import '([^']+)'/g)]
      .map((m) => m[1] ?? '')
      .filter((path) => path !== 'tailwindcss');
    expect(fontImports.length).toBeGreaterThan(0);
    for (const path of fontImports) expect(path).toMatch(/^@fontsource\/geist(-mono)?\/\d+\.css$/);
  });
});

describe('keyboard focus', () => {
  const rule = (scope: string) =>
    app.find((d) => d.scope.includes(scope) && d.property.startsWith('outline'));

  test("a details tab's ring is drawn inside it so the scrolling tab list cannot clip it", () => {
    expect(rule("[data-details] [role='tab']:focus-visible")?.value).toBe('-2px');
  });
});
