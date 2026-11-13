import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { scorecardEdges } from '../app/lib/factory-scorecard';
import { retriedArgs } from '../app/lib/failure-view';
import { pinZone } from '../app/lib/pin-zone';
import { queries } from '../db/queries/test-seed';
import { snapshot } from '../db/test-db';
import { writeMetrics } from '../scripts/fixture/write';
import { FACTORY, type ManagerDb, startManagerDb } from './manager-fixture';
import { READ_TOOL_NAMES } from './manager-tools';

interface ToolsResult {
  tools: { name: string }[];
  content: { text: string }[];
  isError?: boolean;
}

pinZone('America/Chicago');

let fixture: ManagerDb;
beforeAll(async () => {
  fixture = await startManagerDb();
}, 60_000);
afterAll(() => fixture.stop());

/** Speaks MCP to the tool server as the SDK's CLI does: one JSON-RPC request per line. */
async function session(requests: object[]): Promise<{ id: number; result: ToolsResult }[]> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'manager-tools.ts')], {
    env: { PATH: process.env.PATH, MC_DATABASE_URL: fixture.url, MC_MANAGER_FACTORY: FACTORY },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await child.stdin.end();
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

const call = (id: number, name: string, args: object) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

test('the tool server offers exactly the two read tools and refuses a write', async () => {
  const before = await snapshot(fixture.direct);
  const answers = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, 'live_query', { name: 'attention-items' }),
    call(4, 'live_query', { name: 'no-such-query' }),
    call(5, 'live_query', { name: 'attention-items', args: ['extra'] }),
    call(6, 'select', { sql: 'DELETE FROM mc.laps' }),
    call(7, 'delete_everything', {}),
  ]);
  const byId = new Map(answers.map((a) => [a.id, a.result]));
  const offered = byId.get(2)?.tools.map((t: { name: string }) => `mcp__mc__${t.name}`);
  expect(offered).toEqual(READ_TOOL_NAMES);
  const rows = JSON.parse(byId.get(3)?.content[0]?.text ?? '{}').rows;
  expect(rows.map((r: { message: string }) => r.message)).toEqual(['Ship?', 'Ship how?']);
  for (const id of [4, 5, 6, 7]) expect(byId.get(id)?.isError).toBe(true);
  expect(await snapshot(fixture.direct)).toEqual(before);
}, 30_000);

test('live_query factory-scorecard answers the rows the Factory page reads, from the same query and date', async () => {
  const sql = queries.find(([name]) => name === 'factory-scorecard')?.[1] as string;
  const now = new Date('2026-11-11T12:00:00Z');
  await fixture.direct.query(`INSERT INTO public.remote_agent_codebases (name) VALUES ('o/r')`);
  await fixture.direct.transaction(async (tx) => void (await writeMetrics(tx, now, 'o/r')));
  try {
    const [, answer] = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      call(3, 'live_query', { name: 'factory-scorecard', args: scorecardEdges(now) }),
    ]);
    const asked = JSON.parse(answer?.result.content[0]?.text ?? '{}').rows;
    const direct = await fixture.direct.query(sql, [FACTORY, ...scorecardEdges(now)]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).toEqual(JSON.parse(JSON.stringify(direct)));
  } finally {
    await fixture.direct.query(
      `DELETE FROM mc.laps WHERE run_id IN (SELECT id FROM public.remote_agent_workflow_runs WHERE workflow_name = 'archon-metrics-prs')`,
    );
    await fixture.direct.query(
      `DELETE FROM public.remote_agent_workflow_runs WHERE workflow_name = 'archon-metrics-prs'`,
    );
    await fixture.direct.query(`DELETE FROM public.remote_agent_codebases WHERE name = 'o/r'`);
  }
}, 30_000);

test('live_query retried-runs answers today in the viewer’s zone, not a run from yesterday evening', async () => {
  const blip = "Couldn't connect to compute node";
  const lap = async (id: string, status: string, at: string) => {
    await fixture.direct.query(
      `INSERT INTO mc.laps (run_id, factory, workflow_name, status, started_at, completed_at)
       VALUES ($1, $2, 'ticks', $3, $4::timestamptz, $4::timestamptz)`,
      [id, FACTORY, status, at],
    );
    if (status === 'failed') {
      await fixture.direct.query(
        `INSERT INTO mc.lap_steps (run_id, step_id, status, completed_at, error)
         VALUES ($1, 'facts', 'failed', $2::timestamptz, $3)`,
        [id, at, blip],
      );
    }
  };
  const yesterday = '5eed0009-0000-4000-8000-000000000001';
  const today = '5eed0009-0000-4000-8000-000000000002';
  const retry = '5eed0009-0000-4000-8000-000000000003';
  // 20:00 on 11/11 and 08:00 on 11/12 in Chicago; the viewer's clock is 09:00 on 11/12.
  await lap(yesterday, 'failed', '2026-11-12T02:00:00Z');
  await lap(today, 'failed', '2026-11-12T14:00:00Z');
  await lap(retry, 'completed', '2026-11-12T14:30:00Z');
  try {
    const [, answer] = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      call(3, 'live_query', {
        name: 'retried-runs',
        args: retriedArgs(new Date('2026-11-12T15:00:00Z')),
      }),
    ]);
    const rows = JSON.parse(answer?.result.content[0]?.text ?? '{}').rows;
    expect(rows.map((r: { run_id: string }) => r.run_id)).toEqual([today]);
  } finally {
    await fixture.direct.query(`DELETE FROM mc.laps WHERE run_id::text LIKE '5eed0009-%'`);
  }
}, 30_000);
