/**
 * The old loop's review outcomes, as the `outcome` enum in the pack's archon-loop.yaml lists them.
 * The state each reads in is `REVIEW_OUTCOME_STATE` (states.ts).
 */
export const REVIEW_OUTCOMES = [
  'merge',
  'approved',
  'sent-back',
  'needs-owner',
  'nothing',
] as const;

export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
