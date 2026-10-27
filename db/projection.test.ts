import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { holdoutId } from '../parsers/metrics';
import { eventData, structuredOutputFor } from '../scripts/fixture/write';
import type { Db, Row } from '../scripts/lib/db';
import { runMigrations } from '../scripts/migrate';
import { archonDb, migrationFiles, snapshot } from './test-db';

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
    TRUNCATE mc.laps, mc.lap_steps, mc.lap_step_attempts, mc.app_check_lines, mc.projection_errors,
      mc.factories, mc.versions, mc.pins`);
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

/** How many values in every mc text and json column contain the marker. */
async function markerCount(): Promise<number> {
  const columns = await db.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'mc' AND data_type IN ('text', 'character varying', 'jsonb', 'json')`);
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
   WHERE oid IN ('mc.record_step_attempt(uuid,text,text,jsonb)'::regprocedure,
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
          await db.query('SELECT mc.record_step_attempt($1, $2, $3, $4)', [
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
      { source: 'mc_project_step_event', event_id: event?.id, sqlstate: '23514' },
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
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0010'), db: historical });
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
        `SELECT mc.record_step_attempt('00000000-0000-0000-0000-000000000000',
        'node_completed', 'review', '{}')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  } finally {
    await historical.close();
  }
});

test('the eligibility upgrade keeps live history and installs the same functions as a fresh database', async () => {
  const upgraded = await archonDb();
  try {
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0010'), db: upgraded });
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
    expect(await runMigrations({ files: migrationFiles, db: upgraded })).toEqual([
      '0010_step_attempt_eligibility.sql',
      '0011_pin_full_archon_sha.sql',
      '0012_arch_text_lf.sql',
    ]);
    expect(await snapshot(upgraded)).toEqual(before);
    expect(await projectionDefinitions(upgraded)).toEqual(await projectionDefinitions(db));
    expect(await runMigrations({ files: migrationFiles, db: upgraded })).toEqual([]);
    await upgraded.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       SELECT id, 'node_completed', 'check-app', '{"timing":{"startedAt":"invalid"}}'
       FROM public.remote_agent_workflow_runs WHERE workflow_name = 'archon-manager'`,
    );
    expect(await snapshot(upgraded)).toEqual(before);
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
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0011'), db: historical });
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

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual([
      '0011_pin_full_archon_sha.sql',
      '0012_arch_text_lf.sql',
    ]);
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
    await runMigrations({ files: migrationFiles.filter((f) => f.name < '0012'), db: historical });
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

    expect(await runMigrations({ files: migrationFiles, db: historical })).toEqual([
      '0012_arch_text_lf.sql',
    ]);
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
      output: { outcome: 'merge', pr: '#29', sha: REVIEWED.sha, delivers: 'all', dispositions: [] },
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
  await insertEvent('provider_event', 'review', { type: 'assistant', text: 'thinking' });
  expect(await dashboardCounts()).toEqual(before);

  const [trigger] = await db.query(`SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
    WHERE tgname = 'mc_project_step_event'`);
  const when = String(trigger?.def).match(/ WHEN \((.*)\) EXECUTE /)?.[1] ?? '';
  const types = [...when.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  expect(types.sort()).toEqual(['node_completed', 'node_failed', 'node_skipped', 'node_started']);
});

test('a structured_output that is a JSON string commits in Archon, is recorded and keeps its step', async () => {
  const completed = eventData('pick', 'node_completed', NOW);
  const data = { ...completed, structured_output: '{"route":"x"}' };
  const [event] = await insertEvent('node_completed', 'pick', data);

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
    { step_id: 'pick', status: 'completed', cost_usd: String(completed.cost_usd), output: null },
  ]);
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
    // It relabels versions in the transaction that writes a pin, never in Archon's, so it waits.
    { proname: 'label_versions', proconfig: null },
    ...[
      'project_app_check_lines',
      'project_run',
      'project_step_event',
      'project_version',
      'record_projection_error',
      'record_step_attempt',
    ].map((proname) => ({ proname, proconfig: ['lock_timeout=100ms'] })),
  ]);

  await stepEvent('check-app', 'node_completed');
  expect(await db.query('SHOW lock_timeout')).toEqual([{ lock_timeout: '0' }]);
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
    { ...report.lines[2], kind: '\tprobe\r\n', pre_existing: '\nbaseline/health.txt\t' },
  ];
  const data = eventData('check-app', 'node_completed', NOW);
  await insertEvent('node_completed', 'check-app', {
    ...data,
    structured_output: { ...report, lines, summary: `H-07 fails: ${MARKER}`, noticed: [MARKER] },
  });

  expect(
    await db.query(
      `SELECT position, kind, verdict, evidence_count, pre_existing, scenario_id
       FROM mc.app_check_lines ORDER BY position`,
    ),
  ).toEqual([
    {
      position: 1,
      kind: 'criterion',
      verdict: 'PASS',
      evidence_count: 1,
      pre_existing: '',
      scenario_id: null,
    },
    {
      position: 2,
      kind: 'holdout',
      verdict: 'FAIL',
      evidence_count: 2,
      pre_existing: '',
      scenario_id: 'H-07',
    },
    {
      position: 3,
      kind: 'holdout',
      verdict: 'PASS',
      evidence_count: 0,
      pre_existing: '',
      scenario_id: 'unidentified',
    },
    {
      position: 4,
      kind: 'probe',
      verdict: 'OK',
      evidence_count: 1,
      pre_existing: 'baseline/health.txt',
      scenario_id: null,
    },
  ]);
  expect(await db.query('SELECT output FROM mc.lap_steps')).toEqual([
    { output: { pr: '#29', head: report.head, merged_with: report.merged_with, overall: 'PASS' } },
  ]);

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
  const report = structuredOutputFor('check-app') as { lines: Record<string, unknown>[] };
  const holdout = report.lines[1];
  await insertEvent('node_completed', 'check-app', {
    ...eventData('check-app', 'node_completed', NOW),
    structured_output: { ...report, lines: texts.map((text) => ({ ...holdout, text })) },
  });
  const rows = await db.query('SELECT scenario_id FROM mc.app_check_lines ORDER BY position');
  expect(rows.map((row) => row.scenario_id)).toEqual(texts.map(holdoutId));
});

test('a check-app line that cannot be stored is recorded and the step row stays', async () => {
  const report = structuredOutputFor('check-app') as { lines: Record<string, unknown>[] };
  const [event] = await insertEvent('node_completed', 'check-app', {
    ...eventData('check-app', 'node_completed', NOW),
    structured_output: { ...report, lines: [{ ...report.lines[0], kind: 'remark' }] },
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
  const lap = async () => {
    await stepEvent('pick', 'node_started');
    await stepEvent('pick', 'node_completed');
    await stepEvent('check-app', 'node_completed');
  };
  await lap();
  const once = await dashboardCounts();
  await lap();
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
  const report = structuredOutputFor('check-app') as { lines: Record<string, unknown>[] };
  const holdout = { kind: 'holdout', verdict: 'FAIL', text: `H-07 ${MARKER}`, evidence: [] };
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
    { step_id: 'check-app', started_at: at(NOW), ...done, outcome: null, holdout_catches: 1 },
    { step_id: 'check-app', started_at: at(later), ...done, outcome: null, holdout_catches: 2 },
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
    { step_id: 'review', started_at: at(NOW), ...done, outcome: 'sent-back', holdout_catches: 0 },
    { step_id: 'review', started_at: at(later), ...done, outcome: 'approved', holdout_catches: 0 },
  ]);
  expect(
    await db.query('SELECT step_id, output FROM mc.lap_steps WHERE step_id = $1', ['review']),
  ).toEqual([{ step_id: 'review', output: expect.objectContaining({ outcome: 'approved' }) }]);
  expect(await projectionErrors()).toEqual([]);
  expect(await markerCount()).toBe(0);

  await review('approved', later);
  expect(await attempts()).toHaveLength(5);
  await db.query(`DELETE FROM mc.lap_steps WHERE step_id = 'review'`);
  expect((await attempts()).map((a) => a.step_id)).toEqual(['check-app', 'check-app', 'land']);
});

test('a replayed start never reopens a finished step, and a retry does', async () => {
  await stepEvent('pick', 'node_started');
  await stepEvent('pick', 'node_completed');
  await stepEvent('pick', 'node_started');
  expect(await db.query('SELECT status FROM mc.lap_steps')).toEqual([{ status: 'completed' }]);

  const retry = new Date(NOW.getTime() + 60_000).toISOString();
  await insertEvent('node_started', 'pick', { provider: 'claude', timing: { startedAt: retry } });
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
    { factory: 'mission-control', digest: DIGEST, first_run_at: NOW, pin_sha: 'before' },
  ]);
  expect(await projectionErrors()).toEqual([]);
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
    { factory: 'mission-control', digest: DIGEST, first_run_at: minutes(-30), pin_sha: 'earlier' },
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
