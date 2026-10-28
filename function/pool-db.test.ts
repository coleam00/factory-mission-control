import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { ARCHON_TABLES, archonDb, snapshot } from '../db/test-db';
import factories from '../factories.json';
import { type Db, openDb } from '../scripts/lib/db';
import { pgliteDb } from '../scripts/lib/pglite';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createWebhookApp } from './app';
import { createGitHub } from './github';
import { poolDb } from './pool-db';

const repoRoot = resolve(import.meta.dir, '..');
const fixtures = join(repoRoot, 'fixtures', 'webhooks');
const files = readMigrationFiles(migrationsDir(repoRoot));

type Delivery = { file: string; event: string; delivery: string; signature: string };
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

async function deliver(db: Db, delivery: Delivery): Promise<Response> {
  const app = createWebhookApp({
    secret: 'test',
    db,
    factories: factories.factories,
    github: noGitHub,
  });
  return app.request('/', {
    method: 'POST',
    body: readFileSync(join(fixtures, delivery.file)),
    headers: {
      'content-type': 'application/json',
      'x-github-event': delivery.event,
      'x-github-delivery': delivery.delivery,
      'x-hub-signature-256': delivery.signature,
    },
  });
}

/** Every sample delivery but `push`, which reads DECISIONS.md from GitHub. */
async function deliverAll(db: Db): Promise<number[]> {
  const statuses: number[] = [];
  for (const delivery of deliveries.filter((d) => d.event !== 'push')) {
    statuses.push((await deliver(db, delivery)).status);
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
    on: () => {},
    off: () => {},
    release: (arg?: unknown) => released.push(arg),
  };
  const fakePool = { connect: async () => client } as unknown as pg.Pool;
  const write = poolDb(fakePool).transaction(async () => {
    throw failure;
  });
  await expect(write).rejects.toBe(failure);
  expect(released).toEqual([dropped]);
});

/** The ErrorResponse a backend ended by `pg_terminate_backend` sends on the client's next message. */
const TERMINATED = (() => {
  const fields = Buffer.from(
    'SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0',
  );
  const head = Buffer.alloc(5);
  head.write('E');
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
})();

/**
 * A TCP relay to the socket server that can close a connection the way a dead one fails: on the
 * next message the client sends, or once the server has answered a COMMIT, before the client
 * hears it. `terminate` ends every open connection the way the server does before the client has
 * read it: the backend is gone, and the client's next message is answered with FATAL 57P01.
 * PGlite serves every connection from one session, so a cut or a terminate also drops the prepared
 * statements that Postgres would have dropped with the connection.
 */
async function relay(upstream: string) {
  const [host, port] = upstream.split(':');
  let cut: 'next message' | 'COMMIT answer' | undefined;
  const terminators = new Set<() => void>();
  const server = net.createServer((client) => {
    const backend = net.connect(Number(port), host);
    let committing = false;
    let terminated = false;
    const terminate = () => {
      terminated = true;
      backend.destroy();
    };
    terminators.add(terminate);
    const close = () => {
      terminators.delete(terminate);
      client.destroy();
      backend.destroy();
    };
    const cutHere = () => {
      committing = false;
      lite.exec('DEALLOCATE ALL').finally(close);
    };
    for (const socket of [client, backend]) {
      socket.on('error', () => {});
    }
    client.on('close', close);
    backend.on('close', () => {
      if (!terminated) close();
    });
    client.on('data', (chunk) => {
      if (terminated) {
        client.end(TERMINATED);
        return;
      }
      if (cut === 'next message') {
        cut = undefined;
        return cutHere();
      }
      if (cut === 'COMMIT answer' && chunk.includes('COMMIT')) {
        cut = undefined;
        committing = true;
      }
      backend.write(chunk);
    });
    backend.on('data', (chunk) => {
      if (committing) cutHere();
      else client.write(chunk);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port: relayPort } = server.address() as net.AddressInfo;
  return {
    url: `postgres://postgres@127.0.0.1:${relayPort}/postgres`,
    cutOn: (at: typeof cut) => {
      cut = at;
    },
    terminate: async () => {
      for (const terminate of terminators) terminate();
      await lite.exec('DEALLOCATE ALL');
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test.each([
  ['Bun SQL', 'next message', 'before the first statement'],
  ['Bun SQL', 'COMMIT answer', 'at COMMIT'],
  ['pg.Pool', 'next message', 'before the first statement'],
  ['pg.Pool', 'COMMIT answer', 'at COMMIT'],
] as const)(
  'a %s connection closed on the %s records the delivery once, on a second try',
  async (adapter, cut, where) => {
    const link = await relay(server.getServerConn());
    const db =
      adapter === 'Bun SQL'
        ? openDb(link.url)
        : poolDb(new pg.Pool({ connectionString: link.url, max: 5 }));
    const issue = deliveries[0];
    const reference = await archonDb();
    await runMigrations({ files, db: reference });
    expect((await deliver(reference, issue)).status).toBe(200);

    await db.query('SELECT 1');
    link.cutOn(cut);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await deliver(db, issue)).status).toBe(200);
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringContaining(`issues ${issue.delivery}: connection closed ${where}`),
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(await snapshot(pgliteDb(lite))).toEqual(await snapshot(reference));
    await Promise.all([db.close(), reference.close()]);
    await link.close();
  },
);

test.each(['Bun SQL', 'pg.Pool'] as const)(
  'a %s pool whose idle connections the server ended records the delivery on its one retry',
  async (adapter) => {
    const link = await relay(server.getServerConn());
    const db =
      adapter === 'Bun SQL'
        ? openDb(link.url)
        : poolDb(new pg.Pool({ connectionString: link.url, max: 5 }));
    const issue = deliveries[0];
    const reference = await archonDb();
    await runMigrations({ files, db: reference });
    expect((await deliver(reference, issue)).status).toBe(200);

    // Several connections at once, so the pool holds more than one idle when the server ends them.
    await Promise.all(
      Array.from({ length: 4 }, () =>
        db.transaction(async (tx) => {
          await tx.query('SELECT 1');
          await Bun.sleep(20);
        }),
      ),
    );
    await link.terminate();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await deliver(db, issue)).status).toBe(200);
      expect(warn.mock.calls.map((args) => args.join(' '))).toEqual([
        expect.stringContaining(
          `issues ${issue.delivery}: connection closed before the first statement`,
        ),
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(await snapshot(pgliteDb(lite))).toEqual(await snapshot(reference));
    await Promise.all([db.close(), reference.close()]);
    await link.close();
  },
);
