import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, paramsFor, queries } from './test-seed';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
});
afterAll(() => db.close());

const FACTORY = 'mission-control';
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
  const groups = await db.query(sql, paramsFor('failure-groups', FACTORY));
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

/** The cutoff the resolve rules run against: a failure at or before it is resolved by age. */
const CUTOFF = '2026-10-10T09:00:00.000Z';
/** A cutoff older than every row, for tests that do not exercise age. */
const NEVER_OLD = '2000-01-01T00:00:00.000Z';

test('failure-groups resolves a failure when its item closes, a later run of its workflow completes on the item, or it is at or before the cutoff', async () => {
  const factory = 'resolve-proof';
  let n = 0;
  const runId = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const lap = async (
    workflow: string,
    status: 'completed' | 'failed',
    at: string,
    opts: { issue?: number; error?: string; steps?: [string, unknown][]; claim?: number } = {},
  ) => {
    const id = runId();
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at, issue_number)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6)`,
      [id, factory, workflow, status, at, opts.issue ?? null],
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
        [factory, opts.claim, id, at],
      );
    }
    if (opts.error !== undefined) {
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
         VALUES ($1, 'prepare', 'failed', $2::timestamptz, $3)`,
        [id, at, opts.error],
      );
    }
    return id;
  };
  const facts = (issue: number): [string, unknown][] => [['facts', { item: { number: issue } }]];
  const issue = (number: number, state: 'open' | 'closed') =>
    db.query(
      `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
       VALUES ($1, $2, 't', $3, 'u', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      [factory, number, state],
    );
  const pull = (number: number, state: 'open' | 'closed') =>
    db.query(
      `INSERT INTO mc.pull_requests (factory, number, title, state, head_sha, url, created_at, updated_at)
       VALUES ($1, $2, 't', $3, 'sha', 'u', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      [factory, number, state],
    );
  const oct = (day: number) => `2026-10-${day}T09:00:00Z`;

  // a later completed run, same workflow, same item: held by facts, a claim, the lap's own issue, a PR
  await lap('build', 'failed', oct(20), { steps: facts(1), error: 'error: later-facts' });
  await lap('build', 'completed', oct(21), { steps: facts(1) });
  await lap('build', 'failed', oct(20), { claim: 4, error: 'error: later-claim' });
  await lap('build', 'completed', oct(21), { claim: 4 });
  await lap('build', 'failed', oct(20), { issue: 11, error: 'error: later-lap' });
  await lap('build', 'completed', oct(21), { issue: 11 });
  await lap('factory-app-check', 'failed', oct(20), {
    steps: [['select', { pr: 70 }]],
    error: 'error: later-pr',
  });
  await lap('factory-app-check', 'completed', oct(22), { steps: [['select', { pr: 70 }]] });
  // another failure on the item, a success of another workflow, a success before the failure: nothing resolves
  await lap('build', 'failed', oct(18), { issue: 2, error: 'error: kept-twice' });
  const latestTwice = await lap('build', 'failed', oct(19), {
    issue: 2,
    error: 'error: kept-twice',
  });
  await lap('build', 'failed', oct(20), { issue: 5, error: 'error: kept-other-workflow' });
  await lap('other', 'completed', oct(21), { issue: 5 });
  await lap('build', 'completed', oct(15), { issue: 6 });
  await lap('build', 'failed', oct(20), { issue: 6, error: 'error: kept-success-before' });
  // a closed item resolves; an open one does not
  await issue(12, 'closed');
  await lap('build', 'failed', oct(20), { issue: 12, error: 'error: closed-issue' });
  await issue(13, 'open');
  await lap('build', 'failed', oct(20), { issue: 13, error: 'error: kept-open-issue' });
  await pull(71, 'closed');
  await lap('factory-app-check', 'failed', oct(20), {
    steps: [['select', { pr: 71 }]],
    error: 'error: closed-pr',
  });
  await pull(72, 'open');
  await lap('factory-app-check', 'failed', oct(20), {
    steps: [['select', { pr: 72 }]],
    error: 'error: kept-open-pr',
  });
  // no item: a later completed run of the same workflow resolves, another workflow's does not
  await lap('noitem', 'failed', oct(20), { error: 'error: no-item-later' });
  await lap('noitem', 'completed', oct(22));
  await lap('lonely', 'failed', oct(20), { error: 'error: kept-no-item-other' });
  await lap('noitem', 'completed', oct(23));
  // age: a failure at exactly the cutoff is resolved, one a minute after it is counted
  await lap('aging', 'failed', '2026-10-10T09:00:00Z', { issue: 7, error: 'error: age-at-cutoff' });
  await lap('aging', 'failed', '2026-10-10T09:01:00Z', {
    issue: 8,
    error: 'error: kept-age-after',
  });

  const groups = await db.query(sql, [factory, CUTOFF]);
  expect(groups.map((g) => g.line).sort()).toEqual([
    'error: kept-age-after',
    'error: kept-no-item-other',
    'error: kept-open-issue',
    'error: kept-open-pr',
    'error: kept-other-workflow',
    'error: kept-success-before',
    'error: kept-twice',
  ]);
  const twice = groups.find((g) => g.line === 'error: kept-twice');
  expect(twice?.failures).toBe(2);
  expect(twice?.latest_run_id).toBe(latestTwice);
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
  const [g] = await db.query(sql, ['order-proof', NEVER_OLD]);
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
  const groups = await db.query(sql, ['class-proof', NEVER_OLD]);
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
  await lap('ticks', 'failed', `${day}T08:20:00Z`, { error: 'error: out of memory' });
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

  const groups = await db.query(sql, [factory, NEVER_OLD]);
  expect(groups.map((g) => g.workflow_name)).toEqual(['stuck']);
  expect(groups.find((g) => g.workflow_name === 'stuck')?.class).toBe('transient');

  const retried = queries.find(([name]) => name === 'retried-runs')?.[1] as string;
  expect((await db.query(retried, [factory])).map((r) => r.run_id)).toEqual([a, d]);
  expect(await db.query(retried, ['resolve-proof'])).toEqual([]);
});

test('on the seed a failed run whose item is closed reads as finished, one whose item is open does not', async () => {
  const oneLap = queries.find(([n]) => n === 'one-lap')?.[1] as string;
  const [closed] = await db.query(oneLap, [FACTORY, '5eed0002-0000-4000-8000-000000000008']);
  expect(closed?.item_merged_at).not.toBeNull();
  expect(closed?.finished_by).toBe('5eed0002-0000-4000-8000-00000000000a');
  const [open] = await db.query(oneLap, [FACTORY, '5eed0003-0000-4000-8000-000000000002']);
  expect([open?.item_closed_at, open?.finished_by]).toEqual([null, null]);
});
