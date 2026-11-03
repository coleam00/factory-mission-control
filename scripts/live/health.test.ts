import { expect, test } from 'bun:test';
import { type ExpectedHealth, healthMismatches, type ShownHealth } from './health';

const expected: ExpectedHealth = {
  pending: ['q'],
  paused: ['p'],
  overdue: ['a build', 'b check-app'],
  causes: { 'usage-limit': 2, authentication: 2, infrastructure: 1, other: 1 },
  workable: [9],
  running: 2,
};

const shown: ShownHealth = {
  pending: ['q'],
  paused: ['p'],
  overdue: ['b check-app', 'a build'],
  causes: { 'usage-limit': 2, authentication: 2, infrastructure: 1, other: 1 },
  workable: [9],
  workableCount: 1,
  running: 2,
};

test('a screen showing exactly what SQL says has no mismatch', () => {
  expect(healthMismatches(shown, expected)).toEqual([]);
});

test('a wrong count, a missing overdue step and a wrong workable count are each a mismatch', () => {
  const wrong = {
    ...shown,
    overdue: ['a build'],
    workableCount: 0,
    causes: { ...shown.causes, other: 0 },
  };
  expect(healthMismatches(wrong, expected)).toEqual([
    'overdue steps: screen ["a build"], SQL ["a build","b check-app"]',
    'failed laps by cause: screen {"usage-limit":2,"authentication":2,"infrastructure":1,"other":0}, SQL {"usage-limit":2,"authentication":2,"infrastructure":1,"other":1}',
    'workable count: screen 0, SQL 1',
  ]);
});

test('a seed without a pending run, an overdue step or a cause cannot pass', () => {
  const thin: ExpectedHealth = {
    ...expected,
    pending: [],
    overdue: [],
    causes: { ...expected.causes, authentication: 0 },
  };
  const same: ShownHealth = { ...shown, pending: [], overdue: [], causes: thin.causes };
  expect(healthMismatches(same, thin)).toEqual([
    'the seed does not have exactly 1 pending run',
    'the seed has no overdue step',
    'the seed has no failed lap of authentication',
  ]);
});
