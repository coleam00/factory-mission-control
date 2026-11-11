import { expect, test } from 'bun:test';
import {
  type AttentionRow,
  attentionItems,
  attentionOrigin,
  attentionQuestion,
  attentionTitle,
  parseRecommendation,
} from './attention';

const MESSAGE = [
  '**Build queue, issue 15: scope decision**',
  '**What it is.** Issue 15 asks for two screens in one change.',
  '**Why it matters.** It is hard to review.',
  '**Recommendation: `split`** (high confidence). Two small changes land sooner.',
].join('\n\n');
const CHOICES = [
  { id: 'split', label: 'Split', description: null },
  { id: 'build', label: null, description: null },
];

const row = (overrides: Partial<AttentionRow>): AttentionRow => ({
  run_id: 'a',
  workflow_name: 'archon-build-queue',
  node_id: 'ask',
  waiting_since: new Date('2026-10-24T10:00:00Z'),
  form: 'select',
  options: JSON.stringify(CHOICES),
  labels: '{"build":"scope"}',
  recommended: null,
  message: MESSAGE,
  console: 'http://localhost:3090',
  ...overrides,
});

test('the queue layout gives its title, its question and its recommended choice', () => {
  expect(attentionTitle(MESSAGE)).toBe('Build queue, issue 15: scope decision');
  expect(attentionQuestion(MESSAGE)).toBe('Issue 15 asks for two screens in one change.');
});

test('a plain message has no title and no recommendation, and its first paragraph is the question', () => {
  const plainMessage = 'Which of these should the next lap take?\n\nThe second line.';
  expect(attentionTitle(plainMessage)).toBeNull();
  expect(attentionQuestion(plainMessage)).toBe('Which of these should the next lap take?');
});

test("the reason is the rest of the Recommendation's paragraph, wherever the line sits", () => {
  const midParagraph =
    '**What it is.** Two screens. **Recommendation: `split`** (high confidence). Because.';
  expect(parseRecommendation(midParagraph)?.reason).toBe('Because.');
  const wide = parseRecommendation('**Recommendation: `split`** (very high confidence). Because.');
  const later = '**Recommendation: `split`** (high confidence). Because.\n\nA later paragraph.';
  expect(parseRecommendation(later)?.reason).toBe('Because.');
  expect(wide?.confidence).toBeNull();
  expect(wide?.reason).toBe('(very high confidence). Because.');
  expect(parseRecommendation(MESSAGE)).toMatchObject({
    confidence: 'high',
    reason: expect.stringContaining('Two small changes land sooner.'),
  });
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

test('a choice keeps the description the projection recorded', () => {
  const [item] = attentionItems([
    row({ options: JSON.stringify([{ id: 'split', label: 'Split', description: 'Two changes' }]) }),
  ]);
  expect(item?.options).toEqual([{ id: 'split', label: 'Split', description: 'Two changes' }]);
});
