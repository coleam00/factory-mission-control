import { describe, expect, test } from 'bun:test';
import {
  parseClaim,
  parseClaimReleased,
  parseDependsOn,
  parseOwnerQuestions,
  parsePhase,
  parseReview,
} from './comments';

// The literal examples from the PRD appendix.
const CLAIM = `Loop claim: run 4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c
Route: simple
Area: app/routes/lanes.tsx`;

const RELEASED =
  'Loop claim released: run 4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c ended. Its `Loop review:` comment, if any, says what it did.';

const MERGED =
  'Loop review: merged (route: simple) at 9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c by the merge gate, after the review above.';

const REFUSED = `Loop review: not merged (route: complex). The merge gate refused the reviewer's merge:

- it changes .claude/settings.json, which only the owner changes; the owner merges it by hand if it is intended

The next lap continues this pull request.`;

const SENT_BACK = 'Loop review: sent back (route: continue)';

const OWNER_QUESTIONS = `### Q3. Should the lanes panel show finished laps for an hour?
Options: A) yes, faded; B) no, only running laps.
Recommendation: A, so a merge that just happened is still visible.
If there is no answer by 2026-10-27 14:00 UTC, the loop will use A.`;

describe('claims', () => {
  test('a claim', () => {
    expect(parseClaim(CLAIM)).toEqual({
      runId: '4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c',
      route: 'simple',
      area: 'app/routes/lanes.tsx',
    });
  });

  test('a claim released', () => {
    expect(parseClaimReleased(RELEASED)).toEqual({
      runId: '4f1c2a9e-7b3d-4e8a-9c21-5d6e7f8a9b0c',
    });
  });

  test('a claim with CRLF line endings', () => {
    expect(parseClaim(CLAIM.replaceAll('\n', '\r\n'))?.area).toBe('app/routes/lanes.tsx');
  });

  test('malformed claims return null', () => {
    expect(parseClaim(RELEASED)).toBeNull();
    expect(parseClaim('Loop claim: run 4f1c2a9e\nRoute: simple\nArea: x')).toBeNull();
    expect(parseClaim(CLAIM.replace('Route: simple', 'Route: sideways'))).toBeNull();
    expect(parseClaim(CLAIM.replace('Area: app/routes/lanes.tsx', ''))).toBeNull();
    expect(parseClaimReleased(CLAIM)).toBeNull();
    expect(parseClaim('')).toBeNull();
  });
});

describe('reviews', () => {
  test('merged', () => {
    expect(parseReview(MERGED)).toEqual({
      outcome: 'merged',
      route: 'simple',
      sha: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
    });
  });

  test('not merged, with the reason', () => {
    expect(parseReview(REFUSED)).toEqual({
      outcome: 'refused',
      route: 'complex',
      reason:
        'it changes .claude/settings.json, which only the owner changes; the owner merges it by hand if it is intended',
    });
  });

  test('sent back', () => {
    expect(parseReview(SENT_BACK)).toEqual({ outcome: 'sent-back', route: 'continue' });
  });

  test('malformed reviews return null', () => {
    expect(parseReview('Loop review: merged (route: simple) at 9b8c7d6')).toBeNull();
    expect(parseReview('Loop review: not merged (route: complex).')).toBeNull();
    expect(parseReview('Loop review: sent back (route: elsewhere)')).toBeNull();
    expect(parseReview('Looks good to me')).toBeNull();
  });
});

describe('owner questions', () => {
  test('Q3', () => {
    expect(parseOwnerQuestions(OWNER_QUESTIONS)).toEqual([
      {
        number: 3,
        question: 'Should the lanes panel show finished laps for an hour?',
        options: [
          { key: 'A', text: 'yes, faded' },
          { key: 'B', text: 'no, only running laps' },
        ],
        recommendation: 'A, so a merge that just happened is still visible.',
        default: 'A',
        defaultAt: '2026-10-27T14:00:00Z',
      },
    ]);
  });

  test('one row per section, ignoring the prose around them', () => {
    const body = `# Owner decisions needed\n\nIntro text.\n\n${OWNER_QUESTIONS}\n\n${OWNER_QUESTIONS.replace('Q3', 'Q4')}\n\n## Answered\n\nnothing`;
    expect(parseOwnerQuestions(body).map((q) => q.number)).toEqual([3, 4]);
  });

  test('a section with garbled options is dropped', () => {
    expect(parseOwnerQuestions(OWNER_QUESTIONS.replace('A) yes', 'yes'))).toEqual([]);
  });
});

describe('issue body lines', () => {
  test('Depends on', () => {
    expect(parseDependsOn('Some text\n\nDepends on: #12\nDepends on: #14\n')).toEqual([12, 14]);
    expect(parseDependsOn('nothing here')).toEqual([]);
  });

  test('Phase', () => {
    expect(parsePhase('Phase: Owner queue\n\nSource: x')).toBe('Owner queue');
    expect(parsePhase('no phase')).toBeNull();
  });
});
