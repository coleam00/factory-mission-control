import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRealtime, rawSql, type SealedLiveQuery } from '@neon/realtime/server';
import type { Hono } from 'hono';
import { isRewindBranch } from '../scripts/lib/guard';
import { createNeonApi, type NeonApi } from '../scripts/lib/neon';
import type { Env } from './check-env';
import { readFactoryNames } from './factories';
import { rewindRealtime, UnknownRewindBranch } from './rewind';

export const LIVE_QUERY_NAME = /^[a-z0-9-]+$/;

/** One branch's sealing: the Realtime WebSocket the browser subscribes on, and its sealer. */
export interface Sealer {
  url: string;
  seal(sql: string, params: readonly string[]): Promise<SealedLiveQuery<unknown>>;
}

export type RewindSealer = Sealer & { name: string };

/** What the server needs to seal live queries; absent when the environment cannot seal. */
export interface Live {
  /** The factories this server shows and seals for, from its factories file. */
  factories: string[];
  /** Every file in `db/queries/` by its name without `.sql`: the only SQL the server seals. */
  queries: Map<string, string>;
  /** MC_DATABASE_URL's branch: sealed for until a switch, and always for a `home` panel. */
  home: Sealer;
  /** The rewind branch `POST /api/rewind` switched sealing to, until switched back. */
  rewind?: RewindSealer;
  /** Finds a rewind-* branch's sealing; absent without NEON_API_KEY and NEON_PROJECT_ID. */
  openRewind?: (name: string) => Promise<RewindSealer>;
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
function realtimeUrlOf(host: string): string | undefined {
  const match = /^(ep-[a-z0-9-]+?)(?:-pooler)?\.(.+\.neon\.tech)$/.exec(host);
  return match ? `wss://${match[1]}.rt.${match[2]}/` : undefined;
}

export function realtimeUrlFor(databaseUrl: string): string {
  const url = realtimeUrlOf(new URL(databaseUrl).hostname);
  if (!url) throw new Error('MC_DATABASE_URL is not a Neon endpoint');
  return url;
}

export function realtimeUrlForHost(host: string): string {
  const url = realtimeUrlOf(host);
  if (!url) throw new Error(`${host} is not a Neon endpoint`);
  return url;
}

/** Seals with `secret` for database `db`; the secret stays in the closure. */
function sealerFor(url: string, secret: string, db: string): Sealer {
  const realtime = createRealtime({ secret, db });
  return { url, seal: (sql, params) => realtime.seal({ query: rawSql(sql, [...params]) }) };
}

/**
 * Opens a rewind branch's sealing through the Neon API. A branch copies its parent's databases,
 * so the rewind branch has the home branch's database `db`.
 */
export function rewindOpener(api: NeonApi, db: string): (name: string) => Promise<RewindSealer> {
  return async (name) => {
    const { host, secret } = await rewindRealtime(api, name);
    return { name, ...sealerFor(realtimeUrlForHost(host), secret, db) };
  };
}

/**
 * The factories file: `MC_FACTORIES_FILE` when set (a check's own list, as `test:live` writes),
 * else the repository's factories.json. Only its names are shown and sealed for: a row of
 * `mc.factories` the file does not name is never listed, so one entry means one factory.
 */
export function factoryNames(env: Env, repoRoot: string): string[] {
  return readFactoryNames(env, repoRoot);
}

export function liveFromEnv(env: Env, repoRoot: string): Live | undefined {
  const databaseUrl = env.MC_DATABASE_URL;
  const secret = env.NEON_REALTIME_SECRET;
  if (!databaseUrl || !secret) return undefined;
  const db = new URL(databaseUrl).pathname.slice(1);
  const apiKey = env.NEON_API_KEY;
  const projectId = env.NEON_PROJECT_ID;
  return {
    factories: factoryNames(env, repoRoot),
    queries: loadLiveQueries(join(repoRoot, 'db', 'queries')),
    home: sealerFor(realtimeUrlFor(databaseUrl), secret, db),
    openRewind:
      apiKey && projectId ? rewindOpener(createNeonApi({ apiKey, projectId }), db) : undefined,
  };
}

/** How many parameters `sql` takes: its highest `$n`. */
export function parameterCount(sql: string): number {
  return Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
}

/** What `GET /api/live` answers and the page's boot script carries: no secret, no connection string. */
export function liveConfig(live: Live) {
  return {
    /** The Realtime WebSocket every panel subscribes on, the rewind branch's while switched. */
    url: (live.rewind ?? live.home).url,
    /** The home branch's, for the panels that always read it. */
    home: live.home.url,
    factories: live.factories,
    rewind: live.rewind?.name ?? null,
  };
}

export type LiveConfig = ReturnType<typeof liveConfig>;

const NOT_CONFIGURED = { error: 'live queries are not configured' };

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null && key in body
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The browser names a query file, a factory, and `args` for a query's parameters after `$1`; it
 * never sends SQL. Sealing follows the rewind branch `POST /api/rewind` switched to, except for a
 * panel that asks for `branch: 'home'`.
 */
export function liveRoutes(app: Hono, live: Live | undefined): void {
  app.get('/api/live', (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    return c.json(liveConfig(live));
  });

  app.post('/api/live/:name', async (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    const sql = live.queries.get(c.req.param('name'));
    if (sql === undefined) return c.json({ error: 'unknown live query' }, 404);
    const body: unknown = await c.req.json().catch(() => undefined);
    const factory = field(body, 'factory');
    if (typeof factory !== 'string' || !live.factories.includes(factory)) {
      return c.json({ error: 'unknown factory' }, 400);
    }
    const args = field(body, 'args') ?? [];
    if (
      !Array.isArray(args) ||
      !args.every((arg) => typeof arg === 'string') ||
      args.length !== parameterCount(sql) - 1
    ) {
      return c.json({ error: 'wrong arguments for this query' }, 400);
    }
    const branch = field(body, 'branch');
    if (branch !== undefined && branch !== 'home') return c.json({ error: 'unknown branch' }, 400);
    const sealer = branch === 'home' ? live.home : (live.rewind ?? live.home);
    return c.json(await sealer.seal(sql, [factory, ...args]));
  });

  // `{ branch: "rewind-..." }` switches every page's sealing to that branch; `{ branch: null }` back.
  app.post('/api/rewind', async (c) => {
    if (!live) return c.json(NOT_CONFIGURED, 503);
    const branch = field(await c.req.json().catch(() => undefined), 'branch');
    if (branch === null) {
      live.rewind = undefined;
      return c.json({ rewind: null });
    }
    if (typeof branch !== 'string' || !isRewindBranch(branch)) {
      return c.json({ error: 'not a rewind-* branch' }, 400);
    }
    if (!live.openRewind) {
      return c.json(
        { error: 'switching needs NEON_API_KEY and NEON_PROJECT_ID on the server' },
        503,
      );
    }
    try {
      live.rewind = await live.openRewind(branch);
    } catch (error) {
      if (error instanceof UnknownRewindBranch) return c.json({ error: error.message }, 404);
      // The Neon API's answer stays in the server's log: the browser gets no upstream text.
      console.error(`opening ${branch} failed: ${error instanceof Error ? error.message : error}`);
      return c.json({ error: `could not open ${branch}` }, 502);
    }
    return c.json({ rewind: branch });
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
export function liveBootScript(config: LiveConfig): string {
  const boot = JSON.stringify({ ...config, protocol: REALTIME_PROTOCOL }).replace(/</g, '\\u003c');
  return (
    '<script>(function(c){try{var s=new WebSocket(c.url,c.protocol);c.socket=s;c.early=[];' +
    "s.addEventListener('message',function(e){if(c.early)c.early.push(e.data)})}catch(e){}" +
    `window.__MC_LIVE__=c})(${boot})</script>`
  );
}
