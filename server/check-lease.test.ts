import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEASE_MS,
  LEASE_REFRESH_MS,
  readLeases,
  refreshLease,
  removeLease,
  startLeaseRefresh,
  writeLease,
} from './check-lease';

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

test('a lease file that cannot be read holds its branch; other files are no lease', () => {
  const dir = leaseDir();
  const valid = JSON.stringify({ refreshed_at: AT.toISOString() });
  writeFileSync(join(dir, 'check-bad.json'), '{not json');
  writeFileSync(join(dir, 'check-empty.json'), '{}');
  writeFileSync(join(dir, 'check-when.json'), '{"refreshed_at":"soon"}');
  mkdirSync(join(dir, 'check-dir.json'));
  writeFileSync(join(dir, 'main.json'), valid);
  writeFileSync(join(dir, 'check-abc.txt'), valid);
  expect(readLeases(dir).sort((a, b) => a.branch.localeCompare(b.branch))).toEqual([
    { branch: 'check-bad', refreshed_at: null },
    { branch: 'check-dir', refreshed_at: null },
    { branch: 'check-empty', refreshed_at: null },
    { branch: 'check-when', refreshed_at: null },
  ]);
});

test('a lease directory that cannot be listed throws rather than reading as no leases', () => {
  const file = join(leaseDir(), 'not-a-dir');
  writeFileSync(file, '');
  expect(() => readLeases(file)).toThrow(`cannot read the leases in ${file}`);
});

test('a write leaves only the lease file behind', () => {
  const dir = leaseDir();
  writeLease(dir, 'check-abc', AT);
  writeLease(dir, 'check-abc', AT);
  expect(readdirSync(dir)).toEqual(['check-abc.json']);
});

test('a refresh moves an existing lease and never creates one', () => {
  const dir = leaseDir();
  refreshLease(dir, 'check-abc', AT);
  expect(readLeases(dir)).toEqual([]);
  writeLease(dir, 'check-abc', new Date(AT.getTime() - 3_600_000));
  refreshLease(dir, 'check-abc', AT);
  expect(readLeases(dir)).toEqual([{ branch: 'check-abc', refreshed_at: AT.toISOString() }]);
});

test('a refresh that cannot move an existing lease says so', () => {
  const dir = leaseDir();
  mkdirSync(join(dir, 'check-abc.json'));
  expect(refreshLease(dir, 'check-abc', AT)).toBe(false);
});

function serveRefresh(branch: string | undefined, dir: string) {
  let now = AT;
  const timers: { refresh: () => void; ms: number }[] = [];
  const warnings: string[] = [];
  startLeaseRefresh(
    branch,
    dir,
    () => now,
    (refresh, ms) => timers.push({ refresh, ms }),
    (message) => warnings.push(message),
  );
  return {
    timers,
    warnings,
    tick(at: Date) {
      now = at;
      for (const timer of timers) timer.refresh();
    },
  };
}

test("serve refreshes its branch's lease at start and on every interval, well inside LEASE_MS", () => {
  const dir = leaseDir();
  const expired = new Date(AT.getTime() - LEASE_MS);
  writeLease(dir, 'check-abc', expired);
  writeLease(dir, 'check-other', expired);
  const serve = serveRefresh('check-abc', dir);
  const refreshedAt = (branch: string) =>
    readLeases(dir).find((lease) => lease.branch === branch)?.refreshed_at;
  expect(refreshedAt('check-abc')).toBe(AT.toISOString());
  expect(serve.timers.map((timer) => timer.ms)).toEqual([LEASE_REFRESH_MS]);
  expect(LEASE_REFRESH_MS).toBeLessThanOrEqual(LEASE_MS / 2);
  const later = new Date(AT.getTime() + LEASE_REFRESH_MS);
  serve.tick(later);
  expect(refreshedAt('check-abc')).toBe(later.toISOString());
  expect(refreshedAt('check-other')).toBe(expired.toISOString());
  expect(serve.warnings).toEqual([]);
});

test('serve registers nothing without MC_CHECK_BRANCH', () => {
  expect(serveRefresh(undefined, leaseDir()).timers).toEqual([]);
});

test('serve warns once when its lease cannot be refreshed', () => {
  const dir = leaseDir();
  mkdirSync(join(dir, 'check-abc.json'));
  const serve = serveRefresh('check-abc', dir);
  serve.tick(new Date(AT.getTime() + LEASE_REFRESH_MS));
  expect(serve.warnings).toEqual([`could not refresh the lease for check-abc in ${dir}`]);
});
