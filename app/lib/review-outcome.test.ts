import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { REVIEW_OUTCOMES } from './review-outcome';

test('the table lists exactly the outcomes the pack loop review can return', () => {
  const yaml = readFileSync('fixtures/pack/sdlc/loop/archon-loop.yaml', 'utf8');
  const list = yaml.match(/outcome: \{ type: string, enum: \[([^\]]*)\] \}/)?.[1] ?? '';
  const packEnum = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  expect(packEnum.length).toBeGreaterThan(0);
  expect([...REVIEW_OUTCOMES].sort()).toEqual(packEnum);
});
