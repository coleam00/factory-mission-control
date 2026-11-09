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
  fixCards,
  ownerCards,
  QUEUE_OF_CARD,
  queueOf,
  releaseCommand,
  retriageCommand,
  sweepLine,
  unstickCards,
  unstickKey,
} from './attention-page';
import type { FailureGroupRow } from './failures';
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

const group = (overrides: Partial<FailureGroupRow> = {}): FailureGroupRow => ({
  signature: 'sig',
  workflow_name: 'archon-loop',
  step_id: 'review',
  class: 'transient',
  failures: 3,
  first_at: new Date('2026-10-22T23:00:00Z'),
  last_at: new Date('2026-10-24T01:00:00Z'),
  latest_run_id: RUN,
  line: 'boom',
  last_day: new Date('2026-10-24'),
  daily: [0, 1, 2],
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
    type: 'link',
    variant: 'primary',
    href: CONSOLE_RUN,
    external: true,
  });
  expect(first('claim')).toMatchObject({
    type: 'copy',
    command: releaseCommand('owner/repo', 'archon-build-queue'),
  });
});

test('a Fix card says the count, the inclusive UTC days, the step and the class', () => {
  const [card] = fixCards([group()], 'f');
  expect(card?.age).toEqual({ text: '3 runs · 3 days' });
  expect(card?.title).toBe('Lap failed at review');
  expect(card?.meta).toContainEqual({ pill: 'transient', state: 'failed' });
  expect(card?.note.rest).toBe('It is transient: a retry usually passes.');
  expect(card?.actions[0]).toMatchObject({ href: `/f/f/runs/${RUN}`, external: false });
  const [queued] = fixCards([group({ workflow_name: 'archon-build-queue', step_id: 'ask' })], 'f');
  expect(queued?.actions[0]).toMatchObject({ href: `/f/f/runs/${RUN}`, external: false });

  const [bare] = fixCards([group({ step_id: null, class: null, failures: 1, line: null })], 'f');
  expect(bare?.title).toBe('Lap failed');
  expect(bare?.note).toEqual({
    lead: '1 failed run has this cause.',
    rest: 'It is not classified.',
  });
  expect(bare?.meta).toContainEqual({ pill: 'unclassified', state: 'failed' });
  expect(bare?.age).toEqual({ since: new Date('2026-10-24T01:00:00Z') });
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
    ...fixCards([group(), group({ signature: 'b', workflow_name: 'mystery' })], 'f'),
  ];
  const keys = (groups: { cards: AttentionCard[] }[]) =>
    groups.flatMap((g) => g.cards.map((c) => c.key)).sort();
  expect(keys(byQueue(cards))).toEqual(keys(byKind(cards)));
  expect(byQueue(cards).map((g) => g.queue)).toEqual(['intake', 'build', 'merge', 'other']);
  expect(byKind(cards).map((g) => g.kind)).toEqual(['decide', 'unstick', 'fix']);
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
  expect(sweepLine('f', new Date('2026-10-24T08:48:00Z'), now)).toBe(
    'f. The manager swept 3h 12m ago and put its recommendation first on each.',
  );
  expect(sweepLine('f', null, now)).toBe('f. The manager put its recommendation first on each.');
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
