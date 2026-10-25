import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealtime, rawSql, type SealedLiveQuery } from '@neon/realtime/server';
import type { Hono } from 'hono';
import type { Env } from './check-env';

export const LIVE_QUERY_NAME = /^[a-z0-9-]+$/;

/** What the server needs to seal live queries; absent when the environment cannot seal. */
export interface Live {
  /** The Realtime WebSocket the browser subscribes on. */
  url: string;
  factories: string[];
  /** Every file in `db/queries/` by its name without `.sql`: the only SQL the server seals. */
  queries: Map<string, string>;
  seal(sql: string, factory: string): Promise<SealedLiveQuery<unknown>>;
}

export function loadLiveQueries(dir: string): Map<string, string> {
  const queries = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const name = file.slice(0, -'.sql'.length);
    if (!LIVE_QUERY_NAME.test(name)) throw new Error(`live query file name ${file} is not allowed`);
    queries.set(name, readFileSync(join(dir, file), 'utf-8').trim());
  }
  return queries;
}

/**
 * Neon serves Realtime for a branch on its endpoint's host with `.rt.` after the endpoint id;
 * the Neon API's `invocation_url` for the branch is the same host.
 */
export function realtimeUrlFor(databaseUrl: string): string {
  const host = new URL(databaseUrl).hostname;
  const match = /^(ep-[a-z0-9-]+?)(?:-pooler)?\.(.+\.neon\.tech)$/.exec(host);
  if (!match) throw new Error('MC_DATABASE_URL is not a Neon endpoint');
  return `wss://${match[1]}.rt.${match[2]}/`;
}

function factoryNames(repoRoot: string): string[] {
  const { factories } = JSON.parse(readFileSync(join(repoRoot, 'factories.json'), 'utf-8')) as {
    factories: { name: string }[];
  };
  return factories.map((f) => f.name);
}

export function liveFromEnv(env: Env, repoRoot: string): Live | undefined {
  const databaseUrl = env.MC_DATABASE_URL;
  const secret = env.NEON_REALTIME_SECRET;
  if (!databaseUrl || !secret) return undefined;
  const realtime = createRealtime({ secret, db: new URL(databaseUrl).pathname.slice(1) });
  return {
    url: realtimeUrlFor(databaseUrl),
    factories: factoryNames(repoRoot),
    queries: loadLiveQueries(join(repoRoot, 'db', 'queries')),
    seal: (sql, factory) => realtime.seal({ query: rawSql(sql, [factory]) }),
  };
}

const NOT_CONFIGURED = { error: 'live queries are not configured' };

/** The browser names a query file and a factory; it never sends SQL. */
export function liveRoutes(app: Hono, live: Live | undefined): void {
  app.get('/api/live', (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    return c.json({ url: live.url, factories: live.factories });
  });

  app.post('/api/live/:name', async (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    const sql = live.queries.get(c.req.param('name'));
    if (sql === undefined) return c.json({ error: 'unknown live query' }, 404);
    const body: unknown = await c.req.json().catch(() => undefined);
    const factory =
      typeof body === 'object' && body !== null && 'factory' in body ? body.factory : undefined;
    if (typeof factory !== 'string' || !live.factories.includes(factory)) {
      return c.json({ error: 'unknown factory' }, 400);
    }
    return c.json(await live.seal(sql, factory));
  });
}

/** The WebSocket subprotocol `@neon/realtime`'s client asks for (`neon.realtime.v1`). */
export const REALTIME_PROTOCOL = 'neon.realtime.v1';

/**
 * An inline script for `index.html`: it hands the browser what `GET /api/live` answers and opens
 * the Realtime WebSocket while the page is still parsing, buffering what Realtime sends until the
 * app's client takes the socket over (app/live/early-socket.ts). Opening the connection is most of
 * a panel's wait for its first rows; this way it runs while the app's bundle loads.
 */
export function liveBootScript(live: Pick<Live, 'url' | 'factories'>): string {
  const config = JSON.stringify({
    url: live.url,
    factories: live.factories,
    protocol: REALTIME_PROTOCOL,
  }).replace(/</g, '\\u003c');
  return (
    '<script>(function(c){try{var s=new WebSocket(c.url,c.protocol);c.socket=s;c.early=[];' +
    "s.addEventListener('message',function(e){if(c.early)c.early.push(e.data)})}catch(e){}" +
    `window.__MC_LIVE__=c})(${config})</script>`
  );
}
