import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { DecideRow, UnstickRow } from '../lib/attention';
import type { FailureGroupRow } from '../lib/failures';
import type { OwnerQueueRow } from '../lib/owner-queue';
import type { Source } from '../live/Feed';
import { AttentionBody } from './Attention';

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
  item_number: 15,
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
  repository: 'o/r',
  console: 'http://localhost:3090/',
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
    'Recommends',
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
  expect(html).not.toContain('data-choice');
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
    'f. The manager swept 12m ago. The manager put its recommendation first on each.',
  );
  for (const sweep of [
    ready([{ swept_at: null }]),
    ready([]),
    { rows: [{ swept_at: swept }], state: 'error' } as const,
  ]) {
    expect(render({ sweep })).toContain('f. The manager put its recommendation first on each.');
  }
});
