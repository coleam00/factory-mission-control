import { expect, test } from 'bun:test';
import type { ManagerEvent } from '../../server/manager-stream';
import {
  applyEvent,
  askAbout,
  endWithout,
  type HandledRow,
  handledLine,
  handledSummary,
  handledToday,
  managerHandledToday,
  historyFor,
  linkify,
  type ManagerContext,
  type ManagerLink,
  type ManagerMessage,
  MAX_MESSAGE_CHARS,
  managerPlace,
  postBriefing,
  postChat,
  readEvents,
  reply,
} from './manager';
import { lapHref } from './one-lap';
import { PLACES, placeAddress } from './places';
import { stepHref } from './step-detail';
import { workItemHref } from './work-item';

const RUN = '5eed0001-0000-4000-8000-0000000000a1';
const place = (path: string, query = '', what?: string) =>
  managerPlace(path, new URLSearchParams(query), what);

test('each address gives the context the Manager is asked with and the chip that says so', () => {
  expect(place('/f/x', '', '7 items')).toMatchObject({
    context: { place: 'attention' },
    chip: 'Attention · 7 items',
    questions: ['What failed overnight?', 'What did today cost?', 'What is stuck?'],
  });
  expect(place('/f/x').chip).toBe('Attention');
  expect(place('/f/x/map')).toMatchObject({
    context: { place: 'factory' },
    chip: 'Factory map',
    questions: [
      'How is the factory doing?',
      'Where is work piling up?',
      'Which step costs the most?',
    ],
  });
  expect(place('/f/x/board').chip).toBe('Board · pipeline');
  expect(place('/f/x/board', 'view=table').chip).toBe('Board · table');
  expect(place('/f/x/board', 'order=v3')).toMatchObject({
    context: { place: 'board', order: 'v3' },
    chip: 'Board · work order v3',
  });
  expect(place('/f/x/board', 'view=table').context).toEqual({ place: 'board' });
  expect(place('/f/x/runs')).toMatchObject({ context: { place: 'runs' }, chip: 'Runs · all' });
  expect(place('/f/x/runs', 'state=failed').chip).toBe('Runs · failed');
  expect(place(`/f/x/runs/${RUN.toUpperCase()}`)).toMatchObject({
    context: { place: 'run', run: RUN },
    chip: 'Run 5eed0001',
    questions: ['What is 5eed0001 about?'],
  });
  expect(place('/f/x/work/42')).toMatchObject({
    context: { place: 'work', item: 42 },
    chip: 'Work item #42',
  });
  expect(place('/f/x/steps/archon-loop/review%20one')).toMatchObject({
    context: { place: 'step', workflow: 'archon-loop', step: 'review one' },
    chip: 'Step review one',
  });
});

test('an address that names no run or item still names its place, and sends no id', () => {
  expect(place('/f/x/runs/not-a-uuid').context).toEqual({ place: 'run' });
  expect(place('/f/x/work/abc').context).toEqual({ place: 'work' });
  expect(place('/f/x/steps/wf').context).toEqual({ place: 'step', workflow: 'wf' });
  expect(place(`/f/x/steps/wf/${'s'.repeat(101)}`).context).toEqual({
    place: 'step',
    workflow: 'wf',
  });
  expect(place('/f/x/steps/wf/a%0Ab').context).toEqual({ place: 'step', workflow: 'wf' });
  expect(place('/f/x/board', `order=${'x'.repeat(101)}`).context).toEqual({ place: 'board' });
  expect(place(`/f/x/steps/${'w'.repeat(101)}/s`).context).toEqual({ place: 'step', step: 's' });
});

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

const collect = async (events: AsyncGenerator<ManagerEvent>) => {
  const out: ManagerEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

test('a line split across chunks and a last line without a newline both arrive whole', async () => {
  const events = await collect(
    readEvents(
      stream(
        '{"type":"text","te',
        'xt":"hi"}\n\n{"type":"done","cost_usd":0,',
        '"day_spent_usd":0,"day_cap_usd":5}',
      ),
    ),
  );
  expect(events.map((e) => e.type)).toEqual(['text', 'done']);
});

const answers = (status: number, body: BodyInit | null) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;
const request = { factory: 'x', context: { place: 'attention' as const }, messages: [] };

test('an unavailable Manager is said in a plain sentence, never nothing', async () => {
  const signal = new AbortController().signal;
  const unset = await postChat(
    request,
    signal,
    answers(503, '{"error":"the manager is not configured"}'),
  );
  expect(unset).toEqual({ failure: expect.stringContaining('not set up') });
  const refused = await postChat(request, signal, answers(400, '{"error":"too long\\nmore"}'));
  expect(refused).toEqual({ failure: 'The Manager refused the question: too long' });
  const down = await postBriefing('x', signal, (async () => {
    throw new TypeError('network');
  }) as unknown as typeof fetch);
  expect(down).toEqual({ failure: expect.stringContaining('could not be reached') });
});

test('an aborted request is not reported as a failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = (async () => {
    throw new DOMException('aborted', 'AbortError');
  }) as unknown as typeof fetch;
  await expect(postChat(request, controller.signal, aborted)).rejects.toThrow('aborted');
});

test('the history never exceeds the server limits, ends with the owner, and leaves action lines out', () => {
  const long: ManagerMessage[] = Array.from({ length: 30 }, (_, i) =>
    i % 2 === 0 ? { role: 'owner', text: 'q'.repeat(5000) } : reply('answer', 'a', 'done'),
  );
  const sent = historyFor(
    [...long, reply('action', 'Undone. Nothing was sent.', 'done'), reply('briefing')],
    'next',
  );
  expect(sent).toHaveLength(20);
  expect(sent.at(-1)).toEqual({ role: 'owner', text: 'next' });
  expect(
    sent.every((m) => m.text.length <= MAX_MESSAGE_CHARS && m.text !== 'Undone. Nothing was sent.'),
  ).toBe(true);
});

test('a stream builds one reply, and a stream cut before done says so', () => {
  const events: ManagerEvent[] = [
    { type: 'text', text: 'Run ' },
    { type: 'text', text: 'failed.' },
    { type: 'notice', kind: 'message-cap', text: 'Cap reached.' },
  ];
  const cut = events.reduce(applyEvent, reply('answer'));
  expect(cut).toMatchObject({ text: 'Run failed.', state: 'streaming', notices: ['Cap reached.'] });
  expect(endWithout(cut)).toMatchObject({ state: 'cut' });
  const done = applyEvent(cut, {
    type: 'done',
    cost_usd: 0,
    day_spent_usd: 0,
    day_cap_usd: 5,
    generated_at: '2026-11-09T10:00:00Z',
  });
  expect(endWithout(done)).toBe(done);
  expect(done.generatedAt).toBe('2026-11-09T10:00:00Z');
});

test('links go where the prose names them, and an unnamed link is left over', () => {
  const run: ManagerLink = { type: 'link', kind: 'run', id: RUN, href: '/r' };
  const item: ManagerLink = { type: 'link', kind: 'item', id: 514, href: '/w' };
  const other: ManagerLink = { ...item, id: 9 };
  const { segments, rest } = linkify('See #514 and run 5eed0001 now. #5140 is unrelated.', [
    item,
    run,
    other,
  ]);
  expect(segments).toEqual(['See ', item, ' and run ', run, ' now. #5140 is unrelated.']);
  expect(rest).toEqual([other]);
});

const row = (id: number, action: HandledRow['action'], at: Date): HandledRow => ({
  id,
  action,
  run_id: RUN,
  item_number: null,
  option: null,
  from_step: null,
  sent_at: at,
  exit_code: 0,
  workflow_name: null,
});

test('the handled line counts today only, and says it in plural and singular', () => {
  const noon = new Date(2026, 10, 9, 12).getTime();
  const rows = [
    row(1, 'resume', new Date(2026, 10, 9, 9)),
    row(2, 'resume', new Date(2026, 10, 9, 10)),
    row(3, 'answer', new Date(2026, 10, 9, 11)),
    row(4, 'answer', new Date(2026, 10, 8, 11)),
  ];
  const today = handledToday(rows, noon);
  expect(today.map((r) => r.id)).toEqual([1, 2, 3]);
  expect(handledSummary(today)).toBe('answered 1, resumed 2');
  expect(handledSummary(today.slice(0, 1))).toBe('resumed 1');
});

test('the handled line names who acted: you, then the manager, a side with nothing left out', () => {
  const at = new Date(2026, 10, 9, 9);
  const mine = [
    row(1, 'answer', at),
    row(2, 'retriage', at),
    row(3, 'close', at),
    row(4, 'comment', at),
  ];
  const managerRuns = [
    { run_id: RUN, completed_at: at, answered: 2 },
    { run_id: RUN, completed_at: at, answered: 1 },
  ];
  expect(handledSummary(mine)).toBe('answered 1, re-triaged 1, closed 1, commented on 1');
  expect(handledLine(mine.slice(0, 1), managerRuns.slice(0, 1))).toBe(
    'You answered 1 · the manager handled 2 today',
  );
  expect(handledLine([], managerRuns)).toBe('The manager handled 3 today');
  expect(handledLine(mine.slice(0, 1), [])).toBe('You answered 1 today');
  expect(handledLine([], [])).toBeNull();
  const noon = new Date(2026, 10, 9, 12).getTime();
  expect(
    managerHandledToday(
      [...managerRuns, { run_id: RUN, completed_at: new Date(2026, 10, 8, 9), answered: 4 }],
      noon,
    ),
  ).toHaveLength(2);
});

test('Ask manager looks at the run and work item it was pressed on', () => {
  expect(askAbout(RUN, 15)).toEqual({
    context: { place: 'attention', run: RUN, item: 15 },
    chip: 'Attention · #15',
  });
  expect(askAbout(RUN, null)).toEqual({
    context: { place: 'attention', run: RUN },
    chip: 'Attention · run 5eed0001',
  });
  expect(askAbout(null, null)).toEqual({ context: { place: 'attention' }, chip: 'Attention' });
});

test('every address the app writes is read back as the place it names', () => {
  const factory = 'my factory';
  const at = (href: string) =>
    managerPlace(href.split('?')[0] ?? href, new URLSearchParams(), undefined);
  for (const { path } of PLACES) {
    const expected: ManagerContext['place'] = {
      '': 'attention',
      map: 'factory',
      board: 'board',
      runs: 'runs',
    }[path] as ManagerContext['place'];
    expect(at(placeAddress(factory, path)).context.place).toBe(expected);
  }
  expect(at(lapHref(factory, RUN)).context).toEqual({ place: 'run', run: RUN });
  expect(at(workItemHref(factory, 42)).context).toEqual({ place: 'work', item: 42 });
  expect(at(stepHref(factory, 'archon-loop', 'review one')).context).toEqual({
    place: 'step',
    workflow: 'archon-loop',
    step: 'review one',
  });
});

test("a run's questions follow its state, and stop or resume is asked only of a stopped run", () => {
  const questions = (state?: string) => place(`/f/x/runs/${RUN}`, '', state).questions;
  expect(questions('completed')).toEqual([
    'What did 5eed0001 change?',
    'What did 5eed0001 cost, and why?',
  ]);
  for (const stopped of ['failed', 'paused', 'cancelled']) {
    expect(questions(stopped)).toEqual([
      'Why did 5eed0001 stop?',
      'Is it safe to resume 5eed0001?',
    ]);
  }
  for (const live of ['running', 'pending']) {
    expect(questions(live)).toEqual([
      'What is 5eed0001 doing now?',
      'What has 5eed0001 cost so far?',
    ]);
  }
  for (const other of ['completed', 'running', 'pending', undefined, 'toString']) {
    expect(questions(other).join(' ')).not.toMatch(/stop|resume/);
  }
});
