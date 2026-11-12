import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
});
afterAll(() => db.close());

const FACTORY = 'mission-control';
const DAY_START = '2026-10-24T00:00:00.000Z';
const sql = queries.find(([n]) => n === 'failure-groups')?.[1] as string;

test('on the seed every finished or failed run has a stop record, classed and signed when failed', async () => {
  expect(
    await db.query(`SELECT l.run_id FROM mc.laps l LEFT JOIN mc.run_stops s USING (run_id)
      WHERE l.status IN ('completed', 'failed') AND s.run_id IS NULL`),
  ).toEqual([]);
  expect(
    await db.query(`SELECT run_id FROM mc.run_stops
      WHERE status = 'failed' AND (class IS NULL OR signature IS NULL)`),
  ).toEqual([]);
});

test('failure-groups returns the factory’s unresolved failures as groups with 14 daily counts', async () => {
  const groups = await db.query(sql, [FACTORY]);
  const [{ failed } = { failed: 0 }] = await db.query(
    `SELECT count(*)::int AS failed FROM mc.run_stops WHERE factory = $1 AND status = 'failed'`,
    [FACTORY],
  );
  expect(groups.length).toBeGreaterThan(0);
  const [{ console: factoryConsole } = { console: null }] = await db.query(
    'SELECT console FROM mc.factories WHERE name = $1',
    [FACTORY],
  );
  for (const g of groups) expect(g.console).toBe(factoryConsole);
  for (const g of groups) expect((g.daily as number[]).length).toBe(14);
  const failures = groups.reduce((n, g) => n + Number(g.failures), 0);
  const daily = groups.reduce((n, g) => n + (g.daily as number[]).reduce((a, b) => a + b, 0), 0);
  expect(daily).toBe(failures);
  expect(failures).toBeLessThan(Number(failed));
});

test('failure-groups counts a failed run until a later run of its workflow on its item completes, or it is 14 days older than the factory’s latest stop', async () => {
  const factory = 'resolve-proof';
  let n = 0;
  const runId = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const lap = async (
    workflow: string,
    status: 'completed' | 'failed',
    day: string,
    opts: { issue?: number; error?: string; steps?: [string, unknown][]; claim?: number } = {},
  ) => {
    const id = runId();
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at, issue_number)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6)`,
      [id, factory, workflow, status, `${day}T09:00:00Z`, opts.issue ?? null],
    );
    for (const [step, output] of opts.steps ?? []) {
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, output) VALUES ($1, $2, 'completed', $3)`,
        [id, step, JSON.stringify(output)],
      );
    }
    if (opts.claim !== undefined) {
      await db.query(
        `INSERT INTO mc.claims (factory, issue_number, run_id, claimed_at) VALUES ($1, $2, $3, $4::timestamptz)`,
        [factory, opts.claim, id, `${day}T09:00:00Z`],
      );
    }
    if (opts.error !== undefined) {
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
         VALUES ($1, 'prepare', 'failed', $2::timestamptz, $3)`,
        [id, `${day}T09:00:00Z`, opts.error],
      );
    }
    return id;
  };
  const facts = (issue: number): [string, unknown][] => [['facts', { item: { number: issue } }]];

  await lap('anchor', 'completed', '2026-10-25');
  // a: failure then success, same workflow, same item (held by its facts step)
  await lap('build', 'failed', '2026-10-20', { steps: facts(1), error: 'error: case a' });
  await lap('build', 'completed', '2026-10-21', { steps: facts(1) });
  // b: failure then another failure on the same item
  await lap('build', 'failed', '2026-10-18', { issue: 2, error: 'error: case b' });
  const latestB = await lap('build', 'failed', '2026-10-19', { issue: 2, error: 'error: case b' });
  // c: older than 14 days before the factory's latest stop
  await lap('build', 'failed', '2026-10-05', { issue: 3, error: 'error: case c' });
  // d: an app check keyed by its PR, failure then success
  await lap('factory-app-check', 'failed', '2026-10-20', {
    steps: [['select', { pr: 70 }]],
    error: 'error: case d',
  });
  await lap('factory-app-check', 'completed', '2026-10-22', { steps: [['select', { pr: 70 }]] });
  // e: an item held by claim
  await lap('build', 'failed', '2026-10-20', { claim: 4, error: 'error: case e' });
  await lap('build', 'completed', '2026-10-21', { claim: 4 });
  // f: a success of another workflow on the item resolves nothing
  await lap('build', 'failed', '2026-10-20', { issue: 5, error: 'error: case f' });
  await lap('other', 'completed', '2026-10-21', { issue: 5 });
  // g: a success that finished before the failure resolves nothing
  await lap('build', 'completed', '2026-10-10', { issue: 6 });
  await lap('build', 'failed', '2026-10-20', { issue: 6, error: 'error: case g' });
  // i: exactly 14 days before the latest stop is outside the sparkline window and resolved; 13 days is counted
  await lap('build', 'failed', '2026-10-11', { issue: 7, error: 'error: case i14' });
  await lap('build', 'failed', '2026-10-12', { issue: 8, error: 'error: case i13' });
  // h: a run with no item is resolved by age alone
  await lap('noitem', 'failed', '2026-10-20', { error: 'error: case h' });
  await lap('noitem', 'completed', '2026-10-22');

  const groups = await db.query(sql, [factory]);
  expect(groups.map((g) => g.line).sort()).toEqual([
    'error: case b',
    'error: case f',
    'error: case g',
    'error: case h',
    'error: case i13',
  ]);
  const b = groups.find((g) => g.line === 'error: case b');
  expect(b?.failures).toBe(2);
  expect(b?.latest_run_id).toBe(latestB);
  // i14 and i13 share one signature group: a wrongly counted 14-day run shows only in the count
  expect(groups.find((g) => g.line === 'error: case i13')?.failures).toBe(1);
});

test('failure-groups orders daily oldest first and names the newest failure as the latest run', async () => {
  const day = (d: string) => new Date(`${d}T09:00:00Z`);
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
  await db.query(
    `INSERT INTO mc.run_stops (run_id, factory, workflow_name, status, step_id, line, class, signature, stopped_at)
    VALUES ($1, 'order-proof', 'w', 'failed', 's', 'old', 'code', 'sig', $3::timestamptz),
           ($2, 'order-proof', 'w', 'failed', 's', 'new', 'code', 'sig', $4::timestamptz)`,
    [ids[0], ids[1], day('2026-10-23').toISOString(), day('2026-10-25').toISOString()],
  );
  const [g] = await db.query(sql, ['order-proof']);
  expect(g?.daily).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
  expect(new Date(g?.last_day as string).toISOString().slice(0, 10)).toBe('2026-10-25');
  expect(g?.latest_run_id).toBe(ids[1]);
});

test('failure-groups shows the latest run’s class, or mixed when the group’s runs differ', async () => {
  const row = (n: number, cls: string | null, day: string) =>
    db.query(
      `INSERT INTO mc.run_stops (run_id, factory, workflow_name, status, step_id, line, class, signature, stopped_at)
       VALUES ($1, $2, 'w', 'failed', 's', 'l', $3, $4, $5::timestamptz)`,
      [
        `bbbbbbbb-0000-4000-8000-00000000000${n}`,
        `class-proof`,
        cls,
        `sig-${n > 4 ? 'c' : n > 2 ? 'b' : 'a'}`,
        day,
      ],
    );
  await row(1, 'transient', '2026-10-23');
  await row(2, 'config', '2026-10-24');
  await row(3, 'code', '2026-10-24');
  await row(4, 'code', '2026-10-25');
  await row(5, null, '2026-10-24');
  await row(6, 'code', '2026-10-25');
  const groups = await db.query(sql, ['class-proof']);
  expect(Object.fromEntries(groups.map((g) => [g.signature, g.class]))).toEqual({
    'sig-a': 'mixed',
    'sig-b': 'code',
    'sig-c': 'mixed',
  });
});

test('a transient failure that a later run of its workflow retried is the muted line, not a card; one not retried, and a non-transient failure, stay cards', async () => {
  const factory = 'blip-proof';
  let n = 0;
  const lap = async (
    workflow: string,
    status: 'completed' | 'failed',
    at: string,
    opts: { issue?: number; error?: string } = {},
  ) => {
    const id = `dddddddd-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at, issue_number)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6)`,
      [id, factory, workflow, status, at, opts.issue ?? null],
    );
    if (opts.error !== undefined) {
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
         VALUES ($1, 'prepare', 'failed', $2::timestamptz, $3)`,
        [id, at, opts.error],
      );
    }
    return id;
  };
  const day = '2026-10-24';
  const a = await lap('ticks', 'failed', `${day}T08:00:00Z`, {
    error: "Couldn't connect to compute node",
  });
  await lap('ticks', 'completed', `${day}T08:10:00Z`);
  const b = await lap('ticks', 'failed', `${day}T08:20:00Z`, { error: 'error: out of memory' });
  await lap('ticks', 'completed', `${day}T08:30:00Z`);
  await lap('stuck', 'failed', `${day}T09:00:00Z`, { error: 'gh: HTTP 502: Bad Gateway' });
  const d = await lap('build', 'failed', `${day}T07:00:00Z`, {
    issue: 9,
    error: 'deadlock detected',
  });
  await lap('build', 'completed', `${day}T07:45:00Z`, { issue: 10 });
  await lap('steady', 'failed', `${day}T07:30:00Z`, { error: 'error: type check failed' });
  await lap('steady', 'completed', `${day}T07:50:00Z`);
  await lap('ticks', 'failed', '2026-10-22T08:00:00Z', { error: 'error: out of memory' });
  await lap('ticks', 'completed', '2026-10-22T08:10:00Z');

  const groups = await db.query(sql, [factory]);
  expect(groups.map((g) => g.workflow_name).sort()).toEqual(['steady', 'stuck']);
  expect(groups.find((g) => g.workflow_name === 'stuck')?.class).toBe('transient');

  const retried = queries.find(([name]) => name === 'retried-runs')?.[1] as string;
  expect((await db.query(retried, [factory, DAY_START])).map((r) => r.run_id)).toEqual([b, a, d]);
  expect(await db.query(retried, ['resolve-proof', DAY_START])).toEqual([]);
});
