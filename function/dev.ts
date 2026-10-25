// `bun run function:dev -- --port <port>`: the webhook Function on this machine, writing to the
// check branch in `.mc-check.env` and refusing any other (PRD 6.8).
import { parseArgs } from 'node:util';
import factories from '../factories.json';
import { defaultDeps, guardedDatabaseUrl } from '../scripts/lib/cli';
import { openDb } from '../scripts/lib/db';
import { SERVE_PORTS } from '../server/ports';
import { createWebhookApp } from './app';
import { createGitHub } from './github';

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: 'string' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < SERVE_PORTS.min || port > SERVE_PORTS.max) {
  console.error(`usage: bun run function:dev -- --port <${SERVE_PORTS.min}-${SERVE_PORTS.max}>`);
  process.exit(2);
}

const deps = defaultDeps();
let app: ReturnType<typeof createWebhookApp>;
try {
  app = createWebhookApp({
    secret: deps.env.GITHUB_WEBHOOK_SECRET ?? '',
    db: openDb(await guardedDatabaseUrl(deps, 'check')),
    factories: factories.factories,
    github: createGitHub(),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
console.log(`receiving webhooks at http://localhost:${server.port}/`);
