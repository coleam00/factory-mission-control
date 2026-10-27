import { expect, test } from 'bun:test';
import {
  type CheckRow,
  checkMix,
  type DefaultHoldoutRow,
  defaultBranch,
  prHoldouts,
  type RouteRow,
  routeMix,
} from './testing';

const lap = (n: number) => `5eed0001-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (n: number) => new Date(Date.UTC(2026, 9, n, 8));

const route = (n: number, over: Partial<RouteRow>): RouteRow => ({
  run_id: lap(n),
  status: 'completed',
  started_at: day(n),
  route: 'simple',
  depth: 'normal',
  ...over,
});

const line = (n: number, position: number, over: Partial<CheckRow>): CheckRow => ({
  run_id: lap(n),
  position,
  kind: 'criterion',
  verdict: 'PASS',
  scenario_id: null,
  started_at: day(n),
  pr: `#${100 + n}`,
  ...over,
});

const holdout = (
  scenario_id: string,
  over: Partial<DefaultHoldoutRow> = {},
): DefaultHoldoutRow => ({
  at: new Date('2026-10-24T09:00:00Z'),
  sha: '3e4f5a6b',
  report_issue: 18,
  scenario_id,
  verdict: 'PASS',
  issue_number: null,
  issue_title: null,
  issue_state: null,
  issue_url: null,
  repository: 'coleam00/factory-mission-control',
  ...over,
});

test('laps group by route and depth, the largest first, a lap not yet picked kept', () => {
  const rows = [
    route(1, {}),
    route(2, { route: 'none', depth: 'light' }),
    route(3, {}),
    route(4, { route: null, depth: null, status: 'pending', started_at: null }),
  ];
  expect(routeMix(rows)).toEqual([
    { route: 'simple', depth: 'normal', laps: [lap(3), lap(1)] },
    { route: 'none', depth: 'light', laps: [lap(2)] },
    { route: null, depth: null, laps: [lap(4)] },
  ]);
});

test('app-check lines group by kind then verdict, each line with its lap and pull request', () => {
  const rows = [
    line(1, 3, { kind: 'probe', verdict: 'OK' }),
    line(1, 1, {}),
    line(1, 2, { kind: 'holdout', scenario_id: 'H-01' }),
    line(2, 1, {}),
    line(2, 2, { kind: 'holdout', verdict: 'FAIL', scenario_id: 'unidentified' }),
    line(2, 3, { kind: 'defect', verdict: 'DEFECT', pr: 'no pull request' }),
  ];
  expect(checkMix(rows).map((g) => [g.kind, g.verdict, g.lines])).toEqual([
    [
      'criterion',
      'PASS',
      [
        { run: lap(2), position: 1, pr: 102 },
        { run: lap(1), position: 1, pr: 101 },
      ],
    ],
    ['holdout', 'FAIL', [{ run: lap(2), position: 2, pr: 102 }]],
    ['holdout', 'PASS', [{ run: lap(1), position: 2, pr: 101 }]],
    ['probe', 'OK', [{ run: lap(1), position: 3, pr: 101 }]],
    ['defect', 'DEFECT', [{ run: lap(2), position: 3, pr: null }]],
  ]);
});

test('pull-request-time holdouts go by scenario id in number order, unidentified last', () => {
  const rows = [
    line(1, 1, { kind: 'holdout', verdict: 'FAIL', scenario_id: 'unidentified' }),
    line(1, 2, { kind: 'holdout', scenario_id: 'H-10' }),
    line(2, 1, { kind: 'holdout', verdict: 'FAIL', scenario_id: 'H-02' }),
    line(3, 1, { kind: 'holdout', scenario_id: 'H-02' }),
    line(3, 2, {}),
  ];
  expect(prHoldouts(rows).map((g) => [g.scenario, g.verdict, g.lines.map((l) => l.run)])).toEqual([
    ['H-02', 'FAIL', [lap(2)]],
    ['H-02', 'PASS', [lap(3)]],
    ['H-10', 'PASS', [lap(1)]],
    ['unidentified', 'FAIL', [lap(1)]],
  ]);
});

test("the default branch is the newest line's verdicts; failing is its FAILs only", () => {
  const h02 = holdout('H-02', { verdict: 'FAIL', issue_number: 14 });
  const h03 = holdout('H-03', { verdict: 'INCOMPLETE', issue_number: 15 });
  const branch = defaultBranch([holdout('H-04'), h03, h02, holdout('H-01')]);
  expect(branch?.sha).toBe('3e4f5a6b');
  expect(branch?.issue).toBe(18);
  expect(branch?.verdicts.map((v) => v.scenario_id)).toEqual(['H-01', 'H-02', 'H-03', 'H-04']);
  expect(branch?.failing).toEqual([h02]);
  expect(defaultBranch([])).toBeNull();
});
