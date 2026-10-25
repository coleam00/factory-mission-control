import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const scratch = mkdtempSync(join(tmpdir(), 'mc-bundle-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SECRETS = {
  NEON_REALTIME_SECRET: 'nrt_sample_secret_do_not_ship',
  MC_DATABASE_URL:
    'postgresql://sample_user:sample_pw@ep-sample-000000.c-14.us-east-1.aws.neon.tech/factory',
};

test('no browser source can reach the sealing key or the database URL', () => {
  const offenders: string[] = [];
  for (const file of new Bun.Glob('app/**/*.{ts,tsx}').scanSync(repoRoot)) {
    if (join(repoRoot, file) === import.meta.path) continue;
    const source = readFileSync(join(repoRoot, file), 'utf-8');
    if (/@neon\/realtime\/server|NEON_REALTIME_SECRET|MC_DATABASE_URL/.test(source)) {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});

test('the built browser bundle holds neither secret value from the build environment', () => {
  const outDir = join(scratch, 'dist');
  const build = Bun.spawnSync(['bunx', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: repoRoot,
    env: { ...process.env, ...SECRETS },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const files = [...new Bun.Glob('**/*').scanSync(outDir)];
  expect(files).toContain('index.html');
  for (const file of files) {
    const content = readFileSync(join(outDir, file), 'latin1');
    for (const value of Object.values(SECRETS)) expect(content).not.toContain(value);
  }
}, 120_000);
