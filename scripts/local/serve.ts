import { resolve } from 'node:path';

/**
 * Local mode's container entrypoint (LOCAL-MODE.md): applies db/migrations and loads the
 * configured factories, then serves the built UI and API on PORT (8850). A failed migration stops
 * it before serving.
 */
const env = { ...process.env, MC_LIVE_MODE: process.env.MC_LIVE_MODE ?? 'local' };
const spawn = (args: string[]) =>
  Bun.spawn([process.execPath, ...args], {
    cwd: resolve(import.meta.dir, '..', '..'),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

if (Bun.env.MC_SKIP_MIGRATE !== '1') {
  const migrated = await spawn(['scripts/migrate.ts', '--configured-factories']).exited;
  if (migrated !== 0) {
    console.error(`migrations failed (exit ${migrated}); not serving`);
    process.exit(migrated);
  }
}

const server = spawn(['server/main.ts', '--port', Bun.env.PORT ?? '8850']);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.kill(signal));
}
process.exit(await server.exited);
