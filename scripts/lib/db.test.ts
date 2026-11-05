import { afterEach, beforeEach, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { type Db, openDb } from './db';

let lite: PGlite;
let server: PGLiteSocketServer;
let db: Db;

beforeEach(async () => {
  lite = new PGlite();
  server = new PGLiteSocketServer({ db: lite, port: 0, host: '127.0.0.1' });
  await server.start();
  db = openDb(`postgres://postgres@${server.getServerConn()}/postgres`);
});

afterEach(async () => {
  await db.close();
  await server.stop();
  await lite.close();
});

test.each([
  ['an array of objects', [{ a: 1 }, { a: 2 }], 'array'],
  ['an empty array', [], 'array'],
  ['an object', { workflow_source: { digest: 'x' } }, 'object'],
  ['a JSON.stringify of an object', JSON.stringify({ a: 1 }), 'string'],
])('Bun binds %s to ::jsonb as a jsonb %s', async (_name, value, type) => {
  const [row] = await db.query('SELECT jsonb_typeof($1::jsonb) AS t', [value]);
  expect(row?.t).toBe(type);
});
