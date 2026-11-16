import { resolve } from 'node:path';

/**
 * Local mode's ingest loop (LOCAL-MODE.md): GitHub webhooks cannot reach a self-hosted install, so
 * every MC_INGEST_INTERVAL_S (300) seconds this runs `backfill --reconcile` and `reconcile:laps`.
 * A failed pass is logged and retried on the next tick; `--once` runs one pass and exits with its
 * code.
 */
const env = { ...process.env, MC_LIVE_MODE: process.env.MC_LIVE_MODE ?? 'local' };
const intervalS = Number(Bun.env.MC_INGEST_INTERVAL_S ?? 300);
if (!Number.isFinite(intervalS) || intervalS < 30) {
  console.error('MC_INGEST_INTERVAL_S must be a number of seconds, at least 30');
  process.exit(2);
}

async function pass(): Promise<number> {
  let worst = 0;
  for (const args of [['scripts/backfill.ts', '--reconcile'], ['scripts/reconcile-laps.ts']]) {
    const started = Date.now();
    const code = await Bun.spawn([process.execPath, ...args], {
      cwd: resolve(import.meta.dir, '..', '..'),
      env,
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited;
    console.log(
      `${new Date().toISOString()} ${args.join(' ')} exit ${code} in ${Date.now() - started} ms`,
    );
    if (code !== 0) worst = code;
  }
  return worst;
}

if (Bun.argv.includes('--once')) process.exit(await pass());

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
while (true) {
  await pass();
  await Bun.sleep(intervalS * 1000);
}
