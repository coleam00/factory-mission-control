/** How a review outcome reads: finished work, an open question for the owner, or nothing to color. */
export type ReviewTone = 'done' | 'owner' | 'plain';

/**
 * The old loop's review outcomes, keyed by the `outcome` enum in the pack's archon-loop.yaml, with
 * the tone each reads in. The lap page reads this table.
 */
export const REVIEW_TONE = {
  merge: 'done',
  approved: 'done',
  'sent-back': 'done',
  'needs-owner': 'owner',
  nothing: 'plain',
} as const satisfies Record<string, ReviewTone>;

export const TONE_TOKEN: Record<Exclude<ReviewTone, 'plain'>, `--${string}`> = {
  done: '--success',
  owner: '--role-person',
};

/** The token a review outcome is colored with; undefined for a plain or unknown outcome. */
export function reviewToken(outcome: string): `--${string}` | undefined {
  const tone: ReviewTone | undefined = (REVIEW_TONE as Record<string, ReviewTone>)[outcome];
  return tone === undefined || tone === 'plain' ? undefined : TONE_TOKEN[tone];
}
