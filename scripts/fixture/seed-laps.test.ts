import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/cli';
import { seedLaps } from './seed-laps';

test("reads every run the seed holds, with the generator's account of it", () => {
  const laps = seedLaps(readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8'));
  const runs = readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8').match(
    /^INSERT INTO remote_agent_workflow_runs /gm,
  );
  expect(laps).toHaveLength(runs?.length ?? 0);
  expect(new Set(laps.map((l) => l.runId)).size).toBe(laps.length);
  expect(laps.find((l) => l.label === 'V1 k4')).toEqual({
    label: 'V1 k4',
    runId: '5eed0001-0000-4000-8000-000000000004',
    what: 'needs-owner',
    issue: 4,
  });
  expect(laps.find((l) => l.label === 'V3 run Q')).toMatchObject({ what: 'pending', issue: null });
});
