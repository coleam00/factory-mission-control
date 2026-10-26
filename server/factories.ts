import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './check-env';

export interface FactoryEntry {
  name: string;
  repository: string;
  codebase: string;
  console: string;
}

export function readFactories(env: Env, repoRoot: string): FactoryEntry[] {
  const file = env.MC_FACTORIES_FILE || join(repoRoot, 'factories.json');
  const { factories } = JSON.parse(readFileSync(file, 'utf-8')) as { factories: FactoryEntry[] };
  return factories;
}
