import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/cli';
import { parseRealtimeFeatures } from './test-live';

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
    'EXISTS in CASE',
  ]) {
    expect(names).toContain(name);
  }
  for (const f of features) {
    expect(f.probe).toMatch(/^(SELECT|WITH)\b/);
    expect(f.verdict === 'rejected').toBe(f.error !== '');
  }
});
