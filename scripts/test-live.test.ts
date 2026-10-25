import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/cli';
import { compareScorecard, parseRealtimeFeatures, type ShownCell } from './test-live';

test('REALTIME.md gives test:live a probe and a verdict for each feature the live queries rely on', () => {
  const features = parseRealtimeFeatures(
    readFileSync(join(REPO_ROOT, 'db', 'queries', 'REALTIME.md'), 'utf-8'),
  );
  const names = features.map((f) => f.feature);
  for (const name of [
    'CTE',
    'LATERAL',
    'DISTINCT ON',
    'window function',
    'LEFT JOIN LATERAL',
    'UNION ALL',
    'NOT EXISTS',
  ]) {
    expect(names).toContain(name);
  }
  for (const f of features) {
    expect(f.probe).toMatch(/^(SELECT|WITH)\b/);
    expect(f.verdict === 'rejected').toBe(f.error !== '');
  }
});

test('the scorecard comparison counts a number missing from the screen as a mismatch', () => {
  const cell = (measure: string, value: string, over: Partial<ShownCell> = {}): ShownCell => ({
    digest: 'sha256:a1',
    measure,
    value,
    laps: '12',
    listed: 12,
    summary: '12 laps',
    ...over,
  });
  const expected = {
    versions: [
      {
        digest: 'sha256:a1',
        measures: {
          merges: { value: 3, laps: 12 },
          cost_per_merge: { value: null, laps: 12 },
          send_backs: { value: 2, laps: 12 },
          empty_laps: { value: 1, laps: 12 },
        },
      },
    ],
  };
  const { comparisons, mismatches, lapListFailures } = compareScorecard(
    [
      cell('merges', '3.0000'),
      cell('cost_per_merge', 'n/a'),
      cell('send_backs', '2.0000', { laps: '11', listed: 11, summary: '11 laps' }),
      cell('laps', '12.0000', { listed: 11 }),
    ],
    expected,
  );
  expect(comparisons.map((c) => [c.measure, c.match])).toEqual([
    ['merges', true],
    ['cost_per_merge', true],
    ['send_backs', false],
    ['empty_laps', false],
  ]);
  expect(mismatches).toBe(2);
  expect(lapListFailures).toHaveLength(1);
  expect(lapListFailures[0]).toContain('laps: data-laps 12, lists 11');
});
