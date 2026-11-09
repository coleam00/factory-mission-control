/**
 * The Manager's fixed sentences about work that stopped. Attention's Unstick cards and the work
 * item page's note say the same thing the same way, so the words live here once. Pure, no React.
 */
import type { UnstickRow } from './attention';
import type { StopClass } from './failures';

/** What to know about work that stopped moving, by why it stopped: a bold lead, then the rest. */
export const UNSTICK_NOTE: Record<UnstickRow['kind'], { lead: string; rest: string }> = {
  blocked: {
    lead: 'The blocker is gone.',
    rest: 'A named build round refuses blocked items, so it waits for the next revisit unless you re-triage it.',
  },
  parked: {
    lead: 'What it was parked on has closed.',
    rest: 'A parked item waits until it is re-triaged.',
  },
  capacity: {
    lead: 'Answered, waiting for a free slot.',
    rest: 'Runs in this state do not always continue on their own; resuming once a slot frees moves it.',
  },
  claim: {
    lead: 'The run holding the claim has finished.',
    rest: 'A new run of its queue that names no item releases it.',
  },
};

/** A failure's class in a sentence; `mixed` is a group whose runs differ. */
export const CLASS_NOTE: Record<StopClass | 'mixed', string> = {
  transient: 'It is transient: a retry usually passes.',
  environment: 'It is the environment, not the code.',
  config: 'It is configuration: a binding, a schedule or a credential.',
  code: 'It is a code failure.',
  input: 'It is the input: the run was given something it could not use.',
  mixed: 'Its runs differ in class.',
};
