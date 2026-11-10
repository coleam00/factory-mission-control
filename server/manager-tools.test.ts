import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { snapshot } from '../db/test-db';
import { FACTORY, type ManagerDb, startManagerDb } from './manager-fixture';
import { READ_TOOL_NAMES } from './manager-tools';

interface ToolsResult {
  tools: { name: string }[];
  content: { text: string }[];
  isError?: boolean;
}

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
