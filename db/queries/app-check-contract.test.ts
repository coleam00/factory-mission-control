// The App check's projection contract (migration 0024) is restated by its readers: home-map.sql,
// board.sql and app-check.sql each spell out which (workflow, step) carries the verdict. These tests
// bind the copies to 0024's accepted pairs, check the map card that lists the panel covers only those, and
// bind the pinned pack to the writer.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allCards, FACTORY_MAP } from '../../app/map/factory-map';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, paramsFor, queries } from './test-seed';

const root = join(import.meta.dir, '..', '..');
const sqlOf = (name: string) => queries.find(([n]) => n === name)?.[1] as string;

// The seed's open mission-control pull request and the issue it links to.
const PR = 112;
const ISSUE = 12;
const CODEBASE = '5eed0000-0000-4000-8000-000000000000';
// Newer than any seeded step, so the readers' ORDER BY started_at DESC picks this test's row.
const LATER = '2040-01-01T00:00:00Z';
// The step whose output the writer `mc.app_check_step_output` keeps as the verdict: 0024 reads
// `check`. Migration 0025 (#445) reads `evidence`; whichever lands second flips this.
const VERDICT_STEP = 'check';

let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
}, 60_000);
afterAll(() => db.close());

async function seen() {
  const home = await db.query(sqlOf('home-map'), paramsFor('home-map', 'mission-control'));
  const board = await db.query(sqlOf('board'), ['mission-control']);
  const panel = await db.query(sqlOf('app-check'), ['mission-control']);
  return {
    failing: home.some((r) => r.kind === 'failing' && Number(r.number) === PR),
    board: board.find((r) => Number(r.number) === ISSUE)?.app_check ?? null,
    panel: panel.find((r) => Number(r.number) === PR) ?? null,
  };
}

type Schema = {
  type?: unknown;
  enum?: string[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
};
const pinned = Bun.YAML.parse(
  readFileSync(join(root, 'fixtures/pack/queue/factory/app-check/factory-app-check.yaml'), 'utf8'),
) as { nodes: { id: string; output_format?: Schema }[] };
const format = (id: string) => pinned.nodes.find((n) => n.id === id)?.output_format;

test('the seed holds no verdict for the pull request the contract tests use', async () => {
  const s = await seen();
  expect(s.failing).toBe(false);
  expect(s.board).toBeNull();
  expect(s.panel?.overall ?? null).toBeNull();
});

test('the readers count the (workflow, step) pairs 0024 keeps as the App check', async () => {
  // 0024 keeps `check-app` from any workflow (no workflow guard) and `check` only from
  // factory-app-check. The card's covers must be inside that set.
  const accepted = (workflow: string, step: string) =>
    step === 'check-app' || (workflow === 'factory-app-check' && step === 'check');
  const owners = allCards(FACTORY_MAP).filter((card) => card.lists?.includes('checks'));
  expect(owners).toHaveLength(1);
  const covers = (owners[0]?.covers ?? []).flatMap((c) =>
    c.steps.map((step) => [c.workflow, step] as const),
  );
  for (const [workflow, step] of covers) expect(accepted(workflow, step)).toBe(true);

  const workflows = ['archon-loop', 'archon-build-queue', 'factory-app-check'];
  const steps = ['check-app', 'check', 'select', 'evidence'];
  const probes = workflows.flatMap((w) => steps.map((s) => [w, s] as const));
  const covered = probes.filter(([w, s]) => accepted(w, s));

  const counted: Record<'failing' | 'board' | 'panel', string[]> = {
    failing: [],
    board: [],
    panel: [],
  };
  for (const [i, [workflow, step]] of probes.entries()) {
    const run = `00000000-0000-4000-8000-0000000009${String(i).padStart(2, '0')}`;
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at)
         VALUES ($1, 'mission-control', $2, 'completed', $3)`,
        [run, workflow, LATER],
      );
      await db.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, started_at, output)
         VALUES ($1, $2, 'completed', $3, $4)`,
        [run, step, LATER, JSON.stringify({ pr: PR, overall: 'FAIL' })],
      );
      const s = await seen();
      const key = `${workflow}/${step}`;
      if (s.failing) counted.failing.push(key);
      if (s.board === 'FAIL') counted.board.push(key);
      if (s.panel?.run_id === run) counted.panel.push(key);
    } finally {
      await db.query('ROLLBACK');
    }
  }
  const expected = covered.map(([workflow, step]) => `${workflow}/${step}`);
  expect(counted).toEqual({ failing: expected, board: expected, panel: expected });
});

test('the pinned app check declares exactly the shapes the writer keeps', () => {
  const writer = 'mc.app_check_step_output (0024) keeps';
  const verdict = format(VERDICT_STEP);
  expect(format('select')?.properties?.pr, `${writer} pr as bare digits`).toEqual({
    type: ['integer', 'null'],
  });
  expect(verdict?.properties?.overall, `${writer} overall only as PASS or FAIL`).toEqual({
    type: 'string',
    enum: ['PASS', 'FAIL'],
  });
  expect(verdict?.properties?.lines, `${writer} lines only as an array`).toEqual({
    type: 'array',
    items: { type: 'string' },
  });
  expect(verdict?.required).toEqual(expect.arrayContaining(['overall', 'lines']));
  expect(format('select')?.required).toContain('pr');
});

const OVERALLS = format(VERDICT_STEP)?.properties?.overall?.enum ?? [];

test.each(OVERALLS)(
  'a factory-app-check run with %s reaches the home map, the Board and the App check panel through the trigger',
  async (value) => {
    const other = OVERALLS.find((o) => o !== value);
    const overall = (step: string) => (step === VERDICT_STEP ? value : other);
    const lines = [
      'C1  PASS  A criterion.  evidence: a.png',
      'P1  FAIL  A probe.  evidence: b.png',
      'A1  PASS  An assertion.  evidence: c.png',
    ];
    const outputs: [string, unknown][] = [
      ['select', { found: true, pr: PR, head: 'abc1234' }],
      [
        'check',
        {
          overall: overall('check'),
          lines,
          summary: 'summary',
        },
      ],
      [
        'evidence',
        {
          overall: overall('evidence'),
          lines,
          report: 'report',
        },
      ],
    ];
    await db.query('BEGIN');
    try {
      const [run] = await db.query(
        `INSERT INTO public.remote_agent_workflow_runs
           (workflow_name, codebase_id, status, user_message, started_at)
         VALUES ('factory-app-check', $1, 'completed', 'queue', $2) RETURNING id`,
        [CODEBASE, LATER],
      );
      for (const [step, structured_output] of outputs) {
        await db.query(
          `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
           VALUES ($1, 'node_completed', $2, $3)`,
          [
            run?.id,
            step,
            JSON.stringify({ structured_output, timing: { startedAt: LATER }, duration_ms: 5 }),
          ],
        );
      }
      const [lap] = await db.query('SELECT factory FROM mc.laps WHERE run_id = $1', [run?.id]);
      const errors = await db.query('SELECT 1 FROM mc.projection_errors WHERE run_id = $1', [
        run?.id,
      ]);
      const s = await seen();
      expect(lap?.factory).toBe('mission-control');
      expect(errors).toEqual([]);
      expect(s.failing).toBe(value === 'FAIL');
      expect(s.board).toBe(value);
      expect(s.panel).toMatchObject({ run_id: run?.id, overall: value });
      expect([s.panel?.criteria, s.panel?.probes, s.panel?.assertions].map(Number)).toEqual([
        1, 1, 1,
      ]);
    } finally {
      await db.query('ROLLBACK');
    }
  },
);
