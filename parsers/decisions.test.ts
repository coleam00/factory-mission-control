import { describe, expect, test } from 'bun:test';
import { parseDecisions } from './decisions';

const SAMPLE = `# Decisions

## 2026-10-20 Run the complex route through dev's ship-block
Decision: the complex route includes archon-ship-block from dev.
Why: complex laps were sent back twice as often as simple ones,
because the old block skipped the plan review.
Replaces: none
Version: abd85896

## 2026-10-22 Review reads handoff files
Decision: the reviewer reads the builder's handoff files.
Why: reviews repeated checks the builder had already run.
Replaces: 2026-10-20 Run the complex route through dev's ship-block
Version: c23d423f

## 2026-10-23 Show finished laps for an hour
Decision: the lanes panel keeps a finished lap, faded, for an hour.
Why: a merge that just happened is still visible.
Replaces: none
`;

describe('DECISIONS.md', () => {
  test('two well-formed entries and one missing Version:', () => {
    const { entries, errors } = parseDecisions(SAMPLE);
    expect(entries).toEqual([
      {
        date: '2026-10-20',
        title: "Run the complex route through dev's ship-block",
        decision: 'the complex route includes archon-ship-block from dev.',
        why: 'complex laps were sent back twice as often as simple ones, because the old block skipped the plan review.',
        replaces: 'none',
        version: 'abd85896',
      },
      {
        date: '2026-10-22',
        title: 'Review reads handoff files',
        decision: "the reviewer reads the builder's handoff files.",
        why: 'reviews repeated checks the builder had already run.',
        replaces: "2026-10-20 Run the complex route through dev's ship-block",
        version: 'c23d423f',
      },
    ]);
    expect(errors).toEqual([
      {
        entry: '2026-10-23 Show finished laps for an hour',
        line: 16,
        message: 'missing `Version:`',
      },
    ]);
  });

  test('a heading without a date is an error, not an entry', () => {
    const { entries, errors } = parseDecisions(
      '## Untitled\nDecision: a\nWhy: b\nReplaces: none\nVersion: abd85896\n',
    );
    expect(entries).toEqual([]);
    expect(errors.map((e) => e.entry)).toEqual(['Untitled']);
  });

  test('empty input', () => {
    expect(parseDecisions('')).toEqual({ entries: [], errors: [] });
  });
});
