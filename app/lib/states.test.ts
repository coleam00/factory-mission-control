import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { UNSTICK_KINDS } from './attention';
import { STOP_CLASSES } from './failures';
import { STATE_LABEL } from './lap-graph';
import { OUTCOMES } from './laps';
import { REVIEW_OUTCOMES } from './review-outcome';
import {
  CHECK_OVERALL_STATE,
  LAP_OUTCOME_STATE,
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
  QUEUE_REVIEW_STATE,
  GATE_OUTCOME_STATE,
  GATE_STATE,
  STOP_CLASS_STATE,
  stateOf,
  UNSTICK_STATE,
  SWEEP_ACTION_STATE,
} from './states';

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** The words of the `export const <name> = [...] as const` tuple a pack file declares. */
function packTuple(file: string, name: string): string[] {
  const text = readFileSync(`fixtures/pack/queue/sdlc/.shared/${file}`, 'utf8');
  const list = text.split(`export const ${name} = [`)[1]?.split(']')[0] ?? '';
  return sorted([...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
}

/** The quoted words in the first capture group of `pattern` over a file. */
function quoted(file: string, pattern: RegExp): string[] {
  const list = readFileSync(file, 'utf8').match(pattern)?.[1] ?? '';
  return sorted([...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''));
}

test('every value of every source maps to one of the five states', () => {
  for (const [name, map] of Object.entries(STATE_SOURCES))
    for (const [value, state] of Object.entries(map))
      expect(STATES, `${name}.${value}`).toContain(state);
});

test('a map holds exactly the values its source reads, so a new value fails here', () => {
  expect(sorted(Object.keys(LAP_OUTCOME_STATE))).toEqual(sorted(OUTCOMES));
  expect(sorted(Object.keys(REVIEW_OUTCOME_STATE))).toEqual(sorted(REVIEW_OUTCOMES));
  expect(sorted(Object.keys(UNSTICK_STATE))).toEqual(sorted(UNSTICK_KINDS));
  expect(sorted(Object.keys(STOP_CLASS_STATE))).toEqual(
    sorted([...STOP_CLASSES, 'mixed', 'unclassified']),
  );
  expect(sorted(Object.keys(STEP_STATE_STATE))).toEqual(sorted(Object.keys(STATE_LABEL)));
  expect(sorted(Object.keys(VERDICT_STATE))).toEqual(
    sorted(
      (
        readFileSync('fixtures/pack/sdlc/loop/archon-loop.yaml', 'utf8').match(
          /verdict: \{ type: string, enum: \[([^\]]+)\]/,
        )?.[1] ?? ''
      )
        .split(',')
        .map((v) => v.trim()),
    ),
  );
  expect(sorted(Object.keys(STEP_STATUS_STATE))).toEqual(
    quoted('db/migrations/0005_laps.sql', /status IN \(([^)]+)\)/),
  );
  const reviewActions = readFileSync(
    'fixtures/pack/queue/sdlc/review/archon-review-block.yaml',
    'utf8',
  ).match(/action:\s+type: string\s+enum: \[([^\]]+)\]/)?.[1];
  expect(sorted(Object.keys(QUEUE_REVIEW_STATE))).toEqual(
    sorted((reviewActions ?? '').split(',').map((v) => v.trim())),
  );
  // 'idle' picks no item and 'launch' throws in apply.ts before a row is written, so neither is an ending.
  expect(sorted(Object.keys(QUEUE_ENDING_STATE))).toEqual(
    packTuple('build.ts', 'APPLY_DECISIONS').filter((d) => d !== 'idle' && d !== 'launch'),
  );
  expect(sorted(Object.keys(SWEEP_ACTION_STATE))).toEqual(packTuple('merge.ts', 'SWEEP_ACTIONS'));
  expect(sorted(Object.keys(CHECK_OVERALL_STATE))).toEqual(
    sorted(
      (
        readFileSync('fixtures/pack/sdlc/loop/archon-loop.yaml', 'utf8').match(
          /overall: \{ type: string, enum: \[([^\]]+)\]/,
        )?.[1] ?? ''
      )
        .split(',')
        .map((v) => v.trim()),
    ),
  );
  const landed = readFileSync('fixtures/pack/sdlc/loop/scripts/land.ts', 'utf8');
  expect(sorted(Object.keys(GATE_STATE))).toEqual(
    sorted(new Set([...landed.matchAll(/emit\(\{ outcome: '([^']+)'/g)].map((m) => m[1] ?? ''))),
  );
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
  expect(QUEUE_ENDING_STATE.parked).toBe('idle');
  expect(STEP_STATUS_STATE.skipped).toBe('idle');
  expect(GATE_OUTCOME_STATE.merged).toBe('done');
  expect(VERDICT_STATE.PASS).toBe('done');
  expect(VERDICT_STATE.FAIL).toBe('failed');
  expect(VERDICT_STATE.INCOMPLETE).toBe('failed');
  expect(VERDICT_STATE.QUESTION).toBe('needs-you');
});

test('an unknown value has no state', () => {
  expect(stateOf(RUN_STATE, 'paused')).toBe('needs-you');
  expect(stateOf(RUN_STATE, 'toString')).toBeUndefined();
  expect(stateOf(RUN_STATE, null)).toBeUndefined();
});
