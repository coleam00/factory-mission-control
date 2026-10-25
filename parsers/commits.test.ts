import { describe, expect, test } from 'bun:test';
import { parsePin, parseVerdict } from './commits';

// The literal pin and verdict commits from the PRD appendix.
const PIN = `Pin Archon abd85896: holdouts fenced in the repository; the complex route runs dev's ship-block

Hypothesis: complex laps finish faster and are sent back less.
Measure: complex-route lap-hours per merge and send-backs per merge, over at least 10 complex laps.`;

const VERDICT = `Record the verdict on abd85896

Verdict: abd85896 helped: complex laps took 1.4 lap-hours per merge against 2.6, over 12 laps.`;

describe('pin commits', () => {
  test('the appendix example', () => {
    expect(parsePin(PIN)).toEqual({
      archonSha: 'abd85896',
      reason: "holdouts fenced in the repository; the complex route runs dev's ship-block",
      hypothesis: 'complex laps finish faster and are sent back less.',
      measure:
        'complex-route lap-hours per merge and send-backs per merge, over at least 10 complex laps.',
    });
  });

  test('a pin without trailers', () => {
    expect(parsePin('Pin Archon c23d423f: review reads handoff files')).toEqual({
      archonSha: 'c23d423f',
      reason: 'review reads handoff files',
      hypothesis: null,
      measure: null,
    });
  });

  test('a commit that is not a pin returns null', () => {
    expect(parsePin(VERDICT)).toBeNull();
    expect(parsePin('Repin the factory to Archon c23d423f')).toBeNull();
    expect(parsePin('Pin Archon : no sha')).toBeNull();
  });
});

describe('verdict commits', () => {
  test('the appendix example', () => {
    expect(parseVerdict(VERDICT)).toEqual({
      pin: 'abd85896',
      verdict: 'helped',
      sentence: 'complex laps took 1.4 lap-hours per merge against 2.6, over 12 laps.',
    });
  });

  test('an unknown verdict or no trailer returns null', () => {
    expect(parseVerdict(VERDICT.replace('helped', 'maybe'))).toBeNull();
    expect(parseVerdict(PIN)).toBeNull();
  });
});
