import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './app';
import { resolveBuildId } from './build-id';
import { PORTS } from './ports';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: 'string' } },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < PORTS.min || port > PORTS.max) {
  console.error(`usage: bun run serve -- --port <${PORTS.min}-${PORTS.max}>`);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dir, '..');
const distDir = join(repoRoot, 'dist');
if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html is missing: run `bun run setup` first');
  process.exit(1);
}

const app = createApp({ buildId: resolveBuildId(Bun.env, repoRoot), distDir });
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
console.log(`serving http://localhost:${server.port}`);
