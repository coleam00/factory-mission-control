import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLeases, refreshLease, removeLease, writeLease } from './check-lease';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function leaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-check-lease-'));
  scratch.push(dir);
  return dir;
}

const AT = new Date('2026-10-24T12:00:00Z');

test('a missing directory holds no leases', () => {
  expect(readLeases(join(leaseDir(), 'missing'))).toEqual([]);
});

test('writes, reads and removes a lease, creating the directory', () => {
  const dir = join(leaseDir(), 'leases');
  expect(writeLease(dir, 'check-abc', AT)).toBe(true);
  expect(readLeases(dir)).toEqual([{ branch: 'check-abc', refreshed_at: AT.toISOString() }]);
  removeLease(dir, 'check-abc');
  expect(readLeases(dir)).toEqual([]);
});

test.each(['main', 'fixture', 'rewind-x'])('refuses a lease on %s', (name) => {
  const dir = leaseDir();
  expect(writeLease(dir, name, AT)).toBe(false);
  expect(existsSync(join(dir, `${name}.json`))).toBe(false);
});

test('skips a malformed lease, one with no time and one not on a check branch', () => {
  const dir = leaseDir();
  const valid = JSON.stringify({ refreshed_at: AT.toISOString() });
  writeFileSync(join(dir, 'check-bad.json'), '{not json');
  writeFileSync(join(dir, 'check-empty.json'), '{}');
  writeFileSync(join(dir, 'check-when.json'), '{"refreshed_at":"soon"}');
  writeFileSync(join(dir, 'main.json'), valid);
  writeFileSync(join(dir, 'check-abc.txt'), valid);
  expect(readLeases(dir)).toEqual([]);
});

test('a refresh moves an existing lease and never creates one', () => {
  const dir = leaseDir();
  refreshLease(dir, 'check-abc', AT);
  expect(readLeases(dir)).toEqual([]);
  writeLease(dir, 'check-abc', new Date(AT.getTime() - 3_600_000));
  refreshLease(dir, 'check-abc', AT);
  expect(readLeases(dir)).toEqual([{ branch: 'check-abc', refreshed_at: AT.toISOString() }]);
});
