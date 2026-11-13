import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecommendation } from '../app/lib/attention';
import { FACTORY_MAP } from '../app/map/factory-map';
import { holdoutId } from '../parsers/metrics';
import { eventData, structuredOutputFor } from '../scripts/fixture/write';
import type { Db, Row } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { queries } from './queries/test-seed';
import { archonDb, migrationFiles, snapshot } from './test-db';

const migrationsFrom = (cut: string) =>
  migrationFiles.filter((f) => f.name >= cut).map((f) => f.name);

const NOW = new Date('2026-10-25T12:00:00Z');
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const MARKER = 'HOLDOUT-TEXT-MARKER';
const REVIEWED = structuredOutputFor('review') as { sha: string };

let db: Db;
let runId: string;

beforeAll(async () => {
  db = await archonDb();
  await runMigrations({ files: migrationFiles, db });
});
afterAll(() => db.close());

beforeEach(async () => {
  await db.query(`TRUNCATE public.remote_agent_workflow_runs, public.remote_agent_codebases CASCADE;
    TRUNCATE mc.laps, mc.lap_steps, mc.attention_items, mc.run_stops, mc.metric_records, mc.lap_step_attempts, mc.app_check_lines, mc.projection_errors,
      mc.factories, mc.versions, mc.pins, mc.work_item_states, mc.work_item_blockers, mc.capacity_waits, public.remote_agent_state_revisions`);
  runId = await newRun();
});

async function newRun(codebaseId: string | null = null): Promise<string> {
  const [row] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs
       (workflow_name, codebase_id, status, user_message, metadata)
     VALUES ('archon-loop', $1, 'running', 'Run the loop', $2) RETURNING id`,
    [codebaseId, JSON.stringify({ workflow_source: { digest: DIGEST } })],
  );
  return String(row?.id);
}

function insertEvent(eventType: string, step: string, data: unknown): Promise<Row[]> {
  return db.query(
    `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [runId, eventType, step, JSON.stringify(data)],
  );
}

const stepEvent = (step: string, event: 'node_started' | 'node_completed' | 'node_failed') =>
  insertEvent(event, step, eventData(step, event, NOW));

/** Projects every event again under its own id, in Archon's order, as `reconcile:laps` does. */
const replayEvents = () =>
  db.transaction(async (tx) => {
    await tx.query(
      'CREATE TEMP TABLE replayed_events (LIKE public.remote_agent_workflow_events) ON COMMIT DROP',
      [],
    );
    await tx.query(
      `CREATE TRIGGER replayed_step_event AFTER INSERT ON replayed_events
         FOR EACH ROW EXECUTE FUNCTION mc.project_step_event()`,
      [],
    );
    await tx.query(
      `INSERT INTO replayed_events SELECT * FROM public.remote_agent_workflow_events
         ORDER BY created_at, coalesce(event_order, 0), id`,
      [],
    );
  });

/** Row counts of every dashboard table, so a test can say nothing else changed. */
async function dashboardCounts(): Promise<Record<string, number>> {
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'mc' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [row] = await db.query(`SELECT count(*)::int AS n FROM mc.${table_name}`);
    counts[String(table_name)] = Number(row?.n);
  }
  return counts;
}

/** How many values in every mc text, json and array column contain the marker. */
async function markerCount(): Promise<number> {
  const columns = await db.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'mc'
      AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')`);
  expect(columns.length).toBeGreaterThan(0);
  let found = 0;
  for (const { table_name, column_name } of columns) {
    const [row] = await db.query(
      `SELECT count(*)::int AS n FROM mc.${table_name} WHERE ${column_name}::text LIKE $1`,
      [`%${MARKER}%`],
    );
    found += Number(row?.n);
  }
  return found;
}

async function projectionErrors(): Promise<Row[]> {
  return db.query('SELECT source, run_id, event_id, sqlstate, message FROM mc.projection_errors');
}

const projectionDefinitions = (database: Db) =>
  database.query(
    `SELECT proname, pg_get_functiondef(oid) AS definition FROM pg_proc
   WHERE oid IN ('mc.record_step_attempt(uuid,uuid,text,text,jsonb)'::regprocedure,
     'mc.project_step_event()'::regprocedure) ORDER BY proname`,
  );

test.each(['archon-manager', 'archon-holdouts', 'archon-backlog', 'fence-proof'])(
  '%s events are excluded before parsing payloads or projecting steps, attempts and check lines',
  async (workflow) => {
    await db.query(
      'UPDATE public.remote_agent_workflow_runs SET workflow_name = $1 WHERE id = $2',
      [workflow, runId],
    );
    const before = await dashboardCounts();
    const payloads = [
      eventData('check-app', 'node_completed', NOW),
      { structured_output: 'malformed' },
      { timing: { startedAt: 'invalid' } },
      { duration_ms: 'invalid' },
      { cost_usd: 'invalid' },
    ];
    for (const event of ['node_started', 'node_completed', 'node_failed', 'node_skipped']) {
      for (const data of payloads) {
        await insertEvent(event, 'check-app', data);
        if (event !== 'node_started') {
          await db.query('SELECT mc.record_step_attempt(gen_random_uuid(), $1, $2, $3, $4)', [
            runId,
            event,
            'check-app',
            JSON.stringify(data),
          ]);
        }
      }
    }
    expect(await dashboardCounts()).toEqual(before);
    expect(
      await db.query('SELECT count(*)::int AS n FROM public.remote_agent_workflow_events'),
    ).toEqual([{ n: 20 }]);
  },
);

test('an attempt failure is recorded without losing the source event or its step', async () => {
  const rolledBack = db.transaction(async (tx) => {
    await tx.query('ALTER TABLE mc.lap_step_attempts ADD CONSTRAINT reject_attempt CHECK (false)');
    const [event] = await tx.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_completed', 'review', '{}') RETURNING id`,
      [runId],
    );
    expect(await tx.query('SELECT id FROM public.remote_agent_workflow_events')).toEqual([event]);
    expect(await tx.query('SELECT step_id, status FROM mc.lap_steps')).toEqual([
      { step_id: 'review', status: 'completed' },
    ]);
    expect(await tx.query('SELECT * FROM mc.lap_step_attempts')).toEqual([]);
    expect(await tx.query('SELECT source, event_id, sqlstate FROM mc.projection_errors')).toEqual([
      {
        source: 'mc_project_step_event',
        event_id: event?.id,
        sqlstate: '23514',
      },
    ]);
    throw new Error('rollback after attempt failure');
  });
  await expect(rolledBack).rejects.toThrow('rollback after attempt failure');
});

test('0010 undoes the replay errors of non-laps but keeps missing parents of eligible laps', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0006'),
      db: historical,
    });
    for (const workflow of [
      'archon-manager',
      'archon-holdouts',
      'archon-backlog',
      'fence-proof',
      'archon-loop',
    ]) {
      const [run] = await historical.query(
        `INSERT INTO public.remote_agent_workflow_runs (workflow_name, user_message)
         VALUES ($1, 'historical') RETURNING id`,
        [workflow],
      );
      for (const status of ['completed', 'failed', 'skipped']) {
        await historical.query(
          `INSERT INTO public.remote_agent_workflow_events
             (workflow_run_id, event_type, step_name, data)
           VALUES ($1, $2, $3, '{}'), ($1, $2, $4, '{}')`,
          [run?.id, `node_${status}`, status, `missing-${status}`],
        );
        if (workflow === 'archon-loop') {
          await historical.query(
            'INSERT INTO mc.lap_steps (run_id, step_id, status) VALUES ($1, $2, $2)',
            [run?.id, status],
          );
        }
      }
    }
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0010'),
      db: historical,
    });
    expect(
      await historical.query(
        `SELECT count(*)::int AS n FROM mc.projection_errors WHERE source = '0007_step_attempts'`,
      ),
    ).toEqual([{ n: 27 }]);
    await runMigrations({ files: migrationFiles, db: historical });
    expect(
      await historical.query(
        `SELECT r.workflow_name, a.step_id, a.status FROM mc.lap_step_attempts a
       JOIN public.remote_agent_workflow_runs r ON r.id = a.run_id ORDER BY a.step_id`,
      ),
    ).toEqual(
      ['completed', 'failed', 'skipped'].map((status) => ({
        workflow_name: 'archon-loop',
        step_id: status,
        status,
      })),
    );
    expect(
      await historical.query(
        `SELECT r.workflow_name, e.step_name, p.source, p.sqlstate FROM mc.projection_errors p
       JOIN public.remote_agent_workflow_runs r ON r.id = p.run_id
       JOIN public.remote_agent_workflow_events e ON e.id = p.event_id ORDER BY e.step_name`,
      ),
    ).toEqual(
      ['completed', 'failed', 'skipped'].map((status) => ({
        workflow_name: 'archon-loop',
        step_name: `missing-${status}`,
        source: '0007_step_attempts',
        sqlstate: '23503',
      })),
    );
    await expect(
      historical.query(
        `SELECT mc.record_step_attempt(gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
        'node_completed', 'review', '{}')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  } finally {
    await historical.close();
  }
});

test('0032 backfills pr_number from a step pr_url and leaves a step pr as it was', async () => {
  const db = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0032'), db });
    const run = '00000000-0000-4000-8000-0000000000a1';
    for (const [step, output] of [
      ['round', { pr_url: 'https://github.com/o/r/pull/565' }],
      ['control', { pr: '#7', pr_url: 'https://github.com/o/r/pull/9' }],
    ] as const) {
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, output) VALUES ($1, $2, 'completed', $3)`,
        [run, step, JSON.stringify(output)],
      );
    }
    await runMigrations({ files: migrationFiles, db });
    expect(
      await db.query(
        `SELECT step_id, pr_number FROM mc.lap_steps WHERE run_id = $1 ORDER BY step_id`,
        [run],
      ),
    ).toEqual([
      { step_id: 'control', pr_number: 7 },
      { step_id: 'round', pr_number: 565 },
    ]);
  } finally {
    await db.close();
  }
}, 60_000);

test('the eligibility upgrade keeps live history and installs the same functions as a fresh database', async () => {
  const upgraded = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0010'),
      db: upgraded,
    });
    for (const workflow of ['archon-loop', 'archon-manager']) {
      await upgraded.query(
        `WITH r AS (
          INSERT INTO public.remote_agent_workflow_runs (workflow_name, user_message)
          VALUES ($1, 'upgrade') RETURNING id)
         INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         SELECT id, 'node_completed', 'review', '{"structured_output":"malformed"}' FROM r`,
        [workflow],
      );
    }
    expect(await upgraded.query('SELECT count(*)::int AS n FROM mc.lap_step_attempts')).toEqual([
      { n: 2 },
    ]);
    expect(await upgraded.query('SELECT count(*)::int AS n FROM mc.projection_errors')).toEqual([
      { n: 2 },
    ]);
    const before = await snapshot(upgraded);
    expect(
      await runMigrations({
        files: migrationFiles.filter((f) => f.name < '0013'),
        db: upgraded,
      }),
    ).toEqual([
      '0010_step_attempt_eligibility.sql',
      '0011_pin_full_archon_sha.sql',
      '0012_arch_text_lf.sql',
    ]);
    expect(await snapshot(upgraded)).toEqual(before);
    expect(await runMigrations({ files: migrationFiles, db: upgraded })).toEqual(
      migrationsFrom('0013'),
    );
    expect(await projectionDefinitions(upgraded)).toEqual(await projectionDefinitions(db));
    expect(await runMigrations({ files: migrationFiles, db: upgraded })).toEqual([]);
    const migrated = await snapshot(upgraded);
    await upgraded.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       SELECT id, 'node_completed', 'check-app', '{"timing":{"startedAt":"invalid"}}'
       FROM public.remote_agent_workflow_runs WHERE workflow_name = 'archon-manager'`,
    );
    expect(await snapshot(upgraded)).toEqual(migrated);
  } finally {
    await upgraded.close();
  }
});

test('0011 rewrites a short pin to the one full sha it prefixes, and clears ambiguous and unknown ones', async () => {
  const historical = await archonDb();
  const full = `abcdef12${'0'.repeat(32)}`;
  const twin = (last: string) => `12345678${'0'.repeat(31)}${last}`;
  const pinShas = () => historical.query('SELECT sha, archon_sha FROM mc.pins ORDER BY sha');
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0011'),
      db: historical,
    });
    await historical.query(
      `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at)
        VALUES ($1, 'f1', $4), ($1, 'f2', $4), ($2, 'f1', $4), ($3, 'f1', $4)`,
      [full, twin('1'), twin('2'), NOW],
    );
    for (const [sha, archon] of [
      ['p1', full.slice(0, 8)],
      ['p2', '12345678'],
      ['p3', 'deadbeef'],
      ['p4', twin('1')],
    ]) {
      await historical.query(
        `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES ($1, $2, 'r', $3)`,
        [sha, archon, NOW],
      );
    }

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0011'),
    );
    const migrated = [
      { sha: 'p1', archon_sha: full },
      { sha: 'p2', archon_sha: null },
      { sha: 'p3', archon_sha: null },
      { sha: 'p4', archon_sha: twin('1') },
    ];
    expect(await pinShas()).toEqual(migrated);
    const [rewrite] = migrationFiles.filter((f) => f.name.startsWith('0011'));
    await historical.query(rewrite?.sql ?? '');
    expect(await pinShas()).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('0012 rewrites CRLF to LF in stored architecture texts, and changes nothing run again', async () => {
  const historical = await archonDb();
  const texts = () =>
    historical.query(
      `SELECT 'workflow' AS kind, name AS path, yaml AS text FROM mc.arch_workflows
       UNION ALL SELECT 'text', path, text FROM mc.arch_texts
       UNION ALL SELECT 'script', path, text FROM mc.arch_scripts
       UNION ALL SELECT 'hook', path, text FROM mc.arch_hooks
       ORDER BY kind, path`,
    );
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0012'),
      db: historical,
    });
    const v = ['a1', 'f1'];
    await historical.query(
      `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, $2, $3)`,
      [...v, NOW],
    );
    await historical.query(
      `INSERT INTO mc.arch_workflows (archon_sha, factory_sha, name, file, yaml)
       VALUES ($1, $2, 'loop', 'loop/loop.yaml', E'name: loop\\r\\nnodes: []\\r\\n')`,
      v,
    );
    await historical.query(
      `INSERT INTO mc.arch_texts (archon_sha, factory_sha, path, text) VALUES
        ($1, $2, 'crlf.md', E'# Plan\\r\\n\\r\\nDo it.\\r\\n'),
        ($1, $2, 'lf.md', E'# Plan\\n\\nDo it.\\n'),
        ($1, $2, 'lone-cr.md', E'a\\rb\\n')`,
      v,
    );
    await historical.query(
      `INSERT INTO mc.arch_scripts (archon_sha, factory_sha, path, text)
       VALUES ($1, $2, 'run.sh', E'#!/bin/sh\\r\\necho hi\\r\\n')`,
      v,
    );
    await historical.query(
      `INSERT INTO mc.arch_hooks (archon_sha, factory_sha, path, text)
       VALUES ($1, $2, '.factory/hooks/gate.sh', E'exit 0\\r\\n')`,
      v,
    );

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0012'),
    );
    const migrated = [
      { kind: 'hook', path: '.factory/hooks/gate.sh', text: 'exit 0\n' },
      { kind: 'script', path: 'run.sh', text: '#!/bin/sh\necho hi\n' },
      { kind: 'text', path: 'crlf.md', text: '# Plan\n\nDo it.\n' },
      { kind: 'text', path: 'lf.md', text: '# Plan\n\nDo it.\n' },
      { kind: 'text', path: 'lone-cr.md', text: 'a\rb\n' },
      { kind: 'workflow', path: 'loop', text: 'name: loop\nnodes: []\n' },
    ];
    expect(await texts()).toEqual(migrated);
    const [rewrite] = migrationFiles.filter((f) => f.name.startsWith('0012'));
    await historical.query(rewrite?.sql ?? '');
    expect(await texts()).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('0013 gives back the runs of a step the old key merged, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0013'),
      db: historical,
    });
    const [run] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, user_message)
       VALUES ('archon-loop', 'historical') RETURNING id`,
    );
    const finished = async (step: string, data: object) => {
      const [event] = await historical.query(
        `INSERT INTO public.remote_agent_workflow_events
           (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'node_completed', $2, $3) RETURNING id`,
        [run?.id, step, JSON.stringify(data)],
      );
      return String(event?.id);
    };
    const timing = { timing: { startedAt: NOW.toISOString() } };
    const events = [
      await finished('review', {
        ...timing,
        cost_usd: 1,
        structured_output: { outcome: 'sent-back' },
      }),
      await finished('review', {
        ...timing,
        cost_usd: 2,
        structured_output: { outcome: 'merge' },
      }),
      await finished('land', {
        structured_output: { outcome: 'refused', reason: 'red' },
      }),
      await finished('land', { structured_output: { outcome: 'merged' } }),
    ];
    // An attempt only this constraint refuses: its step row stays and its error is recorded.
    await historical.query(
      `ALTER TABLE mc.lap_step_attempts ADD CONSTRAINT refuse_pick CHECK (step_id <> 'pick')`,
    );
    const refused = await finished('pick', {});
    const attempts = () =>
      historical.query(
        `SELECT step_id, outcome, cost_usd FROM mc.lap_step_attempts ORDER BY step_id, cost_usd, outcome`,
      );
    expect(await attempts()).toEqual([
      { step_id: 'land', outcome: 'merged', cost_usd: null },
      { step_id: 'review', outcome: 'merge', cost_usd: '2' },
    ]);
    const errors = () => historical.query('SELECT event_id, sqlstate FROM mc.projection_errors');
    expect(await errors()).toEqual([{ event_id: refused, sqlstate: '23514' }]);

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0013'),
    );
    expect(await attempts()).toEqual([
      { step_id: 'land', outcome: 'merged', cost_usd: null },
      { step_id: 'land', outcome: 'refused', cost_usd: null },
      { step_id: 'review', outcome: 'sent-back', cost_usd: '1' },
      { step_id: 'review', outcome: 'merge', cost_usd: '2' },
    ]);
    expect(
      (await historical.query('SELECT event_id FROM mc.lap_step_attempts ORDER BY event_id')).map(
        (row) => row.event_id,
      ),
    ).toEqual(events.sort());
    expect(await errors()).toEqual([{ event_id: refused, sqlstate: '23514' }]);
    const migrated = await snapshot(historical);
    const [identity] = migrationFiles.filter((f) => f.name.startsWith('0013'));
    const [eventTime] = migrationFiles.filter((f) => f.name.startsWith('0032'));
    await historical.query(identity?.sql ?? '');
    await historical.query(eventTime?.sql ?? '');
    expect(await snapshot(historical)).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('a started then completed step is one completed row with the event’s timing and cost', async () => {
  await stepEvent('review', 'node_started');
  await stepEvent('review', 'node_completed');

  const completed = eventData('review', 'node_completed', NOW);
  expect(await db.query('SELECT * FROM mc.lap_steps')).toEqual([
    {
      run_id: runId,
      step_id: 'review',
      status: 'completed',
      started_at: new Date(NOW.getTime() - 184_250),
      completed_at: NOW,
      duration_ms: 184_250,
      provider: 'claude',
      model: 'sonnet',
      tokens_input: 48_210,
      tokens_output: 6_904,
      tokens_cache_read: 39_877,
      tokens_cache_write: 8_333,
      cost_usd: String(completed.cost_usd),
      error: null,
      output: {
        outcome: 'merge',
        pr: '#29',
        sha: REVIEWED.sha,
        delivers: 'all',
        dispositions: [],
      },
      pr_number: 29,
    },
  ]);
  expect(await projectionErrors()).toEqual([]);
});

test('a failed step keeps its error and duration', async () => {
  await stepEvent('pick', 'node_started');
  await stepEvent('pick', 'node_failed');
  expect(
    await db.query('SELECT status, duration_ms, error, cost_usd, output FROM mc.lap_steps'),
  ).toEqual([
    {
      status: 'failed',
      duration_ms: 18_400,
      error: 'pick failed: fixture error',
      cost_usd: null,
      output: null,
    },
  ]);
});

test('a skipped step is a skipped row', async () => {
  await insertEvent('node_skipped', 'land', { reason: 'when: false' });
  expect(await db.query('SELECT step_id, status FROM mc.lap_steps')).toEqual([
    { step_id: 'land', status: 'skipped' },
  ]);
});

test('a skipped step without timing is dated by its event', async () => {
  await db.query(
    `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data, created_at)
     VALUES ($1, 'node_skipped', 'land', $2, '2026-10-25T12:03:00Z')`,
    [runId, JSON.stringify({ reason: 'when: false' })],
  );
  const [attempt] = await db.query('SELECT event_at::text AS event_at FROM mc.lap_step_attempts');
  expect(new Date(String(attempt?.event_at)).toISOString()).toBe('2026-10-25T12:03:00.000Z');
});

test('the model is the one the provider resolved when Archon reports it', async () => {
  await insertEvent('node_completed', 'verify', {
    model: 'haiku',
    model_usage: { requested: 'haiku', resolved: 'claude-haiku-4-5-20251001' },
    timing: { startedAt: NOW.toISOString(), durationMs: 30_599 },
  });
  expect(await db.query('SELECT model, duration_ms FROM mc.lap_steps')).toEqual([
    { model: 'claude-haiku-4-5-20251001', duration_ms: 30_599 },
  ]);
});

test('a provider_event changes no dashboard row and never fires the trigger', async () => {
  const before = await dashboardCounts();
  await insertEvent('provider_event', 'review', {
    type: 'assistant',
    text: 'thinking',
  });
  expect(await dashboardCounts()).toEqual(before);

  const [trigger] = await db.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
    WHERE tgname = 'mc_project_step_event'`);
  const when = String(trigger?.def).match(/ WHEN \((.*)\) EXECUTE /)?.[1] ?? '';
  const types = [...when.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  expect(types.sort()).toEqual(['node_completed', 'node_failed', 'node_skipped', 'node_started']);
});

test('a structured_output that is a JSON string holding an object is projected as that object', async () => {
  const completed = eventData('pick', 'node_completed', NOW);
  await insertEvent('node_completed', 'pick', {
    ...completed,
    structured_output: '{"route":"x"}',
  });

  expect(await projectionErrors()).toEqual([]);
  expect(await db.query('SELECT step_id, status, cost_usd, output FROM mc.lap_steps')).toEqual([
    {
      step_id: 'pick',
      status: 'completed',
      cost_usd: String(completed.cost_usd),
      output: { route: 'x' },
    },
  ]);
  expect(await db.query('SELECT route FROM mc.lap_step_attempts')).toEqual([{ route: 'x' }]);
});

test.each(['text', '[1]', '{', '"{}"'])(
  'a structured_output string %p holding no object commits in Archon, is recorded and keeps its step',
  async (text) => {
    const completed = eventData('pick', 'node_completed', NOW);
    const [event] = await insertEvent('node_completed', 'pick', {
      ...completed,
      structured_output: text,
    });

    expect(
      await db.query('SELECT count(*)::int AS n FROM public.remote_agent_workflow_events'),
    ).toEqual([{ n: 1 }]);
    expect(await projectionErrors()).toEqual([
      {
        source: 'mc_project_step_event',
        run_id: runId,
        event_id: event?.id,
        sqlstate: '22000',
        message: 'structured_output is a jsonb string, not an object',
      },
    ]);
    // The step still ran and cost what it cost: only its unreadable output is dropped.
    expect(await db.query('SELECT step_id, status, cost_usd, output FROM mc.lap_steps')).toEqual([
      {
        step_id: 'pick',
        status: 'completed',
        cost_usd: String(completed.cost_usd),
        output: null,
      },
    ]);
  },
);

test('a check-app report stored as a JSON string projects the same lines as the object', async () => {
  const data = eventData('check-app', 'node_completed', NOW);
  const fixture = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
  };
  const report = {
    ...fixture,
    lines: fixture.lines.map((line) =>
      line.kind === 'holdout' ? { ...line, verdict: 'FAIL', pre_existing: '' } : line,
    ),
  };
  const projected = async () => ({
    lines: await db.query('SELECT * FROM mc.app_check_lines ORDER BY position'),
    output: await db.query('SELECT output FROM mc.lap_steps'),
  });
  const catches = () =>
    db.query('SELECT holdout_catches FROM mc.lap_step_attempts ORDER BY event_id');

  await insertEvent('node_completed', 'check-app', {
    ...data,
    structured_output: JSON.stringify(report),
  });
  const fromString = await projected();
  expect(await catches()).toEqual([{ holdout_catches: 1 }]);
  await db.query('DELETE FROM mc.app_check_lines');
  await insertEvent('node_completed', 'check-app', {
    ...data,
    structured_output: report,
  });

  expect(await projectionErrors()).toEqual([]);
  expect(fromString.lines.length).toBeGreaterThan(0);
  expect(fromString).toEqual(await projected());
  expect(await catches()).toEqual([{ holdout_catches: 1 }, { holdout_catches: 1 }]);
});

test('an error the projection cannot even record still never fails Archon’s write', async () => {
  const rolledBack = db.transaction(async (tx) => {
    await tx.query('ALTER TABLE mc.projection_errors RENAME TO projection_errors_gone');
    await tx.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'node_completed', 'pick', '{"structured_output": "text"}')`,
      [runId],
    );
    const [events] = await tx.query(
      'SELECT count(*)::int AS n FROM public.remote_agent_workflow_events',
    );
    throw new Error(`rollback after ${events?.n} event`);
  });
  await expect(rolledBack).rejects.toThrow('rollback after 1 event');
});

test('every projection function stops a lock wait after 100 ms, and only inside itself', async () => {
  // PGlite has one session, so the wait itself is proved on a check branch by
  // `bun run projection:locks`; this keeps the setting from being dropped.
  const functions = await db.query(`SELECT p.proname, p.proconfig FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'mc' AND l.lanname = 'plpgsql' ORDER BY p.proname`);
  expect(functions).toEqual([
    { proname: 'drop_metric_records_trigger', proconfig: ['lock_timeout=100ms'] },
    // It relabels versions in the transaction that writes a pin, never in Archon's, so it waits.
    { proname: 'label_versions', proconfig: null },
    ...[
      'project_app_check_lines',
      'project_attention',
      'project_attention_item',
      'project_metric_records',
      'project_metric_records_trigger',
      'project_queue_app_check',
      'project_run',
      'project_run_stop',
      'project_run_stop_trigger',
      'project_step_event',
      'project_version',
      'project_work_item_state',
      'project_work_item_state_revision',
      'record_attempt_usage',
      'record_projection_error',
      'record_step_attempt',
    ].map((proname) => ({ proname, proconfig: ['lock_timeout=100ms'] })),
    // It only sets a column of the row being written and takes no lock of its own.
    { proname: 'set_lap_step_pr_number', proconfig: null },
    { proname: 'structured_output', proconfig: ['lock_timeout=100ms'] },
  ]);

  await stepEvent('check-app', 'node_completed');
  expect(await db.query('SHOW lock_timeout')).toEqual([{ lock_timeout: '0' }]);
});

test('0014 keeps only a stored citation’s references, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0014'),
      db: historical,
    });
    const [run] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, user_message)
       VALUES ('archon-loop', 'historical') RETURNING id`,
    );
    for (const [position, citation] of [
      '',
      'baseline/health.txt',
      `${MARKER} fails on main in run 675828cb-50ab-4296-9ba0-3c999bee3960, see #14`,
    ].entries()) {
      await historical.query(
        `INSERT INTO mc.app_check_lines (run_id, position, kind, verdict, evidence_count, pre_existing)
         VALUES ($1, $2, 'probe', 'FAIL', 0, $3)`,
        [run?.id, position + 1, citation],
      );
    }

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0014'),
    );
    const lines = () =>
      historical.query(
        `SELECT position, pre_existing, pre_existing_refs, pre_existing_refs::text LIKE $1 AS marked
         FROM mc.app_check_lines ORDER BY position`,
        [`%${MARKER}%`],
      );
    const converted = [
      {
        position: 1,
        pre_existing: false,
        pre_existing_refs: [],
        marked: false,
      },
      { position: 2, pre_existing: true, pre_existing_refs: [], marked: false },
      {
        position: 3,
        pre_existing: true,
        pre_existing_refs: ['#14', '675828cb-50ab-4296-9ba0-3c999bee3960'],
        marked: false,
      },
    ];
    expect(await lines()).toEqual(converted);
    const migrated = await snapshot(historical);
    const [refs] = migrationFiles.filter((f) => f.name.startsWith('0014'));
    await historical.query(refs?.sql ?? '');
    expect(await snapshot(historical)).toEqual(migrated);
    expect(await lines()).toEqual(converted);
  } finally {
    await historical.close();
  }
});

test('0016 lets a pin have no reason, keeps stored reasons, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0016'),
      db: historical,
    });
    const pin = (sha: string, reason: string | null) =>
      historical.query(
        `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES ($1, NULL, $2, $3)`,
        [sha, reason, NOW],
      );
    await pin('a'.repeat(40), 'a reason');
    await expect(pin('b'.repeat(40), null)).rejects.toThrow();

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0016'),
    );
    await pin('b'.repeat(40), null);
    const reasons = () => historical.query('SELECT sha, reason FROM mc.pins ORDER BY sha');
    const stored = [
      { sha: 'a'.repeat(40), reason: 'a reason' },
      { sha: 'b'.repeat(40), reason: null },
    ];
    expect(await reasons()).toEqual(stored);
    const [optional] = migrationFiles.filter((f) => f.name.startsWith('0016'));
    await historical.query(optional?.sql ?? '');
    expect(await reasons()).toEqual(stored);
  } finally {
    await historical.close();
  }
});

test('0017 keeps lines projected before it without an id, fills new reports’ ids, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0017'),
      db: historical,
    });
    const run = async () => {
      const [row] = await historical.query(
        `INSERT INTO public.remote_agent_workflow_runs (workflow_name, user_message)
         VALUES ('archon-loop', 'historical') RETURNING id`,
      );
      return row?.id;
    };
    const before = await run();
    await historical.query(
      `INSERT INTO mc.app_check_lines (run_id, position, kind, verdict, evidence_count)
       VALUES ($1, 1, 'defect', 'FAIL', 0)`,
      [before],
    );

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0017'),
    );
    const after = await run();
    await historical.query('SELECT mc.project_app_check_lines($1, $2)', [
      after,
      JSON.stringify([
        { id: 'C1', kind: 'criterion', verdict: 'PASS' },
        { id: ' h2 ', kind: 'holdout', verdict: 'FAIL', text: 'H-02' },
      ]),
    ]);
    const ids = (runId: unknown) =>
      historical.query(
        'SELECT position, line_id FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position',
        [runId],
      );
    expect(await ids(before)).toEqual([{ position: 1, line_id: null }]);
    expect(await ids(after)).toEqual([
      { position: 1, line_id: 'C1' },
      { position: 2, line_id: 'H2' },
    ]);
    const migrated = await snapshot(historical);
    const [lineIds] = migrationFiles.filter((f) => f.name.startsWith('0017'));
    await historical.query(lineIds?.sql ?? '');
    expect(await snapshot(historical)).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('a check-app line keeps only its report id’s leading letters and digits, as a disposition’s line id', async () => {
  const report = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
  };
  const ids = ['C1', ' \th2\n', `H3 holdout FAIL H-07 ${MARKER}`, '2', '', MARKER];
  await insertEvent('node_completed', 'check-app', {
    ...eventData('check-app', 'node_completed', NOW),
    structured_output: {
      ...report,
      lines: ids.map((id) => ({ ...report.lines[0], id })),
    },
  });

  expect(await db.query('SELECT line_id FROM mc.app_check_lines ORDER BY position')).toEqual(
    ['C1', 'H2', 'H3', null, null, null].map((line_id) => ({ line_id })),
  );
  expect(await projectionErrors()).toEqual([]);
  expect(await markerCount()).toBe(0);
});

test('check-app lines keep kind, verdict, evidence count and only a holdout’s scenario id', async () => {
  const report = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
    head: string;
    merged_with: string;
  };
  const line = (id: string, verdict: string, text: string, evidence: string[]) => ({
    ...report.lines[1],
    id,
    verdict,
    text,
    evidence,
  });
  const lines = [
    report.lines[0],
    line('2', 'FAIL', `H-07 ${MARKER} the user sees the lap`, ['a.txt', 'b.txt']),
    line('3', '\tpass\n', `${MARKER} with no scenario id`, []),
    {
      ...report.lines[2],
      kind: '\tprobe\r\n',
      pre_existing: '\nbaseline/health.txt\t',
    },
  ];
  const data = eventData('check-app', 'node_completed', NOW);
  await insertEvent('node_completed', 'check-app', {
    ...data,
    structured_output: {
      ...report,
      lines,
      summary: `H-07 fails: ${MARKER}`,
      noticed: [MARKER],
    },
  });

  expect(
    await db.query(
      `SELECT position, kind, verdict, evidence_count, pre_existing, pre_existing_refs, scenario_id
       FROM mc.app_check_lines ORDER BY position`,
    ),
  ).toEqual([
    {
      position: 1,
      kind: 'criterion',
      verdict: 'PASS',
      evidence_count: 1,
      pre_existing: false,
      pre_existing_refs: [],
      scenario_id: null,
    },
    {
      position: 2,
      kind: 'holdout',
      verdict: 'FAIL',
      evidence_count: 2,
      pre_existing: false,
      pre_existing_refs: [],
      scenario_id: 'H-07',
    },
    {
      position: 3,
      kind: 'holdout',
      verdict: 'PASS',
      evidence_count: 0,
      pre_existing: false,
      pre_existing_refs: [],
      scenario_id: 'unidentified',
    },
    {
      position: 4,
      kind: 'probe',
      verdict: 'OK',
      evidence_count: 1,
      pre_existing: true,
      pre_existing_refs: [],
      scenario_id: null,
    },
  ]);
  expect(await db.query('SELECT output FROM mc.lap_steps')).toEqual([
    {
      output: {
        pr: '#29',
        head: report.head,
        merged_with: report.merged_with,
        overall: 'PASS',
      },
    },
  ]);

  expect(await markerCount()).toBe(0);
});

test('a line’s pre-existing citation keeps only the references it names, never its text', async () => {
  const report = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
  };
  const holdout = (id: string, preExisting: string) => ({
    id,
    kind: 'holdout',
    verdict: 'FAIL',
    text: `H-0${id} ${MARKER}`,
    evidence: [],
    pre_existing: preExisting,
  });
  const [event] = await insertEvent('node_completed', 'check-app', {
    ...eventData('check-app', 'node_completed', NOW),
    structured_output: {
      ...report,
      lines: [
        holdout(
          '1',
          `${MARKER} fails on main at 8AAD49143CFCB155CA918A0513CF99D381263E30, tracked in #14 and https://github.com/o/r/pull/216; see C:\\runs\\675828CB-50AB-4296-9BA0-3c999bee3960\\holdout-runs\\base-results.txt`,
        ),
        holdout('2', `${MARKER} the same thing happens on main`),
        holdout('3', ' \t\n'),
        holdout('4', ''),
      ],
    },
  });

  expect(
    await db.query(
      `SELECT position, verdict, scenario_id, pre_existing, pre_existing_refs
       FROM mc.app_check_lines ORDER BY position`,
    ),
  ).toEqual([
    {
      position: 1,
      verdict: 'FAIL',
      scenario_id: 'H-01',
      pre_existing: true,
      pre_existing_refs: [
        '#14',
        '#216',
        '675828cb-50ab-4296-9ba0-3c999bee3960',
        '8aad49143cfcb155ca918a0513cf99d381263e30',
      ],
    },
    {
      position: 2,
      verdict: 'FAIL',
      scenario_id: 'H-02',
      pre_existing: true,
      pre_existing_refs: [],
    },
    {
      position: 3,
      verdict: 'FAIL',
      scenario_id: 'H-03',
      pre_existing: false,
      pre_existing_refs: [],
    },
    {
      position: 4,
      verdict: 'FAIL',
      scenario_id: 'H-04',
      pre_existing: false,
      pre_existing_refs: [],
    },
  ]);
  expect(
    await db.query('SELECT holdout_catches FROM mc.lap_step_attempts WHERE event_id = $1', [
      event?.id,
    ]),
  ).toEqual([{ holdout_catches: 2 }]);
  expect(await projectionErrors()).toEqual([]);
  expect(await markerCount()).toBe(0);
});

test('a review keeps its outcome and each disposition’s action and line id, never its text', async () => {
  const data = eventData('review', 'node_completed', NOW);
  const disposition = {
    line: `h1 holdout FAIL H-07 ${MARKER} the lane never moves`,
    action: 'blocks',
    file: `review/${MARKER}.md`,
    issue: MARKER,
    reason: `H-07 ${MARKER}`,
  };
  await insertEvent('node_completed', 'review', {
    ...data,
    structured_output: {
      ...structuredOutputFor('review'),
      outcome: 'sent-back',
      dispositions: [
        disposition,
        { ...disposition, line: MARKER, action: 'issue' },
        { ...disposition, line: ` \t\n r2 holdout ${MARKER}`, action: 'issue' },
      ],
      judge_changes: [{ file: 'holdouts/H-07.md', change: MARKER, approval: MARKER }],
      reason: `Sent back: ${MARKER}`,
    },
  });

  expect(await db.query('SELECT output FROM mc.lap_steps')).toEqual([
    {
      output: {
        outcome: 'sent-back',
        pr: '#29',
        sha: REVIEWED.sha,
        delivers: 'all',
        dispositions: [
          { line: 'H1', action: 'blocks' },
          { line: null, action: 'issue' },
          { line: 'R2', action: 'issue' },
        ],
      },
    },
  ]);
  expect(await projectionErrors()).toEqual([]);
  expect(await markerCount()).toBe(0);
});

test('a holdout line’s scenario id is the one parsers/metrics.ts holdoutId reads', async () => {
  const texts = [
    'H-07 fine',
    'PH-12 then H-07 seen',
    'H-07a only',
    'see H-123, then H-04',
    'H-1 is too short',
    'x_H-07 and (H-08)',
    'no id at all',
  ];
  const report = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
  };
  const holdout = report.lines[1];
  await insertEvent('node_completed', 'check-app', {
    ...eventData('check-app', 'node_completed', NOW),
    structured_output: {
      ...report,
      lines: texts.map((text) => ({ ...holdout, text })),
    },
  });
  const rows = await db.query('SELECT scenario_id FROM mc.app_check_lines ORDER BY position');
  expect(rows.map((row) => row.scenario_id)).toEqual(texts.map(holdoutId));
});

test('a check-app line that cannot be stored is recorded and the step row stays', async () => {
  const report = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
  };
  const [event] = await insertEvent('node_completed', 'check-app', {
    ...eventData('check-app', 'node_completed', NOW),
    structured_output: {
      ...report,
      lines: [{ ...report.lines[0], kind: 'remark' }],
    },
  });
  expect(await db.query('SELECT step_id, status FROM mc.lap_steps')).toEqual([
    { step_id: 'check-app', status: 'completed' },
  ]);
  expect(await db.query('SELECT position FROM mc.app_check_lines')).toEqual([]);
  expect(await projectionErrors()).toMatchObject([
    { source: 'mc_project_step_event', event_id: event?.id, sqlstate: '23514' },
  ]);
});

test('a shorter check-app report replaces the lines of an earlier one', async () => {
  const report = structuredOutputFor('check-app') as { lines: unknown[] };
  const data = eventData('check-app', 'node_completed', NOW);
  await insertEvent('node_completed', 'check-app', data);
  await insertEvent('node_completed', 'check-app', {
    ...data,
    structured_output: { ...report, lines: report.lines.slice(0, 1) },
  });
  expect(await db.query('SELECT position FROM mc.app_check_lines')).toEqual([{ position: 1 }]);
});

test('replaying the same events leaves every row count unchanged', async () => {
  await stepEvent('pick', 'node_started');
  await stepEvent('pick', 'node_completed');
  await stepEvent('check-app', 'node_completed');
  const once = await dashboardCounts();
  await replayEvents();
  expect(await dashboardCounts()).toEqual(once);
  expect(once).toMatchObject({
    laps: 1,
    lap_steps: 2,
    lap_step_attempts: 2,
    app_check_lines: 3,
    projection_errors: 0,
  });
});

test('every finished attempt of a step is its own row, and goes with its step row', async () => {
  const later = new Date(NOW.getTime() + 3_600_000);
  const review = (outcome: string, at: Date) =>
    insertEvent('node_completed', 'review', {
      ...eventData('review', 'node_completed', at),
      structured_output: { ...REVIEWED, outcome },
    });
  const report = structuredOutputFor('check-app') as {
    lines: Record<string, unknown>[];
  };
  const holdout = {
    kind: 'holdout',
    verdict: 'FAIL',
    text: `H-07 ${MARKER}`,
    evidence: [],
  };
  const checkApp = (lines: Record<string, unknown>[], at: Date) =>
    insertEvent('node_completed', 'check-app', {
      ...eventData('check-app', 'node_completed', at),
      structured_output: { ...report, lines },
    });
  await review('sent-back', NOW);
  await review('approved', later);
  await checkApp([holdout, { ...holdout, pre_existing: 'baseline' }], NOW);
  await checkApp([holdout, { ...holdout, verdict: ' fail\t' }, report.lines[0]], later);
  await insertEvent('node_skipped', 'land', { reason: 'when: false' });

  const attempts = () =>
    db.query(`SELECT step_id, CASE WHEN isfinite(started_at) THEN started_at END AS started_at,
        status, duration_ms, cost_usd, outcome, holdout_catches
      FROM mc.lap_step_attempts ORDER BY step_id, mc.lap_step_attempts.started_at`);
  const at = (d: Date) => new Date(d.getTime() - 184_250);
  const cost = String(eventData('review', 'node_completed', NOW).cost_usd);
  const done = { status: 'completed', duration_ms: 184_250, cost_usd: cost };
  expect(await attempts()).toEqual([
    {
      step_id: 'check-app',
      started_at: at(NOW),
      ...done,
      outcome: null,
      holdout_catches: 1,
    },
    {
      step_id: 'check-app',
      started_at: at(later),
      ...done,
      outcome: null,
      holdout_catches: 2,
    },
    {
      step_id: 'land',
      // No start time on the event: the step's one unstarted attempt (`-infinity`).
      started_at: null,
      status: 'skipped',
      duration_ms: null,
      cost_usd: null,
      outcome: null,
      holdout_catches: 0,
    },
    {
      step_id: 'review',
      started_at: at(NOW),
      ...done,
      outcome: 'sent-back',
      holdout_catches: 0,
    },
    {
      step_id: 'review',
      started_at: at(later),
      ...done,
      outcome: 'approved',
      holdout_catches: 0,
    },
  ]);
  expect(
    await db.query('SELECT step_id, output FROM mc.lap_steps WHERE step_id = $1', ['review']),
  ).toEqual([
    {
      step_id: 'review',
      output: expect.objectContaining({ outcome: 'approved' }),
    },
  ]);
  expect(await projectionErrors()).toEqual([]);
  expect(await markerCount()).toBe(0);

  const recorded = await attempts();
  await replayEvents();
  expect(await attempts()).toEqual(recorded);
  await db.query(`DELETE FROM mc.lap_steps WHERE step_id = 'review'`);
  expect((await attempts()).map((a) => a.step_id)).toEqual(['check-app', 'check-app', 'land']);
});

test('a replayed start never reopens a finished step, and a retry does', async () => {
  await stepEvent('pick', 'node_started');
  await stepEvent('pick', 'node_completed');
  await stepEvent('pick', 'node_started');
  expect(await db.query('SELECT status FROM mc.lap_steps')).toEqual([{ status: 'completed' }]);

  const retry = new Date(NOW.getTime() + 60_000).toISOString();
  await insertEvent('node_started', 'pick', {
    provider: 'claude',
    timing: { startedAt: retry },
  });
  expect(await db.query('SELECT status, cost_usd, output FROM mc.lap_steps')).toEqual([
    { status: 'running', cost_usd: null, output: null },
  ]);
});

test('a run is a lap of the factory whose codebase it ran, with its digest', async () => {
  await db.query(`INSERT INTO mc.factories VALUES
    ('mission-control', 'coleam00/factory-mission-control', 'coleam00/factory-mission-control',
     'http://localhost:3090')`);
  const [codebase] = await db.query(`INSERT INTO public.remote_agent_codebases (name)
    VALUES ('coleam00/factory-mission-control') RETURNING id`);
  const [other] = await db.query(
    `INSERT INTO public.remote_agent_codebases (name) VALUES ('mc-fence-proof') RETURNING id`,
  );
  const ours = await newRun(String(codebase?.id));
  const theirs = await newRun(String(other?.id));
  await db.query(
    `UPDATE public.remote_agent_workflow_runs SET status = 'completed', completed_at = now()
     WHERE id = $1`,
    [ours],
  );

  expect(
    await db.query(
      `SELECT run_id, factory, workflow_name, status, digest, completed_at IS NOT NULL AS done
       FROM mc.laps ORDER BY factory`,
    ),
  ).toEqual([
    {
      run_id: runId,
      factory: '',
      workflow_name: 'archon-loop',
      status: 'running',
      digest: DIGEST,
      done: false,
    },
    {
      run_id: theirs,
      factory: 'mc-fence-proof',
      workflow_name: 'archon-loop',
      status: 'running',
      digest: DIGEST,
      done: false,
    },
    {
      run_id: ours,
      factory: 'mission-control',
      workflow_name: 'archon-loop',
      status: 'completed',
      digest: DIGEST,
      done: true,
    },
  ]);
});

test('an update that changes nothing a lap shows does not fire the projection', async () => {
  await db.query(`UPDATE mc.laps SET status = 'stale' WHERE run_id = $1`, [runId]);
  await db.query(
    `UPDATE public.remote_agent_workflow_runs SET last_activity_at = now() + interval '1 minute'
     WHERE id = $1`,
    [runId],
  );
  expect(await db.query('SELECT status FROM mc.laps')).toEqual([{ status: 'stale' }]);
});

test('a lap follows a change of its run’s digest or codebase', async () => {
  const [codebase] = await db.query(`INSERT INTO public.remote_agent_codebases (name)
    VALUES ('mc-fence-proof') RETURNING id`);
  const digest = `sha256:${'cd'.repeat(32)}`;
  await db.query(`UPDATE public.remote_agent_workflow_runs SET metadata = $2 WHERE id = $1`, [
    runId,
    JSON.stringify({ workflow_source: { digest } }),
  ]);
  expect(await db.query('SELECT factory, digest FROM mc.laps')).toEqual([{ factory: '', digest }]);

  await db.query(`UPDATE public.remote_agent_workflow_runs SET codebase_id = $2 WHERE id = $1`, [
    runId,
    codebase?.id,
  ]);
  expect(await db.query('SELECT factory, digest FROM mc.laps')).toEqual([
    { factory: 'mc-fence-proof', digest },
  ]);
});

async function factoryCodebase(): Promise<string> {
  await db.query(`INSERT INTO mc.factories VALUES
    ('mission-control', 'coleam00/factory-mission-control', 'coleam00/factory-mission-control',
     'http://localhost:3090')`);
  const [codebase] = await db.query(`INSERT INTO public.remote_agent_codebases (name)
    VALUES ('coleam00/factory-mission-control') RETURNING id`);
  return String(codebase?.id);
}

function runAt(
  codebaseId: string,
  startedAt: Date,
  { workflow = 'archon-loop', digest = DIGEST }: { workflow?: string; digest?: string | null } = {},
): Promise<Row[]> {
  return db.query(
    `INSERT INTO public.remote_agent_workflow_runs
       (workflow_name, codebase_id, status, user_message, metadata, started_at)
     VALUES ($1, $2, 'running', 'Run the loop', $3, $4) RETURNING id`,
    [
      workflow,
      codebaseId,
      JSON.stringify(digest ? { workflow_source: { digest } } : {}),
      startedAt,
    ],
  );
}

function pin(sha: string, committedAt: Date): Promise<Row[]> {
  return db.query(
    `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES ($1, 'archon', 'why', $2)`,
    [sha, committedAt],
  );
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

test('a factory’s archon-loop run with a new digest is one version labelled by the pin before it, and a second run adds none', async () => {
  const codebase = await factoryCodebase();
  await pin('before', minutes(-10));
  await pin('after', minutes(10));
  await runAt(codebase, NOW);
  await runAt(codebase, minutes(20));
  await runAt(codebase, minutes(-30), { workflow: 'archon-fix' });
  await runAt(codebase, minutes(-30), { digest: null });

  expect(await db.query('SELECT * FROM mc.versions')).toEqual([
    {
      factory: 'mission-control',
      digest: DIGEST,
      first_run_at: NOW,
      pin_sha: 'before',
    },
  ]);
  expect(await projectionErrors()).toEqual([]);
});

test('an archon-build-queue run with a new digest is a version, and another queue workflow’s run is not', async () => {
  const codebase = await factoryCodebase();
  await pin('before', minutes(-10));
  await runAt(codebase, NOW, { workflow: 'archon-build-queue' });
  await runAt(codebase, minutes(-30), {
    workflow: 'archon-intake',
    digest: 'sha256:intake',
  });
  await runAt(codebase, minutes(-30), {
    workflow: 'archon-manager',
    digest: 'sha256:manager',
  });

  expect(await db.query('SELECT * FROM mc.versions')).toEqual([
    {
      factory: 'mission-control',
      digest: DIGEST,
      first_run_at: NOW,
      pin_sha: 'before',
    },
  ]);
  expect(await projectionErrors()).toEqual([]);
});

test('a version’s first run is the earliest of its loop and build-queue runs', async () => {
  const codebase = await factoryCodebase();
  await runAt(codebase, NOW);
  await runAt(codebase, minutes(20), { workflow: 'archon-build-queue' });
  const first = () => db.query('SELECT first_run_at FROM mc.versions');
  expect(await first()).toEqual([{ first_run_at: NOW }]);

  await runAt(codebase, minutes(-20), { workflow: 'archon-build-queue' });
  expect(await first()).toEqual([{ first_run_at: minutes(-20) }]);
});

test('a pin written after the run labels its version', async () => {
  await runAt(await factoryCodebase(), NOW);
  expect(await db.query('SELECT pin_sha FROM mc.versions')).toEqual([{ pin_sha: null }]);

  await pin('before', minutes(-10));
  expect(await db.query('SELECT pin_sha FROM mc.versions')).toEqual([{ pin_sha: 'before' }]);

  await pin('after', minutes(10));
  expect(await db.query('SELECT pin_sha FROM mc.versions')).toEqual([{ pin_sha: 'before' }]);
});

test('an earlier run projected later moves its version’s first run and pin back', async () => {
  const codebase = await factoryCodebase();
  await pin('earlier', minutes(-40));
  await pin('later', minutes(-10));
  await runAt(codebase, NOW);
  await runAt(codebase, minutes(-30));

  expect(await db.query('SELECT * FROM mc.versions')).toEqual([
    {
      factory: 'mission-control',
      digest: DIGEST,
      first_run_at: minutes(-30),
      pin_sha: 'earlier',
    },
  ]);
});

test('a pin updated or deleted relabels the versions it labelled', async () => {
  await runAt(await factoryCodebase(), NOW);
  await pin('first', minutes(-20));
  await pin('second', minutes(-10));
  expect(await db.query('SELECT pin_sha FROM mc.versions')).toEqual([{ pin_sha: 'second' }]);

  await db.query(`UPDATE mc.pins SET committed_at = $1 WHERE sha = 'second'`, [minutes(10)]);
  expect(await db.query('SELECT pin_sha FROM mc.versions')).toEqual([{ pin_sha: 'first' }]);

  await db.query(`DELETE FROM mc.pins WHERE sha = 'first'`);
  expect(await db.query('SELECT pin_sha FROM mc.versions')).toEqual([{ pin_sha: null }]);
});

test('a lap that moves off a digest takes its version along', async () => {
  const codebase = await factoryCodebase();
  const other = `sha256:${'ef'.repeat(32)}`;
  const [only] = await runAt(codebase, NOW);
  const [first] = await runAt(codebase, minutes(-30), { digest: other });
  await runAt(codebase, minutes(10), { digest: other });
  const versions = () => db.query('SELECT digest, first_run_at FROM mc.versions ORDER BY 1');
  const setDigest = (runId: unknown, digest: string) =>
    db.query(`UPDATE public.remote_agent_workflow_runs SET metadata = $2 WHERE id = $1`, [
      runId,
      JSON.stringify({ workflow_source: { digest } }),
    ]);

  await setDigest(only?.id, `sha256:${'cd'.repeat(32)}`);
  expect(await versions()).toEqual([
    { digest: `sha256:${'cd'.repeat(32)}`, first_run_at: NOW },
    { digest: other, first_run_at: minutes(-30) },
  ]);

  await setDigest(first?.id, DIGEST);
  expect(await versions()).toEqual([
    { digest: DIGEST, first_run_at: minutes(-30) },
    { digest: `sha256:${'cd'.repeat(32)}`, first_run_at: NOW },
    { digest: other, first_run_at: minutes(10) },
  ]);

  await db.query(
    `UPDATE public.remote_agent_workflow_runs SET workflow_name = 'archon-fix' WHERE id = $1`,
    [first?.id],
  );
  await db.query(`UPDATE public.remote_agent_workflow_runs SET codebase_id = NULL WHERE id = $1`, [
    only?.id,
  ]);
  expect(await versions()).toEqual([{ digest: other, first_run_at: minutes(10) }]);
  expect(await projectionErrors()).toEqual([]);
});

test('a version that cannot be written keeps the lap and is recorded', async () => {
  const codebase = await factoryCodebase();
  const rolledBack = db.transaction(async (tx) => {
    await tx.query('ALTER TABLE mc.versions ADD CONSTRAINT no_rows CHECK (false) NOT VALID');
    const [run] = await tx.query(
      `INSERT INTO public.remote_agent_workflow_runs
         (workflow_name, codebase_id, status, user_message, metadata)
       VALUES ('archon-loop', $1, 'running', 'Run the loop', $2) RETURNING id`,
      [codebase, JSON.stringify({ workflow_source: { digest: DIGEST } })],
    );
    expect(await tx.query('SELECT factory FROM mc.laps WHERE run_id = $1', [run?.id])).toEqual([
      { factory: 'mission-control' },
    ]);
    expect(await tx.query('SELECT source, run_id, sqlstate FROM mc.projection_errors')).toEqual([
      { source: 'mc_project_run_insert', run_id: run?.id, sqlstate: '23514' },
    ]);
    throw new Error('rollback after the run committed');
  });
  await expect(rolledBack).rejects.toThrow('rollback after the run committed');
});

test('a run status update commits and is recorded when the trigger cannot reach mc.laps, even on its first call', async () => {
  // PGlite has one session, so no lock wait is possible here; `bun run projection:locks` proves
  // that on a check branch. Recompiling the trigger with mc.laps out of reach is what a session's
  // first call under a lock on it does: anything the trigger resolves when it compiles fails
  // outside its exception blocks (#114).
  const rolledBack = db.transaction(async (tx) => {
    await tx.query(`ALTER FUNCTION mc.project_run() SET lock_timeout = '100ms'`);
    await tx.query('ALTER TABLE mc.laps RENAME TO laps_gone');
    await tx.query(`UPDATE public.remote_agent_workflow_runs SET status = 'paused' WHERE id = $1`, [
      runId,
    ]);
    expect(await tx.query('SELECT source, run_id, sqlstate FROM mc.projection_errors')).toEqual([
      { source: 'mc_project_run_update', run_id: runId, sqlstate: '42P01' },
    ]);
    throw new Error('rollback after the run committed');
  });
  await expect(rolledBack).rejects.toThrow('rollback after the run committed');
});

const ATTN_WAIT = {
  owner: 'node',
  nodeId: 'ask',
  kind: 'attention',
  waitingSince: '2026-10-24T10:20:00.000Z',
  message: '**Build queue, issue 15: scope decision**\n\n**What it is.** Ship it?',
  pauseId: 'p1',
  form: 'select',
  options: [
    { id: 'ship', label: 'Ship' },
    { id: 'other', label: 'Something else' },
  ],
  labels: { build: 'scope' },
};

async function pausedRun(wait: object = ATTN_WAIT, extra: object = {}): Promise<string> {
  const [row] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
     VALUES ('archon-build-queue', 'paused', 'queue', $1) RETURNING id`,
    [JSON.stringify({ wait, ...extra })],
  );
  return String(row?.id);
}

const setAttentionMetadata = (id: string, metadata: object) =>
  db.query('UPDATE public.remote_agent_workflow_runs SET metadata = $2 WHERE id = $1', [
    id,
    JSON.stringify(metadata),
  ]);

const attentionItems = () =>
  db.query(
    `SELECT run_id, node_id, form, options::text AS options, labels::text AS labels,
       length(message)::int AS length FROM mc.attention_items`,
  );

test('a run paused at an open attention wait is one attention item, and leaves when it is not', async () => {
  const id = await pausedRun();
  const [item] = await db.query(`SELECT * FROM mc.attention_items WHERE run_id = $1`, [id]);
  expect(item).toMatchObject({
    factory: '',
    workflow_name: 'archon-build-queue',
    node_id: 'ask',
    form: 'select',
    options: ATTN_WAIT.options,
    labels: { build: 'scope' },
    message: ATTN_WAIT.message,
  });
  expect(new Date(String(item?.waiting_since)).toISOString()).toBe('2026-10-24T10:20:00.000Z');

  await setAttentionMetadata(id, {
    wait: { ...ATTN_WAIT, labels: { build: 'stop' } },
  });
  expect((await attentionItems())[0]?.labels).toBe('{"build": "stop"}');

  for (const gone of [
    { wait: { ...ATTN_WAIT, answer: { decision: 'ship' } } },
    { wait: ATTN_WAIT, source_release: { nodeId: 'ask' } },
  ]) {
    await setAttentionMetadata(id, gone);
    expect(await attentionItems()).toEqual([]);
    await setAttentionMetadata(id, { wait: ATTN_WAIT });
    expect(await attentionItems()).toHaveLength(1);
  }
  await db.query(`UPDATE public.remote_agent_workflow_runs SET status = 'running' WHERE id = $1`, [
    id,
  ]);
  expect(await attentionItems()).toEqual([]);
});

test('an attention item’s node and choices follow the wait’s owner and form', async () => {
  await pausedRun({
    ...ATTN_WAIT,
    owner: 'loop_group',
    nodeId: 'rounds',
    bodyWaitId: 'ask',
    form: 'approval',
  });
  await pausedRun({ ...ATTN_WAIT, form: 'message' });
  const items = await attentionItems();
  expect(items.map((i) => [i.node_id, i.form, i.options])).toEqual(
    expect.arrayContaining([
      ['rounds.ask', 'approval', '[{"id": "approve"}, {"id": "reject"}]'],
      ['ask', 'message', '[]'],
    ]),
  );
});

test('an attention message is stored as its first 4000 characters', async () => {
  await pausedRun({ ...ATTN_WAIT, message: 'x'.repeat(5000) });
  expect((await attentionItems())[0]?.length).toBe(4000);
});

test('an update that changes nothing an attention item shows does not fire the projection', async () => {
  const id = await pausedRun();
  await db.query(`UPDATE mc.attention_items SET labels = '{"by":"hand"}'`);
  await db.query(
    `UPDATE public.remote_agent_workflow_runs SET last_activity_at = now() + interval '1 minute'
     WHERE id = $1`,
    [id],
  );
  expect((await attentionItems())[0]?.labels).toBe('{"by": "hand"}');
});

test('an unreadable wait time commits Archon’s write and records one projection error', async () => {
  const id = await pausedRun();
  await setAttentionMetadata(id, {
    wait: { ...ATTN_WAIT, waitingSince: 'not a time' },
  });
  expect(await attentionItems()).toHaveLength(1);
  expect(await db.query('SELECT source, run_id FROM mc.projection_errors')).toEqual([
    { source: 'mc_project_attention_update', run_id: id },
  ]);
  const [run] = await db.query(
    'SELECT metadata FROM public.remote_agent_workflow_runs WHERE id = $1',
    [id],
  );
  expect(JSON.stringify(run?.metadata)).toContain('not a time');
});

test('deleting a paused run removes its attention item', async () => {
  const id = await pausedRun();
  await db.query('DELETE FROM public.remote_agent_workflow_runs WHERE id = $1', [id]);
  expect(await attentionItems()).toEqual([]);
});

test('0019 projects the attention runs already paused, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0019'),
      db: historical,
    });
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('archon-build-queue', 'paused', 'queue', $1)`,
      [JSON.stringify({ wait: ATTN_WAIT })],
    );
    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0019'),
    );
    expect(await historical.query('SELECT node_id FROM mc.attention_items')).toEqual([
      { node_id: 'ask' },
    ]);
    const before = await historical.query('SELECT * FROM mc.attention_items');
    const [attention] = migrationFiles.filter((f) => f.name === '0019_attention_items.sql');
    await historical.query(attention?.sql ?? '');
    expect(await historical.query('SELECT * FROM mc.attention_items')).toEqual(before);
  } finally {
    await historical.close();
  }
});

const WAIT = {
  kind: 'attention',
  owner: 'node',
  nodeId: 'ask',
  message: MARKER,
};

async function setMetadata(metadata: unknown, status?: string): Promise<void> {
  await db.query(
    `UPDATE public.remote_agent_workflow_runs SET metadata = $2, status = coalesce($3, status)
     WHERE id = $1`,
    [runId, JSON.stringify(metadata), status ?? null],
  );
}

const queueLap = async () =>
  (
    await db.query('SELECT issue_number, attention_open FROM mc.laps WHERE run_id = $1', [runId])
  )[0];

test('a lap’s issue is its run’s number input, unless the run is for a pull request', async () => {
  await setMetadata({ inputs: { number: '401' } });
  expect(await queueLap()).toEqual({
    issue_number: 401,
    attention_open: false,
  });
  await setMetadata({ inputs: { number: '401', kind: 'pull_request' } });
  expect((await queueLap())?.issue_number).toBeNull();
  await setMetadata({ inputs: { number: '' } });
  expect((await queueLap())?.issue_number).toBeNull();
});

test('a lap waits on attention from its pause until the wait is answered or the run resumes', async () => {
  await setMetadata({ wait: WAIT }, 'paused');
  expect((await queueLap())?.attention_open).toBe(true);
  await setMetadata({ wait: { ...WAIT, answer: { text: 'yes' } } });
  expect((await queueLap())?.attention_open).toBe(false);
  await setMetadata({ wait: WAIT }, 'paused');
  expect((await queueLap())?.attention_open).toBe(true);
  await setMetadata({ wait: WAIT }, 'running');
  expect((await queueLap())?.attention_open).toBe(false);
  await setMetadata({ wait: { kind: 'quota' } }, 'paused');
  expect((await queueLap())?.attention_open).toBe(false);
  await setMetadata({ source_release: { nodeId: 'a' }, wait: WAIT }, 'paused');
  expect((await queueLap())?.attention_open).toBe(false);
});

test('metadata of an odd shape commits in Archon, with no issue and no wait, and records no error', async () => {
  for (const odd of [[1, 2], 'text', 5, { inputs: 'x' }, { inputs: { number: '99999999999' } }]) {
    await setMetadata(odd, 'paused');
    expect(await queueLap()).toEqual({
      issue_number: null,
      attention_open: false,
    });
  }
  expect(await projectionErrors()).toEqual([]);
});

test('0019 fills a lap projected before it, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0019'),
      db: historical,
    });
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('archon-build-queue', 'paused', 'historical', $1)`,
      [JSON.stringify({ inputs: { number: '402' }, wait: WAIT })],
    );
    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0019'),
    );
    const lap = () => historical.query('SELECT issue_number, attention_open FROM mc.laps');
    expect(await lap()).toEqual([{ issue_number: 402, attention_open: true }]);
    const migrated = await snapshot(historical);
    const [file] = migrationFiles.filter((f) => f.name === '0019_queue_laps.sql');
    await historical.query(file?.sql ?? '');
    expect(await snapshot(historical)).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('0022 writes the versions build-queue runs already have, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0022'),
      db: historical,
    });
    await historical.query(`INSERT INTO mc.factories VALUES
      ('mission-control', 'coleam00/factory-mission-control', 'coleam00/factory-mission-control',
       'http://localhost:3090')`);
    const [codebase] = await historical.query(`INSERT INTO public.remote_agent_codebases (name)
      VALUES ('coleam00/factory-mission-control') RETURNING id`);
    for (const [workflow, digest] of [
      ['archon-loop', 'sha256:loop'],
      ['archon-build-queue', 'sha256:queue'],
    ]) {
      await historical.query(
        `INSERT INTO public.remote_agent_workflow_runs
           (workflow_name, codebase_id, status, user_message, metadata, started_at)
         VALUES ($1, $2, 'completed', 'historical', $3, $4)`,
        [workflow, codebase?.id, JSON.stringify({ workflow_source: { digest } }), NOW],
      );
    }
    const versions = () => historical.query('SELECT digest, first_run_at FROM mc.versions');
    expect(await versions()).toEqual([{ digest: 'sha256:loop', first_run_at: NOW }]);

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual(
      migrationsFrom('0022'),
    );
    expect(
      (await versions()).sort((a, b) => String(a.digest).localeCompare(String(b.digest))),
    ).toEqual([
      { digest: 'sha256:loop', first_run_at: NOW },
      { digest: 'sha256:queue', first_run_at: NOW },
    ]);
    const migrated = await snapshot(historical);
    const [file] = migrationFiles.filter((f) => f.name === '0022_queue_versions.sql');
    await historical.query(file?.sql ?? '');
    expect(await snapshot(historical)).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

async function archonEvent(workflow: string, type: string, step: string, data: unknown) {
  const [run] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message)
     VALUES ($1, 'running', 'queue') RETURNING id`,
    [workflow],
  );
  await db.query(
    `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
     VALUES ($1, $2, $3, $4)`,
    [run?.id, type, step, JSON.stringify(data)],
  );
  return run?.id;
}

const projectedSteps = (id: unknown) =>
  db.query('SELECT step_id, status, output FROM mc.lap_steps WHERE run_id = $1', [id]);

test('a queue run’s step events project steps and attempts, as the old pack’s other workflows still do not', async () => {
  const started = await archonEvent('archon-build-queue', 'node_started', 'implement', {});
  expect(await projectedSteps(started)).toEqual([
    { step_id: 'implement', status: 'running', output: null },
  ]);
  const merged = await archonEvent('archon-merge-queue', 'node_completed', 'record', {
    structured_output: { merged: [404, 405] },
    duration_ms: 5,
  });
  const [record] = await projectedSteps(merged);
  expect(record).toMatchObject({ step_id: 'record', status: 'completed' });
  expect(
    await db.query('SELECT step_id, status FROM mc.lap_step_attempts WHERE run_id = $1', [merged]),
  ).toEqual([{ step_id: 'record', status: 'completed' }]);
  expect(
    await db.query('SELECT step_id FROM mc.lap_step_attempt_usage WHERE run_id = $1', [merged]),
  ).toEqual([{ step_id: 'record' }]);
  const split = await archonEvent('archon-split', 'node_started', 'slice', {});
  expect(await projectedSteps(split)).toEqual([
    { step_id: 'slice', status: 'running', output: null },
  ]);
  const manager = await archonEvent('archon-manager', 'node_started', 'steer', {});
  expect(await projectedSteps(manager)).toEqual([]);
  expect(await projectionErrors()).toEqual([]);
});

test('the workflows projecting step events are the map’s queue covers and the old loop, no other', async () => {
  const covers = FACTORY_MAP.cards.flatMap((c) => c.covers ?? []);
  const projecting = new Set(
    covers.filter((c) => c.pack === 'queue' || c.workflow === 'archon-loop').map((c) => c.workflow),
  );
  const notProjecting = new Set(covers.map((c) => c.workflow).filter((w) => !projecting.has(w)));
  expect([...notProjecting].sort()).toEqual(['archon-backlog', 'archon-manager']);
  for (const workflow of [...projecting, ...notProjecting]) {
    const [row] = await db.query('SELECT mc.projects_step_events($1) AS projects', [workflow]);
    expect({ workflow, projects: row?.projects }).toEqual({
      workflow,
      projects: projecting.has(workflow),
    });
  }
});

test('mc.keeps_step_output drops output for the workflows that once read holdouts, kept for old rows', async () => {
  const redacted = ['factory-app-check', 'factory-holdout-sweep', 'factory-holdouts'];
  const kept = ['archon-build-queue', 'archon-intake', 'archon-split', 'factory-manager'];
  for (const workflow of [...redacted, ...kept]) {
    const [row] = await db.query('SELECT mc.keeps_step_output($1) AS keeps', [workflow]);
    expect({ workflow, keeps: row?.keeps }).toEqual({
      workflow,
      keeps: !redacted.includes(workflow),
    });
  }
});

test('a holdout workflow’s steps keep status and timing but no output, route or reason', async () => {
  const secret = 'H-07 SECRET report text';
  const cases: [string, string, Record<string, unknown>][] = [
    ['factory-app-check', 'evidence', { report: secret, overall: 'FAIL' }],
    ['factory-app-check', 'choose', { route: 'fix', reason: secret }],
    ['factory-holdouts', 'write', { summary: secret }],
    ['factory-holdout-sweep', 'check', { summary: secret }],
  ];
  for (const [workflow, step, structured_output] of cases) {
    const id = await archonEvent(workflow, 'node_completed', step, {
      structured_output,
      duration_ms: 5,
    });
    expect(await projectedSteps(id)).toEqual([
      { step_id: step, status: 'completed', output: null },
    ]);
    expect(
      await db.query('SELECT route, outcome, reason FROM mc.lap_step_attempts WHERE run_id = $1', [
        id,
      ]),
    ).toEqual([{ route: null, outcome: null, reason: null }]);
  }
  expect(await projectionErrors()).toEqual([]);
});

test('the architecture diff reports a step whose only change is the workflow it runs', async () => {
  const diff = queries.find(([name]) => name === 'arch-diff')?.[1] as string;
  const before = new Date('2026-10-01T00:00:00Z');
  const after = new Date('2026-10-10T00:00:00Z');
  const versions = [
    { digest: 'sha256:aaaa', archon: 'a1', pinnedAt: before, child: 'c3c3' },
    { digest: 'sha256:bbbb', archon: 'a2', pinnedAt: after, child: '9a9a' },
  ];
  await db.query('TRUNCATE mc.arch_versions, mc.arch_steps');
  for (const v of versions) {
    const ranAt = new Date(v.pinnedAt.getTime() + 3_600_000);
    await db.query(
      `INSERT INTO mc.pins (sha, archon_sha, reason, committed_at) VALUES ($1, $1, 'r', $2)`,
      [v.archon, v.pinnedAt],
    );
    await db.query(
      `INSERT INTO mc.arch_versions (archon_sha, factory_sha, parsed_at) VALUES ($1, 'f1', $2)`,
      [v.archon, v.pinnedAt],
    );
    await db.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, digest, started_at)
       VALUES (gen_random_uuid(), 'mission-control', 'archon-loop', 'completed', $1, $2)`,
      [v.digest, ranAt],
    );
    for (const [path, child] of [
      ['judge', v.child],
      ['other', 'same'],
    ]) {
      await db.query(
        `INSERT INTO mc.arch_steps (archon_sha, factory_sha, workflow, path, position, step_id, kind, child_workflow, defined_in, file)
         VALUES ($1, 'f1', 'calibrate', $2, 0, $2, 'workflow', $3, 'calibrate', 'calibrate.yaml')`,
        [v.archon, path, child],
      );
    }
  }

  const rows = await db.query(diff, ['mission-control']);
  const entries = (digest: string) =>
    new Map(
      ((rows.find((r) => r.digest === digest && r.kind === 'step')?.entries ?? []) as string[]).map(
        (e) => e.split('\t'),
      ) as [string, string][],
    );
  const [old, next] = [entries('sha256:aaaa'), entries('sha256:bbbb')];
  expect(next.get('judge')).not.toBe(old.get('judge'));
  expect(next.get('other')).toBe(old.get('other'));
});

async function appCheckRun(
  steps: [string, Record<string, unknown>, ('node_completed' | 'node_failed')?][],
) {
  const [run] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message)
     VALUES ('factory-app-check', 'running', 'queue') RETURNING id`,
  );
  for (const [step, structured_output, eventType = 'node_completed'] of steps) {
    await db.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, $2, $3, $4)`,
      [run?.id, eventType, step, JSON.stringify({ structured_output, duration_ms: 5 })],
    );
  }
  return run?.id;
}

const appCheckSteps = (id: unknown) =>
  db.query('SELECT step_id, status, output FROM mc.lap_steps WHERE run_id = $1 ORDER BY step_id', [
    id,
  ]);

const select = {
  found: true,
  pr: 7,
  head: 'abc1234',
  files: ['SECRET-PATH'],
  issue_body: 'SECRET',
};

test('a queue app check keeps the verdict publish posted and the lines evidence sealed, by kind without their text', async () => {
  const id = await appCheckRun([
    ['select', select],
    ['check', { overall: 'PASS', summary: 'SECRET summary', lines: ['C9  PASS  Self-reported.'] }],
    [
      'evidence',
      {
        overall: 'FAIL',
        report: 'SECRET report',
        lines: [
          'C1  PASS  SECRET sentence.  evidence: a.png',
          'P1  FAIL  The probe failed.  evidence: b.png',
          'A1  PASS  An assertion held.  evidence: c.png',
          'C2  PASS  No tail.',
          'not a line',
        ],
      },
    ],
    ['publish', { state: 'failure', comment: 'created' }],
  ]);
  expect(await appCheckSteps(id)).toEqual([
    { step_id: 'check', status: 'completed', output: { pr: 7, head: 'abc1234', overall: 'FAIL' } },
    { step_id: 'evidence', status: 'completed', output: null },
    { step_id: 'publish', status: 'completed', output: null },
    { step_id: 'select', status: 'completed', output: { pr: 7, head: 'abc1234' } },
  ]);
  expect(
    await db.query(
      'SELECT position, line_id, kind, verdict, evidence_count FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position',
      [id],
    ),
  ).toEqual([
    { position: 1, line_id: 'C1', kind: 'criterion', verdict: 'PASS', evidence_count: 1 },
    { position: 2, line_id: 'P1', kind: 'probe', verdict: 'FAIL', evidence_count: 1 },
    { position: 3, line_id: 'A1', kind: 'assertion', verdict: 'PASS', evidence_count: 1 },
  ]);
  expect(await projectionErrors()).toEqual([]);
});

test('a queue app check shows the verdict publish posted: success is PASS, a stale or failed result is FAIL', async () => {
  const verdict = async (overall: string, state: string) => {
    const id = await appCheckRun([
      ['select', select],
      ['check', { overall }],
      ['evidence', { overall, lines: ['C1  PASS  Fine.  evidence: a.png'] }],
      ['publish', { state, comment: 'created' }],
    ]);
    return (await appCheckSteps(id)).find((r) => r.step_id === 'check')?.output;
  };
  expect(await verdict('PASS', 'success')).toEqual({ pr: 7, head: 'abc1234', overall: 'PASS' });
  expect(await verdict('PASS', 'failure')).toEqual({ pr: 7, head: 'abc1234', overall: 'FAIL' });
  expect(await verdict('FAIL', 'failure')).toEqual({ pr: 7, head: 'abc1234', overall: 'FAIL' });
  expect(await projectionErrors()).toEqual([]);
});

test('a queue app check shows no verdict and no lines until evidence completes, and no verdict until publish completes', async () => {
  const check = [
    'check',
    { overall: 'PASS', lines: ['C1  PASS  Fine.  evidence: a.png'] },
  ] as const;
  const checked = await appCheckRun([['select', select], [...check]]);
  const refused = await appCheckRun([
    ['select', select],
    [...check],
    ['evidence', {}, 'node_failed'],
  ]);
  for (const id of [checked, refused]) {
    expect(await appCheckSteps(id)).toMatchObject([
      { step_id: 'check', status: 'completed', output: null },
      ...(id === refused ? [{ step_id: 'evidence', status: 'failed', output: null }] : []),
      { step_id: 'select', output: { pr: 7, head: 'abc1234' } },
    ]);
    expect(await db.query('SELECT 1 FROM mc.app_check_lines WHERE run_id = $1', [id])).toEqual([]);
  }
  const evidence = ['evidence', { overall: 'PASS', lines: check[1].lines }] as const;
  const unpublished = await appCheckRun([['select', select], [...check], [...evidence]]);
  const publishFailed = await appCheckRun([
    ['select', select],
    [...check],
    [...evidence],
    ['publish', {}, 'node_failed'],
  ]);
  for (const id of [unpublished, publishFailed]) {
    expect((await appCheckSteps(id)).find((r) => r.step_id === 'check')?.output).toBeNull();
  }
  expect(await projectionErrors()).toEqual([]);
});

test('a queue app check that names a holdout, at check or at evidence, keeps no output and no lines', async () => {
  const clean = ['C1  PASS  Fine.  evidence: a.png'];
  const held = ['C1  PASS  Fine.  evidence: a.png', 'H-07  FAIL  SECRET  evidence: b.png'];
  for (const [checkLines, evidenceLines] of [
    [held, clean],
    [clean, held],
  ]) {
    const id = await appCheckRun([
      ['select', select],
      ['check', { overall: 'FAIL', lines: checkLines }],
      ['evidence', { overall: 'FAIL', lines: evidenceLines }],
      ['publish', { state: 'success', comment: 'created' }],
    ]);
    expect(await appCheckSteps(id)).toEqual([
      { step_id: 'check', status: 'completed', output: null },
      { step_id: 'evidence', status: 'completed', output: null },
      { step_id: 'publish', status: 'completed', output: null },
      { step_id: 'select', status: 'completed', output: null },
    ]);
    expect(await db.query('SELECT 1 FROM mc.app_check_lines WHERE run_id = $1', [id])).toEqual([]);
  }
  expect(await projectionErrors()).toEqual([]);
});

test('a queue app check line’s id, kind and verdict follow the factory’s LINE', async () => {
  // A variable path keeps the factory package's own `.ts` imports out of this project's type-check.
  const { LINE } = (await import(
    join(import.meta.dir, '../fixtures/pack/queue/factory/app-check/scripts/evidence.ts')
  )) as { LINE: RegExp };
  const base = [
    'C1  PASS  A criterion.',
    'P12  FAIL  A probe.',
    'A3  INCOMPLETE  An assertion.',
    'X9  PASS  Unknown prefix.',
    'c1  PASS  Lower case id.',
    'C1  MAYBE  Unknown verdict.',
    'C1 PASS Single spaces.',
    'C  PASS  No number.',
  ];
  // Every character where JS `\s` and `.` differ from Postgres' regex classes.
  const jsOnlySpace = [
    ' ',
    ' ',
    ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
    ' ',
    ' ',
    ' ',
    ' ',
    '　',
    '﻿',
  ];
  const texts = [
    ...jsOnlySpace.map((c) => `C1${c}${c}PASS${c}${c}ok.${c}${c}evidence:${c}a.png`),
    ...['\r', ' ', ' '].map((c) => `C1  PASS  in${c}side.  evidence: a.png`),
    ...base.map((text) => `${text}  evidence: a.png`),
    ...base,
    'C4  PASS  Empty tail.  evidence:',
    'C5  PASS  One blank.  evidence: ',
    ' C6  PASS  Leading space.  evidence: a.png',
    'C7\tPASS\tTab separators.  evidence: a.png',
    'C8  PASS  Two\nlines.  evidence: a.png',
    'C9  PASS  Newline after.  evidence:\na.png',
  ];
  const id = await appCheckRun([
    ['select', select],
    ['check', { overall: 'PASS', lines: [] }],
    ['evidence', { overall: 'PASS', lines: texts }],
  ]);
  const projected = await db.query(
    'SELECT line_id, kind FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position',
    [id],
  );
  const accepted = texts.filter((t) => LINE.test(t));
  expect(accepted.length).toBeGreaterThan(3);
  expect(accepted.length).toBeLessThan(texts.length);
  expect(projected).toEqual(
    accepted.map((t) => ({
      line_id: t.split(/\s/)[0],
      kind: { C: 'criterion', P: 'probe', A: 'assertion' }[t[0] as 'C' | 'P' | 'A'],
    })),
  );
});

test('a queue app check stores no line LINE rejects: no evidence tail, empty tail, leading space', async () => {
  const { LINE } = (await import(
    join(import.meta.dir, '../fixtures/pack/queue/factory/app-check/scripts/evidence.ts')
  )) as { LINE: RegExp };
  const rejected = [
    'C7  PASS  No evidence tail.',
    'C2  PASS  Empty evidence.  evidence:',
    '  C3  PASS  Leading space.  evidence: a.png',
  ];
  expect(rejected.filter((t) => LINE.test(t))).toEqual([]);
  const id = await appCheckRun([
    ['select', select],
    ['check', { overall: 'PASS', lines: rejected }],
    ['evidence', { overall: 'PASS', lines: [...rejected, 'C1  PASS  Kept.  evidence: a.png'] }],
  ]);
  expect(
    await db.query('SELECT line_id FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position', [
      id,
    ]),
  ).toEqual([{ line_id: 'C1' }]);
});

test('the queue holdout fence names every id holdoutId reads', async () => {
  const texts = ['PH-12 then H-07 seen', 'see H-123, then H-04', 'x_H-07 and (H-08)', 'no id'];
  for (const text of texts) {
    const [row] = await db.query('SELECT mc.queue_app_check_has_holdout($1::jsonb) AS held', [
      JSON.stringify([`C1  PASS  ${text}  evidence: a.png`]),
    ]);
    expect({ text, held: row?.held }).toEqual({ text, held: holdoutId(text) !== 'unidentified' });
  }
});

test('0024 re-projects stored queue app checks: lines for a clean run, nothing for a holdout run, and nothing changes run again', async () => {
  const historical = await archonDb();
  const check = (lines: string[]) => ({ overall: 'FAIL', summary: 'SECRET', lines });
  const run = async (hold: boolean) => {
    const [r] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message)
       VALUES ('factory-app-check', 'running', 'queue') RETURNING id`,
    );
    const outputs: [string, unknown][] = [
      ['select', select],
      [
        'check',
        check([
          'C1  PASS  Fine.  evidence: a.png',
          hold ? 'H-07  FAIL  SECRET  evidence: b.png' : 'P1  FAIL  Probe.  evidence: b.png',
        ]),
      ],
    ];
    for (const [step, structured_output] of outputs) {
      await historical.query(
        `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'node_completed', $2, $3)`,
        [r?.id, step, JSON.stringify({ structured_output, duration_ms: 5 })],
      );
    }
    return r?.id;
  };
  const stored = (id: unknown) =>
    Promise.all([
      historical.query(
        'SELECT step_id, output FROM mc.lap_steps WHERE run_id = $1 ORDER BY step_id',
        [id],
      ),
      historical.query(
        'SELECT line_id, kind, verdict FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position',
        [id],
      ),
    ]);
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0024'),
      db: historical,
    });
    const clean = await run(false);
    const held = await run(true);
    expect(await stored(clean)).toEqual([
      [
        { step_id: 'check', output: null },
        { step_id: 'select', output: null },
      ],
      [],
    ]);

    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0025'),
      db: historical,
    });
    const migrated = [await stored(clean), await stored(held)];
    expect(migrated).toEqual([
      [
        [
          { step_id: 'check', output: { pr: 7, head: 'abc1234', overall: 'FAIL' } },
          { step_id: 'select', output: { pr: 7, head: 'abc1234' } },
        ],
        [
          { line_id: 'C1', kind: 'criterion', verdict: 'PASS' },
          { line_id: 'P1', kind: 'probe', verdict: 'FAIL' },
        ],
      ],
      [
        [
          { step_id: 'check', output: null },
          { step_id: 'select', output: null },
        ],
        [],
      ],
    ]);
    const [file] = migrationFiles.filter((f) => f.name.startsWith('0024'));
    await historical.query(file?.sql ?? '');
    expect([await stored(clean), await stored(held)]).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('0025 re-projects stored queue app checks from the sealed evidence, leaves the old loop alone, and nothing changes run again', async () => {
  const historical = await archonDb();
  const lines = ['C1  PASS  Fine.  evidence: a.png', 'C2  PASS  No tail.'];
  const run = async (workflow: string, events: [string, string, unknown][]) => {
    const [r] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message)
       VALUES ($1, 'running', 'queue') RETURNING id`,
      [workflow],
    );
    for (const [type, step, structured_output] of events) {
      await historical.query(
        `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, $2, $3, $4)`,
        [r?.id, type, step, JSON.stringify({ structured_output, duration_ms: 5 })],
      );
    }
    return r?.id;
  };
  const stored = (id: unknown) =>
    Promise.all([
      historical.query(
        'SELECT step_id, output FROM mc.lap_steps WHERE run_id = $1 ORDER BY step_id',
        [id],
      ),
      historical.query(
        'SELECT line_id FROM mc.app_check_lines WHERE run_id = $1 ORDER BY position',
        [id],
      ),
    ]);
  const check = ['node_completed', 'check', { overall: 'PASS', lines }] as [
    string,
    string,
    unknown,
  ];
  const sel = ['node_completed', 'select', select] as [string, string, unknown];
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0025'),
      db: historical,
    });
    const refused = await run('factory-app-check', [sel, check, ['node_failed', 'evidence', {}]]);
    const sealed = await run('factory-app-check', [
      sel,
      check,
      ['node_completed', 'evidence', { overall: 'FAIL', lines }],
    ]);
    const oldLoop = await run('archon-loop', [['node_completed', 'check-app', { lines: [] }]]);
    const oldLoopBefore = await stored(oldLoop);
    expect(await stored(refused)).toMatchObject([
      [{ step_id: 'check', output: { overall: 'PASS' } }, {}, {}],
      [{ line_id: 'C1' }, { line_id: 'C2' }],
    ]);

    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0027'),
      db: historical,
    });
    const migrated = [await stored(refused), await stored(sealed)];
    expect(migrated).toEqual([
      [
        [
          { step_id: 'check', output: null },
          { step_id: 'evidence', output: null },
          { step_id: 'select', output: { pr: 7, head: 'abc1234' } },
        ],
        [],
      ],
      [
        [
          { step_id: 'check', output: { pr: 7, head: 'abc1234', overall: 'FAIL' } },
          { step_id: 'evidence', output: null },
          { step_id: 'select', output: { pr: 7, head: 'abc1234' } },
        ],
        [{ line_id: 'C1' }],
      ],
    ]);
    expect(await stored(oldLoop)).toEqual(oldLoopBefore);
    const [file] = migrationFiles.filter((f) => f.name.startsWith('0025'));
    await historical.query(file?.sql ?? '');
    expect([await stored(refused), await stored(sealed)]).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('0027 re-projects stored queue app checks from what publish posted, leaves the old loop alone, and nothing changes run again', async () => {
  const historical = await archonDb();
  const lines = ['C1  PASS  Fine.  evidence: a.png'];
  const run = async (workflow: string, events: [string, unknown][]) => {
    const [r] = await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message)
       VALUES ($1, 'running', 'queue') RETURNING id`,
      [workflow],
    );
    for (const [step, structured_output] of events) {
      await historical.query(
        `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'node_completed', $2, $3)`,
        [r?.id, step, JSON.stringify({ structured_output, duration_ms: 5 })],
      );
    }
    return r?.id;
  };
  const stored = (id: unknown) =>
    historical.query(
      'SELECT step_id, output FROM mc.lap_steps WHERE run_id = $1 ORDER BY step_id',
      [id],
    );
  const verdict = async (id: unknown) =>
    (await stored(id)).find((r) => r.step_id === 'check')?.output;
  const upToEvidence: [string, unknown][] = [
    ['select', select],
    ['check', { overall: 'PASS', lines }],
    ['evidence', { overall: 'PASS', lines }],
  ];
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0027'),
      db: historical,
    });
    const stale = await run('factory-app-check', [
      ...upToEvidence,
      ['publish', { state: 'failure', comment: 'created' }],
    ]);
    const fresh = await run('factory-app-check', [
      ...upToEvidence,
      ['publish', { state: 'success', comment: 'created' }],
    ]);
    const unpublished = await run('factory-app-check', upToEvidence);
    const oldLoop = await run('archon-loop', [['check-app', { lines: [] }]]);
    const oldLoopBefore = await stored(oldLoop);
    expect(await verdict(stale)).toEqual({ pr: 7, head: 'abc1234', overall: 'PASS' });

    await runMigrations({ files: migrationFiles, db: historical });
    const verdicts = () => Promise.all([stale, fresh, unpublished].map(verdict));
    const migrated = await verdicts();
    expect(migrated).toEqual([
      { pr: 7, head: 'abc1234', overall: 'FAIL' },
      { pr: 7, head: 'abc1234', overall: 'PASS' },
      null,
    ]);
    expect(await stored(oldLoop)).toEqual(oldLoopBefore);
    const [file] = migrationFiles.filter((f) => f.name.startsWith('0027'));
    await historical.query(file?.sql ?? '');
    expect(await verdicts()).toEqual(migrated);
  } finally {
    await historical.close();
  }
});

test('the queue app check projection reads the node ids and output keys the pack declares', () => {
  type Node = {
    id: string;
    with?: Record<string, string>;
    output_format?: { required?: string[]; properties?: Record<string, { enum?: string[] }> };
  };
  const pack = Bun.YAML.parse(
    readFileSync(
      join(import.meta.dir, '../fixtures/pack/queue/factory/app-check/factory-app-check.yaml'),
      'utf-8',
    ),
  ) as { nodes: Node[] };
  const node = (id: string) => pack.nodes.find((n) => n.id === id);
  expect(node('check')).toBeDefined();
  expect(node('select')).toBeDefined();
  expect(node('evidence')?.output_format?.required).toEqual(
    expect.arrayContaining(['overall', 'lines']),
  );
  expect(node('evidence')?.output_format?.properties?.overall?.enum).toEqual(['PASS', 'FAIL']);
  expect(node('publish')?.output_format?.required).toEqual(expect.arrayContaining(['state']));
  expect(node('publish')?.output_format?.properties?.state?.enum).toEqual(['success', 'failure']);
  expect(node('publish')?.with).toMatchObject({
    overall: '$evidence.output.overall',
    lines: '$evidence.output.lines',
    pr: '$select.output.pr',
    head: '$select.output.head',
  });
});

const stateDoc = (facts: object) => JSON.stringify({ version: 1, stage: 'deliver', facts });
const WORK = 'coleam00/factory-mission-control';

async function putState(name: string, revision: number, value: string | null, operation = 'put') {
  await db.query(
    `INSERT INTO public.remote_agent_state_revisions (project_key, name, revision, value, operation, writer_kind)
     VALUES ($1, $2, $3, $4, $5, 'run')`,
    [WORK, name, revision, value, operation],
  );
}

const workStates = () =>
  db.query(
    `SELECT number, revision, build_status, build_at, merge_status, triage_at, own_pr_at
     FROM mc.work_item_states ORDER BY number`,
  );

test('a work item state revision replaces the row, an older one inserted after it does not, and a delete removes it', async () => {
  await putState(
    'work/356',
    1,
    stateDoc({ triage: { at: 'T1' }, build: { status: 'next', at: 'T2' } }),
  );
  await putState(
    'work/356',
    3,
    stateDoc({ triage: { at: 'T1' }, build: { status: 'parked', at: 'T3' } }),
  );
  await putState('work/356', 2, stateDoc({ build: { status: 'asking', at: 'T0' } }));
  expect(await workStates()).toEqual([
    {
      number: 356,
      revision: 3,
      build_status: 'parked',
      build_at: 'T3',
      merge_status: null,
      triage_at: 'T1',
      own_pr_at: null,
    },
  ]);

  await putState('work/356', 4, null, 'delete');
  expect(await workStates()).toEqual([]);
});

test('only work/<n> documents of the state store are projected, and a bad one never fails the write', async () => {
  await putState('discoveries/x', 1, stateDoc({ build: { status: 'parked', at: 'T1' } }));
  await putState('work/abc', 1, stateDoc({ build: { status: 'parked', at: 'T1' } }));
  expect(await workStates()).toEqual([]);

  await putState('work/9', 1, '{not json');
  expect(await workStates()).toEqual([]);
  expect(
    await db.query('SELECT count(*)::int AS n FROM public.remote_agent_state_revisions'),
  ).toEqual([{ n: 3 }]);
  const errors = await projectionErrors();
  expect(errors).toHaveLength(1);
  expect(errors[0]?.source).toBe('mc_project_work_item_state');
  expect(String(errors[0]?.message)).toStartWith('work/9: ');
});

test('0028 projects the latest revision of each stored work item, and nothing changes run again', async () => {
  const historical = await archonDb();
  const put = (name: string, revision: number, value: string | null) =>
    historical.query(
      `INSERT INTO public.remote_agent_state_revisions (project_key, name, revision, value, operation, writer_kind)
       VALUES ($1, $2, $3, $4, 'put', 'run')`,
      [WORK, name, revision, value],
    );
  await put('work/5', 1, stateDoc({ build: { status: 'next', at: 'T1' } }));
  await put('work/5', 2, stateDoc({ build: { status: 'parked', at: 'T2' } }));
  await put('work/6', 1, stateDoc({ merge: { status: 'parked', at: 'T3' } }));
  await put('discoveries/x', 1, '{}');
  await runMigrations({ files: migrationFiles, db: historical });

  expect(
    await historical.query(
      'SELECT number, revision, build_status, merge_status FROM mc.work_item_states ORDER BY number',
    ),
  ).toEqual([
    { number: 5, revision: 2, build_status: 'parked', merge_status: null },
    { number: 6, revision: 1, build_status: null, merge_status: 'parked' },
  ]);
  const before = await snapshot(historical);
  await historical.query(
    await Bun.file(join(import.meta.dir, 'migrations/0028_work_item_states.sql')).text(),
  );
  expect(await snapshot(historical)).toEqual(before);
  await historical.close();
});

const ATTENTION = {
  what: 'Two screens in one change.',
  why: 'Hard to review.',
  recommendation: {
    choice: 'split',
    why: 'Smaller changes land sooner.',
    evidence: 'No shared component.',
    confidence: 'high',
    would_change: 'A shared change.',
  },
  choices: [
    { id: 'split', label: 'Split (in two)', does: 'Two issues.' },
    { id: 'build', label: 'Build', does: 'One change.' },
  ],
  if_unanswered: 'It waits.',
  links: ['https://example.test/1'],
};

// The message layout Archon 57c857402 rendered; waits stored before the upgrade still carry it.
const renderedAttention = (title: string, recommended = 'split'): string => {
  const { recommendation } = ATTENTION;
  return [
    `**${title}**`,
    '',
    `**What it is.** ${ATTENTION.what}`,
    '',
    `**Why it matters.** ${ATTENTION.why}`,
    '',
    `**Recommendation: \`${recommended}\`** (${recommendation.confidence} confidence). ${recommendation.why}`,
    `Evidence: ${recommendation.evidence}`,
    `What would change it: ${recommendation.would_change}`,
    '',
    '**Choices.**',
    ...ATTENTION.choices.map((choice) => `- \`${choice.id}\` (${choice.label}): ${choice.does}`),
    '',
    `**If nobody answers.** ${ATTENTION.if_unanswered}`,
    '',
    '**Evidence links.**',
    ...ATTENTION.links.map((link) => `- ${link}`),
  ].join('\n');
};

const ATTN_OPTIONS = [
  { id: 'split', label: 'Split (in two)' },
  { id: 'build', label: 'Build' },
];

const decideFields = () =>
  db.query(
    `SELECT occurrence_id, item_number, recommended, confidence, recommendation_why,
       options::text AS options FROM mc.attention_items`,
  );

test('an attention item records the rendered recommendation, confidence, descriptions, item and occurrence', async () => {
  const message = renderedAttention('Build queue, issue 15: scope decision');
  await pausedRun({ ...ATTN_WAIT, message, options: ATTN_OPTIONS });
  const [item] = await decideFields();
  expect(item).toMatchObject({
    occurrence_id: 'p1',
    item_number: 15,
    recommended: 'split',
    confidence: 'high',
    recommendation_why: null,
  });
  expect(JSON.parse(String(item?.options))).toEqual([
    { id: 'split', label: 'Split (in two)', description: 'Two issues.' },
    { id: 'build', label: 'Build', description: 'One change.' },
  ]);
});

const STRUCTURED = {
  ...ATTN_WAIT,
  options: [
    { id: 'split', label: 'Split (in two)', does: 'Two issues.', value: { choice: 'split' } },
    { id: 'build', label: 'Build', does: 'One change.', value: { choice: 'build' } },
  ],
  recommendation: { option: 'build', why: 'One reviewer has both screens.', confidence: 'low' },
  message:
    '**Build queue, issue 15: scope decision**\n\n**Recommendation: `split`** (high confidence). Old.\n\n**Choices.**\n- `split` (Split (in two)): Stale text.',
};

test('a wait the pinned pack’s attentionWait writes projects its recommendation, why, confidence and each choice’s does', async () => {
  const { attentionWait } = await import(
    join(import.meta.dir, '../fixtures/pack/queue/sdlc/.shared/queue.ts')
  );
  await pausedRun({
    ...ATTN_WAIT,
    ...attentionWait('Build queue, issue 15: scope decision', ATTENTION),
  });
  const [item] = await decideFields();
  expect(item).toMatchObject({
    item_number: 15,
    recommended: 'split',
    confidence: 'high',
    recommendation_why: 'Smaller changes land sooner.',
  });
  expect(JSON.parse(String(item?.options))).toEqual([
    { id: 'split', label: 'Split (in two)', description: 'Two issues.' },
    { id: 'build', label: 'Build', description: 'One change.' },
  ]);
});

test('a structured wait’s recommendation, why, confidence and does win over a reworded message', async () => {
  await pausedRun(STRUCTURED);
  const [item] = await decideFields();
  expect(item).toMatchObject({
    recommended: 'build',
    confidence: 'low',
    recommendation_why: 'One reviewer has both screens.',
  });
  expect(JSON.parse(String(item?.options))).toEqual([
    { id: 'split', label: 'Split (in two)', description: 'Two issues.' },
    { id: 'build', label: 'Build', description: 'One change.' },
  ]);

  await db.query('TRUNCATE mc.attention_items');
  await pausedRun({
    ...STRUCTURED,
    form: 'approval',
    recommendation: { option: 'approve', why: 'Safe.' },
  });
  expect((await decideFields())[0]).toMatchObject({
    recommended: 'approve',
    confidence: null,
    recommendation_why: 'Safe.',
  });
});

test('a structured recommendation naming an option that is not offered leaves the message reading', async () => {
  await pausedRun({
    ...STRUCTURED,
    recommendation: { option: 'ghost', why: 'Nobody offered this.', confidence: 'low' },
  });
  expect((await decideFields())[0]).toMatchObject({
    recommended: 'split',
    confidence: 'high',
    recommendation_why: null,
  });
});

test('a blank does leaves the option description as its choice line', async () => {
  await pausedRun({
    ...STRUCTURED,
    options: [{ id: 'split', label: 'Split (in two)', does: '  ' }, ...STRUCTURED.options.slice(1)],
  });
  const [item] = await decideFields();
  expect(JSON.parse(String(item?.options))[0]).toEqual({
    id: 'split',
    label: 'Split (in two)',
    description: 'Stale text.',
  });
});

test('20261110T1600Z reprojects waits stored before it, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    const name = '20261110T1600Z_attention_wait_recommendation';
    await runMigrations({ files: migrationFiles.filter((f) => f.name < name), db: historical });
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('archon-build-queue', 'paused', 'queue', $1)`,
      [JSON.stringify({ wait: STRUCTURED })],
    );
    await runMigrations({ files: migrationFiles, db: historical });
    const [item] = await historical.query(
      'SELECT recommended, confidence, recommendation_why FROM mc.attention_items',
    );
    expect(item).toEqual({
      recommended: 'build',
      confidence: 'low',
      recommendation_why: 'One reviewer has both screens.',
    });
    const before = await snapshot(historical);
    const [file] = migrationFiles.filter((f) => f.name.startsWith(name));
    await historical.query(file?.sql ?? '');
    expect(await snapshot(historical)).toEqual(before);
  } finally {
    await historical.close();
  }
});

test('the projector and parseRecommendation read the same Recommendation line', async () => {
  const messages = [
    renderedAttention('Build queue, issue 15: scope decision'),
    '**What it is.** Two screens. **Recommendation: `split`** (high confidence). Because.',
    '**Recommendation: `split`** (very high confidence). Because.',
    '**Recommendation: `split`**. Because.',
    '**Recommendation: `nope`** (high confidence). Because.',
    '**Recommendation: `split`**. A.\n\n**Recommendation: `build`** (high confidence). B.',
    'Which lap next?',
  ];
  const seen: unknown[] = [];
  for (const message of messages) {
    await db.query('TRUNCATE mc.attention_items, public.remote_agent_workflow_runs CASCADE');
    await pausedRun({ ...ATTN_WAIT, message, options: ATTN_OPTIONS });
    const p = parseRecommendation(message);
    const offered = p !== null && ATTN_OPTIONS.some((o) => o.id === p.choice);
    const [item] = await decideFields();
    expect(item).toMatchObject({
      recommended: offered ? p.choice : null,
      confidence: offered ? p.confidence : null,
    });
    seen.push([item?.recommended, item?.confidence]);
  }
  expect(seen[1]).toEqual(['split', 'high']);
  expect(seen[2]).toEqual(['split', null]);
});

test('an attention item without a recommendation or pause id still has its occurrence and item', async () => {
  const { pauseId: _pause, ...legacy } = ATTN_WAIT;
  const unoffered = renderedAttention('Build queue, issue 15: scope decision', 'nope');
  await pausedRun({ ...legacy, message: unoffered, options: ATTN_OPTIONS });
  const [item] = await decideFields();
  expect(item).toMatchObject({ occurrence_id: 'legacy:ask', recommended: null, confidence: null });

  await db.query('TRUNCATE mc.attention_items');
  await pausedRun({ ...legacy, message: 'Which lap next?', options: ATTN_OPTIONS });
  const [plain] = await decideFields();
  expect(plain).toMatchObject({ recommended: null, confidence: null, item_number: null });
  expect(JSON.parse(String(plain?.options))).toEqual(ATTN_OPTIONS);

  await db.query('TRUNCATE mc.attention_items');
  await pausedRun({ ...legacy, owner: 'loop_group', bodyWaitId: 'ask', nodeId: 'rounds' });
  expect((await decideFields())[0]?.occurrence_id).toBe('legacy:rounds.ask');
});

test('an attention item’s number is the merge title’s PR, else the run’s number input', async () => {
  const merge = renderedAttention('Merge queue, PR 16: merge decision');
  await pausedRun({ ...ATTN_WAIT, message: merge, options: ATTN_OPTIONS });
  expect((await decideFields())[0]?.item_number).toBe(16);

  await db.query('TRUNCATE mc.attention_items');
  await pausedRun(
    { ...ATTN_WAIT, message: '**Build: a person decides how this run continues**\n\nAsk.' },
    { inputs: { number: '77' } },
  );
  expect((await decideFields())[0]?.item_number).toBe(77);
});

const capacityWaits = () => db.query('SELECT run_id, item_number, since FROM mc.capacity_waits');
const setStatus = (id: string, status: string) =>
  db.query('UPDATE public.remote_agent_workflow_runs SET status = $2 WHERE id = $1', [id, status]);

test('an answered run waiting for capacity is one capacity wait until it resumes or its slot is released', async () => {
  const answered = { ...ATTN_WAIT, answer: { decision: 'ship' } };
  const since = '2026-10-24T11:00:00.000Z';
  const id = await pausedRun(ATTN_WAIT);
  expect(await capacityWaits()).toEqual([]);
  await setAttentionMetadata(id, { wait: answered });
  expect(await capacityWaits()).toEqual([]);

  await setAttentionMetadata(id, { wait: answered, capacity_wait: { since } });
  expect(await capacityWaits()).toEqual([{ run_id: id, item_number: 15, since: new Date(since) }]);
  expect(await attentionItems()).toEqual([]);

  await setAttentionMetadata(id, { wait: answered, capacity_wait: null });
  expect(await capacityWaits()).toEqual([]);

  await setAttentionMetadata(id, { wait: answered, capacity_wait: { since } });
  await setStatus(id, 'running');
  expect(await capacityWaits()).toEqual([]);

  await setStatus(id, 'paused');
  expect(await capacityWaits()).toHaveLength(1);
  await db.query('DELETE FROM public.remote_agent_workflow_runs WHERE id = $1', [id]);
  expect(await capacityWaits()).toEqual([]);
});

test('a capacity wait with a bad since commits Archon’s write, records one error and keeps the attention item', async () => {
  const id = await pausedRun(ATTN_WAIT);
  await setAttentionMetadata(id, {
    wait: { ...ATTN_WAIT, answer: {} },
    capacity_wait: { since: 'not a time' },
  });
  expect(await capacityWaits()).toEqual([]);
  const errors = await projectionErrors();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ source: 'mc.project_attention_item', run_id: id });
});

const workExtras = () =>
  db.query('SELECT number, stage, claim_run_id FROM mc.work_item_states ORDER BY number');
const workBlockers = () =>
  db.query('SELECT number, blocker FROM mc.work_item_blockers ORDER BY number, blocker');

test('a work item state keeps its stage, its claim’s run and the items its parking decision names', async () => {
  const claimRun = '5eed0009-0000-4000-8000-000000000001';
  const doc = (extra: object, facts: object) =>
    JSON.stringify({ version: 1, stage: 'blocked', ...extra, facts });
  await putState('work/20', 1, doc({ claim: { run_id: claimRun, at: 'T1' } }, {}));
  await putState('work/21', 1, doc({ claim: { run_id: 'not-a-uuid' } }, {}));
  expect(await workExtras()).toEqual([
    { number: 20, stage: 'blocked', claim_run_id: claimRun },
    { number: 21, stage: 'blocked', claim_run_id: null },
  ]);

  const parked = (decisions: object[], queue = 'build') => ({
    [queue]: { status: 'parked', at: 'T2', decisions },
  });
  await putState(
    'work/30',
    1,
    doc(
      {},
      parked([
        { reason: 'Earlier #1', answer: { text: '#1' } },
        { reason: 'Wait for #496', answer: { choice: 'wait', text: 'Wait: #496 and #30, #497' } },
      ]),
    ),
  );
  expect(await workBlockers()).toEqual([
    { number: 30, blocker: 496 },
    { number: 30, blocker: 497 },
  ]);

  await putState('work/31', 1, doc({}, parked([{ reason: 'Wait for #12' }], 'merge')));
  expect(await workBlockers()).toContainEqual({ number: 31, blocker: 12 });

  await putState('work/30', 2, doc({}, { build: { status: 'next', at: 'T3' } }));
  await putState('work/31', 2, null, 'delete');
  expect(await workBlockers()).toEqual([]);
});

test('a work item state keeps the reason of the decision that parked it, and drops it once it is not parked', async () => {
  const doc = (facts: object) => JSON.stringify({ version: 1, stage: 'deliver', facts });
  const reasons = () =>
    db.query('SELECT number, parked_reason FROM mc.work_item_states ORDER BY number');
  await putState(
    'work/40',
    1,
    doc({
      build: {
        status: 'parked',
        at: 'T2',
        decisions: [{ reason: 'Earlier' }, { reason: 'Wait for #41 to merge' }],
      },
    }),
  );
  await putState('work/42', 1, doc({ build: { status: 'parked', at: 'T2', decisions: [{}] } }));
  expect(await reasons()).toEqual([
    { number: 40, parked_reason: 'Wait for #41 to merge' },
    { number: 42, parked_reason: null },
  ]);
  await putState('work/40', 2, doc({ build: { status: 'next', at: 'T3' } }));
  expect(await reasons()).toContainEqual({ number: 40, parked_reason: null });
});

test('a work item state projects its rounds compactly, its returns, last decision and pull request', async () => {
  const round = (reason: string, pr: number, reviews: number) => ({
    at: `T-${pr}`,
    reason,
    summary: 'long text that is not kept',
    reviews: Array.from({ length: reviews }, () => ({ verdict: 'x' })),
    run_id: `run-${pr}`,
    pr_number: pr,
  });
  const returned = { decision: 'returned by the merge queue', reason: 'conflict' };
  const doc = (build: object) =>
    JSON.stringify({
      version: 1,
      stage: 'deliver',
      facts: { build: { status: 'ready', at: 'T', ...build } },
    });
  const facts = () =>
    db.query(
      `SELECT number, rounds, returns, last_decision, pr_number FROM mc.work_item_states
       WHERE number IN (648, 649) ORDER BY number`,
    );
  await putState(
    'work/648',
    1,
    doc({
      rounds: [
        round('ask', 650, 0),
        round('delivered', 651, 2),
        round('delivered', 652, 1),
        round('ask', 653, 0),
        round('delivered', 654, 3),
      ],
      decisions: [
        returned,
        { decision: 'park', reason: 'returned by the merge queue' },
        returned,
        returned,
      ],
    }),
  );
  await putState('work/649', 1, doc({}));
  const [full, empty] = (await facts()) as unknown as {
    rounds: { at: string; reason: string; reviews: number; run_id: string }[];
    returns: number;
    last_decision: string | null;
    pr_number: number | null;
  }[];
  expect(full.rounds.map((r) => [r.reason, r.reviews])).toEqual([
    ['ask', 0],
    ['delivered', 2],
    ['delivered', 1],
    ['ask', 0],
    ['delivered', 3],
  ]);
  expect(full.rounds[4]).toEqual({
    at: 'T-654',
    reason: 'delivered',
    reviews: 3,
    run_id: 'run-654',
  });
  expect(full).toMatchObject({
    returns: 3,
    last_decision: 'returned by the merge queue',
    pr_number: 654,
  });
  expect(empty).toEqual({
    number: 649,
    rounds: [],
    returns: 0,
    last_decision: null,
    pr_number: null,
  });
  expect(await projectionErrors()).toEqual([]);
});

test('0031 fills the new columns and tables for runs and documents stored before it, and changes nothing run again', async () => {
  const historical = await archonDb();
  try {
    await runMigrations({
      files: migrationFiles.filter((f) => f.name < '0031'),
      db: historical,
    });
    const since = '2026-10-24T11:00:00.000Z';
    await historical.query(
      `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message, metadata)
       VALUES ('archon-build-queue', 'paused', 'queue', $1), ('archon-build-queue', 'paused', 'queue', $2)`,
      [
        JSON.stringify({ wait: ATTN_WAIT }),
        JSON.stringify({ wait: { ...ATTN_WAIT, answer: {} }, capacity_wait: { since } }),
      ],
    );
    await historical.query(
      `INSERT INTO public.remote_agent_state_revisions (project_key, name, revision, value, operation, writer_kind)
       VALUES ($1, 'work/5', 1, $2, 'put', 'run')`,
      [
        WORK,
        stateDoc({ build: { status: 'parked', at: 'T2', decisions: [{ reason: 'Wait for #9' }] } }),
      ],
    );
    await runMigrations({ files: migrationFiles, db: historical });
    expect(
      await historical.query(`SELECT
        (SELECT occurrence_id FROM mc.attention_items) AS occurrence,
        (SELECT item_number FROM mc.attention_items) AS item,
        (SELECT since FROM mc.capacity_waits) AS since,
        (SELECT blocker FROM mc.work_item_blockers) AS blocker`),
    ).toEqual([{ occurrence: 'p1', item: 15, since: new Date(since), blocker: 9 }]);
    const before = await snapshot(historical);
    const [file] = migrationFiles.filter((f) => f.name.startsWith('0031'));
    await historical.query(file?.sql ?? '');
    expect(await snapshot(historical)).toEqual(before);
  } finally {
    await historical.close();
  }
});

const metric = (subject: string | null, value: number, extra: Record<string, unknown> = {}) => ({
  name: 'sdlc.review_rounds',
  kind: 'score',
  unit: 'rounds',
  subject,
  value,
  ...extra,
});
const metricEvent = (
  event: 'node_completed' | 'node_failed',
  data: Record<string, unknown>,
  step = 'prs',
) => insertEvent(event, step, { type: 'script', ...data });
const metricRows = () =>
  db.query('SELECT subject, value, step_id FROM mc.metric_records ORDER BY subject');

describe('metric records (#630)', () => {
  test('a node_completed writes one row per record, and a later one at the same step replaces them', async () => {
    await metricEvent('node_completed', {
      structured_output: { metrics: [metric('pr#1', 3), metric('pr#2', 5)] },
    });
    expect(await metricRows()).toEqual([
      { subject: 'pr#1', value: 3, step_id: 'prs' },
      { subject: 'pr#2', value: 5, step_id: 'prs' },
    ]);
    await metricEvent('node_completed', { structured_output: { metrics: [metric('pr#2', 4)] } });
    expect(await metricRows()).toEqual([{ subject: 'pr#2', value: 4, step_id: 'prs' }]);
  });

  test('a later node_failed at the same position removes the run’s rows, another step keeps its own', async () => {
    await metricEvent('node_completed', { structured_output: { metrics: [metric('pr#1', 3)] } });
    await metricEvent(
      'node_completed',
      { structured_output: { metrics: [metric('pr#2', 2)] } },
      'other',
    );
    await metricEvent('node_failed', {});
    expect(await metricRows()).toEqual([{ subject: 'pr#2', value: 2, step_id: 'other' }]);
  });

  test('a relaying node’s metrics are not records', async () => {
    await metricEvent('node_completed', {
      type: 'workflow',
      structured_output: { metrics: [metric('pr#1', 3)] },
    });
    expect(await metricRows()).toEqual([]);
  });

  test('one malformed record refuses the whole event and records no error', async () => {
    await metricEvent('node_completed', {
      structured_output: {
        metrics: [metric('pr#1', 3), { ...metric('pr#2', 1), name: 'Bad Name' }],
      },
    });
    expect(await metricRows()).toEqual([]);
    expect(await db.query('SELECT 1 FROM mc.projection_errors')).toEqual([]);
  });

  test.each(['unit', 'value'])(
    'a record missing %s refuses only its own event, with no projection error',
    async (key) => {
      await metricEvent('node_completed', { structured_output: { metrics: [metric('pr#1', 3)] } });
      const { [key]: _omitted, ...incomplete } = metric('pr#2', 1) as Record<string, unknown>;
      await metricEvent(
        'node_completed',
        { structured_output: { metrics: [incomplete] } },
        'other',
      );
      expect(await metricRows()).toEqual([{ subject: 'pr#1', value: 3, step_id: 'prs' }]);
      expect(await db.query('SELECT 1 FROM mc.projection_errors')).toEqual([]);
    },
  );

  test('a record without a subject key is refused, as Archon refuses it', async () => {
    const { subject: _omitted, ...subjectless } = metric('pr#1', 3) as Record<string, unknown>;
    await metricEvent('node_completed', { structured_output: { metrics: [subjectless] } });
    expect(await metricRows()).toEqual([]);
    expect(await db.query('SELECT 1 FROM mc.projection_errors')).toEqual([]);
  });

  test('a node_completed without metrics on a run with no rows writes nothing', async () => {
    await metricEvent('node_completed', { structured_output: { verdict: 'ok' } });
    expect(await metricRows()).toEqual([]);
    expect(await db.query('SELECT 1 FROM mc.projection_errors')).toEqual([]);
  });

  test('deleting the Archon run deletes its rows', async () => {
    await metricEvent('node_completed', { structured_output: { metrics: [metric('pr#1', 3)] } });
    await db.query('DELETE FROM public.remote_agent_workflow_runs WHERE id = $1', [runId]);
    expect(await metricRows()).toEqual([]);
  });

  test('20261111T1300Z projects metric events stored before it, and changes nothing run again', async () => {
    const historical = await archonDb();
    try {
      const name = '20261111T1300Z_metric_records';
      await runMigrations({ files: migrationFiles.filter((f) => f.name < name), db: historical });
      const [run] = await historical.query(
        `INSERT INTO public.remote_agent_workflow_runs (workflow_name, status, user_message)
         VALUES ('archon-metrics-prs', 'completed', 'metrics') RETURNING id`,
      );
      await historical.query(
        `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
         VALUES ($1, 'node_completed', 'prs', $2)`,
        [
          run?.id,
          JSON.stringify({ type: 'script', structured_output: { metrics: [metric('pr#1', 3)] } }),
        ],
      );
      await runMigrations({ files: migrationFiles, db: historical });
      expect(await historical.query('SELECT subject, value FROM mc.metric_records')).toEqual([
        { subject: 'pr#1', value: 3 },
      ]);
      const before = await snapshot(historical);
      const [file] = migrationFiles.filter((f) => f.name.startsWith(name));
      await historical.query(file?.sql ?? '');
      expect(await snapshot(historical)).toEqual(before);
    } finally {
      await historical.close();
    }
  });
});
