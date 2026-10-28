import { Hono } from 'hono';
import type { Db } from '../scripts/lib/db';
import { type Context, DECISIONS_PATH, PACK_PATH, prepare, type Write } from './ingest';
import { verify } from './signature';

export interface WebhookOptions extends Context {
  secret: string;
  db: Db;
}

// Bun SQL and a reset socket name a dropped connection by code; node-postgres only in its message.
// SQLSTATE 57P01 is the server ending the connection (an admin terminate, a compute shutting
// down): node-postgres puts it in `code`, Bun SQL in `errno`. Bun SQL reports a socket that closed
// while a reply was expected as ERR_POSTGRES_EXPECTED_REQUEST ("Failed to read data").
const CLOSED_CODES = new Set([
  'ERR_POSTGRES_CONNECTION_CLOSED',
  'ERR_POSTGRES_EXPECTED_REQUEST',
  'ECONNRESET',
  '57P01',
]);
const connectionClosed = (error: unknown): error is Error =>
  error instanceof Error &&
  (('code' in error && CLOSED_CODES.has(String(error.code))) ||
    ('errno' in error && String(error.errno) === '57P01') ||
    error.message.startsWith('Connection terminated'));

/**
 * Runs one delivery's write, and once more when the connection closed under it, after dropping
 * the pool's idle connections: the server may have ended them with it, and the retry would draw
 * one. Every write is an upsert or a delete by key, so a replay after a COMMIT whose outcome was
 * lost records nothing twice.
 */
async function writeDelivery(db: Db, write: Write, delivery: string): Promise<void> {
  let statements = 0;
  let wrote = false;
  const attempt = () =>
    db.transaction(async (tx) => {
      statements = 0;
      wrote = false;
      await write({
        query: (sql, params) => {
          statements += 1;
          return tx.query(sql, params);
        },
      });
      wrote = true;
    });
  try {
    await attempt();
  } catch (error) {
    if (!connectionClosed(error)) throw error;
    const where = wrote
      ? 'at COMMIT'
      : statements === 0
        ? 'before the first statement'
        : `at statement ${statements}`;
    console.warn(`${delivery}: connection closed ${where} (${error.message}); writing it again`);
    await db.dropIdleConnections?.();
    await attempt();
  }
}

/** One route: GitHub's POST of a delivery. A delivery whose signature fails writes nothing. */
export function createWebhookApp({ secret, db, ...context }: WebhookOptions): Hono {
  if (!secret) throw new Error('GITHUB_WEBHOOK_SECRET must be set');
  const app = new Hono();

  app.post('/', async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (!(await verify(secret, body, c.req.header('x-hub-signature-256')))) {
      return c.json({ error: 'signature does not match' }, 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.json(
        { error: 'the body is not JSON: register the webhook as application/json' },
        400,
      );
    }
    const event = c.req.header('x-github-event') ?? '';
    const delivery = `${event} ${c.req.header('x-github-delivery') ?? ''}`;
    const prepared = await prepare(event, payload, context);
    if (prepared) await writeDelivery(db, prepared.write, delivery);
    const response: Record<string, string | boolean> = { event, written: prepared !== null };
    const decisions = prepared?.decisionsUnread;
    if (decisions !== undefined) {
      console.warn(
        `${delivery}: ${DECISIONS_PATH} unread: ${decisions}; commits written, decisions kept`,
      );
      response.decisions = `unread: ${decisions}`;
    }
    const pins = prepared?.pinsUnread;
    if (pins !== undefined) {
      console.warn(
        `${delivery}: ${PACK_PATH} unread for pins: ${pins}; pins written without an Archon sha`,
      );
      response.pins = `unread: ${pins}`;
    }
    return c.json(response);
  });

  // Whatever fails inside one delivery answers that delivery with a 500, so GitHub shows the
  // failure and can redeliver; the process keeps serving the next one.
  app.onError((error, c) => {
    console.error(`${c.req.header('x-github-event') ?? ''} delivery failed:`, error);
    return c.json({ error: 'the delivery could not be recorded' }, 500);
  });

  return app;
}
