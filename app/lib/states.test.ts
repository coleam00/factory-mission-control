import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { STATE_LABEL } from './lap-graph';
import { OUTCOMES } from './laps';
import { REVIEW_OUTCOMES } from './review-outcome';
import {
  BUILD_STATUS_STATE,
  LAP_OUTCOME_STATE,
  MERGE_STATUS_STATE,
  REVIEW_OUTCOME_STATE,
  RUN_STATE,
  STATE_COLOR,
  STATE_INK,
  STATE_SOURCES,
  STATE_WASH,
  STATES,
  STEP_STATE_STATE,
  STEP_STATUS_STATE,
  VERDICT_STATE,
  QUEUE_ENDING_STATE,
  GATE_OUTCOME_STATE,
  stateOf,
} from './states';

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** The literal union a pack file declares as `export type <name> = 'a' | 'b'`. */
function packUnion(file: string, name: string): string[] {
  const text = readFileSync(`fixtures/pack/queue/sdlc/.shared/${file}`, 'utf8');
  const union = text.match(new RegExp(`export type ${name} = ([^;]+);`))?.[1] ?? '';
  return sorted([...union.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
}

test('every value of every source maps to one of the five states', () => {
  for (const [name, map] of Object.entries(STATE_SOURCES))
    for (const [value, state] of Object.entries(map))
      expect(STATES, `${name}.${value}`).toContain(state);
});

test('a map holds exactly the values its source reads, so a new value fails here', () => {
  expect(sorted(Object.keys(LAP_OUTCOME_STATE))).toEqual(sorted(OUTCOMES));
  expect(sorted(Object.keys(REVIEW_OUTCOME_STATE))).toEqual(sorted(REVIEW_OUTCOMES));
  expect(sorted(Object.keys(STEP_STATE_STATE))).toEqual(sorted(Object.keys(STATE_LABEL)));
  expect(sorted(Object.keys(BUILD_STATUS_STATE))).toEqual(packUnion('build.ts', 'BuildStatus'));
  expect(sorted(Object.keys(MERGE_STATUS_STATE))).toEqual(packUnion('merge.ts', 'MergeStatus'));
});

test('every state color is a token the v3 design declares', () => {
  const css = readFileSync('docs/design/v3/tokens.css', 'utf8');
  for (const table of [STATE_COLOR, STATE_WASH, STATE_INK])
    for (const token of Object.values(table)) expect(css).toContain(`${token}:`);
});

test("the README's States examples hold", () => {
  expect(RUN_STATE.paused).toBe('needs-you');
  expect(RUN_STATE.pending).toBe('idle');
  expect(RUN_STATE.cancelled).toBe('idle');
  expect(BUILD_STATUS_STATE.parked).toBe('idle');
  expect(MERGE_STATUS_STATE.parked).toBe('idle');
  expect(QUEUE_ENDING_STATE.parked).toBe('idle');
  expect(STEP_STATUS_STATE.skipped).toBe('idle');
  expect(GATE_OUTCOME_STATE.merged).toBe('done');
  expect(VERDICT_STATE.PASS).toBe('done');
  expect(VERDICT_STATE.FAIL).toBe('failed');
});

test('an unknown value has no state', () => {
  expect(stateOf(RUN_STATE, 'paused')).toBe('needs-you');
  expect(stateOf(RUN_STATE, 'toString')).toBeUndefined();
  expect(stateOf(RUN_STATE, null)).toBeUndefined();
});
