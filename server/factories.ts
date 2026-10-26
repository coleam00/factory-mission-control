import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './check-env';

export type FactoryEntry = {
  name: string;
  repository: string;
  codebase: string;
  console: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEntries(env: Env, repoRoot: string): Record<string, unknown>[] {
  const file = env.MC_FACTORIES_FILE || join(repoRoot, 'factories.json');
  const config: unknown = JSON.parse(readFileSync(file, 'utf-8'));
  if (!isObject(config) || !Array.isArray(config.factories)) {
    throw new Error('Invalid factories configuration: expected an object with a factories array');
  }
  return config.factories.map((entry: unknown, index) => {
    if (!isObject(entry)) {
      throw new Error(`Invalid factories configuration: factories[${index}] must be an object`);
    }
    return entry;
  });
}

function stringField(
  entry: Record<string, unknown>,
  field: keyof FactoryEntry,
  index: number,
): string {
  const value = entry[field];
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid factories configuration: factories[${index}].${field} must be a string`,
    );
  }
  return value;
}

export function readFactoryNames(env: Env, repoRoot: string): string[] {
  return readEntries(env, repoRoot).map((entry, index) => stringField(entry, 'name', index));
}

export function readFactories(env: Env, repoRoot: string): FactoryEntry[] {
  return readEntries(env, repoRoot).map((entry, index) => ({
    name: stringField(entry, 'name', index),
    repository: stringField(entry, 'repository', index),
    codebase: stringField(entry, 'codebase', index),
    console: stringField(entry, 'console', index),
  }));
}
