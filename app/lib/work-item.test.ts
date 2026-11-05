import { expect, test } from 'bun:test';
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
  number: null,
  title: null,
  url: null,
  console: null,
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

test('a merged decision the record step did not read back reads as not landed', () => {
  const decisions = [{ number: 410, action: 'merged', reason: 'ok' }];
  expect(texts([item, sweep({ decisions, landed: [410] })])).toContain('Merged');
  expect(texts([item, sweep({ decisions, landed: [] })])).toContain(
    `The merge did not land. ${NO_REASON}`,
  );
});

test('old-loop rounds link to their lap page, every other run to the console', () => {
  const loop = row({ workflow: 'archon-loop', run_id: RUN });
  const queue = row({ run_id: '5eed0005-0000-4000-8000-00000000000b' });
  const links = workItemTimeline([item, loop, queue], 'f').flatMap((e) =>
    e.run ? [e.run.link] : [],
  );
  expect(links).toEqual([
    { kind: 'lap', to: `/f/f/laps/${RUN}` },
    {
      kind: 'console',
      href: 'http://localhost:3090/console/r/5eed0005-0000-4000-8000-00000000000b',
    },
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
