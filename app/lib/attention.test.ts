import { renderAttention } from '../../fixtures/pack/queue/sdlc/.shared/queue';
import { expect, test } from 'bun:test';
import {
  type AttentionRow,
  attentionItems,
  attentionOrigin,
  attentionQuestion,
  attentionTitle,
  recommendedChoice,
} from './attention';

const MESSAGE = [
  '**Build queue, issue 15: scope decision**',
  '**What it is.** Issue 15 asks for two screens in one change.',
  '**Why it matters.** It is hard to review.',
  '**Recommendation: `split`** (high confidence). Two small changes land sooner.',
].join('\n\n');
const CHOICES = [
  { id: 'split', label: 'Split' },
  { id: 'build', label: null },
];

const row = (overrides: Partial<AttentionRow>): AttentionRow => ({
  run_id: 'a',
  workflow_name: 'archon-build-queue',
  node_id: 'ask',
  waiting_since: new Date('2026-10-24T10:00:00Z'),
  form: 'select',
  options: JSON.stringify(CHOICES),
  labels: '{"build":"scope"}',
  message: MESSAGE,
  console: 'http://localhost:3090',
  ...overrides,
});

test('the queue layout gives its title, its question and its recommended choice', () => {
  expect(attentionTitle(MESSAGE)).toBe('Build queue, issue 15: scope decision');
  expect(attentionQuestion(MESSAGE)).toBe('Issue 15 asks for two screens in one change.');
  expect(recommendedChoice(MESSAGE, CHOICES)).toBe('split');
});

test('a plain message has no title and no recommendation, and its first paragraph is the question', () => {
  const plainMessage = 'Which of these should the next lap take?\n\nThe second line.';
  expect(attentionTitle(plainMessage)).toBeNull();
  expect(attentionQuestion(plainMessage)).toBe('Which of these should the next lap take?');
  expect(recommendedChoice(plainMessage, CHOICES)).toBeNull();
});

test('a recommendation that is not one of the choices marks none', () => {
  expect(recommendedChoice(MESSAGE, [{ id: 'build', label: null }])).toBeNull();
});

test('the origin is the labels, or the workflow without its archon- lead', () => {
  expect(attentionOrigin({ labels: { discoveries: '' }, workflow_name: 'w' })).toBe('discoveries');
  expect(attentionOrigin({ labels: { build: 'scope', x: 'y' }, workflow_name: 'w' })).toBe(
    'build: scope · x: y',
  );
  expect(attentionOrigin({ labels: {}, workflow_name: 'archon-merge-queue' })).toBe('merge-queue');
});

test('items wait longest first, and unreadable choices or labels are none', () => {
  const items = attentionItems([
    row({ run_id: 'late', waiting_since: new Date('2026-10-24T12:00:00Z') }),
    row({ run_id: 'early', options: 'not json', labels: '[1]' }),
  ]);
  expect(items.map((i) => i.run_id)).toEqual(['early', 'late']);
  expect(items[0]).toMatchObject({ options: [], labels: {} });
  expect(items[1]?.options).toEqual(CHOICES);
});

test('a message the pack writes with renderAttention is read back by the console', () => {
  const message = renderAttention('Merge queue, pull request 16: ready to merge', {
    what: 'Pull request 16 is green.',
    why: 'It is the last change.',
    recommendation: {
      choice: 'merge',
      why: 'Nothing waits on it.',
      evidence: 'Every check is green.',
      confidence: 'medium',
      would_change: 'A new finding.',
    },
    choices: [
      { id: 'merge', label: 'Merge it', does: 'Merges.', effect: 'merge', ruling: '' },
      { id: 'hold', label: 'Hold it', does: 'Holds.', effect: 'hold', ruling: '' },
    ],
    if_unanswered: 'It stays open.',
    links: ['https://example.com/pull/16'],
  });
  expect(attentionTitle(message)).toBe('Merge queue, pull request 16: ready to merge');
  expect(attentionQuestion(message)).toBe('Pull request 16 is green.');
  expect(recommendedChoice(message, [{ id: 'merge', label: 'Merge it' }])).toBe('merge');
});
