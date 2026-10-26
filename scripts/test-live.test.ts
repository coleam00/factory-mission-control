import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/cli';
import { NOW, recordingDeps, scratchRepo } from './lib/test-deps';
import { compareScorecard, main, parseRealtimeFeatures, type ShownCell } from './test-live';

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
    'starts_with()',
    'EXISTS in CASE',
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

/**
 * `main` over deps with no check branch, so `test:live` fails at its first step (reading
 * `MC_DATABASE_URL`) and records whether this process held the lock at that moment.
 */
function lockedRun(options: { holder?: number; onSleep?: (sleeps: number) => void } = {}) {
  const lock = join(scratchRepo(), 'test-live.lock');
  if (options.holder !== undefined) {
    writeFileSync(lock, `${JSON.stringify({ pid: options.holder, since: NOW.toISOString() })}\n`);
  }
  const heldDuringWork: (number | undefined)[] = [];
  const env = new Proxy<Record<string, string | undefined>>(
    { MC_TEST_LIVE_LOCK: lock },
    {
      get(target, key: string) {
        if (key === 'MC_DATABASE_URL') {
          heldDuringWork.push(
            existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf-8')).pid : undefined,
          );
        }
        return target[key];
      },
    },
  );
  const recorder = recordingDeps({ repoRoot: scratchRepo(), env });
  recorder.deps.env = env;
  let clock = NOW.getTime();
  let sleeps = 0;
  recorder.deps.now = () => new Date(clock);
  recorder.deps.sleep = async (ms) => {
    sleeps += 1;
    clock += ms;
    options.onSleep?.(sleeps);
  };
  return { lock, recorder, heldDuringWork, sleeps: () => sleeps };
}

const NOT_SET = 'MC_DATABASE_URL is not set: run `bun run fixture:branch` first';

test('test:live takes a free lock before it starts and releases it when it fails', async () => {
  const { lock, recorder, heldDuringWork } = lockedRun();
  expect(await main([], recorder.deps)).toBe(1);
  expect(heldDuringWork).toEqual([process.pid]);
  expect(existsSync(lock)).toBe(false);
  expect(recorder.err).toEqual([NOT_SET]);
  expect(recorder.out).toEqual([]);
});

test('test:live waits for a live holder, naming its process id, then runs once it lets go', async () => {
  const holder = process.ppid;
  const run = lockedRun({
    holder,
    onSleep: (sleeps) => {
      if (sleeps === 3) rmSync(run.lock);
    },
  });
  expect(await main([], run.recorder.deps)).toBe(1);
  expect(run.sleeps()).toBe(3);
  expect(run.recorder.out).toEqual([
    `waiting for test:live lock ${run.lock}, held by process ${holder} (up to 30 min)`,
    `took test:live lock ${run.lock}`,
  ]);
  expect(run.heldDuringWork).toEqual([process.pid]);
  expect(existsSync(run.lock)).toBe(false);
});

test('test:live takes over a lock left by a process that no longer exists', async () => {
  const gone = Bun.spawn([process.execPath, '-e', '0']);
  await gone.exited;
  const { lock, recorder, heldDuringWork, sleeps } = lockedRun({ holder: gone.pid });
  expect(await main([], recorder.deps)).toBe(1);
  expect(sleeps()).toBe(0);
  expect(recorder.out).toEqual([
    `test:live lock ${lock} was left by process ${gone.pid}, which no longer exists: taking it over`,
  ]);
  expect(heldDuringWork).toEqual([process.pid]);
  expect(existsSync(lock)).toBe(false);
});

test('test:live gives up after 30 minutes, naming the holder, and leaves its lock alone', async () => {
  const holder = process.ppid;
  const { lock, recorder, heldDuringWork } = lockedRun({ holder });
  expect(await main([], recorder.deps)).toBe(1);
  expect(heldDuringWork).toEqual([]);
  expect(recorder.err).toEqual([
    `test:live lock ${lock} is still held by process ${holder} after 30 min: another test:live is running on this machine`,
  ]);
  expect(JSON.parse(readFileSync(lock, 'utf-8')).pid).toBe(holder);
});

test('the usage text says test:live runs one at a time per machine', async () => {
  const { recorder } = lockedRun();
  expect(await main(['--help'], recorder.deps)).toBe(0);
  expect(recorder.out.join('\n')).toContain('Runs one at a time per machine');
});
