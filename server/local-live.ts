import pg from 'pg';
import type { Env } from './check-env';

/**
 * Local mode: a plain self-hosted Postgres instead of Neon. There is no Realtime: a "seal" is a
 * plain object naming the query and its parameters (no secret), and the browser polls
 * `POST /api/live-rows` with it; the server runs the named `db/queries/*.sql` itself.
 */
export type LiveMode = 'neon' | 'local';

export function isLocalMode(env: Env): boolean {
  return env.MC_LIVE_MODE === 'local';
}

export const LOCAL_UNAVAILABLE = 'unavailable in local mode (no Neon API)';

/** A seal far in the future: local seals never expire, so the panel never renews. */
const LOCAL_SEAL_LIFE_MS = 365 * 24 * 60 * 60 * 1000;

interface LocalSeal {
  capability: string;
  queryFingerprint: string;
  expiresAt: number;
  local: { query: string; params: string[] };
}

export function localSeal(name: string, params: readonly string[], now = Date.now()): LocalSeal {
  return {
    capability: `local:${name}:${JSON.stringify(params)}`,
    queryFingerprint: `local:${name}`,
    expiresAt: now + LOCAL_SEAL_LIFE_MS,
    local: { query: name, params: [...params] },
  };
}

/** What `POST /api/live-rows` answers. `dates` are the columns the browser turns into `Date`s. */
interface LocalRows {
  rows: Record<string, unknown>[];
  /** Columns of type timestamp/timestamptz, sent as ISO strings. */
  timestamps: string[];
  /** Columns of type date, sent as `YYYY-MM-DD`. */
  dates: string[];
}

export type RunQuery = (sql: string, params: readonly string[]) => Promise<LocalRows>;

const DATE_OID = 1082;
const TIMESTAMP_OIDS = new Set([1114, 1184]);
const LOCAL_STATEMENT_TIMEOUT_MS = 5_000;

/** Runs each query in its own read-only transaction with a statement timeout. */
export function poolRunner(pool: pg.Pool): RunQuery {
  const types = {
    getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
      oid === DATE_OID
        ? (value: string) => value
        : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
  };
  // An idle client's dropped connection would otherwise be an unhandled 'error' event.
  pool.on('error', (error) => console.error(`local pool: ${error.message}`));
  return async (sql, params) => {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${LOCAL_STATEMENT_TIMEOUT_MS}`);
      const result = await client.query({ text: sql, values: [...params], types });
      await client.query('COMMIT');
      return {
        rows: result.rows,
        timestamps: result.fields
          .filter((f) => TIMESTAMP_OIDS.has(f.dataTypeID))
          .map((f) => f.name),
        dates: result.fields.filter((f) => f.dataTypeID === DATE_OID).map((f) => f.name),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch((rollback: Error) => {
        broken = rollback;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  };
}
