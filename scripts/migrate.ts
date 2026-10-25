import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { failing, guardedDatabaseUrl, type Main, runCli } from './lib/cli';
import type { Db } from './lib/db';

export type MigrationFile = { name: string; sql: string };

export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf-8') }));
}

export function migrationsDir(repoRoot: string): string {
  return join(repoRoot, 'db', 'migrations');
}

/** Applies each file not yet recorded, file and record in one transaction; returns those applied. */
export async function runMigrations({
  files,
  db,
}: {
  files: MigrationFile[];
  db: Db;
}): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS mc_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const recorded = new Set(
    (await db.query('SELECT name FROM mc_schema_migrations')).map((row) => String(row.name)),
  );
  const applied: string[] = [];
  for (const file of files) {
    if (recorded.has(file.name)) continue;
    try {
      await db.transaction(async (tx) => {
        await tx.query(file.sql);
        await tx.query('INSERT INTO mc_schema_migrations (name) VALUES ($1)', [file.name]);
      });
    } catch (error) {
      const committed = applied.length > 0 ? ` after applying ${applied.join(', ')}` : '';
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${file.name} failed${committed}: ${reason}`, { cause: error });
    }
    applied.push(file.name);
  }
  return applied;
}

const USAGE =
  'usage: bun run migrate (the check branch in .mc-check.env) | bun run migrate:main (the owner, at a terminal)';

export const main: Main = async (argv, deps) => {
  let values: { main?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { main: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (error) {
    deps.err(error instanceof Error ? `${error.message}\n${USAGE}` : USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  const target = values.main ? 'main' : 'check';
  return failing(deps, async () => {
    const url = await guardedDatabaseUrl(deps, target);
    if (target === 'main' && !deps.confirmOwner(deps.env.NEON_PROJECT_ID ?? '')) {
      throw new Error('migrate:main is for the owner, at a terminal');
    }
    const db = deps.openDb(url);
    try {
      const applied = await runMigrations({
        files: readMigrationFiles(migrationsDir(deps.repoRoot)),
        db,
      });
      for (const name of applied) deps.out(`applied ${name}`);
      deps.out(`applied ${applied.length} migration(s)`);
    } finally {
      await db.close();
    }
  });
};

if (import.meta.main) await runCli(main);
