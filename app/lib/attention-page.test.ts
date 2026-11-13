import { expect, test } from 'bun:test';
import type { Source } from '../live/Feed';
import { FACTORY_MAP } from '../map/factory-map';
import type { DecideRow, UnstickRow } from './attention';
import {
  type AttentionCard,
  attentionCount,
  byKind,
  byQueue,
  decideCards,
  ownerCards,
  QUEUE_OF_CARD,
  queueOf,
  releaseCommand,
  retriageCommand,
  sweepLine,
  unstickCards,
  unstickKey,
} from './attention-page';
import type { OwnerQueueRow } from './owner-queue';

const RUN = '5eed0005-0000-4000-8000-000000000001';
const CONSOLE_RUN = `http://localhost:3090/console/r/${RUN}`;

const decide = (overrides: Partial<DecideRow> = {}): DecideRow => ({
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
  message: [
    '**Build queue, issue 15: scope decision**',
    '**What it is.** Issue 15 asks for two screens.',
    '**Recommendation: `split`** (high confidence). Two small changes land sooner.',
  ].join('\n\n'),
  console: 'http://localhost:3090/',
  ...overrides,
});

const unstick = (overrides: Partial<UnstickRow>): UnstickRow => ({
  kind: 'blocked',
  number: 7,
  run_id: null,
  workflow_name: null,
  waits_on: '#6',
  since: new Date('2026-10-24T10:00:00Z'),
  action: 'retriage',
  repository: 'owner/repo',
  console: 'http://localhost:3090/',
  ...overrides,
});

test('attentionCount is unavailable on any error, loading until every query answers, else the sum', () => {
  const ready = (n: number): Source<object> => ({ rows: Array(n).fill({}), state: 'ready' });
  expect(attentionCount([ready(2), { rows: [{}], state: 'error' }])).toBe('unavailable');
  expect(attentionCount([ready(2), { rows: undefined, state: 'loading' }])).toBe('loading');
  expect(attentionCount([ready(2), ready(3)])).toBe(5);
});

test('the copied commands are the exact text the owner pastes', () => {
  expect(retriageCommand('o/r', 9)).toBe(
    'gh issue edit 9 --repo o/r --add-label archon-triage && archon workflow run archon-intake --input repo_host=github.com --input repo_path=o/r --input number=9 --input action=added --input label=archon-triage --input label_actor="$(gh api user --jq .login)" --detach',
  );
  expect(releaseCommand('o/r', 'archon-build-queue')).toBe(
    'archon workflow run archon-build-queue --input repo_host=github.com --input repo_path=o/r --detach',
  );
});

test('a question marks the recommended option only when it is one of the options, and appends Something else once', () => {
  const [card] = decideCards([decide()], 'f');
  expect(card?.tiles.filter((t) => t.recommended).map((t) => t.id)).toEqual(['split']);
  expect(card?.tiles.map((t) => t.label)).toEqual(['Split it', 'Build it', 'Something else']);
  expect(card?.tiles.every((t) => t.href === CONSOLE_RUN)).toBe(true);
  expect(card?.note.lead).toBe('Recommends Split it.');
  expect(card?.note.rest).toBe('Two small changes land sooner.');
  expect(card?.confidence).toBe('high confidence');

  const [stale] = decideCards([decide({ recommended: 'gone' })], 'f');
  expect(stale?.tiles.some((t) => t.recommended)).toBe(false);
  expect(stale?.note.lead).toBe('No recommendation.');

  const [own] = decideCards(
    [
      decide({
        options: JSON.stringify([{ id: 'other', label: 'Something else' }]),
        recommended: null,
      }),
    ],
    'f',
  );
  expect(own?.tiles.map((t) => t.label)).toEqual(['Something else']);
});

test('a structured wait renders its recommendation, why and effects from the fields, not the reworded message', () => {
  const [card] = decideCards(
    [
      decide({
        recommended: 'build',
        confidence: 'low',
        recommendation_why: 'One reviewer has both screens.',
        options: JSON.stringify([
          { id: 'split', label: 'Split it', description: 'Two issues.' },
          { id: 'build', label: 'Build it', description: 'One change.' },
        ]),
        message: '**Recommendation: `split`** (high confidence). Old reason.',
      }),
    ],
    'f',
  );
  expect(card?.note).toMatchObject({
    lead: 'Recommends Build it.',
    rest: 'One reviewer has both screens.',
  });
  expect(card?.confidence).toBe('low confidence');
  expect(card?.tiles.filter((t) => t.recommended).map((t) => t.id)).toEqual(['build']);
  expect(card?.tiles.slice(0, 2).map((t) => t.consequence)).toEqual(['Two issues.', 'One change.']);
  expect(card?.tiles.find((t) => t.id === 'build')?.answer?.request.option).toBe('build');

  const [legacy] = decideCards([decide({ recommendation_why: null })], 'f');
  expect(legacy?.note.rest).toBe('Two small changes land sooner.');
});

test('each option tile answers with its row occurrence, and every tile keeps its console link', () => {
  const [card] = decideCards([decide()], 'f');
  const split = card?.tiles.find((t) => t.id === 'split');
  expect(split?.answer).toEqual({
    request: {
      factory: 'f',
      action: 'answer',
      run_id: RUN,
      occurrence: 'p1',
      option: 'split',
      text: null,
    },
    item: 15,
  });
  expect(card?.tiles.every((t) => t.href === CONSOLE_RUN)).toBe(true);
});

test('"Something else" opens the text box only where the server can send text', () => {
  const tileFor = (row: DecideRow) =>
    decideCards([row], 'f')[0]?.tiles.find((t) => t.label === 'Something else');
  // No declared option, a select form: the synthetic tile stays a console link.
  expect(tileFor(decide())?.somethingElse).toBeUndefined();
  // No declared option, a message form: the text alone is the answer.
  expect(
    tileFor(decide({ form: 'message', options: '[]', recommended: null }))?.somethingElse,
  ).toMatchObject({ request: { option: null, text: null } });
  // A declared "Something else" option carries the text and is not an option answer.
  const declared = tileFor(
    decide({ options: JSON.stringify([{ id: 'other', label: 'Something else' }]) }),
  );
  expect(declared?.somethingElse).toBeDefined();
  expect(declared?.answer).toBeUndefined();
});

test('each unstick kind leads with its own primary action', () => {
  const cards = unstickCards(
    [
      unstick({ kind: 'blocked' }),
      unstick({ kind: 'parked', number: 8 }),
      unstick({
        kind: 'capacity',
        number: 9,
        run_id: RUN,
        workflow_name: 'archon-loop',
        action: 'resume',
        waits_on: 'a free slot',
      }),
      unstick({
        kind: 'claim',
        number: 10,
        run_id: RUN,
        workflow_name: 'archon-build-queue',
        action: 'release_claim',
        waits_on: 'a claim held by a finished run',
      }),
    ],
    'f',
  );
  const first = (kind: string) =>
    cards.find((c) => c.hooks['data-unstick-kind'] === kind)?.actions[0];
  expect(first('blocked')).toMatchObject({
    type: 'copy',
    command: retriageCommand('owner/repo', 7),
  });
  expect(first('parked')).toMatchObject({
    type: 'copy',
    command: retriageCommand('owner/repo', 8),
  });
  expect(first('capacity')).toMatchObject({
    type: 'act',
    variant: 'primary',
    request: { factory: 'f', action: 'resume', run_id: RUN, from_step: null },
    fallback: { href: CONSOLE_RUN, external: true },
  });
  expect(first('claim')).toMatchObject({
    type: 'copy',
    command: releaseCommand('owner/repo', 'archon-build-queue'),
  });
});

test('By queue holds exactly the cards By kind holds, and an unknown workflow lands in Other', () => {
  expect(queueOf('archon-merge-queue')).toBe('merge');
  expect(queueOf('archon-loop', 'review')).toBe('merge');
  expect(queueOf('archon-loop', 'ship/deliver/rounds/review')).toBe('build');
  expect(queueOf('archon-build-queue', 'ask')).toBe('build');
  expect(queueOf('archon-build-queue', 'no-such-step')).toBe('build');
  expect(queueOf('factory-app-check')).toBe('app-check');
  expect(queueOf('something-new')).toBe('other');
  expect(queueOf(null)).toBe('other');
  const cards: AttentionCard[] = [
    ...decideCards([decide()], 'f'),
    ...unstickCards([unstick({})], 'f'),
  ];
  const keys = (groups: { cards: AttentionCard[] }[]) =>
    groups.flatMap((g) => g.cards.map((c) => c.key)).sort();
  expect(keys(byQueue(cards))).toEqual(keys(byKind(cards)));
  expect(byQueue(cards).map((g) => g.queue)).toEqual(['intake', 'build']);
  expect(byKind(cards).map((g) => g.kind)).toEqual(['decide', 'unstick']);
});

test('By queue names real factory-map cards, and every card that covers a workflow has a queue or is listed as Other', () => {
  const ids = FACTORY_MAP.cards.map((c) => c.id);
  for (const id of Object.keys(QUEUE_OF_CARD)) expect(ids).toContain(id);
  const otherByDesign = ['mgr', 'deploy'];
  const unplaced = FACTORY_MAP.cards
    .filter((c) => c.covers.length > 0 && !(c.id in QUEUE_OF_CARD))
    .map((c) => c.id);
  expect(unplaced).toEqual(otherByDesign);
});

const question = (overrides: Partial<OwnerQueueRow> = {}): OwnerQueueRow => ({
  kind: 'question',
  issue_number: 12,
  question_number: 1,
  title: 'Which format?',
  url: 'https://github.com/o/r/issues/12',
  options: JSON.stringify([
    { key: 'A', text: 'JSON' },
    { key: 'B', text: 'YAML' },
  ]),
  recommendation: 'JSON is simpler.',
  default_option: 'B',
  default_at: new Date('2026-10-25T09:07:30Z'),
  waiting_since: new Date('2026-10-24T09:00:00Z'),
  approximate: false,
  ...overrides,
});

test('an owner question recommends only its default tile, and says when the default applies', () => {
  const [card] = ownerCards([question()]);
  expect(card?.tiles.map((t) => [t.id, t.recommended])).toEqual([
    ['A', false],
    ['B', true],
  ]);
  expect(card?.note).toEqual({
    lead: 'Default B applies 2026-10-25 09:07 UTC.',
    rest: 'JSON is simpler.',
  });
  expect(card?.tiles.map((t) => t.href)).toEqual([
    'https://github.com/o/r/issues/12',
    'https://github.com/o/r/issues/12',
  ]);
});

test('an owner question without a default says so and recommends no tile', () => {
  const [card] = ownerCards([question({ default_option: null, default_at: null })]);
  expect(card?.note.lead).toBe('No default.');
  expect(card?.tiles.some((t) => t.recommended)).toBe(false);
});

test('sweepLine says how long ago the manager swept, and drops the clause when it never did', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const swept = new Date('2026-10-24T08:48:00Z');
  expect(sweepLine('f', swept, now, 2)).toBe(
    'f. The manager swept 3h 12m ago and put its recommendation first on each.',
  );
  expect(sweepLine('f', null, now, 1)).toBe('f. The manager put its recommendation first on each.');
});

test('sweepLine makes no claim about items when there are none or the count is not known', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const swept = new Date('2026-10-24T08:48:00Z');
  for (const count of [0, 'loading', 'unavailable'] as const) {
    expect(sweepLine('f', swept, now, count)).toBe('f. The manager swept 3h 12m ago.');
    expect(sweepLine('f', null, now, count)).toBe('f.');
  }
});

test('an unstick card is keyed as unstickKey says, so the live phase finds it', () => {
  const rows = [
    unstick({}),
    unstick({
      kind: 'capacity',
      number: null,
      run_id: RUN,
      action: 'resume',
      workflow_name: 'archon-build-queue',
    }),
  ];
  expect(
    unstickCards(rows, 'f')
      .map((c) => c.key)
      .sort(),
  ).toEqual(rows.map(unstickKey).sort());
});
