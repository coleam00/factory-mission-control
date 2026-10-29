import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../scripts/lib/db';
import { createNeonApi } from '../scripts/lib/neon';
import { createApp } from './app';
import { resolveBuildId } from './build-id';
import { loadCheckEnv } from './check-env';
import { syncFactoriesAtStart } from './factory-sync';
import { liveFromEnv } from './live';
import { SERVE_PORTS } from './ports';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
});

if (values.help) {
  console.log(`usage: bun run serve -- --port <${SERVE_PORTS.min}-${SERVE_PORTS.max}>`);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < SERVE_PORTS.min || port > SERVE_PORTS.max) {
  console.error(`usage: bun run serve -- --port <${SERVE_PORTS.min}-${SERVE_PORTS.max}>`);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, '..');
loadCheckEnv(repoRoot, Bun.env);
const distDir = join(repoRoot, 'dist');
if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html is missing: run `bun run setup` first');
  process.exit(1);
}

try {
  const note = await syncFactoriesAtStart({
    env: Bun.env,
    repoRoot,
    neon: createNeonApi,
    openDb,
  });
  if (note) console.log(note);
} catch (error) {
  console.error(`factories sync failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const app = createApp({
  buildId: resolveBuildId(Bun.env, repoRoot),
  distDir,
  live: liveFromEnv(Bun.env, repoRoot),
});
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
console.log(`serving http://localhost:${server.port}`);
