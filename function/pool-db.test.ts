import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { ARCHON_TABLES, archonDb, snapshot } from '../db/test-db';
import factories from '../factories.json';
import type { Db } from '../scripts/lib/db';
import { pgliteDb } from '../scripts/lib/pglite';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createWebhookApp } from './app';
import { createGitHub } from './github';
import { poolDb } from './pool-db';

const repoRoot = resolve(import.meta.dir, '..');
const fixtures = join(repoRoot, 'fixtures', 'webhooks');
const files = readMigrationFiles(migrationsDir(repoRoot));

type Delivery = { file: string; event: string; signature: string };
const deliveries: Delivery[] = JSON.parse(readFileSync(join(fixtures, 'deliveries.json'), 'utf-8'));
const noGitHub = createGitHub(async (url) => {
  throw new Error(`no network in tests: ${url}`);
});

let lite: PGlite;
let server: PGLiteSocketServer;
let pool: pg.Pool;

beforeEach(async () => {
  lite = new PGlite();
  await pgliteDb(lite).query(ARCHON_TABLES);
  await runMigrations({ files, db: pgliteDb(lite) });
  // The default of one connection resets the pool's second.
  server = new PGLiteSocketServer({ db: lite, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await server.start();
  pool = new pg.Pool({
    connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
    max: 5,
  });
});

afterEach(async () => {
  await pool.end();
  await server.stop();
  await lite.close();
});

/** Every sample delivery but `push`, which reads DECISIONS.md from GitHub. */
async function deliverAll(db: Db): Promise<number[]> {
  const app = createWebhookApp({
    secret: 'test',
    db,
    factories: factories.factories,
    github: noGitHub,
  });
  const statuses: number[] = [];
  for (const delivery of deliveries.filter((d) => d.event !== 'push')) {
    const res = await app.request('/', {
      method: 'POST',
      body: readFileSync(join(fixtures, delivery.file)),
      headers: {
        'content-type': 'application/json',
        'x-github-event': delivery.event,
        'x-hub-signature-256': delivery.signature,
      },
    });
    statuses.push(res.status);
  }
  return statuses;
}

test("the Function's pool writes what the Bun path writes", async () => {
  const viaPool = poolDb(pool);
  const statuses = await deliverAll(viaPool);
  const reference = await archonDb();
  await runMigrations({ files, db: reference });
  await deliverAll(reference);
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((status) => status === 200)).toBe(true);
  expect(await snapshot(viaPool)).toEqual(await snapshot(reference));
  await reference.close();
});

test('a delivery that throws mid-transaction rejects with its own error and leaves no row', async () => {
  // One connection: the second transaction gets a client only if the first one's came back.
  const single = new pg.Pool({
    connectionString: `postgres://postgres@${server.getServerConn()}/postgres`,
    max: 1,
  });
  const db = poolDb(single);
  const failure = new Error('original insert failure');
  for (const name of ['rolled-back-1', 'rolled-back-2']) {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO mc.factories (name, repository, codebase, console) VALUES ($1, 'r', 'c', 'x')",
          [name],
        );
        throw failure;
      }),
    ).rejects.toBe(failure);
  }
  expect(await db.query("SELECT name FROM mc.factories WHERE name LIKE 'rolled-back-%'")).toEqual(
    [],
  );
  await db.close();
});

test('a ROLLBACK that fails keeps the original error and destroys the client', async () => {
  const failure = new Error('original insert failure');
  const dropped = new Error('connection terminated');
  const released: unknown[] = [];
  const client = {
    query: async (text: string) => {
      if (text === 'ROLLBACK') throw dropped;
      return { rows: [] };
    },
    release: (arg?: unknown) => released.push(arg),
  };
  const fakePool = { connect: async () => client } as unknown as pg.Pool;
  const write = poolDb(fakePool).transaction(async () => {
    throw failure;
  });
  await expect(write).rejects.toBe(failure);
  expect(released).toEqual([dropped]);
});
