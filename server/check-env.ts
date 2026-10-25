import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Written by `bun run fixture:branch`, removed by `bun run fixture:drop`; gitignored. */
export const CHECK_ENV_FILE = '.mc-check.env';

export type Env = Record<string, string | undefined>;

export function parseCheckEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

export function formatCheckEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
}

/** The environment the launcher sets wins: the file only fills keys `env` lacks. */
export function loadCheckEnv(repoRoot: string, env: Env): void {
  const file = join(repoRoot, CHECK_ENV_FILE);
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseCheckEnv(readFileSync(file, 'utf-8')))) {
    if (env[key] === undefined) env[key] = value;
  }
}
