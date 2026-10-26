import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/cli';
import { SEED_CODEBASE } from './seed';
import { seedLaps } from './seed-laps';

test("reads every run of the seed's mission-control codebase, with the generator's account of it", () => {
  const seed = readFileSync(join(REPO_ROOT, 'fixtures', 'seed.sql'), 'utf8');
  const laps = seedLaps(seed);
  const runs = seed
    .match(/^INSERT INTO remote_agent_workflow_runs .*$/gm)
    ?.filter((run) => run.includes(`'${SEED_CODEBASE}'`));
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
