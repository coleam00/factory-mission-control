/**
 * The five states of Mission Control v3 (docs/design/v3/README.md "States") and the one place a
 * state gets its name and color. Every run, step, work item and question value the dashboard reads
 * maps here to exactly one state, and every screen colors a state through `stateColor`,
 * `stateWash` or `stateInk`, never by picking a token itself. Pure, no React.
 */
import type { GateOutcome, MapRightNowRow } from '../map/live';
import type { UnstickRow } from './attention';
import type { StopClass } from './failures';
import type { StepState } from './lap-graph';
import type { Outcome } from './laps';
import type { ReviewOutcome } from './review-outcome';

export const STATES = ['running', 'needs-you', 'failed', 'done', 'idle'] as const;

export type State = (typeof STATES)[number];

export const STATE_NAME: Record<State, string> = {
  running: 'Running',
  'needs-you': 'Needs you',
  failed: 'Failed',
  done: 'Done',
  idle: 'Idle',
};

type V3Token = `--v3-${string}`;

/** A state's mark: its dot, bar or fill. */
export const STATE_COLOR: Record<State, V3Token> = {
  running: '--v3-live',
  'needs-you': '--v3-you',
  failed: '--v3-failed',
  done: '--v3-done',
  idle: '--v3-idle',
};

/** A state's pill fill. */
export const STATE_WASH: Record<State, V3Token> = {
  running: '--v3-live-wash',
  'needs-you': '--v3-you-wash',
  failed: '--v3-failed-wash',
  done: '--v3-done-wash',
  idle: '--v3-idle-wash',
};

/** A state's text: the mark color, except where the mockup lifts it to stay legible on dark. */
export const STATE_INK: Record<State, V3Token> = {
  running: '--v3-live',
  'needs-you': '--v3-you-2',
  failed: '--v3-failed',
  done: '--v3-done',
  idle: '--v3-fg-2',
};

export const stateColor = (state: State) => `var(${STATE_COLOR[state]})`;
export const stateWash = (state: State) => `var(${STATE_WASH[state]})`;
export const stateInk = (state: State) => `var(${STATE_INK[state]})`;

/** The state of a value a row carries as a plain string; undefined for a value no map knows. */
export function stateOf(
  map: Readonly<Record<string, State>>,
  value: string | null | undefined,
): State | undefined {
  return value == null || !Object.hasOwn(map, value) ? undefined : map[value];
}

/** Archon's run status: a vocabulary Archon owns, so nothing in this repository binds it. */
export const RUN_STATE: Record<
  'pending' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled',
  State
> = {
  pending: 'idle',
  running: 'running',
  paused: 'needs-you',
  failed: 'failed',
  completed: 'done',
  cancelled: 'idle',
};

/** A step attempt's status (the CHECK list in db/migrations/0005_laps.sql). */
export const STEP_STATUS_STATE: Record<'running' | 'completed' | 'failed' | 'skipped', State> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  skipped: 'idle',
};

/** What happened to a step in a lap. */
export const STEP_STATE_STATE: Record<StepState, State> = {
  finished: 'done',
  running: 'running',
  failed: 'failed',
  skipped: 'idle',
  'not-reached': 'idle',
};

/** A lap's outcome. A send-back is done work. */
export const LAP_OUTCOME_STATE: Record<Outcome, State> = {
  merged: 'done',
  'sent-back': 'done',
  'gate-refused': 'failed',
  'needs-owner': 'needs-you',
  nothing: 'idle',
  failed: 'failed',
};

/** The old loop's review outcome. */
export const REVIEW_OUTCOME_STATE: Record<ReviewOutcome, State> = {
  merge: 'done',
  approved: 'done',
  'sent-back': 'done',
  'needs-owner': 'needs-you',
  nothing: 'idle',
};

/** How a build queue round ended. */
export const QUEUE_ENDING_STATE: Record<'ready' | 'continue' | 'asked' | 'parked', State> = {
  ready: 'done',
  continue: 'done',
  asked: 'needs-you',
  parked: 'idle',
};

/** A build queue round's review. */
export const QUEUE_REVIEW_STATE: Record<'none' | 'correct' | 'replan' | 'ask', State> = {
  none: 'done',
  correct: 'done',
  replan: 'done',
  ask: 'needs-you',
};

/** The merge gate's decision on a lap (the outcomes `land.ts` emits). */
export const GATE_STATE: Record<'merged' | 'refused', State> = {
  merged: 'done',
  refused: 'failed',
};

/**
 * A check line's verdict, every value the pack's `check-app` schema allows
 * (fixtures/pack/sdlc/loop/archon-loop.yaml). INCOMPLETE counts against the merge gate like FAIL
 * (`blocksPass`, `failure` in merge-gate.ts), a QUESTION waits on the owner.
 */
export const VERDICT_STATE: Record<
  'PASS' | 'FAIL' | 'INCOMPLETE' | 'OK' | 'SURPRISE' | 'DEFECT' | 'QUESTION',
  State
> = {
  PASS: 'done',
  OK: 'done',
  FAIL: 'failed',
  INCOMPLETE: 'failed',
  SURPRISE: 'failed',
  DEFECT: 'failed',
  QUESTION: 'needs-you',
};

/** The check's overall verdict, the `overall` enum of the pack's check-app schema. NO PR is no check ran. */
export const CHECK_OVERALL_STATE: Record<'PASS' | 'FAIL' | 'NO PR', State> = {
  PASS: 'done',
  FAIL: 'failed',
  'NO PR': 'idle',
};

/** The merge sweep's decision on a pull request (SWEEP_ACTIONS in fixtures/pack/queue/sdlc/.shared/merge.ts). */
export const SWEEP_ACTION_STATE: Record<'merged' | 'return' | 'ask' | 'wait', State> = {
  merged: 'done',
  return: 'done',
  ask: 'needs-you',
  wait: 'idle',
};

/** What the merge gate did with a pull request, on the factory map. */
export const GATE_OUTCOME_STATE: Record<GateOutcome['outcome'], State> = {
  merged: 'done',
  'sweep: sent back': 'done',
  'sweep: asked': 'needs-you',
};

/** A deploy's status on the factory map. */
export const DEPLOY_STATE: Record<NonNullable<MapRightNowRow['status']>, State> = {
  verified: 'done',
  deployed: 'done',
  failed: 'failed',
};

/** A chip on a factory map card. */
export const MAP_CHIP_STATE: Record<'here' | 'queued' | 'failing' | 'waiting' | 'merged', State> = {
  here: 'running',
  queued: 'idle',
  failing: 'failed',
  waiting: 'needs-you',
  merged: 'done',
};

/** An Unstick card: work waiting on something else is idle, work waiting for a slot is Needs you because the owner resumes it once a slot frees. */
export const UNSTICK_STATE: Record<UnstickRow['kind'], State> = {
  blocked: 'idle',
  parked: 'idle',
  capacity: 'needs-you',
  claim: 'idle',
};

/** A Fix card's cause: every stop class is a failure; a run with no stop record is unclassified. */
export const STOP_CLASS_STATE: Record<StopClass | 'mixed' | 'unclassified', State> = {
  transient: 'failed',
  environment: 'failed',
  config: 'failed',
  code: 'failed',
  input: 'failed',
  mixed: 'failed',
  unclassified: 'failed',
};

/** Every map above, named once, so the test can hold each to a declared state. */
export const STATE_SOURCES: Record<string, Record<string, State>> = {
  RUN_STATE,
  STEP_STATUS_STATE,
  STEP_STATE_STATE,
  LAP_OUTCOME_STATE,
  REVIEW_OUTCOME_STATE,
  QUEUE_ENDING_STATE,
  QUEUE_REVIEW_STATE,
  GATE_STATE,
  VERDICT_STATE,
  CHECK_OVERALL_STATE,
  SWEEP_ACTION_STATE,
  GATE_OUTCOME_STATE,
  DEPLOY_STATE,
  MAP_CHIP_STATE,
  UNSTICK_STATE,
  STOP_CLASS_STATE,
};
