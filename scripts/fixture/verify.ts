import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failing, guardedDatabaseUrl, type Main, runCli } from '../lib/cli';
import { counts, formatCounts, formatScorecard, scorecard } from './seed-report';

const USAGE =
  'usage: bun run fixture:verify counts|scorecard (reads the check branch in .mc-check.env)';

const REPORTS = ['counts', 'scorecard'] as const;

/** Reads the seeded check branch: its row counts and minimums, or its scorecard. Never writes. */
export const main: Main = async (argv, deps) => {
  const report = REPORTS.find((name) => argv.length === 1 && argv[0] === name);
  if (!report) {
    deps.err(USAGE);
    return 2;
  }
  return failing(deps, async () => {
    const db = deps.openDb(await guardedDatabaseUrl(deps, 'check'));
    try {
      const { text, ok } =
        report === 'counts'
          ? formatCounts(await counts(db))
          : formatScorecard(
              await scorecard(db, deps.repoRoot),
              JSON.parse(
                readFileSync(join(deps.repoRoot, 'fixtures', 'expected-scorecard.json'), 'utf8'),
              ),
            );
      deps.out(text);
      if (!ok) throw new Error(`the check branch does not hold what the seed promises (${report})`);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
