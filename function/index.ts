// The webhook Function as Neon runs it (`bun run function:deploy`, runtime nodejs24): Node only,
// no Bun API at run time. `function:dev` is the local entry.
import { attachDatabasePool } from '@neon/functions';
import pg from 'pg';
import factories from '../factories.json';
import { createWebhookApp } from './app';
import { FUNCTION_ENV } from './env';
import { createGitHub } from './github';
import { poolDb } from './pool-db';

const connectionString = process.env[FUNCTION_ENV.databaseUrl];
if (!connectionString) throw new Error(`${FUNCTION_ENV.databaseUrl} must be set`);

const pool = new pg.Pool({ connectionString, max: 5 });
attachDatabasePool(pool);

export default createWebhookApp({
  secret: process.env[FUNCTION_ENV.webhookSecret] ?? '',
  db: poolDb(pool),
  factories: factories.factories,
  github: createGitHub(fetch, process.env[FUNCTION_ENV.githubToken] || undefined),
});
