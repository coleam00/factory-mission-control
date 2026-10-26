import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { DATABASE_URL, recordingDeps, scratchRepo } from '../lib/test-deps';
import { main } from './verify';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = scratchRepo({ MC_DATABASE_URL: DATABASE_URL });
  scratch.push(dir);
  return dir;
}

test.each([0, 1, 2, 5, undefined])(
  'counts requires exactly one projection error (got %s)',
  async (errors) => {
    const run = recordingDeps({
      repoRoot: repo(),
      rows: (sql) => {
        if (sql.includes('information_schema.tables')) {
          return [
            { table_name: 'lap_steps' },
            ...(errors === undefined ? [] : [{ table_name: 'projection_errors' }]),
          ];
        }
        if (sql.includes('mc."projection_errors"')) return [{ n: errors }];
        if (sql.includes('information_schema.columns')) return [];
        return [{ n: 100 }];
      },
    });
    expect(await main(['counts'], run.deps)).toBe(errors === 1 ? 0 : 1);
    expect(run.out.join('\n')).toContain(
      `table mc.projection_errors ${errors ?? 'missing'} == 1 ${errors === 1 ? 'ok' : 'SHORT'}`,
    );
    expect(run.out.join('\n')).toContain('table mc.lap_steps 100 >= 1 ok');
  },
);

test.each(['main', 'fixture', 'rewind-x'])(
  'refuses a database URL on branch %s without connecting',
  async (branchName) => {
    const run = recordingDeps({ repoRoot: repo(), branchName });
    expect(await main(['counts'], run.deps)).toBe(1);
    expect(run.opened).toEqual([]);
    expect(run.err.join('\n')).toContain(`refusing branch '${branchName}'`);
  },
);

test.each([[[]], [['seed']], [['counts', 'scorecard']]])(
  'exits 2 with usage for %j before touching Neon',
  async (argv) => {
    const run = recordingDeps({ repoRoot: repo() });
    expect(await main(argv, run.deps)).toBe(2);
    expect(run.neonCalls).toEqual([]);
    expect(run.err.join('\n')).toContain('usage: bun run fixture:verify counts|scorecard');
  },
);
