import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

describe('console tokens', () => {
  for (const source of [
    'docs/design/archon-console/theme.css',
    'docs/design/archon-console/index.css',
  ]) {
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
