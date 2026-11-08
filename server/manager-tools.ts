import { join } from 'node:path';
import { type Db, openDb } from '../scripts/lib/db';
import { loadLiveQueries, parameterCount } from './live';
import {
  adHocSelect,
  MANAGER_LIMITS,
  type ReadResult,
  RefusedQuery,
  readOnlyQuery,
} from './manager-sql';

/**
 * The Manager's tools, served to the Agent SDK's CLI as an MCP stdio server (`bun
 * server/manager-tools.ts`). The SDK's in-process tool API needs zod, a dependency this server
 * does not declare; newline-delimited JSON-RPC needs nothing. Both tools only read.
 */

/** The MCP server's key and the two tool names, as the SDK qualifies them: `mcp__<server>__<tool>`. */
export const TOOL_SERVER = 'mc';
export const LIVE_QUERY_TOOL = 'live_query';
export const SELECT_TOOL = 'select';
export const READ_TOOL_NAMES = [LIVE_QUERY_TOOL, SELECT_TOOL].map(
  (name) => `mcp__${TOOL_SERVER}__${name}`,
);

export interface ToolContext {
  db: Db;
  /** The request's factory: bound by the server, never chosen by the agent. */
  factory: string;
  /** The sealed named live queries, by name. */
  queries: Map<string, string>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const MAX_RESULT_CHARS = 60_000;

export function readTools(queries: Map<string, string>) {
  const listing = [...queries]
    .map(([name, sql]) => `${name} (${parameterCount(sql) - 1} extra arguments)`)
    .join(', ');
  return [
    {
      name: LIVE_QUERY_TOOL,
      description:
        "Run one of the dashboard's named queries for the current factory. Each takes the " +
        `listed number of extra string arguments after the factory. Names: ${listing}.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
    },
    {
      name: SELECT_TOOL,
      description:
        'Run one SELECT (or WITH ... SELECT) over the mc schema. Only mc may be read; at most ' +
        `${MANAGER_LIMITS.rowCap} rows come back and a statement over ` +
        `${MANAGER_LIMITS.timeoutMs / 1000}s is stopped.`,
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' } },
        required: ['sql'],
      },
    },
  ];
}

function text(value: string, isError?: boolean): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) };
}

function rowsText({ rows, truncated }: ReadResult): string {
  const json = JSON.stringify({ rows, truncated });
  return json.length > MAX_RESULT_CHARS
    ? `${json.slice(0, MAX_RESULT_CHARS)}\n[cut: the result is longer than ${MAX_RESULT_CHARS} characters; select fewer columns or rows]`
    : json;
}

function stringArgs(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

export async function callTool(
  { db, factory, queries }: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (name === SELECT_TOOL) {
      if (typeof input.sql !== 'string') return text('sql must be a string', true);
      return text(rowsText(await adHocSelect(db, input.sql, MANAGER_LIMITS)));
    }
    if (name === LIVE_QUERY_TOOL) {
      const sql = typeof input.name === 'string' ? queries.get(input.name) : undefined;
      if (sql === undefined) return text('unknown live query', true);
      const args = stringArgs(input.args);
      if (!args || args.length !== parameterCount(sql) - 1) {
        return text('wrong arguments for this query', true);
      }
      return text(rowsText(await readOnlyQuery(db, sql, [factory, ...args], MANAGER_LIMITS)));
    }
    return text(`unknown tool ${name}`, true);
  } catch (error) {
    // A database error is the model's to read and retry; none of it reaches the owner's page.
    const reason = error instanceof Error ? error.message : String(error);
    return text(error instanceof RefusedQuery ? reason : `the query failed: ${reason}`, true);
  }
}

type Message = { id?: unknown; method?: unknown; params?: Record<string, unknown> };

/** Answers one JSON-RPC request; undefined for a notification, which gets no answer. */
export async function handleMessage(context: ToolContext, msg: Message): Promise<unknown> {
  if (msg.id === undefined) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: msg.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: TOOL_SERVER, version: '1' },
    });
  }
  if (msg.method === 'tools/list') return reply({ tools: readTools(context.queries) });
  if (msg.method === 'tools/call') {
    const input = msg.params?.arguments;
    return reply(
      await callTool(
        context,
        String(msg.params?.name),
        typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {},
      ),
    );
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
}

export async function serveStdio(
  context: ToolContext,
  input: AsyncIterable<Uint8Array>,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of input) {
    buffered += decoder.decode(chunk, { stream: true });
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const answer = await handleMessage(context, JSON.parse(line));
      if (answer !== undefined) write(`${JSON.stringify(answer)}\n`);
    }
  }
}

if (import.meta.main) {
  const url = process.env.MC_DATABASE_URL;
  const factory = process.env.MC_MANAGER_FACTORY;
  if (!url || !factory) {
    console.error('MC_DATABASE_URL and MC_MANAGER_FACTORY are required');
    process.exit(1);
  }
  const queries = loadLiveQueries(join(import.meta.dir, '..', 'db', 'queries'));
  await serveStdio(
    { db: openDb(url), factory, queries },
    Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
    (line) => process.stdout.write(line),
  );
}
