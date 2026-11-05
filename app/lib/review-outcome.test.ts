import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REVIEW_TONE, reviewToken } from './review-outcome';

test('the table lists exactly the outcomes the pack loop review can return', () => {
  const yaml = readFileSync('fixtures/pack/sdlc/loop/archon-loop.yaml', 'utf8');
  const list = yaml.match(/outcome: \{ type: string, enum: \[([^\]]*)\] \}/)?.[1] ?? '';
  const packEnum = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  expect(packEnum.length).toBeGreaterThan(0);
  expect(Object.keys(REVIEW_TONE).sort()).toEqual(packEnum);
});

test('approved reads done, merge and sent-back keep teal, needs-owner violet, nothing plain', () => {
  expect(reviewToken('approved')).toBe('--success');
  expect(reviewToken('merge')).toBe('--success');
  expect(reviewToken('sent-back')).toBe('--success');
  expect(reviewToken('needs-owner')).toBe('--role-person');
  expect(reviewToken('nothing')).toBeUndefined();
});
