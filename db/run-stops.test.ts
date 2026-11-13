import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eventData } from '../scripts/fixture/write';
import { runMigrations } from '../scripts/migrate';
import { migratedDb } from './queries/test-seed';
import { STOP_CORPUS, STOP_LINE_CORPUS } from './run-stops-corpus';
import { archonDb, migrationFiles, type TestDb } from './test-db';

let db: TestDb;
beforeAll(async () => {
  db = await migratedDb();
});
afterAll(async () => {
  await db.close();
});

test('mc.stop_class puts a corpus of real error lines in the expected classes', async () => {
  expect(STOP_CORPUS.length).toBeGreaterThanOrEqual(25);
  const got = [];
  for (const [line, , source] of STOP_CORPUS) {
    const [row] = await db.query('SELECT mc.stop_class($1) AS class', [line]);
    got.push([line, row?.class, source]);
  }
  expect(got).toEqual(STOP_CORPUS.map(([line, cls, source]) => [line, cls, source]));
});

test('mc.stop_line picks an error: line, else a command’s failed: line, else the first line', async () => {
  const got = [];
  for (const [text, , source] of STOP_LINE_CORPUS) {
    const [row] = await db.query('SELECT mc.stop_line($1) AS line', [text]);
    got.push([text, row?.line, source]);
  }
  expect(got).toEqual(STOP_LINE_CORPUS.map(([text, line, source]) => [text, line, source]));
  for (const [line] of STOP_CORPUS.filter(([l]) => !/[\r\n]/.test(l))) {
    const [row] = await db.query('SELECT mc.stop_line($1) AS line', [line]);
    expect(row?.line).toBe(line.trim());
  }
});

test('mc.stop_signature ignores ids, numbers, paths and shas, and keeps steps and workflows apart', async () => {
  const sig = async (workflow: string, step: string, line: string) =>
    (
      (await db.query('SELECT mc.stop_signature($1, $2, $3) AS s', [workflow, step, line]))[0] as {
        s: string;
      }
    ).s;
  const a = await sig(
    'archon-build-queue',
    'check',
    String.raw`check must write C:\w\run-1\app-check\result.json, round 2 of 3 at 4f2a9c1d0b7e for 7c2f1e87-4010-4c2a-9ac4-f00000000000`,
  );
  const b = await sig(
    'archon-build-queue',
    'check',
    String.raw`check must write D:\x\run-9\app-check\result.json, round 7 of 9 at 0a1b2c3d4e5f for 11111111-2222-4333-8444-555555555555`,
  );
  expect(a).toBe(b);
  expect(await sig('archon-build-queue', 'evidence', 'check must write x')).not.toBe(
    await sig('archon-build-queue', 'check', 'check must write x'),
  );
  expect(await sig('archon-loop', 'check', 'x')).not.toBe(
    await sig('archon-build-queue', 'check', 'x'),
  );
  expect(await sig('w', 's', 'GET https://api.github.com/x failed')).toContain('https:');
  expect(await sig('w', 's', 'gh: HTTP 504: Gateway Timeout')).toBe(
    await sig('w', 's', 'gh: HTTP 401: Gateway Timeout'),
  );
});

const NOW = new Date('2026-10-25T12:00:00Z');
const stopOf = async (id: string) =>
  (
    await db.query(
      'SELECT step_id, line, class, status, signature FROM mc.run_stops WHERE run_id = $1',
      [id],
    )
  )[0];
const newRun = async (workflow = 'archon-build-queue', status = 'running', metadata: object = {}) =>
  String(
    (
      await db.query(
        `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
         VALUES ($1, $2, 'q', $3) RETURNING id`,
        [workflow, status, JSON.stringify(metadata)],
      )
    )[0]?.id,
  );
const setStatus = (id: string, status: string) =>
  db.query(
    `UPDATE public.remote_agent_workflow_runs SET status = $2::text,
       completed_at = CASE WHEN $2 IN ('running', 'paused') THEN NULL ELSE now() END WHERE id = $1`,
    [id, status],
  );
const failStep = (id: string, step: string, error: string) =>
  db.query(
    `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
     VALUES ($1, 'node_failed', $2, $3)`,
    [id, step, JSON.stringify(eventData(step, 'node_failed', NOW, error))],
  );

test('a run stop record follows Archon’s writes, so a fixed run never shows as failing', async () => {
  const id = await newRun();
  await failStep(id, 'pr__publish', '\n  gh: HTTP 502: Bad Gateway\nsecond line');
  await setStatus(id, 'failed');
  expect(await stopOf(id)).toMatchObject({
    status: 'failed',
    step_id: 'pr__publish',
    line: 'gh: HTTP 502: Bad Gateway',
    class: 'transient',
  });

  await setStatus(id, 'running');
  expect(await stopOf(id)).toBeUndefined();

  const early = await newRun();
  await setStatus(early, 'failed');
  expect(await stopOf(early)).toMatchObject({ step_id: null, class: 'environment' });
  await failStep(early, 'check', 'No issue matched the query');
  expect(await stopOf(early)).toMatchObject({ step_id: 'check', class: 'input' });

  const done = await newRun('archon-loop');
  await setStatus(done, 'completed');
  expect(await stopOf(done)).toMatchObject({ status: 'completed', step_id: null, class: null });
});

test('a paused run’s stop record is the question it asks', async () => {
  const id = await newRun('archon-build-queue', 'paused', {
    wait: {
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-10-24T10:20:00.000Z',
      message: '**Scope decision**\n\nShip it?',
      pauseId: 'p1',
      form: 'select',
      options: [{ id: 'ship', label: 'Ship' }],
    },
  });
  expect(await stopOf(id)).toMatchObject({
    status: 'paused',
    step_id: 'ask',
    line: '**Scope decision**',
    class: null,
  });

  const withBody = await newRun('archon-build-queue', 'paused', {
    wait: {
      nodeId: 'ask',
      kind: 'attention',
      waitingSince: '2026-10-24T10:20:00.000Z',
      message: '**Ship it?**\n- CI failed: lint',
      pauseId: 'p2',
      form: 'select',
      options: [{ id: 'ship', label: 'Ship' }],
    },
  });
  expect(await stopOf(withBody)).toMatchObject({ status: 'paused', line: '**Ship it?**' });
});

test('a run stop record that cannot be written never fails Archon’s write', async () => {
  const id = await newRun();
  const rolledBack = db.transaction(async (tx) => {
    await tx.query('ALTER TABLE mc.run_stops RENAME TO run_stops_gone');
    await tx.query(`UPDATE public.remote_agent_workflow_runs SET status = 'failed' WHERE id = $1`, [
      id,
    ]);
    expect(await tx.query('SELECT status FROM mc.laps WHERE run_id = $1', [id])).toEqual([
      { status: 'failed' },
    ]);
    const errors = await tx.query('SELECT source FROM mc.projection_errors WHERE run_id = $1', [
      id,
    ]);
    expect(errors.some((e) => String(e.source).startsWith('run_stops_'))).toBe(true);
    throw new Error('rollback');
  });
  await expect(rolledBack).rejects.toThrow('rollback');
});

test('0031 gives runs that finished before it a stop record', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0031'), db: historical });
    const insert = async (status: string, metadata: object = {}) =>
      String(
        (
          await historical.query(
            `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata, completed_at)
             VALUES ('archon-loop', $1::text, 'q', $2, CASE WHEN $1 IN ('running', 'paused') THEN NULL ELSE now() END)
             RETURNING id`,
            [status, JSON.stringify(metadata)],
          )
        )[0]?.id,
      );
    const failed = await insert('running');
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_failed', 'implement', $2)`,
      [
        failed,
        JSON.stringify(eventData('implement', 'node_failed', NOW, 'bun test: 3 tests failed')),
      ],
    );
    await historical.query(
      `UPDATE public.remote_agent_workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1`,
      [failed],
    );
    const completed = await insert('completed');
    const paused = await insert('paused', {
      wait: {
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: '2026-10-24T10:20:00.000Z',
        message: 'Ship it?',
        pauseId: 'p1',
        form: 'select',
        options: [{ id: 'ship', label: 'Ship' }],
      },
    });

    await runMigrations({ files: migrationFiles, db: historical });
    const stops = await historical.query(
      'SELECT run_id, status, step_id, class, signature FROM mc.run_stops ORDER BY status',
    );
    expect(stops).toEqual([
      { run_id: completed, status: 'completed', step_id: null, class: null, signature: null },
      {
        run_id: failed,
        status: 'failed',
        step_id: 'implement',
        class: 'code',
        signature: 'archon-loop · implement · bun test: <n> tests failed',
      },
      { run_id: paused, status: 'paused', step_id: 'ask', class: null, signature: null },
    ]);
  } finally {
    await historical.close();
  }
});

test('0032 re-projects the stop line of runs that failed before it, and leaves a question’s line as it was', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0032_stop_line'),
      db: historical,
    });
    const insert = async (status: string, metadata: object = {}) =>
      String(
        (
          await historical.query(
            `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata, completed_at)
             VALUES ('factory-app-check', $1::text, 'q', $2, CASE WHEN $1 IN ('running', 'paused') THEN NULL ELSE now() END)
             RETURNING id`,
            [status, JSON.stringify(metadata)],
          )
        )[0]?.id,
      );
    const failed = await insert('running');
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_failed', 'prepare', $2)`,
      [
        failed,
        JSON.stringify(eventData('prepare', 'node_failed', NOW, STOP_LINE_CORPUS[0]?.[0] ?? '')),
      ],
    );
    await historical.query(
      `UPDATE public.remote_agent_workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1`,
      [failed],
    );
    const paused = await insert('paused', {
      wait: {
        nodeId: 'ask',
        kind: 'attention',
        waitingSince: '2026-10-24T10:20:00.000Z',
        message: '**Ship it?**\n- CI failed: lint',
        pauseId: 'p1',
        form: 'select',
        options: [{ id: 'ship', label: 'Ship' }],
      },
    });
    const [old] = await historical.query('SELECT line FROM mc.run_stops WHERE run_id = $1', [
      failed,
    ]);
    expect(old?.line).toBe("Script node 'prepare' failed [exit 1]: 28 | }");

    await runMigrations({ files: migrationFiles, db: historical });
    const [stop] = await historical.query(
      `SELECT line, signature, mc.stop_signature(workflow_name, step_id, line) AS expected
       FROM mc.run_stops WHERE run_id = $1`,
      [failed],
    );
    expect(stop?.line).toBe('error: git merge --no-edit failed');
    expect(stop?.signature).toBe(stop?.expected);
    const [question] = await historical.query('SELECT line FROM mc.run_stops WHERE run_id = $1', [
      paused,
    ]);
    expect(question?.line).toBe('**Ship it?**');
  } finally {
    await historical.close();
  }
});

test('mc.stop_class leaves a JavaScript heap out of memory out of transient', async () => {
  const [row] = await db.query('SELECT mc.stop_class($1) AS class', [
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  ]);
  expect(row?.class).not.toBe('transient');
});

test('20261110T1200Z re-projects the class of runs that failed on a database blip before it', async () => {
  const name = '20261110T1200Z_transient_database_blips';
  const historical = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < name), db: historical });
    const [run] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('factory-app-check', 'running', 'q', '{}') RETURNING id`,
    );
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_failed', 'prepare', $2)`,
      [
        run?.id,
        JSON.stringify(
          eventData('prepare', 'node_failed', NOW, "Couldn't connect to compute node"),
        ),
      ],
    );
    await historical.query(
      `UPDATE public.remote_agent_workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1`,
      [run?.id],
    );
    const read = () =>
      historical.query('SELECT class FROM mc.run_stops WHERE run_id = $1', [run?.id]);
    expect((await read())[0]?.class).toBeNull();

    await runMigrations({ files: migrationFiles, db: historical });
    expect((await read())[0]?.class).toBe('transient');
  } finally {
    await historical.close();
  }
});

test('20261112T2001Z re-projects the class of runs that failed on a claim conflict before it', async () => {
  const name = '20261112T2001Z_every_failure_has_a_class';
  const historical = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < name), db: historical });
    const [run] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('archon-build-queue', 'running', 'q', '{}') RETURNING id`,
    );
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_failed', 'facts', $2)`,
      [
        run?.id,
        JSON.stringify(
          eventData(
            'facts',
            'node_failed',
            NOW,
            'build-queue facts: issue 630 is claimed by run e353c524-1111-4000-8000-000000000000',
          ),
        ),
      ],
    );
    await historical.query(
      `UPDATE public.remote_agent_workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1`,
      [run?.id],
    );
    const read = () =>
      historical.query('SELECT class FROM mc.run_stops WHERE run_id = $1', [run?.id]);
    expect((await read())[0]?.class).toBeNull();

    await runMigrations({ files: migrationFiles, db: historical });
    expect((await read())[0]?.class).toBe('input');
  } finally {
    await historical.close();
  }
});

test('20261113T1200Z gives a failed run with no stop line that never started a node the environment class, and no other', async () => {
  const name = '20261113T1200Z_classify_host_and_unlined_failures';
  const historical = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < name), db: historical });
    const failedRun = async (
      workflow: string,
      events: ['node_started' | 'node_failed' | 'node_skipped', string][],
    ): Promise<string> => {
      const [run] = await historical.query(
        `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
         VALUES ($1, 'running', 'q', '{}') RETURNING id`,
        [workflow],
      );
      for (const [type, message] of events) {
        const shape = type === 'node_skipped' ? 'node_completed' : type;
        await historical.query(
          `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
           VALUES ($1, $2, 'facts', $3)`,
          [run?.id, type, JSON.stringify(eventData('facts', shape, NOW, message))],
        );
      }
      await historical.query(
        `UPDATE public.remote_agent_workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1`,
        [run?.id],
      );
      return String(run?.id);
    };
    const neverStarted = await failedRun('archon-build-queue', []);
    const onlySkipped = await failedRun('archon-build-queue', [['node_skipped', '']]);
    const startedNoLine = await failedRun('archon-build-queue', [
      ['node_started', ''],
      ['node_failed', ''],
    ]);
    const unlistedWorkflow = await failedRun('archon-build', [
      ['node_started', ''],
      ['node_failed', ''],
    ]);
    const classes = async () =>
      Object.fromEntries(
        (await historical.query('SELECT run_id, class FROM mc.run_stops')).map((r) => [
          String(r.run_id),
          r.class,
        ]),
      );
    expect(await classes()).toEqual({
      [neverStarted]: null,
      [onlySkipped]: null,
      [startedNoLine]: null,
      [unlistedWorkflow]: null,
    });

    await runMigrations({ files: migrationFiles, db: historical });
    const after = await classes();
    expect(after).toEqual({
      [neverStarted]: 'environment',
      [onlySkipped]: 'environment',
      [startedNoLine]: null,
      [unlistedWorkflow]: null,
    });
    await runMigrations({ files: migrationFiles, db: historical });
    expect(await classes()).toEqual(after);
  } finally {
    await historical.close();
  }
});

test('a failed projecting run that starts a node after it failed stops being environment', async () => {
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles, db });
    const [run] = await db.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('archon-build-queue', 'running', 'q', '{}') RETURNING id`,
    );
    await db.query(
      `UPDATE public.remote_agent_workflow_runs SET status = 'failed', completed_at = now() WHERE id = $1`,
      [run?.id],
    );
    const read = async () =>
      (await db.query('SELECT class FROM mc.run_stops WHERE run_id = $1', [String(run?.id)]))[0]
        ?.class;
    expect(await read()).toBe('environment');
    await db.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_started', 'facts', $2)`,
      [run?.id, JSON.stringify(eventData('facts', 'node_started', NOW, ''))],
    );
    expect(await read()).toBeNull();
  } finally {
    await db.close();
  }
});

test('0031 records a run it cannot project in projection_errors and still finishes', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0031'), db: historical });
    await historical.query(`CREATE TABLE mc.run_stops (
      run_id uuid PRIMARY KEY, factory text NOT NULL,
      workflow_name text NOT NULL CHECK (workflow_name <> 'archon-bad'),
      status text NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'paused')),
      step_id text, line text,
      class text CHECK (class IN ('transient', 'environment', 'config', 'code', 'input')),
      signature text, stopped_at timestamptz)`);
    const finished = async (workflow: string) =>
      String(
        (
          await historical.query(
            `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, completed_at)
             VALUES ($1, 'failed', 'q', now()) RETURNING id`,
            [workflow],
          )
        )[0]?.id,
      );
    const bad = await finished('archon-bad');
    const good = await finished('archon-loop');

    await runMigrations({ files: migrationFiles, db: historical });
    expect(
      (await historical.query('SELECT run_id FROM mc.run_stops')).map((r) => r.run_id),
    ).toEqual([good]);
    expect(
      await historical.query(
        `SELECT run_id, source FROM mc.projection_errors WHERE source = '0031_run_stops'`,
      ),
    ).toEqual([{ run_id: bad, source: '0031_run_stops' }]);
  } finally {
    await historical.close();
  }
});

test('applying the run-stop migrations again changes nothing', async () => {
  const snapshot = async () => ({
    stops: await db.query('SELECT * FROM mc.run_stops ORDER BY run_id'),
    errors: await db.query(
      'SELECT source, run_id, message FROM mc.projection_errors ORDER BY 1, 2, 3',
    ),
    triggers: await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'run_stops_%' ORDER BY tgname`,
    ),
  });
  const before = await snapshot();
  expect(before.stops.length).toBeGreaterThan(0);
  for (const file of migrationFiles.filter((f) => f.name >= '0031_run_stops')) {
    await db.query(file.sql);
  }
  expect(await snapshot()).toEqual(before);
  const [row] = await db.query('SELECT mc.stop_line($1) AS line', ['a: b\nerror: c']);
  expect(row?.line).toBe('error: c');
});
