// The webhook Function as Neon runs it (`bun run function:deploy`, runtime nodejs24): Node only,
// no Bun API at run time. `function:dev` is the local entry.
import { attachDatabasePool } from '@neon/functions';
import pg from 'pg';
import factories from '../factories.json';
import { createWebhookApp } from './app';
import { createGitHub } from './github';
import { poolDb } from './pool-db';

const connectionString = process.env.MC_DATABASE_URL;
if (!connectionString) throw new Error('MC_DATABASE_URL must be set');

const pool = new pg.Pool({ connectionString, max: 5 });
attachDatabasePool(pool);

export default createWebhookApp({
  secret: process.env.GITHUB_WEBHOOK_SECRET ?? '',
  db: poolDb(pool),
  factories: factories.factories,
  github: createGitHub(fetch, process.env.GITHUB_TOKEN || undefined),
});
