import { expect, test } from 'bun:test';
import { GATE_STATE, SWEEP_ACTION_STATE } from './states';
import { NO_REASON, type WorkItemRow, workItemHeader, workItemTimeline } from './work-item';

const RUN = '5eed0005-0000-4000-8000-000000000009';
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

const item = row({
  kind: 'item',
  run_id: null,
  workflow: null,
  status: 'open',
  started_at: at('08:00'),
  completed_at: null,
  number: 7,
  title: 'A title',
  url: 'https://github.com/o/r/issues/7',
  console: 'http://localhost:3090',
});

const sweep = (over: Partial<WorkItemRow>) =>
  row({
    kind: 'sweep',
    run_id: '5eed0005-0000-4000-8000-00000000000a',
    workflow: 'archon-merge-queue',
    pr: 410,
    decision_at: at('11:00'),
    ...over,
  });

const texts = (rows: WorkItemRow[]) => workItemTimeline(rows, 'f').map((e) => e.text);

test('events run oldest first, and a tie reads in the order the story is told', () => {
  const rows = [
    row({ review: 'none', review_at: at('09:00'), deliveries: '1' }),
    { ...item, started_at: at('09:00') },
  ];
  expect(texts(rows)).toEqual(['Filed', 'Review: Ready', 'Round 1: 1 delivery, 0:09:00']);
});

test('a refusal or a return with no reason says so in one sentence', () => {
  const refused = row({
    workflow: 'archon-loop',
    decision: 'refused',
    reason: '  ',
    decision_at: at('09:05'),
  });
  const returned = sweep({
    decisions: [{ number: 410, action: 'return', reason: '', brief: '' }],
  });
  const events = workItemTimeline([item, refused, returned], 'f');
  expect(events.find((e) => e.text.startsWith('Merge gate'))?.text).toBe(
    `Merge gate refused. ${NO_REASON}`,
  );
  const back = events.find((e) => e.text.startsWith('Returned'));
  expect(back?.text).toBe(`Returned to Build: ${NO_REASON}`);
  expect(back?.detail).toBe('No brief was recorded.');
});

test('a sweep that decided on another pull request adds nothing', () => {
  const rows = [
    item,
    sweep({ decisions: [{ number: 999, action: 'return', reason: 'x', brief: 'y' }] }),
  ];
  expect(texts(rows)).toEqual(['Filed']);
});

test('a pull request the record step read back as merged shows Merged whatever the sweep decided', () => {
  const decisions = [{ number: 410, action: 'return', reason: 'x', brief: 'y' }];
  const shown = texts([item, sweep({ decisions, landed: [410], record_status: 'completed' })]);
  expect(shown).toContain('Merged');
  expect(shown.some((t) => t.startsWith('Returned to Build'))).toBe(false);
});

test('a merged decision reads as landed, merging, or not landed by the record step', () => {
  const decisions = [{ number: 410, action: 'merged', reason: 'ok' }];
  expect(texts([item, sweep({ decisions, landed: [410], record_status: 'completed' })])).toContain(
    'Merged',
  );
  for (const record_status of [null, 'running'])
    expect(
      texts([
        item,
        sweep({ decisions, landed: null, record_status, status: 'running', completed_at: null }),
      ]),
    ).toContain('Merging');
  const notReadBack = 'Merged, not read back: the run ended before checking it.';
  for (const status of ['failed', 'cancelled'])
    expect(texts([item, sweep({ decisions, status, record_status: null })])).toContain(notReadBack);
  expect(texts([item, sweep({ decisions, landed: null, record_status: 'failed' })])).toContain(
    notReadBack,
  );
  expect(texts([item, sweep({ decisions, landed: [], record_status: 'completed' })])).toContain(
    `The merge did not land. ${NO_REASON}`,
  );
});

test('a cancelled intake run reads as cancelled, neither finished nor running', () => {
  for (const completed_at of [null, at('08:05')]) {
    const cancelled = row({ workflow: 'archon-intake', status: 'cancelled', completed_at });
    expect(texts([item, cancelled])).toEqual(['Filed', 'Intake cancelled']);
  }
});

test('an old-loop review of approved or nothing reads, and nothing is a round with nothing to do', () => {
  const loop = (review: string) =>
    row({
      workflow: 'archon-loop',
      route: 'simple',
      depth: 'normal',
      review,
      review_at: at('09:05'),
      started_at: at('09:00'),
    });
  expect(texts([item, loop('approved')])).toContain('Review: approved');
  expect(texts([item, loop('nothing')])).toEqual([
    'Filed',
    'Round 1: nothing to do',
    'Review: nothing to do',
  ]);
});

test('a build-queue round shows its review and its re-review verdicts', () => {
  const rows = [
    item,
    row({ review: 'correct', review_at: at('09:03'), rereview: 'none', rereview_at: at('09:06') }),
  ];
  expect(texts(rows).slice(2)).toEqual(['Review: fixes requested', 'Re-review: Ready']);
});

test('a build-queue round colors its ending and its review by the state map', () => {
  const tones = (over: Partial<WorkItemRow>) =>
    workItemTimeline([item, row(over)], 'f')
      .slice(1)
      .map((e) => e.tone);
  expect(tones({ decision: 'asked' })).toEqual(['needs-you']);
  expect(tones({ decision: 'parked' })).toEqual(['idle']);
  expect(tones({ decision: 'ready' })).toEqual(['done']);
  expect(tones({ review: 'ask', review_at: at('09:03') })).toContain('needs-you');
  expect(tones({ review: 'correct', review_at: at('09:03') })).toContain('done');
});

test('a failed round names its card, and its error is its stop line', () => {
  const failed = row({
    status: 'failed',
    failed_step: 'ship__deliver__rounds.review__policy',
    error: 'boom',
  });
  const [event] = workItemTimeline([item, failed], 'f').filter((e) => e.kind === 'round');
  expect(event?.text).toBe('Round 1 failed in Review');
  expect(event?.stop).toEqual({ step: 'ship__deliver__rounds.review__policy', line: 'boom' });
});

test('a stop record wins over the run error, and a long error gives its headline', () => {
  const stopOf = (over: Partial<WorkItemRow>) =>
    workItemTimeline([item, row({ status: 'failed', ...over })], 'f').find(
      (e) => e.kind === 'round',
    )?.stop;
  expect(
    stopOf({ failed_step: 'a', error: 'boom', stop_step: 'b', stop_line: '401 unauthorized' }),
  ).toEqual({ step: 'b', line: '401 unauthorized' });
  expect(
    stopOf({ failed_step: 'a', error: 'node failed\nerror: disk full\n  at x (y:1)' }),
  ).toEqual({
    step: 'a',
    line: 'disk full',
  });
  expect(stopOf({})).toEqual({ step: null, line: NO_REASON });
});

test('a round waiting on you asks its question, or says it waits, and a done round has no stop', () => {
  const stopOf = (over: Partial<WorkItemRow>) =>
    workItemTimeline([item, row(over)], 'f').find((e) => e.kind === 'round')?.stop;
  const waiting = { waiting: true, completed_at: null, status: 'running', stop_step: 'ask' };
  expect(stopOf({ ...waiting, stop_line: '**Build queue, issue 15: scope decision**' })).toEqual({
    step: 'ask',
    line: 'Asking: Build queue, issue 15: scope decision',
  });
  expect(stopOf(waiting)).toEqual({ step: 'ask', line: 'Waiting on you' });
  expect(stopOf({})).toBeNull();
});

test('the app check reads its tally by kind and verdict, with a tone from the overall', () => {
  const lines = ['a', 'b'].map(() =>
    row({ kind: 'line', line_kind: 'spec', line_verdict: 'PASS', workflow: null }),
  );
  const loop = (check_overall: string) =>
    row({ workflow: 'archon-loop', check_overall, check_at: at('09:05') });
  const events = (overall: string) =>
    workItemTimeline([item, loop(overall), ...lines], 'f').filter((e) => e.kind === 'check');
  expect(events('PASS')[0]).toMatchObject({ tone: 'done', text: 'App check PASS: 2 spec PASS' });
  expect(events('FAIL')[0]).toMatchObject({ tone: 'failed', text: 'App check FAIL: 2 spec PASS' });
});

test('an owner answer shows on the pull request it was asked about only', () => {
  const answered = { answer: 'merge it', answer_summary: 'ok', answer_at: at('12:00') };
  const mine = sweep({ decisions: [], asked_pr: '410', ...answered });
  const other = sweep({ decisions: [], asked_pr: '999', ...answered });
  expect(texts([item, mine])).toContain('You answered: merge it');
  expect(workItemTimeline([item, mine], 'f').find((e) => e.kind === 'answer')).toMatchObject({
    tone: 'done',
  });
  expect(texts([item, other])).toEqual(['Filed']);
});

test('a sweep ask shows as asked only on the pull request the record step raised', () => {
  const decisions = [
    { number: 410, action: 'ask', reason: 'which one?' },
    { number: 411, action: 'ask', reason: 'which one?' },
  ];
  const asked = (pr: number) => sweep({ pr, decisions, asked_pr: '410' });
  expect(texts([item, asked(410)])).toContain('Asked you: which one?');
  expect(
    workItemTimeline([item, asked(410)], 'f').find((e) => e.text.startsWith('Asked you')),
  ).toMatchObject({ tone: 'needs-you' });
  expect(texts([item, asked(411)])).toEqual(['Filed']);
});

test('every run links to its run page', () => {
  const loop = row({ workflow: 'archon-loop', run_id: RUN });
  const queue = row({ run_id: '5eed0005-0000-4000-8000-00000000000b' });
  const links = workItemTimeline([item, loop, queue], 'f').flatMap((e) =>
    e.run ? [e.run.link] : [],
  );
  expect(links).toEqual([
    { kind: 'lap', to: `/f/f/runs/${RUN}` },
    { kind: 'lap', to: '/f/f/runs/5eed0005-0000-4000-8000-00000000000b' },
  ]);
});

test('a running build-queue round says which stage it is in', () => {
  const running = row({
    status: 'running',
    completed_at: null,
    steps: ['ship__deliver__rounds.review__policy'],
  });
  const [, round] = workItemTimeline([item, running], 'f');
  expect(round).toMatchObject({
    tone: 'running',
    stage: 'review',
    text: 'Round 1: running, now in Review',
  });
});

test('the header links the issue and the newest run in the console', () => {
  expect(workItemHeader([item, row({})])).toEqual({
    number: 7,
    title: 'A title',
    issueUrl: 'https://github.com/o/r/issues/7',
    latestRunHref: `http://localhost:3090/console/r/${RUN}`,
  });
  expect(workItemHeader([row({})])).toBeNull();
});

test('the header opens a merge-queue run that is newer than every build run', () => {
  const SWEEP = '5eed0005-0000-4000-8000-000000000014';
  const merge = sweep({
    run_id: SWEEP,
    started_at: at('13:55'),
    decisions: [{ number: 410, action: 'wait', reason: 'checks pending', brief: '' }],
  });
  expect(workItemHeader([item, row({}), merge])?.latestRunHref).toBe(
    `http://localhost:3090/console/r/${SWEEP}`,
  );
});

test('the header skips a newer sweep the timeline does not show for this item', () => {
  const other = sweep({
    started_at: at('13:55'),
    decisions: [{ number: 999, action: 'return', reason: 'x', brief: 'y' }],
  });
  const unraised = sweep({
    started_at: at('13:56'),
    decisions: [{ number: 410, action: 'ask', reason: 'which?', brief: '' }],
    asked_pr: null,
  });
  expect(workItemHeader([item, row({}), other, unraised])?.latestRunHref).toBe(
    `http://localhost:3090/console/r/${RUN}`,
  );
});

test('an intake with two route labels reads the route the Board shows', () => {
  const intake = row({
    workflow: 'archon-intake',
    labels: ['archon-investigate', 'archon-ready'],
  });
  expect(texts([item, intake])).toEqual(['Filed', 'Intake: route deliver']);
});

test('every merge gate decision and sweep action the state owner names yields a timeline event', () => {
  for (const decision of Object.keys(GATE_STATE))
    expect(
      workItemTimeline(
        [item, row({ workflow: 'archon-loop', decision, decision_at: at('10:00'), reason: 'r' })],
        'f',
      ).filter((e) => e.kind === 'decision'),
      `gate ${decision}`,
    ).not.toHaveLength(0);
  for (const action of Object.keys(SWEEP_ACTION_STATE))
    expect(
      workItemTimeline(
        [
          item,
          sweep({
            decisions: [{ number: 410, action, reason: 'r', brief: 'b' }],
            asked_pr: '410',
          }),
        ],
        'f',
      ).filter((e) => e.kind === 'decision'),
      `sweep ${action}`,
    ).not.toHaveLength(0);
});
