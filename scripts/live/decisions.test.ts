import { expect, test } from 'bun:test';
import { attentionMismatches, type ShownAttention } from './decisions';

const RUN = '5eed0005-0000-4000-8000-000000000001';
const projected = [{ run: RUN, console: 'http://localhost:3090/', recommended: 'split' }];
const archon = [{ run: RUN }];
const shown: ShownAttention[] = [
  {
    id: RUN,
    href: `http://localhost:3090/console/r/${RUN}`,
    recommended: ['split'],
    waited: '1h 40m',
  },
];

test('a panel that matches SQL has no mismatch', () => {
  expect(attentionMismatches(shown, archon, projected)).toEqual([]);
});

test('a missing panel, a wrong console link and a wrong recommended choice are each named', () => {
  expect(attentionMismatches([], archon, projected)).toHaveLength(1);
  const [wrongLink] = attentionMismatches(
    [{ ...shown[0], href: 'http://localhost:3090/console/r/other' } as ShownAttention],
    archon,
    projected,
  );
  expect(wrongLink).toContain('console link');
  const [wrongChoice] = attentionMismatches(
    [{ ...shown[0], recommended: ['build'] } as ShownAttention],
    archon,
    projected,
  );
  expect(wrongChoice).toContain('recommended');
});

test('a projection that disagrees with Archon’s own rows is named', () => {
  expect(attentionMismatches(shown, [], projected)[0]).toContain("Archon's open attention waits");
});

test('a seed with no attention item or no recommendation says so', () => {
  expect(attentionMismatches([], [], [])).toContain('the seed has no open attention item');
  expect(attentionMismatches(shown, archon, [{ ...projected[0], recommended: null }])).toContain(
    'no seeded attention item recommends a choice',
  );
});
