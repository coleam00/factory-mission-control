import { expect, test } from 'bun:test';
import { answerFailures, answerMismatches, panelMismatches, type ShownPanel } from './manager';

const QUESTIONS = ['What failed overnight?', 'What did today cost?', 'What is stuck?'];
const shown: ShownPanel = {
  head: 'AManagerWatches every run and queue for you×',
  placeholder: 'Ask about any run, or tell me what to do',
  chip: 'Attention · 7 items',
  suggestions: QUESTIONS,
};

test('a panel that matches the design and the page count has no mismatch', () => {
  expect(panelMismatches(shown, 7, 'Attention', QUESTIONS)).toEqual([]);
});

test('a quiet factory, with no items, is chip "Attention · 0 items"', () => {
  const quiet = { ...shown, chip: 'Attention · 0 items' };
  expect(panelMismatches(quiet, 0, 'Attention', QUESTIONS)).toEqual([]);
});

test('a wrong chip, copy or suggestion set is a mismatch', () => {
  const wrong = { ...shown, chip: 'Attention', placeholder: 'Ask', suggestions: [QUESTIONS[0]] };
  expect(panelMismatches(wrong, 7, 'Attention', QUESTIONS)).toHaveLength(3);
});

test('an answer that names no run, or a run the factory lacks, is a failure', () => {
  const known = new Set(['a', 'b']);
  expect(answerMismatches(['a'], known)).toEqual([]);
  expect(answerMismatches([], known)).toEqual(['the answer named no run']);
  expect(answerMismatches(['a', 'zzz'], known)).toHaveLength(1);
});

test('an answer with a notice fails with the notice, not with "named no run"', () => {
  const known = new Set(['a']);
  const failures = answerFailures(['The Manager has used its budget for today.'], [], known);
  expect(failures).toEqual([
    'the answer carries a notice: The Manager has used its budget for today.',
  ]);
  expect(answerFailures([], [], known)).toEqual(['the answer named no run']);
  expect(answerFailures([], ['a'], known)).toEqual([]);
});
