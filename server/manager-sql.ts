import type { Db, Row } from '../scripts/lib/db';

export interface ReadLimits {
  timeoutMs: number;
  rowCap: number;
}

export const MANAGER_LIMITS: ReadLimits = { timeoutMs: 5000, rowCap: 200 };

/** A query the Manager may not run; the message says why, in words the model can act on. */
export class RefusedQuery extends Error {}

export interface ReadResult {
  rows: Row[];
  /** More rows matched than the cap: only the first `rowCap` are here. */
  truncated: boolean;
}

/**
 * Runs `sql` in a read-only transaction under a statement timeout, wrapped as a subquery with the
 * row cap bound as its last parameter. A bound parameter puts the statement on the extended
 * protocol, where Postgres refuses a second command; Bun's client runs several when it has none.
 */
export async function readOnlyQuery(
  db: Db,
  sql: string,
  params: unknown[],
  limits: ReadLimits,
  guard?: (tx: Db['query'], wrapped: string, bound: unknown[]) => Promise<void>,
): Promise<ReadResult> {
  const wrapped = `SELECT * FROM (\n${sql}\n) AS manager_q LIMIT $${params.length + 1}`;
  const bound = [...params, limits.rowCap + 1];
  let rows: Row[] = [];
  await db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    await tx.query(`SET LOCAL statement_timeout = '${Math.trunc(limits.timeoutMs)}ms'`);
    await guard?.(tx.query, wrapped, bound);
    rows = await tx.query(wrapped, bound);
  });
  return { rows: rows.slice(0, limits.rowCap), truncated: rows.length > limits.rowCap };
}

/** Functions that run SQL text, read files or act outside the transaction. */
const DENIED_FUNCTIONS =
  /\b(\w*_to_xml\w*|ts_rewrite|pg_stat_get_\w+|dblink\w*|pg_read_\w+|pg_ls_\w+|pg_stat_file|lo_\w+|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config|pg_advisory\w*|pg_notify|pg_sleep\w*)\s*\(/i;

/** Schemas of the relations and set-returning functions a plan reads; a function node has its own. */
function schemasRead(plan: unknown, out = new Set<string>()): Set<string> {
  if (typeof plan === 'object' && plan !== null) {
    if ('Relation Name' in plan) out.add(String((plan as { Schema?: unknown }).Schema));
    if ('Function Name' in plan) out.add(String((plan as { Schema?: unknown }).Schema));
    for (const value of Object.values(plan)) schemasRead(value, out);
  }
  return out;
}

/** Postgres's own plan for the query: every relation it scans must be in `mc`. */
async function mcOnly(query: Db['query'], wrapped: string, bound: unknown[]): Promise<void> {
  const [row] = await query(`EXPLAIN (VERBOSE, FORMAT JSON) ${wrapped}`, bound);
  const raw = row?.['QUERY PLAN'];
  const plan: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const outside = [...schemasRead(plan)].filter((schema) => schema !== 'mc');
  if (outside.length > 0) {
    throw new RefusedQuery(`only the mc schema may be read, not ${outside.join(', ')}`);
  }
  const denied = DENIED_FUNCTIONS.exec(JSON.stringify(plan));
  if (denied) throw new RefusedQuery(`the function ${denied[1]} is not allowed`);
}

/** After leading whitespace and comments, the first word of `text`, lower-cased. */
function firstWord(text: string): string {
  let rest = text;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      rest = end < 0 ? '' : rest.slice(end + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end < 0 ? '' : rest.slice(end + 2);
    } else break;
  }
  return /^[a-z]+/i.exec(rest)?.[0].toLowerCase() ?? '';
}

/** The agent's own SELECT: one statement, reading `mc` only, read-only, timed and capped. */
export async function adHocSelect(db: Db, text: string, limits: ReadLimits): Promise<ReadResult> {
  const sql = text.trimEnd().replace(/;$/, '').trimEnd();
  if (!['select', 'with'].includes(firstWord(sql))) {
    throw new RefusedQuery('only one SELECT is allowed');
  }
  return readOnlyQuery(db, sql, [], limits, mcOnly);
}
