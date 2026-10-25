import { describe, expect, test } from 'bun:test';
import { holdoutId, parseHoldoutsLine, parseMetricsLine } from './metrics';

// The literal `Loop metrics` lines from the PRD appendix.
const METRICS =
  '2026-10-25T14:20Z | merged since last pass: 4 (simple 2, complex 1, continue 1) | open PRs: 2 | loop send-backs since last pass: 1 | merge-gate refusals: 0 | ship correction rounds: 2 | needs-owner open: 1 | owner questions open: 2 | default branch checks: green (CI) | laps since last pass: 9 (empty 2, failed 0) | health actions: 1';
const HOLDOUTS =
  '2026-10-25T14:20Z | holdouts at 3e4f5a6b: H-01 PASS, H-02 FAIL #41, H-03 INCOMPLETE #42';

describe('metrics line', () => {
  test('the appendix example', () => {
    expect(parseMetricsLine(METRICS)).toEqual({
      at: '2026-10-25T14:20Z',
      merged: { total: 4, simple: 2, complex: 1, continue: 1 },
      openPrs: 2,
      sendBacks: 1,
      gateRefusals: 0,
      correctionRounds: 2,
      needsOwnerOpen: 1,
      ownerQuestionsOpen: 2,
      defaultBranchChecks: 'green (CI)',
      laps: { total: 9, empty: 2, failed: 0 },
      healthActions: 1,
    });
  });

  test('a holdouts line is not a metrics line', () => {
    expect(parseMetricsLine(HOLDOUTS)).toBeNull();
  });

  test('a missing or garbled measure returns null', () => {
    expect(parseMetricsLine(METRICS.replace(' | health actions: 1', ''))).toBeNull();
    expect(parseMetricsLine(METRICS.replace('open PRs: 2', 'open PRs: two'))).toBeNull();
    expect(parseMetricsLine(METRICS.replace('2026-10-25T14:20Z', 'yesterday'))).toBeNull();
    expect(parseMetricsLine('')).toBeNull();
  });
});

describe('holdouts line', () => {
  test('the appendix example: sha and ids with verdicts, no other field', () => {
    const parsed = parseHoldoutsLine(HOLDOUTS);
    expect(parsed).toEqual({
      at: '2026-10-25T14:20Z',
      sha: '3e4f5a6b',
      holdouts: [
        { id: 'H-01', verdict: 'PASS', issue: null },
        { id: 'H-02', verdict: 'FAIL', issue: 41 },
        { id: 'H-03', verdict: 'INCOMPLETE', issue: 42 },
      ],
    });
    expect(Object.keys(parsed ?? {})).toEqual(['at', 'sha', 'holdouts']);
    for (const h of parsed?.holdouts ?? []) {
      expect(Object.keys(h)).toEqual(['id', 'verdict', 'issue']);
    }
  });

  test('a metrics line is not a holdouts line', () => {
    expect(parseHoldoutsLine(METRICS)).toBeNull();
  });

  test('scenario text in place of a verdict is refused, not carried', () => {
    expect(parseHoldoutsLine(HOLDOUTS.replace('H-01 PASS', 'H-01 the lane moves'))).toBeNull();
  });
});

describe('holdout id', () => {
  test('the first H-<nn> and nothing else of the line', () => {
    expect(holdoutId('H-07 the lane moves')).toBe('H-07');
    expect(holdoutId('step 3: H-12 then H-13')).toBe('H-12');
  });

  test('a line with no id is unidentified', () => {
    expect(holdoutId('the lane moves')).toBe('unidentified');
    expect(holdoutId('')).toBe('unidentified');
  });

  test('the returned value never contains the line text', () => {
    for (const line of ['H-07 the lane moves', 'the lane moves', 'see H-07: the lane moves']) {
      expect(holdoutId(line)).not.toContain('lane');
    }
  });
});
