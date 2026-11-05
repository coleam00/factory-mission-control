import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLUMNS } from '../../app/lib/board';
import { queries } from './test-seed';

const root = join(import.meta.dir, '..', '..');
const read = (...path: string[]) => readFileSync(join(root, ...path), 'utf8');
const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
const quoted = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
// A computed path keeps tsc out of the pack, whose `.ts` import extensions this config refuses.
const pack = (...path: string[]) => import(join(root, 'fixtures', 'pack', ...path));

test('the health queries exclude exactly the pack manager titles', async () => {
  const { MANAGER_TITLES } = await pack('sdlc', '.shared', 'workable.ts');
  const expected = [...MANAGER_TITLES].sort();

  const notIn = sqlOf('health-workable').match(/i\.title NOT IN \(([^)]*)\)/);
  expect(notIn).not.toBeNull();
  expect(quoted(notIn?.[1] ?? '').sort()).toEqual(expected);
});

test('the board route CASE agrees with the pack ROUTE_LABEL', async () => {
  const { ROUTE_LABEL } = await pack('queue', 'sdlc', '.shared', 'labels.ts');
  const block = sqlOf('board').match(/CASE lb\.label([\s\S]*?)END\) AS route/);
  expect(block).not.toBeNull();
  const pairs = [...(block?.[1] ?? '').matchAll(/WHEN '([^']*)' THEN '([^']*)'/g)].map(
    (m) => [m[1], m[2]] as const,
  );
  expect(new Set(pairs.map(([label]) => label))).toEqual(new Set(Object.values(ROUTE_LABEL)));
  for (const [label, route] of pairs) expect(ROUTE_LABEL[route as string]).toBe(label);
});

test('the Board grid has one track per column', () => {
  expect(read('app', 'components', 'Board.tsx')).toContain(
    `grid-cols-[repeat(${COLUMNS.length},minmax(160px,1fr))]`,
  );
});
