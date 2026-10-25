import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');

// Archon on this machine owns DATABASE_URL; the app reads MC_DATABASE_URL only.
test('app/ and server/ never read DATABASE_URL', () => {
  const offenders: string[] = [];
  for (const file of new Bun.Glob('{app,server}/**/*.{ts,tsx}').scanSync(repoRoot)) {
    if (join(repoRoot, file) === import.meta.path) continue;
    const source = readFileSync(join(repoRoot, file), 'utf-8');
    if (/\bDATABASE_URL\b/.test(source)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
