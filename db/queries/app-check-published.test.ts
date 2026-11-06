import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Db } from '../../scripts/lib/db';
import { onTheSeed, queries } from './test-seed';

const sql = (name: string) => queries.find(([n]) => n === name)?.[1] as string;
const FACTORY = 'queue-factory';
const PR = 9001;
const ISSUE = 9002;
const QUEUE_CODEBASE = '5eed0000-0000-4000-8000-000000000002';
let db: Db;
beforeAll(async () => {
  db = await onTheSeed();
  const stamp = '2030-01-01T00:00:00Z';
  await db.query(
    `INSERT INTO mc.pull_requests (factory, number, title, state, head_sha, url, created_at, updated_at)
     VALUES ($1, $2, 'Queue PR', 'open', 'abc1234', 'https://github.com/o/q/pull/9001', $3, $3)`,
    [FACTORY, PR, stamp],
  );
  await db.query(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
     VALUES ($1, $2, 'Queue item', 'open', 'https://github.com/o/q/issues/9002', $3, $3)`,
    [FACTORY, ISSUE, stamp],
  );
  await db.query(
    'INSERT INTO mc.pull_request_issues (factory, pr_number, issue_number) VALUES ($1, $2, $3)',
    [FACTORY, PR, ISSUE],
  );
}, 60_000);
afterAll(() => db.close());

let day = 0;
/** A factory-app-check run whose evidence said `overall` and whose publish posted `state`. */
async function drive(overall: 'PASS' | 'FAIL', state: 'success' | 'failure') {
  day++;
  const at = (m: number) => `2030-01-${String(day + 1).padStart(2, '0')}T00:0${m}:00Z`;
  const lines = ['C1  PASS  Fine.  evidence: a.png'];
  const [run] = await db.query(
    `INSERT INTO public.remote_agent_workflow_runs (workflow_name, codebase_id, status, user_message, started_at)
     VALUES ('factory-app-check', $1, 'running', 'queue', $2) RETURNING id`,
    [QUEUE_CODEBASE, at(0)],
  );
  const steps: [string, unknown][] = [
    ['select', { found: true, pr: PR, head: 'abc1234' }],
    ['check', { overall, lines }],
    ['evidence', { overall, report: 'r', lines }],
    ['publish', { state, comment: 'created' }],
  ];
  for (const [i, [step, structured_output]] of steps.entries()) {
    await db.query(
      `INSERT INTO public.remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
       VALUES ($1, 'node_completed', $2, $3)`,
      [
        run?.id,
        step,
        JSON.stringify({ structured_output, duration_ms: 5, timing: { startedAt: at(i + 1) } }),
      ],
    );
  }
}

/** What the home map, the Board and the App check panel show for the pull request. */
async function shown() {
  const home = await db.query(sql('home-map'), [FACTORY, '']);
  const board = await db.query(sql('board'), [FACTORY]);
  const panel = await db.query(sql('app-check'), [FACTORY]);
  return {
    failingChip: home.some((r) => r.kind === 'failing' && r.number === PR),
    board: board.find((r) => r.number === ISSUE)?.app_check,
    panel: panel.find((r) => r.number === PR)?.overall,
  };
}

test('a PASS that publish found stale shows FAIL on the home map, the Board and the panel; a fresh PASS shows PASS; a FAIL stays FAIL', async () => {
  const errorsBefore = await db.query('SELECT count(*)::int AS n FROM mc.projection_errors');

  await drive('PASS', 'failure');
  expect(await shown()).toEqual({ failingChip: true, board: 'FAIL', panel: 'FAIL' });

  await drive('PASS', 'success');
  expect(await shown()).toEqual({ failingChip: false, board: 'PASS', panel: 'PASS' });

  await drive('FAIL', 'failure');
  expect(await shown()).toEqual({ failingChip: true, board: 'FAIL', panel: 'FAIL' });

  expect(await db.query('SELECT count(*)::int AS n FROM mc.projection_errors')).toEqual(
    errorsBefore,
  );
});
