import { Hono } from 'hono';
import type { Db } from '../scripts/lib/db';
import { type Context, prepare } from './ingest';
import { verify } from './signature';

export interface WebhookOptions extends Context {
  secret: string;
  db: Db;
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
    const write = await prepare(event, payload, context);
    if (write) await db.transaction(write);
    return c.json({ event, written: write !== null });
  });

  return app;
}
