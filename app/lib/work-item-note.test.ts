import { expect, test } from 'bun:test';
import type { DecideRow, UnstickRow } from './attention';
import { COLUMNS, type ItemOnBoard } from './board';
import { consoleUrl } from './one-lap';
import type { WorkItemRow } from './work-item';
import { workItemNote } from './work-item-note';

const CONSOLE = 'http://localhost:3090';
const RUN = '5eed0005-0000-4000-8000-000000000009';
const OLDER = '5eed0005-0000-4000-8000-000000000001';
const at = (clock: string) => new Date(`2026-10-13T${clock}:00Z`);

const row = (over: Partial<WorkItemRow>): WorkItemRow => ({
  kind: 'run',
  run_id: RUN,
  workflow: 'archon-build-queue',
  status: 'completed',
  started_at: at('09:00'),
  completed_at: at('09:09'),
  lap: true,
  waiting: false,
  cost: null,
  steps: null,
  failed_step: null,
  error: null,
  route: null,
  depth: null,
  labels: null,
  deliveries: null,
  review: null,
  review_at: null,
  rereview: null,
  rereview_at: null,
  check_overall: null,
  check_at: null,
  decision: null,
  reason: null,
  decision_at: null,
  answer: null,
  answer_summary: null,
  answer_at: null,
  line_kind: null,
  line_verdict: null,
  pr: null,
  decisions: null,
  landed: null,
  asked_pr: null,
  record_status: null,
  number: null,
  title: null,
  url: null,
  console: null,
  stop_step: null,
  stop_line: null,
  stop_class: null,
  ...over,
});

const item = (over: Partial<WorkItemRow> = {}) =>
  row({
    kind: 'item',
    run_id: null,
    workflow: null,
    status: 'open',
    started_at: at('08:00'),
    completed_at: null,
    number: 7,
    title: 'A title',
    url: 'https://github.com/o/r/issues/7',
    console: CONSOLE,
    ...over,
  });

const unstick = (over: Partial<UnstickRow>): UnstickRow => ({
  kind: 'capacity',
  number: 7,
  run_id: RUN,
  workflow_name: 'archon-build-queue',
  waits_on: 'a slot',
  since: at('10:00'),
  action: 'resume',
  title: null,
  blocker_titles: null,
  reason: null,
  console: CONSOLE,
  open: true,
  sent_action: null,
  sent_at: null,
  ...over,
});

const board = (id: string): ItemOnBoard => ({
  column: COLUMNS.find((c) => c.id === id) ?? null,
  blocked: false,
  pr: null,
  prUrl: null,
  workOrders: [],
});

const say = (note: ReturnType<typeof workItemNote>) =>
  note?.parts.map((p) => (p.bold ? `**${p.mono ? `\`${p.text}\`` : p.text}**` : p.text)).join('');

const failedRun = row({
  status: 'failed',
  failed_step: 'ship__prepare',
  stop_step: 'pr__prepare',
  stop_line: '401 unauthorized',
  stop_class: 'config',
});

test('a closed item with a Merged decision is Merged, and any other closed item is Done', () => {
  const merged = row({ workflow: 'archon-loop', decision: 'merged', decision_at: at('09:08') });
  const note = workItemNote([item({ status: 'closed' }), failedRun, merged], null, [unstick({})]);
  expect(note).toMatchObject({ state: 'done', pill: 'Merged', action: null });
  expect(say(note)).toBe('**Merged.** Nothing is left to do on it.');
  const other = workItemNote([item({ status: 'closed' }), failedRun], null, []);
  expect(other).toMatchObject({ state: 'done', pill: 'Done' });
  expect(say(other)).toBe('**Closed.** Nothing is left to do on it.');
});

test('a waiting newest run beats an older failed one, and offers the console answer', () => {
  const old = row({ ...failedRun, run_id: OLDER, started_at: at('07:00') });
  const waiting = row({
    waiting: true,
    status: 'running',
    completed_at: null,
    stop_step: 'ship__ask',
    stop_line: '**Build queue, issue 15: scope decision**',
  });
  const note = workItemNote([item(), old, waiting], null, []);
  expect(note).toMatchObject({ state: 'needs-you', pill: 'Needs you' });
  expect(say(note)).toBe(
    '**Waiting for your answer** at **`ship__ask`**: Build queue, issue 15: scope decision.',
  );
  expect(note?.action).toEqual({
    kind: 'answer',
    label: 'Answer the question',
    href: consoleUrl(CONSOLE, RUN),
    runId: RUN,
    step: 'ship__ask',
    request: null,
    toast: { item: 7, label: '' },
  });
  const bare = workItemNote([item(), row({ waiting: true, completed_at: null })], null, []);
  expect(say(bare)).toBe('**Waiting for your answer.** Its question is in the console.');
});

test('an Unstick row beats a failed run and uses the Attention wording', () => {
  const note = workItemNote([item(), failedRun], null, [unstick({ number: 99 }), unstick({})]);
  expect(say(note)).toBe(
    '**Answered, waiting for a free slot.** Runs in this state do not always continue on their own; resuming once a slot frees moves it.',
  );
  expect(note?.action).toMatchObject({
    kind: 'resume',
    label: 'Resume 5eed0005',
    href: consoleUrl(CONSOLE, RUN),
  });
  const blocked = workItemNote([item()], null, [
    unstick({ kind: 'blocked', waits_on: 'issue 3', action: 'retriage' }),
  ]);
  expect(say(blocked)).toBe(
    '**The blocker is gone.** A named build round refuses blocked items, so it waits for the next revisit unless you re-triage it. It was blocked on **issue 3**.',
  );
  expect(blocked?.action).toBeNull();
  const parked = workItemNote([item()], null, [
    unstick({ kind: 'parked', waits_on: 'issue 4', action: 'retriage' }),
  ]);
  expect(parked?.parts.at(-2)).toEqual({ text: 'issue 4', bold: true });
});

test('a failed run says where it stopped and why, and offers to resume from there', () => {
  const note = workItemNote([item(), failedRun], null, []);
  expect(note).toMatchObject({ state: 'failed', pill: 'Failed' });
  expect(say(note)).toBe(
    '**Round 1 failed** at **`pr__prepare`**. It is configuration: a binding, a schedule or a credential.',
  );
  expect(note?.action).toMatchObject({
    kind: 'resume',
    label: 'Resume from pr__prepare',
    href: consoleUrl(CONSOLE, RUN),
    step: 'pr__prepare',
  });
});

test('a failed run with no stop record falls back to its failed step and is not classified', () => {
  const bare = row({ status: 'failed', failed_step: 'ship__prepare' });
  const note = workItemNote([item(), bare], null, []);
  expect(say(note)).toBe('**Round 1 failed** at **`ship__prepare`**. It is not classified.');
  expect(note?.action?.label).toBe('Resume from ship__prepare');
  const none = workItemNote([item(), row({ status: 'failed' })], null, []);
  expect(none?.action?.label).toBe('Resume 5eed0005');
});

test('no console means no action, and an intake run is not numbered as a round', () => {
  const note = workItemNote(
    [item({ console: null }), row({ ...failedRun, workflow: 'archon-intake' })],
    null,
    [],
  );
  expect(say(note)).toContain('**Intake failed**');
  expect(note?.action).toBeNull();
});

test('a running newest run says it is running', () => {
  const running = row({ status: 'running', completed_at: null });
  const note = workItemNote([item(), running], null, []);
  expect(say(note)).toBe('**Round 1 is running.**');
  expect(note).toMatchObject({ state: 'running', pill: 'Running', action: null });
});

test('with no run to speak of, the board column speaks, and an item off the board says so', () => {
  const columns: [string, string, string, string][] = [
    ['queued', 'idle', 'Queued', '**Queued.** The build queue takes it when a slot frees.'],
    ['build', 'idle', 'Waiting', '**In Build**, with the build queue.'],
    ['merge', 'idle', 'Waiting', '**In Merge**, with the merge queue.'],
    ['decision', 'needs-you', 'Needs you', '**Waiting on you.** Its question is on Attention.'],
    ['parked', 'idle', 'Parked', '**Parked.** A parked item waits until it is re-triaged.'],
    ['merged', 'done', 'Merged', '**Merged.**'],
  ];
  for (const [id, state, pill, text] of columns) {
    const note = workItemNote([item()], board(id), []);
    expect(note, id).toMatchObject({ state, pill, action: null });
    expect(say(note), id).toBe(text);
  }
  const off = workItemNote([item()], null, []);
  expect(off).toMatchObject({ state: 'idle', pill: 'Waiting' });
  expect(say(off)).toBe('**Not on the board.** No queue holds it right now.');
});

test('no item row means no note', () => {
  expect(workItemNote([], null, [])).toBeNull();
});

const decideRow = (over: Partial<DecideRow> = {}): DecideRow => ({
  run_id: RUN,
  workflow_name: 'archon-build-queue',
  node_id: 'ship__ask',
  occurrence_id: 'pause-1',
  waiting_since: at('09:05'),
  form: 'select',
  options: JSON.stringify([{ id: 'split', label: 'Split it' }, { id: 'build' }]),
  labels: '{}',
  recommended: 'split',
  confidence: 'high',
  recommendation_why: null,
  item_number: 7,
  item_title: 'A title',
  message: 'Which?',
  console: CONSOLE,
  ...over,
});

const waitingRun = () =>
  row({ waiting: true, status: 'running', completed_at: null, stop_step: 'ship__ask' });

test('a question with a recommendation is answered in place with it', () => {
  const note = workItemNote([item(), waitingRun()], null, [], {
    decide: [decideRow()],
    factory: 'f',
  });
  expect(note?.action).toMatchObject({
    kind: 'answer',
    label: 'Answer "Split it"',
    href: consoleUrl(CONSOLE, RUN),
    request: {
      factory: 'f',
      action: 'answer',
      run_id: RUN,
      occurrence: 'pause-1',
      option: 'split',
      text: null,
    },
    toast: { item: 7, label: 'Split it' },
  });
});

test('a question with no usable recommendation stays the console link', () => {
  for (const decide of [
    [],
    [decideRow({ recommended: null })],
    [decideRow({ recommended: 'gone' })],
  ]) {
    const note = workItemNote([item(), waitingRun()], null, [], { decide, factory: 'f' });
    expect(note?.action).toMatchObject({ label: 'Answer the question', request: null });
  }
});

test('a recommended Something else option stays the console link', () => {
  const decide = [
    decideRow({
      options: JSON.stringify([
        { id: 'split', label: 'Split it' },
        { id: 'other', label: 'Something else' },
      ]),
      recommended: 'other',
    }),
  ];
  const note = workItemNote([item(), waitingRun()], null, [], { decide, factory: 'f' });
  expect(note?.action).toMatchObject({ label: 'Answer the question', request: null });
});

test('resuming names the failed step, or none for a run waiting for a slot', () => {
  const failed = workItemNote([item(), failedRun], null, [], { decide: [], factory: 'f' });
  expect(failed?.action?.request).toEqual({
    factory: 'f',
    action: 'resume',
    run_id: RUN,
    from_step: 'pr__prepare',
  });
  const capacity = workItemNote([item(), failedRun], null, [unstick({})], {
    decide: [],
    factory: 'f',
  });
  expect(capacity?.action?.request).toEqual({
    factory: 'f',
    action: 'resume',
    run_id: RUN,
    from_step: null,
  });
});
