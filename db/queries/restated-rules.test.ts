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

  const live = [...read('scripts', 'live', 'health.ts').matchAll(/i\.title <> '([^']*)'/g)];
  expect(live.map((m) => m[1]).sort()).toEqual(expected);
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

test('map-right-now reads only paths the pinned merge queue declares', () => {
  const sql = sqlOf('map-right-now');
  const gate = sql.slice(0, sql.indexOf(') gate'));
  const joins = [
    ...gate.matchAll(
      /JOIN mc\.lap_steps (\w+) ON \1\.run_id = l\.run_id AND \1\.step_id = '([\w-]+)'/g,
    ),
  ];
  const steps = Object.fromEntries(joins.map((m) => [m[1], m[2]] as const));
  expect(steps).toEqual({ rec: 'record', fa: 'facts', sw: 'sweep' });
  // A read or join this parser cannot spell, or whose path continues past what it parsed,
  // would otherwise be skipped unchecked.
  expect(joins.length).toBe(gate.split('mc.lap_steps').length - 1);

  const reads = [...gate.matchAll(/\b(rec|fa|sw)\.output((?: ->>? '[\w]+')+)(?!\s*(?:->|#>|\[))/g)];
  expect(reads.length).toBe(gate.split(/\.output\b/).length - 1);
  const paths = new Set(
    reads.map(
      (m) =>
        `${steps[m[1] as string]}${[...(m[2] as string).matchAll(/'(\w+)'/g)].map((k) => `.${k[1]}`).join('')}`,
    ),
  );
  expect([...paths].sort()).toEqual([
    'facts.items',
    'record.asked.pr.number',
    'record.merged',
    'sweep.decisions',
  ]);

  const yaml = Bun.YAML.parse(
    read('fixtures', 'pack', 'queue', 'sdlc', 'merge-queue', 'archon-merge-queue.yaml'),
  ) as { nodes: { id: string; output_format?: { properties?: Record<string, unknown> } }[] };
  const mergeTs = read('fixtures', 'pack', 'queue', 'sdlc', '.shared', 'merge.ts');
  const forgeTs = read('fixtures', 'pack', 'queue', 'sdlc', '.shared', 'forge.ts');

  for (const path of paths) {
    const [step, ...keys] = path.split('.') as [string, ...string[]];
    const node = yaml.nodes.find((n) => n.id === step);
    expect(node?.output_format, `${step} declares an output_format`).toBeDefined();
    let at = node?.output_format as { properties?: Record<string, unknown> };
    const walked: string[] = [];
    for (const [i, key] of keys.entries()) {
      if (at.properties === undefined) {
        // The yaml leaves `record.asked` open; the pinned TypeScript is its only declaration.
        expect(path).toBe('record.asked.pr.number');
        expect(keys.slice(i)).toEqual(['pr', 'number']);
        expect(mergeTs).toMatch(
          /by: Extract<MergeAskedBy, 'pr'>;\s*readonly item: QualifiedPr;\s*readonly pr: QualifiedPr;/,
        );
        expect(forgeTs).toMatch(
          /export interface QualifiedPr \{\s*readonly repo:[^\n]*\n\s*readonly number: number;/,
        );
        break;
      }
      walked.push(key);
      expect(Object.keys(at.properties), `${step}.${walked.join('.')} is declared`).toContain(key);
      at = at.properties[key] as { properties?: Record<string, unknown> };
    }
  }
});
