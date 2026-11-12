import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { decideCards, fixCards, ownerCards, unstickCards } from '../lib/attention-page';
import type { DecideRow, UnstickRow } from '../lib/attention';
import type { FailureGroupRow, RetriedRunRow } from '../lib/failures';
import type { HandledRow } from '../lib/manager';
import type { OwnerQueueRow } from '../lib/owner-queue';
import type { Source } from '../live/Feed';
import type { Action } from '../lib/attention-page';
import { ActionControl, AttentionBody, RetriedRuns } from './Attention';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const RUN = '5eed0005-0000-4000-8000-000000000001';

const ready = <Row,>(rows: Row[]): Source<Row> => ({ rows, state: 'ready' });

const decide: DecideRow = {
  run_id: RUN,
  workflow_name: 'archon-build-queue',
  node_id: 'ask',
  occurrence_id: 'p1',
  waiting_since: new Date('2026-10-24T10:20:00Z'),
  form: 'select',
  options: JSON.stringify([
    { id: 'split', label: 'Split it' },
    { id: 'build', label: 'Build it' },
  ]),
  labels: '{"build":"scope"}',
  recommended: 'split',
  confidence: 'high',
  recommendation_why: null,
  item_number: 15,
  item_title: 'Lanes and recent laps',
  message: '**What it is.** Two screens.\n\n**Recommendation: `split`** (high confidence). Sooner.',
  console: 'http://localhost:3090/',
};
const owner: OwnerQueueRow = {
  kind: 'issue',
  issue_number: 17,
  question_number: null,
  title: 'Pick a license',
  url: 'https://github.com/o/r/issues/17',
  options: null,
  recommendation: null,
  default_option: null,
  default_at: null,
  waiting_since: new Date('2026-10-24T09:00:00Z'),
  approximate: false,
};
const stuck: UnstickRow = {
  kind: 'blocked',
  number: 7,
  run_id: null,
  workflow_name: null,
  waits_on: '#6',
  since: new Date('2026-10-24T08:00:00Z'),
  action: 'retriage',
  title: 'Seven',
  blocker_titles: ['Six'],
  reason: null,
  console: 'http://localhost:3090/',
  open: true,
};
const failure: FailureGroupRow = {
  signature: 'sig',
  workflow_name: 'archon-loop',
  step_id: 'review',
  class: 'code',
  failures: 2,
  first_at: new Date('2026-10-23T10:00:00Z'),
  last_at: new Date('2026-10-24T10:00:00Z'),
  latest_run_id: RUN,
  line: 'boom',
  last_day: new Date('2026-10-24'),
  daily: [0, 1, 1],
  console: 'http://localhost:3090/',
};

const handledRow = (id: number, action: HandledRow['action'], sent_at: Date): HandledRow => ({
  id,
  action,
  run_id: RUN,
  item_number: null,
  option: null,
  from_step: null,
  sent_at,
  exit_code: 0,
  workflow_name: 'factory-manager',
});

const none = ready<never>([]);
const render = (props: Partial<Parameters<typeof AttentionBody>[0]> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AttentionBody
        factory="f"
        decide={none}
        owner={none}
        unstick={none}
        failures={none}
        sweep={none}
        now={NOW}
        {...props}
      />
    </MemoryRouter>,
  );

test('with nothing waiting the head says so and no group is drawn', () => {
  const html = render();
  expect(html).toContain('Nothing needs you');
  expect(html).toContain('data-attention-count="0"');
  expect(html).not.toContain('<h2');
});

test('the head counts every card, and the groups come in the order Decide, Unstick, Fix', () => {
  const html = render({
    decide: ready([decide]),
    owner: ready([owner]),
    unstick: ready([stuck]),
    failures: ready([failure]),
  });
  expect(html).toContain('4 things need you');
  expect(html).toContain('data-attention-count="4"');
  expect(html.match(/data-attention-kind=/g)?.length).toBe(4);
  const headers = [...html.matchAll(/<h2[^>]*>(Decide|Unstick|Fix)/g)].map((m) => m[1]);
  expect(headers).toEqual(['Decide', 'Unstick', 'Fix']);
});

test('one item reads "1 thing needs you"', () => {
  expect(render({ unstick: ready([stuck]) })).toContain('1 thing needs you');
});

test('a card draws its parts in the README order: dot, title, age, meta, note, options, actions', () => {
  const html = render({ decide: ready([decide]) });
  const at = (needle: string) => html.indexOf(needle);
  const order = [
    '<span aria-hidden="true" class="inline-block',
    'data-title',
    'data-waited',
    'archon-build-queue',
    'waits at ask for your answer',
    'data-choice',
    'Open #15',
  ];
  const positions = order.map(at);
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(html).toContain('data-recommended=""');
  expect(html).toContain('high confidence');
});

test('an errored source says so, draws none of its stale rows, and the other groups still draw', () => {
  const html = render({
    decide: { rows: [decide], state: 'error' },
    unstick: ready([stuck]),
  });
  expect(html).toContain('What needs you');
  expect(html).toContain('Live data for what is waiting on you is unavailable.');
  expect(html).not.toContain('data-choice="split"');
  expect(html).toContain('data-unstick-kind="blocked"');
  expect(html).not.toContain('data-attention-count=');
});

test('By queue draws the same cards under queue headers', () => {
  const props = { decide: ready([decide]), unstick: ready([stuck]), failures: ready([failure]) };
  const html = render({ ...props, view: 'queue' });
  const headers = [
    ...html.matchAll(/<h2[^>]*>(Intake|Build|Merge|App check|Discoveries|Other)/g),
  ].map((m) => m[1]);
  expect(headers).toEqual(['Intake', 'Build', 'Merge']);
  const keys = (h: string) =>
    [...h.matchAll(/data-attention-item="([^"]+)"/g)].map((m) => m[1]).sort();
  expect(keys(html)).toEqual(keys(render(props)));
});

test('the recommendation span holds the text alone, so the separator is not read as part of it', () => {
  const question: OwnerQueueRow = {
    ...owner,
    kind: 'question',
    question_number: 2,
    options: JSON.stringify([
      { key: 'A', text: 'Ship it' },
      { key: 'B', text: 'Hold' },
    ]),
    recommendation: 'Ship it: the fix is small.',
    default_option: 'A',
    default_at: new Date('2026-10-25T09:00:00Z'),
  };
  const html = render({ owner: ready([question]) });
  expect(html).toContain('</b> <span data-recommendation="true">Ship it: the fix is small.</span>');
});

test('the head says when the manager swept, and leaves the clause out without a finished manager run', () => {
  const swept = new Date(NOW - 12 * 60_000);
  expect(render({ sweep: ready([{ swept_at: swept }]) })).toContain(
    'f. The manager swept 12m ago and put its recommendation first on each.',
  );
  for (const sweep of [
    ready([{ swept_at: null }]),
    ready([]),
    { rows: [{ swept_at: swept }], state: 'error' } as const,
  ]) {
    expect(render({ sweep })).toContain('f. The manager put its recommendation first on each.');
  }
});

test('before the server says an operator exists, every write tile stays a link and nothing is copied', () => {
  const html = render({ decide: ready([decide]), unstick: ready([stuck]) });
  expect(html).not.toContain('data-answer-box');
  expect(html).toMatch(/<a (?=[^>]*data-choice="retriage")(?=[^>]*href="\/f\/f\/work\/7")[^>]*>/);
  expect(html).toMatch(/<a [^>]*data-choice="split"/);
  expect(html).not.toMatch(/<button[^>]*data-choice="(retriage|close|split|build)"/);
  expect(html).not.toContain('data-command');
  expect(html).not.toContain('Copy');
});

test('an unstick card says what it waits on and ends in Re-triage, Close and Something else', () => {
  const html = render({ unstick: ready([stuck]) });
  expect(html).toContain('#6 “Six” closed');
  const labels = [...html.matchAll(/data-choice="([^"]+)"/g)].map((m) => m[1]);
  expect(labels).toEqual(['retriage', 'close', 'something-else']);
  expect(html).toContain('Re-triage #7');
  expect(html).toContain('Close #7');
});

test('every card offers Ask manager, and the handled line counts only the actions of today', () => {
  const html = render({
    decide: ready([decide]),
    failures: ready([failure]),
    handled: ready([
      handledRow(1, 'resume', new Date(NOW - 60_000)),
      handledRow(2, 'resume', new Date(NOW - 2 * 86_400_000)),
    ]),
  });
  expect(html.match(/data-ask-manager/g)?.length).toBe(2);
  expect(html).toContain('You resumed 1 today.');
  const failed = render({
    handled: { rows: [handledRow(1, 'resume', new Date(NOW - 60_000))], state: 'error' },
  });
  expect(failed).not.toContain('data-handled');
});

test('the handled line names who acted: your actions, then what the manager answered on its own', () => {
  const html = render({
    handled: ready([handledRow(1, 'answer', new Date(NOW - 60_000))]),
    managerHandled: ready([
      { run_id: RUN, completed_at: new Date(NOW - 120_000), answered: 2 },
      { run_id: RUN, completed_at: new Date(NOW - 3 * 86_400_000), answered: 5 },
    ]),
  });
  expect(html).toContain('You answered 1 · the manager handled 2 today.');
  const managerOnly = render({
    managerHandled: ready([{ run_id: RUN, completed_at: new Date(NOW - 60_000), answered: 1 }]),
  });
  expect(managerOnly).toContain('The manager handled 1 today.');
});

test('the handled sentence counts only the actions that went through', () => {
  const refused = { ...handledRow(2, 'resume', new Date(NOW - 30_000)), exit_code: 1 };
  const unknown = { ...handledRow(3, 'resume', new Date(NOW - 20_000)), exit_code: null };
  const mixed = render({
    handled: ready([handledRow(1, 'resume', new Date(NOW - 60_000)), refused, unknown]),
  });
  expect(mixed).toContain('You resumed 1 today.');
  const none = render({ handled: ready([refused]) });
  expect(none).toContain('None of your actions today went through.');
  const pending = render({ handled: ready([unknown]) });
  expect(pending).toContain('None of your actions today is confirmed yet.');
  expect(pending).not.toContain('went through');
  expect(pending).not.toContain('background:var(--v3-done)');
});

test('Ask manager on each kind of card carries that card’s run and work item', () => {
  expect(decideCards([decide], 'f')[0]?.ask.context).toEqual({
    place: 'attention',
    run: RUN,
    item: 15,
  });
  expect(ownerCards([owner])[0]?.ask.context).toEqual({ place: 'attention', item: 17 });
  expect(unstickCards([stuck], 'f')[0]?.ask.context).toEqual({ place: 'attention', item: 7 });
  expect(fixCards([failure], 'f')[0]?.ask.context).toEqual({ place: 'attention', run: RUN });
});

test('a console link opens in a new tab, and an in-app link stays in the dashboard tab', () => {
  const link = (external: boolean): Action => ({
    type: 'link',
    variant: 'secondary',
    label: 'Go',
    href: '/x',
    external,
    hooks: {},
  });
  const draw = (external: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <ActionControl action={link(external)} />
      </MemoryRouter>,
    );
  expect(draw(true)).toContain('target="_blank"');
  expect(draw(true)).toContain('rel="noreferrer"');
  expect(draw(false)).not.toContain('target=');
});

const retriedRow = (id: number, line: string | null): RetriedRunRow => ({
  run_id: `5eed0000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  workflow_name: 'archon-merge-queue',
  step_id: 'facts',
  line,
  stopped_at: new Date(NOW - id * 60_000),
});

test('retried blips are one muted line that opens their list, and the head counts only cards', () => {
  const rows = [
    retriedRow(1, "Couldn't connect to compute node"),
    retriedRow(2, null),
    retriedRow(3, 'x'),
  ];
  const html = render({ failures: ready([failure]), retried: ready(rows) });
  expect(html).toContain('data-attention-count="1"');
  expect(html).toContain('1 thing needs you');
  expect(html).toContain('3 runs hit a passing database or GitHub error today and were retried.');
  expect(html).toContain('data-retried');
  expect(html).toMatch(/aria-expanded="false"[^>]*>See them/);
  expect(render({ retried: { rows, state: 'error' } })).not.toContain('data-retried');
  expect(render({ retried: ready([]) })).not.toContain('data-retried');

  const list = renderToStaticMarkup(
    <MemoryRouter>
      <RetriedRuns factory="f" rows={rows} />
    </MemoryRouter>,
  );
  expect(list).toContain('compute node');
  expect(list.match(/href="\/f\/f\/runs\//g)?.length).toBe(3);
});
