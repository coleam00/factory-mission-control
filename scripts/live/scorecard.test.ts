import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEASURES } from '../../app/lib/scorecard';
import { compareScorecard, readExpectedScorecard, type ShownCell } from './scorecard';

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
      cell('merges', '3'),
      cell('cost_per_merge', 'n/a'),
      cell('send_backs', '2', { laps: '11', listed: 11, summary: '11 laps' }),
      cell('laps', '12', { listed: 11 }),
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

test('the expected scorecard on disk keys its measures by MEASURES', () => {
  expect(readExpectedScorecard(process.cwd()).versions.length).toBeGreaterThan(0);
});

describe('readExpectedScorecard refuses a file that disagrees with MEASURES', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const load = (measures: Record<string, unknown>) => {
    mkdirSync(join(dir, 'fixtures'), { recursive: true });
    writeFileSync(
      join(dir, 'fixtures', 'expected-scorecard.json'),
      JSON.stringify({ versions: [{ digest: 'sha256:a1', measures }] }),
    );
    return () => readExpectedScorecard(dir);
  };
  const all = Object.fromEntries(MEASURES.map((m) => [m.key, { value: 1, laps: 1 }]));

  test('a key MEASURES lacks', () => {
    expect(load({ ...all, bogus: { value: 1, laps: 1 } })).toThrow('bogus');
  });

  test('a MEASURES key the file lacks', () => {
    const { merges: _dropped, ...rest } = all;
    expect(load(rest)).toThrow('merges');
  });
});
