import { expect, test } from 'bun:test';
import { expectedItems, ownerMismatches, type ShownOwnerItem } from './owner';

const URL17 = 'https://github.com/coleam00/factory-mission-control/issues/17';
const URL13 = 'https://github.com/coleam00/factory-mission-control/issues/13';

const issues = [
  {
    number: 13,
    title: 'The architecture diff',
    url: URL13,
    updated_at: new Date('2026-10-10T21:00:00Z'),
  },
];
const questions = [
  {
    issue_number: 17,
    question_number: 2,
    question: 'Should the lanes panel show finished laps for an hour?',
    options: [
      { key: 'A', text: 'yes, faded' },
      { key: 'B', text: 'no, only running laps' },
    ],
    recommendation: 'A, so a merge that just happened is still visible.',
    default_option: 'A',
    default_at: new Date('2026-10-27T14:00:00Z'),
    raised_at: new Date('2026-10-23T09:00:00Z'),
    url: URL17,
  },
];

const shown: ShownOwnerItem[] = [
  {
    id: 'issue-13',
    title: 'The architecture diff',
    href: URL13,
    options: [],
    recommendation: null,
    defaultOption: null,
    defaultAt: null,
    waitingSince: '2026-10-10T21:00:00.000Z',
    waited: '16d 13h',
  },
  {
    id: 'question-17-2',
    title: 'Should the lanes panel show finished laps for an hour?',
    href: URL17,
    options: [
      { key: 'A', text: 'yes, faded', isDefault: true },
      { key: 'B', text: 'no, only running laps', isDefault: false },
    ],
    recommendation: 'A, so a merge that just happened is still visible.',
    defaultOption: 'A',
    defaultAt: '2026-10-27T14:00:00.000Z',
    waitingSince: '2026-10-23T09:00:00.000Z',
    waited: '4d 1h',
  },
];

const expected = expectedItems(issues, questions);

test('a screen showing exactly the seed has no mismatch', () => {
  expect(ownerMismatches(shown, expected)).toEqual([]);
});

test('a missing item, a wrong link and a wrong default are each a mismatch', () => {
  const [issue, question] = shown;
  const wrong = { ...question, href: URL13, defaultOption: 'B' };
  expect(ownerMismatches([wrong], expected)).toEqual([
    'items: screen ["question-17-2"], SQL ["issue-13","question-17-2"]',
    `question-17-2 href: screen "${URL13}", SQL "${URL17}"`,
    'question-17-2 defaultOption: screen "B", SQL "A"',
  ]);
  expect(ownerMismatches([issue, { ...question, href: null }], expected)).toContain(
    'question-17-2 links to null, not a GitHub issue',
  );
});

test('options read as JSON text, as Realtime may deliver them, give the same expectation', () => {
  const asText = expectedItems(issues, [
    { ...questions[0], options: JSON.stringify(questions[0].options) },
  ]);
  expect(ownerMismatches(shown, asText)).toEqual([]);
});
