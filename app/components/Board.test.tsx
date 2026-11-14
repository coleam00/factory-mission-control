import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { type BoardView, COLUMNS, PIPELINE, type WorkItem } from '../lib/board';
import { BoardBody } from './Board';

const longTitle = '.archon/workflows/factory-build-queue-with-an-unbroken-path-token.yaml';

const longChip = 'factory-build-queue-with-an-unbroken-order-name-token';

const bare = {
  round: 0,
  dots: [],
  run: null,
  returned: 0,
  mergedAt: null,
  stop: null,
  waits: null,
};

const empty: BoardView = {
  orders: [],
  columns: COLUMNS.map((c) => ({ ...c, items: [] })),
  pipeline: PIPELINE.map((spec) => ({ ...spec, items: [], pills: [] })),
  found: { filed: 0, tracked: 0, dropped: 0 },
  notInOrder: 0,
  older: 0,
  olderHref: null,
};

function render(view: BoardView, mode: 'pipeline' | 'table'): string {
  const router = createMemoryRouter([
    {
      path: '/',
      element: <BoardBody view={view} mode={mode} order={null} onOrder={() => {}} />,
    },
  ]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

test('a card title and an order chip with long unbroken tokens wrap inside their card', () => {
  const html = render(
    {
      ...empty,
      columns: [
        {
          id: 'merged',
          title: 'Merged',
          role: 'test',
          holder: 'test',
          items: [
            {
              ...bare,
              number: 441,
              title: longTitle,
              chips: [{ kind: 'order', text: longChip }],
              to: '/f/x/work/441',
            },
          ],
        },
      ],
    },
    'table',
  );
  const title = html.match(/<span class="([^"]*)">\.archon\/workflows/);
  expect(title?.[1]).toContain('[overflow-wrap:anywhere]');
  const chip = html.match(/<span data-chip="order" class="([^"]*)"/);
  expect(chip?.[1]).toContain('[overflow-wrap:anywhere]');
});

test('the Table renders every column with its caption under the header', () => {
  const sections = render(empty, 'table').split('data-board-column=').slice(1);
  expect(sections).toHaveLength(COLUMNS.length);
  COLUMNS.forEach((c, i) => {
    expect(sections[i]).toContain(`"${c.id}"`);
    expect(sections[i]).toMatch(new RegExp(`data-holder[^>]*>${c.holder}</p>`));
  });
});

test('a failed chip renders the v3 failed color and a running chip pulses', () => {
  const html = render(
    {
      ...empty,
      columns: [
        {
          id: 'merged',
          title: 'Merged',
          role: 'test',
          holder: 'test',
          items: [
            {
              ...bare,
              number: 1,
              title: 'x',
              chips: [
                { kind: 'route', text: 'broke', state: 'failed' },
                { kind: 'route', text: 'going', state: 'running', pulse: true },
              ],
              to: '/f/x/work/1',
            },
          ],
        },
      ],
    },
    'table',
  );
  const failed = html.match(/<span[^>]*color:var\(--v3-failed\)[^>]*>broke<\/span>/);
  expect(failed).not.toBeNull();
  const running = html.match(/<span[^>]*>(<span[^>]*animate-pulse[^>]*><\/span>)going<\/span>/);
  expect(running).not.toBeNull();
});

const stage = (id: string, numbers: number[]) => ({
  ...(PIPELINE.find((h) => h.id === id) as (typeof PIPELINE)[number]),
  items: numbers.map((number) => ({
    ...bare,
    number,
    title: `Item ${number}`,
    chips: [],
    to: `/f/x/work/${number}`,
    status: 'waiting' as const,
  })),
  pills:
    numbers.length > 0
      ? [{ label: 'waiting' as const, state: 'idle' as const, count: numbers.length }]
      : [],
});

test('the Pipeline renders the seven stages in order, then Blocked and parked, each with its count and a link to the work item', () => {
  const view: BoardView = {
    ...empty,
    pipeline: PIPELINE.map((h) => stage(h.id, h.id === 'build' ? [7] : [])),
  };
  const html = render(view, 'pipeline');
  const ids = [...html.matchAll(/data-board-stage="(\w+)"/g)].map((m) => m[1]);
  expect(ids).toEqual([
    'intake',
    'planned',
    'build',
    'review',
    'app',
    'merge',
    'merged',
    'blocked',
  ]);
  expect(html).toContain('data-count="1"');
  expect(html).toMatch(
    /<a[^>]*href="\/f\/x\/work\/7"[^>]*data-work-item="7"|data-work-item="7"[^>]*href="\/f\/x\/work\/7"/,
  );
  expect(html).toContain('data-found');
});

test('a Pipeline column shows every item it holds, and the stage row scrolls inside the Board', () => {
  const numbers = Array.from({ length: 12 }, (_, i) => i + 1);
  const view: BoardView = {
    ...empty,
    pipeline: PIPELINE.map((h) => stage(h.id, h.id === 'build' ? numbers : [])),
  };
  const html = render(view, 'pipeline');
  expect(html.match(/data-work-item=/g)).toHaveLength(numbers.length);
  expect(html).toContain('data-count="12"');
  expect(html).not.toContain('more in Table');
  expect(html).toMatch(/data-stage-row[^>]*class="[^"]*overflow-x-auto/);
  expect(html).toContain('auto-cols-[minmax(200px,1fr)]');
});

test('a mini card moves its state pill under the number instead of breaking it', () => {
  const html = render(
    {
      ...empty,
      pipeline: PIPELINE.map((spec, i) => ({
        ...spec,
        items:
          i === 0
            ? [
                {
                  ...bare,
                  number: 7,
                  title: 't',
                  status: 'check failed' as const,
                  chips: [],
                  to: '/f/x/work/7',
                },
              ]
            : [],
        pills: [],
      })),
    },
    'pipeline',
  );
  expect(html).toMatch(/class="[^"]*flex-wrap[^"]*whitespace-nowrap/);
  expect(html).toMatch(/class="[^"]*min-w-0[^"]*" title="check failed"/);
  expect(html).toMatch(/<span class="min-w-0 truncate">check failed<\/span>/);
});

test('a stage summary pill truncates on one line and carries its full text in a title', () => {
  const html = render(
    {
      ...empty,
      pipeline: PIPELINE.map((h) => ({
        ...stage(h.id, [7]),
        pills: [{ label: 'check failed' as const, state: 'failed' as const, count: 1 }],
      })),
    },
    'pipeline',
  );
  expect(html).toMatch(/title="check failed 1"[^>]*><span class="truncate">check failed/);
});

const card = (over: Partial<WorkItem>): WorkItem => ({
  ...bare,
  number: 648,
  title: 'Build the thing',
  chips: [],
  to: '/f/x/work/648',
  ...over,
});

const inMerged = (item: WorkItem) =>
  render(
    { ...empty, columns: [{ id: 'merged', title: 'Merged', holder: 'done', items: [item] }] },
    'table',
  );

const dot = (state: 'done' | 'needs-you' | 'idle' | 'running', title = 't') => ({ state, title });

test('a finished item shows its round, one dot per round in order, and returned', () => {
  const html = inMerged(
    card({
      round: 5,
      dots: [dot('done'), dot('needs-you'), dot('idle'), dot('done'), dot('done')],
      returned: 3,
    }),
  );
  expect(html).toContain('round 5');
  expect([...html.matchAll(/data-round-dot="([\w-]+)"/g)].map((m) => m[1])).toEqual([
    'done',
    'needs-you',
    'idle',
    'done',
    'done',
  ]);
  expect(html).toMatch(/<a [^>]*href="\/f\/x\/work\/648"[^>]*>returned ×3<\/a>/);
});

test('a running item shows the live dot and its workflow and step linking to the run', () => {
  const html = inMerged(
    card({
      round: 6,
      dots: [dot('running', 'Round 6: running')],
      run: { text: 'archon-build-queue · review__code', to: '/f/x/runs/abc' },
    }),
  );
  expect(html).toContain('round 6');
  expect(html).toContain('data-round-dot="running"');
  expect(html).toMatch(
    /<a [^>]*href="\/f\/x\/runs\/abc"[^>]*>archon-build-queue · review__code<\/a>/,
  );
  expect(html).not.toContain('returned');
});

test('a merged item shows when it merged, and an asking item its stop line', () => {
  const merged = inMerged(card({ mergedAt: new Date(2026, 10, 12, 9, 7) }));
  expect(merged).toContain('merged 2026-11-12 09:07');
  const asking = inMerged(card({ stop: { text: 'Waiting on you', state: 'needs-you' } }));
  expect(asking).toMatch(/data-stop-line[^>]*>Waiting on you</);
});

test('a Pipeline card shows round, run, returned, merged and stop line below its title, in the design order', () => {
  const full = {
    ...card({
      round: 2,
      dots: [dot('done'), dot('running')],
      run: { text: 'archon-build-queue · review__code', to: '/f/x/runs/abc' },
      returned: 2,
      mergedAt: new Date(2026, 10, 12, 9, 7),
      stop: { text: 'Asking: Merge it?', state: 'needs-you' },
    }),
    status: 'needs you' as const,
  };
  const spec = PIPELINE.find((h) => h.id === 'merged') as (typeof PIPELINE)[number];
  const html = render({ ...empty, pipeline: [{ ...spec, items: [full], pills: [] }] }, 'pipeline');
  const at = [
    'Build the thing',
    'round 2',
    'review__code',
    'returned ×2',
    'merged 2026-11-12',
    'Asking: Merge it?',
  ].map((text) => html.indexOf(text));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  expect(html).toMatch(
    /<a [^>]*href="\/f\/x\/runs\/abc"[^>]*>archon-build-queue · review__code<\/a>/,
  );
  expect(html).toMatch(/<a [^>]*href="\/f\/x\/work\/648"[^>]*>returned ×2<\/a>/);
});

test('a blocked card and its Table row say what the item waits on', () => {
  const reason = { kind: 'reason' as const, text: 'Held by the 11/09 ruling' };
  const blockers = {
    kind: 'blockers' as const,
    items: [
      { number: 3, to: '/f/x/work/3' },
      { number: 9, to: '/f/x/work/9' },
    ],
  };
  const cards = (waits: WorkItem['waits']) =>
    render(
      {
        ...empty,
        pipeline: PIPELINE.map((spec) => ({
          ...spec,
          items: spec.id === 'blocked' ? [{ ...card({ waits }), status: 'blocked' as const }] : [],
          pills: [],
        })),
      },
      'pipeline',
    );
  const html = cards(reason);
  expect(html).toContain('title="Held by the 11/09 ruling"');
  expect(cards({ kind: 'contract' })).toContain('Needs a contract');
  const linked = cards(blockers);
  expect(linked).toMatch(/Blocked on <a [^>]*href="\/f\/x\/work\/3"[^>]*>#3<\/a>/);
  expect(linked).toMatch(/href="\/f\/x\/work\/9"/);
  const table = render(
    {
      ...empty,
      columns: [
        {
          id: 'parked',
          title: 'Parked',
          holder: 'x',
          items: [card({ waits: { kind: 'contract' } })],
        },
      ],
    },
    'table',
  );
  expect(table).toContain('Needs a contract');
});
