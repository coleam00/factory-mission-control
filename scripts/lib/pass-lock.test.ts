import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { type Db, openDb, type Row } from './db';
import { advisoryPassLock } from './pass-lock';

/**
 * A server that grants each (namespace, job) key to one open transaction at a time and frees it when
 * that transaction ends, as `pg_try_advisory_xact_lock` does. `failWith` makes every transaction
 * fail after its statements ran, as a dropped connection does.
 */
function fakeServer() {
  const held = new Set<string>();
  const statements: string[] = [];
  const state = { opened: 0, closed: 0, failWith: undefined as Error | undefined };
  const open = (): Db => {
    state.opened++;
    return {
      query: async () => [],
      async transaction(fn) {
        const mine: string[] = [];
        try {
          await fn({
            async query(sql: string, params?: unknown[]): Promise<Row[]> {
              statements.push(sql);
              if (!sql.includes('pg_try_advisory_xact_lock')) return [];
              const key = String(params?.[1]);
              if (held.has(key)) return [{ taken: false }];
              held.add(key);
              mine.push(key);
              return [{ taken: true }];
            },
          });
          if (state.failWith) throw state.failWith;
        } finally {
          for (const key of mine) held.delete(key);
        }
      },
      async close() {
        state.closed++;
      },
    };
  };
  return { open, held, statements, state };
}

test('a taken lock refuses a second take until it is released, then lets a later take succeed', async () => {
  const server = fakeServer();
  const take = advisoryPassLock(server.open);

  const first = await take('postgres://x/db', 'reconcile:laps');
  expect(first).toBeDefined();
  expect(server.held.size).toBe(1);

  expect(await take('postgres://x/db', 'reconcile:laps')).toBeUndefined();
  // A different job on the same database is not blocked.
  const other = await take('postgres://x/db', 'reconcile:main');
  expect(other).toBeDefined();
  await other?.release();

  await first?.release();
  expect(server.held.size).toBe(0);
  const again = await take('postgres://x/db', 'reconcile:laps');
  expect(again).toBeDefined();
  await again?.release();
});

test('the lock transaction disables the idle timeout before it takes the lock', async () => {
  const server = fakeServer();
  const lock = await advisoryPassLock(server.open)('postgres://x/db', 'reconcile:laps');
  await lock?.release();
  expect(server.statements[0]).toBe('SET LOCAL idle_in_transaction_session_timeout = 0');
  expect(server.statements[1]).toContain('pg_try_advisory_xact_lock');
});

test('a refused take ends its transaction and closes its connection', async () => {
  const server = fakeServer();
  const take = advisoryPassLock(server.open);
  const first = await take('postgres://x/db', 'reconcile:laps');
  const refusedBefore = server.state.closed;
  expect(await take('postgres://x/db', 'reconcile:laps')).toBeUndefined();
  expect(server.state.closed).toBe(refusedBefore + 1);
  // The refused attempt left the first holder's lock alone.
  expect(server.held.size).toBe(1);
  await first?.release();
});

test('release rejects naming the job when the lock connection failed during the pass', async () => {
  const server = fakeServer();
  server.state.failWith = new Error('connection terminated');
  const lock = await advisoryPassLock(server.open)('postgres://x/db', 'reconcile:laps');
  expect(lock).toBeDefined();
  await expect(lock?.release()).rejects.toThrow(
    "the reconcile:laps pass lock's connection failed during the pass: connection terminated",
  );
  expect(server.state.closed).toBe(1);
});

let lite: PGlite;
let socket: PGLiteSocketServer;

beforeEach(async () => {
  lite = new PGlite();
  socket = new PGLiteSocketServer({ db: lite, port: 0, host: '127.0.0.1' });
  await socket.start();
});

afterEach(async () => {
  await socket.stop();
  await lite.close();
});

test('on the real driver a take returns a lock and release resolves', async () => {
  const url = `postgres://postgres@${socket.getServerConn()}/postgres`;
  const lock = await advisoryPassLock(openDb)(url, 'reconcile:laps');
  expect(lock).toBeDefined();
  await lock?.release();
});
