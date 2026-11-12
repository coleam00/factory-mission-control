import { expect, test } from 'bun:test';
import type { Source } from '../live/Feed';
import { FACTORY_MAP } from '../map/factory-map';
import type { DecideRow, UnstickRow } from './attention';
import {
  type AttentionCard,
  ATTENTION_SOURCES,
  attentionCount,
  byKind,
  byQueue,
  decideCards,
  fixCards,
  ownerCards,
  QUEUE_OF_CARD,
  queueOf,
  RETRIED_QUERY,
  retriedLine,
  sweepLine,
  unstickCards,
  unstickKey,
} from './attention-page';
import type { FailureGroupRow } from './failures';
import { localMoment } from './format';
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
  item_title: 'Lanes and recent laps',
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
  title: null,
  blocker_titles: null,
  reason: null,
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

test('a question marks the recommended option only when it is one of the options, and appends Something else once', () => {
  const [card] = decideCards([decide()], 'f');
  expect(card?.tiles.filter((t) => t.recommended).map((t) => t.id)).toEqual(['split']);
  expect(card?.tiles.map((t) => t.label)).toEqual(['Split it', 'Build it', 'Something else']);
  expect(card?.tiles.every((t) => t.href === CONSOLE_RUN)).toBe(true);
  expect(card?.note.lead).toStartWith(
    `#15 “Lanes and recent laps” waits at ask for your answer since ${localMoment(new Date('2026-10-24T10:20:00Z'))}.`,
  );
  expect(card?.note.lead).toEndWith('. Recommends Split it.');
  expect(card?.note.rest).toBe('Two small changes land sooner.');
  expect(card?.confidence).toBe('high confidence');

  const [stale] = decideCards([decide({ recommended: 'gone' })], 'f');
  expect(stale?.tiles.some((t) => t.recommended)).toBe(false);
  expect(stale?.note.lead).toEndWith('There is no recommendation.');
  expect(stale?.note.rest).toBe('');

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
  expect(card?.note.lead).toEndWith('Recommends Build it.');
  expect(card?.note.rest).toBe('One reviewer has both screens.');
  expect(card?.confidence).toBe('low confidence');
  expect(card?.tiles.filter((t) => t.recommended).map((t) => t.id)).toEqual(['build']);
  expect(card?.tiles.map((t) => t.id)).toEqual(['build', 'split', 'something-else']);
  expect(card?.tiles.find((t) => t.id === 'build')?.act?.request).toMatchObject({
    option: 'build',
  });

  const [legacy] = decideCards([decide({ recommendation_why: null })], 'f');
  expect(legacy?.note.rest).toBe('Two small changes land sooner.');
});

test('each option tile answers with its row occurrence, and every tile keeps its console link', () => {
  const [card] = decideCards([decide()], 'f');
  const split = card?.tiles.find((t) => t.id === 'split');
  expect(split?.act).toEqual({
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

test('"Something else" opens the text box where a write takes the text, else the Manager’s box', () => {
  const tileFor = (row: DecideRow) =>
    decideCards([row], 'f')[0]?.tiles.find((t) => t.label === 'Something else');
  // No declared option, a select form: no write takes text, so the Manager's box opens.
  expect(tileFor(decide())?.somethingElse).toBeUndefined();
  expect(tileFor(decide())?.manager).toBeDefined();
  // No declared option, a message form: the text alone is the answer.
  expect(
    tileFor(decide({ form: 'message', options: '[]', recommended: null }))?.somethingElse,
  ).toMatchObject({ request: { option: null, text: null } });
  // A declared "Something else" option carries the text and is not an option answer.
  const declared = tileFor(
    decide({ options: JSON.stringify([{ id: 'other', label: 'Something else' }]) }),
  );
  expect(declared?.somethingElse).toBeDefined();
  expect(declared?.act).toBeUndefined();
});

const TILE_IDS = (card: AttentionCard | undefined) => card?.tiles.map((t) => t.id);

test('a parked item whose blocker closed offers Re-triage first, Close and Something else', () => {
  const [card] = unstickCards(
    [
      unstick({
        kind: 'parked',
        number: 454,
        waits_on: '#455',
        blocker_titles: ['Queue issue 455'],
        title: 'Queue issue 454',
        reason: 'Waits for #455 to merge',
      }),
    ],
    'f',
  );
  expect(TILE_IDS(card)).toEqual(['retriage', 'close', 'something-else']);
  expect(card?.tiles.map((t) => t.label)).toEqual([
    'Re-triage #454',
    'Close #454',
    'Something else',
  ]);
  expect(card?.tiles.map((t) => t.recommended)).toEqual([true, false, false]);
  expect(card?.tiles[0]?.act?.request).toEqual({ factory: 'f', action: 'retriage', number: 454 });
  expect(card?.tiles[1]?.act?.request).toEqual({ factory: 'f', action: 'close', number: 454 });
  expect(card?.tiles[2]?.somethingElse?.request).toEqual({
    factory: 'f',
    action: 'comment',
    number: 454,
    text: '',
  });
  expect(card?.tiles.every((t) => t.href === '/f/f/work/454')).toBe(true);
  expect(card?.tiles.every((t) => t.consequence !== undefined)).toBe(true);
  expect(card?.hooks['data-waits-on']).toBe('#455');
});

test('an unstick card names the blocker’s title and when it closed, and why the item was parked', () => {
  const since = new Date('2026-10-24T09:08:00Z');
  const [parked] = unstickCards(
    [
      unstick({
        kind: 'parked',
        number: 454,
        waits_on: '#455',
        blocker_titles: ['Queue issue 455'],
        reason: 'Waits for #455 to merge',
        since,
      }),
    ],
    'f',
  );
  expect(parked?.note.lead).toBe(`#455 “Queue issue 455” closed ${localMoment(since)}.`);
  expect(parked?.note.rest).toBe(
    '#454 was parked on it: “Waits for #455 to merge”. Nothing re-triages a parked item on its own.',
  );
  const [blocked] = unstickCards(
    [unstick({ waits_on: '#6, #7', blocker_titles: ['Six', ''], since })],
    'f',
  );
  expect(blocked?.note.lead).toBe(`#6 “Six”, #7 all closed by ${localMoment(since)}.`);
  expect(blocked?.note.rest).toContain('depends on #6, #7');
});

test('capacity offers Resume first, then the item’s writes; a claim leads with Re-triage', () => {
  const [capacity, claim, itemless] = unstickCards(
    [
      unstick({
        kind: 'capacity',
        number: 9,
        run_id: RUN,
        workflow_name: 'archon-loop',
        action: 'resume',
        waits_on: 'a free slot',
        since: new Date('2026-10-24T09:00:00Z'),
      }),
      unstick({
        kind: 'claim',
        number: 10,
        run_id: RUN,
        workflow_name: 'archon-build-queue',
        waits_on: 'a claim held by a finished run',
        since: new Date('2026-10-24T09:10:00Z'),
      }),
      unstick({
        kind: 'capacity',
        number: null,
        run_id: RUN,
        workflow_name: 'archon-loop',
        action: 'resume',
        waits_on: 'a free slot',
        since: new Date('2026-10-24T09:20:00Z'),
      }),
    ],
    'f',
  );
  expect(TILE_IDS(capacity)).toEqual(['resume', 'retriage', 'close', 'something-else']);
  expect(capacity?.tiles[0]).toMatchObject({
    recommended: true,
    href: CONSOLE_RUN,
    act: { request: { factory: 'f', action: 'resume', run_id: RUN, from_step: null } },
  });
  expect(capacity?.tiles[1]?.recommended).toBe(false);
  expect(TILE_IDS(claim)).toEqual(['retriage', 'close', 'something-else']);
  expect(claim?.tiles[0]?.recommended).toBe(true);
  expect(TILE_IDS(itemless)).toEqual(['resume', 'something-else']);
  expect(itemless?.tiles[1]?.manager).toBeDefined();
});

test('every card ends in Something else, and no card carries a copied command', () => {
  const owner: OwnerQueueRow = {
    kind: 'issue',
    issue_number: 12,
    question_number: null,
    title: 'Needs you',
    url: 'https://github.com/o/r/issues/12',
    options: null,
    recommendation: null,
    default_option: null,
    default_at: null,
    waiting_since: new Date('2026-10-24T08:00:00Z'),
    approximate: false,
  };
  const cards = [
    ...decideCards([decide(), decide({ form: 'select', options: '[]', recommended: null })], 'f'),
    ...ownerCards([owner, { ...owner, kind: 'question', question_number: 2, issue_number: 13 }]),
    ...unstickCards(
      [
        unstick({}),
        unstick({ kind: 'parked', number: 8 }),
        unstick({ kind: 'capacity', number: null, run_id: RUN, waits_on: 'a free slot' }),
        unstick({ kind: 'claim', number: 10, run_id: RUN, workflow_name: 'archon-build-queue' }),
      ],
      'f',
    ),
  ];
  expect(cards.length).toBeGreaterThan(5);
  for (const card of cards) {
    expect(card.tiles.at(-1)?.label, card.key).toBe('Something else');
    expect(JSON.stringify(card)).not.toMatch(/copy|archon workflow|"command"/);
    expect(card.actions.every((action) => action.type === 'link')).toBe(true);
  }
  const managerTiles = (key: string) => cards.find((c) => c.key.startsWith(key))?.tiles.at(-1);
  expect(managerTiles('owner:')?.manager).toBeDefined();
  expect(
    cards.filter((c) => c.key.startsWith('owner:')).every((c) => c.tiles.at(-1)?.manager),
  ).toBe(true);
});

test('the needs-owner issue recommends replying on GitHub, and a question links its options there', () => {
  const issue: OwnerQueueRow = {
    kind: 'issue',
    issue_number: 12,
    question_number: null,
    title: 'Needs you',
    url: 'https://github.com/o/r/issues/12',
    options: null,
    recommendation: null,
    default_option: null,
    default_at: null,
    waiting_since: new Date('2026-10-24T08:00:00Z'),
    approximate: false,
  };
  const [card] = ownerCards([issue]);
  expect(card?.tiles.map((t) => [t.label, t.recommended, t.href])).toEqual([
    ['Reply on GitHub', true, issue.url],
    ['Something else', false, issue.url],
  ]);
  expect(card?.note.lead).toBe(
    `#12 “Needs you” has been labelled needs-owner since ${localMoment(issue.waiting_since as Date)}.`,
  );
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
    ['B', true],
    ['A', false],
    ['something-else', false],
  ]);
  expect(card?.note).toEqual({
    lead: `#12 asks question 1 since ${localMoment(new Date('2026-10-24T09:00:00Z'))}. Default B applies ${localMoment(new Date('2026-10-25T09:07:30Z'))}.`,
    rest: 'JSON is simpler.',
  });
  expect(card?.tiles.map((t) => t.href)).toEqual(Array(3).fill('https://github.com/o/r/issues/12'));
});

test('an owner question without a default says so and recommends no tile', () => {
  const [card] = ownerCards([question({ default_option: null, default_at: null })]);
  expect(card?.note.lead).toEndWith('There is no default.');
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

test('retriedLine words one run and many, and the muted line is not an item source', () => {
  expect(retriedLine(1)).toBe(
    '1 run hit a passing database or GitHub error today and was retried.',
  );
  expect(retriedLine(3)).toBe(
    '3 runs hit a passing database or GitHub error today and were retried.',
  );
  expect(Object.values(ATTENTION_SOURCES).map((s) => s.query)).not.toContain(RETRIED_QUERY);
});
