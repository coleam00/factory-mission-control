import { expect, test } from 'bun:test';
import type { UnstickRow } from '../../app/lib/attention';
import { retriageCommand } from '../../app/lib/attention-page';
import {
  countMismatches,
  decideMismatches,
  fixMismatches,
  type ShownCard,
  unstickMismatches,
} from './attention';

const RUN = '5eed0005-0000-4000-8000-000000000001';
const projected = [{ run: RUN, console: 'http://localhost:3090/', recommended: 'split' }];
const archon = [{ run: RUN }];
const card = (overrides: Partial<ShownCard>): ShownCard => ({
  id: RUN,
  kind: 'decide',
  console: `http://localhost:3090/console/r/${RUN}`,
  recommended: ['split'],
  command: null,
  waited: '1h 40m',
  ...overrides,
});

test('Decide cards that match SQL have no mismatch', () => {
  expect(decideMismatches([card({})], archon, projected)).toEqual([]);
});

test('a missing card, a duplicated card, a wrong console link and a wrong recommended choice are each named', () => {
  expect(decideMismatches([], archon, projected)[0]).toContain('Decide cards');
  expect(decideMismatches([card({}), card({})], archon, projected)[0]).toContain('Decide cards');
  expect(
    decideMismatches(
      [card({ console: 'http://localhost:3090/console/r/other' })],
      archon,
      projected,
    )[0],
  ).toContain('console link');
  expect(decideMismatches([card({ recommended: ['build'] })], archon, projected)[0]).toContain(
    'recommended',
  );
});

test('a projection that disagrees with Archon’s own rows is named', () => {
  expect(decideMismatches([card({})], [], projected)[0]).toContain("Archon's open attention waits");
});

test('a seed with no question or no recommendation says so', () => {
  expect(decideMismatches([], [], [])).toContain('the seed has no open attention item');
  expect(decideMismatches([card({})], archon, [{ ...projected[0], recommended: null }])).toContain(
    'no seeded attention item recommends a choice',
  );
});

test('Fix cards must be each failure signature exactly once', () => {
  const fix = (id: string) => card({ id, kind: 'fix' });
  expect(fixMismatches([fix('a'), fix('b')], [{ signature: 'a' }, { signature: 'b' }])).toEqual([]);
  expect(fixMismatches([fix('a')], [{ signature: 'a' }, { signature: 'b' }])[0]).toContain('Fix');
  expect(fixMismatches([fix('a'), fix('a')], [{ signature: 'a' }])[0]).toContain('Fix');
  expect(fixMismatches([], [])).toEqual(['the seed has no unresolved failure']);
});

const stuck: UnstickRow = {
  kind: 'blocked',
  number: 7,
  run_id: null,
  workflow_name: null,
  waits_on: '#6',
  since: new Date('2026-10-24T10:00:00Z'),
  action: 'retriage',
  repository: 'o/r',
  console: 'http://localhost:3090/',
};

test('Unstick cards must match the query’s rows, and a re-triage card must hold the exact command', () => {
  const shown = card({
    id: 'unstick:blocked:7:',
    kind: 'unstick',
    command: retriageCommand('o/r', 7),
  });
  expect(unstickMismatches([shown], [stuck], 'f')).toEqual([]);
  expect(unstickMismatches([], [stuck], 'f')[0]).toContain('Unstick cards');
  expect(unstickMismatches([shown, shown], [stuck], 'f')[0]).toContain('Unstick cards');
  expect(unstickMismatches([{ ...shown, command: 'gh issue edit 7' }], [stuck], 'f')[0]).toContain(
    're-triage command',
  );
});

test('the head, the cards and the tab badge must say one number, and the badge hides at zero', () => {
  expect(countMismatches(3, 3, 3)).toEqual([]);
  expect(countMismatches(0, 0, null)).toEqual([]);
  expect(countMismatches(2, 3, 3)[0]).toContain('head count');
  expect(countMismatches(3, 3, 2)[0]).toContain('tab count');
});
